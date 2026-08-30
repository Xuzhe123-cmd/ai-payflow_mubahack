/**
 * The Move abort code ↔ PolicyViolationCode mapping.
 *
 * A Move abort carries a bare number. This is what turns that number back into
 * the violation the interface already knows how to render, and it is the only
 * place the correspondence is written down.
 *
 * The numbering is not arbitrary: in move/payflow/sources/payment.move the
 * error constants ARE the check codes, and `evaluate` builds its result vector
 * from those same constants. So position in this array, the check code on chain,
 * and the abort code are one number with three names — and
 * tests/sui/errorCodeParity.test.ts reads the Move source to prove it stays that
 * way.
 */

import type { PolicyViolationCode } from "../types";

/**
 * Evaluation order, which is also render order in DecisionChain's safety block.
 * Index i holds the code that aborts with `i + 1`.
 */
export const POLICY_CHECK_ORDER: readonly PolicyViolationCode[] = [
  "AGENT_NOT_AUTHORIZED",
  "CAPABILITY_DISABLED",
  "SUPPLIER_NOT_APPROVED",
  "RECIPIENT_WALLET_MISMATCH",
  "EXCEEDS_MAX_PAYMENT",
  "EXCEEDS_DAILY_LIMIT",
  "CURRENCY_NOT_ALLOWED",
  "INVOICE_ALREADY_PAID",
  "INSUFFICIENT_RESERVE",
  "RECOMMENDATION_EXPIRED",
] as const;

/** Abort code for each violation. 1-based, matching the Move constants. */
export const MOVE_ABORT_CODE: Record<PolicyViolationCode, number> =
  Object.fromEntries(
    POLICY_CHECK_ORDER.map((code, index) => [code, index + 1]),
  ) as Record<PolicyViolationCode, number>;

/**
 * Decodes a Move abort code. Returns null for anything outside 1..10 — the
 * package also aborts with operational codes in the 100s and 700s, which are
 * bugs or misuse rather than policy verdicts, and must not be rendered as a
 * failed safety check.
 */
export function violationForAbortCode(
  abortCode: number,
): PolicyViolationCode | null {
  if (!Number.isInteger(abortCode)) return null;
  return POLICY_CHECK_ORDER[abortCode - 1] ?? null;
}

/**
 * The Move constant name for a violation, e.g. EXCEEDS_MAX_PAYMENT →
 * EExceedsMaxPayment. Used by the parity test to read the Move source, and
 * useful when reporting an abort to a developer.
 */
export function moveConstantName(code: PolicyViolationCode): string {
  const pascal = code
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join("");
  return `E${pascal}`;
}
