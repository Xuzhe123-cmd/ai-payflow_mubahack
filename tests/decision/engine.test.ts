/**
 * The decision engine, scenario by scenario.
 *
 * The base snapshot below mirrors the live testnet deployment — $97,000 vault,
 * $50,000 reserve, $5,000 agent cap and approval threshold, $20,000 daily with
 * $3,000 already spent. Each test changes ONE thing, so what makes the decision
 * move is never ambiguous.
 *
 * Two properties matter more than any individual verdict and are asserted
 * throughout: a blocking on-chain risk always produces REJECT whatever the
 * explainer says, and the explainer can never be less cautious than the
 * deterministic ceiling.
 */

import { describe, expect, it } from "vitest";

import { decidePayment, deterministicCeiling, buildDecisionFacts } from "../../lib/decision/engine";
import type { DecisionExplainer } from "../../lib/decision/explain";
import type { DecisionAction } from "../../lib/decision/types";
import type {
  ChainAgent,
  ChainCashFlowEvent,
  ChainInvoice,
  ChainSnapshot,
  ChainSupplier,
  ChainTreasury,
} from "../../lib/sui/chainTypes";

const ASOF = "2026-09-01";
const WALLET = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const OTHER_WALLET = "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad0";

const dollars = (n: number) => n * 100;

const TREASURY: ChainTreasury = {
  objectId: "0xtreasury",
  owner: "0xowner",
  balanceCents: dollars(97_000),
  minimumReserveCents: dollars(50_000),
  humanApprovalThresholdCents: dollars(5_000),
  autoPayEnabled: true,
  allowedCurrencies: ["USD"],
  allowedCoinTypes: ["0xpkg::mock_usdc::MOCK_USDC"],
  maxRecommendationAgeMs: 86_400_000,
  totalPaidCents: dollars(3_000),
  paymentCount: 1,
  availableCents: dollars(47_000),
};

const AGENT: ChainAgent = {
  capObjectId: "0xagentcap",
  agentId: "agent_payflow_01",
  enabled: true,
  maxSinglePaymentCents: dollars(5_000),
  dailyLimitCents: dollars(20_000),
  spentTodayCents: dollars(3_000),
  remainingTodayCents: dollars(17_000),
};

const SUPPLIERS: ChainSupplier[] = [
  {
    supplierId: "sup_northwind",
    name: "Northwind Components Ltd",
    registeredWallet: WALLET,
    status: "APPROVED",
  },
  { supplierId: "sup_pending", name: "Pending Co", registeredWallet: OTHER_WALLET, status: "PENDING" },
];

const EVENTS: ChainCashFlowEvent[] = [
  { date: "2026-09-04", direction: "OUTFLOW", amountCents: dollars(12_000), description: "Facility lease" },
  { date: "2026-09-12", direction: "INFLOW", amountCents: dollars(55_000), description: "Halden Group receivable" },
  { date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(40_000), description: "Payroll" },
];

function invoice(overrides: Partial<ChainInvoice> = {}): ChainInvoice {
  return {
    objectId: "0xinvoice",
    invoiceNumber: "INV-TEST-1",
    supplierId: "sup_northwind",
    amountCents: dollars(3_000),
    currency: "USD",
    dueDate: "2026-09-20",
    poNumber: "PO-1",
    recipient: WALLET,
    status: "PENDING",
    walrusBlobId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    network: "testnet",
    packageId: "0xpkg",
    readAt: "2026-09-01T00:00:00.000Z",
    treasury: TREASURY,
    agent: AGENT,
    suppliers: SUPPLIERS,
    invoices: [],
    cashFlowEvents: EVENTS,
    ...overrides,
  };
}

/** An explainer that always demands the most spending possible. */
function recklessExplainer(date: string | null = ASOF): DecisionExplainer {
  return {
    id: "llm",
    async explain() {
      return {
        action: "PAY_NOW" as DecisionAction,
        recommendedDate: date,
        confidence: 0.99,
        reasons: ["pay it immediately"],
        explanation: { summary: "pay", cashFlow: "fine", risk: "none", whyNotToday: "" },
      };
    },
  };
}

