/**
 * The timing answer — "when should this be paid?" — and where it came from.
 *
 * THREE THINGS THAT KEPT GETTING CONFLATED, and the bug this file exists to
 * end. The cash-flow page collapsed all three into one sentence:
 *
 *   1. the SIMULATION      deterministic arithmetic over candidate dates
 *   2. the RECOMMENDATION  a live model's timing verdict, or a recorded one
 *   3. the AUTHORIZATION   what Sui will actually permit
 *
 * When the model was unreachable the safety fallback returned
 * `recommendedDate: null`, and the page rendered "No payment date — this
 * invoice does not proceed". That is a statement about the TREASURY, made on
 * the strength of a fact about the NETWORK. The simulation had run, several
 * dates cleared the reserve comfortably, and the screen said none did.
 *
 * So the recommendation is derived here from the scenarios the deterministic
 * layer already produced, and it carries its own provenance. A model outage
 * costs the recommendation its LIVE label. It does not cost the invoice its
 * payment dates, and it grants no authority either way — `source` is for
 * display, and nothing downstream may read it as permission.
 *
 * WHY IT CANNOT CONTRADICT THE SCREEN. It selects from the same
 * `CashFlowScenario[]` the page renders, by the same rule the deterministic
 * engine uses, and every figure it quotes is read off the chosen scenario. It
 * has no numbers of its own.
 */

import type { CashFlowScenario, Cents, IsoDate, PolicyFacts } from "../types";

export type RecommendationSource =
  /** A live model produced this timing verdict. */
  | "LIVE"
  /** The model was unreachable; the deterministic scenario decided it. */
  | "DEMO_FALLBACK";

export interface CashFlowRecommendation {
  /** Null ONLY when no candidate date clears the reserve. */
  recommendedDate: IsoDate | null;
  source: RecommendationSource;
  /** The large line: "Schedule for 20 September", or the refusal. */
  headline: string;
  /** Why, in figures taken from the chosen scenario. */
  reason: string;
  /**
   * What paying today would cost instead, when today is not the answer.
   *
   * The comparison that makes the case legible — "waiting preserves $15,000
   * more headroom" — and it is a subtraction of two displayed figures, never a
   * number written here.
   */
  comparison: string | null;
  /** True when every candidate date breaches the reserve. */
  noSafeDate: boolean;
}

/**
 * The date a treasurer would actually choose, and why it is not the engine's.
 *
 * TWO DIFFERENT QUESTIONS, DELIBERATELY ANSWERED DIFFERENTLY.
 *
 *   `deterministicEngine` answers "may the agent settle this NOW?" — so it
 *   takes today whenever today is safe. That is the right rule for an
 *   AUTHORIZATION decision: it never defers a payment it is allowed to make.
 *
 *   This answers "when is it financially best to pay?" — the AI CFO question.
 *   On a $30,000 invoice due in fourteen days with no discount, paying today
 *   projects a $70,000 trough and waiting until the due date projects $85,000.
 *   Both clear the reserve; one keeps $15,000 more headroom for nothing. A CFO
 *   waits, and the engine's rule cannot express that because it is not what the
 *   engine is for.
 *
 * The order below is the whole rule, and every clause is a real cost:
 *
 *   1. A DISCOUNT is money on the table. Take the dates that capture the most
 *      of it; nothing about headroom outweighs cash already offered.
 *   2. NEVER RECOMMEND PAYING LATE. Dates past the due date are dropped while
 *      any on-time date survives — a better trough is not worth a late fee or
 *      a supplier relationship.
 *   3. OVERDUE ALREADY? Pay at the earliest safe date. Waiting compounds it.
 *   4. Otherwise take the best projected trough, earliest date breaking ties.
 *
 * This function decides DISPLAY only. It grants nothing, and `execute_payment`
 * has never heard of it.
 */
export function chooseScenario(
  scenarios: readonly CashFlowScenario[],
  asOfDate: IsoDate,
): { chosen: CashFlowScenario | null; today: CashFlowScenario | null } {
  const today = scenarios.find((entry) => entry.paymentDate === asOfDate) ?? null;
  const safe = scenarios.filter((entry) => !entry.reserveBreach);
  if (safe.length === 0) return { chosen: null, today };

  // 1. Discount first.
  const bestDiscount = Math.max(...safe.map((entry) => entry.discountCapturedCents));
  if (bestDiscount > 0) {
    return { chosen: earliest(safe.filter((e) => e.discountCapturedCents === bestDiscount)), today };
  }

  // 2 & 3. On-time dates only, unless the invoice is already past due — in
  // which case every date is late and the earliest is the least late.
  const onTime = safe.filter((entry) => !entry.isAfterDueDate);
  if (onTime.length === 0) return { chosen: earliest(safe), today };

  // 4. The most headroom, earliest date winning ties.
  const best = onTime.reduce((winner, entry) =>
    entry.projectedMinimumCashCents > winner.projectedMinimumCashCents ? entry : winner,
  );
  return { chosen: best, today };
}

