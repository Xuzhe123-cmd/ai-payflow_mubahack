/**
 * Which tab an invoice belongs in, and why it is not the AI's decision.
 *
 * THE BUG THIS PREVENTS: INV-2026-3501 settled — $4,800 released from escrow to
 * Northwind Components Ltd, oracle attestation confirmed, escrow holding $0,
 * invoice PAID on chain — and the /invoices page filed it under "Rejected"
 * while the badge in that very row read "Payment released".
 *
 * Two rules were running. The badge used chain-first precedence; the list
 * switched on `finalOutcome`, the pipeline's verdict on paying the invoice NOW,
 * which for an already-paid invoice is necessarily a refusal. Neither was
 * lying. They were answering different questions and only one of them was the
 * question the tab claimed to ask.
 *
 *   the category   what happened to the money
 *   finalOutcome   what would happen if someone paid it again
 *
 * So the category now comes from `describeInvoiceStatus` — the same call that
 * produces the label — and the tests below pair each chain state with the most
 * hostile recommendation available to prove the recommendation cannot move it.
 */

import { describe, expect, it } from "vitest";

import {
  categorizeInvoice,
  describeInvoiceStatus,
  type InvoiceCategory,
} from "../../lib/payments/invoiceStatus";
import type { FinalOutcome } from "../../lib/types";

/** Every verdict the pipeline can reach, so none of them can leak through. */
const OUTCOMES: FinalOutcome[] = [
  "EXECUTED",
  "SCHEDULED",
  "AWAITING_APPROVAL",
  "HUMAN_REVIEW",
  "REJECTED",
  "SUI_REJECT",
];

// --- 1-4: a released conditional invoice ------------------------------------

describe("a RELEASED conditional invoice", () => {
  it("is categorised PAID, whatever the AI recommended", () => {
    // INV-2026-3501 exactly: released escrow, invoice PAID on chain.
    for (const finalOutcome of OUTCOMES) {
      expect(
        categorizeInvoice({
          runStatus: "ANALYZED",
          finalOutcome,
          chainInvoiceStatus: "PAID",
          conditionStage: "RELEASED",
        }),
      ).toBe("paid");
    }
  });

  it("is NEVER categorised rejected", () => {
    // The single assertion worth failing a build on.
    for (const finalOutcome of OUTCOMES) {
      for (const chainInvoiceStatus of ["PAID", "SETTLED", null]) {
        expect(
          categorizeInvoice({
            runStatus: "ANALYZED",
            finalOutcome,
            chainInvoiceStatus,
            conditionStage: "RELEASED",
          }),
        ).not.toBe("rejected");
      }
    }
  });

  it("reads Payment released, and the label and tab agree", () => {
    // One call produces both, which is what makes them unable to disagree.
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "REJECTED",
      chainInvoiceStatus: "PAID",
      conditionStage: "RELEASED",
    });

    expect(status.label).toBe("Payment released");
    expect(status.category).toBe("paid");
    expect(status.settled).toBe(true);
  });

  it("is settled, so no payment action can be offered", async () => {
    // Proven against the action rule rather than restated, so the tab and the
    // button cannot drift apart.
    const { availablePaymentAction, offersPaymentControl } = await import(
      "../../lib/payments/availableAction"
    );
    const { decideAutonomy } = await import("../../lib/payments/autonomy");

    const state = availablePaymentAction({
      autonomy: decideAutonomy({
        action: "AUTO_PAY",
        finalOutcome: "EXECUTED",
        hasPaymentRequest: true,
        enforcement: { outcome: "APPROVED" },
        conditional: true,
      }),
      conditionStage: "RELEASED",
      fundsHeldCents: 0,
      amountCents: 480_000,
      chainInvoiceStatus: "PAID",
      runStatus: "ANALYZED",
      hasReceipt: false,
    });

    expect(state.settled).toBe(true);
    expect(offersPaymentControl(state)).toBe(false);
  });
});

// --- an ordinary settled invoice -------------------------------------------

