/**
 * zkLogin configuration, and the rules about where each value may travel.
 *
 * THE SPLIT THAT MATTERS:
 *
 *   NEXT_PUBLIC_GOOGLE_CLIENT_ID   public by design. Google requires the
 *                                  browser to send it, and it authorizes
 *                                  nothing on its own.
 *   PAYFLOW_ZKLOGIN_SALT           SERVER ONLY. Never prefixed NEXT_PUBLIC_,
 *                                  never returned by an API, never logged,
 *                                  never written on chain.
 *
 * The salt is not a secret in the sense a private key is — it cannot sign
 * anything — but it is the difference between an address and a DIFFERENT
 * address. Anyone holding both a Google JWT for the account and this salt can
 * derive the same Sui address, which is exactly why it stays on the server.
 *
 * WHY NO CLIENT SECRET APPEARS ANYWHERE. zkLogin uses the OIDC implicit flow:
 * `response_type=id_token`, which returns a signed JWT straight to the
 * redirect URI and involves no code exchange. There is no client secret in
 * this design, so there is none to leak.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HACKATHON SALT STRATEGY — READ BEFORE REUSING THIS
 *
 * One fixed salt is shared by every user of this deployment. That is a
 * deliberate demo trade-off, chosen because the address must stay stable
 * across sessions and redeploys so a single on-chain membership record keeps
 * pointing at the same person.
 *
 * What it costs: with a shared salt, anyone who learns it and sees a user's
 * Google `sub` can compute that user's Sui address, so the unlinkability
 * between the Web2 and Web3 identity — one of zkLogin's real privacy
 * properties — is lost.
 *
 * Production would use a per-user salt from a dedicated salt service (Mysten's
 * enoki, or a self-hosted equivalent) that returns a salt bound to the user
 * and never exposes it in bulk. Swapping to that changes `saltFor()` below and
 * nothing else — but note it changes every derived address, which would orphan
 * existing on-chain memberships. Migrating means re-granting membership to the
 * new addresses, not editing the salt in place.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * zkLogin requires the salt to fit in 128 bits. Enforced, not assumed.
 *
 * Built with the constructor rather than a `128n` literal: this project targets
 * ES2017, where BigInt literals are a syntax error.
 */
export const MAX_SALT = BigInt(2) ** BigInt(128);

/**
 * What these readers need from an environment.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose: they read string variables and
 * nothing else, and `process.env` satisfies this. Demanding the full type
 * would force every caller — tests especially — to cast a small fixture to a
 * shape it has no reason to have.
 */
export type EnvSource = Record<string, string | undefined>;

export interface ZkLoginPublicConfig {
  /** Safe to ship to the browser: Google requires it in the authorize URL. */
  googleClientId: string;
  redirectUri: string;
}

export class IdentityConfigError extends Error {
  constructor(
    message: string,
    /** The variable at fault, so an operator is told what to set. */
    readonly variable: string,
  ) {
    super(message);
    this.name = "IdentityConfigError";
  }
}

/**
 * The salt, validated.
 *
 * Server-only by construction: it reads a variable with no NEXT_PUBLIC_ prefix,
 * which Next.js never inlines into a client bundle. Importing this module from
 * a client component would therefore get `undefined` and throw here rather
 * than silently deriving a wrong address — which is the failure worth
 * preventing, because a wrong address looks exactly like a correct one.
 */
export function saltFor(env: EnvSource = process.env): bigint {
  const raw = env.PAYFLOW_ZKLOGIN_SALT?.trim();
  if (!raw) {
    throw new IdentityConfigError(
      "PAYFLOW_ZKLOGIN_SALT is not set. zkLogin cannot derive a Sui address without it.",
      "PAYFLOW_ZKLOGIN_SALT",
    );
  }

  // Checked with a pattern before BigInt sees it. `BigInt()` accepts "0x1f",
  // "0o17" and "0b101" and returns a number the operator did not mean — and a
  // salt that is quietly a different number derives a quietly different
  // address, which is indistinguishable from a correct one until the
  // membership lookup finds nothing.
  if (!/^\d+$/.test(raw)) {
    throw new IdentityConfigError(
      `PAYFLOW_ZKLOGIN_SALT must be a decimal integer; received ${JSON.stringify(raw)}.`,
      "PAYFLOW_ZKLOGIN_SALT",
    );
  }

  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    throw new IdentityConfigError(
      `PAYFLOW_ZKLOGIN_SALT must be a decimal integer; received ${JSON.stringify(raw)}.`,
      "PAYFLOW_ZKLOGIN_SALT",
    );
  }

  // Out of range is not a soft failure. A salt >= 2^128 does not produce a
  // slightly wrong address — the derivation is undefined, and a demo that
  // shipped one would be authorizing an address nobody controls.
  if (value < BigInt(0) || value >= MAX_SALT) {
    throw new IdentityConfigError(
      `PAYFLOW_ZKLOGIN_SALT must be in [0, 2^128); received a ${value.toString().length}-digit value.`,
      "PAYFLOW_ZKLOGIN_SALT",
    );
  }

  return value;
}

/** True when a salt is present and valid, without throwing. For status UIs. */
export function saltConfigured(env: EnvSource = process.env): boolean {
  try {
    saltFor(env);
    return true;
  } catch {
    return false;
  }
}

export function googleClientId(env: EnvSource = process.env): string {
  const value = env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  if (!value) {
    throw new IdentityConfigError(
      "NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set. Create an OAuth 2.0 Web client in the " +
        "Google Cloud console and set its Client ID.",
      "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
    );
  }
  return value;
}

/**
 * Where Google sends the browser back.
 *
 * Must match an Authorized redirect URI on the OAuth client exactly, including
 * scheme, port and trailing path. Google rejects anything else, and the error
 * it returns is not obviously about this.
 */
export function redirectUri(env: EnvSource = process.env): string {
  const explicit = env.NEXT_PUBLIC_ZKLOGIN_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin = env.NEXT_PUBLIC_APP_ORIGIN?.trim() ?? "http://localhost:3000";
  return `${origin.replace(/\/$/, "")}/auth/callback`;
}

/** The values the browser legitimately needs. Never includes the salt. */
export function publicConfig(env: EnvSource = process.env): ZkLoginPublicConfig {
  return { googleClientId: googleClientId(env), redirectUri: redirectUri(env) };
}

export interface ConfigReadiness {
  ready: boolean;
  /** Every variable that is missing or invalid, with what to do about it. */
  missing: { variable: string; detail: string }[];
}

/**
 * Whether zkLogin can run at all.
 *
 * Reported rather than thrown so the sign-in screen can say precisely what is
 * unconfigured instead of failing at the moment the user clicks — and instead
 * of falling back to a mock, which would be a fake login wearing a real one's
 * clothes.
 */
export function checkConfig(env: EnvSource = process.env): ConfigReadiness {
  const missing: { variable: string; detail: string }[] = [];

  for (const check of [googleClientId, saltFor]) {
    try {
      check(env);
    } catch (error) {
      if (error instanceof IdentityConfigError) {
        missing.push({ variable: error.variable, detail: error.message });
      } else {
        throw error;
      }
    }
  }

  return { ready: missing.length === 0, missing };
}
