/**
 * Membership vs. verification — the distinction, held by tests.
 *
 * THE BUG THIS GUARDS. "Membership reading is out of date" was read as "your
 * membership expired". It is the opposite: Chain-Doi still says ACTIVE, and the
 * treasury's hourly COPY of that answer went stale. Telling an active Treasury
 * Manager their membership lapsed is a worse failure than saying nothing, so
 * the forbidden vocabulary is asserted directly rather than left to review.
 *
 * The refresh action is a REAL transaction, so its availability is tested as a
 * security property, not a cosmetic one: offered for exactly one state, absent
 * everywhere else, and never beside a revoked membership where a button would
 * imply a revocation can be clicked away.
 */

import { describe, expect, it } from "vitest";

import {
  describeMembershipVerification,
  verificationAgeLabel,
} from "../../lib/identity/membershipVerification";
import {
  MEMBERSHIP_SYNC_MAX_AGE_MS,
  describeAuthority,
  resolvePaymentAuthority,
  type ApproverAuthorization,
  type AuthorityInput,
} from "../../lib/identity/paymentAuthority";

const NOW = 1_800_000_000_000;
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const COMPANY = "0x274fe88f2ca611088342b607727296a937904b648484ca448d42c5763fd4116a";
const APPROVER = "0x9840c5c522e7e94bd01ffe0a57da9a10853cadb40574da5a5f058d3913ffa443";

/** The live Chain-Doi authorization: $25,000 single, $50,000 daily. */
function authorization(overrides: Partial<ApproverAuthorization> = {}): ApproverAuthorization {
  return {
    approver: APPROVER,
    treasuryId: TREASURY,
    maxSingleCents: 2_500_000,
    dailyLimitCents: 5_000_000,
    authorizedTodayCents: 0,
    enabled: true,
    expiresAtMs: NOW + 30 * 86_400_000,
    allowedRecipients: [],
    companyId: COMPANY,
    membershipActive: true,
    membershipSyncedAtMs: NOW - 60_000,
    ...overrides,
  };
}

/** An active Treasury Manager, verified a minute ago. */
function input(overrides: Partial<AuthorityInput> = {}): AuthorityInput {
  return {
    authenticated: true,
    companyExists: true,
    isMember: true,
    membershipActive: true,
    role: "TREASURY_MANAGER",
    declaresApprovePayments: true,
    authorization: authorization(),
    nowMs: NOW,
    membershipSyncMaxAgeMs: MEMBERSHIP_SYNC_MAX_AGE_MS,
    ...overrides,
  };
}

const view = (overrides: Partial<AuthorityInput> = {}) =>
  describeMembershipVerification(resolvePaymentAuthority(input(overrides)), NOW);

/** Everything the panel renders, as one lowercase blob. */
function text(overrides: Partial<AuthorityInput> = {}): string {
  const v = view(overrides);
  return [v.membership, v.verification, v.authorization]
    .flatMap((row) => [row.label, row.detail ?? ""])
    .join(" ")
    .toLowerCase();
}

// --- 1 & 2: the two states the redesign exists for ---------------------------

describe("active and fresh", () => {
  const v = view();

  it("says the membership is verified", () => {
    expect(v.verification.label).toBe("Membership verified");
    expect(v.verification.marker).toBe("ok");
  });

  it("confirms the role Chain-Doi records", () => {
    expect(v.verification.detail).toContain(
      "Chain-Doi confirms you are an active Treasury Manager",
    );
  });

  it("shows all three rows green", () => {
    expect(v.membership.label).toBe("ACTIVE");
    expect(v.authorization.label).toBe("ACTIVE");
    expect([v.membership.marker, v.verification.marker, v.authorization.marker]).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });
});

describe("active but stale", () => {
  const stale = {
    authorization: authorization({ membershipSyncedAtMs: NOW - MEMBERSHIP_SYNC_MAX_AGE_MS - 1 }),
  };
  const v = view(stale);

  it("asks for a refresh of the VERIFICATION", () => {
    expect(v.verification.label).toBe("Membership verification needs refresh");
    expect(v.verification.marker).toBe("warn");
  });

  it("states outright that the membership is still active", () => {
    expect(v.membership.label).toBe("ACTIVE");
    expect(v.membership.marker).toBe("ok");
    expect(v.verification.detail).toContain("Your Chain-Doi membership is still ACTIVE");
    expect(v.verification.detail).toContain(
      "The Treasury requires a fresh on-chain membership check",
    );
  });

  it("holds the authorization rather than blocking it", () => {
    // "Waiting for" and "BLOCKED" are different promises to the reader.
    expect(v.authorization.label).toBe("Waiting for membership verification");
    expect(v.authorization.marker).toBe("warn");
  });

  // --- 3 & 4: the words that must never appear -------------------------------

  it.each(["expired", "membership expired", "inactive", "revoked", "no longer"])(
    'never says "%s"',
    (banned) => {
      expect(text(stale)).not.toContain(banned);
    },
  );

  it("never says the membership itself lapsed", () => {
    const blob = text(stale);
    expect(blob).not.toMatch(/membership (has )?(expired|lapsed|ended)/);
    expect(blob).not.toContain("not a member");
  });

  it("is also fixed at the source, in describeAuthority", () => {
    // The panel is not the only surface reading this state.
    const described = describeAuthority(resolvePaymentAuthority(input(stale)));
    expect(described.headline).toBe("Membership verification needs refresh");
    expect(described.headline.toLowerCase()).not.toContain("out of date");
    expect(described.detail).toContain("still ACTIVE");
  });
});

