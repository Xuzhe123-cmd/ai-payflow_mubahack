/**
 * Resolving an invoice id to the document the pipeline reads.
 *
 * There are two kinds of invoice in this deployment and only one used to be
 * reachable. The eight seeded ones are scenarios; the conditional pair were
 * created on chain afterwards and had no scenario, so they never appeared in
 * the invoice list and nothing could analyse them.
 *
 * This is the one lookup both the list and the analyzer use, so a caller never
 * has to know which kind it is holding. It is NOT a second invoice source — the
 * LIST comes from the chain. This only answers "which document belongs to this
 * invoice", which the chain cannot say, because the chain holds no document.
 */

import { conditionalDocumentFor, conditionalWorld } from "../escrow/conditionalInvoices";
import { extractInvoice } from "../deterministic/extractInvoice";
import { DEMO_AS_OF_DATE } from "./clock";
import { SCENARIOS } from "./scenarios";
import type { IsoDate, RawInvoiceDocument, WorldSnapshot } from "../types";

export interface ResolvedInvoiceSource {
  /** The id the pipeline is called with. A scenario id, or an invoice number. */
  id: string;
  invoiceNumber: string;
  document: RawInvoiceDocument;
  world: WorldSnapshot;
  asOf: IsoDate;
  /** Where the document came from, for reporting rather than for logic. */
  kind: "scenario" | "conditional";
  scenarioName: string;
  description: string;
}

/**
 * Finds the document for an id, whichever kind it is.
 *
 * Accepts a scenario id or an invoice number, because callers legitimately hold
 * both: the queue keys on scenario ids, and a chain-discovered invoice has only
 * its number.
 */
export function resolveInvoiceSource(id: string): ResolvedInvoiceSource | null {
  const scenario = SCENARIOS.find(
    (entry) => entry.id === id || invoiceNumberOf(entry.document, entry.asOfDate) === id,
  );
  if (scenario) {
    return {
      id: scenario.id,
      invoiceNumber: invoiceNumberOf(scenario.document, scenario.asOfDate),
      document: scenario.document,
      world: scenario.world,
      asOf: scenario.asOfDate,
      kind: "scenario",
      scenarioName: scenario.name,
      description: scenario.description,
    };
  }

  // A conditional invoice, created on chain after the original seed.
  const document = conditionalDocumentFor(id);
  if (document) {
    return {
      id,
      invoiceNumber: id,
      document,
      world: conditionalWorld(),
      asOf: DEMO_AS_OF_DATE,
      kind: "conditional",
      scenarioName: "Conditional settlement",
      description:
        "Authorized within the agent's limits, and payable only once the shipment is confirmed.",
    };
  }

  return null;
}

/** Every id the pipeline can analyse, for a caller that wants to enumerate. */
export function analysableIds(): string[] {
  return SCENARIOS.map((scenario) => scenario.id);
}

function invoiceNumberOf(document: RawInvoiceDocument, asOf: IsoDate): string {
  return extractInvoice(document, asOf).invoiceNumber;
}
