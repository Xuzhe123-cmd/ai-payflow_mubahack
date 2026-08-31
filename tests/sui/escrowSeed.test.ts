/**
 * The escrow seed must be safe to re-run.
 *
 * This suite exists because of a real incident. The seed issued an OracleCap on
 * testnet, then failed to recognise the object it had just created — it looked
 * for the v1 `oracle::OracleCap` type while the chain reported v2 — and exited
 * without recording anything. A capability existed that the manifest did not
 * know about, and a naive re-run would have issued a second one.
 *
 * Two lessons, both tested here. Types must be resolved against the package
 * version that DEFINED the module, and existence must be established from chain
 * state rather than from the manifest, so a lost record cannot become a
 * duplicate object.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  callPackageId,
  modulePackageId,
  structTypes,
  structTypesFor,
  typePackageId,
  type DeploymentManifest,
} from "../../lib/sui/deployment";
import {
  decideInvoices,
  decideOracleCap,
  seedIsComplete,
  type ExistingOracleCap,
  type OracleCapExpectation,
} from "../../scripts/lib/escrowSeedPlan";

const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
/**
 * The package that DEFINED escrow and oracle.
 *
 * v2, and permanently so: a type is anchored to the version that introduced
 * its module, and later upgrades do not move it. Distinct from CALLS, which
 * always target the newest package.
 */
const V2_ORIGIN = "0x14ae68a6e19f0671c7b9d23db312b56bd003b36d77ce279802aaf9cf7d997578";
/** The current live package, for CALLS. Bumped by each upgrade. */
const V4_CALLS = "0x6d237a995924ad0529c0933a2d0eeca58fb2f3bebaa79bee46605960edbf21ed";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const OWNER = "0xa09bfa3a1f78f168c2970cff756592b7376be0ac947d845aedc4c0781d270609";
/** The capability the partial run really created. */
const REAL_CAP = "0x834f4da6d286873d078311b830c50f99b7ec688b48a8824634de28d5df78168e";

const live = JSON.parse(
  readFileSync(resolve(process.cwd(), "deployments/testnet.json"), "utf8"),
) as DeploymentManifest;

const expectation: OracleCapExpectation = {
  expectedType: `${V2_ORIGIN}::oracle::OracleCap`,
  expectedTreasuryId: TREASURY,
  expectedOwner: OWNER,
  expectedOracleId: "demo_shipment_oracle",
};

function existing(overrides: Partial<ExistingOracleCap> = {}): ExistingOracleCap {
  return {
    objectId: REAL_CAP,
    objectType: `${V2_ORIGIN}::oracle::OracleCap`,
    owner: OWNER,
    treasuryId: TREASURY,
    oracleId: "demo_shipment_oracle",
    ...overrides,
  };
}

