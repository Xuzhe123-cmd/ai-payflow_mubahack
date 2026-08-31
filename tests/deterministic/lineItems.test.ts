/**
 * Line-item extraction, and the panel that renders it.
 *
 * The billed lines are what make a PO overage legible: a $14,700 invoice
 * against a $9,800 order is an abstract discrepancy until you can see that the
 * order covers the fixture plates and the invoice adds an expedite fee nobody
 * approved. They come out of the document by the same deterministic path as
 * every other fact — parsed, never summarised, and never inferred from a total.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { extractInvoice } from "../../lib/deterministic/extractInvoice";
import { DEMO_DOCUMENTS } from "../../lib/demo/invoices";
import type { RawInvoiceDocument } from "../../lib/types";

const AS_OF = "2026-08-31";

const PANEL = readFileSync(
  resolve(process.cwd(), "components/invoices/PurchaseOrderEvidence.tsx"),
  "utf8",
);
const PAGE = readFileSync(
  resolve(process.cwd(), "app/(app)/invoices/[id]/page.tsx"),
  "utf8",
);

describe("line items come out of the document", () => {
  it("reads the itemised block, in order, with exact amounts", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.poMismatch, AS_OF);

    expect(facts.lineItems).toEqual([
      { description: "Fixture plates and clamps", amountCents: 980_000 },
      { description: "Additional machining and expedite fee", amountCents: 490_000 },
    ]);
  });

  it("reads a single-line invoice as one line, not as the total", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.normal, AS_OF);

    expect(facts.lineItems).toEqual([
      { description: "Bearing assemblies, batch 44", amountCents: 300_000 },
    ]);
  });

  it("sums to the invoice total on every demo document", () => {
    // Not asserted as a rule the extractor enforces — it is a property of these
    // documents, and it catches a parser that drops or duplicates a line.
    for (const [name, doc] of Object.entries(DEMO_DOCUMENTS)) {
      const facts = extractInvoice(doc as RawInvoiceDocument, AS_OF);
      const summed = facts.lineItems.reduce((total, item) => total + item.amountCents, 0);
      expect(summed, `${name} line items should sum to its total`).toBe(facts.amountCents);
    }
  });

  it("returns nothing rather than guessing when there is no itemised block", () => {
    // A wrong line item is worse than a missing one: this is the evidence a
    // reader uses to judge an overage.
    const facts = extractInvoice(
      {
        id: "doc_bare",
        sourceRef: "test",
        receivedAt: AS_OF,
        filename: "bare.pdf",
        text: "SOME SUPPLIER\n\nInvoice Number:  INV-1\nTotal Due (USD)   100.00\n",
      },
      AS_OF,
    );

    expect(facts.lineItems).toEqual([]);
    // And an absent block is not reported as a failed extraction.
    expect(facts.unresolvedFields).not.toContain("lineItems");
  });
});

describe("where the purchase-order panel appears", () => {
  it("renders only for an invoice that cites a purchase order", () => {
    expect(PANEL).toContain("hasPoEvidence");
    expect(PANEL).toContain("return null");
  });

  it("keys off the invoice's own PO reference, never an invoice number", () => {
    // The same rule as the shipment panel: condition-driven, with no special
    // cases for the invoices the demo data happens to define.
    expect(PANEL).not.toMatch(/INV-\d{4}-\d{4}/);
    expect(PAGE).not.toMatch(/INV-\d{4}-\d{4}/);
  });

  it("derives nothing itself — every figure comes from the shared rule", () => {
    expect(PANEL).toContain("evaluatePoEvidence");
    // No arithmetic in the component. The delta was computed by
    // validateInvoice and travels with the analysis.
    expect(PANEL).not.toMatch(/amountCents\s*-\s*\w*[Pp]o/);
  });

  it("shows both documents side by side, not just the verdict", () => {
    expect(PANEL).toContain("Invoice");
    expect(PANEL).toContain("Purchase order");
    expect(PANEL).toContain("ComparisonTable");
    expect(PANEL).toContain("Difference");
  });

  it("names the architecture it sits in", () => {
    // Evidence → AI → guard → Sui, with enforcement outside the UI.
    expect(PANEL).toContain("EvidenceChain");
    expect(PANEL).toContain("describePoPolicy");
  });

  it("never claims a verification the comparison did not make", () => {
    // The panel must not carry a hardcoded "verified" anywhere: the badge is
    // returned by the shared rule, which reserves the matching word.
    expect(PANEL).not.toContain("Purchase Order Verified");
    expect(PANEL).not.toContain("PO Verified");
  });
});
