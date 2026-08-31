/**
 * Which breaker reading the panel shows, across real action sequences.
 *
 * THE BUG THIS EXISTS FOR. The rule was a chain of `||` inline in the panel:
 *
 *   (reset.phase === "done" && reset.breaker) ||
 *   (trip.phase  === "done" && trip.breaker)  ||
 *   snapshot.breaker
 *
 * It resolved by POSITION. Once a reset completed, nothing ever cleared its
 * phase, so its NORMAL outranked every later trip for the rest of the session —
 * and the panel showed 🟢 ARMED for a treasury Sui had frozen ten seconds
 * earlier. Reading the source told you nothing; only the ORDER results arrive
 * in reveals it. Hence a pure function and sequence tests.
 *
 * Verified against the live chain when this was found: mode HUMAN_ONLY,
 * trip_count 6, while the screen read ARMED / NORMAL.
 */

import { describe, expect, it } from "vitest";

import { resolveDisplayedBreaker } from "../../lib/defense/displayedBreaker";

type Mode = "NORMAL" | "HUMAN_ONLY" | "NOT_INSTALLED";

const NORMAL = { mode: "NORMAL" as Mode };
const TRIPPED = { mode: "HUMAN_ONLY" as Mode };

const idle = { phase: "idle" as const };
const running = { phase: "running" as const };
const done = (breaker: { mode: Mode }, completedAt: number) => ({
  phase: "done" as const,
  breaker,
  completedAt,
});

// --- the exact sequence that shipped broken ----------------------------------

describe("reset, then simulate, then trip", () => {
  it("renders TRIPPED — the trip is newer than the reset", () => {
    // 1. reset succeeds  → NORMAL
    // 2. simulate attack
    // 3. trip succeeds   → HUMAN_ONLY
    const shown = resolveDisplayedBreaker(
      done(NORMAL, 1_000),
      done(TRIPPED, 2_000),
      NORMAL,
    );
    expect(shown).toBe(TRIPPED);
    expect(shown?.mode).toBe("HUMAN_ONLY");
  });

  it("does NOT let the completed reset mask it", () => {
    // The precise failure: position-based precedence returned the reset.
    const shown = resolveDisplayedBreaker(done(NORMAL, 1_000), done(TRIPPED, 2_000), null);
    expect(shown?.mode).not.toBe("NORMAL");
  });

  it("holds even when the snapshot still lags behind", () => {
    // The snapshot is the slowest source; it must never override a confirmed
    // read that is newer than it.
    const shown = resolveDisplayedBreaker(
      done(NORMAL, 1_000),
      done(TRIPPED, 2_000),
      NORMAL,
    );
    expect(shown?.mode).toBe("HUMAN_ONLY");
  });

  it("is what the panel actually clears, so both can never be done at once", () => {
    // Belt and braces: the panel sets the other action to idle when one starts,
    // so in practice only one is ever `done`. This asserts that too.
    const afterTripStarted = resolveDisplayedBreaker(idle, running, TRIPPED);
    expect(afterTripStarted).toBe(TRIPPED);
  });
});

// --- the reverse sequence ------------------------------------------------------

describe("trip, then reset", () => {
  it("renders ARMED/NORMAL — the reset is newer than the trip", () => {
    // 1. trip succeeds  → HUMAN_ONLY
    // 2. reset succeeds → NORMAL
    const shown = resolveDisplayedBreaker(
      done(NORMAL, 2_000),
      done(TRIPPED, 1_000),
      TRIPPED,
    );
    expect(shown).toBe(NORMAL);
    expect(shown?.mode).toBe("NORMAL");
  });

  it("does NOT let the completed trip mask the recovery", () => {
    const shown = resolveDisplayedBreaker(done(NORMAL, 2_000), done(TRIPPED, 1_000), null);
    expect(shown?.mode).not.toBe("HUMAN_ONLY");
  });
});

// --- a full rehearsal cycle ----------------------------------------------------

describe("repeated rehearsal", () => {
  it("tracks the newest confirmation through trip → reset → trip", () => {
    // Each step is what the panel would hold at that moment, given it clears
    // the other action when one begins.
    const afterFirstTrip = resolveDisplayedBreaker(idle, done(TRIPPED, 1_000), NORMAL);
    expect(afterFirstTrip?.mode).toBe("HUMAN_ONLY");

    const afterReset = resolveDisplayedBreaker(done(NORMAL, 2_000), idle, TRIPPED);
    expect(afterReset?.mode).toBe("NORMAL");

    const afterSecondTrip = resolveDisplayedBreaker(idle, done(TRIPPED, 3_000), NORMAL);
    expect(afterSecondTrip?.mode).toBe("HUMAN_ONLY");
  });

  it("never goes stale across many cycles", () => {
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const tripped = resolveDisplayedBreaker(idle, done(TRIPPED, cycle * 10), NORMAL);
      expect(tripped?.mode, `cycle ${cycle} trip`).toBe("HUMAN_ONLY");
      const reset = resolveDisplayedBreaker(done(NORMAL, cycle * 10 + 5), idle, TRIPPED);
      expect(reset?.mode, `cycle ${cycle} reset`).toBe("NORMAL");
    }
  });
});

// --- the snapshot is the fallback, never the override -------------------------

describe("falling back to the snapshot", () => {
  it("uses the snapshot when no action has completed", () => {
    expect(resolveDisplayedBreaker(idle, idle, TRIPPED)).toBe(TRIPPED);
    expect(resolveDisplayedBreaker(running, running, NORMAL)).toBe(NORMAL);
  });

  it("uses the snapshot when an action completed without a chain read", () => {
    // A result carrying no breaker proves nothing about the chain.
    const noRead = { phase: "done" as const, breaker: null, completedAt: 9_000 };
    expect(resolveDisplayedBreaker(noRead, idle, TRIPPED)).toBe(TRIPPED);
    expect(resolveDisplayedBreaker(idle, noRead, NORMAL)).toBe(NORMAL);
  });

  it("returns null only when there is nothing to show at all", () => {
    expect(resolveDisplayedBreaker(idle, idle, null)).toBeNull();
  });

  it("ignores failed and stale phases", () => {
    const failed = { phase: "failed" as const };
    const stale = { phase: "stale" as const };
    expect(resolveDisplayedBreaker(stale, failed, TRIPPED)).toBe(TRIPPED);
  });
});

// --- ordering safety -----------------------------------------------------------

describe("when recency is unknown", () => {
  it("prefers the freeze on a tie", () => {
    // Equal timestamps: showing TRIPPED is the safer error, since it never
    // claims autonomy the chain may not permit.
    const shown = resolveDisplayedBreaker(done(NORMAL, 5_000), done(TRIPPED, 5_000), null);
    expect(shown?.mode).toBe("HUMAN_ONLY");
  });

  it("treats a result with no timestamp as oldest", () => {
    const undated = { phase: "done" as const, breaker: NORMAL };
    const shown = resolveDisplayedBreaker(undated, done(TRIPPED, 1), null);
    expect(shown?.mode).toBe("HUMAN_ONLY");
  });
});
