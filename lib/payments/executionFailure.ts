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
    LOCAL_HEADLINE[code] ??
    "No payment was submitted"
  );
}
