/**
 * Recovery: a real transaction, governed by a human, repeatable for rehearsal.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE TRIP. Freezing removes autonomy and needs
 * one signature; restoring it gives autonomy back and needs a signature AND a
 * person the company still vouches for, verified within the hour. The asymmetry
 * is the whole security argument, so these tests assert it from both ends: the
 * conditions Move enforces, and the fact that nothing here can route around
 * them.
 *
 * THE STALE CASE IS THE INTERESTING ONE. `reset_breaker` takes `now_ms` as a
 * parameter rather than reading the Clock, so a caller COULD pass an old
 * timestamp and slip past the freshness check. The route must always send the
 * real clock and refuse instead — the extra `sync_membership` transaction is
 * the honest cost of the rule, and defeating it would make the rule decorative.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readRecoveryRoster } from "../../lib/defense/recoveryApprover";
import { MEMBERSHIP_SYNC_MAX_AGE_MS } from "../../lib/identity/paymentAuthority";
import { resetBreakerCall } from "../../lib/defense/breakerCalls";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const resetRoute = code("app/api/defense/reset/route.ts");
const panel = code("components/defense/CircuitBreakerPanel.tsx");
const page = code("app/(app)/defense/page.tsx");

const NOW = 1_800_000_000_000;
const APPROVER = "0x9840c5c522e7e94bd01ffe0a57da9a10853cadb40574da5a5f058d3913ffa443";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";

/** A treasury whose one approver record carries these fields. */
function rosterWith(overrides: Record<string, unknown> = {}) {
  return {
    async getDynamicFields() {
      return [
        {
          name: APPROVER,
          nameType: "0x2::dynamic_field::Field<address, …::ApproverAuthorization>",
          value: {
            fields: {
              max_single: "25000000000",
              daily_limit: "50000000000",
              enabled: true,
              expires_at_ms: String(NOW + 30 * 86_400_000),
              membership_active: true,
              membership_synced_at_ms: String(NOW - 60_000),
              ...overrides,
            },
          },
        },
        // Not an authorization: skipped rather than guessed at.
        { name: "roster", nameType: "…::ApproversKey", value: { fields: {} } },
      ];
    },
    async getObjectFields() {
      return null;
    },
  } as unknown as Parameters<typeof readRecoveryRoster>[0];
}

// --- who may recover ----------------------------------------------------------

describe("resolving recovery authority from chain", () => {
  it("accepts an approver in good standing", async () => {
    const roster = await readRecoveryRoster(rosterWith(), TREASURY, NOW);
    expect(roster.eligible?.address).toBe(APPROVER);
    expect(roster.eligible?.inGoodStanding).toBe(true);
    expect(roster.refreshable).toBeNull();
  });

  it("skips dynamic fields that are not authorizations", async () => {
    const roster = await readRecoveryRoster(rosterWith(), TREASURY, NOW);
    // The roster vector and the breaker share the treasury's UID.
    expect(roster.approvers).toHaveLength(1);
  });

  it("reports a stale mirror as REFRESHABLE, not as a dead end", async () => {
    const stale = rosterWith({
      membership_synced_at_ms: String(NOW - MEMBERSHIP_SYNC_MAX_AGE_MS - 1),
    });
    const roster = await readRecoveryRoster(stale, TREASURY, NOW);
    expect(roster.eligible).toBeNull();
    expect(roster.refreshable?.address).toBe(APPROVER);
    expect(roster.refreshable?.staleOnly).toBe(true);
    // Everything except freshness still holds.
    expect(roster.refreshable?.enabled).toBe(true);
    expect(roster.refreshable?.membershipActive).toBe(true);
  });

  it.each([
    ["revoked at the company", { membership_active: false }],
    ["authorization disabled", { enabled: false }],
    ["authorization expired", { expires_at_ms: String(NOW - 1) }],
  ])("offers no recovery and no refresh when %s", async (_label, overrides) => {
    const roster = await readRecoveryRoster(rosterWith(overrides), TREASURY, NOW);
    expect(roster.eligible).toBeNull();
    // A refresh would copy the same refusal across; it must not be offered.
    expect(roster.refreshable).toBeNull();
  });

  it("treats a never-synced mirror as stale, not as fresh", async () => {
    const roster = await readRecoveryRoster(
      rosterWith({ membership_synced_at_ms: "0" }),
      TREASURY,
      NOW,
    );
    expect(roster.eligible).toBeNull();
    expect(roster.refreshable?.membershipAgeMs).toBeNull();
  });

  it("mirrors the Move freshness constant rather than restating it", () => {
    expect(MEMBERSHIP_SYNC_MAX_AGE_MS).toBe(3_600_000);
    const treasuryMove = source("move/payflow/sources/treasury.move");
    expect(treasuryMove).toMatch(/MEMBERSHIP_SYNC_MAX_AGE_MS\s*:\s*u64\s*=\s*3_600_000/);
    // The reader imports it; it does not hardcode an hour of its own.
    expect(code("lib/defense/recoveryApprover.ts")).toContain("MEMBERSHIP_SYNC_MAX_AGE_MS");
    expect(code("lib/defense/recoveryApprover.ts")).not.toContain("3_600_000");
  });
});

