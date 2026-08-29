/**
 * Candidate payment-date simulation.
 *
 * Builds a small, meaningful set of dates and fully costs each one, so the LLM
 * reasons over real projections instead of guessing. The set is deliberately
 * curated rather than "every day until due": a handful of decision-relevant
 * dates keeps the prompt short and each option genuinely distinct.
 *
 * Candidates:
 *   - today
 *   - the earliest date on which the reserve is no longer breached
 *   - the early-payment discount deadline
 *   - the due date
 *
 * The LLM must pick one of these; validateDecision() rejects anything else, so
 * this function also defines the space of dates that can ever reach the chain.
 */

import type { CashFlowEvent, CashFlowScenario, Cents, DiscountFacts, IsoDate } from "../types";
import { addDays, compareDates, daysBetween, uniqueSortedDates } from "../util/date";
import { forecastCash, horizonCovering } from "./forecast";

/** Days beyond the furthest candidate that the forecast still looks ahead. */
const HORIZON_TAIL_DAYS = 21;
/** Cap on how far out a candidate may sit, so the search stays bounded. */
const MAX_CANDIDATE_HORIZON_DAYS = 60;

export interface CandidateInput {
  asOf: IsoDate;
  dueDate: IsoDate;
  amountCents: Cents;
  discount: DiscountFacts | null;
  openingCashCents: Cents;
  minimumReserveCents: Cents;
  events: readonly CashFlowEvent[];
}

function costDate(input: CandidateInput, paymentDate: IsoDate, horizonDays: number): CashFlowScenario {
  const { asOf, dueDate, amountCents, discount, openingCashCents, minimumReserveCents, events } = input;

  // A discount is captured only when payment lands on or before its deadline.
  const capturesDiscount =
    discount !== null && compareDates(paymentDate, discount.deadline) <= 0;
  const discountCapturedCents = capturesDiscount ? discount.amountCents : 0;
  const paymentAmountCents = amountCents - discountCapturedCents;

  const forecast = forecastCash({
    asOf,
    horizonDays,
    openingCashCents,
    minimumReserveCents,
    events,
    payment: { date: paymentDate, amountCents: paymentAmountCents },
  });

  return {
    paymentDate,
    daysFromToday: daysBetween(asOf, paymentDate),
    projectedMinimumCashCents: forecast.minimumCashCents,
    projectedMinimumCashDate: forecast.minimumCashDate,
    reserveBreach: forecast.reserveBreach,
    breachDepthCents: forecast.breachDepthCents,
    balanceOnPaymentDateCents:
      forecast.days.find((day) => day.date === paymentDate)?.closingCents ?? forecast.closingCents,
    discountCapturedCents,
    paymentAmountCents,
    isAfterDueDate: compareDates(paymentDate, dueDate) > 0,
    daysBeforeDue: daysBetween(paymentDate, dueDate),
  };
}

/**
 * Scans forward for the first date whose forecast clears the reserve. Returns
 * null when no date within the search window does.
 */
function findEarliestSafeDate(input: CandidateInput, horizonDays: number): IsoDate | null {
  const limit = Math.min(
    MAX_CANDIDATE_HORIZON_DAYS,
    Math.max(daysBetween(input.asOf, input.dueDate), 0),
  );
  for (let offset = 0; offset <= limit; offset++) {
    const date = addDays(input.asOf, offset);
    if (!costDate(input, date, horizonDays).reserveBreach) return date;
  }
  return null;
}

export function simulateCandidateDates(input: CandidateInput): CashFlowScenario[] {
  const { asOf, dueDate, discount } = input;

  const furthest = compareDates(dueDate, asOf) > 0 ? dueDate : asOf;
  const horizonDays = horizonCovering(asOf, furthest, 30) + HORIZON_TAIL_DAYS;

  const candidates: IsoDate[] = [asOf];

  // The due date, when it is still ahead of us and inside the search window.
  if (
    compareDates(dueDate, asOf) > 0 &&
    daysBetween(asOf, dueDate) <= MAX_CANDIDATE_HORIZON_DAYS
  ) {
    candidates.push(dueDate);
  }

  // The discount deadline, when it is still reachable.
  if (discount && compareDates(discount.deadline, asOf) >= 0) {
    candidates.push(discount.deadline);
  }

  const earliestSafe = findEarliestSafeDate(input, horizonDays);
  if (earliestSafe) candidates.push(earliestSafe);

  return uniqueSortedDates(candidates).map((date) => costDate(input, date, horizonDays));
}
