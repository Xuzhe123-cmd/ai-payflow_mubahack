/**
 * The eight demo scenarios.
 *
 * These are INPUTS ONLY. No scenario carries an expected action, and nothing in
 * lib/ may ever read one — expectations live solely in tests/expectations.ts.
 * Every scenario runs through the identical pipeline; only the data differs.
 *
 * All eight share the same TREASURY_POLICY and AGENT_CAPABILITY, so scenario 8
 * trips the on-chain ceiling because its invoice is genuinely larger, not
 * because its policy was weakened to stage the demo.
 *
 * With the agent capped at $5,000 and the human-approval threshold at the same
 * figure, scenarios divide three ways by amount alone: s1 and s3 are small
 * enough for the agent to settle on its own, s2 is large enough to require a
 * person, and s8 is large enough that the agent's attempt is refused outright.
 */

import type { Scenario, WorldSnapshot } from "../types";
import { DEMO_DOCUMENTS } from "./invoices";
import { SUPPLIERS } from "./suppliers";
import { PURCHASE_ORDERS } from "./purchaseOrders";
import { PAYMENT_HISTORY } from "./paymentHistory";
import { TREASURY_PROFILES, type TreasuryProfile } from "./cashFlow";
import { AGENT_CAPABILITY, APPROVER_AUTHORITY, TREASURY_POLICY } from "./policies";
import { DEMO_AS_OF_DATE } from "./clock";

/**
 * Every scenario shares one "today" so the fixtures stay comparable. Demo day
 * is written down once, in ./clock, and re-exported here for the callers that
 * have always imported it from this module.
 */
export { DEMO_AS_OF_DATE };

function world(profile: TreasuryProfile): WorldSnapshot {
  return {
    suppliers: SUPPLIERS,
    purchaseOrders: PURCHASE_ORDERS,
    paymentHistory: PAYMENT_HISTORY,
    cashFlowEvents: profile.events,
    treasury: profile.treasury,
    policy: TREASURY_POLICY,
    capability: AGENT_CAPABILITY,
    approver: APPROVER_AUTHORITY,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "s1_normal",
    name: "Normal invoice",
    description:
      "Approved supplier, wallet and PO match, no duplicate, typical amount, due in a week, healthy cash.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.normal,
    world: world(TREASURY_PROFILES.healthy),
  },
  {
    id: "s2_cashflow",
    name: "Cash-flow optimization",
    description:
      "Legitimate $30,000 invoice against a constrained position: paying today breaches the reserve, waiting does not.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.cashflow,
    world: world(TREASURY_PROFILES.tight),
  },
  {
    id: "s3_discount",
    name: "Early-payment discount",
    description:
      "Approved supplier offering 5% for payment by today, with liquidity comfortable enough to take it.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.discount,
    world: world(TREASURY_PROFILES.discount),
  },
  {
    id: "s4_new_supplier",
    name: "New supplier",
    description:
      "Supplier does not appear in the approved registry and has no payment history.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.newSupplier,
    world: world(TREASURY_PROFILES.healthy),
  },
  {
    id: "s5_wallet_mismatch",
    name: "Wallet mismatch",
    description:
      "Approved supplier, but the remit wallet differs from the registered one — payment redirection.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.walletMismatch,
    world: world(TREASURY_PROFILES.healthy),
  },
  {
    id: "s6_duplicate",
    name: "Duplicate invoice",
    description:
      "Invoice number INV-2026-3391 was already settled on 2026-08-11.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.duplicate,
    world: world(TREASURY_PROFILES.healthy),
  },
  {
    id: "s7_po_mismatch",
    name: "PO mismatch",
    description:
      "Invoice bills $14,700 against a $9,800 purchase order — a 50% unapproved overage.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.poMismatch,
    world: world(TREASURY_PROFILES.healthy),
  },
  {
    id: "s8_policy_violation",
    name: "Policy violation",
    description:
      "Clean, well-funded $8,000 invoice that exceeds the agent's $5,000 on-chain single-payment cap.",
    asOfDate: DEMO_AS_OF_DATE,
    document: DEMO_DOCUMENTS.policyViolation,
    world: world(TREASURY_PROFILES.wellFunded),
  },
];

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown scenario: ${id}`);
  return found;
}
