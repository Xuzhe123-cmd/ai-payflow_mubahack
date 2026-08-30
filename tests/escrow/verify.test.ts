/**
 * The between-step verifications the Demo A runner halts on.
 *
 * These decide whether a real sequence of money-moving transactions continues.
 * The runner cannot be tested without a chain; these can, so the judgement they
 * encode is asserted here rather than discovered on stage.
 *
 * The property running through all of it: a field that could not be read must
 * FAIL. An escrow whose status is unknown is not a locked one, and an
 * attestation that could not be fetched is not a confirmed one.
 */

import { describe, expect, it } from "vitest";

import {
  verifyAttestation,
  verifyLockedEscrow,
  verifyReleasedEscrow,
  verifySupplierPaid,
  type ObservedAttestation,
  type ObservedEscrow,
} from "../../lib/escrow/verify";

const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const NORTHWIND = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const IMPOSTOR = `0x${"b4".repeat(32)}`;
const SHA = "a556583aab69811c6195b36d481cb857383952d8a691ba2b1f5bbbf1d2c56b9c";
const NOW = 1_788_685_200_000;

function escrow(overrides: Partial<ObservedEscrow> = {}): ObservedEscrow {
  return {
    objectId: "0xesc",
    treasuryId: TREASURY,
    invoiceNumber: "INV-2026-3501",
    recipient: NORTHWIND,
    status: "LOCKED",
    amountCents: 480_000,
    heldCents: 480_000,
    ...overrides,
  };
}

const expectedEscrow = {
  treasuryId: TREASURY,
  invoiceNumber: "INV-2026-3501",
  recipient: NORTHWIND,
  amountCents: 480_000,
};

function attestation(overrides: Partial<ObservedAttestation> = {}): ObservedAttestation {
  return {
    attestationId: "0xatt",
    treasuryId: TREASURY,
    invoiceNumber: "INV-2026-3501",
    shipmentId: "SHIP-3501",
    confirmed: true,
    proofSha256: SHA,
    expiresAtMs: NOW + 86_400_000,
    oracleId: "demo_shipment_oracle",
    ...overrides,
  };
}

const expectedAttestation = {
  treasuryId: TREASURY,
  invoiceNumber: "INV-2026-3501",
  shipmentId: "SHIP-3501",
  proofSha256: SHA,
  oracleId: "demo_shipment_oracle",
  nowMs: NOW,
};

describe("the escrow after a lock", () => {
  it("accepts the escrow Demo A should produce", () => {
    const v = verifyLockedEscrow(escrow(), expectedEscrow);
    expect(v.ok).toBe(true);
    expect(v.failure).toBeNull();
  });

  it("halts when nothing could be read", () => {
    const v = verifyLockedEscrow(null, expectedEscrow);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/nothing could be read/);
  });

  it("halts on any status other than LOCKED", () => {
    for (const status of ["RELEASED", "REFUNDED", "UNKNOWN"]) {
      expect(verifyLockedEscrow(escrow({ status }), expectedEscrow).ok, status).toBe(false);
    }
  });

  it("halts when the recipient is not the registered wallet", () => {
    const v = verifyLockedEscrow(escrow({ recipient: IMPOSTOR }), expectedEscrow);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/recipient/);
  });

  it("halts on the wrong invoice, treasury, or amount", () => {
    expect(verifyLockedEscrow(escrow({ invoiceNumber: "INV-9999" }), expectedEscrow).ok).toBe(false);
    expect(verifyLockedEscrow(escrow({ treasuryId: IMPOSTOR }), expectedEscrow).ok).toBe(false);
    expect(verifyLockedEscrow(escrow({ amountCents: 400_000 }), expectedEscrow).ok).toBe(false);
  });

  it("halts when the escrow records the amount but holds nothing", () => {
    // The two fields answer different questions, which is why both are checked.
    const v = verifyLockedEscrow(escrow({ heldCents: 0 }), expectedEscrow);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/funds actually held/);
  });

  it("tolerates address padding differences", () => {
    const padded = `0x${NORTHWIND.replace(/^0x/, "").toUpperCase()}`;
    expect(verifyLockedEscrow(escrow({ recipient: padded }), expectedEscrow).ok).toBe(true);
  });
});

