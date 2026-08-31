/**
 * The duplicate check, and the sentence it is allowed to write.
 *
 * THE CONTRADICTION THIS PREVENTS: on INV-2026-3501 the validation card read
 *
 *   ✕ No duplicate detected
 *     Already settled as payment chain_0x927e138e…
 *
 * Two statements denying each other, with a red cross beside the true one. The
 * label was a constant describing the CHECK; the detail described the FINDING;
 * only the detail ever moved.
 *
 * The distinction that has to survive, and why this is more than a relabel:
 *
 *   the INVOICE is legitimate            it is the original, and it was paid
 *   a NEW PAYMENT would be a duplicate   which is why the guard refuses one
 *
 * The chain state is correct and untouched. Only the sentence changes.
 */

import { describe, expect, it } from "vitest";

import { describeDuplicateCheck } from "../../lib/payments/invoiceStatus";
import { buildRiskEvidence } from "../../lib/deterministic/buildRiskEvidence";
import { blockingConditions } from "../../lib/ai/blockingConditions";
import {
  createDeterministicEngine,
  decideDeterministically,
} from "../../lib/ai/deterministicEngine";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { runScenario } from "../../lib/demo/runScenario";
import { scenarioById } from "../../lib/demo/scenarios";
import type { DeterministicAnalysis, SupplierFacts, ValidationFacts } from "../../lib/types";

// --- 1: an invoice that has never been settled ------------------------------

describe("an invoice with no prior settlement", () => {
  const check = describeDuplicateCheck({
    invoiceNumber: "INV-2026-3468",
    alreadySettled: false,
    settledByPaymentId: null,
  });

  it("passes the check and says so", () => {
    expect(check.passed).toBe(true);
    expect(check.label).toBe("No duplicate detected");
    expect(check.detail).toBe("No previous settlement found for this invoice.");
  });

  it("offers no settlement reference and no prevention note", () => {
    expect(check.settlementReference).toBeNull();
    expect(check.preventionNote).toBeNull();
  });
});

// --- 2, 4: an invoice that IS already settled -------------------------------

describe("an invoice already settled on chain", () => {
  const check = describeDuplicateCheck({
    invoiceNumber: "INV-2026-3501",
    alreadySettled: true,
    settledByPaymentId: "chain_0x927e138e",
  });

  it("says already settled, not 'no duplicate detected'", () => {
    // The exact contradiction, asserted directly.
    expect(check.label).toBe("Already settled");
    expect(check.label).not.toBe("No duplicate detected");
    expect(check.passed).toBe(false);
  });

  it("states the settlement plainly and carries the reference", () => {
    expect(check.detail).toBe("INV-2026-3501 has already been paid on chain.");
    expect(check.settlementReference).toBe("chain_0x927e138e");
  });

  it("explains that it is the PAYMENT that would be a duplicate", () => {
    expect(check.preventionNote).toBe(
      "A new payment would be a duplicate and is therefore prevented.",
    );
  });

  // --- 3: the invoice itself is not the duplicate ---------------------------
  it("never calls the invoice itself a duplicate invoice", () => {
    const text = [check.label, check.detail, check.preventionNote].join(" ").toLowerCase();

    expect(text).not.toContain("duplicate invoice");
    expect(text).not.toContain("fraudulent");
    // "duplicate" may appear ONLY about a prospective payment.
    expect(check.preventionNote).toContain("new payment would be a duplicate");
  });

  it("is consistent however the label and detail are combined", () => {
    // The property that failed: label and detail must describe one finding.
    const settled = describeDuplicateCheck({
      invoiceNumber: "INV-X",
      alreadySettled: true,
      settledByPaymentId: null,
    });

    expect(settled.label.toLowerCase()).not.toContain("no duplicate");
    expect(settled.detail).toContain("already been paid");
    // No reference is not a reason to fall back to the passing wording.
    expect(settled.passed).toBe(false);
    expect(settled.settlementReference).toBeNull();
  });
});

// --- 5, 6: one semantic state, shared -------------------------------------

