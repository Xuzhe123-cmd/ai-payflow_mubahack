/**
 * Replays previously recorded Workers AI responses.
 *
 * This is how CI stays deterministic without pretending an LLM ran: the
 * responses are real model output captured by `npm run record:llm`, and they go
 * through the identical validation guard. It reports engine "LLM" because the
 * decision genuinely came from the model — just at recording time rather than
 * now. Anything not in the recording is an error, never a silent fallback.
 */

import type {
  DecisionResult,
  DeterministicAnalysis,
  TreasuryDecisionEngine,
} from "../types";
import { validateDecision } from "./validateDecision";

export interface RecordedResponse {
  scenarioId: string;
  modelId: string;
  recordedAt: string;
  /** Verbatim model output, exactly as Workers AI returned it. */
  raw: string;
}

export interface RecordedEngineOptions {
  /** Resolves the analysis being decided to its recording key. */
  keyFor: (analysis: Readonly<DeterministicAnalysis>) => string;
}

export function createRecordedEngine(
  recordings: readonly RecordedResponse[],
  options: RecordedEngineOptions,
): TreasuryDecisionEngine {
  const byKey = new Map(recordings.map((entry) => [entry.scenarioId, entry]));

  return {
    id: "recorded",

    decide(analysis: Readonly<DeterministicAnalysis>): Promise<DecisionResult> {
      const key = options.keyFor(analysis);
      const recording = byKey.get(key);
      if (!recording) {
        return Promise.reject(
          new Error(
            `No recorded model response for "${key}". Run "npm run record:llm" to capture one.`,
          ),
        );
      }

      const outcome = validateDecision(recording.raw, analysis);
      return Promise.resolve({
        decision: outcome.decision,
        engine: "LLM",
        rawModelOutput: recording.raw,
        modelId: recording.modelId,
        guard: {
          downgraded: outcome.downgraded,
          from: outcome.from,
          violations: outcome.violations,
        },
        latencyMs: 0,
      });
    },
  };
}
