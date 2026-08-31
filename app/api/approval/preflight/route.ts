/**
 * What Sui would decide about one human approval — asked of Sui.
 *
 * WHY THIS EXISTS. The interface used to answer this question itself, from a
 * TypeScript constant, and got it wrong by a factor of ten: a $30,000 invoice
 * passed a $250,000 demo figure while the live on-chain authorization permitted
 * $25,000. The answer now comes from the chain, because the chain is the only
 * thing that can give a true one.
 *
 * HOW. It dry-runs the real `approval::approve_scoped` against live state. The
 * validator evaluates every condition exactly as it would on execution — the
 * approver record, the enabled flag, the expiry, the membership mirror and its
 * freshness, the per-payment ceiling, the recipient scope, the daily budget —
 * and returns its verdict. Nothing is committed, no gas is spent, no object
 * changes. A refusal comes back as the Move abort code, which is the same
 * number that would abort a real submission.
 *
 * WHAT IT IS NOT. It is not an execution and it does not pretend to be. A
 * success here means Sui WOULD accept the approval, not that anything has been
 * approved or paid. Submitting for real needs the zkLogin session to sign,
 * which this build does not yet do.
 */

import { NextResponse } from "next/server";

import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import { callPackageId } from "@/lib/sui/deployment";
import { dryRunApproveScoped } from "@/lib/sui/approvalPreflight";

export const runtime = "nodejs";
/** A verdict about live authorization must never come from a cache. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const read = (key: string): string | undefined => {
    if (typeof body !== "object" || body === null) return undefined;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const amountCents = (() => {
    if (typeof body !== "object" || body === null) return undefined;
    const value = (body as Record<string, unknown>).amountCents;
    return typeof value === "number" ? value : undefined;
  })();

  const invoiceNumber = read("invoiceNumber");
  const recipient = read("recipient");
  const approver = read("approver");

  if (!invoiceNumber || !recipient || !approver || amountCents === undefined) {
    return NextResponse.json(
      {
        ok: false,
        code: "BAD_REQUEST",
        message: "invoiceNumber, amountCents, recipient and approver are required.",
      },
      { status: 400 },
    );
  }

  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const identity = manifest.identity;

    if (!identity?.companyId) {
      return NextResponse.json({
        ok: true,
        wouldAuthorize: false,
        code: "NO_COMPANY",
        message: "No company identity exists on chain, so no authorization can be evaluated.",
      });
    }

    const verdict = await dryRunApproveScoped({
      network,
      packageId: callPackageId(manifest),
      coinType: manifest.coinType,
      treasuryId: manifest.objects.treasuryId,
      companyId: identity.companyId,
      invoiceNumber,
      amountCents,
      recipient,
      approver,
    });

    return NextResponse.json({ ok: true, ...verdict });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The chain could not be reached.";
    return NextResponse.json(
      { ok: false, code: "CHAIN_UNAVAILABLE", message },
      { status: 503 },
    );
  }
}
