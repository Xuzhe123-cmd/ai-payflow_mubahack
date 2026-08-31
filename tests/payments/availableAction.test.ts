/**
 * What the interface may offer, given where the payment actually is.
 *
 * THE INVARIANT: "AI says PAY NOW" does not mean an execute control is
 * available. The recommendation says what should happen; the chain says what
 * already has. An invoice recommended for payment may by now be escrowed, held,
 * or settled, and the button must answer to the second.
 *
 * So the tests are mostly about precedence. Every case below pairs an
 * enthusiastic recommendation — AUTO_PAY, approved, autonomous — with a chain
 * state that has moved on, and asserts the chain wins. A pass means the screen
 * cannot offer to pay something that is already paid.
 */

import { describe, expect, it } from "vitest";

import { decideAutonomy } from "../../lib/payments/autonomy";
import {
  availablePaymentAction,
  offersPaymentControl,
  type AvailableActionInput,
} from "../../lib/payments/availableAction";
import type { EscrowDemoStage } from "../../lib/escrow/demoFlow";

/** The most permissive recommendation there is: pay now, approved, autonomous. */
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
    runStatus: "ANALYZED",
    hasReceipt: false,
    ...overrides,
  };
}

describe("chain state overrides the recommendation", () => {
  // Every case here carries the SAME enthusiastic recommendation.
  const overriding: [EscrowDemoStage, string][] = [
    ["RELEASED", "Payment released"],
    ["HELD", "Payment held — awaiting confirmed shipment"],
    ["ESCROWED", "Payment locked in escrow"],
    ["PROOF_SUBMITTED", "Payment locked in escrow"],
    ["ATTESTED", "Shipment confirmed — releasable"],
  ];

  it.each(overriding)("offers no control when the chain says %s", (stage, status) => {
    const state = availablePaymentAction(
      input({ conditionStage: stage, fundsHeldCents: 400_000 }),
    );
    expect(state.status).toBe(status);
    expect(state.action).toBe("NONE");
    expect(state.label).toBeNull();
    expect(offersPaymentControl(state)).toBe(false);
  });

  it("never offers Execute after a release, however keen the AI was", () => {
    // Demo A. The recommendation still says AUTO_PAY; the escrow says RELEASED.
    const state = availablePaymentAction(input({ conditionStage: "RELEASED" }));
    expect(offersPaymentControl(state)).toBe(false);
    expect(state.detail).toMatch(/released from escrow to .*supplier/i);
    expect(state.fundsLocked).toBe(false);
  });

  it("never offers Execute or Release on a held escrow", () => {
    // Demo B. The requirement in one assertion.
    const state = availablePaymentAction(
      input({ conditionStage: "HELD", amountCents: 400_000, fundsHeldCents: 400_000 }),
    );
    expect(offersPaymentControl(state)).toBe(false);
    expect(state.fundsLocked).toBe(true);
    expect(state.detail).toContain("$4,000");
    expect(state.detail).toMatch(/authorized, but the supplier is not paid/i);
    // Held is not refused.
    expect(state.status).not.toMatch(/reject|fail/i);
  });

  it("reports the held amount from the chain, not from the recommendation", () => {
    const state = availablePaymentAction(
      input({ conditionStage: "HELD", amountCents: 999_999, fundsHeldCents: 400_000 }),
    );
    expect(state.detail).toContain("$4,000");
    expect(state.detail).not.toContain("$9,999");
  });
});

describe("a conditional invoice before anything is committed", () => {
  it("offers Start conditional payment, not Execute payment", () => {
    const state = availablePaymentAction(input({ conditionStage: "READY" }));
    expect(state.action).toBe("START_CONDITIONAL_PAYMENT");
    expect(state.label).toBe("Start conditional payment");
    expect(offersPaymentControl(state)).toBe(true);
  });

  it("offers nothing when the agent is not authorized for it", () => {
    const state = availablePaymentAction(
      input({ conditionStage: "READY", autonomy: NEEDS_HUMAN }),
    );
    expect(state.action).not.toBe("START_CONDITIONAL_PAYMENT");
  });
});

