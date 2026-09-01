/**
 * The human-approval state machine, in the order a judge sees it.
 *
 * THE POINT THE ORDER MAKES. Sui's decisive check happens when the HUMAN
 * attempts to approve — not on page load. Showing "WOULD BE REFUSED BY SUI"
 * before anyone has attempted anything tells the wrong story twice over: it
 * implies an approval was tried and refused, and it hides the moment that
 * actually demonstrates the security boundary.
 *
 *   before the click   amber — human approval required, agent lacks authority
 *   during the click   Sui preflight running
 *   after the click    the chain's own verdict, whichever way it went
 *
 * WHAT MUST NEVER HAPPEN. The frontend comparing $30,000 > $25,000 and
 * presenting that as a Sui result. The local explanation before the click is
 * fine — it is about the AGENT's $5,000 limit, a fact the pipeline established.
 * The refusal after the click must come from the real preflight.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { availablePaymentAction } from "../../lib/payments/availableAction";
import { decideAutonomy } from "../../lib/payments/autonomy";
import { APPROVER_AUTHORITY } from "../../lib/demo/policies";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const approval = code("components/payments/HumanApproval.tsx");
const chain = code("components/payments/DecisionChain.tsx");

// --- before the click ----------------------------------------------------------

describe("before the human attempts approval", () => {
  it("asks for a human rather than reporting a refusal", () => {
    const rendered = approval.replace(/\s+/g, " ");
    expect(rendered).toContain("Human approval required");
    expect(rendered).toContain("Awaiting an operator");
    expect(rendered).toContain(
      "the AI agent is not authorized to execute it autonomously",
    );
  });

  it("is amber, not a red refusal", () => {
    // The ask sits in warn-soft; only the chain's own verdict may be negative.
    // Checked as the container/eyebrow PAIR, so it cannot pass on an amber
    // container that wraps something else.
    const rendered = approval.replace(/\s+/g, " ");
    expect(rendered).toContain(
      '<div className="rounded-xl border border-warn/35 bg-warn-soft p-4"> ' +
        '<Eyebrow className="text-warn">Human approval required</Eyebrow>',
    );
    // And the ask carries no refusal wording at all.
    const ask = rendered.slice(rendered.lastIndexOf("Human approval required"));
    expect(ask).not.toContain("WOULD BE REFUSED");
    expect(ask).not.toContain("EAboveApproverLimit");
  });

  it("explains the AGENT's limit, which is a pipeline fact, not a Sui verdict", () => {
    // Naming the agent's own cap before the click is legitimate: it is why a
    // human is being asked at all. It is not presented as Sui's answer.
    expect(approval).toContain('<Line label="Agent limit"');
    expect(approval).toContain("policy.maxSinglePaymentCents");
  });

  it("shows the chain's verdict ONLY once an approval exists", () => {
    // `enforcement` here is run.approval.enforcement, which the provider sets
    // when the operator clicks — never on load.
    expect(approval).toContain("if (enforcement) {");
    const verdict = approval.slice(approval.indexOf("if (enforcement) {"));
    expect(verdict).toContain('enforcement.outcome === "APPROVED"');
  });

  it("gates the preflight card on the approval, not on the analysis", () => {
    // The SUI PREFLIGHT refusal card renders from run.approval, so it cannot
    // appear before somebody attempted to approve.
    expect(chain).toContain("const approvalPreflight = entry.run?.approval ?? null;");
    expect(chain).toContain(
      'approvalPreflight?.enforcement.outcome === "SUI_REJECT"',
    );
  });
});

// --- during the click ----------------------------------------------------------

describe("while Sui is being asked", () => {
  const rendered = approval.replace(/\s+/g, " ");

  it("shows a visible preflight step", () => {
    // A button label alone made the verdict look instantaneous, as though it
    // had been decided before the click.
    expect(approval).toContain("if (working) {");
    expect(rendered).toContain("Checking authorization with Sui…");
  });

  it("names the real Move function being asked", () => {
    expect(rendered).toContain("approval::approve_scoped");
    expect(rendered).toContain("against the live Chain-Doi authorization");
  });

  it("says nothing has been submitted yet", () => {
    expect(rendered).toContain("Nothing has been submitted");
    expect(rendered).toContain("no");
    expect(rendered).toContain("HumanApproval");
  });
});

// --- after the click -----------------------------------------------------------

describe("the verdict the chain returns", () => {
  const overLimit = availablePaymentAction({
    autonomy: decideAutonomy({
      action: "SCHEDULE",
      finalOutcome: "AWAITING_APPROVAL",
      hasPaymentRequest: true,
      enforcement: { outcome: "APPROVED" },
      conditional: false,
    }),
    conditionStage: null,
    fundsHeldCents: 0,
    amountCents: 3_000_000,
    chainInvoiceStatus: "PENDING",
    runStatus: "ANALYZED",
    hasReceipt: false,
    humanApproval: { outcome: "SUI_REJECT" },
  });

  it("reports a refusal as conditional, with nothing submitted", () => {
    expect(overLimit.headline).toBe("WOULD BE REFUSED BY SUI");
    expect(overLimit.facts).toContain("No transaction was submitted");
    expect(overLimit.facts).toContain("No funds moved");
    expect(overLimit.detail).toContain("No human approval transaction was submitted");
  });

  it("offers no payment control after a refusal", () => {
    expect(overLimit.action).toBe("NONE");
    expect(overLimit.label).toBeNull();
  });
});

// --- the boundary the demo exists to show --------------------------------------

describe("$30,000 against a $25,000 authorization", () => {
  it("keeps the approver ceiling where it is", () => {
    // The demo depends on this being real, not staged.
    expect(APPROVER_AUTHORITY.maxSinglePaymentCents).toBe(2_500_000);
    expect(APPROVER_AUTHORITY.dailyLimitCents).toBe(5_000_000);
  });

  it("maps an over-ceiling approval to the Move constant", async () => {
    const { approvalAbortFor, formatAbort } = await import("../../lib/sui/moveAborts");
    const abort = approvalAbortFor("EXCEEDS_MAX_PAYMENT")!;
    expect(formatAbort(abort)).toBe("601 — EAboveApproverLimit");
    expect(abort.location).toBe("approval::approve_scoped");
  });

  it("never lets the interface compute the refusal itself", () => {
    // The forbidden shortcut: comparing the amount to the ceiling in the UI and
    // presenting the result as Sui's answer.
    for (const file of [approval, chain]) {
      expect(file).not.toMatch(/amountCents\s*>\s*.*maxSingle/);
      expect(file).not.toMatch(/>\s*2_?500_?000/);
    }
    // The verdict is read off the enforcement the approval carried back.
    expect(chain).toContain("checks.find((check) => !check.passed)");
  });

  it("$14,700 stays inside the same ceiling", () => {
    // The successful path must remain reachable, or the demo only shows refusal.
    expect(1_470_000).toBeLessThan(APPROVER_AUTHORITY.maxSinglePaymentCents);
    expect(3_000_000).toBeGreaterThan(APPROVER_AUTHORITY.maxSinglePaymentCents);
  });
});
