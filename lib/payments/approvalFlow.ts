/**
 * The human-approval state machine, as one pure function.
 *
 * EIGHT STATES, AND THE RULE THAT ORDERS THEM. Each one is entitled to say
 * exactly what has happened by the time it is reached, and nothing more:
 *
 *   HUMAN_REVIEW        a person must decide. Nothing has been asked of Sui.
 *   APPROVAL_PREFLIGHT  a dry run of approve_scoped is in flight.
 *   APPROVAL_PASSED     Sui WOULD accept an approval. None exists.
 *   APPROVAL_REFUSED    Sui would refuse one, with its own abort code.
 *   APPROVAL_SUBMITTED  an approval transaction is in flight.
 *   APPROVAL_CONFIRMED  a HumanApproval object was READ BACK from chain.
 *   EXECUTION_READY     that object is live and spendable for this invoice.
 *   PAYMENT_SUBMITTED   execute_approved is in flight.
 *   PAYMENT_CONFIRMED   the chain re-read shows the invoice settled.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE. Nothing past APPROVAL_PASSED may
 * be reached without `approvalOnChain` — a real object the chain returned. The
 * screen previously reached "Cleared for execution" from a TypeScript policy
 * mirror having returned APPROVED: a forecast, made before any approval had
 * been minted, signed or submitted, beside an Execute button that could not
 * work. A prediction is not a verdict and a verdict is not an object.
 *
 * Equally: PAYMENT_CONFIRMED requires a digest AND a settled re-read. A
 * transaction that was accepted is not a settlement that was observed.
 *
 * Pure, with no chain access of its own, so the ordering can be tested without
 * a network — and so there is exactly one place where these words are chosen.
 */

export type ApprovalFlowState =
  | "HUMAN_REVIEW"
  | "APPROVAL_PREFLIGHT"
  | "APPROVAL_PASSED"
  | "APPROVAL_REFUSED"
  | "APPROVAL_SUBMITTED"
  | "APPROVAL_CONFIRMED"
  | "EXECUTION_READY"
  | "PAYMENT_SUBMITTED"
  | "PAYMENT_CONFIRMED"
  | "PAYMENT_REFUSED"
  | "DECLINED";

/** The control this state may offer. `NONE` means there is no button. */
export type ApprovalFlowAction = "APPROVE" | "CONFIRM_APPROVAL" | "EXECUTE" | "RETRY" | "NONE";

export interface ApprovalPreflightVerdict {
  wouldAuthorize: boolean;
  /** The Move abort code the chain returned. Null on a pass. */
  abortCode: number | null;
  /** The Move constant's own name, e.g. `EAboveApproverLimit`. */
  abortName: string | null;
  message: string;
}

/** A HumanApproval the chain returned. Never constructed from a click. */
export interface ApprovalObject {
  objectId: string;
  amountCents: number;
  expiresAtMs: number;
}

export interface ApprovalFlowInput {
  /** A person declined outright. Terminal, and outranks everything. */
  humanRejected?: boolean;
  /** A dry run of `approval::approve_scoped` is in flight. */
  preflighting?: boolean;
  /** What that dry run answered. Null until it has answered. */
  preflight?: ApprovalPreflightVerdict | null;
  /** An `approve_scoped` transaction is in flight. */
  approving?: boolean;
  /** The digest of the approval transaction, when the chain issued one. */
  approvalDigest?: string | null;
  /**
   * The approval object AS THE CHAIN RETURNED IT.
   *
   * The gate on every state past APPROVAL_PASSED. Null means the chain holds no
   * live approval for this invoice — whether because none was ever minted, or
   * because the one that was is consumed or expired.
   */
  approvalOnChain?: ApprovalObject | null;
  /** An `execute_approved` transaction is in flight. */
  paying?: boolean;
  /** The settlement digest, when the chain issued one. */
  paymentDigest?: string | null;
  /** The invoice's own status on chain says settled. */
  settledOnChain?: boolean;
  /** The last refusal, from whichever step produced it. */
  error?: string | null;
}

export interface ApprovalFlowView {
  state: ApprovalFlowState;
  /** The large line. Says where the payment IS, in the interface's own voice. */
  headline: string;
  /** A smaller line above it, where one is needed. */
  lead: string | null;
  detail: string;
  action: ApprovalFlowAction;
  /** Button text, or null when there is no button. */
  actionLabel: string | null;
  /** True while the interface is waiting on Sui and must not offer a control. */
  busy: boolean;
  tone: "neutral" | "warning" | "chain" | "positive" | "negative";
}

