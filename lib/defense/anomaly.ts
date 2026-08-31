/**
 * Anomaly scoring: four measured signals, fixed weights, one number.
 *
 * NOTHING HERE IS HARDCODED FOR THE DEMO. The score is a weighted sum of four
 * ratios, each computed from `BehaviorStats`, each capped at its own weight.
 * Feed it ordinary behaviour and it returns single digits; feed it the attack
 * pattern and it returns the nineties. The demo's number is whatever the
 * arithmetic produces — no branch anywhere returns a constant.
 *
 * WHY THESE FOUR, AND WHY WEIGHTED THIS WAY.
 *
 *   FREQUENCY (30)   The clearest signature of an automated attacker: a
 *                    compromised agent's advantage is speed, and speed is the
 *                    one thing it cannot hide while using it.
 *   AMOUNT    (25)   Drain attempts are large relative to ordinary spend.
 *                    Lower than frequency because a genuine large invoice is
 *                    unremarkable on its own.
 *   RECIPIENT (25)   Money going repeatedly to ONE address is what an
 *                    extraction looks like; ordinary weeks are spread across
 *                    suppliers.
 *   CEILING   (20)   Amounts hugging the authorization limit indicate someone
 *                    probing what they can get away with rather than paying
 *                    what is owed. Lowest weight because a treasury with few
 *                    large suppliers can hit it honestly.
 *
 * No single signal can trip the breaker. The maximum from any one is 30, well
 * under the 70 threshold, so a trip always requires corroboration from at least
 * three of the four. That is deliberate: a busy hour, a single big invoice, or
 * a supplier being paid twice should never freeze a treasury on its own.
 *
 * THE SCORE DECIDES NOTHING. It produces a band and a set of reason codes. What
 * follows from a CRITICAL band is a REQUEST to trip the on-chain breaker, which
 * a human-authorised transaction has to carry out. The scorer cannot reach Sui,
 * and Move never sees this number.
 */

import type { Baseline, BehaviorStats } from "./behaviorStats";

export type AnomalyBand = "NORMAL" | "ELEVATED" | "HIGH" | "CRITICAL";

export type AnomalySignalId =
  | "PAYMENT_FREQUENCY"
  | "AMOUNT_DEVIATION"
  | "RECIPIENT_CONCENTRATION"
  | "CEILING_PROXIMITY";

export interface AnomalySignal {
  id: AnomalySignalId;
  label: string;
  /** Points contributed, 0..weight. */
  score: number;
  weight: number;
  /** True once this signal is contributing more than a token amount. */
  abnormal: boolean;
  /** The measurement, in the units a reader can check. */
  observed: string;
  expected: string;
  /** Why it scored what it scored. Shown in the UI verbatim. */
  detail: string;
}

export interface AnomalyAssessment {
  /** 0..100. */
  score: number;
  band: AnomalyBand;
  signals: AnomalySignal[];
  /** Ids of the signals that are abnormal, for machine consumers. */
  reasonCodes: AnomalySignalId[];
  /** True when the score is at or above the trip threshold. */
  exceedsThreshold: boolean;
  threshold: number;
  summary: string;
}

export const SIGNAL_WEIGHTS: Record<AnomalySignalId, number> = {
  PAYMENT_FREQUENCY: 30,
  AMOUNT_DEVIATION: 25,
  RECIPIENT_CONCENTRATION: 25,
  CEILING_PROXIMITY: 20,
};

/**
 * The band boundaries.
 *
 * CRITICAL begins at 90 and the TRIP threshold sits at 70, so HIGH already
 * trips. Freezing a treasury is disruptive but reversible by governance;
 * letting an extraction continue is not, and the asymmetry is why the trigger
 * sits below the top band rather than at it.
 */
export const BANDS: { band: AnomalyBand; min: number }[] = [
  { band: "CRITICAL", min: 90 },
  { band: "HIGH", min: 70 },
  { band: "ELEVATED", min: 40 },
  { band: "NORMAL", min: 0 },
];

export const TRIP_THRESHOLD = 70;

/** A signal contributing more than a fifth of its weight is worth naming. */
const ABNORMAL_FRACTION = 0.2;

/** Scales a ratio into 0..weight, flattening once it is beyond `full`. */
function ramp(value: number, start: number, full: number, weight: number): number {
  if (!Number.isFinite(value) || value <= start) return 0;
  if (value >= full) return weight;
  return ((value - start) / (full - start)) * weight;
}

export function assessAnomaly(stats: BehaviorStats, baseline: Baseline): AnomalyAssessment {
  const signals: AnomalySignal[] = [
    frequencySignal(stats, baseline),
    amountSignal(stats, baseline),
    recipientSignal(stats, baseline),
    ceilingSignal(stats, baseline),
  ];

  // Rounded once, at the end. Rounding each signal first would let four
  // half-points appear or vanish from the total.
  const score = Math.round(
    Math.min(100, signals.reduce((total, signal) => total + signal.score, 0)),
  );
  const band = BANDS.find((entry) => score >= entry.min)!.band;
  const reasonCodes = signals.filter((signal) => signal.abnormal).map((signal) => signal.id);

  return {
    score,
    band,
    signals: signals.map((signal) => ({ ...signal, score: Math.round(signal.score * 10) / 10 })),
    reasonCodes,
    exceedsThreshold: score >= TRIP_THRESHOLD,
    threshold: TRIP_THRESHOLD,
    summary: summarize(score, band, signals),
  };
}

