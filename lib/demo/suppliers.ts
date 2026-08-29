/**
 * Approved supplier registry. Mirrors the Supplier objects that will live on
 * Sui — the registry is authorization data, so on-chain it is written only by
 * the treasury owner, never by the agent.
 */

import type { Supplier } from "../types";
import { dollars } from "../util/money";

export const SUPPLIERS: Supplier[] = [
  {
    id: "sup_northwind",
    name: "Northwind Components Ltd",
    aliases: ["Northwind Components", "Northwind Ltd"],
    registryStatus: "APPROVED",
    registeredWallet: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
    businessCriticality: "HIGH",
    history: {
      invoiceCount: 34,
      meanAmountCents: dollars(11_800),
      maxAmountCents: dollars(28_400),
      onTimePaymentRate: 0.97,
      firstSeen: "2023-04-12",
    },
  },
  {
    id: "sup_kestrel",
    name: "Kestrel Logistics GmbH",
    aliases: ["Kestrel Logistics", "Kestrel GmbH"],
    registryStatus: "APPROVED",
    registeredWallet: "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308",
    businessCriticality: "MEDIUM",
    history: {
      invoiceCount: 19,
      meanAmountCents: dollars(42_500),
      maxAmountCents: dollars(96_000),
      onTimePaymentRate: 0.89,
      firstSeen: "2024-01-30",
    },
  },
  {
    id: "sup_lumen",
    name: "Lumen Fabrication Inc",
    aliases: ["Lumen Fabrication", "Lumen Inc"],
    registryStatus: "APPROVED",
    registeredWallet: "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
    businessCriticality: "MEDIUM",
    history: {
      invoiceCount: 27,
      meanAmountCents: dollars(24_000),
      maxAmountCents: dollars(61_000),
      onTimePaymentRate: 0.93,
      firstSeen: "2023-09-05",
    },
  },
  {
    id: "sup_atlas",
    name: "Atlas Precision Works",
    aliases: ["Atlas Precision", "Atlas Works"],
    registryStatus: "APPROVED",
    registeredWallet: "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690",
    businessCriticality: "HIGH",
    history: {
      invoiceCount: 41,
      meanAmountCents: dollars(18_200),
      maxAmountCents: dollars(45_000),
      onTimePaymentRate: 0.98,
      firstSeen: "2022-11-18",
    },
  },
  {
    id: "sup_veritas",
    name: "Veritas Materials Co",
    aliases: ["Veritas Materials"],
    registryStatus: "APPROVED",
    registeredWallet: "0x2e6b9d4a7c30f815b6d29a4e7c03f815b6d29a4e7c03f815b6d29a4e7c03f815",
    businessCriticality: "LOW",
    history: {
      invoiceCount: 12,
      meanAmountCents: dollars(7_400),
      maxAmountCents: dollars(15_900),
      onTimePaymentRate: 0.91,
      firstSeen: "2024-06-22",
    },
  },
];

/** Convenience lookup used by fixtures, not by the pipeline. */
export function supplierById(id: string): Supplier {
  const found = SUPPLIERS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown demo supplier: ${id}`);
  return found;
}
