/**
 * Which Move abort a failed policy check corresponds to on the approval path.
 *
 * The point is to let the interface name the REAL rule. "Above the limit" is a
 * claim a frontend can make about a number it holds; `601 EAboveApproverLimit`
 * is a line in `approval::approve_scoped` that a validator executes. Showing
 * the constant is how a reader tells the two apart, and it is the difference
 * between a preflight that means something and a mockup.
 *
 * NO GUESSING. Only checks that `approve_scoped` itself enforces are mapped.
 * The rest — supplier registration, currency, reserve, duplicate payment — are
 * enforced later, by `payment::evaluate` on execution, and are deliberately
 * absent so a caller cannot render an approval-path abort code beside a check
 * that path never runs. An unmapped code returns null and the abort line is
 * omitted rather than invented.
 *
 * Kept pure and dependency-free so components may import it; the codes mirror
 * `move/payflow/sources/approval.move` and must be changed with it.
 */

import type { PolicyViolationCode } from "../types";

export interface MoveAbort {
  /** The `u64` the Move constant is assigned. */
  code: number;
  /** The constant's name, exactly as the source spells it. */
  name: string;
  /** Where it aborts, for a reader who wants to go and read it. */
  location: string;
}

const APPROVAL_PATH: Partial<Record<PolicyViolationCode, MoveAbort>> = {
  EXCEEDS_MAX_PAYMENT: {
    code: 601,
    name: "EAboveApproverLimit",
    location: "approval::approve_scoped",
  },
  EXCEEDS_DAILY_LIMIT: {
    code: 607,
    name: "EAboveApproverDailyLimit",
    location: "approval::approve_scoped",
  },
  RECIPIENT_WALLET_MISMATCH: {
    code: 606,
    name: "ERecipientNotInScope",
    location: "approval::approve_scoped",
  },
  AGENT_NOT_AUTHORIZED: {
    code: 602,
    name: "ENotAuthorizedApprover",
    location: "approval::approve_scoped",
  },
  CAPABILITY_DISABLED: {
    code: 604,
    name: "EApproverRevoked",
    location: "approval::approve_scoped",
  },
};

/** The abort this check would trigger, or null when the approval path has none. */
export function approvalAbortFor(code: PolicyViolationCode): MoveAbort | null {
  return APPROVAL_PATH[code] ?? null;
}

/** Rendered the way the Move source reads it: `601 — EAboveApproverLimit`. */
export function formatAbort(abort: MoveAbort): string {
  return `${abort.code} — ${abort.name}`;
}
