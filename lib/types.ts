/**
 * AI PayFlow — shared domain and pipeline types.
 *
 * Architectural rule encoded here: the deterministic layer produces FACTS
 * (numbers and booleans). It never produces a risk level, an urgency level,
 * a score, or an action. Judgement belongs to the LLM; authority belongs to
 * Sui/Move.
 */

/** Integer minor units (e.g. cents). Never a float — all money math is exact. */
export type Cents = number;

/** Calendar date as "YYYY-MM-DD", always interpreted as UTC. */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Demo world / domain
// ---------------------------------------------------------------------------

/** An invoice as it arrives — semi-structured text, not yet parsed. */
export interface RawInvoiceDocument {
  id: string;
  /** Where it came from: an email id, a Walrus blob id, a fixture name. */
  sourceRef: string;
  receivedAt: IsoDate;
  filename: string;
  /** The raw document body that extraction has to parse. */
  text: string;
}

export type RegistryStatus = "APPROVED" | "PENDING" | "REVOKED" | "NOT_FOUND";

export type BusinessCriticality = "LOW" | "MEDIUM" | "HIGH";

export interface SupplierHistory {
  invoiceCount: number;
  meanAmountCents: Cents;
  maxAmountCents: Cents;
  /** 0..1 */
  onTimePaymentRate: number;
  firstSeen: IsoDate;
}

export interface Supplier {
  id: string;
  name: string;
  /** Alternate spellings that may appear on an invoice. */
  aliases: string[];
  registryStatus: Exclude<RegistryStatus, "NOT_FOUND">;
  registeredWallet: string;
  businessCriticality: BusinessCriticality;
  history: SupplierHistory;
}

export interface PurchaseOrder {
  poNumber: string;
  supplierId: string;
  amountCents: Cents;
  currency: string;
  issuedAt: IsoDate;
  description: string;
}

export interface PaymentRecord {
  paymentId: string;
  invoiceNumber: string;
  supplierId: string;
  amountCents: Cents;
  currency: string;
  paidAt: IsoDate;
  recipientWallet: string;
}

export interface CashFlowEvent {
  id: string;
  date: IsoDate;
  direction: "INFLOW" | "OUTFLOW";
  amountCents: Cents;
  description: string;
}

export interface TreasuryState {
  currentCashCents: Cents;
  currency: string;
}

/** Mirrors the Treasury policy that will live on Sui. */
export interface TreasuryPolicy {
  minimumReserveCents: Cents;
  allowedCurrencies: string[];
  /**
   * Above this, a payment needs a human approver — the agent's own capability
   * is not enough, however confident the AI is.
   *
   * This is a routing rule, not a limit: it decides WHICH authority a payment
   * runs under, and therefore which set of limits the checks are measured
   * against. It is never supplied by the caller.
   */
  humanApprovalThresholdCents: Cents;
}

/** Mirrors the AgentCapability object that will live on Sui. */
export interface AgentCapability {
  agentId: string;
  authorized: boolean;
  enabled: boolean;
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  dailySpentCents: Cents;
}

/** What a human approver may authorize, for payments above the threshold. */
export interface ApproverAuthority {
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  dailySpentCents: Cents;
}

/** Everything the pipeline is allowed to know about the world for one run. */
export interface WorldSnapshot {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  paymentHistory: PaymentRecord[];
  cashFlowEvents: CashFlowEvent[];
  treasury: TreasuryState;
  policy: TreasuryPolicy;
  capability: AgentCapability;
  approver: ApproverAuthority;
}

/**
 * A test fixture. Deliberately carries NO expected outcome — expectations live
 * only in the test suite, so nothing downstream can read the answer.
 */
export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** The "today" for this scenario. Nothing in lib/ ever calls Date.now(). */
  asOfDate: IsoDate;
  document: RawInvoiceDocument;
  world: WorldSnapshot;
}

// ---------------------------------------------------------------------------
// Deterministic layer output — facts only
// ---------------------------------------------------------------------------

export interface DiscountFacts {
  percent: number;
  amountCents: Cents;
  deadline: IsoDate;
  daysUntilDeadline: number;
}

/**
 * One billed line, exactly as the document states it.
 *
 * Extracted rather than summarised, because the line items are where a PO
 * overage is actually legible: a $14,700 invoice against a $9,800 order is an
 * abstract discrepancy until you can see that the order covers the fixture
 * plates and the invoice adds an expedite fee nobody approved.
 */
export interface InvoiceLineItem {
  description: string;
  amountCents: Cents;
}

