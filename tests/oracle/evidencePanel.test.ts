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

import {
  chainSettlementSummary,
  evaluateShipmentEvidence,
  evidenceBadge,
  evidenceConclusion,
  oracleStatusWord,
} from "../../lib/oracle/evidence";
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

  it("names the layers separately", () => {
    // Evidence, verdict and enforcement are three different claims, and the
    // section exists to keep them apart.
    expect(PANEL).toContain("Shipment proof");
    expect(PANEL).toContain("Sui escrow condition");
    expect(PANEL).toContain("evidenceBadge");
  });

  it("keeps the oracle's evidence and the chain's settlement in separate blocks", () => {
    // The two questions that were being run together: what the oracle
    // established, and what Sui did with the money. A settled invoice reported
    // inside the evidence block is what produced "Discrepancy found" on an
    // invoice that had in fact been paid correctly.
    expect(PANEL).toContain("Real-world facts");
    expect(PANEL).toContain("Chain settlement");
    expect(PANEL).toContain("chainSettlementSummary");
  });

  it("states the verdict through the shared badge rule, never as verified on chain", () => {
    // The chain holds an escrow object. That is not evidence a lorry arrived,
    // and no badge on this panel may imply it is.
    expect(PANEL).toContain("evidenceBadge");
    expect(PANEL).not.toContain("Verified on chain");
    expect(PANEL).not.toContain("Verified by chain");
  });

  it("says the oracle does not move funds", () => {
    expect(PANEL.replace(/\s+/g, " ")).toContain("The oracle does not move funds.");
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

// --- evidence and settlement are two different questions ---------------------

describe("what the badge over the evidence may claim", () => {
  it("says ORACLE CONFIRMED only where the shared rule confirms", () => {
    expect(evidenceBadge("CONFIRMED")).toBe("ORACLE CONFIRMED");
  });

  it("says ORACLE WAITING where nothing has attested", () => {
    // Not a failure and not a refusal. The oracle has not spoken, and a proof
    // document sitting on file is not the oracle speaking.
    expect(evidenceBadge("NO_PROOF")).toBe("ORACLE WAITING");
    expect(evidenceBadge("AWAITING_ATTESTATION")).toBe("ORACLE WAITING");
    expect(oracleStatusWord("AWAITING_ATTESTATION")).toBe("WAITING");
  });

  it("says SHIPMENT NOT CONFIRMED where an attestation actually declined", () => {
    // A real, negative answer — different from silence, and worded differently.
    for (const verdict of ["NOT_CONFIRMED", "HASH_MISMATCH", "SUBJECT_MISMATCH"] as const) {
      expect(evidenceBadge(verdict)).toBe("SHIPMENT NOT CONFIRMED");
      expect(oracleStatusWord(verdict)).toBe("NOT CONFIRMED");
    }
  });

  it("never claims the chain verified the shipment", () => {
    // The chain can establish that an escrow exists, is LOCKED or RELEASED, and
    // that an attestation's digest matches the document. It cannot establish
    // that a delivery happened, so no badge here may say so.
    const badges = (["NO_PROOF", "AWAITING_ATTESTATION", "NOT_CONFIRMED", "HASH_MISMATCH",
      "SUBJECT_MISMATCH", "CONFIRMED"] as const).map(evidenceBadge);

    for (const badge of badges) {
      expect(badge.toLowerCase()).not.toContain("verified on chain");
      expect(badge.toLowerCase()).not.toContain("verified");
    }
  });
});

describe("what the evidence concludes", () => {
  it("ticks the whole chain for a confirmed, released shipment", () => {
    const conclusion = evidenceConclusion({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: ATTESTATION,
      released: true,
    });

    expect(conclusion.ok).toBe(true);
    expect(conclusion.headline).toBe("Shipment confirmed");
    expect(conclusion.checks.map((check) => check.label)).toEqual([
      "Proof hash matches attestation",
      "Shipment confirmed",
      "Escrow condition satisfied",
      "Payment released",
    ]);
    expect(conclusion.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports a proof with no attestation as pending, not as a discrepancy", () => {
    // A document exists and nothing has read it. That is waiting, and calling
    // it a mismatch would blame the evidence for the oracle's silence.
    const conclusion = evidenceConclusion({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: null,
      released: false,
    });

    expect(conclusion.ok).toBe(false);
    expect(conclusion.headline).toBe("Shipment confirmation pending");
    expect(conclusion.detail).toContain("Proof available — not yet confirmed by oracle");
    expect(conclusion.detail).toContain("No confirmed oracle attestation exists");
    expect(conclusion.headline.toLowerCase()).not.toContain("discrepan");
  });

  it("does not let a proof document alone imply the oracle verified it", () => {
    // The claim the whole panel exists to refuse.
    const conclusion = evidenceConclusion({
      invoiceNumber: INVOICE,
      proof: PROOF,
      attestation: null,
      released: false,
    });

    expect(conclusion.checks.some((check) => check.ok)).toBe(false);
    expect(conclusion.checks.map((check) => check.label)).toContain(
      "No confirmed oracle attestation exists",
    );
  });

  it("names the failing clause when an attestation declines", () => {
    const conclusion = evidenceConclusion({
      invoiceNumber: INVOICE,
      proof: { ...PROOF, sha256: "f".repeat(64) },
      attestation: ATTESTATION,
      released: false,
    });

    expect(conclusion.headline).toBe("Shipment not confirmed");
    expect(conclusion.checks[0].label).toBe("Proof hash does not match the attestation");
  });
});

describe("chain settlement, stated apart from the evidence", () => {
  it("reports a release as released, with the amount that moved", () => {
    const settlement = chainSettlementSummary({ released: true, amountLabel: "$4,800" });

    expect(settlement.headline).toBe("Payment released");
    expect(settlement.amountLabel).toBe("$4,800");
    expect(settlement.headline.toLowerCase()).not.toContain("discrepan");
    expect(settlement.headline.toLowerCase()).not.toContain("reject");
  });

  it("reports a hold as held, and says the supplier has not been paid", () => {
    // The distinction a held escrow must never blur: the money has left the
    // treasury AND the supplier does not have it.
    const settlement = chainSettlementSummary({ released: false, amountLabel: "$4,000" });

    expect(settlement.headline).toBe("Payment held in escrow");
    expect(settlement.detail).toBe("$4,000 remains locked. Supplier has not been paid.");
  });

  it("is derived from the escrow alone, never from the oracle's verdict", () => {
    // Same settlement input, and the summary does not take an evidence verdict
    // at all — which is what stops one from being read as the other.
    expect(chainSettlementSummary({ released: true, amountLabel: "$1" }).released).toBe(true);
    expect(chainSettlementSummary({ released: false, amountLabel: "$1" }).released).toBe(false);
  });
});
