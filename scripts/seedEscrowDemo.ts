/**
 * Creates the two conditional demo invoices and the demo shipment oracle.
 *
 * DRY RUN BY DEFAULT. The bare command creates nothing and prints the exact
 * calls it would make; only `--confirm` submits.
 *
 *   npx tsx scripts/seedEscrowDemo.ts              # plan only
 *   npx tsx scripts/seedEscrowDemo.ts --confirm    # create the objects
 *
 * WHAT THIS TOUCHES. New objects only. It creates two invoices that did not
 * exist and issues one capability. It does not modify the treasury, the
 * registry, the eight seeded invoices, or anything the A0 and Scenario B
 * transactions reference — there is no call here that takes an existing object
 * as mutable except the treasury, and that is only read for its id when issuing
 * the oracle capability.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It locks no escrow, makes no attestation,
 * releases nothing and refunds nothing. Those are the demo itself, and they run
 * from the interface or from a separate deliberate command — not from a seed.
 *
 * Requires the escrow upgrade: `invoice::require_shipment_confirmation` and
 * `oracle::issue_to` exist only on the upgraded package.
 *
 * RESUMABLE. An earlier version of this script issued a real OracleCap, failed
 * to recognise the created object, and exited without recording it — leaving a
 * capability on chain the manifest did not know about, which a re-run would
 * have duplicated. Two things came out of that. Existence is now established
 * from CHAIN state rather than from the manifest, so a lost record cannot cause
 * a duplicate; and the manifest is written after EVERY object, so a later
 * failure cannot lose an earlier success.
 *
 * THE PACKAGE-ID DISTINCTION, which is what actually broke:
 *   callPackageId    where a Move call is SENT — the newest version
 *   typePackageId    the original publish, for the settlement coin type
 *   structTypesFor   each type at the version that DEFINED its module, so
 *                    OracleCap resolves to v2 while Invoice stays at v1
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { SUPPLIERS } from "../lib/demo/suppliers";
import { centsToUnitsString } from "../lib/sui/units";
import {
  callPackageId,
  isDeploymentManifest,
  manifestPath,
  structTypesFor,
  typePackageId,
  type DeploymentManifest,
  type SeededInvoice,
  type SuiNetwork,
} from "../lib/sui/deployment";
import {
  decideInvoices,
  decideOracleCap,
  seedIsComplete,
  type ExistingOracleCap,
} from "./lib/escrowSeedPlan";
import * as sui from "./lib/suiCli";

const confirmed = process.argv.includes("--confirm");

/** The oracle identity written into every attestation it makes. */
const ORACLE_ID = "demo_shipment_oracle";

/**
 * The two conditional invoices.
 *
 * Both are deliberately unremarkable: an approved supplier, the wallet the
 * registry already holds, USD, and an amount inside the agent's $5,000 cap. The
 * ONLY thing that distinguishes them from an ordinary autonomous payment is the
 * shipment condition — which is the entire point. If either failed a policy
 * check, the demo would be showing the wrong mechanism.
 */
interface ConditionalInvoicePlan {
  label: string;
  invoiceNumber: string;
  amountCents: number;
  dueDate: string;
  poNumber: string;
  supplierId: string;
  shipment: "CONFIRMED" | "NOT_CONFIRMED";
  expectation: string;
}

const PLANNED: ConditionalInvoicePlan[] = [
  {
    label: "Invoice C",
    invoiceNumber: "INV-2026-3501",
    amountCents: 480_000,
    dueDate: "2026-09-24",
    poNumber: "PO-2026-0530",
    supplierId: "sup_northwind",
    shipment: "CONFIRMED",
    expectation: "PAY_NOW → authorized → oracle confirms → escrow locked then RELEASED",
  },
  {
    label: "Invoice D",
    invoiceNumber: "INV-2026-3502",
    amountCents: 400_000,
    dueDate: "2026-09-26",
    poNumber: "PO-2026-0531",
    supplierId: "sup_kestrel",
    shipment: "NOT_CONFIRMED",
    expectation: "PAY_NOW → authorized → oracle silent → funds remain ESCROWED",
  },
];

/** Agent policy, restated here only to refuse a plan that would not demo. */
const AGENT_MAX_SINGLE_CENTS = 500_000;

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

function fail(message: string): never {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

function loadManifest(network: SuiNetwork): DeploymentManifest {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), manifestPath(network)), "utf8"),
  );
  if (!isDeploymentManifest(parsed)) fail("deployment manifest is not valid.");
  return parsed;
}

