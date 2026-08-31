/**
 * What the browser needs to start a sign-in, and nothing more.
 *
 * Returns the Client ID (public by design — Google requires the browser to
 * send it), the redirect URI, and the current Sui epoch, which the ephemeral
 * key's validity window is measured from.
 *
 * IT DOES NOT RETURN THE SALT, and there is no field it could travel in. A
 * route that leaked it would let anyone holding a Google token for an account
 * derive that account's Sui address — the one thing the server-side split
 * exists to prevent.
 *
 * `ready: false` is a first-class answer. The sign-in screen renders what is
 * unconfigured rather than offering a button that cannot work, and rather than
 * falling back to a mock, which would be a fake login wearing a real one's
 * clothes.
 */

import { NextResponse } from "next/server";

import { checkConfig, publicConfig } from "@/lib/identity/config";
import { graphqlUrlFor } from "@/lib/sui/client";
import { configuredNetwork } from "@/lib/sui/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The current epoch, for the ephemeral key's expiry.
 *
 * Falls back to 0 rather than failing the whole request: in this phase the
 * ephemeral key signs nothing, so an unreadable epoch must not be the reason
 * somebody cannot look at their own identity. The phase that signs will need
 * this to be right, and will have to treat a failure here as fatal.
 */
async function currentEpoch(): Promise<{ epoch: number; read: boolean }> {
  try {
    const response = await fetch(graphqlUrlFor(configuredNetwork()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ epoch { epochId } }" }),
      cache: "no-store",
    });
    const payload = (await response.json()) as { data?: { epoch?: { epochId?: number } } };
    const epoch = payload.data?.epoch?.epochId;
    return typeof epoch === "number" ? { epoch, read: true } : { epoch: 0, read: false };
  } catch {
    return { epoch: 0, read: false };
  }
}

export async function GET() {
  const readiness = checkConfig();
  if (!readiness.ready) {
    return NextResponse.json({ ok: true, ready: false, missing: readiness.missing });
  }

  const { googleClientId, redirectUri } = publicConfig();
  const { epoch, read } = await currentEpoch();

  return NextResponse.json({
    ok: true,
    ready: true,
    googleClientId,
    redirectUri,
    epoch,
    epochRead: read,
  });
}
