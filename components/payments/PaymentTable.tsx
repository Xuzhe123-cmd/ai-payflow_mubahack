"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/common/Badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/States";
import { formatDay, formatMoneyRounded } from "@/lib/format";
import { usePayflow } from "@/components/providers/PayflowProvider";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";

/**
 * Payment activity.
 *
 * The transaction column is the honest one: it is empty unless a payment was
 * actually executed on chain. A scheduled payment has no digest, and the table
 * does not pretend otherwise.
 */
export function PaymentTable({ entries }: { entries: InvoiceEntry[] }) {
  const { executeInvoicePayment } = usePayflow();

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No payment activity"
        description="Invoices appear here once the agent has analyzed them."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] border-collapse text-left">
          <thead>
            <tr className="border-b border-hairline bg-surface-sunken/60">
              {["Invoice", "Supplier", "Amount", "Payment date", "Status", "Transaction", ""].map(
                (label, index) => (
                  <th
                    key={label || index}
                    scope="col"
                    className={cn(
                      "px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint",
                      index === 0 && "pl-5",
                      index === 2 && "text-right",
                      index === 6 && "pr-5 text-right",
                    )}
                  >
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>

          <tbody className="divide-y divide-hairline">
            {entries.map((entry) => {
              const { invoice, run } = entry;
              const analysis = run?.analysis ?? null;
              const request = analysis?.paymentRequest ?? null;
              const canExecute =
                analysis?.enforcement?.outcome === "APPROVED" &&
                run?.status !== "PAID" &&
                run?.status !== "EXECUTING";

              return (
                <tr key={invoice.id} className="transition-colors hover:bg-surface-sunken/50">
                  <td className="px-3 py-3 pl-5">
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="font-mono text-[12.5px] font-medium text-ink hover:underline"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                  </td>

                  <td className="px-3 py-3">
                    <span className="block max-w-[200px] truncate text-[13px] text-ink-soft">
                      {invoice.supplierName}
                    </span>
                  </td>

                  <td className="px-3 py-3 text-right">
                    <span className="tabular text-[13.5px] font-semibold text-ink">
                      {formatMoneyRounded(
                        request?.amountCents ?? invoice.amountCents,
                        invoice.currency,
                      )}
                    </span>
                    {request && request.amountCents !== invoice.amountCents ? (
                      <span className="ml-1.5 text-[11px] text-pos">net of discount</span>
                    ) : null}
                  </td>

                  <td className="px-3 py-3">
                    {request ? (
                      <span className="tabular text-[13px] text-ink">
                        {formatDay(request.requestedDate)}
                      </span>
                    ) : (
                      <span className="text-[13px] text-ink-faint">—</span>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <StatusBadge run={run} invoiceNumber={invoice.invoiceNumber} />
                  </td>

                  <td className="px-3 py-3">
                    {run?.receipt ? (
                      <span className="font-mono text-[11.5px] text-chain">
                        {run.receipt.digest.slice(0, 12)}…{run.receipt.digest.slice(-6)}
                      </span>
                    ) : run?.status === "EXECUTING" ? (
                      <Badge tone="chain" dot pulse>
                        submitting
                      </Badge>
                    ) : (
                      <span className="text-[13px] text-ink-faint">—</span>
                    )}
                  </td>

                  <td className="px-3 py-3 pr-5 text-right">
                    {canExecute ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className="rounded-lg"
                        onClick={() => void executeInvoicePayment(invoice.id)}
                      >
                        Execute
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
