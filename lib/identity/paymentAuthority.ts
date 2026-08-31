/**
 * Whether this human may authorize a payment, and — when they may not — which
 * link in the chain is missing.
 *
 * FIVE THINGS, FOUR OF WHICH ARE NOT PAYMENT AUTHORITY:
 *
 *   zkLogin identity    proves who the human is
 *   company membership  says which company they belong to
 *   role                says what the company calls them
 *   declared permission says what the company intends them to do
 *   APPROVER AUTHORIZATION   the only one Move consults before moving money
 *
 * Each is necessary and none is sufficient. A verified Google account with an
 * ACTIVE Chain-Doi membership, the TREASURY_MANAGER role and APPROVE_PAYMENTS
 * declared can still be unable to authorize a single dollar, because
 * `approval::approve_scoped` reads none of those — it reads the treasury's own
 * approver record for the sender's address.
 *
 * So this module never collapses a refusal into "access denied". Each state
 * below names the link that is missing, because the remedy differs at every
 * step and telling someone the wrong one wastes their afternoon.
 *
 * ADVISORY, AND SAYS SO. Every rule here mirrors `treasury::approver_can_
 * authorize` deliberately, so a screen can explain in advance what Move will
 * decide. It is a preview, not a gate: the transaction is refused by Move
 * whatever this returns, and a disabled button is not a security boundary.
 */

import type { Cents } from "../types";

/**
 * How long a mirrored membership reading stays usable.
 *
 * Mirrors `treasury::MEMBERSHIP_SYNC_MAX_AGE_MS` exactly. The chain is the
 * authority; this copy exists so a screen can explain the state in advance,
 * and a test asserts the two agree.
 */
export const MEMBERSHIP_SYNC_MAX_AGE_MS = 3_600_000;

/** The treasury's approver record, exactly as chain stores it. */
export interface ApproverAuthorization {
  approver: string;
  treasuryId: string;
  maxSingleCents: Cents;
  dailyLimitCents: Cents;
  authorizedTodayCents: Cents;
  enabled: boolean;
  expiresAtMs: number;
  /** Empty means any recipient, subject to every other limit. */
  allowedRecipients: string[];
  /** The company whose ACTIVE membership this authorization requires. */
  companyId: string;
  /** The treasury's mirror of that company's verdict. */
  membershipActive: boolean;
  membershipSyncedAtMs: number;
}

export type PaymentAuthorityState =
  /** Nobody is signed in. */
  | { kind: "UNAUTHENTICATED" }
  /** No company object exists on chain at all. */
  | { kind: "NO_COMPANY" }
  /** The company exists; this address is not in it. */
  | { kind: "NOT_A_MEMBER" }
  /** A membership exists and has been revoked. */
  | { kind: "MEMBERSHIP_REVOKED" }
  /** A member whose role does not carry APPROVE_PAYMENTS. */
  | { kind: "ROLE_WITHOUT_PERMISSION"; role: string }
  /**
   * The company declares APPROVE_PAYMENTS and the treasury records no approver
   * authorization for this address. The state this phase ships in.
   */
  | { kind: "POLICY_ONLY" }
  /**
   * The treasury authorization is live and the COMPANY has stopped recognising
   * this person.
   *
   * Its own state because the remedy is different: nothing is wrong with the
   * authorization, and restoring it means restoring membership. Reported as
   * "revoked authorization" it would send an admin to the wrong record.
   */
  | { kind: "MEMBERSHIP_BLOCKS"; authorization: ApproverAuthorization }
  /**
   * The mirrored membership reading has aged out.
   *
   * Not a refusal of this person — nobody has refreshed the treasury's copy of
   * the company's verdict, and a stale copy is not trusted.
   */
  | { kind: "MEMBERSHIP_STALE"; authorization: ApproverAuthorization }
  /** An authorization exists and the admin has revoked it. */
  | { kind: "REVOKED"; authorization: ApproverAuthorization }
  /** An authorization exists and has lapsed. */
  | { kind: "EXPIRED"; authorization: ApproverAuthorization }
  /** Live, with limits. The only state that may be called capability-backed. */
  | { kind: "ACTIVE"; authorization: ApproverAuthorization }
  /** The chain could not be read. Not the same as having no authority. */
  | { kind: "CHAIN_UNAVAILABLE"; reason: string };

export interface AuthorityInput {
  authenticated: boolean;
  companyExists: boolean;
  isMember: boolean;
  membershipActive: boolean;
  role: string | null;
  declaresApprovePayments: boolean;
  /** The treasury's own record, or null when it holds none for this address. */
  authorization: ApproverAuthorization | null;
  nowMs: number;
  /** How long a mirrored membership reading stays usable. Mirrors Move. */
  membershipSyncMaxAgeMs: number;
  chainError?: string | null;
}

