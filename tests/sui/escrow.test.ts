/**
 * The off-chain half of conditional settlement.
 *
 * Two things are worth testing here that the Move suite cannot reach: that the
 * TypeScript view of a condition agrees with what `escrow::release` will
 * actually do, and — structurally, by reading the Move source — that no
 * advisory field is anywhere near the function that moves money.
 *
 * The second is the kind of property a runtime test cannot establish. A Move
 * test can show that a particular glowing assessment failed to release a
 * particular escrow; only reading the source can show there is no path at all.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assessProof,
  attestationNote,
  supportsConfirmation,
  type ProofAssessment,
} from "../../lib/ai/proofAssessment";
import {
  buildShipmentCondition,
  describeShipment,
  isReleasable,
  noShipmentCondition,
  SHIPMENT_ORACLE_LABEL,
  type ShipmentAttestation,
  type ShipmentProofDocument,
} from "../../lib/oracle/shipment";
import {
  createLocalProofStore,
  proofMatches,
  selectProofStore,
  sha256Hex,
} from "../../lib/oracle/proofStore";
import { escrowStatusFrom } from "../../lib/sui/escrowReader";

const INVOICE = "INV-2026-3501";
const WALLET = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const NOW_MS = 1_800_000_000_000;

function document(overrides: Partial<ShipmentProofDocument> = {}): ShipmentProofDocument {
  return {
    invoiceNumber: INVOICE,
    shipmentId: "SHIP-88431",
    recipient: WALLET,
    deliveryStatus: "DELIVERED",
    deliveredAt: "2026-09-05",
    carrier: "Demo Freight",
    ...overrides,
  };
}

function attestation(overrides: Partial<ShipmentAttestation> = {}): ShipmentAttestation {
  return {
    attestationId: "0xatt",
    invoiceNumber: INVOICE,
    shipmentId: "SHIP-88431",
    confirmed: true,
    proofBlobId: "demo:abc",
    proofSha256: "ab".repeat(32),
    deliveredAtMs: NOW_MS,
    oracleId: "demo_shipment_oracle",
    attestedBy: "0xoracle",
    attestedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 86_400_000,
    aiAssessment: null,
    ...overrides,
  };
}

function locked(att: ShipmentAttestation | null) {
  return buildShipmentCondition({
    invoiceNumber: INVOICE,
    amountCents: 400_000,
    required: true,
    escrow: "LOCKED",
    attestation: att,
    proof: null,
  });
}

describe("a shipment condition is not a rejection", () => {
  it("holds an unconfirmed invoice rather than refusing it", () => {
    const condition = locked(null);
    expect(condition.state).toBe("NOT_CONFIRMED");
    expect(condition.escrow).toBe("LOCKED");
    expect(describeShipment(condition)).toMatch(/waiting for shipment confirmation/i);
    // The money is committed, not refused — the vocabulary must not drift into
    // rejection, which is what blockingConditions() means.
    expect(describeShipment(condition)).not.toMatch(/reject/i);
  });

  it("leaves an invoice with no condition entirely alone", () => {
    const condition = noShipmentCondition("INV-2026-3468", 480_000);
    expect(condition.required).toBe(false);
    expect(condition.state).toBe("NOT_REQUIRED");
    expect(condition.escrow).toBe("NONE");
    expect(isReleasable(condition, NOW_MS)).toBe(false);
  });

  it("labels the oracle honestly wherever it appears", () => {
    expect(SHIPMENT_ORACLE_LABEL).toBe("Demo Shipment Oracle");
    const condition = locked(null);
    expect(condition.sourceLabel).toBe(SHIPMENT_ORACLE_LABEL);
    expect(condition.sourceDetail).toMatch(/not a carrier integration/i);
    for (const forbidden of [/\bDHL\b/i, /fedex/i, /\bUPS\b/, /maersk/i]) {
      expect(condition.sourceDetail).not.toMatch(forbidden);
      expect(SHIPMENT_ORACLE_LABEL).not.toMatch(forbidden);
    }
  });
});

describe("releasability agrees with what the chain will do", () => {
  it("releases only on a confirmed, unexpired, matching attestation", () => {
    expect(isReleasable(locked(attestation()), NOW_MS)).toBe(true);
  });

  it("refuses an unconfirmed attestation", () => {
    expect(isReleasable(locked(attestation({ confirmed: false })), NOW_MS)).toBe(false);
  });

  it("refuses an attestation for another invoice", () => {
    // buildShipmentCondition drops a mismatched attestation outright, which is
    // the same answer escrow::release reaches by aborting.
    const condition = locked(attestation({ invoiceNumber: "INV-2026-9999" }));
    expect(condition.attestation).toBeNull();
    expect(isReleasable(condition, NOW_MS)).toBe(false);
  });

  it("refuses an expired attestation", () => {
    const condition = locked(attestation({ expiresAtMs: NOW_MS - 1 }));
    expect(isReleasable(condition, NOW_MS)).toBe(false);
  });

  it("refuses once the escrow is no longer locked", () => {
    for (const escrow of ["RELEASED", "REFUNDED", "NONE"] as const) {
      const condition = buildShipmentCondition({
        invoiceNumber: INVOICE,
        amountCents: 400_000,
        required: true,
        escrow,
        attestation: attestation(),
        proof: null,
      });
      expect(isReleasable(condition, NOW_MS), escrow).toBe(false);
    }
  });

  it("decodes the Move status constants in the same order", () => {
    expect(escrowStatusFrom(0)).toBe("LOCKED");
    expect(escrowStatusFrom(1)).toBe("RELEASED");
    expect(escrowStatusFrom(2)).toBe("REFUNDED");
  });
});

describe("proof storage", () => {
  it("hashes the bytes and addresses the blob by content", async () => {
    const store = createLocalProofStore();
    const bytes = new TextEncoder().encode("DELIVERY NOTE\nInvoice: INV-2026-3501\n");

    const stored = await store.put({
      bytes,
      filename: "delivery_proof.pdf",
      contentType: "application/pdf",
    });

    expect(stored.sha256).toBe(sha256Hex(bytes));
    expect(stored.byteLength).toBe(bytes.byteLength);
    expect(stored.storage).toBe("demo");

    // The same document stores to the same reference, twice.
    const again = await store.put({
      bytes,
      filename: "copy.pdf",
      contentType: "application/pdf",
    });
    expect(again.blobId).toBe(stored.blobId);

    expect(await store.get(stored.blobId)).toEqual(bytes);
  });

  it("verifies a document against what was attested, and catches a swap", () => {
    const real = new TextEncoder().encode("delivered");
    const forged = new TextEncoder().encode("delivered ");
    const digest = sha256Hex(real);

    expect(proofMatches(real, digest)).toBe(true);
    expect(proofMatches(forged, digest)).toBe(false);
    // The hash is what makes the reference checkable, so it must survive the
    // cosmetic differences a caller might introduce.
    expect(proofMatches(real, `0x${digest.toUpperCase()}`)).toBe(true);
  });

  it("falls back to local storage and says why", () => {
    const selection = selectProofStore({});
    expect(selection.live).toBe(false);
    expect(selection.store.kind).toBe("demo");
    expect(selection.reason).toMatch(/WALRUS_PUBLISHER_URL/);
  });

  it("uses Walrus when it is configured", () => {
    const selection = selectProofStore({
      WALRUS_PUBLISHER_URL: "https://publisher.example/",
      WALRUS_AGGREGATOR_URL: "https://aggregator.example/",
    });
    expect(selection.live).toBe(true);
    expect(selection.store.kind).toBe("walrus");
    expect(selection.reason).toBeNull();
  });
});

describe("the AI reads the proof and decides nothing", () => {
  it("reports a clean document as supporting confirmation", () => {
    const assessment = assessProof({
      document: document(),
      invoiceNumber: INVOICE,
      registeredRecipient: WALLET,
    });
    expect(assessment.concerns).toEqual([]);
    expect(assessment.matchesInvoice).toBe(true);
    expect(assessment.statesDelivered).toBe(true);
    expect(supportsConfirmation(assessment)).toBe(true);
  });

  it("catches a document filed against the wrong invoice", () => {
    const assessment = assessProof({
      document: document({ invoiceNumber: "INV-2026-9999" }),
      invoiceNumber: INVOICE,
      registeredRecipient: WALLET,
    });
    expect(assessment.concerns.map((c) => c.code)).toContain("INVOICE_NUMBER_MISMATCH");
    expect(supportsConfirmation(assessment)).toBe(false);
  });

  it("catches a delivery to somewhere other than the registered wallet", () => {
    const assessment = assessProof({
      document: document({ recipient: `0x${"9".repeat(64)}` }),
      invoiceNumber: INVOICE,
      registeredRecipient: WALLET,
    });
    expect(assessment.concerns.map((c) => c.code)).toContain("RECIPIENT_MISMATCH");
  });

  it("catches a document that does not claim delivery", () => {
    for (const status of ["IN_TRANSIT", "FAILED", "UNKNOWN"] as const) {
      const assessment = assessProof({
        document: document({ deliveryStatus: status }),
        invoiceNumber: INVOICE,
        registeredRecipient: WALLET,
      });
      expect(assessment.statesDelivered, status).toBe(false);
      expect(supportsConfirmation(assessment), status).toBe(false);
    }
  });

  it("marks its output as advisory when it reaches the chain", () => {
    const assessment = assessProof({
      document: document(),
      invoiceNumber: INVOICE,
      registeredRecipient: WALLET,
    });
    // Anyone reading the attestation, on chain or on screen, sees what this is.
    expect(attestationNote(assessment)).toMatch(/^ADVISORY \(deterministic\):/);
  });

  it("is not consulted by releasability, whatever it concluded", () => {
    // A confident, clean assessment attached to an UNCONFIRMED attestation.
    const glowing: ProofAssessment = assessProof({
      document: document(),
      invoiceNumber: INVOICE,
      registeredRecipient: WALLET,
    });
    expect(supportsConfirmation(glowing)).toBe(true);

    const condition = locked(
      attestation({ confirmed: false, aiAssessment: attestationNote(glowing) }),
    );
    expect(isReleasable(condition, NOW_MS)).toBe(false);
  });
});

describe("no advisory value can reach the money — structurally", () => {
  const escrowSource = readFileSync(
    resolve(process.cwd(), "move/payflow/sources/escrow.move"),
    "utf8",
  );

  /** Executable Move only — doc comments discuss what the code must not do. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  /** The body of one Move function, by brace matching. */
  function functionBody(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThan(-1);

    let i = source.indexOf("{", start);
    let depth = 0;
    const from = i;
    while (i < source.length) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(from, i + 1);
      }
      i += 1;
    }
    throw new Error(`unbalanced braces reading ${signature}`);
  }

  it("release never mentions the AI assessment", () => {
    const body = functionBody(escrowSource, "public fun release<T>");
    expect(body).not.toMatch(/ai_assessment/);
    // It reads exactly one thing about the shipment.
    expect(body).toMatch(/oracle::confirmed\(att\)/);
  });

  it("release takes no destination and pays the locked recipient", () => {
    const signature = escrowSource.slice(
      escrowSource.indexOf("public fun release<T>"),
      escrowSource.indexOf("public fun release<T>") + 400,
    );
    // No address parameter anywhere in the signature.
    expect(signature).not.toMatch(/:\s*address/);

    const body = functionBody(escrowSource, "public fun release<T>");
    expect(body).toMatch(/escrow\.recipient/);
  });

  it("the oracle module never touches a coin or a balance", () => {
    // Comments stripped: the module's own doc comment explains that it handles
    // no money, and a check reading prose would pass or fail on the wording.
    const oracleCode = stripComments(
      readFileSync(resolve(process.cwd(), "move/payflow/sources/oracle.move"), "utf8"),
    );
    // The strongest statement available about the oracle's authority: in
    // executable code it has no vocabulary for money at all.
    expect(oracleCode).not.toMatch(/\bBalance\b/);
    expect(oracleCode).not.toMatch(/\bCoin\b/);
    // The primitives that move value. It transfers exactly one thing — the
    // capability itself, to the oracle that will hold it — and never a coin.
    expect(oracleCode).not.toMatch(/split_vault|from_balance|into_balance|return_to_vault/);
    expect(oracleCode.match(/public_transfer/g) ?? []).toHaveLength(1);
    expect(oracleCode).toMatch(/public_transfer\(oracle, recipient\)/);
  });

  it("escrow is the only new module that moves value, and payment does not import it", () => {
    const paymentSource = readFileSync(
      resolve(process.cwd(), "move/payflow/sources/payment.move"),
      "utf8",
    );
    // The acyclic direction the whole design rests on: escrow -> payment.
    expect(paymentSource).not.toMatch(/use payflow::escrow/);
    expect(escrowSource).toMatch(/use payflow::payment/);
  });

  it("every direct settlement path is gated on the condition", () => {
    const paymentSource = readFileSync(
      resolve(process.cwd(), "move/payflow/sources/payment.move"),
      "utf8",
    );
    // One assert, in the one function all three entry points funnel through.
    expect(paymentSource).toMatch(
      /assert!\(!invoice::requires_shipment\(inv\), EConditionalInvoice\)/,
    );
    for (const entry of [
      "public fun execute_payment<T>",
      "public fun execute_approved<T>",
      "public fun execute_scheduled<T>",
    ]) {
      expect(functionBody(paymentSource, entry), entry).toMatch(/settle\(/);
    }
  });
});
