/**
 * Restores the treasury to NORMAL. Human-governed recovery, on an explicit click.
 *
 * POST ONLY, AND NEVER ON RENDER. A reset gives autonomy back, so it must not
 * be reachable by a prefetch or a page load. GET is not implemented.
 *
 * THE APPROVER IS RESOLVED FROM CHAIN, not accepted from the caller. An address
 * in a request body is a claim; the roster on the treasury is a fact. The route
 * asks Sui who holds an authorization and whether Move would accept them.
 *
 * A STALE MIRROR IS A REFUSAL, NOT A WORKAROUND. `reset_breaker` takes `now_ms`
 * as a parameter rather than reading the Clock, so a caller COULD pass an old
 * timestamp and slip past the hour-old freshness check. This route always sends
 * the real clock and returns 409 MEMBERSHIP_STALE instead, telling the
 * interface to refresh first. The extra transaction is the honest cost of the
 * rule; defeating it here would make the rule decorative.
 *
 * THE ANSWER COMES FROM THE CHAIN. On success the breaker is RE-READ and the
 * fresh state returned, so NORMAL is only ever rendered because Sui says so.
 */

import { NextResponse } from "next/server";

import { resetBreakerCall } from "@/lib/defense/breakerCalls";
import { readRecoveryRoster } from "@/lib/defense/recoveryApprover";
import { breakerConsequences, readBreakerState } from "@/lib/sui/breakerReader";
import { readBreakerUntil } from "@/lib/sui/awaitBreaker";
import { createSuiQueries } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const nowMs = Date.now();
  const network = configuredNetwork();

  let manifest;
  try {
    manifest = loadManifest(network);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const queries = createSuiQueries(network);
  const treasuryId = manifest.objects.treasuryId;

  // --- is there anything to reset? -----------------------------------------
  const before = await readBreakerState(queries, treasuryId);
  if (before.mode !== "HUMAN_ONLY") {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_TRIPPED",
        error: `The treasury is already ${before.mode}. Nothing was submitted.`,
        breaker: { ...before, consequences: breakerConsequences(before) },
      },
      { status: 409 },
    );
  }

  // --- who may recover, according to the chain ------------------------------
  const roster = await readRecoveryRoster(queries, treasuryId, nowMs);

  if (!roster.eligible) {
    // Stale is a distinct, fixable answer: it names the refresh that resolves
    // it. Anything else is a genuine lack of recovery authority.
    if (roster.refreshable) {
      const ageMinutes = Math.round((roster.refreshable.membershipAgeMs ?? 0) / 60_000);
      return NextResponse.json(
        {
          ok: false,
          code: "MEMBERSHIP_STALE",
          error:
            `The membership verification for ${roster.refreshable.address} is ${ageMinutes} ` +
            "minutes old, past the 60-minute freshness rule. Refresh it and reset again. " +
            "Nothing was submitted.",
          approver: roster.refreshable.address,
          breaker: { ...before, consequences: breakerConsequences(before) },
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        code: "NO_RECOVERY_AUTHORITY",
        error:
          "No approver on this treasury is in good standing, so no human recovery authority " +
          "exists. Nothing was submitted.",
        approvers: roster.approvers.map((entry) => ({
          address: entry.address,
          enabled: entry.enabled,
          membershipActive: entry.membershipActive,
        })),
        breaker: { ...before, consequences: breakerConsequences(before) },
      },
      { status: 409 },
    );
  }

  // --- submit, with the REAL clock ------------------------------------------
  const plan = resetBreakerCall(manifest, roster.eligible.address, nowMs);

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
        breaker: { ...before, consequences: breakerConsequences(before) },
      },
      { status: 502 },
    );
  }

  // RE-READ, WAITING FOR THE INDEX — same hazard as the trip: the GraphQL
  // indexer trails the fullnode, and a single immediate read can return the
  // pre-transaction value.
  let breaker = null;
  let breakerError: string | null = null;
  let converged = false;
  try {
    const outcome = await readBreakerUntil(queries, treasuryId, "NORMAL");
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
      recoveringApprover: roster.eligible.address,
      nowMs,
    },
    breaker,
    breakerError,
    /** False when the write succeeded but the index has not shown it yet. */
    converged,
  });
}
