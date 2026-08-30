/**
 * The shipment condition: the real-world fact a conditional invoice waits on.
 *
 * This is a SETTLEMENT condition, and the distinction from a blocking condition
 * is the most important thing in this file. `blockingConditions()` in lib/ai
 * answers "is this payment wrong?" — an unregistered supplier, a redirected
 * wallet — and forces REJECT. This answers "is this payment due yet?", and the
 * answer being no means ESCROW, never rejection. A payment held for a shipment
 * is a payment the system intends to make.
 *
 * Nothing here decides anything financial. The condition is reported; Move
 * enforces it, in payflow::escrow, where the funds actually sit.
 *
 * HONESTY: the attesting party in this build is a controlled hackathon oracle.
 * It is labelled "Demo Shipment Oracle" everywhere it is shown, and no part of
 * the interface may present it as a carrier integration.
 */

import type { IsoDate } from "../types";

export const SHIPMENT_ORACLE_LABEL = "Demo Shipment Oracle";
export const SHIPMENT_ORACLE_DETAIL =
  "A controlled hackathon oracle attesting shipment status from an uploaded delivery document. Not a carrier integration, and not connected to any logistics provider.";

/** The on-chain oracle_id the demo oracle signs its attestations with. */
export const DEMO_ORACLE_ID = "demo_shipment_oracle";

export type ShipmentState = "CONFIRMED" | "NOT_CONFIRMED" | "NOT_REQUIRED";

export type EscrowState = "NONE" | "LOCKED" | "RELEASED" | "REFUNDED";

/**
 * A delivery document, as the oracle reads it.
 *
 * Deliberately the minimum a person would need to decide the same question by
 * hand: which invoice, which shipment, who received it, whether it arrived, and
 * when. Everything else in a real delivery note is noise for this purpose.
 */
export interface ShipmentProofDocument {
  invoiceNumber: string;
  shipmentId: string;
  /** The wallet or party the goods were delivered to, as the document states. */
  recipient: string;
  deliveryStatus: "DELIVERED" | "IN_TRANSIT" | "FAILED" | "UNKNOWN";
  deliveredAt: IsoDate | null;
  carrier: string | null;
}

/** The document plus where its bytes live and what they hash to. */
export interface ShipmentProof extends ShipmentProofDocument {
  /** Lowercase hex SHA-256 of the document bytes. */
  sha256: string;
  blobId: string;
  storage: "walrus" | "demo";
  filename: string;
  byteLength: number;
}

/**
 * What the oracle asserted, mirroring `payflow::oracle::ShipmentAttestation`.
 *
 * `aiAssessment` is carried for display and audit and is explicitly not part of
 * the release decision — the Move function that moves money reads `confirmed`
 * and never touches this field.
 */
export interface ShipmentAttestation {
  attestationId: string | null;
  /** Which treasury the attesting capability was bound to. */
  treasuryId?: string | null;
  invoiceNumber: string;
  shipmentId: string;
  confirmed: boolean;
  proofBlobId: string;
  proofSha256: string;
  deliveredAtMs: number;
  oracleId: string;
  attestedBy: string | null;
  attestedAtMs: number;
  expiresAtMs: number;
  aiAssessment: string | null;
}

/** Everything the interface needs to describe one invoice's shipment condition. */
export interface ShipmentCondition {
  invoiceNumber: string;
  required: boolean;
  state: ShipmentState;
  escrow: EscrowState;
  amountCents: number;
  attestation: ShipmentAttestation | null;
  proof: ShipmentProof | null;
  sourceLabel: string;
  sourceDetail: string;
}

/** An invoice with no shipment requirement — the ordinary case. */
export function noShipmentCondition(
  invoiceNumber: string,
  amountCents: number,
): ShipmentCondition {
  return {
    invoiceNumber,
    required: false,
    state: "NOT_REQUIRED",
    escrow: "NONE",
    amountCents,
    attestation: null,
    proof: null,
    sourceLabel: SHIPMENT_ORACLE_LABEL,
    sourceDetail: SHIPMENT_ORACLE_DETAIL,
  };
}

/**
 * Whether an attestation would in fact open an escrow.
 *
 * Mirrors `payflow::escrow::release` exactly — same four conditions, same
 * order. It exists so a screen can say "releasable" using the rule the chain
 * enforces rather than a second opinion about it, and it is advisory: the chain
 * re-derives all of this when the release is actually attempted.
 */
export function isReleasable(
  condition: ShipmentCondition,
  nowMs: number,
): boolean {
  const att = condition.attestation;
  if (condition.escrow !== "LOCKED") return false;
  if (!att) return false;
  if (att.invoiceNumber !== condition.invoiceNumber) return false;
  if (!att.confirmed) return false;
  return nowMs <= att.expiresAtMs;
}

/** One line, in the vocabulary the demo uses on screen. */
export function describeShipment(condition: ShipmentCondition): string {
  if (!condition.required) return "No shipment condition on this invoice.";

  switch (condition.escrow) {
    case "RELEASED":
      return "Shipment confirmed and the escrow has been released to the supplier.";
    case "REFUNDED":
      return "The shipment was never confirmed, and the funds were returned to the treasury.";
    case "LOCKED":
      return condition.state === "CONFIRMED"
        ? "Shipment confirmed. The escrow can be released."
        : "Waiting for shipment confirmation. The funds are locked and the supplier cannot be paid.";
    default:
      return condition.state === "CONFIRMED"
        ? "Shipment confirmed."
        : "Shipment not confirmed.";
  }
}

/**
 * Builds the condition an invoice is in, from the proof and attestation known
 * for it. Pure: it reports, it does not fetch.
 */
export function buildShipmentCondition(input: {
  invoiceNumber: string;
  amountCents: number;
  required: boolean;
  escrow: EscrowState;
  attestation: ShipmentAttestation | null;
  proof: ShipmentProof | null;
}): ShipmentCondition {
  if (!input.required) return noShipmentCondition(input.invoiceNumber, input.amountCents);

  const attestation =
    input.attestation && input.attestation.invoiceNumber === input.invoiceNumber
      ? input.attestation
      : null;

  return {
    invoiceNumber: input.invoiceNumber,
    required: true,
    state: attestation?.confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
    escrow: input.escrow,
    amountCents: input.amountCents,
    attestation,
    proof: input.proof,
    sourceLabel: SHIPMENT_ORACLE_LABEL,
    sourceDetail: SHIPMENT_ORACLE_DETAIL,
  };
}
