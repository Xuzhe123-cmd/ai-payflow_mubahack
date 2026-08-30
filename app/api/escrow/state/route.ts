/**
 * The live escrow state for both conditional invoices.
 *
 * Read-only. This handler builds no transaction and can submit none — it exists
 * so the page reports what the chain says rather than what the last click
 * implied. A reload shows the same thing the escrow does.
 *
 * The proof DOCUMENT is local (it is the file that was hashed), but the digest
 * it is compared against comes from the on-chain attestation, so the interface
 * can state whether the evidence chain actually holds together rather than
 * showing the two next to each other and hoping.
 */

import { NextResponse } from "next/server";

import {
  fundsHeldCents,
  proofMatchesAttestation,
  stageFromChain,
  supplierWasPaid,
  type ChainEscrowState,
} from "@/lib/escrow/chainStage";
import { proofBytes, proofFor, proofSha256, PROOF_DISCLAIMER } from "@/lib/escrow/proofDocument";
import { SHIPMENT_ORACLE_LABEL, SHIPMENT_ORACLE_DETAIL } from "@/lib/oracle/shipment";
import type { ShipmentAttestation, ShipmentProof } from "@/lib/oracle/shipment";
import { readAttestation, readEscrow } from "@/lib/sui/escrowReader";
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { createSuiQueries } from "@/lib/sui/client";
import { explorerObjectUrl, structTypesFor } from "@/lib/sui/deployment";
import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import { conditionalInvoiceSet } from "@/lib/escrow/conditionalSet";
import * as escrowPlan from "@/lib/escrow/demoFlow";

export const runtime = "nodejs";
/** Chain state moves; a cached escrow would be a lie with a timestamp on it. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const queries = createSuiQueries(network);
    const types = structTypesFor(manifest);

    const snapshot = await readChainSnapshot(queries, manifest);

    // Every escrow on chain, so an invoice's escrow is found by what it IS
    // rather than by what a manifest remembers. The type must be the full
    // generic form — a filter on the bare name matches nothing.
    const escrowsByInvoice = await readEscrowsByInvoice(
      `${types.paymentEscrow}<${manifest.coinType}>`,
      queries,
    );

    // Which invoices carry a shipment condition is a question about CHAIN
    // state, not about what a manifest was written with. An invoice escrowed
    // after the seed has an escrow object and an ESCROWED status, and either is
    // enough to include it — otherwise the next conditional invoice created
    // would silently show no evidence at all.
    const invoices = conditionalInvoiceSet(
      manifest.escrowDemo?.invoices ?? [],
      snapshot.invoices,
      new Set(escrowsByInvoice.keys()),
    );
    const demos = await Promise.all(
      invoices.map(async (seeded) => {
        const escrow = escrowsByInvoice.get(seeded.invoiceNumber) ?? null;
        const attestation = escrow?.attestationId
          ? await readAttestation(queries, escrow.attestationId)
          : null;

        const source = proofFor(seeded.invoiceNumber);
        const proof: ShipmentProof | null = source
          ? {
              ...source.document,
              sha256: proofSha256(source),
              blobId: `demo:${proofSha256(source).slice(0, 32)}`,
              storage: "demo",
              filename: source.filename,
              byteLength: proofBytes(source).byteLength,
            }
          : null;

        const stage = stageFromChain({ escrow, attestation, proof });
        const onChainInvoice = snapshot.invoices.find(
          (entry) => entry.invoiceNumber === seeded.invoiceNumber,
        );

        return {
          invoiceNumber: seeded.invoiceNumber,
          amountCents: seeded.amountCents,
          recipient: escrow?.recipient ?? source?.document.recipient ?? "",
          stage,
          escrow: escrow
            ? {
                objectId: escrow.objectId,
                status: escrow.status,
                amountCents: escrow.amountCents,
                heldCents: escrow.heldCents,
                attestationId: escrow.attestationId,
                explorerUrl: explorerObjectUrl(escrow.objectId, network),
              }
            : null,
          attestation,
          proof,
          /** Whether the document on file is the one the oracle attested. */
          proofMatchesAttestation: proofMatchesAttestation(proof, attestation),
          invoiceStatus: onChainInvoice?.status ?? null,
          fundsHeldCents: fundsHeldCents(escrow),
          supplierPaid: supplierWasPaid(escrow),
          /** Derived from state, so the page cannot offer more than the chain allows. */
          actions: escrowPlan.availableActions({
            invoiceNumber: seeded.invoiceNumber,
            amountCents: seeded.amountCents,
            stage,
            recipient: escrow?.recipient ?? "",
            proof,
            attestation,
            escrowObjectId: escrow?.objectId ?? null,
            attestationObjectId: escrow?.attestationId ?? null,
            transactions: [],
          }),
        };
      }),
    );

    return NextResponse.json({
      ok: true,
      network,
      readAt: snapshot.readAt,
      oracle: { label: SHIPMENT_ORACLE_LABEL, detail: SHIPMENT_ORACLE_DETAIL },
      disclaimer: PROOF_DISCLAIMER,
      demos,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error reading escrow state";
    return NextResponse.json({ ok: false, message }, { status: 503 });
  }
}

