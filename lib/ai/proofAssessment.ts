/**
 * What a model makes of a delivery document — advisory, and only advisory.
 *
 * The model reads the proof and reports what it found: which invoice the
 * document names, whether the recipient matches, whether it says delivered.
 * That is genuinely useful to whoever operates the oracle, and it is genuinely
 * not authority. The oracle attests; Move releases.
 *
 * The boundary is structural rather than a matter of discipline. Nothing this
 * module produces is an argument to `escrow::release` — that function reads
 * `confirmed` off a `ShipmentAttestation` and takes no other input about the
 * shipment at all. `ai_assessment` rides along on the attestation for the audit
 * trail and is never read by any function that moves money, which
 * move/payflow/tests/oracle_tests.move pins with an attestation carrying a
 * glowing assessment and `confirmed: false`.
 *
 * A failure here must therefore be uneventful: no assessment means the oracle
 * decides without one, which is exactly what it would do if no model existed.
 */

import type { ShipmentProofDocument } from "../oracle/shipment";

/** One thing that did not line up between the document and the invoice. */
export interface ProofConcern {
  code:
    | "INVOICE_NUMBER_MISMATCH"
    | "RECIPIENT_MISMATCH"
    | "NOT_DELIVERED"
    | "MISSING_DELIVERY_DATE"
    | "SHIPMENT_ID_ABSENT"
    | "UNREADABLE";
  detail: string;
}

export interface ProofAssessment {
  /** Everything the reader could pull out of the document. */
  extracted: Partial<ShipmentProofDocument>;
  /** Whether the document appears to be about the invoice it was filed under. */
  matchesInvoice: boolean;
  /** Whether it says, in as many words, that the goods arrived. */
  statesDelivered: boolean;
  concerns: ProofConcern[];
  /** 0..1, INFORMATIONAL. Nothing gates on it. */
  confidence: number;
  summary: string;
  source: "deterministic" | "model";
  modelId: string | null;
}

/**
 * The advisory line written onto the attestation.
 *
 * Prefixed so that anyone reading the chain — or a screen — can see at a glance
 * that this sentence came from a model and carries no authority.
 */
export function attestationNote(assessment: ProofAssessment): string {
  return `ADVISORY (${assessment.source}): ${assessment.summary}`;
}

export interface AssessProofInput {
  document: ShipmentProofDocument;
  /** The invoice the proof was filed against. */
  invoiceNumber: string;
  /** The wallet the registry holds for this supplier. */
  registeredRecipient: string;
}

/**
 * Deterministic assessment — field comparison, no model.
 *
 * This is the floor. It is what runs when no model is configured and what the
 * model's output is checked against, and it is entirely sufficient for the
 * oracle to act on: every question it answers is a string comparison.
 */
export function assessProof(input: AssessProofInput): ProofAssessment {
  const { document, invoiceNumber, registeredRecipient } = input;
  const concerns: ProofConcern[] = [];

  const matchesInvoice = document.invoiceNumber.trim() === invoiceNumber.trim();
  if (!matchesInvoice) {
    concerns.push({
      code: "INVOICE_NUMBER_MISMATCH",
      detail: `The document names ${document.invoiceNumber || "(nothing)"}, but it was filed against ${invoiceNumber}.`,
    });
  }

  const recipientMatches =
    document.recipient.trim().toLowerCase() === registeredRecipient.trim().toLowerCase();
  if (!recipientMatches) {
    concerns.push({
      code: "RECIPIENT_MISMATCH",
      detail:
        "The delivery recipient on the document is not the wallet registered for this supplier.",
    });
  }

  const statesDelivered = document.deliveryStatus === "DELIVERED";
  if (!statesDelivered) {
    concerns.push({
      code: "NOT_DELIVERED",
      detail: `The document reports status ${document.deliveryStatus}, not DELIVERED.`,
    });
  }

  if (!document.deliveredAt) {
    concerns.push({
      code: "MISSING_DELIVERY_DATE",
      detail: "No delivery date appears on the document.",
    });
  }

  if (!document.shipmentId.trim()) {
    concerns.push({
      code: "SHIPMENT_ID_ABSENT",
      detail: "No shipment or tracking reference appears on the document.",
    });
  }

  const clean = concerns.length === 0;
  return {
    extracted: { ...document },
    matchesInvoice,
    statesDelivered,
    concerns,
    // Every check here is exact, so there is nothing to be uncertain about.
    // A model-backed assessment would carry a genuine confidence; this does not
    // pretend to.
    confidence: clean ? 1 : 0,
    summary: clean
      ? `Document names ${invoiceNumber}, shipment ${document.shipmentId}, status DELIVERED${
          document.deliveredAt ? ` on ${document.deliveredAt}` : ""
        }.`
      : `${concerns.length} discrepanc${concerns.length === 1 ? "y" : "ies"}: ${concerns
          .map((concern) => concern.code)
          .join(", ")}.`,
    source: "deterministic",
    modelId: null,
  };
}

/**
 * Whether the assessment supports confirming the shipment.
 *
 * A RECOMMENDATION to whoever holds the oracle capability, and nothing more.
 * The oracle is free to attest against it in either direction — it may have
 * seen the pallet — and the chain neither knows nor cares what this returned.
 */
export function supportsConfirmation(assessment: ProofAssessment): boolean {
  return assessment.matchesInvoice && assessment.statesDelivered && assessment.concerns.length === 0;
}
