/**
 * The S2 $30,000 scenario must never claim something happened that did not.
 *
 * WHAT WENT WRONG. The outcome card for INV-2026-3461 read:
 *
 *   "A human approved this, and the chain still refused it."
 *
 * Two events, neither of which occurred. No approval transaction was
 * submitted, so no `HumanApproval` object was minted, nothing was signed, and
 * nothing on chain refused anything. The verdict is a PREDICTION — the policy
 * mirror and a Sui preflight of `approval::approve_scoped`, which would abort
 * `601 EAboveApproverLimit` against the live $25,000 Chain-Doi authorization.
 *
 * A reader who saw that sentence would reasonably conclude a payment had been
 * attempted and failed. It had not been attempted at all.
 *
 * WHY THIS TEST READS SOURCE. There is no DOM harness here, and the sentence
 * lived in a component rather than in a tested rule — which is exactly how it
 * survived the previous wording pass. So every surface that renders this state
 * is scanned: the two components and the shared action rule behind them. A
 * banned phrase reappearing anywhere fails the build.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { availablePaymentAction } from "../../lib/payments/availableAction";
import { decideAutonomy } from "../../lib/payments/autonomy";

/** Every file that renders or derives the S2 preflight verdict. */
const SURFACES = [
  "components/payments/DecisionChain.tsx",
  "components/payments/HumanApproval.tsx",
  "lib/payments/availableAction.ts",
] as const;

/**
 * Phrases that assert an event.
 *
 * Each claims either that a person approved, that a transaction reached the
 * network, or that the chain acted. None is true of a preflight.
 */
const BANNED = [
  "human approved",
  "approved this",
  "refused on chain",
  "rejected on chain",
] as const;

function sourceOf(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

/**
 * Source with `//` and `/* *\/` comments stripped.
 *
 * The bug is what a READER sees. A comment explaining the banned phrase — of
 * which this codebase now has several, deliberately — must not fail the test,
 * and a comment is also not a defence for the phrase appearing in real text.
 */
function renderableText(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .toLowerCase();
}

describe("the S2 preflight card claims no event that did not happen", () => {
  it.each(SURFACES)("%s contains no phrase asserting an approval or a chain action", (file) => {
    const text = renderableText(file);
    for (const phrase of BANNED) {
      expect(text, `${file} must not say "${phrase}"`).not.toContain(phrase);
    }
  });

  it("never implies a transaction was submitted", () => {
    // "transaction submitted" is only permissible in the negative. Any
    // occurrence must be preceded by "no".
    for (const file of SURFACES) {
      const text = renderableText(file);
      let index = text.indexOf("transaction submitted");
      while (index !== -1) {
        const before = text.slice(Math.max(0, index - 4), index);
        expect(before, `${file}: "transaction submitted" must be negated`).toContain("no");
        index = text.indexOf("transaction submitted", index + 1);
      }
    }
  });
});

describe("the required preflight vocabulary is present", () => {
  const combined = SURFACES.map(renderableText).join("\n");

  it.each(["would be refused by sui", "preflight", "no transaction submitted", "no funds moved"])(
    'says "%s"',
    (phrase) => {
      expect(combined).toContain(phrase);
    },
  );
});

// --- the state itself, not just the words -----------------------------------

describe("the action state behind the card", () => {
  const state = availablePaymentAction({
    autonomy: decideAutonomy({
      action: "SCHEDULE",
      finalOutcome: "AWAITING_APPROVAL",
      hasPaymentRequest: true,
      enforcement: { outcome: "APPROVED" },
      conditional: false,
    }),
    conditionStage: null,
    fundsHeldCents: 0,
    // The S2 invoice: $30,000, above the $25,000 Chain-Doi authorization.
    amountCents: 3_000_000,
    chainInvoiceStatus: "PENDING",
    runStatus: "ANALYZED",
    hasReceipt: false,
    humanApproval: { outcome: "SUI_REJECT" },
  });

  it("headlines the prediction, not a rejection", () => {
    expect(state.headline).toBe("WOULD BE REFUSED BY SUI");
    expect(state.status).toBe("Would be refused by Sui");
    expect(state.lead).toBe("Preflight — nothing was submitted");
  });

  it("states plainly that nothing was submitted and nothing moved", () => {
    expect(state.facts).toContain("No transaction was submitted");
    expect(state.facts).toContain("No funds moved");
  });

  it("keeps the security claim about human approval", () => {
    const text = [state.detail, ...state.facts].join(" ");
    expect(text).toContain("Human approval does not bypass treasury policy");
    expect(state.detail).toContain("never the limit itself");
  });

  it("offers no payment control", () => {
    expect(state.action).toBe("NONE");
    expect(state.label).toBeNull();
  });

  it("asserts no approval was made", () => {
    // The positive form of the ban: the card must SAY the approval is absent,
    // not merely avoid claiming it happened.
    expect(state.detail).toContain("No human approval transaction was submitted");
  });
});
