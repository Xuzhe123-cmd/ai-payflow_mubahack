/**
 * Populates a deployed treasury with the demo world.
 *
 * Every figure comes from the existing fixtures in lib/demo — the same data the
 * pipeline and the test suite already use. Nothing is re-typed here, so the
 * chain and the off-chain scenarios cannot drift apart before the frontend has
 * even been pointed at them.
 *
 * Idempotent where it can be, refusing where it cannot:
 *
 *  - Suppliers use registry::upsert, which overwrites. Safe to repeat.
 *  - Invoices and cash-flow events create new objects every time, so what has
 *    been created is recorded in the manifest and skipped on a re-run.
 *  - Funding is recorded too; the vault is not topped up twice by accident.
 *
 *   npx tsx scripts/seed.ts             # plan only
 *   npx tsx scripts/seed.ts --confirm   # send transactions
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractInvoice } from "../lib/deterministic/extractInvoice";
import { lookupSupplier } from "../lib/deterministic/lookupSupplier";
import { TREASURY_PROFILES } from "../lib/demo/cashFlow";
import { SCENARIOS } from "../lib/demo/scenarios";
import { SUPPLIERS } from "../lib/demo/suppliers";
import { centsToUnitsString } from "../lib/sui/units";
import {
  isDeploymentManifest,
  manifestPath,
  structTypes,
  type DeploymentManifest,
  type SeededInvoice,
} from "../lib/sui/deployment";
import * as sui from "./lib/suiCli";

/**
 * The company treasury profile. s2_cashflow is the scenario the dashboard
 * treats as "our" treasury, and `tight` is the profile it carries: $100,000
 * against a $50,000 reserve, which is what makes Scenario A's timing question
 * real and Scenario C's outflow bite.
 */
const COMPANY_PROFILE = TREASURY_PROFILES.tight;

const REGISTRY_STATUS_APPROVED = 1;
const DIRECTION_INFLOW = 0;
const DIRECTION_OUTFLOW = 1;

const confirmed = process.argv.includes("--confirm");
const force = process.argv.includes("--force");

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

function loadManifest(network: string): { manifest: DeploymentManifest; path: string } {
  const path = resolve(process.cwd(), manifestPath(network as never));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `No deployment manifest at ${manifestPath(network as never)}. ` +
        `Run: npx tsx scripts/deploy.ts --confirm`,
    );
  }
  if (!isDeploymentManifest(parsed)) {
    throw new Error(`Manifest at ${path} is not a valid deployment manifest.`);
  }
  return { manifest: parsed, path };
}

/** Invoices, derived from the demo scenarios rather than restated. */
function plannedInvoices() {
  return SCENARIOS.map((scenario) => {
    const facts = extractInvoice(scenario.document, scenario.asOfDate);
    const supplier = lookupSupplier(facts, SUPPLIERS);
    return {
      scenarioId: scenario.id,
      invoiceNumber: facts.invoiceNumber,
      // An unknown supplier keeps the name it claimed. That is the point of
      // scenario 4: the registry will not vouch for it, and check 3 fails.
      supplierId: supplier.supplierId ?? facts.supplierName,
      amountCents: facts.amountCents,
      currency: facts.currency,
      dueDate: facts.dueDate,
      poNumber: facts.poNumber ?? "",
      recipient: facts.recipientWallet,
    };
  });
}

