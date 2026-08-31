/**
 * "View invoice", and why it hung.
 *
 * THE BUG: the modal held a single `doc: StoredDocument | null`, set when the
 * fetch resolved. `null` therefore meant two different things — "still loading"
 * and "there is no such document" — and the header rendered
 * `doc?.filename ?? "Loading…"`. A lookup that found nothing left the modal on
 * "Loading…" with a blank body, for ever. There was no `.catch` either, so a
 * rejection did exactly the same.
 *
 * WHY THE LOOKUP MISSED: `documentService` built its registry from
 * `DEMO_DOCUMENTS` alone — the eight seeded scenarios. Three kinds of id were
 * therefore unresolvable:
 *
 *   doc_escrow_confirmed  INV-2026-3501, registered in CONDITIONAL_DOCUMENTS
 *   doc_escrow_pending    INV-2026-3502, likewise
 *   chain-*               an invoice discovered on chain with no local document
 *
 * Both halves are fixed here: the registry covers every document the app can
 * list, and the lookup reports MISSING explicitly instead of returning a null
 * the caller has to interpret.
 *
 * The viewer is deliberately independent of the AI, the oracle, the escrow, the
 * chain and the payment state — viewing the paperwork must work precisely when
 * those are unavailable.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getDocument,
  hasContent,
  loadDocument,
  storedFrom,
} from "../../lib/services/documentService";
import { DEMO_DOCUMENTS } from "../../lib/demo/invoices";
import { CONDITIONAL_DOCUMENTS } from "../../lib/escrow/conditionalInvoices";
import { resolveInvoiceSource } from "../../lib/demo/invoiceSource";
import { SCENARIOS } from "../../lib/demo/scenarios";
import type { RawInvoiceDocument } from "../../lib/types";

const HEADER = readFileSync(
  resolve(process.cwd(), "components/invoices/InvoiceHeader.tsx"),
  "utf8",
);

/** Every document id the invoice list can hand the viewer. */
const EVERY_DOCUMENT: RawInvoiceDocument[] = [
  ...Object.values(DEMO_DOCUMENTS),
  ...Object.values(CONDITIONAL_DOCUMENTS),
];

// --- 12: successful document loading ---------------------------------------

describe("every invoice the app can list has a loadable document", () => {
  it.each(EVERY_DOCUMENT.map((doc) => [doc.id, doc] as const))(
    "resolves %s",
    async (_id, doc) => {
      const result = await loadDocument(doc.id);

      expect(result.status).toBe("found");
      if (result.status !== "found") return;
      expect(result.document.text.length).toBeGreaterThan(0);
      expect(result.document.filename).toBe(doc.filename);
    },
  );

  it("covers the two conditional invoices that used to hang", async () => {
    // The exact ids that returned null and left the modal spinning.
    for (const id of ["doc_escrow_confirmed", "doc_escrow_pending"]) {
      const result = await loadDocument(id);
      expect(result.status, `${id} must resolve`).toBe("found");
    }
  });

  it("covers every scenario invoice, named individually", async () => {
    // 3486, 3455, 3468 and the rest — the viewer is checked against all of
    // them, not against the two that prompted the report.
    const wanted = [
      "INV-2026-3455",
      "INV-2026-3461",
      "INV-2026-3468",
      "INV-2026-3479",
      "INV-2026-3486",
      "INV-2026-3492",
      "INV-2026-3391",
      "INV-BP-88214",
      // Conditional: one with a shipment condition, one without an escrow yet.
      "INV-2026-3501",
      "INV-2026-3502",
    ];

    for (const invoiceNumber of wanted) {
      const source = resolveInvoiceSource(invoiceNumber);
      expect(source, `${invoiceNumber} should resolve to a source`).not.toBeNull();
      const result = await loadDocument(source!.document.id);
      expect(result.status, `${invoiceNumber} should load`).toBe("found");
    }
  });

  it("keeps the registry in step with the source resolver", async () => {
    // The two lists drifting apart is what caused the bug. If a new kind of
    // invoice is added to one and not the other, this fails.
    for (const scenario of SCENARIOS) {
      const result = await loadDocument(scenario.document.id);
      expect(result.status, `${scenario.id} is resolvable`).toBe("found");
    }
  });
});

// --- 12: lookup failure and missing documents ------------------------------

