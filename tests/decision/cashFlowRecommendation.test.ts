/**
 * The AI CFO recommendation survives the model being unreachable.
 *
 * WHAT THE PAGE USED TO DO. When Workers AI could not be reached, the safety
 * fallback returned `recommendedDate: null` — correctly, because an unreachable
 * model must never be able to cause a payment — and the cash-flow panel
 * rendered that as:
 *
 *     "No payment date — this invoice does not proceed"
 *
 * which is a statement about the TREASURY made on the strength of a fact about
 * the NETWORK. The simulation had already run, several dates cleared the
 * reserve comfortably, and the screen said none did.
 *
 * Three things had been collapsed into one sentence: the deterministic
 * simulation, the model's timing verdict, and Sui's authorization. These tests
 * hold them apart — and hold the labelling honest, because a recorded
 * recommendation is useful and a recorded one wearing a LIVE badge is not.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  cashFlowRecommendation,
  chooseScenario,
  type RecommendationInput,
} from "../../lib/decision/cashFlowRecommendation";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { scenarioById, DEMO_AS_OF_DATE } from "../../lib/demo/scenarios";
import { fallbackDecision } from "../../lib/ai/fallbackEngine";
import type { CashFlowScenario } from "../../lib/types";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const panel = source("components/invoices/CashFlowAnalysis.tsx");

const ASOF = "2026-09-06";

function scenario(overrides: Partial<CashFlowScenario> = {}): CashFlowScenario {
  return {
    paymentDate: ASOF,
    daysFromToday: 0,
    projectedMinimumCashCents: 7_000_000,
    projectedMinimumCashDate: "2026-09-12",
    reserveBreach: false,
    breachDepthCents: 0,
    balanceOnPaymentDateCents: 7_000_000,
    discountCapturedCents: 0,
    paymentAmountCents: 3_000_000,
    isAfterDueDate: false,
    daysBeforeDue: 4,
    ...overrides,
  };
}

/** Pay Sep 6 → $70,000 trough; pay Sep 20 → $85,000. Neither breaches. */
const TWO_SAFE_DATES: CashFlowScenario[] = [
  scenario(),
  scenario({
    paymentDate: "2026-09-20",
    daysFromToday: 14,
    projectedMinimumCashCents: 8_500_000,
  }),
];

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    scenarios: TWO_SAFE_DATES,
    policy: { minimumReserveCents: 5_000_000 },
    asOfDate: ASOF,
    ...overrides,
  };
}

// --- AI unavailable is not payment blocked ----------------------------------------

describe("a model outage does not remove the payment dates", () => {
  it("still recommends a date when the live verdict is absent", () => {
    const result = cashFlowRecommendation(input({ liveRecommendedDate: null }));
    expect(result.recommendedDate).not.toBeNull();
    expect(result.noSafeDate).toBe(false);
    expect(result.headline).not.toMatch(/does not proceed/i);
  });

  it("labels it as recorded, never as live", () => {
    const result = cashFlowRecommendation(input({ liveRecommendedDate: null }));
    expect(result.source).toBe("DEMO_FALLBACK");
  });

  it("the safety fallback still refuses to authorize anything", () => {
    // The security property this must not cost: an unreachable model can never
    // produce AUTO_PAY or SCHEDULE as a DECISION. Only the displayed timing
    // recommendation is recovered.
    const decision = fallbackDecision({ summary: "no model" }, 0).decision;
    expect(decision.action).toBe("HUMAN_REVIEW");
    expect(decision.recommendedDate).toBeNull();
    expect(decision.confidence).toBe(0);
  });

  it("grants no authorization of its own", () => {
    const result = cashFlowRecommendation(input({ liveRecommendedDate: null }));
    expect(Object.keys(result)).not.toContain("approved");
    expect(Object.keys(result)).not.toContain("authorized");
  });
});

// --- the only legitimate "no payment date" ----------------------------------------