async function main(): Promise<void> {
  heading("1. Network");
  const network = sui.assertSafeNetwork() as SuiNetwork;
  const sender = sui.activeAddress();
  console.log(`  network            ${network}`);
  console.log(`  active address     ${sender}`);

  const manifest = loadManifest(network);
  const callPackage = callPackageId(manifest);
  const typePackage = typePackageId(manifest);
  const coinType = manifest.coinType;

  heading("2. Package");
  console.log(`  calls target       ${callPackage}`);
  console.log(`  types resolve to   ${typePackage}`);
  if (!manifest.upgrade) {
    fail(
      "The manifest records no upgrade. escrow and oracle do not exist on the deployed package " +
        "yet — run `npm run upgrade -- --confirm` first.",
    );
  }
  console.log(`  upgrade version    ${manifest.upgrade.version}`);

  heading("3. Preconditions");
  for (const plan of PLANNED) {
    const supplier = SUPPLIERS.find((entry) => entry.id === plan.supplierId);
    if (!supplier) fail(`${plan.label}: supplier ${plan.supplierId} is not in the registry fixture.`);
    if (supplier.registryStatus !== "APPROVED") {
      fail(`${plan.label}: supplier ${plan.supplierId} is ${supplier.registryStatus}, not APPROVED.`);
    }
    if (plan.amountCents > AGENT_MAX_SINGLE_CENTS) {
      fail(
        `${plan.label}: ${money(plan.amountCents)} exceeds the agent's ${money(AGENT_MAX_SINGLE_CENTS)} cap. ` +
          "Both demo invoices must be autonomously payable, or the demo shows the wrong refusal.",
      );
    }
    // Whether it already exists is decided from CHAIN state in step 4, not
    // from the manifest — a partial run can leave an object unrecorded.

    console.log(
      `  ${plan.label.padEnd(10)} ${plan.invoiceNumber}  ${money(plan.amountCents).padStart(8)}  ` +
        `${supplier.name} → ${supplier.registeredWallet.slice(0, 10)}…`,
    );
  }

  heading("4. Existing state, read from the chain");
  const types = structTypesFor(manifest);
  const treasury = manifest.objects.treasuryId;
  const ownerCap = manifest.objects.treasuryOwnerCapId;

  // The three package ids, spelled out because confusing them is what broke the
  // first run of this script.
  console.log(`  OracleCap type     ${types.oracleCap}`);
  console.log(`  Invoice type       ${types.invoice}`);
  console.log(`  coin type argument ${coinType}`);

  // Discovered from the chain, not from the manifest. A partial run can leave a
  // real object behind with nothing recorded, and that is exactly the case that
  // must not produce a duplicate.
  const existingCap = await findOracleCap(sender, types.oracleCap);
  const oracleDecision = decideOracleCap(existingCap, {
    expectedType: types.oracleCap,
    expectedTreasuryId: treasury,
    expectedOwner: sender,
    expectedOracleId: ORACLE_ID,
  });

  if (oracleDecision.kind === "ISSUE") {
    console.log("  OracleCap          none on chain — would be issued");
  } else if (oracleDecision.kind === "REUSE") {
    console.log(`  OracleCap          ${oracleDecision.objectId}`);
    console.log("                     exists and matches — will REUSE, not re-issue");
  } else {
    console.log(`  OracleCap          ${oracleDecision.objectId}`);
    fail(
      `an OracleCap exists but does not match: ${oracleDecision.reason}. ` +
        "Refusing to issue a second one — resolve this by hand first.",
    );
  }

  const onChainInvoices = await findInvoices(types.invoice);
  const invoiceDecisions = decideInvoices(
    PLANNED.map((plan) => ({ invoiceNumber: plan.invoiceNumber, amountCents: plan.amountCents })),
    onChainInvoices,
  );
  console.log(`  invoices on chain  ${onChainInvoices.length}`);
  for (const decision of invoiceDecisions) {
    console.log(
      `  ${decision.invoiceNumber}      ` +
        (decision.create
          ? "not on chain — would be created"
          : `${decision.existingObjectId} — exists, will SKIP`),
    );
  }

  if (oracleDecision.kind === "REUSE" && seedIsComplete(oracleDecision, invoiceDecisions)) {
    heading("Nothing left to do");
    console.log("  Every object this script creates already exists on chain.");
    if (confirmed) {
      // Reconciles a manifest that lost track of objects a partial run created.
      recordManifest(manifest, network, oracleDecision.objectId, invoiceDecisions);
      console.log(`  manifest           ${manifestPath(network)} reconciled`);
    }
    return;
  }

  heading("5. Transactions that would be submitted");
  let step = 0;

  if (oracleDecision.kind === "ISSUE") {
    step += 1;
    console.log(`\n  ${step}. issue the ${ORACLE_ID} capability`);
    console.log(
      `     ${sui.renderCall(issueOracleCall(callPackage, coinType, treasury, ownerCap, sender))}`,
    );
  }

  for (const [index, plan] of PLANNED.entries()) {
    if (!invoiceDecisions[index].create) continue;
    step += 1;
    console.log(`\n  ${step}. create ${plan.invoiceNumber} (${money(plan.amountCents)})`);
    console.log(`     ${sui.renderCall(createInvoiceCall(callPackage, ownerCap, plan))}`);
    step += 1;
    console.log(`\n  ${step}. attach the shipment condition to ${plan.invoiceNumber}`);
    console.log(
      `     ${callPackage}::invoice::require_shipment_confirmation <invoice id> ${ownerCap}`,
    );
  }

  console.log(`\n  ${step} transaction(s). Every one creates or annotates a NEW object.`);

  heading("6. What is NOT done here");
  console.log("  no escrow is locked      (escrow::execute_conditional)");
  console.log("  no attestation is made   (oracle::attest)");
  console.log("  no escrow is released    (escrow::release)");
  console.log("  no escrow is refunded    (escrow::refund)");
  console.log("  no existing invoice, capability or balance is touched");

  heading("7. Expected demo behaviour once created");
  for (const plan of PLANNED) {
    console.log(`  ${plan.label} — ${plan.invoiceNumber} ${money(plan.amountCents)}`);
    console.log(`    shipment         ${plan.shipment}`);
    console.log(`    expectation      ${plan.expectation}`);
  }

  if (!confirmed) {
    heading("Dry run complete — nothing was submitted");
    console.log("  No transaction was sent. No object was created.");
    console.log("\n  To create these objects:\n    npx tsx scripts/seedEscrowDemo.ts --confirm\n");
    return;
  }

  heading("8. Creating objects");
  let oracleCapId = oracleDecision.kind === "REUSE" ? oracleDecision.objectId : "";

  if (oracleDecision.kind === "ISSUE") {
    console.log(`  issuing the ${ORACLE_ID} capability`);
    const tx = sui.call(issueOracleCall(callPackage, coinType, treasury, ownerCap, sender));
    oracleCapId = sui.requireCreatedObject(tx, types.oracleCap, "OracleCap");
    console.log(`     OracleCap        ${oracleCapId}`);
    // Recorded IMMEDIATELY. The bug this replaces created a real capability and
    // then threw, leaving nothing written down for the next run to find.
    recordManifest(manifest, network, oracleCapId, invoiceDecisions);
  }

  const created: SeededInvoice[] = [];
  for (const [index, plan] of PLANNED.entries()) {
    const decision = invoiceDecisions[index];
    if (!decision.create) {
      console.log(`  ${plan.invoiceNumber} already exists — skipping`);
      continue;
    }

    console.log(`  creating ${plan.invoiceNumber}`);
    const tx = sui.call(createInvoiceCall(callPackage, ownerCap, plan));
    const objectId = sui.requireCreatedObject(tx, types.invoice, "Invoice");
    console.log(`     Invoice          ${objectId}`);
    created.push({
      invoiceNumber: plan.invoiceNumber,
      objectId,
      amountCents: plan.amountCents,
      supplierId: plan.supplierId,
    });
    // Written before the condition call, so a failure there leaves the invoice
    // recorded rather than orphaned.
    recordManifest(manifest, network, oracleCapId, invoiceDecisions, created);

    console.log(`  attaching the shipment condition to ${plan.invoiceNumber}`);
    sui.call({
      packageId: callPackage,
      module: "invoice",
      function: "require_shipment_confirmation",
      typeArgs: [],
      args: [objectId, ownerCap],
    });
    console.log("     condition        attached");
  }

  recordManifest(manifest, network, oracleCapId, invoiceDecisions, created);
  console.log(`\n  manifest           ${manifestPath(network)} updated`);
}

