/**
 * Demo A, end to end, against real Sui Testnet.
 *
 *   npx tsx scripts/demoA.ts                        # dry run — validates, submits nothing
 *   npx tsx scripts/demoA.ts --confirm              # executes three real transactions
 *   npx tsx scripts/demoA.ts --resume <escrow id>   # continues from an existing escrow
 *
 * RESUME exists because the first live run needed it. The lock succeeded, the
 * escrow id was captured correctly, and the read-back came a moment too early:
 * Sui's GraphQL endpoint is an indexer and trails the fullnode by a few
 * checkpoints, so the object was real but not yet visible to it. Re-running
 * step 1 would have locked a second $4,800 — or, more likely, aborted with
 * check 8 and left the demo stuck. Resume adopts the escrow that exists.
 *
 * Read-backs now retry with backoff, so the same lag should no longer halt a
 * run. Resume remains for the case where something else interrupts one.
 *
 * THE RULE BETWEEN STEPS. Nothing proceeds because a transaction was
 * *submitted*. Each step re-reads the object it created off chain and checks it
 * says what it was supposed to say; only then does the next step run. A lock
 * that cannot be verified stops the runner with the funds still in escrow,
 * which is a recoverable state — an unverified attestation followed by a
 * hopeful release is not.
 *
 * WHAT THIS WILL NOT DO. It will not print a digest it did not receive, will
 * not continue past a failed verification, and will not touch Demo B. Demo B is
 * the invoice whose shipment never arrives, and its whole value is that nobody
 * released it.
 *
 * The AI appears once, as a line of advisory prose recorded on the attestation.
 * It authorises nothing: `escrow::release` reads `confirmed` off the
 * attestation and never touches that field.
 */

import { assessProof, attestationNote } from "../lib/ai/proofAssessment";
import { decideDeterministically } from "../lib/ai/deterministicEngine";
import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { DEMO_AS_OF_DATE, DEMO_CLOCK_MS } from "../lib/demo/clock";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { attestCall, lockCall, releaseCall, renderPlan } from "../lib/escrow/calls";
import { conditionalDocumentFor, conditionalWorld } from "../lib/escrow/conditionalInvoices";
import { guardAttest, guardLock, guardRelease, type GuardResult } from "../lib/escrow/guards";
import { proofBytes, proofFor, proofSha256 } from "../lib/escrow/proofDocument";
import { createTestnetExecutor, preflight } from "../lib/escrow/testnetExecutor";
import { createdOfType, type ExecutionResult } from "../lib/escrow/executor";
import {
  verifyAttestation,
  verifyLockedEscrow,
  verifyReleasedEscrow,
  verifySupplierPaid,
  type ObservedEscrow,
  type Verification,
} from "../lib/escrow/verify";
import { DEMO_ORACLE_ID } from "../lib/oracle/shipment";
import { selectProofStore } from "../lib/oracle/proofStore";
import { readAttestation, readEscrow } from "../lib/sui/escrowReader";
import { awaitCondition, awaitObject, describeUnresolved } from "../lib/sui/awaitObject";
import { classifySettlement, describeStale } from "../lib/escrow/settlementState";
import { readChainSnapshot } from "../lib/sui/chainReader";
import { createSuiQueries } from "../lib/sui/client";
import { explorerTxUrl, structTypesFor } from "../lib/sui/deployment";
import { configuredNetwork, loadManifest } from "../lib/sui/manifest";
import { unitsToCents } from "../lib/sui/units";
import * as sui from "./lib/suiCli";

const INVOICE_NUMBER = "INV-2026-3501";
const SHIPMENT_ID = "SHIP-3501";
const ATTESTATION_TTL_MS = 86_400_000;

const confirmed = process.argv.includes("--confirm");
/** `--resume <escrow id>` adopts an escrow a previous run already created. */
const resumeIndex = process.argv.indexOf("--resume");
const resumeEscrowId = resumeIndex >= 0 ? (process.argv[resumeIndex + 1] ?? null) : null;

function heading(text: string): void {
  console.log(`\n${text}\n${"=".repeat(text.length)}`);
}

