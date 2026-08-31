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

/**
 * The tabs, and which category fills each.
 *
 * THE BUG THIS PAGE HAD: the filter below used to switch on `entry.outcome` —
 * the AI's verdict — and on `run.status`, the local session's own record. For
 * an invoice settled on chain in an earlier session both are silent about the
 * settlement, so a released $4,800 escrow fell through to the guard's refusal
 * of a SECOND payment and was filed under "Rejected", while its own badge in
 * the same row read "Payment released".
 *
 * That was a second status system. It is gone: `entry.category` comes from
 * `describeInvoiceStatus`, the same call that produces the badge, with the same
 * chain-first precedence as `availablePaymentAction`. This file no longer
 * derives status at all — it only says which category belongs in which tab.
 *
 * "Held" is its own tab because an escrowed payment is neither paid nor
 * refused: the treasury has parted with the money and the supplier does not
 * have it, and there was previously nowhere honest to put it.
 */
type TabId = "all" | "review" | "scheduled" | "held" | "paid" | "rejected";

const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "scheduled", label: "Scheduled" },
  { id: "held", label: "Held in escrow" },
  { id: "paid", label: "Paid" },
  { id: "rejected", label: "Rejected" },
];

function matches(entry: InvoiceEntry, tab: TabId): boolean {
  return tab === "all" || entry.category === tab;
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
