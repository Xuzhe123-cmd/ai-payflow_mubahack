/**
 * The demo clock.
 *
 * The seeded invoices and the on-chain objects carry fixed dates, so "today"
 * has to be pinned or the whole demo drifts into the past the day after it is
 * recorded. Demo day is 6 September 2026, and that is what the app presents.
 *
 * Nothing here reads the host machine's clock. That is the point: the demo must
 * produce the same decisions on the presenter's laptop, on a judge's laptop in
 * another timezone, and in CI, whatever their system date happens to say. Every
 * "today" in the product resolves to this module, and `lib/util/date.ts` keeps
 * the arithmetic on top of it pure.
 *
 * Wall-clock time is still used for one thing — measuring how long a pipeline
 * step took — because that is a stopwatch, not a calendar, and a duration of
 * "0ms" would be a worse lie than a real one.
 */

import type { IsoDate } from "../types";

/** Demo day. Every scenario's `asOf`, and the default "today" everywhere. */
export const DEMO_AS_OF_DATE: IsoDate = "2026-09-06";

/**
 * The instant within demo day used for timestamp arithmetic — recommendation
 * issue and expiry, and the `nowMs` the expiry check is judged against.
 *
 * 09:00 UTC: far enough into the day that a 24-hour recommendation window opens
 * and closes inside it, so RECOMMENDATION_EXPIRED never fires by accident.
 */
export const DEMO_CLOCK_MS = Date.UTC(2026, 8, 6, 9, 0, 0);

/** What the UI puts next to the DEMO CLOCK badge. */
export const DEMO_CLOCK_LABEL = "Sep 6, 2026";

/** The fixed "now" for anything that needs an instant rather than a date. */
export function demoNowMs(): number {
  return DEMO_CLOCK_MS;
}
