/**
 * The oracle flow belongs to a CONDITION, not to two invoice numbers.
 *
 * INV-2026-3501 and INV-2026-3502 are the conditional invoices that happen to
 * exist today. They are demo DATA. If the rendering or state logic knows their
 * names, then the architecture does not generalise — a conditional invoice
 * created tomorrow would silently get no oracle section, no evidence, and no
 * explanation of why its money is sitting in escrow.
 *
 * So the tests below use invoice numbers that appear nowhere in the codebase
 * (INV-2026-3601, INV-2099-0001, ACME-42) and assert they behave identically.
 * The source-level checks then prove no rendering path can special-case a
 * number even if someone later tries.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateShipmentEvidence,
  shipmentEvidenceRows,
} from "../../lib/oracle/evidence";
import { conditionalInvoiceSet } from "../../lib/escrow/conditionalSet";
import { describeInvoiceStatus, describeRecommendation } from "../../lib/payments/invoiceStatus";
import type { ShipmentAttestation, ShipmentProof } from "../../lib/oracle/shipment";

/** Invoice numbers that exist nowhere in this repository. */
const FUTURE = "INV-2026-3601";
const STRANGER = "ACME-42";
const DIGEST = "f".repeat(64);

function proofFor(invoiceNumber: string, status: ShipmentProof["deliveryStatus"]): ShipmentProof {
  return {
    invoiceNumber,
    shipmentId: `SHP-${invoiceNumber}`,
    recipient: "0xsupplier",
    deliveryStatus: status,
    deliveredAt: status === "DELIVERED" ? "2026-09-04" : null,
    carrier: "Some Freight Co",
    sha256: DIGEST,
    blobId: "demo:blob",
    storage: "demo",
    filename: `delivery-${invoiceNumber}.json`,
    byteLength: 400,
  };
}

function attestationFor(invoiceNumber: string, confirmed: boolean): ShipmentAttestation {
  return {
    attestationId: "0xattestation",
    treasuryId: "0xtreasury",
    invoiceNumber,
    shipmentId: `SHP-${invoiceNumber}`,
    confirmed,
    proofBlobId: "demo:blob",
    proofSha256: DIGEST,
    deliveredAtMs: 1_787_900_000_000,
    oracleId: "demo_shipment_oracle",
    attestedBy: "0xoracle",
    attestedAtMs: 1_788_000_000_000,
    expiresAtMs: 1_790_000_000_000,
    aiAssessment: null,
  };
}

// --- C, D, G: the verdict is a function of state, for any invoice ------------

describe("the oracle verdict", () => {
  it("reads CONFIRMED for a confirmed shipment on ANY invoice", () => {
    for (const invoiceNumber of [FUTURE, STRANGER, "INV-2026-3501"]) {
      const evidence = evaluateShipmentEvidence({
        invoiceNumber,
        proof: proofFor(invoiceNumber, "DELIVERED"),
        attestation: attestationFor(invoiceNumber, true),
      });

      expect(evidence.confirmed, invoiceNumber).toBe(true);
      expect(evidence.verdict).toBe("CONFIRMED");
    }
  });

  it("reads NOT CONFIRMED with no attestation, on ANY invoice", () => {
    // The headline rule: a delivery document is not a confirmation.
    for (const invoiceNumber of [FUTURE, STRANGER, "INV-2026-3502"]) {
      const evidence = evaluateShipmentEvidence({
        invoiceNumber,
        proof: proofFor(invoiceNumber, "DELIVERED"),
        attestation: null,
      });

      expect(evidence.confirmed, invoiceNumber).toBe(false);
    }
  });

  it("reads NOT CONFIRMED when the oracle declined, on ANY invoice", () => {
    for (const invoiceNumber of [FUTURE, STRANGER]) {
      const evidence = evaluateShipmentEvidence({
        invoiceNumber,
        proof: proofFor(invoiceNumber, "IN_TRANSIT"),
        attestation: attestationFor(invoiceNumber, false),
      });

      expect(evidence.confirmed, invoiceNumber).toBe(false);
      expect(evidence.verdict).toBe("NOT_CONFIRMED");
    }
  });
});

// --- the rows, for a judge reading the panel ---------------------------------

