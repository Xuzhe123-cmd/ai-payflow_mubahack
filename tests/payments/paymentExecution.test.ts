/**
 * Real payment execution: the gate, the clock, and the vocabulary of refusal.
 *
 * These are the parts of the execution path that can be decided without a
 * chain. What the chain does with the call is the chain's business and is
 * covered by the Move tests; what is covered here is everything that has
 * historically been got wrong OFF chain:
 *
 *  - submitting when nobody asked for live submission,
 *  - sending the demo clock to a validator that reads real time,
 *  - and having no words for a refusal, which is how a genuine rejection
 *    rendered as a button that did nothing.
 */

import { describe, expect, it } from "vitest";

import { chainTimestamps, paymentExecutionEnabled } from "../../lib/sui/paymentExecution";
import { executionFailureHeadline } from "../../lib/payments/executionFailure";
import { POLICY_CHECK_ORDER } from "../../lib/sui/errorCodes";
import { DEMO_CLOCK_MS } from "../../lib/demo/clock";

describe("the live-execution gate", () => {
  it("is off when nothing is set", () => {
    expect(paymentExecutionEnabled({})).toBe(false);
  });

  it("opens only for an explicit affirmative", () => {
    expect(paymentExecutionEnabled({ PAYFLOW_PAYMENT_LIVE: "1" })).toBe(true);
    expect(paymentExecutionEnabled({ PAYFLOW_PAYMENT_LIVE: "true" })).toBe(true);
    expect(paymentExecutionEnabled({ PAYFLOW_PAYMENT_LIVE: " TRUE " })).toBe(true);
  });

  // Anything ambiguous must fail CLOSED. A misread flag that opens the gate
  // spends real gas; one that closes it costs a restart.
  it("stays shut for anything else", () => {
    for (const value of ["0", "false", "yes", "on", "", "  ", "TRUE1"]) {
      expect(paymentExecutionEnabled({ PAYFLOW_PAYMENT_LIVE: value })).toBe(false);
    }
  });
});

describe("the timestamps sent to the chain", () => {
  /**
   * THE DEMO CLOCK MUST NOT REACH A VALIDATOR. `payment::evaluate` judges check
   * 10 against the on-chain `Clock`, which reads real wall time. Demo day is
   * pinned to September 2026 so the DECISIONS are reproducible; measuring a
   * freshness window against it would make check 10 answer a question nobody
   * asked, and would pass or fail by accident depending on the calendar.
   */
  it("uses real wall time, never the demo clock", () => {
    const now = Date.now();
    const times = chainTimestamps(now);
    expect(times.recommendedAtMs).toBe(String(now));
    expect(times.recommendedAtMs).not.toBe(String(DEMO_CLOCK_MS));
  });

  it("opens a 24-hour window, matching the policy's recommendation age", () => {
    const times = chainTimestamps(1_000);
    expect(Number(times.expiresAtMs) - Number(times.recommendedAtMs)).toBe(86_400_000);
  });

  it("emits decimal strings, which is what the CLI takes", () => {
    const times = chainTimestamps(1_762_000_000_000);
    expect(times.recommendedAtMs).toMatch(/^\d+$/);
    expect(times.expiresAtMs).toMatch(/^\d+$/);
  });
});

describe("the words shown for a refusal", () => {
  /**
   * The parity that matters. A check added to Move without a headline here
   * refuses payments the interface can only describe as "no payment was
   * submitted" — true, useless, and indistinguishable from a broken button.
   */
  it("has a headline for every one of the ten policy checks", () => {
    for (const code of POLICY_CHECK_ORDER) {
      const headline = executionFailureHeadline(code);
      expect(headline).not.toBe("No payment was submitted");
      expect(headline.length).toBeGreaterThan(0);
    }
  });

  /**
   * "Not submitted" and "refused" are different events and the wording keeps
   * them apart: one means no transaction exists, the other means the treasury
   * declined. Collapsing them is how a server-side configuration flag would
   * come to read as an on-chain rejection.
   */
  it("says 'not submitted' for refusals that never reached the chain", () => {
    for (const code of [
      "EXECUTION_DISABLED",
      "NOT_DEPLOYED",
      "CHAIN_UNAVAILABLE",
      "SERVER_UNREACHABLE",
      "INVOICE_NOT_ON_CHAIN",
    ]) {
      expect(executionFailureHeadline(code)).toMatch(/^Not submitted/);
    }
  });

  it("attributes an on-chain refusal to Sui", () => {
    expect(executionFailureHeadline("EXCEEDS_MAX_PAYMENT")).toContain("Sui");
    expect(executionFailureHeadline("INSUFFICIENT_RESERVE")).toContain("Sui");
  });

  // An unknown code is reported plainly rather than glossed with a guess. The
  // server's own message is always rendered beside it.
  it("falls back without inventing a reason", () => {
    expect(executionFailureHeadline("SOMETHING_NEW")).toBe("No payment was submitted");
  });
});
