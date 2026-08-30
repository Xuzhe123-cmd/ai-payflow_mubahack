/**
 * Turns a validated AI decision into a PaymentRecommendation.
 *
 * This is the layer the addendum asks for explicitly: the AI's answer to "what
 * SHOULD happen" is a named artifact, distinct from the PaymentRequest that
 * asks the chain "may this happen". A recommendation is advisory and nothing
 * here can spend money — no function in the codebase takes a
 * PaymentRecommendation and returns a transaction.
 *
 * Every figure is re-read from the deterministic analysis. The model supplies
 * judgement and prose; it never supplies a number that ends up on screen as
 * fact.
 */

import type {
  DeterministicAnalysis,
  PaymentRecommendation,
  TreasuryDecision,
} from "../types";
import { buildWhyNotToday } from "../deterministic/whyNotToday";

/**
 * How long a recommendation stays usable. Enforced on-chain as well as here —
 * an expired recommendation is a Move check, not a frontend convention.
 */
export const RECOMMENDATION_TTL_MS = 24 * 60 * 60 * 1000;

export function buildPaymentRecommendation(
  decision: Readonly<TreasuryDecision>,
  analysis: Readonly<DeterministicAnalysis>,
  generatedAtMs: number,
): PaymentRecommendation {
  const candidates = analysis.cashFlowScenarios;
  const today = candidates[0] ?? null;

  // The candidate the recommendation actually points at. Falls back to today so
  // an escalation still reports a real cash position rather than zeroes.
  const chosen =
    (decision.recommendedDate
      ? candidates.find((candidate) => candidate.paymentDate === decision.recommendedDate)
      : null) ?? today;

  const whyNotToday = buildWhyNotToday(analysis, decision.recommendedDate);

  return {
    recommendationId: recommendationIdFor(decision, analysis),
    action: decision.action,
    recommendedDate: decision.recommendedDate,
    riskLevel: decision.risk,
    riskReasons: [...decision.reasons],
    urgencyLevel: decision.urgency,
    cashStatus: chosen?.reserveBreach ? "RESERVE_BREACH" : "SAFE",
    projectedMinimumCashCents: chosen?.projectedMinimumCashCents ?? 0,
    minimumReserveCents: analysis.policyFacts.minimumReserveCents,
    reserveBreach: chosen?.reserveBreach ?? false,
    // Only the discount delta — see the note on the type. Zero when the
    // recommendation is to pay today, or when no date was chosen at all.
    financialImpactCents: whyNotToday?.discountDeltaCents ?? 0,
    whyNotToday,
    reason: decision.decisionExplanation,
    aiConfidence: decision.confidence,
    generatedAtMs,
    expiresAtMs: generatedAtMs + RECOMMENDATION_TTL_MS,
  };
}

/**
 * Stable identity for one recommendation.
 *
 * Deliberately hashes only what the recommendation is ABOUT — invoice, action,
 * date, amount — and not when it was generated, so re-running the same decision
 * produces the same id and the audit trail stays joinable across replays.
 */
function recommendationIdFor(
  decision: Readonly<TreasuryDecision>,
  analysis: Readonly<DeterministicAnalysis>,
): string {
  const seed = [
    analysis.invoiceFacts.invoiceNumber,
    decision.action,
    decision.recommendedDate ?? "-",
    String(analysis.invoiceFacts.amountCents),
  ].join(":");
  return `rec_${fnv1a32(seed)}`;
}

/** FNV-1a, 32-bit. Not a security hash — an identity for joining records. */
function fnv1a32(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