describe("the evidence rows", () => {
  function rows(invoiceNumber: string, confirmed: boolean) {
    const entries = shipmentEvidenceRows({
      invoiceNumber,
      proof: proofFor(invoiceNumber, confirmed ? "DELIVERED" : "IN_TRANSIT"),
      attestation: confirmed ? attestationFor(invoiceNumber, true) : null,
      oracleName: "Demo Shipment Oracle",
      attestationId: confirmed ? "0xattestation" : null,
    });
    return Object.fromEntries(entries.map((row) => [row.label, row.value]));
  }

  it("shows the confirmed set for a confirmed shipment", () => {
    const shown = rows(FUTURE, true);

    expect(shown["Shipment proof"]).toBe(`SHP-${FUTURE}`);
    expect(shown["Shipment status"]).toBe("DELIVERED");
    expect(shown["Proof document"]).toContain(FUTURE);
    expect(shown["SHA-256"]).toBe(DIGEST);
    expect(shown["Oracle"]).toBe("Demo Shipment Oracle");
    expect(shown["Oracle status"]).toBe("CONFIRMED");
    expect(shown["Attestation"]).toBe("0xattestation");
  });

  it("shows the unconfirmed set for an unconfirmed shipment", () => {
    const shown = rows(FUTURE, false);

    expect(shown["Shipment proof"]).toBe(`SHP-${FUTURE}`);
    expect(shown["Shipment status"]).toBe("IN_TRANSIT");
    expect(shown["Proof document"]).toContain(FUTURE);
    expect(shown["Oracle"]).toBe("Demo Shipment Oracle");
    // WAITING, not NOT CONFIRMED: nothing has attested, so the oracle has not
    // declined anything. The two are different states and read differently.
    expect(shown["Oracle status"]).toBe("WAITING");
    expect(shown["Attestation"]).toBe("NONE");
    // No digest is offered where there is nothing to compare it to — printing
    // one beside WAITING invites the reader to assume it was checked.
    expect(shown["SHA-256"]).toBeUndefined();
  });

  it("says NOT CONFIRMED only when an attestation actually declined", () => {
    // The third state, and the one that must never be confused with WAITING.
    const entries = shipmentEvidenceRows({
      invoiceNumber: FUTURE,
      proof: proofFor(FUTURE, "DELIVERED"),
      attestation: attestationFor(FUTURE, false),
      oracleName: "Demo Shipment Oracle",
      attestationId: "0xattestation",
    });
    const shown = Object.fromEntries(entries.map((row) => [row.label, row.value]));

    expect(shown["Oracle status"]).toBe("NOT CONFIRMED");
    expect(shown["Attestation"]).toBe("0xattestation");
  });
});

// --- E, F, G: which invoices get the section at all --------------------------

describe("which invoices get the oracle section", () => {
  it("includes a brand-new invoice that has a shipment condition", () => {
    // G. Nothing local names this invoice; it has an escrow, so it is
    // conditional and gets the same treatment as the demo pair.
    const set = conditionalInvoiceSet(
      [],
      [{ invoiceNumber: FUTURE, amountCents: 210_000, status: "ESCROWED" }],
      new Set([FUTURE]),
    );

    expect(set.map((entry) => entry.invoiceNumber)).toEqual([FUTURE]);
  });

  it("excludes an invoice with no shipment condition", () => {
    // F. An ordinary invoice shows no oracle, no proof, no escrow condition.
    const set = conditionalInvoiceSet(
      [],
      [
        { invoiceNumber: "INV-2026-3455", amountCents: 300_000, status: "PAID" },
        { invoiceNumber: STRANGER, amountCents: 90_000, status: "PENDING" },
      ],
      new Set(),
    );

    expect(set).toEqual([]);
  });

  it("treats the demo pair by the same rule as everything else", () => {
    // H. Remove their escrows and their conditional status and they drop out,
    // exactly like any other invoice would. Nothing privileges them.
    const set = conditionalInvoiceSet(
      [],
      [
        { invoiceNumber: "INV-2026-3501", amountCents: 480_000, status: "PAID" },
        { invoiceNumber: "INV-2026-3502", amountCents: 400_000, status: "PENDING" },
      ],
      new Set(),
    );

    expect(set).toEqual([]);
  });
});

// --- A, B: the settlement wording -------------------------------------------

