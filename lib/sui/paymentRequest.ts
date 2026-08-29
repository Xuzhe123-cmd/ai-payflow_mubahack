/**
 * Turns a validated AI decision into a payment request for the chain.
 *
 * A request is built only for AUTO_PAY and SCHEDULE. HUMAN_REVIEW and REJECT
 * never produce one, so they can never reach the treasury at all.
 *
 * The amount comes from the deterministic extraction, never from the model —
 * the AI chooses whether and when to pay, not how much.
 */

import type {
  DeterministicAnalysis,
  PaymentRequest,
  TreasuryDecision,
} from "../types";

export function buildPaymentRequest(
  decision: TreasuryDecision,
  analysis: Readonly<DeterministicAnalysis>,
  agentId: string,
): PaymentRequest | null {
  if (decision.action !== "AUTO_PAY" && decision.action !== "SCHEDULE") return null;
  if (!decision.recommendedDate) return null;

  const candidate = analysis.cashFlowScenarios.find(
    (scenario) => scenario.paymentDate === decision.recommendedDate,
  );
  // validateDecision guarantees this, but the chain-facing path re-checks.
  if (!candidate) return null;

  return {
    invoiceNumber: analysis.invoiceFacts.invoiceNumber,
    supplierId: analysis.supplierFacts.supplierId,
    supplierName: analysis.invoiceFacts.supplierName,
    // The discounted figure when a discount is genuinely captured on this date.
    amountCents: candidate.paymentAmountCents,
    currency: analysis.invoiceFacts.currency,
    recipientWallet: analysis.invoiceFacts.recipientWallet,
    requestedDate: decision.recommendedDate,
    agentId,
  };
}
