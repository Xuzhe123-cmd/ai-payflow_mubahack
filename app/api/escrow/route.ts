/**
 * Drives the conditional-payment demo.
 *
 * Stateless: the client holds the flow state and sends the action it wants;
 * this route runs the guards, submits (or declines to), reads the result back
 * off chain, and returns what actually happened. The client applies the
 * transition with the same pure `advance` the tests use.
 *
 * EXECUTION MODE. Simulated unless PAYFLOW_ESCROW_LIVE is set on the server — so
 * the default cannot spend testnet gas by accident, and going live is a
 * deliberate act rather than a click. A simulated response carries
 * `digest: null` and says so; a live one carries whatever the chain returned,
 * including a failure. Neither ever invents a digest.
 *
 * NEVER TRUST THE CLIENT. Object ids arriving in a request are treated as
 * pointers and nothing more: every fact about an escrow or an attestation is
 * re-read from chain before a release is submitted. A client that lies about a
 * confirmation gets a refusal here, and would get an abort from Move even if it
 * did not.
 *
 * The guards are not what makes this safe — `escrow::release` and the ten checks
 * in `payment::evaluate` do that. They are what makes a refusal legible before
 * gas is spent, and they run in both modes for exactly that reason.
 */

import { NextResponse } from "next/server";

import { attestCall, lockCall, releaseCall, renderPlan } from "@/lib/escrow/calls";
import {
  proofBytes,
  proofFor,
  proofSha256,
  PROOF_DISCLAIMER,
} from "@/lib/escrow/proofDocument";
import { assessProof, attestationNote, supportsConfirmation } from "@/lib/ai/proofAssessment";
import { DEMO_AS_OF_DATE, DEMO_CLOCK_MS } from "@/lib/demo/clock";
import { SUPPLIERS } from "@/lib/demo/suppliers";
import { decideDeterministically } from "@/lib/ai/deterministicEngine";
import { conditionalDocumentFor, conditionalWorld } from "@/lib/escrow/conditionalInvoices";
import { buildAnalysis } from "@/lib/deterministic/buildAnalysis";
import { selectProofStore } from "@/lib/oracle/proofStore";
import { DEMO_ORACLE_ID, SHIPMENT_ORACLE_LABEL } from "@/lib/oracle/shipment";
import type { ShipmentAttestation, ShipmentProof } from "@/lib/oracle/shipment";
import { guardAttest, guardLock, guardRelease, type GuardResult } from "@/lib/escrow/guards";
import {
  createSimulatedExecutor,
  createdOfType,
  liveExecutionEnabled,
  type EscrowExecutor,
  type ExecutionResult,
} from "@/lib/escrow/executor";
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { readAttestation, readEscrow } from "@/lib/sui/escrowReader";
import { createSuiQueries } from "@/lib/sui/client";
import { structTypesFor } from "@/lib/sui/deployment";
import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import { availableActions, type EscrowDemoAction } from "@/lib/escrow/demoFlow";
import { stageFromChain } from "@/lib/escrow/chainStage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long an attestation stays usable. Mirrors the Move expiry check. */
const ATTESTATION_TTL_MS = 86_400_000;
/**
 * The live executor is loaded lazily and only when enabled.
 *
 * It reaches the CLI keystore through `node:child_process`, so importing it
 * unconditionally would drag that into every build of this route whether or not
 * anyone intends to submit anything.
 */
async function executorFor(network: ReturnType<typeof configuredNetwork>): Promise<EscrowExecutor> {
  if (!liveExecutionEnabled()) return createSimulatedExecutor();
  const { createTestnetExecutor } = await import("@/lib/escrow/testnetExecutor");
  return createTestnetExecutor(network);
}

