/**
 * Live chain state, read server-side.
 *
 * The Sui SDK stays on this side of the wire. Components receive resolved,
 * already-decoded values through this route and never learn an object id, a
 * fullnode URL, or how many decimals the settlement coin has.
 *
 * Read-only: this handler cannot build, sign or submit a transaction, and the
 * query layer it uses exposes no way to.
 */

import { NextResponse } from "next/server";

import { readChainSnapshot } from "@/lib/sui/chainReader";
import { createSuiQueries } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import type { ChainSnapshotResponse } from "@/lib/services/contracts";

export const runtime = "nodejs";
/** Chain state moves; a cached balance would be a lie with a timestamp on it. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const snapshot = await readChainSnapshot(createSuiQueries(network), manifest);

    const payload: ChainSnapshotResponse = { ok: true, snapshot };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      // Not an error condition for a developer running without a deployment —
      // the interface should say so plainly rather than showing a stack trace.
      return NextResponse.json(
        { ok: false, reason: "NOT_DEPLOYED", message: error.message },
        { status: 503 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error reading chain state";
    return NextResponse.json({ ok: false, reason: "READ_FAILED", message }, { status: 502 });
  }
}
