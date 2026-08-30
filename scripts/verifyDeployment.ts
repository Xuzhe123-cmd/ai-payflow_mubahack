/**
 * Checks a live deployment against what the manifest says was deployed.
 *
 * Read-only by default: it fetches objects and compares. The one thing it does
 * beyond reading is a DRY RUN of the Demo B payment, which asks the chain to
 * evaluate an $8,000 autonomous payment against a $5,000 cap and confirms it is
 * refused with abort code 5. A dry run costs nothing and changes nothing, so
 * this is safe to run repeatedly.
 *
 * `--demo-b` executes that payment for real, to capture a transaction digest
 * for the presentation. It is expected to FAIL — that failure is the artifact.
 *
 *   npx tsx scripts/verifyDeployment.ts
 *   npx tsx scripts/verifyDeployment.ts --demo-b
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { POLICY_CHECK_ORDER } from "../lib/sui/errorCodes";
import {
  classifyScenarioA0,
  classifyScenarioB,
  describeA0Verdict,
  describeVerdict,
} from "./lib/scenarioB";
import {
  AUTHORITY_AGENT,
  describeA0Proof,
  describeProofPackage,
  verifyA0Proof,
} from "./lib/a0Proof";
import { centsToUnitsString, unitsToCents } from "../lib/sui/units";
import {
  callPackageId,
  explorerTxUrl,
  isDeploymentManifest,
  manifestPath,
  typePackageId,
  type DeploymentManifest,
} from "../lib/sui/deployment";
import * as sui from "./lib/suiCli";

const DEMO_B_ABORT_CODE = 5; // EExceedsMaxPayment

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

/**
 * Move u64s arrive as decimal STRINGS, not numbers — they can exceed
 * Number.MAX_SAFE_INTEGER, so the JSON encoder never emits them as numbers.
 */
