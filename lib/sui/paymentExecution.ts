/**
 * Real payment execution, through the server's own Sui CLI access.
 *
 * SERVER ONLY. This module reaches the keystore the CLI manages, so it must
 * never be imported from a component — the `node:child_process` import deep in
 * the CLI wrapper would fail the client build, which is a crude but effective
 * guard on top of the deliberate one.
 *
 * WHAT THIS REPLACES. `lib/services/suiService.executePayment` used to return a
 * fabricated receipt, and then — once that was caught — to throw
 * unconditionally, because inventing a settlement is worse than admitting there
 * is none. Neither is a payment. This submits the real Move call and reports
 * the digest the chain gave back, or the abort code it refused with.
 *
 * TWO AUTHORITIES, TWO DIFFERENT MOVE FUNCTIONS. The distinction is structural
 * rather than a parameter:
 *
 *   AGENT           `payment::execute_payment`, holding the AgentCap. Measured
 *                   against the agent's own limits, and withdrawn entirely by
 *                   the circuit breaker's HUMAN_ONLY mode.
 *   HUMAN_APPROVAL  `approval::approve_scoped` to mint the approval, then
 *                   `payment::execute_approved` to spend it. Two transactions,
 *                   because `approve_scoped` SHARES the HumanApproval rather
 *                   than returning it, so nothing downstream can use it inside
 *                   the same PTB.
 *
 * WHO SIGNS. The server's CLI keystore — the same signer the escrow flow, the
 * membership sync and the circuit breaker already use. It is NOT the zkLogin
 * session: this build derives an address from a Google identity and reads
 * membership with it, but has no proving service, so it cannot produce a
 * zkLogin signature. Saying the treasury key signed is the true statement, and
 * the interface says it.
 *
 * WHAT THIS WILL NOT DO. It will not submit when live execution is off, will
 * not return a digest it did not receive, and will not report a Move abort as
 * anything other than a refusal. A payment that failed comes back as a failure
 * carrying the chain's own abort code.
 */

import {
  AUTO_GAS_BUDGET,
  callAllowingAbort,
  createdObject,
  describeCliError,
  dryRunCall,
  fetchTransaction,
  type CallOptions,
  type TxResponse,
} from "../../scripts/lib/suiCli";
import { callPackageId, explorerTxUrl, structTypesFor } from "./deployment";
import type { DeploymentManifest, SuiNetwork } from "./deployment";
import { violationForAbortCode } from "./errorCodes";
import { centsToUnitsString } from "./units";
import type { PaymentRequest, PolicyViolationCode } from "../types";

/** How long a freshly minted approval stays spendable. */
const APPROVAL_TTL_MS = 3_600_000;
/** The recommendation window the chain judges check 10 against. */
const RECOMMENDATION_TTL_MS = 86_400_000;

export type PaymentAuthority = "AGENT" | "HUMAN_APPROVAL";

/**
 * Live submission is off unless the server says otherwise.
 *
 * Mirrors `PAYFLOW_ESCROW_LIVE`. The default cannot spend testnet gas by
 * accident, and turning it on is an act on the server rather than a click in a
 * browser — a client can no more enable this than it can sign for the treasury.
 */
export function paymentExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.PAYFLOW_PAYMENT_LIVE?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export interface PaymentSubmission {
  ok: boolean;
  /** Present whenever the transaction reached the chain, success or abort. */
  digest: string | null;
  /** Present once the transaction is in a checkpoint — proof of consensus. */
  checkpoint: string | null;
  /** The Move function that produced this result. */
  target: string;
  /** The Move abort code, when Sui refused. */
  abortCode: number | null;
  /** The policy check that failed, when the abort decodes to one of the ten. */
  violation: PolicyViolationCode | null;
  explorerUrl: string | null;
  /** Null on success. Never a summary of one — the chain's own complaint. */
  error: string | null;
}

/**
 * A refusal that never reached the chain, shaped like one that did.
 *
 * The caller gets the same object either way and so cannot treat a local
 * refusal as a success for lack of a branch.
 */
function refusal(target: string, error: string): PaymentSubmission {
  return {
    ok: false,
    digest: null,
    checkpoint: null,
    target,
    abortCode: null,
    violation: null,
    explorerUrl: null,
    error,
  };
}

/**
 * Submits one Move call and reports what the chain said.
 *
 * `callAllowingAbort` rather than `call`, because a Move abort is the answer
 * this product exists to show — a payment refused by the treasury's own rules
 * should surface its code, not a stack trace.
 */