export function approvalFlow(input: ApprovalFlowInput): ApprovalFlowView {
  // ---- terminal, in precedence order --------------------------------------

  // The chain settled it. Outranks every local belief, including a stale one
  // from a previous session that never saw the payment happen.
  if (input.settledOnChain && input.paymentDigest) {
    return {
      state: "PAYMENT_CONFIRMED",
      headline: "PAYMENT SETTLED ON SUI",
      lead: "Confirmed by re-reading the invoice on chain",
      detail:
        "The transaction landed and the invoice object now records the settlement. The digest " +
        "below is the one Sui issued.",
      action: "NONE",
      actionLabel: null,
      busy: false,
      tone: "positive",
    };
  }

  // Settled, but this browser never held the receipt — an earlier session, a
  // script, or another operator. Still settled; still no further action.
  if (input.settledOnChain) {
    return {
      state: "PAYMENT_CONFIRMED",
      headline: "PAYMENT SETTLED ON SUI",
      lead: "Read from the invoice object on chain",
      detail:
        "The chain records this invoice as paid. No further payment action is available.",
      action: "NONE",
      actionLabel: null,
      busy: false,
      tone: "positive",
    };
  }

  if (input.humanRejected) {
    return {
      state: "DECLINED",
      headline: "DECLINED BY OPERATOR",
      lead: null,
      detail:
        "No approval was submitted and no payment was made. The invoice stays open for a " +
        "different decision.",
      action: "NONE",
      actionLabel: null,
      busy: false,
      tone: "neutral",
    };
  }

  // ---- in flight ----------------------------------------------------------

  if (input.paying) {
    return {
      state: "PAYMENT_SUBMITTED",
      headline: "Submitting payment to Sui…",
      lead: "payment::execute_approved",
      detail:
        "The approval is being spent against the treasury vault. Nothing is settled until the " +
        "chain confirms it and the invoice re-reads as paid.",
      action: "NONE",
      actionLabel: null,
      busy: true,
      tone: "chain",
    };
  }

  if (input.approving) {
    return {
      state: "APPROVAL_SUBMITTED",
      headline: "Submitting approval to Sui…",
      lead: "approval::approve_scoped",
      detail:
        "Creating the HumanApproval object. It moves no funds; it authorizes exactly this " +
        "invoice, amount and recipient, and nothing larger.",
      action: "NONE",
      actionLabel: null,
      busy: true,
      tone: "chain",
    };
  }

  if (input.preflighting) {
    return {
      state: "APPROVAL_PREFLIGHT",
      headline: "Checking authorization with Sui…",
      lead: "approval::approve_scoped · dry run",
      detail:
        "Asking Sui what it would do with this approval, against live state. Nothing is " +
        "submitted, and no HumanApproval exists unless it says yes.",
      action: "NONE",
      actionLabel: null,
      busy: true,
      tone: "chain",
    };
  }

  // ---- the chain holds an approval ----------------------------------------
  //
  // THE GATE. Every state below this line is entitled to describe an approval
  // as EXISTING, and none of them may be reached without the object.

  if (input.approvalOnChain) {
    const failed = input.error;
    return {
      state: failed ? "PAYMENT_REFUSED" : "EXECUTION_READY",
      headline: failed ? "PAYMENT NOT SUBMITTED" : "APPROVED BY OPERATOR",
      lead: "HumanApproval verified on Sui",
      detail: failed
        ? failed
        : "The approval object exists on chain, is unspent and has not expired. Executing " +
          "spends it: Move re-checks all ten assertions and re-asks the treasury whether the " +
          "approver is still authorized.",
      action: "EXECUTE",
      actionLabel: failed ? "Retry payment" : "Execute payment",
      busy: false,
      tone: failed ? "negative" : "positive",
    };
  }

  // An approval transaction landed but the object is not visible yet. Reported
  // as its own state rather than as readiness: a digest is not an object.
  if (input.approvalDigest) {
    return {
      state: "APPROVAL_CONFIRMED",
      headline: "Approval submitted — reading it back",
      lead: "HumanApproval not yet visible on chain",
      detail:
        "Sui accepted the approval transaction. The object has not been read back yet, and no " +
        "payment may be executed until it has been.",
      action: "NONE",
      actionLabel: null,
      busy: true,
      tone: "chain",
    };
  }

  // ---- the preflight has answered -----------------------------------------

  if (input.preflight && !input.preflight.wouldAuthorize) {
    const abort = input.preflight.abortCode;
    const named = input.preflight.abortName;
    return {
      state: "APPROVAL_REFUSED",
      headline: "WOULD BE REFUSED BY SUI",
      lead: "Preflight verdict · nothing was submitted",
      detail:
        input.preflight.message +
        (abort !== null
          ? ` The chain aborted with ${abort}${named ? ` ${named}` : ""}.`
          : "") +
        " No approval transaction was submitted, so no HumanApproval exists and nothing was " +
        "refused — this is what Sui would do if one were attempted.",
      action: "NONE",
      actionLabel: null,
      busy: false,
      tone: "negative",
    };
  }

  if (input.preflight?.wouldAuthorize) {
    return {
      state: "APPROVAL_PASSED",
      headline: "SUI AUTHORIZATION PASSED",
      lead: "Preflight verdict · nothing was submitted",
      detail:
        (input.error ? input.error + " " : "") +
        "Sui evaluated this approval against the live Chain-Doi authorization and would accept " +
        "it. No HumanApproval exists yet — confirming submits the transaction that creates one.",
      action: "CONFIRM_APPROVAL",
      actionLabel: input.error ? "Retry approval" : "Confirm approval",
      busy: false,
      tone: "warning",
    };
  }

  // ---- nothing has been asked yet ------------------------------------------

  return {
    state: "HUMAN_REVIEW",
    headline: "HUMAN APPROVAL REQUIRED",
    lead: null,
    detail:
      (input.error ? input.error + " " : "") +
      "This payment is above what the agent may settle on its own. Approving asks Sui whether " +
      "this person's authorization covers it; it does not raise any limit.",
    action: "APPROVE",
    actionLabel: "Approve payment",
    busy: false,
    tone: "warning",
  };
}

/** Whether the interface may offer an execute control at all. */
export function offersExecute(view: ApprovalFlowView): boolean {
  return view.action === "EXECUTE";
}

/**
 * Whether this state is entitled to claim an approval EXISTS.
 *
 * Stated separately because it is the claim worth asserting on its own — and
 * because it must be a property of the STATE rather than of a stylesheet.
 */
export function claimsApprovalExists(state: ApprovalFlowState): boolean {
  return (
    state === "EXECUTION_READY" ||
    state === "PAYMENT_SUBMITTED" ||
    state === "PAYMENT_CONFIRMED" ||
    state === "PAYMENT_REFUSED"
  );
}
