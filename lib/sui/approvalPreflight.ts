/**
 * Asking Sui what it would do with a human approval, without doing it.
 *
 * A dry run is evaluated by a validator against live state and then discarded:
 * the same code runs, the same conditions are checked, the same abort fires —
 * and nothing is committed, no gas is spent, no object changes. That makes it
 * the honest way to show a limit working, as opposed to re-implementing the
 * limit in TypeScript and hoping the two agree.
 *
 * The abort codes below are read from Move rather than guessed. Each is the
 * number `approval::approve_scoped` or `treasury` actually raises, so a
 * refusal shown to a reader is the refusal the chain would give.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { unitsToCents, centsToUnits } from "./units";
import type { SuiNetwork } from "./deployment";

const run = promisify(execFile);

/** Move abort codes, and what each means to a person. */
const ABORTS: Record<number, { code: string; message: string }> = {
  601: {
    code: "AMOUNT_EXCEEDS_LIMIT",
    message: "The amount is above the per-payment ceiling this authorization permits.",
  },
  602: {
    code: "NOT_AUTHORIZED_APPROVER",
    message: "The treasury holds no approver authorization for this address.",
  },
  604: { code: "APPROVER_REVOKED", message: "This authorization has been revoked." },
  605: { code: "APPROVER_EXPIRED", message: "This authorization has expired." },
  606: {
    code: "RECIPIENT_OUT_OF_SCOPE",
    message: "This recipient is outside the authorization's allowed list.",
  },
  607: {
    code: "EXCEEDS_DAILY_LIMIT",
    message: "This would take the approver past their daily authorization limit.",
  },
  608: {
    code: "LEGACY_PATH_SEALED",
    message: "The legacy ApproverCap path is sealed and authorizes nothing.",
  },
  610: {
    code: "NOT_AN_ACTIVE_MEMBER",
    message: "The company does not recognise this address as an active member.",
  },
  611: {
    code: "MEMBER_CANNOT_APPROVE",
    message: "This member's role does not carry APPROVE_PAYMENTS.",
  },
  110: {
    code: "APPROVERS_NOT_READY",
    message: "The treasury's approver registry has not been initialised.",
  },
  114: {
    code: "WRONG_COMPANY",
    message: "This authorization is bound to a different company.",
  },
};

export interface PreflightVerdict {
  /** What Sui would do. A PREVIEW of execution, not an execution. */
  wouldAuthorize: boolean;
  /** A stable identifier for the refusal, or null on success. */
  code: string | null;
  message: string;
  /** The raw Move abort code, when the chain aborted. */
  abortCode: number | null;
  /** The exact Move function the verdict came from. */
  target: string;
  /** Stated so no reader mistakes this for a settlement. */
  submitted: false;
}

export interface PreflightInput {
  network: SuiNetwork;
  packageId: string;
  coinType: string;
  treasuryId: string;
  companyId: string;
  invoiceNumber: string;
  amountCents: number;
  recipient: string;
  approver: string;
}

/**
 * Pulls the abort code out of the CLI's Move error text.
 *
 * The shape is:
 *
 *   MoveAbort(MoveLocation { module: ..., function: 4, instruction: 104,
 *             function_name: Some("approve_scoped") }, 601)
 *
 * The code is the number after the CLOSING brace - 601 here. Two traps, both
 * of which this hit while being written:
 *
 *   - matching up to the first ")" stops inside Some("approve_scoped"), so the
 *     pattern never matches at all;
 *   - a loose "first three-digit number" fallback then happily returns
 *     `instruction: 104`, which is not an abort code and reads as a plausible
 *     one. That is exactly what it did, reporting 104 for a $30,000 refusal
 *     whose real code is 601.
 *
 * So it anchors on "}, <digits>)" and takes the LAST such match, and there is
 * deliberately no fallback: an abort it cannot parse returns null and is
 * reported as an unidentified refusal rather than a confident wrong number.
 */
function abortCodeFrom(text: string): number | null {
  const pattern = /\}\s*,\s*(\d+)\s*\)/g;
  let code: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) code = Number(match[1]);
  return code;
}

/**
 * Dry-runs `approval::approve_scoped` and reports what the chain decided.
 *
 * Note the expiry passed for the approval itself is deliberately short and in
 * the future: it is not what is under test, and a value in the past would abort
 * for the wrong reason and hide the answer the caller wanted.
 */
export async function dryRunApproveScoped(input: PreflightInput): Promise<PreflightVerdict> {
  const target = `${input.packageId}::approval::approve_scoped`;
  const now = Date.now();

  const args = [
    "client",
    "call",
    "--package", input.packageId,
    "--module", "approval",
    "--function", "approve_scoped",
    "--type-args", input.coinType,
    "--args",
    input.treasuryId,
    input.companyId,
    input.invoiceNumber,
    String(centsToUnits(input.amountCents)),
    input.recipient,
    String(now + 3_600_000),
    "0x6",
    // THE SENDER IS THE AUTHORITY. `approve_scoped` reads `ctx.sender()` and
    // looks it up in the treasury's approver state, so a dry run sent by
    // anyone else answers a different question — it reports 602
    // (no authorization for THAT address) and never reaches the limit under
    // test. `--sender` sets it without needing the key, which is exactly what
    // a preview should do.
    "--sender", input.approver,
    "--gas-budget", "100000000",
    "--dry-run",
    "--json",
  ];

  let stdout = "";
  let stderr = "";
  try {
    const result = await run("sui", args, { maxBuffer: 32 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? "";
  }

  const combined = `${stdout}\n${stderr}`;

  // Success is only claimed on an explicit success status. Anything ambiguous
  // is reported as a refusal, because guessing in the permissive direction is
  // the failure mode this whole route exists to remove.
  let succeeded = false;
  try {
    const parsed = JSON.parse(stdout) as {
      effects?: { status?: { status?: string } };
    };
    succeeded = parsed.effects?.status?.status === "success";
  } catch {
    succeeded = /"status"\s*:\s*"success"/.test(stdout);
  }

  if (succeeded) {
    return {
      wouldAuthorize: true,
      code: null,
      message:
        `Sui evaluated this approval against the live authorization and would accept it. ` +
        "Nothing was submitted — this is the chain's verdict, not a settlement.",
      abortCode: null,
      target,
      submitted: false,
    };
  }

  const abortCode = abortCodeFrom(combined);
  const known = abortCode !== null ? ABORTS[abortCode] : undefined;

  return {
    wouldAuthorize: false,
    code: known?.code ?? "REFUSED",
    message:
      known?.message ??
      "Sui refused this approval. See the abort code for the exact condition that failed.",
    abortCode,
    target,
    submitted: false,
  };
}

/** Re-exported so a caller can render the figures it compared. */
export { unitsToCents, centsToUnits };
