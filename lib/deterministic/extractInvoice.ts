/**
 * Deterministic invoice extraction.
 *
 * Parses a RawInvoiceDocument into exact, typed facts. Amounts become integer
 * cents here and are never re-derived downstream — the LLM is told these
 * figures are pre-verified, so this is where that promise is kept.
 *
 * The DocumentExtractor interface is the seam where a Workers AI document
 * extractor (Phase 8, Walrus PDFs) drops in without touching anything else.
 */

import type {
  Cents,
  DiscountFacts,
  InvoiceFacts,
  InvoiceLineItem,
  IsoDate,
  RawInvoiceDocument,
} from "../types";
import { daysBetween, isIsoDate } from "../util/date";
import { percentOf } from "../util/money";

export interface DocumentExtractor {
  readonly id: string;
  extract(doc: RawInvoiceDocument, asOf: IsoDate): InvoiceFacts;
}

/** "12,400.00" -> 1240000. Returns null if the text is not a money amount. */
export function parseMoneyText(text: string): Cents | null {
  const match = /^-?[\d,]+(?:\.\d{1,2})?$/.exec(text.trim());
  if (!match) return null;
  const cleaned = text.trim().replace(/,/g, "");
  const negative = cleaned.startsWith("-");
  const [major, minor = ""] = cleaned.replace(/^-/, "").split(".");
  const cents = Number(major) * 100 + Number(minor.padEnd(2, "0"));
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/** Reads a `Label: value` line, tolerating the wide column padding. */
function readLabelled(text: string, label: string): string | null {
  const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im");
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function readTotal(text: string): { amountCents: Cents; currency: string } | null {
  const match = /^\s*Total Due\s*\(([A-Z]{3})\)\s+([\d,]+\.\d{2})\s*$/im.exec(text);
  if (!match) return null;
  const amountCents = parseMoneyText(match[2]);
  if (amountCents === null) return null;
  return { amountCents, currency: match[1] };
}

function readDiscount(text: string, amountCents: Cents, asOf: IsoDate): DiscountFacts | null {
  const match =
    /^\s*Early Payment Discount\s*:\s*([\d.]+)%\s+if paid by\s+(\d{4}-\d{2}-\d{2})\s*$/im.exec(text);
  if (!match) return null;
  const percent = Number(match[1]);
  const deadline = match[2];
  if (!Number.isFinite(percent) || !isIsoDate(deadline)) return null;
  return {
    percent,
    amountCents: percentOf(amountCents, percent),
    deadline,
    daysUntilDeadline: daysBetween(asOf, deadline),
  };
}

/**
 * The billed lines, from the itemised block.
 *
 * The block runs from the `Description ... Amount` header to the rule above
 * the total, and each line is a description followed by a money amount in the
 * right-hand column. Anything that does not parse as such a line is skipped
 * rather than guessed at — a wrong line item is worse than a missing one,
 * because this is the evidence a reader uses to judge a PO overage.
 *
 * Deliberately does NOT fall back to the total. An invoice with no itemised
 * section has no line items, and inventing one from the total would present a
 * derived figure as something the document stated.
 */
function readLineItems(text: string): InvoiceLineItem[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*Description\s+Amount\s*$/i.test(line));
  if (start === -1) return [];

  const items: InvoiceLineItem[] = [];
  for (const line of lines.slice(start + 1)) {
    // The rule, the total, or a blank line ends the block.
    if (/^\s*-{3,}\s*$/.test(line)) break;
    if (/^\s*Total Due/i.test(line)) break;
    if (line.trim().length === 0) break;

    const match = /^\s*(.+?)\s{2,}(-?[\d,]+\.\d{2})\s*$/.exec(line);
    if (!match) continue;
    const amountCents = parseMoneyText(match[2]);
    if (amountCents === null) continue;
    items.push({ description: match[1].trim(), amountCents });
  }

  return items;
}

/** The supplier name is the document's first non-empty line, by convention. */
function readSupplierName(text: string): string | null {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return first ?? null;
}

export const TEXT_EXTRACTOR: DocumentExtractor = {
  id: "text",

  extract(doc: RawInvoiceDocument, asOf: IsoDate): InvoiceFacts {
    const unresolvedFields: string[] = [];
    const extractionConfidence: Record<string, number> = {};

    const note = (field: string, value: unknown, confidence: number) => {
      if (value === null || value === undefined) {
        unresolvedFields.push(field);
        extractionConfidence[field] = 0;
      } else {
        extractionConfidence[field] = confidence;
      }
    };

    const invoiceNumber = readLabelled(doc.text, "Invoice Number");
    const dueDateRaw = readLabelled(doc.text, "Due Date");
    const poNumber = readLabelled(doc.text, "Purchase Order");
    const paymentTerms = readLabelled(doc.text, "Payment Terms");
    const wallet = readLabelled(doc.text, "Remit to wallet");
    const total = readTotal(doc.text);
    // Positional rather than labelled, so it earns less confidence.
    const supplierName = readSupplierName(doc.text);

    note("invoiceNumber", invoiceNumber, 1);
    note("dueDate", dueDateRaw && isIsoDate(dueDateRaw) ? dueDateRaw : null, 1);
    note("poNumber", poNumber, 1);
    note("paymentTerms", paymentTerms, 1);
    note("recipientWallet", wallet, 1);
    note("amount", total, 1);
    note("supplierName", supplierName, 0.9);

    const dueDate = dueDateRaw && isIsoDate(dueDateRaw) ? dueDateRaw : asOf;
    const amountCents = total?.amountCents ?? 0;
    const discount = total ? readDiscount(doc.text, amountCents, asOf) : null;
    if (discount) extractionConfidence.discount = 1;

    const lineItems = readLineItems(doc.text);
    // Not an unresolved FIELD: plenty of invoices carry no itemised block, and
    // reporting its absence as a failed extraction would misdescribe them.
    if (lineItems.length > 0) extractionConfidence.lineItems = 1;

    return {
      invoiceNumber: invoiceNumber ?? "",
      supplierName: supplierName ?? "",
      amountCents,
      currency: total?.currency ?? "",
      dueDate,
      daysUntilDue: daysBetween(asOf, dueDate),
      poNumber,
      recipientWallet: wallet ?? "",
      paymentTerms,
      discount,
      extractionConfidence,
      unresolvedFields,
      lineItems,
    };
  },
};

export function extractInvoice(doc: RawInvoiceDocument, asOf: IsoDate): InvoiceFacts {
  return TEXT_EXTRACTOR.extract(doc, asOf);
}
