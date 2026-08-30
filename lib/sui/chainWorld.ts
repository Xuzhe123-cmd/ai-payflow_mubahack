/**
 * Builds the pipeline's WorldSnapshot from live chain state.
 *
 * This is what lets the existing dashboard show real testnet facts without a
 * single component changing: the pipeline keeps the shape it already consumes,
 * and the values inside it stop being fixtures.
 *
 * What comes from the chain, and what cannot:
 *
 *   treasury, policy, capability   chain — these are the numbers Move enforces
 *   suppliers (status, wallet)     chain — the registry is the authority
 *   cash-flow events               chain
 *   payment history                chain — derived from invoices already PAID,
 *                                  which is what makes duplicate detection real
 *   purchase orders                fixtures — there is no on-chain equivalent
 *   supplier ALIASES               fixtures — the registry stores one name, but
 *                                  extraction needs the spellings that appear
 *                                  on real documents
 *
 * The overlay below is deliberate rather than a wholesale replacement: taking
 * status and wallet from the chain while keeping the fixture aliases means
 * supplier lookup still works on invoice text, and the facts that decide a
 * payment still come from the chain.
 */

import type {
  PaymentRecord,
  Supplier,
  TreasuryPolicy,
  WorldSnapshot,
} from "../types";
import type { ChainSnapshot, ChainSupplier } from "./chainTypes";
import { APPROVER_AUTHORITY } from "../demo/policies";
import { PURCHASE_ORDERS } from "../demo/purchaseOrders";
import { SUPPLIERS } from "../demo/suppliers";

/** Chain status maps onto the registry status the pipeline already understands. */
function registryStatusOf(supplier: ChainSupplier): Supplier["registryStatus"] {
  switch (supplier.status) {
    case "APPROVED":
      return "APPROVED";
    case "REVOKED":
      return "REVOKED";
    default:
      return "PENDING";
  }
}

function mergeSuppliers(chain: readonly ChainSupplier[]): Supplier[] {
  const byId = new Map(SUPPLIERS.map((supplier) => [supplier.id, supplier]));

  const merged = chain.map((entry) => {
    const fixture = byId.get(entry.supplierId);
    byId.delete(entry.supplierId);
    return {
      id: entry.supplierId,
      name: entry.name || fixture?.name || entry.supplierId,
      // Aliases exist only in the fixtures; the registry stores one name, and
      // extraction has to match whatever the document happens to say.
      aliases: fixture?.aliases ?? [],
      registryStatus: registryStatusOf(entry),
      registeredWallet: entry.registeredWallet,
      businessCriticality: fixture?.businessCriticality ?? "MEDIUM",
      history: fixture?.history ?? {
        invoiceCount: 0,
        meanAmountCents: 0,
        maxAmountCents: 0,
        onTimePaymentRate: 0,
        firstSeen: "1970-01-01",
      },
    } satisfies Supplier;
  });

  // A supplier the chain does not know must NOT be carried in from fixtures —
  // that would vouch for a counterparty the registry has never approved.
  return merged;
}

/**
 * Invoices already settled on chain become payment history, which is what the
 * duplicate check reads. This is the only reason an already-paid invoice can be
 * recognised as one.
 */
function paymentHistoryFrom(snapshot: ChainSnapshot): PaymentRecord[] {
  return snapshot.invoices
    .filter((invoice) => invoice.status === "PAID")
    .map((invoice) => ({
      paymentId: `chain_${invoice.objectId.slice(0, 10)}`,
      invoiceNumber: invoice.invoiceNumber,
      supplierId: invoice.supplierId,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      paidAt: invoice.dueDate,
      recipientWallet: invoice.recipient,
    }));
}

export function worldFromChain(snapshot: ChainSnapshot): WorldSnapshot {
  const policy: TreasuryPolicy = {
    minimumReserveCents: snapshot.treasury.minimumReserveCents,
    allowedCurrencies: [...snapshot.treasury.allowedCurrencies],
    humanApprovalThresholdCents: snapshot.treasury.humanApprovalThresholdCents,
  };

  const agent = snapshot.agent;

  return {
    suppliers: mergeSuppliers(snapshot.suppliers),
    // No on-chain equivalent; PO matching stays a fixture concern.
    purchaseOrders: PURCHASE_ORDERS,
    paymentHistory: paymentHistoryFrom(snapshot),
    cashFlowEvents: snapshot.cashFlowEvents.map((event, index) => ({
      id: `chain_${index}`,
      date: event.date,
      direction: event.direction,
      amountCents: event.amountCents,
      description: event.description,
    })),
    treasury: {
      currentCashCents: snapshot.treasury.balanceCents,
      currency: snapshot.treasury.allowedCurrencies[0] ?? "USD",
    },
    policy,
    capability: {
      agentId: agent?.agentId ?? "agent",
      // No registered agent means no autonomous authority at all, rather than
      // a default that would quietly permit something.
      authorized: agent !== null,
      enabled: agent?.enabled ?? false,
      maxSinglePaymentCents: agent?.maxSinglePaymentCents ?? 0,
      dailyLimitCents: agent?.dailyLimitCents ?? 0,
      dailySpentCents: agent?.spentTodayCents ?? 0,
    },
    approver: APPROVER_AUTHORITY,
  };
}
