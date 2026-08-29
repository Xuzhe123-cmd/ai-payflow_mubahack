/**
 * Runs all eight scenarios through the production pipeline and prints a table.
 *
 *   npm run scenarios              # live model when credentials are present
 *   npm run scenarios -- --replay  # recorded responses, no network
 *
 * The point of the table is to show that the SAME pipeline reaches DIFFERENT
 * decisions purely from the input data — so it prints the engine that decided
 * and the model's own reasoning, not just the outcome.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectDecisionEngine } from "../lib/ai/engine";
import { createRecordedEngine, type RecordedResponse } from "../lib/ai/recordedEngine";
import { SCENARIOS } from "../lib/demo/scenarios";
import { runScenario } from "../lib/demo/runScenario";
import type { PipelineRun, TreasuryDecisionEngine } from "../lib/types";
import { loadEnvLocal } from "./loadEnv";

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/llm");

function loadRecordings(): RecordedResponse[] {
  return SCENARIOS.flatMap((scenario) => {
    const path = resolve(FIXTURE_DIR, `${scenario.id}.json`);
    if (!existsSync(path)) return [];
    return [JSON.parse(readFileSync(path, "utf8")) as RecordedResponse];
  });
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function outcomeMarker(run: PipelineRun): string {
  switch (run.finalOutcome) {
    case "EXECUTED":
      return "PAID";
    case "SCHEDULED":
      return "SCHEDULED";
    case "SUI_REJECT":
      return "SUI REJECT";
    case "REJECTED":
      return "REJECTED";
    default:
      return "REVIEW";
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const replay = process.argv.includes("--replay");
  let engine: TreasuryDecisionEngine;
  let engineLabel: string;

  if (replay) {
    const recordings = loadRecordings();
    if (recordings.length === 0) {
      console.error(
        `No recordings in ${FIXTURE_DIR}. Run "npm run record:llm" first, or drop --replay to call the live model.`,
      );
      process.exit(1);
    }
    engine = createRecordedEngine(recordings, { keyFor: () => currentScenarioId });
    engineLabel = `replay (${recordings.length} recordings, ${recordings[0].modelId})`;
  } else {
    const selection = selectDecisionEngine(process.env);
    engine = selection.engine;
    engineLabel = selection.live
      ? `live Workers AI (${selection.modelId})`
      : `FALLBACK — ${selection.reason}`;
    if (!selection.live) {
      console.warn(
        "\n  ⚠  No Cloudflare credentials found. Every scenario will be escalated by the\n" +
          "     safety fallback rather than decided by the AI. This is not an AI demo run.\n",
      );
    }
  }

  console.log(`\nAI PayFlow — scenario suite`);
  console.log(`Engine: ${engineLabel}\n`);

  const header = [
    pad("SCENARIO", 22),
    pad("ENGINE", 9),
    pad("AI ACTION", 13),
    pad("DATE", 11),
    pad("RISK", 9),
    pad("URGENCY", 9),
    pad("CONF", 5),
    pad("FINAL", 11),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  const runs: PipelineRun[] = [];

  for (const scenario of SCENARIOS) {
    currentScenarioId = scenario.id;
    const run = await runScenario(scenario, engine);
    runs.push(run);

    console.log(
      [
        pad(scenario.id, 22),
        pad(run.decision.engine, 9),
        pad(run.decision.decision.action, 13),
        pad(run.decision.decision.recommendedDate ?? "—", 11),
        pad(run.decision.decision.risk, 9),
        pad(run.decision.decision.urgency, 9),
        pad(run.decision.decision.confidence.toFixed(2), 5),
        pad(outcomeMarker(run), 11),
      ].join(" "),
    );
  }

  console.log("\n\nReasoning\n" + "=".repeat(60));
  for (const run of runs) {
    const scenario = SCENARIOS.find((s) => s.id === run.scenarioId)!;
    console.log(`\n${scenario.name} (${scenario.id})`);
    console.log(`  AI: ${run.decision.decision.decisionExplanation}`);
    if (run.decision.decision.cashFlowExplanation) {
      console.log(`  Cash flow: ${run.decision.decision.cashFlowExplanation}`);
    }
    for (const reason of run.decision.decision.reasons) {
      console.log(`    - ${reason}`);
    }
    if (run.decision.guard.downgraded) {
      console.log(
        `  ⚠ Guard downgraded from ${run.decision.guard.from ?? "invalid output"}: ` +
          run.decision.guard.violations.map((v) => v.code).join(", "),
      );
    }
    if (run.enforcement && run.enforcement.outcome === "SUI_REJECT") {
      console.log(
        `  ⛔ Sui rejected execution: ${run.enforcement.violations.map((v) => `${v.code} — ${v.detail}`).join("; ")}`,
      );
    }
  }
  console.log();
}

// The recorded engine keys off the scenario currently being run.
let currentScenarioId = "";

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
