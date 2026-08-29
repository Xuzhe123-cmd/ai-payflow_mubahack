/**
 * UTC-only date arithmetic for "YYYY-MM-DD" strings.
 *
 * Everything here is pure. Nothing in lib/ may call Date.now() — the "today"
 * of a run is always passed in explicitly as `asOf`, which is what makes the
 * whole pipeline reproducible.
 */

import type { IsoDate } from "../types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_RE.test(value)) return false;
  // Reject impossible dates like 2026-02-31 that Date would silently roll over.
  return formatDate(parseDate(value)) === value;
}

/** Parse "YYYY-MM-DD" as UTC midnight. Throws on malformed input. */
export function parseDate(value: IsoDate): Date {
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Format a Date back to "YYYY-MM-DD" using its UTC fields. */
export function formatDate(date: Date): IsoDate {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return formatDate(new Date(parseDate(value).getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / MS_PER_DAY);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Inclusive range of every date from `start` to `end`. Empty if end < start. */
export function eachDayInclusive(start: IsoDate, end: IsoDate): IsoDate[] {
  const span = daysBetween(start, end);
  if (span < 0) return [];
  const out: IsoDate[] = [];
  for (let i = 0; i <= span; i++) out.push(addDays(start, i));
  return out;
}

/** Sorted, de-duplicated dates. */
export function uniqueSortedDates(dates: IsoDate[]): IsoDate[] {
  return [...new Set(dates)].sort(compareDates);
}

/** "2026-09-05" -> "Sep 5, 2026", for prompts and UI. */
export function formatDateLong(value: IsoDate): string {
  const date = parseDate(value);
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][date.getUTCMonth()];
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}
