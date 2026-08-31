/**
 * Collects observations relevant to whether a payment is safe.
 *
 * Critically, this returns EVIDENCE, not a verdict: no score, no weight, no
 * severity. Aggregating these into a risk level is the LLM's job. A severity
 * field here would quietly become the decision, which is exactly the design we
 * are avoiding.
 *
 * Note what is absent: no due date, no discount deadline, nothing temporal.
 * The input type makes "nearer due date = higher risk" impossible to express.
 */

import type {
  InvoiceFacts,
  RiskEvidenceItem,
  SupplierFacts,
  ValidationFacts,
} from "../types";
import { formatMoney } from "../util/money";

/** The subset of invoice facts risk evidence may see — deliberately date-free. */
export type RiskRelevantInvoiceFacts = Pick<
  InvoiceFacts,
  "invoiceNumber" | "supplierName" | "amountCents" | "currency" | "poNumber" | "unresolvedFields"
>;

export function buildRiskEvidence(
  invoice: RiskRelevantInvoiceFacts,
  supplier: SupplierFacts,
  validation: ValidationFacts,
): RiskEvidenceItem[] {
  const evidence: RiskEvidenceItem[] = [];

  if (!supplier.supplierFound) {
    evidence.push({
      code: "SUPPLIER_NOT_IN_REGISTRY",
      observation: `"${invoice.supplierName}" does not appear in the approved supplier registry.`,
      evidence: { supplierName: invoice.supplierName, registryStatus: supplier.registryStatus },
    });
  } else if (supplier.registryStatus !== "APPROVED") {
    evidence.push({
      code: "SUPPLIER_NOT_APPROVED",
      observation: `Supplier is in the registry but its status is ${supplier.registryStatus}, not APPROVED.`,
      evidence: { supplierId: supplier.supplierId, registryStatus: supplier.registryStatus },
    });
  }

  if (supplier.supplierFound && !supplier.walletMatch) {
    evidence.push({
      code: "WALLET_MISMATCH",
      observation:
        "The invoice's remit wallet differs from the wallet registered for this supplier.",
      evidence: {
        registeredWallet: supplier.registeredWallet,
        invoiceRecipientWallet: supplier.invoiceRecipientWallet,
      },
    });
  }

  // AN ALREADY-PAID INVOICE IS NOT A DUPLICATE INVOICE.
  //
  // `validation.isDuplicate` means "a payment record exists for this invoice
  // number" — that is, THIS invoice has been paid. Reported as
  // DUPLICATE_INVOICE it rendered as "Duplicate invoice: Invoice number
  // INV-2026-3501 has already been settled", which accuses the original
  // invoice of being a duplicate of itself.
  //
  // A duplicate invoice is a SECOND document improperly repeating a first. We
  // have no evidence of one here, and inventing the accusation from a
  // settlement fact is exactly the conflation being removed. The observation
  // stays — a settled invoice cannot be paid again and the reader must know
  // that — but it is a settlement fact, and it says so.
  if (validation.isDuplicate) {
    evidence.push({
      code: "INVOICE_ALREADY_SETTLED",
      observation: `Invoice ${invoice.invoiceNumber} was already settled on chain.`,
      evidence: {
        invoiceNumber: invoice.invoiceNumber,
        settledByPaymentId: validation.duplicateOfPaymentId,
      },
    });
  }

  if (invoice.poNumber && !validation.poFound) {
    evidence.push({
      code: "PO_NOT_FOUND",
      observation: `Purchase order ${invoice.poNumber} is not in the purchase-order records.`,
      evidence: { poNumber: invoice.poNumber },
    });
  }

  if (validation.poFound && validation.poMatch === false) {
    const delta = validation.poDeltaCents ?? 0;
    const poAmount = validation.poAmountCents ?? 0;
    const overagePercent = poAmount > 0 ? Math.round((delta / poAmount) * 1000) / 10 : null;
    evidence.push({
      code: "PO_AMOUNT_MISMATCH",
      observation:
        `Invoice bills ${formatMoney(invoice.amountCents, invoice.currency)} against a ` +
        `${formatMoney(poAmount, invoice.currency)} purchase order ` +
        `(${delta >= 0 ? "over" : "under"} by ${formatMoney(Math.abs(delta), invoice.currency)}).`,
      evidence: {
        invoiceAmountCents: invoice.amountCents,
        poAmountCents: poAmount,
        deltaCents: delta,
        overagePercent,
      },
    });
  }

  if (
    validation.amountVsSupplierMaxRatio !== null &&
    validation.amountVsSupplierMaxRatio > 1
  ) {
    evidence.push({
      code: "AMOUNT_ABOVE_SUPPLIER_HISTORY",
      observation:
        `Amount is ${validation.amountVsSupplierMaxRatio}x this supplier's largest previous invoice ` +
        `and ${validation.amountVsSupplierMeanRatio}x their average.`,
      evidence: {
        amountCents: invoice.amountCents,
        historicalMaxCents: supplier.history?.maxAmountCents ?? null,
        vsMaxRatio: validation.amountVsSupplierMaxRatio,
        vsMeanRatio: validation.amountVsSupplierMeanRatio,
      },
    });
  }

  if (supplier.supplierFound && supplier.history === null) {
    evidence.push({
      code: "NO_SUPPLIER_HISTORY",
      observation: "Supplier is registered but has no recorded payment history.",
      evidence: { supplierId: supplier.supplierId },
    });
  }

  if (!validation.currencyAllowed) {
    evidence.push({
      code: "CURRENCY_NOT_ALLOWED",
      observation: `Invoice currency ${invoice.currency || "(unreadable)"} is not on the treasury's allowed list.`,
      evidence: { currency: invoice.currency },
    });
  }

  if (invoice.unresolvedFields.length > 0) {
    evidence.push({
      code: "INCOMPLETE_EXTRACTION",
      observation: `Some invoice fields could not be read: ${invoice.unresolvedFields.join(", ")}.`,
      evidence: { unresolvedFields: invoice.unresolvedFields.join(", ") },
    });
  }

  return evidence;
}
