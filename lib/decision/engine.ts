/**
 * The decision engine.
 *
 *   live chain snapshot
 *          ↓
 *   deterministic facts        supplier, authority, cash flow, risk
 *          ↓
 *   deterministic CEILING      the most permissive action the rules allow
 *          ↓
 *   explainer (LLM)            chooses within that, and writes the prose
 *          ↓
 *   guard                      clamps to the ceiling, validates the date
 *          ↓
 *   PaymentDecision            a recommendation — never authority
 *
 * The guard is monotonic in one direction only: an explainer may be more
 * cautious than the ceiling, never less. So a model that hallucinates PAY_NOW
 * on a revoked supplier produces REJECT, and the worst a broken explainer can
 * do is be needlessly careful.
 *
 * Read-only throughout. Nothing here builds, signs or submits a transaction —
 * and Move re-derives every constraint again at execution regardless.
 */

import type { IsoDate } from "../types";
import type { ChainInvoice, ChainSnapshot } from "../sui/chainTypes";
import { daysBetween } from "../util/date";
import { DEMO_AS_OF_DATE } from "../demo/clock";
import { evaluateAuthority } from "./authority";
import { analyseCashFlow } from "./cashFlow";
import { deterministicExplainer, preferredOption, type DecisionExplainer } from "./explain";
import { evaluateRisk, evaluateSupplier, hasBlockingRisk } from "./risk";
import {
  moreCautious,
  type DecisionAction,
  type DecisionFacts,
  type ExplanationSource,
  type PaymentDecision,
} from "./types";

export interface DecisionInput {
  snapshot: ChainSnapshot;
  invoice: ChainInvoice;
  /** The "today" of this run. Injected so a decision is reproducible;
   *  defaults to the demo clock, never to the system date. */
  asOf?: IsoDate;
  explainer?: DecisionExplainer;
}

/**
 * The demo clock, never the host machine's. A decision opened on a judge's
 * laptop in another timezone must match the one rehearsed on demo day.
 */
function todayIso(): IsoDate {
  return DEMO_AS_OF_DATE;
}

/**
 * The most permissive action the rules permit, computed with no model involved.
 *
 * Read top to bottom: a blocking risk settles it; otherwise authority decides
 * whether a human is needed; otherwise liquidity decides whether today works.
 */
export function deterministicCeiling(facts: Omit<DecisionFacts, "ceiling" | "selectableDates">): DecisionAction {
  if (hasBlockingRisk(facts.risks)) return "REJECT";
  if (!facts.authority.withinAutonomousAuthority) return "HUMAN_APPROVAL";
  // A blocking NO_SAFE_PAYMENT_DATE would already have returned REJECT, so
  // reaching here with today unusable means a later date does work.
  if (facts.cashFlow.today.breachesReserveImmediately) return "SCHEDULE";
  return "PAY_NOW";
}

export function buildDecisionFacts(input: DecisionInput): DecisionFacts {
  const asOf = input.asOf ?? todayIso();
  const { snapshot, invoice } = input;

  const supplier = evaluateSupplier(invoice, snapshot.suppliers);
  const authority = evaluateAuthority(invoice.amountCents, snapshot.treasury, snapshot.agent);
  const cashFlow = analyseCashFlow({
    asOf,
    balanceCents: snapshot.treasury.balanceCents,
    minimumReserveCents: snapshot.treasury.minimumReserveCents,
    amountCents: invoice.amountCents,
    dueDate: invoice.dueDate,
    events: snapshot.cashFlowEvents,
  });
  const risks = evaluateRisk({
    asOf,
    invoice,
    treasury: snapshot.treasury,
    supplier,
    authority,
    cashFlow,
  });

  const daysUntilDue = daysBetween(asOf, invoice.dueDate);
  const partial = {
    asOf,
    invoiceNumber: invoice.invoiceNumber,
    invoiceObjectId: invoice.objectId,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    daysUntilDue,
    isOverdue: daysUntilDue < 0,
    alreadyPaid: invoice.status === "PAID",
    supplier,
    authority,
    cashFlow,
    risks,
  };

  const ceiling = deterministicCeiling(partial);

  return {
    ...partial,
    ceiling,
    // Only dates the chain would actually accept. Offering one it will refuse
    // would be inviting the model to recommend a payment doomed to abort.
    selectableDates:
      ceiling === "REJECT"
        ? []
        : cashFlow.candidates
            .filter((option) => !option.breachesReserveImmediately)
            .map((option) => option.date),
  };
}

