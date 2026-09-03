/**
 * Whether the chain would let this payment run RIGHT NOW — and which way.
 *
 * THE GAP THIS CLOSES. The outcome box reached "AUTHORIZED · READY" from the
 * pipeline's own forecast, computed before anyone clicked and without asking
 * the chain anything. So it said READY while the agent's capability was
 * revoked, while the circuit breaker was tripped, and — the case that actually
 * bit — while the approver's daily authorization was spent and every human
 * approval on chain had stopped being live. The word "ready" was a prediction
 * wearing the clothes of a fact.
 *
 * WHAT THIS IS, AND IS NOT. Every figure below arrives from a chain read: the
 * agent's registration and its ceilings, the approver's standing and their
 * day's bookings, the breaker's mode, the invoice's own status, and whether a
 * spendable `HumanApproval` exists. Nothing here is a constant, and there is
 * deliberately no policy number written in this file.
 *
 * It decides WHAT THE INTERFACE MAY CLAIM AND WHICH CONTROL IT MAY OFFER. It
 * is not the gate. `payment::evaluate` re-runs all ten assertions,
 * `approval::limits_for` re-judges the approval, and the circuit breaker is
 * asserted in Move — on the real transaction, against state as it stands at
 * that instant. A readiness verdict that says yes buys a caller nothing they
 * did not already have; one that says no simply stops the screen promising
 * something the chain would refuse.
 *
 * Pure, so the ordering can be tested without a network.
 */

import type { Cents } from "../types";

export type ReadinessState =
  /** The agent may settle this itself, now. No human step. */
  | "AUTONOMOUS_READY"
  /** Above the agent's authority, and a person could authorize it. */
  | "HUMAN_APPROVAL_REQUIRED"
  /** A live `HumanApproval` exists on chain and can be spent right now. */
  | "HUMAN_APPROVAL_READY"
  /** An approval exists but cannot be settled — or none can be. */
  | "APPROVAL_NOT_LIVE"
  /** Chain-backed policy refuses this action, whoever asks. */
  | "BLOCKED"
  /** Not executable yet because it is scheduled for a later date. */
  | "SCHEDULED"
  /** The chain already records this invoice as settled. */
  | "SETTLED"
  /** The chain has not answered yet. Claim nothing. */
  | "UNKNOWN";

/** The agent's registration, as the treasury holds it. */
export interface AgentStanding {
  /** The capability is registered on THIS treasury. */
  authorized: boolean;
  /** And has not been revoked. */
  enabled: boolean;
  maxSingleCents: Cents;
  dailyLimitCents: Cents;
  /** Spend already booked in the current day bucket, after rollover. */
  spentTodayCents: Cents;
}

/** The approver's authorization, as the treasury holds it. */
export interface ApproverStanding {
  /** Every condition `treasury::approver_in_good_standing` checks. */
  inGoodStanding: boolean;
  maxSingleCents: Cents;
  dailyLimitCents: Cents;
  /** Booked against the day at MINT time, not at settlement. */
  authorizedTodayCents: Cents;
  /** True when a membership refresh alone would restore standing. */
  staleOnly: boolean;
}

/**
 * Which daily-budget rule the DEPLOYED package enforces at settlement.
 *
 * This has to be modelled, not assumed, because the two versions disagree and
 * the interface must track whichever one is actually on chain:
 *
 *   V4_DOUBLE_COUNT  `approver_can_authorize` asks `used + amount <= daily`,
 *                    where `used` ALREADY contains this approval's amount
 *                    because `approve_scoped` booked it at mint. The amount is
 *                    therefore charged twice at execution.
 *   V5_BOOKED_ONCE   `approver_can_settle` asks `used <= daily`, charging it
 *                    once — the prepared upgrade.
 *
 * Getting this wrong in either direction is a lie: modelling v5 while v4 is
 * deployed makes the screen say a payment can settle when Move will abort it,
 * and modelling v4 after the upgrade hides payments that would now succeed.
 */
export type ApprovalBudgetRule = "V4_DOUBLE_COUNT" | "V5_BOOKED_ONCE";