export interface InvoiceFacts {
  invoiceNumber: string;
  supplierName: string;
  amountCents: Cents;
  currency: string;
  dueDate: IsoDate;
  daysUntilDue: number;
  poNumber: string | null;
  recipientWallet: string;
  paymentTerms: string | null;
  discount: DiscountFacts | null;
  /** Per-field extraction confidence, 0..1. */
  extractionConfidence: Record<string, number>;
  /** Fields the extractor could not resolve from the document. */
  unresolvedFields: string[];
  /**
   * The billed lines, in document order. Empty when the document has no
   * itemised section — never padded, and never inferred from the total.
   */
  lineItems: InvoiceLineItem[];
}

export interface SupplierFacts {
  supplierFound: boolean;
  supplierId: string | null;
  registryStatus: RegistryStatus;
  registeredWallet: string | null;
  invoiceRecipientWallet: string;
  walletMatch: boolean;
  businessCriticality: BusinessCriticality | null;
  history: SupplierHistory | null;
}

export interface ValidationFacts {
  isDuplicate: boolean;
  duplicateOfPaymentId: string | null;
  poFound: boolean;
  poAmountCents: Cents | null;
  /** invoice amount − PO amount. Positive means the invoice asks for more. */
  poDeltaCents: Cents | null;
  poMatch: boolean | null;
  /**
   * The matched purchase order's OWN fields, carried through so a screen can
   * show the record the comparison actually ran against.
   *
   * They travel with the analysis rather than being looked up again in the
   * browser: the interface must display the document the deterministic layer
   * compared, not a second copy of it fetched by different code that could
   * disagree. All null when no PO was matched.
   */
  poCurrency: string | null;
  poDescription: string | null;
  poIssuedAt: IsoDate | null;
  poSupplierId: string | null;
  /** Whether the order belongs to the supplier that sent this invoice. */
  poSupplierMatch: boolean | null;
  amountVsSupplierMeanRatio: number | null;
  amountVsSupplierMaxRatio: number | null;
  currencyAllowed: boolean;
}

/** One simulated payment date, fully costed by deterministic code. */
export interface CashFlowScenario {
  paymentDate: IsoDate;
  daysFromToday: number;
  projectedMinimumCashCents: Cents;
  projectedMinimumCashDate: IsoDate;
  reserveBreach: boolean;
  /** How far below the minimum reserve the trough goes. 0 when no breach. */
  breachDepthCents: Cents;
  balanceOnPaymentDateCents: Cents;
  /** Saving captured by paying on this date. 0 when no discount applies. */
  discountCapturedCents: Cents;
  /** Net cash actually leaving the treasury on this date. */
  paymentAmountCents: Cents;
  isAfterDueDate: boolean;
  daysBeforeDue: number;
}

/** Policy values as read from Sui. Never written by the AI layer. */
export interface PolicyFacts {
  agentAuthorized: boolean;
  capabilityEnabled: boolean;
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  dailySpentCents: Cents;
  minimumReserveCents: Cents;
  currentCashCents: Cents;
  allowedCurrencies: string[];
  wouldExceedSingleLimit: boolean;
  wouldExceedDailyLimit: boolean;
}

export type RiskEvidenceCode =
  | "SUPPLIER_NOT_IN_REGISTRY"
  | "SUPPLIER_NOT_APPROVED"
  | "WALLET_MISMATCH"
  /**
   * A SECOND invoice improperly repeating one already on file.
   *
   * Emphatically NOT "this invoice has been paid". That is
   * INVOICE_ALREADY_SETTLED below, and conflating the two labelled the
   * original, correctly-paid invoice a duplicate of itself.
   */
  | "DUPLICATE_INVOICE"
  /**
   * This invoice is already settled on chain.
   *
   * Informational: a statement about what has happened, not an anomaly. It is
   * still a blocking condition for a NEW payment — see blockingConditions —
   * but that is a fact about a hypothetical second payment, not a risk carried
   * by the completed one.
   */
  | "INVOICE_ALREADY_SETTLED"
  | "PO_NOT_FOUND"
  | "PO_AMOUNT_MISMATCH"
  | "AMOUNT_ABOVE_SUPPLIER_HISTORY"
  | "CURRENCY_NOT_ALLOWED"
  | "NO_SUPPLIER_HISTORY"
  | "INCOMPLETE_EXTRACTION";

/**
 * A single observed fact relevant to trustworthiness. Deliberately carries no
 * weight, score, or severity — aggregating evidence into a judgement is the
 * LLM's job, and a severity field here would become the decision by proxy.
 */
export interface RiskEvidenceItem {
  code: RiskEvidenceCode;
  /** Plain statement of what was observed. */
  observation: string;
  /** The concrete values behind the observation. */
  evidence: Record<string, string | number | boolean | null>;
}

export interface UrgencyFacts {
  dueDate: IsoDate;
  daysUntilDue: number;
  isOverdue: boolean;
  discountDeadline: IsoDate | null;
  daysUntilDiscountDeadline: number | null;
  discountAmountCents: Cents | null;
  businessCriticality: BusinessCriticality | null;
  paymentTerms: string | null;
}

