/**
 * The word beside an invoice number.
 *
 * THE BUG THIS EXISTS TO FIX: a conditional invoice was settled — its escrow
 * released to the supplier — and its header badge read "Rejected". The badge was
 * derived from `finalOutcome`, which describes the AI pipeline's verdict on
 * paying the invoice NOW. For an invoice that has already been paid, that
 * verdict is necessarily a refusal, because paying it again would be a
 * duplicate. Rendered as the invoice's status, it says the opposite of what
 * happened to the money.
 *
 * Two different questions, and the badge answers the first:
 *
 *   1. WHAT HAPPENED TO THE MONEY?      settlement state — this badge
 *   2. WHAT IF SOMEONE PAYS IT AGAIN?   the guard's verdict — the decision chain
 *
 *   PAID / RELEASED → HELD / ESCROWED → pending & approval → AI recommendation
 *
 * Same precedence as `availablePaymentAction`, and deliberately the same
 * `isPaidOnChain` definition, so a header and an outcome box cannot disagree
 * about whether an invoice is settled.
 */

import { isPaidOnChain } from "./availableAction";
import type { EscrowDemoStage } from "../escrow/demoFlow";
import type { FinalOutcome, TreasuryAction } from "../types";

export type StatusTone = "neutral" | "ai" | "chain" | "warning" | "positive" | "negative";

/**
 * Which bucket of the invoice list this invoice belongs in.
 *
 * THE SECOND HALF OF THE SAME BUG. The badge was fixed to read "Payment
 * released" while the /invoices list went on filing the invoice under
 * "Rejected", because the list ran its own categorisation off `finalOutcome` —
 * a second status system, deriving a different answer from the same invoice.
 *
 * So the category is returned from HERE, by the same function and the same
 * precedence that produce the label. The list cannot disagree with the badge
 * because it is no longer allowed its own opinion: one call, one answer.
 */
export type InvoiceCategory =
  /** Settled on chain. The supplier has the money. */
  | "paid"
  /** Committed to escrow and not settled. Neither paid nor refused. */
  | "held"
  /** Waiting on a person. */
  | "review"
  /** Authorized or scheduled, and not yet settled. */
  | "scheduled"
  /** Refused BEFORE any payment. Never an invoice that has settled. */
  | "rejected"
  /** Nothing has concluded yet. */
  | "pending";

export interface InvoiceStatusDescriptor {
  label: string;
  tone: StatusTone;
  pulse?: boolean;
  /** True when the chain establishes that the supplier has the money. */
  settled: boolean;
  /** The list bucket. Always consistent with `label` — same rule, same call. */
  category: InvoiceCategory;
}

export interface InvoiceStatusInput {
  /** The local run's own status. */
  runStatus?: "DETECTED" | "ANALYZING" | "ANALYZED" | "EXECUTING" | "PAID" | "FAILED" | null;
  /** What the pipeline concluded. Advisory — consulted last. */
  finalOutcome?: FinalOutcome | null;
  /** The invoice object's own status on chain. */
  chainInvoiceStatus?: string | null;
  /** The escrow stage, or null when the invoice carries no shipment condition. */
  conditionStage?: EscrowDemoStage | null;
  /** A payment this session actually settled. */
  hasReceipt?: boolean;
  /**
   * Whether the chain reads have returned yet.
   *
   * Defaults to true, for callers that never consult the chain at all and want
   * the local run's own answer.
   *
   * A caller that DOES consult the chain must pass false while the read is in
   * flight, because the alternative is a lie told briefly: with
   * `chainInvoiceStatus` still null, a settled invoice falls through to the
   * recommendation — a refusal of a SECOND payment — and flashes "Rejected"
   * before the fetch lands. Brief is not harmless when that flash is the exact
   * mistake the rest of this file exists to prevent.
   */
  chainResolved?: boolean;
}