export async function decidePayment(input: DecisionInput): Promise<PaymentDecision> {
  const facts = Object.freeze(buildDecisionFacts(input));
  const explainer = input.explainer ?? deterministicExplainer;

  let raw;
  let usedFallback = false;
  let failure: string | null = null;
  try {
    raw = await explainer.explain(facts);
  } catch (error) {
    // An unreachable model must never widen what is allowed, so the fallback
    // is the deterministic explainer rather than a default of PAY_NOW. The
    // failure is RECORDED rather than swallowed — the interface needs it for
    // an "Engine details" disclosure — but it never becomes a reason, because
    // an HTTP status is not a fact about the invoice.
    raw = await deterministicExplainer.explain(facts);
    usedFallback = true;
    failure = error instanceof Error ? error.message : String(error);
  }

  // --- the guard ------------------------------------------------------------
  const action = moreCautious(raw.action, facts.ceiling);
  const clampedToCeiling = action !== raw.action;

  const fallbackOption = preferredOption(facts);
  const requestedDate = raw.recommendedDate;
  // A date the model invented, or one the chain would refuse, is discarded
  // rather than corrected — the acceptable set was given to it explicitly.
  const dateIsSelectable = requestedDate !== null && facts.selectableDates.includes(requestedDate);

  let recommendedPaymentDate: IsoDate | null = null;
  if (action !== "REJECT") {
    recommendedPaymentDate = dateIsSelectable ? requestedDate : (fallbackOption?.date ?? null);
    // PAY_NOW means today, by definition. A later date makes it a SCHEDULE.
    if (action === "PAY_NOW") recommendedPaymentDate = facts.asOf;
  }

  const option =
    facts.cashFlow.candidates.find((entry) => entry.date === recommendedPaymentDate) ??
    fallbackOption;

  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;

  return {
    decision: action,
    confidence,
    reasons: raw.reasons.filter((reason) => reason.trim().length > 0).slice(0, 8),
    risks: [...facts.risks],
    recommendedPaymentDate,
    projectedBalanceAfterPayment:
      option?.balanceAfterPaymentCents ?? facts.cashFlow.openingBalanceCents,
    authorityStatus: facts.authority.status,
    requiresHumanApproval: facts.authority.requiresHumanApproval,
    deterministicCeiling: facts.ceiling,
    clampedToCeiling,
    engine: explainer.id === "llm" && !usedFallback ? "LLM" : "DETERMINISTIC",
    explanationSource: describeExplanationSource(explainer.id, usedFallback, failure),
    explanation: raw.explanation,
    facts,
  };
}

/**
 * Turns "what wrote the prose" into something safe to put on screen.
 *
 * The label never claims a model ran when one did not, and the raw failure is
 * kept apart from the human-readable reason so a panel can show one and hide
 * the other.
 */
export function describeExplanationSource(
  explainerId: "llm" | "deterministic",
  usedFallback: boolean,
  failure: string | null,
): ExplanationSource {
  if (explainerId === "deterministic") {
    return {
      kind: "DETERMINISTIC",
      label: "Deterministic engine",
      reason: null,
      detail: null,
    };
  }
  if (!usedFallback) {
    return { kind: "LLM", label: "Workers AI", reason: null, detail: null };
  }
  return {
    kind: "DETERMINISTIC_FALLBACK",
    label: "Deterministic fallback · AI explanation unavailable",
    reason: humaniseFailure(failure),
    detail: failure,
  };
}

/** One readable sentence. The raw text stays in `detail`. */
function humaniseFailure(raw: string | null): string {
  if (!raw) return "The explanation model did not return a usable answer.";
  if (/daily free allocation|neurons/i.test(raw)) {
    return "The Workers AI account has used its daily allocation.";
  }
  if (/429|rate limit/i.test(raw)) return "Workers AI is rate limiting requests.";
  if (/40[13]/.test(raw)) return "Workers AI rejected the credentials.";
  if (/5\d\d/.test(raw)) return "Workers AI returned a server error.";
  if (/abort|timeout/i.test(raw)) return "The model did not respond in time.";
  if (/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN/i.test(raw)) {
    return "Workers AI credentials are not configured.";
  }
  return "Workers AI could not be reached.";
}

/** Convenience: decide for every seeded invoice in a snapshot. */
export async function decideAll(
  snapshot: ChainSnapshot,
  options: { asOf?: IsoDate; explainer?: DecisionExplainer } = {},
): Promise<PaymentDecision[]> {
  return Promise.all(
    snapshot.invoices.map((invoice) =>
      decidePayment({ snapshot, invoice, asOf: options.asOf, explainer: options.explainer }),
    ),
  );
}
