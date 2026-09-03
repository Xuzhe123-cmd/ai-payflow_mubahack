/**
 * What a refused payment is called, in the reader's terms.
 *
 * Separated from the component that renders it so the correspondence can be
 * tested: every one of the ten policy checks must have a headline here, or a
 * check added to Move ships with a refusal the interface can only describe as
 * "no payment was submitted". The parity test in tests/payments enforces that.
 *
 * The gloss is a HEADLINE, never a replacement for the message. The message
 * comes from the chain or the server and is always rendered beside this —
 * inventing an explanation for a code this file does not know would be worse
 * than showing the unglossed original.
 */

import type { PolicyViolationCode } from "../types";

/** Refusals that come from the ten on-chain checks. */
const POLICY_HEADLINE: Record<PolicyViolationCode, string> = {
  AGENT_NOT_AUTHORIZED: "Refused by Sui — the agent is not authorized here",
  CAPABILITY_DISABLED: "Refused by Sui — the agent capability is revoked",
  SUPPLIER_NOT_APPROVED: "Refused by Sui — supplier not in the registry",
  RECIPIENT_WALLET_MISMATCH: "Refused by Sui — recipient does not match the registry",
  EXCEEDS_MAX_PAYMENT: "Refused by Sui — above the payment ceiling",
  EXCEEDS_DAILY_LIMIT: "Refused by Sui — above the daily limit",
  CURRENCY_NOT_ALLOWED: "Refused by Sui — currency not permitted",
  INVOICE_ALREADY_PAID: "Refused — this invoice is already paid",
  INSUFFICIENT_RESERVE: "Refused by Sui — would breach the minimum reserve",
  RECOMMENDATION_EXPIRED: "Refused by Sui — the recommendation has expired",
};

/**
 * Refusals raised by `approval::approve_scoped` and the human settlement path.
 *
 * These are Sui refusals like the ten above, but they are not failed policy
 * CHECKS — they are the approval authority itself being absent, revoked, lapsed,
 * out of scope, or exhausted. They needed their own list because every one of
 * them previously arrived as the bare word "REFUSED": `violationForAbortCode`
 * decodes 1..10 and returns null for everything else, so an abort of 602 — the
 * signer holds no approver authorization at all — was indistinguishable on
 * screen from any other failure.
 */
const APPROVAL_HEADLINE: Record<string, string> = {
  NOT_AUTHORIZED_APPROVER: "Refused by Sui — this signer is not an authorized approver",
  AMOUNT_EXCEEDS_LIMIT: "Refused by Sui — above the approver's per-payment limit",
  EXCEEDS_DAILY_AUTHORIZATION: "Refused by Sui — above the approver's daily limit",
  RECIPIENT_OUT_OF_SCOPE: "Refused by Sui — recipient outside the approver's scope",
  APPROVER_REVOKED: "Refused by Sui — this approver's authority was revoked",
  APPROVER_EXPIRED: "Refused by Sui — this approver's authority has expired",
  NOT_AN_ACTIVE_MEMBER: "Refused by Sui — not an active member of the company",
  MEMBER_CANNOT_APPROVE: "Refused by Sui — this role cannot approve payments",
  MEMBERSHIP_READING_STALE: "Refused by Sui — the membership check is stale",
  EXPIRY_IN_PAST: "Refused by Sui — the approval would already have expired",
  LEGACY_PATH_SEALED: "Refused by Sui — the legacy approval path is sealed",
  APPROVERS_NOT_READY: "Refused by Sui — the approver registry is not initialised",
  WRONG_COMPANY: "Refused by Sui — bound to a different company",
  WRONG_TREASURY: "Refused by Sui — bound to a different treasury",
  APPROVAL_MISMATCH: "Refused by Sui — the approval is for a different invoice",
  CIRCUIT_BREAKER_ACTIVE: "Blocked by the Sui circuit breaker",
  APPROVAL_NOT_LIVE: "Refused by Sui — the human approval is no longer live",
  APPROVAL_NOT_RECOGNIZED: "Refused by Sui — this approval is not recognised here",
  CONDITIONAL_INVOICE: "Refused by Sui — this invoice settles only against a shipment",
};

/**
 * Refusals that happen before the chain is ever asked.
 *
 * Worded so the difference stays visible: "not submitted" means no transaction
 * exists, and none of these may read as though the treasury declined something.
 */
const LOCAL_HEADLINE: Record<string, string> = {
  EXECUTION_DISABLED: "Not submitted — live execution is off",
  NOT_DEPLOYED: "Not submitted — no deployment to pay from",
  CHAIN_UNAVAILABLE: "Not submitted — the chain could not be reached",
  SERVER_UNREACHABLE: "Not submitted — the execution service is unreachable",
  INVOICE_NOT_ON_CHAIN: "Not submitted — no invoice object to settle",
  NO_DIGEST: "Not recorded — no transaction digest came back",
  EXECUTION_FAILED: "No payment was submitted",
  REFUSED: "Refused by Sui",
};

/** The headline for a refusal code, or a neutral one for a code we don't know. */
export function executionFailureHeadline(code: string): string {
  return (
    POLICY_HEADLINE[code as PolicyViolationCode] ??
    APPROVAL_HEADLINE[code] ??
    LOCAL_HEADLINE[code] ??
    "No payment was submitted"
  );
}
