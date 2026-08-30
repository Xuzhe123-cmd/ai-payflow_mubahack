/**
 * Telling a stale read apart from a wrong one.
 *
 * This exists because of a specific, real, and expensive-looking mistake. The
 * $4,800 release SUCCEEDED on testnet — status 1, funds 0, attestation linked —
 * and the runner reported "expected RELEASED, found LOCKED" and halted. The
 * chain had done exactly the right thing; the GraphQL index was still serving
 * the previous version of the object.
 *
 * Three situations produce a disagreeing read, and the correct response to each
 * is different: stop (the transaction failed), wait (the index is behind), or
 * fetch a human (the state is genuinely wrong). Collapsing the middle one into
 * the third is what turned a successful settlement into a reported failure.
 */

import { describe, expect, it } from "vitest";

import { classifySettlement, describeStale } from "../../lib/escrow/settlementState";

const ESCROW = "0xfc2955a1367bf7663ef1a0dde4b02ea0f1ea6e80530af3ab7d833ebdca1747f3";
/** The escrow's version before the release, and after it. */
const BEFORE = "997512949";
const AFTER = "997521062";

describe("a failed transaction is not a staleness problem", () => {
  it("reports FAILED when the chain did not accept it", () => {
    const verdict = classifySettlement({
      transactionSucceeded: false,
      transactionError: "MoveAbort … 904",
      versionBefore: BEFORE,
      versionNow: BEFORE,
      stateMatches: false,
    });
    expect(verdict.kind).toBe("FAILED");
    expect(verdict.kind === "FAILED" && verdict.reason).toMatch(/904/);
  });

  it("does not wait for an index to confirm something that never happened", () => {
    // A failed transaction leaves the object at its old version too, which is
    // exactly why success has to be checked first.
    const verdict = classifySettlement({
      transactionSucceeded: false,
      versionBefore: BEFORE,
      versionNow: BEFORE,
      stateMatches: false,
    });
    expect(verdict.kind).not.toBe("STALE");
  });
});

describe("a successful transaction with a lagging index", () => {
  it("reports STALE when the index still shows the pre-transaction version", () => {
    // The real incident, in one assertion.
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: BEFORE,
      versionNow: BEFORE,
      stateMatches: false,
    });
    expect(verdict.kind).toBe("STALE");
    expect(verdict.kind === "STALE" && verdict.detail).toMatch(/stale copy rather than disagreeing/);
  });

  it("reports STALE when the version cannot be read at all", () => {
    // A successful transaction is stronger evidence than an unconfirmed read.
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: BEFORE,
      versionNow: null,
      stateMatches: false,
    });
    expect(verdict.kind).toBe("STALE");
    expect(verdict.kind === "STALE" && verdict.detail).toMatch(/could not be read/);
  });

  it("explains what a stale read does not prove, and how to settle it", () => {
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: BEFORE,
      versionNow: BEFORE,
      stateMatches: false,
    });
    const message = describeStale(
      verdict as Extract<typeof verdict, { kind: "STALE" }>,
      ESCROW,
    );
    expect(message).toMatch(/transaction SUCCEEDED/);
    expect(message).toMatch(/not evidence that the settlement failed/i);
    expect(message).toContain(`sui client object ${ESCROW}`);
  });
});

describe("a current index showing the wrong state", () => {
  it("reports CURRENT once the version has moved on", () => {
    // The version advanced and the state is still not what was expected. That
    // is a real disagreement, and the caller should act on it rather than wait.
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: BEFORE,
      versionNow: AFTER,
      stateMatches: false,
    });
    expect(verdict.kind).toBe("CURRENT");
  });

  it("reports CURRENT as soon as the state matches, whatever the versions say", () => {
    for (const versionNow of [BEFORE, AFTER, null]) {
      const verdict = classifySettlement({
        transactionSucceeded: true,
        versionBefore: BEFORE,
        versionNow,
        stateMatches: true,
      });
      expect(verdict.kind, String(versionNow)).toBe("CURRENT");
    }
  });

  it("cannot be fooled by a version it never knew", () => {
    // With no pre-transaction version there is nothing to compare, so it must
    // not claim staleness it cannot establish — it says so instead.
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: null,
      versionNow: AFTER,
      stateMatches: false,
    });
    expect(verdict.kind).toBe("CURRENT");
  });
});
