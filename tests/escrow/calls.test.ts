/**
 * The Move calls the escrow demo would submit.
 *
 * Mostly about package ids, because that is what has actually gone wrong on
 * this project: a seed script looked for a v1 `OracleCap` when the chain had
 * created one at v2, issued a real capability, and lost track of it. The three
 * ids in play here are all different and all correct, so each is pinned.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { attestCall, lockCall, releaseCall, renderPlan } from "../../lib/escrow/calls";
import {
  PROOF_CONFIRMED,
  PROOF_UNCONFIRMED,
  PROOF_DISCLAIMER,
  proofBytes,
  proofFor,
  proofSha256,
} from "../../lib/escrow/proofDocument";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const V2 = "0x14ae68a6e19f0671c7b9d23db312b56bd003b36d77ce279802aaf9cf7d997578";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "deployments/testnet.json"), "utf8"),
) as DeploymentManifest;

const INVOICE_C = "0x927e138efa55e1fa300522191d01ac72a8b8a4c183c37c230a646b1a63c6065a";
const NORTHWIND = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";

function lock() {
  return lockCall({
    manifest,
    invoiceObjectId: INVOICE_C,
    amountCents: 480_000,
    recipient: NORTHWIND,
    recommendationId: "rec_demo_c",
    recommendedAtMs: 1_788_685_200_000,
  });
}

describe("the three package ids stay apart", () => {
  it("sends every call to v2", () => {
    expect(lock().packageId).toBe(V2);
    expect(
      attestCall({
        manifest,
        invoiceNumber: "INV-2026-3501",
        shipmentId: "SHIP-3501",
        confirmed: true,
        proofBlobId: "demo:abc",
        proofSha256: "ab".repeat(32),
        deliveredAtMs: 0,
        validForMs: 86_400_000,
        aiAssessment: null,
      }).packageId,
    ).toBe(V2);
    expect(
      releaseCall({
        manifest,
        escrowObjectId: "0xesc",
        attestationObjectId: "0xatt",
        invoiceObjectId: INVOICE_C,
      }).packageId,
    ).toBe(V2);
  });

  it("keeps the settlement coin type argument on v1", () => {
    // MOCK_USDC was defined by the original publish. The upgraded id would name
    // a type that does not exist.
    expect(lock().typeArguments).toEqual([`${V1}::mock_usdc::MOCK_USDC`]);
    expect(lock().typeArguments[0]).not.toContain(V2);
  });

  it("expects a v2 escrow and a v2 attestation to be created", () => {
    // The exact mistake that broke the seed: these are modules ADDED by the
    // upgrade, so their types carry the upgrade's address.
    expect(lock().createsType).toBe(`${V2}::escrow::PaymentEscrow`);
    expect(
      attestCall({
        manifest,
        invoiceNumber: "INV-2026-3501",
        shipmentId: "SHIP-3501",
        confirmed: true,
        proofBlobId: "demo:abc",
        proofSha256: "ab".repeat(32),
        deliveredAtMs: 0,
        validForMs: 86_400_000,
        aiAssessment: null,
      }).createsType,
    ).toBe(`${V2}::oracle::ShipmentAttestation`);
  });
});

describe("release cannot be pointed anywhere", () => {
  it("takes no recipient argument at all", () => {
    const plan = releaseCall({
      manifest,
      escrowObjectId: "0xesc",
      attestationObjectId: "0xatt",
      invoiceObjectId: INVOICE_C,
    });
    // Treasury, escrow, attestation, invoice, clock. No destination.
    expect(plan.arguments).toEqual([
      manifest.objects.treasuryId,
      "0xesc",
      "0xatt",
      INVOICE_C,
      "0x6",
    ]);
    expect(plan.arguments).not.toContain(NORTHWIND);
    expect(plan.createsType).toBeNull();
  });

  it("locks the recipient at the lock call, and only there", () => {
    expect(lock().arguments).toContain(NORTHWIND);
  });
});

describe("the attestation carries evidence, not authority", () => {
  const plan = attestCall({
    manifest,
    invoiceNumber: "INV-2026-3501",
    shipmentId: "SHIP-3501",
    confirmed: true,
    proofBlobId: "walrus:blob",
    proofSha256: "cd".repeat(32),
    deliveredAtMs: 1_788_000_000_000,
    validForMs: 86_400_000,
    aiAssessment: "ADVISORY (deterministic): document names INV-2026-3501",
  });

  it("names no treasury, escrow, recipient or amount", () => {
    // The oracle's whole call surface. It cannot reach money from here.
    expect(plan.arguments).not.toContain(manifest.objects.treasuryId);
    expect(plan.arguments).not.toContain(NORTHWIND);
    expect(plan.arguments.join(" ")).not.toContain("4800");
  });

  it("uses the OracleCap the seed created", () => {
    expect(plan.arguments[0]).toBe(manifest.escrowDemo?.oracleCapId);
  });

  it("carries the proof hash and blob reference", () => {
    expect(plan.arguments).toContain(`0x${"cd".repeat(32)}`);
    expect(plan.arguments).toContain("walrus:blob");
  });

  it("passes the AI assessment through as an Option the CLI accepts", () => {
    // `Option<String>` wants ["value"] for Some and [] for None. A bare string
    // is rejected with CommandArgumentError{InvalidBCSBytes}, which names the
    // argument index and nothing about why — verified by dry run against v2.
    const encoded = plan.arguments[8];
    expect(encoded.startsWith("[")).toBe(true);
    expect(JSON.parse(encoded)).toEqual([
      "ADVISORY (deterministic): document names INV-2026-3501",
    ]);
  });

  it("encodes an absent assessment as None", () => {
    const withoutAi = attestCall({
      manifest,
      invoiceNumber: "INV-2026-3501",
      shipmentId: "SHIP-3501",
      confirmed: true,
      proofBlobId: "demo:abc",
      proofSha256: "ab".repeat(32),
      deliveredAtMs: 0,
      validForMs: 86_400_000,
      aiAssessment: null,
    });
    expect(withoutAi.arguments[8]).toBe("[]");
  });

  it("can state a negative outcome too", () => {
    const declined = attestCall({
      manifest,
      invoiceNumber: "INV-2026-3502",
      shipmentId: "SHIP-3502",
      confirmed: false,
      proofBlobId: "demo:x",
      proofSha256: "00".repeat(32),
      deliveredAtMs: 0,
      validForMs: 86_400_000,
      aiAssessment: null,
    });
    expect(declined.arguments).toContain("false");
    expect(declined.label).toMatch(/NOT CONFIRMED/);
  });
});

describe("the demo proof documents", () => {
  it("hashes the actual bytes, so editing the note changes the digest", () => {
    const digest = proofSha256(PROOF_CONFIRMED);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const edited = { ...PROOF_CONFIRMED, text: `${PROOF_CONFIRMED.text} ` };
    expect(proofSha256(edited)).not.toBe(digest);
  });

  it("produces different digests for the two demos", () => {
    expect(proofSha256(PROOF_CONFIRMED)).not.toBe(proofSha256(PROOF_UNCONFIRMED));
  });

  it("says DELIVERED for Demo A and does not for Demo B", () => {
    expect(PROOF_CONFIRMED.document.deliveryStatus).toBe("DELIVERED");
    expect(PROOF_CONFIRMED.document.deliveredAt).toBe("2026-09-01");
    expect(PROOF_UNCONFIRMED.document.deliveryStatus).toBe("IN_TRANSIT");
    expect(PROOF_UNCONFIRMED.document.deliveredAt).toBeNull();
  });

  it("carries every field the proof card shows", () => {
    for (const proof of [PROOF_CONFIRMED, PROOF_UNCONFIRMED]) {
      expect(proof.document.invoiceNumber).toMatch(/^INV-/);
      expect(proof.document.shipmentId).toMatch(/^SHIP-/);
      expect(proof.document.recipient).toMatch(/^0x[0-9a-f]{64}$/);
      expect(proof.document.carrier).toBeTruthy();
      expect(proofBytes(proof).byteLength).toBeGreaterThan(100);
    }
  });

  it("names the invoice it belongs to, and is findable by it", () => {
    expect(proofFor("INV-2026-3501")).toBe(PROOF_CONFIRMED);
    expect(proofFor("INV-2026-3502")).toBe(PROOF_UNCONFIRMED);
    expect(proofFor("INV-2026-3455")).toBeNull();
  });

  it("never claims to come from a real carrier", () => {
    expect(PROOF_DISCLAIMER).toBe("Demo evidence — not a carrier API integration");
    for (const proof of [PROOF_CONFIRMED, PROOF_UNCONFIRMED]) {
      for (const forbidden of [/\bDHL\b/i, /fedex/i, /\bUPS\b/, /maersk/i, /\bDPD\b/i]) {
        expect(proof.text, proof.filename).not.toMatch(forbidden);
      }
      // And says so in the document itself, not only in the chrome around it.
      expect(proof.text).toMatch(/not issued by a carrier/i);
    }
  });
});

describe("rendered commands are inspectable", () => {
  it("renders a lock as a runnable call", () => {
    const rendered = renderPlan(lock());
    expect(rendered).toContain(`--package ${V2}`);
    expect(rendered).toContain("--module escrow");
    expect(rendered).toContain("--function execute_conditional");
    expect(rendered).toContain(`--type-args ${V1}::mock_usdc::MOCK_USDC`);
  });
});
