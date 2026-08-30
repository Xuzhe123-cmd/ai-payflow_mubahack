/**
 * Turns an AI recommendation into a payment request for the chain.
 *
 * This is the boundary between "what should happen" and "what the chain is
 * being asked to allow". A request is built only for AUTO_PAY and SCHEDULE;
 * HUMAN_REVIEW and REJECT never produce one, so they can never reach the
 * treasury at all.
 *
 * Note what does NOT cross this boundary. The recommendation carries a risk
 * level, an urgency level, a confidence, a projected minimum cash figure and a
 * whole "why not today" comparison — and none of it appears below. The chain is
 * given the amount, the recipient, and the provenance it needs for audit and
 * expiry. There is no field through which the AI could assert its own safety.
 *
 * The amount comes from the deterministic extraction, never from the model —
 * the AI chooses whether and when to pay, not how much.
 */

import type {
  DeterministicAnalysis,
  PaymentRecommendation,
  PaymentRequest,
} from "../types";

export function buildPaymentRequest(
  recommendation: Readonly<PaymentRecommendation>,
  analysis: Readonly<DeterministicAnalysis>,
  agentId: string,
): PaymentRequest | null {
  if (recommendation.action !== "AUTO_PAY" && recommendation.action !== "SCHEDULE") return null;
  if (!recommendation.recommendedDate) return null;

  const candidate = analysis.cashFlowScenarios.find(
    (scenario) => scenario.paymentDate === recommendation.recommendedDate,
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
    requestedDate: recommendation.recommendedDate,
    agentId,
    recommendationId: recommendation.recommendationId,
    recommendedAtMs: recommendation.generatedAtMs,
    expiresAtMs: recommendation.expiresAtMs,
  };
}
