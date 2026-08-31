/**
 * Payment authority, and the four things that are not it.
 *
 * THE CLAIM UNDER TEST: no amount of identity, membership, role or declared
 * permission produces payment authority. Only the treasury's own approver
 * record does, and the tests below climb the chain one link at a time to show
 * that each is insufficient on its own.
 *
 * The refusal states are checked individually rather than as "denied", because
 * the remedy differs at every step — a revoked membership, a role without the
 * permission, and a permission with no capability behind it are three different
 * problems and telling someone the wrong one wastes their afternoon.
 */

import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_SYNC_MAX_AGE_MS,
  checkPayment,
  describeAuthority,
  isCapabilityBacked,
  resolvePaymentAuthority,
  type ApproverAuthorization,
  type AuthorityInput,
} from "../../lib/identity/paymentAuthority";

const ADDRESS = "0x9f2b71c4a83e05d6b1f7c2e94a6d38b05c1e7f2a94d63b805c1e7f2a94d63b80";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const SUPPLIER = "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091";
const OTHER = "0xb41f8e2c95a7d0361f8e2c95a7d0361f8e2c95a7d0361f8e2c95a7d0361f8e2c";

const COMPANY = "0xc0mpanyc0mpanyc0mpanyc0mpanyc0mpanyc0mpanyc0mpanyc0mpanyc0mpany";
const NOW = 1_788_000_000_000;

function authorization(overrides: Partial<ApproverAuthorization> = {}): ApproverAuthorization {
  return {
    approver: ADDRESS,
    treasuryId: TREASURY,
    maxSingleCents: 2_500_000, // $25,000
    dailyLimitCents: 5_000_000,
    authorizedTodayCents: 0,
    enabled: true,
    expiresAtMs: NOW + 30 * 86_400_000,
    allowedRecipients: [],
    companyId: COMPANY,
    membershipActive: true,
    membershipSyncedAtMs: NOW,
    ...overrides,
  };
}

/** Every link established. Individual tests break one at a time. */
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

// --- climbing the chain, one broken link at a time ---------------------------

describe("each link is necessary and none is sufficient", () => {
  it("gives an unauthenticated visitor nothing", () => {
    const state = resolvePaymentAuthority(input({ authenticated: false }));
    expect(state.kind).toBe("UNAUTHENTICATED");
    expect(isCapabilityBacked(state)).toBe(false);
  });

  it("reports no company rather than no authority", () => {
    // A distinct state: nothing is wrong with this person.
    const state = resolvePaymentAuthority(input({ companyExists: false }));
    expect(state.kind).toBe("NO_COMPANY");
    expect(describeAuthority(state).detail).toContain("No company object exists");
  });

  it("distinguishes a non-member from a revoked member", () => {
    expect(resolvePaymentAuthority(input({ isMember: false })).kind).toBe("NOT_A_MEMBER");
    expect(resolvePaymentAuthority(input({ membershipActive: false })).kind).toBe(
      "MEMBERSHIP_REVOKED",
    );
  });

  it("reports a role that does not carry the permission", () => {
    const state = resolvePaymentAuthority(
      input({ declaresApprovePayments: false, role: "VIEWER" }),
    );
    expect(state.kind).toBe("ROLE_WITHOUT_PERMISSION");
    if (state.kind !== "ROLE_WITHOUT_PERMISSION") return;
    expect(state.role).toBe("VIEWER");
  });

  it("reports a declared permission with no capability behind it", () => {
    // THE STATE THIS PHASE SHIPS IN. Membership active, role correct,
    // APPROVE_PAYMENTS declared — and Move would still refuse.
    const state = resolvePaymentAuthority(input({ authorization: null }));

    expect(state.kind).toBe("POLICY_ONLY");
    expect(isCapabilityBacked(state)).toBe(false);
    expect(describeAuthority(state).headline).toBe(
      "Company policy permission — not yet capability-backed",
    );
  });

  it("is capability-backed only with a live treasury record", () => {
    const state = resolvePaymentAuthority(input());
    expect(state.kind).toBe("ACTIVE");
    expect(isCapabilityBacked(state)).toBe(true);
  });

  it("is never capability-backed in any other state", () => {
    // Stated as an invariant so a new state cannot quietly qualify.
    const states = [
      input({ authenticated: false }),
      input({ companyExists: false }),
      input({ isMember: false }),
      input({ membershipActive: false }),
      input({ declaresApprovePayments: false }),
      input({ authorization: null }),
      input({ authorization: authorization({ enabled: false }) }),
      input({ authorization: authorization({ expiresAtMs: NOW - 1 }) }),
      input({ chainError: "GraphQL 503" }),
    ].map(resolvePaymentAuthority);

    for (const state of states) {
      expect(isCapabilityBacked(state), `${state.kind} must not be capability-backed`).toBe(
        false,
      );
    }
  });
});

// --- revocation and expiry ---------------------------------------------------

