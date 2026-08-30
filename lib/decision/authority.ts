/**
 * What the agent is allowed to settle on its own.
 *
 * Every figure comes from the live chain snapshot — the agent's registered
 * limits and the treasury's approval threshold. Nothing here is configured in
 * the frontend, because a second copy of a limit is a limit that can disagree
 * with the one being enforced.
 *
 * Note the order of the checks. An agent that is disabled or unregistered is
 * reported as such rather than as "over its limit", because the remedy is
 * different and a demo that says the wrong one is misleading.
 */

import type { Cents } from "../types";
import type { ChainAgent, ChainTreasury } from "../sui/chainTypes";
import type { AuthorityEvaluation, AuthorityStatus } from "./types";

export function evaluateAuthority(
  amountCents: Cents,
  treasury: ChainTreasury,
  agent: ChainAgent | null,
): AuthorityEvaluation {
  const threshold = treasury.humanApprovalThresholdCents;

  if (!agent) {
    return {
      status: "AGENT_NOT_REGISTERED",
      withinAutonomousAuthority: false,
      requiresHumanApproval: true,
      amountCents,
      maxSinglePaymentCents: 0,
      dailyLimitCents: 0,
      spentTodayCents: 0,
      remainingTodayCents: 0,
      humanApprovalThresholdCents: threshold,
      autonomousHeadroomCents: 0,
    };
  }

  const base = {
    amountCents,
    maxSinglePaymentCents: agent.maxSinglePaymentCents,
    dailyLimitCents: agent.dailyLimitCents,
    spentTodayCents: agent.spentTodayCents,
    remainingTodayCents: agent.remainingTodayCents,
    humanApprovalThresholdCents: threshold,
    // The most the agent could still settle alone today: the tightest of its
    // per-payment cap, what is left of the day, and the approval threshold.
    autonomousHeadroomCents: Math.max(
      0,
      Math.min(agent.maxSinglePaymentCents, agent.remainingTodayCents, threshold),
    ),
  };

  const status = determineStatus(amountCents, threshold, agent);
  const withinAutonomousAuthority = status === "WITHIN_AUTONOMOUS";

  return {
    ...base,
    status,
    withinAutonomousAuthority,
    requiresHumanApproval: !withinAutonomousAuthority,
  };
}

function determineStatus(
  amountCents: Cents,
  threshold: Cents,
  agent: ChainAgent,
): AuthorityStatus {
  if (!agent.enabled) return "AGENT_DISABLED";
  if (amountCents > agent.maxSinglePaymentCents) return "EXCEEDS_SINGLE_LIMIT";
  if (amountCents > agent.remainingTodayCents) return "EXCEEDS_DAILY_LIMIT";
  // Reported last: an amount can be inside every agent limit and still be large
  // enough that the company wants a person to sign it.
  if (amountCents > threshold) return "REQUIRES_HUMAN_APPROVAL";
  return "WITHIN_AUTONOMOUS";
}

/** Human-readable, for reasons and prose. */
export function describeAuthority(authority: AuthorityEvaluation): string {
  switch (authority.status) {
    case "WITHIN_AUTONOMOUS":
      return "within the agent's autonomous authority";
    case "REQUIRES_HUMAN_APPROVAL":
      return "above the treasury's human-approval threshold";
    case "EXCEEDS_SINGLE_LIMIT":
      return "above the agent's per-payment ceiling";
    case "EXCEEDS_DAILY_LIMIT":
      return "beyond what the agent has left of today's limit";
    case "AGENT_DISABLED":
      return "blocked because the agent capability is disabled";
    case "AGENT_NOT_REGISTERED":
      return "blocked because no agent is registered on this treasury";
  }
}
