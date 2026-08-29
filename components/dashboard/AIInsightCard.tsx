"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Robot01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { LinkButton } from "@/components/common/LinkButton";
import { ACTION_LABEL, formatDay, formatFullDate, formatMoneyRounded } from "@/lib/format";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";
import type { CashFlowScenario } from "@/lib/types";

/**
 * The product's headline claim, made concrete.
 *
 * Every figure here comes from the deterministic simulation, and the wording
 * comes from the model. The card never blends the two: the numbers are facts,
 * the sentence is a recommendation, and the label says which is which.
 */
export function AIInsightCard({ entry }: { entry: InvoiceEntry }) {
  const analysis = entry.run?.analysis;
  if (!analysis) return null;

  const { decision, analysis: facts } = analysis;
  const currency = facts.invoiceFacts.currency;
  const scenarios = facts.cashFlowScenarios;

  const today = scenarios.find((item) => item.paymentDate === facts.asOfDate) ?? scenarios[0];
  const chosen =
    scenarios.find((item) => item.paymentDate === decision.recommendedDate) ?? null;

  const blocked = analysis.finalOutcome === "SUI_REJECT";
  const tone = blocked
    ? "negative"
    : decision.action === "HUMAN_REVIEW" || decision.action === "REJECT"
      ? "default"
      : "ai";

  return (
    <Panel tone={tone === "negative" ? "negative" : "ai"}>
      <PanelHeader
        tone={tone === "negative" ? "negative" : "ai"}
        eyebrow={
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon icon={Robot01Icon} size={12} strokeWidth={2} />
            AI treasury insight
          </span>
        }
        title={headline(entry)}
        actions={
          <Badge tone={analysis.engineMode === "fallback" ? "warning" : "ai"}>
            {analysis.engineMode === "fallback"
              ? "Safety fallback"
              : analysis.engineMode === "recorded"
                ? "Recorded model output"
                : "Model decision"}
          </Badge>
        }
      />

      <PanelBody className="px-5 py-5">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_264px]">
          <div className="space-y-5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] font-medium text-ink">
                {facts.invoiceFacts.invoiceNumber}
              </span>
              <span className="text-[13.5px] text-ink-soft">
                {facts.invoiceFacts.supplierName}
              </span>
              <span className="tabular ml-auto text-[19px] font-semibold tracking-[-0.01em] text-ink">
                {formatMoneyRounded(facts.invoiceFacts.amountCents, currency)}
              </span>
            </div>

            {today && chosen && today.paymentDate !== chosen.paymentDate ? (
              <div className="grid gap-2.5 sm:grid-cols-2">
                <OutcomeTile
                  label={`Pay ${formatDay(today.paymentDate)}`}
                  scenario={today}
                  currency={currency}
                  selected={false}
                />
                <OutcomeTile
                  label={`Pay ${formatDay(chosen.paymentDate)}`}
                  scenario={chosen}
                  currency={currency}
                  selected
                />
              </div>
            ) : null}

            <p className="text-[13.5px] leading-relaxed text-ink-soft">
              {decision.cashFlowExplanation || decision.decisionExplanation}
            </p>
          </div>

          <div className="flex flex-col justify-between gap-4 rounded-xl border border-hairline bg-surface-sunken p-4">
            <div>
              <Eyebrow>Recommendation</Eyebrow>
              <div
                className={cn(
                  "mt-2 text-[17px] font-semibold leading-tight tracking-[-0.01em]",
                  blocked ? "text-neg" : "text-ink",
                )}
              >
                {decision.action === "SCHEDULE" && decision.recommendedDate
                  ? `Schedule for ${formatDay(decision.recommendedDate)}`
                  : ACTION_LABEL[decision.action]}
              </div>
              {decision.recommendedDate ? (
                <div className="mt-1 text-[12.5px] text-ink-faint">
                  {formatFullDate(decision.recommendedDate)}
                </div>
              ) : null}

              {blocked ? (
                <div className="mt-3 rounded-lg border border-neg/25 bg-neg-soft px-2.5 py-2 text-[12px] leading-relaxed text-neg">
                  Sui rejected this recommendation. On-chain policy is final.
                </div>
              ) : null}

              <div className="mt-3.5 flex items-center gap-2">
                <Badge tone={decision.risk === "LOW" ? "positive" : decision.risk === "MEDIUM" ? "warning" : "negative"}>
                  Risk {decision.risk}
                </Badge>
                <Badge tone="chain">Urgency {decision.urgency}</Badge>
              </div>
            </div>

            <LinkButton
              href={`/invoices/${entry.invoice.id}`}
              size="sm"
              className="w-full rounded-lg"
            >
              View analysis
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} />
            </LinkButton>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function headline(entry: InvoiceEntry): string {
  const analysis = entry.run?.analysis;
  if (!analysis) return "";
  if (analysis.finalOutcome === "SUI_REJECT") {
    return "On-chain policy blocked a payment the AI recommended.";
  }
  switch (analysis.decision.action) {
    case "SCHEDULE":
      return "Your treasury is healthy, but one payment should wait.";
    case "AUTO_PAY":
      return "One invoice is cleared for autonomous payment.";
    case "HUMAN_REVIEW":
      return "One invoice needs a human decision.";
    case "REJECT":
      return "One invoice was rejected before it could reach the treasury.";
  }
}

function OutcomeTile({
  label,
  scenario,
  currency,
  selected,
}: {
  label: string;
  scenario: CashFlowScenario;
  currency: string;
  selected: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-3.5 py-3 transition-colors",
        selected ? "border-ai bg-surface" : "border-hairline bg-surface-sunken",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        {selected ? <Badge tone="ai">Recommended</Badge> : null}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-[0.06em] text-ink-faint">
        Projected minimum cash
      </div>
      <div
        className={cn(
          "tabular mt-0.5 text-[19px] font-semibold tracking-[-0.01em]",
          scenario.reserveBreach ? "text-neg" : "text-ink",
        )}
      >
        {formatMoneyRounded(scenario.projectedMinimumCashCents, currency)}
      </div>
      <div
        className={cn(
          "mt-1.5 flex items-center gap-1.5 text-[11.5px] font-medium",
          scenario.reserveBreach ? "text-neg" : "text-pos",
        )}
      >
        <span>{scenario.reserveBreach ? "✕" : "✓"}</span>
        {scenario.reserveBreach ? "Reserve breach" : "Reserve protected"}
      </div>
    </div>
  );
}