function step(text: string): void {
  console.log(`\n  ${text}\n  ${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

function halt(reason: string): never {
  console.error(`\n  HALTED — ${reason}`);
  console.error("  No further step will run. Nothing after this point was attempted.\n");
  process.exit(1);
}

function printGuard(guard: GuardResult): void {
  for (const c of guard.checks) {
    console.log(`      ${c.passed ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
  }
}

function printVerification(v: Verification): void {
  for (const c of v.checks) {
    console.log(
      `      ${c.passed ? "PASS" : "FAIL"}  ${c.label} — expected ${c.expected}, found ${c.actual}`,
    );
  }
}

/** Reports a submission honestly: a digest only when the chain gave one. */
function printResult(result: ExecutionResult): void {
  console.log(`      digest      ${result.digest ?? "(none — nothing was submitted)"}`);
  console.log(`      status      ${result.status ?? "not submitted"}`);
  if (result.explorerUrl) console.log(`      explorer    ${result.explorerUrl}`);
  if (result.abortCode !== null) console.log(`      abort code  ${result.abortCode}`);
  if (result.error) console.log(`      error       ${result.error.slice(0, 400)}`);
}

/**
 * Reads an object back, tolerating the indexer trailing the fullnode.
 *
 * Returns null only after retrying — and says plainly that a failure to read is
 * not proof of absence, because conflating those is what halted the first run.
 */
async function readBack<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
  const result = await awaitObject(read, {
    onRetry: (attempt, delayMs) =>
      console.log(`      (${what} not indexed yet — retry ${attempt} in ${delayMs}ms)`),
  });
  if (result.kind === "FOUND") {
    if (result.attempts > 1) console.log(`      ${what} read after ${result.attempts} attempts`);
    return result.value;
  }
  console.log(`      ${what}: ${describeUnresolved(result)}`);
  return null;
}

/**
 * Waits for a mutated object to actually show its new state.
 *
 * Distinct from `readBack`, which waits for existence. After a release the
 * escrow is readable the whole time — at its old version, still saying LOCKED
 * — so waiting for existence returns instantly with the wrong answer.
 */
async function readUntil<T>(
  what: string,
  read: () => Promise<T | null>,
  satisfied: (value: T) => boolean,
): Promise<{ value: T | null; satisfied: boolean }> {
  const result = await awaitCondition(read, satisfied, {
    onRetry: (attempt, delayMs) =>
      console.log(`      (${what} still shows the previous state — retry ${attempt} in ${delayMs}ms)`),
  });
  if (result.kind === "SATISFIED") {
    if (result.attempts > 1) {
      console.log(`      ${what} caught up after ${result.attempts} attempts`);
    }
    return { value: result.value, satisfied: true };
  }
  return { value: result.last, satisfied: false };
}

/** The object version the index currently reports, when it can say. */
async function indexedVersion(objectId: string): Promise<string | null> {
  try {
    return (await queriesRef?.getObjectVersion?.(objectId)) ?? null;
  } catch {
    return null;
  }
}

/** Set once in main so the helpers above can reach the query layer. */
let queriesRef: ReturnType<typeof createSuiQueries> | null = null;

/**
 * Verifies an escrow that has already settled, and submits nothing.
 *
 * Reached when `--resume` is pointed at an escrow that is RELEASED. The demo is
 * over; the only useful thing left is to establish that it really happened and
 * that nothing moved which should not have. Re-locking or re-releasing is not a
 * recovery, it is a second payment.
 */
