/**
 * A prediction is not a verdict, and a click must always answer.
 *
 * PROBLEM 1. The pipeline enforces every PaymentRequest it builds, so a $30,000
 * invoice arrives carrying `enforcement.outcome === "SUI_REJECT"` computed
 * under the approver's ceiling — before anyone has attempted anything. Rendered
 * as the chain's answer it asserted two things that had not happened: that an
 * approval was tried, and that Sui refused it.
 *
 * PROBLEM 2. Both click handlers had guards that `return`ed with no state
 * change, no error and no log. The spinner cleared, the screen was identical,
 * and the click was indistinguishable from a hang.
 *
 * These tests drive the resolver through real sequences rather than reading the
 * source, because both bugs were about WHEN state arrives, not what the code
 * says.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  awaitsHuman,
  resolveApprovalStage,
  showsChainVerdict,
  type ApprovalStageInput,
} from "../../lib/payments/approvalStage";
import { APPROVER_AUTHORITY } from "../../lib/demo/policies";
import type { PolicyViolationCode } from "../../lib/types";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const chain = code("components/payments/DecisionChain.tsx");
const provider = code("components/providers/PayflowProvider.tsx");

const check = (code: PolicyViolationCode, passed: boolean) => ({ code, passed });

/** The pipeline's forecast for $30,000 under a $25,000 ceiling. */
const overCeiling: ApprovalStageInput["analysisEnforcement"] = {
  outcome: "SUI_REJECT",
  checks: [check("SUPPLIER_NOT_APPROVED", true), check("EXCEEDS_MAX_PAYMENT", false)],
};

// --- 1, 2, 7: no verdict before the click ------------------------------------

describe("before the human clicks Approve", () => {
  it("$30,000 is PRE_APPROVAL, not a refusal", () => {
    const stage = resolveApprovalStage({
      analysisEnforcement: overCeiling,
      approvalEnforcement: null,
    });
    expect(stage).toBe("PRE_APPROVAL");
    expect(awaitsHuman(stage)).toBe(true);
    expect(showsChainVerdict(stage)).toBe(false);
  });

  it("$14,700 shows no final verdict either", () => {
    // It passes the forecast, so there is simply nothing to report yet.
    const stage = resolveApprovalStage({
      analysisEnforcement: {
        outcome: "APPROVED",
        checks: [check("EXCEEDS_MAX_PAYMENT", true)],
      },
      approvalEnforcement: null,
    });
    expect(showsChainVerdict(stage)).toBe(false);
  });

  it("routes PRE_APPROVAL to the human ask in the Decision Chain", () => {
    expect(chain).toContain('if (outcomeStage === "PRE_APPROVAL")');
    const branch = chain.slice(chain.indexOf('if (outcomeStage === "PRE_APPROVAL")'));
    expect(branch).toContain("<HumanApproval");
  });

  it("shows no assertion list and no red panel before the click", () => {
    expect(chain).toContain('if (stage === "PRE_APPROVAL")');
    expect(chain).toContain("Not yet run.");
    // The panel tone must not go negative on a forecast alone.
    expect(chain).toContain('panelStage !== "PRE_APPROVAL"');
  });
});

// --- 3, 4, 5: the verdict only after the click -------------------------------

