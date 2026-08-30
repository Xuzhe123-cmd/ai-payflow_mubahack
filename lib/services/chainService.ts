/**
 * The interface's only route to chain state.
 *
 * SWAP POINT — none needed. Components call this; it calls /api/chain; the
 * server does the reading. No component imports the Sui SDK, learns an object
 * id, or discovers that the settlement coin has six decimals.
 *
 * Read-only. There is deliberately no write counterpart here yet.
 */

import type { ChainSnapshot } from "../sui/chainTypes";
import type { ChainSnapshotResponse } from "./contracts";

export class ChainUnavailableError extends Error {
  constructor(
    message: string,
    /** NOT_DEPLOYED is a normal developer state, not a fault worth alarming about. */
    readonly reason: "NOT_DEPLOYED" | "READ_FAILED" | "TRANSPORT",
  ) {
    super(message);
    this.name = "ChainUnavailableError";
  }
}

const ENDPOINT = process.env.NEXT_PUBLIC_CHAIN_ENDPOINT ?? "/api/chain";

export async function fetchChainSnapshot(signal?: AbortSignal): Promise<ChainSnapshot> {
  let payload: ChainSnapshotResponse;
  try {
    const response = await fetch(ENDPOINT, { signal, cache: "no-store" });
    payload = (await response.json()) as ChainSnapshotResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChainUnavailableError(
      error instanceof Error ? error.message : "Could not reach the chain endpoint",
      "TRANSPORT",
    );
  }

  if (!payload.ok) {
    throw new ChainUnavailableError(payload.message, payload.reason);
  }
  return payload.snapshot;
}
