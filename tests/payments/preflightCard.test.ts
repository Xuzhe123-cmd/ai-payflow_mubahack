/**
 * The SUI PREFLIGHT card for the $30,000 invoice.
 *
 * WHAT IT REPLACED. "No payment request was created, so nothing was submitted
 * to the treasury contract." True, and useless: it named no rule, no limit and
 * no amount, so a reader learned only that something had not happened. The card
 * now reports the verdict — which rule spoke, what it compared, and what it
 * would do.
 *
 * THE LINE IT MUST HOLD. A preflight asks Sui to evaluate the real
 * `approval::approve_scoped` against real treasury state without executing it.
 * That is genuinely stronger than a frontend limit check, and genuinely weaker
 * than a submitted transaction. "Sui WOULD reject this approval" is the only
 * phrasing that is true of both halves — "Sui rejected it" claims an event that
 * never occurred, and calling it a frontend check undersells the actual Move
 * rule being run.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { approvalAbortFor, formatAbort } from "../../lib/sui/moveAborts";

const CARD = readFileSync(
  resolve(process.cwd(), "components/payments/DecisionChain.tsx"),
  "utf8",
);

/**
 * The card's markup, with comments stripped and whitespace collapsed.
 *
 * Collapsed because JSX wraps prose across source lines and the browser joins
 * it back into one sentence. Matching the raw source would miss a phrase that
 * renders perfectly well, and would also pass a phrase broken so badly it
 * renders wrong — so the test reads what the reader reads.
 */
const rendered = CARD.slice(
  CARD.indexOf("function PreflightRefusal"),
  CARD.indexOf("function SafetyBlock"),
)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\s+/g, " ");

describe("the preflight card says what it is", () => {
  it("uses the conditional, not the past tense", () => {
    expect(rendered).toContain("Sui would reject this approval");
  });

  it("labels itself a preflight with nothing submitted", () => {
    expect(rendered).toContain("Preflight check · no transaction submitted");
  });

  it("shows the limit and the request side by side", () => {
    expect(rendered).toContain("Authorization limit");
    expect(rendered).toContain("Requested");
  });

  it("states plainly that nothing happened", () => {
    expect(rendered).toContain("No transaction was submitted");
    expect(rendered).toContain("No funds moved");
  });

  it("credits the real Move rule rather than a frontend limit", () => {
    expect(rendered).toContain("The real Move authorization rule rejects this amount");
    expect(rendered).toContain("not a limit enforced in this interface");
    expect(rendered).toContain("approval::approve_scoped");
  });

  it.each([
    "sui rejected",
    "rejected on chain",
    "refused on chain",
    "transaction failed",
    "payment failed",
  ])('never claims "%s"', (banned) => {
    expect(rendered.toLowerCase()).not.toContain(banned);
  });

  it("no longer says a payment request was not created", () => {
    // The replaced wording, gone from the whole file.
    expect(CARD).not.toContain("No payment request was created");
  });
});

describe("the abort code is derived from the Move source, not typed into JSX", () => {
  it("renders the constant through the shared mapping", () => {
    expect(rendered).toContain("formatAbort(abort)");
    expect(rendered).toContain("approvalAbortFor");
  });

  it("maps an over-limit amount to 601 EAboveApproverLimit", () => {
    const abort = approvalAbortFor("EXCEEDS_MAX_PAYMENT");
    expect(abort).not.toBeNull();
    expect(formatAbort(abort!)).toBe("601 — EAboveApproverLimit");
    expect(abort!.location).toBe("approval::approve_scoped");
  });

  it("matches the constants the Move source actually declares", () => {
    const source = readFileSync(
      resolve(process.cwd(), "move/payflow/sources/approval.move"),
      "utf8",
    );
    for (const code of [
      "EXCEEDS_MAX_PAYMENT",
      "EXCEEDS_DAILY_LIMIT",
      "RECIPIENT_WALLET_MISMATCH",
      "AGENT_NOT_AUTHORIZED",
      "CAPABILITY_DISABLED",
    ] as const) {
      const abort = approvalAbortFor(code)!;
      expect(source, `${abort.name} must exist in approval.move`).toContain(
        `const ${abort.name}: u64 = ${abort.code};`,
      );
    }
  });

  it("returns null for checks the approval path does not enforce", () => {
    // These abort later, in payment::evaluate. Rendering an approval-path code
    // beside them would attribute the refusal to the wrong Move function.
    for (const code of [
      "SUPPLIER_NOT_APPROVED",
      "CURRENCY_NOT_ALLOWED",
      "INSUFFICIENT_RESERVE",
      "INVOICE_ALREADY_PAID",
      "RECOMMENDATION_EXPIRED",
    ] as const) {
      expect(approvalAbortFor(code)).toBeNull();
    }
  });

  it("omits the abort line rather than inventing one", () => {
    expect(rendered).toContain("{abort ?");
  });
});

describe("the card is reached from the approval's own verdict", () => {
  it("renders when the human-approval preflight came back SUI_REJECT", () => {
    const block = CARD.slice(CARD.indexOf("function SafetyBlock"));
    expect(block).toContain('approvalPreflight?.enforcement.outcome === "SUI_REJECT"');
    expect(block).toContain("<PreflightRefusal approval={approvalPreflight} />");
  });

  it("reads the failed check rather than hardcoding an amount", () => {
    expect(rendered).toContain("checks.find((check) => !check.passed)");
    expect(rendered).not.toContain("$25,000");
    expect(rendered).not.toContain("$30,000");
  });
});
