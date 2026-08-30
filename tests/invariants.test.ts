/**
 * Safety invariants.
 *
 * These hold for ANY decision the AI could possibly emit, so they are the part
 * of the suite that does not depend on model behaviour. If the model is having
 * a bad day, these are what still stop a bad payment.
 */

import { describe, expect, it } from "vitest";

import { createFallbackEngine } from "../lib/ai/fallbackEngine";
import { buildAnalysis, deepFreeze } from "../lib/deterministic/buildAnalysis";
import { buildRiskEvidence } from "../lib/deterministic/buildRiskEvidence";
import { buildUrgencyFacts } from "../lib/deterministic/buildUrgencyFacts";
import { extractInvoice } from "../lib/deterministic/extractInvoice";
import { lookupSupplier } from "../lib/deterministic/lookupSupplier";
import { validateInvoice } from "../lib/deterministic/validateInvoice";
import { SCENARIOS, scenarioById } from "../lib/demo/scenarios";
import { runScenario } from "../lib/demo/runScenario";
import { TREASURY_POLICY } from "../lib/demo/policies";
import { PURCHASE_ORDERS } from "../lib/demo/purchaseOrders";
import { PAYMENT_HISTORY } from "../lib/demo/paymentHistory";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { TREASURY_ACTIONS } from "../lib/ai/decisionSchema";
import { addDays } from "../lib/util/date";
import type {
  DecisionResult,
  RawInvoiceDocument,
  TreasuryAction,
  TreasuryDecisionEngine,
} from "../lib/types";

/**
 * An engine that returns whatever we tell it to — including decisions a real
 * model should never make. Lets us test what happens when the AI is wrong.
 */