// --- 5: the button is offered for exactly one state --------------------------

describe("when the refresh action is offered", () => {
  it("is offered when, and only when, verification is stale", () => {
    expect(view({
      authorization: authorization({ membershipSyncedAtMs: NOW - MEMBERSHIP_SYNC_MAX_AGE_MS - 1 }),
    }).canRefresh).toBe(true);
  });

  it.each([
    ["fresh and active", {}],
    ["membership revoked at the company", { membershipActive: false }],
    ["mirror says inactive", { authorization: authorization({ membershipActive: false }) }],
    ["not a member", { isMember: false }],
    ["authorization revoked", { authorization: authorization({ enabled: false }) }],
    ["authorization expired", { authorization: authorization({ expiresAtMs: NOW - 1 }) }],
    ["no authorization at all", { authorization: null }],
    ["no company", { companyExists: false }],
    ["signed out", { authenticated: false }],
    ["chain unreadable", { chainError: "rpc timeout" }],
  ])("is not offered when %s", (_label, overrides) => {
    expect(view(overrides as Partial<AuthorityInput>).canRefresh).toBe(false);
  });

  it("is never offered beside a revoked membership", () => {
    // A button there would imply a revocation can be clicked away. Refreshing
    // would copy the same refusal across again.
    for (const overrides of [{ membershipActive: false }, { authorization: authorization({ membershipActive: false }) }]) {
      const v = view(overrides);
      expect(v.canRefresh).toBe(false);
      expect(text(overrides)).not.toContain("needs refresh");
    }
  });

  it("IS offered for a mirror that was never synced", () => {
    // syncedAt === 0 is stale by the rule, and a refresh is exactly what fixes
    // it — so the button belongs here. Asserted rather than assumed, because
    // "never synced" reads like a harder failure than it is: the membership is
    // untouched and one transaction resolves it.
    const neverSynced = { authorization: authorization({ membershipSyncedAtMs: 0 }) };
    expect(resolvePaymentAuthority(input(neverSynced)).kind).toBe("MEMBERSHIP_STALE");
    expect(view(neverSynced).canRefresh).toBe(true);
    expect(view(neverSynced).membership.label).toBe("ACTIVE");
  });
});

// --- 8: revoked stays blocked ------------------------------------------------

describe("revoked membership", () => {
  it.each([
    ["the company revoked it", { membershipActive: false }],
    ["the treasury mirror says inactive", { authorization: authorization({ membershipActive: false }) }],
  ])("shows INACTIVE and BLOCKED when %s", (_label, overrides) => {
    const v = view(overrides as Partial<AuthorityInput>);
    expect(v.membership.label).toBe("INACTIVE");
    expect(v.membership.marker).toBe("fail");
    expect(v.authorization.label).toBe("BLOCKED");
    expect(v.authorization.marker).toBe("fail");
  });

  it("says Chain-Doi no longer recognizes the address", () => {
    expect(view({ membershipActive: false }).membership.detail).toBe(
      "Chain-Doi no longer recognizes this address as an active member.",
    );
  });

  it("never suggests a refresh would help", () => {
    const blob = text({ membershipActive: false });
    expect(blob).not.toContain("needs refresh");
    expect(blob).not.toContain("out of date");
  });

  it("keeps fail-closed behaviour: only ACTIVE is capability-backed", () => {
    for (const overrides of [
      { membershipActive: false },
      { authorization: authorization({ membershipActive: false }) },
      { authorization: authorization({ membershipSyncedAtMs: 0 }) },
    ]) {
      expect(resolvePaymentAuthority(input(overrides)).kind).not.toBe("ACTIVE");
    }
  });
});

// --- an unreadable chain is not a permission ---------------------------------

describe("fail-closed states", () => {
  it("reports an unreadable chain as unknown, not as verified", () => {
    const v = view({ chainError: "rpc timeout" });
    expect(v.authorization.label).toBe("UNKNOWN");
    expect(v.authorization.detail).toContain("No payment action is available");
    expect(v.verification.label).not.toBe("Membership verified");
  });

  it("does not blame membership when the authorization is the problem", () => {
    // A revoked AUTHORIZATION must not render the sentence about Chain-Doi
    // dropping the member — different record, different admin, different fix.
    const v = view({ authorization: authorization({ enabled: false }) });
    expect(v.authorization.label).toBe("REVOKED");
    expect(v.membership.label).toBe("ACTIVE");
    expect(v.membership.detail).toBeNull();
  });
});

// --- the age label -----------------------------------------------------------

describe("verification age", () => {
  it.each([
    [NOW - 30_000, "just now"],
    [NOW - 60_000, "1 minute ago"],
    [NOW - 600_000, "10 minutes ago"],
    [NOW - 3_600_000, "1 hour ago"],
    [NOW - 7_200_000, "2 hours ago"],
  ])("renders %i as %s", (syncedAt, expected) => {
    expect(verificationAgeLabel(syncedAt, NOW)).toBe(expected);
  });

  it("returns null rather than a negative age", () => {
    expect(verificationAgeLabel(0, NOW)).toBeNull();
    expect(verificationAgeLabel(NOW + 60_000, NOW)).toBeNull();
  });
});