// --- A ---------------------------------------------------------------------

describe("A — a legitimate $3,000 invoice", () => {
  it("can be paid autonomously today", async () => {
    const decision = await decidePayment({ snapshot: snapshot(), invoice: invoice(), asOf: ASOF });

    expect(decision.deterministicCeiling).toBe("PAY_NOW");
    expect(decision.decision).toBe("PAY_NOW");
    expect(decision.requiresHumanApproval).toBe(false);
    expect(decision.authorityStatus).toBe("WITHIN_AUTONOMOUS");
    expect(decision.recommendedPaymentDate).toBe(ASOF);
  });

  it("reports the balance the chain will see after the transfer", async () => {
    const decision = await decidePayment({ snapshot: snapshot(), invoice: invoice(), asOf: ASOF });
    // $97,000 − $3,000, comfortably above the $50,000 reserve.
    expect(decision.projectedBalanceAfterPayment).toBe(dollars(94_000));
  });

  it("raises no blocking risk", async () => {
    const decision = await decidePayment({ snapshot: snapshot(), invoice: invoice(), asOf: ASOF });
    expect(decision.risks.filter((r) => r.blocking)).toEqual([]);
  });
});

// --- B ---------------------------------------------------------------------

describe("B — an $8,000 invoice exceeds the agent's authority", () => {
  const big = invoice({ amountCents: dollars(8_000), invoiceNumber: "INV-TEST-B" });

  it("needs a human, and says which limit was hit", async () => {
    const decision = await decidePayment({ snapshot: snapshot(), invoice: big, asOf: ASOF });

    expect(decision.deterministicCeiling).toBe("HUMAN_APPROVAL");
    expect(decision.decision).toBe("HUMAN_APPROVAL");
    expect(decision.requiresHumanApproval).toBe(true);
    expect(decision.authorityStatus).toBe("EXCEEDS_SINGLE_LIMIT");
  });

  it("is NOT rejected — a person can still approve it", async () => {
    const decision = await decidePayment({ snapshot: snapshot(), invoice: big, asOf: ASOF });

    expect(decision.decision).not.toBe("REJECT");
    // The authority risk is real but not blocking: nothing about this invoice
    // is wrong, it is simply larger than the agent may settle alone.
    const risk = decision.risks.find((r) => r.code === "EXCEEDS_AUTONOMOUS_AUTHORITY")!;
    expect(risk.blocking).toBe(false);
  });

  it("cannot be talked into PAY_NOW by the model", async () => {
    // This is the security demonstration in miniature: the AI asks to pay
    // $8,000 autonomously and the engine refuses before Sui is even consulted.
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: big,
      asOf: ASOF,
      explainer: recklessExplainer(),
    });

    expect(decision.decision).toBe("HUMAN_APPROVAL");
    expect(decision.clampedToCeiling).toBe(true);
  });
});

// --- C ---------------------------------------------------------------------

describe("C — within authority, but paying today would break the reserve", () => {
  // $52,000 in the vault against a $50,000 reserve: a $3,000 payment today
  // leaves $49,000 and the chain would refuse it.
  const tight = snapshot({
    treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
  });

  it("schedules rather than paying now", async () => {
    const decision = await decidePayment({ snapshot: tight, invoice: invoice(), asOf: ASOF });

    expect(decision.authorityStatus).toBe("WITHIN_AUTONOMOUS");
    expect(decision.deterministicCeiling).toBe("SCHEDULE");
    expect(decision.decision).toBe("SCHEDULE");
    expect(decision.recommendedPaymentDate).not.toBe(ASOF);
  });

  it("picks a date the chain will actually accept", async () => {
    const decision = await decidePayment({ snapshot: tight, invoice: invoice(), asOf: ASOF });
    // The $55,000 receivable on the 12th is what makes a later date work.
    expect(decision.projectedBalanceAfterPayment).toBeGreaterThanOrEqual(dollars(50_000));
  });

  it("explains why not today, with both figures", async () => {
    const decision = await decidePayment({ snapshot: tight, invoice: invoice(), asOf: ASOF });

    expect(decision.explanation.whyNotToday).toContain("$49,000");
    expect(decision.explanation.whyNotToday).toContain("$50,000");
  });

  it("refuses to be pushed into paying today", async () => {
    const decision = await decidePayment({
      snapshot: tight,
      invoice: invoice(),
      asOf: ASOF,
      explainer: recklessExplainer(ASOF),
    });

    expect(decision.decision).toBe("SCHEDULE");
    expect(decision.clampedToCeiling).toBe(true);
  });
});

