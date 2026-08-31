/**
 * Trips the on-chain circuit breaker. The real transaction, on an explicit click.
 *
 * POST ONLY, AND NEVER ON RENDER. This freezes a treasury and spends gas, so it
 * must not be reachable by a prefetch, a crawler, or a browser's speculative
 * fetch. GET is not implemented on purpose.
 *
 * THE SCORE IS RECOMPUTED HERE, NOT ACCEPTED FROM THE CALLER. This is the part
 * that matters. The client sends no score and no reason: this route rebuilds
 * the same deterministic attack pattern, runs the same statistics and the same
 * scorer the monitor uses, and refuses outright if the result is below the trip
 * threshold. A caller cannot freeze the treasury with a number it made up, and
 * the figure recorded on chain is always the engine's own.
 *
 * IT DOES NOT DECIDE, EITHER. Move still requires the TreasuryOwnerCap, which
 * is what makes this an operator acting on the engine's finding rather than the
 * engine acting by itself. The anomaly score is evidence written alongside the
 * mode; Move never reads it back.
 *
 * THE ANSWER COMES FROM THE CHAIN. On success the breaker is RE-READ and the
 * fresh state returned, so the interface renders what Sui holds rather than
 * what this route hoped. A failure returns the real error and the state is
 * left exactly as it was.
 */

import { NextResponse } from "next/server";

import { assessAnomaly } from "@/lib/defense/anomaly";
import { buildAttackPattern } from "@/lib/defense/attackSimulation";
import { computeBehaviorStats, deriveBaseline } from "@/lib/defense/behaviorStats";
import { tripBreakerCall } from "@/lib/defense/breakerCalls";
import { breakerConsequences } from "@/lib/sui/breakerReader";
import { readBreakerUntil } from "@/lib/sui/awaitBreaker";
import { PAYMENT_HISTORY } from "@/lib/demo/paymentHistory";
import { APPROVER_AUTHORITY } from "@/lib/demo/policies";
import { createSuiQueries } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same trailing window the monitor reports on. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST() {
  const nowMs = Date.now();

  // --- the engine's own finding, recomputed ---------------------------------
  const baseline = deriveBaseline(
    PAYMENT_HISTORY,
    APPROVER_AUTHORITY.maxSinglePaymentCents,
    420_000,
  );
  const stats = computeBehaviorStats(
    buildAttackPattern(nowMs).events,
    baseline,
    nowMs,
    WINDOW_MS,
  );
  const anomaly = assessAnomaly(stats, baseline);

  if (!anomaly.exceedsThreshold) {
    // The button is only offered when the engine says trip; this is the same
    // rule enforced where it cannot be skipped by a hand-made request.
    return NextResponse.json(
      {
        ok: false,
        code: "BELOW_THRESHOLD",
        error:
          `The anomaly score is ${anomaly.score}, below the ${anomaly.threshold} trip ` +
          "threshold. Nothing was submitted.",
        anomaly,
      },
      { status: 409 },
    );
  }

  // The dominant signal, named from the assessment rather than chosen here.
  const reasonCode = anomaly.reasonCodes[0] ?? "BEHAVIORAL_ANOMALY";

  let plan;
  const network = configuredNetwork();
  try {
    plan = tripBreakerCall(loadManifest(network), anomaly.score, reasonCode, nowMs);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // Loaded here, not at module scope: it pulls in the CLI wrapper and
  // `node:child_process` with it.
  const { submitBreakerCall } = await import("@/lib/defense/breakerSubmit");
  const result = submitBreakerCall(plan, network);

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "SUBMIT_FAILED",
        error: result.error,
        abortCode: result.abortCode,
        anomaly,
      },
      { status: 502 },
    );
  }

  // RE-READ, WAITING FOR THE INDEX. The interface may only say TRIPPED because
  // the chain says so — but the read goes through the GraphQL indexer, which
  // trails the fullnode by a second or two. Reading once, immediately, returned
  // the PRE-trip value and made a successful freeze render as ARMED.
  let breaker = null;
  let breakerError: string | null = null;
  let converged = false;
  try {
    const manifest = loadManifest(network);
    const outcome = await readBreakerUntil(
      createSuiQueries(network),
      manifest.objects.treasuryId,
      "HUMAN_ONLY",
    );
    converged = outcome.converged;
    breaker = { ...outcome.state, consequences: breakerConsequences(outcome.state) };
  } catch (error) {
    breakerError = error instanceof Error ? error.message : "The chain could not be re-read.";
  }

  return NextResponse.json({
    ok: true,
    digest: result.digest,
    explorerUrl: result.explorerUrl,
    submitted: {
      call: `${plan.module}::${plan.function}`,
      anomalyScore: anomaly.score,
      reasonCode,
      nowMs,
    },
    breaker,
    breakerError,
    /**
     * Whether the re-read caught up to the transaction.
     *
     * False means the write succeeded (there is a digest) and the index has not
     * shown it yet. The interface must say that, rather than rendering the
     * stale state as though the trip had not happened.
     */
    converged,
  });
}