export interface ReadinessFacts {
  /** Null while the chain has not answered. Never assumed. */
  agent: AgentStanding | null;
  approver: ApproverStanding | null;
  /** A spendable approval for exactly this payment, read from chain. */
  liveApproval: { objectId: string; amountCents: Cents } | null;
  /** Approvals that exist and cannot be spent, with the chain's reason. */
  deadApprovals: { objectId: string; reason: string }[];
  breaker: "NORMAL" | "HUMAN_ONLY" | "NOT_INSTALLED";
  /** PENDING / APPROVED / PAID / ESCROWED, as the Invoice object records it. */
  invoiceStatus: string | null;
  amountCents: Cents;
  /** The date the recommendation asks for, when it asks for a later one. */
  scheduledFor?: string | null;
  /** Today, for comparing against `scheduledFor`. */
  today?: string;
  /** The rule the deployed package enforces. Defaults to the safer reading. */
  approvalBudgetRule?: ApprovalBudgetRule;
}

export interface ReadinessVerdict {
  state: ReadinessState;
  /** One sentence, in the chain's terms. Never a paraphrase of a constant. */
  reason: string;
  /** Whether the interface may render an execute-style control at all. */
  offersExecution: boolean;
}

export function executionReadiness(facts: ReadinessFacts): ReadinessVerdict {
  // ---- the chain has not spoken --------------------------------------------
  // Ordered first, so a partial read can never be mistaken for a refusal or a
  // permission. Nothing is claimed until every fact needed is in hand.
  if (facts.agent === null || facts.approver === null) {
    return {
      state: "UNKNOWN",
      reason: "Reading the current authorization state from Sui.",
      offersExecution: false,
    };
  }

  // ---- settlement outranks everything --------------------------------------
  if (isSettled(facts.invoiceStatus)) {
    return {
      state: "SETTLED",
      reason: "The chain records this invoice as already settled.",
      offersExecution: false,
    };
  }

  // ---- an approval that exists is the nearest fact about this payment ------
  //
  // EXISTS, LIVE, AND EXECUTABLE NOW ARE THREE DIFFERENT THINGS. The object
  // being unconsumed and unexpired is only the half of `approval::limits_for`
  // that can be read off the object. The other half re-asks the TREASURY
  // whether the approver may still authorize this — and that is what fails when
  // the day's authorization has been spent, when membership has lapsed, or when
  // an admin has narrowed the scope since the mint.
  //
  // Reporting the first as though it were the third is what produced an Execute
  // button that aborted the moment it was pressed.
  if (facts.liveApproval) {
    const blocked = settlementRefusal(facts);
    if (blocked === null) {
      return {
        state: "HUMAN_APPROVAL_READY",
        reason:
          "A HumanApproval for this invoice exists on Sui, unspent and unexpired, and the " +
          "approver's authorization still covers it. Executing spends it.",
        offersExecution: true,
      };
    }
    return {
      state: "APPROVAL_NOT_LIVE",
      reason: `The approval exists on Sui but cannot be settled right now. ${blocked}`,
      offersExecution: false,
    };
  }

  if (facts.deadApprovals.length > 0) {
    // WHY THIS IS ITS OWN STATE. `payment::execute_approved` collapses every
    // authorization failure into abort 2, so an approval that has been spent
    // and one whose approver ran out of daily budget look identical from the
    // abort code alone. Only a chain read can tell them apart, and this is
    // where that reading is reported instead of being guessed at afterwards.
    return {
      state: "APPROVAL_NOT_LIVE",
      reason: facts.deadApprovals[0]?.reason ?? "The approval on chain cannot be spent.",
      offersExecution: false,
    };
  }

  // ---- scheduled for later --------------------------------------------------
  if (facts.scheduledFor && facts.today && facts.scheduledFor > facts.today) {
    return {
      state: "SCHEDULED",
      reason: `Scheduled for ${facts.scheduledFor}. Nothing settles before then.`,
      offersExecution: false,
    };
  }

  // ---- can the agent do it alone? ------------------------------------------
  const agentBlocked = agentRefusal(facts);
  if (agentBlocked === null) {
    return {
      state: "AUTONOMOUS_READY",
      reason:
        "Within the agent's own on-chain authorization, and the treasury is not in " +
        "HUMAN_ONLY mode.",
      // The agent settles it; no human control is offered.
      offersExecution: false,
    };
  }

  // ---- could a person authorize it? ----------------------------------------
  const approverBlocked = approverRefusal(facts);
  if (approverBlocked === null) {
    return {
      state: "HUMAN_APPROVAL_REQUIRED",
      reason: `${agentBlocked} A person holding an on-chain authorization may approve it.`,
      offersExecution: true,
    };
  }

  return {
    state: "BLOCKED",
    reason: `${agentBlocked} ${approverBlocked}`,
    offersExecution: false,
  };
}

