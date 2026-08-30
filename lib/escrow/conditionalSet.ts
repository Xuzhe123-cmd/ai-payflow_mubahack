/**
 * Which invoices carry a shipment condition.
 *
 * The manifest is a starting point and never the authority: it records what the
 * seed created and knows nothing about anything created since. An invoice with
 * an escrow object against it, or sitting at ESCROWED on chain, is conditional
 * whether or not anyone wrote it down locally — and if this used the manifest
 * alone, the next conditional invoice created would show no shipment evidence
 * at all, which is exactly how the first pair went missing.
 *
 * Pure, so the union rule is assertable without a chain.
 */

export interface ConditionalInvoiceRef {
  invoiceNumber: string;
  amountCents: number;
}

export interface OnChainInvoiceRef extends ConditionalInvoiceRef {
  status: string;
}

/** Statuses that only a conditional invoice reaches. */
const CONDITIONAL_STATUSES = new Set(["ESCROWED", "HELD"]);

export function conditionalInvoiceSet(
  seeded: readonly ConditionalInvoiceRef[],
  onChain: readonly OnChainInvoiceRef[],
  escrowedNumbers: ReadonlySet<string>,
): ConditionalInvoiceRef[] {
  const byNumber = new Map<string, ConditionalInvoiceRef>();

  for (const invoice of seeded) {
    byNumber.set(invoice.invoiceNumber, invoice);
  }

  for (const invoice of onChain) {
    if (byNumber.has(invoice.invoiceNumber)) continue;
    const conditional =
      escrowedNumbers.has(invoice.invoiceNumber) || CONDITIONAL_STATUSES.has(invoice.status);
    if (conditional) {
      byNumber.set(invoice.invoiceNumber, {
        invoiceNumber: invoice.invoiceNumber,
        amountCents: invoice.amountCents,
      });
    }
  }

  return [...byNumber.values()].sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
}
