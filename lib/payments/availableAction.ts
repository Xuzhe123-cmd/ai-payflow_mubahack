/**
 * What the interface may offer, given where the payment actually is.
 *
 * THE INVARIANT THIS EXISTS FOR: "AI says PAY NOW" does not mean an execute
 * control is available — and, just as importantly, "AI says REJECT" does not
 * mean the invoice is unpaid. The recommendation describes what the AI thinks
 * should happen NEXT; the chain describes what has already happened. When they
 * disagree the chain wins, and it disagrees constantly.
 *
 * The second half of that is the subtler failure, and it is real: an invoice
 * that has already settled makes the deterministic guard refuse a further
 * payment, because paying it twice would be a duplicate. Reading that refusal
 * as the settlement state turns "$4,800 was released to the supplier" into
 * "Rejected" — the exact opposite of what happened.
 *
 *   CHAIN SETTLEMENT → ESCROW STATE → AI RECOMMENDATION → AVAILABLE ACTION
 *
 * So the order below is deliberate and load-bearing. Settlement is consulted
 * FIRST, then escrow, and the recommendation only gets a say once neither has
 * anything to report. The last box controls the button, and this function is
 * that box.
 */

import type { AutonomyVerdict } from "./autonomy";
import type { EscrowDemoStage } from "../escrow/demoFlow";
import type { Cents } from "../types";

export type PaymentActionKind =
  /**
   * Authorized and not yet executed. The control SUBMITS the payment — it does
   * not acknowledge one that already happened.
   */
  | "EXECUTE_PAYMENT"
  /** A person must authorize this. The only control the agent cannot replace. */
  | "APPROVE"
  /** Commit funds to escrow. Offered only before an escrow exists. */
  | "START_CONDITIONAL_PAYMENT"
  /** Nothing for anyone to press. */
  | "NONE";

export interface PaymentActionState {
  action: PaymentActionKind;
  /** Button text, or null when there is no button. */
  label: string | null;
  /**
   * The large word, in the interface's own voice. Says where the payment IS.
   * Never derived from the recommendation.
   */
  headline: string;
  /** A smaller line ABOVE the headline, where one is needed to set it up. */
  lead: string | null;
  /** The sentence-case form of the headline, for compact surfaces and tests. */
  status: string;
  detail: string;
  /** Short lines stating what the chain establishes. May be empty. */
  facts: string[];
  tone: "neutral" | "chain" | "warning" | "positive" | "negative";
  /** True while funds have left the treasury and the supplier lacks them. */
  fundsLocked: boolean;
  /**
   * The chain has settled this invoice: the supplier has the money.
   *
   * Exposed because it is the claim the AI must never be able to contradict. A
   * settled invoice stays settled however the guard rules on paying it again.
   */
  settled: boolean;
}

export interface AvailableActionInput {
  /** What the recommendation and the guard concluded. Advisory here. */
  autonomy: AutonomyVerdict;
  /**
   * The escrow stage from chain, or null when this invoice carries no shipment
   * condition at all. Null is not "no escrow yet" — it is "not conditional".
   */
  conditionStage: EscrowDemoStage | null;
  /** What the escrow still holds, when one exists. */
  fundsHeldCents: Cents;
  amountCents: Cents;
  /**
   * The invoice object's OWN status on chain. Highest precedence there is.
   *
   * PAID here means the chain recorded a settlement — which may have happened
   * in an earlier session, or before this browser ever loaded. It is the one
   * fact that cannot be inferred from anything local.
   */
  chainInvoiceStatus?: string | null;
  /** The local run's own status, for the non-conditional path. */
  runStatus: "DETECTED" | "ANALYZING" | "ANALYZED" | "EXECUTING" | "PAID" | "FAILED";
  /** Set once a payment has actually settled. */
  hasReceipt: boolean;
  /** Who the money went to, when it is worth naming. */
  supplierName?: string | null;
  /**
   * The result of a human approval, once one has been sought.
   *
   * `null` means nobody has approved yet. An approval that the CHAIN refused is
   * not an approval: `/api/approve` re-runs the same ten checks under the
   * approver's limits, and a person saying yes to a payment Sui refuses changes
   * nothing. So the granted flag reads the enforcement outcome, not the click.
   */
  humanApproval?: { outcome: "APPROVED" | "SUI_REJECT" } | null;
  /** A person declined outright. Terminal. */
  humanRejected?: boolean;
}

