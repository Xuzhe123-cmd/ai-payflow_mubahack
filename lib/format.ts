/**
 * Presentation helpers.
 *
 * Formatting only — no arithmetic that could change a figure's meaning. Money
 * and date maths live in lib/util, and financial rules live in the
 * deterministic layer. This module exists so components never hand-roll a
 * currency string and drift apart from each other.
 */

import type { Cents, FinalOutcome, IsoDate, Level, TreasuryAction } from "./types";
import { formatMoney, formatMoneyRounded } from "./util/money";
import { parseDate } from "./util/date";

export { formatMoney, formatMoneyRounded };

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Sep 5" — the default in tables and chart axes. */
export function formatDay(value: IsoDate): string {
  const date = parseDate(value);
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** "September 5, 2026" — used where a date is the subject, not a column. */
export function formatFullDate(value: IsoDate): string {
  const date = parseDate(value);
  return `${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatWeekday(value: IsoDate): string {
  const date = parseDate(value);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
}

/** "$140k" / "$1.2M" — chart axes only, where precision is noise. */
export function formatCompactMoney(cents: Cents, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const units = Math.abs(cents) / 100;
  const sign = cents < 0 ? "-" : "";
  if (units >= 1_000_000) return `${sign}${symbol}${(units / 1_000_000).toFixed(units % 1_000_000 === 0 ? 0 : 1)}M`;
  if (units >= 1_000) return `${sign}${symbol}${Math.round(units / 1_000)}k`;
  return `${sign}${symbol}${Math.round(units)}`;
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatSignedMoney(cents: Cents, currency = "USD"): string {
  const body = formatMoneyRounded(Math.abs(cents), currency);
  return `${cents < 0 ? "−" : "+"}${body}`;
}

export function shortWallet(address: string, lead = 10, tail = 6): string {
  if (!address) return "—";
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** "in 5 days" / "today" / "6 days overdue" */
export function describeDueIn(days: number): string {
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days > 1) return `due in ${days} days`;
  return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} overdue`;
}

export const ACTION_LABEL: Record<TreasuryAction, string> = {
  AUTO_PAY: "Pay now",
  SCHEDULE: "Schedule",
  HUMAN_REVIEW: "Human approval",
  REJECT: "Payment rejected",
};

export const OUTCOME_LABEL: Record<FinalOutcome, string> = {
  EXECUTED: "Approved",
  SCHEDULED: "Scheduled",
  AWAITING_APPROVAL: "Awaiting approval",
  HUMAN_REVIEW: "Human approval",
  REJECTED: "Rejected",
  SUI_REJECT: "Would be blocked by Sui",
};

export const LEVEL_INDEX: Record<Level, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export const LEVELS: Level[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** Human wording for the machine-readable evidence codes. */
export const RISK_EVIDENCE_LABEL: Record<string, string> = {
  SUPPLIER_NOT_IN_REGISTRY: "Supplier not in registry",
  SUPPLIER_NOT_APPROVED: "Supplier not approved",
  WALLET_MISMATCH: "Remit wallet does not match registry",
  DUPLICATE_INVOICE: "Duplicate invoice",
  INVOICE_ALREADY_SETTLED: "Payment already settled",
  PO_NOT_FOUND: "Purchase order not found",
  PO_AMOUNT_MISMATCH: "Invoice exceeds purchase order",
  AMOUNT_ABOVE_SUPPLIER_HISTORY: "Amount above supplier history",
  CURRENCY_NOT_ALLOWED: "Currency not permitted",
  NO_SUPPLIER_HISTORY: "No payment history with supplier",
  INCOMPLETE_EXTRACTION: "Invoice fields could not be read",
};

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Turns an engine failure into one readable line.
 *
 * The raw text is a provider error body and is useless on a dashboard, but the
 * fact that no model ran must never be softened — so the phrase always names
 * the failure rather than describing a degraded "AI" result.
 */
export function describeEngineFailure(raw: string | null | undefined): string {
  if (!raw) return "The decision engine did not return a usable answer.";
  if (/daily free allocation|neurons/i.test(raw)) {
    return "The Workers AI account has used its daily allocation.";
  }
  if (/HTTP 429|rate limit/i.test(raw)) return "Workers AI is rate limiting requests.";
  if (/HTTP 40[13]/i.test(raw)) return "Workers AI rejected the credentials.";
  if (/HTTP 5\d\d/i.test(raw)) return "Workers AI returned a server error.";
  if (/abort|timeout/i.test(raw)) return "The model did not respond in time.";
  if (/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN/i.test(raw)) {
    return "Workers AI credentials are not configured.";
  }
  return "Workers AI could not be reached.";
}
