/**
 * Settlement outranks recommendation.
 *
 * THE BUG THIS PREVENTS: INV-2026-3501 was paid — $4,800 released from escrow
 * to the supplier — and the page said "Rejected". Both facts were real. The
 * guard does refuse a payment for that invoice, because paying an already
 * settled invoice twice is a duplicate. But that refusal is about a NEW
 * payment, and showing it as the outcome states that the original one failed.
 *
 *   the guard      "refuse a NEW payment for this invoice"
 *   the settlement "the payment already completed"
 *
 * So every test below pairs the most hostile recommendation there is — REJECT,
 * no payment request, Sui refusing — with a chain that has already settled, and
 * asserts the chain wins. The recommendation may explain; it may not overrule.
 */

import { describe, expect, it } from "vitest";

import { decideAutonomy } from "../../lib/payments/autonomy";
import {
  availablePaymentAction,
  offersPaymentControl,
  type AvailableActionInput,
} from "../../lib/payments/availableAction";

/** What the guard concludes about paying an already-settled invoice again. */
const REJECTED = decideAutonomy({
  action: "REJECT",
  finalOutcome: "REJECTED",
  hasPaymentRequest: false,
  enforcement: null,
  conditional: false,
});

const PAY_NOW = decideAutonomy({
  action: "AUTO_PAY",
  finalOutcome: "EXECUTED",
  hasPaymentRequest: true,
  enforcement: { outcome: "APPROVED" },
  conditional: false,
});

const NEEDS_HUMAN = decideAutonomy({
  action: "SCHEDULE",
  finalOutcome: "AWAITING_APPROVAL",
  hasPaymentRequest: true,
  enforcement: { outcome: "APPROVED" },
  conditional: false,
});

function input(overrides: Partial<AvailableActionInput> = {}): AvailableActionInput {
  return {
    autonomy: PAY_NOW,
    conditionStage: null,
    fundsHeldCents: 0,
    amountCents: 480_000,
    chainInvoiceStatus: null,
    runStatus: "ANALYZED",
    hasReceipt: false,
    ...overrides,
  };
}

describe("a settled invoice, with the AI recommending rejection", () => {
  it("reports PAYMENT RELEASED for a released escrow", () => {
    // INV-2026-3501 exactly: released on chain, guard says reject.
    const state = availablePaymentAction(
      input({
        autonomy: REJECTED,
        conditionStage: "RELEASED",
        chainInvoiceStatus: "PAID",
        supplierName: "Northwind Components Ltd",
      }),
    );

    expect(state.headline).toBe("PAYMENT RELEASED");
    expect(state.settled).toBe(true);
    expect(state.tone).toBe("positive");
    expect(state.detail).toContain("$4,800");
    expect(state.detail).toContain("Northwind Components Ltd");
    expect(state.facts).toContain("Payment settled on chain");
    // The word that must NOT be the outcome.
    expect(state.headline.toLowerCase()).not.toContain("reject");
    expect(state.status.toLowerCase()).not.toContain("reject");
  });

  it("reports PAID for an ordinary invoice the chain records as settled", () => {
    // No escrow, no local receipt — the payment happened in another session.
    const state = availablePaymentAction(
      input({ autonomy: REJECTED, chainInvoiceStatus: "PAID", amountCents: 300_000 }),
    );

    expect(state.headline).toBe("PAID");
    expect(state.status).toBe("Paid");
    expect(state.settled).toBe(true);
    expect(state.detail).toContain("Payment already made");
    expect(state.facts).toContain("No further payment action available");
  });

  it("offers no payment control once settled, by either route", () => {
    for (const settled of [
      input({ autonomy: REJECTED, conditionStage: "RELEASED", chainInvoiceStatus: "PAID" }),
      input({ autonomy: PAY_NOW, chainInvoiceStatus: "PAID" }),
      input({ autonomy: NEEDS_HUMAN, chainInvoiceStatus: "PAID" }),
    ]) {
      const state = availablePaymentAction(settled);
      expect(offersPaymentControl(state)).toBe(false);
      expect(state.action).toBe("NONE");
      expect(state.label).toBeNull();
    }
  });

  it("is not overridden by ANY recommendation", () => {
    // The invariant stated directly: whatever the AI concluded, a settled
    // invoice reports as settled.
    for (const autonomy of [PAY_NOW, NEEDS_HUMAN, REJECTED]) {
      const state = availablePaymentAction(input({ autonomy, chainInvoiceStatus: "PAID" }));
      expect(state.settled).toBe(true);
      expect(state.headline).toBe("PAID");
    }
  });
});