// --- the route ----------------------------------------------------------------

describe("the reset route", () => {
  it("is POST-only, so a page load can never reset the breaker", () => {
    expect(resetRoute).toContain("export async function POST");
    expect(resetRoute).not.toContain("export async function GET");
  });

  it("takes no request body, so the approver cannot be claimed by the caller", () => {
    expect(resetRoute).not.toContain("request.json()");
    expect(resetRoute).toContain("export async function POST()");
    expect(resetRoute).toContain("readRecoveryRoster");
  });

  it("refuses when the treasury is not tripped", () => {
    expect(resetRoute).toContain("NOT_TRIPPED");
    expect(resetRoute).toContain('before.mode !== "HUMAN_ONLY"');
  });

  it("refuses a stale mirror instead of bypassing the rule", () => {
    expect(resetRoute).toContain("MEMBERSHIP_STALE");
    expect(resetRoute).toContain("Nothing was submitted");
    // The bypass this route must never use.
    expect(resetRoute).not.toMatch(/membershipSyncedAtMs\s*\+/);
    expect(resetRoute).not.toContain("staleOnly ? ");
  });

  it("always sends the REAL clock", () => {
    expect(resetRoute).toContain("const nowMs = Date.now();");
    expect(resetRoute).toContain("resetBreakerCall(manifest, roster.eligible.address, nowMs)");
  });

  it("re-reads the chain, WAITING for the index, before reporting NORMAL", () => {
    const afterSubmit = resetRoute.slice(resetRoute.indexOf("submitBreakerCall"));
    expect(afterSubmit).toContain("readBreakerUntil");
    expect(afterSubmit).toContain('"NORMAL"');
    expect(resetRoute).toContain("converged");
  });

  it("returns the real error on failure", () => {
    expect(resetRoute).toContain("SUBMIT_FAILED");
    expect(resetRoute).toContain("result.abortCode");
    expect(resetRoute).not.toMatch(/digest:\s*["'`]/);
  });

  it("builds the call against the treasury and owner cap", () => {
    const plan = resetBreakerCall(
      {
        packageId: "0xv1",
        coinType: "0xv1::mock_usdc::MOCK_USDC",
        objects: { treasuryId: TREASURY, treasuryOwnerCapId: "0xcap" },
        upgrade: { packageId: "0xv4", version: 4 },
      } as unknown as DeploymentManifest,
      APPROVER,
      NOW,
    );
    expect(plan.function).toBe("reset_breaker");
    expect(plan.arguments).toEqual([TREASURY, "0xcap", APPROVER, String(NOW)]);
  });
});

// --- the interface ------------------------------------------------------------

describe("the reset UI", () => {
  const rendered = panel.replace(/\s+/g, " ");

  it("offers the action only while tripped", () => {
    const recovery = panel.slice(panel.indexOf("Eyebrow>Recovery"));
    expect(recovery).toContain("Reset Circuit Breaker");
    // The whole recovery block sits inside the `tripped` branch.
    expect(panel).toContain("{tripped ? (");
  });

  it("labels the authority it requires", () => {
    expect(rendered).toContain("Requires verified human recovery authority.");
    expect(rendered).toContain("Demo / admin recovery");
  });

  it("states that AI cannot perform it", () => {
    expect(rendered).toContain(
      "Neither AI provider, the anomaly engine, nor this interface can perform it.",
    );
  });

  it("offers the refresh when, and only when, the mirror is stale", () => {
    expect(rendered).toContain("Membership verification needs refresh");
    expect(rendered).toContain("Refresh membership verification");
    expect(rendered).toContain('reset.phase === "stale"');
    expect(rendered).toContain("The 60-minute rule is satisfied, not bypassed.");
  });

  it("reuses the existing sync_membership endpoint", () => {
    expect(panel).toContain('"/api/membership/sync"');
    expect(panel).toContain("approval::sync_membership");
  });

  it("never claims NORMAL before the chain confirms", () => {
    // The receipt requires a completed request, a converged read, AND the
    // chain agreeing — three conditions, not one.
    expect(rendered).toContain('reset.phase === "done" && reset.converged && !tripped');
    expect(panel).toContain('breaker.mode === "HUMAN_ONLY"');
    expect(panel).not.toMatch(/setReset\([^)]*mode:\s*"NORMAL"/);
  });

  it("says so when the write landed but the index has not caught up", () => {
    // A digest proves the write; a stale read does not disprove it.
    expect(rendered).toContain('reset.phase === "done" && !reset.converged');
    expect(rendered).toContain("Reset confirmed — waiting for the chain index");
  });

  it("prefers the re-read breaker from the reset", () => {
    expect(panel).toContain("resolveDisplayedBreaker(reset, trip, snapshot.breaker)");
    expect(panel).toContain("breaker: payload.breaker ?? null");
  });

  it("clears the trip result when a reset starts, and vice versa", () => {
    // At most one action may be `done`, so a stale result can never mask a
    // newer one — the failure that showed ARMED for a frozen treasury.
    const tripFn = panel.slice(panel.indexOf("async function submitTrip"));
    expect(tripFn.slice(0, tripFn.indexOf("await fetch"))).toContain(
      'setReset({ phase: "idle" })',
    );
    const resetFn = panel.slice(panel.indexOf("async function submitReset"));
    expect(resetFn.slice(0, resetFn.indexOf("await fetch"))).toContain(
      'setTrip({ phase: "idle" })',
    );
  });

  it("keeps the old state and the real error on failure", () => {
    expect(rendered).toContain("Reset failed — treasury mode unchanged");
    expect(rendered).toContain("{reset.error}");
  });

  it("prevents duplicate submissions while in flight", () => {
    expect(rendered).toContain(
      'disabled={reset.phase === "running" || reset.phase === "refreshing"}',
    );
  });

  it("keeps the trip history after a reset", () => {
    // History is what happened, not what is in force.
    expect(rendered).toContain("Recorded on chain");
    expect(rendered).toContain("{breaker.anomalyScore} / 100");
    expect(rendered).toContain("{breaker.tripCount}");
    expect(rendered).toContain("records what happened, not what is in force");
  });
});

// --- nothing resets on its own ------------------------------------------------

describe("what cannot reset the breaker", () => {
  it("is never called on page load", () => {
    expect(page).not.toContain("/api/defense/reset");
    // No effect fires it; only the button's onClick does.
    expect(panel).not.toMatch(/useEffect\([^)]*submitReset/);
    expect(panel).toContain("onClick={() => void submitReset()}");
  });

  it("is never called automatically after a trip", () => {
    const tripEffect = panel.slice(
      panel.indexOf("const shouldAutoTrip"),
      panel.indexOf("}, [shouldAutoTrip, autoTripToken]);"),
    );
    expect(tripEffect).not.toContain("submitReset");
    expect(tripEffect).not.toContain("reset");
  });

  it("gives the AI layer no path to it", () => {
    for (const file of [
      "lib/defense/anomaly.ts",
      "lib/defense/behaviorStats.ts",
      "lib/defense/attackSimulation.ts",
      "lib/ai/dualAnalysis.ts",
      "lib/demo/providerAnalysisCatalog.ts",
    ]) {
      const text = code(file);
      expect(text, `${file} must not reference reset_breaker`).not.toContain("reset_breaker");
      expect(text, `${file} must not reach the reset route`).not.toContain("/api/defense/reset");
    }
  });

  it("keeps Move authorization semantics untouched", () => {
    const treasuryMove = source("move/payflow/sources/treasury.move");
    const body = treasuryMove.slice(treasuryMove.indexOf("public fun reset_breaker"));
    expect(body).toContain("assert_owner(treasury, cap)");
    expect(body).toContain("approver_in_good_standing");
    expect(body).toContain("ENoHumanRecovery");
  });
});

// --- the rehearsal cycle ------------------------------------------------------

describe("a confirmed reset retires the simulation", () => {
  /**
   * THE BUG THIS CLOSES. `?simulate=attack` survived the reset, so the monitor
   * kept reading 75 beside a correctly-ARMED breaker, and the Simulate button
   * stayed disabled because `simulating` was still true. The screen read as
   * "the reset did not take", and rehearsing needed an undocumented extra click
   * to clear the simulation first.
   */
  it("clears the simulation ONLY when the chain confirms NORMAL", () => {
    // Three conditions, not one: the request succeeded, the re-read caught up,
    // and what it read is NORMAL.
    expect(panel).toContain(
      '(payload.converged ?? false) && payload.breaker?.mode === "NORMAL"',
    );
    expect(panel).toContain("if (confirmedNormal) onResetComplete?.();");
  });

  it("does not retire the simulation on a mere HTTP 200", () => {
    // A submitted reset whose state has not been confirmed must leave the
    // simulation on screen — it has not recovered anything yet.
    const handler = panel.slice(panel.indexOf("async function submitReset"));
    const guardIndex = handler.indexOf("const confirmedNormal");
    const callIndex = handler.indexOf("onResetComplete?.()");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(guardIndex);

    // Never reached from the stale branch, which returns before the guard.
    const staleBranch = handler.slice(
      handler.indexOf('code === "MEMBERSHIP_STALE"'),
      guardIndex,
    );
    expect(staleBranch).not.toContain("onResetComplete");
  });

  it("clears the URL parameter, returning the page to the live baseline", () => {
    expect(page).toContain("onResetComplete={() => {");
    expect(page).toContain("setParams({ simulate: null })");
    // The baseline is whatever the engine currently computes, not a literal.
    expect(page).toContain('searchParams.get("simulate") === "attack"');
  });

  it("re-enables the Simulate button once the simulation is cleared", () => {
    // `disabled={simulating || loading}` — with the parameter gone, simulating
    // is false and the button is live for the next rehearsal.
    expect(page).toContain("disabled={simulating || loading}");
  });

  it("makes a re-trip impossible rather than merely guarded", () => {
    // With the simulation off the anomaly falls to the live baseline, below the
    // threshold, so `shouldAutoTrip` is false whatever the token holds.
    const guard = panel.slice(
      panel.indexOf("const shouldAutoTrip ="),
      panel.indexOf("useEffect(() => {"),
    );
    expect(guard).toContain("pendingAnomaly.exceedsThreshold");
    expect(guard).toContain('pendingMode === "NORMAL"');
  });

  it("still requires a NEW click to start the next trip", () => {
    // The token only ever advances in the Simulate handler; clearing the
    // simulation does not touch it, and the once-per-token ref still holds.
    const clearHandler = page.slice(
      page.indexOf("onResetComplete={() => {"),
      page.indexOf("/>", page.indexOf("onResetComplete={() => {")),
    );
    expect(clearHandler).not.toContain("setTripToken");
    expect(page).toContain("setTripToken((value) => value + 1)");
    const simulateHandler = page.slice(
      page.indexOf("onClick={() => {"),
      page.indexOf("Simulate AI attack"),
    );
    expect(simulateHandler).toContain("setTripToken");
    expect(panel).toContain("if (firedFor.current === autoTripToken) return;");
  });

  it("keeps the trip history through the whole cycle", () => {
    // reset_breaker writes mode and reset_at_ms only — Move never clears the
    // count, the score, or the reason.
    const treasuryMove = source("move/payflow/sources/treasury.move");
    const body = treasuryMove.slice(
      treasuryMove.indexOf("public fun reset_breaker"),
      treasuryMove.indexOf("}", treasuryMove.indexOf("breaker.reset_at_ms = now_ms;")),
    );
    expect(body).toContain("breaker.mode = MODE_NORMAL;");
    expect(body).toContain("breaker.reset_at_ms = now_ms;");
    expect(body).not.toContain("trip_count = 0");
    expect(body).not.toContain("anomaly_score = 0");
    expect(body).not.toContain("reason_code =");
  });
});
