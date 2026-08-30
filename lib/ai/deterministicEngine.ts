/**
 * The decision the rules alone reach, with no model involved.
 *
 * This exists because the old safety fallback escalated EVERY invoice to a
 * human the moment Workers AI was unreachable. That is safe in the narrow sense
 * — nothing gets paid by accident — and useless in every other: a treasury that
 * cannot tell a clean $4,800 invoice from a redirected $19,500 one has stopped
 * doing its job, and the screen stops demonstrating anything.
 *
 * The rule order below is the same one the chain enforces, and the same one
 * lib/decision/engine.ts uses for its ceiling: a blocking fact settles it,
 * otherwise authority decides whether a person is needed, otherwise liquidity
 * decides whether today works.
 *
 * It is still incapable of being reckless. Every action it can return is one
 * the deterministic facts already justify, and Move re-checks all of it anyway.
 */

import type {
  CashFlowScenario,
  DecisionResult,
  DeterministicAnalysis,
  TreasuryAction,
  TreasuryDecision,
  TreasuryDecisionEngine,
} from "../types";
import { formatMoneyRounded } from "../util/money";
import { blockingConditions } from "./blockingConditions";

const money = (cents: number) => formatMoneyRounded(cents);

/** The first candidate date the chain would accept on reserve grounds. */
function firstAcceptable(analysis: Readonly<DeterministicAnalysis>): CashFlowScenario | null {
  return analysis.cashFlowScenarios.find((candidate) => !candidate.reserveBreach) ?? null;
}

export function decideDeterministically(
  analysis: Readonly<DeterministicAnalysis>,
): TreasuryDecision {
  const { policyFacts: pol, invoiceFacts: inv, urgencyFacts: urg } = analysis;
  const blocking = blockingConditions(analysis);
  const today = analysis.cashFlowScenarios[0] ?? null;
  const acceptable = firstAcceptable(analysis);

  if (blocking.length > 0) {
    return build("REJECT", null, blocking, {
      risk: "CRITICAL",
      riskExplanation: blocking.join(" "),
      cashFlowExplanation: "Timing is not what decides this invoice.",
      decisionExplanation: blocking[0],
    });
  }

  // Above the agent's own authority: a person must sign, however healthy the
  // treasury is. This is the case the demo turns on.
  const overSingle = pol.wouldExceedSingleLimit;
  const overDaily = pol.wouldExceedDailyLimit;
  if (overSingle || overDaily) {
    const detail = overSingle
      ? `${money(inv.amountCents)} exceeds the agent's ${money(pol.maxSinglePaymentCents)} autonomous payment limit.`
      : `${money(inv.amountCents)} would take today's spend past the ${money(pol.dailyLimitCents)} daily limit.`;
    return build(
      "HUMAN_REVIEW",
      null,
      [
        "The supplier is approved and the remit address matches the registry.",
        detail,
        "The company can afford the payment; the agent is not authorized to make it alone.",
      ],
      {
        risk: "LOW",
        riskExplanation:
          "Nothing about this invoice is suspicious — the supplier, address and currency all check out.",
        cashFlowExplanation: today
          ? `Paying would leave ${money(today.projectedMinimumCashCents)} at the projected trough, against a ${money(pol.minimumReserveCents)} reserve.`
          : "",
        decisionExplanation: `${detail} Human approval is required before it can settle.`,
      },
    );
  }

  if (acceptable === null) {
    return build(
      "HUMAN_REVIEW",
      null,
      [
        `No candidate date keeps the treasury above its ${money(pol.minimumReserveCents)} minimum reserve.`,
      ],
      {
        risk: "MEDIUM",
        riskExplanation: "The invoice itself is sound; the treasury cannot currently absorb it.",
        cashFlowExplanation: `Every simulated date breaches the ${money(pol.minimumReserveCents)} reserve.`,
        decisionExplanation:
          "Escalated because no payment date clears the minimum reserve, not because of anything about the supplier.",
      },
    );
  }

  const payingToday = today !== null && !today.reserveBreach;
  const action: TreasuryAction = payingToday ? "AUTO_PAY" : "SCHEDULE";
  const chosen = payingToday ? today! : acceptable;

  const reasons = [
    "The supplier is approved and the remit address matches the registry.",
    `${money(inv.amountCents)} is within the agent's ${money(pol.maxSinglePaymentCents)} autonomous limit.`,
    `Paying on ${chosen.paymentDate} leaves a projected ${money(chosen.projectedMinimumCashCents)} trough, above the ${money(pol.minimumReserveCents)} reserve.`,
  ];
  if (inv.discount && chosen.discountCapturedCents > 0) {
    reasons.push(
      `Paying by ${inv.discount.deadline} captures ${money(chosen.discountCapturedCents)} of early-payment discount.`,
    );
  }
  if (urg.isOverdue) reasons.push(`This invoice is ${Math.abs(urg.daysUntilDue)} day(s) overdue.`);

  return build(action, chosen.paymentDate, reasons, {
    risk: "LOW",
    riskExplanation:
      "Approved supplier, matching recipient wallet, permitted currency, and no prior settlement.",
    cashFlowExplanation: `Paying on ${chosen.paymentDate} projects a ${money(chosen.projectedMinimumCashCents)} trough against a ${money(pol.minimumReserveCents)} reserve.`,
    whyNotTodayExplanation:
      payingToday || today === null
        ? ""
        : `Paying today projects a ${money(today.projectedMinimumCashCents)} trough, below the ${money(pol.minimumReserveCents)} reserve. Waiting until ${chosen.paymentDate} leaves ${money(chosen.projectedMinimumCashCents)} instead.`,
    decisionExplanation: payingToday
      ? `Within authority and above the reserve, so the agent can settle this today without a person.`
      : `Within authority, but today breaches the reserve — scheduled for ${chosen.paymentDate}.`,
  });
}

function build(
  action: TreasuryAction,
  recommendedDate: string | null,
  reasons: string[],
  prose: Partial<TreasuryDecision> & { decisionExplanation: string },
): TreasuryDecision {
  return {
    action,
    recommendedDate,
    risk: prose.risk ?? "LOW",
    urgency: prose.urgency ?? "MEDIUM",
    // Deliberately not 1.0. The arithmetic is certain; calling the judgement
    // certain would be claiming more than a rule can know.
    confidence: 0.75,
    reasons: reasons.slice(0, 6),
    riskExplanation: prose.riskExplanation ?? "",
    cashFlowExplanation: prose.cashFlowExplanation ?? "",
    whyNotTodayExplanation: prose.whyNotTodayExplanation ?? "",
    decisionExplanation: prose.decisionExplanation,
  };
}

/**
 * Wraps the rules as an engine, so the pipeline can use it wherever a model
 * would go. `engineFailure` carries why the model was unavailable — it is shown
 * as a label, never as a decision reason.
 */
export function createDeterministicEngine(
  engineFailure: string | null = null,
): TreasuryDecisionEngine {
  return {
    id: "fallback",
    decide(analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult> {
      return Promise.resolve({
        decision: decideDeterministically(analysis),
        engine: "FALLBACK",
        rawModelOutput: null,
        modelId: null,
        engineFailure,
        guard: { downgraded: false, from: null, violations: [] },
        latencyMs: 0,
      });
    },
  };
}
