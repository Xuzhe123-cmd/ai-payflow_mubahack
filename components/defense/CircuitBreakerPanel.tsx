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

import { Badge, Eyebrow } from "@/components/common/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import type { DefenseSnapshot } from "./types";
import { cn } from "@/lib/utils";

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
  onRefresh,
}: {
  snapshot: DefenseSnapshot | null;
  onRefresh: () => void;
}) {
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

  const { breaker, breakerError, anomaly } = snapshot;

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
        subtitle="The one fact on this page that is not an opinion. Read from the treasury object on every load."
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
          <p className="mt-1.5 border-t border-hairline pt-2 text-[11px] leading-relaxed text-ink-faint">
            Enforced by <span className="font-mono text-[10.5px]">treasury::assert_autonomy_allowed</span>,
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
        {anomaly.exceedsThreshold && !tripped ? (
          <div className="rounded-xl border border-warn/35 bg-warn-soft px-3.5 py-3">
            <div className="text-[12.5px] font-semibold text-warn">
              ⚠ CIRCUIT BREAKER WOULD TRIP
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
              The behavioral engine detected an anomalous payment pattern — score {anomaly.score},
              at or above the {anomaly.threshold} threshold.
            </p>
            {/* WOULD, not DID. The gap between this box and the mode above it
                is the human decision, and the panel must not close it. */}
            <p className="mt-1.5 border-t border-warn/25 pt-1.5 text-[11px] leading-relaxed text-ink-soft">
              Simulation only — no AI model was compromised and no on-chain state was changed.
              The engine cannot freeze the treasury itself: tripping requires a transaction signed
              with the TreasuryOwnerCap, and none has been submitted. The Sui treasury mode above
              is unchanged.
            </p>
          </div>
        ) : null}

        {tripped ? (
          <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
            <Eyebrow>Recovery</Eyebrow>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
              Human / multisig governance required. Resetting takes the TreasuryOwnerCap AND a
              named approver whose Chain-Doi membership is active and verified within the last
              hour. Neither AI provider, the anomaly engine, nor this interface can perform it.
            </p>
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