/** The complete, frozen fact sheet handed to the LLM. */
export interface DeterministicAnalysis {
  asOfDate: IsoDate;
  invoiceFacts: InvoiceFacts;
  supplierFacts: SupplierFacts;
  validationFacts: ValidationFacts;
  cashFlowScenarios: CashFlowScenario[];
  policyFacts: PolicyFacts;
  riskEvidence: RiskEvidenceItem[];
  urgencyFacts: UrgencyFacts;
}

// ---------------------------------------------------------------------------
// AI layer contract
// ---------------------------------------------------------------------------

export type TreasuryAction = "AUTO_PAY" | "SCHEDULE" | "HUMAN_REVIEW" | "REJECT";

export type Level = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** What the model returns, after validation. */
export interface TreasuryDecision {
  action: TreasuryAction;
  recommendedDate: IsoDate | null;
  risk: Level;
  urgency: Level;
  /** 0..1 */
  confidence: number;
  reasons: string[];
  riskExplanation: string;
  cashFlowExplanation: string;
  /**
   * Why not pay today, in the model's own words. Empty when the recommendation
   * IS today, when no payment was recommended, or when an older recording
   * predates this field — the interface falls back to cashFlowExplanation.
   *
   * Deliberately NOT a guard-checked field: validateDecision inspects structure
   * only, and escalating a sound decision over missing prose would restrict
   * nothing while mislabelling a correct answer as guard-rescued.
   */
  whyNotTodayExplanation: string;
  decisionExplanation: string;
}

export type GuardViolationCode =
  | "MALFORMED_JSON"
  | "SCHEMA_VIOLATION"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_LEVEL"
  | "CONFIDENCE_OUT_OF_RANGE"
  | "CONFIDENCE_BELOW_FLOOR"
  | "MISSING_RECOMMENDED_DATE"
  | "DATE_NOT_IN_CANDIDATE_SET"
  | "EMPTY_REASONS"
  | "TRANSPORT_ERROR"
  /** A deterministic safety condition the model does not get a vote on. */
  | "BLOCKING_CONDITION";

export interface GuardViolation {
  code: GuardViolationCode;
  detail: string;
}

export type EngineKind = "LLM" | "FALLBACK";

export interface DecisionResult {
  decision: TreasuryDecision;
  engine: EngineKind;
  rawModelOutput: string | null;
  modelId: string | null;
  /**
   * Raw transport failure, when the engine could not run at all.
   *
   * Deliberately NOT in `reasons`. An HTTP status is not a fact about the
   * invoice, and rendering one as a decision reason buries the verdict a reader
   * actually needs. The interface shows a humanised line and keeps this behind
   * an "Engine details" disclosure.
   */
  engineFailure?: string | null;
  guard: {
    downgraded: boolean;
    from: TreasuryAction | null;
    violations: GuardViolation[];
  };
  latencyMs: number;
}

