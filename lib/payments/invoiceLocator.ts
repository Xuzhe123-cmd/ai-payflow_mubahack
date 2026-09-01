/**
 * Finds an invoice's on-chain object, and reads its terms from the object.
 *
 * THE POINT. A settlement request names an invoice; everything else — the
 * amount, the recipient — is read from what the chain holds, never from the
 * request. A client that asks to pay a different address or a larger sum finds
 * those fields simply ignored.
 *
 * Move re-checks all of it anyway. This is not the security boundary; it is the
 * removal of an opportunity to lie, so that a refusal comes from a real
 * disagreement rather than from tampering the interface allowed through.
 */

import type { SuiNetwork } from "../sui/deployment";
import { graphqlUrlFor } from "../sui/client";
import type { OnChainInvoiceRef } from "./executeCall";

interface InvoiceNode {
  address?: string;
  asMoveObject?: { contents?: { json?: Record<string, unknown> } };
}

/** Status codes the Move invoice module uses. 4 = PAID. */
export const INVOICE_STATUS_PAID = 4;

export interface LocatedInvoice extends OnChainInvoiceRef {
  status: number;
  supplierId: string;
}

/**
 * Reads every on-chain Invoice and returns the one with this number.
 *
 * Returns null when no such invoice exists on chain — a different answer from
 * "it exists and is unpayable", and the caller must keep them apart.
 */
export async function locateInvoice(
  network: SuiNetwork,
  typePackageId: string,
  invoiceNumber: string,
): Promise<LocatedInvoice | null> {
  const query = `{
    objects(filter: {type: "${typePackageId}::invoice::Invoice"}) {
      nodes { address asMoveObject { contents { json } } }
    }
  }`;

  const response = await fetch(graphqlUrlFor(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The chain could not be read (HTTP ${response.status}).`);
  }

  const body = (await response.json()) as {
    data?: { objects?: { nodes?: InvoiceNode[] } };
  };

  const wanted = invoiceNumber.trim().toUpperCase();
  for (const node of body.data?.objects?.nodes ?? []) {
    const fields = node.asMoveObject?.contents?.json;
    if (!fields || typeof node.address !== "string") continue;
    if (String(fields.invoice_number ?? "").toUpperCase() !== wanted) continue;

    return {
      objectId: node.address,
      invoiceNumber: String(fields.invoice_number),
      amount: String(fields.amount ?? "0"),
      recipient: String(fields.recipient ?? ""),
      status: Number(fields.status ?? 0),
      supplierId: String(fields.supplier_id ?? ""),
    };
  }

  return null;
}
