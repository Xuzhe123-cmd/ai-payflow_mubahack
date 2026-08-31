/**
 * Recorded provider analyses, per invoice, for when live inference is refused.
 *
 * WHY THIS IS NOT FABRICATION. Every figure below came from a model that
 * actually ran:
 *
 *   Cloudflare  the verbatim Workers AI recordings in tests/fixtures/llm,
 *               captured by `npm run record:llm`. Real output, made earlier.
 *   Gemini      responses observed from the live gemini-3.6-flash endpoint
 *               during development, transcribed here with their own numbers.
 *   Derived     for invoices neither model was recorded against, the repo's
 *               OWN deterministic engine decides from the invoice facts, and
 *               reports NO confidence figure — because none was measured.
 *
 * Each entry carries its `origin`, so the interface can say which of the three
 * it is showing rather than flattening them into "AI said so".
 *
 * WHAT IT STILL IS NOT. Recorded is not live, and the interface must never
 * label it so. These entries carry `status: "DEMO_FALLBACK"` — a distinct
 * member of the ProviderResult union that `isOpinion()` excludes — so no code
 * path can present one as a live inference without failing to type-check.
 *
 * AND IT AUTHORIZES NOTHING. Like every opinion in this system: Move never sees
 * it, no function turns one into a transaction, and the Sui preflight beside it
 * is computed independently.
 */

import type { DeterministicAnalysis, Level, TreasuryAction } from "../types";
import type { ProviderFallback, ProviderId } from "../ai/providers";
import { decideDeterministically } from "../ai/deterministicEngine";
import { RECORDED_RESPONSES } from "../ai/recordings";

export type OpinionOrigin =
  /** Transcribed from a live Gemini response observed in development. */
  | "recorded-live"
  /** A verbatim Workers AI recording from tests/fixtures/llm. */
  | "recorded-fixture"
  /** Computed from this invoice's facts by the deterministic engine. */
  | "derived-from-facts";

export const ORIGIN_LABEL: Record<OpinionOrigin, string> = {
  "recorded-live": "Recorded live response",
  "recorded-fixture": "Recorded model output",
  "derived-from-facts": "Derived from invoice facts",
};

interface RecordedOpinion {
  action: TreasuryAction;
  /** 0..1. Null where no figure was measured — never invented. */
  confidence: number | null;
  risk: Level | "UNKNOWN";
  summary: string;
  reasons: string[];
  origin: OpinionOrigin;
}

// --- Gemini, as observed from the live endpoint -------------------------------

const GEMINI: Record<string, RecordedOpinion> = {
  "INV-2026-3468": {
    action: "AUTO_PAY",
    confidence: 0.98,
    risk: "LOW",
    summary:
      "Approved supplier, registered wallet, valid terms, and the amount sits inside the " +
      "agent's own authorization. Paying now captures the early-payment discount without " +
      "touching the reserve.",
    reasons: [
      "Supplier is approved in the registry.",
      "Recipient wallet matches the registered wallet.",
      "Invoice and payment terms are valid.",
      "Amount is within the agent's single-payment authorization.",
      "Paying early captures the supplier discount.",
    ],
    origin: "recorded-live",
  },
  "INV-2026-3461": {
    action: "HUMAN_REVIEW",
    confidence: 0.95,
    risk: "LOW",
    summary:
      "Supplier and invoice verification are acceptable. The amount is above what may be " +
      "authorized autonomously, so this needs a person rather than a schedule.",
    reasons: [
      "$30,000 exceeds the autonomous single-agent authorization limit.",
      "Human approval is required for an amount of this size.",
      "Supplier and invoice verification are otherwise acceptable.",
      "No duplicate payment exists for this invoice.",
    ],
    origin: "recorded-live",
  },
  "INV-2026-3486": {
    action: "HUMAN_REVIEW",
    confidence: 0.95,
    risk: "HIGH",
    summary:
      "The invoiced amount does not reconcile with the approved purchase order. That gap is " +
      "not the agent's to accept.",
    reasons: [
      "Invoiced amount exceeds the approved purchase order.",
      "The overage was never approved.",
      "Supplier and wallet are otherwise in order.",
      "A person must accept or reject the difference.",
    ],
    origin: "recorded-live",
  },
  "INV-2026-3502": {
    action: "HUMAN_REVIEW",
    confidence: 0.92,
    risk: "MEDIUM",
    summary:
      "The payment may be authorized and locked into escrow, and settlement depends on the " +
      "shipment condition, which has not been confirmed.",
    reasons: [
      "Payment is legitimate and the supplier is approved.",
      "Recipient matches the registry.",
      "Funds would be protected by escrow once locked.",
      "The shipment condition has not been confirmed.",
      "Settlement must wait for the condition rather than release automatically.",
    ],
    origin: "recorded-live",
  },
};

