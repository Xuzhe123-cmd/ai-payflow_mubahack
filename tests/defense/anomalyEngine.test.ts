/**
 * The anomaly engine: computed, deterministic, and unable to authorize anything.
 *
 * The claim these tests defend is that the score is ARITHMETIC over measured
 * behaviour, not a number chosen to make a demo land. So they assert the
 * direction each signal moves, that no single signal can trip the breaker
 * alone, that the same input always gives the same output, and that what the
 * UI shows matches what the score was actually built from.
 */

import { describe, expect, it } from "vitest";

import {
  BANDS,
  SIGNAL_WEIGHTS,
  TRIP_THRESHOLD,
  assessAnomaly,
  type AnomalySignalId,
} from "../../lib/defense/anomaly";
import {
  computeBehaviorStats,
  deriveBaseline,
  type Baseline,
  type PaymentEvent,
} from "../../lib/defense/behaviorStats";
import {
  ATTACK_DISCLAIMER,
  ATTACK_RECIPIENT,
  buildAttackPattern,
  buildNormalPattern,
} from "../../lib/defense/attackSimulation";

const NOW = 1_800_000_000_000;
const WINDOW = 24 * 60 * 60 * 1000;
const CEILING = 2_500_000; // the live $25,000 authorization

const BASELINE: Baseline = {
  maxNormalPerHour: 5,
  averageAmountCents: 420_000,
  typicalDistinctRecipients: 4,
  authorizationCeilingCents: CEILING,
};

function score(events: PaymentEvent[], baseline: Baseline = BASELINE) {
  return assessAnomaly(computeBehaviorStats(events, baseline, NOW, WINDOW), baseline);
}

/** n payments, spread over `spanMs`, to one recipient at `amountCents`. */
function burst(n: number, spanMs: number, amountCents: number, recipient = ATTACK_RECIPIENT) {
  const step = n > 1 ? spanMs / (n - 1) : 0;
  return Array.from({ length: n }, (_, index) => ({
    atMs: Math.round(NOW - spanMs + index * step),
    amountCents,
    recipient,
    invoiceNumber: `T-${index}`,
  }));
}

/** Ordinary: four modest payments, hours apart, four different suppliers. */
const NORMAL_EVENTS = buildNormalPattern(NOW);

// --- 6: normal behaviour does not trip ---------------------------------------

describe("normal behaviour", () => {
  const result = score(NORMAL_EVENTS);

  it("scores low and does not trip the breaker", () => {
    expect(result.score).toBeLessThan(40);
    expect(result.band).toBe("NORMAL");
    expect(result.exceedsThreshold).toBe(false);
  });

  it("names no abnormal signal", () => {
    expect(result.reasonCodes).toEqual([]);
  });

  it("scores an empty window at zero without dividing by zero", () => {
    const empty = score([]);
    expect(empty.score).toBe(0);
    expect(Number.isNaN(empty.score)).toBe(false);
  });
});

// --- 7-10: each signal moves the score in the right direction ----------------

describe("individual signals", () => {
  it.each<[string, AnomalySignalId, PaymentEvent[]]>([
    ["high frequency", "PAYMENT_FREQUENCY", burst(18, 5 * 60 * 1000, 400_000)],
    [
      "repeated recipient",
      "RECIPIENT_CONCENTRATION",
      burst(8, 20 * 60 * 60 * 1000, 400_000),
    ],
    [
      "near-ceiling amounts",
      "CEILING_PROXIMITY",
      burst(8, 20 * 60 * 60 * 1000, 2_450_000),
    ],
  ])("%s raises the %s signal", (_label, id, events) => {
    const result = score(events);
    const signal = result.signals.find((entry) => entry.id === id)!;
    expect(signal.score).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain(id);
  });

  it("large amount deviation raises the amount signal", () => {
    // Measured against a baseline this treasury would call ordinary.
    const small: Baseline = { ...BASELINE, averageAmountCents: 300_000 };
    const result = score(burst(6, 20 * 60 * 60 * 1000, 2_400_000, "0xaaa"), small);
    const signal = result.signals.find((entry) => entry.id === "AMOUNT_DEVIATION")!;
    expect(signal.score).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain("AMOUNT_DEVIATION");
  });

  it("keeps every signal inside its own weight", () => {
    const extreme = score(burst(200, 60_000, CEILING));
    for (const signal of extreme.signals) {
      expect(signal.score).toBeLessThanOrEqual(SIGNAL_WEIGHTS[signal.id]);
      expect(signal.score).toBeGreaterThanOrEqual(0);
    }
    expect(extreme.score).toBeLessThanOrEqual(100);
  });

  it("stays silent on concentration when there are too few payments to mean anything", () => {
    // One payment is trivially 100% concentrated and says nothing at all.
    const single = score(burst(1, 0, 400_000));
    const signal = single.signals.find((entry) => entry.id === "RECIPIENT_CONCENTRATION")!;
    expect(signal.score).toBe(0);
  });
});

// --- 11: no single signal can trip; combined ones can ------------------------

