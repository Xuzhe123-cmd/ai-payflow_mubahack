/**
 * The non-AI path, used when Workers AI is unavailable or its output cannot be
 * validated.
 *
 * It is structurally incapable of returning AUTO_PAY or SCHEDULE: an
 * unreachable model can never cause a payment to be made. It always escalates
 * to a human, and it says plainly that no AI reasoning took place — the demo
 * must never pass this off as an AI decision.
 */

import type { DecisionResult, DeterministicAnalysis, TreasuryDecisionEngine } from "../types";

export const FALLBACK_NOTICE =
  "AI decision engine unavailable — no automated reasoning was performed on this invoice.";

export interface FallbackReason {
  summary: string;
}

export function fallbackDecision(
  reason: FallbackReason,
  latencyMs: number,
): DecisionResult {
  return {
    decision: {
      action: "HUMAN_REVIEW",
      recommendedDate: null,
      risk: "MEDIUM",
      urgency: "MEDIUM",
      confidence: 0,
      reasons: [FALLBACK_NOTICE, reason.summary],
      riskExplanation:
        "No risk assessment was produced: assessing risk requires the AI engine, which did not return a usable decision.",
      cashFlowExplanation:
        "No timing recommendation was produced. The deterministic cash-flow projections are still available for a human reviewer.",
      decisionExplanation:
        "Routed to human review because the AI decision engine was unavailable. This is a safety default, not an assessment of this invoice.",
    },
    engine: "FALLBACK",
    rawModelOutput: null,
    modelId: null,
    guard: { downgraded: false, from: null, violations: [] },
    latencyMs,
  };
}

export function createFallbackEngine(reasonSummary: string): TreasuryDecisionEngine {
  return {
    id: "fallback",
    decide(_analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult> {
      void _analysis;
      return Promise.resolve(fallbackDecision({ summary: reasonSummary }, 0));
    },
  };
}
