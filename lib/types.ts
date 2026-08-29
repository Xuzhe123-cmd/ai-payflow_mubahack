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

/** Everything the pipeline is allowed to know about the world for one run. */
export interface WorldSnapshot {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  paymentHistory: PaymentRecord[];
  cashFlowEvents: CashFlowEvent[];
  treasury: TreasuryState;
  policy: TreasuryPolicy;
  capability: AgentCapability;
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
  | "DUPLICATE_INVOICE"
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
  | "TRANSPORT_ERROR";

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
}

export type PolicyViolationCode =
  | "AGENT_NOT_AUTHORIZED"
  | "CAPABILITY_DISABLED"
  | "EXCEEDS_MAX_PAYMENT"
  | "EXCEEDS_DAILY_LIMIT"
  | "SUPPLIER_NOT_APPROVED"
  | "RECIPIENT_WALLET_MISMATCH"
  | "INVOICE_ALREADY_PAID"
  | "CURRENCY_NOT_ALLOWED"
  | "INSUFFICIENT_RESERVE";

export interface PolicyViolation {
  code: PolicyViolationCode;
  detail: string;
}

export interface PolicyEnforcementResult {
  outcome: "APPROVED" | "SUI_REJECT";
  violations: PolicyViolation[];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type FinalOutcome =
  | "EXECUTED"
  | "SCHEDULED"
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
  paymentRequest: PaymentRequest | null;
  enforcement: PolicyEnforcementResult | null;
  finalOutcome: FinalOutcome;
  steps: PipelineStep[];
}
