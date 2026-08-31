"use client";

/**
 * The browser's half of the zkLogin ceremony.
 *
 * Three things live here and nowhere else: the ephemeral keypair, the
 * randomness behind the nonce, and the `state` that ties a redirect back to
 * the click that started it. All three are per-attempt and all three are
 * discarded the moment the attempt resolves.
 *
 * WHAT IS DELIBERATELY ABSENT: the salt. It never reaches this file, this
 * bundle, or this browser. The JWT goes to the server and an address comes
 * back; the derivation happens where the salt lives.
 *
 * WHAT IS STORED, AND WHY IT IS SAFE TO. `sessionStorage` holds the pending
 * attempt (nonce, state, ephemeral key) between the redirect out and the
 * redirect back, because the page is destroyed in between and there is nowhere
 * else to put it. It holds the resolved identity afterwards so a refresh does
 * not force a new sign-in. Neither is a credential: the identity is an address
 * and an email, and possessing them grants nothing — authorization is resolved
 * from the chain on every read.
 *
 * The JWT itself is never persisted. It is used once, posted to the server,
 * and dropped.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";

import type { AuthenticatedIdentity } from "./authorization";

const PENDING_KEY = "payflow.zklogin.pending.v1";
const IDENTITY_KEY = "payflow.zklogin.identity.v1";

/**
 * How many epochs the ephemeral key stays valid.
 *
 * Small on purpose. The key authorizes nothing in this phase — no transaction
 * is signed — but a short window is the right default to carry into the phase
 * where one is.
 */
export const EPHEMERAL_EPOCH_WINDOW = 2;

export interface PendingLogin {
  nonce: string;
  state: string;
  /** The ephemeral secret, base64. Per-attempt, and never reused. */
  ephemeralSecret: string;
  maxEpoch: number;
  startedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Private modes and blocked site data. Not a reason to fail the app.
    return null;
  }
}

/**
 * Starts an attempt: mints the ephemeral key, the randomness and the nonce.
 *
 * `maxEpoch` is passed in rather than fetched here, so this stays pure enough
 * to test and the caller decides how to learn the current epoch.
 */
export function beginLogin(currentEpoch: number): { pending: PendingLogin; nonce: string } {
  const keypair = Ed25519Keypair.generate();
  const randomness = generateRandomness();
  const maxEpoch = currentEpoch + EPHEMERAL_EPOCH_WINDOW;
  const nonce = generateNonce(keypair.getPublicKey(), maxEpoch, randomness);

  const pending: PendingLogin = {
    nonce,
    // Binds the redirect back to this click. A response carrying a different
    // state did not come from a sign-in this tab started.
    state: generateRandomness(),
    ephemeralSecret: keypair.getSecretKey(),
    maxEpoch,
    startedAt: new Date().toISOString(),
  };

  storage()?.setItem(PENDING_KEY, JSON.stringify(pending));
  return { pending, nonce };
}

export function readPendingLogin(): PendingLogin | null {
  const raw = storage()?.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingLogin;
    return typeof parsed?.nonce === "string" && typeof parsed?.state === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Clears the attempt. Called on success, failure, and cancellation alike. */
export function clearPendingLogin(): void {
  storage()?.removeItem(PENDING_KEY);
}

export function storeIdentity(identity: AuthenticatedIdentity): void {
  storage()?.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function readIdentity(): AuthenticatedIdentity | null {
  const raw = storage()?.getItem(IDENTITY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthenticatedIdentity;
    // A stored blob missing an address is not an identity. Better to sign in
    // again than to carry a half-formed one into an authorization lookup.
    return typeof parsed?.sui?.address === "string" && parsed.sui.address.length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function clearIdentity(): void {
  storage()?.removeItem(IDENTITY_KEY);
  clearPendingLogin();
}

/**
 * Reads the `id_token` Google returns in the URL fragment.
 *
 * A FRAGMENT, not a query string — which is the point of the implicit flow:
 * the token never reaches a server log or a Referer header on the way back.
 */
export function readCallbackFragment(hash: string): {
  idToken: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    idToken: params.get("id_token"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

/**
 * What the callback should do with what Google returned.
 *
 * Pure, so every branch is testable without a browser: a cancelled sign-in, a
 * mismatched state, a missing token, and success are four different outcomes
 * and the screen must not collapse them into a spinner.
 */
export type CallbackOutcome =
  | { kind: "SUCCESS"; idToken: string; nonce: string }
  /** The person pressed cancel, or Google refused. Not an error to shout about. */
  | { kind: "CANCELLED"; reason: string }
  /** The response does not match the attempt this tab started. */
  | { kind: "STATE_MISMATCH" }
  /** No attempt is on record — a stale tab, or a direct visit. */
  | { kind: "NO_PENDING" }
  | { kind: "NO_TOKEN" };

export function interpretCallback(
  fragment: ReturnType<typeof readCallbackFragment>,
  pending: PendingLogin | null,
): CallbackOutcome {
  if (fragment.error) {
    return {
      kind: "CANCELLED",
      reason: fragment.errorDescription ?? fragment.error,
    };
  }
  if (!pending) return { kind: "NO_PENDING" };
  // Checked before the token is looked at: a response from another flow should
  // not be examined, let alone acted on.
  if (fragment.state !== pending.state) return { kind: "STATE_MISMATCH" };
  if (!fragment.idToken) return { kind: "NO_TOKEN" };

  return { kind: "SUCCESS", idToken: fragment.idToken, nonce: pending.nonce };
}
