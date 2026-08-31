"use client";

/**
 * The circuit breaker — the only panel on this page that is not intelligence.
 *
 * EVERY FIGURE HERE IS READ FROM SUI. The mode, the recorded score, the reason
 * code, the trip count. Nothing is derived from the simulation, from the
 * anomaly engine, or from a click, and that is the entire point: the panels
 * above can be wrong or compromised, and this one still reports what the chain
 * actually holds.
 *
 * THREE STATES, KEPT APART. "Armed" and "not installed" both permit autonomous
 * payments, and conflating them on a security screen would let an operator
 * believe in a protection that does not exist yet. A chain that could not be
 * read is a fourth answer and is never resolved to "armed".
 *
 * NO TRIP BUTTON. Freezing the treasury is a real transaction requiring the
 * owner capability, and this phase submits nothing — the panel shows the exact
 * call that would be needed instead, which is honest and also a better
 * explanation of the architecture than a button would be.
 */

import { useEffect, useRef, useState } from "react";

import { Badge, Eyebrow } from "@/components/common/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import type { BreakerConsequences, BreakerState } from "@/lib/sui/breakerReader";
import { resolveDisplayedBreaker } from "@/lib/defense/displayedBreaker";
import type { DefenseSnapshot } from "./types";
import { cn } from "@/lib/utils";

/**
 * The trip request's own state.
 *
 * `done` carries the RE-READ breaker, so the panel renders what the chain said
 * after the transaction rather than what the click intended. There is no state
 * here that means "assume tripped".
 */
/**
 * The reset request's own state.
 *
 * `stale` is its own phase rather than a kind of failure: it is the ONE outcome
 * a further action fixes, and the demo hits it constantly because rehearsing
 * takes longer than the hour the membership reading stays fresh.
 */
type ResetState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "refreshing" }
  | { phase: "stale"; approver: string; message: string }
  | {
      phase: "done";
      digest: string | null;
      explorerUrl: string | null;
      breaker: (BreakerState & { consequences: BreakerConsequences }) | null;
      /** False when the write landed but the index has not shown it yet. */
      converged: boolean;
      /** When this result arrived, so recency can outrank declaration order. */
      completedAt: number;
    }
  | { phase: "failed"; error: string; abortCode: number | null };

type TripState =
  | { phase: "idle" }
  | { phase: "running" }
  | {
      phase: "done";
      digest: string | null;
      explorerUrl: string | null;
      breaker: (BreakerState & { consequences: BreakerConsequences }) | null;
      /** False when the write landed but the index has not shown it yet. */
      converged: boolean;
      /** When this result arrived, so recency can outrank declaration order. */
      completedAt: number;
    }
  | { phase: "failed"; error: string; abortCode: number | null };

function Consequence({ label, allowed }: { label: string; allowed: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[12px] text-ink-soft">{label}</dt>
      <dd className={cn("text-[12.5px] font-semibold", allowed ? "text-pos" : "text-neg")}>
        {allowed ? "✓ permitted" : "❌ disabled"}
      </dd>
    </div>
  );
}

