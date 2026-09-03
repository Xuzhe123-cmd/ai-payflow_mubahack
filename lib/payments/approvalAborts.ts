/**
 * What each Move abort on the approval and settlement paths means to a person.
 *
 * READ FROM MOVE, NOT GUESSED. Every number below is the constant a named
 * function actually raises, so a refusal shown to a reader is the refusal the
 * chain gave — and the constant's name is carried alongside, because
 * "601 EAboveApproverLimit" is checkable against the source in a way that
 * "above the limit" is not.
 *
 * DELIBERATELY INCOMPLETE. Only codes the approval and human-settlement paths
 * can actually raise are here. An unmapped code returns null and is reported as
 * an unidentified refusal carrying its number, rather than being matched to a
 * plausible-sounding rule it did not come from.
 *
 * Pure and dependency-free, so components may import it.
 */

export interface AbortMeaning {
  /** A stable identifier for the refusal. */
  code: string;
  /** The Move constant's name, exactly as the source spells it. */
  name: string;
  /** Where it aborts, so a reader can go and read it. */
  location: string;
  message: string;
}

const MEANINGS: Record<number, AbortMeaning> = {
  // --- payment::evaluate, the ten checks. Codes ARE check positions. --------
  1: {
    code: "AGENT_NOT_AUTHORIZED",
    name: "EAgentNotAuthorized",
    location: "payment::evaluate",
    message: "The authority presented is not registered on this treasury.",
  },
  2: {
    code: "CAPABILITY_DISABLED",
    name: "ECapabilityDisabled",
    location: "payment::evaluate",
    message: "That authority has been revoked.",
  },
  3: {
    code: "SUPPLIER_NOT_APPROVED",
    name: "ESupplierNotApproved",
    location: "payment::evaluate",
    message: "The supplier is not approved in the registry.",
  },
  4: {
    code: "RECIPIENT_WALLET_MISMATCH",
    name: "ERecipientWalletMismatch",
    location: "payment::evaluate",
    message: "The recipient is not the supplier's registered wallet.",
  },
  5: {
    code: "EXCEEDS_MAX_PAYMENT",
    name: "EExceedsMaxPayment",
    location: "payment::evaluate",
    message: "The amount is above the ceiling this authority permits for one payment.",
  },
  6: {
    code: "EXCEEDS_DAILY_LIMIT",
    name: "EExceedsDailyLimit",
    location: "payment::evaluate",
    message: "This would take the day's total past what this authority permits.",
  },
  7: {
    code: "CURRENCY_NOT_ALLOWED",
    name: "ECurrencyNotAllowed",
    location: "payment::evaluate",
    message: "The invoice currency or the settlement coin is not on the allowed list.",
  },
  8: {
    code: "INVOICE_ALREADY_PAID",
    name: "EInvoiceAlreadyPaid",
    location: "payment::evaluate",
    message: "This invoice has already been settled. It cannot be paid twice.",
  },
  9: {
    code: "INSUFFICIENT_RESERVE",
    name: "EInsufficientReserve",
    location: "payment::evaluate",
    message: "Paying this would take the vault below the minimum reserve.",
  },
  10: {
    code: "RECOMMENDATION_EXPIRED",
    name: "ERecommendationExpired",
    location: "payment::evaluate",
    message: "The recommendation behind this payment is too old to act on.",
  },

  // --- treasury -------------------------------------------------------------
  110: {
    code: "APPROVERS_NOT_READY",
    name: "EApproversNotReady",
    location: "treasury::init_approvers",
    message: "The treasury's approver registry has not been initialised.",
  },
  114: {
    code: "WRONG_COMPANY",
    name: "EWrongCompany",
    location: "treasury::assert_approver_company",
    message: "This authorization is bound to a different company.",
  },
  115: {
    code: "CIRCUIT_BREAKER_ACTIVE",
    name: "ECircuitBreakerActive",
    location: "treasury::assert_autonomy_allowed",
    message:
      "Autonomous payment is blocked by the Sui circuit breaker. The treasury is in " +
      "HUMAN_ONLY mode, so the agent may not settle anything on its own.",
  },

  // --- approval::approve_scoped --------------------------------------------
  600: {
    code: "WRONG_TREASURY",
    name: "EWrongTreasury",
    location: "approval::assert_treasury",
    message: "This approval was minted against a different treasury.",
  },
  601: {
    code: "AMOUNT_EXCEEDS_LIMIT",
    name: "EAboveApproverLimit",
    location: "approval::approve_scoped",
    message: "The amount is above the per-payment ceiling this authorization permits.",
  },
  602: {
    code: "NOT_AUTHORIZED_APPROVER",
    name: "ENotAuthorizedApprover",
    location: "approval::approve_scoped",
    message: "The treasury holds no approver authorization for this address.",
  },
  603: {
    code: "EXPIRY_IN_PAST",
    name: "EExpiryInPast",
    location: "approval::approve_scoped",
    message: "The approval would already have expired, so it would authorize nothing.",
  },
  604: {
    code: "APPROVER_REVOKED",
    name: "EApproverRevoked",
    location: "approval::approve_scoped",
    message: "This authorization has been revoked.",
  },
  605: {
    code: "APPROVER_EXPIRED",
    name: "EApproverExpired",
    location: "approval::approve_scoped",
    message: "This authorization has expired.",
  },
  606: {
    code: "RECIPIENT_OUT_OF_SCOPE",
    name: "ERecipientNotInScope",
    location: "approval::approve_scoped",
    message: "This recipient is outside the authorization's allowed list.",
  },
  607: {
    code: "EXCEEDS_DAILY_AUTHORIZATION",
    name: "EAboveApproverDailyLimit",
    location: "approval::approve_scoped",
    message: "This would take the approver past their daily authorization limit.",
  },
  608: {
    code: "LEGACY_PATH_SEALED",
    name: "ELegacyApprovalPathSealed",
    location: "approval::approve",
    message: "The legacy ApproverCap path is sealed and authorizes nothing.",
  },
  610: {
    code: "NOT_AN_ACTIVE_MEMBER",
    name: "ENotAnActiveMember",
    location: "approval::approve_scoped",
    message: "The company does not recognise this address as an active member.",
  },
  611: {
    code: "MEMBER_CANNOT_APPROVE",
    name: "EMemberCannotApprove",
    location: "approval::approve_scoped",
    message: "This member's role does not carry APPROVE_PAYMENTS.",
  },
  612: {
    code: "MEMBERSHIP_READING_STALE",
    name: "EMembershipReadingStale",
    location: "approval::limits_for",
    message:
      "The treasury's copy of this member's Chain-Doi status is too old to rely on. It must " +
      "be refreshed before the approval can be spent.",
  },

  // --- payment, operational ------------------------------------------------
  700: {
    code: "WRONG_TREASURY",
    name: "EWrongTreasury",
    location: "payment::execute_approved",
    message: "The invoice or registry belongs to a different treasury.",
  },
  701: {
    code: "APPROVAL_MISMATCH",
    name: "EApprovalMismatch",
    location: "payment::execute_approved",
    message: "This approval was signed for a different invoice.",
  },
  703: {
    code: "CONDITIONAL_INVOICE",
    name: "EConditionalInvoice",
    location: "payment::settle",
    message:
      "This invoice settles only against a confirmed shipment, so it cannot be paid from here.",
  },
};

