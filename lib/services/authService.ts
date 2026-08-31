/**
 * Authentication: Google, through zkLogin, to a Sui address.
 *
 * This file used to be a 420ms `setTimeout` returning a hardcoded session for
 * "Acme Corporation". It is now the real ceremony, and the shape of the thing
 * it returns has changed in one important way: a session no longer asserts a
 * company.
 *
 * WHY THE COMPANY LEFT THIS FILE. The old `TreasurySession` carried
 * `companyName` and `companyId`, so signing in *was* being a member of a
 * company — the two were one object and could not disagree. They are different
 * facts with different authorities: Google says who the human is, and the
 * chain says which company they belong to. A session now carries only the
 * first. Membership is read separately, from `payflow::identity`, and may be
 * absent for a perfectly valid login.
 *
 *   signIn()   →  who is this human, and what Sui address do they derive to
 *   chain      →  and is that address a member of anything
 *
 * The redirect leaves the app entirely, so `beginSignIn` returns a URL rather
 * than a session; the session materialises in the callback.
 */

import type { AuthenticatedIdentity } from "@/lib/identity/authorization";
import { buildGoogleAuthUrl } from "@/lib/identity/zklogin";
import { beginLogin, clearIdentity, readIdentity, storeIdentity } from "@/lib/identity/session";

/**
 * The authenticated human.
 *
 * Deliberately no company, no role, no permission. Those are the chain's to
 * report, and a session that carried them would be asserting authorization it
 * has no standing to grant.
 */
export interface TreasurySession {
  operatorName: string | null;
  operatorEmail: string | null;
  emailVerified: boolean;
  /** The zkLogin-derived Sui address. The authorization anchor. */
  address: string;
  /** Google's stable subject. Identity, not authority. */
  subject: string;
  issuer: string;
  provider: "google";
  signedInAt: string;
}

export interface AuthConfigStatus {
  ready: boolean;
  missing: { variable: string; detail: string }[];
  googleClientId?: string;
  redirectUri?: string;
  epoch?: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function fetchAuthConfig(): Promise<AuthConfigStatus> {
  const response = await fetch("/api/auth/config", { cache: "no-store" });
  const payload = (await response.json()) as AuthConfigStatus & { ok?: boolean };
  if (!payload.ready) {
    return { ready: false, missing: payload.missing ?? [] };
  }
  return {
    ready: true,
    missing: [],
    googleClientId: payload.googleClientId,
    redirectUri: payload.redirectUri,
    epoch: payload.epoch,
  };
}

/**
 * Starts a sign-in and returns where to send the browser.
 *
 * The ephemeral key and nonce are minted here and kept in sessionStorage,
 * because the page is destroyed by the redirect and has to recognise the
 * response when it comes back.
 */
export function beginSignIn(config: AuthConfigStatus): string {
  if (!config.ready || !config.googleClientId || !config.redirectUri) {
    throw new AuthError("zkLogin is not configured on the server.", "NOT_CONFIGURED");
  }

  const { pending, nonce } = beginLogin(config.epoch ?? 0);
  return buildGoogleAuthUrl({
    clientId: config.googleClientId,
    redirectUri: config.redirectUri,
    nonce,
    state: pending.state,
  });
}

/**
 * Exchanges a verified Google credential for a Sui address.
 *
 * The JWT crosses to the server once and is not stored anywhere. What comes
 * back is an identity, not an authorization — nothing here consults a company.
 */
export async function completeSignIn(input: {
  idToken: string;
  nonce: string;
}): Promise<AuthenticatedIdentity> {
  const response = await fetch("/api/auth/zklogin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  const payload = (await response.json()) as {
    ok?: boolean;
    code?: string;
    message?: string;
    address?: string;
    issuer?: string;
    derivedAt?: string;
    google?: { subject: string; email: string | null; emailVerified: boolean; name: string | null };
  };

  if (!response.ok || !payload.ok || !payload.address || !payload.google) {
    throw new AuthError(
      payload.message ?? "The Google credential could not be verified.",
      payload.code ?? "VERIFY_FAILED",
    );
  }

  const identity: AuthenticatedIdentity = {
    google: {
      subject: payload.google.subject,
      email: payload.google.email,
      emailVerified: payload.google.emailVerified,
      name: payload.google.name,
    },
    sui: {
      address: payload.address,
      issuer: payload.issuer ?? "https://accounts.google.com",
      derivedAt: payload.derivedAt ?? new Date().toISOString(),
    },
  };

  storeIdentity(identity);
  return identity;
}

/** The identity from a previous page load, if this tab still has one. */
export function restoreIdentity(): AuthenticatedIdentity | null {
  return readIdentity();
}

export function signOutIdentity(): void {
  clearIdentity();
}

/** The session shape the rest of the app reads, from an identity. */
export function sessionFromIdentity(identity: AuthenticatedIdentity): TreasurySession {
  return {
    operatorName: identity.google.name,
    operatorEmail: identity.google.email,
    emailVerified: identity.google.emailVerified,
    address: identity.sui.address,
    subject: identity.google.subject,
    issuer: identity.sui.issuer,
    provider: "google",
    signedInAt: identity.sui.derivedAt,
  };
}

/**
 * The identity a session represents.
 *
 * The inverse of `sessionFromIdentity`, and the reason neither is stored
 * twice: keeping an identity and a session side by side in provider state
 * would give two records of the same facts and a way for them to disagree.
 */
export function identityFromSession(session: TreasurySession): AuthenticatedIdentity {
  return {
    google: {
      subject: session.subject,
      email: session.operatorEmail,
      emailVerified: session.emailVerified,
      name: session.operatorName,
    },
    sui: {
      address: session.address,
      issuer: session.issuer,
      derivedAt: session.signedInAt,
    },
  };
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
