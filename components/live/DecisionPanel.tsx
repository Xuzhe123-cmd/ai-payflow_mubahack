/**
 * Everything behind one verdict.
 *
 * Ordered the way the engine reasons: the four verdicts first, so the answer
 * and its binding constraint are visible immediately, then the evidence that
 * produced them.
 *
 * The AI's prose is fenced off in its own block and labelled with which engine
 * wrote it. A deterministic fallback must never be presented as an AI decision,
 * and the numbers on this screen are not the model's in either case — they come
 * from the deterministic layer, and the model only ever explained them.
 */

"use client";

import { Badge } from "@/components/common/Badge";
import { CashFlowTimeline } from "@/components/live/CashFlowTimeline";
import { VerdictChips } from "@/components/live/VerdictChips";
import { buildTimeline, buildVerdicts } from "@/lib/decision/present";
import type { PaymentDecision } from "@/lib/decision/types";
import type { ChainSnapshot } from "@/lib/sui/chainTypes";
import { formatMoneyRounded } from "@/lib/util/money";

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      <span className={`min-w-0 truncate text-right text-sm text-ink ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-hairline bg-surface p-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-soft">{title}</h3>
      {children}
    </section>
  );
}

export function DecisionPanel({
  decision,
  snapshot,
}: {
  decision: PaymentDecision;
  snapshot: ChainSnapshot;
}) {
  const verdicts = buildVerdicts(decision);
  const facts = decision.facts;
  const authority = facts.authority;
  const source = decision.explanationSource;

  const timeline = buildTimeline(snapshot, {
    asOf: facts.asOf,
    payment: decision.recommendedPaymentDate
      ? { date: decision.recommendedPaymentDate, amountCents: facts.amountCents }
      : null,
    balanceAfterPaymentCents:
      decision.decision === "REJECT" ? null : decision.projectedBalanceAfterPayment,
  });

  const reserveBufferCents = decision.projectedBalanceAfterPayment - facts.cashFlow.minimumReserveCents;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-hairline bg-surface p-5">
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">{facts.invoiceNumber}</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              {formatMoneyRounded(facts.amountCents)} {facts.currency} · {facts.supplier.supplierId}
            </p>
          </div>
          <Badge tone="chain" dot>
            on chain
          </Badge>
        </header>

        <VerdictChips verdicts={verdicts} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Invoice">
          <Row label="Amount" value={`${formatMoneyRounded(facts.amountCents)} ${facts.currency}`} />
          <Row label="Supplier" value={facts.supplier.supplierId} />
          <Row label="Recipient" value={facts.supplier.invoiceRecipient} mono />
          <Row label="Due date" value={facts.dueDate} />
          <Row
            label="Days until due"
            value={facts.isOverdue ? `${Math.abs(facts.daysUntilDue)} overdue` : `${facts.daysUntilDue}`}
          />
          <Row label="Chain status" value={facts.alreadyPaid ? "PAID" : "open"} />
        </Block>

        <Block title="Supplier verification">
          <Row label="In registry" value={facts.supplier.found ? "yes" : "no"} />
          <Row label="Approved" value={facts.supplier.approved ? "yes" : "no"} />
          <Row label="Registered wallet" value={facts.supplier.registeredWallet ?? "—"} mono />
          <Row label="Invoice recipient" value={facts.supplier.invoiceRecipient} mono />
          <Row label="Addresses match" value={facts.supplier.walletMatches ? "yes" : "NO"} />
        </Block>

        <Block title="Agent authority">
          <Row label="Payment amount" value={formatMoneyRounded(facts.amountCents)} />
          <Row label="Max single payment" value={formatMoneyRounded(authority.maxSinglePaymentCents)} />
          <Row label="Daily limit" value={formatMoneyRounded(authority.dailyLimitCents)} />
          <Row label="Spent today" value={formatMoneyRounded(authority.spentTodayCents)} />
          <Row label="Remaining today" value={formatMoneyRounded(authority.remainingTodayCents)} />
          <Row label="Approval threshold" value={formatMoneyRounded(authority.humanApprovalThresholdCents)} />
          <Row
            label="Autonomously executable"
            value={authority.withinAutonomousAuthority ? "yes" : "no — needs a person"}
          />
        </Block>

        <Block title="Cash-flow impact">
          <Row label="Treasury now" value={formatMoneyRounded(facts.cashFlow.openingBalanceCents)} />
          <Row label="Payment" value={`− ${formatMoneyRounded(facts.amountCents)}`} />
          <Row
            label="Balance after payment"
            value={formatMoneyRounded(decision.projectedBalanceAfterPayment)}
          />
          <Row label="Minimum reserve" value={formatMoneyRounded(facts.cashFlow.minimumReserveCents)} />
          <Row
            label="Reserve buffer"
            value={`${reserveBufferCents >= 0 ? "+" : "−"}${formatMoneyRounded(Math.abs(reserveBufferCents))}`}
          />
          <Row label="Recommended date" value={decision.recommendedPaymentDate ?? "—"} />
        </Block>
      </div>

      <section className="rounded-xl border border-hairline bg-surface p-5">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-soft">
          Projected cash position
        </h3>
        <CashFlowTimeline timeline={timeline} />

        {(facts.cashFlow.upcomingInflows.length > 0 || facts.cashFlow.upcomingOutflows.length > 0) && (
          <ul className="mt-4 space-y-1 border-t border-hairline pt-3 text-xs">
            {[...facts.cashFlow.upcomingInflows, ...facts.cashFlow.upcomingOutflows]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((event) => (
                <li key={`${event.date}-${event.description}`} className="flex items-baseline gap-3">
                  <span className="w-20 shrink-0 tabular-nums text-ink-faint">{event.date}</span>
                  <span
                    className={`w-24 shrink-0 tabular-nums ${event.direction === "INFLOW" ? "text-pos" : "text-warn"}`}
                  >
                    {event.direction === "INFLOW" ? "+" : "−"}
                    {formatMoneyRounded(event.amountCents)}
                  </span>
                  <span className="min-w-0 truncate text-ink-faint">{event.description}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-ai-border bg-ai-soft p-5">
        <header className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-ai">Why</h3>
          <Badge tone="muted">confidence {Math.round(decision.confidence * 100)}%</Badge>
          {decision.clampedToCeiling && (
            <Badge tone="warning" dot>
              model held back to {decision.deterministicCeiling}
            </Badge>
          )}
        </header>

        <p className="text-sm text-ink">{decision.explanation.summary}</p>

        {decision.explanation.whyNotToday && (
          <div className="mt-3 rounded-md border border-hairline bg-surface p-3">
            <div className="text-xs uppercase tracking-wide text-ink-faint">Why not today?</div>
            <p className="mt-1 text-sm text-ink-soft">{decision.explanation.whyNotToday}</p>
          </div>
        )}

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-faint">Cash flow</div>
            <p className="mt-1 text-sm text-ink-soft">{decision.explanation.cashFlow}</p>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-faint">Risk</div>
            <p className="mt-1 text-sm text-ink-soft">{decision.explanation.risk}</p>
          </div>
        </div>

        {decision.reasons.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {decision.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}

        {decision.risks.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <div className="mb-1.5 text-xs uppercase tracking-wide text-ink-faint">
              Observations from the automated checks
            </div>
            <ul className="space-y-1.5">
              {decision.risks.map((risk) => (
                <li key={risk.code} className="flex items-start gap-2 text-sm">
                  <Badge tone={risk.blocking ? "negative" : "warning"}>
                    {risk.blocking ? "blocking" : "note"}
                  </Badge>
                  <span className="min-w-0 flex-1 text-ink-soft">{risk.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          Provenance of the PROSE, never of the decision. The verdicts above are
          deterministic in every case; what changes here is only who wrote the
          sentences — and a fallback must never be dressed up as a model.
        */}
        <div className="mt-4 border-t border-hairline pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={source.kind === "LLM" ? "ai" : "muted"} dot>
              {source.label}
            </Badge>
            {source.kind !== "LLM" && (
              <span className="text-xs text-ink-faint">
                Verdicts and figures above are deterministic and unaffected.
              </span>
            )}
          </div>

          {source.reason && <p className="mt-1.5 text-xs text-ink-faint">{source.reason}</p>}

          {/* The raw failure lives here and nowhere else. An HTTP status says
              nothing about the invoice and would bury the verdict that does. */}
          {source.detail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-ink-soft">
                Engine details
              </summary>
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline bg-surface p-2 font-mono text-[11px] leading-relaxed text-ink-faint">
                {source.detail}
              </pre>
            </details>
          )}
        </div>

        <p className="mt-3 border-t border-hairline pt-3 text-xs text-ink-faint">
          This is a recommendation. Sui re-derives every constraint at execution and can refuse it —
          nothing here can move funds.
        </p>
      </section>
    </div>
  );
}
