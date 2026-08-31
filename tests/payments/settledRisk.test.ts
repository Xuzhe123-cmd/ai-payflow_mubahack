/**
 * Risk, for a payment that has already happened.
 *
 * THE BUG THIS PREVENTS: INV-2026-3501 was paid — $4,800 released, oracle
 * attestation confirmed, invoice PAID on chain — and its risk panel read
 * CRITICAL, with one observation flagged:
 *
 *   "Duplicate invoice — Invoice number INV-2026-3501 has already been settled."
 *
 * Three separate errors, all from one conflation. Re-analysing a settled
 * invoice answers a question about a payment that does not exist — could we pay
 * this now? no — and that answer was rendered as though it described the
 * invoice in front of the reader.
 *
 *   the completed payment   $4,800, released. Finished, and it went well.
 *   a new payment attempt   not permitted, because the invoice is settled.
 *
 * An already-paid invoice is also not a DUPLICATE invoice. A duplicate is a
 * second document improperly repeating a first; this is the original, and
 * accusing it of duplicating itself is nonsense. The protection is unchanged —
 * a second payment is still refused — only the description is.
 */

import { describe, expect, it } from "vitest";

import {
  describeSettledRisk,
  isSettlementEvidence,
} from "../../lib/payments/settledRisk";
import { buildRiskEvidence } from "../../lib/deterministic/buildRiskEvidence";
import { blockedOnlyBySettlement, blockingConditions } from "../../lib/ai/blockingConditions";
import { decideDeterministically } from "../../lib/ai/deterministicEngine";
import { RISK_EVIDENCE_LABEL } from "../../lib/format";
import type {
  DeterministicAnalysis,
  SupplierFacts,
  ValidationFacts,
} from "../../lib/types";

const SUPPLIER: SupplierFacts = {
  supplierFound: true,
  supplierId: "SUP-NORTHWIND",
  registryStatus: "APPROVED",
  walletMatch: true,
  registeredWallet: "0xnorthwind",
  invoiceRecipientWallet: "0xnorthwind",
  businessCriticality: "HIGH",
  history: {
    invoiceCount: 6,
    meanAmountCents: 460_000,
    maxAmountCents: 520_000,
    onTimePaymentRate: 1,
    firstSeen: "2025-02-11",
  },
};

const CLEAN: ValidationFacts = {
  isDuplicate: false,
  duplicateOfPaymentId: null,
  poFound: true,
  poAmountCents: 480_000,
  poDeltaCents: 0,
  poMatch: true,
  poCurrency: "USD",
  poDescription: "Powder coating line, phase 2",
  poIssuedAt: "2026-08-28",
  poSupplierId: "SUP-NORTHWIND",
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
  poNumber: "PO-2026-118",
  unresolvedFields: [] as string[],
};

// --- 5: an already-paid invoice is not a duplicate invoice ------------------

describe("the observation for a settled invoice", () => {
  it("does NOT create a Duplicate invoice observation", () => {
    // The exact accusation that appeared on screen, and the code that produced
    // it. `isDuplicate` means "a payment record exists for this invoice
    // number" — which is to say THIS invoice was paid.
    const evidence = buildRiskEvidence(INVOICE, SUPPLIER, {
      ...CLEAN,
      isDuplicate: true,
      duplicateOfPaymentId: "PMT-4471",
    });

    expect(evidence.map((item) => item.code)).not.toContain("DUPLICATE_INVOICE");
  });

  it("records it as a settlement fact instead", () => {
    const evidence = buildRiskEvidence(INVOICE, SUPPLIER, {
      ...CLEAN,
      isDuplicate: true,
      duplicateOfPaymentId: "PMT-4471",
    });
    const settled = evidence.find((item) => item.code === "INVOICE_ALREADY_SETTLED");

    expect(settled).toBeDefined();
    expect(settled!.observation).toBe("Invoice INV-2026-3501 was already settled on chain.");
    // And it reads as settlement, not as a fault found.
    expect(settled!.observation.toLowerCase()).not.toContain("duplicate");
    expect(RISK_EVIDENCE_LABEL.INVOICE_ALREADY_SETTLED).toBe("Payment already settled");
  });

  it("is classified as settlement evidence, so it is not listed as flagged", () => {
    // The panel filters these out of "N observations flagged" — a completed
    // payment counted as an anomaly is the same error in another place.
    expect(isSettlementEvidence("INVOICE_ALREADY_SETTLED")).toBe(true);
    expect(isSettlementEvidence("WALLET_MISMATCH")).toBe(false);
    expect(isSettlementEvidence("DUPLICATE_INVOICE")).toBe(false);
  });

  it("flags nothing at all for a clean settled invoice once settlement is removed", () => {
    // INV-2026-3501 has no other anomaly. After filtering, the panel shows the
    // "no anomalies detected" state rather than a flagged observation.
    const evidence = buildRiskEvidence(INVOICE, SUPPLIER, { ...CLEAN, isDuplicate: true });
    const flagged = evidence.filter((item) => !isSettlementEvidence(item.code));

    expect(flagged).toEqual([]);
  });
});

// --- 6, 7: settled is not a risk failure and not CRITICAL -------------------

