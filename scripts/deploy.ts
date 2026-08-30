/**
 * Publishes the payflow Move package and creates the objects the demo needs.
 *
 * Dry run by default. Nothing touches the chain until `--confirm` is passed,
 * and every preflight that CAN run offline runs before anything that cannot.
 *
 * Policy values are NOT written here. They come from lib/demo/policies.ts, the
 * same constants the pipeline already uses, so the repo has exactly one set of
 * literals. After deployment that stops mattering: the chain becomes
 * authoritative and the interface reads the live policy from the treasury.
 *
 *   npx tsx scripts/deploy.ts              # preflight + plan, no transactions
 *   npx tsx scripts/deploy.ts --confirm    # actually publish
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { RECOMMENDATION_TTL_MS } from "../lib/ai/recommendation";
import { AGENT_CAPABILITY, TREASURY_POLICY } from "../lib/demo/policies";
import { centsToUnitsString } from "../lib/sui/units";
import {
  manifestPath,
  structTypes,
  type DeploymentManifest,
  type SuiNetwork,
} from "../lib/sui/deployment";
import * as sui from "./lib/suiCli";

const PACKAGE_PATH = resolve(process.cwd(), "move/payflow");
const EXPECTED_MOVE_TESTS = 34;
/** Publishing plus six setup calls; a little headroom on top. */
const MINIMUM_MIST = BigInt(700_000_000);

const confirmed = process.argv.includes("--confirm");

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