export function describeInvoiceStatus(input: InvoiceStatusInput): InvoiceStatusDescriptor {
  // ---- 1. Settled on chain -------------------------------------------------
  // Nothing below can contradict this, and an AI rejection least of all.

  if (input.conditionStage === "RELEASED") {
    // Preferred over "Paid" for a conditional invoice: it says the escrow
    // condition was satisfied, which is the whole point of the mechanism.
    return { label: "Payment released", tone: "positive", settled: true, category: "paid" };
  }

  if (isPaidOnChain(input.chainInvoiceStatus) || input.runStatus === "PAID" || input.hasReceipt) {
    return { label: "Paid", tone: "positive", settled: true, category: "paid" };
  }

  // ---- 2. Committed, not settled -------------------------------------------
  switch (input.conditionStage) {
    case "HELD":
    case "ESCROWED":
    case "PROOF_SUBMITTED":
      return { label: "Payment held", tone: "warning", settled: false, category: "held" };
    case "ATTESTED":
      // Releasable, and the funds have NOT reached the supplier. Held, not
      // paid — and emphatically not rejected.
      return { label: "Shipment confirmed", tone: "chain", settled: false, category: "held" };
    default:
      break;
  }

  // ---- 3. Nothing local proves settlement, and the chain has not answered ---
  // Better to say so than to answer from the recommendation and be wrong.
  if (input.chainResolved === false) {
    return { label: "Checking chain", tone: "neutral", pulse: true, settled: false, category: "pending" };
  }

  // ---- 4. The local run's own progress -------------------------------------
  switch (input.runStatus) {
    case "EXECUTING":
      return { label: "Executing", tone: "chain", pulse: true, settled: false, category: "scheduled" };
    case "ANALYZING":
      return { label: "Analyzing", tone: "ai", pulse: true, settled: false, category: "pending" };
    case "FAILED":
      // A failed analysis is not a refused payment. It needs a person.
      return { label: "Analysis failed", tone: "negative", settled: false, category: "review" };
    case "DETECTED":
    case null:
    case undefined:
      return { label: "Detected", tone: "neutral", settled: false, category: "pending" };
    default:
      break;
  }

  // ---- 5. Only now the recommendation --------------------------------------
  return input.finalOutcome
    ? describeOutcome(input.finalOutcome)
    : { label: "Analyzed", tone: "neutral", settled: false, category: "pending" };
}

/**
 * The pipeline's verdict as a word.
 *
 * Correct only for an invoice the chain has NOT settled — which is why every
 * caller goes through `describeInvoiceStatus` rather than here.
 */
export function describeOutcome(outcome: FinalOutcome): InvoiceStatusDescriptor {
  switch (outcome) {
    case "EXECUTED":
      // Authorized, not executed: no transaction exists until someone runs one.
      return { label: "Authorized · ready", tone: "positive", settled: false, category: "scheduled" };
    case "SCHEDULED":
      return { label: "Scheduled", tone: "chain", settled: false, category: "scheduled" };
    // Every chain check passed — what is missing is a person, not a permission.
    case "AWAITING_APPROVAL":
    case "HUMAN_REVIEW":
      return { label: "Awaiting approval", tone: "warning", settled: false, category: "review" };
    case "REJECTED":
      // A payment refused before any money moved. A SETTLED invoice never
      // reaches here — branch 1 of describeInvoiceStatus claims it first.
      return { label: "Payment rejected", tone: "negative", settled: false, category: "rejected" };
    case "SUI_REJECT":
      return { label: "Blocked on chain", tone: "negative", settled: false, category: "rejected" };
  }
}

/**
 * How the AI's recommendation should be worded, given what the chain says.
 *
 * "Payment rejected" is correct for an invoice that was refused BEFORE any
 * payment. On an invoice that has already settled it is actively misleading:
 * the guard is refusing a SECOND payment, and the sentence reads as though the
 * first one failed. Same verdict, different history, different words.
 *
 * THE DISTINCTION THIS FILE NOW HOLDS, and the one that was wrong:
 *
 *   "Payment already settled"     the invoice is settled. A statement of fact.
 *   "Duplicate payment prevented" someone TRIED to pay it again and was
 *                                 stopped. A statement about an event.
 *
 * The second is only true when a second payment was actually attempted. Shown
 * merely because an invoice is paid, it invents an attempt that never happened
 * — and next to "$4,800 released from escrow" it reads as though the money
 * moved twice. So the headline for a settled invoice states the settlement, and
 * the guard's standing refusal is explanatory text underneath it.
 *
 * The recommendation itself is untouched — this changes only how it is said,
 * and `attemptedDuplicate` never comes from the recommendation.
 */