/**
 * Codes 1 and 2 mean DIFFERENT THINGS depending on which authority was asked.
 *
 * `payment::evaluate` runs one rule body against a `Limits` value, and that
 * value is built either from an agent's capability or from a human approval.
 * Checks 1 and 2 ask "is this authority registered" and "is it still live" —
 * so on the agent path they are the AgentCap, and on the human path they are
 * the `HumanApproval` object, which `approval::limits_for` marks not-live when
 * it is consumed, expired, minted against another treasury, or when the
 * approver has since been revoked, has lapsed, has a stale membership reading,
 * or has exhausted the day's authorization budget.
 *
 * WHY THIS MATTERS AND NOT ACADEMICALLY. Reporting `ECapabilityDisabled` on the
 * human path as "the agent capability is revoked" sends a reader to inspect an
 * AgentCap that is enabled and working, while the real cause — a spent daily
 * budget — goes unlooked-at. That is not a wording nit; it is a wrong answer to
 * "what do I fix".
 */
const HUMAN_PATH_MEANINGS: Record<number, AbortMeaning> = {
  1: {
    code: "APPROVAL_NOT_RECOGNIZED",
    name: "EAgentNotAuthorized",
    location: "payment::evaluate (human approval path)",
    message:
      "This approval is not recognised by the treasury it was presented to.",
  },
  2: {
    code: "APPROVAL_NOT_LIVE",
    name: "ECapabilityDisabled",
    location: "approval::limits_for",
    message:
      "The human approval is no longer live. It has been spent or has expired, or the " +
      "approver's authorization has been revoked, has lapsed, needs its membership " +
      "re-verified, or has used up the amount it may authorize today. The agent's own " +
      "capability is not involved on this path.",
  },
};

/**
 * What a Move abort code means, or null when this path cannot raise it.
 *
 * `target` is the Move function that raised it. Pass it wherever it is known:
 * without it, codes 1 and 2 are reported in their agent-path sense, which is
 * the right default only because `execute_payment` is the commoner call.
 */
export function abortMeaning(
  code: number | null | undefined,
  target?: string | null,
): AbortMeaning | null {
  if (code === null || code === undefined) return null;
  if (target && target.includes("execute_approved") && HUMAN_PATH_MEANINGS[code]) {
    return HUMAN_PATH_MEANINGS[code];
  }
  return MEANINGS[code] ?? null;
}

/** Rendered the way the Move source reads it: `601 EAboveApproverLimit`. */
export function formatMoveAbort(code: number, meaning: AbortMeaning | null): string {
  return meaning ? `${code} ${meaning.name}` : `Move abort ${code}`;
}

/** The breaker's own code, named so a caller need not repeat the number. */
export const CIRCUIT_BREAKER_ABORT = 115;
