/**
 * The one pipeline every invoice goes through.
 *
 * All eight demo scenarios run this exact function — the scenario only changes
 * the input data. There is no per-scenario branch anywhere below.
 *
 *   deterministic facts -> AI decision -> recommendation -> Sui enforcement
 *   "what is true?"        "what to do?"   "what should?"    "what can?"
 *
 * The recommendation is a deliberate step rather than a rename. It is the AI's
 * advisory output, and it is always produced — including for REJECT. Only
 * AUTO_PAY and SCHEDULE go on to become a PaymentRequest, which is the only
 * artifact the chain ever judges.
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
import { buildPaymentRecommendation } from "./ai/recommendation";
import { authorityFor, limitsFor } from "./sui/limits";
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
  /**
   * Judge the payment under the agent's own capability even when policy would
   * route it to a human approver. Used by the security demonstration and by the
   * invariant tests to submit a payment the agent is not allowed to make.
   *
   * Only ever MORE restrictive. There is no flag in the other direction.
   */
  forceAgentAuthority?: boolean;
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

  // ---- Recommendation layer ------------------------------------------------
  // Advisory. Always produced, never permission to move funds.
  const recommendation = buildPaymentRecommendation(decision.decision, analysis, clock());

  // ---- Sui / Move layer ----------------------------------------------------
  const paymentRequest = buildPaymentRequest(
    recommendation,
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
    // Which authority this payment runs under is decided by the treasury's own
    // policy and the amount — never by the request, and never by the AI.
    const authority = authorityFor(
      paymentRequest.amountCents,
      decision.decision.action,
      input.world.policy,
      input.forceAgentAuthority,
    );
    const limits = limitsFor(authority, input.world.capability, input.world.approver);

    enforcement = enforcePolicy({
      request: paymentRequest,
      limits,
      policy: input.world.policy,
      treasury: input.world.treasury,
      suppliers: input.world.suppliers,
      paymentHistory: input.world.paymentHistory,
      nowMs: clock(),
    });

    if (enforcement.outcome === "SUI_REJECT") {
      finalOutcome = "SUI_REJECT";
    } else if (authority === "HUMAN_APPROVAL") {
      // Every check passes, but the agent's capability alone cannot authorize
      // this size of payment. A person has to sign before it can execute.
      finalOutcome = "AWAITING_APPROVAL";
    } else {
      finalOutcome = decision.decision.action === "AUTO_PAY" ? "EXECUTED" : "SCHEDULED";
    }

    const amount = formatMoneyRounded(paymentRequest.amountCents, paymentRequest.currency);
    emit(
      "policy_enforce",
      "Sui policy enforcement",
      enforcement.outcome !== "APPROVED"
        ? `REJECTED on chain — ${enforcement.violations.map((v) => v.code).join(", ")}.`
        : authority === "HUMAN_APPROVAL"
          ? `Checks pass, but ${amount} is above the ${formatMoneyRounded(input.world.policy.humanApprovalThresholdCents, paymentRequest.currency)} threshold — a human approval is required before execution.`
          : `Approved — payment of ${amount} on ${paymentRequest.requestedDate}.`,
    );
  }

  return {
    scenarioId: input.scenarioId,
    asOfDate: input.asOf,
    analysis,
    decision,
    recommendation,
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
