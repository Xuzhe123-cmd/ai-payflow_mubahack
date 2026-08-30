/**
 * Which invoices carry a shipment condition — and who gets to decide.
 *
 * THE BUG THIS PREVENTS: the answer used to be "the two the manifest names",
 * which meant a conditional invoice created after the seed had an escrow, an
 * oracle attestation, and no evidence section anywhere in the interface. The
 * chain knew; the screen did not.
 *
 * So the manifest is a floor, never a ceiling: anything with an escrow against
 * it, or sitting at a status only escrow produces, is conditional whether or
 * not it was written down locally.
 */

import { describe, expect, it } from "vitest";

import { conditionalInvoiceSet } from "../../lib/escrow/conditionalSet";

const SEEDED = [{ invoiceNumber: "INV-2026-3501", amountCents: 480_000 }];

describe("the conditional invoice set", () => {
  it("includes an invoice the manifest has never heard of, given an escrow", () => {
    const result = conditionalInvoiceSet(
      SEEDED,
      [
        { invoiceNumber: "INV-2026-3501", amountCents: 480_000, status: "PAID" },
        { invoiceNumber: "INV-2026-3600", amountCents: 210_000, status: "PENDING" },
      ],
      new Set(["INV-2026-3600"]),
    );

    expect(result.map((entry) => entry.invoiceNumber)).toEqual([
      "INV-2026-3501",
      "INV-2026-3600",
    ]);
  });

  it("includes an invoice whose on-chain status is ESCROWED", () => {
    // Status alone is enough: the escrow query can lag the invoice read, and a
    // missing evidence section is worse than an extra one.
    const result = conditionalInvoiceSet(
      [],
      [{ invoiceNumber: "INV-2026-3700", amountCents: 90_000, status: "ESCROWED" }],
      new Set(),
    );

    expect(result).toEqual([{ invoiceNumber: "INV-2026-3700", amountCents: 90_000 }]);
  });

  it("excludes ordinary invoices", () => {
    // An invoice with no escrow and no escrow-only status must not grow a
    // shipment section. Inventing one claims a condition that does not exist.
    const result = conditionalInvoiceSet(
      [],
      [
        { invoiceNumber: "INV-2026-3455", amountCents: 300_000, status: "PAID" },
        { invoiceNumber: "INV-2026-3461", amountCents: 3_000_000, status: "PENDING" },
      ],
      new Set(),
    );

    expect(result).toEqual([]);
  });

  it("keeps the seeded entry when the chain reports the same invoice", () => {
    // No duplicates, and the seeded amount is not overwritten by a second read.
    const result = conditionalInvoiceSet(
      SEEDED,
      [{ invoiceNumber: "INV-2026-3501", amountCents: 999_999, status: "ESCROWED" }],
      new Set(["INV-2026-3501"]),
    );

    expect(result).toEqual([{ invoiceNumber: "INV-2026-3501", amountCents: 480_000 }]);
  });

  it("still reports the seeded pair when the chain cannot be read", () => {
    // Degraded, not empty. An unreachable indexer must not erase the demo.
    expect(conditionalInvoiceSet(SEEDED, [], new Set())).toEqual(SEEDED);
  });
});
