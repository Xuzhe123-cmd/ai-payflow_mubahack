/**
 * The evidence panel's rules, checked where a renderer cannot be run.
 *
 * There is no DOM test harness in this project, so the properties that matter
 * are asserted two ways: against the pure functions the panel renders from, and
 * against the panel's own source for the things only the source can prove — for
 * instance that it returns nothing at all for an invoice with no condition, and
 * that it does not decide "confirmed" for itself.
 *
 * The claim being protected is narrow and important: the shipment/oracle
 * section appears for a conditional invoice, never for an ordinary one, and it
 * calls nothing verified that the shared rule has not verified.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateShipmentEvidence } from "../../lib/oracle/evidence";
import { proofCardRows } from "../../lib/escrow/present";
import { availablePaymentAction } from "../../lib/payments/availableAction";
import { decideAutonomy } from "../../lib/payments/autonomy";
import type { EscrowDemoState } from "../../lib/escrow/demoFlow";
import type { ShipmentAttestation, ShipmentProof } from "../../lib/oracle/shipment";

const PANEL = readFileSync(
  resolve(process.cwd(), "components/payments/ShipmentEvidence.tsx"),
  "utf8",
);

const INVOICE = "INV-2026-3501";
const DIGEST = "c".repeat(64);

const PROOF: ShipmentProof = {
  invoiceNumber: INVOICE,
  shipmentId: "SHP-88213",
  recipient: "0xsupplier",
  deliveryStatus: "DELIVERED",
  deliveredAt: "2026-09-04",
  carrier: "Northwind Freight",
  sha256: DIGEST,
  blobId: "demo:SHP-88213",
  storage: "demo",
  filename: "delivery-SHP-88213.json",
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

function state(overrides: Partial<EscrowDemoState> = {}): EscrowDemoState {
  return {
    invoiceNumber: INVOICE,
    amountCents: 480_000,
    stage: "ATTESTED",
    recipient: "0xsupplier",
    proof: PROOF,
    attestation: ATTESTATION,
    escrowObjectId: "0xescrow",
    attestationObjectId: "0xattestation",
    transactions: [],
    ...overrides,
  };
}

describe("where the evidence section appears", () => {
  it("renders nothing for an invoice with no shipment condition", () => {
    // An ordinary invoice must not grow an oracle section. Inventing one would
    // suggest a verification that never happened.
    expect(PANEL).toContain("if (!resolved || !condition) return null;");
  });

  it("waits for the chain before deciding, rather than assuming no condition", () => {
    // `resolved` gates the render, so a slow read shows nothing instead of
    // briefly showing an ordinary invoice.
    expect(PANEL).toContain("!resolved");
  });

  it("keys off the condition, never off an invoice number", () => {
    // The conditional pair were created after the seed. Hard-coding them is how
    // the list lost them in the first place.
    expect(PANEL).not.toMatch(/INV-2026-\d{4}/);
  });

  it("does not decide 'confirmed' for itself", () => {
    // No inline `attestation.confirmed &&` chain: the shared rule decides, so
    // this panel and the escrow page cannot drift apart.
    expect(PANEL).toContain("evaluateShipmentEvidence");
    expect(PANEL).not.toMatch(/const oracleConfirmed =\s*\n?\s*attestation !== null/);
  });

  it("names the three layers separately", () => {
    // Evidence, attestation and enforcement are three different claims, and the
    // section exists to keep them apart.
    expect(PANEL).toContain("Shipment proof");
    expect(PANEL).toContain("Oracle attestation");
    expect(PANEL).toContain("Sui escrow");
  });

  it("says the oracle does not move funds", () => {
    expect(PANEL).toContain("does not\n              move funds");
  });
});

describe("what the evidence rows say", () => {
  it("marks the attestation row positive only when the shared rule confirms", () => {
    const rows = proofCardRows(state());
    const attestation = rows.find((row) => row.label === "Attestation");
    expect(attestation?.tone).toBe("positive");
    expect(rows.find((row) => row.label === "Hash matches")?.value).toBe("TRUE");
  });

  it("does not mark it positive when the digest disagrees", () => {
    // A document that is not the attested document. The row must not read as a
    // verification even though `confirmed` is true on the attestation itself.
    const rows = proofCardRows(state({ proof: { ...PROOF, sha256: "d".repeat(64) } }));
    expect(rows.find((row) => row.label === "Attestation")?.tone).toBe("warning");
    expect(rows.find((row) => row.label === "Hash matches")?.value).toBe("FALSE");
  });

  it("does not mark it positive when nothing has attested", () => {
    const rows = proofCardRows(state({ attestation: null, stage: "PROOF_SUBMITTED" }));
    expect(rows.find((row) => row.label === "Attestation")?.value).toBe("NONE");
    expect(rows.find((row) => row.label === "Attestation")?.tone).toBe("warning");
  });

  it("agrees with the invoice page's verdict on the same state", () => {
    // One rule, two surfaces. This is the assertion that keeps them the same.
    for (const candidate of [
      state(),
      state({ attestation: null }),
      state({ attestation: { ...ATTESTATION, confirmed: false } }),
      state({ proof: { ...PROOF, sha256: "e".repeat(64) } }),
    ]) {
      const verdict = evaluateShipmentEvidence({
        invoiceNumber: candidate.invoiceNumber,
        proof: candidate.proof,
        attestation: candidate.attestation,
      });
      const rows = proofCardRows(candidate);
      const row = rows.find((entry) => entry.label === "Attestation");
      if (!row) {
        expect(candidate.proof).toBeNull();
        continue;
      }
      expect(row.tone === "positive").toBe(verdict.confirmed);
    }
  });
});

describe("what the escrow box reports", () => {
  const autonomy = decideAutonomy({
    action: "AUTO_PAY",
    finalOutcome: "EXECUTED",
    hasPaymentRequest: true,
    enforcement: { outcome: "APPROVED" },
    conditional: true,
  });

  it("reports RELEASED as released, with no control", () => {
    const action = availablePaymentAction({
      autonomy,
      conditionStage: "RELEASED",
      fundsHeldCents: 0,
      amountCents: 480_000,
      runStatus: "ANALYZED",
      hasReceipt: false,
    });

    expect(action.status).toBe("Payment released");
    expect(action.action).toBe("NONE");
    expect(action.fundsLocked).toBe(false);
  });

  it("reports HELD as held, with the funds still locked", () => {
    const action = availablePaymentAction({
      autonomy,
      conditionStage: "HELD",
      fundsHeldCents: 400_000,
      amountCents: 400_000,
      runStatus: "ANALYZED",
      hasReceipt: false,
    });

    expect(action.status).toContain("held");
    expect(action.fundsLocked).toBe(true);
    expect(action.action).toBe("NONE");
    // Held is not rejected. Conflating the two misrepresents what escrow does.
    expect(action.status.toLowerCase()).not.toContain("reject");
  });
});
