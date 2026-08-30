/**
 * The server-side guards.
 *
 * These run before a transaction is signed. They are not the security boundary
 * — Move is — but they decide whether real gas gets spent on a call that was
 * always going to abort, and they are the last chance to refuse a request the
 * client shaped.
 *
 * So the tests are mostly refusals, and one property runs through all of them:
 * a guard that cannot establish its fact must FAIL. An unreadable escrow is not
 * a releasable one, and a missing attestation is not a confirmed one.
 */

import { describe, expect, it } from "vitest";

import { guardAttest, guardLock, guardRelease } from "../../lib/escrow/guards";

const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const NORTHWIND = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const IMPOSTOR = `0x${"b4".repeat(32)}`;
const NOW = 1_788_685_200_000;

// --- lock ----------------------------------------------------------------------

function lockInput(overrides: Partial<Parameters<typeof guardLock>[0]> = {}) {
  return {
    invoiceNumber: "INV-2026-3501",
    onChainInvoice: {
      invoiceNumber: "INV-2026-3501",
      status: "PENDING",
      amountCents: 480_000,
      currency: "USD",
      supplierId: "sup_northwind",
      recipient: NORTHWIND,
    },
    requiresShipment: true,
    decision: "AUTO_PAY" as const,
    agentMaxSingleCents: 500_000,
    agentDailyRemainingCents: 2_000_000,
    supplierApproved: true,
    registryRecipient: NORTHWIND,
    allowedCurrencies: ["USD"],
    vaultCents: 9_700_000,
    minimumReserveCents: 5_000_000,
    ...overrides,
  };
}

