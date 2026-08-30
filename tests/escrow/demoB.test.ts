/**
 * Demo B: the payment that is authorised and still does not arrive.
 *
 * The claim is a negative, and negatives are easy to assert loosely. "No error
 * occurred" would pass on a system that did nothing at all; "the supplier was
 * not paid" would pass on a system that refused the invoice outright. Neither
 * is what this demonstrates.
 *
 * What it demonstrates is narrower and harder: a payment that passes every
 * check a treasury can make, whose money leaves the treasury, and which the
 * supplier still cannot collect — because a real-world condition has not been
 * met. So each test below names the specific thing that must NOT have happened,
 * alongside the things that must have.
 */

import { describe, expect, it } from "vitest";

import { verifyHeldEscrow, type ObservedEscrow } from "../../lib/escrow/verify";
import { guardLock } from "../../lib/escrow/guards";
import { PROOF_UNCONFIRMED, proofSha256 } from "../../lib/escrow/proofDocument";
import { assessProof, supportsConfirmation } from "../../lib/ai/proofAssessment";
import { conditionalDocumentFor, conditionalWorld } from "../../lib/escrow/conditionalInvoices";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { decideDeterministically } from "../../lib/ai/deterministicEngine";
import { DEMO_AS_OF_DATE } from "../../lib/demo/clock";
import { invoiceStatusFrom } from "../../lib/sui/chainTypes";

const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const KESTREL = "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308";
const INVOICE = "INV-2026-3502";
const AMOUNT = 400_000;

function escrow(overrides: Partial<ObservedEscrow> = {}): ObservedEscrow {
  return {
    objectId: "0xescB",
    treasuryId: TREASURY,
    invoiceNumber: INVOICE,
    recipient: KESTREL,
    status: "LOCKED",
    amountCents: AMOUNT,
    heldCents: AMOUNT,
    ...overrides,
  };
}

function expectation(overrides: Partial<Parameters<typeof verifyHeldEscrow>[1]> = {}) {
  return {
    treasuryId: TREASURY,
    invoiceNumber: INVOICE,
    recipient: KESTREL,
    amountCents: AMOUNT,
    invoiceStatus: "ESCROWED",
    attestationExists: false,
    supplierBalanceBeforeCents: 0,
    supplierBalanceAfterCents: 0,
    ...overrides,
  };
}

describe("the invoice is genuinely payable — that is the point", () => {
  it("the deterministic engine says AUTO_PAY", async () => {
    // If the engine escalated or refused this, the demo would be showing a
    // rejection rather than a held payment, and the two mean opposite things.
    const document = conditionalDocumentFor(INVOICE)!;
    const analysis = await buildAnalysis({
      document,
      world: conditionalWorld(),
      asOf: DEMO_AS_OF_DATE,
    });
    expect(decideDeterministically(analysis).action).toBe("AUTO_PAY");
  });

  it("passes every lock guard", () => {
    const result = guardLock({
      invoiceNumber: INVOICE,
      onChainInvoice: {
        invoiceNumber: INVOICE,
        status: "PENDING",
        amountCents: AMOUNT,
        currency: "USD",
        supplierId: "sup_kestrel",
        recipient: KESTREL,
      },
      requiresShipment: true,
      decision: "AUTO_PAY",
      agentMaxSingleCents: 500_000,
      agentDailyRemainingCents: 2_000_000,
      supplierApproved: true,
      registryRecipient: KESTREL,
      allowedCurrencies: ["USD"],
      vaultCents: 9_220_000,
      minimumReserveCents: 5_000_000,
    });
    expect(result.ok).toBe(true);
    // $4,000 against the $5,000 cap — inside the agent's own authority.
    expect(AMOUNT).toBeLessThanOrEqual(500_000);
  });
});

