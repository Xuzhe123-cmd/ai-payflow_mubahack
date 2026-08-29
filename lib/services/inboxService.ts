/**
 * Finance inbox service — invoice detection.
 *
 * SWAP POINT — Gmail / Outlook.
 *   connectFinanceInbox() becomes an OAuth grant, and detectInvoices() becomes
 *   a message search plus attachment fetch. The adapter shape below is what the
 *   real connector has to satisfy; nothing in the interface changes.
 *
 * Field extraction is NOT done here. It is delegated to the deterministic
 * extractor so the inbox list and the analysis screen can never show different
 * numbers for the same invoice.
 */

import type { Cents, IsoDate, RawInvoiceDocument } from "../types";
import { extractInvoice } from "../deterministic/extractInvoice";
import { SCENARIOS, DEMO_AS_OF_DATE } from "../demo/scenarios";

/** One detected invoice, before any AI has looked at it. */
export interface DetectedInvoice {
  /** Stable id used by every route: /invoices/[id]. */
  id: string;
  /** Which demo world this invoice is analyzed against. */
  scenarioId: string;
  scenarioName: string;
  document: RawInvoiceDocument;
  invoiceNumber: string;
  supplierName: string;
  amountCents: Cents;
  currency: string;
  dueDate: IsoDate;
  daysUntilDue: number;
  receivedAt: IsoDate;
  sourceRef: string;
  hasDiscount: boolean;
}

export type ConnectStageId =
  | "connect"
  | "scan"
  | "detect"
  | "extract"
  | "import";

export interface ConnectStage {
  id: ConnectStageId;
  label: string;
  /** Roughly how long the real operation takes; the demo can scale it. */
  durationMs: number;
}

export const CONNECT_STAGES: ConnectStage[] = [
  { id: "connect", label: "Connecting finance inbox", durationMs: 620 },
  { id: "scan", label: "Scanning recent messages", durationMs: 700 },
  { id: "detect", label: "Detecting supplier invoices", durationMs: 640 },
  { id: "extract", label: "Extracting invoice fields", durationMs: 560 },
  { id: "import", label: "Importing to treasury", durationMs: 420 },
];

export interface InboxAdapter {
  readonly id: string;
  readonly label: string;
  detectInvoices(asOf: IsoDate): Promise<DetectedInvoice[]>;
}

/**
 * The demo adapter. Every scenario document is a message sitting in the
 * finance inbox — the scenarios are not eight different apps, they are eight
 * invoices that happen to have arrived.
 */
export const DemoInboxAdapter: InboxAdapter = {
  id: "demo",
  label: "Demo finance inbox",
  async detectInvoices(asOf: IsoDate): Promise<DetectedInvoice[]> {
    return SCENARIOS.map((scenario) => {
      const facts = extractInvoice(scenario.document, asOf);
      return {
        id: scenario.id,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        document: scenario.document,
        invoiceNumber: facts.invoiceNumber,
        supplierName: facts.supplierName,
        amountCents: facts.amountCents,
        currency: facts.currency,
        dueDate: facts.dueDate,
        daysUntilDue: facts.daysUntilDue,
        receivedAt: scenario.document.receivedAt,
        sourceRef: scenario.document.sourceRef,
        hasDiscount: facts.discount !== null,
      };
    }).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  },
};

let adapter: InboxAdapter = DemoInboxAdapter;

/** Lets a real Gmail adapter be injected without touching any component. */
export function setInboxAdapter(next: InboxAdapter): void {
  adapter = next;
}

export function activeInboxAdapter(): InboxAdapter {
  return adapter;
}

export function detectInvoices(asOf: IsoDate = DEMO_AS_OF_DATE): Promise<DetectedInvoice[]> {
  return adapter.detectInvoices(asOf);
}