/** The demo clock instant, so created_at matches the rest of the demo. */
const DEMO_CREATED_AT_MS = Date.UTC(2026, 8, 6, 9, 0, 0);

/**
 * The settlement coin type argument keeps the ORIGINAL package id.
 *
 * MOCK_USDC was defined by the first publish and an upgrade does not move it.
 * Passing the upgraded id here would name a type that does not exist.
 */
function issueOracleCall(
  callPackage: string,
  coinType: string,
  treasury: string,
  ownerCap: string,
  sender: string,
): sui.CallOptions {
  return {
    packageId: callPackage,
    module: "oracle",
    function: "issue_to",
    typeArgs: [coinType],
    args: [treasury, ownerCap, ORACLE_ID, sender],
  };
}

function createInvoiceCall(
  callPackage: string,
  ownerCap: string,
  plan: ConditionalInvoicePlan,
): sui.CallOptions {
  const supplier = SUPPLIERS.find((entry) => entry.id === plan.supplierId)!;
  return {
    packageId: callPackage,
    module: "invoice",
    function: "create",
    typeArgs: [],
    args: [
      ownerCap,
      plan.invoiceNumber,
      plan.supplierId,
      centsToUnitsString(plan.amountCents),
      "USD",
      plan.dueDate,
      plan.poNumber,
      supplier.registeredWallet,
      String(DEMO_CREATED_AT_MS),
    ],
  };
}

