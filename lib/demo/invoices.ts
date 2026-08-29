/**
 * Raw invoice documents, as they would arrive from an inbox or Walrus blob.
 *
 * These are deliberately semi-structured text rather than pre-parsed objects,
 * so extractInvoice() has real work to do and can later be swapped for a
 * Workers AI document extractor without changing anything downstream.
 *
 * Amounts appear only as text here. The deterministic layer parses them into
 * exact integer cents — the LLM never reads these documents directly.
 */

import type { RawInvoiceDocument } from "../types";

const WALLETS = {
  northwind: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  kestrel: "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308",
  lumen: "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
  atlas: "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690",
  /** Not registered to anyone — the redirection attempt in scenario 5. */
  impostor: "0xb41f8e2c95a7d0361f8e2c95a7d0361f8e2c95a7d0361f8e2c95a7d0361f8e2c",
  /** Unknown supplier's own wallet in scenario 4. */
  bluepeak: "0xe07c3a95d1b8462fe07c3a95d1b8462fe07c3a95d1b8462fe07c3a95d1b8462f",
} as const;

/** Scenario 1 — routine invoice from a long-standing approved supplier. */
export const DOC_NORMAL: RawInvoiceDocument = {
  id: "doc_normal",
  sourceRef: "email:AP/2026-08-24/00417",
  receivedAt: "2026-08-24",
  filename: "northwind-INV-2026-3455.pdf",
  text: `NORTHWIND COMPONENTS LTD
Unit 14, Halloway Industrial Park, Sheffield S9 2XT

INVOICE

Invoice Number:    INV-2026-3455
Issue Date:        2026-08-24
Due Date:          2026-08-31
Purchase Order:    PO-2026-0412
Payment Terms:     Net 7

Description                                          Amount
Bearing assemblies, batch 44                      12,400.00
                                                 ----------
Total Due (USD)                                   12,400.00

Remit to wallet: ${WALLETS.northwind}
Thank you for your continued business.`,
};

/** Scenario 2 — large but legitimate; timing is the only real question. */
export const DOC_CASHFLOW: RawInvoiceDocument = {
  id: "doc_cashflow",
  sourceRef: "email:AP/2026-08-25/00423",
  receivedAt: "2026-08-25",
  filename: "lumen-INV-2026-3461.pdf",
  text: `LUMEN FABRICATION INC
2200 Foundry Road, Akron OH 44305

INVOICE

Invoice Number:    INV-2026-3461
Issue Date:        2026-08-25
Due Date:          2026-09-05
Purchase Order:    PO-2026-0470
Payment Terms:     Net 11

Description                                          Amount
Sheet metal enclosures, run 12                    30,000.00
                                                 ----------
Total Due (USD)                                   30,000.00

Remit to wallet: ${WALLETS.lumen}`,
};

/** Scenario 3 — early-payment discount expiring today. */
export const DOC_DISCOUNT: RawInvoiceDocument = {
  id: "doc_discount",
  sourceRef: "email:AP/2026-08-24/00419",
  receivedAt: "2026-08-24",
  filename: "lumen-INV-2026-3468.pdf",
  text: `LUMEN FABRICATION INC
2200 Foundry Road, Akron OH 44305

INVOICE

Invoice Number:    INV-2026-3468
Issue Date:        2026-08-24
Due Date:          2026-09-23
Purchase Order:    PO-2026-0511
Payment Terms:     2/5 Net 30

Description                                          Amount
Powder coating line, phase 2                      30,000.00
                                                 ----------
Total Due (USD)                                   30,000.00

Early Payment Discount: 2% if paid by 2026-08-29

Remit to wallet: ${WALLETS.lumen}`,
};

/** Scenario 4 — supplier has never been seen before. */
export const DOC_NEW_SUPPLIER: RawInvoiceDocument = {
  id: "doc_new_supplier",
  sourceRef: "email:AP/2026-08-27/00431",
  receivedAt: "2026-08-27",
  filename: "bluepeak-INV-BP-88214.pdf",
  text: `BLUEPEAK INDUSTRIAL SUPPLY
Suite 900, 41 Corvin Street, Tampa FL 33602

INVOICE

Invoice Number:    INV-BP-88214
Issue Date:        2026-08-27
Due Date:          2026-09-12
Purchase Order:    PO-2026-9001
Payment Terms:     Net 16

Description                                          Amount
Hydraulic fittings and seals, initial order       14,750.00
                                                 ----------
Total Due (USD)                                   14,750.00

Remit to wallet: ${WALLETS.bluepeak}
New vendor — please process promptly to open the account.`,
};

