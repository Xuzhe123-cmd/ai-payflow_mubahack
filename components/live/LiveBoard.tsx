/**
 * The live demo surface — the interactive half.
 *
 * Deliberately one screen rather than several routes: during a demo, navigating
 * loses the audience. Dashboard on top, queue on the left, the reasoning for
 * whichever invoice is selected on the right.
 *
 * The first board is rendered on the server and handed in as `initialBoard`, so
 * a judge sees real figures on first paint rather than a spinner. Refreshes
 * after that go through /api/decisions.
 *
 * This component performs no financial arithmetic. Even the verdict chips and
 * the chart geometry come from pure functions in lib/decision/present.ts.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/common/Badge";
import { DecisionPanel } from "@/components/live/DecisionPanel";
import { InvoiceQueue } from "@/components/live/InvoiceQueue";
import { ArchitectureStrip } from "@/components/live/ArchitectureStrip";
import { TreasuryOverview } from "@/components/live/TreasuryOverview";
import { defaultSelection, summariseQueue } from "@/lib/decision/present";
import { fetchDecisionBoard, type DecisionBoard } from "@/lib/services/decisionService";
import { formatMoneyRounded } from "@/lib/util/money";


export interface LiveBoardProps {
  /** Rendered on the server, so first paint carries real figures. */
  initialBoard: DecisionBoard | null;
  /** Set when the server read failed; the client can retry. */
  initialError: string | null;
  asOf: string;
}

export default function LiveBoard({ initialBoard, initialError, asOf }: LiveBoardProps) {
  const [board, setBoard] = useState<DecisionBoard | null>(initialBoard);
  const [error, setError] = useState<string | null>(initialError);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialBoard ? defaultSelection(initialBoard.decisions) : null,
  );
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchDecisionBoard({ asOf, signal });
      setBoard(next);
      setSelectedId((current) => current ?? defaultSelection(next.decisions));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not read chain state");
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    // Only fetch on mount when the server had nothing to give us — otherwise
    // the first paint is already correct and refetching just makes it flicker.
    if (initialBoard !== null) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [initialBoard, load]);

  const summary = useMemo(
    () => (board ? summariseQueue(board.decisions) : null),
    [board],
  );
  const selected = useMemo(
    () => board?.decisions.find((entry) => entry.facts.invoiceObjectId === selectedId) ?? null,
    [board, selectedId],
  );

  if (error) {
    return (
      <Shell>
        <div className="rounded-xl border border-neg/25 bg-neg-soft p-6">
          <h2 className="text-sm font-medium text-neg">Could not read the chain</h2>
          <p className="mt-1 text-sm text-ink-soft">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 rounded-md border border-hairline bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }

  if (!board || !summary) {
    return (
      <Shell>
        <div className="rounded-xl border border-hairline bg-surface p-6 text-sm text-ink-faint">
          Reading live state from Sui testnet…
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">AI PayFlow</h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            AI recommends · Sui enforces — live testnet state, read-only
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="positive">{summary.byAction.PAY_NOW} pay now</Badge>
          <Badge tone="chain">{summary.byAction.SCHEDULE} scheduled</Badge>
          <Badge tone="warning">{summary.byAction.HUMAN_APPROVAL} need a human</Badge>
          <Badge tone="negative">{summary.byAction.REJECT} rejected</Badge>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs text-ink hover:bg-surface-sunken disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <ArchitectureStrip packageId={board.snapshot.packageId} />

      <TreasuryOverview snapshot={board.snapshot} />

      <div className="grid gap-4 text-xs text-ink-faint md:grid-cols-3">
        <ValueTile label="Agent can settle alone" value={summary.autonomousValueCents} tone="text-pos" />
        <ValueTile label="Waiting on a person" value={summary.needsHumanValueCents} tone="text-warn" />
        <ValueTile
          label="Would be blocked by Sui"
          value={summary.blockedValueCents}
          tone="text-neg"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <InvoiceQueue
          decisions={board.decisions}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        {selected ? (
          <DecisionPanel decision={selected} snapshot={board.snapshot} />
        ) : (
          <div className="rounded-xl border border-hairline bg-surface p-6 text-sm text-ink-faint">
            Select an invoice to see why PayFlow reached its recommendation.
          </div>
        )}
      </div>
    </Shell>
  );
}

function ValueTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-4 py-3">
      <div className="uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>
        {formatMoneyRounded(value)}
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[92rem] flex-col gap-4 px-4 py-6 md:px-8">
      {children}
    </main>
  );
}