function submit(
  options: CallOptions,
  network: SuiNetwork,
  target: string,
): { result: PaymentSubmission; tx: TxResponse | null } {
  let outcome;
  try {
    outcome = callAllowingAbort({ ...options, gasBudget: AUTO_GAS_BUDGET });
  } catch (error) {
    return { result: refusal(target, describeCliError(error)), tx: null };
  }

  const abortCode = outcome.abort?.code ?? null;
  // A transaction that aborted is still a real transaction: it reached
  // consensus, consumed gas, and is permanently recorded. Reading the
  // checkpoint back is what separates that from a local error that never left
  // the machine.
  const onChain = outcome.digest ? fetchTransaction(outcome.digest) : null;

  return {
    result: {
      ok: outcome.ok,
      digest: outcome.digest ?? null,
      checkpoint: onChain?.checkpoint ?? null,
      target,
      abortCode,
      violation: abortCode === null ? null : violationForAbortCode(abortCode),
      explorerUrl: outcome.digest ? explorerTxUrl(outcome.digest, network) : null,
      error: outcome.ok ? null : outcome.error || outcome.raw || "the call was refused on chain",
    },
    // Carried so the caller can read `objectChanges`, which is how the
    // HumanApproval's id is learned — `approve_scoped` shares it rather than
    // returning it, so the effects are the only place it appears.
    tx: outcome.tx ?? null,
  };
}

/**
 * Asks the chain whether the call would succeed, without committing it.
 *
 * Run before every submission. A dry run is evaluated by a validator against
 * live state and then discarded, so a refusal costs nothing and arrives with
 * the same abort code the real call would carry. It is not a substitute for the
 * real check — the state can move in between — it is how a doomed payment stops
 * before it spends gas.
 *
 * Estimated gas, like the real call. A dry run under the 0.5 SUI default budget
 * has to FIND a coin covering it before the CLI will attempt anything, so a
 * wallet holding only smaller coins gets a gas-selection refusal here for a
 * payment the auto-budgeted submission would have made — a preflight that
 * refuses what the real call permits is worse than no preflight.
 */
function preflight(options: CallOptions, target: string): PaymentSubmission | null {
  let result;
  try {
    result = dryRunCall({ ...options, gasBudget: AUTO_GAS_BUDGET });
  } catch (error) {
    return refusal(target, describeCliError(error));
  }
  if (result.ok) return null;

  const abortCode = result.abort?.code ?? result.abortCode ?? null;
  return {
    ok: false,
    digest: null,
    checkpoint: null,
    target,
    abortCode,
    violation: abortCode === null ? null : violationForAbortCode(abortCode),
    explorerUrl: null,
    error: result.error || "the dry run was refused",
  };
}

export interface ExecuteInput {
  manifest: DeploymentManifest;
  network: SuiNetwork;
  request: PaymentRequest;
  /** The `Invoice` object this settles, resolved from chain by number. */
  invoiceObjectId: string;
  /** Real wall-clock milliseconds. See `chainTimestamps`. */
  nowMs: number;
}

/**
 * The timestamps the chain is given.
 *
 * NOT the demo clock. `payment::evaluate` judges check 10 against the on-chain
 * `Clock`, which reads real wall time on a real validator — so a demo-day
 * timestamp is measured against today and the freshness window means something
 * other than what it says. The demo clock governs which DECISION is reached;
 * a transaction actually being submitted is judged in real time, and this is
 * where the two part company.
 *
 * The recommendation id still comes from the request, so the audit trail on
 * chain points back at the analysis that produced the payment.
 */
export function chainTimestamps(nowMs: number): {
  recommendedAtMs: string;
  expiresAtMs: string;
} {
  return {
    recommendedAtMs: String(nowMs),
    expiresAtMs: String(nowMs + RECOMMENDATION_TTL_MS),
  };
}

/**
 * The agent settling a payment on its own capability.
 *
 * One transaction. The AgentCap is a bearer token the server's address holds;
 * the limits it runs under live on the treasury, keyed by the cap's id, which
 * is what lets an admin revoke an agent without holding its capability.
 */