async function main(): Promise<void> {
  heading("1. Toolchain");
  const cliVersion = sui.cliVersion();
  console.log(`  sui CLI            ${cliVersion}`);

  heading("2. Network");
  const network = sui.assertSafeNetwork() as SuiNetwork;
  const publisher = sui.activeAddress();
  console.log(`  network            ${network}`);
  console.log(`  active address     ${publisher}`);
  if (network !== "testnet") {
    console.log(`  NOTE               expected testnet; continuing on ${network}`);
  }

  heading("3. Move package (offline)");
  sui.moveBuild(PACKAGE_PATH);
  console.log("  build              clean");
  const tests = sui.moveTest(PACKAGE_PATH);
  console.log(`  tests              ${tests.passed} passed, ${tests.failed} failed`);
  if (tests.failed > 0) {
    throw new Error(`Refusing to deploy with ${tests.failed} failing Move test(s).`);
  }
  if (tests.passed < EXPECTED_MOVE_TESTS) {
    throw new Error(
      `Expected at least ${EXPECTED_MOVE_TESTS} Move tests, found ${tests.passed}. ` +
        `Tests may have been removed — refusing to deploy.`,
    );
  }

  // Everything above is offline. Everything below needs the network.
  heading("4. Gas");
  const gas = sui.gasReport();
  // Spendable gas is the sum of the coins. The address-level figure is shown
  // for context only — 1.78 reports it as 0 alongside a funded coin, so gating
  // on it would refuse to deploy from a wallet that has money in it.
  console.log(
    `  gas coins          ${gas.coinCount} totalling ${gas.totalMist} MIST (${sui.formatSui(gas.totalMist)} SUI)`,
  );
  if (gas.addressMistBalance !== null && gas.addressMistBalance !== gas.totalMist) {
    console.log(
      `  address balance    ${gas.addressMistBalance} MIST (informational; not used for this check)`,
    );
  }
  console.log(
    `  required           ${MINIMUM_MIST} MIST (${sui.formatSui(MINIMUM_MIST)} SUI)`,
  );
  if (gas.totalMist < MINIMUM_MIST) {
    console.log(
      `  WARNING            below ${sui.formatSui(MINIMUM_MIST)} SUI; fund with the testnet faucet`,
    );
    if (confirmed) {
      throw new Error("Insufficient gas to publish. Fund the active address and retry.");
    }
  } else {
    console.log(`  sufficient         yes`);
  }

  const agentAddress = process.env.PAYFLOW_AGENT_ADDRESS ?? publisher;
  const approverAddress = process.env.PAYFLOW_APPROVER_ADDRESS ?? publisher;

  heading("5. Policy to be written on chain");
  console.log(`  max agent payment  ${money(AGENT_CAPABILITY.maxSinglePaymentCents)}`);
  console.log(`  daily agent limit  ${money(AGENT_CAPABILITY.dailyLimitCents)}`);
  console.log(`  approval threshold ${money(TREASURY_POLICY.humanApprovalThresholdCents)}`);
  console.log(`  minimum reserve    ${money(TREASURY_POLICY.minimumReserveCents)}`);
  console.log(`  currencies         ${TREASURY_POLICY.allowedCurrencies.join(", ")}`);
  console.log(`  recommendation TTL ${RECOMMENDATION_TTL_MS} ms`);
  console.log(`  agent cap holder   ${agentAddress}`);
  console.log(`  approver           ${approverAddress}`);

  if (!confirmed) {
    heading("Dry run — nothing was sent");
    console.log("  Would publish      move/payflow");
    console.log("  Would then call    treasury::create_and_transfer");
    console.log("                     registry::create");
    console.log("                     cashflow::create");
    console.log("                     agent::issue_to");
    console.log("                     approval::issue_approver_to");
    console.log(`\n  Re-run with --confirm to publish to ${network}.\n`);
    return;
  }

  heading("6. Publishing");
  const publishTx = sui.publish(PACKAGE_PATH);
  const packageId = sui.publishedPackageId(publishTx);
  console.log(`  package            ${packageId}`);
  console.log(`  digest             ${publishTx.digest}`);

  const types = structTypes(packageId);
  const coinType = `${packageId}::mock_usdc::MOCK_USDC`;

  // mock_usdc::init runs on publish and produces both of these.
  const mockUsdcTreasuryCapId = sui.requireCreatedObject(
    publishTx,
    "0x2::coin::TreasuryCap",
    "publish",
  );
  const coinMetadataId = sui.requireCreatedObject(
    publishTx,
    "0x2::coin::CoinMetadata",
    "publish",
  );
  console.log(`  MUSDC mint cap     ${mockUsdcTreasuryCapId}`);

  heading("7. Creating treasury");
  const treasuryTx = sui.call({
    packageId,
    module: "treasury",
    function: "create_and_transfer",
    typeArgs: [coinType],
    args: [
      centsToUnitsString(TREASURY_POLICY.minimumReserveCents),
      centsToUnitsString(TREASURY_POLICY.humanApprovalThresholdCents),
      JSON.stringify(TREASURY_POLICY.allowedCurrencies),
      String(RECOMMENDATION_TTL_MS),
    ],
  });
  const treasuryId = sui.requireCreatedObject(treasuryTx, types.treasury, "treasury::create");
  const treasuryOwnerCapId = sui.requireCreatedObject(
    treasuryTx,
    types.treasuryOwnerCap,
    "treasury::create",
  );
  console.log(`  treasury           ${treasuryId}`);
  console.log(`  owner cap          ${treasuryOwnerCapId}`);

  heading("8. Creating registry and calendar");
  const registryTx = sui.call({
    packageId,
    module: "registry",
    function: "create",
    args: [treasuryOwnerCapId],
  });
  const supplierRegistryId = sui.requireCreatedObject(
    registryTx,
    types.supplierRegistry,
    "registry::create",
  );
  console.log(`  registry           ${supplierRegistryId}`);

  const calendarTx = sui.call({
    packageId,
    module: "cashflow",
    function: "create",
    args: [treasuryOwnerCapId],
  });
  const cashFlowCalendarId = sui.requireCreatedObject(
    calendarTx,
    types.cashFlowCalendar,
    "cashflow::create",
  );
  console.log(`  calendar           ${cashFlowCalendarId}`);

  heading("9. Issuing capabilities");
  const agentTx = sui.call({
    packageId,
    module: "agent",
    function: "issue_to",
    typeArgs: [coinType],
    args: [
      treasuryId,
      treasuryOwnerCapId,
      AGENT_CAPABILITY.agentId,
      centsToUnitsString(AGENT_CAPABILITY.maxSinglePaymentCents),
      centsToUnitsString(AGENT_CAPABILITY.dailyLimitCents),
      agentAddress,
    ],
  });
  const agentCapId = sui.requireCreatedObject(agentTx, types.agentCap, "agent::issue_to");
  console.log(`  agent cap          ${agentCapId}`);

  const approverTx = sui.call({
    packageId,
    module: "approval",
    function: "issue_approver_to",
    typeArgs: [coinType],
    args: [
      treasuryId,
      treasuryOwnerCapId,
      centsToUnitsString(25_000_000_00),
      approverAddress,
    ],
  });
  const approverCapId = sui.requireCreatedObject(
    approverTx,
    types.approverCap,
    "approval::issue_approver_to",
  );
  console.log(`  approver cap       ${approverCapId}`);

  heading("10. Writing manifest");
  const manifest: DeploymentManifest = {
    network,
    packageId,
    publishedAt: new Date().toISOString(),
    publisher,
    publishDigest: publishTx.digest,
    coinType,
    cliVersion,
    objects: {
      treasuryId,
      treasuryOwnerCapId,
      supplierRegistryId,
      cashFlowCalendarId,
      agentCapId,
      approverCapId,
      mockUsdcTreasuryCapId,
      coinMetadataId,
    },
    initialPolicy: {
      maxAgentPaymentCents: AGENT_CAPABILITY.maxSinglePaymentCents,
      dailyAgentLimitCents: AGENT_CAPABILITY.dailyLimitCents,
      humanApprovalThresholdCents: TREASURY_POLICY.humanApprovalThresholdCents,
      minimumReserveCents: TREASURY_POLICY.minimumReserveCents,
      allowedCurrencies: [...TREASURY_POLICY.allowedCurrencies],
      maxRecommendationAgeMs: RECOMMENDATION_TTL_MS,
    },
  };

  const target = resolve(process.cwd(), manifestPath(network));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`  manifest           ${manifestPath(network)}`);

  console.log(`\nDeployed. Next: npx tsx scripts/seed.ts --confirm\n`);
}

main().catch((error: unknown) => {
  console.error(`\nDeployment failed:`);
  console.error(sui.describeCliError(error));
  process.exitCode = 1;
});
