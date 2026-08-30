/**
 * Server-side pipeline entry point.
 *
 * The Cloudflare API token must never reach the browser, so the LLM call
 * happens here and nowhere else. This handler is also the seam for the
 * Cloudflare Workers deployment: the body is a plain call into runPipeline(),
 * which has no Next.js dependency.
 */

import { NextResponse } from "next/server";

import { resolveInvoiceSource } from "@/lib/demo/invoiceSource";

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
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { worldFromChain } from "@/lib/sui/chainWorld";
import { createSuiQueries } from "@/lib/sui/client";
import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";
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

  // A scenario, or a conditional invoice created on chain after the seed. Both
  // resolve to a document, a world and an as-of date; nothing downstream needs
  // to know which kind it got.
  const source = resolveInvoiceSource(scenarioId);
  if (!source) {
    return NextResponse.json({ error: `Unknown invoice: ${scenarioId}` }, { status: 404 });
  }
  const scenario = {
    id: source.id,
    name: source.scenarioName,
    description: source.description,
    document: source.document,
    world: source.world,
    asOfDate: source.asOf,
  };

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

  // Prefer the live treasury. The scenario still supplies the invoice DOCUMENT
  // — the chain holds no document text — but every figure that decides the
  // payment comes from testnet: balances, limits, supplier status, registered
  // wallets, and which invoices are already settled.
  //
  // Falling back to the fixture world keeps the app runnable with no
  // deployment, and the response says which one was used rather than leaving it
  // to be inferred.
  let world = scenario.world;
  let worldSource: "chain" | "fixture" = "fixture";
  try {
    const network = configuredNetwork();
    const snapshot = await readChainSnapshot(createSuiQueries(network), loadManifest(network));
    world = worldFromChain(snapshot);
    worldSource = "chain";
  } catch {
    // Left as the fixture world; reported below.
  }

  const run = await runScenario({ ...scenario, world }, selection.engine);

  const engineMode: EngineMode =
    run.decision.engine === "FALLBACK" ? "fallback" : wantsRecorded ? "recorded" : "live";

  // Display-only projection, built from the same forecast the decision used so
  // the chart and the recommendation can never disagree.
  const projection = buildProjection({
    world,
    asOf: scenario.asOfDate,
    payment: {
      amountCents: run.analysis.invoiceFacts.amountCents,
      dates: run.analysis.cashFlowScenarios.map((candidate) => candidate.paymentDate),
    },
  });

  const payload: AnalysisResponse = {
    worldSource,
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
    engineNotice: selection.live ? (run.decision.engineFailure ?? null) : selection.reason,
    modelId: run.decision.modelId,
    latencyMs: run.decision.latencyMs,
    document: scenario.document,
    analysis: run.analysis,
    decision: run.decision.decision,
    guard: run.decision.guard,
    projection,
    recommendation: run.recommendation,
    paymentRequest: run.paymentRequest,
    enforcement: run.enforcement,
    finalOutcome: run.finalOutcome,
    steps: run.steps,
  };

  return NextResponse.json(payload);
}
