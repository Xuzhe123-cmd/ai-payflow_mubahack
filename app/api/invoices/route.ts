/**
 * The invoice list, discovered from the chain.
 *
 * The list used to come from the eight demo scenarios, which meant an invoice
 * created on chain after the seed — the conditional pair, for instance — simply
 * did not exist as far as the interface was concerned. Nobody could navigate to
 * one, so nobody could see its escrow or its oracle evidence.
 *
 * Now the chain decides membership. Every `Invoice` object belonging to this
 * deployment appears, whoever created it and whenever. The scenario documents
 * are merged in only where one matches by invoice NUMBER, and only to supply
 * what the chain cannot: the document text the AI reads, and the received-at
 * date the inbox sorts by.
 *
 * Chain state is authoritative for anything about settlement. Local metadata is
 * authoritative for nothing.
 */

import { NextResponse } from "next/server";

import { resolveInvoiceSource } from "@/lib/demo/invoiceSource";
import { extractInvoice } from "@/lib/deterministic/extractInvoice";
import { DEMO_AS_OF_DATE } from "@/lib/demo/clock";
import { SUPPLIERS } from "@/lib/demo/suppliers";
import { discoverInvoices } from "@/lib/sui/chainReader";
import type { RawInvoiceDocument } from "@/lib/types";
import { createSuiQueries, graphqlUrlFor } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
/** Chain state moves; a cached invoice list would go stale the moment it is read. */
export const dynamic = "force-dynamic";

export interface DiscoveredInvoice {
  /** The id the pipeline analyses with — a scenario id, or the invoice number. */
  id: string;
  invoiceNumber: string;
  supplierName: string;
  supplierId: string;
  amountCents: number;
  currency: string;
  dueDate: string;
  daysUntilDue: number;
  receivedAt: string;
  sourceRef: string;
  hasDiscount: boolean;
  scenarioName: string;
  /** The source document the AI reads. Local — the chain holds no document. */
  document: RawInvoiceDocument;
  /** The invoice's own on-chain status. Authoritative. */
  chainStatus: string;
  objectId: string;
  /** False when no local document exists, so the AI cannot analyse it. */
  analysable: boolean;
}

export async function GET() {
  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const queries = createSuiQueries(network);

    const onChain = await discoverInvoices(queries, manifest, graphqlUrlFor(network));

    const invoices: DiscoveredInvoice[] = onChain.map((invoice) => {
      // Matched by invoice NUMBER, which is what both sides agree on. The
      // chain has no scenario id and the document has no object id.
      const source = resolveInvoiceSource(invoice.invoiceNumber);
      const supplier = SUPPLIERS.find((entry) => entry.id === invoice.supplierId);

      if (!source) {
        // On chain, but no document to analyse. It still belongs in the list —
        // hiding an invoice because the demo lacks its paperwork would be the
        // same mistake in the other direction.
        return {
          id: invoice.invoiceNumber,
          invoiceNumber: invoice.invoiceNumber,
          supplierName: supplier?.name ?? invoice.supplierId,
          supplierId: invoice.supplierId,
          amountCents: invoice.amountCents,
          currency: invoice.currency,
          dueDate: invoice.dueDate,
          daysUntilDue: daysUntil(invoice.dueDate),
          receivedAt: invoice.dueDate,
          sourceRef: `chain:${invoice.objectId.slice(0, 12)}`,
          hasDiscount: false,
          scenarioName: "On-chain invoice",
          document: placeholderDocument(invoice.invoiceNumber, invoice.objectId),
          chainStatus: invoice.status,
          objectId: invoice.objectId,
          analysable: false,
        };
      }

      const facts = extractInvoice(source.document, source.asOf);
      return {
        id: source.id,
        invoiceNumber: invoice.invoiceNumber,
        supplierName: facts.supplierName,
        supplierId: invoice.supplierId,
        // The CHAIN's figure, not the document's — they should agree, and where
        // they do not the chain is the one that governs a payment.
        amountCents: invoice.amountCents,
        currency: invoice.currency,
        dueDate: facts.dueDate,
        daysUntilDue: facts.daysUntilDue,
        receivedAt: source.document.receivedAt,
        sourceRef: source.document.sourceRef,
        hasDiscount: facts.discount !== null,
        scenarioName: source.scenarioName,
        document: source.document,
        chainStatus: invoice.status,
        objectId: invoice.objectId,
        analysable: true,
      };
    });

    invoices.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));

    return NextResponse.json({ ok: true, network, invoices });
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, reason: "NOT_DEPLOYED", message: error.message },
        { status: 503 },
      );
    }
    const message = error instanceof Error ? error.message : "Could not read the invoice list";
    return NextResponse.json({ ok: false, message }, { status: 503 });
  }
}

/**
 * A stand-in for an invoice that exists on chain with no document on file.
 *
 * It is deliberately empty of invoice text rather than plausible-looking: an
 * invented document body would be analysed as though it were real. `analysable`
 * is false for these, so nothing runs the pipeline over it.
 */
function placeholderDocument(invoiceNumber: string, objectId: string): RawInvoiceDocument {
  return {
    id: `chain-${objectId.slice(2, 14)}`,
    sourceRef: `chain:${objectId}`,
    receivedAt: DEMO_AS_OF_DATE,
    filename: `${invoiceNumber}.onchain`,
    text: "",
  };
}

function daysUntil(dueDate: string): number {
  if (!dueDate) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${DEMO_AS_OF_DATE}T00:00:00Z`);
  if (Number.isNaN(due)) return 0;
  return Math.round((due - now) / 86_400_000);
}
