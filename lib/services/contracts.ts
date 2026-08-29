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
  PaymentRequest,
  PipelineStep,
  PolicyEnforcementResult,
  RawInvoiceDocument,
  TreasuryDecision,
} from "../types";
import type { CashProjection } from "../deterministic/projection";
import type { EngineMode } from "../ai/recordings";

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
  paymentRequest: PaymentRequest | null;
  enforcement: PolicyEnforcementResult | null;
  finalOutcome: FinalOutcome;
  steps: PipelineStep[];
}

export interface AnalysisErrorResponse {
  error: string;
}