describe("an authorization that has stopped working", () => {
  it("reports revocation distinctly from expiry", () => {
    expect(
      resolvePaymentAuthority(input({ authorization: authorization({ enabled: false }) })).kind,
    ).toBe("REVOKED");
    expect(
      resolvePaymentAuthority(input({ authorization: authorization({ expiresAtMs: NOW - 1 }) }))
        .kind,
    ).toBe("EXPIRED");
  });

  it("says a revocation reaches approvals already signed", () => {
    const state = resolvePaymentAuthority(
      input({ authorization: authorization({ enabled: false }) }),
    );
    expect(describeAuthority(state).detail).toContain("signed before the revocation");
  });

  it("does not treat an unreadable chain as no authority", () => {
    const state = resolvePaymentAuthority(input({ chainError: "GraphQL 503" }));
    expect(state.kind).toBe("CHAIN_UNAVAILABLE");
    expect(describeAuthority(state).detail).toContain("No payment action is available");
  });
});

// --- the per-payment preview -------------------------------------------------

describe("what Move would decide for one payment", () => {
  const active = resolvePaymentAuthority(input());

  it("permits an amount inside the limit", () => {
    const check = checkPayment({
      state: active,
      amountCents: 480_000,
      recipient: SUPPLIER,
      treasuryId: TREASURY,
      nowMs: NOW,
    });

    expect(check.wouldAuthorize).toBe(true);
    expect(check.refusal).toBeNull();
  });

  it("refuses an amount above the limit, with both figures", () => {
    // The scope-failure demo: $30,000 against a $25,000 authorization.
    const check = checkPayment({
      state: active,
      amountCents: 3_000_000,
      recipient: SUPPLIER,
      treasuryId: TREASURY,
      nowMs: NOW,
    });

    expect(check.wouldAuthorize).toBe(false);
    expect(check.refusal).toBe("AMOUNT_EXCEEDS_LIMIT");
    expect(check.headline).toBe("Amount exceeds authorization scope");
    expect(check.requestedCents).toBe(3_000_000);
    expect(check.limitCents).toBe(2_500_000);
    // And it says where the boundary actually is.
    expect(check.detail).toContain("not a disabled button");
  });

  it("refuses a recipient outside the allowlist", () => {
    const scoped = resolvePaymentAuthority(
      input({ authorization: authorization({ allowedRecipients: [SUPPLIER] }) }),
    );

    expect(
      checkPayment({
        state: scoped,
        amountCents: 100_000,
        recipient: OTHER,
        treasuryId: TREASURY,
        nowMs: NOW,
      }).refusal,
    ).toBe("RECIPIENT_OUT_OF_SCOPE");

    expect(
      checkPayment({
        state: scoped,
        amountCents: 100_000,
        recipient: SUPPLIER,
        treasuryId: TREASURY,
        nowMs: NOW,
      }).wouldAuthorize,
    ).toBe(true);
  });

  it("refuses an authorization bound to a different treasury", () => {
    const check = checkPayment({
      state: active,
      amountCents: 100_000,
      recipient: SUPPLIER,
      treasuryId: OTHER,
      nowMs: NOW,
    });

    expect(check.refusal).toBe("WRONG_TREASURY");
  });

  it("checks the treasury before the amount", () => {
    // An authorization for another treasury is wrong regardless of the figure,
    // and reporting "amount too large" would send someone to fix the wrong thing.
    const check = checkPayment({
      state: active,
      amountCents: 99_999_999,
      recipient: SUPPLIER,
      treasuryId: OTHER,
      nowMs: NOW,
    });

    expect(check.refusal).toBe("WRONG_TREASURY");
  });

  it("refuses once the day's allowance is used up", () => {
    const spent = resolvePaymentAuthority(
      input({ authorization: authorization({ authorizedTodayCents: 4_800_000 }) }),
    );
    const check = checkPayment({
      state: spent,
      amountCents: 500_000,
      recipient: SUPPLIER,
      treasuryId: TREASURY,
      nowMs: NOW,
    });

    expect(check.refusal).toBe("EXCEEDS_DAILY_LIMIT");
    expect(check.detail).toContain("$2,000");
  });

  it("refuses everything when there is no authority at all", () => {
    const policyOnly = resolvePaymentAuthority(input({ authorization: null }));
    const check = checkPayment({
      state: policyOnly,
      amountCents: 1,
      recipient: SUPPLIER,
      treasuryId: TREASURY,
      nowMs: NOW,
    });

    expect(check.wouldAuthorize).toBe(false);
    expect(check.refusal).toBe("NO_AUTHORITY");
    // Carries the state's own explanation rather than a generic denial: the
    // treasury holds nothing for this address, which is a different problem
    // from an amount being too large.
    expect(check.detail).toContain("treasury holds no approver authorization");
    expect(check.detail).toContain("Move would refuse");
  });
});

// --- what the interface is allowed to say ------------------------------------

