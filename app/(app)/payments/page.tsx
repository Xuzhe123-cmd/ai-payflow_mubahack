"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { MetricCard } from "@/components/common/MetricCard";
import { PaymentTable } from "@/components/payments/PaymentTable";
import { ConnectInboxCard } from "@/components/dashboard/ConnectInboxCard";
import { usePayflow } from "@/components/providers/PayflowProvider";
import {
  useInvoiceEntries,
  useInvoiceStats,
} from "@/components/hooks/usePayflowSelectors";
import { formatMoneyRounded } from "@/lib/format";

export default function PaymentsPage() {
  const { state } = usePayflow();
  const entries = useInvoiceEntries();
  const stats = useInvoiceStats();

  const analyzed = entries.filter((entry) => entry.run?.analysis);

  const committedCents = analyzed.reduce((total, entry) => {
    const request = entry.run?.analysis?.paymentRequest;
    const approved = entry.run?.analysis?.enforcement?.outcome === "APPROVED";
    return approved && request ? total + request.amountCents : total;
  }, 0);

  const paidCents = analyzed.reduce((total, entry) => {
    if (entry.run?.status !== "PAID") return total;
    return total + (entry.run.analysis?.paymentRequest?.amountCents ?? 0);
  }, 0);

  if (state.inboxStatus !== "CONNECTED") {
    return (
      <PageContainer>
        <PageHeader
          title="Payment center"
          subtitle="Connect the finance inbox to see payment activity."
        />
        <ConnectInboxCard />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Payment center"
        subtitle="Every payment the agent proposed, and what the chain did with it."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Approved on chain"
          value={formatMoneyRounded(committedCents)}
          context={`${stats.approved + stats.scheduled + stats.paid} payments cleared policy`}
          accent="pos"
        />
        <MetricCard
          label="Executed"
          value={formatMoneyRounded(paidCents)}
          context={`${stats.paid} settled transaction${stats.paid === 1 ? "" : "s"}`}
        />
        <MetricCard
          label="Awaiting a human"
          value={String(stats.needsReview)}
          context="The agent declined to decide these alone"
          accent={stats.needsReview > 0 ? "warn" : null}
        />
        <MetricCard
          label="Blocked or rejected"
          value={String(stats.blocked + stats.rejected)}
          context={`${stats.blocked} stopped by on-chain policy`}
          accent={stats.blocked + stats.rejected > 0 ? "neg" : null}
        />
      </div>

      <div className="mt-6">
        <PaymentTable entries={analyzed} />
      </div>
    </PageContainer>
  );
}
