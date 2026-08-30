/**
 * Verifying the A0 proof, and — mostly — refusing to.
 *
 * The dangerous version of this check is the one-liner: the invoice is PAID, so
 * pass. That would accept an invoice paid by anyone, for any amount, to any
 * address, under any authority. It would also have passed on a deployment where
 * the agent's cap was never enforced at all.
 *
 * So almost every test here is a near-miss: a real transaction, a real record,
 * one field wrong. A pass must mean the recorded payment IS the one claimed.
 */

import { describe, expect, it } from "vitest";

import {
  AUTHORITY_AGENT,
  describeA0Proof,
  describeProofPackage,
  verifyA0Proof,
  type A0ProofInput,
} from "../../scripts/lib/a0Proof";

const ORIGINAL = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const UPGRADED = "0x14ae68a6e19f0671c7b9d23db312b56bd003b36d77ce279802aaf9cf7d997578";
const DIGEST = "DwegxdkzVmtTnehTXy44noRBv6vDtSJRaYhAH5i8oH2G";
const WALLET = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";

/** The real proof, as the chain actually reports it. */
function input(overrides: Partial<A0ProofInput> = {}): A0ProofInput {
  return {
    claim: {
      invoiceNumber: "INV-2026-3455",
      amountCents: 300_000,
      digest: DIGEST,
      packageId: ORIGINAL,
      module: "payment",
      function: "execute_payment",
      invoiceObjectId: "0x3124042beb52a69d178958037436e2d063e2739abd01ab94593396d71fdd710b",
      paymentRecordId: "0xcccc4e73a0282cffe0efc4d06240fe4f4c8f1a2f34c48ee31f008668240e69e7",
      supplierId: "sup_northwind",
      recipient: WALLET,
      authority: AUTHORITY_AGENT,
    },
    transaction: { exists: true, status: "success" },
    record: {
      invoiceNumber: "INV-2026-3455",
      amountCents: 300_000,
      recipient: WALLET,
      supplierId: "sup_northwind",
      authority: AUTHORITY_AGENT,
      packageId: ORIGINAL,
    },
    invoiceStatus: "PAID",
    agentCapCents: 500_000,
    registeredRecipient: WALLET,
    ...overrides,
  };
}

describe("the real A0 proof verifies", () => {
  it("passes on the actual recorded settlement", () => {
    expect(verifyA0Proof(input())).toEqual({ kind: "PROVEN" });
  });

  it("says what it proved", () => {
    expect(describeA0Proof(verifyA0Proof(input()))).toMatch(
      /previously accepted by every on-chain check/i,
    );
  });

  it("confirms $3,000 sits inside the agent's $5,000 cap", () => {
    // The substance of A0: this payment needed no human.
    const claim = input().claim!;
    expect(claim.amountCents).toBeLessThanOrEqual(500_000);
    expect(claim.authority).toBe(AUTHORITY_AGENT);
  });
});

describe("PAID alone is never enough", () => {
  it("refuses a paid invoice with no recorded proof", () => {
    const verdict = verifyA0Proof(input({ claim: null }));
    expect(verdict.kind).toBe("PAID_UNVERIFIED");
    expect(describeA0Proof(verdict)).toMatch(/nothing establishes WHY it is paid/i);
  });

  it("reports no claim when the invoice is not paid either", () => {
    expect(verifyA0Proof(input({ claim: null, invoiceStatus: "PENDING" })).kind).toBe("NO_CLAIM");
  });

  it("refuses when the transaction is not on chain", () => {
    const verdict = verifyA0Proof(input({ transaction: { exists: false, status: null } }));
    expect(verdict.kind).toBe("TRANSACTION_MISSING");
    expect(describeA0Proof(verdict)).toContain(DIGEST);
  });

  it("refuses a transaction that exists but failed", () => {
    const verdict = verifyA0Proof(input({ transaction: { exists: true, status: "failure" } }));
    expect(verdict.kind).toBe("TRANSACTION_FAILED");
  });

  it("refuses when the payment record is gone", () => {
    const verdict = verifyA0Proof(input({ record: null }));
    expect(verdict.kind).toBe("MISMATCH");
    expect(describeA0Proof(verdict)).toMatch(/does not exist on chain/i);
  });
});

