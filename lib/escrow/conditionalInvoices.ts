/**
 * Documents for the two conditional invoices.
 *
 * These exist because the demo's decision must be about THESE invoices. The
 * preflight originally borrowed another scenario's analysis to obtain a
 * decision, which produced the right answer for one invoice and the wrong one
 * for the other — a $4,000 invoice inheriting an $8,000 invoice's escalation.
 * Borrowing a verdict is not the same as reaching one.
 *
 * Deliberately in lib/escrow rather than added to lib/demo/invoices.ts: that
 * module's `DEMO_DOCUMENTS` is iterated by the scenario suite, and these two are
 * not scenarios. They are the conditional pair, and they belong with the escrow
 * code that uses them.
 *
 * Both are written to be unremarkable — approved supplier, registered wallet,
 * inside the agent's cap, comfortable dates. The only interesting thing about
 * either is the shipment condition attached on chain.
 */

import type { RawInvoiceDocument, WorldSnapshot } from "../types";
import { TREASURY_PROFILES } from "../demo/cashFlow";
import { AGENT_CAPABILITY, APPROVER_AUTHORITY, TREASURY_POLICY } from "../demo/policies";
import { PURCHASE_ORDERS } from "../demo/purchaseOrders";
import { SUPPLIERS } from "../demo/suppliers";
import { DEMO_WALLETS } from "../demo/invoices";

/** INV-2026-3501 — $4,800, the shipment that arrives. */
export const DOC_ESCROW_CONFIRMED: RawInvoiceDocument = {
  id: "doc_escrow_confirmed",
  sourceRef: "email:AP/2026-09-02/00512",
  receivedAt: "2026-09-02",
  filename: "northwind-INV-2026-3501.pdf",
  text: `NORTHWIND COMPONENTS LTD
Unit 14, Halloway Industrial Park, Sheffield S9 2XT

INVOICE

Invoice Number:    INV-2026-3501
Issue Date:        2026-09-02
Due Date:          2026-09-24
Purchase Order:    PO-2026-0530
Payment Terms:     Net 22

Description                                          Amount
Powder coating line, phase 2                       4,800.00
                                                 ----------
Total Due (USD)                                    4,800.00

Delivery Terms:    Payment on confirmed delivery
Shipment Ref:      SHIP-3501

Remit to wallet: ${DEMO_WALLETS.northwind}`,
};

/** INV-2026-3502 — $4,000, the shipment that has not arrived. */
export const DOC_ESCROW_PENDING: RawInvoiceDocument = {
  id: "doc_escrow_pending",
  sourceRef: "email:AP/2026-09-03/00518",
  receivedAt: "2026-09-03",
  filename: "kestrel-INV-2026-3502.pdf",
  text: `KESTREL LOGISTICS GMBH
Hafenstrasse 22, 20359 Hamburg

INVOICE

Invoice Number:    INV-2026-3502
Issue Date:        2026-09-03
Due Date:          2026-09-26
Purchase Order:    PO-2026-0531
Payment Terms:     Net 23

Description                                          Amount
Q3 freight and customs handling                    4,000.00
                                                 ----------
Total Due (USD)                                    4,000.00

Delivery Terms:    Payment on confirmed delivery
Shipment Ref:      SHIP-3502

Remit to wallet: ${DEMO_WALLETS.kestrel}`,
};

export const CONDITIONAL_DOCUMENTS: Record<string, RawInvoiceDocument> = {
  "INV-2026-3501": DOC_ESCROW_CONFIRMED,
  "INV-2026-3502": DOC_ESCROW_PENDING,
};

export function conditionalDocumentFor(invoiceNumber: string): RawInvoiceDocument | null {
  return CONDITIONAL_DOCUMENTS[invoiceNumber] ?? null;
}

/**
 * The world these invoices are judged in.
 *
 * The company treasury profile — the same $100,000/$50,000 shape the chain is
 * seeded to — with an empty payment history, because neither invoice has been
 * settled. The live figures still come from chain at execution time; this is
 * what the off-chain forecaster reasons over.
 */
export function conditionalWorld(): WorldSnapshot {
  const profile = TREASURY_PROFILES.tight;
  return {
    suppliers: SUPPLIERS,
    purchaseOrders: PURCHASE_ORDERS,
    paymentHistory: [],
    cashFlowEvents: profile.events,
    treasury: profile.treasury,
    policy: TREASURY_POLICY,
    capability: AGENT_CAPABILITY,
    approver: APPROVER_AUTHORITY,
  };
}
