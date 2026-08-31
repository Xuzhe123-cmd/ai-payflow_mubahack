/**
 * The demo attack pattern, generated rather than asserted.
 *
 * WHAT THIS IS NOT. No AI model was compromised, and nothing here claims one
 * was. This produces a synthetic PAYMENT STREAM with the shape a compromised
 * agent would produce, feeds it through the same statistics and the same scorer
 * the live monitor uses, and lets the arithmetic reach its own conclusion. The
 * score is not written here; it is computed from these events.
 *
 * That distinction is the whole reason the simulator exists. A demo that set
 * the score to 94 would prove nothing about the detector. This one proves the
 * detector responds to behaviour — and it can be checked by changing the
 * pattern and watching the score move.
 *
 * WHY THIS SHAPE. Every individual payment in it would pass every per-payment
 * check: an approved supplier, the registered wallet, under the $25,000
 * ceiling, sound currency, sufficient reserve. That is the point. The attack is
 * invisible one payment at a time and obvious across eighteen of them.
 */

import type { PaymentEvent } from "./behaviorStats";

export const ATTACK_DISCLAIMER =
  "Demo Attack Simulation — no real AI model was compromised. This generates a synthetic " +
  "payment pattern locally and scores it with the same engine the live monitor uses.";

/** Atlas Precision Works — the registered recipient the pattern concentrates on. */
export const ATTACK_RECIPIENT =
  "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690";

/**
 * Amounts, in cents, riding just under the $25,000 authorization ceiling.
 *
 * Fixed and repeating rather than random: the simulation has to be
 * deterministic, so the same click produces the same score every time and a
 * judge watching twice sees the same number.
 */
const AMOUNTS_CENTS = [
  2_400_000, 2_450_000, 2_500_000, 2_480_000, 2_500_000, 2_420_000,
  2_490_000, 2_500_000, 2_460_000, 2_500_000, 2_470_000, 2_500_000,
];

export interface AttackPattern {
  events: PaymentEvent[];
  paymentCount: number;
  spanMs: number;
  disclaimer: string;
}

/**
 * Eighteen payments across five minutes, ending at `nowMs`.
 *
 * Spaced evenly so the burst counter sees all of them inside one span. The
 * invoice numbers are synthetic and deliberately marked SIM- so nothing
 * downstream can confuse one with a real invoice.
 */
export function buildAttackPattern(nowMs: number, count = 18, spanMs = 5 * 60 * 1000): AttackPattern {
  const events: PaymentEvent[] = [];
  // Oldest first, the last one landing at nowMs.
  const step = count > 1 ? spanMs / (count - 1) : 0;

  for (let index = 0; index < count; index += 1) {
    events.push({
      atMs: Math.round(nowMs - spanMs + index * step),
      amountCents: AMOUNTS_CENTS[index % AMOUNTS_CENTS.length],
      recipient: ATTACK_RECIPIENT,
      invoiceNumber: `SIM-ATTACK-${String(index + 1).padStart(2, "0")}`,
    });
  }

  return { events, paymentCount: count, spanMs, disclaimer: ATTACK_DISCLAIMER };
}

/**
 * An ordinary week, for the "before" half of the demo.
 *
 * Spread across several suppliers at ordinary sizes, so the monitor has
 * something real to report as NORMAL rather than an empty window — an empty
 * window scores zero for the uninteresting reason that nothing happened.
 */
export function buildNormalPattern(nowMs: number): PaymentEvent[] {
  const recipients = [
    "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
    "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690",
    "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
    "0x2e6b9d4a7c30f815b6d29a4e7c03f815b6d29a4e7c03f815b6d29a4e7c03f815",
  ];
  const amounts = [380_000, 512_000, 295_000, 640_000];
  const hour = 3_600_000;

  return amounts.map((amountCents, index) => ({
    // Hours apart, not minutes: an ordinary rate, well under the baseline.
    atMs: nowMs - (index + 1) * hour * 3,
    amountCents,
    recipient: recipients[index],
    invoiceNumber: `INV-NORMAL-${index + 1}`,
  }));
}
