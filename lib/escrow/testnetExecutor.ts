/**
 * Real submission, through the server's own Sui CLI access.
 *
 * SERVER ONLY. This module reaches the keystore the CLI manages, so it must
 * never be imported from a component — the import of `node:child_process` deep
 * in the CLI wrapper would fail the client build, which is a crude but
 * effective guard on top of the deliberate one.
 *
 * It reuses scripts/lib/suiCli rather than growing a second CLI wrapper. That
 * file already handles the things that have actually bitten this project: the
 * CLI writing errors to stdout, Node truncating `error.message`, aborts arriving
 * in three different textual formats. A fresh implementation would rediscover
 * all of it.
 *
 * WHAT THIS WILL NOT DO. It will not submit when the guards refuse, and it will
 * not return a digest it did not receive. A failed call comes back as a failure
 * with the abort code — never as a success with a plausible-looking hash.
 */

import {
  callAllowingAbort,
  createdObjects,
  describeCliError,
  dryRunCall,
  gasChargedMist,
  type CallOptions,
} from "../../scripts/lib/suiCli";
import { explorerTxUrl, type SuiNetwork } from "../sui/deployment";
import type { MoveCallPlan } from "./calls";
import type { GuardResult } from "./guards";
import { refusedResult, type EscrowExecutor, type ExecutionResult } from "./executor";

function toCallOptions(plan: MoveCallPlan): CallOptions {
  return {
    packageId: plan.packageId,
    module: plan.module,
    function: plan.function,
    typeArgs: plan.typeArguments,
    args: plan.arguments,
  };
}

/**
 * Submits for real.
 *
 * `callAllowingAbort` is used rather than `call` because a Move abort is
 * information this demo exists to show, not an exception to unwind — a release
 * refused by the chain should surface its code, not a stack trace.
 */
export function createTestnetExecutor(network: SuiNetwork): EscrowExecutor {
  return {
    mode: "testnet",

    async submit(plan: MoveCallPlan, guard: GuardResult): Promise<ExecutionResult> {
      // The guards are not advisory here. A refusal stops the submission.
      if (!guard.ok) return refusedResult(plan, guard, "testnet");

      try {
        const outcome = callAllowingAbort(toCallOptions(plan));

        return {
          mode: "testnet",
          ok: outcome.ok,
          // Only ever what the chain returned.
          digest: outcome.digest ?? null,
          status: outcome.ok ? "success" : "failure",
          created: createdObjects(outcome.tx).map((entry) => ({
            type: entry.objectType,
            objectId: entry.objectId,
          })),
          explorerUrl: outcome.digest ? explorerTxUrl(outcome.digest, network) : null,
          error: outcome.ok ? null : outcome.error || outcome.raw || "the call was refused on chain",
          abortCode: outcome.abort?.code ?? null,
          guard,
          plan,
        };
      } catch (error) {
        return {
          mode: "testnet",
          ok: false,
          digest: null,
          status: null,
          created: [],
          explorerUrl: null,
          error: describeCliError(error),
          abortCode: null,
          guard,
          plan,
        };
      }
    },
  };
}

export interface PreflightResult {
  ok: boolean;
  /** The chain's own verdict on the call, without committing it. */
  error: string | null;
  abortCode: number | null;
  /** Gas the dry run estimated, in MIST. */
  gasMist: number | null;
}

/**
 * Asks the chain whether the call would succeed, without committing it.
 *
 * This is the authoritative preflight. The TypeScript guards mirror the chain's
 * rules and can drift; a dry run runs the actual Move code against actual state,
 * so a dry run that passes has established every condition — including the ones
 * no guard here models, like the shipment condition being attached.
 */
export function preflight(plan: MoveCallPlan): PreflightResult {
  try {
    const result = dryRunCall(toCallOptions(plan));
    if (result.ok) {
      return { ok: true, error: null, abortCode: null, gasMist: gasChargedMist(result.tx) };
    }
    return {
      ok: false,
      error: result.error || "the dry run was refused",
      abortCode: result.abort?.code ?? null,
      gasMist: null,
    };
  } catch (error) {
    return { ok: false, error: describeCliError(error), abortCode: null, gasMist: null };
  }
}
