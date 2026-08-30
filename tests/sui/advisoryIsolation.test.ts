/**
 * The AI's advisory output must not cross the chain boundary.
 *
 * The recommendation carries a risk level, an urgency level, a confidence, a
 * projected minimum cash figure and a whole "why not today" comparison. None of
 * it may reach the PaymentRequest, because the PaymentRequest is what the Move
 * layer judges — and Move must re-derive every answer from treasury state, not
 * read the AI's opinion of its own safety.
 *
 * This is Invariant 4 ("AI confidence cannot bypass Move policy") plus the
 * addendum's rule that the AI's forecast is never proof. It is written as an
 * exact key allowlist rather than a blocklist, so it fails if ANYONE widens the
 * payload later — including with a field nobody thought to forbid.
 */

import { describe, expect, it } from "vitest";

import { buildPaymentRecommendation } from "../../lib/ai/recommendation";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { buildPaymentRequest } from "../../lib/sui/paymentRequest";
import { SCENARIOS } from "../../lib/demo/scenarios";
import { runScenario } from "../../lib/demo/runScenario";
import type {
  DecisionResult,
  DeterministicAnalysis,
  TreasuryAction,
  TreasuryDecisionEngine,
} from "../../lib/types";

/**
 * Everything the chain is allowed to be told. Amount and recipient are what the
 * checks are ABOUT; the three recommendation fields are audit provenance and
 * the expiry window. Nothing here is a judgement.
 */
const ALLOWED_REQUEST_KEYS = [
  "invoiceNumber",
  "supplierId",
  "supplierName",
  "amountCents",
  "currency",
  "recipientWallet",
  "requestedDate",
  "agentId",
  "recommendationId",
  "recommendedAtMs",
  "expiresAtMs",
].sort();

/** Advisory fields that must never appear, by name, anywhere in the payload. */
const FORBIDDEN_KEYS = [
  "aiConfidence",
  "confidence",
  "riskLevel",
  "risk",
  "urgencyLevel",
  "urgency",
  "projectedMinimumCashCents",
  "reserveBreach",
  "cashStatus",
  "whyNotToday",
  "financialImpactCents",
  "reason",
  "reasons",
];

/** An engine that always wants to pay, so a request is actually built. */
function payingEngine(action: TreasuryAction, date: string): TreasuryDecisionEngine {
  return {
    id: "llm",
    decide(): Promise<DecisionResult> {
      return Promise.resolve({
        decision: {
          action,
          recommendedDate: date,
          risk: "LOW",
          urgency: "HIGH",
          confidence: 0.97,
          reasons: ["stubbed decision"],
          riskExplanation: "stub",
          cashFlowExplanation: "stub",
          whyNotTodayExplanation: "stub",
          decisionExplanation: "stub",
        },
        engine: "LLM",
        rawModelOutput: null,
        modelId: "stub",
        guard: { downgraded: false, from: action, violations: [] },
        latencyMs: 0,
      });
    },
  };
}

function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, nested] of Object.entries(node)) {
      keys.add(key);
      walk(nested);
    }
  };
  walk(value);
  return keys;
}

describe("no advisory value reaches the chain", () => {
  it("builds a payment request with exactly the allowed keys, and no others", async () => {
    for (const scenario of SCENARIOS) {
      const run = await runScenario(scenario, payingEngine("AUTO_PAY", scenario.asOfDate));
      // Every scenario recommends payment here, so a request must exist.
      expect(run.paymentRequest, `${scenario.id} built no request`).not.toBeNull();
      expect(Object.keys(run.paymentRequest!).sort()).toEqual(ALLOWED_REQUEST_KEYS);
    }
  });

  it.each(FORBIDDEN_KEYS)("never carries %s into the request", async (forbidden) => {
    for (const scenario of SCENARIOS) {
      const run = await runScenario(scenario, payingEngine("AUTO_PAY", scenario.asOfDate));
      expect(keysOf(run.paymentRequest).has(forbidden)).toBe(false);
    }
  });

  it("leaks no advisory VALUE either, not just no advisory key", async () => {
    const scenario = SCENARIOS[0];
    const run = await runScenario(scenario, payingEngine("AUTO_PAY", scenario.asOfDate));
    const serialized = JSON.stringify(run.paymentRequest);

    // 0.97 is the stub's confidence; the projections come from the analysis.
    expect(serialized).not.toContain("0.97");
    expect(serialized).not.toContain(
      String(run.recommendation.projectedMinimumCashCents),
    );
    expect(serialized).not.toContain(String(run.recommendation.minimumReserveCents));
  });

  it("proves the test is meaningful: the recommendation DOES carry them", async () => {
    const scenario = SCENARIOS[0];
    const run = await runScenario(scenario, payingEngine("AUTO_PAY", scenario.asOfDate));
    const present = keysOf(run.recommendation);

    for (const field of ["aiConfidence", "riskLevel", "urgencyLevel", "cashStatus"]) {
      expect(present.has(field), `recommendation should carry ${field}`).toBe(true);
    }
    expect(run.recommendation.aiConfidence).toBe(0.97);
  });

  it("keeps confidence out of the request even at the boundary function", async () => {
    const scenario = SCENARIOS[0];
    const analysis: Readonly<DeterministicAnalysis> = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const recommendation = buildPaymentRecommendation(
      {
        action: "SCHEDULE",
        recommendedDate: analysis.cashFlowScenarios.at(-1)!.paymentDate,
        risk: "CRITICAL",
        urgency: "CRITICAL",
        confidence: 1,
        reasons: ["a very confident but irrelevant opinion"],
        riskExplanation: "x",
        cashFlowExplanation: "x",
        whyNotTodayExplanation: "x",
        decisionExplanation: "x",
      },
      analysis,
      1_800_000_000_000,
    );

    const request = buildPaymentRequest(recommendation, analysis, "agent_payflow_01");

    // A maximally confident, maximally alarmed recommendation produces a request
    // that says nothing about either.
    expect(request).not.toBeNull();
    expect(Object.keys(request!).sort()).toEqual(ALLOWED_REQUEST_KEYS);
    expect(JSON.stringify(request)).not.toContain("CRITICAL");
  });
});
