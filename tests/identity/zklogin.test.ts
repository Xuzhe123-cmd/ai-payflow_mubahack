/**
 * The salt, and the verification that must happen before it is applied.
 *
 * TWO SECURITY BOUNDARIES ARE UNDER TEST.
 *
 * The first is the salt. It is server-only, it must be in [0, 2^128), and the
 * same Google identity with the same salt must always derive the same address
 * — because an on-chain membership record points at one address, and a salt
 * that drifted would silently orphan it.
 *
 * The second is JWT verification, and it is the one that matters most.
 * `jwtToAddress` decodes; it does not verify. A route that skipped
 * verification would hand out the address for any `sub` an attacker cared to
 * type — including, if that address happened to be a Chain-Doi member, its
 * authorization. So the tests below forge tokens and check each is refused.
 */

import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MAX_SALT, checkConfig, saltConfigured, saltFor } from "../../lib/identity/config";
import {
  ZkLoginError,
  buildGoogleAuthUrl,
  resetGoogleKeyCache,
  verifyGoogleIdToken,
} from "../../lib/identity/zklogin";

const CLIENT_ID = "123456789-abcdefg.apps.googleusercontent.com";

// --- a throwaway RSA key, standing in for Google's ---------------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
const KEYS = [{ kid: "test-key", kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }];

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A correctly signed Google-shaped token. */
function signToken(claims: Record<string, unknown>, kid = "test-key"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "104729384756102938475",
    email: "xuzhe272486@gmail.com",
    email_verified: true,
    name: "Xu Zhe",
    nonce: "the-nonce",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

const verify = (token: string, options = {}) =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, keys: KEYS, ...options });

// --- the salt ----------------------------------------------------------------

describe("the zkLogin salt", () => {
  it("is read from a server-only variable", () => {
    // No NEXT_PUBLIC_ prefix means Next.js never inlines it into the client
    // bundle. The name is the mechanism, so it is asserted.
    expect(saltFor({ PAYFLOW_ZKLOGIN_SALT: "12345" })).toBe(BigInt(12345));
    expect(saltConfigured({})).toBe(false);
  });

  it("refuses a value at or beyond 2^128", () => {
    // Not a soft failure: out of range, the derivation is undefined, and a demo
    // that shipped one would authorize an address nobody controls.
    expect(() => saltFor({ PAYFLOW_ZKLOGIN_SALT: MAX_SALT.toString() })).toThrow(
      /2\^128/,
    );
    expect(() =>
      saltFor({ PAYFLOW_ZKLOGIN_SALT: (MAX_SALT + BigInt(1)).toString() }),
    ).toThrow();
    // The largest legal salt is accepted.
    expect(
      saltFor({ PAYFLOW_ZKLOGIN_SALT: (MAX_SALT - BigInt(1)).toString() }),
    ).toBe(MAX_SALT - BigInt(1));
  });

  it("refuses a non-integer rather than coercing it", () => {
    for (const bad of ["", "   ", "abc", "1.5", "0x1f"]) {
      expect(() => saltFor({ PAYFLOW_ZKLOGIN_SALT: bad })).toThrow();
    }
  });

  it("is stable — the same variable always yields the same value", () => {
    // The property the on-chain membership depends on. A salt that varied per
    // session would derive a new address each login and orphan the record.
    const env = { PAYFLOW_ZKLOGIN_SALT: "98765432109876543210" };
    expect(saltFor(env)).toBe(saltFor(env));
  });

  it("reports every missing variable at once", () => {
    const readiness = checkConfig({});

    expect(readiness.ready).toBe(false);
    expect(readiness.missing.map((m) => m.variable).sort()).toEqual([
      "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
      "PAYFLOW_ZKLOGIN_SALT",
    ]);
  });

  it("is ready once both are set", () => {
    expect(
      checkConfig({
        NEXT_PUBLIC_GOOGLE_CLIENT_ID: CLIENT_ID,
        PAYFLOW_ZKLOGIN_SALT: "12345",
      }).ready,
    ).toBe(true);
  });
});

// --- JWT verification --------------------------------------------------------

describe("verifying a Google credential", () => {
  it("accepts a correctly signed, current token", async () => {
    const result = await verify(signToken(claims()));

    expect(result.sub).toBe("104729384756102938475");
    expect(result.email).toBe("xuzhe272486@gmail.com");
    expect(result.emailVerified).toBe(true);
  });

  it("refuses a token whose signature does not check out", async () => {
    // The forgery that would otherwise hand out any address on request.
    const token = signToken(claims());
    const tampered = token.slice(0, -6) + "AAAAAA";

    await expect(verify(tampered)).rejects.toThrow(ZkLoginError);
    await expect(verify(tampered)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("refuses an unsigned token", async () => {
    const header = b64url(JSON.stringify({ alg: "none", kid: "test-key" }));
    const payload = b64url(JSON.stringify(claims()));

    await expect(verify(`${header}.${payload}.`)).rejects.toMatchObject({
      code: "BAD_SIGNATURE",
    });
  });

  it("refuses a token signed by a key Google does not publish", async () => {
    await expect(verify(signToken(claims(), "some-other-kid"))).rejects.toMatchObject({
      code: "BAD_SIGNATURE",
    });
  });

  it("refuses a token issued for a different application", async () => {
    // Without this check, any site's Google token would authenticate here.
    await expect(verify(signToken(claims({ aud: "someone-else.apps.googleusercontent.com" })))).rejects.toMatchObject(
      { code: "BAD_AUDIENCE" },
    );
  });

  it("refuses a token from another issuer", async () => {
    await expect(verify(signToken(claims({ iss: "https://evil.example" })))).rejects.toMatchObject({
      code: "BAD_ISSUER",
    });
  });

  it("refuses an expired token", async () => {
    await expect(
      verify(signToken(claims({ exp: Math.floor(Date.now() / 1000) - 60 }))),
    ).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("refuses a token answering a different sign-in request", async () => {
    await expect(
      verify(signToken(claims({ nonce: "a-different-nonce" })), { expectedNonce: "the-nonce" }),
    ).rejects.toMatchObject({ code: "BAD_NONCE" });

    // And accepts the matching one.
    await expect(
      verify(signToken(claims()), { expectedNonce: "the-nonce" }),
    ).resolves.toMatchObject({ sub: "104729384756102938475" });
  });

  it("refuses malformed input rather than deriving from it", async () => {
    for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d"]) {
      await expect(verify(bad)).rejects.toBeInstanceOf(ZkLoginError);
    }
  });

  it("accepts both spellings of the Google issuer", async () => {
    await expect(verify(signToken(claims({ iss: "accounts.google.com" })))).resolves.toBeDefined();
  });
});

// --- the authorize URL -------------------------------------------------------

describe("the Google authorize URL", () => {
  const url = new URL(
    buildGoogleAuthUrl({
      clientId: CLIENT_ID,
      redirectUri: "http://localhost:3000/auth/callback",
      nonce: "the-nonce",
      state: "the-state",
    }),
  );

  it("uses the implicit id_token flow, which needs no client secret", () => {
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.toString()).not.toContain("client_secret");
    expect(url.toString()).not.toContain("code");
  });

  it("carries the nonce that binds the response to this request", () => {
    expect(url.searchParams.get("nonce")).toBe("the-nonce");
    expect(url.searchParams.get("state")).toBe("the-state");
  });

  it("requests only the scopes an identity needs", () => {
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("Google key handling", () => {
  it("can be reset, so a rotated key is not cached indefinitely", () => {
    expect(() => resetGoogleKeyCache()).not.toThrow();
  });
});
