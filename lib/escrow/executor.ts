/**
 * Submitting an escrow call, or declining to.
 *
 * The interface never signs anything. It asks this layer for an action; this
 * layer runs the guards, submits through the server's own Sui access, reads the
 * result back off chain, and returns what actually happened. No signing key
 * crosses the wire in either direction, and no component ever learns one exists.
 *
 * TWO IMPLEMENTATIONS, and the difference is honest rather than cosmetic. The
 * simulated executor returns `digest: null` and says `mode: "simulated"`,
 * because nothing happened. The testnet executor returns a real digest or an
 * error — never a fabricated one. A result that claims a transaction must be
 * backed by a transaction the chain will confirm.
 *
 * The default is simulated. Going live is an explicit server-side decision
 * (PAYFLOW_ESCROW_LIVE), so a stray click cannot spend testnet gas.
 */

import type { GuardResult } from "./guards";
import type { MoveCallPlan } from "./calls";

export type ExecutionMode = "simulated" | "testnet";

export interface ExecutionResult {
  mode: ExecutionMode;
  /** True only when the chain accepted the transaction. */
  ok: boolean;
  /** A real digest, or null. Never invented. */
  digest: string | null;
  /** As the chain reports it: "success", "failure", or null when unsubmitted. */
  status: string | null;
  /** Objects the transaction created, by type. */
  created: { type: string; objectId: string }[];
  explorerUrl: string | null;
  /** Populated when the call aborted or a guard refused. */
  error: string | null;
  /** Move abort code, when the failure was one. */
  abortCode: number | null;
  /** The guards that ran before submission. */
  guard: GuardResult | null;
  /** What was, or would have been, submitted. */
  plan: MoveCallPlan;
}

export interface EscrowExecutor {
  readonly mode: ExecutionMode;
  /**
   * Runs the plan. Implementations MUST refuse when `guard.ok` is false and
   * MUST NOT return a digest they did not receive from a chain.
   */
  submit(plan: MoveCallPlan, guard: GuardResult): Promise<ExecutionResult>;
}

/**
 * Reports what would be submitted, and submits nothing.
 *
 * Deliberately still runs the guards: a demo that would be refused should say
 * so before the presenter reaches the live switch.
 */
export function createSimulatedExecutor(): EscrowExecutor {
  return {
    mode: "simulated",
    async submit(plan, guard) {
      return {
        mode: "simulated",
        ok: guard.ok,
        digest: null,
        status: null,
        created: [],
        explorerUrl: null,
        error: guard.ok ? null : guard.refusal,
        abortCode: null,
        guard,
        plan,
      };
    },
  };
}

/** Whether live execution has been switched on for this server. */
export function liveExecutionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.PAYFLOW_ESCROW_LIVE?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * A refusal, shaped like a result.
 *
 * Used when the guards decline, so the caller gets the same object either way
 * and cannot accidentally treat a refusal as a success for lack of a branch.
 */
export function refusedResult(
  plan: MoveCallPlan,
  guard: GuardResult,
  mode: ExecutionMode,
): ExecutionResult {
  return {
    mode,
    ok: false,
    digest: null,
    status: null,
    created: [],
    explorerUrl: null,
    error: guard.refusal ?? "refused by a server-side guard",
    abortCode: null,
    guard,
    plan,
  };
}

/** Finds a created object by type prefix, tolerating generic parameters. */
export function createdOfType(
  result: ExecutionResult,
  structType: string,
): string | null {
  const match = result.created.find(
    (entry) => entry.type === structType || entry.type.startsWith(`${structType}<`),
  );
  return match?.objectId ?? null;
}
