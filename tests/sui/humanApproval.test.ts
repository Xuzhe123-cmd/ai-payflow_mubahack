/**
 * What a human approval does, and — more importantly — what it does not do.
 *
 * The workflow's whole claim is a narrow one: approving overrides the AGENT's
 * lack of authority, not the treasury's policy. That is easy to state in copy
 * and easy to lose in code, because the tempting shortcut — "a human said yes,
 * so skip the checks" — produces a demo that looks identical right up until it
 * pays an unapproved supplier.
 *
 * So these tests come at it from both sides: an approval must lift the limit
 * checks, and must lift NOTHING else. The remaining eight rules are asserted
 * one at a time against a world deliberately broken in that one way.
 */

import { describe, expect, it } from "vitest";

import { AGENT_CAPABILITY, APPROVER_AUTHORITY, TREASURY_POLICY } from "../../lib/demo/policies";
import { TREASURY_PROFILES } from "../../lib/demo/cashFlow";
import { scenarioById } from "../../lib/demo/scenarios";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { SUPPLIERS } from "../../lib/demo/suppliers";
import { authorityFor, limitsFor } from "../../lib/sui/limits";
import { buildPaymentRequest } from "../../lib/sui/paymentRequest";
import { enforcePolicy } from "../../lib/sui/policyGuard";
import type {
  PaymentRequest,
  PaymentRecommendation,
  PolicyViolationCode,
  Supplier,
  TreasuryAction,
} from "../../lib/types";

const COMPANY = TREASURY_PROFILES.tight;
const NOW_MS = 1_800_000_000_000;
const APPROVED = SUPPLIERS.find((s) => s.registryStatus === "APPROVED")!;

/** $30,000 — over the agent's $5,000 cap, under the approver's $250,000 one. */
function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    invoiceNumber: "INV-HUMAN-1",
    supplierId: APPROVED.id,
    supplierName: APPROVED.name,
    // $24,000: above the agent's $5,000 single cap and $20,000 daily limit,
    // and inside the approver's $25,000 authorization. Chosen so the property
    // under test — approval lifts the AGENT's ceiling — is demonstrated by an
    // amount the approver can actually authorize. It used to be $30,000, which
    // only worked while the approver figure was a $250,000 constant.
    amountCents: 2_400_000,
    currency: "USD",
    recipientWallet: APPROVED.registeredWallet,
    requestedDate: "2026-09-05",
    agentId: AGENT_CAPABILITY.agentId,
    recommendationId: "rec_human",
    recommendedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 86_400_000,
    ...overrides,
  };
}

function approve(
  req: PaymentRequest,
  world: { suppliers?: Supplier[]; history?: string[]; cashCents?: number } = {},
) {
  return enforcePolicy({
    request: req,
    limits: limitsFor("HUMAN_APPROVAL", AGENT_CAPABILITY, APPROVER_AUTHORITY),
    policy: TREASURY_POLICY,
    treasury:
      world.cashCents === undefined
        ? COMPANY.treasury
        : { ...COMPANY.treasury, currentCashCents: world.cashCents },
    suppliers: world.suppliers ?? SUPPLIERS,
    paymentHistory: (world.history ?? []).map((invoiceNumber, index) => ({
      paymentId: `pay_${index}`,
      invoiceNumber,
      supplierId: APPROVED.id,
      amountCents: 1,
      currency: "USD",
      paidAt: "2026-08-01",
      recipientWallet: APPROVED.registeredWallet,
    })),
    nowMs: NOW_MS + 1_000,
  });
}

const codes = (result: { violations: { code: PolicyViolationCode }[] }) =>
  result.violations.map((v) => v.code);

