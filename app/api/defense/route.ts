/**
 * The defense screen's state: providers, behaviour, anomaly, and the breaker.
 *
 * GET reads and computes; it never writes. The breaker's mode comes from the
 * chain on every request — `force-dynamic`, no cache — because a cached
 * security state is a stale one, and this is the single fact the interface is
 * not allowed to guess.
 *
 * THE ATTACK SIMULATION IS A QUERY PARAMETER, not a stored state. Passing
 * `?simulate=attack` scores a synthetic pattern and returns the result; it
 * writes nothing, remembers nothing, and touches no chain state. Reloading
 * without the parameter returns the ordinary picture again.
 */

import { NextResponse } from "next/server";

import { assessAnomaly } from "@/lib/defense/anomaly";
import {
  buildAttackPattern,
  buildNormalPattern,
  ATTACK_DISCLAIMER,
} from "@/lib/defense/attackSimulation";
import { computeBehaviorStats, deriveBaseline } from "@/lib/defense/behaviorStats";
import { checkProviders, bothConnected } from "@/lib/ai/providerHealth";
import { invoiceCatalog } from "@/lib/demo/invoiceCatalog";
import { CONSENSUS_GRANTS_NOTHING } from "@/lib/ai/providers";
import { breakerConsequences, readBreakerState } from "@/lib/sui/breakerReader";
import { PAYMENT_HISTORY } from "@/lib/demo/paymentHistory";
import { APPROVER_AUTHORITY } from "@/lib/demo/policies";
import { createSuiQueries } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The trailing window the monitor reports on. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const simulating = url.searchParams.get("simulate") === "attack";
  // Injected so the whole response describes ONE instant.
  const nowMs = Date.now();

  const baseline = deriveBaseline(
    PAYMENT_HISTORY,
    APPROVER_AUTHORITY.maxSinglePaymentCents,
    420_000,
  );
  const events = simulating
    ? buildAttackPattern(nowMs).events
    : buildNormalPattern(nowMs);

  const stats = computeBehaviorStats(events, baseline, nowMs, WINDOW_MS);
  const anomaly = assessAnomaly(stats, baseline);

  // Liveness only — a real round trip per provider, but no inference. The
  // opinions themselves come from /api/defense/analyze, which costs two real
  // model calls and must not block this screen from rendering.
  const health = await checkProviders();

  // What may be selected for analysis. Derived from the scenarios, so the
  // selector cannot offer an invoice the pipeline could not analyze.
  const catalog = await invoiceCatalog();

  // --- the chain's own answer ------------------------------------------------
  let breaker = null;
  let breakerError: string | null = null;
  try {
    const manifest = loadManifest(configuredNetwork());
    const state = await readBreakerState(
      createSuiQueries(configuredNetwork()),
      manifest.objects.treasuryId,
    );
    breaker = { ...state, consequences: breakerConsequences(state) };
  } catch (error) {
    // Reported as unknown. Never defaulted to ARMED, which would claim a
    // protection nobody verified.
    breakerError =
      error instanceof MissingDeploymentError
        ? error.message
        : error instanceof Error
          ? error.message
          : "The chain could not be read.";
  }

  return NextResponse.json({
    ok: true,
    simulating,
    disclaimer: simulating ? ATTACK_DISCLAIMER : null,
    nowMs,
    health,
    bothConnected: bothConnected(health),
    catalog,
    consensusCaveat: CONSENSUS_GRANTS_NOTHING,
    baseline,
    stats,
    anomaly,
    breaker,
    breakerError,
  });
}
