"use client";

/**
 * AI defense: two providers, the behaviour they produce, and the chain's answer.
 *
 * THE ARGUMENT THIS PAGE MAKES, top to bottom:
 *
 *   Two independent models recommend.        They authorize nothing.
 *   The payment STREAM is measured.          Per-payment checks cannot see it.
 *   An anomaly score is computed.            From the statistics, not typed in.
 *   The breaker's mode is read from Sui.     Not from this page's state.
 *
 * The last line is the one that matters. Every other panel is intelligence, and
 * intelligence is exactly what this architecture assumes can be compromised.
 * The breaker's state is never derived from a click here — it comes back from
 * the chain read, so a tripped breaker on this screen means a tripped breaker
 * on chain, and a page that lied about it would be corrected by the next fetch.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { AiProviderPanel } from "@/components/defense/AiProviderPanel";
import { BehavioralMonitor } from "@/components/defense/BehavioralMonitor";
import { CircuitBreakerPanel } from "@/components/defense/CircuitBreakerPanel";
import type { DefenseSnapshot } from "@/components/defense/types";
import { DEFAULT_INVOICE_NUMBER } from "@/lib/demo/invoiceCatalog";
import { useProviderAnalysis } from "@/components/hooks/useProviderAnalysis";
import { cn } from "@/lib/utils";

export default function DefensePage() {
  const [snapshot, setSnapshot] = useState<DefenseSnapshot | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * Which request the snapshot in hand answers.
   *
   * Loading is DERIVED from the gap between what was asked for and what has
   * arrived, rather than stored. Storing it meant writing state synchronously
   * inside the effect, which cascades renders — and the derived form is also
   * more honest: it cannot get stuck "loading" if a write is missed.
   */
  const [applied, setApplied] = useState<string | null>(null);
  /**
   * WHICH INVOICE IS UNDER ANALYSIS — from the URL, so the selection is
   * shareable, reloadable, and visible in the address bar during a demo. The
   * default applies only when the URL names none.
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const invoice = searchParams.get("invoice")?.trim() || DEFAULT_INVOICE_NUMBER;

  const key = `${simulating}:${attempt}`;
  const loading = applied !== key;

  // THE SAME HOOK the invoice Decision Chain uses. One implementation, so the
  // two screens can never disagree about what the two models said.
  const { analysis, analyzing, error: analysisError } = useProviderAnalysis(invoice);

  useEffect(() => {
    let cancelled = false;

    void fetch(`/api/defense${simulating ? "?simulate=attack" : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as DefenseSnapshot & { ok?: boolean };
        if (cancelled) return;
        if (!response.ok || !payload.ok) {
          setError("The defense state could not be read.");
        } else {
          setSnapshot(payload);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error ? cause.message : "The defense state could not be read.",
        );
      })
      .finally(() => {
        if (!cancelled) setApplied(`${simulating}:${attempt}`);
      });

    return () => {
      cancelled = true;
    };
  }, [simulating, attempt]);


  return (
    <PageContainer>
      <PageHeader
        title="AI defense"
        subtitle="Two independent models recommend. The payment behaviour they produce is measured. When it turns abnormal, the treasury can be put into a mode Sui Move enforces."
      />

      {error ? (
        <Panel tone="negative">
          <PanelBody>
            <p className="text-[13px] text-neg">{error}</p>
          </PanelBody>
        </Panel>
      ) : null}

      {/* The simulation control. Deliberately at the top, labelled, and
          impossible to mistake for a real incident. */}
      <Panel tone={simulating ? "negative" : "default"}>
        <PanelHeader
          eyebrow="Demonstration"
          title="Attack simulation"
          actions={
            <Badge tone={simulating ? "negative" : "neutral"} dot>
              {simulating ? "SIMULATION ACTIVE" : "OFF"}
            </Badge>
          }
        />
        <PanelBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setSimulating(true)}
              disabled={simulating || loading}
              className={cn(
                "h-9 rounded-lg bg-warn px-3.5 text-[13px] font-medium text-white",
                "transition-colors hover:bg-warn/90 disabled:cursor-not-allowed disabled:opacity-55",
              )}
            >
              ⚠️ Simulate AI attack
            </button>
            {simulating ? (
              <button
                type="button"
                onClick={() => setSimulating(false)}
                disabled={loading}
                className="h-9 rounded-lg border border-hairline bg-surface px-3.5 text-[13px] font-medium text-ink hover:bg-surface-sunken disabled:opacity-55"
              >
                Reset to normal behaviour
              </button>
            ) : null}
          </div>

          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            {snapshot?.disclaimer ??
              "Generates a synthetic payment pattern locally and scores it with the same engine the live monitor uses. No real AI model is involved, and no chain state changes."}
          </p>
        </PanelBody>
      </Panel>

      <div className="mt-5 space-y-5">
        <AiProviderPanel
          snapshot={snapshot}
          analysis={analysis}
          analyzing={analyzing}
          analysisError={analysisError}
          invoice={invoice}
          onSelectInvoice={(next) => {
            // The URL is the state. Re-running both models follows from the
            // effect above rather than from this handler.
            const params = new URLSearchParams(searchParams.toString());
            params.set("invoice", next);
            router.replace(`/defense?${params.toString()}`, { scroll: false });
          }}
        />
        <BehavioralMonitor snapshot={snapshot} />
        <CircuitBreakerPanel snapshot={snapshot} onRefresh={() => setAttempt((value) => value + 1)} />
      </div>
    </PageContainer>
  );
}
