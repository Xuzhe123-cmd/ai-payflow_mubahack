/**
 * Dry-runs the Chain-Doi identity and authorization transactions (C–F).
 *
 * DRY RUN ONLY, BY CONSTRUCTION. There is no `--confirm` in this file and no
 * path that submits: every call goes through `sui.dryRunCall`, which the chain
 * evaluates and discards. It exists to produce real gas figures now that v3 is
 * live, without creating a company, a membership or an authorization.
 *
 * WHAT A DRY RUN CANNOT DO HERE. It creates nothing, so the `Company` that C
 * would produce does not exist for D and F to reference. Those two are priced
 * against a placeholder id and will ABORT — that is expected and is itself
 * informative: the abort proves the argument shape reaches Move and that the
 * company binding is enforced. Their real gas is knowable only after C.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { callPackageId, isDeploymentManifest, manifestPath } from "../lib/sui/deployment";
import type { DeploymentManifest, SuiNetwork } from "../lib/sui/deployment";
import * as sui from "./lib/suiCli";

/** The approver. Verified with isValidSuiAddress before it was written here. */
const APPROVER = "0x9840c5c522e7e94bd01ffe0a57da9a10853cadb40574da5a5f058d3913ffa443";
/** Atlas Precision Works, read from the on-chain supplier registry. */
const ATLAS_WALLET = "0x5c8a1f4d7b23e690a4c7f1d85b32e6907a4c1f8d5b23e6907a4c1f8d5b23e690";

const MAX_SINGLE = "25000000000"; // $25,000 at 6 decimals
const DAILY_LIMIT = "50000000000"; // $50,000
const ROLE_TREASURY_MANAGER = "2";
const PERMISSIONS_ALL = "15"; // VIEW_INVOICES|VIEW_TREASURY|APPROVE_PAYMENTS|AUTHORIZE_AGENT
const CLOCK = "0x6";

/**
 * The real Chain-Doi Company, once C has run.
 *
 * Read from the manifest rather than pasted, so a dry run cannot silently
 * price a call against a company that is not the one on chain.
 */
function companyId(m: DeploymentManifest): string {
  const id = m.identity?.companyId;
  if (!id) throw new Error("No company on chain yet — run C first.");
  return id;
}

function companyAdminCapId(m: DeploymentManifest): string {
  const id = m.identity?.companyAdminCapId;
  if (!id) throw new Error("No CompanyAdminCap recorded — run C first.");
  return id;
}

function manifest(network: SuiNetwork): DeploymentManifest {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), manifestPath(network)), "utf8"),
  );
  if (!isDeploymentManifest(parsed)) throw new Error("invalid deployment manifest");
  return parsed;
}

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function report(result: ReturnType<typeof sui.dryRunCall>): void {
  if (!result.ok) {
    console.log(`  status        REFUSED`);
    if (result.abortCode !== null) console.log(`  abort code    ${result.abortCode}`);
    console.log(`  detail        ${result.error.split("\n")[0].slice(0, 160)}`);
    return;
  }
  const gas = result.tx.effects?.gasUsed as
    | { computationCost: string; storageCost: string; storageRebate: string }
    | undefined;
  console.log(`  status        Success`);
  if (gas) {
    const net =
      BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
    console.log(`  computation   ${(Number(gas.computationCost) / 1e9).toFixed(6)} SUI`);
    console.log(`  storage       ${(Number(gas.storageCost) / 1e9).toFixed(6)} SUI`);
    console.log(`  rebate       -${(Number(gas.storageRebate) / 1e9).toFixed(6)} SUI`);
    console.log(`  NET GAS       ${(Number(net) / 1e9).toFixed(6)} SUI`);
  }
}

async function main(): Promise<void> {
  const network = sui.assertSafeNetwork() as SuiNetwork;
  const m = manifest(network);
  const pkg = callPackageId(m);
  const treasury = m.objects.treasuryId;
  const ownerCap = m.objects.treasuryOwnerCapId;
  const nowMs = Date.now();
  const expiry = nowMs + 30 * 86_400_000;

  console.log(`network       ${network}`);
  console.log(`package (v3)  ${pkg}`);
  console.log(`signer        ${sui.activeAddress()}`);
  console.log(`approver      ${APPROVER}`);
  console.log(`expiry        ${new Date(expiry).toISOString()}  (submit time + 30 days)`);

  const company = companyId(m);
  const companyCap = companyAdminCapId(m);
  console.log(`company       ${company}`);
  console.log(`companyCap    ${companyCap}`);

  heading("E  treasury::init_approvers");
  report(
    sui.dryRunCall({
      packageId: pkg,
      module: "treasury",
      function: "init_approvers",
      typeArgs: [m.coinType],
      args: [treasury, ownerCap],
    }),
  );

  heading("D  identity::add_member");
  report(
    sui.dryRunCall({
      packageId: pkg,
      module: "identity",
      function: "add_member",
      args: [
        company,
        companyCap,
        APPROVER,
        ROLE_TREASURY_MANAGER,
        PERMISSIONS_ALL,
        CLOCK,
      ],
    }),
  );

  heading("F  treasury::authorize_approver");
  report(
    sui.dryRunCall({
      packageId: pkg,
      module: "treasury",
      function: "authorize_approver",
      typeArgs: [m.coinType],
      args: [
        treasury,
        ownerCap,
        APPROVER,
        MAX_SINGLE,
        DAILY_LIMIT,
        String(expiry),
        `[${ATLAS_WALLET}]`,
        company,
        String(nowMs),
      ],
    }),
  );

  console.log("\nNothing was submitted. Every call above used --dry-run.");
}

main().catch((error: unknown) => {
  console.error(`\n${sui.describeCliError(error)}\n`);
  process.exit(1);
});
