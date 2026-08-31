/**
 * The purchase-order comparison, as something a reader can check.
 *
 * THE PROBLEM THIS EXISTS FOR: the page said "PO mismatch" and stopped. A
 * reader had to take the claim on trust, because the order it was compared
 * against was nowhere on screen — no number, no amount, no supplier, nothing.
 * An unfalsifiable assertion is not evidence, and "the AI detected a mismatch"
 * is exactly the kind of statement this product exists to avoid making.
 *
 * So this returns the COMPARISON, not the conclusion:
 *
 *   FACT         the invoice, and the purchase order it names
 *   COMPARISON   the two side by side, field by field
 *   REASONING    which field disagrees, and by how much
 *   POLICY       what the deterministic guard does about it
 *   OUTCOME      whether a payment is made
 *
 * WHAT THIS DOES NOT DO: decide anything. Every figure here comes from
 * `ValidationFacts`, computed by `validateInvoice` against the purchase-order
 * ledger, and the arithmetic was done there. This re-formats a comparison that
 * already happened; it does not perform one, and it enforces no policy. The
 * guard remains the only thing that can refuse a payment.
 *
 * Pure, and driven entirely by the facts passed in. No invoice number decides
 * anything, and none may.
 */

import type { Cents, InvoiceLineItem, IsoDate, ValidationFacts } from "../types";
import { formatMoneyRounded } from "../util/money";

export type PoVerdict =
  /** The invoice names no purchase order. There is nothing to compare. */
  | "NO_REFERENCE"
  /** A PO is referenced and could not be retrieved from the ledger. */
  | "PO_UNAVAILABLE"
  /** Retrieved, and it belongs to a different supplier. */
  | "SUPPLIER_MISMATCH"
  /** Retrieved, same supplier, and the amounts disagree. */
  | "AMOUNT_MISMATCH"
  /** Retrieved, same supplier, same amount, and the currencies disagree. */
  | "CURRENCY_MISMATCH"
  /** Every comparable field agrees. The only verdict that may say "matches". */
  | "MATCH";

/** One field, on both documents, with whether they agree. */
export interface PoComparisonRow {
  label: string;
  invoice: string;
  purchaseOrder: string;
  /** null where the field is not comparable rather than disagreeing. */
  agrees: boolean | null;
  mono?: boolean;
}

export interface PoLineItemView {
  description: string;
  amountLabel: string;
  /**
   * Whether this line's description is exactly the order's description.
   *
   * A STRING COMPARISON, and presented as nothing more. It makes an overage
   * legible — the order covers one line and the invoice adds another — but it
   * authorises nothing and the guard never reads it. The policy compares
   * amounts; this only helps a person see where the difference came from.
   */
  matchesOrderDescription: boolean;
}

export interface PoEvidenceResult {
  verdict: PoVerdict;
  /** True only for MATCH. Never widen this to a truthy check. */
  matched: boolean;
  /** The badge word. Never says "verified" for a comparison that did not run. */
  badge: string;
  headline: string;
  /** Why, in a sentence, naming the field and the figure. Null for a match. */
  reason: string | null;
  /** The side-by-side, for the fields that exist on both documents. */
  rows: PoComparisonRow[];
  /** Invoice amount − PO amount, when both are known. */
  deltaCents: Cents | null;
  deltaLabel: string | null;
  lineItems: PoLineItemView[];
  /** The order's own description, as recorded in the ledger. */
  orderDescription: string | null;
  orderIssuedAt: IsoDate | null;
}

export interface PoEvidenceInput {
  poNumber: string | null;
  invoiceSupplierName: string;
  invoiceAmountCents: Cents;
  invoiceCurrency: string;
  lineItems: readonly InvoiceLineItem[];
  validation: Pick<
    ValidationFacts,
    | "poFound"
    | "poAmountCents"
    | "poDeltaCents"
    | "poMatch"
    | "poCurrency"
    | "poDescription"
    | "poIssuedAt"
    | "poSupplierId"
    | "poSupplierMatch"
  >;
}