/**
 * The state, in the order the links are established.
 *
 * Order matters: a revoked membership is reported as such rather than as
 * "no authorization", because the two have different causes and different
 * fixes.
 */
export function resolvePaymentAuthority(input: AuthorityInput): PaymentAuthorityState {
  if (!input.authenticated) return { kind: "UNAUTHENTICATED" };
  if (input.chainError) return { kind: "CHAIN_UNAVAILABLE", reason: input.chainError };
  if (!input.companyExists) return { kind: "NO_COMPANY" };
  if (!input.isMember) return { kind: "NOT_A_MEMBER" };
  if (!input.membershipActive) return { kind: "MEMBERSHIP_REVOKED" };
  if (!input.declaresApprovePayments) {
    return { kind: "ROLE_WITHOUT_PERMISSION", role: input.role ?? "unknown" };
  }

  // The company says yes and the treasury has never been told. This is where a
  // declared permission stops and a Move capability has not started.
  if (!input.authorization) return { kind: "POLICY_ONLY" };

  if (!input.authorization.enabled) {
    return { kind: "REVOKED", authorization: input.authorization };
  }
  if (input.nowMs > input.authorization.expiresAtMs) {
    return { kind: "EXPIRED", authorization: input.authorization };
  }

  // The upper-level block, checked in the same order Move checks it. An
  // authorization is never reported ACTIVE while the company's verdict says
  // otherwise or while that verdict is too old to rely on.
  if (!input.authorization.membershipActive) {
    return { kind: "MEMBERSHIP_BLOCKS", authorization: input.authorization };
  }
  const syncedAt = input.authorization.membershipSyncedAtMs;
  if (
    syncedAt === 0 ||
    input.nowMs < syncedAt ||
    input.nowMs - syncedAt > input.membershipSyncMaxAgeMs
  ) {
    return { kind: "MEMBERSHIP_STALE", authorization: input.authorization };
  }

  return { kind: "ACTIVE", authorization: input.authorization };
}

/**
 * Whether APPROVE_PAYMENTS is backed by something Move will actually consult.
 *
 * True for exactly one state. Every screen that wants to write "on-chain
 * payment authority" has to get `true` from here first, and no amount of
 * membership, role or declared permission produces it.
 */
export function isCapabilityBacked(state: PaymentAuthorityState): boolean {
  return state.kind === "ACTIVE";
}

// --- the per-payment preview -------------------------------------------------

export type PaymentRefusal =
  | "NO_AUTHORITY"
  | "AMOUNT_EXCEEDS_LIMIT"
  | "EXCEEDS_DAILY_LIMIT"
  | "RECIPIENT_OUT_OF_SCOPE"
  | "WRONG_TREASURY";

export interface PaymentCheck {
  /** Whether Move is expected to accept. A PREVIEW — Move decides. */
  wouldAuthorize: boolean;
  refusal: PaymentRefusal | null;
  headline: string;
  detail: string;
  /** The two figures a reader wants side by side, when a limit is the issue. */
  requestedCents: Cents | null;
  limitCents: Cents | null;
}

export interface PaymentCheckInput {
  state: PaymentAuthorityState;
  amountCents: Cents;
  recipient: string;
  /** The treasury the payment would settle from. */
  treasuryId: string;
  nowMs: number;
}

/**
 * What Move would say about ONE specific payment.
 *
 * Mirrors `approval::approve_scoped`'s checks in the same order, so the reason
 * shown matches the abort code that would come back. It is not a gate — the
 * button it informs is a courtesy, and the transaction is refused by the chain
 * whether or not the button was pressed.
 */