describe("types resolve to the package that defined the module", () => {
  it("puts OracleCap on v2 — the version that introduced the oracle module", () => {
    // The exact failure: the seed asked for the v1 type and the chain had made
    // a v2 object, so `requireCreatedObject` found nothing.
    const types = structTypesFor(live);
    expect(types.oracleCap).toBe(`${V2_ORIGIN}::oracle::OracleCap`);
    expect(types.shipmentAttestation).toBe(`${V2_ORIGIN}::oracle::ShipmentAttestation`);
    expect(types.paymentEscrow).toBe(`${V2_ORIGIN}::escrow::PaymentEscrow`);
  });

  it("leaves types from the original publish on v1", () => {
    const types = structTypesFor(live);
    expect(types.invoice).toBe(`${V1}::invoice::Invoice`);
    expect(types.treasury).toBe(`${V1}::treasury::Treasury`);
    expect(types.agentCap).toBe(`${V1}::agent::AgentCap`);
    expect(types.paymentRecord).toBe(`${V1}::payment::PaymentRecord`);
  });

  it("matches what testnet actually reports", () => {
    // Verified by reading the live objects: AgentCap kept v1 while the newly
    // added OracleCap is at v2. The two live at different packages, and that is
    // correct rather than a mistake to normalise away.
    expect(modulePackageId(live, "oracle")).toBe(V2_ORIGIN);
    expect(modulePackageId(live, "escrow")).toBe(V2_ORIGIN);
    expect(modulePackageId(live, "agent")).toBe(V1);
    expect(modulePackageId(live, "invoice")).toBe(V1);
    // A module nobody recorded belongs to the original publish.
    expect(modulePackageId(live, "treasury")).toBe(V1);
  });

  it("keeps the settlement coin type argument on v1", () => {
    // MOCK_USDC was defined by the first publish. Passing the upgraded id here
    // would name a type that does not exist.
    expect(live.coinType).toBe(`${V1}::mock_usdc::MOCK_USDC`);
    expect(typePackageId(live)).toBe(V1);
  });

  it("sends calls to v2", () => {
    expect(callPackageId(live)).toBe(V4_CALLS);
  });

  it("still agrees with the single-package helper before any upgrade", () => {
    // structTypes() is only correct when one version defined everything, which
    // is why structTypesFor exists. It must still behave for a fresh deploy.
    const fresh = structTypes(V1);
    expect(fresh.oracleCap).toBe(`${V1}::oracle::OracleCap`);
    const { upgrade: _u, moduleOrigins: _m, ...preUpgrade } = live;
    expect(structTypesFor(preUpgrade as DeploymentManifest).oracleCap).toBe(
      `${V1}::oracle::OracleCap`,
    );
  });
});

describe("an existing OracleCap is reused, never duplicated", () => {
  it("reuses the capability the partial run created", () => {
    expect(decideOracleCap(existing(), expectation)).toEqual({
      kind: "REUSE",
      objectId: REAL_CAP,
    });
  });

  it("issues one only when none exists", () => {
    expect(decideOracleCap(null, expectation)).toEqual({ kind: "ISSUE" });
  });

  it("refuses rather than issuing a second when the type is wrong", () => {
    // The v1 type is exactly what the broken seed searched for.
    const verdict = decideOracleCap(
      existing({ objectType: `${V1}::oracle::OracleCap` }),
      expectation,
    );
    expect(verdict.kind).toBe("CONFLICT");
  });

  it("refuses a capability bound to a different treasury", () => {
    const verdict = decideOracleCap(existing({ treasuryId: `0x${"9".repeat(64)}` }), expectation);
    expect(verdict.kind).toBe("CONFLICT");
    expect(verdict.kind === "CONFLICT" && verdict.reason).toMatch(/bound to treasury/);
  });

  it("refuses a capability owned by someone else", () => {
    const verdict = decideOracleCap(existing({ owner: `0x${"7".repeat(64)}` }), expectation);
    expect(verdict.kind).toBe("CONFLICT");
    expect(verdict.kind === "CONFLICT" && verdict.reason).toMatch(/owned by/);
  });

  it("refuses a capability with a different oracle_id", () => {
    const verdict = decideOracleCap(existing({ oracleId: "some_other_oracle" }), expectation);
    expect(verdict.kind).toBe("CONFLICT");
  });

  it("never answers ISSUE when something is already there", () => {
    // The property that matters: a mismatch must stop the run, not route around
    // it. Two capabilities for one treasury is worse than none.
    const mismatches: Partial<ExistingOracleCap>[] = [
      { objectType: `${V1}::oracle::OracleCap` },
      { treasuryId: `0x${"9".repeat(64)}` },
      { owner: `0x${"7".repeat(64)}` },
      { oracleId: "other" },
    ];
    for (const overrides of mismatches) {
      expect(decideOracleCap(existing(overrides), expectation).kind).not.toBe("ISSUE");
    }
  });
});