/**
 * Why the agent may not settle this alone, or null when it may.
 *
 * Each clause mirrors a condition Move asserts, and reads the figure it
 * compares against from the treasury rather than from anywhere in this repo.
 */
function agentRefusal(facts: ReadinessFacts): string | null {
  const agent = facts.agent!;
  if (facts.breaker === "HUMAN_ONLY") {
    return "Autonomous payment is blocked by the Sui circuit breaker.";
  }
  if (!agent.authorized) {
    return "The agent capability is not registered on this treasury.";
  }
  if (!agent.enabled) {
    return "The agent capability has been revoked on Sui.";
  }
  if (facts.amountCents > agent.maxSingleCents) {
    return `This is above the agent's on-chain single-payment authorization of ${money(agent.maxSingleCents)}.`;
  }
  if (agent.spentTodayCents + facts.amountCents > agent.dailyLimitCents) {
    return `This would take the agent past its on-chain daily authorization of ${money(agent.dailyLimitCents)}.`;
  }
  return null;
}

/**
 * Why an approval that EXISTS still cannot be spent, or null when it can.
 *
 * Mirrors the treasury half of `approval::limits_for` — the half the approval
 * object cannot answer for itself. Every figure is read from chain.
 */
function settlementRefusal(facts: ReadinessFacts): string | null {
  const approver = facts.approver!;
  if (!approver.inGoodStanding) {
    return approver.staleOnly
      ? "The approver's Chain-Doi membership reading has gone stale and must be refreshed on " +
          "Sui before the approval can be spent."
      : "The approver's authorization is no longer live on Sui.";
  }
  if (facts.amountCents > approver.maxSingleCents) {
    return `It is above the approver's per-payment authorization of ${money(approver.maxSingleCents)}.`;
  }

  // The day's bookings ALREADY include this approval — `approve_scoped` charged
  // it at mint. Whether that amount is charged a second time here depends on
  // which package version is deployed.
  const doubleCounted = (facts.approvalBudgetRule ?? "V4_DOUBLE_COUNT") === "V4_DOUBLE_COUNT";
  const projected = approver.authorizedTodayCents + (doubleCounted ? facts.amountCents : 0);
  if (projected > approver.dailyLimitCents) {
    return (
      `The approver has authorized ${money(approver.authorizedTodayCents)} of their ` +
      `${money(approver.dailyLimitCents)} daily limit on Sui` +
      (doubleCounted
        ? ", and the deployed package re-counts this approval's own amount at settlement, " +
          "putting it over. It becomes settleable when the day's bucket rolls over."
        : ", which leaves no room for this one until the day's bucket rolls over.")
    );
  }
  return null;
}

/** Why no person could authorize this either, or null when one could. */
function approverRefusal(facts: ReadinessFacts): string | null {
  const approver = facts.approver!;
  if (!approver.inGoodStanding) {
    return approver.staleOnly
      ? "The approver's Chain-Doi membership check is stale and must be refreshed on Sui."
      : "No approver currently holds a live authorization on this treasury.";
  }
  if (facts.amountCents > approver.maxSingleCents) {
    return `It is also above the approver's own authorization of ${money(approver.maxSingleCents)}.`;
  }
  // Booked at MINT time, which is why the day can be spent without anything
  // having settled — see `treasury::approver_can_settle`.
  if (approver.authorizedTodayCents + facts.amountCents > approver.dailyLimitCents) {
    return (
      "The approver has already authorized " +
      `${money(approver.authorizedTodayCents)} of their ${money(approver.dailyLimitCents)} ` +
      "daily limit on Sui, leaving too little for this payment until the day rolls over."
    );
  }
  return null;
}

/**
 * Statuses the invoice object carries once a payment has settled against it.
 *
 * ESCROWED is deliberately absent: the treasury has parted with the money and
 * the supplier has not received it, which is not settlement.
 */
export function isSettled(status: string | null | undefined): boolean {
  return status === "PAID" || status === "SETTLED";
}

function money(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}
