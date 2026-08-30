/**
 * Tier 1 — the deterministic layer. No network, exact expected values.
 *
 * These tests are what make the claim "every number handed to the model is
 * pre-verified" true rather than aspirational.
 */

import { describe, expect, it } from "vitest";

import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { extractInvoice, parseMoneyText } from "../lib/deterministic/extractInvoice";
import { forecastCash } from "../lib/deterministic/forecast";
import { lookupSupplier } from "../lib/deterministic/lookupSupplier";
import { validateInvoice } from "../lib/deterministic/validateInvoice";
import { DEMO_DOCUMENTS, DEMO_WALLETS } from "../lib/demo/invoices";
import { PAYMENT_HISTORY } from "../lib/demo/paymentHistory";
import { PURCHASE_ORDERS } from "../lib/demo/purchaseOrders";
import { SCENARIOS, scenarioById } from "../lib/demo/scenarios";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { TREASURY_POLICY } from "../lib/demo/policies";
import { addDays, daysBetween } from "../lib/util/date";
import { dollars, percentOf } from "../lib/util/money";

const AS_OF = "2026-08-29";

describe("money parsing", () => {
  it("converts formatted amounts to exact cents", () => {
    expect(parseMoneyText("12,400.00")).toBe(1_240_000);
    expect(parseMoneyText("68,000.00")).toBe(6_800_000);
    expect(parseMoneyText("0.05")).toBe(5);
    expect(parseMoneyText("1,234.5")).toBe(123_450);
  });

  it("rejects text that is not an amount", () => {
    expect(parseMoneyText("Net 30")).toBeNull();
    expect(parseMoneyText("")).toBeNull();
  });

  it("computes discounts without floating-point drift", () => {
    expect(percentOf(dollars(30_000), 2)).toBe(dollars(600));
    // 2% of $1,234.57 = $24.6914 -> rounds to $24.69
    expect(percentOf(123_457, 2)).toBe(2_469);
  });
});

describe("date arithmetic", () => {
  it("is UTC-based and timezone-independent", () => {
    expect(addDays("2026-08-29", 3)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-08-29", "2026-09-05")).toBe(7);
    expect(daysBetween("2026-09-05", "2026-08-29")).toBe(-7);
  });
});

describe("extractInvoice", () => {
  it("reads every field from a well-formed document", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.normal, AS_OF);
    expect(facts.invoiceNumber).toBe("INV-2026-3455");
    expect(facts.supplierName).toBe("NORTHWIND COMPONENTS LTD");
    expect(facts.amountCents).toBe(dollars(3_000));
    expect(facts.currency).toBe("USD");
    expect(facts.dueDate).toBe("2026-08-31");
    expect(facts.daysUntilDue).toBe(2);
    expect(facts.poNumber).toBe("PO-2026-0412");
    expect(facts.recipientWallet).toBe(DEMO_WALLETS.northwind);
    expect(facts.discount).toBeNull();
    expect(facts.unresolvedFields).toEqual([]);
  });

  it("extracts an early-payment discount as an exact amount", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.discount, AS_OF);
    expect(facts.discount).toEqual({
      percent: 5,
      amountCents: dollars(240),
      deadline: "2026-08-29",
      daysUntilDeadline: 0,
    });
  });

  it("sums a multi-line invoice to the stated total", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.poMismatch, AS_OF);
    expect(facts.amountCents).toBe(dollars(14_700));
  });
});

describe("lookupSupplier", () => {
  it("matches a registered supplier despite suffix and case differences", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.normal, AS_OF);
    const supplier = lookupSupplier(facts, SUPPLIERS);
    expect(supplier.supplierFound).toBe(true);
    expect(supplier.supplierId).toBe("sup_northwind");
    expect(supplier.registryStatus).toBe("APPROVED");
    expect(supplier.walletMatch).toBe(true);
  });

  it("reports an unregistered supplier as NOT_FOUND without guessing", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.newSupplier, AS_OF);
    const supplier = lookupSupplier(facts, SUPPLIERS);
    expect(supplier.supplierFound).toBe(false);
    expect(supplier.registryStatus).toBe("NOT_FOUND");
    expect(supplier.registeredWallet).toBeNull();
    expect(supplier.walletMatch).toBe(false);
  });

  it("detects a swapped remit wallet on an approved supplier", () => {
    const facts = extractInvoice(DEMO_DOCUMENTS.walletMismatch, AS_OF);
    const supplier = lookupSupplier(facts, SUPPLIERS);
    expect(supplier.supplierFound).toBe(true);
    expect(supplier.registryStatus).toBe("APPROVED");
    expect(supplier.walletMatch).toBe(false);
    expect(supplier.invoiceRecipientWallet).toBe(DEMO_WALLETS.impostor);
  });
});