describe('"no payment date" comes from the forecast, never from the model', () => {
  it("is shown when every candidate date breaches the reserve", () => {
    const allBreach = TWO_SAFE_DATES.map((entry) =>
      scenario({ ...entry, reserveBreach: true, breachDepthCents: 100_000 }),
    );
    const result = cashFlowRecommendation(input({ scenarios: allBreach }));
    expect(result.noSafeDate).toBe(true);
    expect(result.recommendedDate).toBeNull();
    expect(result.reason).toMatch(/below the \$50,000 reserve/i);
  });

  it("is NOT shown merely because the model was unreachable", () => {
    const result = cashFlowRecommendation(input({ liveRecommendedDate: null }));
    expect(result.noSafeDate).toBe(false);
  });

  it("is shown when one date is safe? no — that date is recommended", () => {
    const oneSafe = [
      scenario({ reserveBreach: true, breachDepthCents: 50_000 }),
      scenario({ paymentDate: "2026-09-20", daysFromToday: 14, projectedMinimumCashCents: 8_500_000 }),
    ];
    const result = cashFlowRecommendation(input({ scenarios: oneSafe }));
    expect(result.noSafeDate).toBe(false);
    expect(result.recommendedDate).toBe("2026-09-20");
  });
});

// --- the recommendation cannot contradict the table -------------------------------

describe("the recommendation agrees with the displayed simulation", () => {
  it("quotes the chosen scenario's own figures", () => {
    const result = cashFlowRecommendation(input());
    expect(result.reason).toContain("$85,000");
    expect(result.reason).toContain("$50,000");
  });

  it("states what waiting buys, as a subtraction of two displayed figures", () => {
    // $85,000 − $70,000 = $15,000. Never a number written into the UI.
    const waiting = cashFlowRecommendation(input());
    expect(waiting.comparison).toMatch(/\$15,000/);

    // And when today would breach, the sentence names both troughs instead.
    const breachToday = [scenario({ reserveBreach: true }), TWO_SAFE_DATES[1]!];
    const rescued = cashFlowRecommendation(input({ scenarios: breachToday }));
    expect(rescued.comparison).toMatch(/\$70,000/);
    expect(rescued.comparison).toMatch(/\$85,000/);
  });

  it("waits for the better trough when nothing rewards paying early", () => {
    // THE AI CFO STORY. $30,000 due in a fortnight, no discount: both dates
    // clear the reserve, and one keeps $15,000 more headroom for nothing.
    const result = cashFlowRecommendation(input());
    expect(result.recommendedDate).toBe("2026-09-20");
    expect(result.comparison).toContain("$15,000");
    expect(result.comparison).toMatch(/preserves .* more projected/i);
  });

  it("takes the discount instead when one is on the table", () => {
    // Money already offered outweighs a better projected trough.
    const withDiscount = [
      scenario({ discountCapturedCents: 60_000 }),
      scenario({
        paymentDate: "2026-09-20",
        daysFromToday: 14,
        projectedMinimumCashCents: 8_500_000,
      }),
    ];
    const result = cashFlowRecommendation(input({ scenarios: withDiscount }));
    expect(result.recommendedDate).toBe(ASOF);
  });

  it("never recommends paying after the due date when an on-time date is safe", () => {
    const late = [
      scenario({ paymentDate: "2026-09-20", daysFromToday: 14, projectedMinimumCashCents: 7_500_000 }),
      scenario({
        paymentDate: "2026-10-04",
        daysFromToday: 28,
        projectedMinimumCashCents: 9_900_000,
        isAfterDueDate: true,
      }),
    ];
    const result = cashFlowRecommendation(input({ scenarios: late }));
    expect(result.recommendedDate).toBe("2026-09-20");
  });

  it("pays at the earliest safe date when the invoice is already overdue", () => {
    const overdue = [
      scenario({ isAfterDueDate: true, projectedMinimumCashCents: 7_000_000 }),
      scenario({
        paymentDate: "2026-09-20",
        daysFromToday: 14,
        projectedMinimumCashCents: 8_500_000,
        isAfterDueDate: true,
      }),
    ];
    const result = cashFlowRecommendation(input({ scenarios: overdue }));
    expect(result.recommendedDate).toBe(ASOF);
  });

  it("the recommendation rule is display-only and differs from the engine's", () => {
    // The engine takes today whenever today is safe, because it answers
    // "may the agent settle NOW?". This answers "when is it best to pay?".
    const { chosen } = chooseScenario(TWO_SAFE_DATES, ASOF);
    expect(chosen?.paymentDate).toBe("2026-09-20");
  });

  it("ignores a live date the simulation does not offer", () => {
    // A model naming a date the table does not show would put the
    // recommendation and the arithmetic into open disagreement.
    const result = cashFlowRecommendation(input({ liveRecommendedDate: "2027-01-01" }));
    expect(result.source).toBe("DEMO_FALLBACK");
    expect(TWO_SAFE_DATES.map((s) => s.paymentDate)).toContain(result.recommendedDate);
  });
});

