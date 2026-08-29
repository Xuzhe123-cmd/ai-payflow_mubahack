/**
 * Deterministic supplier registry lookup.
 *
 * Reports what the registry says and whether the wallets match. It does not
 * decide whether an unknown supplier is acceptable — that judgement belongs to
 * the LLM, and Move re-checks supplier approval at execution time regardless.
 */

import type { InvoiceFacts, Supplier, SupplierFacts } from "../types";

/** Case- and punctuation-insensitive comparison for company names. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(ltd|limited|inc|incorporated|gmbh|llc|co|corp|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesSupplier(supplier: Supplier, invoiceName: string): boolean {
  const target = normalizeName(invoiceName);
  if (target.length === 0) return false;
  return [supplier.name, ...supplier.aliases].some(
    (candidate) => normalizeName(candidate) === target,
  );
}

export function lookupSupplier(
  invoiceFacts: InvoiceFacts,
  suppliers: readonly Supplier[],
): SupplierFacts {
  const supplier = suppliers.find((s) => matchesSupplier(s, invoiceFacts.supplierName));
  const recipientWallet = invoiceFacts.recipientWallet;

  if (!supplier) {
    return {
      supplierFound: false,
      supplierId: null,
      registryStatus: "NOT_FOUND",
      registeredWallet: null,
      invoiceRecipientWallet: recipientWallet,
      // Nothing to match against; absence of a registered wallet is not a match.
      walletMatch: false,
      businessCriticality: null,
      history: null,
    };
  }

  return {
    supplierFound: true,
    supplierId: supplier.id,
    registryStatus: supplier.registryStatus,
    registeredWallet: supplier.registeredWallet,
    invoiceRecipientWallet: recipientWallet,
    walletMatch: supplier.registeredWallet === recipientWallet,
    businessCriticality: supplier.businessCriticality,
    history: supplier.history,
  };
}