export function describeRecommendation(input: {
  action: TreasuryAction;
  /** Whether the chain has already settled this invoice. */
  settled: boolean;
  /** The default wording, for every case that needs no adjustment. */
  defaultLabel: string;
  /**
   * Set ONLY when a second payment has actually been initiated against a
   * settled invoice and the guard turned it away. Never inferred from
   * settlement: an invoice being paid is not an attempt to pay it again.
   */
  attemptedDuplicate?: boolean;
}): RecommendationWording {
  if (input.settled && input.attemptedDuplicate) {
    // A real event: someone submitted a second payment and the guard refused
    // it. This is the only situation the phrase describes truthfully.
    return {
      label: "Duplicate payment prevented",
      note:
        "A second payment was initiated for this invoice and the deterministic guard refused " +
        "it. The original payment completed successfully and is unaffected.",
      guardNote: null,
    };
  }

  if (input.settled) {
    // Settled, and nobody has tried to pay it twice. The headline states what
    // happened; the guard's standing refusal is secondary.
    return {
      label: "Payment already settled",
      note:
        "This invoice has already been settled on chain. No new payment action is available.",
      guardNote: "The payment guard prevents a second payment.",
    };
  }

  return { label: input.defaultLabel, note: null, guardNote: null };
}

export interface RecommendationWording {
  /** The headline. Never describes an event that did not happen. */
  label: string;
  /** The explanation under it, or null when the label needs none. */
  note: string | null;
  /**
   * Secondary, smaller than `note`: what the guard would do about a further
   * payment. Explanatory only — never the headline.
   */
  guardNote: string | null;
}

/**
 * The invoice list's bucket for one invoice.
 *
 * A one-line wrapper, and deliberately nothing more. The list used to run its
 * own switch over `finalOutcome`, which is how a released escrow ended up under
 * "Rejected" while its own badge read "Payment released". Routing the list
 * through the same call makes that class of disagreement unrepresentable.
 */
export function categorizeInvoice(input: InvoiceStatusInput): InvoiceCategory {
  return describeInvoiceStatus(input).category;
}

/**
 * The duplicate check, worded for what it actually found.
 *
 * THE CONTRADICTION THIS FIXES: the row's label was the constant "No duplicate
 * detected" while its detail flipped to "Already settled as payment
 * chain_0x927e…". A settled invoice therefore rendered as
 *
 *   ✕ No duplicate detected
 *     Already settled as payment chain_0x927e138e…
 *
 * — two statements that deny each other, with a cross beside the one that was
 * true. The label described the check; the detail described the finding; only
 * one of them moved.
 *
 * The distinction that has to survive, and the reason this is not simply a
 * relabelling:
 *
 *   the INVOICE is legitimate       it is the original, and it was paid
 *   a NEW PAYMENT would be a duplicate   which is why the guard refuses one
 *
 * So a settled invoice is never called a duplicate invoice. What is prevented
 * is a second PAYMENT, and the wording says so.
 *
 * Chain-first, like everything else: this reads the settlement state that
 * `validateInvoice` derived, and `describeInvoiceStatus` and
 * `availablePaymentAction` answer to the same fact.
 */
export interface DuplicateCheckView {
  /** True when no prior settlement exists — the check passes. */
  passed: boolean;
  label: string;
  detail: string;
  /** Said only where a settlement exists. Null otherwise. */
  preventionNote: string | null;
  /** The payment that settled it, when one is on record. */
  settlementReference: string | null;
}

export function describeDuplicateCheck(input: {
  invoiceNumber: string;
  /** A prior settlement exists for this invoice number. */
  alreadySettled: boolean;
  /** The payment id that settled it, when known. */
  settledByPaymentId: string | null;
}): DuplicateCheckView {
  if (!input.alreadySettled) {
    return {
      passed: true,
      label: "No duplicate detected",
      detail: "No previous settlement found for this invoice.",
      preventionNote: null,
      settlementReference: null,
    };
  }

  return {
    // Not a failed check in the sense of something being wrong with the
    // invoice. The finding is that it is done.
    passed: false,
    label: "Already settled",
    detail: `${input.invoiceNumber} has already been paid on chain.`,
    preventionNote: "A new payment would be a duplicate and is therefore prevented.",
    settlementReference: input.settledByPaymentId,
  };
}
