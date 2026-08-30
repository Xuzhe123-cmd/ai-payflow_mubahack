/**
 * Demo day is 6 September 2026, and nothing about the host machine may change
 * that.
 *
 * The failure this guards against is quiet and total: a `new Date()` anywhere
 * in the decision path means the demo answers one way in rehearsal and another
 * way on stage, or differently on a judge's laptop in another timezone. So the
 * suite runs the whole pipeline under deliberately absurd system clocks and
 * requires the answers to be byte-identical.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { selectDecisionEngine } from "../lib/ai/engine";
import { DEMO_AS_OF_DATE, DEMO_CLOCK_MS } from "../lib/demo/clock";
import { SCENARIOS } from "../lib/demo/scenarios";
import { runScenario } from "../lib/demo/runScenario";
import { buildDecisionFacts } from "../lib/decision/engine";
import type { ChainInvoice, ChainSnapshot } from "../lib/sui/chainTypes";

const { engine } = selectDecisionEngine({});

/** What each scenario decides on demo day. */
const DEMO_DAY_DECISIONS: Record<string, string> = {
  s1_normal: "AUTO_PAY",
  s2_cashflow: "HUMAN_REVIEW",
  s3_discount: "AUTO_PAY",
  s4_new_supplier: "REJECT",
  s5_wallet_mismatch: "REJECT",
  s6_duplicate: "REJECT",
  s7_po_mismatch: "HUMAN_REVIEW",
  s8_policy_violation: "HUMAN_REVIEW",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the demo clock is pinned to demo day", () => {
  it("is 2026-09-06", () => {
    expect(DEMO_AS_OF_DATE).toBe("2026-09-06");
    expect(new Date(DEMO_CLOCK_MS).toISOString().slice(0, 10)).toBe(DEMO_AS_OF_DATE);
  });

  it("is the 'today' every scenario runs at", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.asOfDate, scenario.id).toBe(DEMO_AS_OF_DATE);
    }
  });
});

describe("the four demo invoices decide as expected on demo day", () => {
  it.each([
    ["s1_normal", "AUTO_PAY", 300_000],
    ["s2_cashflow", "HUMAN_REVIEW", 3_000_000],
    ["s8_policy_violation", "HUMAN_REVIEW", 800_000],
    ["s5_wallet_mismatch", "REJECT", 1_950_000],
  ])("%s decides %s", async (id, action, amountCents) => {
    const scenario = SCENARIOS.find((s) => s.id === id)!;
    const run = await runScenario(scenario, engine);

    expect(run.analysis.invoiceFacts.amountCents).toBe(amountCents);
    expect(run.decision.decision.action).toBe(action);

    // Escalated and refused invoices must never carry a request the execution
    // path would accept — that is what keeps the agent out of them.
    if (action === "AUTO_PAY") {
      expect(run.paymentRequest).not.toBeNull();
      expect(run.enforcement?.outcome).toBe("APPROVED");
    } else {
      expect(run.paymentRequest).toBeNull();
    }
  });
});

describe("the host machine's clock changes nothing", () => {
  const ABSURD = ["2020-01-01T00:00:00.000Z", "2026-03-15T23:59:59.000Z", "2031-12-31T12:00:00.000Z"];

  it("produces identical decisions whatever the system date says", async () => {
    const results: string[] = [];

    for (const when of ABSURD) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(when));

      const snapshot: string[] = [];
      for (const scenario of SCENARIOS) {
        const run = await runScenario(scenario, engine);
        snapshot.push(
          [
            scenario.id,
            run.analysis.asOfDate,
            run.decision.decision.action,
            run.recommendation?.recommendedDate ?? "-",
            String(run.recommendation?.generatedAtMs ?? "-"),
            String(run.recommendation?.expiresAtMs ?? "-"),
            run.enforcement?.outcome ?? "no-request",
          ].join("|"),
        );
      }
      results.push(snapshot.join("\n"));
      vi.useRealTimers();
    }

    // Every run identical, including the recommendation timestamps.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain(`|${DEMO_AS_OF_DATE}|`);
  });

  it("keeps each scenario's decision on demo day", async () => {
    for (const scenario of SCENARIOS) {
      const run = await runScenario(scenario, engine);
      expect(run.decision.decision.action, scenario.id).toBe(DEMO_DAY_DECISIONS[scenario.id]);
    }
  });

  it("defaults the chain decision engine to demo day, not to the system date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));

    // asOf omitted on purpose — this is the path that used to read new Date().
    const facts = buildDecisionFacts({ snapshot: emptySnapshot(), invoice: chainInvoice() });
    expect(facts.asOf).toBe(DEMO_AS_OF_DATE);
  });
});

function emptySnapshot(): ChainSnapshot {
  return {
    network: "testnet",
    packageId: "0x1",
    readAt: "2026-09-06T09:00:00.000Z",
    treasury: {
      objectId: "0x2",
      owner: "0x5",
      balanceCents: 10_000_000,
      minimumReserveCents: 5_000_000,
      humanApprovalThresholdCents: 500_000,
      autoPayEnabled: true,
      allowedCurrencies: ["USD"],
      allowedCoinTypes: ["0x1::mock_usdc::MOCK_USDC"],
      maxRecommendationAgeMs: 86_400_000,
      totalPaidCents: 0,
      paymentCount: 0,
      availableCents: 5_000_000,
    },
    agent: {
      capObjectId: "0x3",
      agentId: "agent",
      enabled: true,
      maxSinglePaymentCents: 500_000,
      dailyLimitCents: 2_000_000,
      spentTodayCents: 0,
      remainingTodayCents: 2_000_000,
    },
    suppliers: [],
    invoices: [],
    cashFlowEvents: [],
  };
}

function chainInvoice(): ChainInvoice {
  return {
    objectId: "0x4",
    invoiceNumber: "INV-CLOCK-1",
    supplierId: "sup_clock",
    amountCents: 100_000,
    currency: "USD",
    dueDate: "2026-09-20",
    poNumber: "PO-CLOCK-1",
    recipient: `0x${"1".repeat(64)}`,
    status: "PENDING",
    walrusBlobId: null,
  };
}
