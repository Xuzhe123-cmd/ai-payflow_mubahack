/**
 * The deployment manifest must survive an upgrade without losing its history.
 *
 * An upgrade publishes a new package id, and the tempting thing to do is
 * overwrite `packageId` with it. That would be wrong twice over: every existing
 * object's type still resolves to the original address, and the A0 and
 * Scenario B transactions are evidence tied to it. So the new id is recorded
 * alongside, and these tests pin the distinction that makes both usable.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  callPackageId,
  isDeploymentManifest,
  structTypes,
  targets,
  typePackageId,
  type DeploymentManifest,
} from "../../lib/sui/deployment";

const ORIGINAL = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
/** The real v2 package, published by the escrow upgrade. */
const UPGRADED = "0x14ae68a6e19f0671c7b9d23db312b56bd003b36d77ce279802aaf9cf7d997578";

const live = JSON.parse(
  readFileSync(resolve(process.cwd(), "deployments/testnet.json"), "utf8"),
) as DeploymentManifest;

/** The live manifest is already upgraded, so this is simply it. */
function upgraded(): DeploymentManifest {
  return live;
}

/** The manifest as it stood before the escrow upgrade. */
function preUpgrade(): DeploymentManifest {
  const { upgrade: _upgrade, ...rest } = live;
  return rest as DeploymentManifest;
}

describe("the deployed manifest is intact", () => {
  it("is a valid manifest and still records the original deployment", () => {
    expect(isDeploymentManifest(live)).toBe(true);
    expect(live.packageId).toBe(ORIGINAL);
    expect(live.network).toBe("testnet");
    // The evidence the demo rests on.
    expect(live.publishDigest).toBe("3tDrm1eGr6vMVkqEu1h35338i24ELra7bx9pn5HphGTd");
    expect(live.coinType).toBe(`${ORIGINAL}::mock_usdc::MOCK_USDC`);
  });

  it("still lists every seeded object and invoice", () => {
    expect(Object.keys(live.objects)).toHaveLength(8);
    expect(live.seed?.invoices).toHaveLength(8);
    // The A0 invoice — the one the $3,000 payment settled.
    expect(live.seed?.invoices.map((entry) => entry.invoiceNumber)).toContain("INV-2026-3455");
    // The Scenario B invoice — the one the $8,000 attempt aborted on.
    expect(live.seed?.invoices.map((entry) => entry.invoiceNumber)).toContain("INV-2026-3492");
  });

  it("records the UpgradeCap that governs the package", () => {
    expect(live.upgradeCapId).toBe(
      "0x29976b1acd8bb91968ed2708cd99c4fb0e011d7defc1ee2a19a7b77218c5acda",
    );
  });

  it("records the escrow upgrade to v2", () => {
    expect(live.upgrade?.packageId).toBe(UPGRADED);
    expect(live.upgrade?.previousPackageId).toBe(ORIGINAL);
    expect(live.upgrade?.version).toBe(2);
    expect(live.upgrade?.addedModules).toEqual(["escrow", "oracle"]);
  });

  it("records the seeded escrow demo objects", () => {
    expect(live.escrowDemo?.oracleCapId).toBe(
      "0x834f4da6d286873d078311b830c50f99b7ec688b48a8824634de28d5df78168e",
    );
    expect(live.escrowDemo?.invoices.map((entry) => entry.invoiceNumber)).toEqual([
      "INV-2026-3501",
      "INV-2026-3502",
    ]);
    expect(live.escrowDemo?.invoices.map((entry) => entry.amountCents)).toEqual([
      480_000, 400_000,
    ]);
  });

  it("has locked no escrow and made no attestation", () => {
    // Phase 2C builds the interface; it runs nothing on chain. If these start
    // failing, a real conditional payment has been executed.
    expect(live.escrowDemo?.escrowIds).toEqual([]);
    expect(live.escrowDemo?.attestationIds).toEqual([]);
  });

  it("knows which package defined the upgraded modules", () => {
    // Without this, the seed looks for the wrong OracleCap type — which is
    // exactly how the partial run failed.
    expect(live.moduleOrigins?.oracle).toBe(UPGRADED);
    expect(live.moduleOrigins?.escrow).toBe(UPGRADED);
  });

  it("records the real A0 settlement as evidence", () => {
    // INV-2026-3455 can never be paid again, so A0 is verified from this rather
    // than re-attempted. See scripts/lib/a0Proof.ts.
    expect(live.proofs?.a0?.digest).toBe("DwegxdkzVmtTnehTXy44noRBv6vDtSJRaYhAH5i8oH2G");
    expect(live.proofs?.a0?.invoiceNumber).toBe("INV-2026-3455");
    expect(live.proofs?.a0?.amountCents).toBe(300_000);
    // Executed before the upgrade, and correctly recorded against v1.
    expect(live.proofs?.a0?.packageId).toBe(ORIGINAL);
    expect(live.proofs?.a0?.authority).toBe(0);
  });
});