// --- D ---------------------------------------------------------------------

describe("D — an unapproved supplier", () => {
  it("is rejected outright", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ supplierId: "sup_pending", recipient: OTHER_WALLET }),
      asOf: ASOF,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "SUPPLIER_NOT_APPROVED" && r.blocking)).toBe(true);
    expect(decision.recommendedPaymentDate).toBeNull();
  });

  it("is rejected when the supplier is not in the registry at all", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ supplierId: "sup_never_seen" }),
      asOf: ASOF,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "SUPPLIER_NOT_IN_REGISTRY" && r.blocking)).toBe(true);
  });

  it("stays rejected however confident the model is", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ supplierId: "sup_never_seen" }),
      asOf: ASOF,
      explainer: recklessExplainer(),
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.clampedToCeiling).toBe(true);
  });
});

// --- E ---------------------------------------------------------------------

describe("E — the remit address does not match the registry", () => {
  it("is rejected — this is the payment-redirection case", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ recipient: OTHER_WALLET }),
      asOf: ASOF,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "RECIPIENT_WALLET_MISMATCH" && r.blocking)).toBe(true);
  });

  it("accepts the same address written differently", async () => {
    // Sui addresses vary in case and 0x; a cosmetic difference must not read as
    // fraud.
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ recipient: WALLET.replace("0x", "0X").toUpperCase() }),
      asOf: ASOF,
    });

    expect(decision.risks.some((r) => r.code === "RECIPIENT_WALLET_MISMATCH")).toBe(false);
  });
});

// --- F ---------------------------------------------------------------------

describe("F — an invoice that has already been settled", () => {
  it("is rejected", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ status: "PAID" }),
      asOf: ASOF,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "INVOICE_ALREADY_PAID" && r.blocking)).toBe(true);
  });

  it("is rejected when the invoice was cancelled", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ status: "REJECTED" }),
      asOf: ASOF,
    });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "INVOICE_NOT_PAYABLE" && r.blocking)).toBe(true);
  });
});

// --- G ---------------------------------------------------------------------

describe("G — a future inflow makes a later date safer", () => {
  it("waits for the receivable rather than refusing", async () => {
    // $51,000 now; a $3,000 payment today leaves $48,000 and would be refused.
    // The $55,000 receivable on the 12th changes that.
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(51_000), availableCents: dollars(1_000) },
    });
    const decision = await decidePayment({ snapshot: tight, invoice: invoice(), asOf: ASOF });

    expect(decision.decision).toBe("SCHEDULE");
    expect(decision.recommendedPaymentDate).not.toBeNull();
    expect(decision.recommendedPaymentDate! >= "2026-09-12").toBe(true);
    expect(decision.facts.cashFlow.upcomingInflows[0].amountCents).toBe(dollars(55_000));
  });

  it("rejects when no inflow ever makes it affordable", async () => {
    const broke = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(50_500), availableCents: dollars(500) },
      cashFlowEvents: [],
    });
    const decision = await decidePayment({ snapshot: broke, invoice: invoice(), asOf: ASOF });

    expect(decision.decision).toBe("REJECT");
    expect(decision.risks.some((r) => r.code === "NO_SAFE_PAYMENT_DATE" && r.blocking)).toBe(true);
  });
});

// --- H ---------------------------------------------------------------------

