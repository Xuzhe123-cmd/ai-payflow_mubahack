/**
 * The zkLogin ceremony: a Google credential becomes a Sui address.
 *
 *   ephemeral keypair          generated in the browser, never persisted
 *        ↓
 *   nonce = H(eph_pk, maxEpoch, randomness)
 *        ↓
 *   Google OIDC  (response_type=id_token, implicit — no client secret)
 *        ↓
 *   JWT          signed by Google, carrying iss / aud / sub / nonce
 *        ↓  [server: verify signature, then apply the server-only salt]
 *   address = H(iss, aud, sub, salt)
 *
 * WHERE EACH STEP RUNS, and why. The nonce and the ephemeral key are the
 * browser's. The salt and therefore the address derivation are the server's,
 * because a salt that reached the browser would be a salt anyone could read.
 * The JWT crosses once, from browser to server, and is never stored.
 *
 * WHAT THIS PHASE DOES AND DOES NOT DO. It derives and proves an ADDRESS. It
 * does not obtain a ZK proof, because nothing here signs a transaction — a
 * proof is needed to spend, and this phase spends nothing. The prover is a
 * later concern and its absence is not a shortcut: an address derived from a
 * verified JWT is exactly as authoritative for identity purposes with or
 * without one.
 *
 * VERIFICATION IS NOT OPTIONAL. `jwtToAddress` will happily derive an address
 * from an unsigned, forged, or expired token — it decodes, it does not verify.
 * Anyone could then POST a hand-written JWT claiming any `sub` and receive the
 * matching address. So the signature is checked against Google's published
 * keys, and issuer, audience and expiry are checked too, before the salt is
 * ever applied.
 */

import { createPublicKey, createVerify } from "node:crypto";

import { jwtToAddress } from "@mysten/sui/zklogin";

import { googleClientId, saltFor, type EnvSource } from "./config";

/** Google's OIDC discovery-published signing keys. */
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** Both spellings Google uses for the issuer claim. */
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface GoogleClaims {
  /** The stable, per-account subject. THIS is the identity, not the email. */
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  nonce?: string;
}

export class ZkLoginError extends Error {
  constructor(
    message: string,
    readonly code:
      | "MALFORMED_JWT"
      | "BAD_SIGNATURE"
      | "BAD_ISSUER"
      | "BAD_AUDIENCE"
      | "EXPIRED"
      | "BAD_NONCE"
      | "JWKS_UNAVAILABLE",
  ) {
    super(message);
    this.name = "ZkLoginError";
  }
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(base64UrlToBuffer(segment).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ZkLoginError("The Google credential is not a readable JWT.", "MALFORMED_JWT");
  }
}

/**
 * Google's signing keys, cached for the lifetime they advertise.
 *
 * Refetched rather than pinned, because Google rotates these. A pinned key
 * would work until it silently did not.
 */
let jwksCache: { keys: Jwk[]; fetchedAtMs: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export async function fetchGoogleKeys(now = Date.now()): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.fetchedAtMs < JWKS_TTL_MS) return jwksCache.keys;

  let payload: { keys?: Jwk[] };
  try {
    const response = await fetch(GOOGLE_JWKS_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new ZkLoginError(
        `Google's key endpoint returned ${response.status}.`,
        "JWKS_UNAVAILABLE",
      );
    }
    payload = (await response.json()) as { keys?: Jwk[] };
  } catch (error) {
    if (error instanceof ZkLoginError) throw error;
    throw new ZkLoginError(
      "Google's signing keys could not be fetched, so the credential cannot be verified.",
      "JWKS_UNAVAILABLE",
    );
  }

  const keys = payload.keys ?? [];
  jwksCache = { keys, fetchedAtMs: now };
  return keys;
}

/** Drops the cached keys. For tests, and for a forced refresh after rotation. */
export function resetGoogleKeyCache(): void {
  jwksCache = null;
}

/**
 * Verifies a Google ID token and returns its claims.
 *
 * Every check here is load-bearing:
 *   signature  the token really came from Google
 *   issuer     it is a Google token, not another provider's
 *   audience   it was issued for THIS application, not a different one
 *   expiry     it is current
 *   nonce      it answers the request this browser actually made
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: {
    expectedNonce?: string;
    clientId?: string;
    now?: number;
    keys?: Jwk[];
  } = {},
): Promise<GoogleClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new ZkLoginError("The Google credential is not a JWT.", "MALFORMED_JWT");
  }

  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) throw new ZkLoginError("The credential names no signing key.", "MALFORMED_JWT");

  const keys = options.keys ?? (await fetchGoogleKeys());
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) {
    throw new ZkLoginError(
      "The credential was signed by a key Google does not currently publish.",
      "BAD_SIGNATURE",
    );
  }

  const publicKey = createPublicKey({ key: { ...jwk, kty: "RSA" }, format: "jwk" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, base64UrlToBuffer(parts[2]))) {
    throw new ZkLoginError("The credential's signature is not valid.", "BAD_SIGNATURE");
  }

  const iss = String(payload.iss ?? "");
  if (!GOOGLE_ISSUERS.has(iss)) {
    throw new ZkLoginError(`The credential was issued by ${iss || "nobody"}.`, "BAD_ISSUER");
  }

  const aud = String(payload.aud ?? "");
  const expectedAud = options.clientId ?? googleClientId();
  if (aud !== expectedAud) {
    // Issued for a different application. Accepting it would let any site's
    // Google token authenticate here.
    throw new ZkLoginError("The credential was issued for a different application.", "BAD_AUDIENCE");
  }

  const exp = Number(payload.exp ?? 0);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(exp) || exp * 1000 <= now) {
    throw new ZkLoginError("The Google credential has expired.", "EXPIRED");
  }

  if (options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
    throw new ZkLoginError(
      "The credential does not answer this sign-in request.",
      "BAD_NONCE",
    );
  }

  const sub = String(payload.sub ?? "");
  if (!sub) throw new ZkLoginError("The credential carries no subject.", "MALFORMED_JWT");

  return {
    sub,
    iss,
    aud,
    exp,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
  };
}

/**
 * The Sui address for a verified credential.
 *
 * SERVER ONLY — it reads the salt. Takes the raw JWT because that is what
 * `jwtToAddress` consumes, and requires the caller to have verified it first;
 * the parameter is named to make an unverified call read wrongly.
 *
 * `legacyAddress: false` selects the current derivation. It is a required
 * positional argument in @mysten/sui v2 with no default, and getting it wrong
 * yields a different, valid-looking address.
 */
export function addressForVerifiedJwt(
  verifiedJwt: string,
  env: EnvSource = process.env,
): string {
  return jwtToAddress(verifiedJwt, saltFor(env), false);
}

/**
 * The Google authorize URL for the implicit flow.
 *
 * `response_type=id_token` returns a signed JWT directly — no code exchange,
 * therefore no client secret anywhere in this application.
 */
export function buildGoogleAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  nonce: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "id_token",
    scope: "openid email profile",
    nonce: input.nonce,
    state: input.state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