function mark(score: number, weight: number): boolean {
  return score >= weight * ABNORMAL_FRACTION;
}

function frequencySignal(stats: BehaviorStats, baseline: Baseline): AnomalySignal {
  const weight = SIGNAL_WEIGHTS.PAYMENT_FREQUENCY;
  // Measured on the BURST, not the window average. An attacker who fires 18
  // payments in five minutes and then stops has an unremarkable hourly rate,
  // and the burst is the thing that was actually abnormal.
  const burstPerHour = (stats.burstCount * 3_600_000) / stats.burstWindowMs;
  const ratio = baseline.maxNormalPerHour > 0 ? burstPerHour / baseline.maxNormalPerHour : 0;
  // Ordinary up to the baseline; saturated at 8x it.
  const score = ramp(ratio, 1, 8, weight);

  return {
    id: "PAYMENT_FREQUENCY",
    label: "Payment frequency",
    score,
    weight,
    abnormal: mark(score, weight),
    observed:
      stats.burstCount > 0
        ? `${stats.burstCount} in ${Math.round(stats.burstWindowMs / 60_000)} min`
        : "none",
    expected: `${baseline.maxNormalPerHour}/hour`,
    detail:
      stats.burstCount === 0
        ? "No payments in the window."
        : `${stats.burstCount} payments inside ${Math.round(stats.burstWindowMs / 60_000)} minutes ` +
          `is ${burstPerHour.toFixed(0)}/hour against an ordinary ceiling of ${baseline.maxNormalPerHour}/hour.`,
  };
}

function amountSignal(stats: BehaviorStats, baseline: Baseline): AnomalySignal {
  const weight = SIGNAL_WEIGHTS.AMOUNT_DEVIATION;
  // Ordinary up to 2x the baseline average; saturated at 6x.
  const score = ramp(stats.amountDeviationRatio, 2, 6, weight);

  return {
    id: "AMOUNT_DEVIATION",
    label: "Amount pattern",
    score,
    weight,
    abnormal: mark(score, weight),
    observed: stats.count > 0 ? money(stats.averageAmountCents) : "—",
    expected: `~${money(baseline.averageAmountCents)}`,
    detail:
      stats.count === 0
        ? "No payments to measure."
        : `Average ${money(stats.averageAmountCents)} is ${stats.amountDeviationRatio.toFixed(1)}x ` +
          `the ordinary ${money(baseline.averageAmountCents)}.`,
  };
}

function recipientSignal(stats: BehaviorStats, baseline: Baseline): AnomalySignal {
  const weight = SIGNAL_WEIGHTS.RECIPIENT_CONCENTRATION;
  // A single payment is trivially 100% concentrated and means nothing. Below
  // three payments the signal stays silent rather than reporting a certainty it
  // does not have.
  const score =
    stats.count < 3 ? 0 : ramp(stats.recipientConcentration, 0.5, 0.95, weight);

  return {
    id: "RECIPIENT_CONCENTRATION",
    label: "Recipient pattern",
    score,
    weight,
    abnormal: mark(score, weight),
    observed:
      stats.count === 0
        ? "—"
        : `${stats.distinctRecipients} recipient${stats.distinctRecipients === 1 ? "" : "s"}` +
          ` · ${Math.round(stats.recipientConcentration * 100)}% to one`,
    expected: `~${baseline.typicalDistinctRecipients} suppliers`,
    detail:
      stats.count < 3
        ? "Too few payments for concentration to mean anything."
        : `${stats.topRecipientCount} of ${stats.count} payments went to a single address.`,
  };
}

function ceilingSignal(stats: BehaviorStats, baseline: Baseline): AnomalySignal {
  const weight = SIGNAL_WEIGHTS.CEILING_PROXIMITY;
  // Ordinary while under a third; saturated when nearly everything rides it.
  const score = stats.count < 3 ? 0 : ramp(stats.nearCeilingRatio, 0.33, 0.9, weight);

  return {
    id: "CEILING_PROXIMITY",
    label: "Authorization usage",
    score,
    weight,
    abnormal: mark(score, weight),
    observed:
      stats.count === 0 ? "—" : `${Math.round(stats.nearCeilingRatio * 100)}% near ceiling`,
    expected: `< 33% of ${money(baseline.authorizationCeilingCents)}`,
    detail:
      stats.count < 3
        ? "Too few payments to read a pattern."
        : `${Math.round(stats.nearCeilingRatio * 100)}% of payments sit at or above 90% of the ` +
          `${money(baseline.authorizationCeilingCents)} ceiling.`,
  };
}

function summarize(score: number, band: AnomalyBand, signals: AnomalySignal[]): string {
  const named = signals
    .filter((signal) => signal.abnormal)
    .map((signal) => signal.label.toLowerCase());

  if (named.length === 0) {
    return `Behaviour is within the ordinary range (score ${score}/100).`;
  }
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return `${band} — ${list} ${named.length === 1 ? "is" : "are"} outside the ordinary range (score ${score}/100).`;
}

function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}
