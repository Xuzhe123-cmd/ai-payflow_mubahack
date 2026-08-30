/**
 * Treasury service — the company's financial position.
 *
 * SWAP POINT — Sui object reads + accounting integration.
 *   The balances come from the demo world today and from the Treasury object
 *   plus an ERP feed later. Every derived figure is computed HERE, not in a
 *   component, so the interface never owns a financial rule.
 */

import type {
  AgentCapability,
  CashFlowEvent,
  Cents,
  IsoDate,
  Supplier,
  TreasuryPolicy,
  TreasuryState,
} from "../types";
import { buildProjection, type CashProjection } from "../deterministic/projection";
import { compareDates } from "../util/date";
import { SCENARIOS, scenarioById, DEMO_AS_OF_DATE } from "../demo/scenarios";
import { PAYMENT_HISTORY } from "../demo/paymentHistory";

export interface TreasuryView {
  asOfDate: IsoDate;
  treasury: TreasuryState;
  policy: TreasuryPolicy;
  capability: AgentCapability;
  /** Cash above the protected reserve. Never negative. */
  availableCents: Cents;
  /**
   * The largest payment the agent could actually make right now: the tightest
   * of the single-payment cap, the remaining daily allowance, and the cash
   * available above the reserve.
   */
  autonomousHeadroomCents: Cents;
  dailySpentCents: Cents;
  dailyLimitCents: Cents;
  projection: CashProjection;
  upcomingInflows: CashFlowEvent[];
  upcomingOutflows: CashFlowEvent[];
  /**
   * Registry counts, for the oracle panel. Kept here rather than counted in a
   * component so the interface reports figures it was given.
   */
  suppliers: { total: number; approved: number };
}

export function buildTreasuryView(
  scenarioId: string,
  horizonDays = 21,
): TreasuryView {
  const scenario = scenarioById(scenarioId);
  const { world, asOfDate } = scenario;

  const availableCents = Math.max(
    0,
    world.treasury.currentCashCents - world.policy.minimumReserveCents,
  );

  const autonomousHeadroomCents = Math.max(
    0,
    Math.min(
      world.capability.maxSinglePaymentCents,
      world.capability.dailyLimitCents - world.capability.dailySpentCents,
      availableCents,
    ),
  );

  const projection = buildProjection({ world, asOf: asOfDate, horizonDays });

  const upcoming = world.cashFlowEvents
    .filter((event) => compareDates(event.date, asOfDate) >= 0)
    .sort((a, b) => compareDates(a.date, b.date));

  return {
    asOfDate,
    treasury: world.treasury,
    policy: world.policy,
    capability: world.capability,
    availableCents,
    autonomousHeadroomCents,
    dailySpentCents: world.capability.dailySpentCents,
    dailyLimitCents: world.capability.dailyLimitCents,
    projection,
    suppliers: {
      total: world.suppliers.length,
      approved: world.suppliers.filter((supplier) => supplier.registryStatus === "APPROVED")
        .length,
    },
    upcomingInflows: upcoming.filter((event) => event.direction === "INFLOW"),
    upcomingOutflows: upcoming.filter((event) => event.direction === "OUTFLOW"),
  };
}

// ---------------------------------------------------------------------------
// Supplier registry
// ---------------------------------------------------------------------------

export interface SupplierView extends Supplier {
  /** invoiceCount x mean, the best lifetime estimate the registry supports. */
  lifetimeVolumeCents: Cents;
  settledPayments: {
    paymentId: string;
    invoiceNumber: string;
    amountCents: Cents;
    currency: string;
    paidAt: IsoDate;
  }[];
  lastPaidAt: IsoDate | null;
}

export function listSuppliers(): SupplierView[] {
  // Suppliers are shared across every scenario world, so the first is enough.
  const suppliers = SCENARIOS[0].world.suppliers;

  return suppliers.map((supplier) => {
    const settled = PAYMENT_HISTORY.filter(
      (record) => record.supplierId === supplier.id,
    )
      .slice()
      .sort((a, b) => compareDates(b.paidAt, a.paidAt));

    return {
      ...supplier,
      lifetimeVolumeCents: supplier.history.invoiceCount * supplier.history.meanAmountCents,
      settledPayments: settled.map((record) => ({
        paymentId: record.paymentId,
        invoiceNumber: record.invoiceNumber,
        amountCents: record.amountCents,
        currency: record.currency,
        paidAt: record.paidAt,
      })),
      lastPaidAt: settled[0]?.paidAt ?? null,
    };
  });
}

export function supplierByName(name: string): SupplierView | null {
  const needle = name.trim().toLowerCase();
  return (
    listSuppliers().find(
      (supplier) =>
        supplier.name.toLowerCase() === needle ||
        supplier.aliases.some((alias) => alias.toLowerCase() === needle),
    ) ?? null
  );
}

export const AS_OF_DATE = DEMO_AS_OF_DATE;
