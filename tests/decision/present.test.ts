/**
 * What the interface shows, and the distinction it exists to protect.
 *
 * The whole point of `buildVerdicts` is that "can we afford it" and "may the
 * agent do it" are separate questions with separate answers. A viewer who sees
 * one verdict on an $8,000 invoice will read the refusal as a cash problem,
 * which is exactly backwards — the treasury has $97,000.
 *
 * These run against the same decision engine the UI uses, so a change that
 * collapsed the two verdicts would fail here rather than quietly mislead a
 * judge.
 */

import { describe, expect, it } from "vitest";

import { decidePayment } from "../../lib/decision/engine";
import {
  buildTimeline,
  buildVerdicts,
  defaultSelection,
  summariseQueue,
} from "../../lib/decision/present";
import type { PaymentDecision } from "../../lib/decision/types";
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
const OTHER = "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad0";
const dollars = (n: number) => n * 100;

const TREASURY: ChainTreasury = {
  objectId: "0xt",
  owner: "0xo",
  balanceCents: dollars(97_000),
  minimumReserveCents: dollars(50_000),
  humanApprovalThresholdCents: dollars(5_000),
  autoPayEnabled: true,
  allowedCurrencies: ["USD"],
  allowedCoinTypes: ["0xp::mock_usdc::MOCK_USDC"],
  maxRecommendationAgeMs: 86_400_000,
  totalPaidCents: dollars(3_000),
  paymentCount: 1,
  availableCents: dollars(47_000),
};

const AGENT: ChainAgent = {
  capObjectId: "0xa",
  agentId: "agent_payflow_01",
  enabled: true,
  maxSinglePaymentCents: dollars(5_000),
  dailyLimitCents: dollars(20_000),
  spentTodayCents: dollars(3_000),
  remainingTodayCents: dollars(17_000),
};

const SUPPLIERS: ChainSupplier[] = [
  { supplierId: "sup_northwind", name: "Northwind", registeredWallet: WALLET, status: "APPROVED" },
];

const EVENTS: ChainCashFlowEvent[] = [
  { date: "2026-09-12", direction: "INFLOW", amountCents: dollars(55_000), description: "Halden receivable" },
  { date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(40_000), description: "Payroll" },
];

function invoice(overrides: Partial<ChainInvoice> = {}): ChainInvoice {
  return {
    objectId: "0xinv",
    invoiceNumber: "INV-1",
    supplierId: "sup_northwind",
    amountCents: dollars(4_800),
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
    packageId: "0xp",
    readAt: "2026-09-01T00:00:00.000Z",
    treasury: TREASURY,
    agent: AGENT,
    suppliers: SUPPLIERS,
    invoices: [],
    cashFlowEvents: EVENTS,
    ...overrides,
  };
}

const decide = (inv: ChainInvoice, snap = snapshot()) =>
  decidePayment({ snapshot: snap, invoice: inv, asOf: ASOF });

describe("the $4,800 invoice — the autonomous demo", () => {
  let decision: PaymentDecision;
  it("reads SAFE and WITHIN LIMIT, and pays now", async () => {
    decision = await decide(invoice());
    const v = buildVerdicts(decision);

    expect(v.cashFlow.headline).toBe("SAFE");
    expect(v.authority.headline).toBe("WITHIN LIMIT");
    expect(v.supplier.headline).toBe("VERIFIED");
    expect(v.invoice.headline).toBe("OPEN");
    expect(v.finalAction.label).toBe("PAY NOW");
  });

  it("says plainly that no person is needed", async () => {
    const v = buildVerdicts(await decide(invoice()));
    expect(v.finalAction.because).toContain("without a person");
  });
});