/**
 * Finds an OracleCap owned by `owner` whose FULL type matches.
 *
 * Searching by the complete type string is the fix. The previous version looked
 * for the v1 OracleCap type and did not recognise the v2 object the chain had
 * just created, because a module ADDED by an upgrade is addressed at that
 * upgrade's package rather than at the original publish.
 */
async function findOracleCap(
  owner: string,
  expectedType: string,
): Promise<ExistingOracleCap | null> {
  const owned = await sui.objectsOfType(expectedType, owner);
  if (owned.length === 0) return null;

  const [first] = owned;
  return {
    objectId: first.objectId,
    // Matched by the query, so it is the expected type by construction.
    objectType: expectedType,
    owner,
    treasuryId: first.fields.treasury_id ? String(first.fields.treasury_id) : null,
    oracleId: first.fields.oracle_id ? String(first.fields.oracle_id) : null,
  };
}

/** Invoice objects already on chain, keyed by the number check 8 cares about. */
async function findInvoices(
  invoiceType: string,
): Promise<{ invoiceNumber: string; objectId: string }[]> {
  const found = await sui.objectsOfType(invoiceType);
  return found.flatMap((entry) => {
    const invoiceNumber = entry.fields.invoice_number
      ? String(entry.fields.invoice_number)
      : null;
    return invoiceNumber ? [{ invoiceNumber, objectId: entry.objectId }] : [];
  });
}

/**
 * Persists what exists so far, after every created object rather than once at
 * the end. The failure this script was rewritten for lost a real capability
 * precisely because the write came last.
 */
function recordManifest(
  manifest: DeploymentManifest,
  network: SuiNetwork,
  oracleCapId: string,
  decisions: readonly { invoiceNumber: string; existingObjectId: string | null }[],
  created: readonly SeededInvoice[] = [],
): void {
  const byNumber = new Map(created.map((entry) => [entry.invoiceNumber, entry]));
  const invoices: SeededInvoice[] = [];

  for (const [index, plan] of PLANNED.entries()) {
    const fromRun = byNumber.get(plan.invoiceNumber);
    if (fromRun) {
      invoices.push(fromRun);
      continue;
    }
    const existing = decisions[index]?.existingObjectId;
    if (existing) {
      invoices.push({
        invoiceNumber: plan.invoiceNumber,
        objectId: existing,
        amountCents: plan.amountCents,
        supplierId: plan.supplierId,
      });
    }
  }

  const updated: DeploymentManifest = {
    ...manifest,
    escrowDemo: {
      createdAt: manifest.escrowDemo?.createdAt ?? new Date().toISOString(),
      oracleCapId,
      oracleId: ORACLE_ID,
      invoices,
      escrowIds: manifest.escrowDemo?.escrowIds ?? [],
      attestationIds: manifest.escrowDemo?.attestationIds ?? [],
    },
  };
  writeFileSync(
    resolve(process.cwd(), manifestPath(network)),
    `${JSON.stringify(updated, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
