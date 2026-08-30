/**
 * The invoice list, sourced from the chain.
 *
 * Replaces reading the eight demo scenarios directly. Membership is decided by
 * what exists on chain, so an invoice created after the seed — the conditional
 * pair, for instance — appears without anyone adding it to a fixture.
 *
 * Falls back to the local inbox adapter when the chain cannot be reached, so
 * the demo still runs offline. The fallback is reported rather than silent: a
 * list that quietly omits live invoices is how the conditional pair went
 * missing in the first place.
 */

import { detectInvoices } from "./inboxService";
import { DEMO_AS_OF_DATE } from "../demo/clock";
import type { DetectedInvoice } from "./inboxService";
import type { RawInvoiceDocument } from "../types";

export interface InvoiceListResult {
  invoices: DetectedInvoice[];
  /** True when the list came from chain discovery. */
  fromChain: boolean;
  /** Why the local fallback was used, when it was. */
  reason: string | null;
}

export async function listInvoices(): Promise<InvoiceListResult> {
  try {
    const response = await fetch("/api/invoices");
    const payload = await response.json();
    if (!payload.ok) {
      return {
        invoices: await detectInvoices(DEMO_AS_OF_DATE),
        fromChain: false,
        reason: payload.message ?? "The chain invoice list was unavailable.",
      };
    }

    const invoices: DetectedInvoice[] = payload.invoices.map(
      (invoice: Record<string, unknown>) => ({
        id: String(invoice.id),
        scenarioId: String(invoice.id),
        scenarioName: String(invoice.scenarioName),
        document: invoice.document as RawInvoiceDocument,
        invoiceNumber: String(invoice.invoiceNumber),
        supplierName: String(invoice.supplierName),
        amountCents: Number(invoice.amountCents),
        currency: String(invoice.currency),
        dueDate: String(invoice.dueDate),
        daysUntilDue: Number(invoice.daysUntilDue),
        receivedAt: String(invoice.receivedAt),
        sourceRef: String(invoice.sourceRef),
        hasDiscount: Boolean(invoice.hasDiscount),
      }),
    );

    return { invoices, fromChain: true, reason: null };
  } catch (error) {
    return {
      invoices: await detectInvoices(DEMO_AS_OF_DATE),
      fromChain: false,
      reason: error instanceof Error ? error.message : "The chain invoice list was unavailable.",
    };
  }
}
