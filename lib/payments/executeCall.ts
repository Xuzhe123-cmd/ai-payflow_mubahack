/**
 * The `payment::execute_payment` call, built from chain facts only.
 *
 * WHICH MOVE FUNCTION, AND WHY THIS ONE. Two entry points settle a payment:
 *
 *   payment::execute_payment   the agent acting on its own AgentCap. Needs no
 *                              approval object, and is the correct call for any
 *                              amount inside the agent's own authorization.
 *   payment::execute_approved  a person settling above that. Requires a live
 *                              `HumanApproval` object, which only exists after
 *                              `approval::approve_scoped` has been SUBMITTED.
 *
 * This builder targets the first. The second cannot be reached today because no
 * `HumanApproval` object exists on chain — the application has never submitted
 * `approve_scoped`, only dry-run it. That is a real limitation, reported rather
 * than papered over: a payment above the agent's ceiling has no executable path
 * in this build, and pretending otherwise would mean inventing a receipt.
 *
 * NOTHING HERE COMES FROM THE CLIENT. Amount and recipient are read off the
 * on-chain `Invoice` object, so a request cannot ask to pay a different address
 * or a larger sum. Move re-checks all ten assertions regardless; this only
 * removes the chance to lie about the inputs.
 */

import type { DeploymentManifest } from "../sui/deployment";
import { callPackageId } from "../sui/deployment";

/** `0x6` is the shared Clock. */
const CLOCK = "0x6";

export interface ExecutePaymentPlan {
  packageId: string;
  module: "payment";
  function: "execute_payment";
  typeArguments: string[];
  arguments: string[];
  label: string;
  effect: string;
}

export interface OnChainInvoiceRef {
  objectId: string;
  invoiceNumber: string;
  /** Base units, as the chain holds them. */
  amount: string;
  recipient: string;
}

export class AgentCapMissingError extends Error {
  readonly code = "NO_AGENT_CAP";
  constructor() {
    super("The deployment manifest records no AgentCap, so no payment call can be built.");
    this.name = "AgentCapMissingError";
  }
}

/**
 * Builds the settlement call.
 *
 * `recommendationId` is recorded on the PaymentRecord as provenance. The
 * recommendation window (`recommendedAtMs` … `expiresAtMs`) is re-checked by
 * Move, which is why both are passed rather than assumed.
 */
export function executePaymentCall(
  manifest: DeploymentManifest,
  invoice: OnChainInvoiceRef,
  recommendationId: string,
  nowMs: number,
  windowMs = 86_400_000,
): ExecutePaymentPlan {
  const agentCap = manifest.objects.agentCapId;
  if (!agentCap) throw new AgentCapMissingError();

  return {
    packageId: callPackageId(manifest),
    module: "payment",
    function: "execute_payment",
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      agentCap,
      manifest.objects.supplierRegistryId,
      invoice.objectId,
      // From the chain object, never from the request.
      invoice.amount,
      invoice.recipient,
      recommendationId,
      String(nowMs),
      String(nowMs + windowMs),
      CLOCK,
    ],
    label: `Settle ${invoice.invoiceNumber} under the agent's authorization`,
    effect:
      "Transfers from the treasury vault to the invoice's registered recipient and records a " +
      "PaymentRecord. Move re-checks all ten assertions, the circuit breaker, and the " +
      "duplicate-payment table before anything moves.",
  };
}
