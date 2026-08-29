/**
 * Engine selection.
 *
 * Credentials present -> the real LLM engine. Absent -> the fallback, which
 * escalates everything and says so. There is no third path that quietly
 * simulates AI reasoning.
 */

import type { TreasuryDecisionEngine } from "../types";
import { createFallbackEngine } from "./fallbackEngine";
import { createLlmEngine, type LlmEngineOptions } from "./llmEngine";
import { createWorkersAiClient, readWorkersAiConfig } from "./workersAiClient";

export interface EngineSelection {
  engine: TreasuryDecisionEngine;
  /** True when a real model will be called. */
  live: boolean;
  modelId: string | null;
  /** Why the fallback was selected, when it was. */
  reason: string | null;
}

export function selectDecisionEngine(
  env: Record<string, string | undefined> = process.env,
  options: LlmEngineOptions = {},
): EngineSelection {
  const config = readWorkersAiConfig(env);

  if (!config) {
    const reason =
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not set, so no model could be called.";
    return { engine: createFallbackEngine(reason), live: false, modelId: null, reason };
  }

  return {
    engine: createLlmEngine(createWorkersAiClient(config), options),
    live: true,
    modelId: config.modelId,
    reason: null,
  };
}

export type { TreasuryDecisionEngine };
