/**
 * Preflight for the conditional-payment demo. Submits nothing, ever.
 *
 * There is no `--confirm` here on purpose. This script's whole job is to
 * establish whether Demo A and Demo B WOULD work, and a script that can also
 * execute invites the wrong keystroke at the wrong moment. Live execution runs
 * through the interface, behind PAYFLOW_ESCROW_LIVE.
 *
 *   npx tsx scripts/escrowPreflight.ts
 *
 * Two independent verdicts per step. The TypeScript guards mirror the chain's
 * rules and can drift from them; the dry run executes the actual Move code
 * against actual state and cannot. Where they disagree, the dry run is right —
 * and the disagreement is itself worth seeing.
 */

import { assessProof, attestationNote } from "../lib/ai/proofAssessment";
import { DEMO_AS_OF_DATE, DEMO_CLOCK_MS } from "../lib/demo/clock";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { attestCall, lockCall, releaseCall, renderPlan } from "../lib/escrow/calls";
import { guardAttest, guardLock, type GuardResult } from "../lib/escrow/guards";
import { preflight } from "../lib/escrow/testnetExecutor";
import { proofBytes, proofFor, proofSha256 } from "../lib/escrow/proofDocument";
import { decideDeterministically } from "../lib/ai/deterministicEngine";
import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { conditionalDocumentFor, conditionalWorld } from "../lib/escrow/conditionalInvoices";
import { selectProofStore } from "../lib/oracle/proofStore";
import { readChainSnapshot } from "../lib/sui/chainReader";
import { createSuiQueries } from "../lib/sui/client";
import { callPackageId, structTypesFor, typePackageId } from "../lib/sui/deployment";
import { configuredNetwork, loadManifest } from "../lib/sui/manifest";
import * as sui from "./lib/suiCli";

const ATTESTATION_TTL_MS = 86_400_000;

interface DemoCase {
  label: string;
  invoiceNumber: string;
  expectation: string;
}

const CASES: DemoCase[] = [
  {
    label: "Demo A",
    invoiceNumber: "INV-2026-3501",
    expectation: "lock → proof → attest CONFIRMED → release",
  },
  {
    label: "Demo B",
    invoiceNumber: "INV-2026-3502",
    expectation: "lock → proof IN_TRANSIT → no attestation → funds stay locked",
  },
];

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

/** A few million MIST reads as "0.00 SUI"; show both so the number is real. */
function gasLine(mist: number): string {
  return `${mist.toLocaleString("en-US")} MIST (${sui.formatSui(BigInt(mist))} SUI)`;
}

function printGuard(guard: GuardResult): void {
  for (const check of guard.checks) {
    console.log(`    ${check.passed ? "PASS" : "FAIL"}  ${check.label} — ${check.detail}`);
  }
}

