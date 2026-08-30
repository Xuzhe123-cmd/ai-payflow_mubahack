/**
 * The one conversion between off-chain cents and on-chain coin base units.
 *
 * Off chain every amount is `Cents` — integer minor units, two decimal places.
 * On chain every amount is in the settlement coin's base units, and MOCK_USDC
 * has six. Nothing in Move scales anything: the treasury's limits, the reserve,
 * and every payment amount are all stored in base units already.
 *
 * That makes this file the entire boundary. If it is wrong, it is wrong by a
 * factor of ten thousand in one direction, which is the kind of error that is
 * obvious the first time you look at a balance — and invisible if the
 * conversion is instead scattered across four call sites.
 */

import type { Cents } from "../types";

/** Decimals of the demo settlement coin, matching mock_usdc.move. */
export const COIN_DECIMALS = 6;

/** 10^(COIN_DECIMALS - 2): cents have two decimals, the coin has six. */
const CENTS_TO_UNITS = 10 ** (COIN_DECIMALS - 2);

export function centsToUnits(cents: Cents): bigint {
  if (!Number.isInteger(cents)) {
    throw new Error(`Expected integer cents, received ${cents}`);
  }
  return BigInt(cents) * BigInt(CENTS_TO_UNITS);
}

export function unitsToCents(units: bigint | string): Cents {
  const value = typeof units === "string" ? BigInt(units) : units;
  const cents = value / BigInt(CENTS_TO_UNITS);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Amount ${value} exceeds safe integer range in cents`);
  }
  return Number(cents);
}

/** For CLI arguments, which take decimal strings rather than bigints. */
export function centsToUnitsString(cents: Cents): string {
  return centsToUnits(cents).toString();
}
