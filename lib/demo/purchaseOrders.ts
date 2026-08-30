/**
 * Purchase orders backing the demo invoices. PO matching is a deterministic
 * comparison — the LLM is told the delta, never asked to compute it.
 */

import type { PurchaseOrder } from "../types";
import { dollars } from "../util/money";

export const PURCHASE_ORDERS: PurchaseOrder[] = [
  {
    poNumber: "PO-2026-0412",
    supplierId: "sup_northwind",
    amountCents: dollars(3_000),
    currency: "USD",
    issuedAt: "2026-08-04",
    description: "Bearing assemblies, batch 44",
  },
  {
    poNumber: "PO-2026-0455",
    supplierId: "sup_kestrel",
    amountCents: dollars(8_000),
    currency: "USD",
    issuedAt: "2026-08-10",
    description: "Q3 freight and customs handling",
  },
  {
    poNumber: "PO-2026-0470",
    supplierId: "sup_lumen",
    amountCents: dollars(30_000),
    currency: "USD",
    issuedAt: "2026-08-14",
    description: "Sheet metal enclosures, run 12",
  },
  {
    poNumber: "PO-2026-0481",
    supplierId: "sup_atlas",
    amountCents: dollars(19_500),
    currency: "USD",
    issuedAt: "2026-08-18",
    description: "CNC tooling refurbishment",
  },
  {
    poNumber: "PO-2026-0493",
    supplierId: "sup_veritas",
    amountCents: dollars(8_200),
    currency: "USD",
    issuedAt: "2026-08-20",
    description: "Polymer stock, grade B",
  },
  {
    poNumber: "PO-2026-0502",
    supplierId: "sup_atlas",
    amountCents: dollars(9_800),
    currency: "USD",
    issuedAt: "2026-08-21",
    description: "Fixture plates and clamps",
  },
  {
    poNumber: "PO-2026-0511",
    supplierId: "sup_lumen",
    amountCents: dollars(4_800),
    currency: "USD",
    issuedAt: "2026-08-24",
    description: "Powder coating line, phase 2",
  },
  {
    poNumber: "PO-2026-0399",
    supplierId: "sup_lumen",
    amountCents: dollars(22_600),
    currency: "USD",
    issuedAt: "2026-07-28",
    description: "Sheet metal enclosures, run 11",
  },
];
