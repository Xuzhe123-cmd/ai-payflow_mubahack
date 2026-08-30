/**
 * A thin, deliberately boring wrapper around the `sui` CLI.
 *
 * Every transaction in this repo is signed by the CLI's own keystore. No script
 * here reads a private key, derives one, or accepts one as an argument — which
 * is why none of them need to be trusted with one.
 *
 * Two safety properties are enforced here rather than left to each caller:
 *
 *  1. Mainnet is refused outright. `sui client envs` lists mainnet by default,
 *     so a single mistyped `--env` is otherwise all that stands between a demo
 *     and a real transaction.
 *  2. Nothing that changes chain state runs without an explicit `--confirm`.
 *     The default for every script is a dry run that prints what it WOULD do.
 */

import { execFileSync } from "node:child_process";

export const ALLOWED_NETWORKS = ["testnet", "devnet", "localnet"] as const;
export type AllowedNetwork = (typeof ALLOWED_NETWORKS)[number];

/** Publishing is the one genuinely expensive call; the rest are small. */
export const DEFAULT_GAS_BUDGET = process.env.PAYFLOW_GAS_BUDGET ?? "500000000";

/**
 * Carries what the CLI actually said, not what Node summarised.
 *
 * Node truncates the failing command into `error.message` — which is why a
 * report of this failure looked like it ended at `--type-args 0`; that is the
 * first character of the type argument, cut mid-token by Node, not a malformed
 * argument. The real diagnostics are in `stdout`, because the Sui CLI writes
 * its errors there rather than to stderr.
 */
export class SuiCliError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly status: number | null,
    readonly argv: readonly string[],
  ) {
    super(message);
    this.name = "SuiCliError";
  }

  /** Everything the process emitted, both streams, untruncated. */
  get output(): string {
    return [this.stdout, this.stderr].filter((part) => part.trim().length > 0).join("\n").trim();
  }

  /** The command as actually invoked — complete, unlike Node's message. */
  get command(): string {
    return ["sui", ...this.argv].join(" ");
  }
}

