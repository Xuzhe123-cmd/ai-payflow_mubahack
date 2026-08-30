/**
 * The deterministic safety boundary, enforced over the model.
 *
 * The property: a recommendation may be more cautious than the deterministic
 * answer, never less. A blocking condition — unregistered supplier, redirected
 * remit wallet, invoice already settled — is a fact rather than a judgement,
 * and no recommendation, however confident, turns it into a payable invoice.
 *
 * This exists because a live model really did return HUMAN_REVIEW for an
 * invoice whose remit wallet had been swapped. HUMAN_REVIEW is safe — no
 * payment request is built — but it puts a redirected-payment attempt in front
 * of a person as a judgement call, when the registry has already settled it.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { validateDecision } from "../lib/ai/validateDecision";
import { blockingConditions } from "../lib/ai/blockingConditions";
import { createFallbackEngine } from "../lib/ai/fallbackEngine";
import { createRecordedEngine } from "../lib/ai/recordedEngine";
import { createDeterministicEngine, decideDeterministically } from "../lib/ai/deterministicEngine";
import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { scenarioById } from "../lib/demo/scenarios";
import { runScenario } from "../lib/demo/runScenario";
import type { DeterministicAnalysis, TreasuryAction } from "../lib/types";

/** INV-2026-3479 — approved supplier, remit wallet swapped. */
let walletMismatch: Readonly<DeterministicAnalysis>;
/** INV-2026-3391 — invoice number already settled on chain. */
let duplicate: Readonly<DeterministicAnalysis>;
/** INV-BP-88214 — supplier not in the registry at all. */
let unknownSupplier: Readonly<DeterministicAnalysis>;
/** INV-2026-3468 — nothing wrong with it. */
let cleanInvoice: Readonly<DeterministicAnalysis>;

async function analysisFor(scenarioId: string) {
  const scenario = scenarioById(scenarioId);
  return buildAnalysis({
    document: scenario.document,
    world: scenario.world,
    asOf: scenario.asOfDate,
  });
}

beforeAll(async () => {
  [walletMismatch, duplicate, unknownSupplier, cleanInvoice] = await Promise.all([
    analysisFor("s5_wallet_mismatch"),
    analysisFor("s6_duplicate"),
    analysisFor("s4_new_supplier"),
    analysisFor("s3_discount"),
  ]);
});

/** Well-formed model output — nothing here is structurally invalid. */
function response(action: TreasuryAction, analysis: Readonly<DeterministicAnalysis>) {
  const paysNow = action === "AUTO_PAY" || action === "SCHEDULE";
  return JSON.stringify({
    action,
    recommendedDate: paysNow ? analysis.asOfDate : "",
    risk: "LOW",
    urgency: "MEDIUM",
    confidence: 0.95,
    reasons: ["Supplier is a long-standing counterparty", "Amount is within the cap"],
    riskExplanation: "All automated checks passed.",
    cashFlowExplanation: "Liquidity is comfortable on every candidate date.",
    decisionExplanation: "Proceed.",
  });
}