describe("after an upgrade the two package ids mean different things", () => {
  it("sends calls to the new package and types to the original", () => {
    const manifest = upgraded();
    expect(callPackageId(manifest)).toBe(UPGRADED);
    expect(typePackageId(manifest)).toBe(ORIGINAL);
  });

  it("falls back to the original before any upgrade", () => {
    const before = preUpgrade();
    expect(callPackageId(before)).toBe(ORIGINAL);
    expect(typePackageId(before)).toBe(ORIGINAL);
  });

  it("keeps the original id on every existing object and on the coin", () => {
    const manifest = upgraded();
    // The upgrade added a package version; it moved nothing.
    expect(manifest.packageId).toBe(ORIGINAL);
    expect(manifest.coinType.startsWith(ORIGINAL)).toBe(true);
    expect(manifest.publishDigest).toBe("3tDrm1eGr6vMVkqEu1h35338i24ELra7bx9pn5HphGTd");
    // Still the eight objects and eight invoices the first deployment created.
    expect(Object.keys(manifest.objects)).toHaveLength(8);
    expect(manifest.seed?.invoices).toHaveLength(8);
  });

  it("resolves struct types against the original package", () => {
    // An Invoice shared by the first publish is still that type afterwards, so
    // filtering objectChanges by an upgraded id would find nothing.
    const types = structTypes(typePackageId(upgraded()));
    expect(types.invoice).toBe(`${ORIGINAL}::invoice::Invoice`);
    expect(types.treasury).toBe(`${ORIGINAL}::treasury::Treasury`);
    // Escrow objects do not exist yet, but their type will anchor here too,
    // because the upgraded code is still the same package.
    expect(types.paymentEscrow).toBe(`${ORIGINAL}::escrow::PaymentEscrow`);
    expect(types.shipmentAttestation).toBe(`${ORIGINAL}::oracle::ShipmentAttestation`);
  });

  it("resolves call targets against the upgraded package", () => {
    const t = targets(callPackageId(upgraded()));
    // The new modules exist only on the new version.
    expect(t.executeConditional).toBe(`${UPGRADED}::escrow::execute_conditional`);
    expect(t.escrowRelease).toBe(`${UPGRADED}::escrow::release`);
    expect(t.oracleAttest).toBe(`${UPGRADED}::oracle::attest`);
    expect(t.requireShipment).toBe(`${UPGRADED}::invoice::require_shipment_confirmation`);
    // And the pre-existing entry points are reached there too.
    expect(t.executePayment).toBe(`${UPGRADED}::payment::execute_payment`);
  });

  it("records what the upgrade replaced, so the history is followable", () => {
    const manifest = upgraded();
    expect(manifest.upgrade?.previousPackageId).toBe(ORIGINAL);
    expect(manifest.upgrade?.version).toBe(2);
    expect(manifest.upgrade?.addedModules).toEqual(["escrow", "oracle"]);
  });
});
