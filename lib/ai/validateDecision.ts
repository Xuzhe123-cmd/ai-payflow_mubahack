/**
 * Strict validation of model output — the DecisionGuard.
 *
 * This exists because Cloudflare documents that Workers AI cannot guarantee
 * schema compliance. It checks STRUCTURE ONLY: parseable JSON, known enum
 * values, a confidence in range, and a payment date the model was actually
 * offered.
 *
 * It contains no business rules of its own. There is no "unknown supplier means
 * escalate" here — that judgement is the model's, and the tests assert on the
 * model's own pre-guard action to prove it.
 *
 * What it does enforce is the DETERMINISTIC SAFETY BOUNDARY. A blocking
 * condition — an unregistered supplier, a redirected remit wallet, an invoice
 * already settled — is a fact, not an opinion, and the model does not get a
 * vote on it. Those conditions force REJECT no matter what was recommended, so
 * the model can be more cautious than the deterministic answer but can never be
 * less. See ./blockingConditions, which is also what the fallback engine
 * decides on, so the two can never disagree.
 *
 * The guard remains strictly monotonic: it only ever restricts. A structural
 * failure lands on HUMAN_REVIEW, a blocking condition lands on REJECT, and
 * neither ever produces an action that moves money.
 */

import type {
  DeterministicAnalysis,
  GuardViolation,
  Level,
  TreasuryAction,
  TreasuryDecision,
} from "../types";
import { LEVELS, MIN_CONFIDENCE, TREASURY_ACTIONS } from "./decisionSchema";
import { blockingConditions } from "./blockingConditions";

const MAX_REASON_LENGTH = 300;
const MAX_EXPLANATION_LENGTH = 1200;
const MAX_REASONS = 8;

export interface ValidationOutcome {
  decision: TreasuryDecision;
  violations: GuardViolation[];
  downgraded: boolean;
  /** The action the model actually chose, before any downgrade. */
  from: TreasuryAction | null;
}

