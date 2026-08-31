/**
 * The circuit-breaker transactions, built and nothing more.
 *
 * Pure, so the argument order can be tested without a chain or a keystore. What
 * these calls DO is decided by Move; what they are allowed to claim is decided
 * by the caller, and neither is decided here.
 *
 * THE DEMO PATH IS A DRY RUN. `SIMULATE AI ATTACK` builds the trip call and
 * asks Sui to evaluate it without executing — the same preflight discipline the
 * $30,000 approval uses. That proves the transaction is well-formed and would
 * be accepted, and it proves it without spending gas or freezing a live
 * treasury mid-demo. A real trip is the same call with the dry run removed, and
 * it needs the owner capability.
 */

import type { DeploymentManifest } from "../sui/deployment";
import { callPackageId } from "../sui/deployment";

/** `0x6` is the shared Clock. Not used by the breaker calls, which take now_ms. */
export interface BreakerCallPlan {
  packageId: string;
  module: "treasury";
  function: "init_breaker" | "trip_breaker" | "reset_breaker";
  typeArguments: string[];
  arguments: string[];
  label: string;
  /** What this would change on chain, in one line, for a confirmation prompt. */
  effect: string;
}

/**
 * Installs the breaker, armed.
 *
 * Idempotent in Move, so running it twice is harmless — but it is still a
 * transaction and still needs the owner capability.
 */
export function initBreakerCall(manifest: DeploymentManifest): BreakerCallPlan {
  return {
    packageId: callPackageId(manifest),
    module: "treasury",
    function: "init_breaker",
    typeArguments: [manifest.coinType],
    arguments: [manifest.objects.treasuryId, requireOwnerCap(manifest)],
    label: "Install the circuit breaker (armed, NORMAL mode)",
    effect:
      "Adds a CircuitBreaker dynamic field to the treasury in NORMAL mode. Changes no limit " +
      "and blocks no payment.",
  };
}

/**
 * Freezes autonomy.
 *
 * The score and reason are EVIDENCE written alongside the mode — Move records
 * them and never reads them back to decide anything. They exist so an operator
 * opening the object later can see why the treasury was frozen.
 */
export function tripBreakerCall(
  manifest: DeploymentManifest,
  anomalyScore: number,
  reasonCode: string,
  nowMs: number,
): BreakerCallPlan {
  if (!Number.isInteger(anomalyScore) || anomalyScore < 0 || anomalyScore > 100) {
    // The Move parameter is a u8 and the scale is 0..100. A caller passing
    // something else is a bug, and silently clamping it would hide the bug in
    // the one record meant to explain the freeze.
    throw new RangeError(`Anomaly score must be an integer 0..100, got ${anomalyScore}`);
  }

  return {
    packageId: callPackageId(manifest),
    module: "treasury",
    function: "trip_breaker",
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      requireOwnerCap(manifest),
      String(anomalyScore),
      reasonCode,
      String(nowMs),
    ],
    label: "Trip the circuit breaker — treasury enters HUMAN_ONLY",
    effect:
      "Sets treasury mode to HUMAN_ONLY. Autonomous and conditional payments abort with 115 " +
      "ECircuitBreakerActive until a human-authorised reset. Moves no funds and changes no limit.",
  };
}

/**
 * Restores autonomy. Needs a human the company still vouches for.
 *
 * `recoveringApprover` is checked by Move against the Phase 1 authorization —
 * enabled, unexpired, membership-active and membership-fresh. Passing an
 * address that fails any of those aborts 117, which is the point: the reset is
 * deliberately harder than the trip.
 */
export function resetBreakerCall(
  manifest: DeploymentManifest,
  recoveringApprover: string,
  nowMs: number,
): BreakerCallPlan {
  return {
    packageId: callPackageId(manifest),
    module: "treasury",
    function: "reset_breaker",
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      requireOwnerCap(manifest),
      recoveringApprover,
      String(nowMs),
    ],
    label: "Reset the circuit breaker — restore NORMAL mode",
    effect:
      "Returns treasury mode to NORMAL. Requires a live, membership-verified approver; the " +
      "trip history is kept.",
  };
}

function requireOwnerCap(manifest: DeploymentManifest): string {
  const cap = manifest.objects.treasuryOwnerCapId;
  if (!cap) {
    throw new Error(
      "The deployment manifest records no TreasuryOwnerCap, so no breaker transaction can be built.",
    );
  }
  return cap;
}

/** Renders the CLI command, for a report that has to be checkable by hand. */
export function renderBreakerPlan(plan: BreakerCallPlan): string {
  return [
    "sui client call",
    `--package ${plan.packageId}`,
    `--module ${plan.module}`,
    `--function ${plan.function}`,
    `--type-args ${plan.typeArguments.join(" ")}`,
    `--args ${plan.arguments.map((arg) => JSON.stringify(arg)).join(" ")}`,
  ].join(" ");
}
