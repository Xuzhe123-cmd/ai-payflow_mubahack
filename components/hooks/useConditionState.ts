"use client";

/**
 * The live shipment condition for an invoice, if it has one.
 *
 * One fetch, shared. Both the decision chain's action box and the shipment
 * evidence panel need the same chain-derived state, and two independent fetches
 * could disagree with each other for a moment — which is precisely the class of
 * bug this whole layer exists to remove.
 *
 * `null` means the invoice carries NO shipment condition, which is different
 * from "the escrow has not been created yet". The first is an ordinary invoice;
 * the second is a conditional one at stage READY.
 */

import { useEffect, useState } from "react";

import type { EscrowDemoState } from "@/lib/escrow/demoFlow";

export interface ConditionState {
  invoiceNumber: string;
  amountCents: number;
  recipient: string;
  stage: EscrowDemoState["stage"];
  escrow: {
    objectId: string;
    status: string;
    heldCents: number;
    attestationId: string | null;
    explorerUrl: string;
  } | null;
  attestation: EscrowDemoState["attestation"];
  proof: EscrowDemoState["proof"];
  proofMatchesAttestation: boolean | null;
  fundsHeldCents: number;
  supplierPaid: boolean;
}

/**
 * Cached at module scope so a page rendering several invoices makes one call.
 *
 * Deliberately not a long-lived cache: it is cleared on reload, and the escrow
 * page refetches on mount. Stale chain state shown as current is worse than a
 * second request.
 */
let inFlight: Promise<Map<string, ConditionState>> | null = null;

async function loadConditions(): Promise<Map<string, ConditionState>> {
  const response = await fetch("/api/escrow/state");
  const payload = await response.json();
  const byInvoice = new Map<string, ConditionState>();
  if (payload.ok) {
    for (const demo of payload.demos as ConditionState[]) {
      byInvoice.set(demo.invoiceNumber, demo);
    }
  }
  return byInvoice;
}

/** Stable empty map, so an unresolved read does not re-render on identity. */
const EMPTY: Map<string, ConditionState> = new Map();

/**
 * Every conditional invoice's escrow state at once.
 *
 * One response covers all of them, and the invoice LIST needs the whole set:
 * an escrow at HELD belongs in a held bucket and an escrow at RELEASED belongs
 * in the paid one, and neither fact is visible from the local run.
 */
export function useConditionStates(): {
  byInvoice: Map<string, ConditionState>;
  resolved: boolean;
} {
  const [byInvoice, setByInvoice] = useState<Map<string, ConditionState>>(EMPTY);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    inFlight ??= loadConditions();

    void inFlight
      .then((loaded) => {
        if (!cancelled) setByInvoice(loaded);
      })
      .catch(() => {
        // Unreachable endpoint. Treated as "no condition known", which shows an
        // ordinary invoice rather than inventing an escrow state.
        if (!cancelled) setByInvoice(EMPTY);
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { byInvoice, resolved };
}

export function useConditionState(invoiceNumber: string): {
  condition: ConditionState | null;
  /** False until the chain has been consulted. Nothing should render before. */
  resolved: boolean;
} {
  const { byInvoice, resolved } = useConditionStates();
  return { condition: byInvoice.get(invoiceNumber) ?? null, resolved };
}

/** Drops the cache so the next read hits the chain again. */
export function refreshConditionState(): void {
  inFlight = null;
}
