/**
 * That the list and the badge cannot go back to disagreeing.
 *
 * The bug was not a wrong branch — it was a SECOND status system. The
 * /invoices page had its own `matches()` switching on `finalOutcome` and
 * `run.status`, deriving a different answer from the same invoice than the
 * badge rendered in the very same row: "Rejected" as the tab, "Payment
 * released" as the chip, both on one line.
 *
 * A unit test on a pure function cannot catch that returning, because the pure
 * function was already right. What has to be asserted is that the page routes
 * through it and derives nothing of its own. There is no DOM harness here, so —
 * as with the evidence panel — the page source is the thing under test.
 *
 * The second half runs the real pipeline over the settled demo scenario, which
 * is what proves the end-to-end behaviour rather than the wiring alone.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDeterministicEngine } from "../../lib/ai/deterministicEngine";
import { validateDecision } from "../../lib/ai/validateDecision";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { runScenario } from "../../lib/demo/runScenario";
import { scenarioById } from "../../lib/demo/scenarios";
import { categorizeInvoice } from "../../lib/payments/invoiceStatus";
import { isSettlementEvidence } from "../../lib/payments/settledRisk";
import type { DeterministicAnalysis } from "../../lib/types";

const PAGE = readFileSync(resolve(process.cwd(), "app/(app)/invoices/page.tsx"), "utf8");
const SELECTORS = readFileSync(
  resolve(process.cwd(), "components/hooks/usePayflowSelectors.ts"),
  "utf8",
);

// --- 6: the list derives no status of its own -------------------------------

describe("the invoice list derives no status of its own", () => {
  it("filters on the shared category, not on the AI outcome", () => {
    expect(PAGE).toContain("entry.category === tab");
    // The two fields that used to drive it, and must not again.
    expect(PAGE).not.toContain("entry.outcome ===");
    expect(PAGE).not.toContain('entry.run?.status === "PAID"');
  });

  it("offers a home for an escrowed payment that is neither paid nor refused", () => {
    expect(PAGE).toContain('id: "held"');
    expect(PAGE).toContain("Held in escrow");
  });

  it("reads the chain before categorising anything", () => {
    // Categorising from the local run alone is what filed a released escrow
    // under Rejected: the settlement happened in an earlier session, and this
    // browser held no record of it.
    expect(SELECTORS).toContain("useChainInvoices");
    expect(SELECTORS).toContain("useConditionStates");
    expect(SELECTORS).toContain("chainInvoiceStatus");
    expect(SELECTORS).toContain("conditionStage");
  });

  it("derives the badge and the bucket from ONE call", () => {
    expect(SELECTORS).toContain("describeInvoiceStatus");
    expect(SELECTORS).toContain("category: status.category");
  });

  it("counts tabs from the same categories it filters by", () => {
    // A count derived separately would drift from the tab's own contents.
    expect(SELECTORS).toContain("switch (entry.category)");
  });
});

// --- 1, 2: the settled demo invoice, through the real pipeline --------------

describe("an already-settled invoice through the real pipeline", () => {
  let analysis: Readonly<DeterministicAnalysis>;

  beforeAll(async () => {
    const scenario = scenarioById("s6_duplicate");
    analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });
  });

  it("is still refused a new payment", async () => {
    // Requirement 7 of the earlier pass, restated where it can regress: the
    // protection is what must not move.
    const run = await runScenario(scenarioById("s6_duplicate"), createDeterministicEngine("test"));

    expect(run.decision.decision.action).toBe("REJECT");
    expect(run.paymentRequest).toBeNull();
  });

  it("does not raise CRITICAL over a payment that completed", async () => {
    const run = await runScenario(scenarioById("s6_duplicate"), createDeterministicEngine("test"));

    expect(run.decision.decision.risk).not.toBe("CRITICAL");
    expect(run.decision.decision.risk).toBe("LOW");
  });

  it("flags no anomaly, and never calls the original a duplicate invoice", async () => {
    const run = await runScenario(scenarioById("s6_duplicate"), createDeterministicEngine("test"));
    const codes = run.analysis.riskEvidence.map((item) => item.code);

    expect(codes).toContain("INVOICE_ALREADY_SETTLED");
    expect(codes).not.toContain("DUPLICATE_INVOICE");
    // After settlement facts are set aside there is nothing flagged at all.
    expect(run.analysis.riskEvidence.filter((i) => !isSettlementEvidence(i.code))).toEqual([]);
  });

  it("lands in the paid tab once the chain is consulted", () => {
    // The pipeline's own verdict is a refusal — of a SECOND payment — and the
    // chain state overrules it for categorisation.
    expect(
      categorizeInvoice({
        runStatus: "ANALYZED",
        finalOutcome: "REJECTED",
        chainInvoiceStatus: "PAID",
        conditionStage: null,
      }),
    ).toBe("paid");
  });

  // --- the guard path, which is what runs when the model is live ------------

  it("is overruled by the guard without the alarm", () => {
    // With Workers AI reachable it is the GUARD, not the deterministic engine,
    // that refuses this invoice — so it needs the same distinction.
    const guarded = validateDecision(
      JSON.stringify({
        action: "AUTO_PAY",
        recommendedDate: null,
        risk: "LOW",
        urgency: "LOW",
        confidence: 0.9,
        reasons: ["The supplier is approved and the amount is in range."],
        riskExplanation: "Nothing unusual.",
        cashFlowExplanation: "Affordable today.",
        decisionExplanation: "Pay now.",
      }),
      analysis,
    );

    // Still refused — the model asked to pay and the guard said no.
    expect(guarded.decision.action).toBe("REJECT");
    // And refused as settlement, not as an emergency.
    expect(guarded.decision.risk).toBe("LOW");
    expect(guarded.decision.decisionExplanation).toContain("already settled");
    expect(guarded.decision.decisionExplanation).toContain("completed payment is unaffected");
  });
});

// --- 9: the alarm must still work -------------------------------------------

describe("a genuinely blocked invoice keeps its alarm", () => {
  it("stays CRITICAL, rejected, and in the rejected tab", async () => {
    const run = await runScenario(
      scenarioById("s5_wallet_mismatch"),
      createDeterministicEngine("test"),
    );

    expect(run.decision.decision.action).toBe("REJECT");
    expect(run.decision.decision.risk).toBe("CRITICAL");
    expect(
      categorizeInvoice({
        runStatus: "ANALYZED",
        finalOutcome: run.finalOutcome,
        chainInvoiceStatus: "PENDING",
      }),
    ).toBe("rejected");
  });

  it("is still refused by the guard at CRITICAL", async () => {
    const scenario = scenarioById("s5_wallet_mismatch");
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const guarded = validateDecision(
      JSON.stringify({
        action: "AUTO_PAY",
        recommendedDate: null,
        risk: "LOW",
        urgency: "LOW",
        confidence: 0.95,
        reasons: ["Looks fine to me."],
        riskExplanation: "",
        cashFlowExplanation: "",
        decisionExplanation: "",
      }),
      analysis,
    );

    expect(guarded.decision.action).toBe("REJECT");
    expect(guarded.decision.risk).toBe("CRITICAL");
    expect(guarded.downgraded).toBe(true);
  });
});
