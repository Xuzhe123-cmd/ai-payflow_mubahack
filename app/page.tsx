"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { usePayflow } from "@/components/providers/PayflowProvider";
import { Wordmark } from "@/components/layout/Sidebar";
import { cn } from "@/lib/utils";
import {
  AuthError,
  beginSignIn,
  fetchAuthConfig,
  type AuthConfigStatus,
} from "@/lib/services/authService";

/**
 * Sign-in.
 *
 * The Google button is zkLogin: a Google credential becomes a Sui address
 * without the operator ever seeing a seed phrase. That is the reason this
 * screen looks like a finance product and not like a wallet — the wallet is
 * an implementation detail the treasury team should never have to think about.
 *
 * WHAT SIGNING IN DOES NOT DO, and the screen says so: it proves who the human
 * is. It does not make them a member of a company, and it grants no authority
 * over any treasury. Those are read from chain afterwards and may be absent.
 *
 * FOUR STATES, none of them a permanent spinner:
 *   checking      asking the server whether zkLogin is configured
 *   ready         the button works
 *   unconfigured  it does not, and here is exactly which variable is missing
 *   error         the attempt failed, with a retry
 */
export default function LoginPage() {
  const router = useRouter();
  const { state } = usePayflow();
  const [config, setConfig] = useState<AuthConfigStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.hydrated && state.session) router.replace("/dashboard");
  }, [router, state.hydrated, state.session]);

  // Fetch only. `config` already starts null, so the first run needs no reset,
  // and the retry button does its own before calling this.
  const loadConfig = useCallback(() => {
    void fetchAuthConfig()
      .then(setConfig)
      // A server that cannot answer is reported, never retried silently into a
      // spinner that never stops.
      .catch(() =>
        setConfig({
          ready: false,
          missing: [
            {
              variable: "server",
              detail: "The sign-in configuration endpoint could not be reached.",
            },
          ],
        }),
      );
  }, []);

  useEffect(loadConfig, [loadConfig]);

  const onSignIn = () => {
    if (!config?.ready) return;
    setPending(true);
    setError(null);
    try {
      // Leaves the app entirely. The session materialises in /auth/callback.
      window.location.href = beginSignIn(config);
    } catch (cause) {
      setPending(false);
      setError(
        cause instanceof AuthError ? cause.message : "Sign-in could not be started.",
      );
    }
  };

  const ready = config?.ready === true;
  const checking = config === null;

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-6">
      <BackdropGrid />

      <div className="relative w-full max-w-[404px]">
        <div className="flex justify-center">
          <Wordmark />
        </div>

        <div className="mt-9 text-center">
          <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-ink">
            Autonomous treasury for
            <br />
            modern businesses
          </h1>

          <div className="mt-6 space-y-1.5 text-[14.5px] leading-relaxed">
            <p className="text-ink-soft">
              <span className="font-medium text-ai">AI</span> analyzes.
            </p>
            <p className="text-ink-soft">
              <span className="font-medium text-chain">Sui</span> enforces.
            </p>
            <p className="text-ink-soft">Your treasury stays protected.</p>
          </div>
        </div>

        <div className="mt-9 rounded-2xl border border-hairline bg-surface p-6 shadow-[0_2px_14px_rgba(16,20,32,0.05)]">
          <button
            type="button"
            onClick={onSignIn}
            disabled={!ready || pending}
            className={cn(
              "flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-hairline",
              "bg-surface text-[14px] font-medium text-ink transition-all",
              "hover:bg-surface-sunken active:translate-y-px",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {checking ? (
              <>
                <span className="size-4 animate-spin rounded-full border-2 border-ai/25 border-t-ai" />
                Checking sign-in configuration…
              </>
            ) : pending ? (
              <>
                <span className="size-4 animate-spin rounded-full border-2 border-ai/25 border-t-ai" />
                Redirecting to Google…
              </>
            ) : (
              <>
                <GoogleMark />
                Continue with Google
              </>
            )}
          </button>

          {config && !config.ready ? (
            <div className="mt-3.5 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-3">
              <div className="text-[12.5px] font-medium text-warn">
                Sign-in is not configured
              </div>
              <ul className="mt-1.5 space-y-1">
                {config.missing.map((item) => (
                  <li key={item.variable} className="text-[11.5px] leading-relaxed text-ink-soft">
                    <span className="font-mono text-[11px] text-ink">{item.variable}</span>
                    {" — "}
                    {item.detail}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  setConfig(null);
                  setError(null);
                  loadConfig();
                }}
                className="mt-2.5 text-[11.5px] font-medium text-ai underline"
              >
                Check again
              </button>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3.5 rounded-xl border border-neg/30 bg-neg-soft px-3.5 py-3">
              <div className="text-[12.5px] font-medium text-neg">Unable to start sign-in</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{error}</p>
            </div>
          ) : null}

          <p className="mt-3.5 text-center text-[12px] leading-relaxed text-ink-faint">
            Secure login with zkLogin. Your Google account derives a Sui address —
            no seed phrase, no browser extension.
          </p>

          {/* Said before signing in, not discovered afterwards. */}
          <p className="mt-2 text-center text-[11px] leading-relaxed text-ink-faint">
            Signing in proves your identity. Access to a company treasury is granted
            separately, on chain.
          </p>
        </div>

        <div className="mt-8 flex items-center justify-center gap-2 text-[11.5px] text-ink-faint">
          <span>Sui</span>
          <span className="text-hairline">·</span>
          <span>zkLogin</span>
          <span className="text-hairline">·</span>
          <span>Walrus</span>
          <span className="text-hairline">·</span>
          <span>Cloudflare Workers AI</span>
        </div>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

/** A very quiet grid. Enough to feel engineered, not enough to be noticed. */
function BackdropGrid() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 opacity-[0.55]"
      style={{
        backgroundImage:
          "linear-gradient(var(--hairline) 1px, transparent 1px), linear-gradient(90deg, var(--hairline) 1px, transparent 1px)",
        backgroundSize: "64px 64px",
        maskImage:
          "radial-gradient(ellipse 70% 55% at 50% 45%, #000 20%, transparent 75%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 70% 55% at 50% 45%, #000 20%, transparent 75%)",
      }}
    />
  );
}