describe("the $8,000 invoice — affordable but not authorized", () => {
  const big = invoice({ amountCents: dollars(8_000), invoiceNumber: "INV-B" });

  it("keeps the two verdicts apart", async () => {
    const v = buildVerdicts(await decide(big));

    // The whole point. Money is fine; authority is not.
    expect(v.cashFlow.state).toBe("PASS");
    expect(v.cashFlow.headline).toBe("SAFE");
    expect(v.authority.state).toBe("FAIL");
    expect(v.authority.headline).toBe("EXCEEDED");
    expect(v.finalAction.label).toBe("HUMAN APPROVAL");
  });

  it("names the cap in the authority detail, not a cash figure", async () => {
    const v = buildVerdicts(await decide(big));

    expect(v.authority.detail).toContain("$8,000");
    expect(v.authority.detail).toContain("$5,000");
    expect(v.authority.detail).toContain("per-payment cap");
  });

  it("leads with 'cash-flow is safe, but…' so it cannot be read as a cash problem", async () => {
    const v = buildVerdicts(await decide(big));

    expect(v.finalAction.because.toLowerCase()).toContain("cash-flow is safe");
    expect(v.finalAction.because.toLowerCase()).toContain("cap");
  });
});

describe("the $19,500 invoice — recipient mismatch", () => {
  const bad = invoice({ amountCents: dollars(19_500), recipient: OTHER, invoiceNumber: "INV-E" });

  it("shows cash SAFE, authority EXCEEDED, supplier FAILED, final REJECT", async () => {
    const v = buildVerdicts(await decide(bad));

    expect(v.cashFlow.state).toBe("PASS");
    expect(v.authority.state).toBe("FAIL");
    expect(v.supplier.state).toBe("FAIL");
    expect(v.supplier.headline).toBe("FAILED");
    expect(v.finalAction.label).toBe("REJECT");
  });

  it("gives the blocking reason precedence over the authority one", async () => {
    // A mismatched address is why this is refused. The size is incidental and
    // must not be what a viewer takes away.
    const v = buildVerdicts(await decide(bad));
    expect(v.finalAction.because.toLowerCase()).toContain("registry");
  });
});

describe("the already-paid invoice", () => {
  it("shows invoice PAID and final REJECT", async () => {
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(3_000), status: "PAID" })));

    expect(v.invoice.headline).toBe("PAID");
    expect(v.finalAction.label).toBe("REJECT");
    expect(v.finalAction.because).toContain("already been settled");
  });
});

describe("a tight treasury", () => {
  const tight = snapshot({
    treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
  });

  it("reads TIGHT TODAY rather than SAFE or UNAFFORDABLE", async () => {
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(3_000) }), tight));

    expect(v.cashFlow.headline).toBe("TIGHT TODAY");
    expect(v.cashFlow.state).toBe("WARN");
    expect(v.finalAction.label).toBe("SCHEDULE");
  });

  it("reads UNAFFORDABLE when nothing ever clears the reserve", async () => {
    const broke = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(50_500), availableCents: dollars(500) },
      cashFlowEvents: [],
    });
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(3_000) }), broke));

    expect(v.cashFlow.headline).toBe("UNAFFORDABLE");
    expect(v.finalAction.label).toBe("REJECT");
  });
});

describe("the queue summary", () => {
  it("counts by action and splits value by who can authorize it", async () => {
    const decisions = await Promise.all([
      decide(invoice({ objectId: "0x1", invoiceNumber: "A", amountCents: dollars(4_800) })),
      decide(invoice({ objectId: "0x2", invoiceNumber: "B", amountCents: dollars(8_000) })),
      decide(invoice({ objectId: "0x3", invoiceNumber: "C", status: "PAID" })),
    ]);
    const summary = summariseQueue(decisions);

    expect(summary.total).toBe(3);
    expect(summary.byAction.PAY_NOW).toBe(1);
    expect(summary.byAction.HUMAN_APPROVAL).toBe(1);
    expect(summary.byAction.REJECT).toBe(1);
    expect(summary.autonomousValueCents).toBe(dollars(4_800));
    expect(summary.needsHumanValueCents).toBe(dollars(8_000));
  });
});