describe("a human approval lifts the agent's ceiling", () => {
  it("clears a payment the agent alone cannot make", () => {
    const req = request();

    const asAgent = enforcePolicy({
      request: req,
      limits: limitsFor("AGENT", AGENT_CAPABILITY, APPROVER_AUTHORITY),
      policy: TREASURY_POLICY,
      treasury: COMPANY.treasury,
      suppliers: SUPPLIERS,
      paymentHistory: [],
      nowMs: NOW_MS + 1_000,
    });
    expect(asAgent.outcome).toBe("SUI_REJECT");
    expect(codes(asAgent)).toEqual(["EXCEEDS_MAX_PAYMENT", "EXCEEDS_DAILY_LIMIT"]);

    const asHuman = approve(req);
    expect(asHuman.outcome).toBe("APPROVED");
    expect(codes(asHuman)).toEqual([]);
  });

  it("still runs all ten checks — approval is not a shortcut past them", () => {
    const result = approve(request());
    expect(result.checks).toHaveLength(10);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("is itself bounded — the approver has a ceiling too", () => {
    const overApprover = approve(
      request({ amountCents: APPROVER_AUTHORITY.maxSinglePaymentCents + 1 }),
    );
    expect(codes(overApprover)).toContain("EXCEEDS_MAX_PAYMENT");
  });
});

describe("a human approval lifts nothing else", () => {
  it("cannot vouch for an unapproved supplier", () => {
    const suppliers = SUPPLIERS.map((s) =>
      s.id === APPROVED.id ? { ...s, registryStatus: "PENDING" as const } : s,
    );
    expect(codes(approve(request(), { suppliers }))).toContain("SUPPLIER_NOT_APPROVED");
  });

  it("cannot redirect a payment to an unregistered wallet", () => {
    const req = request({ recipientWallet: `0x${"9".repeat(64)}` });
    expect(codes(approve(req))).toContain("RECIPIENT_WALLET_MISMATCH");
  });

  it("cannot settle an invoice twice", () => {
    const result = approve(request(), { history: ["INV-HUMAN-1"] });
    expect(codes(result)).toContain("INVOICE_ALREADY_PAID");
  });

  it("cannot break the minimum reserve", () => {
    // $60,000 in the vault, $50,000 reserved, $30,000 asked for.
    const result = approve(request(), { cashCents: 6_000_000 });
    expect(codes(result)).toContain("INSUFFICIENT_RESERVE");
    expect(result.outcome).toBe("SUI_REJECT");
  });

  it("cannot authorize an unlisted currency", () => {
    expect(codes(approve(request({ currency: "GBP" })))).toContain("CURRENCY_NOT_ALLOWED");
  });

  it("cannot revive an expired recommendation", () => {
    const req = request({ expiresAtMs: NOW_MS - 1 });
    expect(codes(approve(req))).toContain("RECOMMENDATION_EXPIRED");
  });
});

describe("the agent cannot reach the human's authority", () => {
  it("never routes its own AUTO_PAY through an approval", () => {
    // The escalation exists to stop the agent, so asking to settle a $30,000
    // invoice itself must be judged against the agent's own cap. If AUTO_PAY
    // could route to HUMAN_APPROVAL, the cap would mean nothing.
    expect(authorityFor(3_000_000, "AUTO_PAY", TREASURY_POLICY)).toBe("AGENT");
    expect(authorityFor(100, "AUTO_PAY", TREASURY_POLICY)).toBe("AGENT");
  });

  it("cannot produce a payment request for an escalated invoice at all", async () => {
    // Built from a real scenario, so the ONLY thing varying below is the
    // action. If the guard were dropped, the SCHEDULE case proves the same
    // inputs would otherwise sail through and produce a live request.
    const scenario = scenarioById("s2_cashflow");
    const analysis = await buildAnalysis({
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
    });
    const date = analysis.cashFlowScenarios[0]!.paymentDate;
    const recommendation = (action: TreasuryAction) =>
      ({ action, recommendedDate: date }) as PaymentRecommendation;

    // Nothing downstream can execute what was never built.
    expect(
      buildPaymentRequest(recommendation("HUMAN_REVIEW"), analysis, AGENT_CAPABILITY.agentId),
    ).toBeNull();
    expect(
      buildPaymentRequest(recommendation("REJECT"), analysis, AGENT_CAPABILITY.agentId),
    ).toBeNull();
    expect(
      buildPaymentRequest(recommendation("SCHEDULE"), analysis, AGENT_CAPABILITY.agentId),
    ).not.toBeNull();
  });

  it("offers no way to ask for laxer limits", () => {
    // authorityFor's escape hatch points one way only: a caller may pin itself
    // to the agent's stricter limits, never to the approver's looser ones.
    const source = authorityFor.toString();
    expect(source).toContain("forceAgentAuthority");
    expect(source).not.toContain("forceHumanAuthority");
  });
});