describe("validateInvoice", () => {
  const validateDoc = (doc: (typeof DEMO_DOCUMENTS)[keyof typeof DEMO_DOCUMENTS]) => {
    const invoice = extractInvoice(doc, AS_OF);
    const supplier = lookupSupplier(invoice, SUPPLIERS);
    return validateInvoice(invoice, supplier, PURCHASE_ORDERS, PAYMENT_HISTORY, TREASURY_POLICY);
  };

  it("flags an already-settled invoice number", () => {
    const result = validateDoc(DEMO_DOCUMENTS.duplicate);
    expect(result.isDuplicate).toBe(true);
    expect(result.duplicateOfPaymentId).toBe("pay_0x91ac");
  });

  it("measures the PO overage exactly", () => {
    const result = validateDoc(DEMO_DOCUMENTS.poMismatch);
    expect(result.poFound).toBe(true);
    expect(result.poAmountCents).toBe(dollars(9_800));
    expect(result.poDeltaCents).toBe(dollars(4_900));
    expect(result.poMatch).toBe(false);
  });

  it("reports a matching PO as a zero delta", () => {
    const result = validateDoc(DEMO_DOCUMENTS.normal);
    expect(result.poMatch).toBe(true);
    expect(result.poDeltaCents).toBe(0);
  });

  it("reports an unknown PO number as not found", () => {
    const result = validateDoc(DEMO_DOCUMENTS.newSupplier);
    expect(result.poFound).toBe(false);
    expect(result.poMatch).toBeNull();
  });
});

describe("forecastCash", () => {
  it("computes end-of-day balances and the trough exactly", () => {
    const forecast = forecastCash({
      asOf: "2026-08-29",
      horizonDays: 7,
      openingCashCents: dollars(100_000),
      minimumReserveCents: dollars(50_000),
      events: [
        { id: "a", date: "2026-08-31", direction: "OUTFLOW", amountCents: dollars(28_000), description: "" },
        { id: "b", date: "2026-09-01", direction: "INFLOW", amountCents: dollars(35_000), description: "" },
      ],
      payment: { date: "2026-08-29", amountCents: dollars(30_000) },
    });

    expect(forecast.days[0].closingCents).toBe(dollars(70_000));
    expect(forecast.days[2].closingCents).toBe(dollars(42_000));
    expect(forecast.days[3].closingCents).toBe(dollars(77_000));
    expect(forecast.minimumCashCents).toBe(dollars(42_000));
    expect(forecast.minimumCashDate).toBe("2026-08-31");
    expect(forecast.reserveBreach).toBe(true);
    expect(forecast.breachDepthCents).toBe(dollars(8_000));
  });

  it("reports no breach when the trough clears the reserve", () => {
    const forecast = forecastCash({
      asOf: "2026-08-29",
      horizonDays: 7,
      openingCashCents: dollars(100_000),
      minimumReserveCents: dollars(50_000),
      events: [],
      payment: { date: "2026-08-29", amountCents: dollars(30_000) },
    });
    expect(forecast.minimumCashCents).toBe(dollars(70_000));
    expect(forecast.reserveBreach).toBe(false);
    expect(forecast.breachDepthCents).toBe(0);
  });
});

describe("candidate date simulation", () => {
  it("reproduces the liquidity shape that makes scenario 2 a timing problem", async () => {
    const scenario = scenarioById("s2_cashflow");
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const byDate = new Map(analysis.cashFlowScenarios.map((c) => [c.paymentDate, c]));
    expect([...byDate.keys()]).toEqual(["2026-08-29", "2026-09-01", "2026-09-05"]);

    expect(byDate.get("2026-08-29")!.projectedMinimumCashCents).toBe(dollars(42_000));
    expect(byDate.get("2026-08-29")!.reserveBreach).toBe(true);
    expect(byDate.get("2026-09-01")!.projectedMinimumCashCents).toBe(dollars(65_000));
    expect(byDate.get("2026-09-01")!.reserveBreach).toBe(false);
    expect(byDate.get("2026-09-05")!.projectedMinimumCashCents).toBe(dollars(70_000));
    expect(byDate.get("2026-09-05")!.reserveBreach).toBe(false);
  });

  it("prices the discount only on dates that capture it", async () => {
    const scenario = scenarioById("s3_discount");
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });

    const today = analysis.cashFlowScenarios.find((c) => c.paymentDate === "2026-08-29")!;
    const dueDate = analysis.cashFlowScenarios.find((c) => c.paymentDate === "2026-09-23")!;

    expect(today.discountCapturedCents).toBe(dollars(240));
    expect(today.paymentAmountCents).toBe(dollars(4_560));
    expect(dueDate.discountCapturedCents).toBe(0);
    expect(dueDate.paymentAmountCents).toBe(dollars(4_800));
  });

  it("never offers a date after the due date", async () => {
    for (const scenario of SCENARIOS) {
      const analysis = await buildAnalysis({
        document: scenario.document,
        world: scenario.world,
        asOf: scenario.asOfDate,
      });
      for (const candidate of analysis.cashFlowScenarios) {
        expect(candidate.isAfterDueDate).toBe(false);
      }
    }
  });
});

describe("policy facts", () => {
  it("flags exactly the invoices above the agent's single-payment cap", async () => {
    // With the cap at $5,000 only the two smallest invoices are inside it —
    // which is what makes s1 and s3 the genuinely autonomous demonstrations.
    const within: string[] = [];
    const exceeding: string[] = [];
    for (const scenario of SCENARIOS) {
      const analysis = await buildAnalysis({
        document: scenario.document,
        world: scenario.world,
        asOf: scenario.asOfDate,
      });
      (analysis.policyFacts.wouldExceedSingleLimit ? exceeding : within).push(scenario.id);
    }

    expect(within).toEqual(["s1_normal", "s3_discount"]);
    expect(exceeding).toContain("s8_policy_violation");
    expect(exceeding).toContain("s2_cashflow");
  });
});
