/**
 * The decision schema.
 *
 * Structure of the engine, and the reason it is shaped this way:
 *
 *   deterministic facts  →  deterministic CEILING  →  LLM choice  →  guard
 *
 * Every number below is computed by ordinary TypeScript from the live chain
 * snapshot. The LLM never sees a balance it can alter, never proposes an
 * amount, and never picks a date that was not offered to it. What it
 * contributes is judgement between options the deterministic layer has already
 * declared safe, plus the prose that explains the choice.
 *
 * And none of this is authority. A `PAY_NOW` here is a recommendation; Move
 * re-derives every constraint at execution and is free to refuse it.
 */

import type { Cents, IsoDate } from "../types";
import type { ChainCashFlowEvent } from "../sui/chainTypes";

export type DecisionAction = "PAY_NOW" | "SCHEDULE" | "HUMAN_APPROVAL" | "REJECT";

/**
 * Ordered by how much spending each permits. The guard clamps the LLM's choice
 * to the deterministic ceiling using this order, so a model can always be more
 * cautious than the rules and never less.
 */
export const ACTION_ORDER: readonly DecisionAction[] = [
  "REJECT",
  "HUMAN_APPROVAL",
  "SCHEDULE",
  "PAY_NOW",
] as const;

export function actionRank(action: DecisionAction): number {
  return ACTION_ORDER.indexOf(action);
}

/** The more cautious of two actions. */
export function moreCautious(a: DecisionAction, b: DecisionAction): DecisionAction {
  return actionRank(a) <= actionRank(b) ? a : b;
}

export type AuthorityStatus =
  /** The agent may settle this alone. */
  | "WITHIN_AUTONOMOUS"
  /** Above the treasury's human-approval threshold. */
  | "REQUIRES_HUMAN_APPROVAL"
  /** Above the agent's per-payment ceiling. */
  | "EXCEEDS_SINGLE_LIMIT"
  /** Would take the day's total past the daily limit. */
  | "EXCEEDS_DAILY_LIMIT"
  | "AGENT_DISABLED"
  | "AGENT_NOT_REGISTERED";

export type RiskCode =
  | "SUPPLIER_NOT_IN_REGISTRY"
  | "SUPPLIER_NOT_APPROVED"
  | "RECIPIENT_WALLET_MISMATCH"
  | "CURRENCY_NOT_ALLOWED"
  | "INVOICE_ALREADY_PAID"
  | "INVOICE_NOT_PAYABLE"
  | "INSUFFICIENT_RESERVE_TODAY"
  | "NO_SAFE_PAYMENT_DATE"
  | "EXCEEDS_AUTONOMOUS_AUTHORITY"
  | "PROJECTED_RESERVE_BREACH"
  | "OVERDUE"
  | "DUE_IMMINENT";

/**
 * One observed risk.
 *
 * `blocking` is a fact, not a severity rating: it is true exactly when the
 * corresponding Move check would refuse the payment. Grading risks on a scale
 * would be the judgement the LLM is there to make, smuggled into the fact
 * sheet.
 */
export interface RiskFinding {
  code: RiskCode;
  blocking: boolean;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
}

/** One costed payment date. */
export interface PaymentDateOption {
  date: IsoDate;
  daysFromToday: number;
  /**
   * Balance immediately after the transfer. This is what Move check 9 compares
   * against the reserve — the chain does no forecasting.
   */
  balanceAfterPaymentCents: Cents;
  /** True when the chain would refuse on reserve grounds if paid on this date. */
  breachesReserveImmediately: boolean;
  /** Lowest projected balance across the horizon. Advisory, never sent to Move. */
  projectedMinimumCashCents: Cents;
  projectedMinimumCashDate: IsoDate;
  /** Whether the forecast trough dips below the reserve. Advisory. */
  projectedReserveBreach: boolean;
  breachDepthCents: Cents;
  isAfterDueDate: boolean;
  daysBeforeDue: number;
}