export function evaluatePoEvidence(input: PoEvidenceInput): PoEvidenceResult {
  const { validation: v } = input;
  const money = (cents: Cents, currency: string) => formatMoneyRounded(cents, currency);

  // ---- No reference at all -------------------------------------------------
  // Not a failure and not a finding. Most invoices carry no PO, and inventing a
  // section for them would show a comparison that never happened.
  if (!input.poNumber) {
    return empty("NO_REFERENCE", "NO PURCHASE ORDER REFERENCED", "No purchase order referenced", null);
  }

  // ---- Referenced and not retrievable --------------------------------------
  // Distinct from "no PO", and distinct from a mismatch: nothing was compared,
  // so nothing may be reported as either matching or disagreeing.
  if (!v.poFound) {
    return empty(
      "PO_UNAVAILABLE",
      "PURCHASE ORDER UNAVAILABLE",
      "Purchase order not available for verification",
      `PO reference found, but purchase order ${input.poNumber} could not be retrieved from the ledger. No comparison was performed.`,
    );
  }

  const poCurrency = v.poCurrency ?? input.invoiceCurrency;
  const poAmount = v.poAmountCents ?? 0;
  const delta = v.poDeltaCents ?? input.invoiceAmountCents - poAmount;

  const rows: PoComparisonRow[] = [
    {
      label: "Supplier",
      invoice: input.invoiceSupplierName,
      // The ledger stores an id, not a name. Shown as the id rather than
      // borrowing the invoice's name, which would make a mismatch invisible.
      purchaseOrder: v.poSupplierMatch ? input.invoiceSupplierName : (v.poSupplierId ?? "—"),
      agrees: v.poSupplierMatch,
    },
    {
      label: "PO number",
      invoice: input.poNumber,
      purchaseOrder: input.poNumber,
      agrees: true,
      mono: true,
    },
    {
      label: "Amount",
      invoice: money(input.invoiceAmountCents, input.invoiceCurrency),
      purchaseOrder: money(poAmount, poCurrency),
      agrees: delta === 0,
    },
    {
      label: "Currency",
      invoice: input.invoiceCurrency,
      purchaseOrder: poCurrency,
      agrees: input.invoiceCurrency === poCurrency,
    },
  ];

  const lineItems: PoLineItemView[] = input.lineItems.map((item) => ({
    description: item.description,
    amountLabel: money(item.amountCents, input.invoiceCurrency),
    matchesOrderDescription:
      v.poDescription !== null &&
      item.description.trim().toLowerCase() === v.poDescription.trim().toLowerCase(),
  }));

  const shared = {
    rows,
    deltaCents: delta,
    deltaLabel: signed(delta, input.invoiceCurrency),
    lineItems,
    orderDescription: v.poDescription,
    orderIssuedAt: v.poIssuedAt,
  };

  // ---- Retrieved, and disagreeing ------------------------------------------
  // Supplier first: an order belonging to somebody else is wrong regardless of
  // what it is worth.
  if (v.poSupplierMatch === false) {
    return {
      verdict: "SUPPLIER_MISMATCH",
      matched: false,
      badge: "PURCHASE ORDER MISMATCH",
      headline: "Purchase order belongs to a different supplier",
      reason: `${input.poNumber} is recorded against ${v.poSupplierId ?? "another supplier"}, not against ${input.invoiceSupplierName}.`,
      ...shared,
    };
  }

  if (delta !== 0) {
    const over = delta > 0;
    return {
      verdict: "AMOUNT_MISMATCH",
      matched: false,
      badge: "PURCHASE ORDER MISMATCH",
      headline: "Purchase order mismatch",
      reason:
        `Invoice amount ${money(input.invoiceAmountCents, input.invoiceCurrency)} ` +
        `${over ? "exceeds" : "falls short of"} PO amount ${money(poAmount, poCurrency)} ` +
        `by ${money(Math.abs(delta), input.invoiceCurrency)}.`,
      ...shared,
    };
  }

  if (input.invoiceCurrency !== poCurrency) {
    return {
      verdict: "CURRENCY_MISMATCH",
      matched: false,
      badge: "PURCHASE ORDER MISMATCH",
      headline: "Purchase order mismatch",
      reason: `Invoice is billed in ${input.invoiceCurrency}; ${input.poNumber} authorises ${poCurrency}.`,
      ...shared,
    };
  }

  // ---- Every comparable field agrees ---------------------------------------
  return {
    verdict: "MATCH",
    matched: true,
    badge: "PURCHASE ORDER MATCHES",
    headline: "Purchase order matches",
    reason: null,
    ...shared,
  };
}

/**
 * What the deterministic layer does about this comparison — and what it does
 * not.
 *
 * Stated on screen because the honest answer is more interesting than the one a
 * reader would assume. A PO overage is NOT a blocking condition: it does not
 * appear in `blockingConditions`, so it never forces a refusal on its own. It
 * is evidence the model weighs, and the guard's ceiling constrains what the
 * model may conclude from it.
 *
 * Claiming the guard blocks on PO mismatch would be a lie about the policy, and
 * a reader who checked would find the invoice escalated rather than refused.
 */
export function describePoPolicy(verdict: PoVerdict): string {
  switch (verdict) {
    case "MATCH":
      return "The purchase order corroborates the invoice. No policy concern arises from this comparison.";
    case "AMOUNT_MISMATCH":
    case "SUPPLIER_MISMATCH":
    case "CURRENCY_MISMATCH":
      return (
        "A purchase-order mismatch is recorded as risk evidence, not as a blocking condition. " +
        "It does not refuse the payment on its own — it is a fact the model must weigh, and the " +
        "deterministic guard constrains what the model is allowed to conclude from it."
      );
    case "PO_UNAVAILABLE":
      return (
        "No comparison was performed, so this contributes no evidence either way. The remaining " +
        "deterministic checks are unaffected."
      );
    case "NO_REFERENCE":
      return "This invoice references no purchase order, so no comparison applies.";
  }
}

/** Whether the evidence section should render at all. Condition-driven. */
export function hasPoEvidence(poNumber: string | null | undefined): boolean {
  return typeof poNumber === "string" && poNumber.trim().length > 0;
}

function signed(delta: Cents, currency: string): string {
  if (delta === 0) return formatMoneyRounded(0, currency);
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${formatMoneyRounded(Math.abs(delta), currency)}`;
}

function empty(
  verdict: PoVerdict,
  badge: string,
  headline: string,
  reason: string | null,
): PoEvidenceResult {
  return {
    verdict,
    matched: false,
    badge,
    headline,
    reason,
    rows: [],
    deltaCents: null,
    deltaLabel: null,
    lineItems: [],
    orderDescription: null,
    orderIssuedAt: null,
  };
}
