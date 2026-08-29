/**
 * Captures real Workers AI responses for the replay test tier.
 *
 *   npm run record:llm            # all scenarios
 *   npm run record:llm s2_cashflow s5_wallet_mismatch
 *
 * The recordings are verbatim model output. Replaying them keeps CI
 * deterministic without pretending an LLM ran — the decisions really are the
 * model's, just captured at record time.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectDecisionEngine } from "../lib/ai/engine";
import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { SCENARIOS } from "../lib/demo/scenarios";
import type { RecordedResponse } from "../lib/ai/recordedEngine";
import { loadEnvLocal } from "./loadEnv";

const OUTPUT_DIR = resolve(process.cwd(), "tests/fixtures/llm");

async function main(): Promise<void> {
  loadEnvLocal();

  const selection = selectDecisionEngine(process.env);
  if (!selection.live) {
    console.error(
      `Cannot record: ${selection.reason}\nAdd CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to .env.local.`,
    );
    process.exit(1);
  }

  const filter = new Set(process.argv.slice(2));
  const targets = filter.size > 0 ? SCENARIOS.filter((s) => filter.has(s.id)) : SCENARIOS;
  if (targets.length === 0) {
    console.error(`No scenarios matched: ${[...filter].join(", ")}`);
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Recording ${targets.length} scenario(s) against ${selection.modelId}\n`);

  let failures = 0;

  for (const scenario of targets) {
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const result = await selection.engine.decide(analysis);

    if (result.engine === "FALLBACK" || result.rawModelOutput === null) {
      console.error(`  ✗ ${scenario.id}: model call failed — ${result.decision.reasons.join(" ")}`);
      failures++;
      continue;
    }

    const recording: RecordedResponse = {
      scenarioId: scenario.id,
      modelId: result.modelId ?? selection.modelId ?? "unknown",
      recordedAt: new Date().toISOString(),
      raw: result.rawModelOutput,
    };

    writeFileSync(
      resolve(OUTPUT_DIR, `${scenario.id}.json`),
      `${JSON.stringify(recording, null, 2)}\n`,
      "utf8",
    );

    const guardNote = result.guard.downgraded
      ? ` (guard downgraded from ${result.guard.from ?? "invalid output"})`
      : "";
    console.log(
      `  ✓ ${scenario.id.padEnd(22)} ${result.decision.action.padEnd(13)} risk ${result.decision.risk.padEnd(8)} ${result.latencyMs}ms${guardNote}`,
    );
  }

  console.log(`\nWrote recordings to ${OUTPUT_DIR}`);
  if (failures > 0) {
    console.error(`${failures} scenario(s) failed to record.`);
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
