/**
 * Membership, verification, and authorization — told apart.
 *
 * THE CONFUSION THIS EXISTS TO END. "Membership reading is out of date" was
 * read as "your membership expired". Those are opposite facts about different
 * records, and conflating them tells an active member they have been thrown
 * out of the company:
 *
 *   Chain-Doi membership     the Company object's verdict. THE SOURCE.
 *   Treasury verification    the treasury's mirrored COPY of that verdict.
 *   Payment authorization    what Move will act on, which needs both.
 *
 * A stale verification means nobody has refreshed the copy for an hour. The
 * membership behind it is untouched and still ACTIVE. Nothing was revoked,
 * nothing expired, and the fix is a re-read rather than a re-grant.
 *
 * WHY THE MIRROR EXISTS AT ALL. `limits_for` has a frozen signature that
 * receives `&Treasury` and no `Company`, so it cannot ask the company directly.
 * Membership therefore has to be readable from treasury state, and a copy of a
 * fact that can change needs an age limit — hence the one-hour rule and
 * `approval::sync_membership` to refresh it.
 *
 * FAIL-CLOSED, UNCHANGED. This module renames nothing about what is permitted:
 * `resolvePaymentAuthority` still decides, a stale mirror still blocks, and the
 * only state that reports authorization ACTIVE is still `ACTIVE`. All that
 * changes here is which of three records a reader is told to look at.
 */

import type { PaymentAuthorityState } from "./paymentAuthority";

export type Marker = "ok" | "warn" | "fail" | "pending";

export interface VerificationRow {
  /** What the row says, in the words the reader should repeat back. */
  label: string;
  marker: Marker;
  /** The sentence under the label. Null when the label says enough. */
  detail: string | null;
}

export interface MembershipVerificationView {
  /** Chain-Doi's own verdict. */
  membership: VerificationRow;
  /** The treasury's copy of it, and how old that copy is. */
  verification: VerificationRow;
  /** What Move would do, which needs the two above to agree and be fresh. */
  authorization: VerificationRow;
  /**
   * Whether to offer the refresh action.
   *
   * TRUE FOR EXACTLY ONE STATE. Refreshing copies the company's verdict; it
   * cannot grant, restore, or widen anything. Offering it beside a revoked
   * membership would imply a button could undo a revocation, so a revoked or
   * blocked member is never shown one.
   */
  canRefresh: boolean;
}

/**
 * Verified, and how recently.
 *
 * Reported separately from the boolean because "verified 3 minutes ago" and
 * "verified" are the same permission with different reassurance.
 */
