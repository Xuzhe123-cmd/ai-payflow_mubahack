/**
 * The shipment proof documents the demo uses, and how they are hashed.
 *
 * These are delivery notes as text, in the same spirit as lib/demo/invoices.ts:
 * semi-structured, so extraction has real work to do, and hashed as bytes so
 * the digest recorded on chain is the digest of something that actually exists.
 *
 * HONESTY: these are demonstration documents. Nothing here came from a carrier,
 * and no part of the interface may suggest otherwise — see PROOF_DISCLAIMER,
 * which is rendered wherever a proof is shown.
 */

import { createHash } from "node:crypto";

import type { ShipmentProofDocument } from "../oracle/shipment";

export const PROOF_DISCLAIMER = "Demo evidence — not a carrier API integration";

export interface DemoProof {
  /** The invoice this document was filed against. */
  invoiceNumber: string;
  filename: string;
  contentType: string;
  /** The document body, exactly as hashed. */
  text: string;
  /** What a reader extracts from it. */
  document: ShipmentProofDocument;
}

const NORTHWIND_WALLET =
  "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const KESTREL_WALLET =
  "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308";

/** Demo A — the goods arrived, and the document says so. */
export const PROOF_CONFIRMED: DemoProof = {
  invoiceNumber: "INV-2026-3501",
  filename: "delivery_proof_SHIP-3501.pdf",
  contentType: "application/pdf",
  text: `DELIVERY CONFIRMATION

Shipment Reference:  SHIP-3501
Invoice Number:      INV-2026-3501
Carrier:             Demo Freight Services
Consignee Wallet:    ${NORTHWIND_WALLET}

Delivery Status:     DELIVERED
Delivered At:        2026-09-01 14:32 UTC
Received By:         M. Halloway, goods inward

Items:               Powder coating line, phase 2 — 4 pallets
Condition On Arrival: Accepted, no damage recorded

This document is demonstration evidence produced for the AI PayFlow
hackathon build. It is not issued by a carrier.`,
  document: {
    invoiceNumber: "INV-2026-3501",
    shipmentId: "SHIP-3501",
    recipient: NORTHWIND_WALLET,
    deliveryStatus: "DELIVERED",
    deliveredAt: "2026-09-01",
    carrier: "Demo Freight Services",
  },
};

/** Demo B — the shipment is still moving, and the document says that too. */
export const PROOF_UNCONFIRMED: DemoProof = {
  invoiceNumber: "INV-2026-3502",
  filename: "shipment_status_SHIP-3502.pdf",
  contentType: "application/pdf",
  text: `SHIPMENT STATUS REPORT

Shipment Reference:  SHIP-3502
Invoice Number:      INV-2026-3502
Carrier:             Demo Freight Services
Consignee Wallet:    ${KESTREL_WALLET}

Delivery Status:     IN_TRANSIT
Last Scan:           2026-09-04 08:15 UTC, Hamburg consolidation
Estimated Delivery:  not yet scheduled

Items:               Q3 freight and customs handling
Notes:               Customs hold released; awaiting onward carrier.

No delivery has taken place. This document is demonstration evidence
produced for the AI PayFlow hackathon build. It is not issued by a carrier.`,
  document: {
    invoiceNumber: "INV-2026-3502",
    shipmentId: "SHIP-3502",
    recipient: KESTREL_WALLET,
    deliveryStatus: "IN_TRANSIT",
    deliveredAt: null,
    carrier: "Demo Freight Services",
  },
};

export const DEMO_PROOFS: Record<string, DemoProof> = {
  "INV-2026-3501": PROOF_CONFIRMED,
  "INV-2026-3502": PROOF_UNCONFIRMED,
};

/** The bytes that get hashed and stored. */
export function proofBytes(proof: DemoProof): Uint8Array {
  return new TextEncoder().encode(proof.text);
}

/**
 * SHA-256 of the document, lowercase hex.
 *
 * Computed from the text rather than stored as a constant, so the digest and
 * the document cannot drift apart — editing the note changes the hash, which is
 * the property that makes the hash worth recording at all.
 */
export function proofSha256(proof: DemoProof): string {
  return createHash("sha256").update(proofBytes(proof)).digest("hex");
}

export function proofFor(invoiceNumber: string): DemoProof | null {
  return DEMO_PROOFS[invoiceNumber] ?? null;
}
