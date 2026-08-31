/**
 * One invoice — the one that was asked for — put to both providers.
 *
 * INVOICE-AWARE, NOT PINNED. The invoice comes from `?invoice=`; the catalog
 * resolves it to the scenario that produces it. There is no invoice number
 * written into this file, and the default only applies when the caller names
 * none.
 *
 * AN UNKNOWN INVOICE IS A 404, NOT A FALLBACK. Quietly analyzing the default
 * instead would render one invoice's opinions under another invoice's heading —
 * the precise failure this route is meant to make impossible.
 *
 * SEPARATE FROM /api/defense ON PURPOSE. This costs two real model calls and
 * takes seconds; the defense screen must render its behavioural statistics and
 * its chain-read breaker state immediately, without waiting on inference.
 *
 * GET, and it writes nothing — no chain call, no state, no record. A provider
 * that is unconfigured or unreachable comes back as such, with the real reason,
 * and consensus falls back to HUMAN_REVIEW. Nothing here fills in a missing
 * opinion.
 */

import { NextResponse } from "next/server";

import { analyzeWithBothProviders } from "@/lib/ai/dualAnalysis";
import { resolveConsensus, CONSENSUS_GRANTS_NOTHING } from "@/lib/ai/providers";
import {
  DEMO_MODE_BANNER,
  DEMO_MODE_DISCLAIMER,
  hasRecordedAnalysis,
  providerAnalysisFor,
} from "@/lib/demo/providerAnalysisCatalog";
import { buildAnalysis } from "@/lib/deterministic/buildAnalysis";
import { DEMO_AS_OF_DATE } from "@/lib/demo/clock";
import {
  DEFAULT_INVOICE_NUMBER,
  findByInvoiceNumber,
  invoiceCatalog,
} from "@/lib/demo/invoiceCatalog";
import { scenarioById } from "@/lib/demo/scenarios";
import { conditionalDocumentFor, conditionalWorld } from "@/lib/escrow/conditionalInvoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested =
    new URL(request.url).searchParams.get("invoice")?.trim() || DEFAULT_INVOICE_NUMBER;

  const entry = await findByInvoiceNumber(requested);
  if (!entry) {
    // Named, and refused. The caller is told what it asked for and what exists.
    const catalog = await invoiceCatalog();
    return NextResponse.json(
      {
        ok: false,
        error: `No invoice ${requested} exists. Nothing was analyzed.`,
        requested,
        available: catalog.map((row) => row.invoiceNumber),
      },
      { status: 404 },
    );
  }

  // THE FACT SHEET IS COMPUTED BEFORE EITHER MODEL IS ASKED, and both receive
  // the identical one. Neither model supplies a figure; they judge figures the
  // deterministic layer established for THIS invoice.
  //
  // Conditional (escrow) invoices carry no scenario and are built from their own
  // document and world instead.
  const scenario = entry.scenarioId ? scenarioById(entry.scenarioId) : null;
  const document = scenario
    ? scenario.document
    : conditionalDocumentFor(entry.invoiceNumber);
  if (!document) {
    return NextResponse.json(
      { ok: false, error: `No document exists for ${entry.invoiceNumber}.` },
      { status: 404 },
    );
  }

  const analysis = await buildAnalysis({
    document,
    world: scenario ? scenario.world : conditionalWorld(),
    asOf: DEMO_AS_OF_DATE,
  });

  const startedAt = Date.now();
  const invoiceNumber = analysis.invoiceFacts.invoiceNumber;

  // LIVE FIRST, ALWAYS. The fallback is only reached after both models have
  // actually been asked and at least one has failed — a quota error, a
  // timeout, a missing credential. It is never preferred for speed.
  const live = await analyzeWithBothProviders(analysis);
  const failures = live.filter((result) => result.status !== "OK");
  const usingFallback = failures.length > 0;

  const providers = usingFallback
    ? providerAnalysisFor({
        invoiceNumber,
        scenarioId: scenario?.id ?? null,
        // Derivation reads THIS invoice's own fact sheet, so an invoice with no
        // recording still gets an analysis about itself rather than a generic one.
        analysis,
      })
    : live;
  const consensus = resolveConsensus(providers);

  return NextResponse.json({
    ok: true,
    // The one field the interface must read before it labels anything. LIVE
    // means both models answered; anything else is recorded data.
    mode: usingFallback ? "DEMO_FALLBACK" : "LIVE",
    banner: usingFallback ? DEMO_MODE_BANNER : null,
    disclaimer: usingFallback ? DEMO_MODE_DISCLAIMER : null,
    /** Whether this invoice has a recorded opinion, or got the generic one. */
    recorded: usingFallback
      ? hasRecordedAnalysis(invoiceNumber, scenario?.id ?? null)
      : null,
    /**
     * Why the live path was abandoned — the providers' own error text.
     *
     * Kept so the screen can say WHICH provider failed and with what. "Live AI
     * unavailable" without the reason invites the reader to assume a bug in
     * this application rather than a quota at the vendor.
     */
    liveFailures: failures.map((failure) => ({
      provider: failure.provider,
      status: failure.status,
      reason: failure.status === "DEMO_FALLBACK" ? null : failure.reason,
    })),
    scenarioId: scenario?.id ?? null,
    // Read back off the analysis rather than echoed from the request, so the
    // heading always names the invoice that was actually analyzed.
    invoiceNumber: analysis.invoiceFacts.invoiceNumber,
    amountCents: analysis.invoiceFacts.amountCents,
    supplierId: analysis.supplierFacts.supplierId,
    providers,
    consensus,
    consensusCaveat: CONSENSUS_GRANTS_NOTHING,
    latencyMs: Date.now() - startedAt,
  });
}
