/**
 * Composes the complete fact sheet handed to the LLM, then deep-freezes it.
 *
 * The freeze is a real security boundary, not a formality: the decision engine
 * receives this object and must not be able to mutate policy limits, the
 * minimum reserve, or supplier authorization on its way to a recommendation.
 */

import type {
  DeterministicAnalysis,
  IsoDate,
  RawInvoiceDocument,
  WorldSnapshot,
} from "../types";
import { DemoPolicyReader, type SuiPolicyReader } from "../sui/policyReader";
import { buildRiskEvidence } from "./buildRiskEvidence";
import { buildUrgencyFacts } from "./buildUrgencyFacts";
import { extractInvoice } from "./extractInvoice";
import { lookupSupplier } from "./lookupSupplier";
import { simulateCandidateDates } from "./simulateCandidateDates";
import { validateInvoice } from "./validateInvoice";

/** Recursively freezes an object graph. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  Object.getOwnPropertyNames(value).forEach((key) => {
    deepFreeze((value as Record<string, unknown>)[key]);
  });
  return Object.freeze(value);
}

export interface BuildAnalysisInput {
  document: RawInvoiceDocument;
  world: WorldSnapshot;
  asOf: IsoDate;
  policyReader?: SuiPolicyReader;
}

export async function buildAnalysis(
  input: BuildAnalysisInput,
): Promise<Readonly<DeterministicAnalysis>> {
  const { document, world, asOf } = input;
  const policyReader = input.policyReader ?? DemoPolicyReader;

  const invoiceFacts = extractInvoice(document, asOf);
  const supplierFacts = lookupSupplier(invoiceFacts, world.suppliers);
  const validationFacts = validateInvoice(
    invoiceFacts,
    supplierFacts,
    world.purchaseOrders,
    world.paymentHistory,
    world.policy,
  );

  const cashFlowScenarios = simulateCandidateDates({
    asOf,
    dueDate: invoiceFacts.dueDate,
    amountCents: invoiceFacts.amountCents,
    discount: invoiceFacts.discount,
    openingCashCents: world.treasury.currentCashCents,
    minimumReserveCents: world.policy.minimumReserveCents,
    events: world.cashFlowEvents,
  });

  const policyFacts = await policyReader.read({
    treasury: world.treasury,
    policy: world.policy,
    capability: world.capability,
    proposedAmountCents: invoiceFacts.amountCents,
  });

  // Each builder receives only its own slice, so risk cannot see dates and
  // urgency cannot see the registry.
  const riskEvidence = buildRiskEvidence(invoiceFacts, supplierFacts, validationFacts);
  const urgencyFacts = buildUrgencyFacts(invoiceFacts, supplierFacts);

  return deepFreeze<DeterministicAnalysis>({
    asOfDate: asOf,
    invoiceFacts,
    supplierFacts,
    validationFacts,
    cashFlowScenarios,
    policyFacts,
    riskEvidence,
    urgencyFacts,
  });
}