export interface TreasuryDecisionEngine {
  readonly id: "llm" | "fallback" | "recorded";
  decide(analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult>;
}

// ---------------------------------------------------------------------------
// Recommendation layer — advisory, sits between the AI and the chain
// ---------------------------------------------------------------------------

/**
 * The comparison behind a scheduled date: what paying today would have cost.
 *
 * Every number here is deterministic — it is re-read from the candidate set the
 * model was offered, never from the model's prose. Computed AFTER the decision
 * (it needs to know which date was chosen), which is why it is not part of
 * DeterministicAnalysis.
 */
export interface WhyNotToday {
  /** Always cashFlowScenarios[0] — the candidate set always opens with today. */
  today: CashFlowScenario;
  recommended: CashFlowScenario;
  /** Every candidate, in date order, for the comparison table. */
  alternatives: CashFlowScenario[];
  /** recommended.projectedMinimumCash − today.projectedMinimumCash. */
  minimumCashDeltaCents: Cents;
  /** recommended.discountCaptured − today.discountCaptured. Negative = given up. */
  discountDeltaCents: Cents;
  todayBreaches: boolean;
  verdict:
    | "TODAY_BREACHES_RESERVE"
    | "LATER_IMPROVES_LIQUIDITY"
    | "DISCOUNT_FAVOURS_EARLIER"
    | "TODAY_IS_EQUIVALENT";
}

/**
 * What the AI recommends. Advisory only.
 *
 * This is NOT permission to move funds, and nothing in the codebase turns one
 * into a transaction: the only path to a transfer runs through PaymentRequest
 * and the Move enforcement that judges it. Every field below is explanatory —
 * none of them is read by the chain.
 *
 * `action` reuses TreasuryAction, where AUTO_PAY is the "PAY_NOW" of the spec.
 */
export interface PaymentRecommendation {
  /** Stable across re-runs: a hash of invoice, action, date and amount only. */
  recommendationId: string;
  action: TreasuryAction;
  recommendedDate: IsoDate | null;
  riskLevel: Level;
  riskReasons: string[];
  urgencyLevel: Level;
  cashStatus: "SAFE" | "RESERVE_BREACH";
  projectedMinimumCashCents: Cents;
  minimumReserveCents: Cents;
  reserveBreach: boolean;
  /**
   * What the chosen timing is worth against paying today, in cash terms.
   *
   * Defined as the discount delta alone. There is deliberately no late-payment
   * penalty term: the domain model carries no late-fee data, so any such figure
   * would be invented rather than derived, and every number the interface shows
   * has to be one the system can actually verify.
   */
  financialImpactCents: Cents;
  whyNotToday: WhyNotToday | null;
  reason: string;
  /**
   * 0..1. INFORMATIONAL ONLY — it explains the recommendation to a human and is
   * never sent to Move. See lib/ai/validateDecision.ts, where the confidence
   * floor can only ever downgrade an action, never authorize one.
   */
  aiConfidence: number;
  /** Epoch milliseconds, from the pipeline's injected clock. */
  generatedAtMs: number;
  /** generatedAtMs + RECOMMENDATION_TTL_MS. Enforced on-chain, not just here. */
  expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// Sui / Move layer
// ---------------------------------------------------------------------------

export interface PaymentRequest {
  invoiceNumber: string;
  supplierId: string | null;
  supplierName: string;
  amountCents: Cents;
  currency: string;
  recipientWallet: string;
  requestedDate: IsoDate;
  agentId: string;
  /**
   * Provenance of the recommendation this request came from. The chain stores
   * the id for audit and enforces the two timestamps; it reads nothing else
   * about how the recommendation was reached.
   */
  recommendationId: string;
  recommendedAtMs: number;
  expiresAtMs: number;
}

/**
 * One code per Move `assert!`. The numeric abort code each one carries on chain
 * is its position in POLICY_CHECK_ORDER (lib/sui/errorCodes.ts), so a Move abort
 * decodes straight back to the member of this union the interface already knows.
 */
export type PolicyViolationCode =
  | "AGENT_NOT_AUTHORIZED"
  | "CAPABILITY_DISABLED"
  | "EXCEEDS_MAX_PAYMENT"
  | "EXCEEDS_DAILY_LIMIT"
  | "SUPPLIER_NOT_APPROVED"
  | "RECIPIENT_WALLET_MISMATCH"
  | "INVOICE_ALREADY_PAID"
  | "CURRENCY_NOT_ALLOWED"
  | "INSUFFICIENT_RESERVE"
  | "RECOMMENDATION_EXPIRED";

export interface PolicyViolation {
  code: PolicyViolationCode;
  detail: string;
}

/**
 * One on-chain assertion, reported whether it passed or failed.
 *
 * The violation list alone cannot drive the UI: showing only what failed would
 * hide the checks that actually ran, which is the part that makes enforcement
 * legible. Each check mirrors exactly one Move `assert!`.
 */
export interface PolicyCheck {
  code: PolicyViolationCode;
  label: string;
  passed: boolean;
  detail: string;
  /** The limit the chain enforces, rendered for display. */
  limit: string | null;
  /** What the request actually asked for, rendered for display. */
  actual: string | null;
}

export interface PolicyEnforcementResult {
  outcome: "APPROVED" | "SUI_REJECT";
  violations: PolicyViolation[];
  /** Every assertion in evaluation order — passed and failed alike. */
  checks: PolicyCheck[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type FinalOutcome =
  | "EXECUTED"
  | "SCHEDULED"
  /**
   * The AI chose to pay and every on-chain check passes — but the amount is
   * above the human-approval threshold, so a person has to authorize it before
   * it can execute. Distinct from HUMAN_REVIEW, which is the AI declining to
   * decide; this is policy inserting a human into a decision the AI did make.
   */
  | "AWAITING_APPROVAL"
  | "HUMAN_REVIEW"
  | "REJECTED"
  | "SUI_REJECT";

export type PipelineStepName =
  | "extract"
  | "supplier"
  | "validate"
  | "forecast"
  | "policy_read"
  | "analysis"
  | "ai_decision"
  | "policy_enforce";

export interface PipelineStep {
  name: PipelineStepName;
  label: string;
  detail: string;
  durationMs: number;
}

export interface PipelineRun {
  scenarioId: string;
  asOfDate: IsoDate;
  analysis: DeterministicAnalysis;
  decision: DecisionResult;
  /** The AI's advisory output. Always present — even for REJECT. */
  recommendation: PaymentRecommendation;
  /** Only built for AUTO_PAY and SCHEDULE. Null means nothing reached the chain. */
  paymentRequest: PaymentRequest | null;
  enforcement: PolicyEnforcementResult | null;
  finalOutcome: FinalOutcome;
  steps: PipelineStep[];
}