export function executeAgentPayment(input: ExecuteInput): PaymentSubmission {
  const { manifest, network, request, invoiceObjectId, nowMs } = input;
  const packageId = callPackageId(manifest);
  const target = `${packageId}::payment::execute_payment`;
  const times = chainTimestamps(nowMs);

  const options: CallOptions = {
    packageId,
    module: "payment",
    function: "execute_payment",
    typeArgs: [manifest.coinType],
    args: [
      manifest.objects.treasuryId,
      manifest.objects.agentCapId,
      manifest.objects.supplierRegistryId,
      invoiceObjectId,
      centsToUnitsString(request.amountCents),
      request.recipientWallet,
      request.recommendationId,
      times.recommendedAtMs,
      times.expiresAtMs,
      "0x6",
    ],
  };

  const refused = preflight(options, target);
  if (refused) return refused;
  return submit(options, network, target).result;
}

export interface ApprovedExecution {
  /** The mint, when it ran. Null when it was refused before submission. */
  approval: PaymentSubmission | null;
  /** The id of the HumanApproval the mint shared, when one was created. */
  approvalObjectId: string | null;
  /** The settlement itself. Null when the mint never succeeded. */
  payment: PaymentSubmission | null;
}

/**
 * A person settling a payment above the agent's authority.
 *
 * TWO TRANSACTIONS, and the first one matters on its own. `approve_scoped`
 * re-checks the approver's authorization, their company membership and its
 * freshness, the per-payment ceiling, the recipient scope and the daily budget
 * against live state — and the sender IS the authority, because Move reads
 * `ctx.sender()`. So this authorizes as whoever the server's keystore holds,
 * and a treasury that has not registered that address as an approver refuses
 * with 602 rather than quietly finding a larger authority to run under.
 *
 * The second transaction re-runs all ten checks again under the approval's own
 * limits, which are the approved amount itself in both the single and the daily
 * figure — an approval cannot be stretched to cover a bigger payment.
 */
export function executeApprovedPayment(input: ExecuteInput): ApprovedExecution {
  const { manifest, network, request, invoiceObjectId, nowMs } = input;
  const packageId = callPackageId(manifest);
  const companyId = manifest.identity?.companyId;
  const mintTarget = `${packageId}::approval::approve_scoped`;
  const payTarget = `${packageId}::payment::execute_approved`;

  if (!companyId) {
    return {
      approval: refusal(
        mintTarget,
        "No company identity exists on chain, so no membership can be read and no scoped " +
          "approval can be minted.",
      ),
      approvalObjectId: null,
      payment: null,
    };
  }

  const mintOptions: CallOptions = {
    packageId,
    module: "approval",
    function: "approve_scoped",
    typeArgs: [manifest.coinType],
    args: [
      manifest.objects.treasuryId,
      companyId,
      request.invoiceNumber,
      centsToUnitsString(request.amountCents),
      request.recipientWallet,
      String(nowMs + APPROVAL_TTL_MS),
      "0x6",
    ],
  };

  const mintRefused = preflight(mintOptions, mintTarget);
  if (mintRefused) return { approval: mintRefused, approvalObjectId: null, payment: null };

  const minted = submit(mintOptions, network, mintTarget);
  const approval = minted.result;
  if (!approval.ok) return { approval, approvalObjectId: null, payment: null };

  // The approval is a SHARED object, so its id has to be read out of the
  // transaction that created it. The type is anchored to the package version
  // that defined `approval`, which after an upgrade is not the one being called.
  const approvalObjectId = minted.tx
    ? createdObject(minted.tx, structTypesFor(manifest).humanApproval)
    : null;

  if (!approvalObjectId) {
    return {
      approval,
      approvalObjectId: null,
      payment: refusal(
        payTarget,
        "The approval transaction succeeded but no HumanApproval object could be found in its " +
          "effects, so there is nothing to execute against. The authorization exists on chain — " +
          `see ${approval.digest ?? "the transaction"} — and can be spent once its id is known.`,
      ),
    };
  }

  const times = chainTimestamps(nowMs);
  const payOptions: CallOptions = {
    packageId,
    module: "payment",
    function: "execute_approved",
    typeArgs: [manifest.coinType],
    args: [
      manifest.objects.treasuryId,
      approvalObjectId,
      manifest.objects.supplierRegistryId,
      invoiceObjectId,
      request.recommendationId,
      times.recommendedAtMs,
      times.expiresAtMs,
      "0x6",
    ],
  };

  const payRefused = preflight(payOptions, payTarget);
  if (payRefused) return { approval, approvalObjectId, payment: payRefused };

  return { approval, approvalObjectId, payment: submit(payOptions, network, payTarget).result };
}
