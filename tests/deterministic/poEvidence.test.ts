/**
 * The purchase-order comparison, and the claims it may not make.
 *
 * THE PROBLEM THIS COVERS: the page said "PO mismatch" and showed nothing
 * else — no PO number, no PO amount, no supplier, no difference. A reader had
 * to take the claim on trust, which makes it an assertion rather than evidence.
 *
 * Two properties are being protected. First, that the comparison is SHOWN:
 * both sides, field by field, with the exact difference. Second, and more
 * importantly, that nothing is called verified which was not — a PO that could
 * not be retrieved must never read as a match, and an invoice with no PO must
 * not grow a comparison that never happened.
 *
 * Every figure comes from `ValidationFacts`, computed by `validateInvoice`
 * against the purchase-order ledger. This module re-formats a comparison; it
 * does not perform one, and the tests at the end assert it enforces nothing.
 */

import { describe, expect, it } from "vitest";

import {
  describePoPolicy,
  evaluatePoEvidence,
  hasPoEvidence,
  type PoEvidenceInput,
} from "../../lib/deterministic/poEvidence";
import { blockingConditions } from "../../lib/ai/blockingConditions";
import { createDeterministicEngine } from "../../lib/ai/deterministicEngine";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { runScenario } from "../../lib/demo/runScenario";
import { scenarioById } from "../../lib/demo/scenarios";
import type { DeterministicAnalysis } from "../../lib/types";

/** A matching order: same supplier, same amount, same currency. */
function input(overrides: Partial<PoEvidenceInput> = {}): PoEvidenceInput {
  return {
    poNumber: "PO-2026-0530",
    invoiceSupplierName: "Northwind Components Ltd",
    invoiceAmountCents: 480_000,
    invoiceCurrency: "USD",
    lineItems: [{ description: "Powder coating line, phase 2", amountCents: 480_000 }],
    validation: {
      poFound: true,
      poAmountCents: 480_000,
      poDeltaCents: 0,
      poMatch: true,
      poCurrency: "USD",
      poDescription: "Powder coating line, phase 2",
      poIssuedAt: "2026-08-28",
      poSupplierId: "sup_northwind",
      poSupplierMatch: true,
    },
    ...overrides,
  };
}

// --- 1, 2: a matching purchase order ----------------------------------------

describe("a matching purchase order", () => {
  it("reports a match, with both documents shown", () => {
    const evidence = evaluatePoEvidence(input());

    expect(evidence.verdict).toBe("MATCH");
    expect(evidence.matched).toBe(true);
    expect(evidence.badge).toBe("PURCHASE ORDER MATCHES");
    expect(evidence.reason).toBeNull();
  });

  it("shows the comparison rather than only the conclusion", () => {
    // The whole point: a reader can check each field themselves.
    const rows = evaluatePoEvidence(input()).rows;
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));

    expect(byLabel.Amount.invoice).toBe("$4,800");
    expect(byLabel.Amount.purchaseOrder).toBe("$4,800");
    expect(byLabel["PO number"].purchaseOrder).toBe("PO-2026-0530");
    expect(byLabel.Currency.purchaseOrder).toBe("USD");
    expect(rows.every((row) => row.agrees === true)).toBe(true);
  });

  it("carries the ledger record the comparison ran against", () => {
    const evidence = evaluatePoEvidence(input());

    expect(evidence.orderDescription).toBe("Powder coating line, phase 2");
    expect(evidence.orderIssuedAt).toBe("2026-08-28");
  });
});

// --- 3, 4: a mismatched amount ----------------------------------------------

