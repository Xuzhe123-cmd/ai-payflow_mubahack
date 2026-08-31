/**
 * The same invoice, put to two providers independently.
 *
 * INDEPENDENCE IS ENGINEERED, NOT ASSUMED. Both receive the identical
 * `SYSTEM_PROMPT` and the identical `buildUserMessage(analysis)` — the same
 * verified fact sheet, the same schema, the same guard on the way back. What
 * differs is only the vendor, the credential, the weights and the network path.
 * That is what makes a disagreement meaningful: with the input held constant,
 * a divergence is about the model, not about what it was told.
 *
 * They are also called CONCURRENTLY and neither sees the other's answer. A
 * second opinion that had been shown the first is not a second opinion.
 *
 * NOTHING IS INVENTED. A provider that is unconfigured, unreachable, or returns
 * output the guard rejects becomes a ProviderUnavailable carrying the real
 * reason. It is never filled in from the other provider, from a recording, or
 * from a default — and `resolveConsensus` then falls back to HUMAN_REVIEW,
 * because one opinion cannot corroborate itself.
 */

import type { DeterministicAnalysis, Level, TreasuryAction } from "../types";
import { DECISION_JSON_SCHEMA } from "./decisionSchema";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { validateDecision } from "./validateDecision";
import { readGeminiConfig, runGemini } from "./geminiClient";
import { createWorkersAiClient, readWorkersAiConfig } from "./workersAiClient";
import type { ProviderResult } from "./providers";

/** Both providers get the same budget. A slow model is not a wrong model. */
const TIMEOUT_MS = 30_000;
const TEMPERATURE = 0;

export interface DualAnalysisOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Asks both providers, in parallel, and reports what each said.
 *
 * Always returns exactly two entries, in a stable order (Gemini first), so the
 * interface renders two columns whether or not either answered.
 */
export async function analyzeWithBothProviders(
  analysis: Readonly<DeterministicAnalysis>,
  options: DualAnalysisOptions = {},
): Promise<ProviderResult[]> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  // Concurrent and isolated: one provider failing must not deny the other its
  // budget, and neither may observe the other's answer.
  const [gemini, cloudflare] = await Promise.all([
    askGemini(analysis, env, timeoutMs),
    askCloudflare(analysis, env, timeoutMs),
  ]);

  return [gemini, cloudflare];
}

async function askGemini(
  analysis: Readonly<DeterministicAnalysis>,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<ProviderResult> {
  const config = readGeminiConfig(env);
  if (!config) {
    return {
      provider: "gemini",
      status: "UNCONFIGURED",
      reason:
        "GEMINI_API_KEY is not set, so Gemini was not called. No recommendation, confidence " +
        "or risk is shown for it.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await runGemini(
      config,
      {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserMessage(analysis),
        jsonSchema: DECISION_JSON_SCHEMA,
        temperature: TEMPERATURE,
      },
      controller.signal,
    );

    // THE SAME GUARD the other provider's output goes through. A provider is
    // not trusted merely because it answered — malformed or out-of-range output
    // is downgraded exactly as it would be from Workers AI.
    const outcome = validateDecision(response.text, analysis);
    return toOpinion("gemini", response.modelId, outcome.decision);
  } catch (error) {
    return {
      provider: "gemini",
      status: "FAILED",
      // The real error. A provider that refused must not read as one that
      // answered, and the status code is how an operator debugs it.
      reason: error instanceof Error ? error.message : "Gemini could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function askCloudflare(
  analysis: Readonly<DeterministicAnalysis>,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<ProviderResult> {
  const config = readWorkersAiConfig(env);
  if (!config) {
    return {
      provider: "cloudflare",
      status: "UNCONFIGURED",
      reason:
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not set, so Workers AI was not called.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await createWorkersAiClient(config).run(
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(analysis) },
        ],
        jsonSchema: DECISION_JSON_SCHEMA,
        temperature: TEMPERATURE,
        // Fixed, so repeating the same invoice gives the same answer.
        seed: 42,
        maxTokens: 900,
      },
      controller.signal,
    );

    const outcome = validateDecision(response.text, analysis);
    return toOpinion("cloudflare", response.modelId, outcome.decision);
  } catch (error) {
    return {
      provider: "cloudflare",
      status: "FAILED",
      reason: error instanceof Error ? error.message : "Workers AI could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function toOpinion(
  provider: "gemini" | "cloudflare",
  modelId: string,
  decision: {
    action: TreasuryAction;
    confidence: number;
    risk: Level;
    reasons: string[];
    decisionExplanation: string;
  },
): ProviderResult {
  return {
    status: "OK",
    provider,
    modelId,
    action: decision.action,
    confidence: decision.confidence,
    risk: decision.risk,
    summary: decision.decisionExplanation,
    reasons: [...decision.reasons],
  };
}
