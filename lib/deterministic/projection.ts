/**
 * Chart-ready cash projections.
 *
 * Display only — nothing here feeds the LLM or the chain. It exists so the
 * interface can DRAW the forecast without recomputing it: every balance below
 * comes from the same forecastCash() that produced the candidate simulations,
 * so the chart and the decision can never disagree.
 *
 * Keeping this in lib/deterministic rather than in a component is the point.
 * The UI renders points; it never decides what a balance is.
 */

import type { CashFlowEvent, Cents, IsoDate, WorldSnapshot } from "../types";
import { compareDates, daysBetween } from "../util/date";
import { forecastCash } from "./forecast";

export interface ProjectionPoint {
  date: IsoDate;
  balanceCents: Cents;
  inflowCents: Cents;
  outflowCents: Cents;
  paymentCents: Cents;
}

export interface ProjectionSeries {
  id: string;
  label: string;
  /** null for the baseline series, which assumes the invoice is not paid. */
  paymentDate: IsoDate | null;
  points: ProjectionPoint[];
  minimumCashCents: Cents;
  minimumCashDate: IsoDate;
  reserveBreach: boolean;
}

export interface CashProjection {
  asOfDate: IsoDate;
  horizonDays: number;
  currency: string;
  currentCashCents: Cents;
  minimumReserveCents: Cents;
  baseline: ProjectionSeries;
  /** One series per candidate payment date the AI was allowed to choose from. */
  candidates: ProjectionSeries[];
  /** Scheduled events inside the horizon, for chart annotations. */
  events: CashFlowEvent[];
}

export interface ProjectionInput {
  world: WorldSnapshot;
  asOf: IsoDate;
  horizonDays?: number;
  /** The invoice under consideration. Omit for a plain treasury forecast. */
  payment?: { amountCents: Cents; dates: IsoDate[] } | null;
}

const DEFAULT_HORIZON_DAYS = 21;

function buildSeries(
  input: ProjectionInput,
  horizonDays: number,
  id: string,
  label: string,
  payment: { date: IsoDate; amountCents: Cents } | null,
): ProjectionSeries {
  const { world, asOf } = input;
  const forecast = forecastCash({
    asOf,
    horizonDays,
    openingCashCents: world.treasury.currentCashCents,
    minimumReserveCents: world.policy.minimumReserveCents,
    events: world.cashFlowEvents,
    payment,
  });

  return {
    id,
    label,
    paymentDate: payment?.date ?? null,
    points: forecast.days.map((day) => ({
      date: day.date,
      balanceCents: day.closingCents,
      inflowCents: day.inflowCents,
      outflowCents: day.outflowCents,
      paymentCents: day.paymentCents,
    })),
    minimumCashCents: forecast.minimumCashCents,
    minimumCashDate: forecast.minimumCashDate,
    reserveBreach: forecast.reserveBreach,
  };
}

export function buildProjection(input: ProjectionInput): CashProjection {
  const { world, asOf } = input;
  const requested = input.horizonDays ?? DEFAULT_HORIZON_DAYS;

  // A candidate date outside the window would vanish from the chart, so the
  // horizon always stretches far enough to contain the latest one.
  const latestCandidate = input.payment?.dates.reduce(
    (latest, date) => (compareDates(date, latest) > 0 ? date : latest),
    asOf,
  );
  const horizonDays = latestCandidate
    ? Math.max(requested, daysBetween(asOf, latestCandidate) + 3)
    : requested;

  const baseline = buildSeries(input, horizonDays, "baseline", "No payment", null);

  const candidates = (input.payment?.dates ?? []).map((date) =>
    buildSeries(input, horizonDays, `pay_${date}`, `Pay ${date}`, {
      date,
      amountCents: input.payment!.amountCents,
    }),
  );

  const horizonEnd = baseline.points[baseline.points.length - 1]?.date ?? asOf;
  const events = world.cashFlowEvents
    .filter(
      (event) =>
        compareDates(event.date, asOf) >= 0 && compareDates(event.date, horizonEnd) <= 0,
    )
    .sort((a, b) => compareDates(a.date, b.date));

  return {
    asOfDate: asOf,
    horizonDays,
    currency: world.treasury.currency,
    currentCashCents: world.treasury.currentCashCents,
    minimumReserveCents: world.policy.minimumReserveCents,
    baseline,
    candidates,
    events,
  };
}
