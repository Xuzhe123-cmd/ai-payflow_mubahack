"use client";

/**
 * The payment stream, measured against what this treasury normally does.
 *
 * Every row shows the OBSERVED value beside the EXPECTED one, so the reader
 * judges the gap themselves rather than taking a verdict on trust. The score is
 * the sum of the four contributions listed — printed with their weights, so it
 * can be checked by adding them up.
 *
 * The baseline is derived from settled payment history where possible, and the
 * panel says which it is. A "normal" that was typed in by a developer is worth
 * less than one computed from what the treasury actually did, and the reader is
 * entitled to know which they are looking at.
 */

import { Badge, Eyebrow } from "@/components/common/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import type { AnomalySignal } from "@/lib/defense/anomaly";
import type { DefenseSnapshot } from "./types";
import { cn } from "@/lib/utils";

function SignalRow({ signal }: { signal: AnomalySignal }) {
  return (
    <div className="border-t border-hairline py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className={cn("text-[12px]", signal.abnormal ? "text-warn" : "text-pos")}>
            {signal.abnormal ? "⚠" : "✓"}
          </span>
          <span className="text-[12.5px] font-medium text-ink">{signal.label}</span>
        </div>
        <div className="tabular text-[12px] text-ink-soft">
          <span className={cn("font-semibold", signal.abnormal ? "text-warn" : "text-ink")}>
            {signal.observed}
          </span>
          <span className="text-ink-faint"> · expected {signal.expected}</span>
        </div>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-ink-faint">{signal.detail}</p>
        <span className="tabular shrink-0 text-[11px] font-semibold text-ink-faint">
          +{signal.score} / {signal.weight}
        </span>
      </div>
    </div>
  );
}

export function BehavioralMonitor({ snapshot }: { snapshot: DefenseSnapshot | null }) {
  if (!snapshot) {
    return (
      <Panel>
        <PanelHeader eyebrow="Behaviour" title="Behavioral monitor" />
        <PanelBody>
          <p className="text-[12.5px] text-ink-faint">Measuring the payment stream…</p>
        </PanelBody>
      </Panel>
    );
  }

  const { anomaly, stats, baseline } = snapshot;
  const tone =
    anomaly.band === "NORMAL"
      ? "positive"
      : anomaly.band === "ELEVATED"
        ? "warning"
        : "negative";

  return (
    <Panel tone={anomaly.exceedsThreshold ? "negative" : "default"}>
      <PanelHeader
        eyebrow="Behaviour"
        title="Behavioral monitor"
        subtitle="What the payment stream looks like. Per-payment checks cannot see any of this."
        actions={
          <Badge tone={tone} dot>
            {anomaly.exceedsThreshold ? "🚨 ANOMALY DETECTED" : anomaly.band}
          </Badge>
        }
      />
      <PanelBody className="space-y-4">
        {/* The score, and the threshold it is measured against. */}
        <div
          className={cn(
            "rounded-xl border px-4 py-3.5",
            anomaly.exceedsThreshold ? "border-neg/35 bg-neg-soft" : "border-hairline bg-surface-sunken",
          )}
        >
          <div className="flex items-baseline justify-between gap-3">
            <Eyebrow className={anomaly.exceedsThreshold ? "text-neg" : undefined}>
              Anomaly score
            </Eyebrow>
            <div
              className={cn(
                "tabular text-[26px] font-semibold leading-none tracking-[-0.02em]",
                anomaly.exceedsThreshold ? "text-neg" : "text-ink",
              )}
            >
              {anomaly.score}
              <span className="text-[15px] font-normal text-ink-faint"> / 100</span>
            </div>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-hairline">
            <div
              className={cn("h-full rounded-full", anomaly.exceedsThreshold ? "bg-neg" : "bg-pos")}
              style={{ width: `${Math.min(100, anomaly.score)}%` }}
            />
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-soft">
            {anomaly.summary} Trip threshold {anomaly.threshold}.
          </p>
        </div>

        <div>
          {anomaly.signals.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </div>

        {/* The window the figures describe, so "18" has a denominator. */}
        <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
          <Eyebrow>Observation window</Eyebrow>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
            {stats.count} payment{stats.count === 1 ? "" : "s"} in the last{" "}
            {Math.round(stats.windowMs / 3_600_000)} hours; tightest burst {stats.burstCount} in{" "}
            {Math.round(stats.burstWindowMs / 60_000)} minutes. Baseline{" "}
            {baseline.derived ? "derived from settled payment history" : "a stated default (no history)"}
            : ordinary payment ${Math.round(baseline.averageAmountCents / 100).toLocaleString("en-US")},
            up to {baseline.maxNormalPerHour}/hour across ~{baseline.typicalDistinctRecipients}{" "}
            suppliers.
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}