describe("a mismatched amount", () => {
  const mismatched = () =>
    input({
      invoiceAmountCents: 1_470_000,
      invoiceSupplierName: "ATLAS PRECISION WORKS",
      poNumber: "PO-2026-0502",
      lineItems: [
        { description: "Fixture plates and clamps", amountCents: 980_000 },
        { description: "Additional machining and expedite fee", amountCents: 490_000 },
      ],
      validation: {
        poFound: true,
        poAmountCents: 980_000,
        poDeltaCents: 490_000,
        poMatch: false,
        poCurrency: "USD",
        poDescription: "Fixture plates and clamps",
        poIssuedAt: "2026-08-21",
        poSupplierId: "sup_atlas",
        poSupplierMatch: true,
      },
    });

  it("reports a mismatch and never a match", () => {
    const evidence = evaluatePoEvidence(mismatched());

    expect(evidence.verdict).toBe("AMOUNT_MISMATCH");
    expect(evidence.matched).toBe(false);
    expect(evidence.badge).toBe("PURCHASE ORDER MISMATCH");
  });

  it("states the exact difference, in the reason and as a figure", () => {
    // The number a reader would otherwise have to compute themselves.
    const evidence = evaluatePoEvidence(mismatched());

    expect(evidence.reason).toBe(
      "Invoice amount $14,700 exceeds PO amount $9,800 by $4,900.",
    );
    expect(evidence.deltaCents).toBe(490_000);
    expect(evidence.deltaLabel).toBe("+$4,900");
  });

  it("marks the field that disagrees, and only that field", () => {
    const rows = evaluatePoEvidence(mismatched()).rows;
    const disagreeing = rows.filter((row) => row.agrees === false).map((row) => row.label);

    expect(disagreeing).toEqual(["Amount"]);
  });

  it("shows which billed line the order does not name", () => {
    // What makes the overage legible: the order covers one line, the invoice
    // adds another. A text comparison, and it authorises nothing.
    const items = evaluatePoEvidence(mismatched()).lineItems;

    expect(items).toEqual([
      {
        description: "Fixture plates and clamps",
        amountLabel: "$9,800",
        matchesOrderDescription: true,
      },
      {
        description: "Additional machining and expedite fee",
        amountLabel: "$4,900",
        matchesOrderDescription: false,
      },
    ]);
  });

  it("reports an under-billed invoice as a mismatch too", () => {
    const evidence = evaluatePoEvidence(
      input({
        invoiceAmountCents: 300_000,
        validation: { ...input().validation, poDeltaCents: -180_000, poMatch: false },
      }),
    );

    expect(evidence.matched).toBe(false);
    expect(evidence.reason).toContain("falls short of");
    expect(evidence.deltaLabel).toBe("−$1,800");
  });
});

// --- 5, 6, 7: what must never be claimed ------------------------------------

describe("claims that may not be made", () => {
  it("never reports a match when the PO could not be retrieved", () => {
    // A reference with no record behind it. Nothing was compared, so nothing
    // may read as verified.
    const evidence = evaluatePoEvidence(
      input({
        validation: {
          poFound: false,
          poAmountCents: null,
          poDeltaCents: null,
          poMatch: null,
          poCurrency: null,
          poDescription: null,
          poIssuedAt: null,
          poSupplierId: null,
          poSupplierMatch: null,
        },
      }),
    );

    expect(evidence.verdict).toBe("PO_UNAVAILABLE");
    expect(evidence.matched).toBe(false);
    expect(evidence.badge).not.toContain("MATCHES");
    expect(evidence.badge.toLowerCase()).not.toContain("verified");
  });

  it("states the unavailable case explicitly, as its own message", () => {
    const evidence = evaluatePoEvidence(
      input({ validation: { ...input().validation, poFound: false } }),
    );

    expect(evidence.headline).toBe("Purchase order not available for verification");
    expect(evidence.reason).toContain("could not be retrieved");
    // And it offers no comparison, because none was performed.
    expect(evidence.rows).toEqual([]);
  });

  it("shows no section at all for an invoice with no PO reference", () => {
    expect(hasPoEvidence(null)).toBe(false);
    expect(hasPoEvidence("")).toBe(false);
    expect(hasPoEvidence("   ")).toBe(false);
    expect(hasPoEvidence("PO-2026-0530")).toBe(true);

    const evidence = evaluatePoEvidence(input({ poNumber: null }));
    expect(evidence.verdict).toBe("NO_REFERENCE");
    expect(evidence.matched).toBe(false);
    expect(evidence.rows).toEqual([]);
    expect(evidence.lineItems).toEqual([]);
  });

  it("catches an order belonging to a different supplier", () => {
    // Checked before the amount: an order that is somebody else's is wrong
    // whatever it is worth.
    const evidence = evaluatePoEvidence(
      input({
        validation: { ...input().validation, poSupplierMatch: false, poSupplierId: "sup_atlas" },
      }),
    );

    expect(evidence.verdict).toBe("SUPPLIER_MISMATCH");
    expect(evidence.reason).toContain("sup_atlas");
    // The PO column shows the id rather than borrowing the invoice's name,
    // which would make the mismatch invisible.
    const supplier = evidence.rows.find((row) => row.label === "Supplier")!;
    expect(supplier.purchaseOrder).toBe("sup_atlas");
    expect(supplier.agrees).toBe(false);
  });
});

