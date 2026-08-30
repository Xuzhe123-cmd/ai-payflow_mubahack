/**
 * The JSON schema the model must fill in.
 *
 * Deliberately FLAT — Cloudflare documents that Workers AI cannot guarantee
 * compliance and that complex schemas make non-compliance more likely, so
 * nesting is avoided even where it would read more naturally.
 */

import type { Level, TreasuryAction } from "../types";

export const TREASURY_ACTIONS: readonly TreasuryAction[] = [
  "AUTO_PAY",
  "SCHEDULE",
  "HUMAN_REVIEW",
  "REJECT",
] as const;

export const LEVELS: readonly Level[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/** Below this the guard downgrades to HUMAN_REVIEW. */
export const MIN_CONFIDENCE = 0.5;

export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...TREASURY_ACTIONS],
      description:
        "AUTO_PAY to pay today, SCHEDULE to pay on a later candidate date, HUMAN_REVIEW to escalate, REJECT to refuse.",
    },
    recommendedDate: {
      type: "string",
      description:
        "The chosen payment date as YYYY-MM-DD. Must be one of the listed candidate dates. Use an empty string for HUMAN_REVIEW or REJECT.",
    },
    risk: {
      type: "string",
      enum: [...LEVELS],
      description: "How suspicious or unsafe this payment is. Not affected by the due date.",
    },
    urgency: {
      type: "string",
      enum: [...LEVELS],
      description: "How soon the payment needs to happen. Not affected by how suspicious it is.",
    },
    confidence: {
      type: "number",
      description: "Your confidence in this decision, between 0 and 1.",
    },
    reasons: {
      type: "array",
      items: { type: "string" },
      description: "Three to six short bullet reasons citing the given facts.",
    },
    riskExplanation: {
      type: "string",
      description: "Why you assigned that risk level.",
    },
    cashFlowExplanation: {
      type: "string",
      description: "How the candidate-date projections informed the timing.",
    },
    whyNotToday: {
      type: "string",
      description:
        "If you chose a date later than today, say what paying today would have cost, quoting the projected minimum cash for today and for your chosen date. Empty string if you are paying today or recommending no payment.",
    },
    decisionExplanation: {
      type: "string",
      description: "Why this action, in two or three sentences.",
    },
  },
  required: [
    "action",
    "recommendedDate",
    "risk",
    "urgency",
    "confidence",
    "reasons",
    "riskExplanation",
    "cashFlowExplanation",
    "whyNotToday",
    "decisionExplanation",
  ],
} as const;