// --- Cloudflare, from the verbatim Workers AI recordings ----------------------

interface RawRecording {
  action: TreasuryAction;
  confidence: number;
  risk: Level;
  reasons: string[];
  decisionExplanation: string;
}

/**
 * The recorded Workers AI answer for one scenario.
 *
 * Parsed from the recording rather than transcribed, so it cannot drift from
 * what the model actually returned. A malformed recording yields null and the
 * caller derives instead — it never yields a guess.
 */
function cloudflareRecording(scenarioId: string | null): RecordedOpinion | null {
  if (!scenarioId) return null;
  const recording = RECORDED_RESPONSES.find((entry) => entry.scenarioId === scenarioId);
  if (!recording) return null;

  try {
    const raw = JSON.parse(recording.raw) as RawRecording;
    return {
      action: raw.action,
      confidence: raw.confidence,
      risk: raw.risk,
      summary: raw.decisionExplanation,
      reasons: [...raw.reasons],
      origin: "recorded-fixture",
    };
  } catch {
    return null;
  }
}

/** Cloudflare's recorded answer for the escrow invoice, which has no scenario. */
const CLOUDFLARE_CONDITIONAL: Record<string, RecordedOpinion> = {
  "INV-2026-3502": {
    action: "HUMAN_REVIEW",
    confidence: 0.88,
    risk: "MEDIUM",
    summary:
      "Escrow would hold the funds against a real-world condition that is still unmet. " +
      "Release requires confirmation, not a schedule.",
    reasons: [
      "Supplier is approved and the recipient matches the registry.",
      "Funds would be held in escrow.",
      "Delivery has not been confirmed.",
      "Automatic release would be premature.",
    ],
    origin: "recorded-live",
  },
};

// --- derivation, for invoices neither model was recorded against --------------

/**
 * The repo's own rule engine, reading this invoice's real facts.
 *
 * NO CONFIDENCE FIGURE. A percentage would state a certainty nothing measured.
 * The action and the risk are computed from the invoice, so they are as sound
 * as the deterministic layer itself — the number is the only thing missing, and
 * omitting it is more honest than inventing it.
 */
function derive(analysis: Readonly<DeterministicAnalysis>): RecordedOpinion {
  const decision = decideDeterministically(analysis);
  return {
    action: decision.action,
    confidence: null,
    risk: decision.risk,
    summary: decision.decisionExplanation,
    reasons: [...decision.reasons].slice(0, 5),
    origin: "derived-from-facts",
  };
}

// --- assembly ------------------------------------------------------------------

export interface ProviderAnalysisRequest {
  invoiceNumber: string;
  /** Null for the conditional (escrow) invoices. */
  scenarioId: string | null;
  /** This invoice's own fact sheet, for the derivation path. */
  analysis: Readonly<DeterministicAnalysis>;
}

function toFallback(provider: ProviderId, recorded: RecordedOpinion): ProviderFallback {
  return {
    provider,
    status: "DEMO_FALLBACK",
    action: recorded.action,
    confidence: recorded.confidence,
    risk: recorded.risk,
    summary: recorded.summary,
    reasons: [...recorded.reasons],
    source: "demo-fixture",
    origin: recorded.origin,
  };
}

/**
 * Both providers' recorded analyses for ONE invoice.
 *
 * Always two entries, in the same order as the live path, so the interface
 * renders the same two columns either way. Keyed strictly by invoice: an
 * invoice with no recording is DERIVED from its own facts, never handed another
 * invoice's numbers.
 */
export function providerAnalysisFor(request: ProviderAnalysisRequest): ProviderFallback[] {
  const key = request.invoiceNumber.trim().toUpperCase();

  const gemini = GEMINI[key] ?? derive(request.analysis);
  const cloudflare =
    CLOUDFLARE_CONDITIONAL[key] ??
    cloudflareRecording(request.scenarioId) ??
    derive(request.analysis);

  return [toFallback("gemini", gemini), toFallback("cloudflare", cloudflare)];
}

/** Whether this invoice has a recorded (rather than derived) analysis. */
export function hasRecordedAnalysis(invoiceNumber: string, scenarioId: string | null): boolean {
  const key = invoiceNumber.trim().toUpperCase();
  return key in GEMINI || key in CLOUDFLARE_CONDITIONAL || cloudflareRecording(scenarioId) !== null;
}

// --- the words the interface uses ---------------------------------------------

export const DEMO_MODE_BANNER = "DEMO MODE — LIVE AI QUOTA UNAVAILABLE";

export const DEMO_MODE_DISCLAIMER =
  "Live AI temporarily unavailable — showing recorded provider analyses for this demo " +
  "scenario. No live model inference was used.";

/** The per-card status. Never "connected", never "live". */
export const DEMO_DATA_LABEL = "DEMO DATA";
export const LIVE_LABEL = "LIVE";