// --- a live verdict is honoured and labelled ---------------------------------------

describe("with a live model", () => {
  it("uses the live date and marks it LIVE", () => {
    const result = cashFlowRecommendation(
      input({ liveRecommendedDate: "2026-09-20", liveExplanation: "Model prose." }),
    );
    expect(result.source).toBe("LIVE");
    expect(result.recommendedDate).toBe("2026-09-20");
    expect(result.reason).toBe("Model prose.");
  });
});

// --- against the real s2_cashflow scenario ----------------------------------------

describe("the real AI CFO demo invoice", () => {
  it("has safe payment dates, so a recorded recommendation is available", async () => {
    const demo = scenarioById("s2_cashflow");
    const analysis = await buildAnalysis({
      document: demo.document,
      world: demo.world,
      asOf: DEMO_AS_OF_DATE,
    });

    const result = cashFlowRecommendation({
      scenarios: analysis.cashFlowScenarios,
      policy: analysis.policyFacts,
      asOfDate: analysis.asOfDate,
      liveRecommendedDate: null,
    });

    // The $30,000 AI-CFO story: dates exist, and the panel must show one.
    expect(analysis.cashFlowScenarios.length).toBeGreaterThan(0);
    expect(result.noSafeDate).toBe(false);
    expect(result.recommendedDate).not.toBeNull();
    expect(result.source).toBe("DEMO_FALLBACK");

    // And it names a date the page actually renders.
    expect(analysis.cashFlowScenarios.map((s) => s.paymentDate)).toContain(
      result.recommendedDate,
    );

    // The demo story, from the engine's own figures: $30,000 due 2026-09-20,
    // no discount, both dates safe, and waiting keeps $15,000 more headroom.
    expect(result.recommendedDate).toBe("2026-09-20");
    expect(result.comparison).toContain("$15,000");
  });
});

// --- the panel ---------------------------------------------------------------------

describe("the cash-flow panel", () => {
  it("renders the recommendation from the shared rule, not from the decision", () => {
    expect(panel).toContain("cashFlowRecommendation({");
    expect(panel).toContain("scenarios: facts.cashFlowScenarios");
  });

  it("only trusts a live date when the engine actually ran a model", () => {
    expect(panel).toContain('analysis.engine === "LLM" ? analysis.decision.recommendedDate : null');
  });

  it("labels the fallback honestly and never as live", () => {
    expect(panel).toContain("Demo fallback — live AI unavailable");
    expect(panel).toContain("Recorded demo recommendation");
    expect(panel).toContain("It grants no authorization");
  });

  it("no longer ties the refusal wording to a missing model", () => {
    expect(panel).not.toContain("No payment date — this invoice does not proceed");
  });

  it("keeps the simulation visible regardless of the model", () => {
    // The scenario table and chart are rendered unconditionally; only the
    // recommendation block varies.
    expect(panel).toContain("facts.cashFlowScenarios.map((scenario) => (");
    expect(panel).toContain("<CashFlowChart");
  });
});
