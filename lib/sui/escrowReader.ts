/**
 * Reading escrow and attestation state back off chain.
 *
 * Read-only, like the rest of lib/sui. Nothing here submits a transaction; the
 * interface shows what the chain already decided rather than deciding anything
 * of its own.
 *
 * These objects are addressed by id rather than discovered, because the escrows
 * and attestations that matter to a screen are the ones a specific invoice
 * produced, and the chain has no index from invoice number to escrow. The
 * manifest carries the ids once the demo has created them.
 */

import type { ChainQueries } from "./client";
import { ChainReadError } from "./chainReader";
import { extractFields, isRecord, readBool, readObjectId, readString, readU64 } from "./decode";
import { unitsToCents } from "./units";
import type { Cents } from "../types";
import type { EscrowState, ShipmentAttestation } from "../oracle/shipment";

/** Mirrors the status constants in payflow::escrow. */
const ESCROW_STATUS: Record<number, EscrowState> = {
  0: "LOCKED",
  1: "RELEASED",
  2: "REFUNDED",
};

export function escrowStatusFrom(value: number): EscrowState {
  return ESCROW_STATUS[value] ?? "NONE";
}

export interface ChainEscrow {
  objectId: string;
  treasuryId: string;
  invoiceNumber: string;
  supplierId: string;
  /** Fixed when the escrow was created. Release cannot target anything else. */
  recipient: string;
  amountCents: Cents;
  /** What the escrow still holds — zero once released or refunded. */
  heldCents: Cents;
  status: EscrowState;
  authority: "AGENT" | "HUMAN_APPROVAL";
  recommendationId: string;
  lockedAtMs: number;
  releasedAtMs: number;
  attestationId: string | null;
}

/** Reads one escrow. Null when the id holds no such object. */
export async function readEscrow(
  queries: ChainQueries,
  escrowId: string,
): Promise<ChainEscrow | null> {
  const raw = await queries.getObjectFields(escrowId);
  if (!isRecord(raw)) return null;

  const fields = extractFields(raw);
  const invoiceNumber = readString(fields, "invoice_number");
  if (!invoiceNumber) {
    throw new ChainReadError("the escrow", `${escrowId} has no invoice_number field.`);
  }

  const amount = readU64(fields, "amount") ?? BigInt(0);
  // `funds` is a Balance, which decodes the same way the treasury vault does.
  const held = readEscrowBalance(fields);

  return {
    objectId: escrowId,
    treasuryId: readString(fields, "treasury_id") ?? "",
    invoiceNumber,
    supplierId: readString(fields, "supplier_id") ?? "",
    recipient: readString(fields, "recipient") ?? "",
    amountCents: unitsToCents(amount),
    heldCents: unitsToCents(held),
    status: escrowStatusFrom(Number(readU64(fields, "status") ?? BigInt(0))),
    authority: Number(readU64(fields, "authority") ?? BigInt(0)) === 1 ? "HUMAN_APPROVAL" : "AGENT",
    recommendationId: readString(fields, "recommendation_id") ?? "",
    lockedAtMs: Number(readU64(fields, "locked_at_ms") ?? BigInt(0)),
    releasedAtMs: Number(readU64(fields, "released_at_ms") ?? BigInt(0)),
    attestationId: readOptionId(fields, "attestation_id"),
  };
}

/**
 * Reads one frozen attestation.
 *
 * `ai_assessment` is decoded and carried for display. Nothing downstream of
 * this branches on it — see lib/ai/proofAssessment.ts for why that separation
 * is the point rather than an omission.
 */
export async function readAttestation(
  queries: ChainQueries,
  attestationId: string,
): Promise<ShipmentAttestation | null> {
  const raw = await queries.getObjectFields(attestationId);
  if (!isRecord(raw)) return null;

  const fields = extractFields(raw);
  const invoiceNumber = readString(fields, "invoice_number");
  if (!invoiceNumber) {
    throw new ChainReadError("the attestation", `${attestationId} has no invoice_number field.`);
  }

  return {
    attestationId,
    treasuryId: readString(fields, "treasury_id"),
    invoiceNumber,
    shipmentId: readString(fields, "shipment_id") ?? "",
    confirmed: readBool(fields, "confirmed") ?? false,
    proofBlobId: readString(fields, "proof_blob_id") ?? "",
    proofSha256: readBytesHex(fields, "proof_sha256"),
    deliveredAtMs: Number(readU64(fields, "delivered_at_ms") ?? BigInt(0)),
    oracleId: readString(fields, "oracle_id") ?? "",
    attestedBy: readString(fields, "attested_by"),
    attestedAtMs: Number(readU64(fields, "attested_at_ms") ?? BigInt(0)),
    expiresAtMs: Number(readU64(fields, "expires_at_ms") ?? BigInt(0)),
    aiAssessment: readOptionString(fields, "ai_assessment"),
  };
}

/** An escrow together with whatever attestation it recorded, if any. */
export interface EscrowWithAttestation {
  escrow: ChainEscrow;
  attestation: ShipmentAttestation | null;
}

export async function readEscrowWithAttestation(
  queries: ChainQueries,
  escrowId: string,
): Promise<EscrowWithAttestation | null> {
  const escrow = await readEscrow(queries, escrowId);
  if (!escrow) return null;

  const attestation = escrow.attestationId
    ? await readAttestation(queries, escrow.attestationId)
    : null;

  return { escrow, attestation };
}

// --- decoding oddities ----------------------------------------------------------

/**
 * `Balance<T>` decodes either as a bare integer or as `{ value }`, depending on
 * which reader produced the JSON. The treasury reader has the same problem.
 */
function readEscrowBalance(fields: Record<string, unknown>): bigint {
  const direct = readU64(fields, "funds");
  if (direct !== null) return direct;

  const funds = fields.funds;
  if (isRecord(funds)) {
    const inner = extractFields(funds);
    return readU64(inner, "value") ?? BigInt(0);
  }
  return BigInt(0);
}

/** `Option<ID>` arrives as null, a bare id, or `{ vec: [...] }`. */
function readOptionId(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;

  if (isRecord(value)) {
    const vec = (value as Record<string, unknown>).vec;
    if (Array.isArray(vec)) {
      const first = vec[0];
      if (typeof first === "string") return first;
      if (isRecord(first)) return readObjectId(extractFields(first));
    }
    return readObjectId(extractFields(value));
  }
  return null;
}

function readOptionString(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;

  if (isRecord(value)) {
    const vec = (value as Record<string, unknown>).vec;
    if (Array.isArray(vec) && typeof vec[0] === "string") return vec[0];
  }
  return null;
}

/** `vector<u8>` arrives as a byte array or as a base64 string. */
function readBytesHex(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];

  if (Array.isArray(value)) {
    return value
      .map((byte) => Number(byte).toString(16).padStart(2, "0"))
      .join("");
  }

  if (typeof value === "string") {
    // Already hex.
    if (/^[0-9a-f]*$/i.test(value)) return value.toLowerCase();
    try {
      return Buffer.from(value, "base64").toString("hex");
    } catch {
      return "";
    }
  }

  return "";
}