describe("the same settlement state everywhere", () => {
  const SUPPLIER: SupplierFacts = {
    supplierFound: true,
    supplierId: "sup_northwind",
    registryStatus: "APPROVED",
    registeredWallet: "0xnorthwind",
    invoiceRecipientWallet: "0xnorthwind",
    walletMatch: true,
    businessCriticality: "HIGH",
    history: {
      invoiceCount: 6,
      meanAmountCents: 460_000,
      maxAmountCents: 520_000,
      onTimePaymentRate: 1,
      firstSeen: "2025-02-11",
    },
  };

  const VALIDATION: ValidationFacts = {
    isDuplicate: true,
    duplicateOfPaymentId: "chain_0x927e138e",
    poFound: true,
    poAmountCents: 480_000,
    poDeltaCents: 0,
    poMatch: true,
    poCurrency: "USD",
    poDescription: "Powder coating line, phase 2",
    poIssuedAt: "2026-08-28",
    poSupplierId: "sup_northwind",
    poSupplierMatch: true,
    amountVsSupplierMeanRatio: 1.04,
    amountVsSupplierMaxRatio: 0.92,
    currencyAllowed: true,
  };

  const INVOICE = {
    invoiceNumber: "INV-2026-3501",
    supplierName: "Northwind Components Ltd",
    amountCents: 480_000,
    currency: "USD",
    poNumber: "PO-2026-0530",
    unresolvedFields: [] as string[],
  };

  it("agrees with the risk evidence about what happened", () => {
    // Both read `isDuplicate`, and both must call it settlement.
    const evidence = buildRiskEvidence(INVOICE, SUPPLIER, VALIDATION);
    const codes = evidence.map((item) => item.code);

    expect(codes).toContain("INVOICE_ALREADY_SETTLED");
    expect(codes).not.toContain("DUPLICATE_INVOICE");

    const check = describeDuplicateCheck({
      invoiceNumber: INVOICE.invoiceNumber,
      alreadySettled: VALIDATION.isDuplicate,
      settledByPaymentId: VALIDATION.duplicateOfPaymentId,
    });
    expect(check.passed).toBe(false);
    expect(check.label).toBe("Already settled");
  });

  it("does not weaken the guard that prevents the second payment", () => {
    // Requirement, stated where it can regress: the presentation changed and
    // the protection did not.
    const analysis = {
      supplierFacts: SUPPLIER,
      validationFacts: VALIDATION,
      invoiceFacts: INVOICE,
    } as unknown as DeterministicAnalysis;

    expect(blockingConditions(analysis).length).toBeGreaterThan(0);
    expect(blockingConditions(analysis).join(" ")).toContain("already been settled");
  });
});

// --- 8: a settled invoice with a REAL problem stays a real problem ----------

describe("settlement is not an amnesty", () => {
  it("keeps a wallet mismatch on a settled invoice a genuine discrepancy", async () => {
    const scenario = scenarioById("s6_duplicate");
    const base = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const attacked = {
      ...base,
      supplierFacts: { ...base.supplierFacts, walletMatch: false },
    } as DeterministicAnalysis;

    // Two independent blocking reasons now, not one.
    const reasons = blockingConditions(attacked);
    expect(reasons.length).toBeGreaterThan(1);
    expect(reasons.join(" ")).toContain("remit wallet");

    // And the wallet mismatch is still flagged as an anomaly, not softened by
    // the invoice happening to be settled.
    const codes = attacked.riskEvidence.map((item) => item.code);
    expect(codes).toContain("INVOICE_ALREADY_SETTLED");
  });

  it("still rates a settled invoice with a wallet mismatch as CRITICAL", async () => {
    const scenario = scenarioById("s6_duplicate");
    const base = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const verdict = decideDeterministically({
      ...base,
      supplierFacts: { ...base.supplierFacts, walletMatch: false },
    } as DeterministicAnalysis);

    expect(verdict.risk).toBe("CRITICAL");
    expect(verdict.action).toBe("REJECT");
  });

  it("rates a cleanly settled invoice as settlement, not as an alarm", async () => {
    const run = await runScenario(scenarioById("s6_duplicate"), createDeterministicEngine("test"));

    expect(run.decision.decision.risk).toBe("LOW");
    expect(run.decision.decision.action).toBe("REJECT");
  });
});
