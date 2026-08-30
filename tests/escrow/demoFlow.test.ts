/**
 * The conditional-payment demo flow.
 *
 * The claim being tested is negative and specific: once a delivery document
 * says the goods have not arrived, no sequence of interface actions produces a
 * release. That is asserted here at the layer that decides which buttons exist,
 * so a regression shows up in CI rather than on stage.
 *
 * This is presentation, not enforcement. `escrow::release` re-derives every one
 * of these conditions on chain — move/payflow/tests/escrow_tests.move covers
 * that side. A bug here would show a button that the chain then refuses; a bug
 * there would move money. Both are tested, for different reasons.
 */

import { describe, expect, it } from "vitest";

import {
  advance,
  availableActions,
  canRelease,
  fundsAreLocked,
  initialState,
  InvalidTransition,
  proofSupportsConfirmation,
  stageAfterProof,
  type EscrowDemoState,
} from "../../lib/escrow/demoFlow";
import {
  proofCardRows,
  showsHeldNotice,
  showsReleaseControl,
  summariseSettlement,
  AI_CANNOT,
  RESPONSIBILITIES,
} from "../../lib/escrow/present";
import type { ShipmentAttestation, ShipmentProof } from "../../lib/oracle/shipment";

const NORTHWIND = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const KESTREL = "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308";
const NOW = 1_788_685_200_000;

function demoA(): EscrowDemoState {
  return initialState({
    invoiceNumber: "INV-2026-3501",
    amountCents: 480_000,
    recipient: NORTHWIND,
  });
}

function demoB(): EscrowDemoState {
  return initialState({
    invoiceNumber: "INV-2026-3502",
    amountCents: 400_000,
    recipient: KESTREL,
  });
}

function proof(overrides: Partial<ShipmentProof> = {}): ShipmentProof {
  return {
    invoiceNumber: "INV-2026-3501",
    shipmentId: "SHIP-3501",
    recipient: NORTHWIND,
    deliveryStatus: "DELIVERED",
    deliveredAt: "2026-09-01",
    carrier: "Demo Freight Services",
    sha256: "ab".repeat(32),
    blobId: "demo:abc",
    storage: "demo",
    filename: "delivery_proof_SHIP-3501.pdf",
    byteLength: 512,
    ...overrides,
  };
}

function attestation(overrides: Partial<ShipmentAttestation> = {}): ShipmentAttestation {
  return {
    attestationId: "0xatt",
    invoiceNumber: "INV-2026-3501",
    shipmentId: "SHIP-3501",
    confirmed: true,
    proofBlobId: "demo:abc",
    proofSha256: "ab".repeat(32),
    deliveredAtMs: NOW,
    oracleId: "demo_shipment_oracle",
    attestedBy: "0xoracle",
    attestedAtMs: NOW,
    expiresAtMs: NOW + 86_400_000,
    aiAssessment: null,
    ...overrides,
  };
}

const actionsOf = (state: EscrowDemoState) => availableActions(state).map((a) => a.action);

// --- Demo A -------------------------------------------------------------------

