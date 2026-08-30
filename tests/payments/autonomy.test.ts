/**
 * Whether the agent acts, or a person does.
 *
 * The interface used to ask a human to press "Execute payment" on invoices the
 * agent was already authorised to settle alone — which contradicts the claim
 * the product makes. An agent that needs a click for a $4,800 payment inside
 * its own $5,000 cap is not autonomous.
 *
 * The risk in fixing that is obvious, so it is what most of these test: autonomy
 * must remove the CLICK and never a CHECK. A payment above the threshold must
 * still wait for a person, a refused payment must still be refused, and nothing
 * may execute without the chain having approved it first.
 */

import { describe, expect, it } from "vitest";

import {
  decideAutonomy,
  shouldActAutonomously,
  showsHumanExecuteControl,
  type AutonomyInput,
} from "../../lib/payments/autonomy";

function input(overrides: Partial<AutonomyInput> = {}): AutonomyInput {
  return {
    action: "AUTO_PAY",
    finalOutcome: "EXECUTED",
    hasPaymentRequest: true,
    enforcement: { outcome: "APPROVED" },
    conditional: false,
    ...overrides,
  };
}

describe("AUTO_PAY inside the agent's authority", () => {
  it("executes without a human", () => {
    const verdict = decideAutonomy(input());
    expect(verdict.kind).toBe("AUTONOMOUS");
    expect(verdict.kind === "AUTONOMOUS" && verdict.action).toBe("EXECUTE");
    expect(shouldActAutonomously(verdict)).toBe(true);
  });

  it("shows no human execute control", () => {
    expect(showsHumanExecuteControl(decideAutonomy(input()))).toBe(false);
  });

  it("locks escrow rather than paying when the invoice is conditional", () => {
    const verdict = decideAutonomy(input({ conditional: true }));
    expect(verdict.kind).toBe("AUTONOMOUS");
    expect(verdict.kind === "AUTONOMOUS" && verdict.action).toBe("LOCK_ESCROW");
    // The agent commits the funds; whether they ever land is not its call.
    expect(verdict.kind === "AUTONOMOUS" && verdict.reason).toMatch(/shipment condition/i);
  });
});

describe("autonomy removes the click, never a check", () => {
  it("refuses to act when Sui did not approve", () => {
    for (const outcome of ["SUI_REJECT"] as const) {
      const verdict = decideAutonomy(input({ enforcement: { outcome } }));
      expect(verdict.kind).toBe("NO_PAYMENT");
      expect(shouldActAutonomously(verdict)).toBe(false);
    }
  });

  it("refuses to act when there is no enforcement result at all", () => {
    // An agent that acts on a missing answer is worse than one that asks.
    const verdict = decideAutonomy(input({ enforcement: null }));
    expect(verdict.kind).toBe("NO_PAYMENT");
  });

  it("refuses to act when no payment request was ever created", () => {
    const verdict = decideAutonomy(
      input({ hasPaymentRequest: false, action: "HUMAN_REVIEW", finalOutcome: "HUMAN_REVIEW" }),
    );
    expect(verdict.kind).toBe("NO_PAYMENT");
    expect(verdict.reason).toMatch(/never creates a payment request/i);
  });

  it("refuses to act after a person declined", () => {
    const verdict = decideAutonomy(input({ humanRejected: true }));
    expect(verdict.kind).toBe("NO_PAYMENT");
    expect(verdict.reason).toMatch(/declined/i);
  });
});

describe("above the threshold, a person still decides", () => {
  it("returns NEEDS_HUMAN for AWAITING_APPROVAL", () => {
    // The $30,000 case. Every check passes and the agent still may not.
    const verdict = decideAutonomy(
      input({ action: "SCHEDULE", finalOutcome: "AWAITING_APPROVAL" }),
    );
    expect(verdict.kind).toBe("NEEDS_HUMAN");
    expect(shouldActAutonomously(verdict)).toBe(false);
    expect(showsHumanExecuteControl(verdict)).toBe(true);
  });

  it("says why, in terms of the threshold rather than the invoice", () => {
    const verdict = decideAutonomy(
      input({ action: "SCHEDULE", finalOutcome: "AWAITING_APPROVAL" }),
    );
    expect(verdict.reason).toMatch(/above the agent's autonomous threshold/i);
    expect(verdict.reason).toMatch(/every on-chain check passes/i);
  });

  it("never turns an approval requirement into an autonomous one", () => {
    // The most important negative here: no combination of inputs may promote
    // AWAITING_APPROVAL to AUTONOMOUS.
    for (const conditional of [true, false]) {
      for (const action of ["AUTO_PAY", "SCHEDULE"] as const) {
        const verdict = decideAutonomy(
          input({ action, conditional, finalOutcome: "AWAITING_APPROVAL" }),
        );
        expect(verdict.kind, `${action}/${conditional}`).toBe("NEEDS_HUMAN");
      }
    }
  });
});

describe("everything else settles nothing", () => {
  it("does not act on a refused or escalated invoice", () => {
    for (const finalOutcome of ["REJECTED", "SUI_REJECT", "HUMAN_REVIEW"] as const) {
      const verdict = decideAutonomy(input({ finalOutcome }));
      expect(verdict.kind, finalOutcome).toBe("NO_PAYMENT");
      expect(shouldActAutonomously(verdict), finalOutcome).toBe(false);
    }
  });

  it("does not execute a scheduled payment early", () => {
    // SCHEDULED is an intent for a later date, not a settlement to make now.
    const verdict = decideAutonomy(input({ action: "SCHEDULE", finalOutcome: "SCHEDULED" }));
    expect(verdict.kind).toBe("NO_PAYMENT");
    expect(verdict.reason).toMatch(/later date/i);
  });

  it("offers no human control for anything it refuses", () => {
    for (const finalOutcome of ["REJECTED", "SUI_REJECT", "HUMAN_REVIEW", "SCHEDULED"] as const) {
      expect(showsHumanExecuteControl(decideAutonomy(input({ finalOutcome }))), finalOutcome).toBe(
        false,
      );
    }
  });
});

describe("the three cases are mutually exclusive", () => {
  it("never both acts autonomously and asks for a human", () => {
    const cases: Partial<AutonomyInput>[] = [
      {},
      { conditional: true },
      { finalOutcome: "AWAITING_APPROVAL" },
      { finalOutcome: "REJECTED" },
      { finalOutcome: "SCHEDULED" },
      { enforcement: { outcome: "SUI_REJECT" } },
      { hasPaymentRequest: false },
      { humanRejected: true },
    ];
    for (const overrides of cases) {
      const verdict = decideAutonomy(input(overrides));
      const autonomous = shouldActAutonomously(verdict);
      const human = showsHumanExecuteControl(verdict);
      expect(autonomous && human, JSON.stringify(overrides)).toBe(false);
    }
  });
});