describe("the attestation after the oracle attests", () => {
  it("accepts a confirmed, matching, unexpired attestation", () => {
    expect(verifyAttestation(attestation(), expectedAttestation).ok).toBe(true);
  });

  it("halts when nothing could be read", () => {
    expect(verifyAttestation(null, expectedAttestation).ok).toBe(false);
  });

  it("halts on an unconfirmed attestation", () => {
    const v = verifyAttestation(attestation({ confirmed: false }), expectedAttestation);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/confirmed/);
  });

  it("halts when the proof hash does not match the stored document", () => {
    // An attestation about some other document proves nothing about this one.
    const v = verifyAttestation(attestation({ proofSha256: "cd".repeat(32) }), expectedAttestation);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/proof hash/);
  });

  it("halts on the wrong invoice, shipment, treasury or oracle", () => {
    expect(verifyAttestation(attestation({ invoiceNumber: "INV-9999" }), expectedAttestation).ok).toBe(false);
    expect(verifyAttestation(attestation({ shipmentId: "SHIP-0000" }), expectedAttestation).ok).toBe(false);
    expect(verifyAttestation(attestation({ treasuryId: IMPOSTOR }), expectedAttestation).ok).toBe(false);
    expect(verifyAttestation(attestation({ oracleId: "other_oracle" }), expectedAttestation).ok).toBe(false);
  });

  it("halts when the treasury could not be read at all", () => {
    const v = verifyAttestation(attestation({ treasuryId: null }), expectedAttestation);
    expect(v.ok).toBe(false);
  });

  it("halts on an already-expired attestation", () => {
    const v = verifyAttestation(attestation({ expiresAtMs: NOW - 1 }), expectedAttestation);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/expired/);
  });
});

describe("the escrow after a release", () => {
  const before = escrow();

  it("accepts a clean release", () => {
    const v = verifyReleasedEscrow(before, escrow({ status: "RELEASED", heldCents: 0 }));
    expect(v.ok).toBe(true);
  });

  it("halts if the escrow is still holding funds", () => {
    const v = verifyReleasedEscrow(before, escrow({ status: "RELEASED" }));
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/now empty/);
  });

  it("halts if the status did not become RELEASED", () => {
    expect(verifyReleasedEscrow(before, escrow({ heldCents: 0 })).ok).toBe(false);
  });

  it("halts if anything but the status and balance moved", () => {
    // A release that also changed the recipient is a different and much worse
    // event than a release that failed.
    const mutations: Partial<ObservedEscrow>[] = [
      { recipient: IMPOSTOR },
      { amountCents: 999_999 },
      { invoiceNumber: "INV-9999" },
      { treasuryId: IMPOSTOR },
    ];
    for (const mutation of mutations) {
      const after = escrow({ status: "RELEASED", heldCents: 0, ...mutation });
      expect(verifyReleasedEscrow(before, after).ok, JSON.stringify(mutation)).toBe(false);
    }
  });

  it("halts when the escrow cannot be read back", () => {
    expect(verifyReleasedEscrow(before, null).ok).toBe(false);
  });
});

describe("the supplier balance", () => {
  it("accepts an increase of exactly the escrow amount", () => {
    const v = verifySupplierPaid({
      balanceBeforeCents: 0,
      balanceAfterCents: 480_000,
      amountCents: 480_000,
    });
    expect(v.ok).toBe(true);
  });

  it("measures a delta, so earlier holdings do not count", () => {
    // "has at least $4,800" would pass on money that arrived last week.
    const v = verifySupplierPaid({
      balanceBeforeCents: 480_000,
      balanceAfterCents: 480_000,
      amountCents: 480_000,
    });
    expect(v.ok).toBe(false);
  });

  it("still verifies when the supplier already held coins", () => {
    const v = verifySupplierPaid({
      balanceBeforeCents: 300_000,
      balanceAfterCents: 780_000,
      amountCents: 480_000,
    });
    expect(v.ok).toBe(true);
  });

  it("halts on a partial payment", () => {
    const v = verifySupplierPaid({
      balanceBeforeCents: 0,
      balanceAfterCents: 400_000,
      amountCents: 480_000,
    });
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/\$4,800/);
  });
});
