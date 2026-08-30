/**
 * Live chain state PLUS a decision for every seeded invoice.
 *
 * One route rather than two, because the interface needs both together and a
 * dashboard assembled from two reads taken seconds apart can show a balance
 * that disagrees with the decisions drawn from it.
 *
 * Read-only. The decision engine returns recommendations; nothing here builds,
 * signs or submits a transaction.
 */

import { NextResponse } from "next/server";

import { decideAll } from "@/lib/decision/engine";
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { createSuiQueries } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import type { DecisionsResponse } from "@/lib/services/contracts";

export const runtime = "nodejs";
/** Chain state moves; a cached balance is a lie with a timestamp on it. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const snapshot = await readChainSnapshot(createSuiQueries(network), manifest);

    // The demo runs against a frozen calendar, so "today" is overridable —
    // otherwise every seeded due date drifts into the past.
    const asOf = new URL(request.url).searchParams.get("asOf") ?? undefined;
    const decisions = await decideAll(snapshot, { asOf: asOf ?? undefined });

    const payload: DecisionsResponse = { ok: true, snapshot, decisions };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, reason: "NOT_DEPLOYED", message: error.message },
        { status: 503 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error reading chain state";
    return NextResponse.json({ ok: false, reason: "READ_FAILED", message }, { status: 502 });
  }
}