describe("the cash-flow timeline", () => {
  it("always includes the reserve line in its range", () => {
    // A healthy treasury would otherwise draw a chart the reserve never
    // appears on, which hides the one line that matters.
    const timeline = buildTimeline(snapshot(), { asOf: ASOF });

    expect(timeline.minCents).toBeLessThanOrEqual(timeline.reserveCents);
    expect(timeline.maxCents).toBeGreaterThanOrEqual(timeline.reserveCents);
  });

  it("marks the recommended payment date", async () => {
    const decision = await decide(invoice());
    const timeline = buildTimeline(snapshot(), {
      asOf: ASOF,
      payment: { date: decision.recommendedPaymentDate!, amountCents: decision.facts.amountCents },
    });

    expect(timeline.points.filter((point) => point.isPaymentDate)).toHaveLength(1);
    expect(timeline.paymentDate).toBe(decision.recommendedPaymentDate);
  });

  it("carries the conservative post-payment balance separately from the line", async () => {
    // The line is end-of-day; the chain checks the vault at the moment of
    // payment. On a day money also arrives those differ, and the chart must not
    // be read as the chain's figure.
    const sameDay = snapshot({
      cashFlowEvents: [
        { date: ASOF, direction: "INFLOW", amountCents: dollars(35_000), description: "same-day" },
        ...EVENTS,
      ],
    });
    const decision = await decide(invoice(), sameDay);
    const timeline = buildTimeline(sameDay, {
      asOf: ASOF,
      payment: { date: ASOF, amountCents: decision.facts.amountCents },
      balanceAfterPaymentCents: decision.projectedBalanceAfterPayment,
    });

    const endOfDay = timeline.points[0].balanceCents;
    expect(timeline.balanceAfterPaymentCents).toBe(dollars(92_200)); // $97,000 − $4,800
    expect(endOfDay).toBeGreaterThan(timeline.balanceAfterPaymentCents!);
  });

  it("reports events inside the horizon", () => {
    const timeline = buildTimeline(snapshot(), { asOf: ASOF });
    expect(timeline.events.map((event) => event.date)).toContain("2026-09-12");
  });
});

describe("presentation when the AI explanation is unavailable", () => {
  /** A model that fails exactly the way Cloudflare is failing right now. */
  const rateLimited = {
    id: "llm" as const,
    async explain(): Promise<never> {
      throw new Error(
        'Workers AI returned HTTP 429: {"errors":[{"message":"AiError: you have used up your ' +
          'daily free allocation of 10,000 neurons","code":4006}],"success":false}',
      );
    },
  };

  it("still produces the real deterministic decision, not a blanket escalation", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice({ amountCents: dollars(4_800) }),
      asOf: ASOF,
      explainer: rateLimited,
    });

    // The whole point: an unreachable model must not turn PAY_NOW into
    // "human review required".
    expect(decision.decision).toBe("PAY_NOW");
    expect(decision.requiresHumanApproval).toBe(false);
    expect(buildVerdicts(decision).finalAction.label).toBe("PAY NOW");
  });

  it("labels the prose honestly and never claims a model ran", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: rateLimited,
    });

    expect(decision.explanationSource.kind).toBe("DETERMINISTIC_FALLBACK");
    expect(decision.explanationSource.label).toBe(
      "Deterministic fallback · AI explanation unavailable",
    );
    expect(decision.engine).toBe("DETERMINISTIC");
    expect(decision.explanationSource.label).not.toMatch(/workers ai$/i);
  });

  it("keeps the raw HTTP error out of everything a panel renders", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: rateLimited,
    });

    // reasons, explanation prose and verdicts are all judge-facing.
    const visible = [
      ...decision.reasons,
      decision.explanation.summary,
      decision.explanation.cashFlow,
      decision.explanation.risk,
      decision.explanation.whyNotToday,
      decision.explanationSource.label,
      decision.explanationSource.reason ?? "",
      JSON.stringify(buildVerdicts(decision)),
    ].join(" ");

    expect(visible).not.toMatch(/429/);
    expect(visible).not.toMatch(/neurons/i);
    expect(visible).not.toMatch(/AiError/);
    expect(visible).not.toMatch(/\{"errors"/);
  });

  it("keeps the raw error available for the Engine details disclosure", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: rateLimited,
    });

    // Hidden, not discarded — a developer still needs to see it.
    expect(decision.explanationSource.detail).toContain("429");
    expect(decision.explanationSource.reason).toBe(
      "The Workers AI account has used its daily allocation.",
    );
  });

  it("still fills the WHY prose from the deterministic explainer", async () => {
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: rateLimited,
    });

    expect(decision.explanation.summary.length).toBeGreaterThan(20);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("carries no failure detail when the model worked", async () => {
    const working = {
      id: "llm" as const,
      async explain() {
        return {
          action: "PAY_NOW" as const,
          recommendedDate: ASOF,
          confidence: 0.9,
          reasons: ["all clear"],
          explanation: { summary: "pay it", cashFlow: "fine", risk: "none", whyNotToday: "" },
        };
      },
    };
    const decision = await decidePayment({
      snapshot: snapshot(),
      invoice: invoice(),
      asOf: ASOF,
      explainer: working,
    });

    expect(decision.explanationSource.kind).toBe("LLM");
    expect(decision.explanationSource.detail).toBeNull();
    expect(decision.engine).toBe("LLM");
  });

  it("shows the four seeded demo verdicts correctly with no model at all", async () => {
    const cases = [
      { amountCents: dollars(4_800), expect: "PAY NOW", cash: "SAFE", auth: "WITHIN LIMIT" },
      { amountCents: dollars(8_000), expect: "HUMAN APPROVAL", cash: "SAFE", auth: "EXCEEDED" },
    ];
    for (const c of cases) {
      const decision = await decidePayment({
        snapshot: snapshot(),
        invoice: invoice({ amountCents: c.amountCents }),
        asOf: ASOF,
        explainer: rateLimited,
      });
      const v = buildVerdicts(decision);
      expect(v.finalAction.label, `${c.amountCents}`).toBe(c.expect);
      expect(v.cashFlow.headline).toBe(c.cash);
      expect(v.authority.headline).toBe(c.auth);
      expect(v.supplier.headline).toBe("VERIFIED");
    }
  });
});

