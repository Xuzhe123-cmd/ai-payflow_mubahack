/**
 * Document service.
 *
 * SWAP POINT — Walrus.
 *   getDocument() becomes a read of the blob referenced by the invoice, and
 *   sourceRef becomes a Walrus blob id instead of an email message id.
 * The viewer component receives text either way.
 *
 * THE BUG THIS REGISTRY HAD: it was built from `DEMO_DOCUMENTS` alone — the
 * eight seeded scenarios. The conditional pair's documents live in
 * `CONDITIONAL_DOCUMENTS`, created after that seed, and an invoice discovered
 * on chain with no local paperwork carries a placeholder document with a
 * generated id. Neither was in the map, so `getDocument` returned null for
 * them, and the viewer — which could not tell "not found" from "not loaded
 * yet" — sat on "Loading…" forever.
 *
 * Both halves are fixed: this file knows about every document the application
 * can actually list, and the lookup now reports MISSING explicitly rather than
 * returning a null that a caller has to interpret.
 */

import type { RawInvoiceDocument } from "../types";
import { DEMO_DOCUMENTS } from "../demo/invoices";
import { CONDITIONAL_DOCUMENTS } from "../escrow/conditionalInvoices";

/**
 * Every document the interface can be asked for.
 *
 * Assembled from the same sources `resolveInvoiceSource` uses, so the viewer
 * and the analyzer cannot disagree about which documents exist. Adding a new
 * kind of invoice means adding it there and here, and the test asserts the two
 * stay in step.
 */
const BY_ID = new Map<string, RawInvoiceDocument>(
  [...Object.values(DEMO_DOCUMENTS), ...Object.values(CONDITIONAL_DOCUMENTS)].map((doc) => [
    doc.id,
    doc,
  ]),
);

export interface StoredDocument {
  id: string;
  filename: string;
  /** Where the bytes live. A Walrus blob id once Walrus is wired in. */
  blobRef: string;
  storage: "demo" | "walrus";
  text: string;
}

/**
 * The outcome of a lookup, stated rather than implied.
 *
 * `null` used to mean both "still loading" and "no such document", which is
 * precisely how a modal ends up stuck: the caller had no way to tell a pending
 * promise from a completed one that found nothing.
 */
export type DocumentResult =
  | { status: "found"; document: StoredDocument }
  /** No document under that id. A real answer, and a terminal one. */
  | { status: "missing"; reason: string };

export async function loadDocument(documentId: string): Promise<DocumentResult> {
  const doc = BY_ID.get(documentId);
  if (!doc) {
    return {
      status: "missing",
      reason: `No document is on file under ${documentId || "(no id)"}.`,
    };
  }
  return { status: "found", document: toStored(doc) };
}

/**
 * The same lookup, returning null when nothing is on file.
 *
 * Kept for callers that genuinely want the optional shape. Prefer
 * `loadDocument` anywhere a UI has to distinguish pending from absent.
 */
export async function getDocument(documentId: string): Promise<StoredDocument | null> {
  const result = await loadDocument(documentId);
  return result.status === "found" ? result.document : null;
}

/**
 * A document the caller already holds, in the viewer's shape.
 *
 * The invoice list carries each invoice's full document text, so the viewer
 * has the bytes in hand before it asks for anything. This lets it render them
 * directly when the registry has no entry — a lookup miss can no longer cost a
 * reader the document that was sitting in front of them.
 */
export function storedFrom(doc: RawInvoiceDocument): StoredDocument {
  return toStored(doc);
}

/** Whether a document carries anything to show. */
export function hasContent(doc: Pick<RawInvoiceDocument, "text"> | null | undefined): boolean {
  return typeof doc?.text === "string" && doc.text.trim().length > 0;
}

function toStored(doc: RawInvoiceDocument): StoredDocument {
  return {
    id: doc.id,
    filename: doc.filename,
    blobRef: doc.sourceRef,
    storage: "demo",
    text: doc.text,
  };
}
