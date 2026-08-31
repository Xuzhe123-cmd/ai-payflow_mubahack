/**
 * The two-step trip: the engine detects, a signed transaction enforces.
 *
 * THE PROPERTY UNDER TEST. Clicking "Simulate AI attack" must never change
 * chain state, and the interface must never say TRIPPED because a button was
 * pressed. Those are separate steps with a human decision between them, and
 * this file asserts the separation from both sides:
 *
 *   the simulation cannot submit    — no POST, no CLI, no cap, anywhere near it
 *   the button cannot lie           — TRIPPED comes from a re-read of the chain
 *   the caller cannot pick a score  — the route recomputes it and refuses low
 *
 * The last one matters most. If the route accepted a score from the client, a
 * hand-made request could freeze the treasury with an invented number, and the
 * figure recorded on chain as the reason for the freeze would be fiction.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assessAnomaly, TRIP_THRESHOLD } from "../../lib/defense/anomaly";
import { buildAttackPattern, buildNormalPattern } from "../../lib/defense/attackSimulation";
import { computeBehaviorStats, deriveBaseline } from "../../lib/defense/behaviorStats";
import { PAYMENT_HISTORY } from "../../lib/demo/paymentHistory";
import { APPROVER_AUTHORITY } from "../../lib/demo/policies";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const tripRoute = code("app/api/defense/trip/route.ts");
const defenseRoute = code("app/api/defense/route.ts");
const panel = code("components/defense/CircuitBreakerPanel.tsx");
const page = code("app/(app)/defense/page.tsx");

// --- the simulation cannot reach the chain -----------------------------------

describe("simulating the attack changes nothing on chain", () => {
  it("is a GET with no submission path", () => {
    expect(defenseRoute).toContain("export async function GET");
    expect(defenseRoute).not.toContain("export async function POST");
    expect(defenseRoute).not.toContain("trip_breaker");
    expect(defenseRoute).not.toContain("submitBreakerCall");
  });

  it("keeps the simulate flag out of the trip route entirely", () => {
    // The trip is never a consequence of the simulation being on; it is a
    // consequence of somebody pressing the button.
    expect(tripRoute).not.toContain('searchParams.get("simulate")');
  });

  it("gives the simulation module no way to submit", () => {
    const sim = code("lib/defense/attackSimulation.ts");
    for (const banned of ["fetch(", "suiCli", "child_process", "trip_breaker", "TreasuryOwnerCap"]) {
      expect(sim, `attackSimulation must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("still produces the deterministic 75 the demo depends on", () => {
    const NOW = 1_800_000_000_000;
    const baseline = deriveBaseline(
      PAYMENT_HISTORY,
      APPROVER_AUTHORITY.maxSinglePaymentCents,
      420_000,
    );
    const window = 24 * 60 * 60 * 1000;
    const attack = assessAnomaly(
      computeBehaviorStats(buildAttackPattern(NOW).events, baseline, NOW, window),
      baseline,
    );
    const normal = assessAnomaly(
      computeBehaviorStats(buildNormalPattern(NOW), baseline, NOW, window),
      baseline,
    );
    expect(attack.score).toBe(75);
    expect(attack.exceedsThreshold).toBe(true);
    expect(normal.score).toBe(6);
    expect(normal.exceedsThreshold).toBe(false);
  });
});

// --- the route decides the score, not the caller -----------------------------

describe("the trip route", () => {
  it("is POST-only, so nothing can freeze the treasury by prefetching", () => {
    expect(tripRoute).toContain("export async function POST");
    expect(tripRoute).not.toContain("export async function GET");
  });

  it("takes no request body at all", () => {
    // Nothing from the caller reaches the transaction.
    expect(tripRoute).not.toContain("request.json()");
    expect(tripRoute).toContain("export async function POST()");
  });

  it("recomputes the anomaly server-side", () => {
    expect(tripRoute).toContain("buildAttackPattern");
    expect(tripRoute).toContain("computeBehaviorStats");
    expect(tripRoute).toContain("assessAnomaly");
  });

  it("refuses below the trip threshold", () => {
    expect(tripRoute).toContain("if (!anomaly.exceedsThreshold)");
    expect(tripRoute).toContain("BELOW_THRESHOLD");
    expect(tripRoute).toContain("Nothing was submitted");
  });

  it("records the engine's own score and dominant reason", () => {
    expect(tripRoute).toContain("anomaly.score");
    expect(tripRoute).toContain("anomaly.reasonCodes[0]");
    // Never a literal.
    expect(tripRoute).not.toMatch(/tripBreakerCall\([^)]*,\s*\d+\s*,/);
  });

  it("re-reads the chain, WAITING for the index, before reporting the new state", () => {
    // A single immediate read goes through the GraphQL indexer, which trails
    // the fullnode — and returned the pre-trip value, rendering a successful
    // freeze as ARMED.
    const afterSubmit = tripRoute.slice(tripRoute.indexOf("submitBreakerCall"));
    expect(afterSubmit).toContain("readBreakerUntil");
    expect(afterSubmit).toContain('"HUMAN_ONLY"');
  });

  it("reports whether the read actually caught up", () => {
    expect(tripRoute).toContain("converged");
    // The interface needs to tell "not tripped" from "not yet visible".
    expect(panel).toContain("trip.converged");
    expect(panel).toContain("Transaction confirmed — waiting for the chain index");
  });

  it("returns the real error and no breaker state on failure", () => {
    expect(tripRoute).toContain("SUBMIT_FAILED");
    expect(tripRoute).toContain("result.error");
    expect(tripRoute).toContain("result.abortCode");
  });

  it("never invents a digest", () => {
    expect(tripRoute).toContain("result.digest");
    expect(tripRoute).not.toMatch(/digest:\s*["'`]/);
  });
});

// --- the submitter will not pretend ------------------------------------------

describe("the submitter", () => {
  const submit = code("lib/defense/breakerSubmit.ts");

  it("has no simulated branch", () => {
    expect(submit).not.toContain("simulated");
    expect(submit).toContain("callAllowingAbort");
  });

  it("never retries a Move abort", () => {
    // An abort is the chain's answer. Retrying could double-submit a call that
    // actually succeeded.
    expect(submit).toContain("attempt.abortCode === null");
  });

  it("reports only what the chain returned", () => {
    expect(submit).toContain("outcome.digest ?? null");
    expect(submit).toContain("digest: null");
  });
});

// --- the interface cannot fake TRIPPED ---------------------------------------

describe("what the panel is allowed to show", () => {
  it("derives TRIPPED from chain state only", () => {
    expect(panel).toContain('breaker.mode === "HUMAN_ONLY"');
    // The shortcuts this design refuses.
    expect(panel).not.toContain("setTripped");
    expect(panel).not.toMatch(/tripped\s*=\s*true/);
    expect(panel).not.toMatch(/trip\.phase === "done"\s*\?\s*"HUMAN_ONLY"/);
  });

  it("prefers a RE-READ breaker over the snapshot, and nothing else", () => {
    // The rule now lives in `resolveDisplayedBreaker`, tested against real
    // sequences in displayedBreaker.test.ts — it was wrong twice while it was
    // an inline chain of `||` here, and source reading never caught it.
    expect(panel).toContain("resolveDisplayedBreaker(reset, trip, snapshot.breaker)");
    expect(panel).not.toContain('(reset.phase === "done" && reset.breaker) ||');
  });

  it("shows the confirmation only when the chain also says tripped", () => {
    // `done` alone is not enough; the chain must agree.
    expect(panel).toContain('trip.phase === "done" && tripped');
  });

  it("keeps the old state and shows the real error on failure", () => {
    expect(panel).toContain("Transaction failed — treasury mode unchanged");
    expect(panel).toContain("{trip.error}");
    expect(panel).toContain("Move abort {trip.abortCode}");
  });

  it("treats a non-ok payload as a failure even on HTTP 200", () => {
    expect(panel).toContain("!response.ok || !payload.ok");
  });
});

// --- the two-step story a judge must read ------------------------------------

describe("the automatic progression is labelled", () => {
  const rendered = panel.replace(/\s+/g, " ");

  it("reports the finding with its score and threshold", () => {
    expect(rendered).toContain("🚨 ANOMALY DETECTED");
    expect(rendered).toContain("{anomaly.score} / 100");
    expect(rendered).toContain("{anomaly.threshold}");
  });

  it("narrates each step, and what has NOT happened at each", () => {
    expect(rendered).toContain("Anomaly threshold exceeded — requesting circuit breaker…");
    expect(rendered).toContain("Submitting protection transaction to Sui…");
    // The conditional survives ONLY on the failure path, where nothing tripped.
    expect(rendered).toContain("Circuit breaker would trip — the transaction did not go through.");
  });

  it("says TRIPPED, not WOULD, once the chain has tripped", () => {
    // "would trip" beside a tripped breaker would understate what happened.
    expect(rendered).toContain('tripped ? "Circuit breaker TRIPPED."');
  });

  it("keeps the finding visible after the trip", () => {
    // Gated on `!tripped`, the evidence vanished the moment the transaction
    // landed, leaving a TRIPPED breaker with no visible cause.
    expect(rendered).toContain("{anomaly.exceedsThreshold ? (");
    expect(rendered).not.toContain("anomaly.exceedsThreshold && !tripped");
  });

  it("says the engine requested the freeze and cannot perform one", () => {
    expect(rendered).toContain("The behavioral engine requested the freeze. It cannot perform one");
    expect(rendered).toContain("requires the TreasuryOwnerCap");
    expect(rendered).toContain("stays exactly as it is until Sui confirms");
    expect(rendered).toContain("trip_breaker");
  });

  it("carries the demo-simulation label", () => {
    expect(rendered).toContain("Demo Attack Simulation — no real AI model was compromised.");
  });

  it("names Sui Move as the enforcement boundary", () => {
    expect(rendered).toContain("Enforced by Sui Move");
  });

  it("keeps a manual retry ONLY as an administrative fallback after a failure", () => {
    // The normal path is automatic; the button exists so a failed trip can be
    // retried without re-running the simulation. It submits the identical
    // transaction — there is no second, more privileged route.
    expect(rendered).toContain("Retry — trip circuit breaker on Sui");
    const failureBox = panel.slice(panel.indexOf('trip.phase === "failed" ?'));
    expect(failureBox).toContain("onClick={() => void submitTrip()}");
    // And it is not offered on the normal path.
    const beforeFailure = panel.slice(0, panel.indexOf('trip.phase === "failed" ?'));
    expect(beforeFailure).not.toContain("void submitTrip()");
  });

  it("shows the armed and tripped states distinctly", () => {
    expect(rendered).toContain('tripped ? "🔴 TRIPPED"');
    expect(rendered).toContain('"🟢 ARMED"');
    expect(rendered).toContain('tripped ? "HUMAN_ONLY"');
  });

  it("keeps the on-chain trip history visible", () => {
    expect(rendered).toContain("Recorded on chain");
    expect(rendered).toContain("{breaker.anomalyScore} / 100");
    expect(rendered).toContain("{breaker.reasonCode");
    expect(rendered).toContain("{breaker.tripCount}");
  });

  it("does not auto-submit from the page either", () => {
    expect(page).not.toContain("/api/defense/trip");
  });
});

// --- the threshold is the engine's, not the interface's ----------------------

describe("the threshold is shared", () => {
  it("is the same constant everywhere", () => {
    expect(TRIP_THRESHOLD).toBe(70);
    // The panel reads it off the assessment rather than restating it.
    expect(panel).toContain("anomaly.threshold");
    expect(panel).not.toContain("70");
  });
});

// --- the automatic trip fires on the CLICK, never on state -------------------

describe("what arms the automatic trip", () => {
  it("is a token the click handler increments, not the URL or the score", () => {
    // The simulation now lives in the URL so it survives a re-mount, which
    // makes this distinction sharper, not weaker: loading ?simulate=attack
    // shows the simulation and submits NOTHING. Only the click arms the trip.
    expect(page).toContain("setTripToken((value) => value + 1)");
    const handler = page.slice(page.indexOf("onClick={() => {"), page.indexOf("Simulate AI attack"));
    expect(handler).toContain('setParams({ simulate: "attack" })');
    expect(handler).toContain("setTripToken");
  });

  it("reads the simulation from the URL, so a re-mount cannot lose it", () => {
    expect(page).toContain('searchParams.get("simulate") === "attack"');
    // And clearing it returns to the live baseline.
    expect(page).toContain("setParams({ simulate: null })");
  });

  it("does not arm the trip from the URL alone", () => {
    // `autoTripToken` starts at 0 and the guard requires > 0, so a fresh load
    // of ?simulate=attack can never submit.
    expect(page).toContain("useState(0)");
    expect(panel).toContain("autoTripToken > 0");
  });

  it("passes the token to the panel", () => {
    expect(page).toContain("autoTripToken={tripToken}");
  });

  it("requires a fresh token, a real finding, and an ARMED breaker", () => {
    const guard = panel.slice(panel.indexOf("const shouldAutoTrip ="), panel.indexOf("useEffect(() => {"));
    expect(guard).toContain("autoTripToken > 0");
    expect(guard).toContain("pendingAnomaly.exceedsThreshold");
    // Never re-trips an already-frozen treasury: that would only spend gas to
    // overwrite the record of the freeze already in force.
    expect(guard).toContain('pendingMode === "NORMAL"');
  });

  it("fires at most once per token", () => {
    const effect = panel.slice(panel.indexOf("useEffect(() => {"));
    expect(effect).toContain("if (firedFor.current === autoTripToken) return;");
    // Claimed BEFORE the request, so a re-render mid-flight cannot start a
    // second transaction.
    expect(effect.indexOf("firedFor.current = autoTripToken")).toBeLessThan(
      effect.indexOf("submitTrip()"),
    );
  });

  it("reads the once-per-token guard outside render", () => {
    // Reading a ref during render is a real bug, not a lint nicety.
    const beforeEffect = panel.slice(0, panel.indexOf("useEffect(() => {"));
    expect(beforeEffect).not.toContain("firedFor.current !==");
  });

  it("still refuses to write TRIPPED from the client", () => {
    expect(panel).toContain('breaker.mode === "HUMAN_ONLY"');
    // Every branch of the mode comes from a chain read, never a literal.
    expect(panel).toContain("resolveDisplayedBreaker(reset, trip, snapshot.breaker)");
    expect(panel).toContain("breaker: payload.breaker ?? null");
    expect(panel).not.toMatch(/setTrip\(\{\s*phase:\s*"done"[^}]*breaker:\s*\{/);
    expect(panel).not.toMatch(/mode:\s*"HUMAN_ONLY"/);
  });
});
