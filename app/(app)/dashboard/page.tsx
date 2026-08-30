"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/PageContainer";
import { MetricCard } from "@/components/common/MetricCard";
import { Badge } from "@/components/common/Badge";
import { LinkButton } from "@/components/common/LinkButton";
import { Skeleton } from "@/components/common/States";
import { EngineNotice } from "@/components/common/EngineNotice";
import { ConnectInboxCard } from "@/components/dashboard/ConnectInboxCard";
import { CashFlowCard } from "@/components/dashboard/CashFlowCard";
import { AIInsightCard } from "@/components/dashboard/AIInsightCard";
import { AgentStatusCard } from "@/components/dashboard/AgentStatusCard";
import { OracleCard } from "@/components/dashboard/OracleCard";
import { PipelineStrip } from "@/components/dashboard/PipelineStrip";
import { InvoiceTable } from "@/components/invoices/InvoiceTable";
import { usePayflow } from "@/components/providers/PayflowProvider";
import {
  useActiveTreasury,
  useFeaturedInvoice,
  useInvoiceEntries,
  useInvoiceStats,
} from "@/components/hooks/usePayflowSelectors";
import { formatMoneyRounded, greeting } from "@/lib/format";
import { buildTreasuryOracleFeed } from "@/lib/oracle/feed";

export default function DashboardPage() {
  const { state } = usePayflow();
  const stats = useInvoiceStats();
  const featured = useFeaturedInvoice();
  const entries = useInvoiceEntries();
  const { view } = useActiveTreasury();

  const connected = state.inboxStatus === "CONNECTED";
  const operatorName = state.session?.operatorName ?? "";

  // Derived in lib/oracle, not here — components report figures, they do not
  // compute them.
  const oracleFeed = buildTreasuryOracleFeed({
    inflowCount: view.upcomingInflows.length,
    outflowCount: view.upcomingOutflows.length,
    horizonDays: view.projection.horizonDays,
    supplierCount: view.suppliers.total,
    approvedSupplierCount: view.suppliers.approved,
    invoiceCount: entries.length,
    settledInvoiceCount: stats.paid,
  });

  return (
    <PageContainer>
      <PageHeader
        eyebrow={greeting()}
        title="Treasury overview"
        subtitle={
          connected
            ? subtitleFor(stats.analyzing, stats.needsReview + stats.blocked, stats.total)
            : `Welcome back${operatorName ? `, ${operatorName}` : ""}. Connect a finance inbox to start monitoring supplier invoices.`
        }
        actions={
          connected ? (
            <LinkButton href="/invoices" variant="outline" size="sm" className="rounded-lg">
              View all invoices
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} />
            </LinkButton>
          ) : null
        }
      />

      {/* Oracle → AI → Guard → Sui, above the numbers, so the architecture is
          read before the figures it produced. */}
      <PipelineStrip className="mb-5" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Treasury balance"
          value={formatMoneyRounded(view.treasury.currentCashCents, view.treasury.currency)}
          context={`${view.projection.events.length} scheduled movements in the next ${view.projection.horizonDays} days`}
        />
        <MetricCard
          label="Available above reserve"
          value={formatMoneyRounded(view.availableCents, view.treasury.currency)}
          context={`${formatMoneyRounded(view.policy.minimumReserveCents)} minimum reserve protected on chain`}
          accent="chain"
        />
        <MetricCard
          label="Pending invoices"
          value={connected ? String(stats.total - stats.paid) : "—"}
          context={
            connected
              ? `${stats.needsReview} awaiting review · ${stats.scheduled} scheduled`
              : "Finance inbox not connected"
          }
          accent={stats.needsReview > 0 ? "warn" : null}
        />
        <MetricCard
          label="Agent headroom"
          value={formatMoneyRounded(view.autonomousHeadroomCents, view.treasury.currency)}
          context="Largest payment the agent may make without a human"
          accent="ai"
          trailing={
            <Badge tone="positive" dot pulse>
              Active
            </Badge>
          }
        />
      </div>

      {!connected ? (
        <div className="mt-5">
          <ConnectInboxCard />
        </div>
      ) : (
        <>
          {featured ? (
            <div className="mt-5 space-y-4 animate-rise">
              {featured.run?.analysis ? (
                <EngineNotice analysis={featured.run.analysis} />
              ) : null}
              <AIInsightCard entry={featured} />
            </div>
          ) : stats.analyzing > 0 ? (
            <div className="mt-5 rounded-xl border border-ai-border bg-ai-soft px-5 py-5">
              <div className="flex items-center gap-3">
                <span className="size-4 animate-spin rounded-full border-2 border-ai/25 border-t-ai" />
                <span className="text-[13.5px] font-medium text-ai">
                  The agent is analyzing {stats.analyzing} invoice
                  {stats.analyzing === 1 ? "" : "s"} — facts first, then a
                  recommendation, then on-chain policy.
                </span>
              </div>
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ) : null}

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_352px]">
            <CashFlowCard
              projection={view.projection}
              subtitle={`Projected treasury position over the next ${view.projection.horizonDays} days, before any pending invoice is paid`}
            />
            <AgentStatusCard />
          </div>

          <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_352px]">
            <OracleCard feed={oracleFeed} />
            <div className="hidden xl:block" />
          </section>

          <section className="mt-8">
            <SectionTitle
              title="Invoice inbox"
              description="Every detected invoice, with the outcome the chain allowed."
              actions={
                <LinkButton href="/invoices" variant="ghost" size="sm" className="rounded-lg">
                  Open inbox
                </LinkButton>
              }
            />
            <InvoiceTable entries={entries.slice(0, 5)} />
          </section>
        </>
      )}
    </PageContainer>
  );
}

function subtitleFor(analyzing: number, attention: number, total: number): string {
  if (analyzing > 0) {
    return `Your AI agent is analyzing ${analyzing} of ${total} invoices.`;
  }
  if (attention > 0) {
    return `Your AI agent is monitoring ${total} invoices. ${attention} need${attention === 1 ? "s" : ""} your attention.`;
  }
  return `Your AI agent is monitoring ${total} invoices. Nothing needs your attention.`;
}
