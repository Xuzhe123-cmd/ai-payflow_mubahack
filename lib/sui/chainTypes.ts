/**
 * What the chain-reading layer returns.
 *
 * These are VIEW types, deliberately separate from the demo fixtures in
 * lib/demo. A `ChainSupplier` is what the registry says; a `Supplier` in
 * lib/types is what the off-chain analysis works with. Keeping them apart is
 * what stops "the chain says X" and "our fixtures say X" quietly merging into
 * one unverifiable claim.
 *
 * Money is in `Cents`, converted once at the boundary in lib/sui/decode.ts, so
 * nothing downstream has to know the settlement coin has six decimals.
 */

import type { Cents, IsoDate } from "../types";

export type ChainNetwork = "testnet" | "devnet" | "localnet";

export interface ChainTreasury {
  objectId: string;
  owner: string;
  /** Live vault balance. This is the number the reserve check acts on. */
  balanceCents: Cents;
  minimumReserveCents: Cents;
  humanApprovalThresholdCents: Cents;
  autoPayEnabled: boolean;
  allowedCurrencies: string[];
  allowedCoinTypes: string[];
  maxRecommendationAgeMs: number;
  totalPaidCents: Cents;
  paymentCount: number;
  /** Above the reserve — what is actually spendable. */
  availableCents: Cents;
}

export interface ChainAgent {
  capObjectId: string;
  agentId: string;
  enabled: boolean;
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  /** After the clock-based rollover, so a stale day reads as zero. */
  spentTodayCents: Cents;
  /** daily limit − spent today, floored at zero. */
  remainingTodayCents: Cents;
}

export type ChainSupplierStatus = "PENDING" | "APPROVED" | "REVOKED" | "UNKNOWN";

export interface ChainSupplier {
  supplierId: string;
  name: string;
  registeredWallet: string;
  status: ChainSupplierStatus;
}

export type ChainInvoiceStatus =
  | "PENDING"
  | "ANALYZING"
  | "APPROVED"
  | "SCHEDULED"
  | "PAID"
  | "REJECTED"
  | "HUMAN_REVIEW"
  | "UNKNOWN";

export interface ChainInvoice {
  objectId: string;
  invoiceNumber: string;
  supplierId: string;
  amountCents: Cents;
  currency: string;
  dueDate: IsoDate;
  poNumber: string;
  /** What the invoice ASKS for — validated against the registry on chain. */
  recipient: string;
  status: ChainInvoiceStatus;
  walrusBlobId: string | null;
}

export interface ChainCashFlowEvent {
  date: IsoDate;
  direction: "INFLOW" | "OUTFLOW";
  amountCents: Cents;
  description: string;
}

/** Everything the interface needs, from one round of reads. */
export interface ChainSnapshot {
  network: ChainNetwork;
  packageId: string;
  /** When these values were read, not when the chain changed. */
  readAt: string;
  treasury: ChainTreasury;
  agent: ChainAgent | null;
  suppliers: ChainSupplier[];
  invoices: ChainInvoice[];
  cashFlowEvents: ChainCashFlowEvent[];
}

const SUPPLIER_STATUS: ChainSupplierStatus[] = ["PENDING", "APPROVED", "REVOKED"];

export function supplierStatusFrom(code: number | null): ChainSupplierStatus {
  return code !== null && code < SUPPLIER_STATUS.length ? SUPPLIER_STATUS[code] : "UNKNOWN";
}

/** Order matches the constants in move/payflow/sources/invoice.move. */
const INVOICE_STATUS: ChainInvoiceStatus[] = [
  "PENDING",
  "ANALYZING",
  "APPROVED",
  "SCHEDULED",
  "PAID",
  "REJECTED",
  "HUMAN_REVIEW",
];

export function invoiceStatusFrom(code: number | null): ChainInvoiceStatus {
  return code !== null && code < INVOICE_STATUS.length ? INVOICE_STATUS[code] : "UNKNOWN";
}

export function directionFrom(code: number | null): ChainCashFlowEvent["direction"] {
  return code === 1 ? "OUTFLOW" : "INFLOW";
}
