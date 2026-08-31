/**
 * Reads the breaker back after a write, waiting for the indexer to catch up.
 *
 * THE BUG THIS FIXES. `readBreakerState` goes through the GraphQL indexer,
 * which trails the fullnode by a second or two. A `trip_breaker` that had
 * already succeeded was re-read immediately afterwards and came back with its
 * PRE-transaction value — so the interface faithfully rendered ARMED for a
 * treasury the chain had just frozen. Nothing lied; the read was simply taken
 * before the index moved.
 *
 * This repo already knew about the hazard: `ChainQueries.getObjectVersion`
 * carries a comment about telling "genuinely not what was expected" apart from
 * "the indexer has not caught up", written after the same failure surfaced in
 * the escrow flow. The breaker re-read never got the same treatment.
 *
 * WHAT IT DOES NOT DO. It never invents the expected state. If the index has
 * not converged within the budget it says so — `converged: false` with the last
 * state actually read — and the caller reports the transaction as submitted
 * with its chain state still settling. A digest is proof the write happened; a
 * stale read is not proof it did not.
 */

import { readBreakerState, type BreakerMode, type BreakerState } from "./breakerReader";
import type { createSuiQueries } from "./client";

/** ~6 seconds total. Testnet's index typically moves within one or two. */
const ATTEMPTS = 8;
const DELAY_MS = 750;

export interface BreakerConvergence {
  state: BreakerState;
  /** True when the read matched what the transaction should have produced. */
  converged: boolean;
  attempts: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the breaker reads as `expected`, or the budget runs out.
 *
 * The FIRST read happens immediately, so a caught-up index costs nothing. Only
 * a lagging one pays the delay.
 */
export async function readBreakerUntil(
  queries: ReturnType<typeof createSuiQueries>,
  treasuryId: string,
  expected: BreakerMode,
  attempts = ATTEMPTS,
  delayMs = DELAY_MS,
): Promise<BreakerConvergence> {
  let state = await readBreakerState(queries, treasuryId);
  let taken = 1;

  while (state.mode !== expected && taken < attempts) {
    await sleep(delayMs);
    state = await readBreakerState(queries, treasuryId);
    taken += 1;
  }

  return { state, converged: state.mode === expected, attempts: taken };
}