/** The shape every action returns, so the client has one branch, not four. */
function respond(action: EscrowDemoAction, result: ExecutionResult, extra: object = {}) {
  return NextResponse.json({
    mode: result.mode,
    action,
    ok: result.ok,
    plan: { ...result.plan, rendered: renderPlan(result.plan) },
    guard: result.guard,
    error: result.error,
    abortCode: result.abortCode,
    transaction: {
      action,
      label: result.plan.label,
      // Only ever what the chain returned.
      digest: result.digest,
      status: result.status,
      explorerUrl: result.explorerUrl,
      mode: result.mode,
      at: new Date(DEMO_CLOCK_MS).toISOString(),
    },
    ...extra,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const input = body as {
    invoiceNumber?: unknown;
    action?: unknown;
    escrowObjectId?: unknown;
    attestationObjectId?: unknown;
  };
  const invoiceNumber = typeof input.invoiceNumber === "string" ? input.invoiceNumber : null;
  const action = typeof input.action === "string" ? (input.action as EscrowDemoAction) : null;

  if (!invoiceNumber || !action) {
    return NextResponse.json({ error: "invoiceNumber and action are required." }, { status: 400 });
  }

  const network = configuredNetwork();
  const manifest = loadManifest(network);
  const types = structTypesFor(manifest);

  const seeded = manifest.escrowDemo?.invoices.find(
    (entry) => entry.invoiceNumber === invoiceNumber,
  );
  if (!seeded) {
    return NextResponse.json(
      { error: `${invoiceNumber} is not one of the conditional demo invoices.` },
      { status: 404 },
    );
  }

  const proofSource = proofFor(invoiceNumber);
  if (!proofSource) {
    return NextResponse.json(
      { error: `No demo shipment proof exists for ${invoiceNumber}.` },
      { status: 404 },
    );
  }

  const recipient = proofSource.document.recipient;

  // THE ACTION MUST BE LEGAL FOR THE STATE THE CHAIN IS ACTUALLY IN.
  //
  // Hiding a button is a rendering decision and a client can ignore it. This is
  // the same `availableActions` the page renders from, applied server-side to
  // state read from chain — so a replayed request, a stale tab, or a hand-made
  // POST asking to release an unattested escrow is refused here, before any
  // plan is built. Move would refuse it too; this refuses it sooner and says
  // why in a sentence.
  const liveStage = await readLiveStage(network, manifest, invoiceNumber, proofSource);
  const permitted = availableActions({
    invoiceNumber,
    amountCents: seeded.amountCents,
    stage: liveStage.stage,
    recipient,
    proof: liveStage.proof,
    attestation: liveStage.attestation,
    escrowObjectId: liveStage.escrow?.objectId ?? null,
    attestationObjectId: liveStage.escrow?.attestationId ?? null,
    transactions: [],
  }).map((entry) => entry.action);

  if (!permitted.includes(action)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `${action} is not available for ${invoiceNumber}, which is ${liveStage.stage} on chain.` +
          (permitted.length > 0 ? ` Available: ${permitted.join(", ")}.` : " No action is available."),
        stage: liveStage.stage,
        permitted,
      },
      { status: 409 },
    );
  }

  const executor = await executorFor(network);

  switch (action) {
    // --- lock ----------------------------------------------------------------
    case "START_CONDITIONAL_PAYMENT": {
      const plan = lockCall({
        manifest,
        invoiceObjectId: seeded.objectId,
        amountCents: seeded.amountCents,
        recipient,
        recommendationId: `rec_escrow_${invoiceNumber.toLowerCase()}`,
        recommendedAtMs: DEMO_CLOCK_MS,
      });

      const guard = await buildLockGuard(network, manifest, invoiceNumber, seeded.supplierId);
      const result = await executor.submit(plan, guard);

      return respond(action, result, {
        escrowObjectId: createdOfType(result, types.paymentEscrow),
      });
    }

    // --- proof: no transaction ------------------------------------------------
    case "SUBMIT_PROOF": {
      const selection = selectProofStore(process.env);
      const stored = await selection.store.put({
        bytes: proofBytes(proofSource),
        filename: proofSource.filename,
        contentType: proofSource.contentType,
      });

      const proof: ShipmentProof = {
        ...proofSource.document,
        sha256: stored.sha256,
        blobId: stored.blobId,
        storage: stored.storage,
        filename: stored.filename,
        byteLength: stored.byteLength,
      };

      // Advisory only. Recorded, shown, and never an input to release.
      const assessment = assessProof({
        document: proofSource.document,
        invoiceNumber,
        registeredRecipient: recipient,
      });

      return NextResponse.json({
        mode: executor.mode,
        action,
        ok: true,
        proof,
        disclaimer: PROOF_DISCLAIMER,
        storageLive: selection.live,
        storageReason: selection.reason,
        assessment: {
          summary: assessment.summary,
          concerns: assessment.concerns,
          supportsConfirmation: supportsConfirmation(assessment),
          advisory: true,
        },
        // Cross-check: the digest the document actually hashes to.
        expectedSha256: proofSha256(proofSource),
        transaction: {
          action,
          label: `Store ${proofSource.filename} and hash it`,
          // Storing a document is not a chain write in either mode.
          digest: null,
          status: null,
          explorerUrl: null,
          mode: executor.mode,
          at: new Date(DEMO_CLOCK_MS).toISOString(),
        },
      });
    }

    // --- attest ----------------------------------------------------------------
    case "ORACLE_CONFIRM": {
      const document = proofSource.document;
      // The oracle attests what the evidence says. A document reporting
      // IN_TRANSIT yields `confirmed: false`, which cannot release anything.
      const confirmed = document.deliveryStatus === "DELIVERED";
      const assessment = assessProof({ document, invoiceNumber, registeredRecipient: recipient });

      const stored = await selectProofStore(process.env).store.put({
        bytes: proofBytes(proofSource),
        filename: proofSource.filename,
        contentType: proofSource.contentType,
      });

      const capId = manifest.escrowDemo?.oracleCapId ?? null;
      const capFields = capId ? await readCapFields(network, capId) : null;

      const guard = guardAttest({
        invoiceNumber,
        oracleCap: capFields,
        expectedTreasuryId: manifest.objects.treasuryId,
        expectedOracleId: DEMO_ORACLE_ID,
        storedSha256: stored.sha256,
        documentSha256: proofSha256(proofSource),
        proofInvoiceNumber: document.invoiceNumber,
      });

      const plan = attestCall({
        manifest,
        invoiceNumber,
        shipmentId: document.shipmentId,
        confirmed,
        proofBlobId: stored.blobId,
        proofSha256: stored.sha256,
        deliveredAtMs: DEMO_CLOCK_MS,
        validForMs: ATTESTATION_TTL_MS,
        aiAssessment: attestationNote(assessment),
      });

      const result = await executor.submit(plan, guard);
      const attestationId =
        createdOfType(result, types.shipmentAttestation) ?? null;

      const attestation: ShipmentAttestation = {
        attestationId,
        invoiceNumber,
        shipmentId: document.shipmentId,
        confirmed,
        proofBlobId: stored.blobId,
        proofSha256: stored.sha256,
        deliveredAtMs: DEMO_CLOCK_MS,
        oracleId: DEMO_ORACLE_ID,
        attestedBy: manifest.publisher,
        attestedAtMs: DEMO_CLOCK_MS,
        expiresAtMs: DEMO_CLOCK_MS + ATTESTATION_TTL_MS,
        aiAssessment: attestationNote(assessment),
      };

      return respond(action, result, {
        attestation,
        attestationObjectId: attestationId,
        oracleLabel: SHIPMENT_ORACLE_LABEL,
      });
    }

    // --- release ----------------------------------------------------------------
    case "RELEASE_ESCROW": {
      const escrowObjectId =
        typeof input.escrowObjectId === "string" ? input.escrowObjectId : null;
      const attestationObjectId =
        typeof input.attestationObjectId === "string" ? input.attestationObjectId : null;

      // The ids are pointers. Every FACT below is re-read from chain.
      const queries = createSuiQueries(network);
      const onChainEscrow = escrowObjectId ? await readEscrow(queries, escrowObjectId) : null;
      const onChainAttestation = attestationObjectId
        ? await readAttestation(queries, attestationObjectId)
        : null;

      const supplier = SUPPLIERS.find((entry) => entry.id === seeded.supplierId);

      const guard = guardRelease({
        escrow: onChainEscrow
          ? {
              objectId: onChainEscrow.objectId,
              treasuryId: onChainEscrow.treasuryId,
              invoiceNumber: onChainEscrow.invoiceNumber,
              recipient: onChainEscrow.recipient,
              status: onChainEscrow.status,
              heldCents: onChainEscrow.heldCents,
            }
          : null,
        attestation: onChainAttestation
          ? {
              attestationId: onChainAttestation.attestationId,
              // The reader does not surface the attestation's treasury; the
              // Move function checks it regardless, and null means "not
              // established here" rather than "fine".
              treasuryId: null,
              invoiceNumber: onChainAttestation.invoiceNumber,
              confirmed: onChainAttestation.confirmed,
              expiresAtMs: onChainAttestation.expiresAtMs,
              proofSha256: onChainAttestation.proofSha256,
            }
          : null,
        expectedTreasuryId: manifest.objects.treasuryId,
        registryRecipient: supplier?.registeredWallet ?? null,
        nowMs: Date.now(),
      });

      const plan = releaseCall({
        manifest,
        escrowObjectId: escrowObjectId ?? "<PaymentEscrow id, from the lock transaction>",
        attestationObjectId:
          attestationObjectId ?? "<ShipmentAttestation id, from the oracle transaction>",
        invoiceObjectId: seeded.objectId,
      });

      const result = await executor.submit(plan, guard);
      return respond(action, result, { escrowObjectId, attestationObjectId });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${String(action)}` }, { status: 400 });
  }
}

/**
 * The stage this invoice is in, according to the chain.
 *
 * Read fresh on every request. The client's opinion of the stage is not
 * consulted at all — it cannot be, since the client is exactly what this is
 * defending against.
 */
async function readLiveStage(
  network: ReturnType<typeof configuredNetwork>,
  manifest: ReturnType<typeof loadManifest>,
  invoiceNumber: string,
  proofSource: NonNullable<ReturnType<typeof proofFor>>,
): Promise<{
  stage: ReturnType<typeof stageFromChain>;
  escrow: Awaited<ReturnType<typeof readEscrow>>;
  attestation: ShipmentAttestation | null;
  proof: ShipmentProof | null;
}> {
  const queries = createSuiQueries(network);
  const types = structTypesFor(manifest);

  const escrow = await findEscrowForInvoice(
    `${types.paymentEscrow}<${manifest.coinType}>`,
    queries,
    invoiceNumber,
  );
  const attestation = escrow?.attestationId
    ? await readAttestation(queries, escrow.attestationId)
    : null;

  const proof: ShipmentProof = {
    ...proofSource.document,
    sha256: proofSha256(proofSource),
    blobId: `demo:${proofSha256(proofSource).slice(0, 32)}`,
    storage: "demo",
    filename: proofSource.filename,
    byteLength: proofBytes(proofSource).byteLength,
  };

  // Before anything is locked there is no proof in play, so the stage is READY
  // rather than "a document exists locally".
  const stage = stageFromChain({
    escrow: escrow
      ? {
          objectId: escrow.objectId,
          status: escrow.status,
          amountCents: escrow.amountCents,
          heldCents: escrow.heldCents,
          invoiceNumber: escrow.invoiceNumber,
          recipient: escrow.recipient,
          attestationId: escrow.attestationId,
        }
      : null,
    attestation,
    proof: escrow ? proof : null,
  });

  return { stage, escrow, attestation, proof: escrow ? proof : null };
}

/** Finds the escrow settling one invoice, by type and invoice number. */
async function findEscrowForInvoice(
  escrowType: string,
  queries: ReturnType<typeof createSuiQueries>,
  invoiceNumber: string,
): Promise<Awaited<ReturnType<typeof readEscrow>>> {
  const url =
    configuredNetwork() === "localnet"
      ? "http://127.0.0.1:9125/graphql"
      : `https://graphql.${configuredNetwork()}.sui.io/graphql`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ objects(filter: {type: "${escrowType}"}) { nodes { address } } }`,
    }),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as {
    data?: { objects?: { nodes?: { address?: string }[] } };
  };
  for (const node of body.data?.objects?.nodes ?? []) {
    if (typeof node.address !== "string") continue;
    const escrow = await readEscrow(queries, node.address);
    if (escrow?.invoiceNumber === invoiceNumber) return escrow;
  }
  return null;
}