describe("a lookup that finds nothing", () => {
  it("reports MISSING rather than a null the caller must interpret", async () => {
    const result = await loadDocument("chain-0x927e138e12");

    expect(result.status).toBe("missing");
    if (result.status !== "missing") return;
    expect(result.reason).toContain("chain-0x927e138e12");
  });

  it("terminates for an empty id instead of waiting on nothing", async () => {
    const result = await loadDocument("");
    expect(result.status).toBe("missing");
  });

  it("still exposes the optional shape for callers that want it", async () => {
    expect(await getDocument("doc_normal")).not.toBeNull();
    expect(await getDocument("nope")).toBeNull();
  });
});

describe("a document with no content", () => {
  it("is recognised as empty rather than shown as a blank page", () => {
    // The chain placeholder: a real document object carrying no text. Rendered
    // as-is it is indistinguishable from a viewer that failed.
    expect(hasContent({ text: "" })).toBe(false);
    expect(hasContent({ text: "   \n  " })).toBe(false);
    expect(hasContent(null)).toBe(false);
    expect(hasContent(undefined)).toBe(false);
    expect(hasContent({ text: "INVOICE" })).toBe(true);
  });

  it("can be adapted from a document the caller already holds", () => {
    // The invoice list carries full document text, so the viewer has the bytes
    // before it asks the registry for anything.
    const stored = storedFrom(DEMO_DOCUMENTS.normal);

    expect(stored.id).toBe(DEMO_DOCUMENTS.normal.id);
    expect(stored.text).toBe(DEMO_DOCUMENTS.normal.text);
    expect(stored.blobRef).toBe(DEMO_DOCUMENTS.normal.sourceRef);
  });
});

// --- 3, 4, 13: the modal's states --------------------------------------------

describe("the viewer's states", () => {
  it("distinguishes loading from every terminal state", () => {
    // The heart of the bug: one nullable value cannot express four states.
    for (const state of ['"loading"', '"ready"', '"unavailable"', '"error"']) {
      expect(HEADER, `${state} must be a distinct state`).toContain(state);
    }
  });

  it("shows a distinct message for each", () => {
    expect(HEADER).toContain("Loading invoice…");
    expect(HEADER).toContain("Invoice document unavailable");
    expect(HEADER).toContain("Unable to load invoice");
  });

  it("offers a retry from the error state", () => {
    expect(HEADER).toContain("Retry");
    expect(HEADER).toContain("setAttempt");
  });

  it("handles a rejected promise, so loading always terminates", () => {
    // Without this the modal stayed on "Loading…" for ever.
    expect(HEADER).toContain(".catch(");
  });

  it("no longer uses the loading text as a filename fallback", () => {
    // The original header line fell back to the spinner wording whenever the
    // document was absent, which is what made "not found" indistinguishable
    // from "not loaded yet". Asserted against the JSX rather than the file, so
    // the comment explaining the old bug does not trip it.
    const jsx = HEADER.slice(HEADER.indexOf("return (", HEADER.indexOf("function DocumentViewer")));

    expect(jsx).not.toContain('?? "Loading…"');
    expect(jsx).toContain('source?.filename ?? "Invoice document"');
  });

  it("handles a missing document id explicitly", () => {
    expect(HEADER).toContain("source?.id");
  });
});

// --- 7: independent of everything else --------------------------------------

describe("the viewer depends on nothing but the document", () => {
  it("does not consult the AI, oracle, escrow, chain or payment state", () => {
    const viewer = HEADER.slice(HEADER.indexOf("function DocumentViewer"));

    for (const forbidden of [
      "useConditionState",
      "useChainInvoice",
      "evaluateShipmentEvidence",
      "availablePaymentAction",
      "analyzeOne",
      "/api/escrow",
      "/api/analyze",
    ]) {
      expect(viewer, `viewer must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reads the invoice document, not the shipment proof", () => {
    // Two different documents. The delivery evidence lives in the oracle panel.
    const viewer = HEADER.slice(HEADER.indexOf("function DocumentViewer"));

    expect(viewer).not.toContain("proofStore");
    expect(viewer).not.toContain("ShipmentProof");
    expect(viewer).not.toContain("shipmentId");
  });

  it("resolves without any network or chain call", async () => {
    // loadDocument is local by construction; this asserts it stays that way by
    // succeeding with no server running.
    const result = await loadDocument("doc_escrow_confirmed");
    expect(result.status).toBe("found");
  });
});
