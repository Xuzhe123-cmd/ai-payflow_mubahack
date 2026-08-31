/**
 * Which authority a payment runs under, and therefore which limits apply.
 *
 * This mirrors the `Limits` struct in the Move layer. One rule body, two
 * sources of authority: an agent's capability, or a human approval. The ten
 * checks are identical either way — only where max_single and daily_limit come
 * from changes. That is what lets a $30,000 human-approved payment and a $3,000
 * autonomous one be judged by exactly the same code.
 *
 * SECURITY: the authority is derived from the treasury's own policy and the
 * amount, never supplied by the caller. On chain the same property holds
 * structurally — the agent can only reach execute_payment (which takes an
 * AgentCap), and cannot reach execute_approved, because it holds no
 * HumanApproval object. There is no argument it could set to promote itself.
 */

import type {
  AgentCapability,
  ApproverAuthority,
  Cents,
  TreasuryAction,
  TreasuryPolicy,
} from "../types";

export type { ApproverAuthority };

export type PaymentAuthority = "AGENT" | "HUMAN_APPROVAL";

export interface Limits {
  authority: PaymentAuthority;
  /** Rendered in the check rows, e.g. "the agent" / "the approver". */
  holder: string;
  authorized: boolean;
  enabled: boolean;
  maxSinglePaymentCents: Cents;
  dailyLimitCents: Cents;
  dailySpentCents: Cents;
}

/**
 * Which authority a payment is judged under.
 *
 * AUTO_PAY is the agent's own claim — "I am settling this myself, now" — so it
 * is always measured against the agent's capability. That is what makes the
 * $8,000-against-a-$5,000-cap rejection possible at all: an agent that could
 * escape its own ceiling merely by asking for more would have no ceiling.
 *
 * SCHEDULE creates a request for a later date. Above the threshold that request
 * needs a person to sign it, so it is measured against the approver's limits
 * instead — and the agent gains nothing by choosing it, because a scheduled
 * request moves no money until a human approves.
 *
 * `forceAgentAuthority` exists for the security demonstration and for tests: it
 * pins the judgement to the agent's own capability. Note the asymmetry — there
 * is deliberately NO option in the other direction. A caller may only ever ask
 * to be judged more strictly, never less.
 */
export function authorityFor(
  amountCents: Cents,
  action: TreasuryAction,
  policy: Readonly<TreasuryPolicy>,
  forceAgentAuthority = false,
): PaymentAuthority {
  if (forceAgentAuthority) return "AGENT";
  if (action === "AUTO_PAY") return "AGENT";
  return amountCents > policy.humanApprovalThresholdCents ? "HUMAN_APPROVAL" : "AGENT";
}

export function limitsFor(
  authority: PaymentAuthority,
  capability: Readonly<AgentCapability>,
  approver: Readonly<ApproverAuthority>,
): Limits {
  if (authority === "HUMAN_APPROVAL") {
    return {
      authority,
      holder: "the approver",
      // NOT a statement about on-chain authority, and it used to read as one.
      //
      // The old comment here said reaching this branch "already proves" the
      // caller holds an approver capability. That stopped being true when
      // `ApproverCap` was replaced by treasury-state authorization: these
      // figures come from a WorldSnapshot, which may be a demo fixture, and
      // nothing about constructing them consults the chain.
      //
      // Move decides. `treasury::approver_can_authorize` reads the live
      // authorization, and `approval::limits_for` re-checks it at execution.
      // These fields drive the off-chain forecast and the explanation shown
      // beside it — never a permission.
      authorized: true,
      enabled: true,
      maxSinglePaymentCents: approver.maxSinglePaymentCents,
      dailyLimitCents: approver.dailyLimitCents,
      dailySpentCents: approver.dailySpentCents,
    };
  }

  return {
    authority,
    holder: "the agent",
    authorized: capability.authorized,
    enabled: capability.enabled,
    maxSinglePaymentCents: capability.maxSinglePaymentCents,
    dailyLimitCents: capability.dailyLimitCents,
    dailySpentCents: capability.dailySpentCents,
  };
}
