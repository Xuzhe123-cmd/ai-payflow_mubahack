/**
 * The one place a Google credential becomes a Sui address.
 *
 * SERVER ONLY, and that is the whole point. The salt lives here and never
 * leaves — the browser sends a JWT and receives an address, so a reader of the
 * client bundle learns the address but not what produced it.
 *
 * WHAT THIS ROUTE REFUSES TO SKIP. `jwtToAddress` will derive an address from
 * any well-formed JWT, signed or not. Without verification, anyone could POST
 * a hand-written token claiming any `sub` and be handed the matching address —
 * and if that address happened to be a Chain-Doi member, they would be handed
 * its authorization too. So the signature is checked against Google's
 * published keys, and the issuer, audience and expiry with it, before the salt
 * is applied.
 *
 * WHAT IT DOES NOT DO: issue a capability, mint a session token, or touch the
 * treasury. It answers one question — which Sui address does this verified
 * Google identity derive to — and authorization is resolved separately from
 * the on-chain company record.
 */

import { NextResponse } from "next/server";

import { checkConfig, googleClientId } from "@/lib/identity/config";
import {
  ZkLoginError,
  addressForVerifiedJwt,
  verifyGoogleIdToken,
} from "@/lib/identity/zklogin";

export const runtime = "nodejs";
/** An identity answer must never be served from a cache. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const readiness = checkConfig();
  if (!readiness.ready) {
    // Told plainly, with the variable names, because the remedy is
    // configuration and a vaguer message would cost an operator an hour.
    return NextResponse.json(
      {
        ok: false,
        code: "NOT_CONFIGURED",
        message: "zkLogin is not configured on the server.",
        missing: readiness.missing,
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const idToken =
    typeof body === "object" && body !== null && "idToken" in body
      ? (body as { idToken: unknown }).idToken
      : undefined;
  const expectedNonce =
    typeof body === "object" && body !== null && "nonce" in body
      ? (body as { nonce: unknown }).nonce
      : undefined;

  if (typeof idToken !== "string" || idToken.length === 0) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "idToken (string) is required." },
      { status: 400 },
    );
  }

  try {
    const claims = await verifyGoogleIdToken(idToken, {
      expectedNonce: typeof expectedNonce === "string" ? expectedNonce : undefined,
      clientId: googleClientId(),
    });

    const address = addressForVerifiedJwt(idToken);

    return NextResponse.json({
      ok: true,
      // The address is the authorization anchor. Everything else on this
      // response is for display.
      address,
      issuer: claims.iss,
      google: {
        subject: claims.sub,
        email: claims.email ?? null,
        emailVerified: claims.emailVerified ?? false,
        name: claims.name ?? null,
      },
      derivedAt: new Date().toISOString(),
      // Stated in the payload so a reader of the network tab sees the claim
      // being made, and can check it against the UI.
      note: "Address derived from the verified Google credential with a server-held salt.",
    });
  } catch (error) {
    if (error instanceof ZkLoginError) {
      const status = error.code === "JWKS_UNAVAILABLE" ? 503 : 401;
      return NextResponse.json(
        { ok: false, code: error.code, message: error.message },
        { status },
      );
    }
    // Never leak an internal message to an unauthenticated caller.
    return NextResponse.json(
      { ok: false, code: "VERIFY_FAILED", message: "The credential could not be verified." },
      { status: 401 },
    );
  }
}
