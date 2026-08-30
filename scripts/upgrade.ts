/**
 * Upgrades the deployed payflow package to add escrow and the shipment oracle.
 *
 * DRY RUN BY DEFAULT. The bare command touches nothing: it builds, runs the
 * Move suite, verifies the UpgradeCap against live chain state, asks a fullnode
 * to execute the upgrade without committing it, and prints the plan. Only
 * `--confirm` submits.
 *
 *   npx tsx scripts/upgrade.ts              # preflight + plan, no transactions
 *   npx tsx scripts/upgrade.ts --confirm    # actually upgrade
 *
 * WHAT AN UPGRADE DOES AND DOES NOT DO.
 *
 * It publishes a NEW package id containing the new code. It does not migrate,
 * move, or alter a single existing object. Everything already on chain — the
 * treasury, the registry, the eight invoices, both capabilities, the frozen
 * payment record from the A0 payment, the failed Scenario B transaction — is
 * exactly as it was, because a package upgrade adds a version rather than
 * rewriting the one beneath it.
 *
 * The consequence to keep straight: after this, CALLS go to the new id while
 * TYPES stay on the original. `callPackageId` and `typePackageId` in
 * lib/sui/deployment.ts exist so no call site has to remember which.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  callPackageId,
  manifestPath,
  isDeploymentManifest,
  type DeploymentManifest,
  type SuiNetwork,
} from "../lib/sui/deployment";
import * as sui from "./lib/suiCli";

const PACKAGE_PATH = resolve(process.cwd(), "move/payflow");
const EXPECTED_MOVE_TESTS = 53;
/** Modules this upgrade introduces. Verified present in the built package. */
const NEW_MODULES = ["escrow", "oracle"] as const;
/** An upgrade is a single transaction, but leave room for a fee spike. */
const MINIMUM_MIST = BigInt(200_000_000);

const confirmed = process.argv.includes("--confirm");

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function fail(message: string): never {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

function loadManifest(network: SuiNetwork): DeploymentManifest {
  const path = resolve(process.cwd(), manifestPath(network));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isDeploymentManifest(parsed)) {
    fail(`${path} is not a valid deployment manifest.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  heading("1. Toolchain");
  console.log(`  sui CLI            ${sui.cliVersion()}`);

  heading("2. Network");
  const network = sui.assertSafeNetwork() as SuiNetwork;
  const sender = sui.activeAddress();
  console.log(`  network            ${network}`);
  console.log(`  active address     ${sender}`);

  const manifest = loadManifest(network);
  const originalPackage = manifest.packageId;
  const currentPackage = callPackageId(manifest);

  heading("3. Move package (offline)");
  sui.moveBuild(PACKAGE_PATH);
  console.log("  build              ok");

  const { passed, failed } = sui.moveTest(PACKAGE_PATH);
  if (failed > 0) fail(`${failed} Move test(s) failing. Nothing is upgraded while the suite is red.`);
  if (passed < EXPECTED_MOVE_TESTS) {
    fail(`Expected at least ${EXPECTED_MOVE_TESTS} Move tests, saw ${passed}. Refusing to upgrade.`);
  }
  console.log(`  move test          ${passed} passed`);

  for (const moduleName of NEW_MODULES) {
    const source = resolve(PACKAGE_PATH, `sources/${moduleName}.move`);
    try {
      readFileSync(source, "utf8");
    } catch {
      fail(`sources/${moduleName}.move is missing — this upgrade exists to add it.`);
    }
  }
  console.log(`  new modules        ${NEW_MODULES.join(", ")}`);

  heading("4. Upgrade capability (live)");
  const upgradeCapId = manifest.upgradeCapId;
  if (!upgradeCapId) {
    fail(
      "The manifest records no upgradeCapId. Add it before upgrading — the id is printed by " +
        "`sui client objects` as a 0x2::package::UpgradeCap owned by the publisher.",
    );
  }

  // Read it rather than trusting the file: the cap could have been transferred,
  // burned, or restricted since the manifest was written.
  const capFields = sui.objectFields(upgradeCapId);
  if (!capFields) fail(`UpgradeCap ${upgradeCapId} does not exist on ${network}.`);

  const capPackage = String(capFields.package ?? "");
  const capPolicy = Number(capFields.policy ?? -1);
  const capVersion = Number(capFields.version ?? 0);
  const capOwner = sui.objectOwner(upgradeCapId);

  console.log(`  UpgradeCap         ${upgradeCapId}`);
  console.log(`  governs package    ${capPackage}`);
  console.log(`  policy             ${capPolicy} (${describePolicy(capPolicy)})`);
  console.log(`  current version    ${capVersion}`);
  console.log(`  owner              ${capOwner ?? "(unknown)"}`);

  if (capPackage !== currentPackage) {
    fail(
      `This capability governs ${capPackage}, but the manifest's current package is ${currentPackage}.`,
    );
  }
  if (capPolicy !== 0) {
    fail(
      `Upgrade policy is ${capPolicy} (${describePolicy(capPolicy)}). This upgrade adds modules, ` +
        "which only the Compatible policy (0) permits.",
    );
  }
  if (capOwner && capOwner !== sender) {
    fail(`The UpgradeCap is owned by ${capOwner}, but the active address is ${sender}.`);
  }

  heading("5. Gas");
  const gas = sui.gasReport();
  console.log(`  balance            ${sui.formatSui(gas.totalMist)} SUI`);
  if (gas.totalMist < MINIMUM_MIST) {
    fail(
      `Need at least ${sui.formatSui(MINIMUM_MIST)} SUI to upgrade, have ${sui.formatSui(gas.totalMist)}.`,
    );
  }

  heading("6. Compatibility (dry run against a fullnode)");
  const dry = sui.dryRunUpgrade(PACKAGE_PATH, upgradeCapId);
  if (!dry.ok) {
    console.error(dry.output || dry.error || "(no output)");
    fail(
      "The upgrade dry run was rejected. If this mentions compatibility, the new code changed " +
        "an existing public signature or struct layout, which an upgrade may never do.",
    );
  }
  console.log("  compatibility      accepted");
  console.log("  dry run            executed without committing");
  if (dry.response?.effects?.gasUsed) {
    console.log(`  estimated gas      ${describeGas(dry.response.effects.gasUsed)}`);
  }

  heading("7. Plan");
  printPlan({ manifest, originalPackage, currentPackage, upgradeCapId, capVersion, sender });

  if (!confirmed) {
    heading("Dry run complete — nothing was submitted");
    console.log("  No transaction was sent. No object was created or modified.");
    console.log(`\n  To upgrade for real:\n    npx tsx scripts/upgrade.ts --confirm\n`);
    return;
  }

  heading("8. Submitting the upgrade");
  const tx = sui.upgrade(PACKAGE_PATH, upgradeCapId);
  const newPackageId = sui.publishedPackageId(tx);
  console.log(`  digest             ${tx.digest}`);
  console.log(`  new package        ${newPackageId}`);

  const updated: DeploymentManifest = {
    ...manifest,
    // The original id is NOT touched: every existing object's type still
    // resolves to it, and so does the settlement coin.
    upgrade: {
      packageId: newPackageId,
      previousPackageId: currentPackage,
      version: capVersion + 1,
      upgradeCapId,
      upgradedAt: new Date().toISOString(),
      digest: tx.digest,
      addedModules: [...NEW_MODULES],
    },
  };

  const path = resolve(process.cwd(), manifestPath(network));
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`  manifest           ${manifestPath(network)} updated`);
  console.log(`\n  Calls now target   ${newPackageId}`);
  console.log(`  Types still use    ${originalPackage}\n`);
}

