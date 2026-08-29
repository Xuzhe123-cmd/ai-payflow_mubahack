/**
 * Money helpers. All amounts are integer minor units (cents) so that the
 * deterministic layer never accumulates floating-point error — the LLM is told
 * these figures are pre-verified, so they have to actually be exact.
 */

import type { Cents } from "../types";

/** Build cents from a major-unit amount, e.g. dollars(1234.56) === 123456. */
export function dollars(amount: number): Cents {
  return Math.round(amount * 100);
}

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be integer cents, received ${value}`);
  }
  return value;
}

/**
 * Percentage of an amount, rounded half-up to the nearest cent.
 * Used for early-payment discounts, so it must be exact and reproducible.
 */
export function percentOf(amountCents: Cents, percent: number): Cents {
  return Math.round((amountCents * percent) / 100);
}

/** "$1,234.56" — display and prompt rendering only. */
export function formatMoney(amountCents: Cents, currency = "USD"): string {
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const grouped = major.toLocaleString("en-US");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${grouped}.${minor}`;
}

/** "$1,235" — compact form for prompt fact sheets where cents are noise. */
export function formatMoneyRounded(amountCents: Cents, currency = "USD"): string {
  const negative = amountCents < 0;
  const rounded = Math.round(Math.abs(amountCents) / 100);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${rounded.toLocaleString("en-US")}`;
}
