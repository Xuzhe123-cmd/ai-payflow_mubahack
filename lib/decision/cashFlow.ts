/**
 * Cash-flow analysis over the live chain state.
 *
 * Reuses `forecastCash` from the deterministic layer rather than re-deriving
 * the arithmetic — that function is what makes "every number the LLM sees is
 * pre-verified" a true statement, so there must be exactly one of it.
 *
 * One distinction runs through this file and is easy to lose:
 *
 *   `breachesReserveImmediately`  — balance − amount < reserve, RIGHT NOW.
 *                                   This is what Move check 9 enforces.
 *   `projectedReserveBreach`      — the forecast trough dips below the reserve
 *                                   at some point in the horizon. Advisory
 *                                   only; the chain never sees it.
 *
 * Conflating them would mean either blocking payments the chain would allow, or
 * promising payments it will refuse.
 */

import type { CashFlowEvent, Cents, IsoDate } from "../types";
import type { ChainCashFlowEvent } from "../sui/chainTypes";
import { forecastCash, horizonCovering } from "../deterministic/forecast";
import { addDays, compareDates, daysBetween, uniqueSortedDates } from "../util/date";
import type { CashFlowAnalysis, PaymentDateOption } from "./types";

/** Days beyond the furthest candidate that the forecast still looks ahead. */
const HORIZON_TAIL_DAYS = 21;
/** How far out a candidate date may sit, so the search stays bounded. */
const MAX_CANDIDATE_HORIZON_DAYS = 60;

export interface CashFlowInput {
  asOf: IsoDate;
  balanceCents: Cents;
  minimumReserveCents: Cents;
  amountCents: Cents;
  dueDate: IsoDate;
  events: readonly ChainCashFlowEvent[];
}

/** The chain's event shape lacks the id the forecaster's type carries. */
function toForecastEvents(events: readonly ChainCashFlowEvent[]): CashFlowEvent[] {
  return events.map((event, index) => ({
    id: `chain_${index}`,
    date: event.date,
    direction: event.direction,
    amountCents: event.amountCents,
    description: event.description,
  }));
}

function costDate(input: CashFlowInput, date: IsoDate, horizonDays: number): PaymentDateOption {
  const events = toForecastEvents(input.events);

  // Two forecasts, because they answer different questions. This one has no
  // payment in it and supplies the balance the vault will actually hold when
  // the transfer is attempted.
  const withoutPayment = forecastCash({
    asOf: input.asOf,
    horizonDays,
    openingCashCents: input.balanceCents,
    minimumReserveCents: input.minimumReserveCents,
    events,
    payment: null,
  });

  const forecast = forecastCash({
    asOf: input.asOf,
    horizonDays,
    openingCashCents: input.balanceCents,
    minimumReserveCents: input.minimumReserveCents,
    events,
    payment: { date, amountCents: input.amountCents },
  });

  /*
   * What the vault holds at the moment of payment — deliberately conservative.
   *
   * A day's CLOSING balance includes that day's inflows, but Move check 9 has
   * no notion of a day: it compares the vault as it stands, right then. A
   * receivable dated the same morning may not have landed when the transaction
   * executes, so counting it would promise payments the chain then refuses.
   * Same-day outflows are subtracted for the same reason, in the other
   * direction — they may already have gone.
   */
  const day = withoutPayment.days.find((entry) => entry.date === date);
  const availableCents = day
    ? day.openingCents - day.outflowCents
    : withoutPayment.closingCents;
  const balanceAfterPayment = availableCents - input.amountCents;

  return {
    date,
    daysFromToday: daysBetween(input.asOf, date),
    balanceAfterPaymentCents: balanceAfterPayment,
    breachesReserveImmediately:
      availableCents < input.amountCents ||
      balanceAfterPayment < input.minimumReserveCents,
    projectedMinimumCashCents: forecast.minimumCashCents,
    projectedMinimumCashDate: forecast.minimumCashDate,
    projectedReserveBreach: forecast.reserveBreach,
    breachDepthCents: forecast.breachDepthCents,
    isAfterDueDate: compareDates(date, input.dueDate) > 0,
    daysBeforeDue: daysBetween(date, input.dueDate),
  };
}

/**
 * A small, curated set of decision-relevant dates rather than every day until
 * the due date: today, the first date the chain would accept, and the due date.
 * A handful of genuinely distinct options keeps the prompt short and the
 * comparison legible.
 */
function candidateDates(input: CashFlowInput, horizonDays: number): IsoDate[] {
  const dates: IsoDate[] = [input.asOf];

  if (
    compareDates(input.dueDate, input.asOf) > 0 &&
    daysBetween(input.asOf, input.dueDate) <= MAX_CANDIDATE_HORIZON_DAYS
  ) {
    dates.push(input.dueDate);
  }

  const safe = findEarliestAcceptableDate(input, horizonDays);
  if (safe) dates.push(safe);

  return uniqueSortedDates(dates);
}

/**
 * Scans forward for the first date the CHAIN would accept — instantaneous
 * balance, not the forecast trough. Recommending a date Move will refuse is
 * worse than recommending none.
 */
function findEarliestAcceptableDate(input: CashFlowInput, horizonDays: number): IsoDate | null {
  const limit = Math.min(
    MAX_CANDIDATE_HORIZON_DAYS,
    Math.max(daysBetween(input.asOf, input.dueDate), 0),
  );
  for (let offset = 0; offset <= limit; offset++) {
    const date = addDays(input.asOf, offset);
    if (!costDate(input, date, horizonDays).breachesReserveImmediately) return date;
  }
  return null;
}

export function analyseCashFlow(input: CashFlowInput): CashFlowAnalysis {
  const furthest = compareDates(input.dueDate, input.asOf) > 0 ? input.dueDate : input.asOf;
  const horizonDays = horizonCovering(input.asOf, furthest, 30) + HORIZON_TAIL_DAYS;

  const candidates = candidateDates(input, horizonDays).map((date) =>
    costDate(input, date, horizonDays),
  );
  const today = candidates[0];
  const acceptable = candidates.find((option) => !option.breachesReserveImmediately);

  const horizonEnd = addDays(input.asOf, horizonDays);
  const inHorizon = input.events.filter(
    (event) =>
      compareDates(event.date, input.asOf) >= 0 && compareDates(event.date, horizonEnd) <= 0,
  );

  return {
    asOf: input.asOf,
    openingBalanceCents: input.balanceCents,
    minimumReserveCents: input.minimumReserveCents,
    amountCents: input.amountCents,
    today,
    candidates,
    earliestSafeDate: acceptable?.date ?? null,
    upcomingInflows: inHorizon
      .filter((event) => event.direction === "INFLOW")
      .sort((a, b) => a.date.localeCompare(b.date)),
    upcomingOutflows: inHorizon
      .filter((event) => event.direction === "OUTFLOW")
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
