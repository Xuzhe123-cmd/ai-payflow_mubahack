"use client";

import { useMemo } from "react";

import type { FinalOutcome } from "@/lib/types";
import type { DetectedInvoice } from "@/lib/services/inboxService";
import type { EscrowDemoStage } from "@/lib/escrow/demoFlow";
import { buildTreasuryView, type TreasuryView } from "@/lib/services/treasuryService";
import { usePayflow, type InvoiceRun } from "@/components/providers/PayflowProvider";
import { useChainInvoices } from "@/components/hooks/useChainInvoice";
import { useConditionStates } from "@/components/hooks/useConditionState";
import {
  describeInvoiceStatus,
  type InvoiceCategory,
  type InvoiceStatusDescriptor,
} from "@/lib/payments/invoiceStatus";

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
  /**
   * The pipeline's verdict. ADVISORY for anything status-shaped.
   *
   * Kept because some surfaces legitimately want to show what the model
   * concluded. It is not the invoice's status, and deriving one from it is the
   * bug that put a released escrow in the "Rejected" tab.
   */
  outcome: FinalOutcome | null;
  /**
   * What the chain says, and what everything status-shaped must answer to.
   *
   * `status` and `category` come from `describeInvoiceStatus`, so a row's badge
   * and the tab it is filed under are the same call and cannot disagree.
   */
  status: InvoiceStatusDescriptor;
  category: InvoiceCategory;
  chainInvoiceStatus: string | null;
  conditionStage: EscrowDemoStage | null;
  /** False until both chain reads have returned. */
  chainResolved: boolean;
}

/**
 * Every invoice, with the chain consulted.
 *
 * THE FIX THIS CARRIES: settlement is read here, once, for the whole list. It
 * used to be read nowhere — the list categorised from `run.status` and
 * `finalOutcome` alone, so an invoice settled in an earlier session (by the
 * seeding script, or by an escrow release) looked unpaid to this browser, fell
 * through to the guard's refusal of a SECOND payment, and was filed as
 * "Rejected". Both hooks fetch once at module scope and are shared, so this
 * costs two requests for the entire application.
 */
export function useInvoiceEntries(): InvoiceEntry[] {
  const { state } = usePayflow();
  const { byNumber: chainInvoices, resolved: invoicesResolved } = useChainInvoices();
  const { byInvoice: conditions, resolved: conditionsResolved } = useConditionStates();
  const chainResolved = invoicesResolved && conditionsResolved;

  return useMemo(
    () =>
      state.invoices.map((invoice) => {
        const run = state.runs[invoice.id] ?? null;
        const chainInvoiceStatus =
          chainInvoices.get(invoice.invoiceNumber)?.status ?? null;
        const conditionStage = conditions.get(invoice.invoiceNumber)?.stage ?? null;

        // ONE call decides the word and the bucket. There is no second rule.
        const status = describeInvoiceStatus({
          runStatus: run?.status ?? null,
          finalOutcome: run?.analysis?.finalOutcome ?? null,
          chainInvoiceStatus,
          conditionStage,
          hasReceipt: run?.receipt != null,
          // Until both reads land, the recommendation must not get a say — it
          // would file a settled invoice under Rejected for a frame.
          chainResolved,
        });

        return {
          invoice,
          run,
          outcome: run?.analysis?.finalOutcome ?? null,
          status,
          category: status.category,
          chainInvoiceStatus,
          conditionStage,
          chainResolved,
        };
      }),
    [state.invoices, state.runs, chainInvoices, conditions, chainResolved],
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
  /** Committed to escrow, not settled. Neither paid nor refused. */
  held: number;
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
      held: 0,
      rejected: 0,
      blocked: 0,
    };

    for (const entry of entries) {
      const runStatus = entry.run?.status ?? "DETECTED";
      if (runStatus === "ANALYZING") stats.analyzing += 1;
      if (runStatus === "DETECTED") stats.pending += 1;

      // Counted off the SAME category the list filters by, so a tab's count and
      // its contents cannot disagree — and a settled invoice is never tallied
      // as rejected because the guard refuses to pay it twice.
      switch (entry.category) {
        case "paid":
          stats.paid += 1;
          break;
        case "held":
          stats.held += 1;
          break;
        case "review":
          stats.needsReview += 1;
          break;
        case "scheduled":
          if (entry.outcome === "EXECUTED") stats.approved += 1;
          else stats.scheduled += 1;
          break;
        case "rejected":
          if (entry.outcome === "SUI_REJECT") stats.blocked += 1;
          else stats.rejected += 1;
          break;
        case "pending":
          break;
      }
    }

    return stats;
  }, [entries]);
}
