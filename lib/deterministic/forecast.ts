/**
 * Deterministic cash-flow forecast.
 *
 * Balances are end-of-day:
 *   closing = opening + inflows − outflows − payment(if scheduled that day)
 *
 * Pure integer arithmetic over a fixed horizon. This is the function that makes
 * "the numbers given to the LLM are pre-verified" a true statement, so it must
 * never be approximated or delegated.
 */

import type { CashFlowEvent, Cents, IsoDate } from "../types";
import { addDays, compareDates, daysBetween } from "../util/date";

export interface DailyBalance {
  date: IsoDate;
  openingCents: Cents;
  inflowCents: Cents;
  outflowCents: Cents;
  paymentCents: Cents;
  closingCents: Cents;
}

export interface CashForecast {
  days: DailyBalance[];
  minimumCashCents: Cents;
  minimumCashDate: IsoDate;
  reserveBreach: boolean;
  /** How far the trough falls below the reserve. 0 when there is no breach. */
  breachDepthCents: Cents;
  closingCents: Cents;
}

export interface ForecastInput {
  asOf: IsoDate;
  horizonDays: number;
  openingCashCents: Cents;
  minimumReserveCents: Cents;
  events: readonly CashFlowEvent[];
  /** The invoice payment being considered, if any. */
  payment: { date: IsoDate; amountCents: Cents } | null;
}

export function forecastCash(input: ForecastInput): CashForecast {
  const { asOf, horizonDays, openingCashCents, minimumReserveCents, events, payment } = input;

  // Bucket events by date so the loop stays O(horizon + events).
  const inflows = new Map<IsoDate, Cents>();
  const outflows = new Map<IsoDate, Cents>();
  for (const event of events) {
    // Events before the horizon start are already reflected in opening cash.
    if (compareDates(event.date, asOf) < 0) continue;
    const bucket = event.direction === "INFLOW" ? inflows : outflows;
    bucket.set(event.date, (bucket.get(event.date) ?? 0) + event.amountCents);
  }

  const days: DailyBalance[] = [];
  let balance = openingCashCents;
  let minimumCashCents = Number.POSITIVE_INFINITY;
  let minimumCashDate = asOf;

  for (let offset = 0; offset <= horizonDays; offset++) {
    const date = addDays(asOf, offset);
    const inflowCents = inflows.get(date) ?? 0;
    const outflowCents = outflows.get(date) ?? 0;
    const paymentCents = payment && payment.date === date ? payment.amountCents : 0;

    const openingCents = balance;
    balance = openingCents + inflowCents - outflowCents - paymentCents;

    days.push({ date, openingCents, inflowCents, outflowCents, paymentCents, closingCents: balance });

    if (balance < minimumCashCents) {
      minimumCashCents = balance;
      minimumCashDate = date;
    }
  }

  const breachDepthCents = Math.max(0, minimumReserveCents - minimumCashCents);

  return {
    days,
    minimumCashCents,
    minimumCashDate,
    reserveBreach: breachDepthCents > 0,
    breachDepthCents,
    closingCents: balance,
  };
}

/**
 * Payments dated outside the forecast window would silently vanish from the
 * trough calculation, so callers size the horizon to cover them.
 */
export function horizonCovering(asOf: IsoDate, latest: IsoDate, minimumDays: number): number {
  return Math.max(minimumDays, daysBetween(asOf, latest) + 1);
}
