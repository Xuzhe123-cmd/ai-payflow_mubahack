/**
 * The refresh button submits a REAL transaction, and only ever claims what one.
 *
 * Two properties are tested here, both security-shaped:
 *
 *   1. The button goes through `approval::sync_membership` — the same Move
 *      function the CLI ran — with the right arguments in the right order.
 *      A button that flipped React state would pass every wording test in the
 *      suite while proving nothing, so the call itself is asserted.
 *
 *   2. Nothing about that path can grant authority. `sync_membership` copies
 *      the company's verdict and writes a timestamp. It cannot raise a limit,
 *      create an authorization, or move a coin — and the source is read here to
 *      confirm the body still says so, because the safety of exposing a
 *      permissionless function as a button rests entirely on that.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CompanyNotDeployedError,
  syncMembershipCall,
} from "../../lib/identity/syncMembershipCall";
import { AUTO_GAS_BUDGET, DEFAULT_GAS_BUDGET, renderCall } from "../../scripts/lib/suiCli";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const COMPANY = "0x274fe88f2ca611088342b607727296a937904b648484ca448d42c5763fd4116a";
const APPROVER = "0x9840c5c522e7e94bd01ffe0a57da9a10853cadb40574da5a5f058d3913ffa443";
const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const V3 = "0x3a6940862c683e19b563ac889cbbe6cd843e42209d63c76f4e0631068666f690";

function manifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    network: "testnet",
    packageId: V1,
    publisher: "0xa09bfa3a1f78f168c2970cff756592b7376be0ac947d845aedc4c0781d270609",
    coinType: `${V1}::mock_usdc::MOCK_USDC`,
    objects: { treasuryId: TREASURY },
    upgrade: { packageId: V3, version: 3 },
    identity: { companyId: COMPANY, treasuryId: TREASURY, companyName: "Chain-Doi" },
    ...overrides,
  } as unknown as DeploymentManifest;
}

// --- 6: the button uses the real sync_membership flow ------------------------

describe("the call the refresh button submits", () => {
  const plan = syncMembershipCall(manifest(), APPROVER);

  it("targets approval::sync_membership", () => {
    expect(plan.module).toBe("approval");
    expect(plan.function).toBe("sync_membership");
  });

  it("passes the Move arguments in signature order", () => {
    // sync_membership<T>(treasury, company, approver, clock)
    expect(plan.arguments).toEqual([TREASURY, COMPANY, APPROVER, "0x6"]);
    expect(plan.typeArguments).toEqual([`${V1}::mock_usdc::MOCK_USDC`]);
  });

  it("calls the UPGRADED package, not the original", () => {
    // sync_membership arrived in v3. Sending it to v1 would abort.
    expect(plan.packageId).toBe(V3);
  });

  it("names the approver as an argument rather than relying on the sender", () => {
    // This is what lets the server pay for the refresh without holding the
    // user's key — the function syncs the address it is told to.
    expect(plan.arguments).toContain(APPROVER);
  });

  it("refuses to build a call when no company exists", () => {
    expect(() => syncMembershipCall(manifest({ identity: undefined }), APPROVER)).toThrow(
      CompanyNotDeployedError,
    );
  });
});

// --- 9 & 10: the refresh cannot grant, widen, or spend -----------------------

describe("what sync_membership is incapable of", () => {
  const source = readFileSync(
    resolve(process.cwd(), "move/payflow/sources/approval.move"),
    "utf8",
  );

  /** Just the body of `public fun sync_membership`, to the closing brace. */
  const body = (() => {
    const start = source.indexOf("public fun sync_membership");
    expect(start).toBeGreaterThan(-1);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error("sync_membership body not found");
  })();

  it("does exactly two things: check the company, mirror the verdict", () => {
    expect(body).toContain("assert_approver_company");
    expect(body).toContain("set_membership_mirror");
  });

  it("reads membership from the live Company rather than asserting it", () => {
    expect(body).toContain("is_active_member");
    expect(body).toContain("has_permission");
    expect(body).toContain("perm_approve_payments");
  });

  it("never touches a payment limit", () => {
    for (const forbidden of [
      "set_approver_limits",
      "max_single",
      "daily_limit",
      "authorized_today",
      "authorize_approver",
      "set_approver_enabled",
      "set_approver_recipients",
    ]) {
      expect(body, `sync_membership must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never moves funds", () => {
    for (const forbidden of ["coin::", "balance::", "transfer::", "vault", "execute_payment"]) {
      expect(body, `sync_membership must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("cannot mint an approval", () => {
    expect(body).not.toContain("HumanApproval");
    expect(body).not.toContain("approve_scoped");
  });

  it("stays permissionless — no capability parameter", () => {
    const signature = source.slice(
      source.indexOf("public fun sync_membership"),
      source.indexOf("{", source.indexOf("public fun sync_membership")),
    );
    expect(signature).not.toContain("Cap");
    // Anyone may call it because the worst they achieve is telling the truth.
    expect(signature).toContain("treasury: &mut Treasury<T>");
    expect(signature).toContain("company: &Company");
  });

  it("keeps the one-hour freshness rule intact", () => {
    const treasury = readFileSync(
      resolve(process.cwd(), "move/payflow/sources/treasury.move"),
      "utf8",
    );
    expect(treasury).toContain("MEMBERSHIP_SYNC_MAX_AGE_MS");
    expect(treasury).toMatch(/MEMBERSHIP_SYNC_MAX_AGE_MS\s*:\s*u64\s*=\s*3_600_000/);
  });
});

// --- 7: the interface may not claim a success it did not get -----------------

describe("the component's success path", () => {
  const component = readFileSync(
    resolve(process.cwd(), "components/identity/MembershipVerification.tsx"),
    "utf8",
  );

  it("only says verified in the phase reached by a real response", () => {
    // "✓ Membership verified" must sit inside the `done` branch, which is set
    // only after an ok response — never in `running`, `failed`, or at the top.
    const done = component.slice(component.indexOf('refresh.phase === "done"'));
    expect(done).toContain("✓ Membership verified");
    const failed = component.slice(
      component.indexOf('refresh.phase === "failed"'),
      component.length,
    );
    expect(failed).not.toContain("✓ Membership verified");
  });

  it("treats a non-ok payload as a failure even on HTTP 200", () => {
    expect(component).toContain("!response.ok || !payload.ok");
  });

  it("renders the real error rather than a friendly substitute", () => {
    expect(component).toContain("{refresh.error}");
    expect(component).toContain("Refresh failed — verification is unchanged");
  });

  it("re-reads the chain instead of assuming what the write did", () => {
    expect(component).toContain("onRefreshed()");
    // The optimistic shortcut this design refuses.
    expect(component).not.toMatch(/setVerified\(|setMembershipActive\(/);
  });

  it("shows a loading state while the transaction is in flight", () => {
    expect(component).toContain("Refreshing membership verification…");
    expect(component).toContain("Refresh membership verification");
  });
});

// --- the route never runs on its own -----------------------------------------

describe("the sync route", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/membership/sync/route.ts"), "utf8");

  it("is POST-only, so nothing can spend gas by prefetching it", () => {
    expect(route).toContain("export async function POST");
    expect(route).not.toContain("export async function GET");
  });

  it("refuses an invalid address rather than normalizing it", () => {
    expect(route).toContain("isValidSuiAddress");
  });

  it("has no simulated branch that could fake a digest", () => {
    // Comments stripped: the route's own docblock says the word while
    // explaining that no such branch exists, which must not fail the check.
    const code = route.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toContain("simulated");
    expect(code).not.toMatch(/digest:\s*["'`]/);
    // Only ever what the submitter returned.
    expect(code).toContain("result.digest");
  });
});

// --- gas: the reservation must match the call, not the largest one in the repo

describe("gas budgeting for the refresh", () => {
  const submitter = readFileSync(
    resolve(process.cwd(), "lib/identity/syncMembershipSubmit.ts"),
    "utf8",
  );

  it("asks the CLI to estimate rather than reserving the publish budget", () => {
    expect(submitter).toContain("AUTO_GAS_BUDGET");
    // The 0.5 SUI reservation that broke gas selection.
    expect(submitter).not.toContain("500000000");
  });

  it("omits --gas-budget entirely for auto, which is what triggers estimation", () => {
    const rendered = renderCall({
      packageId: "0xpkg",
      module: "approval",
      function: "sync_membership",
      gasBudget: AUTO_GAS_BUDGET,
    });
    expect(rendered).not.toContain("--gas-budget");
    // A literal "auto" would be rejected by the CLI as a budget value.
    expect(rendered).not.toContain("auto");
  });

  it("still passes an explicit budget when given one", () => {
    expect(
      renderCall({
        packageId: "0xpkg",
        module: "approval",
        function: "sync_membership",
        gasBudget: "20000000",
      }),
    ).toContain("--gas-budget 20000000");
  });

  it("leaves the default alone, because publish needs it", () => {
    // Lowering DEFAULT_GAS_BUDGET would make package publishes fail. The
    // small-budget decision is scoped to this one call.
    expect(DEFAULT_GAS_BUDGET).toBe("500000000");
    expect(
      renderCall({ packageId: "0xpkg", module: "approval", function: "sync_membership" }),
    ).toContain("--gas-budget 500000000");
  });

  it("falls back to a budget any ordinary coin can cover", () => {
    const match = submitter.match(/const FALLBACK_GAS_BUDGET = "(\d+)"/);
    expect(match).not.toBeNull();
    const budget = Number(match![1]);
    // 0.01–0.02 SUI: comfortably above the ~3.1M MIST the call measures at,
    // and far below a balance a demo wallet would need to hold in one coin.
    expect(budget).toBeGreaterThanOrEqual(10_000_000);
    expect(budget).toBeLessThanOrEqual(20_000_000);
  });

  it("never retries a Move abort with a different budget", () => {
    // An abort is the chain's answer. Retrying would spend gas to hear it
    // twice, and could double-submit a call that actually succeeded.
    expect(submitter).toContain("attempt.abortCode === null");
  });

  it("only retries failures that are actually about the budget", () => {
    expect(submitter).toContain("looksLikeBudgetTrouble");
  });
});