export function verificationAgeLabel(syncedAtMs: number, nowMs: number): string | null {
  if (syncedAtMs <= 0 || nowMs < syncedAtMs) return null;
  const minutes = Math.floor((nowMs - syncedAtMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

const MEMBERSHIP_ACTIVE: VerificationRow = {
  label: "ACTIVE",
  marker: "ok",
  detail: null,
};

/** The one sentence a revoked member should read. Never shown for staleness. */
const MEMBERSHIP_INACTIVE: VerificationRow = {
  label: "INACTIVE",
  marker: "fail",
  detail: "Chain-Doi no longer recognizes this address as an active member.",
};

export function describeMembershipVerification(
  state: PaymentAuthorityState | null,
  nowMs: number,
): MembershipVerificationView {
  if (state === null) {
    const reading: VerificationRow = {
      label: "Reading from chain…",
      marker: "pending",
      detail: null,
    };
    return { membership: reading, verification: reading, authorization: reading, canRefresh: false };
  }

  switch (state.kind) {
    // --- the two states this module was written for --------------------------

    case "ACTIVE": {
      const age = verificationAgeLabel(state.authorization.membershipSyncedAtMs, nowMs);
      return {
        membership: MEMBERSHIP_ACTIVE,
        verification: {
          label: "Membership verified",
          marker: "ok",
          detail: age
            ? `Chain-Doi confirms you are an active Treasury Manager. Verified ${age}.`
            : "Chain-Doi confirms you are an active Treasury Manager.",
        },
        authorization: { label: "ACTIVE", marker: "ok", detail: null },
        canRefresh: false,
      };
    }

    case "MEMBERSHIP_STALE":
      return {
        // The point of the whole exercise: the membership row is UNCHANGED and
        // still reads ACTIVE. Only the row below it needs anything.
        membership: MEMBERSHIP_ACTIVE,
        verification: {
          label: "Membership verification needs refresh",
          marker: "warn",
          detail:
            "Your Chain-Doi membership is still ACTIVE. The Treasury requires a fresh " +
            "on-chain membership check before payment authorization can be used.",
        },
        authorization: {
          label: "Waiting for membership verification",
          marker: "warn",
          detail: null,
        },
        canRefresh: true,
      };

    // --- membership itself is the problem: never offer a refresh -------------

    case "MEMBERSHIP_REVOKED":
    case "MEMBERSHIP_BLOCKS":
      return {
        membership: MEMBERSHIP_INACTIVE,
        verification: {
          label: "Not verified",
          marker: "fail",
          // Says why WITHOUT suggesting a refresh would help. Refreshing would
          // copy the same refusal across again.
          detail: "The Treasury's check confirms Chain-Doi does not recognize this member.",
        },
        authorization: { label: "BLOCKED", marker: "fail", detail: null },
        canRefresh: false,
      };

    case "NOT_A_MEMBER":
      return {
        membership: {
          label: "INACTIVE",
          marker: "fail",
          detail: "This address is not recorded as a member of Chain-Doi.",
        },
        verification: { label: "Not verified", marker: "fail", detail: null },
        authorization: { label: "BLOCKED", marker: "fail", detail: null },
        canRefresh: false,
      };

    // --- everything else: membership is not what is in the way ---------------

    case "UNAUTHENTICATED":
      return unavailable("Not signed in", "Sign in to establish an identity.");
    case "NO_COMPANY":
      return unavailable("No company on chain", "No Chain-Doi company object exists yet.");
    case "CHAIN_UNAVAILABLE":
      return {
        membership: { label: "Unknown", marker: "pending", detail: null },
        verification: { label: "Unknown", marker: "pending", detail: null },
        authorization: {
          label: "UNKNOWN",
          marker: "pending",
          // Unknown is not permission. Fail-closed, and said out loud.
          detail: `The chain could not be read: ${state.reason}. No payment action is available.`,
        },
        canRefresh: false,
      };
    case "ROLE_WITHOUT_PERMISSION":
      return {
        membership: MEMBERSHIP_ACTIVE,
        verification: { label: "Not applicable", marker: "pending", detail: null },
        authorization: {
          label: "BLOCKED",
          marker: "fail",
          detail: `The ${state.role} role does not carry APPROVE_PAYMENTS.`,
        },
        canRefresh: false,
      };
    case "POLICY_ONLY":
      return {
        membership: MEMBERSHIP_ACTIVE,
        verification: { label: "Not applicable", marker: "pending", detail: null },
        authorization: {
          label: "NOT CAPABILITY-BACKED",
          marker: "warn",
          detail: "The treasury holds no approver authorization for this address.",
        },
        canRefresh: false,
      };
    case "REVOKED":
      return authorizationFault(
        "REVOKED",
        "The treasury administrator withdrew this authorization.",
      );
    case "EXPIRED":
      return authorizationFault("EXPIRED", "This authorization has lapsed.");
  }
}

/**
 * The authorization is at fault and the membership is not.
 *
 * Kept distinct so a revoked AUTHORIZATION never renders the sentence about
 * Chain-Doi not recognising the member — a different record, a different admin,
 * a different fix.
 */
function authorizationFault(label: string, detail: string): MembershipVerificationView {
  return {
    membership: MEMBERSHIP_ACTIVE,
    verification: { label: "Not applicable", marker: "pending", detail: null },
    authorization: { label, marker: "fail", detail },
    canRefresh: false,
  };
}

function unavailable(label: string, detail: string): MembershipVerificationView {
  const row: VerificationRow = { label, marker: "pending", detail: null };
  return {
    membership: row,
    verification: row,
    authorization: { label: "NONE", marker: "pending", detail },
    canRefresh: false,
  };
}