describe("a wallet mismatch is refused whatever the model recommends", () => {
  it("1. HUMAN_REVIEW + wallet mismatch → REJECT", () => {
    const outcome = validateDecision(response("HUMAN_REVIEW", walletMismatch), walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
    expect(outcome.from).toBe("HUMAN_REVIEW");
    expect(outcome.downgraded).toBe(true);
    expect(outcome.violations.map((v) => v.code)).toContain("BLOCKING_CONDITION");
    expect(outcome.decision.riskExplanation).toMatch(/remit wallet/i);
  });

  it("2. PAY_NOW (AUTO_PAY) + wallet mismatch → REJECT", () => {
    const outcome = validateDecision(response("AUTO_PAY", walletMismatch), walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
    expect(outcome.from).toBe("AUTO_PAY");
    expect(outcome.decision.recommendedDate).toBeNull();
  });

  it("3. SCHEDULE — the route to human approval — + wallet mismatch → REJECT", () => {
    // SCHEDULE above the threshold is what becomes AWAITING_APPROVAL, so this
    // is the path by which a mismatch could otherwise reach an approver.
    const outcome = validateDecision(response("SCHEDULE", walletMismatch), walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
    expect(outcome.from).toBe("SCHEDULE");
  });

  it("holds even when the model output is unparseable", () => {
    const outcome = validateDecision("not json at all", walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
  });

  it("holds at maximum model confidence", () => {
    const raw = JSON.parse(response("AUTO_PAY", walletMismatch));
    raw.confidence = 1;
    const outcome = validateDecision(JSON.stringify(raw), walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
  });
});

describe("the boundary does not fire on a clean invoice", () => {
  it("4. PAY_NOW + approved supplier + matching wallet + within authority → PAY_NOW", () => {
    expect(blockingConditions(cleanInvoice)).toEqual([]);
    expect(cleanInvoice.supplierFacts.walletMatch).toBe(true);
    expect(cleanInvoice.supplierFacts.registryStatus).toBe("APPROVED");

    const outcome = validateDecision(response("AUTO_PAY", cleanInvoice), cleanInvoice);
    expect(outcome.decision.action).toBe("AUTO_PAY");
    expect(outcome.downgraded).toBe(false);
    expect(outcome.violations).toEqual([]);
    expect(outcome.decision.recommendedDate).toBe(cleanInvoice.asOfDate);
  });

  it("leaves SCHEDULE and HUMAN_REVIEW untouched on a clean invoice", () => {
    for (const action of ["SCHEDULE", "HUMAN_REVIEW"] as TreasuryAction[]) {
      const outcome = validateDecision(response(action, cleanInvoice), cleanInvoice);
      expect(outcome.decision.action, action).toBe(action);
      expect(outcome.downgraded, action).toBe(false);
    }
  });
});

describe("the other blocking conditions", () => {
  it("6. an already-paid invoice remains REJECT", () => {
    expect(duplicate.validationFacts.isDuplicate).toBe(true);
    for (const action of ["AUTO_PAY", "SCHEDULE", "HUMAN_REVIEW"] as TreasuryAction[]) {
      expect(
        validateDecision(response(action, duplicate), duplicate).decision.action,
        action,
      ).toBe("REJECT");
    }
  });

  it("7. a supplier that is not approved remains REJECT", () => {
    expect(unknownSupplier.supplierFacts.supplierFound).toBe(false);
    for (const action of ["AUTO_PAY", "SCHEDULE", "HUMAN_REVIEW"] as TreasuryAction[]) {
      expect(
        validateDecision(response(action, unknownSupplier), unknownSupplier).decision.action,
        action,
      ).toBe("REJECT");
    }
  });

  it("does not report a downgrade when the model already said REJECT", () => {
    const outcome = validateDecision(response("REJECT", walletMismatch), walletMismatch);
    expect(outcome.decision.action).toBe("REJECT");
    expect(outcome.downgraded).toBe(false);
  });
});

describe("the boundary is one definition, not two", () => {
  it("5. an LLM failure still uses the deterministic fallback, and it agrees", async () => {
    // The fallback decides from the same blockingConditions the guard enforces,
    // so an outage cannot change the verdict on a blocked invoice.
    expect(decideDeterministically(walletMismatch).action).toBe("REJECT");
    expect(decideDeterministically(duplicate).action).toBe("REJECT");
    expect(decideDeterministically(unknownSupplier).action).toBe("REJECT");
    expect(decideDeterministically(cleanInvoice).action).toBe("AUTO_PAY");

    // End to end on the path production actually takes when the model cannot
    // be reached: llmEngine and selectDecisionEngine both fall back to this.
    const scenario = scenarioById("s5_wallet_mismatch");
    const run = await runScenario(scenario, createDeterministicEngine("transport failed"));
    expect(run.decision.decision.action).toBe("REJECT");
    expect(run.paymentRequest).toBeNull();
    expect(run.finalOutcome).toBe("REJECTED");

    // And the escalate-to-a-human fallback does not soften it either.
    const escalating = await runScenario(scenario, createFallbackEngine("model unusable"));
    expect(escalating.decision.decision.action).toBe("REJECT");
    expect(escalating.paymentRequest).toBeNull();

    // On a clean invoice that same engine still escalates rather than deciding.
    const openInvoice = await runScenario(
      scenarioById("s3_discount"),
      createFallbackEngine("model unusable"),
    );
    expect(openInvoice.decision.decision.action).toBe("HUMAN_REVIEW");
  });

  it("never lets a blocked invoice produce a payment request", async () => {
    // Model output insisting on payment today, at full confidence, replayed
    // through the real recorded-engine path so the guard genuinely runs.
    for (const [id, analysis] of [
      ["s5_wallet_mismatch", walletMismatch],
      ["s6_duplicate", duplicate],
      ["s4_new_supplier", unknownSupplier],
    ] as const) {
      const engine = createRecordedEngine(
        [
          {
            scenarioId: id,
            modelId: "test-insistent",
            recordedAt: `${analysis.asOfDate}T09:00:00.000Z`,
            raw: response("AUTO_PAY", analysis),
          },
        ],
        { keyFor: () => id },
      );

      const run = await runScenario(scenarioById(id), engine);
      expect(run.decision.guard.from, id).toBe("AUTO_PAY");
      expect(run.decision.decision.action, id).toBe("REJECT");
      expect(run.paymentRequest, id).toBeNull();
      expect(run.enforcement, id).toBeNull();
    }
  });
});
