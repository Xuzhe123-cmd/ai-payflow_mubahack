/**
 * "Why not today?" — the comparison behind a scheduled payment date.
 *
 * A recommendation that says only "pay on Sep 5" hides its reasoning. This
 * re-reads the candidate set the model was offered and states, in exact
 * figures, what paying today would have cost instead.
 *
 * Deterministic: every number comes from simulateCandidateDates(), never from
 * the model's prose. But it runs AFTER the decision — it needs to know which
 * date was chosen — which is why it is not part of DeterministicAnalysis and
 * why the LLM never sees it.
 */

import type { DeterministicAnalysis, IsoDate, WhyNotToday } from "../types";

/**
 * Returns null when there is nothing to explain: no date was chosen, the chosen
 * date IS today, or the candidate set is somehow empty.
 *
 * simulateCandidateDates() always pushes `asOf` first and sorts ascending, so
 * candidate[0] is today by construction.
 */
export function buildWhyNotToday(
  analysis: Readonly<DeterministicAnalysis>,
  recommendedDate: IsoDate | null,
): WhyNotToday | null {
  if (recommendedDate === null) return null;

  const candidates = analysis.cashFlowScenarios;
  const today = candidates[0];
  if (!today || today.paymentDate === recommendedDate) return null;

  const recommended = candidates.find(
    (candidate) => candidate.paymentDate === recommendedDate,
  );
  // validateDecision guarantees the date is in the set; this path stays safe if
  // that ever changes rather than fabricating a comparison.
  if (!recommended) return null;

  const minimumCashDeltaCents =
    recommended.projectedMinimumCashCents - today.projectedMinimumCashCents;
  const discountDeltaCents =
    recommended.discountCapturedCents - today.discountCapturedCents;

  return {
    today,
    recommended,
    alternatives: [...candidates],
    minimumCashDeltaCents,
    discountDeltaCents,
    todayBreaches: today.reserveBreach,
    verdict: decideVerdict(today.reserveBreach, minimumCashDeltaCents, discountDeltaCents),
  };
}

/**
 * Ordered strongest-reason-first.
 *
 * A reserve breach today settles the question on its own. Otherwise an improved
 * trough is the reason the later date was chosen. A given-up discount only
 * becomes the headline when liquidity did NOT improve — that combination is the
 * one worth a second look, so it should not be hidden behind a softer verdict.
 */
function decideVerdict(
  todayBreaches: boolean,
  minimumCashDeltaCents: number,
  discountDeltaCents: number,
): WhyNotToday["verdict"] {
  if (todayBreaches) return "TODAY_BREACHES_RESERVE";
  if (minimumCashDeltaCents > 0) return "LATER_IMPROVES_LIQUIDITY";
  if (discountDeltaCents < 0) return "DISCOUNT_FAVOURS_EARLIER";
  return "TODAY_IS_EQUIVALENT";
}
