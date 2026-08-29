"use client";

import { cn } from "@/lib/utils";
import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/PageContainer";
import { MetricCard } from "@/components/common/MetricCard";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { CashFlowCard } from "@/components/dashboard/CashFlowCard";
import { EmptyState } from "@/components/common/States";
import { useActiveTreasury } from "@/components/hooks/usePayflowSelectors";
import { formatDay, formatFullDate, formatMoney, formatMoneyRounded } from "@/lib/format";
import type { CashFlowEvent } from "@/lib/types";

export default function TreasuryPage() {
  const { view } = useActiveTreasury();
  const currency = view.treasury.currency;

  const dailyPct =
    view.dailyLimitCents > 0
      ? Math.min(100, Math.round((view.dailySpentCents / view.dailyLimitCents) * 100))
      : 0;

  return (
    <PageContainer>
      <PageHeader
        title="Treasury"
        subtitle="The position every payment decision is measured against. Balances are end-of-day projections from scheduled inflows and outflows."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total balance"
          value={formatMoney(view.treasury.currentCashCents, currency)}
          context={`As of ${formatFullDate(view.asOfDate)}`}
        />
        <MetricCard
          label="Minimum reserve"
          value={formatMoney(view.policy.minimumReserveCents, currency)}
          context="Protected by Sui — no agent payment may cross it"
          accent="chain"
        />
        <MetricCard
          label="Available above reserve"
          value={formatMoney(view.availableCents, currency)}
          context="Spendable without touching the reserve"
          accent="pos"
        />
        <MetricCard
          label="Agent headroom"
          value={formatMoney(view.autonomousHeadroomCents, currency)}
          context="Tightest of the single-payment cap, daily allowance and available cash"
          accent="ai"
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_352px]">
        <CashFlowCard
          projection={view.projection}
          title="Cash flow forecast"
          subtitle={`Projected treasury position over the next ${view.projection.horizonDays} days`}
          height={288}
        />

        <Panel>
          <PanelHeader
            eyebrow="Daily agent spending"
            title="Today's autonomous spend"
            actions={<Badge tone="chain">On-chain counter</Badge>}
          />
          <PanelBody className="space-y-4">
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="tabular text-[23px] font-semibold tracking-[-0.02em] text-ink">
                  {formatMoneyRounded(view.dailySpentCents, currency)}
                </span>
                <span className="tabular text-[13px] text-ink-faint">
                  of {formatMoneyRounded(view.dailyLimitCents, currency)}
                </span>
              </div>
              <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-700",
                    dailyPct > 85 ? "bg-warn" : "bg-chain",
                  )}
                  style={{ width: `${Math.max(dailyPct, 1.5)}%` }}
                />
              </div>
              <p className="mt-2 text-[12px] text-ink-faint">
                The counter resets each epoch. When it is exhausted, every further
                agent payment is rejected on chain until it resets.
              </p>
            </div>

            <div className="space-y-2 border-t border-hairline pt-4">
              <Row
                label="Maximum single payment"
                value={formatMoneyRounded(view.capability.maxSinglePaymentCents, currency)}
              />
              <Row
                label="Daily limit"
                value={formatMoneyRounded(view.dailyLimitCents, currency)}
              />
              <Row
                label="Allowed currencies"
                value={view.policy.allowedCurrencies.join(", ")}
              />
            </div>
          </PanelBody>
        </Panel>
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <div>
          <SectionTitle
            title="Upcoming inflows"
            description="Receivables inside the forecast window"
          />
          <EventList events={view.upcomingInflows} currency={currency} direction="INFLOW" />
        </div>
        <div>
          <SectionTitle
            title="Upcoming outflows"
            description="Committed spending inside the forecast window"
          />
          <EventList events={view.upcomingOutflows} currency={currency} direction="OUTFLOW" />
        </div>
      </div>
    </PageContainer>
  );
}

function EventList({
  events,
  currency,
  direction,
}: {
  events: CashFlowEvent[];
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title={direction === "INFLOW" ? "No scheduled inflows" : "No scheduled outflows"}
        description="Nothing is scheduled inside the current forecast window."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      <ul className="divide-y divide-hairline">
        {events.map((event) => (
          <li key={event.id} className="flex items-center gap-4 px-5 py-3.5">
            <div className="w-14 shrink-0">
              <div className="tabular text-[13px] font-semibold text-ink">
                {formatDay(event.date)}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] text-ink">{event.description}</div>
            </div>
            <div
              className={cn(
                "tabular shrink-0 text-[14px] font-semibold",
                direction === "INFLOW" ? "text-pos" : "text-ink",
              )}
            >
              {direction === "INFLOW" ? "+" : "−"}
              {formatMoneyRounded(event.amountCents, currency)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-ink-faint">{label}</span>
      <span className="tabular text-[13px] font-semibold text-ink">{value}</span>
    </div>
  );
}