describe("invoices are never created twice", () => {
  const planned = [
    { invoiceNumber: "INV-2026-3501", amountCents: 480_000 },
    { invoiceNumber: "INV-2026-3502", amountCents: 400_000 },
  ];

  it("creates both when the chain has neither", () => {
    // The eight original invoices are on chain; neither conditional one is.
    const onChain = (live.seed?.invoices ?? []).map((entry) => ({
      invoiceNumber: entry.invoiceNumber,
      objectId: entry.objectId,
    }));
    const decisions = decideInvoices(planned, onChain);
    expect(decisions.map((d) => d.create)).toEqual([true, true]);
  });

  it("creates neither now that both are seeded", () => {
    // The state a re-run would find today: nothing left to do.
    const onChain = (live.escrowDemo?.invoices ?? []).map((entry) => ({
      invoiceNumber: entry.invoiceNumber,
      objectId: entry.objectId,
    }));
    const decisions = decideInvoices(planned, onChain);
    expect(decisions.map((d) => d.create)).toEqual([false, false]);
    expect(seedIsComplete(decideOracleCap(existing(), expectation), decisions)).toBe(true);
  });

  it("skips one that already exists and creates the other", () => {
    const decisions = decideInvoices(planned, [
      { invoiceNumber: "INV-2026-3501", objectId: "0xaaa" },
    ]);
    expect(decisions[0]).toEqual({
      invoiceNumber: "INV-2026-3501",
      create: false,
      existingObjectId: "0xaaa",
    });
    expect(decisions[1].create).toBe(true);
  });

  it("skips both when the chain already has them", () => {
    const decisions = decideInvoices(planned, [
      { invoiceNumber: "INV-2026-3501", objectId: "0xaaa" },
      { invoiceNumber: "INV-2026-3502", objectId: "0xbbb" },
    ]);
    expect(decisions.every((d) => !d.create)).toBe(true);
  });

  it("keys on the invoice NUMBER, which is what the chain enforces on", () => {
    // Two objects carrying one number is the duplicate that matters — check 8
    // and the replay ledger key on the number, not the object id.
    const decisions = decideInvoices(planned, [
      { invoiceNumber: "INV-2026-3501", objectId: "0xdifferent-object-entirely" },
    ]);
    expect(decisions[0].create).toBe(false);
  });
});

describe("resuming the partial run", () => {
  it("has exactly one step left: the two invoices", () => {
    // The real state right now: the OracleCap exists, no invoices do.
    const oracle = decideOracleCap(existing(), expectation);
    const invoices = decideInvoices(
      [
        { invoiceNumber: "INV-2026-3501", amountCents: 480_000 },
        { invoiceNumber: "INV-2026-3502", amountCents: 400_000 },
      ],
      [],
    );
    expect(oracle.kind).toBe("REUSE");
    expect(invoices.every((d) => d.create)).toBe(true);
    expect(seedIsComplete(oracle, invoices)).toBe(false);
  });

  it("reports completion once everything exists", () => {
    const oracle = decideOracleCap(existing(), expectation);
    const invoices = decideInvoices(
      [{ invoiceNumber: "INV-2026-3501", amountCents: 480_000 }],
      [{ invoiceNumber: "INV-2026-3501", objectId: "0xaaa" }],
    );
    expect(seedIsComplete(oracle, invoices)).toBe(true);
  });

  it("is not complete while the capability is still missing", () => {
    expect(seedIsComplete({ kind: "ISSUE" }, [])).toBe(false);
  });

  it("records the capability the partial run left behind", () => {
    // The manifest knows about the object that was created but unrecorded,
    // which is what stopped the resumed run from duplicating it.
    expect(live.escrowDemo?.oracleCapId).toBe(REAL_CAP);
    expect(live.escrowDemo?.oracleId).toBe("demo_shipment_oracle");
  });

  it("recorded both invoices once the resumed run created them", () => {
    const numbers = live.escrowDemo?.invoices.map((entry) => entry.invoiceNumber) ?? [];
    expect(numbers).toEqual(["INV-2026-3501", "INV-2026-3502"]);
    // Exactly one entry each — the resume must not have double-recorded.
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
