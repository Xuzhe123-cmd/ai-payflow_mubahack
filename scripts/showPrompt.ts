/**
 * Prints the exact fact sheet a scenario produces for the model.
 *
 *   npm run prompt -- s2_cashflow
 *
 * Useful when tuning: the prompt is pure and deterministic, so what you see
 * here is byte-for-byte what Workers AI receives.
 */

import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { SYSTEM_PROMPT, buildUserMessage } from "../lib/ai/prompt";
import { SCENARIOS, scenarioById } from "../lib/demo/scenarios";

async function main(): Promise<void> {
  const id = process.argv[2] ?? SCENARIOS[0].id;
  const scenario = scenarioById(id);

  const analysis = await buildAnalysis({
    document: scenario.document,
    world: scenario.world,
    asOf: scenario.asOfDate,
  });

  if (process.argv.includes("--system")) {
    console.log("===== SYSTEM =====\n");
    console.log(SYSTEM_PROMPT);
    console.log();
  }

  console.log(`===== USER (${scenario.id}) =====\n`);
  console.log(buildUserMessage(analysis));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
