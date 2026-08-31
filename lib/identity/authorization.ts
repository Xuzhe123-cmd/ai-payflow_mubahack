/**
 * What a signed-in person is actually allowed to do, and how we know.
 *
 * THE FIVE THINGS THIS FILE REFUSES TO CONFLATE:
 *
 *   1. IDENTITY            Google says who the human is
 *   2. SUI IDENTITY        zkLogin derives an address from that
 *   3. MEMBERSHIP          Chain-Doi's on-chain record names that address
 *   4. ROLE / PERMISSION   what the company declares that member may do
 *   5. CAPABILITY          what Move will actually let them do
 *
 * Each arrow is a separate fact and any of them can be absent. A verified
 * Google account with no membership is authenticated and unauthorized, and the
 * interface has to be able to say exactly that rather than falling back to
 * "logged in, therefore fine".
 *
 * NOTE WHAT IS ABSENT: the email is nowhere in the authorization decision. It
 * is carried for display and it never appears in a condition. Authorization
 * resolves from the zkLogin ADDRESS against the on-chain company record, which
 * is the only thing that could be checked by anyone other than us.
 *
 * The chain being unreachable is its own state, deliberately. Treating a
 * failed read as "no membership" would silently downgrade an authorized user;
 * treating it as "authorized" would be worse. It is reported as unknown, and
 * no action is offered while it is.
 */

import {
  describePermissions,
  permissionsFromMask,
  roleFromCode,
  type Permission,
  type PermissionStatus,
  type Role,
} from "./permissions";

/** The Google half. Display only — never an authorization input. */
export interface GoogleIdentity {
  /** Google's stable subject claim. The anchor, though not the authorizer. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** The zkLogin half. This is what authorization is keyed on. */
export interface SuiIdentity {
  address: string;
  /** Which OIDC issuer the address was derived from. */
  issuer: string;
  derivedAt: string;
}

export interface AuthenticatedIdentity {
  google: GoogleIdentity;
  sui: SuiIdentity;
}

/** A membership record as it exists on chain. */
export interface CompanyMembership {
  companyId: string;
  companyName: string;
  /** The company object's bound treasury. */
  treasuryId: string;
  memberAddress: string;
  role: Role;
  permissionMask: number;
  active: boolean;
  grantedAtMs: number;
}

export type AuthorizationState =
  /** Nobody is signed in. */
  | { kind: "UNAUTHENTICATED" }
  /**
   * Google verified the human and zkLogin derived their address, and the
   * company has no record of that address. Authenticated, unauthorized — the
   * distinction the whole file exists for.
   */
  | { kind: "NO_MEMBERSHIP"; identity: AuthenticatedIdentity }
  /** A record exists and has been revoked. */
  | { kind: "REVOKED"; identity: AuthenticatedIdentity; membership: CompanyMembership }
  /** A record exists and is active. */
  | {
      kind: "AUTHORIZED";
      identity: AuthenticatedIdentity;
      membership: CompanyMembership;
      permissions: PermissionStatus[];
    }
  /** The chain could not be read. Membership is unknown, not absent. */
  | { kind: "CHAIN_UNAVAILABLE"; identity: AuthenticatedIdentity; reason: string }
  /** zkLogin is not configured, so nobody can sign in at all. */
  | { kind: "NOT_CONFIGURED"; missing: { variable: string; detail: string }[] };

export interface ResolveInput {
  identity: AuthenticatedIdentity | null;
  /**
   * The membership found for `identity.sui.address`, or null when the company
   * record has no entry for it. Undefined means the read failed.
   */
  membership?: CompanyMembership | null;
  /** Set when the chain read failed. Never conflated with "no membership". */
  chainError?: string | null;
}

/**
 * The one function every surface asks.
 *
 * Deliberately total: each state is reachable and named, so no caller has to
 * invent a fallback — inventing fallbacks is how "we could not check" turns
 * into "looks fine".
 */
export function resolveAuthorization(input: ResolveInput): AuthorizationState {
  if (!input.identity) return { kind: "UNAUTHENTICATED" };

  if (input.chainError) {
    return { kind: "CHAIN_UNAVAILABLE", identity: input.identity, reason: input.chainError };
  }

  const membership = input.membership ?? null;
  if (!membership) return { kind: "NO_MEMBERSHIP", identity: input.identity };

  // A record for someone else is not this person's authorization. Compared
  // normalized, because Sui addresses vary in case and leading zeros.
  if (!sameAddress(membership.memberAddress, input.identity.sui.address)) {
    return { kind: "NO_MEMBERSHIP", identity: input.identity };
  }

  if (!membership.active) {
    return { kind: "REVOKED", identity: input.identity, membership };
  }

  return {
    kind: "AUTHORIZED",
    identity: input.identity,
    membership,
    permissions: describePermissions(membership.permissionMask),
  };
}

/**
 * Whether the person may be OFFERED an action.
 *
 * Note the wording: offered. This gates an interface, never a payment. Move
 * decides what may actually happen, and in this phase no permission here is
 * backed by a capability Move would accept.
 */
export function mayUse(state: AuthorizationState, permission: Permission): boolean {
  if (state.kind !== "AUTHORIZED") return false;
  return permissionsFromMask(state.membership.permissionMask).includes(permission);
}

/** The one-line status for a header or a badge. */
export function describeAuthorization(state: AuthorizationState): {
  headline: string;
  detail: string;
  tone: "neutral" | "positive" | "warning" | "negative";
} {
  switch (state.kind) {
    case "UNAUTHENTICATED":
      return {
        headline: "Not signed in",
        detail: "Sign in with Google to continue.",
        tone: "neutral",
      };
    case "NOT_CONFIGURED":
      return {
        headline: "Sign-in unavailable",
        detail: `zkLogin is not configured: ${state.missing.map((m) => m.variable).join(", ")}.`,
        tone: "warning",
      };
    case "NO_MEMBERSHIP":
      return {
        headline: "No company authorization",
        detail: "Identity verified, but no Chain-Doi authorization was found for this address.",
        tone: "warning",
      };
    case "REVOKED":
      return {
        headline: "Authorization revoked",
        detail: `This address is recorded as a former member of ${state.membership.companyName}.`,
        tone: "negative",
      };
    case "CHAIN_UNAVAILABLE":
      return {
        headline: "Authorization unknown",
        detail: "Unable to verify on-chain authorization. No payment action is available.",
        tone: "warning",
      };
    case "AUTHORIZED":
      return {
        headline: "Identity verified",
        detail: `${state.membership.companyName} · ${state.membership.role.replace("_", " ")}`,
        tone: "positive",
      };
  }
}

/** Sui addresses vary in case, `0x`, and leading zeros. */
export function sameAddress(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}

/** Decodes a membership as the Move object stores it. */
export function membershipFromChain(input: {
  companyId: string;
  companyName: string;
  treasuryId: string;
  memberAddress: string;
  roleCode: number;
  permissionMask: number;
  active: boolean;
  grantedAtMs: number;
}): CompanyMembership | null {
  const role = roleFromCode(input.roleCode);
  // An unrecognised role code is not a reason to invent one. Better no
  // membership than a guessed authority.
  if (!role) return null;
  return { ...input, role };
}
