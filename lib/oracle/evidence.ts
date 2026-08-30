/**
 * When evidence counts as an oracle confirmation, and when it does not.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a proof document is not a verification. A
 * PDF that says DELIVERED proves that someone wrote DELIVERED in a PDF. What
 * makes a shipment confirmed is an attestation recorded on chain by the oracle,
 * saying confirmed, about THIS invoice and THIS shipment, carrying the digest
 * the document actually hashes to. Every clause is load-bearing:
 *
 *   - no attestation      → the document has been read by nobody
 *   - confirmed = false   → the oracle looked and did not confirm
 *   - other invoice/ship  → an attestation about something else
 *   - digest disagrees    → the attested document is not the one on file
 *
 * Kept pure and in one place because two surfaces render it — the invoice
 * detail page and the escrow page — and if they derived it separately they
 * would eventually disagree, which for this claim means showing "Verified by
 * Oracle" over evidence that verifies nothing.
 *
 * Note what is NOT here: releasing funds. The oracle attests; Sui enforces.
 * This function decides what a screen may say, never what a payment may do.
 */

import type { ShipmentAttestation, ShipmentProof } from "./shipment";

export type EvidenceVerdict =
  /** No document has been submitted. */
  | "NO_PROOF"
  /** A document exists and nothing has attested to it. */
  | "AWAITING_ATTESTATION"
  /** Attested, and about a different invoice or a different shipment. */
  | "SUBJECT_MISMATCH"
  /** Attested about the right subject, and the digest does not match. */
  | "HASH_MISMATCH"
  /** The oracle read it and did not confirm the delivery. */
  | "NOT_CONFIRMED"
  /** Every clause satisfied. The only verdict that may be called verified. */
  | "CONFIRMED";

export interface EvidenceInput {
  invoiceNumber: string;
  proof: ShipmentProof | null;
  attestation: ShipmentAttestation | null;
}

export interface ShipmentEvidenceResult {
  verdict: EvidenceVerdict;
  /** The single question a UI should ask. Never widen this to a truthy check. */
  confirmed: boolean;
  /** True only when a digest comparison was possible AND agreed. */
  hashMatches: boolean;
  /** Plain sentence for the screen, saying which clause failed. */
  detail: string;
}

export function evaluateShipmentEvidence(input: EvidenceInput): ShipmentEvidenceResult {
  const { proof, attestation, invoiceNumber } = input;

  if (!proof) {
    return {
      verdict: "NO_PROOF",
      confirmed: false,
      hashMatches: false,
      detail: "No delivery document has been submitted.",
    };
  }

  if (!attestation) {
    return {
      verdict: "AWAITING_ATTESTATION",
      confirmed: false,
      hashMatches: false,
      detail:
        "A proof document exists and nothing has attested to it. Evidence on its own does not " +
        "confirm a shipment.",
    };
  }

  // Checked before the digest, because an attestation about another shipment is
  // wrong regardless of what it hashes.
  if (attestation.invoiceNumber !== invoiceNumber || attestation.shipmentId !== proof.shipmentId) {
    return {
      verdict: "SUBJECT_MISMATCH",
      confirmed: false,
      hashMatches: false,
      detail: "The attestation on chain refers to a different invoice or shipment.",
    };
  }

  const hashMatches = attestation.proofSha256 === proof.sha256;
  if (!hashMatches) {
    return {
      verdict: "HASH_MISMATCH",
      confirmed: false,
      hashMatches: false,
      detail:
        "The document on file does not hash to the digest the oracle attested. It is not the " +
        "document that was verified.",
    };
  }

  if (!attestation.confirmed) {
    return {
      verdict: "NOT_CONFIRMED",
      confirmed: false,
      hashMatches: true,
      detail: "The oracle read this document and did not confirm the delivery.",
    };
  }

  return {
    verdict: "CONFIRMED",
    confirmed: true,
    hashMatches: true,
    detail:
      "The oracle attested this exact document on chain, for this invoice and this shipment.",
  };
}