describe("the trip threshold", () => {
  it("cannot be reached by any single signal alone", () => {
    // The security property behind the weights: a busy hour, one large invoice,
    // or a supplier paid twice must never freeze a treasury on its own.
    for (const weight of Object.values(SIGNAL_WEIGHTS)) {
      expect(weight).toBeLessThan(TRIP_THRESHOLD);
    }
  });

  it("is reached when several signals corroborate", () => {
    const result = score(buildAttackPattern(NOW).events);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(TRIP_THRESHOLD);
    // At least three of the four agreed, which is what the weights force.
    expect(result.reasonCodes.length).toBeGreaterThanOrEqual(3);
  });

  it("orders the bands so every score lands in exactly one", () => {
    for (const value of [0, 39, 40, 69, 70, 89, 90, 100]) {
      const matches = BANDS.filter((entry) => value >= entry.min);
      expect(matches.length).toBeGreaterThan(0);
      expect(BANDS.find((entry) => value >= entry.min)).toBe(matches[0]);
    }
  });
});

// --- 12: determinism ---------------------------------------------------------

describe("determinism", () => {
  it("returns the identical assessment for the identical input", () => {
    const a = score(buildAttackPattern(NOW).events);
    const b = score(buildAttackPattern(NOW).events);
    expect(a).toEqual(b);
  });

  it("builds the same attack pattern every time", () => {
    expect(buildAttackPattern(NOW)).toEqual(buildAttackPattern(NOW));
  });

  it("uses no clock of its own", () => {
    // `nowMs` is a parameter everywhere; a module reading Date.now() could not
    // be tested and would measure the wrong instant.
    const shifted = assessAnomaly(
      computeBehaviorStats(buildAttackPattern(NOW).events, BASELINE, NOW, WINDOW),
      BASELINE,
    );
    const later = assessAnomaly(
      computeBehaviorStats(
        buildAttackPattern(NOW + 5_000_000).events,
        BASELINE,
        NOW + 5_000_000,
        WINDOW,
      ),
      BASELINE,
    );
    expect(later.score).toBe(shifted.score);
  });
});

// --- 13: the reasons shown match the score's actual inputs -------------------

describe("what the UI is given", () => {
  const result = score(buildAttackPattern(NOW).events);

  it("marks exactly the signals that contributed meaningfully", () => {
    const marked = result.signals.filter((signal) => signal.abnormal).map((s) => s.id);
    expect(result.reasonCodes).toEqual(marked);
  });

  it("carries an observed and an expected value for every signal", () => {
    for (const signal of result.signals) {
      expect(signal.observed.length).toBeGreaterThan(0);
      expect(signal.expected.length).toBeGreaterThan(0);
      expect(signal.detail.length).toBeGreaterThan(0);
    }
  });

  it("sums the displayed contributions to the displayed score", () => {
    // The reader can check the arithmetic, so it has to actually add up.
    const total = result.signals.reduce((sum, signal) => sum + signal.score, 0);
    expect(Math.abs(total - result.score)).toBeLessThanOrEqual(0.5);
  });

  it("reports the burst rather than the window average", () => {
    // 18 payments in 5 minutes inside a 24-hour window is an unremarkable
    // hourly rate. The burst is the thing that was abnormal.
    const stats = computeBehaviorStats(buildAttackPattern(NOW).events, BASELINE, NOW, WINDOW);
    expect(stats.burstCount).toBe(18);
    expect(stats.ratePerHour).toBeLessThan(BASELINE.maxNormalPerHour);
    expect(score(buildAttackPattern(NOW).events).reasonCodes).toContain("PAYMENT_FREQUENCY");
  });
});

// --- the simulator is labelled and harmless ----------------------------------

describe("the attack simulator", () => {
  it("says plainly that no model was compromised", () => {
    expect(ATTACK_DISCLAIMER).toContain("no real AI model was compromised");
    expect(buildAttackPattern(NOW).disclaimer).toBe(ATTACK_DISCLAIMER);
  });

  it("produces payments that each pass the per-payment ceiling", () => {
    // The point of the pattern: every payment is individually unremarkable.
    for (const event of buildAttackPattern(NOW).events) {
      expect(event.amountCents).toBeLessThanOrEqual(CEILING);
    }
  });

  it("marks its invoices as simulated so nothing confuses one for real", () => {
    for (const event of buildAttackPattern(NOW).events) {
      expect(event.invoiceNumber.startsWith("SIM-")).toBe(true);
    }
  });
});

// --- the baseline is evidence, not a constant --------------------------------

describe("the baseline", () => {
  it("is derived from settled history when there is any", () => {
    const derived = deriveBaseline(
      [
        { amountCents: 1_000_000, recipientWallet: "0xa" },
        { amountCents: 2_000_000, recipientWallet: "0xb" },
      ],
      CEILING,
      420_000,
    );
    expect(derived.derived).toBe(true);
    expect(derived.averageAmountCents).toBe(1_500_000);
    expect(derived.typicalDistinctRecipients).toBe(2);
  });

  it("says so when it had to fall back", () => {
    const fallback = deriveBaseline([], CEILING, 420_000);
    expect(fallback.derived).toBe(false);
    expect(fallback.averageAmountCents).toBe(420_000);
  });
});