export interface CashFlowAnalysis {
  asOf: IsoDate;
  openingBalanceCents: Cents;
  minimumReserveCents: Cents;
  amountCents: Cents;
  /** Always present, always index 0 of `candidates`. */
  today: PaymentDateOption;
  candidates: PaymentDateOption[];
  /** Earliest candidate the chain would actually accept, if any. */
  earliestSafeDate: IsoDate | null;
  upcomingInflows: ChainCashFlowEvent[];
  upcomingOutflows: ChainCashFlowEvent[];
}

export interface AuthorityEvaluation {
  status: AuthorityStatus;
  withinAutonomousAuthority: boolean;
  requiresHumanApproval: boolean;
  amountCents: Cents;
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  spentTodayCents: Cents;
  remainingTodayCents: Cents;
  humanApprovalThresholdCents: Cents;
  /** How much more the agent could still settle alone today. */
  autonomousHeadroomCents: Cents;
}

export interface SupplierEvaluation {
  supplierId: string;
  found: boolean;
  approved: boolean;
  registeredWallet: string | null;
  invoiceRecipient: string;
  walletMatches: boolean;
}

/** Everything the LLM is given. Frozen before it runs. */
export interface DecisionFacts {
  asOf: IsoDate;
  invoiceNumber: string;
  invoiceObjectId: string;
  amountCents: Cents;
  currency: string;
  dueDate: IsoDate;
  daysUntilDue: number;
  isOverdue: boolean;
  alreadyPaid: boolean;
  supplier: SupplierEvaluation;
  authority: AuthorityEvaluation;
  cashFlow: CashFlowAnalysis;
  risks: RiskFinding[];
  /** The most permissive action the rules allow. The LLM may not exceed it. */
  ceiling: DecisionAction;
  /** Dates the LLM is allowed to choose from. Empty when nothing is payable. */
  selectableDates: IsoDate[];
}

export interface DecisionExplanation {
  summary: string;
  cashFlow: string;
  risk: string;
  /** Why not today, when a later date was chosen. Empty otherwise. */
  whyNotToday: string;
}

export type DecisionEngineKind = "LLM" | "DETERMINISTIC";

/**
 * Where the PROSE came from — never where the decision came from.
 *
 * The decision is always deterministic: the ceiling is computed from chain
 * facts and the guard clamps whatever the model said. What varies is only who
 * wrote the sentences, and that has to be stated plainly, because presenting a
 * fallback as an AI answer would be a lie about the one thing this product is
 * demonstrating.
 *
 * `detail` is the technical failure text. It belongs behind a disclosure, not
 * in a panel a judge is reading — an HTTP 429 dump says nothing about the
 * invoice and buries the verdict that does.
 */
export interface ExplanationSource {
  kind: "LLM" | "DETERMINISTIC_FALLBACK" | "DETERMINISTIC";
  /** Short, honest, safe to show, e.g. "Deterministic fallback · AI explanation unavailable". */
  label: string;
  /** One readable sentence about why the model was unavailable, if it was. */
  reason: string | null;
  /** Raw error, for an expandable "Engine details" section only. */
  detail: string | null;
}

/** The engine's output. */
export interface PaymentDecision {
  decision: DecisionAction;
  /** 0..1. INFORMATIONAL — it never widens what is permitted. */
  confidence: number;
  reasons: string[];
  risks: RiskFinding[];
  recommendedPaymentDate: IsoDate | null;
  /** Balance immediately after the payment on the recommended date. */
  projectedBalanceAfterPayment: Cents;
  authorityStatus: AuthorityStatus;
  requiresHumanApproval: boolean;

  // --- provenance -----------------------------------------------------------
  /** What the rules alone would permit, before the model was consulted. */
  deterministicCeiling: DecisionAction;
  /** True when the guard pulled the model back to the ceiling. */
  clampedToCeiling: boolean;
  engine: DecisionEngineKind;
  /** Provenance of the PROSE. The decision itself is always deterministic. */
  explanationSource: ExplanationSource;
  explanation: DecisionExplanation;
  facts: DecisionFacts;
}
