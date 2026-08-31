/**
 * The redirect round-trip, and the four ways it can fail.
 *
 * The callback is where a sign-in either becomes an identity or does not, and
 * every non-success path used to be the kind of thing a screen quietly turns
 * into a spinner. Each is a named outcome here, tested, so the screen has
 * something specific to render.
 *
 * The `state` check is the security-relevant one: it binds the response to the
 * click that started it. Without it, a response from another flow — or one an
 * attacker induced — would be examined and acted on.
 */

import { describe, expect, it } from "vitest";

import {
  interpretCallback,
  readCallbackFragment,
  type PendingLogin,
} from "../../lib/identity/session";

function pending(overrides: Partial<PendingLogin> = {}): PendingLogin {
  return {
    nonce: "the-nonce",
    state: "the-state",
    ephemeralSecret: "suiprivkey1...",
    maxEpoch: 42,
    startedAt: "2026-08-31T00:00:00Z",
    ...overrides,
  };
}

describe("reading what Google returned", () => {
  it("reads the token from the fragment, not the query string", () => {
    // The implicit flow puts it in the fragment so it never reaches a server
    // log or a Referer header. Parsing it from anywhere else would undo that.
    const fragment = readCallbackFragment("#id_token=abc.def.ghi&state=the-state");

    expect(fragment.idToken).toBe("abc.def.ghi");
    expect(fragment.state).toBe("the-state");
    expect(fragment.error).toBeNull();
  });

  it("reads an error response", () => {
    const fragment = readCallbackFragment(
      "#error=access_denied&error_description=The+user+cancelled",
    );

    expect(fragment.error).toBe("access_denied");
    expect(fragment.errorDescription).toBe("The user cancelled");
    expect(fragment.idToken).toBeNull();
  });

  it("copes with an empty fragment", () => {
    for (const hash of ["", "#"]) {
      const fragment = readCallbackFragment(hash);
      expect(fragment.idToken).toBeNull();
      expect(fragment.error).toBeNull();
    }
  });
});

describe("what the callback should do", () => {
  it("succeeds when the state matches and a token is present", () => {
    const outcome = interpretCallback(
      readCallbackFragment("#id_token=abc.def.ghi&state=the-state"),
      pending(),
    );

    expect(outcome).toEqual({ kind: "SUCCESS", idToken: "abc.def.ghi", nonce: "the-nonce" });
  });

  it("reports a cancelled sign-in as cancelled, not as an error", () => {
    // Pressing cancel is a normal thing to do. Shouting about it would be wrong.
    const outcome = interpretCallback(
      readCallbackFragment("#error=access_denied&error_description=The+user+cancelled"),
      pending(),
    );

    expect(outcome.kind).toBe("CANCELLED");
    if (outcome.kind !== "CANCELLED") return;
    expect(outcome.reason).toBe("The user cancelled");
  });

  it("refuses a response whose state does not match this browser's attempt", () => {
    // THE SECURITY CHECK. A response from another flow must not be examined,
    // let alone acted on.
    const outcome = interpretCallback(
      readCallbackFragment("#id_token=abc.def.ghi&state=some-other-state"),
      pending(),
    );

    expect(outcome.kind).toBe("STATE_MISMATCH");
  });

  it("checks the state BEFORE looking at the token", () => {
    // A mismatched state with a missing token is still a state mismatch — the
    // ordering is what stops a foreign response being inspected at all.
    const outcome = interpretCallback(
      readCallbackFragment("#state=some-other-state"),
      pending(),
    );

    expect(outcome.kind).toBe("STATE_MISMATCH");
  });

  it("reports a stale tab with no attempt on record", () => {
    const outcome = interpretCallback(
      readCallbackFragment("#id_token=abc.def.ghi&state=the-state"),
      null,
    );

    expect(outcome.kind).toBe("NO_PENDING");
  });

  it("reports a matching response that carries no token", () => {
    const outcome = interpretCallback(readCallbackFragment("#state=the-state"), pending());

    expect(outcome.kind).toBe("NO_TOKEN");
  });

  it("never returns SUCCESS without both a token and a matching state", () => {
    // Stated as an invariant over every shape the fragment can take, so a
    // future branch cannot quietly add a fifth way to succeed.
    const fragments = [
      "",
      "#",
      "#id_token=abc",
      "#state=the-state",
      "#state=wrong&id_token=abc",
      "#error=access_denied",
    ];

    for (const hash of fragments) {
      const outcome = interpretCallback(readCallbackFragment(hash), pending());
      if (outcome.kind === "SUCCESS") {
        expect(hash).toContain("id_token=");
        expect(hash).toContain("state=the-state");
      }
    }
  });
});
