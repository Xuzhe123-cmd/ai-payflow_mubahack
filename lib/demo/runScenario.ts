/**
 * Shared helper: run one demo scenario through the production pipeline.
 *
 * Used by the CLI scripts and the test suite so that every caller exercises the
 * identical path — nothing gets a special-cased shortcut.
 */

import type { PipelineOptions } from "../pipeline";
import type { PipelineRun, Scenario, TreasuryDecisionEngine } from "../types";
import { runPipeline } from "../pipeline";

export function runScenario(
  scenario: Scenario,
  engine: TreasuryDecisionEngine,
  options: PipelineOptions = {},
): Promise<PipelineRun> {
  return runPipeline(
    {
      scenarioId: scenario.id,
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
      engine,
    },
    options,
  );
}
