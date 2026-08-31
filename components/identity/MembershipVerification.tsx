"use client";

/**
 * Three records, three rows, one of which can be refreshed.
 *
 * A reader should be able to leave this panel able to say: "my membership is
 * still active; the treasury's check of it went stale; refreshing re-reads it."
 * The old wording collapsed those into "membership reading is out of date",
 * which reads as an expired membership — the opposite of what is true.
 *
 * THE BUTTON SUBMITS A REAL TRANSACTION. It POSTs to /api/membership/sync,
 * which runs `approval::sync_membership` through the server's Sui CLI. It does
 * not set a flag, does not optimistically flip a row, and does not report
 * success on a failure: a refused call renders the chain's own error and the
 * verification stays stale. On success the chain is RE-READ — the rows come
 * from that new read, not from an assumption about what the write did.
 */

import { useState } from "react";

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import {
  describeMembershipVerification,
  type Marker,
  type VerificationRow,
} from "@/lib/identity/membershipVerification";
import type { PaymentAuthorityState } from "@/lib/identity/paymentAuthority";
import { cn } from "@/lib/utils";

const GLYPH: Record<Marker, string> = { ok: "✓", warn: "⚠", fail: "✕", pending: "·" };

const TONE: Record<Marker, string> = {
  ok: "text-pos",
  warn: "text-warn",
  fail: "text-neg",
  pending: "text-ink-faint",
};

function Row({ title, row }: { title: string; row: VerificationRow }) {
  return (
    <div className="border-t border-hairline pt-3 first:border-t-0 first:pt-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {title}
      </div>
      <div className={cn("mt-1 flex items-baseline gap-1.5 text-[13.5px] font-semibold", TONE[row.marker])}>
        <span aria-hidden className="text-[13px] leading-none">
          {GLYPH[row.marker]}
        </span>
        <span>{row.label}</span>
      </div>
      {row.detail ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{row.detail}</p>
      ) : null}
    </div>
  );
}

type Refresh =
  | { phase: "idle" }
  | { phase: "running" }
  /** A digest the chain issued. The only state allowed to say "verified". */
  | { phase: "done"; digest: string | null; explorerUrl: string | null }
  | { phase: "failed"; error: string; abortCode: number | null };

export function MembershipVerification({
  authority,
  address,
  nowMs,
  onRefreshed,
}: {
  authority: PaymentAuthorityState | null;
  address: string;
  /** The instant the chain was read at, so age is measured against that. */
  nowMs: number | null;
  /** Re-reads chain state. Called only after a transaction actually succeeded. */
  onRefreshed: () => void;
}) {
  const [refresh, setRefresh] = useState<Refresh>({ phase: "idle" });
  const view = describeMembershipVerification(authority, nowMs ?? 0);

  async function run() {
    setRefresh({ phase: "running" });
    try {
      const response = await fetch("/api/membership/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        digest?: string | null;
        explorerUrl?: string | null;
        abortCode?: number | null;
        error?: string | null;
      };

      // A non-ok payload is a failure even on a 200, and an ok payload without
      // a digest is not evidence of a write. Both keep the stale rows.
      if (!response.ok || !payload.ok) {
        setRefresh({
          phase: "failed",
          error: payload.error ?? `The refresh failed (HTTP ${response.status}).`,
          abortCode: payload.abortCode ?? null,
        });
        return;
      }

      setRefresh({
        phase: "done",
        digest: payload.digest ?? null,
        explorerUrl: payload.explorerUrl ?? null,
      });
      // Re-read rather than assume. The rows below now describe the chain's
      // new answer, which is the only thing that can retire the warning.
      onRefreshed();
    } catch (error) {
      setRefresh({
        phase: "failed",
        error: error instanceof Error ? error.message : "The refresh could not be sent.",
        abortCode: null,
      });
    }
  }

  const running = refresh.phase === "running";

  return (
    <Panel tone={view.canRefresh ? "default" : undefined}>
      <PanelHeader
        eyebrow="Membership verification"
        title="Chain-Doi's verdict, and the treasury's copy of it"
        subtitle="Two separate records. The treasury re-checks its copy hourly, and a stale copy is not trusted."
        actions={
          <Badge
            tone={
              view.verification.marker === "ok"
                ? "positive"
                : view.verification.marker === "warn"
                  ? "warning"
                  : view.verification.marker === "fail"
                    ? "negative"
                    : "neutral"
            }
            dot
          >
            {view.canRefresh ? "NEEDS REFRESH" : view.verification.label.toUpperCase()}
          </Badge>
        }
      />
      <PanelBody className="space-y-3.5">
        <Row title="Chain-Doi membership" row={view.membership} />
        <Row title="Treasury verification" row={view.verification} />
        <Row title="Payment authorization" row={view.authorization} />

        {/* Offered for exactly one state — never beside a revoked membership,
            where it would imply a button can undo a revocation. */}
        {view.canRefresh ? (
          <div className="border-t border-hairline pt-3.5">
            <button
              type="button"
              onClick={() => void run()}
              disabled={running}
              className={cn(
                "h-9 rounded-lg bg-warn px-3.5 text-[13px] font-medium text-white transition-colors",
                "hover:bg-warn/90 disabled:cursor-not-allowed disabled:opacity-55",
              )}
            >
              {running ? "Refreshing membership verification…" : "Refresh membership verification"}
            </button>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Submits <code className="font-mono text-[11px]">approval::sync_membership</code>, a
              real transaction. It copies Chain-Doi&rsquo;s current answer into the treasury — it
              cannot grant membership, change a limit, or move funds.
            </p>
          </div>
        ) : null}

        {/* Only ever what the chain returned. */}
        {refresh.phase === "done" ? (
          <div className="rounded-xl border border-pos/35 bg-pos-soft px-3.5 py-3">
            <div className="text-[13px] font-semibold text-pos">✓ Membership verified</div>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
              Chain-Doi confirms you are an active Treasury Manager.
            </p>
            {refresh.digest ? (
              <p className="mt-1.5 break-all font-mono text-[10.5px] text-ink-faint">
                {refresh.explorerUrl ? (
                  <a
                    href={refresh.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {refresh.digest}
                  </a>
                ) : (
                  refresh.digest
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {refresh.phase === "failed" ? (
          <div className="rounded-xl border border-neg/35 bg-neg-soft px-3.5 py-3">
            <div className="text-[13px] font-semibold text-neg">
              Refresh failed — verification is unchanged
            </div>
            {/* The real error. Nothing here claims the membership was refreshed. */}
            <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-soft">
              {refresh.error}
            </p>
            {refresh.abortCode !== null ? (
              <p className="mt-1 font-mono text-[11px] text-neg/85">
                Move abort {refresh.abortCode}
              </p>
            ) : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