// --- 8, 9: the real rejected invoice, end to end ----------------------------

describe("the PO-mismatch invoice, through the real pipeline", () => {
  it("produces evidence that explains the escalation", async () => {
    const scenario = scenarioById("s7_po_mismatch");
    const analysis: Readonly<DeterministicAnalysis> = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const evidence = evaluatePoEvidence({
      poNumber: analysis.invoiceFacts.poNumber,
      invoiceSupplierName: analysis.invoiceFacts.supplierName,
      invoiceAmountCents: analysis.invoiceFacts.amountCents,
      invoiceCurrency: analysis.invoiceFacts.currency,
      lineItems: analysis.invoiceFacts.lineItems,
      validation: analysis.validationFacts,
    });

    // The complete story a reader should be able to follow.
    expect(evidence.verdict).toBe("AMOUNT_MISMATCH");
    expect(evidence.rows.find((r) => r.label === "Amount")!.invoice).toBe("$14,700");
    expect(evidence.rows.find((r) => r.label === "Amount")!.purchaseOrder).toBe("$9,800");
    expect(evidence.deltaLabel).toBe("+$4,900");
    expect(evidence.lineItems.filter((i) => !i.matchesOrderDescription)).toHaveLength(1);
  });

  it("makes the AI explanation reference the actual mismatch", async () => {
    // "The AI detected a mismatch" is not good enough, and stating that nothing
    // is suspicious over a recorded $4,900 overage is worse — the prose
    // contradicted the evidence displayed beside it.
    const run = await runScenario(
      scenarioById("s7_po_mismatch"),
      createDeterministicEngine("test"),
    );
    const decision = run.decision.decision;
    const prose = [decision.riskExplanation, decision.decisionExplanation, ...decision.reasons]
      .join(" ");

    expect(prose).toContain("$9,800");
    expect(prose).toContain("$4,900");
    expect(prose).toContain("PO-2026-0502");
    expect(decision.riskExplanation).not.toContain("Nothing about this invoice is suspicious");
    expect(decision.risk).not.toBe("LOW");
  });

  it("keeps saying nothing is suspicious when nothing IS", async () => {
    // The correction must not become a blanket warning on every invoice.
    const run = await runScenario(scenarioById("s1_normal"), createDeterministicEngine("test"));

    expect(run.decision.decision.risk).toBe("LOW");
    expect(run.analysis.riskEvidence.map((e) => e.code)).not.toContain("PO_AMOUNT_MISMATCH");
  });
});

// --- 10: evidence informs, policy enforces ----------------------------------

describe("PO evidence does not override deterministic policy", () => {
  it("is not a blocking condition", async () => {
    // The honest answer, and the one the panel states on screen: a PO overage
    // is evidence the model weighs, not a refusal. Claiming the guard blocks on
    // it would be a lie a reader could check.
    const scenario = scenarioById("s7_po_mismatch");
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    expect(analysis.validationFacts.poMatch).toBe(false);
    expect(blockingConditions(analysis)).toEqual([]);
  });

  it("says so, rather than claiming the guard refuses the payment", () => {
    const policy = describePoPolicy("AMOUNT_MISMATCH");

    expect(policy).toContain("not as a blocking condition");
    expect(policy).toContain("does not refuse the payment on its own");
  });

  it("does not change the recommendation for a mismatch", async () => {
    // The invoice escalates because it exceeds the agent's authority. The PO
    // overage informs the reasoning; it does not decide the action.
    const run = await runScenario(
      scenarioById("s7_po_mismatch"),
      createDeterministicEngine("test"),
    );

    expect(run.decision.decision.action).toBe("HUMAN_REVIEW");
    expect(run.finalOutcome).toBe("HUMAN_REVIEW");
  });
});
