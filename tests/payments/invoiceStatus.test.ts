/**
 * The badge beside an invoice number says what happened to the money.
 *
 * THE BUG THIS PREVENTS: INV-2026-3501 settled — $4,800 released from escrow to
 * Northwind Components Ltd, oracle attestation confirmed, escrow holding $0 —
 * and its header badge read "Rejected". Both facts were true. The badge came
 * from `finalOutcome`, which is the pipeline's verdict on paying the invoice
 * NOW, and for an already-paid invoice that verdict is necessarily a refusal.
 *
 *   the badge          what happened to the money
 *   the decision chain what happens if someone pays it again
 *
 * So the tests below pair a settled chain with the most hostile recommendation
 * available and assert the badge never says "Rejected". Everything else is the
 * ordering that keeps it that way.
 */

import { describe, expect, it } from "vitest";

import { describeInvoiceStatus } from "../../lib/payments/invoiceStatus";
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

describe("a settled invoice", () => {
  it("reads Payment released for a released escrow, whatever the AI said", () => {
    // INV-2026-3501 exactly.
    for (const finalOutcome of OUTCOMES) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome,
        chainInvoiceStatus: "PAID",
        conditionStage: "RELEASED",
      });

      expect(status.label).toBe("Payment released");
      expect(status.tone).toBe("positive");
      expect(status.settled).toBe(true);
    }
  });

  it("reads Paid for an ordinary settled invoice, whatever the AI said", () => {
    // INV-2026-3455: paid by a script, so no local receipt exists either.
    for (const finalOutcome of OUTCOMES) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome,
        chainInvoiceStatus: "PAID",
        conditionStage: null,
      });

      expect(status.label).toBe("Paid");
      expect(status.settled).toBe(true);
    }
  });

  it("can NEVER read Rejected because a new payment attempt was rejected", () => {
    // The invariant, stated as the single assertion worth failing a build on.
    for (const conditionStage of ["RELEASED", null] as const) {
      for (const finalOutcome of OUTCOMES) {
        const status = describeInvoiceStatus({
          runStatus: "ANALYZED",
          finalOutcome,
          chainInvoiceStatus: "PAID",
          conditionStage,
        });

        expect(status.label.toLowerCase()).not.toContain("reject");
        expect(status.label.toLowerCase()).not.toContain("blocked");
        expect(status.tone).not.toBe("negative");
      }
    }
  });

  it("prefers Payment released over Paid for a conditional invoice", () => {
    // Both are true. The first says the escrow condition was satisfied, which
    // is the thing the mechanism exists to demonstrate.
    const status = describeInvoiceStatus({
      chainInvoiceStatus: "PAID",
      conditionStage: "RELEASED",
      finalOutcome: "REJECTED",
    });

    expect(status.label).toBe("Payment released");
  });

  it("still reads Paid from a local receipt when the chain read fails", () => {
    const status = describeInvoiceStatus({
      runStatus: "PAID",
      chainInvoiceStatus: null,
      finalOutcome: "REJECTED",
      hasReceipt: true,
    });

    expect(status.label).toBe("Paid");
    expect(status.settled).toBe(true);
  });
});

describe("an unsettled invoice", () => {
  it("reads Payment held for a held escrow", () => {
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "EXECUTED",
      chainInvoiceStatus: "ESCROWED",
      conditionStage: "HELD",
    });

    expect(status.label).toBe("Payment held");
    expect(status.tone).toBe("warning");
    expect(status.settled).toBe(false);
  });

  it("does not read an escrowed invoice as paid", () => {
    // The treasury has parted with the money and the supplier does not have it.
    for (const stage of ["ESCROWED", "PROOF_SUBMITTED", "HELD"] as const) {
      const status = describeInvoiceStatus({
        chainInvoiceStatus: "ESCROWED",
        conditionStage: stage,
        finalOutcome: "EXECUTED",
      });

      expect(status.settled).toBe(false);
      expect(status.label.toLowerCase()).not.toContain("paid");
      expect(status.label.toLowerCase()).not.toContain("released");
    }
  });

  it("reads Awaiting approval above the autonomous limit", () => {
    for (const finalOutcome of ["HUMAN_REVIEW", "AWAITING_APPROVAL"] as const) {
      const status = describeInvoiceStatus({
        runStatus: "ANALYZED",
        finalOutcome,
        chainInvoiceStatus: "PENDING",
      });

      expect(status.label).toBe("Awaiting approval");
      expect(status.tone).toBe("warning");
    }
  });

  it("reads Ready to execute for an authorized autonomous payment", () => {
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "EXECUTED",
      chainInvoiceStatus: "PENDING",
    });

    // Authorized, not executed: no transaction exists yet.
    expect(status.label).toBe("Authorized · ready");
    expect(status.settled).toBe(false);
  });

  it("reads Rejected for a rejection that never paid", () => {
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "REJECTED",
      chainInvoiceStatus: "PENDING",
    });

    expect(status.label).toBe("Payment rejected");
    expect(status.tone).toBe("negative");
    expect(status.settled).toBe(false);
  });

  it("reads Would be blocked by Sui when the preflight refused the payment", () => {
    const status = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: "SUI_REJECT",
      chainInvoiceStatus: "PENDING",
    });

    // Not "Blocked on chain": SUI_REJECT is the verdict of the policy mirror
    // and the preflight. No transaction was submitted, so nothing on chain
    // blocked anything.
    expect(status.label).toBe("Would be blocked by Sui");
  });
});

describe("run progress still shows through", () => {
  it("reports an in-flight payment", () => {
    const status = describeInvoiceStatus({ runStatus: "EXECUTING", chainInvoiceStatus: "PENDING" });
    expect(status.label).toBe("Executing");
    expect(status.pulse).toBe(true);
  });

  it("reports analysis states before any outcome exists", () => {
    expect(describeInvoiceStatus({ runStatus: "ANALYZING" }).label).toBe("Analyzing");
    expect(describeInvoiceStatus({ runStatus: "DETECTED" }).label).toBe("Detected");
    expect(describeInvoiceStatus({ runStatus: "FAILED" }).label).toBe("Analysis failed");
    expect(describeInvoiceStatus({}).label).toBe("Detected");
  });

  it("does not let an in-flight run hide a settled invoice", () => {
    // Settlement outranks progress: a stale EXECUTING run must not mask that
    // the payment already landed.
    const status = describeInvoiceStatus({
      runStatus: "EXECUTING",
      chainInvoiceStatus: "PAID",
    });

    expect(status.label).toBe("Paid");
  });
});

describe("the badge and the outcome box agree", () => {
  it("uses one definition of settled on chain", async () => {
    // Both import `isPaidOnChain` from the same module, so a change to what
    // counts as settled cannot reach one surface and not the other.
    const { isPaidOnChain } = await import("../../lib/payments/availableAction");

    for (const status of ["PAID", "SETTLED"]) {
      expect(isPaidOnChain(status)).toBe(true);
      expect(describeInvoiceStatus({ chainInvoiceStatus: status }).settled).toBe(true);
    }
    for (const status of ["PENDING", "APPROVED", "ESCROWED", "UNKNOWN", null]) {
      expect(isPaidOnChain(status)).toBe(false);
      expect(describeInvoiceStatus({ chainInvoiceStatus: status }).settled).toBe(false);
    }
  });
});
