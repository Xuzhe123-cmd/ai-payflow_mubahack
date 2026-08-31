"use client";

import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/common/Badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/States";
import { describeDueIn, formatDay, formatMoneyRounded } from "@/lib/format";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";
import type { Level } from "@/lib/types";

/**
 * The invoice list is a treasury table, not a mailbox.
 *
 * Risk is shown as the model's level and only once an analysis exists — an
 * un-analyzed invoice shows a dash rather than an optimistic default, because
 * "we have not looked yet" and "we looked and it is fine" are different claims.
 */
export function InvoiceTable({
  entries,
  emptyTitle = "No invoices detected",
  emptyDescription = "Connect the finance inbox to start detecting supplier invoices.",
}: {
  entries: InvoiceEntry[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (entries.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline bg-surface-sunken/60">
              <Th className="pl-5">Supplier</Th>
              <Th>Invoice</Th>
              <Th align="right">Amount</Th>
              <Th>Due</Th>
              <Th>Risk</Th>
              <Th>Urgency</Th>
              <Th>Status</Th>
              <Th className="pr-5" align="right">
                <span className="sr-only">Open</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {entries.map(({ invoice, run }) => {
              const decision = run?.analysis?.decision ?? null;
              return (
                <tr
                  key={invoice.id}
                  className="group transition-colors hover:bg-surface-sunken/50"
                >
                  <Td className="pl-5">
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="block max-w-[220px] truncate text-[13.5px] font-medium text-ink"
                    >
                      {invoice.supplierName}
                    </Link>
                    <span className="text-[11.5px] text-ink-faint">
                      {invoice.scenarioName}
                    </span>
                  </Td>

                  <Td>
                    <span className="font-mono text-[12.5px] text-ink-soft">
                      {invoice.invoiceNumber}
                    </span>
                  </Td>

                  <Td align="right">
                    <span className="tabular text-[13.5px] font-semibold text-ink">
                      {formatMoneyRounded(invoice.amountCents, invoice.currency)}
                    </span>
                    {invoice.hasDiscount ? (
                      <span className="ml-2 text-[11px] font-medium text-pos">
                        discount
                      </span>
                    ) : null}
                  </Td>

                  <Td>
                    <span className="tabular text-[13px] text-ink">
                      {formatDay(invoice.dueDate)}
                    </span>
                    <span
                      className={cn(
                        "block text-[11.5px]",
                        invoice.daysUntilDue < 0 ? "text-neg" : "text-ink-faint",
                      )}
                    >
                      {describeDueIn(invoice.daysUntilDue)}
                    </span>
                  </Td>

                  <Td>{decision ? <RiskBadge level={decision.risk} /> : <Dash />}</Td>

                  <Td>
                    {decision ? (
                      <Badge tone="chain">{decision.urgency}</Badge>
                    ) : (
                      <Dash />
                    )}
                  </Td>

                  <Td>
                    <StatusBadge run={run} invoiceNumber={invoice.invoiceNumber} />
                  </Td>

                  <Td className="pr-5" align="right">
                    <Link
                      href={`/invoices/${invoice.id}`}
                      aria-label={`Open ${invoice.invoiceNumber}`}
                      className="inline-flex text-ink-faint transition-colors group-hover:text-ink"
                    >
                      <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.8} />
                    </Link>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RiskBadge({ level }: { level: Level }) {
  const tone =
    level === "LOW" ? "positive" : level === "MEDIUM" ? "warning" : "negative";
  return <Badge tone={tone}>{level}</Badge>;
}

function Dash() {
  return <span className="text-[13px] text-ink-faint">—</span>;
}

function Th({
  children,
  className,
  align = "left",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  align = "left",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "px-3 py-3 align-middle",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
