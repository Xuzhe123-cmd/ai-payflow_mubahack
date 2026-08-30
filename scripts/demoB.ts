/**
 * Demo B, against real Sui Testnet: the payment that is authorised and still
 * does not arrive.
 *
 *   npx tsx scripts/demoB.ts              # dry run — validates, submits nothing
 *   npx tsx scripts/demoB.ts --confirm    # submits ONE transaction: the lock
 *
 * ONE TRANSACTION, and then a deliberate stop. There is no attest step, no
 * release step and no refund step in this file at all — not disabled, not
 * behind a flag, absent. The demonstration is that $4,000 leaves the treasury
 * and the supplier does not get it, and the most convincing way to show that is
 * for the code that could pay them not to exist here.
 *
 * WHAT MAKES THIS DIFFERENT FROM A FAILURE. Everything about this invoice is
 * fine: approved supplier, registered wallet, inside the agent's cap, currency
 * permitted, reserve intact, and the deterministic engine says AUTO_PAY. It is
 * not refused. It is committed and then held, because a real-world condition
 * has not been met — and the delivery document says so in as many words.
 *
 * IDEMPOTENT. Before locking anything it looks for an escrow that already
 * exists for this invoice, by querying the chain for PaymentEscrow objects and
 * matching on invoice number. That is deliberately not read from the manifest:
 * a partial run can leave a real object behind with nothing recorded, which has
 * already happened once on this project.
 */

import { assessProof } from "../lib/ai/proofAssessment";
import { decideDeterministically } from "../lib/ai/deterministicEngine";
import { buildAnalysis } from "../lib/deterministic/buildAnalysis";
import { DEMO_AS_OF_DATE, DEMO_CLOCK_MS } from "../lib/demo/clock";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { lockCall, renderPlan } from "../lib/escrow/calls";
import { conditionalDocumentFor, conditionalWorld } from "../lib/escrow/conditionalInvoices";
import { guardLock, type GuardResult } from "../lib/escrow/guards";
import { proofBytes, proofFor, proofSha256 } from "../lib/escrow/proofDocument";
import { createTestnetExecutor, preflight } from "../lib/escrow/testnetExecutor";
import { createdOfType, type ExecutionResult } from "../lib/escrow/executor";
import { verifyHeldEscrow, type ObservedEscrow, type Verification } from "../lib/escrow/verify";
import { classifySettlement, describeStale } from "../lib/escrow/settlementState";
import { selectProofStore } from "../lib/oracle/proofStore";
import { readEscrow } from "../lib/sui/escrowReader";
import { awaitObject, describeUnresolved } from "../lib/sui/awaitObject";
import { readChainSnapshot } from "../lib/sui/chainReader";
import { createSuiQueries } from "../lib/sui/client";
import { explorerObjectUrl, explorerTxUrl, structTypesFor } from "../lib/sui/deployment";
import { configuredNetwork, loadManifest } from "../lib/sui/manifest";
import { unitsToCents } from "../lib/sui/units";
import * as sui from "./lib/suiCli";

const INVOICE_NUMBER = "INV-2026-3502";
const SHIPMENT_ID = "SHIP-3502";

const confirmed = process.argv.includes("--confirm");

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

