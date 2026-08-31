/**
 * Identity, membership, role, permission, capability — five things, kept apart.
 *
 * THE PROPERTY THIS FILE EXISTS FOR: a successful Google login must not, by
 * itself, produce any authority at all. Every step has to be granted
 * separately, and the tests below try to short-circuit each one.
 *
 * The email gets special attention. It is the obvious thing to key
 * authorization on and it would be wrong: an email is a display string the
 * server received, not something the chain can check. Authorization resolves
 * from the zkLogin ADDRESS against the on-chain company record, and there is a
 * test here asserting the email cannot substitute for it.
 */

import { describe, expect, it } from "vitest";

import {
  describeAuthorization,
  mayUse,
  membershipFromChain,
  resolveAuthorization,
  sameAddress,
  type AuthenticatedIdentity,
  type CompanyMembership,
} from "../../lib/identity/authorization";
import {
  ROLE_CODE,
  PERMISSION_BIT,
  describePermissions,
  hasPermission,
  isCapabilityBacked,
  maskFromPermissions,
  permissionsFromMask,
  roleFromCode,
} from "../../lib/identity/permissions";

const ADDRESS = "0x9f2b71c4a83e05d6b1f7c2e94a6d38b05c1e7f2a94d63b805c1e7f2a94d63b80";
const OTHER = "0x1111111111111111111111111111111111111111111111111111111111111111";

const IDENTITY: AuthenticatedIdentity = {
  google: {
    subject: "104729384756102938475",
    email: "xuzhe272486@gmail.com",
    emailVerified: true,
    name: "Xu Zhe",
  },
  sui: { address: ADDRESS, issuer: "https://accounts.google.com", derivedAt: "2026-08-31T00:00:00Z" },
};

const MANAGER_MASK = maskFromPermissions([
  "VIEW_INVOICES",
  "VIEW_TREASURY",
  "APPROVE_PAYMENTS",
  "AUTHORIZE_AGENT",
]);

function membership(overrides: Partial<CompanyMembership> = {}): CompanyMembership {
  return {
    companyId: "0xC0MPANY",
    companyName: "Chain-Doi",
    treasuryId: "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a",
    memberAddress: ADDRESS,
    role: "TREASURY_MANAGER",
    permissionMask: MANAGER_MASK,
    active: true,
    grantedAtMs: 1_788_000_000_000,
    ...overrides,
  };
}

// --- authentication is not authorization ------------------------------------

describe("what a login alone produces", () => {
  it("gives an unauthenticated visitor nothing", () => {
    const state = resolveAuthorization({ identity: null });

    expect(state.kind).toBe("UNAUTHENTICATED");
    expect(mayUse(state, "VIEW_INVOICES")).toBe(false);
    expect(mayUse(state, "APPROVE_PAYMENTS")).toBe(false);
  });

  it("gives a verified Google identity with no membership nothing", () => {
    // THE CENTRAL ASSERTION. Google proved who this is. That is all it proved.
    const state = resolveAuthorization({ identity: IDENTITY, membership: null });

    expect(state.kind).toBe("NO_MEMBERSHIP");
    for (const permission of [
      "VIEW_INVOICES",
      "VIEW_TREASURY",
      "APPROVE_PAYMENTS",
      "AUTHORIZE_AGENT",
    ] as const) {
      expect(mayUse(state, permission)).toBe(false);
    }
  });

  it("does not make an authenticated user an approver, an agent, or an admin", () => {
    const state = resolveAuthorization({ identity: IDENTITY, membership: null });

    expect(state.kind).not.toBe("AUTHORIZED");
    expect(mayUse(state, "APPROVE_PAYMENTS")).toBe(false);
    expect(mayUse(state, "AUTHORIZE_AGENT")).toBe(false);
  });

  it("says so in words a person can act on", () => {
    const described = describeAuthorization(
      resolveAuthorization({ identity: IDENTITY, membership: null }),
    );

    expect(described.detail).toBe(
      "Identity verified, but no Chain-Doi authorization was found for this address.",
    );
  });
});

// --- the email is not a credential ------------------------------------------

describe("the email cannot authorize anything", () => {
  it("is absent from the authorization decision entirely", () => {
    // Same email, no membership -> nothing. The email cannot be the thing that
    // grants, because nobody outside this process could verify it.
    const state = resolveAuthorization({ identity: IDENTITY, membership: null });
    expect(state.kind).toBe("NO_MEMBERSHIP");
  });

  it("does not authorize when the membership names a different address", () => {
    // The demo human's email, and a company record for somebody else. If the
    // email were doing the work this would come back AUTHORIZED.
    const state = resolveAuthorization({
      identity: IDENTITY,
      membership: membership({ memberAddress: OTHER }),
    });

    expect(state.kind).toBe("NO_MEMBERSHIP");
    expect(mayUse(state, "APPROVE_PAYMENTS")).toBe(false);
  });

  it("authorizes the same identity once the address matches", () => {
    // The control for the test above: only the address changed.
    const state = resolveAuthorization({ identity: IDENTITY, membership: membership() });
    expect(state.kind).toBe("AUTHORIZED");
  });

  it("contains no hard-coded email anywhere in the identity layer", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const file of [
      "lib/identity/authorization.ts",
      "lib/identity/permissions.ts",
      "lib/identity/config.ts",
      "lib/identity/zklogin.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, `${file} must not name a user`).not.toContain("@gmail.com");
    }
  });
});

// --- an authorized Treasury Manager -----------------------------------------