describe("a near-miss is a failure, not a pass", () => {
  const cases: [string, Partial<A0ProofInput>, RegExp][] = [
    [
      "the record settles a different invoice",
      { record: { ...input().record!, invoiceNumber: "INV-2026-9999" } },
      /settles INV-2026-9999/,
    ],
    [
      "the amount does not match",
      { record: { ...input().record!, amountCents: 900_000 } },
      /90000000 cents|900000 cents/,
    ],
    [
      "the money went somewhere else",
      { record: { ...input().record!, recipient: `0x${"9".repeat(64)}` } },
      /paid 0x9{4}/,
    ],
    [
      "a different supplier was paid",
      { record: { ...input().record!, supplierId: "sup_kestrel" } },
      /names supplier sup_kestrel/,
    ],
    [
      "the invoice reads something other than PAID",
      { invoiceStatus: "ESCROWED" },
      /reads ESCROWED, not PAID/,
    ],
    [
      "the registry now points somewhere else",
      { registeredRecipient: `0x${"3".repeat(64)}` },
      /the registry now holds/,
    ],
  ];

  it.each(cases)("refuses when %s", (_label, overrides, pattern) => {
    const verdict = verifyA0Proof(input(overrides));
    expect(verdict.kind).toBe("MISMATCH");
    expect(describeA0Proof(verdict)).toMatch(pattern);
  });

  it("refuses a HUMAN_APPROVAL payment — that would not be A0 at all", () => {
    // The single most important near-miss. A $3,000 payment a person signed off
    // proves the approval path works, and proves nothing about autonomy.
    const verdict = verifyA0Proof(input({ record: { ...input().record!, authority: 1 } }));
    expect(verdict.kind).toBe("MISMATCH");
    expect(describeA0Proof(verdict)).toMatch(/not an autonomous payment/i);
  });

  it("refuses an amount above the agent cap even if everything else lines up", () => {
    const verdict = verifyA0Proof(
      input({
        claim: { ...input().claim!, amountCents: 800_000 },
        record: { ...input().record!, amountCents: 800_000 },
      }),
    );
    expect(verdict.kind).toBe("MISMATCH");
    expect(describeA0Proof(verdict)).toMatch(/exceeds the agent cap/i);
  });
});

describe("an upgrade does not invalidate historical evidence", () => {
  it("still verifies a proof executed against the pre-upgrade package", () => {
    // The claim names the ORIGINAL package while the deployment is now on v2.
    // That is what a historical proof looks like, and it must still pass.
    expect(verifyA0Proof(input()).kind).toBe("PROVEN");
  });

  it("describes a pre-upgrade proof as valid rather than stale", () => {
    expect(describeProofPackage(ORIGINAL, UPGRADED, ORIGINAL)).toMatch(
      /executed before the upgrade — still valid evidence/i,
    );
  });

  it("recognises a proof made against the current package", () => {
    expect(describeProofPackage(UPGRADED, UPGRADED, ORIGINAL)).toBe("current package");
  });

  it("flags a package belonging to neither", () => {
    expect(describeProofPackage(`0x${"7".repeat(64)}`, UPGRADED, ORIGINAL)).toMatch(
      /does not recognise/i,
    );
  });
});

describe("address comparison tolerates formatting", () => {
  it("matches the same address written with and without leading zeroes", () => {
    const padded = `0x${"0".repeat(62)}11`;
    const short = "0x11";
    const verdict = verifyA0Proof(
      input({
        claim: { ...input().claim!, recipient: padded },
        record: { ...input().record!, recipient: short },
        registeredRecipient: short,
      }),
    );
    expect(verdict.kind).toBe("PROVEN");
  });
});
