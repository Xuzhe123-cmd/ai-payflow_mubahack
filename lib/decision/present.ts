/**
 * Turning a PaymentDecision into what the interface shows.
 *
 * All of it is pure and lives here rather than in components, for the same
 * reason the arithmetic lives in the deterministic layer: a number computed in
 * a component is a number nothing can test, and a second implementation of a
 * rule is a rule that can disagree with itself.
 *
 * The central job is separating two things a viewer will otherwise conflate:
 *
 *   "financially safe to pay"        — the treasury can afford it
 *   "authorized for autonomous pay"  — the AGENT may do it without a human
 *
 * An $8,000 invoice against a $97,000 treasury is comfortably the first and
 * emphatically not the second. Showing one verdict would make the refusal look
 * like a liquidity problem, which is the opposite of the point.
 */

import type { Cents, IsoDate } from "../types";
import type { ChainCashFlowEvent, ChainSnapshot } from "../sui/chainTypes";
import { forecastCash } from "../deterministic/forecast";
import { formatMoneyRounded } from "../util/money";
import type { DecisionAction, PaymentDecision } from "./types";

export type VerdictState = "PASS" | "WARN" | "FAIL";

export interface Verdict {
  /** Short label for the chip, e.g. "SAFE", "EXCEEDED". */
  state: VerdictState;
  headline: string;
  detail: string;
}

export interface DecisionVerdicts {
  /** Can the treasury afford it? Nothing to do with who may authorize it. */
  cashFlow: Verdict;
  /** May the AGENT do this alone? Nothing to do with affordability. */
  authority: Verdict;
  supplier: Verdict;
  invoice: Verdict;
  finalAction: {
    action: DecisionAction;
    label: string;
    tone: "positive" | "chain" | "warning" | "negative";
    /** One line a judge can read in under five seconds. */
    because: string;
    /**
     * The point of the whole demo, stated in plain words — set only when the
     * verdict turns on something a viewer is likely to misread. "Affordable but
     * not authorized" is the case that matters: without saying it outright,
     * HUMAN APPROVAL on a $97,000 treasury reads as a cash problem.
     */
    keyInsight: string | null;
  };
}

const money = (cents: Cents) => formatMoneyRounded(cents);

export const ACTION_LABEL: Record<DecisionAction, string> = {
  PAY_NOW: "PAY NOW",
  SCHEDULE: "SCHEDULE",
  HUMAN_APPROVAL: "HUMAN APPROVAL",
  REJECT: "REJECT",
};

export const ACTION_TONE: Record<DecisionAction, DecisionVerdicts["finalAction"]["tone"]> = {
  PAY_NOW: "positive",
  SCHEDULE: "chain",
  HUMAN_APPROVAL: "warning",
  REJECT: "negative",
};

export function buildVerdicts(decision: PaymentDecision): DecisionVerdicts {
  const { facts } = decision;
  const today = facts.cashFlow.today;
  const chosen =
    facts.cashFlow.candidates.find((option) => option.date === decision.recommendedPaymentDate) ??
    today;

  // --- can the treasury afford it -------------------------------------------
  //
  // Judged on the RECOMMENDED date, not today, because "we can afford this on
  // the 12th" is the honest answer when the recommendation is to wait.
  const noDateWorks = facts.cashFlow.earliestSafeDate === null;
  const cashFlow: Verdict = noDateWorks
    ? {
        state: "FAIL",
        headline: "UNAFFORDABLE",
        detail: `No date leaves the vault above its ${money(facts.cashFlow.minimumReserveCents)} reserve.`,
      }
    : today.breachesReserveImmediately
      ? {
          state: "WARN",
          headline: "TIGHT TODAY",
          detail:
            `Paying today leaves ${money(today.balanceAfterPaymentCents)}, below the ` +
            `${money(facts.cashFlow.minimumReserveCents)} reserve. ${facts.cashFlow.earliestSafeDate} clears it.`,
        }
      : {
          state: "PASS",
          headline: "SAFE",
          detail:
            `${money(chosen.balanceAfterPaymentCents)} remains after payment, above the ` +
            `${money(facts.cashFlow.minimumReserveCents)} reserve.`,
        };

  // --- may the agent do it alone --------------------------------------------
  const authority: Verdict = facts.authority.withinAutonomousAuthority
    ? {
        state: "PASS",
        headline: "WITHIN LIMIT",
        detail:
          `${money(facts.amountCents)} is inside the agent's ${money(facts.authority.maxSinglePaymentCents)} ` +
          `per-payment cap, with ${money(facts.authority.remainingTodayCents)} left of today's limit.`,
      }
    : {
        state: "FAIL",
        headline: authorityHeadline(facts.authority.status),
        detail: authorityDetail(decision),
      };

  // --- is the counterparty who they claim to be -----------------------------
  const supplierOk = facts.supplier.found && facts.supplier.approved && facts.supplier.walletMatches;
  const supplier: Verdict = supplierOk
    ? {
        state: "PASS",
        headline: "VERIFIED",
        detail: `${facts.supplier.supplierId} is approved and the remit address matches the registry.`,
      }
    : {
        state: "FAIL",
        headline: "FAILED",
        detail: !facts.supplier.found
          ? `${facts.supplier.supplierId} is not in the on-chain registry.`
          : !facts.supplier.approved
            ? `${facts.supplier.supplierId} is in the registry but not approved.`
            : `The remit address does not match the one registered for ${facts.supplier.supplierId}.`,
      };

  const invoice: Verdict = facts.alreadyPaid
    ? { state: "FAIL", headline: "PAID", detail: `${facts.invoiceNumber} has already been settled on chain.` }
    : facts.risks.some((risk) => risk.code === "INVOICE_NOT_PAYABLE")
      ? { state: "FAIL", headline: "NOT PAYABLE", detail: `${facts.invoiceNumber} is not in a payable state.` }
      : {
          state: "PASS",
          headline: "OPEN",
          detail: facts.isOverdue
            ? `Due ${facts.dueDate} — ${Math.abs(facts.daysUntilDue)} day(s) overdue.`
            : `Due ${facts.dueDate}, in ${facts.daysUntilDue} day(s).`,
        };

  return {
    cashFlow,
    authority,
    supplier,
    invoice,
    finalAction: {
      action: decision.decision,
      label: ACTION_LABEL[decision.decision],
      tone: ACTION_TONE[decision.decision],
      because: becauseLine(decision, { cashFlow, authority, supplier, invoice }),
      keyInsight: keyInsightFor(decision, { cashFlow, authority, supplier, invoice }),
    },
  };
}

