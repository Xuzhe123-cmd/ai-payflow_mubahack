/**
 * The oracle layer, and the honesty constraints on it.
 *
 * Two things are being protected here. First, that facts the chain CANNOT
 * confirm — a forecast, an expected receivable — are never presented as
 * verified. Second, that the demo feed never claims to be a bank or a market
 * provider, which would be a false statement about where the data came from.
 *
 * Both are the sort of claim that is easy to introduce with a copy tweak and
 * hard to notice in review, which is why they are asserted rather than trusted.
 */

import { describe, expect, it } from "vitest";

import {
  ORACLE_SOURCE_LABEL,
  PIPELINE_STAGES,
  PIPELINE_SUMMARY,
  buildInvoiceOracleFeed,
  buildTreasuryOracleFeed,
} from "../../lib/oracle/feed";
import { createDeterministicEngine } from "../../lib/ai/deterministicEngine";
import { buildProjection } from "../../lib/deterministic/projection";
import { runScenario } from "../../lib/demo/runScenario";
import { scenarioById } from "../../lib/demo/scenarios";
import type { AnalysisResponse } from "../../lib/services/contracts";

/** Runs a demo scenario through the real pipeline into the wire shape. */
async function analyse(scenarioId: string): Promise<AnalysisResponse> {
  const scenario = scenarioById(scenarioId);
  const run = await runScenario(scenario, createDeterministicEngine("test: model offline"));
  return {
    worldSource: "fixture",
    scenarioId: run.scenarioId,
    scenario: { id: scenario.id, name: scenario.name, description: scenario.description },
    asOfDate: run.asOfDate,
    engine: run.decision.engine,
    engineMode: "fallback",
    engineNotice: null,
    modelId: null,
    latencyMs: 0,
    document: scenario.document,
    analysis: run.analysis,
    decision: run.decision.decision,
    guard: run.decision.guard,
    projection: buildProjection({
      world: scenario.world,
      asOf: scenario.asOfDate,
      payment: {
        amountCents: run.analysis.invoiceFacts.amountCents,
        dates: run.analysis.cashFlowScenarios.map((c) => c.paymentDate),
      },
    }),
    recommendation: run.recommendation,
    paymentRequest: run.paymentRequest,
    enforcement: run.enforcement,
    finalOutcome: run.finalOutcome,
    steps: run.steps,
  };
}

describe("the four layers", () => {
  it("names oracle, AI, guard and Sui in that order", () => {
    expect(PIPELINE_STAGES.map((stage) => stage.key)).toEqual(["oracle", "ai", "guard", "sui"]);
  });

  it("gives each layer a distinct kind of authority", () => {
    expect(PIPELINE_SUMMARY).toBe(
      "The oracle provides facts. The AI recommends. The guard constrains. Sui enforces.",
    );
  });

  it("never says the oracle, the AI or the guard authorizes anything", () => {
    // Checked per stage. Concatenating them first lets "Sui enforces" satisfy
    // a match anchored on "Oracle", which is exactly the confusion this guards
    // against.
    for (const stage of PIPELINE_STAGES) {
      if (stage.key === "sui") continue;
      expect(stage.role.toLowerCase(), `${stage.label} must not claim authority`).not.toMatch(
        /authoriz|approve|enforce|settle|transfer/,
      );
    }
    expect(PIPELINE_STAGES.find((s) => s.key === "sui")!.role).toContain("Enforces");
  });
});

describe("the source is described honestly", () => {
  it("labels itself a demo oracle", () => {
    expect(ORACLE_SOURCE_LABEL).toContain("Demo Oracle");
  });

  it("disclaims a live financial source outright", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s1_normal"));
    const prose = `${feed.sourceLabel} ${feed.sourceDetail}`.toLowerCase();

    expect(prose).toContain("not a live bank or market feed");
  });

  it("names no provider it is not actually using", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s1_normal"));
    const prose = `${feed.sourceLabel} ${feed.sourceDetail}`.toLowerCase();

    // Brand names imply an integration. There is none.
    for (const brand of ["plaid", "bloomberg", "chainlink", "pyth", "stripe", "reuters"]) {
      expect(prose, `must not mention ${brand}`).not.toContain(brand);
    }
  });
});

describe("verified means the chain re-derived it", () => {
  it("marks the forecast and expected inflows as advisory, not verified", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s1_normal"));
    const byLabel = Object.fromEntries(feed.signals.map((s) => [s.label, s]));

    // The chain checks a balance, never a projection.
    expect(byLabel["Cash-flow forecast"].chainVerified).toBe(false);
    expect(byLabel["Upcoming inflows"].chainVerified).toBe(false);
    expect(byLabel["Upcoming outflows"].chainVerified).toBe(false);
  });

  it("marks supplier, wallet and settled status as chain-verified", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s1_normal"));
    const byLabel = Object.fromEntries(feed.signals.map((s) => [s.label, s]));

    expect(byLabel["Supplier data"].chainVerified).toBe(true);
    expect(byLabel["Recipient wallet"].chainVerified).toBe(true);
    expect(byLabel["Invoice data"].chainVerified).toBe(true);
  });
});