describe("an invoice the chain records as paid", () => {
  it("is categorised PAID even with no local trace of the payment", () => {
    // Settled by a seeding script in an earlier session: no run status, no
    // receipt. Asking the local run alone is what produced the original bug.
    expect(
      categorizeInvoice({
        runStatus: "ANALYZED",
        finalOutcome: "REJECTED",
        chainInvoiceStatus: "PAID",
        conditionStage: null,
      }),
    ).toBe("paid");
  });

  it("is categorised PAID from a local receipt when the chain read fails", () => {
    expect(
      categorizeInvoice({
        runStatus: "PAID",
        finalOutcome: "EXECUTED",
        chainInvoiceStatus: null,
        hasReceipt: true,
      }),
    ).toBe("paid");
  });
});

// --- 10-12: a held conditional invoice --------------------------------------

describe("a HELD conditional invoice", () => {
  it("is categorised held, not rejected and not paid", () => {
    // INV-2026-3502: authorized and committed, condition unmet. The treasury
    // has parted with the money and the supplier does not have it — which is
    // neither a payment nor a refusal, and had nowhere honest to go before.
    for (const stage of ["HELD", "ESCROWED", "PROOF_SUBMITTED"] as const) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome: "EXECUTED",
        chainInvoiceStatus: "ESCROWED",
        conditionStage: stage,
      });

      expect(status.category).toBe("held");
      expect(status.category).not.toBe("rejected");
      expect(status.settled).toBe(false);
    }
  });

  it("stays held even where the AI recommendation is a refusal", () => {
    expect(
      categorizeInvoice({
        runStatus: "ANALYZED",
        finalOutcome: "REJECTED",
        chainInvoiceStatus: "ESCROWED",
        conditionStage: "HELD",
      }),
    ).toBe("held");
  });

  it("treats a confirmed-but-unreleased escrow as held, not paid", () => {
    // ATTESTED is releasable. The funds have NOT reached the supplier, and
    // calling that paid would be the mirror image of the original bug.
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "EXECUTED",
      conditionStage: "ATTESTED",
    });

    expect(status.category).toBe("held");
    expect(status.settled).toBe(false);
  });

  it("offers neither execute nor release while held", async () => {
    const { availablePaymentAction, offersPaymentControl } = await import(
      "../../lib/payments/availableAction"
    );
    const { decideAutonomy } = await import("../../lib/payments/autonomy");

    for (const conditionStage of ["HELD", "ESCROWED", "ATTESTED"] as const) {
      const state = availablePaymentAction({
        autonomy: decideAutonomy({
          action: "AUTO_PAY",
          finalOutcome: "EXECUTED",
          hasPaymentRequest: true,
          enforcement: { outcome: "APPROVED" },
          conditional: true,
        }),
        conditionStage,
        fundsHeldCents: 400_000,
        amountCents: 400_000,
        chainInvoiceStatus: "ESCROWED",
        runStatus: "ANALYZED",
        hasReceipt: false,
      });

      expect(offersPaymentControl(state)).toBe(false);
      expect(state.action).toBe("NONE");
      expect(state.settled).toBe(false);
    }
  });
});

// --- 9, 13, 14: the states that must keep working ---------------------------

