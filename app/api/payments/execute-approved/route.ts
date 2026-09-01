/**
 * Settles an invoice under a human approval. The real transaction.
 *
 * A SEPARATE ROUTE FROM `/api/payments/execute`, DELIBERATELY. The two paths
 * are different Move functions with different authorities and different
 * relationships to the circuit breaker, and running them through one endpoint
 * with a mode flag is how they end up sharing a guard that only one of them
 * should have:
 *
 *   /api/payments/execute            payment::execute_payment   AgentCap
 *   /api/payments/execute-approved   payment::execute_approved  HumanApproval
 *
 * POST ONLY. This moves money, so it must not be reachable by a prefetch or a
 * page load. GET is not implemented.
 *
 * THE REQUEST NAMES AN INVOICE AND NOTHING ELSE. Amount and recipient are not
 * accepted, not read from the request, and not even read from the invoice: Move
 * takes them from inside the `HumanApproval` object, which is what stops an
 * approval for one payment being spent on another.
 *
 * IT REFUSES WITHOUT A LIVE APPROVAL. There is no branch that settles on the
 * strength of a preflight, a policy mirror, or a click. The approval object
 * must exist on chain, unconsumed and unexpired, or nothing is submitted.
 *
 * IT NEVER CLAIMS SETTLEMENT ON ITS OWN. On success the invoice is RE-READ from
 * chain and its status returned; the interface may only render PAID because the
 * chain says so, with the digest the chain issued.
 */

import { NextResponse } from "next/server";

import { abortMeaning } from "@/lib/payments/approvalAborts";
import { liveApproval, locateApprovals } from "@/lib/payments/approvalLocator";
import { executeApprovedCall } from "@/lib/payments/executeApprovedCall";
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
        error: "No on-chain invoice " + invoiceNumber + " exists. Nothing was submitted.",
      },
      { status: 404 },
    );
  }

  // IDEMPOTENCE. Move refuses a second settlement too (check 8); refusing here
  // makes the reason legible without spending gas to hear it, and stops a
  // reload from re-submitting a payment that already landed.
  if (invoice.status === INVOICE_STATUS_PAID) {
    return NextResponse.json(
      {
        ok: false,
        code: "ALREADY_PAID",
        error:
          invoice.invoiceNumber + " is already settled on chain. Nothing was submitted.",
        invoice,
      },
      { status: 409 },
    );
  }

  // --- the approval, as the chain holds it -----------------------------------
  let approval;
  try {
    approval = liveApproval(
      await locateApprovals(network, manifest.packageId, invoiceNumber),
      manifest.objects.treasuryId,
      Date.now(),
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code: "CHAIN_UNAVAILABLE",
        error: error instanceof Error ? error.message : "The chain could not be read.",
      },
      { status: 503 },
    );
  }

  if (!approval) {
    return NextResponse.json(
      {
        ok: false,
        code: "NO_APPROVAL",
        error:
          "No live HumanApproval exists on chain for " +
          invoice.invoiceNumber +
          ". A person authorized to approve must submit one first. Nothing was submitted.",
        invoice,
      },
      { status: 409 },
    );
  }

  const plan = executeApprovedCall(
    manifest,
    approval,
    invoice,
    typeof recommendationId === "string" && recommendationId
      ? recommendationId
      : "rec_" + invoice.invoiceNumber.toLowerCase(),
    Date.now(),
  );

  // DRY RUN FIRST. The same plan object, one flag apart. A settlement the chain
  // would refuse is heard for free, with its own abort code, before any gas is
  // spent — and, more to the point, before a spinner starts that would have
  // nothing to resolve to.
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

  const { submitMoveCall } = await import("@/lib/payments/executeSubmit");
  const result = submitMoveCall(plan, network);

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
    call: plan.module + "::" + plan.function,
    authority: "HUMAN_APPROVAL",
    approvalObjectId: approval.objectId,
    invoice: settled ?? invoice,
    /** True only when the re-read shows the invoice actually settled. */
    settled: settled?.status === INVOICE_STATUS_PAID,
    gasMist: preview.gasMist,
    readError,
  });
}
