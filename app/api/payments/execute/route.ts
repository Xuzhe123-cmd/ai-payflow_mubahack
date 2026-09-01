/**
 * Settles an invoice on Sui. The real transaction, on an explicit click.
 *
 * POST ONLY. This moves money, so it must not be reachable by a prefetch or a
 * page load. GET is not implemented.
 *
 * THE REQUEST NAMES AN INVOICE AND NOTHING ELSE. Amount and recipient are read
 * off the on-chain `Invoice` object, so a caller cannot ask to pay a different
 * address or a larger sum. Move re-checks all ten assertions, the circuit
 * breaker, and the duplicate table regardless — this only removes the chance to
 * lie about the inputs.
 *
 * WHICH MOVE FUNCTION. `payment::execute_payment`, the agent acting on its own
 * AgentCap — the AUTONOMOUS path, and the one the HUMAN_ONLY circuit breaker
 * withdraws. The human-approved path is a different Move function with a
 * different authority and lives at `/api/payments/execute-approved`; the two
 * are deliberately not merged behind a mode flag, because that is how one of
 * them ends up inheriting a guard that belongs only to the other.
 *
 * IT DRY-RUNS BEFORE IT SUBMITS. The same plan object, one flag apart, so a
 * refusal — the breaker, a duplicate, a lapsed recommendation — is heard for
 * free and reported with the chain's own abort code instead of costing gas.
 *
 * IT NEVER CLAIMS SETTLEMENT ON ITS OWN. On success the invoice is RE-READ from
 * chain and its status returned; the interface may only render PAID because the
 * chain says so, with the digest the chain issued.
 */

import { NextResponse } from "next/server";

import { abortMeaning } from "@/lib/payments/approvalAborts";
import { AgentCapMissingError, executePaymentCall } from "@/lib/payments/executeCall";
import { INVOICE_STATUS_PAID, locateInvoice } from "@/lib/payments/invoiceLocator";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const invoiceNumber = (body as { invoiceNumber?: unknown }).invoiceNumber;
  const recommendationId = (body as { recommendationId?: unknown }).recommendationId;
  if (typeof invoiceNumber !== "string" || invoiceNumber.trim() === "") {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "invoiceNumber is required." },
      { status: 400 },
    );
  }

  const network = configuredNetwork();
  let manifest;
  try {
    manifest = loadManifest(network);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // --- the invoice, as the chain holds it ------------------------------------
  const invoice = await locateInvoice(network, manifest.packageId, invoiceNumber);
  if (!invoice) {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_ON_CHAIN",
        error: `No on-chain invoice ${invoiceNumber} exists. Nothing was submitted.`,
      },
      { status: 404 },
    );
  }

  if (invoice.status === INVOICE_STATUS_PAID) {
    // Move would refuse this too; refusing here makes the reason legible
    // without spending gas to hear it.
    return NextResponse.json(
      {
        ok: false,
        code: "ALREADY_PAID",
        error: `${invoice.invoiceNumber} is already settled on chain. Nothing was submitted.`,
        invoice,
      },
      { status: 409 },
    );
  }

  let plan;
  try {
    plan = executePaymentCall(
      manifest,
      invoice,
      typeof recommendationId === "string" && recommendationId
        ? recommendationId
        : `rec_${invoice.invoiceNumber.toLowerCase()}`,
      Date.now(),
    );
  } catch (error) {
    if (error instanceof AgentCapMissingError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // ASK BEFORE PAYING. A dry run is evaluated by a validator against live state
  // and discarded: same bytecode, same assertions, same abort code, no gas and
  // no state change. A payment the chain would refuse — the circuit breaker
  // among them — is therefore refused here for nothing.
  const { dryRunPlan } = await import("@/lib/payments/planDryRun");
  const preview = await dryRunPlan(plan);
  if (!preview.wouldSucceed) {
    const meaning = abortMeaning(preview.abortCode);
    return NextResponse.json(
      {
        ok: false,
        code: meaning?.code ?? "REFUSED",
        abortCode: preview.abortCode,
        abortName: meaning?.name ?? null,
        error:
          meaning?.message ??
          "Sui refused this payment. See the abort code for the condition that failed.",
        detail: preview.error,
        invoice,
        submitted: false,
      },
      { status: 422 },
    );
  }

  // Loaded here, not at module scope: it pulls in the CLI wrapper and
  // `node:child_process` with it.
  const { submitExecutePayment } = await import("@/lib/payments/executeSubmit");
  const result = submitExecutePayment(plan, network);

  if (!result.ok) {
    const meaning = abortMeaning(result.abortCode);
    return NextResponse.json(
      {
        ok: false,
        code: "SUBMIT_FAILED",
        error: result.error,
        abortCode: result.abortCode,
        abortName: meaning?.name ?? null,
        invoice,
      },
      { status: 502 },
    );
  }

  // RE-READ. PAID may only be reported because the chain says so.
  let settled = null;
  let readError: string | null = null;
  try {
    settled = await locateInvoice(network, manifest.packageId, invoiceNumber);
  } catch (error) {
    readError = error instanceof Error ? error.message : "The chain could not be re-read.";
  }

  return NextResponse.json({
    ok: true,
    digest: result.digest,
    explorerUrl: result.explorerUrl,
    call: `${plan.module}::${plan.function}`,
    authority: "AGENT",
    gasMist: preview.gasMist,
    invoice: settled ?? invoice,
    /** True only when the re-read shows the invoice actually settled. */
    settled: settled?.status === INVOICE_STATUS_PAID,
    readError,
  });
}
