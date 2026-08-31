/**
 * Refreshes the treasury's copy of one member's Chain-Doi status.
 *
 * POST ONLY, AND ONLY ON A CLICK. This submits a real transaction that spends
 * real gas, so it is never run on page load, never on render, and never as a
 * side effect of reading authorization. GET is not implemented on purpose — a
 * prefetch, a crawler, or a browser's speculative fetch must not be able to
 * spend gas.
 *
 * WHAT IT MAY DO, AND WHY THAT IS SAFE TO EXPOSE. `approval::sync_membership`
 * copies the live Company's verdict into the treasury mirror and writes the
 * clock reading beside it. It grants no membership, creates no authorization,
 * changes no limit, and moves no funds — see `syncMembershipCall` for the full
 * argument. Move leaves it permissionless because a caller can only make the
 * treasury agree with the company; this route adds no authority of its own.
 *
 * IT NEVER REPORTS A REFRESH THAT DID NOT HAPPEN. The response carries the
 * digest the chain issued or the error it produced. There is no simulated
 * branch: if the CLI is absent, unfunded, or the call aborts, the caller is
 * told exactly that and the interface keeps saying the verification is stale.
 */

import { NextResponse } from "next/server";

import { isValidSuiAddress } from "@mysten/sui/utils";

import { CompanyNotDeployedError, syncMembershipCall } from "@/lib/identity/syncMembershipCall";
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

  const address = (body as { address?: unknown }).address;
  if (typeof address !== "string" || !isValidSuiAddress(address)) {
    // Refused rather than normalized. Padding or truncating an address produces
    // a DIFFERENT address, and syncing the wrong one is worse than refusing.
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", error: "A valid Sui address is required." },
      { status: 400 },
    );
  }

  const network = configuredNetwork();
  let plan;
  try {
    plan = syncMembershipCall(loadManifest(network), address);
  } catch (error) {
    if (error instanceof CompanyNotDeployedError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 409 });
    }
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", error: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  // Loaded here, not at module scope: it pulls in the CLI wrapper and
  // `node:child_process` with it, which has no business in a build of a route
  // that might only ever return the 400 above.
  const { submitSyncMembership } = await import("@/lib/identity/syncMembershipSubmit");
  const result = submitSyncMembership(plan, network);

  return NextResponse.json(
    {
      ok: result.ok,
      address,
      digest: result.digest,
      explorerUrl: result.explorerUrl,
      abortCode: result.abortCode,
      error: result.error,
      call: `${plan.module}::${plan.function}`,
    },
    { status: result.ok ? 200 : 502 },
  );
}
