/**
 * Two independent intelligence providers, named and kept apart.
 *
 * THE POINT OF TWO. One model is a single point of failure in both directions:
 * if it is wrong, nothing contradicts it; if it is compromised, nothing notices.
 * Two providers reached independently give the system a second opinion it did
 * not generate itself, and a DISAGREEMENT is a signal in its own right — the
 * cheapest available evidence that one of them is behaving oddly.
 *
 * WHAT THEY ARE NOT. Neither provider authorises anything. No function in this
 * codebase takes an `AiProviderOpinion` and returns a transaction, and Move
 * never sees one. They answer "what should happen"; Sui answers "what may".
 * A compromised provider can therefore lie, and the worst it achieves is a
 * recommendation the chain still refuses.
 *
 * HONESTY ABOUT CONFIGURATION. A provider with no credentials reports
 * UNCONFIGURED and carries no recommendation, no confidence and no risk. It is
 * never filled in with a plausible-looking number — an invented 92% beside a
 * provider that was never called is exactly the kind of fabrication the rest of
 * this project refuses, and it would be worse here, because the whole claim of
 * this phase is that two systems were consulted independently.
 */

import type { Level, TreasuryAction } from "../types";

export type ProviderId = "gemini" | "cloudflare";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: "Gemini",
  cloudflare: "Cloudflare",
};

/**
 * What a provider offers the treasury engine.
 *
 * Deliberately narrower than `TreasuryDecision`: a provider recommends and
 * explains, and has no field through which it could grant, schedule, or settle.
 */
export interface ProviderOpinion {
  provider: ProviderId;
  /** The model actually consulted, for a reader who wants to verify. */
  modelId: string;
  action: TreasuryAction;
  /** 0..1, as the model reported it. */
  confidence: number;
  risk: Level;
  /** One or two lines. The provider's reasoning, not the app's summary of it. */
  summary: string;
  reasons: string[];
}

/** A provider that could not be reached, or was never configured. */
export interface ProviderUnavailable {
  provider: ProviderId;
  status: "UNCONFIGURED" | "FAILED";
  /** Named credentials, or the error. Shown as-is; never softened. */
  reason: string;
}

/**
 * A PRE-RECORDED opinion, used when the live models cannot be reached.
 *
 * A separate member of the union from `{ status: "OK" }` on purpose: nothing
 * that asks `isOpinion()` can ever receive one, so a fixture cannot be mistaken
 * for a live inference by any code path. The distinction is enforced by the
 * type, not by remembering to check a flag.
 */
export interface ProviderFallback {
  provider: ProviderId;
  status: "DEMO_FALLBACK";
  action: TreasuryAction;
  /** 0..1, or null where no figure was recorded. Never invented. */
  confidence: number | null;
  risk: Level | "UNKNOWN";
  summary: string;
  reasons: string[];
  source: "demo-fixture";
  /**
   * Where this recorded answer came from — a live response, a stored model
   * recording, or a derivation from the invoice's own facts. Surfaced so the
   * interface can be precise rather than flattening three provenances into one.
   */
  origin: "recorded-live" | "recorded-fixture" | "derived-from-facts";
}

export type ProviderResult =
  | ({ status: "OK" } & ProviderOpinion)
  | ProviderUnavailable
  | ProviderFallback;

/** True ONLY for a live model answer. A fixture is deliberately excluded. */
export function isOpinion(result: ProviderResult): result is { status: "OK" } & ProviderOpinion {
  return result.status === "OK";
}

export function isFallback(result: ProviderResult): result is ProviderFallback {
  return result.status === "DEMO_FALLBACK";
}

/**
 * The action and figures a result carries, whichever kind it is.
 *
 * Lets consensus be computed once for both the live and the fallback path, so
 * the two can never apply different rules about what counts as agreement.
 */
function comparable(
  result: ProviderResult,
): { action: TreasuryAction; confidence: number | null; risk: Level | "UNKNOWN" } | null {
  if (result.status === "OK") {
    return { action: result.action, confidence: result.confidence, risk: result.risk };
  }
  if (result.status === "DEMO_FALLBACK") {
    return { action: result.action, confidence: result.confidence, risk: result.risk };
  }
  return null;
}

// --- consensus ---------------------------------------------------------------

export type ConsensusKind =
  /** Both answered, and agree on the action. */
  | "CONSENSUS"
  /** Both answered, and do not. Escalates to a human. */
  | "DISAGREEMENT"
  /** Exactly one answered. One opinion is not a consensus. */
  | "SINGLE_PROVIDER"
  /** Neither answered. */
  | "NO_PROVIDERS";

