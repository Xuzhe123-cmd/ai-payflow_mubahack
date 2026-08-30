/**
 * A document is not a verification.
 *
 * THE INVARIANT: nothing may be shown as oracle-confirmed because a proof file
 * exists. Confirmation requires an attestation recorded on chain that says
 * confirmed, names THIS invoice and THIS shipment, and carries the digest the
 * document actually hashes to. Each test below removes exactly one of those
 * clauses and asserts the verdict stops being CONFIRMED.
 *
 * These are the cases that would put "Verified by Oracle" over evidence that
 * verifies nothing, which is the specific claim this system must never make.
 */

import { describe, expect, it } from "vitest";

import { evaluateShipmentEvidence } from "../../lib/oracle/evidence";
import type { ShipmentAttestation, ShipmentProof } from "../../lib/oracle/shipment";

const INVOICE = "INV-2026-3501";
const DIGEST = "a".repeat(64);

const PROOF: ShipmentProof = {
  invoiceNumber: INVOICE,
  shipmentId: "SHP-88213",
  recipient: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  deliveryStatus: "DELIVERED",
  deliveredAt: "2026-09-04",
  carrier: "Northwind Freight",
  filename: "delivery-SHP-88213.json",
  sha256: DIGEST,
  storage: "demo",
  blobId: "demo:SHP-88213",
  byteLength: 512,
};

const ATTESTATION: ShipmentAttestation = {
  attestationId: "0xattestation",
  treasuryId: "0xtreasury",
  invoiceNumber: INVOICE,
  shipmentId: "SHP-88213",
  confirmed: true,
  proofBlobId: "demo:SHP-88213",
  proofSha256: DIGEST,
  deliveredAtMs: 1_787_900_000_000,
  oracleId: "demo_shipment_oracle",
  attestedBy: "0xoracle",
  attestedAtMs: 1_788_000_000_000,
  expiresAtMs: 1_790_000_000_000,
  aiAssessment: null,
};

describe("shipment evidence", () => {
  it("confirms only when every clause holds", () => {
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: ATTESTATION,
    });

    expect(result.verdict).toBe("CONFIRMED");
    expect(result.confirmed).toBe(true);
    expect(result.hashMatches).toBe(true);
  });

  it("does NOT confirm a proof that nothing has attested", () => {
    // The headline case. A delivery document saying DELIVERED proves only that
    // someone wrote DELIVERED in a document.
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: null,
    });

    expect(result.verdict).toBe("AWAITING_ATTESTATION");
    expect(result.confirmed).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  it("does NOT confirm when the document does not hash to the attested digest", () => {
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: { ...PROOF, sha256: "b".repeat(64) },
      attestation: ATTESTATION,
    });

    expect(result.verdict).toBe("HASH_MISMATCH");
    expect(result.confirmed).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  it("does NOT confirm an attestation about another invoice", () => {
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: { ...ATTESTATION, invoiceNumber: "INV-2026-3502" },
    });

    expect(result.verdict).toBe("SUBJECT_MISMATCH");
    expect(result.confirmed).toBe(false);
  });

  it("does NOT confirm an attestation about another shipment", () => {
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: { ...ATTESTATION, shipmentId: "SHP-00000" },
    });

    expect(result.verdict).toBe("SUBJECT_MISMATCH");
    expect(result.confirmed).toBe(false);
  });

  it("reports the oracle's refusal as a refusal, not as missing evidence", () => {
    // Demo B. The oracle read the document and declined to confirm — which is a
    // different thing from nobody having looked.
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: { ...PROOF, deliveryStatus: "IN_TRANSIT", deliveredAt: null },
      attestation: { ...ATTESTATION, confirmed: false },
    });

    expect(result.verdict).toBe("NOT_CONFIRMED");
    expect(result.confirmed).toBe(false);
    expect(result.hashMatches).toBe(true);
  });

  it("says so when there is no document at all", () => {
    const result = evaluateShipmentEvidence({
      invoiceNumber: INVOICE,
      proof: null,
      attestation: null,
    });

    expect(result.verdict).toBe("NO_PROOF");
    expect(result.confirmed).toBe(false);
  });

  it("never claims confirmation without an attestation, under any proof", () => {
    // Exhaustive over the document's own claims: none of them is sufficient.
    for (const status of ["DELIVERED", "IN_TRANSIT", "FAILED", "UNKNOWN"] as const) {
      const result = evaluateShipmentEvidence({
        invoiceNumber: INVOICE,
        proof: { ...PROOF, deliveryStatus: status },
        attestation: null,
      });
      expect(result.confirmed).toBe(false);
    }
  });
});
