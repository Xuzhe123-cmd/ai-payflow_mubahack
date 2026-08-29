/**
 * Reads treasury policy and agent capability.
 *
 * Today this reads the demo fixtures; in Phase 6 a ChainPolicyReader fetches
 * the same shape from Sui objects. Either way the values flow one direction
 * only — into the analysis. Nothing downstream can write them back.
 */

import type {
  AgentCapability,
  Cents,
  PolicyFacts,
  TreasuryPolicy,
  TreasuryState,
} from "../types";

export interface PolicyReadContext {
  treasury: TreasuryState;
  policy: TreasuryPolicy;
  capability: AgentCapability;
  /** The invoice amount under consideration, for the limit comparisons. */
  proposedAmountCents: Cents;
}

export interface SuiPolicyReader {
  readonly id: string;
  read(ctx: PolicyReadContext): Promise<PolicyFacts>;
}

function toFacts(ctx: PolicyReadContext): PolicyFacts {
  const { treasury, policy, capability, proposedAmountCents } = ctx;
  return {
    agentAuthorized: capability.authorized,
    capabilityEnabled: capability.enabled,
    maxSinglePaymentCents: capability.maxSinglePaymentCents,
    dailyLimitCents: capability.dailyLimitCents,
    dailySpentCents: capability.dailySpentCents,
    minimumReserveCents: policy.minimumReserveCents,
    currentCashCents: treasury.currentCashCents,
    allowedCurrencies: [...policy.allowedCurrencies],
    wouldExceedSingleLimit: proposedAmountCents > capability.maxSinglePaymentCents,
    wouldExceedDailyLimit:
      capability.dailySpentCents + proposedAmountCents > capability.dailyLimitCents,
  };
}

/** Fixture-backed reader used until Sui integration lands. */
export const DemoPolicyReader: SuiPolicyReader = {
  id: "demo",
  read(ctx) {
    return Promise.resolve(toFacts(ctx));
  },
};
