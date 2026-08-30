/**
 * Shared helper: run one demo scenario through the production pipeline.
 *
 * Used by the CLI scripts and the test suite so that every caller exercises the
 * identical path — nothing gets a special-cased shortcut.
 */

import type { PipelineOptions } from "../pipeline";
import type { PipelineRun, Scenario, TreasuryDecisionEngine } from "../types";
import { runPipeline } from "../pipeline";

export interface RunScenarioOptions extends PipelineOptions {
  /** Submit under the agent's own capability — see PipelineInput. */
  forceAgentAuthority?: boolean;
}

export function runScenario(
  scenario: Scenario,
  engine: TreasuryDecisionEngine,
  options: RunScenarioOptions = {},
): Promise<PipelineRun> {
  const { forceAgentAuthority, ...pipelineOptions } = options;
  return runPipeline(
    {
      scenarioId: scenario.id,
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
      engine,
      forceAgentAuthority,
    },
    pipelineOptions,
  );
}
