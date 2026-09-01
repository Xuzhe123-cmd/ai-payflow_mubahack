/**
 * Asking Sui what a call would do, without doing it.
 *
 * SERVER ONLY — it shells out to the Sui CLI.
 *
 * A dry run is evaluated by a validator against live state and then discarded:
 * the same bytecode runs, the same assertions fire, the same abort code comes
 * back, and nothing is committed, no gas is spent, no object changes. That
 * makes it the honest way to show a rule working, as opposed to
 * re-implementing the rule in TypeScript and hoping the two agree.
 *
 * THE SAME PLAN OBJECT IS DRY-RUN AND SUBMITTED. That is the point of taking a
 * plan rather than a bag of arguments: a preview that was assembled separately
 * from the transaction can drift from it, and a preview that has drifted is
 * worse than none — it is a confident wrong answer. Here the only difference
 * between the preview and the submission is the `--dry-run` flag.
 *
 * `--sender` matters and is not cosmetic. `approval::approve_scoped` reads
 * `ctx.sender()` and looks it up in the treasury's approver table, so a dry run
 * sent by anyone else answers a different question: it reports 602 (no
 * authorization for THAT address) and never reaches the condition under test.
 * Setting the sender needs no key, which is exactly what a preview should need.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface DryRunnablePlan {
  packageId: string;
  module: string;
  function: string;
  typeArguments: string[];
  arguments: string[];
  /** Optional. When absent the CLI's active address is used. */
  sender?: string;
}

export interface PlanDryRun {
  /** What Sui would do. A PREVIEW of execution, never an execution. */
  wouldSucceed: boolean;
  /** The Move abort code, when the chain aborted. Null when it did not abort. */
  abortCode: number | null;
  /** Net MIST the transaction would cost, when the CLI reported figures. */
  gasMist: number | null;
  /** The chain's own error text, unedited. Empty on success. */
  error: string;
  /** `package::module::function`, so a reader can go and read the source. */
  target: string;
  /** Stated in the payload so no reader mistakes this for a settlement. */
  submitted: false;
}

/**
 * Pulls the abort code out of the CLI's Move error text.
 *
 * The shape is:
 *
 *   MoveAbort(MoveLocation { module: ..., function: 4, instruction: 104,
 *             function_name: Some("approve_scoped") }, 601)
 *
 * The code is the number after the CLOSING brace — 601 here. Two traps, both of
 * which this hit while being written:
 *
 *   - matching up to the first ")" stops inside Some("approve_scoped"), so the
 *     pattern never matches at all;
 *   - a loose "first three-digit number" fallback then happily returns
 *     `instruction: 104`, which is not an abort code and reads as a plausible
 *     one. That is exactly what it did, reporting 104 for a $30,000 refusal
 *     whose real code is 601.
 *
 * So it anchors on "}, <digits>)" and takes the LAST such match, and there is
 * deliberately no fallback: an abort it cannot parse returns null and is
 * reported as an unidentified refusal rather than a confident wrong number.
 */
export function abortCodeFrom(text: string): number | null {
  const pattern = /\}\s*,\s*(\d+)\s*\)/g;
  let code: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) code = Number(match[1]);
  return code;
}

/** The arguments the CLI is handed. Exported so a test can assert the shape. */
export function dryRunArgs(plan: DryRunnablePlan): string[] {
  const args = [
    "client",
    "call",
    "--package", plan.packageId,
    "--module", plan.module,
    "--function", plan.function,
  ];
  if (plan.typeArguments.length > 0) args.push("--type-args", ...plan.typeArguments);
  if (plan.arguments.length > 0) args.push("--args", ...plan.arguments);
  if (plan.sender) args.push("--sender", plan.sender);
  args.push("--gas-budget", "100000000", "--dry-run", "--json");
  return args;
}

export async function dryRunPlan(plan: DryRunnablePlan): Promise<PlanDryRun> {
  const target = `${plan.packageId}::${plan.module}::${plan.function}`;

  let stdout = "";
  let stderr = "";
  try {
    const result = await run("sui", dryRunArgs(plan), { maxBuffer: 32 * 1024 * 1024 });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? "";
  }

  const combined = `${stdout}\n${stderr}`;

  // SUCCESS IS ONLY CLAIMED ON AN EXPLICIT SUCCESS STATUS. Anything ambiguous
  // is reported as a refusal, because guessing in the permissive direction is
  // the exact failure this whole module exists to remove.
  let parsed: DryRunResponse | null = null;
  try {
    parsed = JSON.parse(stdout) as DryRunResponse;
  } catch {
    parsed = null;
  }

  const status = parsed?.effects?.status?.status;
  if (status === "success") {
    return {
      wouldSucceed: true,
      abortCode: null,
      gasMist: netGas(parsed),
      error: "",
      target,
      submitted: false,
    };
  }

  return {
    wouldSucceed: false,
    abortCode: abortCodeFrom(combined),
    gasMist: netGas(parsed),
    error: parsed?.effects?.status?.error ?? combined.trim(),
    target,
    submitted: false,
  };
}

interface DryRunResponse {
  effects?: {
    status?: { status?: string; error?: string };
    gasUsed?: {
      computationCost?: string;
      storageCost?: string;
      storageRebate?: string;
    };
  };
}

/**
 * What the transaction actually costs: computation plus storage, less the
 * rebate. Reported rather than the gross figure, because the gross one
 * overstates a call that reclaims storage and a reader comparing it against a
 * wallet balance would be comparing the wrong numbers.
 */
function netGas(parsed: DryRunResponse | null): number | null {
  const gas = parsed?.effects?.gasUsed;
  if (!gas) return null;
  const num = (value: string | undefined) => Number(value ?? 0);
  const total = num(gas.computationCost) + num(gas.storageCost) - num(gas.storageRebate);
  return Number.isFinite(total) ? total : null;
}
