"use client";

/**
 * The two providers' opinions on ONE invoice.
 *
 * ONE IMPLEMENTATION, TWO SCREENS. Both the defense deep-dive and the invoice
 * Decision Chain read through this hook and the same `/api/defense/analyze`
 * endpoint. A second AI path built for the invoice page would drift from the
 * first, and the two screens would eventually disagree about what the same two
 * models said about the same invoice.
 *
 * KEYED BY INVOICE. The answer in hand is tracked against the invoice it
 * describes, so a result for a previous invoice reads as "not answered yet"
 * rather than being shown under a new invoice's name. Changing the invoice
 * clears the opinions before the new request goes out.
 *
 * It fetches; it never fabricates. A provider that is unconfigured or
 * unreachable arrives as such, and the caller renders that status rather than
 * an opinion.
 */

import { useEffect, useState } from "react";

import type { Consensus, ProviderResult } from "@/lib/ai/providers";

export interface ProviderAnalysis {
  /** LIVE only when BOTH models answered. Anything else is recorded data. */
  mode: "LIVE" | "DEMO_FALLBACK";
  banner: string | null;
  disclaimer: string | null;
  recorded: boolean | null;
  liveFailures: { provider: string; status: string; reason: string | null }[];
  scenarioId: string | null;
  invoiceNumber: string;
  amountCents: number;
  supplierId: string | null;
  providers: ProviderResult[];
  consensus: Consensus;
  consensusCaveat: string;
  latencyMs: number;
}

export interface ProviderAnalysisResult {
  analysis: ProviderAnalysis | null;
  /** True while the models are being asked about the CURRENT invoice. */
  analyzing: boolean;
  error: string | null;
}

/**
 * @param invoiceNumber the invoice to analyze, or null to ask nothing.
 */
export function useProviderAnalysis(invoiceNumber: string | null): ProviderAnalysisResult {
  /**
   * The answer, STORED WITH THE INVOICE IT DESCRIBES.
   *
   * Keying it this way is what makes a stale result impossible rather than
   * merely unlikely: an answer for a previous invoice does not match the
   * current one, so it reads as "not answered yet" without any effect having to
   * clear it. Clearing synchronously in the effect would also cascade renders.
   */
  const [answer, setAnswer] = useState<{
    invoice: string;
    analysis: ProviderAnalysis | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!invoiceNumber) return;
    let cancelled = false;

    void fetch(`/api/defense/analyze?invoice=${encodeURIComponent(invoiceNumber)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as ProviderAnalysis & {
          ok?: boolean;
          error?: string;
        };
        if (cancelled) return;
        setAnswer(
          !response.ok || !payload.ok
            ? {
                invoice: invoiceNumber,
                analysis: null,
                error: payload.error ?? "The providers could not be reached.",
              }
            : { invoice: invoiceNumber, analysis: payload, error: null },
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAnswer({
          invoice: invoiceNumber,
          analysis: null,
          error:
            cause instanceof Error ? cause.message : "The providers could not be reached.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [invoiceNumber]);

  // Derived: an answer about a different invoice is not an answer about this one.
  const current = answer && answer.invoice === invoiceNumber ? answer : null;

  return {
    analysis: current?.analysis ?? null,
    analyzing: invoiceNumber !== null && current === null,
    error: current?.error ?? null,
  };
}