describe("per-invoice feeds reflect what the chain found", () => {
  it("reports a matching wallet as VERIFIED", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s1_normal"));
    const wallet = feed.signals.find((s) => s.label === "Recipient wallet")!;

    expect(wallet.state).toBe("VERIFIED");
    expect(feed.allVerified).toBe(true);
  });

  it("reports a redirected wallet as MISMATCH and fails the feed", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s5_wallet_mismatch"));
    const wallet = feed.signals.find((s) => s.label === "Recipient wallet")!;

    expect(wallet.state).toBe("MISMATCH");
    expect(wallet.detail).toContain("registry does not hold");
    expect(feed.allVerified).toBe(false);
  });

  it("reports an unknown supplier as a registry miss", async () => {
    const feed = buildInvoiceOracleFeed(await analyse("s4_new_supplier"));
    const supplier = feed.signals.find((s) => s.label === "Supplier data")!;

    expect(supplier.state).toBe("MISMATCH");
    expect(supplier.value).toBe("not in registry");
  });

  it("reports an already-settled invoice as settled, NOT as a discrepancy", async () => {
    // THE BUG: a correctly-paid invoice raised "Discrepancy found" on the
    // Real-World Facts panel, because "already settled" was reported as a
    // MISMATCH. It is not one. The oracle's data and the chain agree
    // completely: the document says what it says, and the payment happened.
    // A discrepancy is a fact the chain re-derived and DISAGREED with.
    const feed = buildInvoiceOracleFeed(await analyse("s6_duplicate"));
    const invoice = feed.signals.find((s) => s.label === "Invoice data")!;

    expect(invoice.state).toBe("SETTLED");
    expect(invoice.state).not.toBe("MISMATCH");
    expect(invoice.value).toBe("settled on chain");
    // The badge over the panel reads off this flag.
    expect(feed.allVerified).toBe(true);
  });

  it("still fails the feed for a genuine discrepancy on a settled invoice", async () => {
    // Settled must not become a blanket amnesty: a redirected wallet is still
    // a discrepancy whatever the invoice's settlement state.
    const duplicate = await analyse("s6_duplicate");
    const feed = buildInvoiceOracleFeed({
      ...duplicate,
      analysis: {
        ...duplicate.analysis,
        supplierFacts: { ...duplicate.analysis.supplierFacts, walletMatch: false },
      },
    });

    expect(feed.signals.find((s) => s.label === "Invoice data")!.state).toBe("SETTLED");
    expect(feed.signals.find((s) => s.label === "Recipient wallet")!.state).toBe("MISMATCH");
    expect(feed.allVerified).toBe(false);
  });
});

describe("the treasury-wide feed", () => {
  it("counts what it was given rather than deriving figures of its own", () => {
    const feed = buildTreasuryOracleFeed({
      inflowCount: 3,
      outflowCount: 3,
      horizonDays: 21,
      supplierCount: 5,
      approvedSupplierCount: 5,
      invoiceCount: 8,
      settledInvoiceCount: 1,
    });
    const byLabel = Object.fromEntries(feed.signals.map((s) => [s.label, s]));

    expect(byLabel["Upcoming inflows"].value).toBe("3 events");
    expect(byLabel["Upcoming outflows"].value).toBe("3 events");
    expect(byLabel["Supplier registry"].value).toBe("5 of 5 approved");
    expect(feed.allVerified).toBe(true);
  });

  it("flags a registry where not every supplier is approved", () => {
    const feed = buildTreasuryOracleFeed({
      inflowCount: 1,
      outflowCount: 1,
      horizonDays: 21,
      supplierCount: 5,
      approvedSupplierCount: 4,
      invoiceCount: 8,
      settledInvoiceCount: 0,
    });

    expect(feed.signals.find((s) => s.label === "Supplier registry")!.state).toBe("MISMATCH");
    expect(feed.allVerified).toBe(false);
  });

  it("uses singular wording for a single event", () => {
    const feed = buildTreasuryOracleFeed({
      inflowCount: 1,
      outflowCount: 0,
      horizonDays: 21,
      supplierCount: 1,
      approvedSupplierCount: 1,
      invoiceCount: 1,
      settledInvoiceCount: 0,
    });

    expect(feed.signals.find((s) => s.label === "Upcoming inflows")!.value).toBe("1 event");
    expect(feed.signals.find((s) => s.label === "Upcoming outflows")!.value).toBe("0 events");
  });
});
