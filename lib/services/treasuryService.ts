/**
 * Treasury service — the company's financial position.
 *
 * WHERE THE BALANCE COMES FROM. The Treasury OBJECT on Sui, whenever the chain
 * can be read; the scenario fixture only when it cannot. That order matters and
 * was the wrong way round: the page rendered `TIGHT_PROFILE`'s hardcoded
 * $100,000 and the vault happened to hold $100,000 too, so the screen looked
 * chain-derived while being a constant. Funding the vault to a different figure
 * would not have moved it, and neither would a payment.
 *
 * Every derived figure — available above reserve, agent headroom, the forecast
 * — is computed HERE from whichever world was supplied, so the interface never
 * owns a financial rule and the two sources cannot disagree about the
 * arithmetic, only about the inputs.
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
import type { WorldSnapshot } from "../types";
import { PAYMENT_HISTORY } from "../demo/paymentHistory";

export interface TreasuryView {
  asOfDate: IsoDate;
  /**
   * Whether these figures came from the chain or from the offline fixture.
   *
   * Stated rather than inferred, so a surface can say which it is showing. A
   * fixture that happens to match the vault is still a fixture.
   */
  fromChain: boolean;
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
  /**
   * The world to measure, when the caller has read one from chain.
   *
   * Omitted offline and in tests, where the scenario's fixture stands in. A
   * caller that passes one is stating that it read the chain; nothing here
   * invents one.
   */
  chainWorld?: WorldSnapshot,
): TreasuryView {
  const scenario = scenarioById(scenarioId);
  const asOfDate = scenario.asOfDate;
  const world = chainWorld ?? scenario.world;

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
    /** True when every figure below was read from Sui rather than a fixture. */
    fromChain: chainWorld !== undefined,
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
