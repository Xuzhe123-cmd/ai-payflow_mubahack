/**
 * Spendable gas is the sum of the gas COINS, never the address-level total.
 *
 * Sui 1.78 reports `addressMistBalance: 0` alongside a perfectly good funded
 * coin. Reading that field as the balance made a wallet holding 1 SUI look
 * empty, and the deploy preflight refused to publish from it. The fixture below
 * is that exact CLI output, so the regression cannot come back.
 */

import { describe, expect, it } from "vitest";

import { MIST_PER_SUI, formatSui, parseGasReport } from "../../scripts/lib/suiCli";

/** Verbatim `sui client gas --json` from a funded testnet address on 1.78.1. */
const FUNDED_ENVELOPE = {
  gasCoins: [
    {
      gasCoinId: "0x9f1c0d5e2b7a4813c6e05d9f2a4b8c17d3e6f0a95b2c8d41e7f3a6b09c5d2e18",
      mistBalance: 1000000000,
      suiBalance: "1.00",
    },
  ],
  addressMistBalance: 0,
  addressSuiBalance: "0.00",
};

describe("gas balance parsing", () => {
  it("reads 1 SUI from the coin, not the zeroed address balance", () => {
    const report = parseGasReport(FUNDED_ENVELOPE);

    expect(report.totalMist).toBe(BigInt(1_000_000_000));
    expect(report.coinCount).toBe(1);
    expect(formatSui(report.totalMist)).toBe("1.00");
  });

  it("keeps the address-level figure available but separate", () => {
    const report = parseGasReport(FUNDED_ENVELOPE);

    // Present for display, and demonstrably NOT what the total came from.
    expect(report.addressMistBalance).toBe(BigInt(0));
    expect(report.totalMist).not.toBe(report.addressMistBalance);
  });

  it("clears the 700,000,000 MIST minimum with 1 SUI", () => {
    const MINIMUM_MIST = BigInt(700_000_000);
    const report = parseGasReport(FUNDED_ENVELOPE);

    expect(report.totalMist >= MINIMUM_MIST).toBe(true);
    expect(formatSui(MINIMUM_MIST)).toBe("0.70");
  });

  it("sums across several coins", () => {
    const report = parseGasReport({
      gasCoins: [
        { gasCoinId: "0xa", mistBalance: 400_000_000 },
        { gasCoinId: "0xb", mistBalance: 350_000_000 },
        { gasCoinId: "0xc", mistBalance: 250_000_000 },
      ],
      addressMistBalance: 0,
    });

    expect(report.totalMist).toBe(BigInt(1_000_000_000));
    expect(report.coinCount).toBe(3);
  });

  it("accepts string balances, which some CLI versions emit", () => {
    const report = parseGasReport({
      gasCoins: [{ gasCoinId: "0xa", mistBalance: "1000000000" }],
    });

    expect(report.totalMist).toBe(BigInt(1_000_000_000));
  });

  it("accepts the bare array shape from older CLIs", () => {
    const report = parseGasReport([
      { gasCoinId: "0xa", mistBalance: 500_000_000 },
      { gasCoinId: "0xb", mistBalance: 500_000_000 },
    ]);

    expect(report.totalMist).toBe(BigInt(1_000_000_000));
    expect(report.addressMistBalance).toBeNull();
  });

  it("reports an unfunded wallet as genuinely empty", () => {
    const report = parseGasReport({
      gasCoins: [],
      addressMistBalance: 0,
      addressSuiBalance: "0.00",
    });

    expect(report.totalMist).toBe(BigInt(0));
    expect(report.coinCount).toBe(0);
    expect(report.totalMist < BigInt(700_000_000)).toBe(true);
  });

  it("does not fall over on malformed or missing input", () => {
    for (const input of [null, undefined, {}, { gasCoins: null }, "nonsense", 42]) {
      const report = parseGasReport(input);
      expect(report.totalMist).toBe(BigInt(0));
    }
    expect(parseGasReport({ gasCoins: [{ gasCoinId: "0xa", mistBalance: "oops" }] }).totalMist)
      .toBe(BigInt(0));
  });

  it("formats MIST as SUI without floating-point drift", () => {
    expect(formatSui(BigInt(0))).toBe("0.00");
    expect(formatSui(MIST_PER_SUI)).toBe("1.00");
    expect(formatSui(BigInt(1_234_567_890))).toBe("1.23");
    expect(formatSui(BigInt(999_999_999))).toBe("0.99");
    // Larger than Number.MAX_SAFE_INTEGER — the reason this is bigint at all.
    expect(formatSui(BigInt("12345678901234567890"))).toBe("12345678901.23");
  });
});
