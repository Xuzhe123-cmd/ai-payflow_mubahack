"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { CashFlowChart, ChartLegend } from "@/components/charts/CashFlowChart";
import { formatDay, formatFullDate, formatMoneyRounded } from "@/lib/format";
import { cashFlowRecommendation } from "@/lib/decision/cashFlowRecommendation";
import type { AnalysisResponse } from "@/lib/services/contracts";
import type { CashFlowScenario } from "@/lib/types";

/**
 * Payment-date simulation.
 *
 * Each row is a fully costed projection produced by the deterministic layer —
 * the operator can select any of them and watch the forecast redraw. What they
 * cannot do is invent a date: the candidate set here is exactly the set the
 * model was allowed to choose from, and anything outside it is rejected before
 * it reaches the chain.
 */
export function CashFlowAnalysis({ analysis }: { analysis: AnalysisResponse }) {
  const facts = analysis.analysis;
  const currency = facts.invoiceFacts.currency;

  // THE TIMING ANSWER, AND WHERE IT CAME FROM.
  //
  // A live verdict is used when there is one; otherwise the deterministic
  // scenario decides and says so. What no longer happens is the model's
  // absence being reported as the treasury's refusal — the simulation below
  // has run either way, and several dates usually clear the reserve.
  const recommendation = cashFlowRecommendation({
    scenarios: facts.cashFlowScenarios,
    policy: facts.policyFacts,
    asOfDate: facts.asOfDate,
    liveRecommendedDate:
      analysis.engine === "LLM" ? analysis.decision.recommendedDate : null,
    liveExplanation: analysis.decision.cashFlowExplanation,
  });
  const recommended = recommendation.recommendedDate;
  const isLive = recommendation.source === "LIVE";

  const [selected, setSelected] = useState<string>(
    recommended ?? facts.cashFlowScenarios[0]?.paymentDate ?? facts.asOfDate,
  );

  const selectedScenario =
    facts.cashFlowScenarios.find((item) => item.paymentDate === selected) ?? null;

  return (
    <Panel>
      <PanelHeader
        eyebrow="AI cash flow analysis"
        title="What each payment date does to the treasury"
        subtitle="Every figure is simulated by deterministic code before the model sees it."
      />

      <PanelBody className="space-y-6">
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <Figure
            label="Current treasury"
            value={formatMoneyRounded(analysis.projection.currentCashCents, currency)}
          />
          <Figure
            label="Minimum reserve"
            value={formatMoneyRounded(analysis.projection.minimumReserveCents, currency)}
            tone="chain"
            note="Enforced on chain"
          />
          {selectedScenario ? (
            <Figure
              label={`Projected low if paid ${formatDay(selectedScenario.paymentDate)}`}
              value={formatMoneyRounded(selectedScenario.projectedMinimumCashCents, currency)}
              tone={selectedScenario.reserveBreach ? "neg" : "pos"}
              note={
                selectedScenario.reserveBreach
                  ? `Breaches the reserve by ${formatMoneyRounded(selectedScenario.breachDepthCents, currency)}`
                  : `Trough on ${formatDay(selectedScenario.projectedMinimumCashDate)}`
              }
            />
          ) : null}
        </div>

        <div>
          <CashFlowChart
            projection={analysis.projection}
            activeSeriesId={`pay_${selected}`}
            compareSeriesId="baseline"
            height={260}
          />
          <ChartLegend
            className="mt-3"
            reserveCents={analysis.projection.minimumReserveCents}
            currency={currency}
            activeLabel={`Paid ${formatDay(selected)}`}
            compareLabel="Invoice unpaid"
          />
        </div>

        <div>
          <div className="mb-2.5 flex items-center justify-between gap-4">
            <Eyebrow>Payment date simulation</Eyebrow>
            <span className="text-[11.5px] text-ink-faint">
              Select a date to redraw the forecast
            </span>
          </div>

          <div className="space-y-2">
            {facts.cashFlowScenarios.map((scenario) => (
              <ScenarioRow
                key={scenario.paymentDate}
                scenario={scenario}
                currency={currency}
                selected={scenario.paymentDate === selected}
                recommended={scenario.paymentDate === recommended}
                onSelect={() => setSelected(scenario.paymentDate)}
              />
            ))}
          </div>
        </div>

        <div
          className={cn(
            "rounded-xl border px-4 py-3.5",
            recommendation.noSafeDate
              ? "border-neg/35 bg-neg-soft"
              : "border-ai-border bg-ai-soft",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow className={recommendation.noSafeDate ? "text-neg" : "text-ai"}>
              AI CFO recommendation
            </Eyebrow>

            {/* THE LABEL IS THE WHOLE POINT. A recorded recommendation is
                useful; a recorded one wearing a LIVE badge is a lie, and this
                is the one place a reader can tell them apart. */}
            {isLive ? (
              <Badge tone="ai" dot>
                Live
              </Badge>
            ) : (
              <Badge tone="warning">Demo fallback — live AI unavailable</Badge>
            )}
          </div>

          <div
            className={cn(
              "mt-1.5 text-[15px] font-semibold",
              recommendation.noSafeDate ? "text-neg" : "text-ink",
            )}
          >
            {recommended
              ? recommendation.headline.startsWith("Schedule")
                ? `Schedule for ${formatFullDate(recommended)}`
                : recommendation.headline
              : recommendation.headline}
          </div>

          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            {recommendation.reason}
          </p>

          {recommendation.comparison ? (
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
              {recommendation.comparison}
            </p>
          ) : null}

          {/* Said plainly, under the recommendation rather than in place of it.
              A recorded timing verdict authorizes nothing: Sui decides what may
              settle, and it never consulted this. */}
          {!isLive ? (
            <p className="mt-2.5 border-t border-warn/25 pt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Recorded demo recommendation, derived from this invoice&rsquo;s deterministic
              cash-flow scenario rather than from a model. It grants no authorization — Sui
              decides what may settle.
            </p>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}

function ScenarioRow({
  scenario,
  currency,
  selected,
  recommended,
  onSelect,
}: {
  scenario: CashFlowScenario;
  currency: string;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-3 text-left transition-all",
        selected
          ? "border-ai bg-surface shadow-[0_0_0_3px_var(--ai-soft)]"
          : "border-hairline bg-surface hover:bg-surface-sunken",
      )}
    >
      <div className="min-w-[140px]">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-ink">
            Pay {formatDay(scenario.paymentDate)}
          </span>
          {recommended ? <Badge tone="ai">AI choice</Badge> : null}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-faint">
          {scenario.daysFromToday === 0
            ? "today"
            : `in ${scenario.daysFromToday} day${scenario.daysFromToday === 1 ? "" : "s"}`}
          {scenario.isAfterDueDate ? " · after due date" : ""}
        </div>
      </div>

      <div className="min-w-[168px]">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
          Projected minimum
        </div>
        <div
          className={cn(
            "tabular mt-0.5 text-[15px] font-semibold",
            scenario.reserveBreach ? "text-neg" : "text-ink",
          )}
        >
          {formatMoneyRounded(scenario.projectedMinimumCashCents, currency)}
        </div>
      </div>

      {scenario.discountCapturedCents > 0 ? (
        <div>
          <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-faint">
            Discount captured
          </div>
          <div className="tabular mt-0.5 text-[13.5px] font-semibold text-pos">
            {formatMoneyRounded(scenario.discountCapturedCents, currency)}
          </div>
        </div>
      ) : null}

      <div className="ml-auto">
        {scenario.reserveBreach ? (
          <Badge tone="negative" dot>
            Reserve breach
          </Badge>
        ) : (
          <Badge tone="positive" dot>
            Safe
          </Badge>
        )}
      </div>
    </button>
  );
}

function Figure({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "chain";
  note?: string;
}) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          "tabular mt-1.5 text-[23px] font-semibold leading-none tracking-[-0.02em]",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
          tone === "chain" && "text-chain",
          !tone && "text-ink",
        )}
      >
        {value}
      </div>
      {note ? <div className="mt-1.5 text-[11.5px] text-ink-faint">{note}</div> : null}
    </div>
  );
}