describe("H — urgency weighed against the reserve", () => {
  it("flags an imminent due date without changing the verdict on its own", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ dueDate: "2026-09-02" }),
      asOf: ASOF,
    });

    expect(decision.risks.some((r) => r.code === "DUE_IMMINENT" && !r.blocking)).toBe(true);
    expect(decision.decision).toBe("PAY_NOW");
  });

  it("flags an overdue invoice", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ dueDate: "2026-08-25" }),
      asOf: ASOF,
    });

    const overdue = decision.risks.find((r) => r.code === "OVERDUE")!;
    expect(overdue.blocking).toBe(false);
    expect(overdue.evidence.daysOverdue).toBe(7);
  });

  it("still will not breach the reserve for an urgent invoice", async () => {
    // Urgency is a reason to prefer an earlier date, never a reason to pay one
    // the chain would refuse.
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(51_000), availableCents: dollars(1_000) },
    });
    const decision = await decidePayment({
      snapshot: tight,
      invoice: invoice({ dueDate: "2026-09-02" }),
      asOf: ASOF,
      explainer: recklessExplainer(ASOF),
    });

    expect(decision.decision).not.toBe("PAY_NOW");
    expect(decision.facts.cashFlow.today.breachesReserveImmediately).toBe(true);
  });
});

// --- cross-cutting -----------------------------------------------------------

describe("the guard holds in every direction", () => {
  it("lets an explainer be MORE cautious than the ceiling", async () => {
    const timid: DecisionExplainer = {
      id: "llm",
      async explain() {
        return {
          action: "HUMAN_APPROVAL",
          recommendedDate: null,
          confidence: 0.4,
          reasons: ["I would rather a person looked at this"],
          explanation: { summary: "", cashFlow: "", risk: "", whyNotToday: "" },
        };
      },
    };
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: timid,
    });

    expect(decision.deterministicCeiling).toBe("PAY_NOW");
    expect(decision.decision).toBe("HUMAN_APPROVAL");
    expect(decision.clampedToCeiling).toBe(false);
  });

  it("discards a payment date that was never offered", async () => {
    const inventive: DecisionExplainer = {
      id: "llm",
      async explain() {
        return {
          action: "SCHEDULE",
          recommendedDate: "2027-01-01",
          confidence: 0.9,
          reasons: ["a date of my own choosing"],
          explanation: { summary: "", cashFlow: "", risk: "", whyNotToday: "" },
        };
      },
    };
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: inventive,
    });

    expect(decision.recommendedPaymentDate).not.toBe("2027-01-01");
    expect(decision.facts.selectableDates).toContain(decision.recommendedPaymentDate!);
  });

  it("falls back deterministically when the explainer throws", async () => {
    const broken: DecisionExplainer = {
      id: "llm",
      async explain() {
        throw new Error("Workers AI unreachable");
      },
    };
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: broken,
    });

    // Labelled honestly, so a degraded run is never shown as an AI decision.
    expect(decision.engine).toBe("DETERMINISTIC");
    expect(decision.decision).toBe("PAY_NOW");
  });

  it("clamps a confidence outside 0..1", async () => {
    const overconfident: DecisionExplainer = {
      id: "llm",
      async explain() {
        return {
          action: "PAY_NOW",
          recommendedDate: ASOF,
          confidence: 42,
          reasons: ["absolutely certain"],
          explanation: { summary: "", cashFlow: "", risk: "", whyNotToday: "" },
        };
      },
    };
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: overconfident,
    });

    expect(decision.confidence).toBe(1);
  });

  it("never lets confidence widen what is permitted", async () => {
    // Invariant 4, restated at this layer: a maximally confident model facing a
    // revoked supplier still gets REJECT.
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ supplierId: "sup_pending", recipient: OTHER_WALLET }),
      asOf: ASOF,
      explainer: recklessExplainer(),
    });

    expect(decision.confidence).toBe(0.99);
    expect(decision.decision).toBe("REJECT");
  });
});

describe("the ceiling is computed without any model", () => {
  it("is a pure function of the facts", () => {
    const facts = buildDecisionFacts({ snapshot: snapshot(), invoice: invoice(), asOf: ASOF });
    expect(deterministicCeiling(facts)).toBe("PAY_NOW");
    expect(facts.ceiling).toBe("PAY_NOW");
  });

  it("offers no selectable dates when the answer is REJECT", () => {
    const facts = buildDecisionFacts({
      snapshot: snapshot(),
      invoice: invoice({ status: "PAID" }),
      asOf: ASOF,
    });

    expect(facts.ceiling).toBe("REJECT");
    expect(facts.selectableDates).toEqual([]);
  });

  it("offers only dates the chain would accept", () => {
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
    });
    const facts = buildDecisionFacts({ snapshot: tight, invoice: invoice(), asOf: ASOF });

    expect(facts.selectableDates).not.toContain(ASOF);
    for (const date of facts.selectableDates) {
      const option = facts.cashFlow.candidates.find((c) => c.date === date)!;
      expect(option.breachesReserveImmediately).toBe(false);
    }
  });
});

