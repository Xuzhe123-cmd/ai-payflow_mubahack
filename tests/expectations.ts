/**
 * The ONLY place expected outcomes are written down.
 *
 * Scenario fixtures deliberately carry no expected action, so nothing in the
 * application can read the answer and short-circuit to it. If you find yourself
 * wanting to import this file from lib/, something has gone wrong.
 */

import type { FinalOutcome, TreasuryAction } from "../lib/types";

export interface ScenarioExpectation {
  scenarioId: string;
  /**
   * Actions the MODEL may choose. Asserted against the pre-guard action, so a
   * pass genuinely means the AI decided — not that a rule downgraded it.
   */
  allowedActions: TreasuryAction[];
  /** The end state after Sui policy enforcement. */
  finalOutcomes: FinalOutcome[];
  why: string;
}

export const EXPECTATIONS: ScenarioExpectation[] = [
  {
    scenarioId: "s1_normal",
    allowedActions: ["AUTO_PAY"],
    finalOutcomes: ["EXECUTED"],
    why: "Fully verified, due in two days, no liquidity pressure — nothing is gained by waiting.",
  },
  {
    scenarioId: "s2_cashflow",
    allowedActions: ["SCHEDULE"],
    finalOutcomes: ["SCHEDULED"],
    why: "Legitimate, but paying today troughs $8,000 below the reserve while later dates do not.",
  },
  {
    scenarioId: "s3_discount",
    allowedActions: ["AUTO_PAY"],
    finalOutcomes: ["EXECUTED"],
    why: "A $600 discount expires today and liquidity is comfortable, so paying now is worth real money.",
  },
  {
    scenarioId: "s4_new_supplier",
    allowedActions: ["HUMAN_REVIEW", "REJECT"],
    finalOutcomes: ["HUMAN_REVIEW", "REJECTED"],
    why: "An unknown supplier must never be paid automatically.",
  },
  {
    scenarioId: "s5_wallet_mismatch",
    // The spec allows either; both refuse to pay a redirected wallet.
    allowedActions: ["HUMAN_REVIEW", "REJECT"],
    finalOutcomes: ["HUMAN_REVIEW", "REJECTED"],
    why: "Payment-redirection pattern: approved supplier, unregistered remit wallet.",
  },
  {
    scenarioId: "s6_duplicate",
    allowedActions: ["REJECT"],
    finalOutcomes: ["REJECTED"],
    why: "The invoice number was already settled on 2026-08-11.",
  },
  {
    scenarioId: "s7_po_mismatch",
    allowedActions: ["HUMAN_REVIEW"],
    finalOutcomes: ["HUMAN_REVIEW"],
    why: "A 50% overage on the purchase order needs a human to approve the variance.",
  },
  {
    scenarioId: "s8_policy_violation",
    // The AI may legitimately want to pay this clean invoice; Sui still refuses.
    allowedActions: ["AUTO_PAY", "SCHEDULE"],
    finalOutcomes: ["SUI_REJECT"],
    why: "$68,000 exceeds the agent's $50,000 on-chain cap, whatever the AI recommends.",
  },
];

export function expectationFor(scenarioId: string): ScenarioExpectation {
  const found = EXPECTATIONS.find((entry) => entry.scenarioId === scenarioId);
  if (!found) throw new Error(`No expectation defined for scenario ${scenarioId}`);
  return found;
}
