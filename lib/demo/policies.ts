/**
 * Treasury policy and agent capability — the demo mirror of the Sui objects.
 *
 * Deliberately ONE shared configuration across all eight scenarios. Scenario 8
 * must trip the single-payment ceiling purely because its invoice is larger,
 * not because its policy was weakened for the demo.
 *
 * The AI can read these values. It can never write them: the pipeline freezes
 * them before the engine runs, and on-chain they are owned by the treasury
 * holder, not the agent.
 */

import type { AgentCapability, TreasuryPolicy } from "../types";
import { dollars } from "../util/money";

export const TREASURY_POLICY: TreasuryPolicy = {
  minimumReserveCents: dollars(50_000),
  allowedCurrencies: ["USD"],
};

export const AGENT_CAPABILITY: AgentCapability = {
  agentId: "agent_payflow_01",
  authorized: true,
  enabled: true,
  /** Any single payment above this is rejected by Move, whatever the AI says. */
  maxSinglePaymentCents: dollars(50_000),
  dailyLimitCents: dollars(80_000),
  dailySpentCents: 0,
};