describe("agent state from the chain drives authority", () => {
  it("requires approval when the agent is disabled", async () => {
    const disabled = snapshot({ agent: { ...AGENT, enabled: false } });
    const decision = await decidePayment({ snapshot: disabled, invoice: invoice(), asOf: ASOF });

    expect(decision.authorityStatus).toBe("AGENT_DISABLED");
    expect(decision.decision).toBe("HUMAN_APPROVAL");
  });

  it("requires approval when the daily limit is nearly used up", async () => {
    const spent = snapshot({
      agent: { ...AGENT, spentTodayCents: dollars(19_000), remainingTodayCents: dollars(1_000) },
    });
    const decision = await decidePayment({ snapshot: spent, invoice: invoice(), asOf: ASOF });

    expect(decision.authorityStatus).toBe("EXCEEDS_DAILY_LIMIT");
    expect(decision.decision).toBe("HUMAN_APPROVAL");
  });

  it("requires approval when no agent is registered at all", async () => {
    const decision = await decidePayment({
      snapshot: snapshot({ agent: null }),
      invoice: invoice(),
      asOf: ASOF,
    });

    expect(decision.authorityStatus).toBe("AGENT_NOT_REGISTERED");
    expect(decision.decision).toBe("HUMAN_APPROVAL");
  });
});

describe("same-day inflows are not counted as already banked", () => {
  /*
   * Move check 9 compares the vault as it stands at execution — it has no
   * notion of a day. A receivable dated the same morning may not have landed
   * when the transaction runs, so counting it would promise payments the chain
   * then refuses. This was a real bug: the balance-after-payment came out
   * HIGHER than the opening vault.
   */
  const sameDayInflow = snapshot({
    cashFlowEvents: [
      { date: ASOF, direction: "INFLOW", amountCents: dollars(35_000), description: "Meridian receivable" },
      ...EVENTS,
    ],
  });

  it("never reports a balance above the vault after spending from it", async () => {
    const decision = await decidePayment({
      snapshot: sameDayInflow,
      invoice: invoice({ amountCents: dollars(3_000) }),
      asOf: ASOF,
    });

    expect(decision.projectedBalanceAfterPayment).toBe(dollars(94_000));
    expect(decision.projectedBalanceAfterPayment).toBeLessThan(TREASURY.balanceCents);
  });

  it("does not let a same-day receivable rescue a payment the chain would refuse", async () => {
    // $52,000 vault, $3,000 payment, $35,000 arriving "today". Counting it
    // would say the reserve is safe; the chain would disagree.
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
      cashFlowEvents: [
        { date: ASOF, direction: "INFLOW", amountCents: dollars(35_000), description: "same-day receivable" },
      ],
    });
    const facts = buildDecisionFacts({ snapshot: tight, invoice: invoice(), asOf: ASOF });

    expect(facts.cashFlow.today.balanceAfterPaymentCents).toBe(dollars(49_000));
    expect(facts.cashFlow.today.breachesReserveImmediately).toBe(true);
  });

  it("DOES count an inflow that arrived on an earlier day", async () => {
    // The distinction that makes SCHEDULE worth recommending at all.
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
      cashFlowEvents: [
        { date: "2026-09-03", direction: "INFLOW", amountCents: dollars(35_000), description: "receivable" },
      ],
    });
    const facts = buildDecisionFacts({
      snapshot: tight,
      invoice: invoice({ dueDate: "2026-09-20" }),
      asOf: ASOF,
    });

    expect(facts.cashFlow.earliestSafeDate).not.toBeNull();
    expect(facts.cashFlow.earliestSafeDate! > "2026-09-03").toBe(true);
  });
});
