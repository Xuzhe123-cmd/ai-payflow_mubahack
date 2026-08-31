/**
 * The circuit breaker: enforced by Move, read from Sui, and not resettable by
 * anything that produced the score.
 *
 * The Move behaviour itself is proved in `circuit_breaker_tests.move`, where a
 * validator actually executes it. What is asserted here is everything on the
 * TypeScript side of that boundary: that the gate really is called from the
 * autonomous and conditional paths, that the reader cannot invent a mode, that
 * no interface path can trip or reset the breaker, and that Phase 1 is intact.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { breakerConsequences, type BreakerState } from "../../lib/sui/breakerReader";
import {
  initBreakerCall,
  renderBreakerPlan,
  resetBreakerCall,
  tripBreakerCall,
} from "../../lib/defense/breakerCalls";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const source = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const CAP = "0xa732e503bbefcac9f8cd958c5b57c80e6cd86a5d69f29e2beafff717a32598ca";
const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const V3 = "0x3a6940862c683e19b563ac889cbbe6cd843e42209d63c76f4e0631068666f690";
const APPROVER = "0x9840c5c522e7e94bd01ffe0a57da9a10853cadb40574da5a5f058d3913ffa443";

const MANIFEST = {
  network: "testnet",
  packageId: V1,
  coinType: `${V1}::mock_usdc::MOCK_USDC`,
  objects: { treasuryId: TREASURY, treasuryOwnerCapId: CAP },
  upgrade: { packageId: V3, version: 3 },
} as unknown as DeploymentManifest;

function state(overrides: Partial<BreakerState> = {}): BreakerState {
  return {
    mode: "NORMAL",
    installed: true,
    anomalyScore: 0,
    reasonCode: "",
    trippedAtMs: 0,
    tripCount: 0,
    resetAtMs: 0,
    treasuryId: TREASURY,
    ...overrides,
  };
}

// --- 14-16: what each mode permits -------------------------------------------

describe("what the breaker permits", () => {
  it("permits every path in NORMAL mode", () => {
    const result = breakerConsequences(state());
    expect(result.autonomousAllowed).toBe(true);
    expect(result.conditionalAllowed).toBe(true);
    expect(result.humanAllowed).toBe(true);
    expect(result.label).toBe("ARMED");
  });

  it("blocks autonomous and conditional payments in HUMAN_ONLY", () => {
    const result = breakerConsequences(state({ mode: "HUMAN_ONLY" }));
    expect(result.autonomousAllowed).toBe(false);
    expect(result.conditionalAllowed).toBe(false);
    expect(result.label).toBe("TRIPPED");
  });

  it("leaves the human path open in HUMAN_ONLY", () => {
    // 17. A breaker that froze everything would be unusable: the business still
    // has to pay people while the automation is contained.
    expect(breakerConsequences(state({ mode: "HUMAN_ONLY" })).humanAllowed).toBe(true);
  });

  it("does not present an uninstalled breaker as protection", () => {
    const result = breakerConsequences(state({ mode: "NOT_INSTALLED", installed: false }));
    expect(result.label).toBe("NOT INSTALLED");
    expect(result.detail).toContain("No circuit breaker exists");
    // It permits, because Move permits — but it must not read as "armed".
    expect(result.autonomousAllowed).toBe(true);
    expect(result.label).not.toBe("ARMED");
  });
});

// --- the gate is genuinely wired into Move -----------------------------------

describe("Move calls the gate on every autonomous path", () => {
  it("checks the breaker in execute_payment", () => {
    const payment = source("move/payflow/sources/payment.move");
    const body = payment.slice(
      payment.indexOf("public fun execute_payment"),
      payment.indexOf("public fun execute_approved"),
    );
    expect(body).toContain("treasury::assert_autonomy_allowed(treasury)");
  });

  it("checks the breaker in execute_conditional", () => {
    const escrow = source("move/payflow/sources/escrow.move");
    const body = escrow.slice(
      escrow.indexOf("public fun execute_conditional<"),
      escrow.indexOf("public fun execute_conditional_approved"),
    );
    expect(body).toContain("treasury::assert_autonomy_allowed(treasury)");
  });

  it("checks the breaker before releasing agent-locked escrow", () => {
    // The half that actually moves money. Freezing the lock but not the release
    // would let every escrow the attacker already created still pay out.
    const escrow = source("move/payflow/sources/escrow.move");
    const body = escrow.slice(escrow.indexOf("public fun release<"));
    expect(body).toContain("limits::authority_agent()");
    expect(body).toContain("treasury::assert_autonomy_allowed(treasury)");
  });

  it("does NOT gate the human execution paths", () => {
    // 17 again, from the other side: the human path must be untouched.
    const payment = source("move/payflow/sources/payment.move");
    const humanBody = payment.slice(
      payment.indexOf("public fun execute_approved"),
      payment.indexOf("public(package) fun record_settlement"),
    );
    expect(humanBody).not.toContain("assert_autonomy_allowed");
  });
});

// --- 18 & 19: who can change the mode ----------------------------------------

describe("who can trip and reset", () => {
  const treasuryMove = source("move/payflow/sources/treasury.move");

  it("requires the owner capability to trip", () => {
    const body = treasuryMove.slice(
      treasuryMove.indexOf("public fun trip_breaker"),
      treasuryMove.indexOf("public fun reset_breaker"),
    );
    expect(body).toContain("assert_owner(treasury, cap)");
  });

  it("requires the owner capability AND a vouched human to reset", () => {
    const body = treasuryMove.slice(treasuryMove.indexOf("public fun reset_breaker"));
    expect(body).toContain("assert_owner(treasury, cap)");
    // Strictly more than the trip: a person the company still vouches for.
    expect(body).toContain("approver_in_good_standing");
    expect(body).toContain("ENoHumanRecovery");
  });

  it("gives the anomaly engine no way to reach the chain", () => {
    // 6 & 18. The scorer is pure arithmetic over statistics; it imports no
    // client, no CLI, no route, and cannot submit anything.
    for (const file of [
      "lib/defense/anomaly.ts",
      "lib/defense/behaviorStats.ts",
      "lib/defense/attackSimulation.ts",
    ]) {
      const text = source(file);
      for (const banned of ["suiCli", "fetch(", "child_process", "reset_breaker", "TreasuryOwnerCap"]) {
        expect(text, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("exposes no interface route that trips or resets the breaker", () => {
    // 19. This phase submits nothing, so no such endpoint exists at all.
    const routes = source("app/api/defense/route.ts");
    expect(routes).toContain("export async function GET");
    expect(routes).not.toContain("export async function POST");
    expect(routes).not.toContain("trip_breaker");
  });

  it("never lets an AI provider name reach a breaker call", () => {
    const calls = source("lib/defense/breakerCalls.ts");
    for (const banned of ["gemini", "cloudflare", "Gemini", "Cloudflare"]) {
      expect(calls).not.toContain(banned);
    }
  });
});

// --- 20: the mode is read from Sui, never derived ----------------------------

describe("the mode comes from the chain", () => {
  it("reads the dynamic field rather than any local state", () => {
    const reader = source("lib/sui/breakerReader.ts");
    expect(reader).toContain("getDynamicFields");
    expect(reader).toContain("CircuitBreakerKey");
  });

  it("reports an absent field as NOT_INSTALLED rather than guessing", () => {
    const reader = source("lib/sui/breakerReader.ts");
    expect(reader).toContain('mode: "NOT_INSTALLED"');
  });

  it("never derives the breaker panel's mode from the simulation", () => {
    const panel = source("components/defense/CircuitBreakerPanel.tsx");
    // The panel reads breaker.mode and nothing else. A tripped display must
    // never follow from a click or from the anomaly score.
    expect(panel).toContain('breaker.mode === "HUMAN_ONLY"');
    expect(panel).not.toMatch(/simulating\s*\?\s*"HUMAN_ONLY"/);
    expect(panel).not.toContain("setTripped");
  });

  it("shows an unreadable chain as unknown, not as armed", () => {
    const panel = source("components/defense/CircuitBreakerPanel.tsx");
    expect(panel).toContain("UNKNOWN");
    expect(panel).toContain("not reported as armed");
  });
});

// --- 21-24: the transactions this phase would need ---------------------------

describe("the breaker transactions", () => {
  it("targets treasury::trip_breaker with the owner cap", () => {
    const plan = tripBreakerCall(MANIFEST, 94, "PAYMENT_FREQUENCY", 1_800_000_000_000);
    expect(plan.module).toBe("treasury");
    expect(plan.function).toBe("trip_breaker");
    expect(plan.packageId).toBe(V3);
    expect(plan.arguments).toEqual([
      TREASURY,
      CAP,
      "94",
      "PAYMENT_FREQUENCY",
      "1800000000000",
    ]);
  });

  it("refuses a score outside the recorded scale", () => {
    // The Move parameter is a u8 on a 0..100 scale. Clamping silently would
    // corrupt the one record meant to explain the freeze.
    expect(() => tripBreakerCall(MANIFEST, 101, "X", 1)).toThrow(RangeError);
    expect(() => tripBreakerCall(MANIFEST, -1, "X", 1)).toThrow(RangeError);
    expect(() => tripBreakerCall(MANIFEST, 94.5, "X", 1)).toThrow(RangeError);
  });

  it("names the recovering approver in the reset call", () => {
    const plan = resetBreakerCall(MANIFEST, APPROVER, 1_800_000_000_000);
    expect(plan.function).toBe("reset_breaker");
    expect(plan.arguments).toContain(APPROVER);
  });

  it("states the exact effect of each call", () => {
    expect(initBreakerCall(MANIFEST).effect).toContain("blocks no payment");
    expect(tripBreakerCall(MANIFEST, 94, "X", 1).effect).toContain("115 ECircuitBreakerActive");
    expect(tripBreakerCall(MANIFEST, 94, "X", 1).effect).toContain("Moves no funds");
  });

  it("renders a command that can be checked by hand", () => {
    const rendered = renderBreakerPlan(tripBreakerCall(MANIFEST, 94, "X", 1));
    expect(rendered).toContain("sui client call");
    expect(rendered).toContain("--function trip_breaker");
    // 22. No digest is produced here. These are plans, not receipts.
    expect(rendered).not.toContain("digest");
  });
});

// --- 25-32: Phase 1 regression ------------------------------------------------

describe("Phase 1 is intact", () => {
  const treasuryMove = source("move/payflow/sources/treasury.move");
  const approvalMove = source("move/payflow/sources/approval.move");

  it("keeps the membership freshness rule at one hour", () => {
    expect(treasuryMove).toMatch(/MEMBERSHIP_SYNC_MAX_AGE_MS\s*:\s*u64\s*=\s*3_600_000/);
  });

  it("keeps the approver limit checks unchanged", () => {
    expect(treasuryMove).toContain("if (amount > auth.max_single) return false;");
    expect(treasuryMove).toContain("used + amount <= auth.daily_limit");
  });

  it("keeps the recipient scope restriction", () => {
    expect(treasuryMove).toContain("auth.allowed_recipients.contains(&recipient)");
  });

  it("keeps membership as an upper-level requirement", () => {
    expect(treasuryMove).toContain("if (!auth.membership_active) return false;");
  });

  it("keeps the legacy ApproverCap path sealed", () => {
    expect(approvalMove).toContain("abort ELegacyApprovalPathSealed");
  });

  it("keeps 601 EAboveApproverLimit for an over-ceiling approval", () => {
    expect(approvalMove).toContain("const EAboveApproverLimit: u64 = 601;");
  });

  it("adds only new abort codes rather than renumbering existing ones", () => {
    // Renumbering would silently change what an existing client sees.
    for (const [name, code] of [
      ["ECircuitBreakerActive", 115],
      ["EBreakerNotReady", 116],
      ["ENoHumanRecovery", 117],
    ] as const) {
      expect(treasuryMove).toContain(`const ${name}: u64 = ${code};`);
    }
    for (const [name, code] of [
      ["EWrongTreasury", 100],
      ["EApproversNotReady", 110],
      ["EWrongCompany", 114],
    ] as const) {
      expect(treasuryMove).toContain(`const ${name}: u64 = ${code};`);
    }
  });

  it("adds no field to the published Treasury struct", () => {
    // The upgrade rule that shaped the whole design: a published struct cannot
    // gain a field, so the breaker hangs off the UID as a dynamic field.
    const struct = treasuryMove.slice(
      treasuryMove.indexOf("public struct Treasury<phantom T> has key {"),
      treasuryMove.indexOf("public struct TreasuryOwnerCap"),
    );
    expect(struct).not.toContain("mode");
    expect(struct).not.toContain("breaker");
    expect(treasuryMove).toContain("public struct CircuitBreakerKey has copy, drop, store {}");
  });
});