/** Pulls the readable text out of any error a CLI helper may throw. */
export function describeCliError(error: unknown): string {
  if (error instanceof SuiCliError) {
    return [
      `exit status: ${error.status ?? "unknown"}`,
      `command: ${error.command}`,
      error.output || "(the CLI produced no output)",
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

function run(args: string[], cwd?: string): string {
  // PAYFLOW_DEBUG_CLI=1 prints the exact argv. Worth keeping: a malformed
  // argument list is otherwise invisible, because execFileSync passes the array
  // straight to the process and no shell ever renders it back to you.
  if (process.env.PAYFLOW_DEBUG_CLI) {
    console.error(`[cli] argv = ${JSON.stringify(["sui", ...args])}`);
  }
  try {
    return execFileSync("sui", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // Both streams must be pipes. Left to Node's default, stderr goes to the
      // parent terminal and never reaches the catch block.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
      message?: string;
    };
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";
    if (process.env.PAYFLOW_DEBUG_CLI) {
      console.error(`[cli] exit=${err.status ?? "?"}`);
      console.error(`[cli] stdout(${stdout.length}B) = ${stdout}`);
      console.error(`[cli] stderr(${stderr.length}B) = ${stderr}`);
    }
    throw new SuiCliError(
      `sui ${args[0]} ${args[1]} failed with exit ${err.status ?? "unknown"}`,
      stdout,
      stderr,
      err.status ?? null,
      args,
    );
  }
}

/**
 * The CLI prints progress lines before its JSON payload, so the response is
 * located rather than assumed to start at byte zero.
 */
function parseJson<T>(raw: string): T {
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error(`No JSON found in CLI output:\n${raw.slice(0, 400)}`);
  return JSON.parse(raw.slice(start)) as T;
}

export function cliVersion(): string {
  return run(["--version"]).trim();
}

export function activeAddress(): string {
  return run(["client", "active-address"]).trim();
}

export function activeEnv(): string {
  return run(["client", "active-env"]).trim();
}

/**
 * Refuses to continue on any network not on the allowlist. This is the single
 * most important line in the deployment pipeline.
 */
export function assertSafeNetwork(): AllowedNetwork {
  const env = activeEnv();
  if (!(ALLOWED_NETWORKS as readonly string[]).includes(env)) {
    throw new Error(
      `Refusing to operate on network "${env}". ` +
        `AI PayFlow deploys only to ${ALLOWED_NETWORKS.join(", ")}. ` +
        `Switch with: sui client switch --env testnet`,
    );
  }
  return env as AllowedNetwork;
}

export interface GasCoin {
  gasCoinId: string;
  mistBalance: number | string;
  suiBalance?: string;
}

/**
 * `sui client gas --json` returns an envelope on 1.78
 * (`{ gasCoins, addressMistBalance, addressSuiBalance }`), but older versions
 * returned a bare array. Both are accepted rather than assuming either.
 */
interface GasEnvelope {
  gasCoins?: GasCoin[];
  addressMistBalance?: number | string;
  addressSuiBalance?: string;
}

export const MIST_PER_SUI = BigInt(1_000_000_000);

export interface GasReport {
  /**
   * What can actually pay for a transaction: the sum of the individual gas
   * coins. This is the only figure the preflight is allowed to gate on.
   */
  totalMist: bigint;
  coinCount: number;
  /**
   * Informational only. Observed to report 0 on 1.78 even when gasCoins holds
   * a funded coin, so gating on it would refuse to deploy from a funded wallet.
   */
  addressMistBalance: bigint | null;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/**
 * Pure so it can be tested against real CLI output without a chain.
 *
 * Spendable gas is the SUM OF THE COINS, never the address-level total. Sui
 * pays for a transaction from individual coin objects, and 1.78 reports
 * `addressMistBalance: 0` alongside a perfectly good coin — reading that field
 * as the balance makes a funded wallet look empty.
 */
export function parseGasReport(parsed: unknown): GasReport {
  const coins: GasCoin[] = Array.isArray(parsed)
    ? (parsed as GasCoin[])
    : ((parsed as GasEnvelope | null)?.gasCoins ?? []);

  const totalMist = coins.reduce<bigint>(
    (sum, coin) => sum + (toBigInt(coin?.mistBalance) ?? BigInt(0)),
    BigInt(0),
  );

  const addressLevel = Array.isArray(parsed)
    ? null
    : toBigInt((parsed as GasEnvelope | null)?.addressMistBalance);

  return { totalMist, coinCount: coins.length, addressMistBalance: addressLevel };
}

/** "1.00", "0.70" — two decimals, computed in bigint so nothing rounds badly. */
export function formatSui(mist: bigint): string {
  const negative = mist < BigInt(0);
  const abs = negative ? -mist : mist;
  const whole = abs / MIST_PER_SUI;
  const fraction = (abs % MIST_PER_SUI).toString().padStart(9, "0").slice(0, 2);
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

function readGas(): GasReport {
  try {
    return parseGasReport(parseJson<unknown>(run(["client", "gas", "--json"])));
  } catch {
    return { totalMist: BigInt(0), coinCount: 0, addressMistBalance: null };
  }
}

export function gasCoins(): GasCoin[] {
  try {
    const parsed = parseJson<GasCoin[] | GasEnvelope>(run(["client", "gas", "--json"]));
    return Array.isArray(parsed) ? parsed : (parsed.gasCoins ?? []);
  } catch {
    return [];
  }
}

export function gasReport(): GasReport {
  return readGas();
}

export function totalMist(): bigint {
  return readGas().totalMist;
}

// --- Transaction responses ----------------------------------------------------

export interface ObjectChange {
  type: "published" | "created" | "mutated" | "transferred" | "deleted" | "wrapped";
  packageId?: string;
  objectId?: string;
  objectType?: string;
  owner?: unknown;
  modules?: string[];
}

export interface TxResponse {
  digest: string;
  objectChanges?: ObjectChange[];
  effects?: { status?: { status?: string; error?: string } };
}

export function assertSucceeded(tx: TxResponse, label: string): void {
  const status = tx.effects?.status?.status;
  if (status && status !== "success") {
    throw new Error(
      `${label} failed on chain: ${tx.effects?.status?.error ?? "unknown error"} (digest ${tx.digest})`,
    );
  }
}

/** The published package id from a publish response. */
export function publishedPackageId(tx: TxResponse): string {
  const published = tx.objectChanges?.find((change) => change.type === "published");
  if (!published?.packageId) {
    throw new Error("Publish response contained no published package");
  }
  return published.packageId;
}

/**
 * Finds a created object by struct type. Matches on the type prefix, so a
 * generic like `Treasury<0x..::mock_usdc::MOCK_USDC>` is found by
 * `...::treasury::Treasury`.
 */
export function createdObject(tx: TxResponse, structType: string): string | null {
  const match = tx.objectChanges?.find(
    (change) =>
      change.type === "created" &&
      typeof change.objectType === "string" &&
      (change.objectType === structType || change.objectType.startsWith(`${structType}<`)),
  );
  return match?.objectId ?? null;
}

export function requireCreatedObject(tx: TxResponse, structType: string, label: string): string {
  const id = createdObject(tx, structType);
  if (!id) {
    const seen = (tx.objectChanges ?? [])
      .filter((change) => change.type === "created")
      .map((change) => change.objectType)
      .join(", ");
    throw new Error(`${label}: no created object of type ${structType}. Saw: ${seen || "none"}`);
  }
  return id;
}

export function allCreatedObjects(tx: TxResponse, structType: string): string[] {
  return (tx.objectChanges ?? [])
    .filter(
      (change) =>
        change.type === "created" &&
        typeof change.objectType === "string" &&
        (change.objectType === structType || change.objectType.startsWith(`${structType}<`)),
    )
    .map((change) => change.objectId!)
    .filter(Boolean);
}

// --- Commands that change chain state ----------------------------------------

export interface CallOptions {
  packageId: string;
  module: string;
  function: string;
  typeArgs?: string[];
  args?: string[];
  gasBudget?: string;
}

/** Renders the command a caller would run, for dry-run output. */
export function renderCall(options: CallOptions): string {
  const parts = [
    "sui client call",
    `--package ${options.packageId}`,
    `--module ${options.module}`,
    `--function ${options.function}`,
  ];
  if (options.typeArgs?.length) parts.push(`--type-args ${options.typeArgs.join(" ")}`);
  if (options.args?.length) {
    parts.push(`--args ${options.args.map((arg) => JSON.stringify(arg)).join(" ")}`);
  }
  parts.push(`--gas-budget ${options.gasBudget ?? DEFAULT_GAS_BUDGET}`);
  return parts.join(" ");
}

export function call(options: CallOptions): TxResponse {
  const args = [
    "client",
    "call",
    "--package",
    options.packageId,
    "--module",
    options.module,
    "--function",
    options.function,
  ];
  if (options.typeArgs?.length) args.push("--type-args", ...options.typeArgs);
  if (options.args?.length) args.push("--args", ...options.args);
  args.push("--gas-budget", options.gasBudget ?? DEFAULT_GAS_BUDGET, "--json");

  const tx = parseJson<TxResponse>(run(args));
  assertSucceeded(tx, `${options.module}::${options.function}`);
  return tx;
}

export interface FailedCall {
  ok: false;
  /** The Move abort code, when the failure was an abort rather than an error. */
  abortCode: number | null;
  /** Where the abort came from, so a caller can confirm it is the right one. */
  abort: MoveAbortInfo | null;
  error: string;
}

export interface SucceededCall {
  ok: true;
  tx: TxResponse;
}

/**
 * Runs a call WITHOUT executing it, and reports the abort code if it fails.
 *
 * This is how the Demo B rejection can be proven against a live deployment for
 * free: the chain evaluates the transaction and refuses it exactly as it would
 * on execution, but no gas is spent and no state changes.
 */
export function dryRunCall(options: CallOptions): SucceededCall | FailedCall {
  const args = [
    "client",
    "call",
    "--package",
    options.packageId,
    "--module",
    options.module,
    "--function",
    options.function,
  ];
  if (options.typeArgs?.length) args.push("--type-args", ...options.typeArgs);
  if (options.args?.length) args.push("--args", ...options.args);
  args.push("--gas-budget", options.gasBudget ?? DEFAULT_GAS_BUDGET, "--dry-run", "--json");

  let raw: string;
  try {
    raw = run(args);
  } catch (error) {
    // A dry run of a failing transaction still exits 0 on 1.78 — reaching here
    // means the CLI itself failed (bad argument, unreachable node), not that
    // the chain refused the payment.
    const err = error as SuiCliError;
    const abort = parseMoveAbort(err.stderr);
    return { ok: false, abortCode: abort?.code ?? null, abort, error: err.stderr };
  }

  const tx = parseJson<TxResponse>(raw);
  const status = tx.effects?.status?.status;
  if (status && status !== "success") {
    const message = tx.effects?.status?.error ?? "";
    const abort = parseMoveAbort(message);
    return { ok: false, abortCode: abort?.code ?? null, abort, error: message };
  }
  return { ok: true, tx };
}

export interface MoveAbortInfo {
  /** The `assert!` code — for this package, the policy check that failed. */
  code: number;
  /** Package address the abort came from, lower-case, no 0x. */
  address: string | null;
  /** e.g. "payment" */
  module: string | null;
  /** e.g. "execute_payment" */
  functionName: string | null;
}

/**
 * Returns the text inside `MoveAbort( ... )`, matching parentheses properly.
 *
 * A regex cannot do this safely. The payload contains nested parens —
 * `Identifier("payment")`, `Some("execute_payment")` — so a non-greedy match
 * stops early and a greedy one can run past the end into whatever follows.
 */
function moveAbortPayload(message: string): string | null {
  const marker = "MoveAbort(";
  const start = message.indexOf(marker);
  if (start === -1) return null;

  const open = start + marker.length - 1;
  let depth = 0;
  for (let i = open; i < message.length; i++) {
    if (message[i] === "(") depth += 1;
    else if (message[i] === ")") {
      depth -= 1;
      if (depth === 0) return message.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Parses a Sui 1.78 Move abort.
 *
 * The format is:
 *
 *   MoveAbort(MoveLocation { module: ModuleId { address: 8d52…,
 *     name: Identifier("payment") }, function: 5, instruction: 83,
 *     function_name: Some("execute_payment") }, 5) in command 0
 *
 * Note the trap: `function: 5` is the function INDEX within the module, and in
 * our case it happens to equal the abort code. A loose pattern that grabs "the
 * first number after MoveAbort" appears to work and is reading the wrong field.
 * The abort code is specifically the value AFTER the MoveLocation struct, which
 * is why the payload is extracted by balancing parens and the code taken from
 * its tail.
 */
export function parseMoveAbort(rawMessage: string): MoveAbortInfo | null {
  // The same abort reaches us two ways: as plain text on stderr, and embedded
  // in a JSON payload where every quote is backslash-escaped. Unescaping first
  // means the field patterns below work on both without being written twice.
  const message = rawMessage.replace(/\\"/g, '"');
  const payload = moveAbortPayload(message);
  if (payload !== null) {
    const tail = /,\s*(\d+)\s*$/.exec(payload);
    if (tail) {
      return {
        code: Number(tail[1]),
        address: /address:\s*([0-9a-fA-Fx]+)/.exec(payload)?.[1]?.replace(/^0x/, "").toLowerCase() ?? null,
        module: /name:\s*Identifier\("([^"]+)"\)/.exec(payload)?.[1] ?? null,
        functionName: /function_name:\s*Some\("([^"]+)"\)/.exec(payload)?.[1] ?? null,
      };
    }
  }

  const friendly = parseFriendlyAbort(message);
  if (friendly) return friendly;

  // Other surfaces and older versions render aborts differently.
  const fallbacks = [/sub[_ ]status[:\s]+(\d+)/i, /abort_code[:\s]+(\d+)/i];
  for (const pattern of fallbacks) {
    const match = pattern.exec(message);
    if (match) {
      return { code: Number(match[1]), address: null, module: null, functionName: null };
    }
  }
  return null;
}

/**
 * The human-readable abort the CLI prints on a real execution:
 *
 *   Error executing transaction '7AJy75zw…': 1st command aborted within
 *   function '0x8d52…::payment::execute_payment' at instruction 83 with code 5
 *
 * Structurally different from the `MoveAbort(MoveLocation { … }, 5)` form the
 * dry run returns, and it carries the same facts in a friendlier shape — which
 * is why a parser written for one silently fails on the other.
 */
function parseFriendlyAbort(message: string): MoveAbortInfo | null {
  const match = /aborted within function\s+'([^']+)'[\s\S]*?with code\s+(\d+)/.exec(message);
  if (!match) return null;

  const parts = match[1].split("::");
  const qualified = parts.length === 3;
  return {
    code: Number(match[2]),
    address: qualified ? parts[0].replace(/^0x/i, "").toLowerCase() : null,
    module: qualified ? parts[1] : null,
    functionName: qualified ? parts[2] : null,
  };
}

/** Base58, the alphabet Sui digests use — no 0, O, I or l. */
const DIGEST_PATTERN = "[1-9A-HJ-NP-Za-km-z]{32,50}";

/**
 * The transaction digest the CLI names when execution fails.
 *
 * Verified against testnet: this identifier resolves through
 * `sui client tx-block`, carries a checkpoint, and shows gas charged — it is a
 * genuine on-chain digest, not a local or dry-run identifier. Callers should
 * still confirm with `fetchTransaction` before presenting it as evidence.
 */
export function parseDigest(message: string): string | null {
  const patterns = [
    new RegExp(`Error executing transaction\\s+'(${DIGEST_PATTERN})'`),
    new RegExp(`Transaction Digest[:\\s]+(${DIGEST_PATTERN})`),
    new RegExp(`(?:digest|Digest)["'\\s:]+(${DIGEST_PATTERN})`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) return match[1];
  }
  return null;
}

/** Convenience for callers that only care about the number. */
export function parseAbortCode(message: string): number | null {
  return parseMoveAbort(message)?.code ?? null;
}

export interface SuiObject {
  objectId?: string;
  /** The CLI names this `objType`; the RPC SDK names it `type`. */
  type?: string;
  objType?: string;
  content?: unknown;
  data?: unknown;
}

export function getObject(objectId: string): SuiObject {
  const parsed = parseJson<SuiObject>(run(["client", "object", objectId, "--json"]));
  // The RPC SDK wraps the object in `data`; the CLI returns it at top level.
  const object = ((parsed as { data?: SuiObject }).data ?? parsed) as SuiObject;
  return { ...object, type: object.type ?? object.objType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move struct fields out of a fetched object.
 *
 * Two shapes exist in the wild and neither is safe to assume:
 *
 *   CLI 1.78     { content: { min_reserve: "500...", policy: {...} } }
 *   RPC / SDK    { content: { fields: { min_reserve: "500...", ... } } }
 *
 * The verifier originally assumed only the second, so every field read came
 * back empty and every policy check reported "unreadable" against a treasury
 * that was in fact perfectly correct. Both are accepted now.
 */
export function extractFields(object: unknown): Record<string, unknown> {
  if (!isRecord(object)) return {};
  const container = isRecord(object.data) ? object.data : object;
  const content = isRecord(container.content) ? container.content : container;
  if (isRecord(content.fields)) return content.fields;
  return isRecord(content) ? content : {};
}

/**
 * A struct held BY VALUE inside another — `Treasury.policy`, for instance.
 * Same two shapes, same tolerance.
 */
export function nestedFields(
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = fields[key];
  if (!isRecord(value)) return {};
  return isRecord(value.fields) ? value.fields : value;
}

export function objectFields(objectId: string): Record<string, unknown> {
  return extractFields(getObject(objectId));
}

export interface ExecutionOutcome {
  /** Whether the transaction actually succeeded on chain. */
  ok: boolean;
  /** Present whenever the transaction reached the chain, success or abort. */
  digest: string | null;
  abort: MoveAbortInfo | null;
  error: string;
  /** Everything the CLI said, for reporting when nothing else parses. */
  raw: string;
  /** Null when the transaction never reached the chain at all. */
  exitStatus?: number | null;
  argv?: readonly string[];
}

/**
 * The CLI's own error shape, which is NOT JSON even under `--json`:
 *
 *   code: 'Some requested entity was not found', message: "Object 0x… not found"
 *
 * Recognising it turns an opaque "could not read the failure reason" into the
 * actual complaint, which is the difference between a five-minute fix and an
 * afternoon.
 */
export function parseCliError(raw: string): string | null {
  const structured = /code:\s*'([^']*)'\s*,\s*message:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (structured) return `${structured[1]}: ${structured[2]}`;
  const bare = /^\s*(?:error|Error)[:\s]+(.+)$/m.exec(raw);
  return bare ? bare[1].trim() : null;
}

/**
 * Executes a call that is EXPECTED to abort, without throwing.
 *
 * `call()` throws on failure, which is right for setup steps but wrong here:
 * for the security demonstration the abort IS the result, and the transaction
 * digest of the refused payment is the artifact worth keeping.
 *
 * The CLI reports an aborting transaction in more than one way depending on
 * whether it exits non-zero and whether `--json` output made it to stdout, so
 * all of them are handled rather than one being assumed:
 *
 *   - exit 0, JSON on stdout with effects.status.status === "failure"
 *   - non-zero exit, JSON still on stdout
 *   - non-zero exit, human-readable text only
 */
export function callAllowingAbort(options: CallOptions): ExecutionOutcome {
  const args = [
    "client",
    "call",
    "--package",
    options.packageId,
    "--module",
    options.module,
    "--function",
    options.function,
  ];
  if (options.typeArgs?.length) args.push("--type-args", ...options.typeArgs);
  if (options.args?.length) args.push("--args", ...options.args);
  args.push("--gas-budget", options.gasBudget ?? DEFAULT_GAS_BUDGET, "--json");

  let raw: string;
  let status: number | null = 0;
  try {
    raw = run(args);
  } catch (error) {
    if (!(error instanceof SuiCliError)) throw error;
    // Only what the CLI emitted. Node's truncated message is deliberately kept
    // out: prefixing it can put a stray brace ahead of the real payload and
    // derail JSON detection.
    raw = error.output;
    status = error.status;
  }

  const outcome = interpretExecution(raw);
  return { ...outcome, exitStatus: status, argv: ["sui", ...args] };
}

/** Pure, so the shapes above can be tested without a chain. */
export function interpretExecution(raw: string): ExecutionOutcome {
  let tx: TxResponse | null = null;
  try {
    tx = parseJson<TxResponse>(raw);
  } catch {
    tx = null;
  }

  if (tx && typeof tx.digest === "string") {
    const status = tx.effects?.status?.status;
    const error = tx.effects?.status?.error ?? "";
    if (status === "success") {
      return { ok: true, digest: tx.digest, abort: null, error: "", raw };
    }
    return { ok: false, digest: tx.digest, abort: parseMoveAbort(error), error, raw };
  }

  // No usable JSON — fall back to reading the text the CLI printed.
  const abort = parseMoveAbort(raw);
  return {
    ok: false,
    digest: parseDigest(raw),
    abort,
    // Prefer the CLI's own complaint over the whole dump, so the reason is
    // legible even when it is not a Move abort at all.
    error: abort ? raw : (parseCliError(raw) ?? raw),
    raw,
  };
}

export interface OnChainTransaction {
  exists: boolean;
  status: string | null;
  /** Present once the transaction is in a checkpoint — proof of consensus. */
  checkpoint: string | null;
  gasChargedMist: number | null;
  error: string | null;
}

/**
 * Looks a digest up on chain.
 *
 * The point is to be able to say "this is recorded in checkpoint N" rather than
 * "the CLI printed a string that looked like a digest". A failed transaction is
 * still a real transaction in Sui — it reaches consensus, consumes gas, and is
 * permanently recorded — so this distinguishes a genuine on-chain rejection
 * from a local error that never left the machine.
 */
export function fetchTransaction(digest: string): OnChainTransaction {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJson<Record<string, unknown>>(run(["client", "tx-block", digest, "--json"]));
  } catch {
    return { exists: false, status: null, checkpoint: null, gasChargedMist: null, error: null };
  }

  const effects = (parsed.effects ?? parsed) as Record<string, unknown>;
  const status = effects.status as { status?: string; error?: string } | undefined;
  const gas = effects.gasUsed as Record<string, string> | undefined;
  const charged = gas
    ? Number(gas.computationCost ?? 0) + Number(gas.storageCost ?? 0) - Number(gas.storageRebate ?? 0)
    : null;

  return {
    exists: true,
    status: status?.status ?? null,
    checkpoint: (parsed.checkpoint as string | undefined) ?? null,
    gasChargedMist: Number.isFinite(charged) ? charged : null,
    error: status?.error ?? null,
  };
}

export function publish(packagePath: string, gasBudget = DEFAULT_GAS_BUDGET): TxResponse {
  const tx = parseJson<TxResponse>(
    run(["client", "publish", "--gas-budget", gasBudget, "--json", packagePath]),
  );
  assertSucceeded(tx, "publish");
  return tx;
}

// --- Local, offline verification ----------------------------------------------

export function moveBuild(packagePath: string): void {
  run(["move", "build", "--path", packagePath]);
}

/** Returns the parsed pass/fail counts so a caller can insist on a full suite. */
export function moveTest(packagePath: string): { passed: number; failed: number } {
  const output = run(["move", "test", "--path", packagePath]);
  const match = /Test result: \w+\. Total tests: (\d+); passed: (\d+); failed: (\d+)/.exec(output);
  if (!match) throw new Error(`Could not parse Move test output:\n${output.slice(-600)}`);
  return { passed: Number(match[2]), failed: Number(match[3]) };
}