function earliest(scenarios: readonly CashFlowScenario[]): CashFlowScenario {
  return scenarios.reduce((winner, entry) =>
    entry.daysFromToday < winner.daysFromToday ? entry : winner,
  );
}

export interface RecommendationInput {
  scenarios: readonly CashFlowScenario[];
  policy: Pick<PolicyFacts, "minimumReserveCents">;
  asOfDate: IsoDate;
  /**
   * The live model's chosen date, when a live model produced one.
   *
   * `null` means no live verdict is available — either the model was
   * unreachable, or it declined to name a date. Both fall back to the
   * deterministic scenario, and both are labelled as such.
   */
  liveRecommendedDate?: IsoDate | null;
  /** The live model's own prose, used verbatim when it is the source. */
  liveExplanation?: string | null;
}

export function cashFlowRecommendation(input: RecommendationInput): CashFlowRecommendation {
  const { chosen, today } = chooseScenario(input.scenarios, input.asOfDate);
  const reserve = input.policy.minimumReserveCents;

  // ---- the only legitimate "no payment date" ------------------------------
  //
  // A property of the FORECAST, never of the model's availability. If it were
  // ever reached because a network call failed, the page would be telling a
  // reader their treasury cannot absorb an invoice it can comfortably absorb.
  if (chosen === null) {
    return {
      recommendedDate: null,
      source: input.liveRecommendedDate ? "LIVE" : "DEMO_FALLBACK",
      headline: "No payment date clears the minimum reserve",
      reason:
        input.scenarios.length === 0
          ? "No payment dates were costed for this invoice."
          : `Every simulated date takes the projected trough below the ${money(reserve)} reserve.`,
      comparison: null,
      noSafeDate: true,
    };
  }

  // ---- a live verdict, when there is one ----------------------------------
  //
  // Honoured only when it names a date the simulation actually offers. A model
  // that picks a date the page does not show would put the recommendation and
  // the table into open disagreement, and the table is the arithmetic.
  const live = input.liveRecommendedDate
    ? (input.scenarios.find((entry) => entry.paymentDate === input.liveRecommendedDate) ?? null)
    : null;

  const selected = live ?? chosen;
  const source: RecommendationSource = live ? "LIVE" : "DEMO_FALLBACK";

  return {
    recommendedDate: selected.paymentDate,
    source,
    headline:
      selected.daysFromToday === 0
        ? "Pay today"
        : `Schedule for ${selected.paymentDate}`,
    reason:
      source === "LIVE" && input.liveExplanation
        ? input.liveExplanation
        : `Paying on ${selected.paymentDate} projects a ${money(selected.projectedMinimumCashCents)} trough on ` +
          `${selected.projectedMinimumCashDate}, against a ${money(reserve)} reserve.`,
    comparison: compare(today, selected, reserve),
    noSafeDate: false,
  };
}

/**
 * What waiting buys, or what paying today would cost.
 *
 * Both figures come off scenarios the page renders, so the sentence can be
 * checked against the table immediately above it.
 */
function compare(
  today: CashFlowScenario | null,
  selected: CashFlowScenario,
  reserve: Cents,
): string | null {
  if (!today || today.paymentDate === selected.paymentDate) return null;

  const gain = selected.projectedMinimumCashCents - today.projectedMinimumCashCents;
  if (today.reserveBreach) {
    return (
      `Paying today projects a ${money(today.projectedMinimumCashCents)} trough, below the ` +
      `${money(reserve)} reserve. Waiting until ${selected.paymentDate} leaves ` +
      `${money(selected.projectedMinimumCashCents)} instead.`
    );
  }
  if (gain <= 0) return null;
  return (
    `Waiting until ${selected.paymentDate} preserves ${money(gain)} more projected ` +
    "minimum-cash headroom than paying today."
  );
}

function money(cents: Cents): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}