describe("an ordinary invoice", () => {
  it("shows no control once it has settled", () => {
    for (const settled of [{ runStatus: "PAID" as const }, { hasReceipt: true }]) {
      const state = availablePaymentAction(input(settled));
      expect(state.status).toBe("Paid");
      expect(offersPaymentControl(state)).toBe(false);
      expect(state.detail).toMatch(/nothing left to execute/i);
    }
  });

  it("is APPROVED and ready to execute — not executing", () => {
    // The correction. AUTO_PAY means the agent MAY settle this, not that it
    // has. Saying "executing" claimed a transaction that did not exist.
    const state = availablePaymentAction(input());
    expect(state.status).toBe("Authorized · ready to execute");
    expect(state.action).toBe("EXECUTE_PAYMENT");
    expect(state.label).toBe("Execute payment");
    expect(offersPaymentControl(state)).toBe(true);
    expect(state.detail).toMatch(/no payment has been submitted yet/i);
  });

  it("never says executing, paid or released before a transaction exists", () => {
    const state = availablePaymentAction(input());
    const text = `${state.status} ${state.detail}`;
    expect(text).not.toMatch(/executing/i);
    expect(text).not.toMatch(/paid/i);
    expect(text).not.toMatch(/released/i);
    expect(text).not.toMatch(/settled/i);
  });

  it("says PAYMENT PROCESSING only once a transaction has been submitted", () => {
    const state = availablePaymentAction(input({ runStatus: "EXECUTING" }));
    expect(state.status).toBe("Payment processing");
    expect(state.detail).toMatch(/has been submitted/i);
    expect(offersPaymentControl(state)).toBe(false);
  });

  it("keeps the human control above the threshold", () => {
    const state = availablePaymentAction(input({ autonomy: NEEDS_HUMAN }));
    expect(state.action).toBe("APPROVE");
    expect(state.label).toBe("Approve payment");
    expect(state.status).toBe("Awaiting approval");
    expect(offersPaymentControl(state)).toBe(true);
  });

  it("shows no control when there is no payment at all", () => {
    const rejected = decideAutonomy({
      action: "REJECT",
      finalOutcome: "REJECTED",
      hasPaymentRequest: false,
      enforcement: null,
      conditional: false,
    });
    const state = availablePaymentAction(input({ autonomy: rejected }));
    expect(offersPaymentControl(state)).toBe(false);
  });
});

describe("precedence is chain, then settlement, then recommendation", () => {
  it("prefers a settled payment over a ready-to-execute recommendation", () => {
    // INV-2026-3468 once it has been paid: no button, whatever the AI said.
    const state = availablePaymentAction(input({ runStatus: "PAID" }));
    expect(state.status).toBe("Paid");
    expect(offersPaymentControl(state)).toBe(false);
  });

  it("prefers a released escrow over a PAID run status", () => {
    const state = availablePaymentAction(
      input({ conditionStage: "RELEASED", runStatus: "PAID", hasReceipt: true }),
    );
    // Both agree nothing is offered; the escrow's wording is the accurate one.
    expect(state.status).toBe("Payment released");
    expect(offersPaymentControl(state)).toBe(false);
  });

  it("prefers a held escrow over an autonomous recommendation", () => {
    const state = availablePaymentAction(input({ conditionStage: "HELD", runStatus: "ANALYZED" }));
    expect(state.status).toMatch(/held/i);
  });

  it("only consults the recommendation when the chain is silent", () => {
    // No condition on this invoice at all — an ordinary payment.
    const state = availablePaymentAction(input({ conditionStage: null }));
    expect(state.status).toBe("Authorized · ready to execute");
  });

  it("offers no control in any settled or committed state", () => {
    // Execute, approve and start-conditional are the three controls. Every
    // state below has moved past the point where any of them make sense.
    const cases: Partial<AvailableActionInput>[] = [
      { runStatus: "PAID" },
      { runStatus: "EXECUTING" },
      { hasReceipt: true },
      { conditionStage: "RELEASED" },
      { conditionStage: "HELD" },
      { conditionStage: "ESCROWED" },
      { conditionStage: "PROOF_SUBMITTED" },
      { conditionStage: "ATTESTED" },
    ];
    for (const overrides of cases) {
      expect(
        offersPaymentControl(availablePaymentAction(input(overrides))),
        JSON.stringify(overrides),
      ).toBe(false);
    }

    // The three states that DO offer one.
    expect(availablePaymentAction(input()).action).toBe("EXECUTE_PAYMENT");
    expect(availablePaymentAction(input({ autonomy: NEEDS_HUMAN })).action).toBe("APPROVE");
    expect(availablePaymentAction(input({ conditionStage: "READY" })).action).toBe(
      "START_CONDITIONAL_PAYMENT",
    );
  });
});

/**
 * The human-approval flow, which is two acts and not one.
 *
 * Approving records that a person authorized the amount. It pays nothing: the
 * chain re-runs all ten checks under the approver's limits and can still refuse.
 * Execution is a separate, later act. Collapsing them would make "approve" mean
 * "pay", which is the opposite of what an approval control is for.
 */
