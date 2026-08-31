"use client";

/**
 * Where Google sends the browser back.
 *
 * Reads the `id_token` from the URL FRAGMENT — the point of the implicit flow
 * is that the token never reaches a server log or a Referer header — hands it
 * to the server for verification, and shows the Sui address it derived to.
 *
 * EVERY PATH TERMINATES. A cancelled sign-in, a mismatched state, a missing
 * token, a refused credential and an unreachable server are five different
 * outcomes with five different messages. None of them is a spinner that never
 * stops, which is the failure this project has already had once.
 *
 * WHAT THIS SCREEN CAREFULLY DOES NOT CLAIM: that the person is authorized.
 * It shows a verified identity and a derived address. Company, role and
 * permissions come from the chain and are shown on the access page, where they
 * can be absent without this screen having implied otherwise.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Wordmark } from "@/components/layout/Sidebar";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { AuthError, completeSignIn, shortAddress } from "@/lib/services/authService";
import {
  clearPendingLogin,
  interpretCallback,
  readCallbackFragment,
  readPendingLogin,
} from "@/lib/identity/session";
import type { AuthenticatedIdentity } from "@/lib/identity/authorization";
import { cn } from "@/lib/utils";

type State =
  | { kind: "VERIFYING" }
  | { kind: "VERIFIED"; identity: AuthenticatedIdentity }
  | { kind: "CANCELLED"; reason: string }
  | { kind: "FAILED"; message: string };

export default function AuthCallbackPage() {
  const router = useRouter();
  const { adoptIdentity } = usePayflow();
  const [state, setState] = useState<State>({ kind: "VERIFYING" });
  /** The exchange must run once; React 18 mounts effects twice in dev. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Deferred past the commit rather than run in the effect body. Parsing the
    // fragment is synchronous, but everything it leads to is not, and updating
    // state during the render pass to report a cancelled sign-in would schedule
    // a cascading render for no benefit.
    void Promise.resolve().then(() => {
      const outcome = interpretCallback(
        readCallbackFragment(window.location.hash),
        readPendingLogin(),
      );

      // The URL carries a credential. Removed from history immediately,
      // whatever the outcome turns out to be.
      window.history.replaceState(null, "", window.location.pathname);

      if (outcome.kind !== "SUCCESS") {
        clearPendingLogin();
        setState(
          outcome.kind === "CANCELLED"
            ? { kind: "CANCELLED", reason: outcome.reason }
            : {
                kind: "FAILED",
                message:
                  outcome.kind === "STATE_MISMATCH"
                    ? "This response does not match the sign-in this browser started."
                    : outcome.kind === "NO_PENDING"
                      ? "No sign-in is in progress. Start again from the sign-in screen."
                      : "Google returned no credential.",
              },
        );
        return;
      }

      void completeSignIn({ idToken: outcome.idToken, nonce: outcome.nonce })
        .then((identity) => {
          clearPendingLogin();
          adoptIdentity(identity);
          setState({ kind: "VERIFIED", identity });
        })
        .catch((error: unknown) => {
          clearPendingLogin();
          setState({
            kind: "FAILED",
            message:
              error instanceof AuthError
                ? error.message
                : "The credential could not be verified.",
          });
        });
    });
  }, [adoptIdentity]);

  const restart = useCallback(() => router.replace("/"), [router]);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6">
      <div className="w-full max-w-[440px]">
        <div className="flex justify-center">
          <Wordmark />
        </div>

        <div className="mt-8 rounded-2xl border border-hairline bg-surface p-6 shadow-[0_2px_14px_rgba(16,20,32,0.05)]">
          {state.kind === "VERIFYING" ? (
            <div className="flex items-center gap-3 py-2">
              <span className="size-4 animate-spin rounded-full border-2 border-ai/25 border-t-ai" />
              <span className="text-[13.5px] text-ink-soft">Verifying your Google credential…</span>
            </div>
          ) : state.kind === "VERIFIED" ? (
            <Verified identity={state.identity} onContinue={() => router.replace("/dashboard")} />
          ) : (
            <Problem
              tone={state.kind === "CANCELLED" ? "neutral" : "negative"}
              title={state.kind === "CANCELLED" ? "Sign-in cancelled" : "Unable to sign in"}
              detail={state.kind === "CANCELLED" ? state.reason : state.message}
              onRetry={restart}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function Verified({
  identity,
  onContinue,
}: {
  identity: AuthenticatedIdentity;
  onContinue: () => void;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] leading-none text-pos">✓</span>
        <span className="text-[17px] font-semibold tracking-[-0.01em] text-pos">
          Identity verified
        </span>
      </div>

      <dl className="mt-4 space-y-3.5">
        <Row label="Google" value={identity.google.email ?? identity.google.subject} />
        <Row
          label="Sui identity"
          value={identity.sui.address}
          mono
          hint={`Derived from your Google credential · ${shortAddress(identity.sui.address, 10, 8)}`}
        />
      </dl>

      {/* The distinction, stated where it cannot be missed: this screen proves
          identity and says nothing about authorization. */}
      <p className="mt-4 border-t border-hairline pt-3.5 text-[11.5px] leading-relaxed text-ink-faint">
        This confirms who you are and the Sui address your identity derives to. Company
        membership and permissions are recorded on chain and shown under On-chain access.
      </p>

      <button
        type="button"
        onClick={onContinue}
        className={cn(
          "mt-4 h-10 w-full rounded-xl bg-ink text-[13.5px] font-medium text-surface",
          "transition-all hover:opacity-90 active:translate-y-px",
        )}
      >
        Continue to AI PayFlow
      </button>
    </div>
  );
}

function Problem({
  tone,
  title,
  detail,
  onRetry,
}: {
  tone: "neutral" | "negative";
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div>
      <div
        className={cn(
          "text-[15px] font-semibold tracking-[-0.01em]",
          tone === "negative" ? "text-neg" : "text-ink",
        )}
      >
        {title}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{detail}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 h-10 w-full rounded-xl border border-hairline bg-surface text-[13.5px] font-medium text-ink transition-all hover:bg-surface-sunken active:translate-y-px"
      >
        Back to sign in
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 break-all text-[13px] text-ink",
          mono && "font-mono text-[11.5px]",
        )}
      >
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}