/** Scenario 5 — approved supplier, but the remit wallet has been swapped. */
export const DOC_WALLET_MISMATCH: RawInvoiceDocument = {
  id: "doc_wallet_mismatch",
  sourceRef: "email:AP/2026-08-26/00428",
  receivedAt: "2026-08-26",
  filename: "atlas-INV-2026-3479.pdf",
  text: `ATLAS PRECISION WORKS
801 Kearny Avenue, Dayton OH 45402

INVOICE

Invoice Number:    INV-2026-3479
Issue Date:        2026-08-26
Due Date:          2026-09-07
Purchase Order:    PO-2026-0481
Payment Terms:     Net 12

Description                                          Amount
CNC tooling refurbishment                         19,500.00
                                                 ----------
Total Due (USD)                                   19,500.00

PLEASE NOTE: our banking details have changed.
Remit to wallet: ${WALLETS.impostor}`,
};

/** Scenario 6 — an invoice number that has already been settled. */
export const DOC_DUPLICATE: RawInvoiceDocument = {
  id: "doc_duplicate",
  sourceRef: "email:AP/2026-08-28/00436",
  receivedAt: "2026-08-28",
  filename: "lumen-INV-2026-3391-resend.pdf",
  text: `LUMEN FABRICATION INC
2200 Foundry Road, Akron OH 44305

INVOICE  (SECOND NOTICE)

Invoice Number:    INV-2026-3391
Issue Date:        2026-07-30
Due Date:          2026-08-31
Purchase Order:    PO-2026-0399
Payment Terms:     Net 32

Description                                          Amount
Sheet metal enclosures, run 11                    22,600.00
                                                 ----------
Total Due (USD)                                   22,600.00

Remit to wallet: ${WALLETS.lumen}`,
};

/** Scenario 7 — invoice bills materially more than the purchase order. */
export const DOC_PO_MISMATCH: RawInvoiceDocument = {
  id: "doc_po_mismatch",
  sourceRef: "email:AP/2026-08-28/00439",
  receivedAt: "2026-08-28",
  filename: "atlas-INV-2026-3486.pdf",
  text: `ATLAS PRECISION WORKS
801 Kearny Avenue, Dayton OH 45402

INVOICE

Invoice Number:    INV-2026-3486
Issue Date:        2026-08-28
Due Date:          2026-09-10
Purchase Order:    PO-2026-0502
Payment Terms:     Net 13

Description                                          Amount
Fixture plates and clamps                          9,800.00
Additional machining and expedite fee              4,900.00
                                                 ----------
Total Due (USD)                                   14,700.00

Remit to wallet: ${WALLETS.atlas}`,
};

/** Scenario 8 — clean invoice that exceeds the agent's on-chain payment cap. */
export const DOC_POLICY_VIOLATION: RawInvoiceDocument = {
  id: "doc_policy_violation",
  sourceRef: "email:AP/2026-08-26/00426",
  receivedAt: "2026-08-26",
  filename: "kestrel-INV-2026-3492.pdf",
  text: `KESTREL LOGISTICS GMBH
Hafenstrasse 22, 20359 Hamburg

INVOICE

Invoice Number:    INV-2026-3492
Issue Date:        2026-08-26
Due Date:          2026-09-18
Purchase Order:    PO-2026-0455
Payment Terms:     Net 23

Description                                          Amount
Q3 freight and customs handling                   68,000.00
                                                 ----------
Total Due (USD)                                   68,000.00

Remit to wallet: ${WALLETS.kestrel}`,
};

export const DEMO_DOCUMENTS = {
  normal: DOC_NORMAL,
  cashflow: DOC_CASHFLOW,
  discount: DOC_DISCOUNT,
  newSupplier: DOC_NEW_SUPPLIER,
  walletMismatch: DOC_WALLET_MISMATCH,
  duplicate: DOC_DUPLICATE,
  poMismatch: DOC_PO_MISMATCH,
  policyViolation: DOC_POLICY_VIOLATION,
} as const;

export { WALLETS as DEMO_WALLETS };
