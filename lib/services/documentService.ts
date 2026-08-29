/**
 * Document service.
 *
 * SWAP POINT — Walrus.
 *   getDocument() becomes a read of the blob referenced by the invoice, and
 *   sourceRef becomes a Walrus blob id instead of an email message id.
 * The viewer component receives text either way.
 */

import type { RawInvoiceDocument } from "../types";
import { DEMO_DOCUMENTS } from "../demo/invoices";

const BY_ID = new Map<string, RawInvoiceDocument>(
  Object.values(DEMO_DOCUMENTS).map((doc) => [doc.id, doc]),
);

export interface StoredDocument {
  id: string;
  filename: string;
  /** Where the bytes live. A Walrus blob id once Walrus is wired in. */
  blobRef: string;
  storage: "demo" | "walrus";
  text: string;
}

export async function getDocument(documentId: string): Promise<StoredDocument | null> {
  const doc = BY_ID.get(documentId);
  if (!doc) return null;
  return {
    id: doc.id,
    filename: doc.filename,
    blobRef: doc.sourceRef,
    storage: "demo",
    text: doc.text,
  };
}