function stubEngine(action: TreasuryAction, recommendedDate: string | null): TreasuryDecisionEngine {
  return {
    id: "llm",
    decide(): Promise<DecisionResult> {
      return Promise.resolve({
        decision: {
          action,
          recommendedDate,
          risk: "LOW",
          urgency: "LOW",
          confidence: 0.99,
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

describe("the fallback engine cannot cause a payment", () => {
  it("never returns a payment action, whatever the invoice looks like", async () => {
    // The invariant is about what it CANNOT do. It escalates an open invoice
    // and refuses a blocked one — never pays either, and never builds a request.
    const engine = createFallbackEngine("test: model unavailable");
    for (const scenario of SCENARIOS) {
      const run = await runScenario(scenario, engine);
      const action = run.decision.decision.action;

      expect(["HUMAN_REVIEW", "REJECT"], scenario.id).toContain(action);
      expect(run.decision.engine, scenario.id).toBe("FALLBACK");
      expect(run.paymentRequest, scenario.id).toBeNull();
      expect(run.finalOutcome, scenario.id).toBe(
        action === "REJECT" ? "REJECTED" : "HUMAN_REVIEW",
      );
    }
  });

  it("refuses a blocked invoice rather than handing it to a person", async () => {
    // A redirected remit wallet is settled by the registry, not by judgement,
    // so an outage must not reopen it as a question.
    const run = await runScenario(
      scenarioById("s5_wallet_mismatch"),
      createFallbackEngine("test: model unavailable"),
    );
    expect(run.decision.decision.action).toBe("REJECT");
  });

  it("labels itself so a degraded run cannot pass as an AI decision", async () => {
    const run = await runScenario(SCENARIOS[0], createFallbackEngine("no credentials"));
    expect(run.decision.engine).toBe("FALLBACK");
    expect(run.decision.modelId).toBeNull();
    expect(run.decision.decision.confidence).toBe(0);
    expect(run.decision.decision.reasons.join(" ")).toMatch(/unavailable/i);
  });
});

describe("Sui remains the final authority", () => {
  it("rejects an autonomous payment above the agent's cap", async () => {
    // AUTO_PAY is the agent claiming it will settle this itself, so it is
    // measured against the agent's own capability — which it exceeds.
    const scenario = scenarioById("s8_policy_violation");
    const run = await runScenario(scenario, stubEngine("AUTO_PAY", scenario.asOfDate));

    expect(run.decision.decision.action).toBe("AUTO_PAY");
    expect(run.finalOutcome).toBe("SUI_REJECT");
    expect(run.enforcement?.outcome).toBe("SUI_REJECT");
    expect(run.enforcement?.violations.map((v) => v.code)).toContain("EXCEEDS_MAX_PAYMENT");
  });

  it("rejects an over-cap payment submitted under agent authority, whatever the action", async () => {
    // The security demonstration: submit it anyway and watch the chain refuse.
    const scenario = scenarioById("s8_policy_violation");

    for (const [action, date] of [
      ["AUTO_PAY", scenario.asOfDate],
      ["SCHEDULE", "2026-09-18"],
    ] as Array<[TreasuryAction, string]>) {
      const run = await runScenario(scenario, stubEngine(action, date), {
        forceAgentAuthority: true,
      });
      expect(run.decision.decision.action).toBe(action);
      expect(run.finalOutcome).toBe("SUI_REJECT");
      expect(run.enforcement?.outcome).toBe("SUI_REJECT");
      expect(run.enforcement?.violations.map((v) => v.code)).toContain("EXCEEDS_MAX_PAYMENT");
    }
  });

  it("never lets the agent promote itself past its own cap", async () => {
    // A scheduled over-cap payment needs a human. The critical property is that
    // it does not EXECUTE — it waits for a person who holds an approval the
    // agent cannot mint.
    const scenario = scenarioById("s8_policy_violation");
    const run = await runScenario(scenario, stubEngine("SCHEDULE", "2026-09-18"));

    expect(run.finalOutcome).toBe("AWAITING_APPROVAL");
    expect(run.finalOutcome).not.toBe("EXECUTED");
    expect(run.finalOutcome).not.toBe("SCHEDULED");
  });

  it("rejects a duplicate even when the AI insists on paying it", async () => {
    const scenario = scenarioById("s6_duplicate");
    const run = await runScenario(scenario, stubEngine("AUTO_PAY", scenario.asOfDate));
    expect(run.decision.decision.action).toBe("AUTO_PAY");
    expect(run.finalOutcome).toBe("SUI_REJECT");
    expect(run.enforcement?.violations.map((v) => v.code)).toContain("INVOICE_ALREADY_PAID");
  });

  it("rejects a redirected wallet even when the AI approves it", async () => {
    const scenario = scenarioById("s5_wallet_mismatch");
    const run = await runScenario(scenario, stubEngine("AUTO_PAY", scenario.asOfDate));
    expect(run.finalOutcome).toBe("SUI_REJECT");
    expect(run.enforcement?.violations.map((v) => v.code)).toContain("RECIPIENT_WALLET_MISMATCH");
  });

  it("rejects an unknown supplier even when the AI approves it", async () => {
    const scenario = scenarioById("s4_new_supplier");
    const run = await runScenario(scenario, stubEngine("AUTO_PAY", scenario.asOfDate));
    expect(run.finalOutcome).toBe("SUI_REJECT");
    expect(run.enforcement?.violations.map((v) => v.code)).toContain("SUPPLIER_NOT_APPROVED");
  });
});

describe("non-payment actions never reach the treasury", () => {
  it.each(["HUMAN_REVIEW", "REJECT"] as TreasuryAction[])(
    "%s builds no payment request",
    async (action) => {
      for (const scenario of SCENARIOS) {
        const run = await runScenario(scenario, stubEngine(action, null));
        expect(run.paymentRequest).toBeNull();
        expect(run.enforcement).toBeNull();
        expect(run.finalOutcome).toBe(action === "REJECT" ? "REJECTED" : "HUMAN_REVIEW");
      }
    },
  );

  it("covers every action in the enum across these invariants", () => {
    expect([...TREASURY_ACTIONS].sort()).toEqual(
      ["AUTO_PAY", "HUMAN_REVIEW", "REJECT", "SCHEDULE"].sort(),
    );
  });
});

describe("the AI cannot mutate policy", () => {
  it("hands the engine a deeply frozen analysis", async () => {
    const scenario = SCENARIOS[0];
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.policyFacts)).toBe(true);
    expect(Object.isFrozen(analysis.cashFlowScenarios)).toBe(true);

    // Silent no-op in sloppy mode, TypeError in strict mode — either way the
    // value must not change.
    const before = analysis.policyFacts.maxSinglePaymentCents;
    try {
      (analysis.policyFacts as { maxSinglePaymentCents: number }).maxSinglePaymentCents = 999_999_999;
    } catch {
      /* strict-mode throw is an acceptable outcome */
    }
    expect(analysis.policyFacts.maxSinglePaymentCents).toBe(before);
  });

  it("freezes nested arrays and objects", () => {
    const frozen = deepFreeze({ a: { b: [1, 2, 3] } });
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a.b)).toBe(true);
  });
});

describe("risk and urgency are independent dimensions", () => {
  /** Rewrites only the due date inside a raw document. */
  function withDueDate(doc: RawInvoiceDocument, dueDate: string): RawInvoiceDocument {
    return {
      ...doc,
      text: doc.text.replace(/^(\s*Due Date:\s*)\d{4}-\d{2}-\d{2}\s*$/m, `$1${dueDate}`),
    };
  }

  function evidenceFor(doc: RawInvoiceDocument, asOf: string) {
    const invoice = extractInvoice(doc, asOf);
    const supplier = lookupSupplier(invoice, SUPPLIERS);
    const validation = validateInvoice(
      invoice,
      supplier,
      PURCHASE_ORDERS,
      PAYMENT_HISTORY,
      TREASURY_POLICY,
    );
    return {
      risk: buildRiskEvidence(invoice, supplier, validation),
      urgency: buildUrgencyFacts(invoice, supplier),
    };
  }

  it("leaves risk evidence unchanged when only the due date moves", () => {
    for (const scenario of SCENARIOS) {
      const soon = evidenceFor(withDueDate(scenario.document, "2026-08-30"), scenario.asOfDate);
      const later = evidenceFor(withDueDate(scenario.document, "2026-12-01"), scenario.asOfDate);

      expect(later.risk).toEqual(soon.risk);
    }
  });

  it("moves urgency facts when the due date moves", () => {
    // Offsets from the run's own "today", so this keeps testing that urgency
    // tracks the due date however the demo clock is set.
    const scenario = scenarioById("s1_normal");
    const asOf = scenario.asOfDate;
    const soon = evidenceFor(withDueDate(scenario.document, addDays(asOf, 1)), asOf);
    const later = evidenceFor(withDueDate(scenario.document, addDays(asOf, 94)), asOf);

    expect(soon.urgency.daysUntilDue).toBe(1);
    expect(later.urgency.daysUntilDue).toBe(94);
    expect(later.urgency).not.toEqual(soon.urgency);
  });

  it("keeps dates out of the risk evidence input type entirely", async () => {
    // A structural check: the serialized risk evidence must never contain a
    // due date, because buildRiskEvidence is never given one.
    for (const scenario of SCENARIOS) {
      const analysis = await buildAnalysis({
        document: scenario.document,
        world: scenario.world,
        asOf: scenario.asOfDate,
      });
      const serialized = JSON.stringify(analysis.riskEvidence);
      expect(serialized).not.toContain(analysis.invoiceFacts.dueDate);
    }
  });
});

describe("the deterministic layer emits no judgements", () => {
  it("contains no action, score, or level field anywhere in the fact sheet", async () => {
    const forbidden = ["action", "score", "riskLevel", "urgencyLevel", "severity", "weight"];

    for (const scenario of SCENARIOS) {
      const analysis = await buildAnalysis({
        document: scenario.document,
        world: scenario.world,
        asOf: scenario.asOfDate,
      });

      const keys = new Set<string>();
      const walk = (value: unknown) => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach(walk);
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      };
      walk(analysis);

      for (const banned of forbidden) {
        expect(keys.has(banned)).toBe(false);
      }
    }
  });
});
