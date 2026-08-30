/**
 * What the interface may offer, given what the chain actually says.
 *
 * The page used to start at READY and advance on clicks, which made the screen
 * a story about the buttons rather than a report about the chain — a reload
 * would have contradicted the escrow. These tests pin the replacement: the
 * stage is derived from the escrow object, and the available actions follow
 * from the stage.
 *
 * The security-shaped assertions are the negative ones. A released escrow must
 * offer nothing, and a locked-but-unattested escrow must offer no release —
 * not a disabled release, none at all.
 */

import { describe, expect, it } from "vitest";

import {
  fundsHeldCents,
  proofMatchesAttestation,
  stageFromChain,
  supplierWasPaid,
  type ChainEscrowState,
} from "../../lib/escrow/chainStage";
import { availableActions, canRelease, type EscrowDemoState } from "../../lib/escrow/demoFlow";
import { summariseSettlement, proofCardRows } from "../../lib/escrow/present";
import { PROOF_CONFIRMED, PROOF_UNCONFIRMED, proofSha256 } from "../../lib/escrow/proofDocument";
import type { ShipmentAttestation, ShipmentProof } from "../../lib/oracle/shipment";

/** The two real testnet escrows, as the chain reports them. */
const DEMO_A_ESCROW: ChainEscrowState = {
  objectId: "0xfc2955a1367bf7663ef1a0dde4b02ea0f1ea6e80530af3ab7d833ebdca1747f3",
  status: "RELEASED",
  amountCents: 480_000,
  heldCents: 0,
  invoiceNumber: "INV-2026-3501",
  recipient: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  attestationId: "0xe6f816e25ace7fe8589d69dc563c101022d51bef9cd4658552ecbc4cc83f367f",
};

const DEMO_B_ESCROW: ChainEscrowState = {
  objectId: "0x02dec759adcf39474a662284cae71740705e611085faa0ee961540ed7000f159",
  status: "LOCKED",
  amountCents: 400_000,
  heldCents: 400_000,
  invoiceNumber: "INV-2026-3502",
  recipient: "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308",
  attestationId: null,
};

function proofOf(source: typeof PROOF_CONFIRMED): ShipmentProof {
  return {
    ...source.document,
    sha256: proofSha256(source),
    blobId: "demo:x",
    storage: "demo",
    filename: source.filename,
    byteLength: 512,
  };
}

const PROOF_A = proofOf(PROOF_CONFIRMED);
const PROOF_B = proofOf(PROOF_UNCONFIRMED);

const ATTESTATION_A: ShipmentAttestation = {
  attestationId: DEMO_A_ESCROW.attestationId,
  treasuryId: "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a",
  invoiceNumber: "INV-2026-3501",
  shipmentId: "SHIP-3501",
  confirmed: true,
  proofBlobId: "demo:x",
  proofSha256: PROOF_A.sha256,
  deliveredAtMs: 0,
  oracleId: "demo_shipment_oracle",
  attestedBy: "0xoracle",
  attestedAtMs: 0,
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  aiAssessment: null,
};

function stateOf(
  escrow: ChainEscrowState | null,
  attestation: ShipmentAttestation | null,
  proof: ShipmentProof | null,
): EscrowDemoState {
  return {
    invoiceNumber: escrow?.invoiceNumber ?? "INV-2026-3501",
    amountCents: escrow?.amountCents ?? 480_000,
    stage: stageFromChain({ escrow, attestation, proof }),
    recipient: escrow?.recipient ?? "",
    proof,
    attestation,
    escrowObjectId: escrow?.objectId ?? null,
    attestationObjectId: escrow?.attestationId ?? null,
    transactions: [],
  };
}

describe("Demo A reads RELEASED from the chain", () => {
  const state = stateOf(DEMO_A_ESCROW, ATTESTATION_A, PROOF_A);

  it("derives RELEASED from the escrow, not from a click", () => {
    expect(state.stage).toBe("RELEASED");
  });

  it("reports the supplier as paid and the escrow as empty", () => {
    expect(supplierWasPaid(DEMO_A_ESCROW)).toBe(true);
    expect(fundsHeldCents(DEMO_A_ESCROW)).toBe(0);
    expect(summariseSettlement(state).headline).toBe("RELEASED");
    expect(summariseSettlement(state).fundsLocked).toBe(false);
  });

  it("offers NO actions once settled — including Execute Payment", () => {
    expect(availableActions(state)).toEqual([]);
    expect(canRelease(state)).toBe(false);
  });

  it("shows the confirmed proof card", () => {
    const rows = Object.fromEntries(proofCardRows(state).map((r) => [r.label, r.value]));
    expect(rows.Shipment).toBe("SHIP-3501");
    expect(rows.Status).toBe("DELIVERED");
    expect(rows.Delivered).toBe("2026-09-01");
    expect(rows.Oracle).toBe("Demo Shipment Oracle");
    expect(rows.Attestation).toBe("CONFIRMED");
  });

  it("links the document to the attestation by hash", () => {
    // Proof document → SHA-256 → attestation → release, as one verifiable chain.
    expect(proofMatchesAttestation(PROOF_A, ATTESTATION_A)).toBe(true);
    expect(ATTESTATION_A.proofSha256).toBe(
      "a556583aab69811c6195b36d481cb857383952d8a691ba2b1f5bbbf1d2c56b9c",
    );
  });

  it("notices if the document and the attestation disagree", () => {
    const tampered = { ...ATTESTATION_A, proofSha256: "cd".repeat(32) };
    expect(proofMatchesAttestation(PROOF_A, tampered)).toBe(false);
  });
});