describe("the key insight, stated outright", () => {
  it("says the affordable-but-unauthorized line for the $8,000 invoice", async () => {
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(8_000) })));

    // Without this sentence, HUMAN APPROVAL on a $97,000 treasury reads as a
    // cash problem, which is the opposite of what happened.
    expect(v.finalAction.keyInsight).toBe(
      "The company can afford it. The AI agent is not authorized to pay it autonomously.",
    );
  });

  it("does not blame cash when a supplier fails verification", async () => {
    const v = buildVerdicts(
      await decide(invoice({ amountCents: dollars(19_500), recipient: OTHER })),
    );

    expect(v.finalAction.keyInsight).toContain("counterparty does not check out");
    expect(v.finalAction.keyInsight).toContain("amount is irrelevant");
  });

  it("names the duplicate for an already-paid invoice", async () => {
    const v = buildVerdicts(await decide(invoice({ status: "PAID" })));
    expect(v.finalAction.keyInsight).toContain("Already settled on chain");
  });

  it("says no human is needed for the autonomous case", async () => {
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(4_800) })));
    expect(v.finalAction.keyInsight).toContain("no human needed");
  });

  it("stays silent when there is nothing counter-intuitive to explain", async () => {
    // A tight treasury scheduling a payment is self-explanatory; an extra
    // sentence there is noise competing with the ones that matter.
    const tight = snapshot({
      treasury: { ...TREASURY, balanceCents: dollars(52_000), availableCents: dollars(2_000) },
    });
    const v = buildVerdicts(await decide(invoice({ amountCents: dollars(3_000) }), tight));

    expect(v.finalAction.label).toBe("SCHEDULE");
    expect(v.finalAction.keyInsight).toBeNull();
  });
});

describe("which invoice the board opens on", () => {
  it("prefers the autonomous case, so the demo does not open on a refusal", async () => {
    const decisions = await Promise.all([
      decide(invoice({ objectId: "0xreject", invoiceNumber: "R", status: "PAID" })),
      decide(invoice({ objectId: "0xhuman", invoiceNumber: "H", amountCents: dollars(8_000) })),
      decide(invoice({ objectId: "0xpay", invoiceNumber: "P", amountCents: dollars(4_800) })),
    ]);

    expect(defaultSelection(decisions)).toBe("0xpay");
  });

  it("falls back through the order when there is no PAY_NOW", async () => {
    const decisions = await Promise.all([
      decide(invoice({ objectId: "0xreject", invoiceNumber: "R", status: "PAID" })),
      decide(invoice({ objectId: "0xhuman", invoiceNumber: "H", amountCents: dollars(8_000) })),
    ]);

    expect(defaultSelection(decisions)).toBe("0xhuman");
  });

  it("returns null for an empty queue", () => {
    expect(defaultSelection([])).toBeNull();
  });
});