function asCents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return unitsToCents(BigInt(text));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const network = sui.assertSafeNetwork();
  const path = resolve(process.cwd(), manifestPath(network));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `No deployment manifest at ${manifestPath(network)}. ` +
        `Deploy first: npx tsx scripts/deploy.ts --confirm`,
    );
  }
  if (!isDeploymentManifest(parsed)) throw new Error(`Invalid manifest at ${path}`);
  const manifest: DeploymentManifest = parsed;

  heading("Deployment");
  console.log(`  network            ${network}`);
  console.log(`  package            ${manifest.packageId}`);
  console.log(`  published          ${manifest.publishedAt}`);

  heading("Objects exist");
  for (const [name, id] of Object.entries(manifest.objects)) {
    let ok = false;
    let detail = "";
    try {
      const object = sui.getObject(id);
      ok = Boolean(object.objectId);
      detail = ok ? "" : "not found";
    } catch (error) {
      detail = (error as Error).message.slice(0, 80);
    }
    check(name, ok, detail);
  }

  heading("Policy is on chain and correct");
  // TreasuryPolicy is stored BY VALUE inside the Treasury — there is no
  // separate policy object to fetch.
  const treasuryFields = sui.objectFields(manifest.objects.treasuryId);
  const policyFields = sui.nestedFields(treasuryFields, "policy");
  const expected = manifest.initialPolicy;

  if (Object.keys(policyFields).length === 0) {
    check(
      "policy readable",
      false,
      `no policy struct inside treasury; treasury fields seen: ${Object.keys(treasuryFields).join(", ") || "none"}`,
    );
  }

  const minReserve = asCents(policyFields.min_reserve);
  check(
    "minimum reserve",
    minReserve === expected.minimumReserveCents,
    `${minReserve === null ? "unreadable" : money(minReserve)} (expected ${money(expected.minimumReserveCents)})`,
  );

  const threshold = asCents(policyFields.human_approval_threshold);
  check(
    "human approval threshold",
    threshold === expected.humanApprovalThresholdCents,
    `${threshold === null ? "unreadable" : money(threshold)} (expected ${money(expected.humanApprovalThresholdCents)})`,
  );

  const currencies = policyFields.allowed_currencies;
  check(
    "allowed currencies",
    Array.isArray(currencies) &&
      expected.allowedCurrencies.every((code) => currencies.includes(code)),
    Array.isArray(currencies) ? currencies.join(", ") : "unreadable",
  );

  // Derived on chain at creation, so this proves the coin allowlist actually
  // names the package that was published rather than a guessed string.
  const coinTypes = policyFields.allowed_coin_types;
  const bareCoinType = manifest.coinType.replace(/^0x/, "");
  check(
    "settlement coin allowlisted",
    Array.isArray(coinTypes) &&
      coinTypes.some((entry) => String(entry).replace(/^0x/, "") === bareCoinType),
    Array.isArray(coinTypes) ? coinTypes.join(", ") : "unreadable",
  );

  const vault = asCents(treasuryFields.vault);
  console.log(
    `  INFO  vault balance — ${vault === null ? "unreadable" : money(vault)}` +
      (vault === 0 ? " (not yet funded; run scripts/seed.ts)" : ""),
  );

  heading("Seed data");
  const seed = manifest.seed;
  check("seed recorded in manifest", Boolean(seed), seed ? "" : "run scripts/seed.ts");
  if (seed) {
    check("suppliers registered", seed.supplierIds.length > 0, `${seed.supplierIds.length}`);
    check("invoices created", seed.invoices.length > 0, `${seed.invoices.length}`);
    check("cash-flow events", seed.cashFlowEventCount > 0, `${seed.cashFlowEventCount}`);
    check("vault funded", seed.vaultFundedCents > 0, money(seed.vaultFundedCents));
  }

  heading("Scenario A0 — the agent CAN pay within its authority");
  const demoA0 = seed?.invoices.find((invoice) => invoice.invoiceNumber === "INV-2026-3455");
  if (!demoA0) {
    check("$3,000 invoice present", false, "seed it before running this check");
  } else {
    const recipient = await recipientFor(manifest, demoA0.supplierId);
    const agentCapCents = manifest.initialPolicy.maxAgentPaymentCents;

    console.log(`  invoice            ${demoA0.invoiceNumber} (${money(demoA0.amountCents)})`);
    console.log(`  agent cap          ${money(agentCapCents)}`);
    console.log(`  supplier           ${demoA0.supplierId} -> ${recipient}`);

    // The live status decides HOW this is verified. A0 settles the invoice, and
    // a settled invoice can never be settled again — so once the proof exists,
    // re-attempting the payment tests replay protection rather than A0.
    const invoiceStatus = readInvoiceStatus(demoA0.objectId);

    if (invoiceStatus === "PAID") {
      await verifyExistingA0Proof({
        manifest,
        network,
        invoiceObjectId: demoA0.objectId,
        invoiceStatus,
        agentCapCents,
        registeredRecipient: recipient,
      });
    } else {
      // A fresh deployment, where the payment has not been made yet.
      const now = Date.now();
      const options = {
        packageId: callPackageId(manifest),
        module: "payment",
        function: "execute_payment",
        typeArgs: [manifest.coinType],
        args: [
          manifest.objects.treasuryId,
          manifest.objects.agentCapId,
          manifest.objects.supplierRegistryId,
          demoA0.objectId,
          centsToUnitsString(demoA0.amountCents),
          String(recipient),
          "rec_demo_a0",
          String(now),
          String(now + 86_400_000),
          "0x6",
        ],
      };

      const executeA0 = process.argv.includes("--demo-a0");
      let a0Verdict;

      if (executeA0) {
        console.log("  mode               REAL transaction — this one is expected to SUCCEED");
        const outcome = sui.callAllowingAbort(options);
        if (outcome.digest) {
          const onChain = sui.fetchTransaction(outcome.digest);
          console.log(`  transaction        ${outcome.digest}`);
          console.log(`  on-chain status    ${onChain.status ?? "unknown"}`);
          if (onChain.exists) {
            console.log(`  checkpoint         ${onChain.checkpoint ?? "(pending)"}`);
            console.log(`  explorer           ${explorerTxUrl(outcome.digest, network)}`);
          }
        }
        a0Verdict = classifyScenarioA0({
          succeeded: outcome.ok,
          abort: outcome.abort,
          error: outcome.error || outcome.raw,
        });
      } else {
        console.log(`  invoice status     ${invoiceStatus ?? "unknown"} (not yet settled)`);
        console.log("  mode               dry run (no gas, no state change)");
        const result = sui.dryRunCall(options);
        a0Verdict = classifyScenarioA0(
          result.ok
            ? { succeeded: true, abort: null, error: "" }
            : { succeeded: false, abort: result.abort, error: result.error },
        );
      }

      check(
        "accepted by every on-chain check",
        a0Verdict.kind === "EXECUTED_AUTONOMOUSLY",
        describeA0Verdict(a0Verdict),
      );
    }
  }

  heading("Scenario B — AI cannot override Sui");
  const demoB = seed?.invoices.find((invoice) => invoice.amountCents === 800_000);
  if (!demoB) {
    check("$8,000 invoice present", false, "seed it before running this check");
  } else {
    const now = Date.now();
    const options = {
      packageId: callPackageId(manifest),
      module: "payment",
      function: "execute_payment",
      typeArgs: [manifest.coinType],
      args: [
        manifest.objects.treasuryId,
        manifest.objects.agentCapId,
        manifest.objects.supplierRegistryId,
        demoB.objectId,
        centsToUnitsString(demoB.amountCents),
        // The registered wallet, so ONLY the payment cap can be what fails.
        String(await recipientFor(manifest, demoB.supplierId)),
        "rec_demo_b",
        String(now),
        String(now + 86_400_000),
        "0x6",
      ],
    };

    console.log(`  invoice            ${demoB.invoiceNumber} (${money(demoB.amountCents)})`);
    console.log(`  agent cap          ${money(manifest.initialPolicy.maxAgentPaymentCents)}`);

    const executeForReal = process.argv.includes("--demo-b");
    let verdict;

    if (executeForReal) {
      console.log("  mode               REAL transaction — this is EXPECTED to fail");
      // Not sui.call(): that throws on failure, and here the abort IS the
      // result. This keeps the digest of the refused payment, which is the
      // artifact worth showing.
      const outcome = sui.callAllowingAbort(options);
      if (outcome.digest) {
        // Confirm it before calling it a digest. A failed transaction is still
        // a real one in Sui — it reaches consensus and is recorded — but that
        // has to be checked rather than assumed from a string's shape.
        const onChain = sui.fetchTransaction(outcome.digest);
        if (onChain.exists) {
          console.log(`  transaction        ${outcome.digest}`);
          console.log(`  on-chain status    ${onChain.status ?? "unknown"}`);
          console.log(
            `  checkpoint         ${onChain.checkpoint ?? "(pending)"}` +
              (onChain.checkpoint ? " — reached consensus" : ""),
          );
          if (onChain.gasChargedMist !== null) {
            console.log(`  gas charged        ${onChain.gasChargedMist} MIST`);
          }
          console.log(`  explorer           ${explorerTxUrl(outcome.digest, network)}`);
        } else {
          console.log(`  identifier         ${outcome.digest}`);
          console.log(`  on chain           NO — not found; this never reached consensus`);
          console.log(`  explorer           (withheld — the identifier is not a recorded digest)`);
        }
      } else {
        console.log(`  digest             (none — the transaction never reached the chain)`);
        console.log(`  exit status        ${outcome.exitStatus ?? "unknown"}`);
        // No digest means the CLI refused before submitting. That is never a
        // Scenario B pass, so print everything it said rather than a summary.
        console.log(`\n  --- complete CLI output ---`);
        console.log(
          (outcome.raw || "(the CLI produced no output)")
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
        );
        console.log(`  --- end CLI output ---\n`);
        console.log(`  command:\n  ${(outcome.argv ?? []).join(" ")}\n`);
      }
      verdict = classifyScenarioB({
        succeeded: outcome.ok,
        abort: outcome.abort,
        error: outcome.error || outcome.raw,
        expectedPackageId: callPackageId(manifest),
      });
    } else {
      console.log("  mode               dry run (no gas, no state change)");
      const result = sui.dryRunCall(options);
      verdict = result.ok
        ? classifyScenarioB({
            succeeded: true,
            abort: null,
            error: "",
            expectedPackageId: callPackageId(manifest),
          })
        : classifyScenarioB({
            succeeded: false,
            abort: result.abort,
            error: result.error,
            expectedPackageId: callPackageId(manifest),
          });
    }

    // Only ONE verdict counts as proof. Anything else — including a rejection
    // for a different reason — is reported as the failure it is.
    check(
      "rejected by the agent payment cap",
      verdict.kind === "REJECTED_BY_CAP",
      describeVerdict(verdict),
    );

    if (verdict.kind === "REJECTED_OTHER") {
      console.log(
        `  NOTE  expected ${DEMO_B_ABORT_CODE} (${POLICY_CHECK_ORDER[DEMO_B_ABORT_CODE - 1]}). ` +
          `Fix the seed data — never loosen the policy to make a demo pass.`,
      );
    }
  }

  heading(failures === 0 ? "All checks passed" : `${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

/** The wallet the registry holds for a supplier — the only address that passes check 4. */
/** Live invoice status, decoded from the chain's numeric field. */
function readInvoiceStatus(invoiceObjectId: string): string | null {
  const fields = sui.objectFields(invoiceObjectId);
  const raw = fields.status;
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  const names = [
    "PENDING",
    "ANALYZING",
    "APPROVED",
    "SCHEDULED",
    "PAID",
    "REJECTED",
    "HUMAN_REVIEW",
    "ESCROWED",
  ];
  return names[value] ?? `UNKNOWN(${value})`;
}

/**
 * Verifies A0 from the settlement that already happened.
 *
 * The invoice is PAID, so the payment cannot be repeated — check 8 exists
 * precisely to stop that. What is checked instead is the recorded proof, and it
 * is checked hard: the transaction must exist and have succeeded, and the frozen
 * PaymentRecord it created must agree with the claim on invoice number, amount,
 * recipient, supplier and — the part that makes it A0 rather than merely a
 * payment — the AGENT authority.
 */
async function verifyExistingA0Proof(input: {
  manifest: DeploymentManifest;
  network: string;
  invoiceObjectId: string;
  invoiceStatus: string;
  agentCapCents: number;
  registeredRecipient: string;
}): Promise<void> {
  const { manifest, invoiceObjectId, invoiceStatus, agentCapCents, registeredRecipient } = input;
  const claim = manifest.proofs?.a0 ?? null;

  console.log("  invoice status     PAID — settled by a previous transaction");
  console.log("  mode               EXISTING ON-CHAIN PROOF");

  if (!claim) {
    check(
      "accepted by every on-chain check",
      false,
      describeA0Proof(
        verifyA0Proof({
          claim: null,
          transaction: null,
          record: null,
          invoiceStatus,
          agentCapCents,
          registeredRecipient,
        }),
      ),
    );
    return;
  }

  console.log(`  transaction        ${claim.digest}`);

  const transaction = sui.fetchTransaction(claim.digest);
  console.log(`  on-chain status    ${transaction.status ?? "not found"}`);
  if (transaction.exists) {
    console.log(`  checkpoint         ${transaction.checkpoint ?? "(pending)"}`);
    console.log(`  explorer           ${explorerTxUrl(claim.digest, input.network as never)}`);
  }

  // The proof ran against whichever package was current at the time. After an
  // upgrade that is the ORIGINAL, and that is correct rather than stale.
  console.log(
    `  proof package      ${claim.packageId.slice(0, 12)}… — ` +
      describeProofPackage(claim.packageId, callPackageId(manifest), typePackageId(manifest)),
  );
  console.log(`  payment record     ${claim.paymentRecordId}`);

  const recordFields = sui.objectFields(claim.paymentRecordId);
  const record =
    Object.keys(recordFields).length > 0
      ? {
          invoiceNumber: String(recordFields.invoice_number ?? ""),
          amountCents: unitsToCents(BigInt(String(recordFields.amount ?? "0"))),
          recipient: String(recordFields.recipient ?? ""),
          supplierId: String(recordFields.supplier_id ?? ""),
          // The CLI renders a u8 as "0.0"; take the integer part.
          authority: Number.parseInt(String(recordFields.authority ?? "-1"), 10),
          packageId: null,
        }
      : null;

  if (record) {
    console.log(`  record amount      ${money(record.amountCents)}`);
    console.log(
      `  record authority   ${record.authority} ` +
        `(${record.authority === AUTHORITY_AGENT ? "AGENT — autonomous" : "NOT the agent"})`,
    );
  }

  const verdict = verifyA0Proof({
    claim,
    transaction: { exists: transaction.exists, status: transaction.status },
    record,
    invoiceStatus,
    agentCapCents,
    registeredRecipient,
  });

  // Cross-check that the proof points at the invoice this check is about.
  const sameInvoice = claim.invoiceObjectId === invoiceObjectId;
  check(
    "proof refers to this invoice object",
    sameInvoice,
    sameInvoice ? claim.invoiceObjectId : `proof names ${claim.invoiceObjectId}`,
  );

  check(
    "accepted by every on-chain check",
    verdict.kind === "PROVEN",
    describeA0Proof(verdict),
  );
}

async function recipientFor(manifest: DeploymentManifest, supplierId: string): Promise<string> {
  const { SUPPLIERS } = await import("../lib/demo/suppliers");
  const supplier = SUPPLIERS.find((entry) => entry.id === supplierId);
  if (!supplier) {
    throw new Error(
      `Supplier ${supplierId} is not in the demo registry, so Scenario B would fail check 3 ` +
        `rather than check 5. Fix the seed data.`,
    );
  }
  void manifest;
  return supplier.registeredWallet;
}

main().catch((error: unknown) => {
  console.error(`\nVerification failed:`);
  console.error(sui.describeCliError(error));
  process.exitCode = 1;
});