export interface Consensus {
  kind: ConsensusKind;
  /** The agreed action, only when both agreed. Null otherwise. */
  agreedAction: TreasuryAction | null;
  /**
   * What the system should do about the consensus itself.
   *
   * A disagreement resolves to HUMAN_REVIEW regardless of what either provider
   * said — two systems that cannot agree are not a basis for autonomy. This is
   * a recommendation like any other and still binds nothing on chain.
   */
  recommendedAction: TreasuryAction;
  /** Mean confidence across providers that answered. Null when none did. */
  meanConfidence: number | null;
  /** The highest risk either provider reported, which is the one that matters. */
  highestRisk: Level | null;
  detail: string;
}

const RISK_ORDER: Level[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function higherRisk(a: Level, b: Level): Level {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/**
 * Compares the two opinions.
 *
 * FAILS TOWARDS THE HUMAN, in every direction. Disagreement escalates. A single
 * provider escalates, because one opinion cannot corroborate itself and this
 * phase's entire premise is that a provider might be compromised. No provider
 * escalates. Only genuine agreement between two independently-reached answers
 * leaves the recommendation where the providers put it.
 */
export function resolveConsensus(results: ProviderResult[]): Consensus {
  const opinions = results
    .map((result) => ({ result, values: comparable(result) }))
    .filter((entry): entry is { result: ProviderResult; values: NonNullable<ReturnType<typeof comparable>> } =>
      entry.values !== null,
    )
    .map((entry) => ({
      provider: entry.result.provider,
      action: entry.values.action,
      confidence: entry.values.confidence,
      risk: entry.values.risk,
    }));

  if (opinions.length === 0) {
    return {
      kind: "NO_PROVIDERS",
      agreedAction: null,
      recommendedAction: "HUMAN_REVIEW",
      meanConfidence: null,
      highestRisk: null,
      detail: "No intelligence provider answered. Nothing autonomous may proceed on no opinion.",
    };
  }

  // Averaged over the providers that REPORTED a figure. A generic fallback
  // records no confidence, and counting it as zero would understate the rest.
  const scored = opinions.filter(
    (opinion): opinion is typeof opinion & { confidence: number } => opinion.confidence !== null,
  );
  const meanConfidence =
    scored.length > 0
      ? scored.reduce((total, opinion) => total + opinion.confidence, 0) / scored.length
      : null;

  // UNKNOWN is not a risk level and must not be ranked as one; a pair that
  // reported no risk reports none here either.
  const ranked = opinions.filter(
    (opinion): opinion is typeof opinion & { risk: Level } => opinion.risk !== "UNKNOWN",
  );
  const highestRisk =
    ranked.length > 0
      ? ranked.reduce<Level>((worst, opinion) => higherRisk(worst, opinion.risk), "LOW")
      : null;

  if (opinions.length === 1) {
    const only = opinions[0];
    return {
      kind: "SINGLE_PROVIDER",
      agreedAction: null,
      // One provider cannot corroborate itself.
      recommendedAction: "HUMAN_REVIEW",
      meanConfidence,
      highestRisk,
      detail:
        `Only ${PROVIDER_LABEL[only.provider]} answered. A single opinion is not a second ` +
        "opinion, so this escalates to a person rather than proceeding autonomously.",
    };
  }

  const actions = new Set(opinions.map((opinion) => opinion.action));
  if (actions.size > 1) {
    const rendered = opinions
      .map((opinion) => `${PROVIDER_LABEL[opinion.provider]} → ${opinion.action}`)
      .join(", ");
    return {
      kind: "DISAGREEMENT",
      agreedAction: null,
      recommendedAction: "HUMAN_REVIEW",
      meanConfidence,
      highestRisk,
      detail: `The providers disagree (${rendered}). A disagreement is escalated to a person.`,
    };
  }

  const agreedAction = opinions[0].action;
  return {
    kind: "CONSENSUS",
    agreedAction,
    recommendedAction: agreedAction,
    meanConfidence,
    highestRisk,
    detail: `Both providers independently recommend ${agreedAction}.`,
  };
}

/**
 * The claim this module is not allowed to support.
 *
 * Exported so callers and tests can state it in one place: a consensus is an
 * opinion two systems happen to share, and sharing it grants nothing.
 */
export const CONSENSUS_GRANTS_NOTHING =
  "AI consensus is advisory. It does not authorize a payment, raise a limit, or " +
  "change treasury state — Sui Move enforces every limit regardless of what the providers agree on.";
