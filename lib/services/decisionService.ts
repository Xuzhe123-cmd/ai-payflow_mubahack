/**
 * The interface's only route to decisions.
 *
 * Components call this and render what comes back. They do not import the
 * decision engine, the chain reader, or the Sui SDK, and they perform no
 * financial arithmetic of their own.
 */

import type { PaymentDecision } from "../decision/types";
import type { ChainSnapshot } from "../sui/chainTypes";
import type { DecisionsResponse } from "./contracts";
import { ChainUnavailableError } from "./chainService";

export interface DecisionBoard {
  snapshot: ChainSnapshot;
  decisions: PaymentDecision[];
}

const ENDPOINT = process.env.NEXT_PUBLIC_DECISIONS_ENDPOINT ?? "/api/decisions";

export async function fetchDecisionBoard(
  options: { asOf?: string; signal?: AbortSignal } = {},
): Promise<DecisionBoard> {
  const url = options.asOf ? `${ENDPOINT}?asOf=${encodeURIComponent(options.asOf)}` : ENDPOINT;

  let payload: DecisionsResponse;
  try {
    const response = await fetch(url, { signal: options.signal, cache: "no-store" });
    payload = (await response.json()) as DecisionsResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChainUnavailableError(
      error instanceof Error ? error.message : "Could not reach the decisions endpoint",
      "TRANSPORT",
    );
  }

  if (!payload.ok) throw new ChainUnavailableError(payload.message, payload.reason);
  return { snapshot: payload.snapshot, decisions: payload.decisions };
}