/** Reads the OracleCap's own fields, so the guard checks chain state. */
async function readCapFields(
  network: ReturnType<typeof configuredNetwork>,
  capId: string,
): Promise<{ objectId: string; treasuryId: string; oracleId: string } | null> {
  try {
    const raw = await createSuiQueries(network).getObjectFields(capId);
    if (typeof raw !== "object" || raw === null) return null;
    const fields = raw as Record<string, unknown>;
    return {
      objectId: capId,
      treasuryId: String(fields.treasury_id ?? ""),
      oracleId: String(fields.oracle_id ?? ""),
    };
  } catch {
    // A guard that cannot establish its fact must fail, never pass.
    return null;
  }
}

/**
 * The lock guard, assembled from live chain state and the existing engine.
 *
 * The decision comes from `decideDeterministically` — the same function the
 * pipeline uses — rather than being asserted here, so this route cannot approve
 * something the engine would not.
 */
async function buildLockGuard(
  network: ReturnType<typeof configuredNetwork>,
  manifest: ReturnType<typeof loadManifest>,
  invoiceNumber: string,
  supplierId: string,
): Promise<GuardResult> {
  const snapshot = await readChainSnapshot(createSuiQueries(network), manifest);
  const onChain = snapshot.invoices.find((entry) => entry.invoiceNumber === invoiceNumber) ?? null;
  const supplier = SUPPLIERS.find((entry) => entry.id === supplierId);

  // Decided from THIS invoice's own document. Borrowing another scenario's
  // analysis gave a $4,000 invoice an $8,000 invoice's escalation.
  const document = conditionalDocumentFor(invoiceNumber);
  let decision = null as ReturnType<typeof decideDeterministically>["action"] | null;
  if (document) {
    const analysis = await buildAnalysis({
      document,
      world: conditionalWorld(),
      asOf: DEMO_AS_OF_DATE,
    });
    decision = decideDeterministically(analysis).action;
  }

  return guardLock({
    invoiceNumber,
    onChainInvoice: onChain
      ? {
          invoiceNumber: onChain.invoiceNumber,
          status: onChain.status,
          amountCents: onChain.amountCents,
          currency: onChain.currency,
          supplierId: onChain.supplierId,
          recipient: onChain.recipient,
        }
      : null,
    // Settled authoritatively by the chain: `execute_conditional` aborts with
    // 901 if the condition is absent. Modelled here so a local refusal can name
    // it, and both seeded demo invoices carry it.
    requiresShipment: true,
    decision,
    agentMaxSingleCents: snapshot.agent?.maxSinglePaymentCents ?? 0,
    agentDailyRemainingCents: snapshot.agent?.remainingTodayCents ?? 0,
    supplierApproved: supplier?.registryStatus === "APPROVED",
    registryRecipient: supplier?.registeredWallet ?? null,
    allowedCurrencies: snapshot.treasury.allowedCurrencies,
    vaultCents: snapshot.treasury.balanceCents,
    minimumReserveCents: snapshot.treasury.minimumReserveCents,
  });
}
