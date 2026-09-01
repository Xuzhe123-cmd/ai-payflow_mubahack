/**
 * Where an invoice stands between "a human must decide" and "Sui has answered".
 *
 * THE DISTINCTION THIS EXISTS TO MAKE. The pipeline enforces every PaymentRequest
 * it builds, including ones the agent may not execute — so a $30,000 invoice
 * arrives carrying `enforcement.outcome === "SUI_REJECT"` before any human has
 * done anything. Rendering that as the chain's verdict says two false things:
 * that an approval was attempted, and that it was refused. Neither happened.
 *
 * A PREDICTION IS NOT A VERDICT. The pipeline's enforcement is a forecast made
 * under the approver's ceiling. The verdict is what `approval::approve_scoped`
 * returns when a person actually asks. This module keeps them apart.
 *
 * NOT EVERY REFUSAL IS A PRE-APPROVAL, EITHER. A duplicate invoice, a mismatched
 * remit wallet, an unapproved supplier — no human approval fixes any of those,
 * and offering an Approve button beside them would invite a click that cannot
 * help. Only failures about AUTHORITY — this amount is above what may be
 * authorized — are a question a human can answer. Everything else stays a
 * refusal, before and after.
 */

import type { PolicyViolationCode } from "../types";

export type ApprovalStage =
  /** A human decision is the next step. No Sui verdict exists yet. */
  | "PRE_APPROVAL"
  /** A human attempted approval and the real preflight refused it. */
  | "APPROVAL_REFUSED"
  /** A human attempted approval and the real preflight passed. */
  | "APPROVAL_PASSED"
  /** Refused for something approval cannot change. */
  | "BLOCKED"
  /** No enforcement has run — nothing to say. */
  | "NOT_APPLICABLE";

/**
 * The failures a human approval actually addresses.
 *
 * Approval raises WHOSE limit applies. It cannot make a duplicate un-paid or a
 * wrong wallet right, so only the two limit checks qualify.
 */
const AUTHORITY_FAILURES: readonly PolicyViolationCode[] = [
  "EXCEEDS_MAX_PAYMENT",
  "EXCEEDS_DAILY_LIMIT",
];

export interface ApprovalStageInput {
  /** The pipeline's own enforcement. A forecast, not the chain's answer. */
  analysisEnforcement: {
    outcome: "APPROVED" | "SUI_REJECT";
    checks: { code: PolicyViolationCode; passed: boolean }[];
  } | null;
  /**
   * The enforcement carried back by a real approval attempt.
   *
   * Non-null ONLY after a human clicked and the preflight answered, which is
   * what makes it safe to render as a verdict.
   */
  approvalEnforcement: { outcome: "APPROVED" | "SUI_REJECT" } | null;
}

export function resolveApprovalStage(input: ApprovalStageInput): ApprovalStage {
  // A human has attempted approval: the chain has spoken, either way.
  if (input.approvalEnforcement) {
    return input.approvalEnforcement.outcome === "SUI_REJECT"
      ? "APPROVAL_REFUSED"
      : "APPROVAL_PASSED";
  }

  const enforcement = input.analysisEnforcement;
  if (!enforcement || enforcement.outcome !== "SUI_REJECT") return "NOT_APPLICABLE";

  const failed = enforcement.checks.filter((check) => !check.passed);
  if (failed.length === 0) return "NOT_APPLICABLE";

  // Every failure must be one a human could authorize away. A single
  // non-authority failure — a duplicate, a wallet mismatch — means approving
  // would achieve nothing, so it stays a refusal.
  const onlyAuthority = failed.every((check) => AUTHORITY_FAILURES.includes(check.code));
  return onlyAuthority ? "PRE_APPROVAL" : "BLOCKED";
}

/** Whether the interface may present a Sui verdict for this stage. */
export function showsChainVerdict(stage: ApprovalStage): boolean {
  return stage === "APPROVAL_REFUSED" || stage === "BLOCKED";
}

/** Whether the interface should ask a human to decide. */
export function awaitsHuman(stage: ApprovalStage): boolean {
  return stage === "PRE_APPROVAL";
}
