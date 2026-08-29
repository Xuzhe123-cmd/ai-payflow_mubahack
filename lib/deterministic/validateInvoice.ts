/**
 * Deterministic invoice validation: duplicate status, PO comparison, amount
 * ratios against supplier history, currency admissibility.
 *
 * Every output is a measured fact. There is no severity, no score, and no
 * verdict — the LLM weighs these, and Move independently re-checks the ones
 * that are authorization-relevant.
 */

import type {
  InvoiceFacts,
  PaymentRecord,
  PurchaseOrder,
  SupplierFacts,
  TreasuryPolicy,
  ValidationFacts,
} from "../types";

export function validateInvoice(
  invoiceFacts: InvoiceFacts,
  supplierFacts: SupplierFacts,
  purchaseOrders: readonly PurchaseOrder[],
  paymentHistory: readonly PaymentRecord[],
  policy: TreasuryPolicy,
): ValidationFacts {
  const duplicate = paymentHistory.find(
    (record) => record.invoiceNumber === invoiceFacts.invoiceNumber,
  );

  const po = invoiceFacts.poNumber
    ? purchaseOrders.find((candidate) => candidate.poNumber === invoiceFacts.poNumber)
    : undefined;

  const poDeltaCents = po ? invoiceFacts.amountCents - po.amountCents : null;

  const history = supplierFacts.history;
  const ratio = (basis: number | undefined) =>
    basis && basis > 0
      ? Math.round((invoiceFacts.amountCents / basis) * 1000) / 1000
      : null;

  return {
    isDuplicate: duplicate !== undefined,
    duplicateOfPaymentId: duplicate?.paymentId ?? null,
    poFound: po !== undefined,
    poAmountCents: po?.amountCents ?? null,
    poDeltaCents,
    poMatch: po ? poDeltaCents === 0 : null,
    amountVsSupplierMeanRatio: ratio(history?.meanAmountCents),
    amountVsSupplierMaxRatio: ratio(history?.maxAmountCents),
    currencyAllowed: policy.allowedCurrencies.includes(invoiceFacts.currency),
  };
}
