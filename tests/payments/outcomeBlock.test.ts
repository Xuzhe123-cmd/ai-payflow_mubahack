/**
 * The outcome box asks the chain before it asks the recommendation.
 *
 * `availablePaymentAction` gets the precedence right on its own — but it only
 * governs the screen if the component actually reaches it. The bug that showed
 * "Rejected" over a released $4,800 payment was not in the rule: it was a
 * component that returned a rejection card several branches BEFORE consulting
 * the state it had already computed.
 *
 * There is no DOM harness here, so order is asserted against the source. A pass
 * means no recommendation-shaped branch can run ahead of the chain.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(process.cwd(), "components/payments/DecisionChain.tsx"),
  "utf8",
);

/** Where the outcome box starts, so the AI-facing blocks above are excluded. */
const OUTCOME = SOURCE.slice(SOURCE.indexOf("function OutcomeBlock"));

describe("branch order in the outcome box", () => {
  it("returns the chain's verdict before any rejection branch", () => {
    const chainFirst = OUTCOME.indexOf("action.settled || action.fundsLocked");
    const rejectBranch = OUTCOME.indexOf('decision.action === "REJECT"');
    const suiRejectBranch = OUTCOME.indexOf('enforcement.outcome === "SUI_REJECT"');

    expect(chainFirst).toBeGreaterThan(-1);
    expect(rejectBranch).toBeGreaterThan(chainFirst);
    expect(suiRejectBranch).toBeGreaterThan(chainFirst);
  });

  it("returns the chain's verdict before the human-approval branch", () => {
    // An approve button on a settled invoice would invite paying it twice.
    const chainFirst = OUTCOME.indexOf("action.settled || action.fundsLocked");
    expect(OUTCOME.indexOf("<HumanApproval")).toBeGreaterThan(chainFirst);
  });

  it("waits for both chain reads before claiming anything", () => {
    // A partial read must not flash a recommendation-shaped outcome at an
    // invoice that is actually settled.
    expect(OUTCOME).toContain("chainResolved && resolved");
  });

  it("passes the invoice's own on-chain status into the rule", () => {
    // Without this, a payment made in an earlier session is invisible and the
    // box falls through to a guard that is only refusing a SECOND payment.
    expect(OUTCOME).toContain("chainInvoiceStatus: chainInvoice?.status");
  });
});

describe("the settled card", () => {
  const CARD = SOURCE.slice(SOURCE.indexOf("function ChainOutcome"), SOURCE.indexOf("function Line"));

  it("offers no control at all", () => {
    // Structural, not stylistic: there is no button to disable.
    expect(CARD).not.toContain("<Button");
    expect(CARD).not.toContain("executeInvoicePayment");
    expect(CARD).not.toContain("approveInvoicePayment");
  });

  it("renders its words from the chain-derived state, not from constants", () => {
    expect(CARD).toContain("action.headline");
    expect(CARD).toContain("action.detail");
    expect(CARD).toContain("action.facts");
  });

  it("never says rejected", () => {
    expect(CARD.toLowerCase()).not.toContain("rejected");
  });
});

describe("the recommendation block", () => {
  const BLOCK = SOURCE.slice(
    SOURCE.indexOf("function RecommendationBlock"),
    SOURCE.indexOf("function SafetyBlock"),
  );

  it("qualifies a rejection when the invoice is already settled", () => {
    // The AI section may still say "rejected" — it must say what it is
    // rejecting. Left bare, it reads as though the original payment failed.
    expect(BLOCK).toContain("alreadySettled");
    expect(BLOCK).toContain("NEW payment");
  });

  it("decides that from chain state, not from the recommendation", () => {
    expect(BLOCK).toContain('chainInvoice?.status === "PAID"');
    expect(BLOCK).toContain('condition?.stage === "RELEASED"');
  });
});