export function availablePaymentAction(input: AvailableActionInput): PaymentActionState {
  const amount = money(input.amountCents);
  const held = money(input.fundsHeldCents);
  const supplier = input.supplierName ?? "the registered supplier";

  // ---- 1. CHAIN SETTLEMENT -------------------------------------------------
  // The money has moved. Nothing the AI recommends can make this untrue, and a
  // guard refusing a SECOND payment is not this invoice being rejected.

  if (input.conditionStage === "RELEASED") {
    return {
      action: "NONE",
      label: null,
      headline: "PAYMENT RELEASED",
      lead: null,
      status: "Payment released",
      detail: `${amount} released from escrow to ${supplier}.`,
      // The chain of facts that produced the release, in the order it happened,
      // so a reader can see it occurred ONCE rather than inferring a retry.
      facts: [
        "Shipment confirmed",
        "Oracle attestation confirmed",
        "Escrow condition satisfied",
        "Payment settled on chain",
        "No further payment action available",
      ],
      tone: "positive",
      fundsLocked: false,
      settled: true,
    };
  }

  if (isPaidOnChain(input.chainInvoiceStatus)) {
    // An ordinary invoice the chain records as settled — possibly by a previous
    // session. The local run knows nothing about it, which is exactly why the
    // invoice object is asked rather than the run.
    return {
      action: "NONE",
      label: null,
      headline: "PAID",
      lead: null,
      status: "Paid",
      detail: `Payment already made. ${amount} settled on chain to ${supplier}.`,
      facts: ["Payment settled on chain", "No further payment action available"],
      tone: "positive",
      fundsLocked: false,
      settled: true,
    };
  }

  // ---- 2. ESCROW STATE -----------------------------------------------------
  // Committed but not settled. The money has left the treasury and the supplier
  // does not have it — which is neither payment nor rejection.
  switch (input.conditionStage) {
    case "HELD":
      return {
        action: "NONE",
        label: null,
        headline: "PAYMENT HELD",
        lead: null,
        status: "Payment held — awaiting confirmed shipment",
        detail:
          `${held} remains protected in escrow. The payment is authorized, but the supplier ` +
          "is not paid until the real-world condition is proven.",
        facts: [
          "Shipment confirmation has not been received",
          "Funds are held by the escrow, not by the supplier",
          "No payment action available",
        ],
        tone: "warning",
        fundsLocked: true,
        settled: false,
      };

    case "ESCROWED":
    case "PROOF_SUBMITTED":
      return {
        action: "NONE",
        label: null,
        headline: "PAYMENT LOCKED IN ESCROW",
        lead: null,
        status: "Payment locked in escrow",
        detail: `${held} has left the treasury and is held against the shipment condition.`,
        facts: [
          "Shipment confirmation has not been received",
          "No payment action available",
        ],
        tone: "warning",
        fundsLocked: true,
        settled: false,
      };

    case "ATTESTED":
      // Releasable — but the release runs from the escrow flow, not from here.
      return {
        action: "NONE",
        label: null,
        headline: "SHIPMENT CONFIRMED",
        lead: null,
        status: "Shipment confirmed — releasable",
        detail: `${held} is held and the oracle has attested the shipment. Release runs from the escrow view.`,
        facts: ["Escrow condition satisfied", "Funds have not yet reached the supplier"],
        tone: "chain",
        fundsLocked: true,
        settled: false,
      };

    case "READY":
      // Conditional, authorised, nothing committed yet. The one case where a
      // conditional invoice offers a control at all.
      if (input.autonomy.kind === "AUTONOMOUS") {
        return {
          action: "START_CONDITIONAL_PAYMENT",
          label: "Start conditional payment",
          headline: "AUTHORIZED",
          lead: "Policy checks passed",
          status: "Authorized — not yet committed",
          detail: `${amount} will be locked in escrow until the shipment is confirmed.`,
          facts: ["Nothing has been committed yet"],
          tone: "chain",
          fundsLocked: false,
          settled: false,
        };
      }
      break;

    case null:
    case undefined:
      break;
  }

  // ---- 3. A settled ordinary payment, as the local run saw it ---------------
  if (input.runStatus === "PAID" || input.hasReceipt) {
    return {
      action: "NONE",
      label: null,
      headline: "PAID",
      lead: null,
      status: "Paid",
      detail: `${amount} has settled. There is nothing left to execute.`,
      facts: ["Payment settled on chain", "No further payment action available"],
      tone: "positive",
      fundsLocked: false,
      settled: true,
    };
  }

  if (input.runStatus === "EXECUTING") {
    // Submitted, not yet confirmed. The only stage entitled to say a payment is
    // in progress, because it is the only one where a transaction exists.
    return {
      action: "NONE",
      label: null,
      headline: "PAYMENT PROCESSING",
      lead: null,
      status: "Payment processing",
      detail: "The payment has been submitted and is awaiting confirmation.",
      facts: [],
      tone: "chain",
      fundsLocked: false,
      settled: false,
    };
  }

  // ---- 4. Only now does the recommendation get a say ------------------------
  switch (input.autonomy.kind) {
    case "AUTONOMOUS":
      // AUTHORIZED, NOT EXECUTED. The distinction this whole file turns on:
      // AUTO_PAY means the agent MAY settle this without a human, not that it
      // has. Saying "executing" here claimed a transaction that did not exist.
      return {
        action: "EXECUTE_PAYMENT",
        label: "Execute payment",
        headline: "AUTHORIZED · READY",
        lead: "Policy checks passed",
        status: "Authorized · ready to execute",
        detail:
          `${amount} is within the agent's authority and every Sui preflight check passed. ` +
          "No payment has been submitted yet.",
        facts: ["Ready to execute"],
        tone: "chain",
        fundsLocked: false,
        settled: false,
      };

    case "NEEDS_HUMAN": {
      if (input.humanRejected) {
        return {
          action: "NONE",
          label: null,
          headline: "DECLINED",
          lead: null,
          status: "Declined by operator",
          detail: "A person declined this payment. No request was submitted.",
          facts: ["No payment action available"],
          tone: "neutral",
          fundsLocked: false,
          settled: false,
        };
      }

      // The preflight refused, BEFORE any approval was minted. Nothing was
      // signed and nothing was sent, so there is no approval to describe as
      // having been refused — only one that would be.
      if (input.humanApproval?.outcome === "SUI_REJECT") {
        // WOULD BE, not WAS. This verdict comes from the policy mirror and the
        // Sui preflight — no transaction was submitted, so nothing on chain
        // rejected anything. Saying "refused on chain" claimed an event that
        // never happened, and next to a $30,000 figure it read as a failed
        // payment rather than as a payment that was never attempted.
        return {
          action: "NONE",
          label: null,
          headline: "WOULD BE REFUSED BY SUI",
          lead: "Preflight — nothing was submitted",
          status: "Would be refused by Sui",
          detail:
            "No human approval transaction was submitted. Sui would refuse one: this amount is " +
            "above the approver's own Chain-Doi authorization. An approval raises WHOSE limit " +
            "applies, never the limit itself.",
          facts: [
            "No transaction was submitted",
            "No funds moved",
            "Human approval does not bypass treasury policy",
            "No payment action available",
          ],
          tone: "negative",
          fundsLocked: false,
          settled: false,
        };
      }

      // Approved by a human AND re-checked by the chain under the approver's
      // limits. Authorization is granted; execution is still a separate act.
      if (input.humanApproval?.outcome === "APPROVED") {
        return {
          action: "EXECUTE_PAYMENT",
          label: "Execute payment",
          // The same state as the autonomous case — authorized, not executed —
          // so it gets the same headline. WHO authorized it belongs in the lead.
          headline: "AUTHORIZED · READY",
          lead: "Approved by a person · policy checks passed",
          status: "Authorized · ready to execute",
          detail:
            `${amount} was authorized by a person and re-checked against every on-chain rule ` +
            "under the approver's limits. No payment has been submitted yet.",
          facts: ["Ready to execute"],
          tone: "chain",
          fundsLocked: false,
          settled: false,
        };
      }

      return {
        action: "APPROVE",
        label: "Approve payment",
        // Awaiting a person, not refused by one. Nothing about this payment has
        // failed — it is above the limit the agent may act on alone.
        headline: "AWAITING APPROVAL",
        // The checks DID pass — what failed is the agent's authority to act
        // alone. Leading with the pass keeps the two apart.
        lead: "Policy checks passed",
        status: "Awaiting approval",
        detail: input.autonomy.reason,
        facts: [],
        tone: "warning",
        fundsLocked: false,
        settled: false,
      };
    }

    case "NO_PAYMENT": {
      const refused = input.autonomy.reason.startsWith("Sui refused");
      return {
        action: "NONE",
        label: null,
        // A payment genuinely refused BEFORE any money moved. Distinct from a
        // settled invoice whose guard refuses a SECOND payment — that case
        // never reaches here, because settlement is branch 1.
        headline: refused ? "PAYMENT REJECTED" : "NO PAYMENT",
        lead: null,
        status: refused ? "Payment rejected" : "No payment",
        detail: input.autonomy.reason,
        facts: ["No payment action available"],
        tone: refused ? "negative" : "neutral",
        fundsLocked: false,
        settled: false,
      };
    }
  }
}

/**
 * Whether an execute-style control may be rendered at all.
 *
 * Stated separately because it is the claim worth asserting on its own: after a
 * release, a hold, or a settlement there is no button, and that must be true of
 * the STATE rather than of a stylesheet.
 */
export function offersPaymentControl(state: PaymentActionState): boolean {
  return state.action !== "NONE";
}

/**
 * Statuses the invoice object carries once a payment has settled against it.
 *
 * ESCROWED is deliberately absent: the treasury has parted with the money and
 * the supplier has not received it, which is not settlement.
 */
export function isPaidOnChain(status: string | null | undefined): boolean {
  return status === "PAID" || status === "SETTLED";
}

function money(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}