export function checkPayment(input: PaymentCheckInput): PaymentCheck {
  const money = (cents: Cents) => `$${(cents / 100).toLocaleString("en-US")}`;

  if (input.state.kind !== "ACTIVE") {
    return {
      wouldAuthorize: false,
      refusal: "NO_AUTHORITY",
      headline: "No payment authorization",
      detail: describeAuthority(input.state).detail,
      requestedCents: input.amountCents,
      limitCents: null,
    };
  }

  const auth = input.state.authorization;

  // Checked before the amount: an authorization for another treasury is wrong
  // regardless of the figure.
  if (!sameId(auth.treasuryId, input.treasuryId)) {
    return {
      wouldAuthorize: false,
      refusal: "WRONG_TREASURY",
      headline: "Authorization is for a different treasury",
      detail:
        "This authorization is bound to another treasury. Move refuses an approval whose " +
        "treasury does not match the payment.",
      requestedCents: input.amountCents,
      limitCents: null,
    };
  }

  if (input.amountCents > auth.maxSingleCents) {
    return {
      wouldAuthorize: false,
      refusal: "AMOUNT_EXCEEDS_LIMIT",
      headline: "Amount exceeds authorization scope",
      detail:
        `${money(input.amountCents)} is above the ${money(auth.maxSingleCents)} this ` +
        "authorization permits for a single payment. Move refuses the approval; it is not a " +
        "disabled button.",
      requestedCents: input.amountCents,
      limitCents: auth.maxSingleCents,
    };
  }

  if (
    auth.allowedRecipients.length > 0 &&
    !auth.allowedRecipients.some((allowed) => sameId(allowed, input.recipient))
  ) {
    return {
      wouldAuthorize: false,
      refusal: "RECIPIENT_OUT_OF_SCOPE",
      headline: "Recipient is outside the authorized scope",
      detail:
        "This authorization names the recipients it may pay, and this is not one of them.",
      requestedCents: input.amountCents,
      limitCents: null,
    };
  }

  if (auth.authorizedTodayCents + input.amountCents > auth.dailyLimitCents) {
    const remaining = Math.max(0, auth.dailyLimitCents - auth.authorizedTodayCents);
    return {
      wouldAuthorize: false,
      refusal: "EXCEEDS_DAILY_LIMIT",
      headline: "Exceeds the daily authorization limit",
      detail:
        `${money(remaining)} of today's ${money(auth.dailyLimitCents)} allowance remains, ` +
        `and this payment asks for ${money(input.amountCents)}.`,
      requestedCents: input.amountCents,
      limitCents: remaining,
    };
  }

  return {
    wouldAuthorize: true,
    refusal: null,
    headline: "Within your authorization",
    detail:
      `${money(input.amountCents)} is inside the ${money(auth.maxSingleCents)} single-payment ` +
      "limit recorded on chain. Move re-checks every one of these when the approval is submitted.",
    requestedCents: input.amountCents,
    limitCents: auth.maxSingleCents,
  };
}

/** One line per state, precise about which link is missing. */
export function describeAuthority(state: PaymentAuthorityState): {
  headline: string;
  detail: string;
  tone: "neutral" | "positive" | "warning" | "negative";
} {
  switch (state.kind) {
    case "UNAUTHENTICATED":
      return {
        headline: "Not signed in",
        detail: "Sign in with Google to establish an identity.",
        tone: "neutral",
      };
    case "CHAIN_UNAVAILABLE":
      return {
        headline: "Authorization unknown",
        detail: `Unable to read on-chain authorization: ${state.reason}. No payment action is available.`,
        tone: "warning",
      };
    case "NO_COMPANY":
      return {
        headline: "No company on chain",
        detail:
          "No company object exists yet, so there is no membership to hold and no authorization to grant.",
        tone: "neutral",
      };
    case "NOT_A_MEMBER":
      return {
        headline: "Not a member",
        detail:
          "Your identity is verified and this address is not recorded as a member of the company.",
        tone: "warning",
      };
    case "MEMBERSHIP_REVOKED":
      return {
        headline: "Membership revoked",
        detail: "This address is recorded as a former member.",
        tone: "negative",
      };
    case "ROLE_WITHOUT_PERMISSION":
      return {
        headline: "Role does not include payment approval",
        detail: `The ${state.role} role does not carry APPROVE_PAYMENTS.`,
        tone: "warning",
      };
    case "POLICY_ONLY":
      return {
        headline: "Company policy permission — not yet capability-backed",
        detail:
          "The company declares that you may approve payments. The treasury holds no approver " +
          "authorization for your address, so Move would refuse an approval today.",
        tone: "warning",
      };
    case "MEMBERSHIP_BLOCKS":
      return {
        headline: "Payment authority unavailable — company membership is inactive",
        detail:
          "Your treasury authorization is still live, and Chain-Doi no longer recognises this " +
          "address as an active member. Membership is an upper-level requirement, so Move " +
          "refuses the approval regardless of the authorization.",
        tone: "negative",
      };
    case "MEMBERSHIP_STALE":
      // NOT AN EXPIRED MEMBERSHIP. "Membership reading is out of date" was read
      // as "your membership expired" — the opposite of the truth. The company
      // still says ACTIVE; it is the treasury's COPY of that answer that has
      // aged past the one-hour limit, and a re-read fixes it.
      return {
        headline: "Membership verification needs refresh",
        detail:
          "Your Chain-Doi membership is still ACTIVE. The Treasury requires a fresh on-chain " +
          "membership check before payment authorization can be used.",
        tone: "warning",
      };
    case "REVOKED":
      return {
        headline: "Authorization revoked",
        detail:
          "The treasury administrator withdrew this authorization. Move refuses approvals from " +
          "it, including any that were signed before the revocation.",
        tone: "negative",
      };
    case "EXPIRED":
      return {
        headline: "Authorization expired",
        detail: "This authorization has lapsed and no longer authorizes anything.",
        tone: "negative",
      };
    case "ACTIVE":
      return {
        headline: "Payment authorization active",
        detail: "The treasury records a live approver authorization for this address.",
        tone: "positive",
      };
  }
}

function sameId(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}