async function main(): Promise<void> {
  heading("1. Network and signer");
  const network = sui.assertSafeNetwork();
  const signer = sui.activeAddress();
  const gas = sui.gasReport();
  console.log(`  network            ${network}`);
  console.log(`  signer             ${signer}`);
  console.log(`  gas balance        ${sui.formatSui(gas.totalMist)} SUI`);

  const manifest = loadManifest(configuredNetwork());
  const types = structTypesFor(manifest);
  console.log(`  calls target       ${callPackageId(manifest)}`);
  console.log(`  type arguments     ${typePackageId(manifest)}`);

  heading("2. Live chain state");
  const snapshot = await readChainSnapshot(createSuiQueries(configuredNetwork()), manifest);
  const treasury = snapshot.treasury;
  const agent = snapshot.agent;
  console.log(`  vault              ${money(treasury.balanceCents)}`);
  console.log(`  minimum reserve    ${money(treasury.minimumReserveCents)}`);
  console.log(`  agent single cap   ${money(agent?.maxSinglePaymentCents ?? 0)}`);
  console.log(`  agent daily left   ${money(agent?.remainingTodayCents ?? 0)}`);

  // The OracleCap that would sign every attestation.
  const capId = manifest.escrowDemo?.oracleCapId ?? "";
  const capFields = capId ? sui.objectFields(capId) : {};
  const oracleCap = capId
    ? {
        objectId: capId,
        treasuryId: String(capFields.treasury_id ?? ""),
        oracleId: String(capFields.oracle_id ?? ""),
      }
    : null;
  console.log(`  OracleCap          ${capId || "(none recorded)"}`);

  let totalGasMist = 0;
  let anyBlocked = false;

  for (const demo of CASES) {
    heading(`3. ${demo.label} — ${demo.invoiceNumber}`);

    const seeded = manifest.escrowDemo?.invoices.find(
      (entry) => entry.invoiceNumber === demo.invoiceNumber,
    );
    if (!seeded) {
      console.log("  FAIL  invoice is not in the manifest");
      anyBlocked = true;
      continue;
    }

    const onChain = snapshot.invoices.find(
      (entry) => entry.invoiceNumber === demo.invoiceNumber,
    );
    const proofSource = proofFor(demo.invoiceNumber);
    if (!proofSource) {
      console.log("  FAIL  no demo proof document");
      anyBlocked = true;
      continue;
    }

    const supplier = SUPPLIERS.find((entry) => entry.id === seeded.supplierId);
    const recipient = proofSource.document.recipient;

    // The deterministic decision, from the engine that already exists, reading
    // THIS invoice rather than borrowing another one's verdict.
    const document = conditionalDocumentFor(demo.invoiceNumber)!;
    const analysis = await buildAnalysis({
      document,
      world: conditionalWorld(),
      asOf: DEMO_AS_OF_DATE,
    });
    const decision = decideDeterministically(analysis).action;
    console.log(`  amount             ${money(seeded.amountCents)}`);
    console.log(`  invoice object     ${seeded.objectId}`);
    console.log(`  on-chain status    ${onChain?.status ?? "not readable"}`);
    console.log(`  AI decision        ${decision}`);
    console.log(`  expectation        ${demo.expectation}`);

    // --- the lock ------------------------------------------------------------
    console.log("\n  STEP 1 — escrow::execute_conditional");
    const lockPlan = lockCall({
      manifest,
      invoiceObjectId: seeded.objectId,
      amountCents: seeded.amountCents,
      recipient,
      recommendationId: `rec_escrow_${demo.invoiceNumber.toLowerCase()}`,
      recommendedAtMs: DEMO_CLOCK_MS,
    });

    const lockGuard = guardLock({
      invoiceNumber: demo.invoiceNumber,
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
      // Established authoritatively by the dry run below; the guard models it
      // so a local refusal can name it, and the chain settles it either way.
      requiresShipment: true,
      decision,
      agentMaxSingleCents: agent?.maxSinglePaymentCents ?? 0,
      agentDailyRemainingCents: agent?.remainingTodayCents ?? 0,
      supplierApproved: supplier?.registryStatus === "APPROVED",
      registryRecipient: supplier?.registeredWallet ?? null,
      allowedCurrencies: treasury.allowedCurrencies,
      vaultCents: treasury.balanceCents,
      minimumReserveCents: treasury.minimumReserveCents,
    });
    console.log(`    guards: ${lockGuard.ok ? "all pass" : `REFUSED — ${lockGuard.refusal}`}`);
    printGuard(lockGuard);

    const lockDry = preflight(lockPlan);
    console.log(
      `    dry run: ${lockDry.ok ? "chain would ACCEPT" : `chain would REFUSE — abort ${lockDry.abortCode ?? "?"}`}`,
    );
    if (!lockDry.ok && lockDry.error) console.log(`             ${lockDry.error.slice(0, 300)}`);
    if (lockDry.gasMist) {
      totalGasMist += lockDry.gasMist;
      console.log(`    gas:     ${gasLine(lockDry.gasMist)}`);
    }
    console.log(`    creates: ${lockPlan.createsType}`);
    console.log(`    ${renderPlan(lockPlan)}`);
    if (!lockGuard.ok || !lockDry.ok) anyBlocked = true;

    // --- the proof ------------------------------------------------------------
    console.log("\n  STEP 2 — shipment proof (no transaction)");
    const store = selectProofStore(process.env);
    const stored = await store.store.put({
      bytes: proofBytes(proofSource),
      filename: proofSource.filename,
      contentType: proofSource.contentType,
    });
    console.log(`    document         ${proofSource.filename}`);
    console.log(`    status           ${proofSource.document.deliveryStatus}`);
    console.log(`    sha256           ${stored.sha256}`);
    console.log(`    storage          ${stored.storage}${store.live ? " (live)" : " (fallback)"}`);

    const assessment = assessProof({
      document: proofSource.document,
      invoiceNumber: demo.invoiceNumber,
      registeredRecipient: recipient,
    });
    console.log(`    AI (advisory)    ${assessment.summary}`);

    // --- the attestation -------------------------------------------------------
    const confirmed = proofSource.document.deliveryStatus === "DELIVERED";
    console.log(`\n  STEP 3 — oracle::attest (confirmed: ${confirmed})`);

    const attestGuard = guardAttest({
      invoiceNumber: demo.invoiceNumber,
      oracleCap,
      expectedTreasuryId: manifest.objects.treasuryId,
      expectedOracleId: "demo_shipment_oracle",
      storedSha256: stored.sha256,
      documentSha256: proofSha256(proofSource),
      proofInvoiceNumber: proofSource.document.invoiceNumber,
    });
    console.log(`    guards: ${attestGuard.ok ? "all pass" : `REFUSED — ${attestGuard.refusal}`}`);
    printGuard(attestGuard);

    if (!confirmed) {
      console.log("    NOT SUBMITTED — the document does not report delivery.");
      console.log("    No confirmed attestation is created, so no release is possible.");
      console.log("\n  STEP 4 — escrow::release");
      console.log("    NOT REACHABLE. There is no confirmed attestation to present.");
      console.log(`    ${money(seeded.amountCents)} would remain locked in escrow.`);
      continue;
    }

    const attestPlan = attestCall({
      manifest,
      invoiceNumber: demo.invoiceNumber,
      shipmentId: proofSource.document.shipmentId,
      confirmed,
      proofBlobId: stored.blobId,
      proofSha256: stored.sha256,
      deliveredAtMs: DEMO_CLOCK_MS,
      validForMs: ATTESTATION_TTL_MS,
      aiAssessment: attestationNote(assessment),
    });
    const attestDry = preflight(attestPlan);
    console.log(
      `    dry run: ${attestDry.ok ? "chain would ACCEPT" : `chain would REFUSE — ${attestDry.error?.slice(0, 200)}`}`,
    );
    if (attestDry.gasMist) {
      totalGasMist += attestDry.gasMist;
      console.log(`    gas:     ${gasLine(attestDry.gasMist)}`);
    }
    console.log(`    creates: ${attestPlan.createsType}`);
    if (!attestGuard.ok || !attestDry.ok) anyBlocked = true;

    // --- the release -----------------------------------------------------------
    console.log("\n  STEP 4 — escrow::release");
    const releasePlan = releaseCall({
      manifest,
      escrowObjectId: "<PaymentEscrow id, captured from step 1>",
      attestationObjectId: "<ShipmentAttestation id, captured from step 3>",
      invoiceObjectId: seeded.objectId,
    });
    console.log("    CANNOT DRY-RUN YET — the escrow and attestation do not exist.");
    console.log("    Both ids come from the transactions above, so this call can only be");
    console.log("    dry-run once step 1 and step 3 have really executed.");
    console.log(`    guards at release re-read escrow and attestation from chain and verify:`);
    console.log("      escrow LOCKED · treasury matches · invoice matches · confirmed · unexpired");
    console.log(`    ${renderPlan(releasePlan)}`);
    console.log(`    creates: ${types.paymentEscrow} is MUTATED, nothing is created`);
  }

  heading("4. Summary");
  console.log(`  estimated gas      ${gasLine(totalGasMist)} for the steps that could be dry-run`);
  console.log(`  signer balance     ${sui.formatSui(gas.totalMist)} SUI`);
  console.log(
    `  sufficient         ${gas.totalMist > BigInt(totalGasMist) * BigInt(3) ? "yes, comfortably" : "CHECK — margin is thin"}`,
  );
  console.log(`  blocked            ${anyBlocked ? "YES — see refusals above" : "no"}`);

  heading("Nothing was executed");
  console.log("  This script submits no transactions and has none to roll back.");
  console.log("  Live execution runs from the Escrow page with PAYFLOW_ESCROW_LIVE=1.\n");
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
