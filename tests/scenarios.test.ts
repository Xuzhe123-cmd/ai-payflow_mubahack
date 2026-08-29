/**
 * Tier 2 — the eight scenarios, replayed from recorded Workers AI responses.
 *
 * The recordings are verbatim model output captured by `npm run record:llm`, so
 * these assertions are about decisions the model genuinely made. Replaying them
 * keeps CI deterministic and offline.
 *
 * Note what is asserted: `guard.from`, the action the MODEL chose, before any
 * downgrade. If a rule were quietly making these decisions, this suite would
 * still pass on `decision.action` but fail here — which is the point.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createRecordedEngine, type RecordedResponse } from "../lib/ai/recordedEngine";
import { SCENARIOS } from "../lib/demo/scenarios";
import { runScenario } from "../lib/demo/runScenario";
import { expectationFor } from "./expectations";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/llm");

function loadRecordings(): RecordedResponse[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as RecordedResponse);
}

const recordings = loadRecordings();
const recordedIds = new Set(recordings.map((entry) => entry.scenarioId));
const missing = SCENARIOS.filter((scenario) => !recordedIds.has(scenario.id));

if (recordings.length === 0) {
  console.warn(
    "\n  ⚠  No LLM recordings found in tests/fixtures/llm.\n" +
      "     The eight-scenario tier is NOT being exercised. Add Cloudflare\n" +
      "     credentials to .env.local and run `npm run record:llm`.\n",
  );
} else if (missing.length > 0) {
  console.warn(
    `\n  ⚠  Missing recordings for: ${missing.map((s) => s.id).join(", ")}\n` +
      "     Those scenarios are not being exercised.\n",
  );
}

describe.skipIf(recordings.length === 0)("eight scenarios (replayed model decisions)", () => {
  it.each(SCENARIOS.filter((scenario) => recordedIds.has(scenario.id)))(
    "$id decides correctly",
    async (scenario) => {
      const engine = createRecordedEngine(recordings, { keyFor: () => scenario.id });
      const run = await runScenario(scenario, engine);
      const expectation = expectationFor(scenario.id);

      // The model must have produced a usable decision — not been rescued by
      // the guard or quietly replaced by the fallback.
      expect(run.decision.engine).toBe("LLM");
      expect(run.decision.guard.downgraded, `guard downgraded: ${JSON.stringify(run.decision.guard.violations)}`).toBe(false);

      // The AI's own choice, before any downstream layer touched it.
      expect(
        expectation.allowedActions,
        `${scenario.id}: ${expectation.why}`,
      ).toContain(run.decision.guard.from!);

      // And the end state after Sui had its say.
      expect(expectation.finalOutcomes).toContain(run.finalOutcome);
    },
  );

  it("reaches different decisions across the scenarios", async () => {
    const outcomes = new Set<string>();
    for (const scenario of SCENARIOS.filter((s) => recordedIds.has(s.id))) {
      const engine = createRecordedEngine(recordings, { keyFor: () => scenario.id });
      const run = await runScenario(scenario, engine);
      outcomes.add(run.finalOutcome);
    }
    // A pipeline that answered the same way every time would prove nothing.
    expect(outcomes.size).toBeGreaterThanOrEqual(3);
  });

  it("explains its timing choice whenever it picks a payment date", async () => {
    for (const scenario of SCENARIOS.filter((s) => recordedIds.has(s.id))) {
      const engine = createRecordedEngine(recordings, { keyFor: () => scenario.id });
      const run = await runScenario(scenario, engine);
      if (run.decision.decision.recommendedDate) {
        expect(run.decision.decision.cashFlowExplanation.length).toBeGreaterThan(20);
        expect(run.decision.decision.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});
