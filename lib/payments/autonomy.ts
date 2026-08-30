/**
 * Whether the agent may act without a person.
 *
 * The interface has been asking a human to press "Execute payment" on invoices
 * the agent was already authorised to settle alone, which contradicts the whole
 * claim: an agent that needs a click for a $4,800 payment inside its own
 * $5,000 cap is not autonomous, it is a form with extra steps.
 *
 * What this does NOT do is loosen anything. Autonomy removes the CLICK, never a
 * check. The conditions below are strictly narrower than the execute gate that
 * already exists — a payment request must exist, the chain must have approved
 * it, and the authority must be the agent's own. A payment above the threshold
 * still waits for a person, because `finalOutcome` says AWAITING_APPROVAL and
 * that is not on this list.
 *
 * Read the four outcomes as four different sentences:
 *   EXECUTED           the agent may settle this itself, now
 *   ESCROWED           the agent may commit the funds itself; release is not its call
 *   AWAITING_APPROVAL  every check passes, and a person must still authorise it
 *   anything else      no payment is made at all
 */

import type { FinalOutcome, PolicyEnforcementResult, TreasuryAction } from "../types";

export type AutonomousAction =
  /** Settle directly, under the agent's own capability. */
  | "EXECUTE"
  /** Commit the funds to escrow; the oracle decides whether they ever land. */
  | "LOCK_ESCROW";

export type AutonomyVerdict =
  | { kind: "AUTONOMOUS"; action: AutonomousAction; reason: string }
  /** A person must act. The interface shows a control; the agent does not. */
  | { kind: "NEEDS_HUMAN"; reason: string }
  /** Nothing to execute — refused, escalated, or never proposed. */
  | { kind: "NO_PAYMENT"; reason: string };

export interface AutonomyInput {
  action: TreasuryAction;
  finalOutcome: FinalOutcome;
  /** Null when the recommendation never produced one. */
  hasPaymentRequest: boolean;
  enforcement: Pick<PolicyEnforcementResult, "outcome"> | null;
  /** True when the invoice settles only against a confirmed shipment. */
  conditional: boolean;
  /** A human declining is final, whatever the agent could otherwise do. */
  humanRejected?: boolean;
}

/**
 * The decision, in one place, for both the interface and the provider.
 *
 * Deliberately conservative at every branch: anything it cannot positively
 * establish comes back NEEDS_HUMAN or NO_PAYMENT. An agent that acts on a
 * missing enforcement result is worse than one that asks.
 */
export function decideAutonomy(input: AutonomyInput): AutonomyVerdict {
  if (input.humanRejected) {
    return { kind: "NO_PAYMENT", reason: "A person declined this payment." };
  }

  // The chain's answer is the gate, exactly as it was before autonomy existed.
  if (!input.hasPaymentRequest) {
    return {
      kind: "NO_PAYMENT",
      reason: `The AI chose ${input.action}, which never creates a payment request.`,
    };
  }
  if (input.enforcement?.outcome !== "APPROVED") {
    return {
      kind: "NO_PAYMENT",
      reason: "Sui refused this payment, so there is nothing to execute.",
    };
  }

  switch (input.finalOutcome) {
    case "EXECUTED":
      // AUTO_PAY, inside the agent's own limits, every check passed.
      return input.conditional
        ? {
            kind: "AUTONOMOUS",
            action: "LOCK_ESCROW",
            reason:
              "The agent is authorized to commit these funds itself. The shipment condition " +
              "decides whether they ever reach the supplier.",
          }
        : {
            kind: "AUTONOMOUS",
            action: "EXECUTE",
            reason: "The agent is authorized to settle this payment without a human.",
          };

    case "AWAITING_APPROVAL":
      // Above the threshold. The agent may not, however clean the invoice is.
      return {
        kind: "NEEDS_HUMAN",
        reason:
          "Every on-chain check passes, but this amount is above the agent's autonomous " +
          "threshold. A person must authorize it.",
      };

    case "SCHEDULED":
      // A scheduled payment is an intent for a later date, not a settlement to
      // make now. It is left alone rather than executed early.
      return {
        kind: "NO_PAYMENT",
        reason: "Scheduled for a later date; nothing settles today.",
      };

    default:
      return {
        kind: "NO_PAYMENT",
        reason: `Final outcome ${input.finalOutcome} does not settle a payment.`,
      };
  }
}

/** Whether the interface should offer a human-operated execute control. */
export function showsHumanExecuteControl(verdict: AutonomyVerdict): boolean {
  return verdict.kind === "NEEDS_HUMAN";
}

/**
 * Whether the agent should act on its own as soon as analysis completes.
 *
 * The provider calls this once per invoice. It is a pure predicate so the
 * "does a human have to press anything?" question has one answer that the
 * screen and the runtime cannot disagree about.
 */
export function shouldActAutonomously(verdict: AutonomyVerdict): boolean {
  return verdict.kind === "AUTONOMOUS";
}