describe("the risk level for a settled invoice", () => {
  const analysis = (validation: Partial<ValidationFacts>): DeterministicAnalysis =>
    ({
      invoiceFacts: { ...INVOICE, dueDate: "2026-09-20", issueDate: "2026-08-20" },
      supplierFacts: SUPPLIER,
      validationFacts: { ...CLEAN, ...validation },
      policyFacts: {
        maxSinglePaymentCents: 1_000_000,
        dailyLimitCents: 2_500_000,
        minimumReserveCents: 5_000_000,
        allowedCurrencies: ["USD"],
        wouldExceedSingleLimit: false,
        wouldExceedDailyLimit: false,
      },
      urgencyFacts: {
        dueDate: "2026-09-20",
        daysUntilDue: 20,
        isOverdue: false,
        discountAmountCents: null,
        discountDeadline: null,
        businessCriticality: "HIGH",
        paymentTerms: "NET30",
      },
      cashFlowScenarios: [
        {
          paymentDate: "2026-08-31",
          projectedMinimumCashCents: 9_000_000,
          reserveBreach: false,
          discountCapturedCents: 0,
        },
      ],
      riskEvidence: [],
    }) as unknown as DeterministicAnalysis;

  it("is not CRITICAL merely because the invoice is already settled", () => {
    // CRITICAL is the loudest signal the interface has. Raising it over a
    // payment that completed correctly tells the reader something went wrong.
    const decision = decideDeterministically(analysis({ isDuplicate: true }));

    expect(decision.risk).not.toBe("CRITICAL");
    expect(decision.risk).toBe("LOW");
  });

  it("still refuses a new payment for it", () => {
    // The protection is untouched. This is the assertion that proves the
    // severity change did not become a permission change.
    const settled = analysis({ isDuplicate: true });
    const decision = decideDeterministically(settled);

    expect(decision.action).toBe("REJECT");
    expect(decision.recommendedDate).toBeNull();
    expect(blockingConditions(settled).length).toBeGreaterThan(0);
  });

  it("describes the refusal as settlement, not as a failure", () => {
    const decision = decideDeterministically(analysis({ isDuplicate: true }));

    expect(decision.riskExplanation).toContain("already settled");
    expect(decision.decisionExplanation).toContain("already settled");
    expect(decision.decisionExplanation).toContain("completed payment is unaffected");
  });

  it("stays CRITICAL for a genuine blocking problem", () => {
    // The distinction must cut both ways, or the fix has removed an alarm.
    const attacked = analysis({ isDuplicate: false });
    const decision = decideDeterministically({
      ...attacked,
      supplierFacts: { ...SUPPLIER, walletMatch: false },
    } as DeterministicAnalysis);

    expect(decision.risk).toBe("CRITICAL");
    expect(decision.action).toBe("REJECT");
  });

  it("stays CRITICAL when a settled invoice ALSO has a real problem", () => {
    // Settlement must not become an amnesty for everything else.
    const both = decideDeterministically({
      ...analysis({ isDuplicate: true }),
      supplierFacts: { ...SUPPLIER, walletMatch: false },
    } as DeterministicAnalysis);

    expect(both.risk).toBe("CRITICAL");
  });
});

describe("blockedOnlyBySettlement", () => {
  const base = {
    supplierFacts: SUPPLIER,
    validationFacts: { ...CLEAN, isDuplicate: true },
  } as unknown as DeterministicAnalysis;

  it("is true when settlement is the only thing in the way", () => {
    expect(blockedOnlyBySettlement(base)).toBe(true);
  });

  it("is false when nothing is in the way at all", () => {
    expect(
      blockedOnlyBySettlement({
        ...base,
        validationFacts: { ...CLEAN, isDuplicate: false },
      } as DeterministicAnalysis),
    ).toBe(false);
  });

  it("is false when a real problem sits alongside the settlement", () => {
    for (const supplierFacts of [
      { ...SUPPLIER, walletMatch: false },
      { ...SUPPLIER, supplierFound: false },
      { ...SUPPLIER, registryStatus: "SUSPENDED" as const },
    ]) {
      expect(
        blockedOnlyBySettlement({ ...base, supplierFacts } as DeterministicAnalysis),
      ).toBe(false);
    }

    expect(
      blockedOnlyBySettlement({
        ...base,
        validationFacts: { ...CLEAN, isDuplicate: true, currencyAllowed: false },
      } as DeterministicAnalysis),
    ).toBe(false);
  });
});

// --- what the settled panel actually says -----------------------------------

describe("the settled risk view", () => {
  it("describes the completed conditional payment, in the order it happened", () => {
    const view = describeSettledRisk({
      conditionStage: "RELEASED",
      oracleConfirmed: true,
      chainInvoiceStatus: "PAID",
      amountLabel: "$4,800",
    });

    expect(view.headline).toBe("Payment settled");
    expect(view.assessment).toContain("released after the shipment condition was satisfied");
    expect(view.checks.map((check) => check.label)).toEqual([
      "Shipment confirmed",
      "Oracle attestation confirmed",
      "Escrow condition satisfied",
      "Payment released",
      "Invoice paid on chain",
    ]);
    expect(view.checks.every((check) => check.ok)).toBe(true);
    expect(view.note).toContain("No further payment action is available");
  });

  it("never uses the vocabulary of a failed payment", () => {
    const view = describeSettledRisk({
      conditionStage: "RELEASED",
      oracleConfirmed: true,
      chainInvoiceStatus: "PAID",
      amountLabel: "$4,800",
    });
    const text = [view.headline, view.assessment, view.note, ...view.checks.map((c) => c.label)]
      .join(" ")
      .toLowerCase();

    expect(text).not.toContain("reject");
    expect(text).not.toContain("duplicate");
    expect(text).not.toContain("critical");
    expect(text).not.toContain("risk");
  });

  it("does not claim an oracle confirmation for an ordinary settled invoice", () => {
    // The mirror-image error: inventing shipment evidence for a payment that
    // never carried a shipment condition.
    const view = describeSettledRisk({
      conditionStage: null,
      oracleConfirmed: false,
      chainInvoiceStatus: "PAID",
      amountLabel: "$12,000",
    });

    expect(view.checks.map((check) => check.label)).toEqual([
      "Payment settled on chain",
      "Invoice recorded as paid",
    ]);
    expect(view.assessment).not.toContain("shipment");
  });
});
