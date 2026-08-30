/**
 * Deriving the demo's stage from what the chain actually says.
 *
 * The page used to start at READY and advance on clicks, which meant the screen
 * was showing a story about the buttons rather than a report about the chain. A
 * reload would have told a different tale than the escrow. Now the stage is
 * computed from the escrow object, the attestation it links, and the invoice —
 * so RELEASED is on screen because the escrow says RELEASED, not because
 * somebody pressed something.
 *
 * Pure, so the mapping can be asserted without a network. Everything it needs
 * has already been read; nothing here fetches.
 */

import type { EscrowDemoStage } from "./demoFlow";
import type { ShipmentAttestation, ShipmentProof } from "../oracle/shipment";
import type { Cents } from "../types";

/** An escrow as `readEscrow` returns it, reduced to what the stage depends on. */
export interface ChainEscrowState {
  objectId: string;
  status: string;
  amountCents: Cents;
  heldCents: Cents;
  invoiceNumber: string;
  recipient: string;
  attestationId: string | null;
}

export interface StageInput {
  escrow: ChainEscrowState | null;
  attestation: ShipmentAttestation | null;
  /** The delivery document for this invoice, when one exists. */
  proof: ShipmentProof | null;
}

/**
 * Which stage the chain is in.
 *
 * The one judgement call is LOCKED with no confirmed attestation. That is HELD
 * rather than ESCROWED whenever the delivery document is already known and does
 * not report delivery — which is Demo B, and is the difference between "waiting
 * for evidence" and "the evidence arrived and did not support release".
 */
export function stageFromChain(input: StageInput): EscrowDemoStage {
  const { escrow, attestation, proof } = input;

  // Nothing locked yet: the payment is authorised and uncommitted.
  if (!escrow) return "READY";

  if (escrow.status === "RELEASED") return "RELEASED";

  // A refunded escrow is terminal and the funds went back to the treasury. It
  // cannot arise for either demo invoice — neither is ever refunded — and it is
  // reported as HELD only in the sense that the supplier was not paid. If
  // refunds join the demo this needs a stage of its own.
  if (escrow.status === "REFUNDED") return "HELD";

  const confirmed =
    attestation !== null &&
    attestation.confirmed &&
    attestation.invoiceNumber === escrow.invoiceNumber;

  if (confirmed) return "ATTESTED";

  // An attestation that exists and does NOT confirm is the oracle having looked
  // and said no. That is settled, not pending — offering "ask the oracle" again
  // would misread a negative answer as an absent one.
  const declined =
    attestation !== null &&
    !attestation.confirmed &&
    attestation.invoiceNumber === escrow.invoiceNumber;
  if (declined) return "HELD";

  // Locked, and no confirmation. Whether that is "waiting for a document" or
  // "the document says no" depends on the document.
  if (proof && proof.deliveryStatus !== "DELIVERED") return "HELD";
  if (proof) return "PROOF_SUBMITTED";
  return "ESCROWED";
}

/**
 * Whether the supplier has actually been paid out of THIS escrow.
 *
 * Deliberately not "the supplier's balance is above zero". That wallet may hold
 * coins from earlier demos — Northwind holds $3,000 from the A0 payment — and a
 * balance check would report Demo A as paid before it was. The escrow itself is
 * the authority: released, empty, and linked to the attestation that opened it.
 */
export function supplierWasPaid(escrow: ChainEscrowState | null): boolean {
  return escrow !== null && escrow.status === "RELEASED" && escrow.heldCents === 0;
}

/** What the escrow is still holding. Zero once released or refunded. */
export function fundsHeldCents(escrow: ChainEscrowState | null): Cents {
  return escrow?.heldCents ?? 0;
}

/**
 * Whether the proof document on file is the one the attestation covers.
 *
 * This is the evidence chain in one boolean: the document that was hashed is
 * the document the oracle attested, and that attestation is what the escrow
 * released against. A mismatch means the chain has been broken somewhere
 * between the file and the payment, and the interface should say so rather than
 * present the two side by side as though they agree.
 */
export function proofMatchesAttestation(
  proof: ShipmentProof | null,
  attestation: ShipmentAttestation | null,
): boolean | null {
  if (!proof || !attestation) return null;
  return proof.sha256.toLowerCase() === attestation.proofSha256.toLowerCase();
}
