"use client";

import { useMemo } from "react";

import type { FinalOutcome } from "@/lib/types";
import type { DetectedInvoice } from "@/lib/services/inboxService";
import { buildTreasuryView, type TreasuryView } from "@/lib/services/treasuryService";
import { usePayflow, type InvoiceRun } from "@/components/providers/PayflowProvider";

/**
 * The company's own treasury position.
 *
 * Pinned rather than derived from whichever invoice happens to be featured: a
 * balance that moved as the operator's attention moved would not be a treasury.
 * The constrained profile is the honest default, because a dashboard that
 * starts comfortable never teaches anyone what the reserve is for.
 */
export const COMPANY_TREASURY_SCENARIO = "s2_cashflow";

export interface InvoiceEntry {
  invoice: DetectedInvoice;
  run: InvoiceRun | null;
  outcome: FinalOutcome | null;
}

export function useInvoiceEntries(): InvoiceEntry[] {
  const { state } = usePayflow();
  return useMemo(
    () =>
      state.invoices.map((invoice) => {
        const run = state.runs[invoice.id] ?? null;
        return { invoice, run, outcome: run?.analysis?.finalOutcome ?? null };
      }),
    [state.invoices, state.runs],
  );
}

/**
 * The invoice the dashboard leads with.
 *
 * Priority is by how much the operator's attention is worth: something the
 * chain blocked, then something the AI could not decide, then the timing
 * decision, then anything analyzed. Selection reads results — it never
 * re-derives them.
 */
export function useFeaturedInvoice(): InvoiceEntry | null {
  const entries = useInvoiceEntries();

  return useMemo(() => {
    const analyzed = entries.filter((entry) => entry.run?.analysis);
    if (analyzed.length === 0) return null;

    const byOutcome = (outcome: FinalOutcome) =>
      analyzed.find((entry) => entry.outcome === outcome) ?? null;

    const timingDecision = analyzed.find((entry) => {
      const analysis = entry.run?.analysis;
      if (!analysis || entry.outcome !== "SCHEDULED") return false;
      const today = analysis.analysis.cashFlowScenarios[0];
      const chosen = analysis.analysis.cashFlowScenarios.find(
        (candidate) => candidate.paymentDate === analysis.decision.recommendedDate,
      );
      // The interesting case: paying now breaches the reserve, waiting does not.
      return Boolean(today?.reserveBreach && chosen && !chosen.reserveBreach);
    });

    return (
      byOutcome("SUI_REJECT") ??
      timingDecision ??
      byOutcome("HUMAN_REVIEW") ??
      byOutcome("SCHEDULED") ??
      analyzed[0]
    );
  }, [entries]);
}

/** The treasury position the dashboard and treasury page are describing. */
export function useActiveTreasury(): { scenarioId: string; view: TreasuryView } {
  const view = useMemo(() => buildTreasuryView(COMPANY_TREASURY_SCENARIO), []);
  return { scenarioId: COMPANY_TREASURY_SCENARIO, view };
}

export interface InvoiceStats {
  total: number;
  analyzing: number;
  pending: number;
  needsReview: number;
  scheduled: number;
  approved: number;
  paid: number;
  rejected: number;
  blocked: number;
}

export function useInvoiceStats(): InvoiceStats {
  const entries = useInvoiceEntries();

  return useMemo(() => {
    const stats: InvoiceStats = {
      total: entries.length,
      analyzing: 0,
      pending: 0,
      needsReview: 0,
      scheduled: 0,
      approved: 0,
      paid: 0,
      rejected: 0,
      blocked: 0,
    };

    for (const entry of entries) {
      const status = entry.run?.status ?? "DETECTED";
      if (status === "ANALYZING") stats.analyzing += 1;
      if (status === "DETECTED") stats.pending += 1;
      if (status === "PAID") {
        stats.paid += 1;
        continue;
      }
      switch (entry.outcome) {
        case "HUMAN_REVIEW":
          stats.needsReview += 1;
          break;
        case "SCHEDULED":
          stats.scheduled += 1;
          break;
        case "EXECUTED":
          stats.approved += 1;
          break;
        case "REJECTED":
          stats.rejected += 1;
          break;
        case "SUI_REJECT":
          stats.blocked += 1;
          break;
        default:
          break;
      }
    }

    return stats;
  }, [entries]);
}
