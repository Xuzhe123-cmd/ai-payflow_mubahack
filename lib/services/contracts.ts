/**
 * The wire contract between the interface and whatever is producing analyses.
 *
 * Today that producer is app/api/analyze; tomorrow it is a Cloudflare Worker.
 * Both sides import these types, so the swap is a change of URL rather than a
 * change of interface. Nothing here is UI state — it is the shape of a result.
 */

import type {
  DecisionResult,
  DeterministicAnalysis,
  EngineKind,
  FinalOutcome,
  IsoDate,
  PaymentRecommendation,
  PaymentRequest,
  PipelineStep,
  PolicyEnforcementResult,
  RawInvoiceDocument,
  TreasuryDecision,
} from "../types";
import type { CashProjection } from "../deterministic/projection";
import type { EngineMode } from "../ai/recordings";
import type { ChainSnapshot } from "../sui/chainTypes";
import type { PaymentDecision } from "../decision/types";

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
}

export interface AnalysisResponse {
  scenarioId: string;
  scenario: ScenarioSummary;
  asOfDate: IsoDate;
  /** LLM or FALLBACK. Surfaced so the UI can never present one as the other. */
  engine: EngineKind;
  /**
   * How that engine ran: a live model call, a replay of recorded model output,
   * or the safety fallback. A replay is real model output, but it is never
   * displayed as a live call.
   */
  engineMode: EngineMode;
  /** Why the fallback is in use, when it is. Null on a live model run. */
  engineNotice: string | null;
  modelId: string | null;
  latencyMs: number;
  document: RawInvoiceDocument;
  analysis: DeterministicAnalysis;
  decision: TreasuryDecision;
  guard: DecisionResult["guard"];
  projection: CashProjection;
  /**
   * The AI's advisory output. Always present, including for HUMAN_REVIEW and
   * REJECT — it is what the AI thinks, not what it is allowed to do.
   */
  recommendation: PaymentRecommendation;
  /** Null unless the recommendation was AUTO_PAY or SCHEDULE. */
  paymentRequest: PaymentRequest | null;
  enforcement: PolicyEnforcementResult | null;
  finalOutcome: FinalOutcome;
  steps: PipelineStep[];
  /**
   * Whether the figures behind this analysis came from live testnet state or
   * from the bundled fixtures. Surfaced so the interface can say which, rather
   * than presenting fixture numbers as chain numbers.
   */
  worldSource?: "chain" | "fixture";
}

export interface AnalysisErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// Live chain state
// ---------------------------------------------------------------------------

/**
 * The wire shape of /api/chain. Discriminated rather than throwing, because
 * "no deployment yet" is a normal state for a developer running the app, not a
 * failure worth a stack trace.
 */
export type ChainSnapshotResponse =
  | { ok: true; snapshot: ChainSnapshot }
  | { ok: false; reason: "NOT_DEPLOYED" | "READ_FAILED"; message: string };

/** The wire shape of /api/decisions: chain state and the verdicts drawn from it. */
export type DecisionsResponse =
  | { ok: true; snapshot: ChainSnapshot; decisions: PaymentDecision[] }
  | { ok: false; reason: "NOT_DEPLOYED" | "READ_FAILED"; message: string };

/**
 * The result of a human approving an escalated payment.
 *
 * `enforcement` is a full re-run of the ten checks under the APPROVER's limits.
 * Approval widens who may authorize the amount; it does not skip a single
 * check, and the outcome can still be SUI_REJECT.
 */
export interface ApprovalResponse {
  scenarioId: string;
  worldSource: "chain" | "fixture";
  paymentRequest: PaymentRequest;
  enforcement: PolicyEnforcementResult;
  approvedUnder: "HUMAN_APPROVAL";
  agentMaxSinglePaymentCents: number;
  approverMaxSinglePaymentCents: number;
  /**
   * Where that ceiling came from.
   *
   * CHAIN means the treasury's own approver record was read. FIXTURE means no
   * on-chain authorization was found and an offline default stood in — which
   * authorizes nothing, and a caller must not present it as though it did.
   */
  approverLimitSource?: "CHAIN" | "FIXTURE";
}