describe("an authorized Treasury Manager", () => {
  const state = resolveAuthorization({ identity: IDENTITY, membership: membership() });

  it("resolves to the company, role and permissions from the record", () => {
    expect(state.kind).toBe("AUTHORIZED");
    if (state.kind !== "AUTHORIZED") return;

    expect(state.membership.companyName).toBe("Chain-Doi");
    expect(state.membership.role).toBe("TREASURY_MANAGER");
    expect(state.membership.treasuryId).toContain("0x15f45303");
    expect(permissionsFromMask(state.membership.permissionMask)).toEqual([
      "VIEW_INVOICES",
      "VIEW_TREASURY",
      "APPROVE_PAYMENTS",
      "AUTHORIZE_AGENT",
    ]);
  });

  it("may be offered every declared permission", () => {
    for (const permission of [
      "VIEW_INVOICES",
      "VIEW_TREASURY",
      "APPROVE_PAYMENTS",
      "AUTHORIZE_AGENT",
    ] as const) {
      expect(mayUse(state, permission)).toBe(true);
    }
  });

  it("loses everything when the membership is revoked", () => {
    const revoked = resolveAuthorization({
      identity: IDENTITY,
      membership: membership({ active: false }),
    });

    expect(revoked.kind).toBe("REVOKED");
    expect(mayUse(revoked, "VIEW_INVOICES")).toBe(false);
    expect(mayUse(revoked, "APPROVE_PAYMENTS")).toBe(false);
  });
});

// --- declared is not enforced -----------------------------------------------

describe("a declared permission is not a Move capability", () => {
  it("marks every permission as company policy, not capability-backed", () => {
    // The distinction the whole phase turns on. A green tick beside "Approve
    // payments" must not imply the chain would accept an approval.
    for (const status of describePermissions(MANAGER_MASK)) {
      expect(status.enforcement).toBe("COMPANY_POLICY");
    }
  });

  it("says out loud that APPROVE_PAYMENTS is not capability-backed", () => {
    const approve = describePermissions(MANAGER_MASK).find(
      (status) => status.permission === "APPROVE_PAYMENTS",
    )!;

    expect(approve.granted).toBe(true);
    expect(approve.caveat).toContain("not yet capability-backed");
    expect(approve.caveat).toContain("ApproverCap");
  });

  it("reports no permission as capability-backed in this phase", () => {
    for (const permission of [
      "VIEW_INVOICES",
      "VIEW_TREASURY",
      "APPROVE_PAYMENTS",
      "AUTHORIZE_AGENT",
    ] as const) {
      expect(isCapabilityBacked(permission)).toBe(false);
    }
  });

  it("carries no caveat for a permission that was not granted", () => {
    const viewerOnly = describePermissions(maskFromPermissions(["VIEW_INVOICES"]));
    const approve = viewerOnly.find((s) => s.permission === "APPROVE_PAYMENTS")!;

    expect(approve.granted).toBe(false);
    expect(approve.caveat).toBeNull();
  });
});

// --- the chain being unreadable is its own state ----------------------------

describe("when the chain cannot be read", () => {
  it("reports unknown rather than unauthorized", () => {
    // Downgrading silently would lock out a real member; upgrading silently
    // would be worse. Neither: it is unknown, and nothing is offered.
    const state = resolveAuthorization({
      identity: IDENTITY,
      chainError: "GraphQL 503",
    });

    expect(state.kind).toBe("CHAIN_UNAVAILABLE");
    expect(mayUse(state, "APPROVE_PAYMENTS")).toBe(false);
    expect(describeAuthorization(state).detail).toBe(
      "Unable to verify on-chain authorization. No payment action is available.",
    );
  });

  it("prefers the failure over a membership it also received", () => {
    const state = resolveAuthorization({
      identity: IDENTITY,
      membership: membership(),
      chainError: "GraphQL 503",
    });

    expect(state.kind).toBe("CHAIN_UNAVAILABLE");
  });
});

// --- the wire format between Move and TypeScript ----------------------------

describe("role and permission encoding", () => {
  it("matches the Move constants exactly", () => {
    expect(ROLE_CODE).toEqual({ ADMIN: 1, TREASURY_MANAGER: 2, APPROVER: 3, VIEWER: 4 });
    expect(PERMISSION_BIT).toEqual({
      VIEW_INVOICES: 1,
      VIEW_TREASURY: 2,
      APPROVE_PAYMENTS: 4,
      AUTHORIZE_AGENT: 8,
    });
  });

  it("round-trips a permission set through the mask", () => {
    const permissions = ["VIEW_INVOICES", "APPROVE_PAYMENTS"] as const;
    const mask = maskFromPermissions(permissions);

    expect(mask).toBe(5);
    expect(permissionsFromMask(mask)).toEqual([...permissions]);
    expect(hasPermission(mask, "APPROVE_PAYMENTS")).toBe(true);
    expect(hasPermission(mask, "AUTHORIZE_AGENT")).toBe(false);
  });

  it("refuses to invent a role for an unknown code", () => {
    expect(roleFromCode(2)).toBe("TREASURY_MANAGER");
    expect(roleFromCode(99)).toBeNull();
    // And a membership with an unrecognised role decodes to nothing rather
    // than to a guessed authority.
    expect(
      membershipFromChain({
        companyId: "0x1",
        companyName: "Chain-Doi",
        treasuryId: "0x2",
        memberAddress: ADDRESS,
        roleCode: 99,
        permissionMask: MANAGER_MASK,
        active: true,
        grantedAtMs: 0,
      }),
    ).toBeNull();
  });
});

describe("address comparison", () => {
  it("ignores case, 0x, and leading zeros", () => {
    expect(sameAddress("0x00AB", "0xab")).toBe(true);
    expect(sameAddress("AB", "0x00ab")).toBe(true);
    expect(sameAddress("0xab", "0xac")).toBe(false);
  });
});