describe("an unsettled invoice", () => {
  it("reports PAYMENT HELD while the escrow waits on a shipment", () => {
    // Committed and not settled. Neither payment nor rejection.
    const state = availablePaymentAction(
      input({
        conditionStage: "HELD",
        fundsHeldCents: 400_000,
        amountCents: 400_000,
        chainInvoiceStatus: "ESCROWED",
      }),
    );

    expect(state.headline).toBe("PAYMENT HELD");
    expect(state.settled).toBe(false);
    expect(state.fundsLocked).toBe(true);
    expect(state.detail).toContain("$4,000");
    expect(state.facts).toContain("Shipment confirmation has not been received");
    expect(offersPaymentControl(state)).toBe(false);
    // Held is not rejected, and it is not paid either.
    expect(state.headline.toLowerCase()).not.toContain("reject");
    expect(state.headline.toLowerCase()).not.toContain("paid");
  });

  it("does not treat ESCROWED as settlement", () => {
    // The treasury has parted with the money and the supplier does not have it.
    const state = availablePaymentAction(
      input({ conditionStage: "ESCROWED", fundsHeldCents: 400_000, chainInvoiceStatus: "ESCROWED" }),
    );

    expect(state.settled).toBe(false);
    expect(state.fundsLocked).toBe(true);
  });

  it("reports APPROVED · ready to execute for an unpaid AUTO_PAY invoice", () => {
    const state = availablePaymentAction(input({ chainInvoiceStatus: "PENDING" }));

    expect(state.headline).toBe("APPROVED");
    expect(state.status).toBe("Approved · ready to execute");
    expect(state.action).toBe("EXECUTE_PAYMENT");
    expect(state.label).toBe("Execute payment");
    expect(state.settled).toBe(false);
    // Authorized is not executed. No transaction exists yet.
    expect(state.detail).toContain("No payment has been submitted yet");
  });

  it("reports HUMAN APPROVAL REQUIRED above the autonomous limit", () => {
    const state = availablePaymentAction(
      input({ autonomy: NEEDS_HUMAN, amountCents: 3_000_000, chainInvoiceStatus: "PENDING" }),
    );

    expect(state.headline).toBe("HUMAN APPROVAL REQUIRED");
    // The checks DID pass; what failed is the agent's authority to act alone.
    expect(state.lead).toBe("Policy checks passed");
    expect(state.action).toBe("APPROVE");
    expect(state.label).toBe("Approve payment");
    expect(state.settled).toBe(false);
  });

  it("reports REJECTED with no action for a rejection that never paid", () => {
    const suiRefused = decideAutonomy({
      action: "AUTO_PAY",
      finalOutcome: "SUI_REJECT",
      hasPaymentRequest: true,
      enforcement: { outcome: "SUI_REJECT" },
      conditional: false,
    });

    const state = availablePaymentAction(
      input({ autonomy: suiRefused, amountCents: 800_000, chainInvoiceStatus: "PENDING" }),
    );

    expect(state.headline).toBe("REJECTED");
    expect(state.settled).toBe(false);
    expect(state.facts).toContain("No payment action available");
    expect(offersPaymentControl(state)).toBe(false);
  });
});

describe("what counts as settled", () => {
  it("does not read ESCROWED as paid", () => {
    expect(availablePaymentAction(input({ chainInvoiceStatus: "ESCROWED" })).settled).toBe(false);
  });

  it("does not read PENDING or APPROVED as paid", () => {
    for (const status of ["PENDING", "APPROVED", "SCHEDULED", "UNKNOWN", null]) {
      expect(availablePaymentAction(input({ chainInvoiceStatus: status })).settled).toBe(false);
    }
  });

  it("still reports a locally executed payment when the chain read fails", () => {
    // Degraded, not wrong: an unreachable endpoint sends chainInvoiceStatus
    // null, and the local receipt still establishes settlement.
    const state = availablePaymentAction(
      input({ autonomy: REJECTED, chainInvoiceStatus: null, runStatus: "PAID", hasReceipt: true }),
    );

    expect(state.settled).toBe(true);
    expect(state.headline).toBe("PAID");
  });
});