/** Strips control characters and clamps length before anything is displayed. */
function clean(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isAction(value: unknown): value is TreasuryAction {
  return typeof value === "string" && (TREASURY_ACTIONS as readonly string[]).includes(value);
}

function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function escalation(
  violations: GuardViolation[],
  from: TreasuryAction | null,
  partial?: Partial<TreasuryDecision>,
): ValidationOutcome {
  const summary = violations.map((v) => v.detail).join(" ");
  return {
    decision: {
      action: "HUMAN_REVIEW",
      recommendedDate: null,
      risk: partial?.risk ?? "HIGH",
      urgency: partial?.urgency ?? "MEDIUM",
      confidence: partial?.confidence ?? 0,
      reasons: [
        "The AI decision could not be validated, so the invoice was escalated for human review.",
        ...violations.map((v) => `${v.code}: ${v.detail}`),
      ].slice(0, MAX_REASONS),
      riskExplanation:
        partial?.riskExplanation ??
        "Risk could not be established because the model response failed validation.",
      cashFlowExplanation: partial?.cashFlowExplanation ?? "",
      whyNotTodayExplanation: "",
      decisionExplanation: `Escalated to human review by the decision guard. ${summary}`.trim(),
    },
    violations,
    downgraded: true,
    from,
  };
}

/**
 * Forces REJECT over whatever the model asked for.
 *
 * The model's own action is preserved in `from`, because what it recommended
 * for a redirected wallet is exactly the thing worth showing on screen — the
 * guard overruling it is the demonstration, not an embarrassment to hide.
 */
function refuse(reasons: string[], outcome: ValidationOutcome): ValidationOutcome {
  const detail = reasons.join(" ");
  const decision = outcome.decision;
  return {
    decision: {
      ...decision,
      action: "REJECT",
      recommendedDate: null,
      risk: "CRITICAL",
      reasons: reasons.slice(0, MAX_REASONS),
      riskExplanation: detail,
      decisionExplanation:
        `Refused by the decision guard: this invoice fails a deterministic safety check, ` +
        `which no recommendation can override. ${detail}`.trim(),
    },
    violations: [
      ...outcome.violations,
      { code: "BLOCKING_CONDITION", detail },
    ],
    // Only a change of action counts as a downgrade. A model that already said
    // REJECT was right, and reporting it as guard-rescued would misrepresent it.
    downgraded: decision.action !== "REJECT",
    from: outcome.from,
  };
}

export function validateDecision(
  raw: string,
  analysis: Readonly<DeterministicAnalysis>,
): ValidationOutcome {
  const outcome = validateStructure(raw, analysis);

  // Applied to every path, including malformed output: an invoice that must not
  // be paid must not become payable because the model failed to parse either.
  const blocking = blockingConditions(analysis);
  return blocking.length > 0 ? refuse(blocking, outcome) : outcome;
}

function validateStructure(
  raw: string,
  analysis: Readonly<DeterministicAnalysis>,
): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return escalation(
      [{ code: "MALFORMED_JSON", detail: "Model output was not valid JSON." }],
      null,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return escalation(
      [{ code: "SCHEMA_VIOLATION", detail: "Model output was not a JSON object." }],
      null,
    );
  }

  const body = parsed as Record<string, unknown>;
  const violations: GuardViolation[] = [];

  const action = isAction(body.action) ? body.action : null;
  if (!action) {
    violations.push({
      code: "UNKNOWN_ACTION",
      detail: `Action ${JSON.stringify(body.action)} is not one of ${TREASURY_ACTIONS.join(", ")}.`,
    });
  }

  const risk = isLevel(body.risk) ? body.risk : null;
  const urgency = isLevel(body.urgency) ? body.urgency : null;
  if (!risk || !urgency) {
    violations.push({
      code: "UNKNOWN_LEVEL",
      detail: `Risk ${JSON.stringify(body.risk)} / urgency ${JSON.stringify(body.urgency)} must each be one of ${LEVELS.join(", ")}.`,
    });
  }

  // The floor gates automated ACTION, so it applies only to actions that move
  // money. Escalating an already-escalated HUMAN_REVIEW because the model was
  // unsure restricts nothing, and it would throw away the model's reasoning
  // while mislabelling a correct decision as guard-rescued.
  const actsOnFunds = action === "AUTO_PAY" || action === "SCHEDULE";
  const confidence = typeof body.confidence === "number" ? body.confidence : null;
  if (confidence === null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    violations.push({
      code: "CONFIDENCE_OUT_OF_RANGE",
      detail: `Confidence ${JSON.stringify(body.confidence)} must be a number between 0 and 1.`,
    });
  } else if (actsOnFunds && confidence < MIN_CONFIDENCE) {
    violations.push({
      code: "CONFIDENCE_BELOW_FLOOR",
      detail: `Confidence ${confidence} is below the ${MIN_CONFIDENCE} floor required to move funds automatically.`,
    });
  }

  const reasons = Array.isArray(body.reasons)
    ? body.reasons.map((entry) => clean(entry, MAX_REASON_LENGTH)).filter((entry) => entry.length > 0)
    : [];
  if (reasons.length === 0) {
    violations.push({
      code: "EMPTY_REASONS",
      detail: "Model gave no usable reasons for its decision.",
    });
  }

  // Referential integrity: a payment date must be one the model was offered.
  // This is what stops an invented date from ever reaching the chain.
  const candidateDates = analysis.cashFlowScenarios.map((scenario) => scenario.paymentDate);
  const rawDate = clean(body.recommendedDate, 32);
  let recommendedDate: string | null = rawDate.length > 0 ? rawDate : null;

  const needsDate = action === "AUTO_PAY" || action === "SCHEDULE";
  if (needsDate) {
    // AUTO_PAY means "pay today"; an omitted date is unambiguous, so fill it in
    // rather than escalating over a formatting slip.
    if (recommendedDate === null && action === "AUTO_PAY") {
      recommendedDate = analysis.asOfDate;
    }

    if (recommendedDate === null) {
      violations.push({
        code: "MISSING_RECOMMENDED_DATE",
        detail: `Action ${action} requires a payment date but none was given.`,
      });
    } else if (!candidateDates.includes(recommendedDate)) {
      violations.push({
        code: "DATE_NOT_IN_CANDIDATE_SET",
        detail: `Date ${recommendedDate} was not among the candidate dates (${candidateDates.join(", ")}).`,
      });
    } else if (action === "AUTO_PAY" && recommendedDate !== analysis.asOfDate) {
      violations.push({
        code: "DATE_NOT_IN_CANDIDATE_SET",
        detail: `AUTO_PAY means paying today (${analysis.asOfDate}) but the date given was ${recommendedDate}.`,
      });
    }
  } else {
    // HUMAN_REVIEW and REJECT carry no payment date.
    recommendedDate = null;
  }

  const partial: Partial<TreasuryDecision> = {
    risk: risk ?? undefined,
    urgency: urgency ?? undefined,
    confidence: confidence ?? undefined,
    riskExplanation: clean(body.riskExplanation, MAX_EXPLANATION_LENGTH) || undefined,
    cashFlowExplanation: clean(body.cashFlowExplanation, MAX_EXPLANATION_LENGTH) || undefined,
  };

  if (violations.length > 0) {
    return escalation(violations, action, partial);
  }

  return {
    decision: {
      action: action!,
      recommendedDate,
      risk: risk!,
      urgency: urgency!,
      confidence: confidence!,
      reasons: reasons.slice(0, MAX_REASONS),
      riskExplanation: clean(body.riskExplanation, MAX_EXPLANATION_LENGTH),
      cashFlowExplanation: clean(body.cashFlowExplanation, MAX_EXPLANATION_LENGTH),
      // Soft field: absent in recordings made before it existed, and absent
      // whenever the model is recommending payment today. Never a violation.
      whyNotTodayExplanation: clean(body.whyNotToday, MAX_EXPLANATION_LENGTH),
      decisionExplanation: clean(body.decisionExplanation, MAX_EXPLANATION_LENGTH),
    },
    violations: [],
    downgraded: false,
    from: action,
  };
}