async function reportCompleted(
  escrow: Awaited<ReturnType<typeof readEscrow>> & object,
  queries: ReturnType<typeof createSuiQueries>,
  coinType: string,
  expectedAmountCents: number,
): Promise<void> {
  step("Already settled — verifying completed state (no transaction)");

  const checks: { label: string; passed: boolean; detail: string }[] = [];
  const add = (label: string, passed: boolean, detail: string) =>
    checks.push({ label, passed, detail });

  add("escrow status", escrow.status === "RELEASED", escrow.status);
  add("escrow funds", escrow.heldCents === 0, money(escrow.heldCents));
  add("amount unchanged", escrow.amountCents === expectedAmountCents, money(escrow.amountCents));
  add("invoice unchanged", escrow.invoiceNumber === INVOICE_NUMBER, escrow.invoiceNumber);

  const proofSource = proofFor(INVOICE_NUMBER);
  const expectedRecipient = proofSource?.document.recipient ?? "";
  add(
    "recipient unchanged",
    escrow.recipient.toLowerCase() === expectedRecipient.toLowerCase(),
    escrow.recipient,
  );

  const manifest = loadManifest(configuredNetwork());
  add(
    "treasury unchanged",
    escrow.treasuryId.toLowerCase() === manifest.objects.treasuryId.toLowerCase(),
    escrow.treasuryId,
  );

  // The attestation must still be linked, and must still say confirmed.
  const attestationId = escrow.attestationId;
  add("attestation linked", attestationId !== null, attestationId ?? "none");

  if (attestationId) {
    const attestation = await readBack("attestation", () =>
      readAttestation(queries, attestationId),
    );
    add(
      "attestation confirmed",
      attestation?.confirmed === true,
      String(attestation?.confirmed ?? "unreadable"),
    );
    add(
      "attestation invoice",
      attestation?.invoiceNumber === INVOICE_NUMBER,
      attestation?.invoiceNumber ?? "unreadable",
    );
    if (attestation) {
      console.log(`      proof hash  ${attestation.proofSha256}`);
      console.log(`      oracle      ${attestation.oracleId}`);
    }
  }

  // The invoice itself should have gone to PAID when the escrow released.
  const snapshot = await readChainSnapshot(queries, manifest);
  const invoice = snapshot.invoices.find((e) => e.invoiceNumber === INVOICE_NUMBER);
  add("invoice status", invoice?.status === "PAID", invoice?.status ?? "unreadable");

  // And the supplier should be holding the money.
  const balance = await supplierBalanceCents(coinType, escrow.recipient);
  add(
    "supplier holds at least the released amount",
    balance >= expectedAmountCents,
    money(balance),
  );

  for (const c of checks) {
    console.log(`      ${c.passed ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    halt(`${failed.length} verification(s) failed on the completed escrow.`);
  }

  heading("Demo A is complete");
  console.log(`  ${money(escrow.amountCents)} released to ${escrow.recipient}`);
  console.log(`  escrow             ${escrow.objectId}`);
  console.log(`  attestation        ${attestationId ?? "none"}`);
  console.log(`  released at        ${new Date(escrow.releasedAtMs).toISOString()}`);
  console.log("\n  Nothing was submitted. This escrow is settled and will not be touched again.");
  console.log("  Demo B remains locked — it is the one nobody releases.\n");
}

/** MOCK_USDC held by an address, for the before/after comparison. */
async function supplierBalanceCents(coinType: string, owner: string): Promise<number> {
  const coins = await sui.objectsOfType(`0x2::coin::Coin<${coinType}>`, owner);
  let total = BigInt(0);
  for (const coin of coins) {
    const balance = coin.fields.balance;
    if (balance !== undefined && balance !== null) total += BigInt(String(balance));
  }
  return unitsToCents(total);
}

async function main(): Promise<void> {
  heading(`Demo A — ${INVOICE_NUMBER} (${confirmed ? "LIVE" : "DRY RUN"})`);
  if (!confirmed) {
    console.log("  Dry run. Every validation below is real; no transaction is submitted.");
  }

  const network = sui.assertSafeNetwork();
  const signer = sui.activeAddress();
  const manifest = loadManifest(configuredNetwork());
  const types = structTypesFor(manifest);
  const queries = createSuiQueries(configuredNetwork());
  queriesRef = queries;

  console.log(`  network            ${network}`);
  console.log(`  signer             ${signer}`);
  console.log(`  gas                ${sui.formatSui(sui.gasReport().totalMist)} SUI`);

  const seeded = manifest.escrowDemo?.invoices.find(
    (entry) => entry.invoiceNumber === INVOICE_NUMBER,
  );
  if (!seeded) halt(`${INVOICE_NUMBER} is not in the manifest.`);

  const proofSource = proofFor(INVOICE_NUMBER);
  if (!proofSource) halt(`No shipment proof document for ${INVOICE_NUMBER}.`);

  const supplier = SUPPLIERS.find((entry) => entry.id === seeded.supplierId);
  const recipient = proofSource.document.recipient;
  const treasuryId = manifest.objects.treasuryId;

  // ---- 0. preconditions ------------------------------------------------------
  step("0. Preconditions");
  const snapshot = await readChainSnapshot(queries, manifest);
  const onChain = snapshot.invoices.find((e) => e.invoiceNumber === INVOICE_NUMBER) ?? null;

  const document = conditionalDocumentFor(INVOICE_NUMBER);
  if (!document) halt(`No conditional document for ${INVOICE_NUMBER}.`);
  const analysis = await buildAnalysis({
    document,
    world: conditionalWorld(),
    asOf: DEMO_AS_OF_DATE,
  });
  const decision = decideDeterministically(analysis).action;

  console.log(`      invoice     ${INVOICE_NUMBER} · ${money(seeded.amountCents)}`);
  console.log(`      object      ${seeded.objectId}`);
  console.log(`      status      ${onChain?.status ?? "unreadable"}`);
  console.log(`      AI decision ${decision}`);

  const lockGuard = guardLock({
    invoiceNumber: INVOICE_NUMBER,
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
  printGuard(lockGuard);
  // The lock guards gate a LOCK. Resuming does not lock, and an escrow that has
  // already settled leaves the invoice PAID — which these correctly refuse, and
  // which is exactly the state a resumed run exists to inspect. Enforcing them
  // here would make the runner unable to verify its own completed work.
  if (!lockGuard.ok) {
    if (!resumeEscrowId) halt(lockGuard.refusal ?? "the lock guards refused");
    console.log(`      (not enforced — resuming, so no lock is attempted)`);
  }

  const balanceBefore = await supplierBalanceCents(manifest.coinType, recipient);
  console.log(`      supplier holds ${money(balanceBefore)} before this run`);

  const executor = createTestnetExecutor(configuredNetwork());

  // ---- 1. lock ---------------------------------------------------------------
  step(
    resumeEscrowId
      ? "1. escrow::execute_conditional — SKIPPED (resuming an existing escrow)"
      : "1. escrow::execute_conditional",
  );
  const lockPlan = lockCall({
    manifest,
    invoiceObjectId: seeded.objectId,
    amountCents: seeded.amountCents,
    recipient,
    recommendationId: `rec_escrow_${INVOICE_NUMBER.toLowerCase()}`,
    recommendedAtMs: DEMO_CLOCK_MS,
  });
  let escrowId: string | null = null;
  let lockedEscrow: ObservedEscrow | null = null;
  /** The escrow's indexed version before the release, to detect a stale read. */
  let lockedEscrowVersion: string | null = null;

  if (resumeEscrowId) {
    // Adopting an escrow a previous run created. Re-running the lock would try
    // to spend a second $4,800 against an invoice already claimed in the replay
    // ledger — check 8 would abort it, which is safe but leaves the demo stuck.
    console.log(`      adopting    ${resumeEscrowId}`);
    console.log("      no lock transaction is submitted in resume mode");

    const read = await readBack("escrow", () => readEscrow(queries, resumeEscrowId));

    // ALREADY SETTLED. This is completed state, not work to repeat: no lock, no
    // attestation, no release. Verify what happened and stop.
    if (read && read.status === "RELEASED") {
      await reportCompleted(read, queries, manifest.coinType, seeded.amountCents);
      return;
    }
    lockedEscrow = read
      ? {
          objectId: read.objectId,
          treasuryId: read.treasuryId,
          invoiceNumber: read.invoiceNumber,
          recipient: read.recipient,
          status: read.status,
          amountCents: read.amountCents,
          heldCents: read.heldCents,
        }
      : null;

    step("2. Verify the adopted escrow on chain");
    const verification = verifyLockedEscrow(lockedEscrow, {
      treasuryId,
      invoiceNumber: INVOICE_NUMBER,
      recipient,
      amountCents: seeded.amountCents,
    });
    printVerification(verification);
    if (!verification.ok) {
      halt(
        `${verification.failure}. Refusing to continue against an escrow that is not the ` +
          "locked one this demo expects.",
      );
    }
    escrowId = resumeEscrowId;
    lockedEscrowVersion = await indexedVersion(resumeEscrowId);
    console.log(`      ${money(seeded.amountCents)} is locked. The supplier has not been paid.`);
  } else if (!confirmed) {
    console.log(`      ${renderPlan(lockPlan)}`);
    const dry = preflight(lockPlan);
    console.log(`      dry run     ${dry.ok ? "chain would ACCEPT" : `REFUSE — ${dry.error}`}`);
    if (dry.gasMist) console.log(`      gas         ${dry.gasMist.toLocaleString("en-US")} MIST`);
    if (!dry.ok) halt("the chain would refuse the lock");
  } else {
    console.log(`      ${renderPlan(lockPlan)}`);
    const result = await executor.submit(lockPlan, lockGuard);
    printResult(result);
    if (!result.ok) halt("the lock transaction did not succeed");

    escrowId = createdOfType(result, types.paymentEscrow);
    if (!escrowId) halt("the lock succeeded but created no PaymentEscrow that could be found");
    console.log(`      escrow      ${escrowId}`);
    lockedEscrowVersion = await indexedVersion(escrowId);

    // Re-read rather than trust the transaction response.
    step("2. Verify the escrow on chain");
    const read = await readBack("escrow", () => readEscrow(queries, escrowId!));
    lockedEscrow = read
      ? {
          objectId: read.objectId,
          treasuryId: read.treasuryId,
          invoiceNumber: read.invoiceNumber,
          recipient: read.recipient,
          status: read.status,
          amountCents: read.amountCents,
          heldCents: read.heldCents,
        }
      : null;

    const verification = verifyLockedEscrow(lockedEscrow, {
      treasuryId,
      invoiceNumber: INVOICE_NUMBER,
      recipient,
      amountCents: seeded.amountCents,
    });
    printVerification(verification);
    if (!verification.ok) {
      halt(
        `${verification.failure}. The funds are in escrow and can be refunded by the admin; ` +
          "no attestation was made and no release was attempted.",
      );
    }
    console.log(`      ${money(seeded.amountCents)} is locked. The supplier has not been paid.`);
  }

  // ---- 3. proof --------------------------------------------------------------
  step("3. Shipment proof (no transaction)");
  const store = selectProofStore(process.env);
  const stored = await store.store.put({
    bytes: proofBytes(proofSource),
    filename: proofSource.filename,
    contentType: proofSource.contentType,
  });
  const expectedSha = proofSha256(proofSource);

  console.log(`      document    ${proofSource.filename}`);
  console.log(`      shipment    ${proofSource.document.shipmentId}`);
  console.log(`      status      ${proofSource.document.deliveryStatus}`);
  console.log(`      delivered   ${proofSource.document.deliveredAt ?? "—"}`);
  console.log(`      sha256      ${stored.sha256}`);
  console.log(`      storage     ${stored.storage}${store.live ? " (live)" : " (local fallback)"}`);

  if (stored.sha256 !== expectedSha) {
    halt("the stored bytes do not hash to the document's digest");
  }

  const assessment = assessProof({
    document: proofSource.document,
    invoiceNumber: INVOICE_NUMBER,
    registeredRecipient: recipient,
  });
  console.log(`      AI          ${assessment.summary}`);
  console.log("      (advisory — recorded on the attestation, never read by release)");

  // ---- 4. attest -------------------------------------------------------------
  step("4. oracle::attest");
  const capId = manifest.escrowDemo?.oracleCapId ?? null;
  const capRaw = capId ? await queries.getObjectFields(capId) : null;
  const capFields =
    capRaw && typeof capRaw === "object"
      ? (capRaw as Record<string, unknown>)
      : null;

  const attestGuard = guardAttest({
    invoiceNumber: INVOICE_NUMBER,
    oracleCap:
      capId && capFields
        ? {
            objectId: capId,
            treasuryId: String(capFields.treasury_id ?? ""),
            oracleId: String(capFields.oracle_id ?? ""),
          }
        : null,
    expectedTreasuryId: treasuryId,
    expectedOracleId: DEMO_ORACLE_ID,
    storedSha256: stored.sha256,
    documentSha256: expectedSha,
    proofInvoiceNumber: proofSource.document.invoiceNumber,
  });
  printGuard(attestGuard);
  if (!attestGuard.ok) halt(attestGuard.refusal ?? "the attest guards refused");

  const attestPlan = attestCall({
    manifest,
    invoiceNumber: INVOICE_NUMBER,
    shipmentId: SHIPMENT_ID,
    confirmed: true,
    proofBlobId: stored.blobId,
    proofSha256: stored.sha256,
    deliveredAtMs: DEMO_CLOCK_MS,
    validForMs: ATTESTATION_TTL_MS,
    aiAssessment: attestationNote(assessment),
  });
  console.log(`      ${renderPlan(attestPlan)}`);

  let attestationId: string | null = null;

  if (!confirmed) {
    const dry = preflight(attestPlan);
    console.log(`      dry run     ${dry.ok ? "chain would ACCEPT" : `REFUSE — ${dry.error}`}`);
    if (dry.gasMist) console.log(`      gas         ${dry.gasMist.toLocaleString("en-US")} MIST`);
    if (!dry.ok) halt("the chain would refuse the attestation");
  } else {
    const result = await executor.submit(attestPlan, attestGuard);
    printResult(result);
    if (!result.ok) halt("the attestation transaction did not succeed");

    attestationId = createdOfType(result, types.shipmentAttestation);
    if (!attestationId) halt("the attestation succeeded but created no object that could be found");
    console.log(`      attestation ${attestationId}`);

    step("5. Verify the attestation on chain");
    const read = await readBack("attestation", () => readAttestation(queries, attestationId!));
    const verification = verifyAttestation(
      read
        ? {
            attestationId: read.attestationId,
            treasuryId: read.treasuryId ?? null,
            invoiceNumber: read.invoiceNumber,
            shipmentId: read.shipmentId,
            confirmed: read.confirmed,
            proofSha256: read.proofSha256,
            expiresAtMs: read.expiresAtMs,
            oracleId: read.oracleId,
          }
        : null,
      {
        treasuryId,
        invoiceNumber: INVOICE_NUMBER,
        shipmentId: SHIPMENT_ID,
        proofSha256: stored.sha256,
        oracleId: DEMO_ORACLE_ID,
        nowMs: Date.now(),
      },
    );
    printVerification(verification);
    if (!verification.ok) {
      halt(
        `${verification.failure}. The escrow is still locked and no release was attempted.`,
      );
    }
  }

  // ---- 6. release ------------------------------------------------------------
  step("6. escrow::release");

  if (!confirmed) {
    if (escrowId) {
      console.log(`      escrow      ${escrowId} (exists, LOCKED)`);
      console.log("      CANNOT DRY-RUN — no attestation exists yet. Its id comes from step 4,");
      console.log("      so this call is only dry-runnable once the oracle has attested.");
    } else {
      console.log("      CANNOT DRY-RUN — the escrow and attestation do not exist yet.");
      console.log("      Their ids come from steps 1 and 4, so this call is only");
      console.log("      dry-runnable once those have really executed.");
    }
    console.log("      At release the runner re-reads both from chain and requires:");
    console.log("        escrow LOCKED · treasury · invoice · confirmed · unexpired · recipient");
    console.log(`      ${renderPlan(
      releaseCall({
        manifest,
        escrowObjectId: escrowId ?? "<PaymentEscrow id from step 1>",
        attestationObjectId: "<ShipmentAttestation id from step 4>",
        invoiceObjectId: seeded.objectId,
      }),
    )}`);
  } else {
    if (!escrowId || !attestationId || !lockedEscrow) {
      halt("missing an escrow or attestation id — refusing to release");
    }

    // Re-read both immediately before submitting. The ids are pointers; every
    // fact comes from the chain.
    const escrowNow = await readEscrow(queries, escrowId);
    const attestationNow = await readAttestation(queries, attestationId);

    const releaseGuard = guardRelease({
      escrow: escrowNow
        ? {
            objectId: escrowNow.objectId,
            treasuryId: escrowNow.treasuryId,
            invoiceNumber: escrowNow.invoiceNumber,
            recipient: escrowNow.recipient,
            status: escrowNow.status,
            heldCents: escrowNow.heldCents,
          }
        : null,
      attestation: attestationNow
        ? {
            attestationId: attestationNow.attestationId,
            treasuryId: attestationNow.treasuryId ?? null,
            invoiceNumber: attestationNow.invoiceNumber,
            confirmed: attestationNow.confirmed,
            expiresAtMs: attestationNow.expiresAtMs,
            proofSha256: attestationNow.proofSha256,
          }
        : null,
      expectedTreasuryId: treasuryId,
      registryRecipient: supplier?.registeredWallet ?? null,
      nowMs: Date.now(),
    });
    printGuard(releaseGuard);
    if (!releaseGuard.ok) {
      halt(`${releaseGuard.refusal}. The escrow stays locked and can be refunded by the admin.`);
    }

    const releasePlan = releaseCall({
      manifest,
      escrowObjectId: escrowId,
      attestationObjectId: attestationId,
      invoiceObjectId: seeded.objectId,
    });
    console.log(`      ${renderPlan(releasePlan)}`);

    const result = await executor.submit(releasePlan, releaseGuard);
    printResult(result);
    if (!result.ok) {
      halt(
        "the release transaction did not succeed. The escrow is unchanged and still holds the " +
          "funds; the admin refund path remains available.",
      );
    }

    step("7. Verify the release on chain");
    // Wait for the escrow to actually SHOW released, not merely to be readable.
    // It is readable throughout — at its previous version, still saying LOCKED.
    const versionBefore = lockedEscrowVersion;
    const waited = await readUntil(
      "escrow",
      () => readEscrow(queries, escrowId!),
      (e) => e.status === "RELEASED",
    );

    if (!waited.satisfied) {
      // Three situations look identical from a single stale read. Tell them
      // apart before reporting a successful release as a failed one.
      const versionNow = await indexedVersion(escrowId);
      const verdict = classifySettlement({
        transactionSucceeded: true,
        versionBefore,
        versionNow,
        stateMatches: false,
      });
      if (verdict.kind === "STALE") {
        console.log(`      ${describeStale(verdict, escrowId)}`);
        halt(
          "the release SUCCEEDED on chain but the index has not caught up. Nothing is wrong " +
            "with the settlement — re-run with --resume to verify once the index advances.",
        );
      }
    }

    const after = waited.value;
    const verification = verifyReleasedEscrow(
      lockedEscrow,
      after
        ? {
            objectId: after.objectId,
            treasuryId: after.treasuryId,
            invoiceNumber: after.invoiceNumber,
            recipient: after.recipient,
            status: after.status,
            amountCents: after.amountCents,
            heldCents: after.heldCents,
          }
        : null,
    );
    printVerification(verification);
    if (!verification.ok) halt(verification.failure ?? "the release could not be verified");

    step("8. Verify the supplier was paid");
    const balanceAfter = await supplierBalanceCents(manifest.coinType, recipient);
    const paid = verifySupplierPaid({
      balanceBeforeCents: balanceBefore,
      balanceAfterCents: balanceAfter,
      amountCents: seeded.amountCents,
    });
    printVerification(paid);
    if (!paid.ok) halt(paid.failure ?? "the supplier balance did not increase as expected");

    heading("Demo A complete");
    console.log(`  ${money(seeded.amountCents)} released to ${recipient}`);
    console.log(`  escrow             ${escrowId}`);
    console.log(`  attestation        ${attestationId}`);
    console.log(`  proof hash         ${stored.sha256}`);
    console.log(`  explorer           ${explorerTxUrl(result.digest!, configuredNetwork())}`);
  }

  if (!confirmed) {
    heading("Dry run complete — nothing was submitted");
    console.log("  Every guard and every dry run above is real. No transaction was sent.");
    console.log("\n  To execute Demo A for real:");
    if (resumeEscrowId) {
      // A bare --confirm while resuming would try to lock a SECOND $4,800
      // against an invoice already claimed in the replay ledger. Check 8 would
      // abort it — safe, but it would waste gas and read as a failure.
      console.log(`    npx tsx scripts/demoA.ts --resume ${resumeEscrowId} --confirm\n`);
    } else {
      console.log("    npx tsx scripts/demoA.ts --confirm\n");
    }
  }

  console.log("  Demo B was not touched. Its escrow is the one nobody releases.\n");
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