/**
 * The invoices that carry a shipment condition, from the manifest AND the chain.
 *
 * The manifest is a starting point, never the authority: it records what the
 * seed created and knows nothing about anything created since. An invoice with
 * an escrow object, or sitting at ESCROWED, is conditional whether or not
 * anyone wrote it down locally.
 */
function conditionalInvoices(
  seeded: { invoiceNumber: string; amountCents: number }[],
  onChain: { invoiceNumber: string; amountCents: number; status: string }[],
  escrows: Map<string, ChainEscrowState>,
): { invoiceNumber: string; amountCents: number }[] {
  const byNumber = new Map<string, { invoiceNumber: string; amountCents: number }>();

  for (const invoice of seeded) {
    byNumber.set(invoice.invoiceNumber, invoice);
  }

  for (const invoice of onChain) {
    if (byNumber.has(invoice.invoiceNumber)) continue;
    const conditional =
      escrows.has(invoice.invoiceNumber) ||
      invoice.status === "ESCROWED" ||
      invoice.status === "HELD";
    if (conditional) {
      byNumber.set(invoice.invoiceNumber, {
        invoiceNumber: invoice.invoiceNumber,
        amountCents: invoice.amountCents,
      });
    }
  }

  return [...byNumber.values()].sort((a, b) =>
    a.invoiceNumber.localeCompare(b.invoiceNumber),
  );
}

/** Every escrow on chain, keyed by the invoice number it settles. */
async function readEscrowsByInvoice(
  escrowType: string,
  queries: ReturnType<typeof createSuiQueries>,
): Promise<Map<string, ChainEscrowState>> {
  const map = new Map<string, ChainEscrowState>();

  const response = await fetch(graphqlUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ objects(filter: {type: "${escrowType}"}) { nodes { address } } }`,
    }),
  });
  if (!response.ok) return map;

  const body = (await response.json()) as {
    data?: { objects?: { nodes?: { address?: string }[] } };
  };
  const ids = (body.data?.objects?.nodes ?? [])
    .map((node) => node.address)
    .filter((address): address is string => typeof address === "string");

  for (const id of ids) {
    const escrow = await readEscrow(queries, id);
    if (escrow) {
      map.set(escrow.invoiceNumber, {
        objectId: escrow.objectId,
        status: escrow.status,
        amountCents: escrow.amountCents,
        heldCents: escrow.heldCents,
        invoiceNumber: escrow.invoiceNumber,
        recipient: escrow.recipient,
        attestationId: escrow.attestationId,
      });
    }
  }
  return map;
}

function graphqlUrl(): string {
  const network = configuredNetwork();
  if (network === "localnet") return "http://127.0.0.1:9125/graphql";
  return `https://graphql.${network}.sui.io/graphql`;
}