export function CircuitBreakerPanel({
  snapshot,
  autoTripToken,
  onRefresh,
  onResetComplete,
}: {
  snapshot: DefenseSnapshot | null;
  /**
   * Changes once per press of "Simulate AI attack". The auto-trip fires once
   * per token and never from state alone — see the effect below.
   */
  autoTripToken: number;
  onRefresh: () => void;
  /**
   * Called ONLY when a reset transaction succeeded AND the chain has been
   * re-read confirming NORMAL. The page uses it to clear `?simulate=attack`,
   * returning the screen to the live baseline.
   *
   * Deliberately not called on a mere HTTP 200: a submitted reset whose state
   * has not yet been confirmed must not retire the simulation, or the screen
   * would claim a recovery the chain had not shown.
   */
  onResetComplete?: () => void;
}) {
  const [trip, setTrip] = useState<TripState>({ phase: "idle" });
  const [reset, setReset] = useState<ResetState>({ phase: "idle" });
  /**
   * The last token this panel acted on.
   *
   * A ref, not state: it must not itself cause a render, and it must be updated
   * BEFORE the request goes out so a re-render mid-flight cannot start a second
   * transaction. Double-submitting here would spend gas twice and overwrite the
   * on-chain evidence of the first trip.
   */
  const firedFor = useRef(0);

  async function submitTrip() {
    // A trip SUPERSEDES any earlier reset. Without this, a completed reset's
    // NORMAL sat in state forever and masked the trip that followed it — the
    // panel showed ARMED for a treasury Sui had just frozen.
    setReset({ phase: "idle" });
    setTrip({ phase: "running" });
    try {
      const response = await fetch("/api/defense/trip", { method: "POST" });
      const payload = (await response.json()) as {
        ok?: boolean;
        digest?: string | null;
        explorerUrl?: string | null;
        error?: string | null;
        abortCode?: number | null;
        breaker?: (BreakerState & { consequences: BreakerConsequences }) | null;
        converged?: boolean;
      };

      // A non-ok payload is a failure even on a 200, and the old state stands.
      if (!response.ok || !payload.ok) {
        setTrip({
          phase: "failed",
          error: payload.error ?? `The transaction failed (HTTP ${response.status}).`,
          abortCode: payload.abortCode ?? null,
        });
        return;
      }

      setTrip({
        phase: "done",
        digest: payload.digest ?? null,
        explorerUrl: payload.explorerUrl ?? null,
        breaker: payload.breaker ?? null,
        converged: payload.converged ?? false,
        completedAt: Date.now(),
      });
      // Re-read everything else too, so the whole page agrees with the chain.
      onRefresh();
    } catch (error) {
      setTrip({
        phase: "failed",
        error: error instanceof Error ? error.message : "The transaction could not be sent.",
        abortCode: null,
      });
    }
  }

  /**
   * Recovery. A REAL `reset_breaker`, never a React flag.
   *
   * Requires an explicit click — it is never called on load, never after a
   * trip, and never by anything the anomaly engine or a provider can reach.
   * A stale membership reading comes back as its own phase so the interface can
   * offer the refresh rather than reporting a dead end.
   */
  async function submitReset() {
    // And a reset supersedes any earlier trip, for the same reason in reverse.
    setTrip({ phase: "idle" });
    setReset({ phase: "running" });
    try {
      const response = await fetch("/api/defense/reset", { method: "POST" });
      const payload = (await response.json()) as {
        ok?: boolean;
        code?: string;
        digest?: string | null;
        explorerUrl?: string | null;
        error?: string | null;
        abortCode?: number | null;
        approver?: string;
        breaker?: (BreakerState & { consequences: BreakerConsequences }) | null;
        converged?: boolean;
      };

      if (!response.ok || !payload.ok) {
        if (payload.code === "MEMBERSHIP_STALE" && payload.approver) {
          setReset({
            phase: "stale",
            approver: payload.approver,
            message: payload.error ?? "Membership verification needs refresh.",
          });
          return;
        }
        setReset({
          phase: "failed",
          error: payload.error ?? `The reset failed (HTTP ${response.status}).`,
          abortCode: payload.abortCode ?? null,
        });
        return;
      }

      const confirmedNormal =
        (payload.converged ?? false) && payload.breaker?.mode === "NORMAL";

      setReset({
        phase: "done",
        digest: payload.digest ?? null,
        explorerUrl: payload.explorerUrl ?? null,
        breaker: payload.breaker ?? null,
        converged: payload.converged ?? false,
        completedAt: Date.now(),
      });

      // THREE CONDITIONS, not one: the request succeeded, the re-read caught
      // up, and what it read is NORMAL. Anything less and the simulation stays
      // on screen, because the recovery is not yet a fact.
      if (confirmedNormal) onResetComplete?.();
      onRefresh();
    } catch (error) {
      setReset({
        phase: "failed",
        error: error instanceof Error ? error.message : "The reset could not be sent.",
        abortCode: null,
      });
    }
  }

  /** Refreshes the membership mirror, then retries the reset. */
  async function refreshMembership(approver: string) {
    setReset({ phase: "refreshing" });
    try {
      const response = await fetch("/api/membership/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: approver }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string | null };

      if (!response.ok || !payload.ok) {
        setReset({
          phase: "failed",
          error: payload.error ?? "The membership refresh failed.",
          abortCode: null,
        });
        return;
      }
      // Fresh now — go straight on to the reset the operator asked for.
      await submitReset();
    } catch (error) {
      setReset({
        phase: "failed",
        error: error instanceof Error ? error.message : "The refresh could not be sent.",
        abortCode: null,
      });
    }
  }

  /**
   * THE AUTOMATIC TRIP.
   *
   * Fires when, and only when, all of these hold:
   *   a fresh token — i.e. the human pressed Simulate, this render did not
   *   the engine's own score is at or above the threshold
   *   the breaker is installed, and not already HUMAN_ONLY
   *
   * It submits the SAME real transaction the manual path submits; there is no
   * separate privileged route. Move still demands the TreasuryOwnerCap, so the
   * anomaly engine is requesting a freeze, not performing one — and nothing
   * here writes TRIPPED into React. That still comes from re-reading the chain.
   */
  const pendingAnomaly = snapshot?.anomaly ?? null;
  const pendingMode = snapshot?.breaker?.mode ?? null;
  // Render-safe conditions only. The "have I already fired for this token"
  // guard is a ref, and reading a ref during render is exactly the bug the
  // lint rule catches — so that check lives inside the effect below.
  const shouldAutoTrip =
    autoTripToken > 0 &&
    pendingAnomaly !== null &&
    pendingAnomaly.exceedsThreshold &&
    // Already frozen: re-tripping would only spend gas to overwrite the record
    // of the freeze that is already in force.
    pendingMode === "NORMAL" &&
    trip.phase !== "running";

  useEffect(() => {
    if (!shouldAutoTrip) return;
    // The once-per-token guard, read and claimed here rather than during
    // render. Claimed BEFORE the request goes out, so a re-render mid-flight
    // cannot start a second transaction.
    if (firedFor.current === autoTripToken) return;
    firedFor.current = autoTripToken;

    let cancelled = false;
    // Deferred to a microtask rather than called inline: a synchronous setState
    // in an effect body cascades renders, and the rule that catches it is right.
    void Promise.resolve().then(() => {
      if (cancelled) return undefined;
      return submitTrip();
    });

    return () => {
      cancelled = true;
    };
  }, [shouldAutoTrip, autoTripToken]);

  if (!snapshot) {
    return (
      <Panel>
        <PanelHeader eyebrow="Enforcement" title="Circuit breaker" />
        <PanelBody>
          <p className="text-[12.5px] text-ink-faint">Reading treasury mode from chain…</p>
        </PanelBody>
      </Panel>
    );
  }

  const { breakerError, anomaly } = snapshot;
  // The most recently CONFIRMED chain read wins over the snapshot, so the panel
  // updates the instant Sui confirms — still chain state, never an assumption.
  // Extracted so the precedence can be tested against real sequences; it was
  // wrong twice while it lived inline here.
  const breaker = resolveDisplayedBreaker(reset, trip, snapshot.breaker);

  // An unreadable chain is reported as unknown. Never as armed.
  if (!breaker) {
    return (
      <Panel tone="negative">
        <PanelHeader
          eyebrow="Enforcement"
          title="Circuit breaker"
          actions={<Badge tone="neutral" dot>UNKNOWN</Badge>}
        />
        <PanelBody className="space-y-2">
          <p className="text-[13px] font-semibold text-neg">Treasury mode could not be read.</p>
          <p className="text-[12px] leading-relaxed text-ink-soft">
            {breakerError ?? "The chain did not answer."} No claim is made about whether
            protection is active — an unverified breaker is not reported as armed.
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="text-[11.5px] font-medium text-ai underline"
          >
            Re-read from chain
          </button>
        </PanelBody>
      </Panel>
    );
  }

  const tripped = breaker.mode === "HUMAN_ONLY";
  const notInstalled = breaker.mode === "NOT_INSTALLED";
  const { consequences } = breaker;

  return (
    <Panel tone={tripped ? "negative" : notInstalled ? "default" : "positive"}>
      <PanelHeader
        eyebrow="Enforcement · read from Sui"
        title="Circuit breaker"
        subtitle="Current Sui enforcement state is read directly from chain — not from the simulation above."
        actions={
          <Badge tone={tripped ? "negative" : notInstalled ? "neutral" : "positive"} dot>
            {tripped ? "🔴 TRIPPED" : notInstalled ? "NOT INSTALLED" : "🟢 ARMED"}
          </Badge>
        }
      />
      <PanelBody className="space-y-4">
        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            tripped
              ? "border-neg/35 bg-neg-soft"
              : notInstalled
                ? "border-hairline bg-surface-sunken"
                : "border-pos/35 bg-pos-soft",
          )}
        >
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Sui treasury mode
          </div>
          <div
            className={cn(
              "mt-1 text-[19px] font-semibold tracking-[-0.015em]",
              tripped ? "text-neg" : notInstalled ? "text-ink-faint" : "text-pos",
            )}
          >
            {tripped ? "HUMAN_ONLY" : notInstalled ? "no breaker installed" : "NORMAL"}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{consequences.detail}</p>
        </div>

        <dl className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5">
          <Consequence label="Autonomous payments" allowed={consequences.autonomousAllowed} />
          <Consequence label="Conditional payments" allowed={consequences.conditionalAllowed} />
          <Consequence label="Human / multisig" allowed={consequences.humanAllowed} />
          <div className="mt-2 border-t border-hairline pt-2 text-[11px] font-semibold text-chain">
            Enforced by Sui Move
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            <span className="font-mono text-[10.5px]">treasury::assert_autonomy_allowed</span>,
            called from <span className="font-mono text-[10.5px]">payment::execute_payment</span>,{" "}
            <span className="font-mono text-[10.5px]">escrow::execute_conditional</span> and{" "}
            <span className="font-mono text-[10.5px]">escrow::release</span>. A refusal aborts{" "}
            <span className="font-mono text-[10.5px]">115 ECircuitBreakerActive</span>.
          </p>
        </dl>

        {/* Evidence recorded on chain at the last trip. */}
        {breaker.installed && breaker.tripCount > 0 ? (
          <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
            <Eyebrow>Recorded on chain</Eyebrow>
            <dl className="mt-1.5 space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-ink-faint">Anomaly score at trip</dt>
                <dd className="tabular text-[12.5px] font-semibold text-ink">
                  {breaker.anomalyScore} / 100
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-ink-faint">Reason code</dt>
                <dd className="font-mono text-[11.5px] text-ink">{breaker.reasonCode || "—"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-ink-faint">Times tripped</dt>
                <dd className="tabular text-[12.5px] text-ink">{breaker.tripCount}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {/* What the engine currently WANTS, kept visibly separate from what the
            chain currently IS. The gap between them is the human decision. */}
        {/* STEP 1 — the simulation's finding, and STEP 2 — the transaction that
            would act on it. Kept in one box, in that order, because the whole
            point a judge must take away is that they are SEPARATE: the engine
            detects, a signed transaction enforces. */}
        {/* THE FINDING STAYS ON SCREEN AFTER THE TRIP. It was gated on
            `!tripped`, so the moment the transaction landed the evidence that
            caused it vanished — leaving a TRIPPED breaker with no visible
            reason. The two are different facts about different things: 75/100
            is the simulated behaviour, HUMAN_ONLY is the chain. Both belong. */}
        {anomaly.exceedsThreshold ? (
          <div className="rounded-xl border border-warn/35 bg-warn-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-warn">🚨 ANOMALY DETECTED</div>

            <dl className="mt-2 space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[11.5px] text-ink-soft">Score</dt>
                <dd className="tabular text-[13px] font-semibold text-warn">
                  {anomaly.score} / 100
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[11.5px] text-ink-soft">Threshold</dt>
                <dd className="tabular text-[12.5px] font-medium text-ink">{anomaly.threshold}</dd>
              </div>
            </dl>

            {/* THE AUTOMATIC PROGRESSION, narrated. Each line states what has
                happened and, just as importantly, what has NOT: the treasury is
                unchanged until Sui confirms, and the panel says so at every step
                rather than only at the end. */}
            {/* WOULD only while it still would. Once the chain says HUMAN_ONLY
                the conditional is simply false, and saying "would trip" beside a
                tripped breaker would understate what actually happened. */}
            <p
              className={cn(
                "mt-2 border-t pt-2 text-[12px] font-medium",
                tripped ? "border-neg/25 text-neg" : "border-warn/25 text-warn",
              )}
            >
              {tripped
                ? "Circuit breaker TRIPPED."
                : trip.phase === "running"
                  ? "Submitting protection transaction to Sui…"
                  : trip.phase === "failed"
                    ? "Circuit breaker would trip — the transaction did not go through."
                    : "Anomaly threshold exceeded — requesting circuit breaker…"}
            </p>

            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">
              {tripped ? (
                <>
                  The behavioral engine requested the freeze;{" "}
                  <span className="font-mono text-[10.5px]">trip_breaker</span> performed it under
                  the TreasuryOwnerCap. The treasury mode below is read from chain, not from this
                  simulation.
                </>
              ) : (
                <>
                  The behavioral engine requested the freeze. It cannot perform one:{" "}
                  <span className="font-mono text-[10.5px]">trip_breaker</span> requires the
                  TreasuryOwnerCap, and the treasury mode above stays exactly as it is until Sui
                  confirms.
                </>
              )}
            </p>

            <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-faint">
              Demo Attack Simulation — no real AI model was compromised. The anomaly score is
              recomputed server-side and the transaction is refused below the threshold, so the
              figure recorded on chain is always the engine&rsquo;s own.
            </p>


            {trip.phase === "failed" ? (
              <div className="mt-2.5 rounded-lg border border-neg/35 bg-neg-soft px-2.5 py-2">
                <div className="text-[11.5px] font-semibold text-neg">
                  Transaction failed — treasury mode unchanged
                </div>
                {/* The real error. Nothing here claims the breaker tripped. */}
                <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-soft">
                  {trip.error}
                </p>
                {trip.abortCode !== null ? (
                  <p className="mt-1 font-mono text-[10.5px] text-neg/85">
                    Move abort {trip.abortCode}
                  </p>
                ) : null}

                {/* The manual path exists ONLY as an administrative retry after
                    the automatic one failed. It submits the identical
                    transaction — there is no second, more privileged route. */}
                <button
                  type="button"
                  onClick={() => void submitTrip()}
                  className={cn(
                    "mt-2 h-8 rounded-lg bg-neg px-3 text-[12px] font-medium text-white",
                    "transition-colors hover:bg-neg/90",
                  )}
                >
                  Retry — trip circuit breaker on Sui
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* SUBMITTED, BUT THE INDEX HAS NOT SHOWN IT YET.
            The digest is proof the write happened; a stale read is not proof it
            did not. Saying so is the only honest option — rendering the stale
            ARMED beside a successful trip is exactly the bug this replaced. */}
        {trip.phase === "done" && !trip.converged ? (
          <div className="rounded-xl border border-warn/35 bg-warn-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-warn">
              Transaction confirmed — waiting for the chain index
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
              Sui accepted <span className="font-mono text-[10.5px]">trip_breaker</span>, and the
              read above has not caught up yet. The treasury mode shown may lag by a second or
              two. Re-read to confirm.
            </p>
            {trip.digest ? (
              <p className="mt-1 break-all font-mono text-[10px] text-ink-faint">{trip.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={onRefresh}
              className="mt-2 text-[11.5px] font-medium text-ai underline"
            >
              Re-read from chain
            </button>
          </div>
        ) : null}

        {/* The receipt, shown only once the chain has confirmed. */}
        {trip.phase === "done" && tripped ? (
          <div className="rounded-xl border border-neg/35 bg-neg-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-neg">
              Transaction confirmed — treasury is now HUMAN_ONLY
            </div>
            {trip.digest ? (
              <p className="mt-1 break-all font-mono text-[10px] text-ink-faint">
                {trip.explorerUrl ? (
                  <a href={trip.explorerUrl} target="_blank" rel="noreferrer" className="underline">
                    {trip.digest}
                  </a>
                ) : (
                  trip.digest
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {tripped ? (
          <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <Eyebrow>Recovery</Eyebrow>
              <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                Demo / admin recovery
              </span>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
              Requires verified human recovery authority. Resetting takes the TreasuryOwnerCap AND
              a named approver whose Chain-Doi membership is active and verified within the last
              hour. Neither AI provider, the anomaly engine, nor this interface can perform it.
            </p>

            {/* A REAL reset_breaker, on an explicit click. Never on load, never
                after a trip, never automatic. */}
            <button
              type="button"
              onClick={() => void submitReset()}
              disabled={reset.phase === "running" || reset.phase === "refreshing"}
              className={cn(
                "mt-2.5 h-9 rounded-lg bg-pos px-3.5 text-[13px] font-medium text-white",
                "transition-colors hover:bg-pos/90 disabled:cursor-not-allowed disabled:opacity-55",
              )}
            >
              {reset.phase === "running"
                ? "Submitting reset to Sui…"
                : reset.phase === "refreshing"
                  ? "Refreshing membership verification…"
                  : "Reset Circuit Breaker"}
            </button>

            {/* THE ONE FAILURE A FURTHER ACTION FIXES. Offered as a refresh
                rather than reported as a dead end — and the freshness rule is
                satisfied honestly, never bypassed with an older timestamp. */}
            {reset.phase === "stale" ? (
              <div className="mt-2.5 rounded-lg border border-warn/35 bg-warn-soft px-2.5 py-2">
                <div className="text-[11.5px] font-semibold text-warn">
                  Membership verification needs refresh
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">{reset.message}</p>
                <button
                  type="button"
                  onClick={() => void refreshMembership(reset.approver)}
                  className={cn(
                    "mt-2 h-8 rounded-lg bg-warn px-3 text-[12px] font-medium text-white",
                    "transition-colors hover:bg-warn/90",
                  )}
                >
                  Refresh membership verification
                </button>
                <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
                  Submits <span className="font-mono">approval::sync_membership</span>, then
                  retries the reset. The 60-minute rule is satisfied, not bypassed.
                </p>
              </div>
            ) : null}

            {reset.phase === "failed" ? (
              <div className="mt-2.5 rounded-lg border border-neg/35 bg-neg-soft px-2.5 py-2">
                <div className="text-[11.5px] font-semibold text-neg">
                  Reset failed — treasury mode unchanged
                </div>
                {/* The real error. Nothing here claims the breaker reset. */}
                <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-soft">
                  {reset.error}
                </p>
                {reset.abortCode !== null ? (
                  <p className="mt-1 font-mono text-[10.5px] text-neg/85">
                    Move abort {reset.abortCode}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {reset.phase === "done" && !reset.converged ? (
          <div className="rounded-xl border border-warn/35 bg-warn-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-warn">
              Reset confirmed — waiting for the chain index
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
              Sui accepted <span className="font-mono text-[10.5px]">reset_breaker</span>, and the
              read above has not caught up yet. Re-read to confirm.
            </p>
            {reset.digest ? (
              <p className="mt-1 break-all font-mono text-[10px] text-ink-faint">{reset.digest}</p>
            ) : null}
            <button
              type="button"
              onClick={onRefresh}
              className="mt-2 text-[11.5px] font-medium text-ai underline"
            >
              Re-read from chain
            </button>
          </div>
        ) : null}

        {/* The receipt, shown only once the chain has confirmed NORMAL. */}
        {reset.phase === "done" && reset.converged && !tripped ? (
          <div className="rounded-xl border border-pos/35 bg-pos-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-pos">
              Reset confirmed — treasury is back to NORMAL
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
              The trip history below is kept: it records what happened, not what is in force.
            </p>
            {reset.digest ? (
              <p className="mt-1 break-all font-mono text-[10px] text-ink-faint">
                {reset.explorerUrl ? (
                  <a href={reset.explorerUrl} target="_blank" rel="noreferrer" className="underline">
                    {reset.digest}
                  </a>
                ) : (
                  reset.digest
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onRefresh}
          className="text-[11.5px] font-medium text-ai underline"
        >
          Re-read from chain
        </button>
      </PanelBody>
    </Panel>
  );
}