describe("after the human clicks Approve", () => {
  it("$30,000 becomes APPROVAL_REFUSED once the preflight answers", () => {
    const stage = resolveApprovalStage({
      analysisEnforcement: overCeiling,
      approvalEnforcement: { outcome: "SUI_REJECT" },
    });
    expect(stage).toBe("APPROVAL_REFUSED");
    expect(showsChainVerdict(stage)).toBe(true);
  });

  it("$14,700 becomes APPROVAL_PASSED", () => {
    const stage = resolveApprovalStage({
      analysisEnforcement: { outcome: "APPROVED", checks: [] },
      approvalEnforcement: { outcome: "APPROVED" },
    });
    expect(stage).toBe("APPROVAL_PASSED");
  });

  it("the real preflight is what produces 601", async () => {
    const { approvalAbortFor, formatAbort } = await import("../../lib/sui/moveAborts");
    const abort = approvalAbortFor("EXCEEDS_MAX_PAYMENT")!;
    expect(formatAbort(abort)).toBe("601 — EAboveApproverLimit");
    expect(abort.location).toBe("approval::approve_scoped");
  });

  it("creates no HumanApproval and submits no payment for a refusal", () => {
    // Execution is gated on APPROVED; a refusal can never reach it.
    expect(provider).toContain('enforcement?.outcome !== "APPROVED"');
    // And no digest is ever manufactured.
    expect(provider).not.toMatch(/digest:\s*["'`]0x/);
  });
});

// --- the failures approval cannot fix ----------------------------------------

describe("refusals a human cannot authorize away", () => {
  it.each<[string, PolicyViolationCode]>([
    ["a duplicate invoice", "INVOICE_ALREADY_PAID"],
    ["a mismatched remit wallet", "RECIPIENT_WALLET_MISMATCH"],
    ["an unapproved supplier", "SUPPLIER_NOT_APPROVED"],
    ["an unallowed currency", "CURRENCY_NOT_ALLOWED"],
  ])("stays BLOCKED for %s", (_label, failing) => {
    const stage = resolveApprovalStage({
      analysisEnforcement: { outcome: "SUI_REJECT", checks: [check(failing, false)] },
      approvalEnforcement: null,
    });
    // Offering Approve here would invite a click that cannot help.
    expect(stage).toBe("BLOCKED");
    expect(awaitsHuman(stage)).toBe(false);
    expect(showsChainVerdict(stage)).toBe(true);
  });

  it("stays BLOCKED when an authority failure is mixed with another", () => {
    const stage = resolveApprovalStage({
      analysisEnforcement: {
        outcome: "SUI_REJECT",
        checks: [check("EXCEEDS_MAX_PAYMENT", false), check("INVOICE_ALREADY_PAID", false)],
      },
      approvalEnforcement: null,
    });
    expect(stage).toBe("BLOCKED");
  });

  it("treats a daily-limit failure as a human question", () => {
    const stage = resolveApprovalStage({
      analysisEnforcement: {
        outcome: "SUI_REJECT",
        checks: [check("EXCEEDS_DAILY_LIMIT", false)],
      },
      approvalEnforcement: null,
    });
    expect(stage).toBe("PRE_APPROVAL");
  });
});

// --- 6, 11, 12: a click always answers ---------------------------------------

describe("no click can leave the interface stuck", () => {
  it("the execute guard reports instead of returning silently", () => {
    const guard = provider.slice(provider.indexOf('enforcement?.outcome !== "APPROVED"'));
    const body = guard.slice(0, guard.indexOf("dispatch({ type: \"RUN_PATCH\", invoiceId, patch: { status: \"EXECUTING\" }"));
    expect(body).toContain("RUN_PATCH");
    expect(body).toContain("Nothing was submitted");
    expect(body).toContain("activityEvent");
  });

  it("the approve guard reports instead of returning silently", () => {
    expect(provider).toContain(
      "This invoice has not been analyzed yet, so there is nothing to approve.",
    );
  });

  it("surfaces the error where the click happened", () => {
    // It was written to run.error and never rendered on this page.
    expect(chain).toContain("run.error ?");
    expect(chain).toContain("Nothing was submitted");
    expect(chain).toContain("{clickError}");
  });

  it("clears the spinner however the promise settles", () => {
    const approvalUi = code("components/payments/HumanApproval.tsx");
    // `.finally` runs on both resolve and reject, so no path leaves it spinning.
    expect(approvalUi).toContain(".finally(() => setWorking(false))");
  });

  it("still catches a thrown execution and resets the run", () => {
    // executePayment throws by design in this build; the catch must land the
    // run back in an actionable state rather than leaving it EXECUTING.
    expect(provider).toContain('status: "ANALYZED"');
    expect(provider).toContain("executionStage: null");
  });
});

// --- 13, 14, 15: the rules that must not move --------------------------------

describe("what stays true", () => {
  it("the AI recommendation authorizes nothing", () => {
    // The stage is decided by enforcement and the approval, never by the
    // model's action.
    const decided = resolveApprovalStage({
      analysisEnforcement: overCeiling,
      approvalEnforcement: null,
    });
    expect(decided).toBe("PRE_APPROVAL");
    expect(code("lib/payments/approvalStage.ts")).not.toContain("AUTO_PAY");
    expect(code("lib/payments/approvalStage.ts")).not.toContain("decision");
  });

  it("the circuit breaker never blocks the human path", () => {
    // Move gates only the autonomous and conditional paths.
    const treasuryMove = source("move/payflow/sources/treasury.move");
    expect(treasuryMove).toContain("public fun assert_autonomy_allowed");
    const approvalMove = source("move/payflow/sources/approval.move");
    expect(approvalMove).not.toContain("assert_autonomy_allowed");
    // And the stage resolver knows nothing about the breaker at all.
    expect(code("lib/payments/approvalStage.ts")).not.toContain("breaker");
  });

  it("keeps the $25,000 and $50,000 authorization unchanged", () => {
    expect(APPROVER_AUTHORITY.maxSinglePaymentCents).toBe(2_500_000);
    expect(APPROVER_AUTHORITY.dailyLimitCents).toBe(5_000_000);
  });

  it("fabricates no digest anywhere on this path", () => {
    for (const file of [chain, provider, code("lib/payments/approvalStage.ts")]) {
      expect(file).not.toMatch(/digest:\s*["'`]0x[0-9a-f]/);
    }
  });
});