describe("Demo B reads LOCKED from the chain", () => {
  const state = stateOf(DEMO_B_ESCROW, null, PROOF_B);

  it("derives HELD, not READY and not REJECTED", () => {
    expect(state.stage).toBe("HELD");
  });

  it("shows no attestation", () => {
    expect(DEMO_B_ESCROW.attestationId).toBeNull();
    expect(state.attestation).toBeNull();
    const rows = Object.fromEntries(proofCardRows(state).map((r) => [r.label, r.value]));
    expect(rows.Shipment).toBe("SHIP-3502");
    expect(rows.Status).toBe("NOT CONFIRMED");
    expect(rows.Oracle).toBe("WAITING");
    expect(rows.Attestation).toBe("NONE");
  });

  it("offers NO release control at all", () => {
    // Not disabled — absent.
    expect(availableActions(state)).toEqual([]);
    expect(canRelease(state)).toBe(false);
  });

  it("keeps the funds locked and the supplier unpaid", () => {
    expect(fundsHeldCents(DEMO_B_ESCROW)).toBe(400_000);
    expect(supplierWasPaid(DEMO_B_ESCROW)).toBe(false);
    const summary = summariseSettlement(state);
    expect(summary.headline).toBe("PAYMENT HELD");
    expect(summary.fundsLocked).toBe(true);
  });

  it("never says the supplier was paid, or that the payment failed", () => {
    const summary = summariseSettlement(state);
    const text = `${summary.headline} ${summary.detail}`;
    expect(text).toMatch(/supplier has not received the funds/i);
    // The three words this payment must never be described with.
    expect(text).not.toMatch(/\bfailed\b/i);
    expect(text).not.toMatch(/\brejected\b/i);
    expect(text).not.toMatch(/human review/i);
    // And it must not read as settled.
    expect(text).not.toMatch(/\bpaid to\b|\breleased to\b/i);
  });

  it("states the sentence the demo turns on", () => {
    const summary = summariseSettlement(state);
    expect(summary.detail).toMatch(/committed but not released until the real-world condition/i);
  });
});

describe("the stage follows the chain in every case", () => {
  it("is READY when no escrow exists", () => {
    expect(stageFromChain({ escrow: null, attestation: null, proof: PROOF_A })).toBe("READY");
  });

  it("is ESCROWED when locked with no proof yet", () => {
    expect(stageFromChain({ escrow: DEMO_B_ESCROW, attestation: null, proof: null })).toBe(
      "ESCROWED",
    );
  });

  it("is ATTESTED when locked with a confirmed attestation", () => {
    const locked = { ...DEMO_A_ESCROW, status: "LOCKED", heldCents: 480_000 };
    expect(stageFromChain({ escrow: locked, attestation: ATTESTATION_A, proof: PROOF_A })).toBe(
      "ATTESTED",
    );
  });

  it("allows Release only from ATTESTED", () => {
    const locked = { ...DEMO_A_ESCROW, status: "LOCKED", heldCents: 480_000 };
    const state = stateOf(locked, ATTESTATION_A, PROOF_A);
    expect(state.stage).toBe("ATTESTED");
    expect(availableActions(state).map((a) => a.action)).toEqual(["RELEASE_ESCROW"]);
    expect(canRelease(state)).toBe(true);
  });

  it("refuses Release when the attestation is for another invoice", () => {
    const locked = { ...DEMO_A_ESCROW, status: "LOCKED", heldCents: 480_000 };
    const wrong = { ...ATTESTATION_A, invoiceNumber: "INV-2026-9999" };
    expect(stageFromChain({ escrow: locked, attestation: wrong, proof: PROOF_A })).not.toBe(
      "ATTESTED",
    );
  });

  it("refuses Release when the attestation is not confirmed", () => {
    const locked = { ...DEMO_A_ESCROW, status: "LOCKED", heldCents: 480_000 };
    const declined = { ...ATTESTATION_A, confirmed: false };
    const state = stateOf(locked, declined, PROOF_A);
    expect(canRelease(state)).toBe(false);
    expect(availableActions(state)).toEqual([]);
  });

  it("treats a refunded escrow as terminal and unpaid", () => {
    const refunded = { ...DEMO_B_ESCROW, status: "REFUNDED", heldCents: 0 };
    expect(stageFromChain({ escrow: refunded, attestation: null, proof: PROOF_B })).toBe("HELD");
    expect(supplierWasPaid(refunded)).toBe(false);
  });
});