describe("settlement wording, for any invoice", () => {
  it("says Payment released and never Payment rejected", () => {
    // A. The released invoice, with the guard refusing a second payment.
    for (const invoiceNumber of [FUTURE, STRANGER, "INV-2026-3501"]) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome: "REJECTED",
        chainInvoiceStatus: "PAID",
        conditionStage: "RELEASED",
      });

      expect(status.label, invoiceNumber).toBe("Payment released");
      expect(status.label.toLowerCase()).not.toContain("reject");
    }
  });

  it("says Payment held for a locked escrow", () => {
    // B.
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "EXECUTED",
      chainInvoiceStatus: "ESCROWED",
      conditionStage: "HELD",
    });

    expect(status.label).toBe("Payment held");
  });

  it("re-words the AI's refusal on a settled invoice", () => {
    // "Payment rejected" is right before a payment and wrong after one.
    const settled = describeRecommendation({
      action: "REJECT",
      settled: true,
      defaultLabel: "Payment rejected",
    });

    expect(settled.label).toBe("Payment already settled");
    expect(settled.label.toLowerCase()).not.toContain("rejected");
    expect(settled.note).toContain("already been settled on chain");
    expect(settled.note).toContain("No new payment action is available");
  });

  it("does NOT headline a duplicate that nobody attempted", () => {
    // THE BUG: "Duplicate payment prevented" as the AI card's headline on a
    // settled invoice, beside "$4,800 released from escrow". It describes an
    // EVENT — someone tried to pay again and was stopped — and next to a
    // release it reads as though the money moved twice. No second payment was
    // ever initiated, so the phrase must not appear as the headline.
    for (const action of ["AUTO_PAY", "SCHEDULE", "HUMAN_REVIEW", "REJECT"] as const) {
      const settled = describeRecommendation({
        action,
        settled: true,
        defaultLabel: "Payment rejected",
      });

      expect(settled.label).toBe("Payment already settled");
      expect(settled.label.toLowerCase()).not.toContain("duplicate");
      // The guard's standing refusal survives — as secondary text.
      expect(settled.guardNote).toBe("The payment guard prevents a second payment.");
    }
  });

  it("says duplicate prevented ONLY for a second payment actually attempted", () => {
    // The one situation the phrase describes truthfully.
    const attempted = describeRecommendation({
      action: "REJECT",
      settled: true,
      defaultLabel: "Payment rejected",
      attemptedDuplicate: true,
    });

    expect(attempted.label).toBe("Duplicate payment prevented");
    expect(attempted.note).toContain("second payment was initiated");
    // And it says the FIRST payment was fine, which is the whole confusion.
    expect(attempted.note).toContain("original payment completed successfully");
  });

  it("keeps Payment rejected for an invoice that never paid", () => {
    const refused = describeRecommendation({
      action: "REJECT",
      settled: false,
      defaultLabel: "Payment rejected",
    });

    expect(refused.label).toBe("Payment rejected");
    expect(refused.note).toBeNull();
  });
});

// --- H: no special cases anywhere in the rendering or state path -------------

describe("no invoice is a special case", () => {
  /** Everything that renders or derives oracle/escrow state. */
  const SOURCES = [
    "components/payments/ShipmentEvidence.tsx",
    "components/payments/DecisionChain.tsx",
    "components/escrow/EscrowDemo.tsx",
    "components/escrow/ProofCard.tsx",
    "components/escrow/FlowDiagram.tsx",
    "components/common/StatusBadge.tsx",
    "components/hooks/useConditionState.ts",
    "components/hooks/useChainInvoice.ts",
    "app/(app)/escrow/page.tsx",
    "app/(app)/invoices/[id]/page.tsx",
    "app/api/escrow/state/route.ts",
    "app/api/invoices/route.ts",
    "lib/oracle/evidence.ts",
    "lib/escrow/conditionalSet.ts",
    "lib/payments/availableAction.ts",
    "lib/payments/invoiceStatus.ts",
  ];

  it("names no invoice number in any rendering or state module", () => {
    // The demo DATA may define the two invoices — lib/escrow/proofDocument.ts
    // and lib/escrow/conditionalInvoices.ts do, and should. Nothing that
    // decides what to draw or what state means may.
    for (const path of SOURCES) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toMatch(/INV-\d{4}-\d{4}/);
      expect(source, path).not.toMatch(/INV-[A-Z]{2}-\d+/);
    }
  });

  it("contains no equality test against an invoice number", () => {
    // The specific shape that would reintroduce the problem.
    for (const path of SOURCES) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toMatch(/invoiceNumber\s*===\s*["'`]INV/);
      expect(source, path).not.toMatch(/["'`]INV-\d/);
    }
  });
});
