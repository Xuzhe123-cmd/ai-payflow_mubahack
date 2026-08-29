/**
 * Treasury starting positions and scheduled cash-flow events.
 *
 * Balances are end-of-day: for a given date the balance is the prior day's
 * close, plus that day's inflows, minus that day's outflows, minus the proposed
 * invoice payment if it falls on that date.
 *
 * The TIGHT profile is tuned so paying today drives the trough below the
 * minimum reserve while later dates do not — that is the whole point of
 * scenario 2, and it must arise from the data, not from a rule.
 */

import type { CashFlowEvent, TreasuryState } from "../types";
import { dollars } from "../util/money";

export interface TreasuryProfile {
  id: string;
  description: string;
  treasury: TreasuryState;
  events: CashFlowEvent[];
}

/** Comfortable liquidity: no candidate date comes near the reserve. */
export const HEALTHY_PROFILE: TreasuryProfile = {
  id: "healthy",
  description: "Comfortable liquidity with a large receivable mid-September",
  treasury: { currentCashCents: dollars(180_000), currency: "USD" },
  events: [
    { id: "cf_h1", date: "2026-09-01", direction: "OUTFLOW", amountCents: dollars(12_000), description: "Facility lease" },
    { id: "cf_h2", date: "2026-09-10", direction: "INFLOW", amountCents: dollars(95_000), description: "Customer receivable — Meridian Systems" },
    { id: "cf_h3", date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(60_000), description: "Payroll" },
    { id: "cf_h4", date: "2026-09-24", direction: "INFLOW", amountCents: dollars(41_000), description: "Customer receivable — Calder Works" },
    { id: "cf_h5", date: "2026-09-30", direction: "OUTFLOW", amountCents: dollars(18_500), description: "Quarterly tax instalment" },
  ],
};

/**
 * Constrained liquidity. Paying a $30,000 invoice today troughs at $42,000
 * against a $50,000 reserve; waiting until the Sep 1 receivable clears removes
 * the breach entirely.
 */
export const TIGHT_PROFILE: TreasuryProfile = {
  id: "tight",
  description: "Constrained liquidity until the Sep 1 receivable clears",
  treasury: { currentCashCents: dollars(100_000), currency: "USD" },
  events: [
    { id: "cf_t1", date: "2026-08-31", direction: "OUTFLOW", amountCents: dollars(28_000), description: "Contract manufacturing milestone" },
    { id: "cf_t2", date: "2026-09-01", direction: "INFLOW", amountCents: dollars(35_000), description: "Customer receivable — Meridian Systems" },
    { id: "cf_t3", date: "2026-09-04", direction: "OUTFLOW", amountCents: dollars(12_000), description: "Facility lease" },
    { id: "cf_t4", date: "2026-09-05", direction: "INFLOW", amountCents: dollars(5_000), description: "Customer receivable — Torrey Design" },
    { id: "cf_t5", date: "2026-09-12", direction: "INFLOW", amountCents: dollars(55_000), description: "Customer receivable — Halden Group" },
    { id: "cf_t6", date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(40_000), description: "Payroll" },
  ],
};

/** Healthy, with no large near-term swings — lets a discount decide timing. */
export const DISCOUNT_PROFILE: TreasuryProfile = {
  id: "discount",
  description: "Healthy position with no near-term liquidity pressure",
  treasury: { currentCashCents: dollars(150_000), currency: "USD" },
  events: [
    { id: "cf_d1", date: "2026-09-02", direction: "OUTFLOW", amountCents: dollars(9_500), description: "Facility lease" },
    { id: "cf_d2", date: "2026-09-09", direction: "INFLOW", amountCents: dollars(48_000), description: "Customer receivable — Meridian Systems" },
    { id: "cf_d3", date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(52_000), description: "Payroll" },
    { id: "cf_d4", date: "2026-09-22", direction: "INFLOW", amountCents: dollars(36_000), description: "Customer receivable — Calder Works" },
  ],
};

/** Deep reserves, so a large invoice is affordable and only policy binds. */
export const WELL_FUNDED_PROFILE: TreasuryProfile = {
  id: "well_funded",
  description: "Deep reserves — liquidity is not the constraint",
  treasury: { currentCashCents: dollars(220_000), currency: "USD" },
  events: [
    { id: "cf_w1", date: "2026-09-01", direction: "OUTFLOW", amountCents: dollars(12_000), description: "Facility lease" },
    { id: "cf_w2", date: "2026-09-08", direction: "INFLOW", amountCents: dollars(70_000), description: "Customer receivable — Halden Group" },
    { id: "cf_w3", date: "2026-09-15", direction: "OUTFLOW", amountCents: dollars(58_000), description: "Payroll" },
    { id: "cf_w4", date: "2026-09-26", direction: "INFLOW", amountCents: dollars(44_000), description: "Customer receivable — Meridian Systems" },
  ],
};

export const TREASURY_PROFILES = {
  healthy: HEALTHY_PROFILE,
  tight: TIGHT_PROFILE,
  discount: DISCOUNT_PROFILE,
  wellFunded: WELL_FUNDED_PROFILE,
} as const;
