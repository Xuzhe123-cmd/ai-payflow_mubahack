"use client";

/**
 * An invoice's own status on chain.
 *
 * Needed because a settled invoice does not necessarily leave a trace in this
 * browser. INV-2026-3455 was paid by a script, INV-2026-3501 by the escrow
 * release — neither produced a local run with a receipt, so asking the run
 * whether it was paid returns no, and the interface then falls through to the
 * AI recommendation, which refuses a SECOND payment and reads as "Rejected".
 *
 * The invoice object knows. This asks it.
 *
 * Reads the same `/api/invoices` the list uses — one endpoint, one truth, one
 * fetch shared across every component that mounts.
 */

import { useEffect, useState } from "react";

export interface ChainInvoiceState {
  invoiceNumber: string;
  /** PENDING / APPROVED / PAID / ESCROWED / … as the invoice object records it. */
  status: string;
  objectId: string;
  supplierName: string;
  amountCents: number;
}

/**
 * Cached at module scope so a page with several invoices makes one call.
 *
 * Cleared on reload and by `refreshChainInvoices`. Deliberately not long-lived:
 * stale settlement shown as current is the failure this hook exists to prevent.
 */
let inFlight: Promise<Map<string, ChainInvoiceState>> | null = null;

async function loadInvoices(): Promise<Map<string, ChainInvoiceState>> {
  const response = await fetch("/api/invoices");
  const payload = await response.json();
  const byNumber = new Map<string, ChainInvoiceState>();
  if (payload.ok) {
    for (const invoice of payload.invoices as ChainInvoiceState[]) {
      byNumber.set(invoice.invoiceNumber, invoice);
    }
  }
  return byNumber;
}

export function useChainInvoice(invoiceNumber: string): {
  invoice: ChainInvoiceState | null;
  /** False until the chain has been consulted. */
  resolved: boolean;
} {
  const [invoice, setInvoice] = useState<ChainInvoiceState | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    inFlight ??= loadInvoices();

    void inFlight
      .then((byNumber) => {
        if (cancelled) return;
        setInvoice(byNumber.get(invoiceNumber) ?? null);
      })
      .catch(() => {
        // Unreachable endpoint. Treated as "status unknown", which falls back
        // to the local run rather than inventing a settlement.
        if (!cancelled) setInvoice(null);
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [invoiceNumber]);

  return { invoice, resolved };
}

/** Drops the cache so the next read hits the chain again. */
export function refreshChainInvoices(): void {
  inFlight = null;
}