/**
 * Said outright, because the alternative is a viewer drawing the wrong
 * conclusion from a correct screen.
 */
function keyInsightFor(
  decision: PaymentDecision,
  verdicts: Omit<DecisionVerdicts, "finalAction">,
): string | null {
  if (
    decision.decision === "HUMAN_APPROVAL" &&
    verdicts.cashFlow.state === "PASS" &&
    verdicts.supplier.state === "PASS"
  ) {
    return "The company can afford it. The AI agent is not authorized to pay it autonomously.";
  }
  if (decision.decision === "REJECT" && verdicts.supplier.state === "FAIL") {
    return "The money is available and the amount is irrelevant — the counterparty does not check out.";
  }
  if (decision.decision === "REJECT" && verdicts.invoice.headline === "PAID") {
    return "Already settled on chain. Paying again would be a duplicate the chain would refuse.";
  }
  if (decision.decision === "PAY_NOW") {
    return "Inside the agent's authority and above the reserve — no human needed.";
  }
  return null;
}

function authorityHeadline(status: PaymentDecision["authorityStatus"]): string {
  switch (status) {
    case "EXCEEDS_SINGLE_LIMIT":
      return "EXCEEDED";
    case "EXCEEDS_DAILY_LIMIT":
      return "DAILY LIMIT";
    case "REQUIRES_HUMAN_APPROVAL":
      return "OVER THRESHOLD";
    case "AGENT_DISABLED":
      return "AGENT DISABLED";
    case "AGENT_NOT_REGISTERED":
      return "NO AGENT";
    case "WITHIN_AUTONOMOUS":
      return "WITHIN LIMIT";
  }
}

function authorityDetail(decision: PaymentDecision): string {
  const a = decision.facts.authority;
  switch (a.status) {
    case "EXCEEDS_SINGLE_LIMIT":
      return `${money(a.amountCents)} is above the agent's ${money(a.maxSinglePaymentCents)} per-payment cap.`;
    case "EXCEEDS_DAILY_LIMIT":
      return `Only ${money(a.remainingTodayCents)} of today's ${money(a.dailyLimitCents)} limit remains.`;
    case "REQUIRES_HUMAN_APPROVAL":
      return `${money(a.amountCents)} is above the ${money(a.humanApprovalThresholdCents)} approval threshold.`;
    case "AGENT_DISABLED":
      return "The agent capability has been disabled by the treasury owner.";
    case "AGENT_NOT_REGISTERED":
      return "No agent is registered on this treasury.";
    case "WITHIN_AUTONOMOUS":
      return "";
  }
}

/**
 * The single sentence that has to land. It names the binding constraint, not
 * a summary — "cash-flow is fine, authority is not" is the whole story for an
 * $8,000 invoice and is exactly what a viewer would otherwise get wrong.
 */
function becauseLine(
  decision: PaymentDecision,
  verdicts: Omit<DecisionVerdicts, "finalAction">,
): string {
  const blocking = decision.risks.filter((risk) => risk.blocking);
  if (blocking.length > 0) return blocking[0].detail;

  if (decision.decision === "HUMAN_APPROVAL") {
    return `Cash-flow is ${verdicts.cashFlow.headline.toLowerCase()}, but ${verdicts.authority.detail.toLowerCase()}`;
  }
  if (decision.decision === "SCHEDULE") {
    return verdicts.cashFlow.detail;
  }
  return `Within authority and the reserve holds — the agent can settle this without a person.`;
}

// --- queue summary --------------------------------------------------------------

