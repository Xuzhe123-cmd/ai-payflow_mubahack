/**
 * The live demo route.
 *
 * A server component: it reads the chain and runs the decision engine before
 * the page is sent, so a judge sees real figures on first paint rather than a
 * spinner. That also means no HTTP hop on the initial load — the reader is
 * called directly, and /api/decisions exists for refreshes and for anything
 * else that wants the same board.
 *
 * Deliberately outside the (app) route group, which gates on a mock sign-in
 * session. This reads real chain state and should not sit behind a fake login.
 */

import LiveBoard from "@/components/live/LiveBoard";
import { decideAll } from "@/lib/decision/engine";
import type { DecisionBoard } from "@/lib/services/decisionService";
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { createSuiQueries } from "@/lib/sui/client";
import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";

/** Chain state moves; a cached balance is a lie with a timestamp on it. */
export const dynamic = "force-dynamic";

/**
 * The seeded invoices carry fixed due dates, so the demo pins "today" rather
 * than letting every one of them drift into the past. Override with ?asOf=.
 */
const DEFAULT_AS_OF = "2026-09-01";

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const { asOf: requested } = await searchParams;
  const asOf = requested ?? DEFAULT_AS_OF;

  let board: DecisionBoard | null = null;
  let error: string | null = null;

  try {
    const network = configuredNetwork();
    const snapshot = await readChainSnapshot(createSuiQueries(network), loadManifest(network));
    board = { snapshot, decisions: await decideAll(snapshot, { asOf }) };
  } catch (caught) {
    // The client half can retry; a failed read is not a reason to show nothing.
    error = caught instanceof Error ? caught.message : "Could not read chain state";
  }

  return <LiveBoard initialBoard={board} initialError={error} asOf={asOf} />;
}
