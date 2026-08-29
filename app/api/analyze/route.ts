/**
 * Server-side pipeline entry point.
 *
 * The Cloudflare API token must never reach the browser, so the LLM call
 * happens here and nowhere else. This handler is also the seam for the
 * Cloudflare Workers deployment: the body is a plain call into runPipeline(),
 * which has no Next.js dependency.
 */

import { NextResponse } from "next/server";

import { selectDecisionEngine } from "@/lib/ai/engine";
import { createRecordedEngine } from "@/lib/ai/recordedEngine";
import {
  RECORDED_RESPONSES,
  hasRecordingFor,
  readEngineMode,
  type EngineMode,
} from "@/lib/ai/recordings";
import { buildProjection } from "@/lib/deterministic/projection";
import { SCENARIOS, scenarioById } from "@/lib/demo/scenarios";
import { runScenario } from "@/lib/demo/runScenario";
import type { AnalysisResponse } from "@/lib/services/contracts";

export const runtime = "nodejs";
/** Every run calls a model; caching would defeat the point. */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    scenarios: SCENARIOS.map(({ id, name, description }) => ({ id, name, description })),
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const scenarioId =
    typeof body === "object" && body !== null && "scenarioId" in body
      ? (body as { scenarioId: unknown }).scenarioId
      : undefined;

  if (typeof scenarioId !== "string") {
    return NextResponse.json({ error: "scenarioId (string) is required." }, { status: 400 });
  }

  let scenario;
  try {
    scenario = scenarioById(scenarioId);
  } catch {
    return NextResponse.json({ error: `Unknown scenario: ${scenarioId}` }, { status: 404 });
  }

  // Replay is opt-in only. A failed live call still escalates to the safety
  // fallback rather than quietly borrowing a recording.
  const wantsRecorded =
    readEngineMode(process.env) === "recorded" && hasRecordingFor(scenario.id);

  const selection = wantsRecorded
    ? {
        engine: createRecordedEngine(RECORDED_RESPONSES, { keyFor: () => scenario.id }),
        live: true,
        modelId:
          RECORDED_RESPONSES.find((entry) => entry.scenarioId === scenario.id)?.modelId ??
          null,
        reason: null,
      }
    : selectDecisionEngine(process.env);

  const run = await runScenario(scenario, selection.engine);

  const engineMode: EngineMode =
    run.decision.engine === "FALLBACK" ? "fallback" : wantsRecorded ? "recorded" : "live";

  // Display-only projection, built from the same forecast the decision used so
  // the chart and the recommendation can never disagree.
  const projection = buildProjection({
    world: scenario.world,
    asOf: scenario.asOfDate,
    payment: {
      amountCents: run.analysis.invoiceFacts.amountCents,
      dates: run.analysis.cashFlowScenarios.map((candidate) => candidate.paymentDate),
    },
  });

  const payload: AnalysisResponse = {
    scenarioId: run.scenarioId,
    scenario: {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
    },
    asOfDate: run.asOfDate,
    // The engine is surfaced so the UI can never present a fallback as AI.
    engine: run.decision.engine,
    engineMode,
    engineNotice: selection.live ? null : selection.reason,
    modelId: run.decision.modelId,
    latencyMs: run.decision.latencyMs,
    document: scenario.document,
    analysis: run.analysis,
    decision: run.decision.decision,
    guard: run.decision.guard,
    projection,
    paymentRequest: run.paymentRequest,
    enforcement: run.enforcement,
    finalOutcome: run.finalOutcome,
    steps: run.steps,
  };

  return NextResponse.json(payload);
}
