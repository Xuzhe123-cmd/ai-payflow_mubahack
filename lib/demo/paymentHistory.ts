/**
 * Settled payments. This is the duplicate-detection source: an invoice number
 * already present here has been paid, which is a deterministic fact.
 *
 * On Sui this becomes the PaymentRecord set, and Move re-checks it at execution
 * time so that a duplicate cannot be paid even if the AI recommends it.
 */

import type { PaymentRecord } from "../types";
import { dollars } from "../util/money";

export const PAYMENT_HISTORY: PaymentRecord[] = [
  {
    paymentId: "pay_0x91ac",
    invoiceNumber: "INV-2026-3391",
    supplierId: "sup_lumen",
    amountCents: dollars(22_600),
    currency: "USD",
    paidAt: "2026-08-11",
    recipientWallet: "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
  },
  {
    paymentId: "pay_0x74be",
    invoiceNumber: "INV-2026-3402",
    supplierId: "sup_atlas",
    amountCents: dollars(17_900),
    currency: "USD",
    paidAt: "2026-08-14",
    recipientWallet: "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690",
  },
  {
    paymentId: "pay_0x2fd1",
    invoiceNumber: "INV-2026-3418",
    supplierId: "sup_northwind",
    amountCents: dollars(10_450),
    currency: "USD",
    paidAt: "2026-08-19",
    recipientWallet: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  },
  {
    paymentId: "pay_0x58c3",
    invoiceNumber: "INV-2026-3427",
    supplierId: "sup_veritas",
    amountCents: dollars(6_800),
    currency: "USD",
    paidAt: "2026-08-22",
    recipientWallet: "0x2e6b9d4a7c30f815b6d29a4e7c03f815b6d29a4e7c03f815b6d29a4e7c03f815",
  },
];
