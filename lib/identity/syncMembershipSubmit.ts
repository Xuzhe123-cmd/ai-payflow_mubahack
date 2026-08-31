/**
 * Submits `approval::sync_membership` for real.
 *
 * SERVER ONLY. It reaches the keystore the Sui CLI manages through
 * `scripts/lib/suiCli`, so it must never be imported from a component — the
 * `node:child_process` import would fail the client build, which is a crude but
 * effective guard on top of the deliberate one. The route imports it lazily for
 * the same reason.
 *
 * IT WILL NOT PRETEND. There is no simulated branch here and no fallback that
 * invents a digest: a call that aborts comes back as a failure carrying the
 * abort code, a CLI that is missing or unfunded comes back as a failure
 * carrying what the CLI said, and neither is reported as a refreshed
 * verification. The button above it is only allowed to say "verified" when this
 * returns a digest the chain issued.
 */

import {
  AUTO_GAS_BUDGET,
  callAllowingAbort,
  describeCliError,
  type CallOptions,
} from "../../scripts/lib/suiCli";
import { explorerTxUrl, type SuiNetwork } from "../sui/deployment";
import type { SyncMembershipPlan } from "./syncMembershipCall";

export interface SyncMembershipResult {
  ok: boolean;
  /** Only ever what the chain returned. Null on any failure. */
  digest: string | null;
  explorerUrl: string | null;
  /** The Move abort code, when the failure was an abort. */
  abortCode: number | null;
  /** The real message, never a friendly substitute. */
  error: string | null;
}

/**
 * The budget to fall back to when estimation cannot run.
 *
 * 0.02 SUI, against a measured cost of ~0.0031 SUI — roughly six times the real
 * price, which is headroom for a gas-price move rather than a reservation the
 * wallet has to be rich enough to satisfy. The 0.5 SUI default this replaces
 * was sized for publishing a package, and demanding a 0.5 SUI coin for a
 * 0.003 SUI call is what broke gas selection on a wallet of small coins.
 */
const FALLBACK_GAS_BUDGET = "20000000";

export function submitSyncMembership(
  plan: SyncMembershipPlan,
  network: SuiNetwork,
): SyncMembershipResult {
  // ESTIMATE FIRST. The CLI dry-runs the call and executes with the real cost,
  // so the reservation matches the transaction instead of the largest one in
  // the repo. Any coin that covers a few million MIST can pay for it.
  let attempt = submitOnce(plan, network, AUTO_GAS_BUDGET);

  // Estimation needs a working dry run, and a failure there is not a refusal of
  // the transaction — it is the CLI declining to guess. Retried once with an
  // explicit modest budget, which still selects gas from any ordinary coin.
  // A Move ABORT is never retried: that is the chain's answer, and asking again
  // with a different budget would only spend gas to hear it twice.
  if (!attempt.ok && attempt.abortCode === null && looksLikeBudgetTrouble(attempt.error)) {
    attempt = submitOnce(plan, network, FALLBACK_GAS_BUDGET);
  }

  return attempt;
}

/** Whether a failure is about sizing the budget rather than about the call. */
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
  plan: SyncMembershipPlan,
  network: SuiNetwork,
  gasBudget: CallOptions["gasBudget"],
): SyncMembershipResult {
  try {
    // `callAllowingAbort` rather than `call`: an abort here is information the
    // interface should show — 114 EWrongCompany, say — not an exception to
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
      error: outcome.ok
        ? null
        : outcome.error || outcome.raw || "Sui refused the membership refresh.",
    };
  } catch (error) {
    // A thrown error is still a failure, not an unknown. Reported with the
    // CLI's own words so a missing binary reads as a missing binary.
    return {
      ok: false,
      digest: null,
      explorerUrl: null,
      abortCode: null,
      error: describeCliError(error),
    };
  }
}
