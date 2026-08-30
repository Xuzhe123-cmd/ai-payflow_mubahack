/**
 * Treasury policy and agent capability — the demo mirror of the Sui objects.
 *
 * Deliberately ONE shared configuration across all eight scenarios. A scenario
 * must trip a ceiling purely because its invoice is larger, never because its
 * policy was weakened for the demo.
 *
 * The AI can read these values. It can never write them: the pipeline freezes
 * them before the engine runs, and on-chain they are owned by the treasury
 * holder, not the agent.
 */

import type { AgentCapability, TreasuryPolicy } from "../types";
import type { ApproverAuthority } from "../sui/limits";
import { dollars } from "../util/money";

export const TREASURY_POLICY: TreasuryPolicy = {
  minimumReserveCents: dollars(50_000),
  allowedCurrencies: ["USD"],
  /** Above this the agent's capability is not enough — a person must approve. */
  humanApprovalThresholdCents: dollars(5_000),
};

export const AGENT_CAPABILITY: AgentCapability = {
  agentId: "agent_payflow_01",
  authorized: true,
  enabled: true,
  /** Any single payment above this is rejected by Move, whatever the AI says. */
  maxSinglePaymentCents: dollars(5_000),
  dailyLimitCents: dollars(20_000),
  dailySpentCents: 0,
};

/**
 * What a human approver may authorize. Bounded, not unlimited: an approval is
 * still policy-constrained, it simply carries a different bound than the
 * agent's. The minimum reserve applies to it exactly as it does to the agent.
 */
export const APPROVER_AUTHORITY: ApproverAuthority = {
  maxSinglePaymentCents: dollars(250_000),
  dailyLimitCents: dollars(250_000),
  dailySpentCents: 0,
};
