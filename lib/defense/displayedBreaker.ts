/**
 * Which breaker reading the interface should show.
 *
 * WHY THIS IS ITS OWN FUNCTION. The rule lived inline in the panel as a chain
 * of `||`, and it was wrong twice — once masking a trip behind a stale reset,
 * once behind a lagging index. Neither was catchable by reading the source,
 * because both were about the ORDER results arrive in, not about what the code
 * says. Pulled out here it can be tested against real sequences.
 *
 * THE RULE. Show the most recently CONFIRMED action's chain read; otherwise the
 * current snapshot. "Confirmed" means the request completed and carried back a
 * state the route had re-read from Sui — never an assumption about what the
 * transaction should have done.
 *
 * RECENCY, NOT ORDER. The bug this replaces resolved by position: a completed
 * reset was checked first, so its NORMAL outranked a later trip's HUMAN_ONLY
 * for the rest of the session. The panel now clears one when the other starts,
 * so at most one is ever `done` — and this function stays correct even if both
 * somehow were, by preferring whichever completed later.
 */

export type ActionPhase = "idle" | "running" | "refreshing" | "stale" | "done" | "failed";

/** The minimum an action must carry for its result to be displayable. */
export interface ConfirmedAction<TBreaker> {
  phase: ActionPhase;
  breaker?: TBreaker | null;
  /** When the result arrived. Absent results are treated as oldest. */
  completedAt?: number;
}

/**
 * @param snapshot the page's own periodic chain read. The fallback, and the
 *                 only source once no action result is newer than it.
 */
export function resolveDisplayedBreaker<TBreaker>(
  reset: ConfirmedAction<TBreaker>,
  trip: ConfirmedAction<TBreaker>,
  snapshot: TBreaker | null,
): TBreaker | null {
  const resetDone = reset.phase === "done" && reset.breaker ? reset : null;
  const tripDone = trip.phase === "done" && trip.breaker ? trip : null;

  if (resetDone && tripDone) {
    // Both completed: the later one describes the treasury now. Ties go to the
    // trip, because a freeze is the safer thing to show when the ordering is
    // genuinely unknown.
    const resetAt = resetDone.completedAt ?? 0;
    const tripAt = tripDone.completedAt ?? 0;
    return (tripAt >= resetAt ? tripDone.breaker : resetDone.breaker) ?? snapshot;
  }

  return (resetDone?.breaker ?? tripDone?.breaker) ?? snapshot;
}
