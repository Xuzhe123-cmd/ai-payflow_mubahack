/**
 * The `HumanApproval` object: reading whether one exists, and creating one.
 *
 * GET — DOES A LIVE APPROVAL EXIST ON CHAIN FOR THIS INVOICE?
 *
 * This is the question the interface must ask before it may say "cleared for
 * execution". It used to say that on the strength of a TypeScript policy mirror
 * returning APPROVED — a forecast, made before any approval had been minted,
 * signed or submitted, beside an Execute button that could not work. The answer
 * now comes from the chain: an object id, or nothing.
 *
 * GET reads and submits nothing, so it is safe on a page load.
 *
 * POST — CREATE ONE, FOR REAL.
 *
 * Dry-runs first and submits only if the chain says it would accept it, so a
 * refusal costs no gas. The approval is signed BY THE APPROVER:
 * `approve_scoped` reads `ctx.sender()`, and this server will not substitute a
 * different signer to make the demo work — an approval signed by somebody else
 * is somebody else's approval. Where no key for the approver is held, it says
 * so and submits nothing.
 *
 * NO POLICY LIVES HERE. The ceiling, the daily budget, the recipient scope, the
 * expiry, the membership requirement and its freshness are all treasury state,
 * asserted by Move at mint time and again at execution. This route reads the
 * invoice, builds the call, and reports what the chain said.
 */

import { NextResponse } from "next/server";

import { isValidSuiAddress } from "@mysten/sui/utils";

import { abortMeaning } from "@/lib/payments/approvalAborts";
import { judgeApproval, liveApproval, locateApprovals } from "@/lib/payments/approvalLocator";
import { approveScopedCall, CompanyMissingError } from "@/lib/payments/approveScopedCall";
import { INVOICE_STATUS_PAID, locateInvoice } from "@/lib/payments/invoiceLocator";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- reading -------------------------------------------------------------------

export async function GET(request: Request) {
  const invoiceNumber = new URL(request.url).searchParams.get("invoiceNumber")?.trim();
  if (!invoiceNumber) {
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

  const now = Date.now();
  let approvals;
  try {
    // The TYPE package is the original publish: Move type identity is fixed at
    // the address that first defined the struct, and the upgraded id matches
    // nothing.
    approvals = await locateApprovals(network, manifest.packageId, invoiceNumber);
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

  const live = liveApproval(approvals, manifest.objects.treasuryId, now);

  return NextResponse.json({
    ok: true,
    invoiceNumber,
    /** Null when the chain holds no spendable approval. Never inferred. */
    approval: live,
    /**
     * Every approval found, with the chain's own reason for discounting the
     * ones that are not live — a consumed approval and a missing one are
     * different facts and the interface must be able to tell them apart.
     */
    considered: approvals.map((entry) => ({
      objectId: entry.objectId,
      consumed: entry.consumed,
      expiresAtMs: entry.expiresAtMs,
      ...judgeApproval(entry, manifest.objects.treasuryId, now),
    })),
    checkedAtMs: now,
  });
}

// --- creating ------------------------------------------------------------------

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
  if (invoice.status === INVOICE_STATUS_PAID) {
    return NextResponse.json(
      {
        ok: false,
        code: "ALREADY_PAID",
        error:
          invoice.invoiceNumber +
          " is already settled on chain. Nothing was submitted.",
        invoice,
      },
      { status: 409 },
    );
  }

  // ALREADY APPROVED. A second approval would authorize a second payment, and a
  // refresh must not be able to mint one — Move would happily create it, so the
  // guard belongs here.
  const existing = liveApproval(
    await locateApprovals(network, manifest.packageId, invoiceNumber),
    manifest.objects.treasuryId,
    Date.now(),
  );
  if (existing) {
    return NextResponse.json({
      ok: true,
      alreadyApproved: true,
      approval: existing,
      digest: null,
      message:
        "A live HumanApproval already exists on chain for this invoice. Nothing was submitted.",
    });
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

  // DRY RUN FIRST. The same plan object, one flag apart, so a refusal is heard
  // for free and the reader is shown the chain's own abort code.
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
          "Sui refused this approval. See the abort code for the condition that failed.",
        detail: preview.error,
        submitted: false,
      },
      { status: 422 },
    );
  }

  const { NoSignerError, submitApproveScoped } = await import("@/lib/payments/approvalSubmit");
  let result;
  try {
    result = submitApproveScoped(plan, network);
  } catch (error) {
    if (error instanceof NoSignerError) {
      // NOT A CHAIN REFUSAL. Sui would accept this approval; this build cannot
      // ask on the approver's behalf. Reported with its own code so the
      // interface never renders it beside a Move abort.
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
          approver: error.approver,
          wouldAuthorize: true,
          submitted: false,
        },
        { status: 501 },
      );
    }
    throw error;
  }

  if (!result.ok) {
    const meaning = abortMeaning(result.abortCode);
    return NextResponse.json(
      {
        ok: false,
        code: meaning?.code ?? "SUBMIT_FAILED",
        abortCode: result.abortCode,
        abortName: meaning?.name ?? null,
        error: result.error,
      },
      { status: 502 },
    );
  }

  // RE-READ. An approval may only be reported as existing because the chain
  // shows the object, not because a transaction was accepted.
  const confirmed = liveApproval(
    await locateApprovals(network, manifest.packageId, invoiceNumber),
    manifest.objects.treasuryId,
    Date.now(),
  );

  return NextResponse.json({
    ok: true,
    digest: result.digest,
    explorerUrl: result.explorerUrl,
    call: plan.module + "::" + plan.function,
    /** Null when the object is not yet visible. Never assumed from the digest. */
    approval: confirmed,
    confirmed: confirmed !== null,
  });
}