function describePolicy(policy: number): string {
  if (policy === 0) return "Compatible — may add modules and functions";
  if (policy === 128) return "Additive — may only add";
  if (policy === 192) return "DepOnly — dependencies only";
  return "unknown";
}

function describeGas(gasUsed: Record<string, unknown>): string {
  const n = (key: string) => Number(gasUsed[key] ?? 0);
  const total = n("computationCost") + n("storageCost") - n("storageRebate");
  return `${sui.formatSui(BigInt(Math.max(total, 0)))} SUI`;
}

function printPlan(input: {
  manifest: DeploymentManifest;
  originalPackage: string;
  currentPackage: string;
  upgradeCapId: string;
  capVersion: number;
  sender: string;
}): void {
  const { manifest, originalPackage, currentPackage, upgradeCapId, capVersion } = input;

  console.log("  CURRENT");
  console.log(`    package                  ${currentPackage}`);
  console.log(`    version                  ${capVersion}`);
  console.log(`    UpgradeCap               ${upgradeCapId}`);
  console.log("");
  console.log("  PROPOSED");
  console.log(`    new package              (assigned on submit)`);
  console.log(`    version                  ${capVersion + 1}`);
  console.log(`    new functionality        escrow, oracle, shipment attestation`);
  console.log("");
  console.log("  EXISTING OBJECTS           PRESERVED (an upgrade alters none)");
  for (const [name, id] of Object.entries(manifest.objects)) {
    console.log(`    ${name.padEnd(24)} ${id}`);
  }
  console.log("");
  console.log(`  Existing A0 proof          PRESERVED`);
  console.log(`  Existing Scenario B proof  PRESERVED`);
  console.log(`    publish digest           ${manifest.publishDigest}`);
  console.log("");
  console.log("  AFTER THE UPGRADE");
  console.log(`    Move CALLS target        the new package id`);
  console.log(`    TYPE arguments keep      ${originalPackage}`);
  console.log(`    settlement coin type     ${manifest.coinType}`);
  console.log("");
  console.log("  NOT DONE BY THIS SCRIPT");
  console.log("    creating the two conditional demo invoices");
  console.log("    issuing the demo shipment OracleCap");
  console.log("    locking, attesting, releasing or refunding any escrow");
  console.log("    (see scripts/seedEscrowDemo.ts, itself dry-run by default)");
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