describe("guardLock", () => {
  it("passes on the real Demo A shape", () => {
    const result = guardLock(lockInput());
    expect(result.ok).toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("refuses when the invoice cannot be read", () => {
    const result = guardLock(lockInput({ onChainInvoice: null }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/could not be read/);
  });

  it("refuses an invoice that is already settled", () => {
    for (const status of ["PAID", "ESCROWED"]) {
      const result = guardLock(
        lockInput({ onChainInvoice: { ...lockInput().onChainInvoice!, status } }),
      );
      expect(result.ok, status).toBe(false);
      expect(result.refusal, status).toMatch(/already settled/);
    }
  });

  it("refuses an invoice with no shipment condition", () => {
    // Routing an unconditional invoice through escrow would hide a plain
    // payment behind a condition nobody asked for.
    const result = guardLock(lockInput({ requiresShipment: false }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/no shipment condition/);
  });

  it("refuses when the condition cannot be established", () => {
    const result = guardLock(lockInput({ requiresShipment: null }));
    expect(result.ok).toBe(false);
  });

  it("refuses anything the engine did not decide to pay now", () => {
    for (const decision of ["SCHEDULE", "HUMAN_REVIEW", "REJECT", null] as const) {
      const result = guardLock(lockInput({ decision }));
      expect(result.ok, String(decision)).toBe(false);
      expect(result.refusal, String(decision)).toMatch(/PAY_NOW/);
    }
  });

  it("refuses an amount above the agent cap", () => {
    const result = guardLock(
      lockInput({ onChainInvoice: { ...lockInput().onChainInvoice!, amountCents: 800_000 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/single-payment cap/);
  });

  it("refuses an amount above the remaining daily limit", () => {
    const result = guardLock(lockInput({ agentDailyRemainingCents: 100_000 }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/daily limit/);
  });

  it("refuses an unapproved supplier", () => {
    expect(guardLock(lockInput({ supplierApproved: false })).ok).toBe(false);
  });

  it("refuses a redirected remit wallet", () => {
    const result = guardLock(
      lockInput({ onChainInvoice: { ...lockInput().onChainInvoice!, recipient: IMPOSTOR } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/registry/);
  });

  it("refuses a currency the treasury does not permit", () => {
    const result = guardLock(
      lockInput({ onChainInvoice: { ...lockInput().onChainInvoice!, currency: "GBP" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/currency/i);
  });

  it("refuses a payment that would breach the reserve", () => {
    const result = guardLock(lockInput({ vaultCents: 5_200_000 }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/reserve/);
  });

  it("refuses an amount larger than the vault without underflowing", () => {
    // Saturating, exactly as check 9 is.
    const result = guardLock(lockInput({ vaultCents: 100 }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/reserve/);
  });
});

// --- attest ---------------------------------------------------------------------

function attestInput(overrides: Partial<Parameters<typeof guardAttest>[0]> = {}) {
  return {
    invoiceNumber: "INV-2026-3501",
    oracleCap: {
      objectId: "0x834f4da6",
      treasuryId: TREASURY,
      oracleId: "demo_shipment_oracle",
    },
    expectedTreasuryId: TREASURY,
    expectedOracleId: "demo_shipment_oracle",
    storedSha256: "ab".repeat(32),
    documentSha256: "ab".repeat(32),
    proofInvoiceNumber: "INV-2026-3501",
    ...overrides,
  };
}

describe("guardAttest", () => {
  it("passes for the demo oracle on this treasury", () => {
    expect(guardAttest(attestInput()).ok).toBe(true);
  });

  it("refuses when no capability can be read", () => {
    const result = guardAttest(attestInput({ oracleCap: null }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/no OracleCap/);
  });

  it("refuses a capability bound to another treasury", () => {
    const result = guardAttest(
      attestInput({
        oracleCap: { ...attestInput().oracleCap!, treasuryId: `0x${"9".repeat(64)}` },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/bound to/);
  });

  it("refuses any oracle that is not the demo one", () => {
    const result = guardAttest(
      attestInput({ oracleCap: { ...attestInput().oracleCap!, oracleId: "some_other_oracle" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/Demo Shipment Oracle/);
  });

  it("refuses a proof filed against a different invoice", () => {
    const result = guardAttest(attestInput({ proofInvoiceNumber: "INV-2026-9999" }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/document names/);
  });

  it("refuses when the stored bytes do not hash to the attested digest", () => {
    // Evidence and attestation coming apart is the one thing a proof cannot
    // survive.
    const result = guardAttest(attestInput({ storedSha256: "cd".repeat(32) }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/do not hash/);
  });

  it("refuses a digest that is not a sha256 at all", () => {
    expect(guardAttest(attestInput({ storedSha256: "nope", documentSha256: "nope" })).ok).toBe(
      false,
    );
  });
});

// --- release ---------------------------------------------------------------------

function releaseInput(overrides: Partial<Parameters<typeof guardRelease>[0]> = {}) {
  return {
    escrow: {
      objectId: "0xesc",
      treasuryId: TREASURY,
      invoiceNumber: "INV-2026-3501",
      recipient: NORTHWIND,
      status: "LOCKED",
      heldCents: 480_000,
    },
    attestation: {
      attestationId: "0xatt",
      treasuryId: TREASURY,
      invoiceNumber: "INV-2026-3501",
      confirmed: true,
      expiresAtMs: NOW + 86_400_000,
      proofSha256: "ab".repeat(32),
    },
    expectedTreasuryId: TREASURY,
    registryRecipient: NORTHWIND,
    nowMs: NOW,
    ...overrides,
  };
}

describe("guardRelease", () => {
  it("passes only on a locked escrow with a confirmed, unexpired attestation", () => {
    const result = guardRelease(releaseInput());
    expect(result.ok).toBe(true);
  });

  it("refuses an unconfirmed attestation — the Demo B case", () => {
    const result = guardRelease(
      releaseInput({ attestation: { ...releaseInput().attestation!, confirmed: false } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/did not confirm/);
  });

  it("refuses when there is no attestation at all", () => {
    const result = guardRelease(releaseInput({ attestation: null }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/no attestation/);
  });

  it("refuses when the escrow cannot be read", () => {
    const result = guardRelease(releaseInput({ escrow: null }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/no escrow object/);
  });

  it("refuses an escrow that is already released or refunded", () => {
    for (const status of ["RELEASED", "REFUNDED"]) {
      const result = guardRelease(
        releaseInput({ escrow: { ...releaseInput().escrow!, status } }),
      );
      expect(result.ok, status).toBe(false);
      expect(result.refusal, status).toMatch(/LOCKED/);
    }
  });

  it("refuses an emptied escrow even if it still claims to be locked", () => {
    const result = guardRelease(
      releaseInput({ escrow: { ...releaseInput().escrow!, heldCents: 0 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/holds the funds/);
  });

  it("refuses an attestation for a different invoice", () => {
    const result = guardRelease(
      releaseInput({
        attestation: { ...releaseInput().attestation!, invoiceNumber: "INV-2026-9999" },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an attestation for a different treasury", () => {
    const result = guardRelease(
      releaseInput({
        attestation: { ...releaseInput().attestation!, treasuryId: `0x${"9".repeat(64)}` },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an escrow belonging to a different treasury", () => {
    const result = guardRelease(
      releaseInput({ escrow: { ...releaseInput().escrow!, treasuryId: `0x${"9".repeat(64)}` } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an expired attestation", () => {
    const result = guardRelease(
      releaseInput({ attestation: { ...releaseInput().attestation!, expiresAtMs: NOW - 1 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/expired/);
  });

  it("refuses when the escrow recipient no longer matches the registry", () => {
    // Release takes no destination, so this cannot redirect anything — but a
    // disagreement means something moved that should not have.
    const result = guardRelease(releaseInput({ registryRecipient: IMPOSTOR }));
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/registry now holds/);
  });

  it("never passes on missing information", () => {
    const blanks = [
      releaseInput({ escrow: null }),
      releaseInput({ attestation: null }),
      releaseInput({ registryRecipient: null }),
    ];
    for (const input of blanks) {
      expect(guardRelease(input).ok).toBe(false);
    }
  });
});