export interface QueueSummary {
  total: number;
  byAction: Record<DecisionAction, number>;
  /** Total value the agent could settle with no human involvement. */
  autonomousValueCents: Cents;
  needsHumanValueCents: Cents;
  blockedValueCents: Cents;
}

/**
 * Which invoice the board should open on.
 *
 * The demo starts from the autonomous case — it establishes that the agent CAN
 * pay before showing what it cannot. Opening on whichever invoice happens to
 * sort first leads with a refusal, which frames the product as an obstacle
 * rather than a treasury that works.
 */
export function defaultSelection(decisions: readonly PaymentDecision[]): string | null {
  const preference: DecisionAction[] = ["PAY_NOW", "SCHEDULE", "HUMAN_APPROVAL", "REJECT"];
  for (const action of preference) {
    const match = decisions.find((decision) => decision.decision === action);
    if (match) return match.facts.invoiceObjectId;
  }
  return decisions[0]?.facts.invoiceObjectId ?? null;
}

export function summariseQueue(decisions: readonly PaymentDecision[]): QueueSummary {
  const byAction: Record<DecisionAction, number> = {
    PAY_NOW: 0,
    SCHEDULE: 0,
    HUMAN_APPROVAL: 0,
    REJECT: 0,
  };
  let autonomousValueCents = 0;
  let needsHumanValueCents = 0;
  let blockedValueCents = 0;

  for (const decision of decisions) {
    byAction[decision.decision] += 1;
    const amount = decision.facts.amountCents;
    if (decision.decision === "PAY_NOW" || decision.decision === "SCHEDULE") {
      autonomousValueCents += amount;
    } else if (decision.decision === "HUMAN_APPROVAL") {
      needsHumanValueCents += amount;
    } else {
      blockedValueCents += amount;
    }
  }

  return {
    total: decisions.length,
    byAction,
    autonomousValueCents,
    needsHumanValueCents,
    blockedValueCents,
  };
}

// --- cash-flow timeline ----------------------------------------------------------

export interface TimelinePoint {
  date: IsoDate;
  /** End-of-day balance, which is what a cash-flow chart means by "balance". */
  balanceCents: Cents;
  inflowCents: Cents;
  outflowCents: Cents;
  isPaymentDate: boolean;
}

export interface Timeline {
  points: TimelinePoint[];
  reserveCents: Cents;
  /** Axis bounds, computed here so the chart component does no arithmetic. */
  minCents: Cents;
  maxCents: Cents;
  events: ChainCashFlowEvent[];
  /**
   * The conservative post-payment balance from the decision engine — opening
   * balance minus same-day outflows, EXCLUDING same-day inflows. The line
   * above is end-of-day and will sit higher on a day money also arrives; this
   * is the figure the chain actually checks, so it is labelled separately
   * rather than read off the chart.
   */
  balanceAfterPaymentCents: Cents | null;
  paymentDate: IsoDate | null;
  paymentAmountCents: Cents | null;
}

export interface TimelineOptions {
  asOf: IsoDate;
  horizonDays?: number;
  payment?: { date: IsoDate; amountCents: Cents } | null;
  /** From the decision, so the chart never recomputes it. */
  balanceAfterPaymentCents?: Cents | null;
}

const DEFAULT_HORIZON_DAYS = 21;

export function buildTimeline(snapshot: ChainSnapshot, options: TimelineOptions): Timeline {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const payment = options.payment ?? null;

  const forecast = forecastCash({
    asOf: options.asOf,
    horizonDays,
    openingCashCents: snapshot.treasury.balanceCents,
    minimumReserveCents: snapshot.treasury.minimumReserveCents,
    events: snapshot.cashFlowEvents.map((event, index) => ({
      id: `chain_${index}`,
      date: event.date,
      direction: event.direction,
      amountCents: event.amountCents,
      description: event.description,
    })),
    payment,
  });

  const points: TimelinePoint[] = forecast.days.map((day) => ({
    date: day.date,
    balanceCents: day.closingCents,
    inflowCents: day.inflowCents,
    outflowCents: day.outflowCents,
    isPaymentDate: payment !== null && day.date === payment.date,
  }));

  const balances = points.map((point) => point.balanceCents);
  const reserveCents = snapshot.treasury.minimumReserveCents;
  // Always include the reserve line in the range, or a healthy treasury draws a
  // chart the reserve never appears on.
  const rawMin = Math.min(reserveCents, ...balances);
  const rawMax = Math.max(reserveCents, ...balances);
  const pad = Math.max(1, Math.round((rawMax - rawMin) * 0.12));

  const horizonEnd = points.at(-1)?.date ?? options.asOf;

  return {
    points,
    reserveCents,
    minCents: Math.max(0, rawMin - pad),
    maxCents: rawMax + pad,
    events: snapshot.cashFlowEvents.filter(
      (event) => event.date >= options.asOf && event.date <= horizonEnd,
    ),
    balanceAfterPaymentCents: options.balanceAfterPaymentCents ?? null,
    paymentDate: payment?.date ?? null,
    paymentAmountCents: payment?.amountCents ?? null,
  };
}