describe("the proof does not support confirmation", () => {
  it("reports IN_TRANSIT with no delivery date", () => {
    expect(PROOF_UNCONFIRMED.document.shipmentId).toBe("SHIP-3502");
    expect(PROOF_UNCONFIRMED.document.deliveryStatus).toBe("IN_TRANSIT");
    expect(PROOF_UNCONFIRMED.document.deliveredAt).toBeNull();
  });

  it("hashes to a real digest of real bytes", () => {
    expect(proofSha256(PROOF_UNCONFIRMED)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the AI agrees it does not report delivery", () => {
    const assessment = assessProof({
      document: PROOF_UNCONFIRMED.document,
      invoiceNumber: INVOICE,
      registeredRecipient: KESTREL,
    });
    expect(supportsConfirmation(assessment)).toBe(false);
    expect(assessment.concerns.map((c) => c.code)).toContain("NOT_DELIVERED");
    // Advisory either way — it informs the oracle and gates nothing.
    expect(assessment.source).toBe("deterministic");
  });

  it("says in the document itself that no delivery took place", () => {
    expect(PROOF_UNCONFIRMED.text).toMatch(/No delivery has taken place/i);
    expect(PROOF_UNCONFIRMED.text).toMatch(/not issued by a carrier/i);
  });
});

describe("the held escrow", () => {
  it("verifies the whole held state", () => {
    const v = verifyHeldEscrow(escrow(), expectation(), null);
    expect(v.ok).toBe(true);
    expect(v.failure).toBeNull();
  });

  it("requires the funds to still be there", () => {
    // An escrow that says $4,000 and holds nothing has paid someone.
    const v = verifyHeldEscrow(escrow({ heldCents: 0 }), expectation(), null);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/still holds the funds/);
  });

  it("fails if the escrow was released", () => {
    const v = verifyHeldEscrow(
      escrow({ status: "RELEASED", heldCents: 0 }),
      expectation(),
      null,
    );
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/LOCKED/);
  });

  it("fails if the escrow was refunded", () => {
    // Refunding would also be wrong here: the money must stay committed.
    const v = verifyHeldEscrow(escrow({ status: "REFUNDED", heldCents: 0 }), expectation(), null);
    expect(v.ok).toBe(false);
  });

  it("fails if an attestation has been linked", () => {
    const v = verifyHeldEscrow(escrow(), expectation(), "0xattB");
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/no attestation linked/);
  });

  it("fails if an attestation exists for the invoice at all", () => {
    const v = verifyHeldEscrow(escrow(), expectation({ attestationExists: true }), null);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/no attestation exists/);
  });

  it("fails if the invoice was marked PAID", () => {
    const v = verifyHeldEscrow(escrow(), expectation({ invoiceStatus: "PAID" }), null);
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/NOT paid/);
  });

  it("fails if the supplier balance moved at all", () => {
    // The single most important negative in the demo.
    const v = verifyHeldEscrow(
      escrow(),
      expectation({ supplierBalanceBeforeCents: 0, supplierBalanceAfterCents: AMOUNT }),
      null,
    );
    expect(v.ok).toBe(false);
    expect(v.failure).toMatch(/supplier balance unchanged/);
  });

  it("tolerates a supplier that already held coins, as long as nothing moved", () => {
    const v = verifyHeldEscrow(
      escrow(),
      expectation({ supplierBalanceBeforeCents: 780_000, supplierBalanceAfterCents: 780_000 }),
      null,
    );
    expect(v.ok).toBe(true);
  });

  it("fails when the escrow cannot be read", () => {
    expect(verifyHeldEscrow(null, expectation(), null).ok).toBe(false);
  });

  it("fails on the wrong invoice, recipient, treasury or amount", () => {
    const wrong: Partial<ObservedEscrow>[] = [
      { invoiceNumber: "INV-2026-3501" },
      { recipient: `0x${"9".repeat(64)}` },
      { treasuryId: `0x${"9".repeat(64)}` },
      { amountCents: 480_000 },
    ];
    for (const overrides of wrong) {
      expect(verifyHeldEscrow(escrow(overrides), expectation(), null).ok, JSON.stringify(overrides)).toBe(
        false,
      );
    }
  });

  it("does not accept Demo A's escrow as Demo B's", () => {
    // Both are LOCKED-shaped objects on the same treasury; only the invoice
    // number and amount tell them apart.
    const demoA = escrow({ invoiceNumber: "INV-2026-3501", amountCents: 480_000, heldCents: 480_000 });
    expect(verifyHeldEscrow(demoA, expectation(), null).ok).toBe(false);
  });
});

describe("the invoice status decoder knows about escrow", () => {
  it("decodes 7 as ESCROWED, not UNKNOWN", () => {
    // The Move layer gained STATUS_ESCROWED with the escrow upgrade; this map
    // did not, so a correctly-escrowed invoice read as UNKNOWN. The held-state
    // check still passed — UNKNOWN is not PAID — but the report was wrong.
    expect(invoiceStatusFrom(7)).toBe("ESCROWED");
  });

  it("still decodes the statuses that predate the upgrade", () => {
    expect(invoiceStatusFrom(0)).toBe("PENDING");
    expect(invoiceStatusFrom(4)).toBe("PAID");
    expect(invoiceStatusFrom(6)).toBe("HUMAN_REVIEW");
    expect(invoiceStatusFrom(99)).toBe("UNKNOWN");
    expect(invoiceStatusFrom(null)).toBe("UNKNOWN");
  });

  it("keeps ESCROWED distinct from PAID", () => {
    // Conflating them would make a held payment look settled.
    expect(invoiceStatusFrom(7)).not.toBe("PAID");
  });
});
