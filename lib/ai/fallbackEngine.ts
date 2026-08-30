/**
 * The non-AI path, used when Workers AI is unavailable or its output cannot be
 * validated.
 *
 * It is structurally incapable of returning AUTO_PAY or SCHEDULE: an
 * unreachable model can never cause a payment to be made. It escalates to a
 * human, and it says plainly that no AI reasoning took place — the demo must
 * never pass this off as an AI decision.
 *
 * The one thing it does not do is escalate a BLOCKED invoice. A redirected
 * remit wallet is not a judgement call a person should be handed as though it
 * were open; it is refused here exactly as the guard and the deterministic
 * engine refuse it. An outage may cost the AI its say — it may not soften a
 * deterministic refusal into a question.
 */

import type { DecisionResult, DeterministicAnalysis, TreasuryDecisionEngine } from "../types";
import { blockingConditions } from "./blockingConditions";

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
      reasons: [FALLBACK_NOTICE],
      riskExplanation:
        "No risk assessment was produced: assessing risk requires the AI engine, which did not return a usable decision.",
      cashFlowExplanation:
        "No timing recommendation was produced. The deterministic cash-flow projections are still available for a human reviewer.",
      whyNotTodayExplanation: "",
      decisionExplanation:
        "Routed to human review because the AI decision engine was unavailable. This is a safety default, not an assessment of this invoice.",
    },
    engine: "FALLBACK",
    rawModelOutput: null,
    modelId: null,
    engineFailure: reason.summary,
    guard: { downgraded: false, from: null, violations: [] },
    latencyMs,
  };
}

export function createFallbackEngine(reasonSummary: string): TreasuryDecisionEngine {
  return {
    id: "fallback",
    decide(analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult> {
      const blocking = blockingConditions(analysis);
      if (blocking.length > 0) {
        return Promise.resolve(blockedDecision(blocking, reasonSummary));
      }
      return Promise.resolve(fallbackDecision({ summary: reasonSummary }, 0));
    },
  };
}

/** A refusal the missing model had no part in, and could not have changed. */
function blockedDecision(blocking: string[], reasonSummary: string): DecisionResult {
  const detail = blocking.join(" ");
  return {
    decision: {
      action: "REJECT",
      recommendedDate: null,
      risk: "CRITICAL",
      urgency: "MEDIUM",
      confidence: 0,
      reasons: blocking,
      riskExplanation: detail,
      cashFlowExplanation: "Timing is not what decides this invoice.",
      whyNotTodayExplanation: "",
      decisionExplanation:
        `Refused on a deterministic safety check, which needs no AI reasoning. ${detail}`.trim(),
    },
    engine: "FALLBACK",
    rawModelOutput: null,
    modelId: null,
    engineFailure: reasonSummary,
    guard: {
      downgraded: false,
      from: null,
      violations: [{ code: "BLOCKING_CONDITION", detail }],
    },
    latencyMs: 0,
  };
}
