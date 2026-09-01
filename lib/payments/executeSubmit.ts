/**
 * Submits a payment-path Move call for real.
 *
 * SERVER ONLY. It reaches the keystore the Sui CLI manages, so it must never be
 * imported from a component — the `node:child_process` import would fail the
 * client build. The routes import it lazily for the same reason.
 *
 * IT WILL NOT PRETEND. No simulated branch, no fallback that invents a digest.
 * A Move abort comes back as a failure carrying its code; an unfunded or absent
 * CLI comes back carrying what the CLI said. Neither is ever reported as a
 * settlement, and the interface may only say PAID after re-reading the chain.
 *
 * ONE SUBMITTER FOR THREE CALLS. `execute_payment`, `execute_approved` and
 * `approve_scoped` all want the same behaviour around the CLI — estimate the
 * budget, retry only an estimation failure, never retry an abort — and giving
 * each its own copy is how three code paths end up with two retry policies.
 */

import {
  AUTO_GAS_BUDGET,
  callAllowingAbort,
  describeCliError,
  type CallOptions,
} from "../../scripts/lib/suiCli";
import { explorerTxUrl, type SuiNetwork } from "../sui/deployment";
import type { ExecutePaymentPlan } from "./executeCall";

/** Measured at ~10.0M MIST by dry run; this is headroom, not a reservation. */
const FALLBACK_GAS_BUDGET = "60000000";

/** The shape every submittable plan shares. */
export interface SubmittablePlan {
  packageId: string;
  module: string;
  function: string;
  typeArguments: string[];
  arguments: string[];
}

export interface ExecuteSubmitResult {
  ok: boolean;
  /** Only ever what the chain returned. Null on any failure. */
  digest: string | null;
  explorerUrl: string | null;
  abortCode: number | null;
  error: string | null;
  /** Every object the transaction created, when it created any. */
  created: { objectType: string; objectId: string }[];
}

export function submitExecutePayment(
  plan: ExecutePaymentPlan,
  network: SuiNetwork,
): ExecuteSubmitResult {
  return submitMoveCall(plan, network);
}

export function submitMoveCall(
  plan: SubmittablePlan,
  network: SuiNetwork,
): ExecuteSubmitResult {
  let attempt = submitOnce(plan, network, AUTO_GAS_BUDGET);

  // A Move ABORT is never retried: that is the chain's answer, and asking again
  // could double-submit a payment that actually succeeded.
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
    (text.includes("budget") || text.includes("estimate") || text.includes("dry"))
  );
}

function submitOnce(
  plan: SubmittablePlan,
  network: SuiNetwork,
  gasBudget: CallOptions["gasBudget"],
): ExecuteSubmitResult {
  try {
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
      error: outcome.ok ? null : outcome.error || outcome.raw || "Sui refused the payment.",
      created: createdFrom(outcome.tx),
    };
  } catch (error) {
    return {
      ok: false,
      digest: null,
      explorerUrl: null,
      abortCode: null,
      error: describeCliError(error),
      created: [],
    };
  }
}

/** Object ids the transaction created, so a caller can find what it minted. */
function createdFrom(tx: unknown): { objectType: string; objectId: string }[] {
  const changes = (tx as { objectChanges?: unknown[] } | null | undefined)?.objectChanges ?? [];
  const created: { objectType: string; objectId: string }[] = [];
  for (const change of changes) {
    const row = change as { type?: string; objectType?: string; objectId?: string };
    if (row.type !== "created") continue;
    if (typeof row.objectType !== "string" || typeof row.objectId !== "string") continue;
    created.push({ objectType: row.objectType, objectId: row.objectId });
  }
  return created;
}
