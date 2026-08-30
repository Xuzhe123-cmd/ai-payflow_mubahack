/**
 * The TypeScript view of the check codes must match the Move source exactly.
 *
 * This reads move/payflow/sources/payment.move rather than trusting a copied
 * list. If someone renumbers a check, inserts one, or renames a constant, the
 * chain would start aborting with a code the interface decodes as a different
 * violation — and a "blocked on chain" panel naming the wrong reason is worse
 * than no panel at all. This test is what makes that a build failure.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MOVE_ABORT_CODE,
  POLICY_CHECK_ORDER,
  moveConstantName,
  violationForAbortCode,
} from "../../lib/sui/errorCodes";
import { enforcePolicy } from "../../lib/sui/policyGuard";
import { limitsFor } from "../../lib/sui/limits";
import { AGENT_CAPABILITY, APPROVER_AUTHORITY, TREASURY_POLICY } from "../../lib/demo/policies";
import { SUPPLIERS } from "../../lib/demo/suppliers";
import type { PaymentRequest } from "../../lib/types";

const PAYMENT_MOVE = resolve(process.cwd(), "move/payflow/sources/payment.move");

/** Every `const EName: u64 = N;` declared in the Move module. */
function moveConstants(): Map<string, number> {
  const source = readFileSync(PAYMENT_MOVE, "utf8");
  const found = new Map<string, number>();
  const pattern = /^\s*const\s+(E[A-Za-z0-9_]*)\s*:\s*u64\s*=\s*(\d+)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.set(match[1], Number(match[2]));
  }
  return found;
}

describe("Move abort codes and PolicyViolationCode agree", () => {
  it("declares exactly ten checks", () => {
    expect(POLICY_CHECK_ORDER).toHaveLength(10);
    expect(new Set(POLICY_CHECK_ORDER).size).toBe(10);
  });

  it("matches the constants declared in payment.move", () => {
    const declared = moveConstants();

    POLICY_CHECK_ORDER.forEach((code, index) => {
      const name = moveConstantName(code);
      const value = declared.get(name);
      expect(value, `payment.move declares no constant ${name}`).toBeDefined();
      expect(value, `${name} should abort with ${index + 1}`).toBe(index + 1);
    });
  });

  it("keeps the operational errors clear of the check range", () => {
    // Codes 1..10 are policy verdicts the interface renders. Anything else is a
    // bug or misuse and must not be decodable as a failed check.
    const declared = moveConstants();
    const checkNames = new Set(POLICY_CHECK_ORDER.map(moveConstantName));

    for (const [name, value] of declared) {
      if (checkNames.has(name)) continue;
      expect(value, `${name} collides with the check-code range`).toBeGreaterThan(10);
    }
  });

  it("round-trips every code", () => {
    for (const code of POLICY_CHECK_ORDER) {
      expect(violationForAbortCode(MOVE_ABORT_CODE[code])).toBe(code);
    }
  });

  it("refuses to decode codes outside the check range", () => {
    for (const outside of [0, 11, 100, 700, -1, 1.5]) {
      expect(violationForAbortCode(outside)).toBeNull();
    }
  });

  it("matches the order the off-chain guard actually renders", () => {
    // The mirror in policyGuard.ts produces the checks in evaluation order.
    // That order is what the UI shows, so it has to be the Move order too.
    const supplier = SUPPLIERS[0];
    const request: PaymentRequest = {
      invoiceNumber: "INV-PARITY-1",
      supplierId: supplier.id,
      supplierName: supplier.name,
      amountCents: 100_00,
      currency: "USD",
      recipientWallet: supplier.registeredWallet,
      requestedDate: "2026-08-29",
      agentId: AGENT_CAPABILITY.agentId,
      recommendationId: "rec_parity",
      recommendedAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_086_400_000,
    };

    const result = enforcePolicy({
      request,
      limits: limitsFor("AGENT", AGENT_CAPABILITY, APPROVER_AUTHORITY),
      policy: TREASURY_POLICY,
      treasury: { currentCashCents: 100_000_00, currency: "USD" },
      suppliers: SUPPLIERS,
      paymentHistory: [],
      nowMs: 1_800_000_100_000,
    });

    expect(result.checks.map((check) => check.code)).toEqual([...POLICY_CHECK_ORDER]);
  });
});
