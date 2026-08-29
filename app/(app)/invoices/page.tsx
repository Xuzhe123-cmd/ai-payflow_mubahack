"use client";

import { useMemo, useState } from "react";

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { Button } from "@/components/ui/button";
import { InvoiceTable } from "@/components/invoices/InvoiceTable";
import { ConnectInboxCard } from "@/components/dashboard/ConnectInboxCard";
import { cn } from "@/lib/utils";
import { usePayflow } from "@/components/providers/PayflowProvider";
import {
  useInvoiceEntries,
  useInvoiceStats,
  type InvoiceEntry,
} from "@/components/hooks/usePayflowSelectors";

type TabId = "all" | "review" | "scheduled" | "paid" | "rejected";

const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "scheduled", label: "Scheduled" },
  { id: "paid", label: "Paid" },
  { id: "rejected", label: "Rejected" },
];

function matches(entry: InvoiceEntry, tab: TabId): boolean {
  if (tab === "all") return true;
  if (tab === "paid") return entry.run?.status === "PAID";
  if (entry.run?.status === "PAID") return false;

  switch (tab) {
    case "review":
      return entry.outcome === "HUMAN_REVIEW";
    case "scheduled":
      return entry.outcome === "SCHEDULED" || entry.outcome === "EXECUTED";
    case "rejected":
      return entry.outcome === "REJECTED" || entry.outcome === "SUI_REJECT";
    default:
      return true;
  }
}

export default function InvoicesPage() {
  const [tab, setTab] = useState<TabId>("all");
  const { state, analyzeAll } = usePayflow();
  const entries = useInvoiceEntries();
  const stats = useInvoiceStats();

  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map((item) => [item.id, entries.filter((entry) => matches(entry, item.id)).length]),
      ) as Record<TabId, number>,
    [entries],
  );

  const filtered = entries.filter((entry) => matches(entry, tab));
  const connected = state.inboxStatus === "CONNECTED";

  return (
    <PageContainer>
      <PageHeader
        title="Invoices"
        subtitle={
          connected
            ? `${entries.length} invoices detected. ${
                stats.analyzing > 0
                  ? `The agent is analyzing ${stats.analyzing} of them.`
                  : "All analyses complete."
              }`
            : "Connect the finance inbox to detect supplier invoices."
        }
        actions={
          connected && stats.pending > 0 ? (
            <Button size="sm" className="rounded-lg" onClick={() => void analyzeAll()}>
              Analyze {stats.pending} pending
            </Button>
          ) : null
        }
      />

      {!connected ? (
        <ConnectInboxCard />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-hairline">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "relative -mb-px px-3.5 py-2.5 text-[13px] font-medium transition-colors",
                  tab === item.id
                    ? "border-b-2 border-ai text-ink"
                    : "border-b-2 border-transparent text-ink-faint hover:text-ink-soft",
                )}
              >
                {item.label}
                <span
                  className={cn(
                    "tabular ml-1.5 rounded-full px-1.5 py-px text-[10.5px]",
                    tab === item.id
                      ? "bg-ai-soft text-ai"
                      : "bg-surface-sunken text-ink-faint",
                  )}
                >
                  {counts[item.id]}
                </span>
              </button>
            ))}
          </div>

          <InvoiceTable
            entries={filtered}
            emptyTitle="Nothing in this view"
            emptyDescription="No invoice currently has this status."
          />
        </>
      )}
    </PageContainer>
  );
}
