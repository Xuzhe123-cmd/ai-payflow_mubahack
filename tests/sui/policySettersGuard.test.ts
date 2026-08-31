/**
 * Invariant 1, as a build failure: the AI cannot change the rules.
 *
 * A Move test cannot prove the ABSENCE of an entry point — you can only call
 * functions that exist. So the guarantee "no agent-reachable function mutates
 * policy" has to be checked against the source itself, and that is what this
 * does. It reads the Move modules and fails if any publicly callable function
 * that mutates governed state stops demanding a TreasuryOwnerCap.
 *
 * If someone later adds a convenient `set_limit(treasury, value)` without the
 * capability argument, this is what stops it reaching a demo.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_DIR = resolve(process.cwd(), "move/payflow/sources");

/** Modules whose public surface is the admin surface. */
const GOVERNED_MODULES = [
  "treasury.move",
  "policy.move",
  "registry.move",
  "invoice.move",
  "cashflow.move",
  "agent.move",
  "approval.move",
];

/** State that only an administrator may rewrite. */
const GOVERNED_TYPES = [
  "Treasury<",
  "SupplierRegistry",
  "Invoice",
  "CashFlowCalendar",
  "TreasuryPolicy",
];

/**
 * Functions that mutate governed state without an owner capability, and why
 * that is correct. Anything not on this list must carry the capability.
 */
const ALLOWED_WITHOUT_CAP = new Map<string, string>([
  [
    "treasury::deposit",
    "Funding a treasury is deliberately open — adding money harms no one, and " +
      "requiring the admin to sign every top-up would break sponsored funding.",
  ],
  [
    "approval::approve_scoped",
    "The approver exercising DELEGATED authority, not administering anything. " +
      "It mints no authority: `treasury::authorize_approver` grants it and DOES " +
      "demand the owner capability, and this function aborts unless the treasury " +
      "already records a live authorization for `ctx.sender()`. What it mutates " +
      "is that approver's own daily counter — requiring an admin signature here " +
      "would mean the admin co-signing every approval, which is precisely the " +
      "delegation the authorization exists to avoid.",
  ],
  [
    "approval::sync_membership",
    "Copies the live Company's verdict on one member into the treasury's " +
      "mirror, and can do nothing else. It asserts no status of its own: it " +
      "reads `identity::is_active_member` and `has_permission` from the Company " +
      "passed in, and `treasury::assert_approver_company` refuses a Company the " +
      "authorization is not bound to. A hostile caller can therefore only make " +
      "the treasury agree with the company — the worst they achieve is telling " +
      "the truth. It must stay permissionless because the mirror has to be " +
      "refreshable by anyone: gating it behind the owner cap would mean a " +
      "revoked membership stayed usable until the admin personally noticed.",
  ],
]);

interface MoveFunction {
  module: string;
  name: string;
  visibility: string;
  params: string;
}

function readModule(file: string): string {
  return readFileSync(resolve(SOURCE_DIR, file), "utf8");
}

/** Extracts every function signature, balancing parentheses across newlines. */
function functionsIn(file: string): MoveFunction[] {
  const source = readModule(file);
  const moduleName = file.replace(/\.move$/, "");
  const out: MoveFunction[] = [];
  const declaration = /(public\(package\)|public|entry)?\s*\bfun\s+([a-z_][A-Za-z0-9_]*)\s*(?:<[^>(]*>)?\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    let depth = 1;
    let i = declaration.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    out.push({
      module: moduleName,
      name: match[2],
      visibility: match[1] ?? "private",
      params: source.slice(declaration.lastIndex, i - 1),
    });
  }
  return out;
}

function mutatesGovernedState(params: string): boolean {
  return GOVERNED_TYPES.some((type) => {
    const pattern = new RegExp(`&mut\\s+${type.replace("<", "\\<")}`);
    return pattern.test(params);
  });
}

describe("only an administrator can change the rules", () => {
  const everyFunction = GOVERNED_MODULES.flatMap(functionsIn);

  it("finds the functions it claims to be checking", () => {
    // A parser that silently matches nothing would make this whole file a
    // no-op that passes forever.
    expect(everyFunction.length).toBeGreaterThan(30);
    const names = everyFunction.map((fn) => `${fn.module}::${fn.name}`);
    expect(names).toContain("treasury::set_min_reserve");
    expect(names).toContain("registry::set_wallet");
    expect(names).toContain("treasury::deposit");
  });

  it("demands a TreasuryOwnerCap on every public mutator", () => {
    const offenders = everyFunction
      .filter((fn) => fn.visibility === "public" || fn.visibility === "entry")
      .filter((fn) => mutatesGovernedState(fn.params))
      .filter((fn) => !/TreasuryOwnerCap/.test(fn.params))
      .map((fn) => `${fn.module}::${fn.name}`)
      .filter((qualified) => !ALLOWED_WITHOUT_CAP.has(qualified));

    expect(offenders, `these mutate governed state with no owner capability: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("keeps every policy mutator package-private", () => {
    // policy.move must expose no public writer at all: the only way in is
    // through treasury.move, which checks the capability first.
    const publicWriters = functionsIn("policy.move")
      .filter((fn) => fn.visibility === "public")
      .filter((fn) => /&mut\s+TreasuryPolicy/.test(fn.params))
      .map((fn) => fn.name);

    expect(publicWriters).toEqual([]);
  });

  it("keeps the vault's only exit package-private and used once", () => {
    // Funds leave through balance::split inside treasury::split_vault, and
    // nothing but payment.move may call it.
    const treasurySource = readModule("treasury.move");
    expect(treasurySource).toMatch(/public\(package\)\s+fun\s+split_vault/);

    const callers = GOVERNED_MODULES.concat(["payment.move", "limits.move", "mock_usdc.move"])
      .filter((file) => file !== "treasury.move")
      .filter((file) => /split_vault/.test(readModule(file)));

    expect(callers).toEqual(["payment.move"]);
  });

  it("gives the agent no capability-mutating function of its own", () => {
    // AgentCap is a bearer token. If it ever grew a setter, the agent could
    // rewrite its own limits, which is Invariant 2.
    const agentSource = readModule("agent.move");
    const setters = functionsIn("agent.move").filter(
      (fn) => /&mut\s+AgentCap/.test(fn.params),
    );

    expect(setters).toEqual([]);
    expect(agentSource).not.toMatch(/public\s+fun\s+set_/);
  });
});
