/**
 * The one pipeline every invoice goes through.
 *
 * All eight demo scenarios run this exact function — the scenario only changes
 * the input data. There is no per-scenario branch anywhere below.
 *
 *   deterministic facts  ->  AI decision  ->  Sui policy enforcement
 *   "what is true?"          "what to do?"    "are we allowed to?"
 */

import type {
  DecisionResult,
  DeterministicAnalysis,
  FinalOutcome,
  IsoDate,
  PipelineRun,
  PipelineStep,
  PipelineStepName,
  RawInvoiceDocument,
  TreasuryDecisionEngine,
  WorldSnapshot,
} from "./types";
import { buildAnalysis } from "./deterministic/buildAnalysis";
import { buildPaymentRequest } from "./sui/paymentRequest";
import { enforcePolicy } from "./sui/policyGuard";
import type { SuiPolicyReader } from "./sui/policyReader";
import { formatMoneyRounded } from "./util/money";

export interface PipelineInput {
  scenarioId: string;
  document: RawInvoiceDocument;
  world: WorldSnapshot;
  asOf: IsoDate;
  engine: TreasuryDecisionEngine;
  policyReader?: SuiPolicyReader;
}

export interface PipelineOptions {
  onStep?: (step: PipelineStep) => void;
}

/** Injectable so tests stay deterministic; step timings are display-only. */
type Clock = () => number;

export async function runPipeline(
  input: PipelineInput,
  options: PipelineOptions = {},
  clock: Clock = () => Date.now(),
): Promise<PipelineRun> {
  const steps: PipelineStep[] = [];
  let lastMark = clock();

  const emit = (name: PipelineStepName, label: string, detail: string) => {
    const now = clock();
    const step: PipelineStep = { name, label, detail, durationMs: now - lastMark };
    lastMark = now;
    steps.push(step);
    options.onStep?.(step);
  };

  // ---- Deterministic layer -------------------------------------------------
  const analysis = await buildAnalysis({
    document: input.document,
    world: input.world,
    asOf: input.asOf,
    policyReader: input.policyReader,
  });

  emitAnalysisSteps(analysis, emit);

  // ---- AI layer ------------------------------------------------------------
  const decision: DecisionResult = await input.engine.decide(analysis);
  emit(
    "ai_decision",
    "AI decision",
    describeDecision(decision),
  );

  // ---- Sui / Move layer ----------------------------------------------------
  const paymentRequest = buildPaymentRequest(
    decision.decision,
    analysis,
    input.world.capability.agentId,
  );

  let enforcement = null as PipelineRun["enforcement"];
  let finalOutcome: FinalOutcome;

  if (paymentRequest === null) {
    finalOutcome = decision.decision.action === "REJECT" ? "REJECTED" : "HUMAN_REVIEW";
    emit(
      "policy_enforce",
      "Sui policy enforcement",
      `Not submitted — the AI chose ${decision.decision.action}, which never creates a payment request.`,
    );
  } else {
    enforcement = enforcePolicy({
      request: paymentRequest,
      capability: input.world.capability,
      policy: input.world.policy,
      treasury: input.world.treasury,
      suppliers: input.world.suppliers,
      paymentHistory: input.world.paymentHistory,
    });

    if (enforcement.outcome === "SUI_REJECT") {
      finalOutcome = "SUI_REJECT";
    } else {
      finalOutcome = decision.decision.action === "AUTO_PAY" ? "EXECUTED" : "SCHEDULED";
    }

    emit(
      "policy_enforce",
      "Sui policy enforcement",
      enforcement.outcome === "APPROVED"
        ? `Approved — payment of ${formatMoneyRounded(paymentRequest.amountCents, paymentRequest.currency)} on ${paymentRequest.requestedDate}.`
        : `REJECTED on chain — ${enforcement.violations.map((v) => v.code).join(", ")}.`,
    );
  }

  return {
    scenarioId: input.scenarioId,
    asOfDate: input.asOf,
    analysis,
    decision,
    paymentRequest,
    enforcement,
    finalOutcome,
    steps,
  };
}

function emitAnalysisSteps(
  analysis: Readonly<DeterministicAnalysis>,
  emit: (name: PipelineStepName, label: string, detail: string) => void,
): void {
  const { invoiceFacts: inv, supplierFacts: sup, validationFacts: val } = analysis;
  const currency = inv.currency || "USD";

  emit(
    "extract",
    "Invoice extraction",
    `${inv.invoiceNumber || "(no number)"} — ${formatMoneyRounded(inv.amountCents, currency)} due ${inv.dueDate}` +
      (inv.discount ? `, ${inv.discount.percent}% discount until ${inv.discount.deadline}` : ""),
  );

  emit(
    "supplier",
    "Supplier verification",
    sup.supplierFound
      ? `${sup.registryStatus} in registry, wallet ${sup.walletMatch ? "matches" : "DOES NOT match"} the registered address.`
      : `"${inv.supplierName}" is not in the approved supplier registry.`,
  );

  emit(
    "validate",
    "Invoice validation",
    [
      val.isDuplicate ? "already paid" : "no duplicate",
      val.poFound
        ? val.poMatch
          ? "PO matches"
          : `PO differs by ${formatMoneyRounded(Math.abs(val.poDeltaCents ?? 0), currency)}`
        : inv.poNumber
          ? "PO not found"
          : "no PO referenced",
    ].join(", ") + ".",
  );

  const today = analysis.cashFlowScenarios[0];
  emit(
    "forecast",
    "Cash-flow projection",
    `${analysis.cashFlowScenarios.length} candidate date(s) simulated; paying today projects a ` +
      `${formatMoneyRounded(today?.projectedMinimumCashCents ?? 0, currency)} trough` +
      `${today?.reserveBreach ? " — below the minimum reserve." : "."}`,
  );

  emit(
    "policy_read",
    "On-chain policy read",
    `Agent cap ${formatMoneyRounded(analysis.policyFacts.maxSinglePaymentCents, currency)} per payment; ` +
      `this invoice ${analysis.policyFacts.wouldExceedSingleLimit ? "EXCEEDS" : "is within"} it.`,
  );

  emit(
    "analysis",
    "Fact sheet assembled",
    `${analysis.riskEvidence.length} observation(s) flagged; facts frozen and handed to the AI.`,
  );
}

function describeDecision(result: DecisionResult): string {
  const { decision } = result;
  const engineNote =
    result.engine === "FALLBACK" ? " [AI unavailable — safety fallback]" : "";
  const guardNote = result.guard.downgraded
    ? ` [guard downgraded from ${result.guard.from ?? "invalid output"}]`
    : "";
  const date = decision.recommendedDate ? ` on ${decision.recommendedDate}` : "";
  return `${decision.action}${date} — risk ${decision.risk}, urgency ${decision.urgency}, confidence ${decision.confidence}${engineNote}${guardNote}`;
}
