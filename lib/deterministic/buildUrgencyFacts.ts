/**
 * Timing facts: how soon this payment needs to happen.
 *
 * The mirror image of buildRiskEvidence — this sees dates and nothing about
 * trustworthiness. Keeping the two input sets disjoint is what makes risk and
 * urgency genuinely independent dimensions rather than two names for one score.
 */

import type { InvoiceFacts, SupplierFacts, UrgencyFacts } from "../types";

/** The subset of invoice facts urgency may see — no wallet, no PO, no registry. */
export type UrgencyRelevantInvoiceFacts = Pick<
  InvoiceFacts,
  "dueDate" | "daysUntilDue" | "paymentTerms" | "discount"
>;

export function buildUrgencyFacts(
  invoice: UrgencyRelevantInvoiceFacts,
  supplier: Pick<SupplierFacts, "businessCriticality">,
): UrgencyFacts {
  return {
    dueDate: invoice.dueDate,
    daysUntilDue: invoice.daysUntilDue,
    isOverdue: invoice.daysUntilDue < 0,
    discountDeadline: invoice.discount?.deadline ?? null,
    daysUntilDiscountDeadline: invoice.discount?.daysUntilDeadline ?? null,
    discountAmountCents: invoice.discount?.amountCents ?? null,
    businessCriticality: supplier.businessCriticality,
    paymentTerms: invoice.paymentTerms,
  };
}
