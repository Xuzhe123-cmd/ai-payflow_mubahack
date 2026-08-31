"use client";

/**
 * The single place an invoice's state becomes a word on screen.
 *
 * The state shown is what happened to the MONEY, not what the AI preferred: a
 * payment the model wanted but the preflight refused reads "Would be blocked
 * by Sui" — a prediction, since nothing was submitted — never
 * "Scheduled" — and an invoice that has already settled reads "Payment
 * released", never "Rejected", however firmly the guard refuses to pay it a
 * second time.
 *
 * The precedence lives in `describeInvoiceStatus`, which is pure and tested.
 * This component's only job is to fetch the chain state that rule needs. Both
 * hooks are cached at module scope, so a table of twenty invoices makes two
 * requests in total.
 */

import type { FinalOutcome } from "@/lib/types";
import type { InvoiceRun } from "@/components/providers/PayflowProvider";
import { useChainInvoice } from "@/components/hooks/useChainInvoice";
import { useConditionState } from "@/components/hooks/useConditionState";
import {
  describeInvoiceStatus,
  describeOutcome,
  type InvoiceStatusDescriptor,
} from "@/lib/payments/invoiceStatus";
import { Badge, type BadgeTone } from "./Badge";

export type StatusDescriptor = InvoiceStatusDescriptor;

/**
 * The local run's state, for surfaces with no invoice number to look up.
 *
 * Prefer `StatusBadge`: this cannot see a payment made outside this session,
 * and will describe a settled invoice by whatever the pipeline recommended.
 */
export function describeRun(run: InvoiceRun | null | undefined): StatusDescriptor {
  return describeInvoiceStatus({
    runStatus: run?.status ?? null,
    finalOutcome: run?.analysis?.finalOutcome ?? null,
    hasReceipt: run?.receipt != null,
  });
}

export { describeOutcome };

export function StatusBadge({
  run,
  invoiceNumber,
}: {
  run: InvoiceRun | null | undefined;
  /**
   * Enables the chain lookup. Without it the badge falls back to the local run,
   * which cannot know about a payment made in another session.
   */
  invoiceNumber?: string;
}) {
  const status = useInvoiceStatus(run, invoiceNumber);
  return (
    <Badge tone={status.tone as BadgeTone} dot pulse={status.pulse}>
      {status.label}
    </Badge>
  );
}

/** The badge's rule, for a caller that wants the words rather than the chip. */
export function useInvoiceStatus(
  run: InvoiceRun | null | undefined,
  invoiceNumber?: string,
): StatusDescriptor {
  const { invoice: chainInvoice, resolved: invoiceResolved } = useChainInvoice(
    invoiceNumber ?? "",
  );
  const { condition, resolved: conditionResolved } = useConditionState(invoiceNumber ?? "");

  return describeInvoiceStatus({
    runStatus: run?.status ?? null,
    finalOutcome: run?.analysis?.finalOutcome ?? null,
    chainInvoiceStatus: invoiceNumber ? (chainInvoice?.status ?? null) : null,
    conditionStage: invoiceNumber ? (condition?.stage ?? null) : null,
    hasReceipt: run?.receipt != null,
    // Only meaningful where a chain lookup was actually requested.
    chainResolved: invoiceNumber ? invoiceResolved && conditionResolved : true,
  });
}

export function OutcomeBadge({ outcome }: { outcome: FinalOutcome }) {
  const status = describeOutcome(outcome);
  return (
    <Badge tone={status.tone as BadgeTone} dot>
      {status.label}
    </Badge>
  );
}
