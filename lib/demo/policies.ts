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
/**
 * NOT AN AUTHORIZATION. A default for the offline forecast, and nothing more.
 *
 * THE BUG THIS CAUSED. `/api/approve` used to measure a human approval against
 * this figure, so a $30,000 invoice passed a $250,000 constant while the live
 * on-chain authorization permitted $25,000 — and the interface then offered an
 * Execute Payment button on the strength of it. A number in a TypeScript file
 * decided what a person could authorize.
 *
 * What decides now: `treasury::approver_can_authorize`, read from the treasury
 * for the approver's own address. This survives only so the deterministic
 * pipeline can run offline, against fixture worlds with no chain behind them,
 * and `/api/approve` overrides it with the chain's figure whenever one exists.
 *
 * Lowered to the demo authorization as well, so a fixture run and the chain do
 * not disagree by a factor of ten even where the override cannot reach.
 */
export const APPROVER_AUTHORITY: ApproverAuthority = {
  maxSinglePaymentCents: dollars(25_000),
  dailyLimitCents: dollars(50_000),
  dailySpentCents: 0,
};