describe("the categories that must not be collapsed", () => {
  it("keeps a genuine rejection in the rejected tab", () => {
    // A wallet mismatch or policy violation, refused before any money moved.
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "REJECTED",
      chainInvoiceStatus: "PENDING",
      conditionStage: null,
    });

    expect(status.category).toBe("rejected");
    expect(status.label).toBe("Payment rejected");
  });

  it("keeps a chain-refused payment in the rejected tab", () => {
    expect(
      categorizeInvoice({
        runStatus: "ANALYZED",
        finalOutcome: "SUI_REJECT",
        chainInvoiceStatus: "PENDING",
      }),
    ).toBe("rejected");
  });

  it("puts an invoice awaiting a person in the review tab", () => {
    for (const finalOutcome of ["AWAITING_APPROVAL", "HUMAN_REVIEW"] as const) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome,
        chainInvoiceStatus: "PENDING",
      });

      expect(status.category).toBe("review");
      expect(status.label).toBe("Awaiting approval");
    }
  });

  it("puts an authorized, unpaid invoice in the scheduled tab", () => {
    for (const finalOutcome of ["EXECUTED", "SCHEDULED"] as const) {
      expect(
        categorizeInvoice({
          runStatus: "ANALYZED",
          finalOutcome,
          chainInvoiceStatus: "PENDING",
        }),
      ).toBe("scheduled");
    }
  });

  it("leaves an unanalyzed invoice pending", () => {
    expect(categorizeInvoice({ runStatus: "DETECTED" })).toBe("pending");
    expect(categorizeInvoice({ runStatus: "ANALYZING" })).toBe("pending");
  });

  it("gives every category at least one invoice that reaches it", () => {
    // Guards against a refactor quietly making a bucket unreachable.
    const reached = new Set<InvoiceCategory>([
      categorizeInvoice({ conditionStage: "RELEASED" }),
      categorizeInvoice({ conditionStage: "HELD" }),
      categorizeInvoice({ runStatus: "ANALYZED", finalOutcome: "HUMAN_REVIEW" }),
      categorizeInvoice({ runStatus: "ANALYZED", finalOutcome: "SCHEDULED" }),
      categorizeInvoice({ runStatus: "ANALYZED", finalOutcome: "REJECTED" }),
      categorizeInvoice({ runStatus: "DETECTED" }),
    ]);

    expect(reached).toEqual(
      new Set(["paid", "held", "review", "scheduled", "rejected", "pending"]),
    );
  });
});

// --- the window before the chain answers ------------------------------------

describe("while the chain read is still in flight", () => {
  it("does not let the recommendation categorise a settled invoice", () => {
    // The transient version of the same bug. Before the fetch lands,
    // `chainInvoiceStatus` is null and a settled invoice would fall through to
    // the guard's refusal and appear under Rejected for a frame. Brief is not
    // harmless when the flash IS the mistake.
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "REJECTED",
      chainInvoiceStatus: null,
      conditionStage: null,
      chainResolved: false,
    });

    expect(status.category).toBe("pending");
    expect(status.category).not.toBe("rejected");
    expect(status.label).toBe("Checking chain");
  });

  it("still reports what the LOCAL run already proves", () => {
    // A payment this session made needs no chain read to be known.
    expect(
      categorizeInvoice({
        runStatus: "PAID",
        finalOutcome: "EXECUTED",
        hasReceipt: true,
        chainResolved: false,
      }),
    ).toBe("paid");
  });

  it("defaults to resolved for callers that never consult the chain", () => {
    // `describeRun` and other local-only surfaces must keep working unchanged.
    expect(
      categorizeInvoice({ runStatus: "ANALYZED", finalOutcome: "REJECTED" }),
    ).toBe("rejected");
  });
});

// --- 15: one recommendation, many chain states ------------------------------

describe("the same AI recommendation under different chain states", () => {
  it("produces a different final category for each", () => {
    // The clearest statement of the precedence: the recommendation is held
    // constant and the chain alone decides. If this collapses to one answer,
    // the recommendation has taken over again.
    const recommendation = { runStatus: "ANALYZED" as const, finalOutcome: "EXECUTED" as const };

    expect(categorizeInvoice({ ...recommendation, conditionStage: "RELEASED" })).toBe("paid");
    expect(categorizeInvoice({ ...recommendation, chainInvoiceStatus: "PAID" })).toBe("paid");
    expect(categorizeInvoice({ ...recommendation, conditionStage: "HELD" })).toBe("held");
    expect(categorizeInvoice({ ...recommendation, chainInvoiceStatus: "PENDING" })).toBe(
      "scheduled",
    );
  });

  it("produces a different category for a REJECT recommendation too", () => {
    // The direction that caused the bug: a refusal that means "already paid"
    // on one chain state and "do not pay this" on another.
    const refusal = { runStatus: "ANALYZED" as const, finalOutcome: "REJECTED" as const };

    expect(categorizeInvoice({ ...refusal, conditionStage: "RELEASED" })).toBe("paid");
    expect(categorizeInvoice({ ...refusal, chainInvoiceStatus: "PAID" })).toBe("paid");
    expect(categorizeInvoice({ ...refusal, conditionStage: "HELD" })).toBe("held");
    expect(categorizeInvoice({ ...refusal, chainInvoiceStatus: "PENDING" })).toBe("rejected");
  });
});
