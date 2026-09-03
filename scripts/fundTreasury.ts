/**
 * Tops the demo treasury's MOCK_USDC vault up to an exact figure.
 *
 * WHY A SCRIPT AND NOT A NUMBER SOMEWHERE. The vault balance the interface
 * shows is read from the `Treasury` object on chain. There is deliberately no
 * display constant to edit and no local override — a demo whose headline figure
 * can be typed into the frontend is one whose every other figure is suspect
 * too. So restoring it means actually funding it.
 *
 * THE PATH IS THE PROJECT'S OWN, not a new one. Exactly what `seed.ts` does
 * when it first fills the vault:
 *
 *   mock_usdc::mint      mints MOCK_USDC to the signer, under the TreasuryCap
 *                        the publisher holds. Testnet demo coin, six decimals,
 *                        no value.
 *   treasury::deposit    joins that Coin into the vault. Permissionless by
 *                        design — "anyone may add funds; only the owner may
 *                        remove them" — so it needs no capability and grants
 *                        none.
 *
 * WHAT IT CANNOT TOUCH. `deposit` takes a `Treasury` and a `Coin` and does one
 * thing: `balance::join`. It cannot settle an invoice, mint an approval, move
 * an AgentCap, change a limit, trip or reset the breaker, or alter escrow
 * state. Withdrawal is a different function behind the owner capability, and
 * this script never calls it.
 *
 * IT WILL NOT OVERSHOOT OR REVERSE. A vault already at or above the target is
 * left alone and reported, because taking funds back out is a withdrawal and a
 * different decision than a top-up.
 *
 * Dry runs by default. Pass --submit to send.
 */

import { readTreasury } from "../lib/sui/chainReader";
import { createSuiQueries } from "../lib/sui/client";
import { configuredNetwork, loadManifest } from "../lib/sui/manifest";
import { callPackageId } from "../lib/sui/deployment";
import { centsToUnitsString } from "../lib/sui/units";
import {
  AUTO_GAS_BUDGET,
  activeAddress,
  call,
  dryRunCall,
  renderCall,
  requireCreatedObject,
  type CallOptions,
} from "./lib/suiCli";

/** Dollars, as cents. The demo's headline vault figure. */
const TARGET_CENTS = 100_000 * 100;

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

async function main() {
  const submit = process.argv.includes("--submit");
  const network = configuredNetwork();
  const manifest = loadManifest(network);
  const packageId = callPackageId(manifest);
  const sender = activeAddress();
  const treasuryId = manifest.objects.treasuryId;
  const coinType = manifest.coinType;

  // ---- 1. what the chain actually holds -----------------------------------
  const treasury = await readTreasury(createSuiQueries(network), manifest);
  const currentCents = treasury.balanceCents;

  console.log("network    :", network);
  console.log("package    :", packageId);
  console.log("treasury   :", treasuryId);
  console.log("coin type  :", coinType);
  console.log("signer     :", sender);
  console.log("mint cap   :", manifest.objects.mockUsdcTreasuryCapId);
  console.log();
  console.log("vault now  :", money(currentCents));
  console.log("target     :", money(TARGET_CENTS));

  if (currentCents === TARGET_CENTS) {
    console.log("\nAlready exactly at the target. No transaction is needed.");
    return;
  }
  if (currentCents > TARGET_CENTS) {
    // Refused rather than "corrected": removing funds is a withdrawal, it needs
    // the owner capability, and it is not what a top-up was asked for.
    console.log(
      `\nVault is ABOVE the target by ${money(currentCents - TARGET_CENTS)}. ` +
        "Reducing it would be a withdrawal, not a top-up. Nothing was submitted.",
    );
    return;
  }

  const topUpCents = TARGET_CENTS - currentCents;
  const topUpUnits = centsToUnitsString(topUpCents);
  console.log("top-up     :", money(topUpCents), `(${topUpUnits} base units)`);
  console.log();

  // ---- 2. mint exactly the shortfall ---------------------------------------
  const mint: CallOptions = {
    packageId,
    module: "mock_usdc",
    function: "mint",
    args: [manifest.objects.mockUsdcTreasuryCapId, topUpUnits, sender],
    gasBudget: AUTO_GAS_BUDGET,
  };

  console.log("--- 1/2 mock_usdc::mint ---");
  console.log(renderCall(mint));
  const mintPreview = dryRunCall(mint);
  if (!mintPreview.ok) {
    console.log("  dry run FAILED:", String(mintPreview.error).slice(0, 400));
    return;
  }
  console.log("  dry run: success");

  if (!submit) {
    console.log("\n--- 2/2 treasury::deposit ---");
    console.log(
      "  Cannot be dry-run until the coin exists: `deposit` takes the Coin object\n" +
        "  the mint creates, and that object id is only known once the mint has\n" +
        "  landed. It is dry-run for real, against the real coin, before it is\n" +
        "  submitted below.",
    );
    console.log("\nDry run only. Pass --submit to send both transactions.");
    return;
  }

  const mintTx = call(mint);
  const coinId = requireCreatedObject(mintTx, "0x2::coin::Coin", "mock_usdc::mint");
  console.log("  SUBMITTED digest:", mintTx.digest);
  console.log("  minted coin     :", coinId);
  console.log();

  // ---- 3. deposit it into the vault ----------------------------------------
  const deposit: CallOptions = {
    packageId,
    module: "treasury",
    function: "deposit",
    typeArgs: [coinType],
    args: [treasuryId, coinId],
    gasBudget: AUTO_GAS_BUDGET,
  };

  console.log("--- 2/2 treasury::deposit ---");
  console.log(renderCall(deposit));
  const depositPreview = dryRunCall(deposit);
  if (!depositPreview.ok) {
    console.log("  dry run FAILED:", String(depositPreview.error).slice(0, 400));
    console.log(
      `  The minted coin ${coinId} is held by ${sender} and can be deposited once ` +
        "the reason is resolved. Nothing was lost.",
    );
    return;
  }
  console.log("  dry run: success");
  const depositTx = call(deposit);
  console.log("  SUBMITTED digest:", depositTx.digest);
  console.log();

  // ---- 4. the chain's word, not the transaction's --------------------------
  //
  // POLLED, BECAUSE THE READ PATH LAGS THE WRITE PATH. `readTreasury` goes
  // through the GraphQL indexer, which trails the fullnode by a few seconds.
  // Reading once immediately after a confirmed deposit returns the PREVIOUS
  // balance and reports a successful top-up as a failure — a verification step
  // that cries wolf is worse than none, because the next person ignores it.
  const after = await settledBalance(network, manifest, TARGET_CENTS);
  console.log("vault after:", money(after));
  console.log(
    after === TARGET_CENTS
      ? "MATCHES THE TARGET EXACTLY, read back from the Treasury object."
      : `DOES NOT match the target. Off by ${money(TARGET_CENTS - after)}.`,
  );
}

/**
 * Re-reads the vault until the indexer catches up, then reports what it says.
 *
 * Returns the LAST reading either way rather than throwing: the transaction is
 * already on chain and checkpointed by this point, so a read that has not
 * caught up is a fact about the indexer, not about the deposit.
 */
async function settledBalance(
  network: ReturnType<typeof configuredNetwork>,
  manifest: Parameters<typeof readTreasury>[1],
  target: number,
): Promise<number> {
  let balance = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    balance = (await readTreasury(createSuiQueries(network), manifest)).balanceCents;
    if (balance === target) return balance;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return balance;
}

void main();