describe("the words the UI may use", () => {
  it("never claims authorization without a live chain record", () => {
    for (const overrides of [
      { authorization: null },
      { authorization: authorization({ enabled: false }) },
      { authorization: authorization({ expiresAtMs: NOW - 1 }) },
      { declaresApprovePayments: false },
      { membershipActive: false },
    ]) {
      const described = describeAuthority(resolvePaymentAuthority(input(overrides)));
      expect(described.headline.toLowerCase()).not.toBe("payment authorization active");
      expect(described.tone).not.toBe("positive");
    }
  });

  it("uses the exact required wording for the policy-only state", () => {
    // Specified verbatim, because this is the sentence that keeps a green tick
    // from implying on-chain payment authority.
    const described = describeAuthority(
      resolvePaymentAuthority(input({ authorization: null })),
    );
    expect(described.headline).toBe("Company policy permission — not yet capability-backed");
  });

  it("gives every state its own headline rather than a generic denial", () => {
    const headlines = [
      input({ authenticated: false }),
      input({ companyExists: false }),
      input({ isMember: false }),
      input({ membershipActive: false }),
      input({ declaresApprovePayments: false }),
      input({ authorization: null }),
      input({ authorization: authorization({ enabled: false }) }),
      input({ authorization: authorization({ expiresAtMs: NOW - 1 }) }),
      input({ chainError: "boom" }),
      input(),
    ].map((candidate) => describeAuthority(resolvePaymentAuthority(candidate)).headline);

    expect(new Set(headlines).size).toBe(headlines.length);
    for (const headline of headlines) {
      expect(headline.toLowerCase()).not.toContain("access denied");
    }
  });
});

// --- membership as an upper-level requirement --------------------------------

describe("company membership gates the treasury authorization", () => {
  it("reports MEMBERSHIP_BLOCKS when the authorization is live but membership is not", () => {
    // The state this phase exists for. Nothing is wrong with the
    // authorization; the company has stopped recognising the person.
    const state = resolvePaymentAuthority(
      input({ authorization: authorization({ membershipActive: false }) }),
    );

    expect(state.kind).toBe("MEMBERSHIP_BLOCKS");
    expect(isCapabilityBacked(state)).toBe(false);
  });

  it("says exactly why, and points at membership rather than the authorization", () => {
    // Requirement 13, verbatim enough that an admin fixes the right record.
    const described = describeAuthority(
      resolvePaymentAuthority(
        input({ authorization: authorization({ membershipActive: false }) }),
      ),
    );

    expect(described.headline).toBe(
      "Payment authority unavailable — company membership is inactive",
    );
    expect(described.detail).toContain("still live");
    expect(described.detail).toContain("upper-level requirement");
    expect(described.tone).toBe("negative");
  });

  it("does not trust a membership reading that has aged out", () => {
    const stale = resolvePaymentAuthority(
      input({
        authorization: authorization({
          membershipSyncedAtMs: NOW - MEMBERSHIP_SYNC_MAX_AGE_MS - 1,
        }),
      }),
    );

    expect(stale.kind).toBe("MEMBERSHIP_STALE");
    expect(isCapabilityBacked(stale)).toBe(false);

    // And distinguishes "not refreshed" from "refused" — now by saying which
    // record is stale outright. The old wording ("nothing is wrong with your
    // authorization") left the reader to infer that their MEMBERSHIP was the
    // thing that had aged out, which is the opposite of the truth.
    const described = describeAuthority(stale);
    expect(described.headline).toBe("Membership verification needs refresh");
    expect(described.detail).toContain("Your Chain-Doi membership is still ACTIVE");
    expect(described.detail).not.toMatch(/membership (has )?expired/i);
  });

  it("treats a never-synced reading as stale rather than as active", () => {
    const never = resolvePaymentAuthority(
      input({ authorization: authorization({ membershipSyncedAtMs: 0 }) }),
    );
    expect(never.kind).toBe("MEMBERSHIP_STALE");
  });

  it("keeps the two revocations independent", () => {
    // Membership ACTIVE, authorization revoked -> reported against the
    // authorization. Membership inactive, authorization live -> reported
    // against membership. Neither masks the other.
    expect(
      resolvePaymentAuthority(input({ authorization: authorization({ enabled: false }) })).kind,
    ).toBe("REVOKED");
    expect(
      resolvePaymentAuthority(
        input({ authorization: authorization({ membershipActive: false }) }),
      ).kind,
    ).toBe("MEMBERSHIP_BLOCKS");
  });

  it("refuses every payment while membership blocks", () => {
    const blocked = resolvePaymentAuthority(
      input({ authorization: authorization({ membershipActive: false }) }),
    );
    const check = checkPayment({
      state: blocked,
      amountCents: 1,
      recipient: SUPPLIER,
      treasuryId: TREASURY,
      nowMs: NOW,
    });

    expect(check.wouldAuthorize).toBe(false);
    expect(check.refusal).toBe("NO_AUTHORITY");
    // Names membership as the blocker, so nobody goes looking at the limits.
    expect(check.detail).toContain("no longer recognises this address as an active member");
    expect(check.detail).toContain("upper-level requirement");
  });

  it("mirrors the Move freshness window exactly", async () => {
    // One constant, two languages. If Move's changes and this does not, the
    // interface would promise a window the chain does not honour.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "move/payflow/sources/treasury.move"),
      "utf8",
    );
    const match = /const MEMBERSHIP_SYNC_MAX_AGE_MS: u64 = ([\d_]+);/.exec(source);

    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBe(MEMBERSHIP_SYNC_MAX_AGE_MS);
  });
});
