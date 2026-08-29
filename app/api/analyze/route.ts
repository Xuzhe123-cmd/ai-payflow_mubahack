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
import { SCENARIOS, scenarioById } from "@/lib/demo/scenarios";
import { runScenario } from "@/lib/demo/runScenario";

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

  const selection = selectDecisionEngine(process.env);
  const run = await runScenario(scenario, selection.engine);

  return NextResponse.json({
    scenarioId: run.scenarioId,
    asOfDate: run.asOfDate,
    // The engine is surfaced so the UI can never present a fallback as AI.
    engine: run.decision.engine,
    engineNotice: selection.live ? null : selection.reason,
    modelId: run.decision.modelId,
    analysis: run.analysis,
    decision: run.decision.decision,
    guard: run.decision.guard,
    paymentRequest: run.paymentRequest,
    enforcement: run.enforcement,
    finalOutcome: run.finalOutcome,
    steps: run.steps,
  });
}