describe("Demo A — a confirmed shipment settles", () => {
  it("walks lock → proof → attest → release", () => {
    let state = demoA();
    expect(actionsOf(state)).toEqual(["START_CONDITIONAL_PAYMENT"]);
    expect(summariseSettlement(state).fundsLocked).toBe(false);

    state = advance({ state, action: "START_CONDITIONAL_PAYMENT" });
    expect(state.stage).toBe("ESCROWED");
    expect(actionsOf(state)).toEqual(["SUBMIT_PROOF"]);
    // The money has left the treasury and the supplier does not have it.
    expect(fundsAreLocked(state)).toBe(true);
    expect(summariseSettlement(state).headline).toMatch(/ESCROWED/);

    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    expect(state.stage).toBe("PROOF_SUBMITTED");
    expect(actionsOf(state)).toEqual(["ORACLE_CONFIRM"]);
    expect(fundsAreLocked(state)).toBe(true);

    state = advance({ state, action: "ORACLE_CONFIRM", attestation: attestation() });
    expect(state.stage).toBe("ATTESTED");
    expect(actionsOf(state)).toEqual(["RELEASE_ESCROW"]);
    expect(canRelease(state)).toBe(true);

    state = advance({ state, action: "RELEASE_ESCROW" });
    expect(state.stage).toBe("RELEASED");
    expect(actionsOf(state)).toEqual([]);
    expect(fundsAreLocked(state)).toBe(false);
    expect(summariseSettlement(state).headline).toBe("RELEASED");
    expect(summariseSettlement(state).detail).toContain("$4,800");
  });

  it("shows a complete proof card once the oracle has ruled", () => {
    let state = advance({ state: demoA(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    state = advance({ state, action: "ORACLE_CONFIRM", attestation: attestation() });

    const rows = Object.fromEntries(proofCardRows(state).map((r) => [r.label, r.value]));
    expect(rows.Invoice).toBe("INV-2026-3501");
    expect(rows.Shipment).toBe("SHIP-3501");
    expect(rows.Status).toBe("DELIVERED");
    expect(rows.Delivered).toBe("2026-09-01");
    expect(rows.Oracle).toBe("Demo Shipment Oracle");
    expect(rows.Attestation).toBe("CONFIRMED");
  });
});

// --- Demo B: the one that matters ---------------------------------------------

describe("Demo B — an unconfirmed shipment is never releasable", () => {
  it("goes straight to HELD when the document reports IN_TRANSIT", () => {
    let state = advance({ state: demoB(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({
      state,
      action: "SUBMIT_PROOF",
      proof: proof({
        invoiceNumber: "INV-2026-3502",
        shipmentId: "SHIP-3502",
        recipient: KESTREL,
        deliveryStatus: "IN_TRANSIT",
        deliveredAt: null,
      }),
    });

    expect(state.stage).toBe("HELD");
    // The requirement, stated exactly: no release control after a NOT
    // CONFIRMED proof.
    expect(actionsOf(state)).toEqual([]);
    expect(showsReleaseControl(state)).toBe(false);
    expect(showsHeldNotice(state)).toBe(true);
    expect(canRelease(state)).toBe(false);
    expect(fundsAreLocked(state)).toBe(true);
  });

  it("says the money is held rather than refused", () => {
    let state = advance({ state: demoB(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({
      state,
      action: "SUBMIT_PROOF",
      proof: proof({ invoiceNumber: "INV-2026-3502", deliveryStatus: "IN_TRANSIT", deliveredAt: null }),
    });

    const summary = summariseSettlement(state);
    expect(summary.headline).toBe("PAYMENT HELD");
    expect(summary.detail).toContain("$4,000");
    expect(summary.detail).toMatch(/supplier has not received the funds/i);
    expect(summary.detail).toMatch(/committed but not released/i);
    // Held is not rejected. Conflating them misrepresents the whole design.
    expect(summary.headline).not.toMatch(/reject/i);
    expect(summary.detail).not.toMatch(/reject/i);
  });

  it("shows WAITING and NONE on the proof card", () => {
    let state = advance({ state: demoB(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({
      state,
      action: "SUBMIT_PROOF",
      proof: proof({ invoiceNumber: "INV-2026-3502", deliveryStatus: "IN_TRANSIT", deliveredAt: null }),
    });

    const rows = Object.fromEntries(proofCardRows(state).map((r) => [r.label, r.value]));
    expect(rows.Status).toBe("NOT CONFIRMED");
    expect(rows.Oracle).toBe("WAITING");
    expect(rows.Attestation).toBe("NONE");
    expect(rows.Delivered).toBe("—");
  });

  it("refuses a release even if one is somehow requested", () => {
    let state = advance({ state: demoB(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({
      state,
      action: "SUBMIT_PROOF",
      proof: proof({ invoiceNumber: "INV-2026-3502", deliveryStatus: "IN_TRANSIT", deliveredAt: null }),
    });
    // A stale button, a replayed request, a hand-crafted POST.
    expect(() => advance({ state, action: "RELEASE_ESCROW" })).toThrow(InvalidTransition);
    expect(() => advance({ state, action: "ORACLE_CONFIRM" })).toThrow(InvalidTransition);
  });

  it("stays held for every non-delivered status", () => {
    for (const status of ["IN_TRANSIT", "FAILED", "UNKNOWN"] as const) {
      const p = proof({ deliveryStatus: status, deliveredAt: null });
      expect(proofSupportsConfirmation(p), status).toBe(false);
      expect(stageAfterProof(p), status).toBe("HELD");
    }
  });
});

// --- the security claims the page makes ---------------------------------------

describe("no interface path releases without a confirmed attestation", () => {
  it("refuses release when the attestation says not confirmed", () => {
    let state = advance({ state: demoA(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    // A document that reads DELIVERED, and an oracle that declined anyway —
    // it may have looked and found nothing.
    state = advance({
      state,
      action: "ORACLE_CONFIRM",
      attestation: attestation({ confirmed: false }),
    });

    expect(state.stage).toBe("HELD");
    expect(actionsOf(state)).toEqual([]);
    expect(canRelease(state)).toBe(false);
  });

  it("refuses release when the attestation is for another invoice", () => {
    let state = advance({ state: demoA(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    state = advance({
      state,
      action: "ORACLE_CONFIRM",
      attestation: attestation({ invoiceNumber: "INV-2026-9999" }),
    });

    expect(state.stage).toBe("HELD");
    expect(canRelease(state)).toBe(false);
  });

  it("never offers release before an attestation exists", () => {
    let state = demoA();
    expect(canRelease(state)).toBe(false);
    state = advance({ state, action: "START_CONDITIONAL_PAYMENT" });
    expect(canRelease(state)).toBe(false);
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    expect(canRelease(state)).toBe(false);
  });

  it("keeps the recipient fixed from lock to release", () => {
    let state = advance({ state: demoA(), action: "START_CONDITIONAL_PAYMENT" });
    const locked = state.recipient;
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof({ recipient: "0xdeadbeef" }) });
    state = advance({ state, action: "ORACLE_CONFIRM", attestation: attestation() });
    state = advance({ state, action: "RELEASE_ESCROW" });
    // Nothing downstream of the lock can move it, including a proof document
    // that names somewhere else.
    expect(state.recipient).toBe(locked);
    expect(state.recipient).toBe(NORTHWIND);
  });

  it("rejects out-of-order actions at every stage", () => {
    const state = demoA();
    for (const action of ["SUBMIT_PROOF", "ORACLE_CONFIRM", "RELEASE_ESCROW"] as const) {
      expect(() => advance({ state, action }), action).toThrow(InvalidTransition);
    }
  });

  it("cannot release twice", () => {
    let state = advance({ state: demoA(), action: "START_CONDITIONAL_PAYMENT" });
    state = advance({ state, action: "SUBMIT_PROOF", proof: proof() });
    state = advance({ state, action: "ORACLE_CONFIRM", attestation: attestation() });
    state = advance({ state, action: "RELEASE_ESCROW" });
    expect(() => advance({ state, action: "RELEASE_ESCROW" })).toThrow(InvalidTransition);
  });
});

describe("the page states the division of authority", () => {
  it("names four actors with four distinct questions", () => {
    expect(RESPONSIBILITIES.map((r) => r.actor)).toEqual(["AI", "Sui", "Oracle", "Escrow"]);
    expect(RESPONSIBILITIES.find((r) => r.actor === "AI")?.question).toBe("Should we pay?");
    expect(RESPONSIBILITIES.find((r) => r.actor === "Sui")?.question).toBe(
      "Is this payment authorized?",
    );
    expect(RESPONSIBILITIES.find((r) => r.actor === "Oracle")?.question).toMatch(
      /real-world condition/i,
    );
  });

  it("lists what the AI structurally cannot do", () => {
    const text = AI_CANNOT.join(" ");
    expect(text).toMatch(/recipient/);
    expect(text).toMatch(/amount/);
    expect(text).toMatch(/attestation/);
    expect(text).toMatch(/release/);
    expect(text).toMatch(/bypass/);
  });
});
