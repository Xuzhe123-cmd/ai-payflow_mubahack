/**
 * The demo scenarios must fail for the reason the demo claims.
 *
 * Scenario B exists to show a payment refused by the agent's on-chain payment
 * cap. If the seeded world happened to also have an unapproved supplier, or a
 * mismatched wallet, the chain would refuse it for THAT instead — the screen
 * would look identical, the story would be wrong, and nobody would notice.
 *
 * So this asserts the exact violation set for each scenario against the world
 * scripts/seed.ts actually creates: the same suppliers, the same extracted
 * invoice facts, the same treasury profile. It is checked off chain through the
 * Move mirror, which errorCodeParity.test.ts and the Move suite together pin to
 * the real thing.
 */

import { describe, expect, it } from "vitest";

import { extractInvoice } from "../../lib/deterministic/extractInvoice";
import { lookupSupplier } from "../../lib/deterministic/lookupSupplier";
import { TREASURY_PROFILES } from "../../lib/demo/cashFlow";
import { AGENT_CAPABILITY, APPROVER_AUTHORITY, TREASURY_POLICY } from "../../lib/demo/policies";
import { SCENARIOS, scenarioById } from "../../lib/demo/scenarios";
import { SUPPLIERS } from "../../lib/demo/suppliers";
import { limitsFor, type PaymentAuthority } from "../../lib/sui/limits";
import { enforcePolicy } from "../../lib/sui/policyGuard";
import type { PaymentRequest, PolicyViolationCode } from "../../lib/types";

/** The treasury the seed script funds: $100,000 behind a $50,000 reserve. */
const COMPANY = TREASURY_PROFILES.tight;

const NOW_MS = 1_800_000_000_000;

/** Builds the request the seed's on-chain invoice would produce. */
function requestFor(scenarioId: string): PaymentRequest {
  const scenario = scenarioById(scenarioId);
  const facts = extractInvoice(scenario.document, scenario.asOfDate);
  const supplier = lookupSupplier(facts, SUPPLIERS);
  return {
    invoiceNumber: facts.invoiceNumber,
    supplierId: supplier.supplierId,
    supplierName: facts.supplierName,
    amountCents: facts.amountCents,
    currency: facts.currency,
    recipientWallet: facts.recipientWallet,
    requestedDate: scenario.asOfDate,
    agentId: AGENT_CAPABILITY.agentId,
    recommendationId: "rec_demo",
    recommendedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 86_400_000,
  };
}

function violationsFor(
  scenarioId: string,
  authority: PaymentAuthority = "AGENT",
): PolicyViolationCode[] {
  const result = enforcePolicy({
    request: requestFor(scenarioId),
    limits: limitsFor(authority, AGENT_CAPABILITY, APPROVER_AUTHORITY),
    policy: TREASURY_POLICY,
    treasury: COMPANY.treasury,
    suppliers: SUPPLIERS,
    paymentHistory: [],
    nowMs: NOW_MS + 1_000,
  });
  return result.violations.map((violation) => violation.code);
}

describe("the seeded demo world produces the intended verdicts", () => {
  it("Scenario A0 — $3,000 settles autonomously, nothing objects", () => {
    const request = requestFor("s1_normal");
    expect(request.amountCents).toBe(300_000);
    expect(violationsFor("s1_normal")).toEqual([]);
  });

  it("Scenario B — $8,000 fails on the payment cap ALONE", () => {
    const request = requestFor("s8_policy_violation");
    expect(request.amountCents).toBe(800_000);

    // The whole point: exactly one violation, and it is the one on the slide.
    expect(violationsFor("s8_policy_violation")).toEqual(["EXCEEDS_MAX_PAYMENT"]);
  });

  it("Scenario B is not rescued by the reserve or the daily limit either", () => {
    // Sanity on the neighbouring checks, so a future change to the treasury
    // profile cannot silently turn this into a different demonstration.
    const amount = requestFor("s8_policy_violation").amountCents;
    expect(COMPANY.treasury.currentCashCents - amount).toBeGreaterThan(
      TREASURY_POLICY.minimumReserveCents,
    );
    expect(amount).toBeLessThan(AGENT_CAPABILITY.dailyLimitCents);
  });

  it("Scenario A — $30,000 is refused to the agent AND to the approver", () => {
    const request = requestFor("s2_cashflow");
    expect(request.amountCents).toBe(3_000_000);

    // The agent alone cannot: this is why the flow needs a human. $30,000 is
    // over the $5,000 single cap AND the $20,000 daily limit, so both fire —
    // what matters is that the refusal is about LIMITS and nothing else. A
    // supplier, wallet, reserve or currency failure here would mean the demo
    // was telling a different story than the one on the slide.
    expect(violationsFor("s2_cashflow", "AGENT")).toEqual([
      "EXCEEDS_MAX_PAYMENT",
      "EXCEEDS_DAILY_LIMIT",
    ]);

    // AND the human approver cannot rescue it either. The approver ceiling is
    // $25,000 — the live Chain-Doi authorization — so $30,000 fails the same
    // check under human authority. Approval raises WHOSE limit applies; it
    // does not remove the limit.
    //
    // This assertion used to be `toEqual([])`, which held only while
    // APPROVER_AUTHORITY was a $250,000 constant no validator had ever seen.
    expect(violationsFor("s2_cashflow", "HUMAN_APPROVAL")).toEqual([
      "EXCEEDS_MAX_PAYMENT",
    ]);
  });

  it("Scenario A is above the human-approval threshold, A0 below it", () => {
    // The routing rule the UI labels payments by.
    expect(requestFor("s2_cashflow").amountCents).toBeGreaterThan(
      TREASURY_POLICY.humanApprovalThresholdCents,
    );
    expect(requestFor("s1_normal").amountCents).toBeLessThanOrEqual(
      TREASURY_POLICY.humanApprovalThresholdCents,
    );
  });

  it("the unknown-supplier scenario really is unknown to the registry", () => {
    // Scenario 4 must fail check 3, not something incidental.
    const violations = violationsFor("s4_new_supplier");
    expect(violations).toContain("SUPPLIER_NOT_APPROVED");
  });

  it("every seeded supplier has a wallet the registry will vouch for", () => {
    // If a demo invoice's remit address drifted from the registry, check 4
    // would fire first and mask whatever the scenario was meant to show.
    for (const scenario of SCENARIOS) {
      const facts = extractInvoice(scenario.document, scenario.asOfDate);
      const supplier = lookupSupplier(facts, SUPPLIERS);
      if (!supplier.supplierFound) continue;
      if (scenario.id === "s5_wallet_mismatch") {
        // The one scenario where a mismatch IS the point.
        expect(supplier.walletMatch).toBe(false);
        continue;
      }
      expect(supplier.walletMatch, `${scenario.id} remit wallet drifted`).toBe(true);
    }
  });
});
