"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Shield01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { CheckList, CheckRow } from "@/components/common/CheckRow";
import { StageList } from "@/components/common/States";
import { ACTION_LABEL, formatFullDate, formatMoney, formatMoneyRounded } from "@/lib/format";
import { EXECUTION_STAGES } from "@/lib/services/suiService";
import { usePayflow } from "@/components/providers/PayflowProvider";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";
import type { TreasuryAction } from "@/lib/types";

const ACTION_MARK: Record<TreasuryAction, string> = {
  AUTO_PAY: "✓",
  SCHEDULE: "◷",
  HUMAN_REVIEW: "⚠",
  REJECT: "✕",
};

/**
 * The separation that makes this product defensible.
 *
 * Left: what the model concluded. Right: what the chain permitted. They are
 * drawn in different colours, in separate boxes, with an arrow between them,
 * because the second is not a formality that confirms the first — it is an
 * independent authority that can and does refuse.
 */
export function DecisionChain({ entry }: { entry: InvoiceEntry }) {
  const analysis = entry.run?.analysis;
  if (!analysis) return null;

  const { decision, enforcement, paymentRequest } = analysis;
  const blocked = enforcement?.outcome === "SUI_REJECT";
  const approved = enforcement?.outcome === "APPROVED";

  return (
    <Panel tone={blocked ? "negative" : approved ? "default" : "default"}>
      <PanelHeader
        eyebrow="Decision chain"
        title="What the AI recommended, and what the chain allowed"
        subtitle="The model proposes. Move decides. A recommendation is never self-executing."
      />

      <PanelBody className="px-5 py-5">
        <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_28px_minmax(0,1.15fr)_28px_minmax(0,0.9fr)]">
          <RecommendationBlock entry={entry} />
          <Connector />
          <SafetyBlock entry={entry} />
          <Connector />
          <OutcomeBlock entry={entry} />
        </div>

        {decision.action !== "REJECT" && !paymentRequest ? (
          <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
            {ACTION_LABEL[decision.action]} does not create a payment request, so
            nothing was submitted to the treasury.
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function Connector() {
  return (
    <div className="flex items-center justify-center xl:py-0">
      <span className="grid size-7 place-items-center rounded-full border border-hairline bg-surface text-ink-faint">
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={14}
          strokeWidth={2}
          className="rotate-90 xl:rotate-0"
        />
      </span>
    </div>
  );
}

function RecommendationBlock({ entry }: { entry: InvoiceEntry }) {
  const analysis = entry.run!.analysis!;
  const { decision, guard } = analysis;
  const facts = analysis.analysis;
  const currency = facts.invoiceFacts.currency;

  const amount =
    analysis.paymentRequest?.amountCents ?? facts.invoiceFacts.amountCents;

  return (
    <div className="rounded-xl border border-ai-border bg-ai-soft p-4">
      <Eyebrow className="text-ai">AI recommendation</Eyebrow>

      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="text-[17px] leading-none text-ai">
          {ACTION_MARK[decision.action]}
        </span>
        <span className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {ACTION_LABEL[decision.action]}
        </span>
      </div>

      {decision.action === "AUTO_PAY" || decision.action === "SCHEDULE" ? (
        <div className="mt-3 space-y-2 border-t border-ai-border/60 pt-3">
          <Line label="Amount" value={formatMoney(amount, currency)} strong />
          {decision.recommendedDate ? (
            <Line label="Payment date" value={formatFullDate(decision.recommendedDate)} />
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 border-t border-ai-border/60 pt-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ai">
          Reasoning
        </div>
        <ul className="mt-1.5 space-y-1">
          {decision.reasons.slice(0, 5).map((reason) => (
            <li key={reason} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ai/60" />
              {reason}
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-soft">
          {decision.decisionExplanation}
        </p>
      </div>

      {guard.downgraded ? (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2">
          <div className="text-[11.5px] font-medium text-warn">
            Output guard downgraded this decision
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-warn/85">
            The model returned {guard.from ?? "invalid output"} —{" "}
            {guard.violations.map((violation) => violation.code).join(", ")}. The
            guard escalated it to a human instead of trusting it.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SafetyBlock({ entry }: { entry: InvoiceEntry }) {
  const analysis = entry.run!.analysis!;
  const { enforcement, paymentRequest } = analysis;

  if (!paymentRequest || !enforcement) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
        <Eyebrow>Sui safety check</Eyebrow>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          No payment request was created, so nothing was submitted to the
          treasury contract.
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
          Human review and rejection are terminal in the agent path. The chain is
          never asked to authorise a payment the AI did not propose.
        </p>
      </div>
    );
  }

  const failed = enforcement.checks.filter((check) => !check.passed);

  return (
    <div className="rounded-xl border border-chain-border bg-chain-soft p-4">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow className="text-chain">
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon icon={Shield01Icon} size={11} strokeWidth={2} />
            Sui safety check
          </span>
        </Eyebrow>
        <Badge tone="chain">{enforcement.checks.length} assertions</Badge>
      </div>

      <div className="mt-2 rounded-lg bg-surface/70 px-3">
        <CheckList>
          {enforcement.checks.map((check, index) => (
            <CheckRow
              key={check.code + index}
              passed={check.passed}
              label={check.label}
              detail={check.passed ? undefined : check.detail}
              limit={check.passed ? null : check.limit}
              actual={check.passed ? null : check.actual}
              tone="chain"
              index={index}
              animate
            />
          ))}
        </CheckList>
      </div>

      {failed.length > 0 ? (
        <p className="mt-3 text-[12px] leading-relaxed text-neg">
          {failed.length} assertion{failed.length === 1 ? "" : "s"} failed. Move
          aborts the transaction — there is no override path from this interface.
        </p>
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed text-chain/85">
          Every assertion is re-derived from treasury state, independently of
          anything the model concluded.
        </p>
      )}
    </div>
  );
}

function OutcomeBlock({ entry }: { entry: InvoiceEntry }) {
  const { executeInvoicePayment } = usePayflow();
  const run = entry.run!;
  const analysis = run.analysis!;
  const { enforcement, paymentRequest, decision } = analysis;

  const currency = analysis.analysis.invoiceFacts.currency;
  const executing = run.status === "EXECUTING";
  const paid = run.status === "PAID";

  if (!enforcement || !paymentRequest) {
    return (
      <div className="flex flex-col rounded-xl border border-hairline bg-surface-sunken p-4">
        <Eyebrow>Outcome</Eyebrow>
        <div className="mt-2.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">
          {decision.action === "REJECT" ? "Rejected" : "Held for a human"}
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          {decision.action === "REJECT"
            ? "The invoice was rejected before any payment request existed."
            : "A treasury operator has to approve this payment manually. The agent cannot proceed on its own."}
        </p>
      </div>
    );
  }

  if (enforcement.outcome === "SUI_REJECT") {
    const primary = enforcement.checks.find((check) => !check.passed);
    return (
      <div className="flex flex-col rounded-xl border border-neg/35 bg-neg-soft p-4">
        <Eyebrow className="text-neg">Outcome</Eyebrow>
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-[17px] leading-none text-neg">✕</span>
          <span className="text-[21px] font-semibold tracking-[-0.015em] text-neg">
            Rejected
          </span>
        </div>

        {primary?.limit && primary.actual ? (
          <dl className="mt-3.5 space-y-2 border-t border-neg/20 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[12px] text-neg/85">On-chain limit</dt>
              <dd className="tabular text-[13.5px] font-semibold text-neg">
                {primary.limit}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[12px] text-neg/85">Requested</dt>
              <dd className="tabular text-[13.5px] font-semibold text-neg">
                {primary.actual}
              </dd>
            </div>
          </dl>
        ) : null}

        <p className="mt-3.5 border-t border-neg/20 pt-3 text-[12.5px] font-medium leading-relaxed text-neg">
          An AI recommendation cannot override on-chain treasury policy.
        </p>
      </div>
    );
  }

  if (paid && run.receipt) {
    return (
      <div className="flex flex-col rounded-xl border border-pos/35 bg-pos-soft p-4">
        <Eyebrow className="text-pos">Outcome</Eyebrow>
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-[17px] leading-none text-pos">✓</span>
          <span className="text-[21px] font-semibold tracking-[-0.015em] text-pos">
            Payment completed
          </span>
        </div>

        <dl className="mt-3.5 space-y-2 border-t border-pos/20 pt-3">
          <div>
            <dt className="text-[11px] uppercase tracking-[0.06em] text-pos/80">
              Transaction digest
            </dt>
            <dd className="mt-0.5 break-all font-mono text-[11.5px] text-pos">
              {run.receipt.digest}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-pos/85">Amount</dt>
            <dd className="tabular text-[13px] font-semibold text-pos">
              {formatMoneyRounded(paymentRequest.amountCents, currency)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-pos/85">Gas</dt>
            <dd className="text-[12.5px] font-medium text-pos">Sponsored</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (executing) {
    return (
      <div className="flex flex-col rounded-xl border border-chain-border bg-chain-soft p-4">
        <Eyebrow className="text-chain">Executing</Eyebrow>
        <StageList
          className="mt-3"
          stages={EXECUTION_STAGES.map((stage) => {
            const currentIndex = EXECUTION_STAGES.findIndex(
              (item) => item.id === run.executionStage,
            );
            const index = EXECUTION_STAGES.findIndex((item) => item.id === stage.id);
            return {
              id: stage.id,
              label: stage.label,
              state:
                index < currentIndex
                  ? ("done" as const)
                  : index === currentIndex
                    ? ("active" as const)
                    : ("pending" as const),
            };
          })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-xl border border-pos/30 bg-surface p-4">
      <Eyebrow className="text-pos">Outcome</Eyebrow>
      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="text-[17px] leading-none text-pos">✓</span>
        <span className="text-[21px] font-semibold tracking-[-0.015em] text-pos">
          Allowed
        </span>
      </div>

      <dl className="mt-3.5 space-y-2 border-t border-hairline pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[12px] text-ink-faint">Amount</dt>
          <dd className="tabular text-[13.5px] font-semibold text-ink">
            {formatMoneyRounded(paymentRequest.amountCents, currency)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[12px] text-ink-faint">Scheduled for</dt>
          <dd className="text-[12.5px] font-medium text-ink">
            {formatFullDate(paymentRequest.requestedDate)}
          </dd>
        </div>
      </dl>

      <Button
        className="mt-4 w-full rounded-lg"
        onClick={() => void executeInvoicePayment(entry.invoice.id)}
      >
        Execute payment
      </Button>

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        Submitted as a programmable transaction block with sponsored gas, signed
        by the zkLogin session.
      </p>
    </div>
  );
}

function Line({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12px] text-ink-faint">{label}</span>
      <span
        className={cn(
          "tabular text-[13px] text-ink",
          strong ? "text-[15px] font-semibold" : "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}
