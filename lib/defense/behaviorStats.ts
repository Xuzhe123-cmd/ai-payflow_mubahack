/**
 * What the payment stream actually looks like, measured rather than judged.
 *
 * This module computes; it does not decide. Every field is an observation with
 * a unit, and the scoring in `anomaly.ts` reads them. Splitting the two means a
 * statistic can be checked against arithmetic — "18 payments in 5 minutes" is
 * either true of the input or it is not — without arguing about thresholds.
 *
 * DETERMINISTIC, and clock-injected. `nowMs` is a parameter because a function
 * that reads the clock cannot be tested, and because the window has to be
 * measured against the moment the observation was taken rather than whenever a
 * component happened to render.
 *
 * WHY BEHAVIOUR AND NOT CONTENT. The invoice checks already look at each
 * payment on its own merits, and every one of the 18 payments in the attack
 * pattern passes them individually — right supplier, right wallet, under the
 * ceiling. What gives the attack away is the SHAPE of the stream: the rate, the
 * concentration, and how close to the ceiling the amounts sit. None of that is
 * visible from inside a single payment, which is exactly why it is measured
 * here instead.
 */

export interface PaymentEvent {
  /** When it was authorized. */
  atMs: number;
  amountCents: number;
  recipient: string;
  invoiceNumber: string;
}

/**
 * What the treasury considers ordinary.
 *
 * Supplied rather than assumed, so the baseline can be derived from settled
 * history instead of written into the scorer as a magic number.
 */
export interface Baseline {
  /** Payments per hour, at the top of the ordinary range. */
  maxNormalPerHour: number;
  /** The ordinary payment size. */
  averageAmountCents: number;
  /** How many distinct recipients an ordinary window touches. */
  typicalDistinctRecipients: number;
  /** The per-payment ceiling behaviour is measured against. */
  authorizationCeilingCents: number;
}

export interface BehaviorStats {
  /** Payments inside the window. */
  count: number;
  windowMs: number;
  /** Extrapolated to an hour, so it can be compared with the baseline. */
  ratePerHour: number;
  /** The tightest burst: most payments seen in any 5-minute span. */
  burstCount: number;
  burstWindowMs: number;
  averageAmountCents: number;
  /** Observed average ÷ baseline average. 1 means ordinary. */
  amountDeviationRatio: number;
  distinctRecipients: number;
  /** Share of payments going to the single most-used recipient, 0..1. */
  recipientConcentration: number;
  topRecipient: string | null;
  topRecipientCount: number;
  /** Share of payments at or above 90% of the ceiling, 0..1. */
  nearCeilingRatio: number;
  /** Largest single payment in the window. */
  maxAmountCents: number;
  /** Total authorized in the window. */
  totalAmountCents: number;
}

/** The burst window: the tightest span the monitor reports on. */
export const BURST_WINDOW_MS = 5 * 60 * 1000;

/** At or above this share of the ceiling counts as "riding the limit". */
export const NEAR_CEILING_FRACTION = 0.9;

const EMPTY: Omit<BehaviorStats, "windowMs" | "burstWindowMs"> = {
  count: 0,
  ratePerHour: 0,
  burstCount: 0,
  averageAmountCents: 0,
  amountDeviationRatio: 0,
  distinctRecipients: 0,
  recipientConcentration: 0,
  topRecipient: null,
  topRecipientCount: 0,
  nearCeilingRatio: 0,
  maxAmountCents: 0,
  totalAmountCents: 0,
};

/**
 * Measures the stream over a trailing window.
 *
 * Events outside the window are dropped rather than decayed. A hard edge is
 * cruder than a decay curve and far easier to reason about: a reader can count
 * the events themselves and get the same number.
 */
export function computeBehaviorStats(
  events: readonly PaymentEvent[],
  baseline: Baseline,
  nowMs: number,
  windowMs: number,
): BehaviorStats {
  const inWindow = events
    .filter((event) => event.atMs <= nowMs && nowMs - event.atMs <= windowMs)
    .sort((a, b) => a.atMs - b.atMs);

  if (inWindow.length === 0) {
    return { ...EMPTY, windowMs, burstWindowMs: BURST_WINDOW_MS };
  }

  const total = inWindow.reduce((sum, event) => sum + event.amountCents, 0);
  const average = total / inWindow.length;

  // Recipient concentration: the largest share one address holds.
  const perRecipient = new Map<string, number>();
  for (const event of inWindow) {
    perRecipient.set(event.recipient, (perRecipient.get(event.recipient) ?? 0) + 1);
  }
  let topRecipient: string | null = null;
  let topRecipientCount = 0;
  for (const [recipient, count] of perRecipient) {
    if (count > topRecipientCount) {
      topRecipient = recipient;
      topRecipientCount = count;
    }
  }

  const nearCeiling = inWindow.filter(
    (event) => event.amountCents >= baseline.authorizationCeilingCents * NEAR_CEILING_FRACTION,
  ).length;

  return {
    count: inWindow.length,
    windowMs,
    ratePerHour: (inWindow.length * 3_600_000) / windowMs,
    burstCount: tightestBurst(inWindow, BURST_WINDOW_MS),
    burstWindowMs: BURST_WINDOW_MS,
    averageAmountCents: average,
    amountDeviationRatio:
      baseline.averageAmountCents > 0 ? average / baseline.averageAmountCents : 0,
    distinctRecipients: perRecipient.size,
    recipientConcentration: topRecipientCount / inWindow.length,
    topRecipient,
    topRecipientCount,
    nearCeilingRatio: nearCeiling / inWindow.length,
    maxAmountCents: Math.max(...inWindow.map((event) => event.amountCents)),
    totalAmountCents: total,
  };
}

/**
 * The most events falling inside any span of `spanMs`.
 *
 * A sliding count rather than fixed buckets: 18 payments straddling a bucket
 * boundary are still 18 payments in five minutes, and bucketing would report
 * two unremarkable halves. Events must already be sorted ascending.
 */
function tightestBurst(sorted: readonly PaymentEvent[], spanMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end].atMs - sorted[start].atMs > spanMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * A baseline derived from settled history.
 *
 * Computed from what this treasury has actually done rather than asserted, so
 * the "normal" the monitor compares against is evidence rather than a constant
 * someone typed. Falls back to a stated default only when there is no history
 * at all, and says so by returning `derived: false`.
 */
export function deriveBaseline(
  history: readonly { amountCents: number; recipientWallet: string }[],
  authorizationCeilingCents: number,
  fallbackAverageCents: number,
): Baseline & { derived: boolean } {
  if (history.length === 0) {
    return {
      maxNormalPerHour: 5,
      averageAmountCents: fallbackAverageCents,
      typicalDistinctRecipients: 1,
      authorizationCeilingCents,
      derived: false,
    };
  }

  const average =
    history.reduce((sum, record) => sum + record.amountCents, 0) / history.length;
  const distinct = new Set(history.map((record) => record.recipientWallet)).size;

  return {
    // Settled history carries dates, not timestamps, so the rate ceiling is a
    // stated policy expectation rather than something measured from it. Named
    // here so the scorer does not invent it.
    maxNormalPerHour: 5,
    averageAmountCents: average,
    typicalDistinctRecipients: distinct,
    authorizationCeilingCents,
    derived: true,
  };
}
