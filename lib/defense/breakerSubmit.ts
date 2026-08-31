/**
 * Submits `treasury::trip_breaker` for real.
 *
 * SERVER ONLY. It reaches the keystore the Sui CLI manages, so it must never be
 * imported from a component — the `node:child_process` import would fail the
 * client build, which is a crude but effective guard on top of the deliberate
 * one. The route imports it lazily for the same reason.
 *
 * IT WILL NOT PRETEND. There is no simulated branch and no fallback that
 * invents a digest: a call that aborts comes back as a failure carrying the
 * abort code, a CLI that is missing or unfunded comes back carrying what the
 * CLI said, and neither is reported as a tripped breaker. The interface above
 * it may only say TRIPPED after re-reading the chain — never because this
 * returned.
 */

import {
  AUTO_GAS_BUDGET,
  callAllowingAbort,
  describeCliError,
  type CallOptions,
} from "../../scripts/lib/suiCli";
import { explorerTxUrl, type SuiNetwork } from "../sui/deployment";
import type { BreakerCallPlan } from "./breakerCalls";

/**
 * The budget to fall back to when estimation cannot run.
 *
 * 0.02 SUI, against a measured cost of ~0.003 SUI. Headroom for a gas-price
 * move rather than a reservation the wallet has to be rich enough to satisfy.
 */
const FALLBACK_GAS_BUDGET = "20000000";

export interface BreakerSubmitResult {
  ok: boolean;
  /** Only ever what the chain returned. Null on any failure. */
  digest: string | null;
  explorerUrl: string | null;
  /** The Move abort code, when the failure was an abort. */
  abortCode: number | null;
  /** The real message, never a friendly substitute. */
  error: string | null;
}

export function submitBreakerCall(
  plan: BreakerCallPlan,
  network: SuiNetwork,
): BreakerSubmitResult {
  // ESTIMATE FIRST, so the reservation matches the transaction rather than the
  // largest call in the repo. Any ordinary coin can pay for it.
  let attempt = submitOnce(plan, network, AUTO_GAS_BUDGET);

  // Estimation needs a working dry run, and a failure there is not a refusal of
  // the transaction — it is the CLI declining to guess. A Move ABORT is never
  // retried: that is the chain's answer, and asking again with a different
  // budget would only spend gas to hear it twice, or double-submit a call that
  // actually succeeded.
  if (!attempt.ok && attempt.abortCode === null && looksLikeBudgetTrouble(attempt.error)) {
    attempt = submitOnce(plan, network, FALLBACK_GAS_BUDGET);
  }

  return attempt;
}

function looksLikeBudgetTrouble(error: string | null): boolean {
  if (!error) return false;
  const text = error.toLowerCase();
  return (
    text.includes("gas") &&
    (text.includes("budget") ||
      text.includes("estimate") ||
      text.includes("dry run") ||
      text.includes("dry-run"))
  );
}

function submitOnce(
  plan: BreakerCallPlan,
  network: SuiNetwork,
  gasBudget: CallOptions["gasBudget"],
): BreakerSubmitResult {
  try {
    // `callAllowingAbort` rather than `call`: an abort here is information the
    // interface should show — 116 EBreakerNotReady, say — not an exception to
    // unwind into a stack trace.
    const outcome = callAllowingAbort({
      packageId: plan.packageId,
      module: plan.module,
      function: plan.function,
      typeArgs: plan.typeArguments,
      args: plan.arguments,
      gasBudget,
    });

    return {
      ok: outcome.ok,
      digest: outcome.digest ?? null,
      explorerUrl: outcome.digest ? explorerTxUrl(outcome.digest, network) : null,
      abortCode: outcome.abort?.code ?? null,
      error: outcome.ok ? null : outcome.error || outcome.raw || "Sui refused the transaction.",
    };
  } catch (error) {
    // A thrown error is still a failure, not an unknown.
    return {
      ok: false,
      digest: null,
      explorerUrl: null,
      abortCode: null,
      error: describeCliError(error),
    };
  }
}
