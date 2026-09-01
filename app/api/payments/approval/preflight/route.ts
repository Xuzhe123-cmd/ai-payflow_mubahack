/**
 * What Sui would decide about one human approval — asked of Sui.
 *
 * WHY THIS EXISTS. The interface used to answer this question itself, by
 * re-running the policy rules in TypeScript against limits it had read. That is
 * a forecast, and a forecast presented as "Sui preflight passed" is a claim
 * about a validator that never ran. Worse, the two can disagree: the rule that
 * decides is in Move, and a mirror of it in another language is a second
 * implementation waiting to drift.
 *
 * HOW. It dry-runs the REAL `approval::approve_scoped` — the same plan object
 * that would be submitted, differing only by the `--dry-run` flag — against
 * live state, sent AS the approver. The validator evaluates every condition
 * exactly as it would on execution: the approver record, the enabled flag, the
 * expiry, the membership mirror and its freshness, the per-payment ceiling, the
 * recipient scope, the daily budget. Nothing is committed, no gas is spent, no
 * object changes. A refusal comes back as the Move abort code, which is the
 * same number that would abort a real submission.
 *
 * THE REQUEST NAMES AN INVOICE AND AN APPROVER. Amount and recipient are read
 * off the on-chain `Invoice`, so a caller cannot preflight a different payment
 * from the one they are about to ask for.
 *
 * WHAT IT IS NOT. It is not an approval and it does not pretend to be. A pass
 * means Sui WOULD accept one, not that any exists.
 */

import { NextResponse } from "next/server";

import { isValidSuiAddress } from "@mysten/sui/utils";

import { approveScopedCall, CompanyMissingError } from "@/lib/payments/approveScopedCall";
import { abortMeaning } from "@/lib/payments/approvalAborts";
import { INVOICE_STATUS_PAID, locateInvoice } from "@/lib/payments/invoiceLocator";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
/** A verdict about live authorization must never come from a cache. */
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

  const read = (key: string): string | undefined => {
    if (typeof body !== "object" || body === null) return undefined;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  const invoiceNumber = read("invoiceNumber");
  const approver = read("approver");
  if (!invoiceNumber || !approver) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "invoiceNumber and approver are required." },
      { status: 400 },
    );
  }
  if (!isValidSuiAddress(approver)) {
    // Refused rather than normalized: padding or truncating an address produces
    // a DIFFERENT address, and previewing the wrong one is worse than refusing.
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "approver must be a valid Sui address." },
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

  let invoice;
  try {
    invoice = await locateInvoice(network, manifest.packageId, invoiceNumber);
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
  if (!invoice) {
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_ON_CHAIN",
        error: `No on-chain invoice ${invoiceNumber} exists, so there is nothing to approve.`,
      },
      { status: 404 },
    );
  }
  if (invoice.status === INVOICE_STATUS_PAID) {
    return NextResponse.json(
      {
        ok: false,
        code: "ALREADY_PAID",
        error: `${invoice.invoiceNumber} is already settled on chain. There is nothing to approve.`,
        invoice,
      },
      { status: 409 },
    );
  }

  let plan;
  try {
    plan = approveScopedCall(manifest, invoice, approver, Date.now());
  } catch (error) {
    if (error instanceof CompanyMissingError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // Loaded here, not at module scope: it pulls in `node:child_process` with it.
  const { dryRunPlan } = await import("@/lib/payments/planDryRun");
  const verdict = await dryRunPlan(plan);
  const meaning = abortMeaning(verdict.abortCode);

  return NextResponse.json({
    ok: true,
    /** What Sui would do. A PREVIEW of execution, not an execution. */
    wouldAuthorize: verdict.wouldSucceed,
    abortCode: verdict.abortCode,
    /** The Move constant's own name, checkable against the source. */
    abortName: meaning?.name ?? null,
    code: verdict.wouldSucceed ? null : (meaning?.code ?? "REFUSED"),
    message: verdict.wouldSucceed
      ? "Sui evaluated this approval against the live authorization and would accept it. " +
        "Nothing was submitted — this is the chain's verdict, not an approval."
      : (meaning?.message ??
        "Sui refused this approval. See the abort code for the exact condition that failed."),
    target: `${plan.module}::${plan.function}`,
    gasMist: verdict.gasMist,
    invoice,
    /** Stated in the payload so no reader mistakes this for a settlement. */
    submitted: false,
  });
}
