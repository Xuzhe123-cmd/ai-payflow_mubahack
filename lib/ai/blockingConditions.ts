/**
 * The deterministic safety boundary: conditions under which no payment may be
 * recommended, whatever the model says.
 *
 * These are the facts the chain would refuse outright — an unregistered
 * supplier, a redirected remit wallet, an invoice already settled, a currency
 * the treasury does not permit. They are not judgement calls, so they are not
 * the model's to make.
 *
 * This lives in one place and is read by two callers: the deterministic engine,
 * which uses it to decide, and the guard, which uses it to overrule. Keeping a
 * single definition is the point — two lists of blocking rules would drift, and
 * the drift would be invisible until a payment went somewhere it should not.
 */

import type { DeterministicAnalysis } from "../types";

/** Reasons the chain would refuse this outright, whatever anyone recommends. */
export function blockingConditions(analysis: Readonly<DeterministicAnalysis>): string[] {
  const { supplierFacts: sup, validationFacts: val, invoiceFacts: inv } = analysis;
  const reasons: string[] = [];

  if (!sup.supplierFound) {
    reasons.push(`"${inv.supplierName}" is not in the approved supplier registry.`);
  } else if (sup.registryStatus !== "APPROVED") {
    reasons.push(`Supplier ${sup.supplierId} has registry status ${sup.registryStatus}.`);
  } else if (!sup.walletMatch) {
    // Only meaningful once we know who the supplier is supposed to be.
    reasons.push(
      "The remit wallet does not match the address registered for this supplier.",
    );
  }

  if (val.isDuplicate) {
    reasons.push(`Invoice ${inv.invoiceNumber} has already been settled on chain.`);
  }
  if (!val.currencyAllowed) {
    reasons.push(`${inv.currency || "(none)"} is not a permitted settlement currency.`);
  }

  return reasons;
}
