"use client";

import type { ReactNode } from "react";

import type { CashProjection } from "@/lib/deterministic/projection";
import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { CashFlowChart, ChartLegend } from "@/components/charts/CashFlowChart";
import { formatDay, formatMoneyRounded } from "@/lib/format";

/**
 * The forecast card.
 *
 * The reserve is drawn as a floor rather than described in a sentence, because
 * the operator has to understand "how close are we to the line" in the first
 * second of looking at the screen.
 */
export function CashFlowCard({
  projection,
  title = "Cash flow forecast",
  subtitle,
  activeSeriesId = null,
  compareSeriesId = null,
  activeLabel = "Projected balance",
  compareLabel = null,
  height = 268,
  actions,
  className,
}: {
  projection: CashProjection;
  title?: ReactNode;
  subtitle?: ReactNode;
  activeSeriesId?: string | null;
  compareSeriesId?: string | null;
  activeLabel?: string;
  compareLabel?: string | null;
  height?: number;
  actions?: ReactNode;
  className?: string;
}) {
  const active =
    projection.candidates.find((series) => series.id === activeSeriesId) ??
    projection.baseline;

  return (
    <Panel className={className}>
      <PanelHeader
        eyebrow="Treasury projection"
        title={title}
        subtitle={
          subtitle ??
          `Projected position over the next ${projection.horizonDays} days`
        }
        actions={actions}
      />
      <PanelBody className="px-5 pb-5 pt-4">
        <CashFlowChart
          projection={projection}
          activeSeriesId={activeSeriesId}
          compareSeriesId={compareSeriesId}
          height={height}
        />

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-hairline pt-4">
          <ChartLegend
            reserveCents={projection.minimumReserveCents}
            currency={projection.currency}
            activeLabel={activeLabel}
            compareLabel={compareLabel}
          />

          <div className="flex items-center gap-6">
            <Figure
              label="Current"
              value={formatMoneyRounded(projection.currentCashCents, projection.currency)}
            />
            <Figure
              label={`Projected low · ${formatDay(active.minimumCashDate)}`}
              value={formatMoneyRounded(active.minimumCashCents, projection.currency)}
              tone={active.reserveBreach ? "neg" : "pos"}
            />
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="text-right">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
        {label}
      </div>
      <div
        className={cn(
          "tabular mt-0.5 text-[15px] font-semibold tracking-[-0.01em]",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
          !tone && "text-ink",
        )}
      >
        {value}
      </div>
    </div>
  );
}
