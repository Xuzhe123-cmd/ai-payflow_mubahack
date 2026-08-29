/**
 * The AI decision engine.
 *
 * This is where the business decision is actually made. It hands the verified
 * fact sheet to the model, takes back a schema-constrained JSON decision, and
 * puts it through the structural guard. It never reasons about the invoice
 * itself — no rule here inspects supplier status, wallets, or duplicates.
 */

import type {
  DecisionResult,
  DeterministicAnalysis,
  TreasuryDecisionEngine,
} from "../types";
import { DECISION_JSON_SCHEMA } from "./decisionSchema";
import { fallbackDecision } from "./fallbackEngine";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";
import { validateDecision } from "./validateDecision";
import type { ChatMessage, WorkersAiClient } from "./workersAiClient";

export interface LlmEngineOptions {
  /** Fixed so repeated runs of the same invoice give the same decision. */
  seed?: number;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const DEFAULTS = {
  seed: 42,
  temperature: 0,
  maxTokens: 900,
  timeoutMs: 30_000,
} as const;

const RETRY_NUDGE =
  "Your previous response could not be parsed. Return ONLY a single JSON object matching the schema, with no prose, no markdown fences, and no commentary.";

export function createLlmEngine(
  client: WorkersAiClient,
  options: LlmEngineOptions = {},
): TreasuryDecisionEngine {
  const seed = options.seed ?? DEFAULTS.seed;
  const temperature = options.temperature ?? DEFAULTS.temperature;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;

  async function callModel(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await client.run(
        { messages, jsonSchema: DECISION_JSON_SCHEMA, temperature, seed, maxTokens },
        controller.signal,
      );
      return response.text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "llm",

    async decide(analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult> {
      const startedAt = Date.now();
      const baseMessages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(analysis) },
      ];

      let raw: string;
      try {
        raw = await callModel(baseMessages);
      } catch (error) {
        // One retry with a stricter instruction before giving up on the model.
        try {
          raw = await callModel([
            ...baseMessages,
            { role: "user", content: RETRY_NUDGE },
          ]);
        } catch (retryError) {
          return fallbackDecision(
            {
              summary: `Workers AI could not be reached: ${describe(error)} (retry also failed: ${describe(retryError)})`,
            },
            Date.now() - startedAt,
          );
        }
      }

      let outcome = validateDecision(raw, analysis);

      // A malformed body is worth one more attempt; a merely disagreeable
      // decision is not — the model's judgement stands either way.
      if (
        outcome.downgraded &&
        outcome.violations.some(
          (violation) =>
            violation.code === "MALFORMED_JSON" || violation.code === "SCHEMA_VIOLATION",
        )
      ) {
        try {
          const retried = await callModel([
            ...baseMessages,
            { role: "user", content: RETRY_NUDGE },
          ]);
          const retriedOutcome = validateDecision(retried, analysis);
          if (!retriedOutcome.downgraded) {
            raw = retried;
            outcome = retriedOutcome;
          }
        } catch {
          // Keep the original guarded outcome; it already escalates safely.
        }
      }

      return {
        decision: outcome.decision,
        engine: "LLM",
        rawModelOutput: raw,
        modelId: client.modelId,
        guard: {
          downgraded: outcome.downgraded,
          from: outcome.from,
          violations: outcome.violations,
        },
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
