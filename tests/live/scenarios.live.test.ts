/**
 * Tier 3 — the live model.
 *
 *   npm run test:live
 *
 * This is where "all eight scenarios decide correctly" is actually tested.
 * Because a language model makes the call, the result is empirical: each
 * scenario is sampled several times and the agreement rate is reported. A
 * disagreement is a real signal about prompt quality, not a broken test.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { selectDecisionEngine } from "../../lib/ai/engine";
import { SCENARIOS } from "../../lib/demo/scenarios";
import { runScenario } from "../../lib/demo/runScenario";
import { loadEnvLocal } from "../../scripts/loadEnv";
import { expectationFor } from "../expectations";
import type { TreasuryAction, TreasuryDecisionEngine } from "../../lib/types";

/** How many times each scenario is sampled. */
const SAMPLES = Number(process.env.LIVE_SAMPLES ?? 3);
/** Fraction of samples that must land on an expected action. */
const REQUIRED_AGREEMENT = Number(process.env.LIVE_AGREEMENT ?? 0.8);

let engine: TreasuryDecisionEngine;
let live = false;
let modelId: string | null = null;

beforeAll(() => {
  loadEnvLocal();
  const selection = selectDecisionEngine(process.env);
  engine = selection.engine;
  live = selection.live;
  modelId = selection.modelId;

  if (!live) {
    console.warn(`\n  ⚠  Skipping live tier: ${selection.reason}\n`);
  } else {
    console.log(`\n  Live tier against ${modelId}, ${SAMPLES} sample(s) per scenario.\n`);
  }
});

describe("live Workers AI decisions", () => {
  it.each(SCENARIOS)("$id agrees with the expectation", async (scenario) => {
    if (!live) return;

    const expectation = expectationFor(scenario.id);
    const actions: TreasuryAction[] = [];
    const outcomes: string[] = [];
    let agreements = 0;

    for (let sample = 0; sample < SAMPLES; sample++) {
      const run = await runScenario(scenario, engine);

      expect(
        run.decision.engine,
        "model call failed — check credentials and model id",
      ).toBe("LLM");

      const chosen = run.decision.guard.from;
      actions.push(chosen ?? ("INVALID" as TreasuryAction));
      outcomes.push(run.finalOutcome);

      if (
        chosen !== null &&
        expectation.allowedActions.includes(chosen) &&
        expectation.finalOutcomes.includes(run.finalOutcome)
      ) {
        agreements++;
      }
    }

    const rate = agreements / SAMPLES;
    console.log(
      `  ${scenario.id.padEnd(22)} ${Math.round(rate * 100)}% agreement  ` +
        `actions=[${actions.join(", ")}] outcomes=[${outcomes.join(", ")}] expected=[${expectation.allowedActions.join("|")}]`,
    );

    expect(
      rate,
      `${scenario.id}: expected ${expectation.allowedActions.join(" or ")} (${expectation.why}); got ${actions.join(", ")}`,
    ).toBeGreaterThanOrEqual(REQUIRED_AGREEMENT);
  });
});