describe("above the autonomous limit, a person authorizes and then executes", () => {
  it("offers Approve, not Execute, before anyone has approved", () => {
    // INV-2026-3461: $30,000 against a $5,000 cap, every other check passing.
    const state = availablePaymentAction(
      input({ autonomy: NEEDS_HUMAN, amountCents: 3_000_000 }),
    );
    expect(state.action).toBe("APPROVE");
    expect(state.label).toBe("Approve payment");
    expect(state.status).toBe("Awaiting approval");
    expect(state.detail).toMatch(/above the agent's autonomous threshold/i);
    // It must not offer to execute something nobody has authorized.
    expect(state.action).not.toBe("EXECUTE_PAYMENT");
  });

  it("never claims the agent is authorized for it", () => {
    const state = availablePaymentAction(input({ autonomy: NEEDS_HUMAN }));
    const text = `${state.status} ${state.detail}`;
    expect(text).not.toMatch(/agent authorized/i);
    expect(text).not.toMatch(/autonomous(ly)? (execut|settl)/i);
  });

  it("moves to ready-to-execute once a human approved AND the chain agreed", () => {
    const state = availablePaymentAction(
      input({
        autonomy: NEEDS_HUMAN,
        amountCents: 3_000_000,
        humanApproval: { outcome: "APPROVED" },
      }),
    );
    // Authorized, not executed — the same state as the autonomous case, so
    // the same words. WHO authorized it is carried by the lead.
    expect(state.status).toBe("Authorized · ready to execute");
    expect(state.lead).toBe("Approved by a person · policy checks passed");
    expect(state.action).toBe("EXECUTE_PAYMENT");
    expect(state.label).toBe("Execute payment");
  });

  it("does NOT mark the invoice paid on approval", () => {
    // The requirement stated exactly: approving grants authorization, and the
    // payment has still not been submitted.
    const state = availablePaymentAction(
      input({ autonomy: NEEDS_HUMAN, humanApproval: { outcome: "APPROVED" } }),
    );
    expect(state.status).not.toMatch(/paid/i);
    expect(state.detail).toMatch(/no payment has been submitted yet/i);
    expect(state.fundsLocked).toBe(false);
  });

  it("refuses when the preflight says no, and does not pretend anyone approved", () => {
    // SUI_REJECT is reached BEFORE any approval is minted, so this test used to
    // carry the same false premise the UI did — its own name said "a person
    // approved". Nobody did. The security claim it guards is still the real
    // one: approval raises WHOSE limit applies, never the limit itself.
    const state = availablePaymentAction(
      input({ autonomy: NEEDS_HUMAN, humanApproval: { outcome: "SUI_REJECT" } }),
    );
    expect(state.action).toBe("NONE");
    expect(offersPaymentControl(state)).toBe(false);
    expect(state.detail).toMatch(/raises WHOSE limit applies, never the limit itself/i);
    expect(state.detail).toMatch(/no human approval transaction was submitted/i);
  });

  it("never claims a transaction was submitted or rejected on chain", () => {
    // SUI_REJECT is the verdict of the policy mirror and the preflight. Nothing
    // reached a validator, so no field may describe a chain event or a
    // settlement — "REJECTED ON CHAIN" beside a $30,000 figure read as a
    // payment that failed rather than one never attempted.
    const state = availablePaymentAction(
      input({ autonomy: NEEDS_HUMAN, humanApproval: { outcome: "SUI_REJECT" } }),
    );
    const text = [state.headline, state.status, state.detail, state.lead ?? "", ...state.facts]
      .join(" ")
      .toLowerCase();

    expect(state.headline).toBe("WOULD BE REFUSED BY SUI");
    expect(text).not.toContain("refused on chain");
    expect(text).not.toContain("rejected on chain");
    expect(text).toContain("no transaction was submitted");
    expect(text).toContain("no funds moved");
    // And the security claim survives the rewording.
    expect(text).toContain("does not bypass treasury policy");
  });

  it("stops entirely when a person declined", () => {
    const state = availablePaymentAction(input({ autonomy: NEEDS_HUMAN, humanRejected: true }));
    expect(state.action).toBe("NONE");
    expect(state.status).toBe("Declined by operator");
  });

  it("within the autonomous limit, offers Execute and never Approve", () => {
    const state = availablePaymentAction(input());
    expect(state.action).toBe("EXECUTE_PAYMENT");
    expect(state.action).not.toBe("APPROVE");
  });
});

describe("chain state still overrides an approval", () => {
  it.each(["RELEASED", "HELD", "ESCROWED", "PROOF_SUBMITTED"] as const)(
    "offers nothing on a %s escrow, even after a human approved",
    (stage) => {
      const state = availablePaymentAction(
        input({
          autonomy: NEEDS_HUMAN,
          humanApproval: { outcome: "APPROVED" },
          conditionStage: stage,
          fundsHeldCents: 400_000,
        }),
      );
      expect(offersPaymentControl(state)).toBe(false);
    },
  );

  it("offers nothing once the payment has settled, even after a human approved", () => {
    const state = availablePaymentAction(
      input({
        autonomy: NEEDS_HUMAN,
        humanApproval: { outcome: "APPROVED" },
        runStatus: "PAID",
      }),
    );
    expect(state.status).toBe("Paid");
    expect(offersPaymentControl(state)).toBe(false);
  });

  it("offers nothing while an approved payment is processing", () => {
    const state = availablePaymentAction(
      input({
        autonomy: NEEDS_HUMAN,
        humanApproval: { outcome: "APPROVED" },
        runStatus: "EXECUTING",
      }),
    );
    expect(state.status).toBe("Payment processing");
    expect(offersPaymentControl(state)).toBe(false);
  });
});