async function main(): Promise<void> {
  heading("1. Network and manifest");
  const network = sui.assertSafeNetwork();
  const { manifest, path } = loadManifest(network);
  const sender = sui.activeAddress();

  console.log(`  network            ${network}`);
  console.log(`  package            ${manifest.packageId}`);
  console.log(`  treasury           ${manifest.objects.treasuryId}`);
  console.log(`  sender             ${sender}`);

  if (manifest.network !== network) {
    throw new Error(
      `Manifest is for ${manifest.network} but the CLI is on ${network}. Refusing to seed.`,
    );
  }

  const types = structTypes(manifest.packageId);
  const seeded = manifest.seed;
  const alreadyInvoiced = new Set((seeded?.invoices ?? []).map((entry) => entry.invoiceNumber));

  const invoices = plannedInvoices();
  const pendingInvoices = force
    ? invoices
    : invoices.filter((entry) => !alreadyInvoiced.has(entry.invoiceNumber));
  const needsFunding = force || !seeded?.vaultFundedCents;
  const needsEvents = force || !seeded?.cashFlowEventCount;

  heading("2. Plan");
  console.log(`  suppliers          ${SUPPLIERS.length} (upsert — safe to repeat)`);
  console.log(
    `  invoices           ${pendingInvoices.length} to create` +
      (alreadyInvoiced.size ? `, ${alreadyInvoiced.size} already on chain` : ""),
  );
  console.log(
    `  cash-flow events   ${needsEvents ? COMPANY_PROFILE.events.length : 0} to create` +
      (needsEvents ? "" : ` (${seeded?.cashFlowEventCount} already on chain)`),
  );
  console.log(
    `  vault funding      ${needsFunding ? money(COMPANY_PROFILE.treasury.currentCashCents) : "already funded"}`,
  );

  if (seeded && !force && pendingInvoices.length === 0 && !needsFunding && !needsEvents) {
    console.log(`\n  Nothing to do — this deployment is already seeded.`);
    console.log(`  Pass --force to create a second set of demo objects.\n`);
    return;
  }

  if (!confirmed) {
    heading("Dry run — nothing was sent");
    for (const invoice of pendingInvoices) {
      console.log(
        `  ${invoice.invoiceNumber.padEnd(18)} ${money(invoice.amountCents).padStart(10)}  ${invoice.supplierId}`,
      );
    }
    console.log(`\n  Re-run with --confirm to seed ${network}.\n`);
    return;
  }

  const { packageId, coinType } = manifest;
  const { treasuryId, treasuryOwnerCapId, supplierRegistryId, cashFlowCalendarId } =
    manifest.objects;

  heading("3. Suppliers");
  for (const supplier of SUPPLIERS) {
    sui.call({
      packageId,
      module: "registry",
      function: "upsert",
      args: [
        supplierRegistryId,
        treasuryOwnerCapId,
        supplier.id,
        supplier.name,
        supplier.registeredWallet,
        String(REGISTRY_STATUS_APPROVED),
      ],
    });
    console.log(`  approved           ${supplier.id.padEnd(16)} ${supplier.registeredWallet}`);
  }

  heading("4. Funding the vault");
  let fundedCents = seeded?.vaultFundedCents ?? 0;
  if (needsFunding) {
    const amount = centsToUnitsString(COMPANY_PROFILE.treasury.currentCashCents);
    const mintTx = sui.call({
      packageId,
      module: "mock_usdc",
      function: "mint",
      args: [manifest.objects.mockUsdcTreasuryCapId, amount, sender],
    });
    const coinId = sui.requireCreatedObject(mintTx, "0x2::coin::Coin", "mock_usdc::mint");

    sui.call({
      packageId,
      module: "treasury",
      function: "deposit",
      typeArgs: [coinType],
      args: [treasuryId, coinId],
    });
    fundedCents = COMPANY_PROFILE.treasury.currentCashCents;
    console.log(`  deposited          ${money(fundedCents)}`);
  } else {
    console.log(`  skipped            already funded`);
  }

  heading("5. Invoices");
  const createdInvoices: SeededInvoice[] = [...(seeded?.invoices ?? [])];
  for (const invoice of pendingInvoices) {
    const tx = sui.call({
      packageId,
      module: "invoice",
      function: "create",
      args: [
        treasuryOwnerCapId,
        invoice.invoiceNumber,
        invoice.supplierId,
        centsToUnitsString(invoice.amountCents),
        invoice.currency,
        invoice.dueDate,
        invoice.poNumber,
        invoice.recipient,
        String(Date.now()),
      ],
    });
    const objectId = sui.requireCreatedObject(tx, types.invoice, "invoice::create");
    createdInvoices.push({
      invoiceNumber: invoice.invoiceNumber,
      objectId,
      amountCents: invoice.amountCents,
      supplierId: invoice.supplierId,
    });
    console.log(
      `  ${invoice.invoiceNumber.padEnd(18)} ${money(invoice.amountCents).padStart(10)}  ${objectId}`,
    );
  }

  heading("6. Cash-flow events");
  let eventCount = seeded?.cashFlowEventCount ?? 0;
  if (needsEvents) {
    for (const event of COMPANY_PROFILE.events) {
      sui.call({
        packageId,
        module: "cashflow",
        function: "add_event",
        args: [
          cashFlowCalendarId,
          treasuryOwnerCapId,
          event.date,
          String(event.direction === "INFLOW" ? DIRECTION_INFLOW : DIRECTION_OUTFLOW),
          centsToUnitsString(event.amountCents),
          event.description,
        ],
      });
      console.log(
        `  ${event.date}  ${event.direction.padEnd(8)} ${money(event.amountCents).padStart(10)}  ${event.description}`,
      );
    }
    eventCount = COMPANY_PROFILE.events.length;
  } else {
    console.log(`  skipped            ${eventCount} already on chain`);
  }

  heading("7. Updating manifest");
  const updated: DeploymentManifest = {
    ...manifest,
    seed: {
      seededAt: new Date().toISOString(),
      supplierIds: SUPPLIERS.map((supplier) => supplier.id),
      invoices: createdInvoices,
      cashFlowEventCount: eventCount,
      vaultFundedCents: fundedCents,
    },
  };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.log(`  written            ${manifestPath(network)}`);

  console.log(`\nSeeded. Next: npx tsx scripts/verifyDeployment.ts\n`);
}

main().catch((error: unknown) => {
  console.error(`\nSeeding failed:`);
  console.error(sui.describeCliError(error));
  process.exitCode = 1;
});