function printChecks(items: { label: string; passed: boolean; detail: string }[]): void {
  for (const c of items) console.log(`      ${c.passed ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
}

function printGuard(guard: GuardResult): void {
  printChecks(guard.checks);
}

function printVerification(v: Verification): void {
  for (const c of v.checks) {
    console.log(
      `      ${c.passed ? "PASS" : "FAIL"}  ${c.label} — expected ${c.expected}, found ${c.actual}`,
    );
  }
}

function printResult(result: ExecutionResult): void {
  console.log(`      digest      ${result.digest ?? "(none — nothing was submitted)"}`);
  console.log(`      status      ${result.status ?? "not submitted"}`);
  if (result.explorerUrl) console.log(`      explorer    ${result.explorerUrl}`);
  if (result.abortCode !== null) console.log(`      abort code  ${result.abortCode}`);
  if (result.error) console.log(`      error       ${result.error.slice(0, 400)}`);
}

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

/** MOCK_USDC held by an address. */
async function supplierBalanceCents(coinType: string, owner: string): Promise<number> {
  const coins = await sui.objectsOfType(`0x2::coin::Coin<${coinType}>`, owner);
  let total = BigInt(0);
  for (const coin of coins) {
    const balance = coin.fields.balance;
    if (balance !== undefined && balance !== null) total += BigInt(String(balance));
  }
  return unitsToCents(total);
}

/**
 * An escrow that already exists for this invoice, if any.
 *
 * Queried from the chain by TYPE and matched on invoice number, rather than
 * read from the manifest. A partial run can leave a real object behind with
 * nothing recorded — that has happened on this project before, and a manifest
 * lookup would have locked a second $4,000 on top of it.
 *
 * The type must be the FULL generic form. `PaymentEscrow` is generic over the
 * coin, and a filter on the bare name matches nothing at all — a query that
 * silently returns zero for a type that exists is worse than one that errors.
 */
async function findExistingEscrow(
  escrowType: string,
  coinType: string,
): Promise<{ objectId: string; invoiceNumber: string } | null> {
  const found = await sui.objectsOfType(`${escrowType}<${coinType}>`);
  for (const entry of found) {
    if (String(entry.fields.invoice_number ?? "") === INVOICE_NUMBER) {
      return { objectId: entry.objectId, invoiceNumber: INVOICE_NUMBER };
    }
  }
  return null;
}

async function main(): Promise<void> {
  heading(`Demo B — ${INVOICE_NUMBER} (${confirmed ? "LIVE" : "DRY RUN"})`);
  console.log("  The payment that is authorised, committed, and still does not arrive.");
  if (!confirmed) {
    console.log("  Dry run. Every validation below is real; no transaction is submitted.");
  }

  const network = sui.assertSafeNetwork();
  const manifest = loadManifest(configuredNetwork());
  const types = structTypesFor(manifest);
  const queries = createSuiQueries(configuredNetwork());

  console.log(`  network            ${network}`);
  console.log(`  signer             ${sui.activeAddress()}`);
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

  // ---- idempotence: has this already been locked? ----------------------------
  step("0. Existing state (chain, not manifest)");
  const existing = await findExistingEscrow(types.paymentEscrow, manifest.coinType);
  if (existing) {
    console.log(`      escrow      ${existing.objectId} already exists for ${INVOICE_NUMBER}`);
    console.log("      no lock transaction will be submitted");
  } else {
    console.log(`      no escrow exists for ${INVOICE_NUMBER} yet`);
  }

  // ---- preconditions ---------------------------------------------------------
  step("1. Preconditions, read from chain");
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
  if (!lockGuard.ok) {
    // An escrow that already exists leaves the invoice ESCROWED, which these
    // correctly refuse — and which is the state a resumed run inspects.
    if (!existing) halt(lockGuard.refusal ?? "the lock guards refused");
    console.log("      (not enforced — an escrow already exists, so no lock is attempted)");
  }

  const balanceBefore = await supplierBalanceCents(manifest.coinType, recipient);
  console.log(`      supplier holds ${money(balanceBefore)}`);

  // ---- the lock ---------------------------------------------------------------
  step(existing ? "2. escrow::execute_conditional — SKIPPED (already locked)" : "2. escrow::execute_conditional");
  let escrowId = existing?.objectId ?? null;

  if (!existing) {
    const lockPlan = lockCall({
      manifest,
      invoiceObjectId: seeded.objectId,
      amountCents: seeded.amountCents,
      recipient,
      recommendationId: `rec_escrow_${INVOICE_NUMBER.toLowerCase()}`,
      recommendedAtMs: DEMO_CLOCK_MS,
    });
    console.log(`      ${renderPlan(lockPlan)}`);

    if (!confirmed) {
      const dry = preflight(lockPlan);
      console.log(`      dry run     ${dry.ok ? "chain would ACCEPT" : `REFUSE — ${dry.error}`}`);
      if (dry.gasMist) console.log(`      gas         ${dry.gasMist.toLocaleString("en-US")} MIST`);
      if (!dry.ok) halt("the chain would refuse the lock");
    } else {
      const executor = createTestnetExecutor(configuredNetwork());
      const result = await executor.submit(lockPlan, lockGuard);
      printResult(result);
      if (!result.ok) halt("the lock transaction did not succeed");

      escrowId = createdOfType(result, types.paymentEscrow);
      if (!escrowId) halt("the lock succeeded but created no PaymentEscrow that could be found");
      console.log(`      escrow      ${escrowId}`);
    }
  }

  // ---- the proof: no transaction ----------------------------------------------
  step("3. Shipment proof (no transaction, and no attestation)");
  const store = selectProofStore(process.env);
  const stored = await store.store.put({
    bytes: proofBytes(proofSource),
    filename: proofSource.filename,
    contentType: proofSource.contentType,
  });
  if (stored.sha256 !== proofSha256(proofSource)) {
    halt("the stored bytes do not hash to the document's digest");
  }

  console.log(`      document    ${proofSource.filename}`);
  console.log(`      shipment    ${SHIPMENT_ID}`);
  console.log(`      status      ${proofSource.document.deliveryStatus}`);
  console.log(`      delivered   ${proofSource.document.deliveredAt ?? "— not delivered"}`);
  console.log(`      sha256      ${stored.sha256}`);

  const assessment = assessProof({
    document: proofSource.document,
    invoiceNumber: INVOICE_NUMBER,
    registeredRecipient: recipient,
  });
  console.log(`      AI          ${assessment.summary}`);
  console.log("      (advisory — and it agrees the document does not report delivery)");

  console.log("\n      oracle::attest  NOT CALLED. The document reports IN_TRANSIT, so there is");
  console.log("                      nothing to confirm. No attestation is created.");
  console.log("      escrow::release NOT CALLED, and not reachable: release requires a");
  console.log("                      confirmed attestation, and none exists.");

  if (!confirmed && !existing) {
    heading("Dry run complete — nothing was submitted");
    console.log("  To lock the escrow for real:");
    console.log("    npx tsx scripts/demoB.ts --confirm\n");
    return;
  }

  // ---- verify the held state ---------------------------------------------------
  step("4. Verify the escrow is HELD");
  if (!escrowId) halt("no escrow id to verify");

  const read = await readBack("escrow", () => readEscrow(queries, escrowId!));
  const observed: ObservedEscrow | null = read
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

  if (!observed && confirmed) {
    // The lock succeeded, so a read that shows nothing is the index lagging.
    const verdict = classifySettlement({
      transactionSucceeded: true,
      versionBefore: null,
      versionNow: null,
      stateMatches: false,
    });
    if (verdict.kind === "STALE") console.log(`      ${describeStale(verdict, escrowId)}`);
  }

  // Re-read the invoice and the balance AFTER the lock, so the negatives are
  // measured against the post-lock world rather than the pre-lock one.
  const afterSnapshot = await readChainSnapshot(queries, manifest);
  const invoiceAfter =
    afterSnapshot.invoices.find((e) => e.invoiceNumber === INVOICE_NUMBER) ?? null;
  const balanceAfter = await supplierBalanceCents(manifest.coinType, recipient);

  const verification = verifyHeldEscrow(
    observed,
    {
      treasuryId,
      invoiceNumber: INVOICE_NUMBER,
      recipient,
      amountCents: seeded.amountCents,
      invoiceStatus: invoiceAfter?.status ?? null,
      // No attestation was made, and the escrow's own link is the record of it.
      attestationExists: read?.attestationId != null,
      supplierBalanceBeforeCents: balanceBefore,
      supplierBalanceAfterCents: balanceAfter,
    },
    read?.attestationId ?? null,
  );
  printVerification(verification);
  if (!verification.ok) halt(verification.failure ?? "the held state could not be verified");

  heading("PAYMENT HELD");
  console.log(`  ${money(seeded.amountCents)} is locked in escrow.`);
  console.log("  The shipment has not been confirmed.");
  console.log("  The supplier has NOT received the funds.");
  console.log("  Release is unavailable — it requires a confirmed attestation, and none exists.");
  console.log("");
  console.log(`  escrow             ${escrowId}`);
  console.log(`  invoice            ${INVOICE_NUMBER} (${invoiceAfter?.status ?? "unreadable"})`);
  console.log(`  supplier balance   ${money(balanceAfter)} — unchanged by this run`);
  console.log(`  explorer           ${explorerObjectUrl(escrowId, configuredNetwork())}`);
  console.log("");
  console.log("  Nothing was attested, released or refunded. Demo A is untouched.\n");
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
