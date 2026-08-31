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
import { AutonomousBadge, HumanApproval, SIGNER_NOTE } from "@/components/payments/HumanApproval";
import { AiProviders } from "@/components/payments/AiProviders";
import { useConditionState, type ConditionState } from "@/components/hooks/useConditionState";
import { useChainInvoice } from "@/components/hooks/useChainInvoice";
import { evaluateShipmentEvidence } from "@/lib/oracle/evidence";
import { money } from "@/lib/escrow/present";
import { decideAutonomy } from "@/lib/payments/autonomy";
import { describeRecommendation } from "@/lib/payments/invoiceStatus";
import {
  availablePaymentAction,
  type PaymentActionState,
} from "@/lib/payments/availableAction";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";
import type { ApprovalResponse } from "@/lib/services/contracts";
import { approvalAbortFor, formatAbort } from "@/lib/sui/moveAborts";
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

  // A settled invoice makes the guard refuse a payment — a SECOND one. Left
  // unqualified beside "REJECT", that reads as though the original payment
  // failed. Both hooks are module-cached, so this costs no extra request.
  const { invoice: chainInvoice } = useChainInvoice(facts.invoiceFacts.invoiceNumber);
  const { condition } = useConditionState(facts.invoiceFacts.invoiceNumber);
  const alreadySettled =
    chainInvoice?.status === "PAID" || condition?.stage === "RELEASED";

  // Same verdict, different history, different words. "Payment rejected" on a
  // settled invoice reads as though the original payment failed.
  //
  // `attemptedDuplicate` is deliberately NOT passed. Nothing on this page
  // initiates a second payment — a settled invoice offers no control at all —
  // so no second attempt has been made, and claiming one prevented would
  // describe an event that never happened. A surface that does submit a repeat
  // payment passes the flag; this one has nothing to report.
  const wording = describeRecommendation({
    action: decision.action,
    settled: alreadySettled,
    defaultLabel: ACTION_LABEL[decision.action],
  });

  const amount =
    analysis.paymentRequest?.amountCents ?? facts.invoiceFacts.amountCents;

  return (
    <div className="rounded-xl border border-ai-border bg-ai-soft p-4">
      <Eyebrow className="text-ai">AI / Decision</Eyebrow>

      <div className="mt-2.5 flex items-baseline gap-2">
        {/* On a settled invoice the mark comes from the SETTLEMENT, not from
            the action. "✕" beside "Payment already settled" would put a cross
            against a payment that succeeded. */}
        <span
          className={cn(
            "text-[17px] leading-none",
            alreadySettled ? "text-pos" : "text-ai",
          )}
        >
          {alreadySettled ? "✓" : ACTION_MARK[decision.action]}
        </span>
        <span className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {wording.label}
        </span>
      </div>

      {wording.note ? (
        <div className="mt-3 rounded-lg border border-hairline bg-surface px-2.5 py-2">
          <div className="text-[11px] leading-relaxed text-ink-soft">{wording.note}</div>
          {/* SECONDARY, and it stays secondary. The guard refusing a further
              payment is an explanation of why no control is offered — never the
              headline, which would read as the payment having been stopped. */}
          {wording.guardNote ? (
            <div className="mt-1.5 border-t border-hairline pt-1.5 text-[11px] leading-relaxed text-ink-faint">
              {wording.guardNote}
            </div>
          ) : null}
        </div>
      ) : null}

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

      {/* The two models behind the verdict above, for THIS invoice. Placed
          inside the AI card so the evidence sits with the conclusion rather
          than on a separate page the judge has to find. */}
      <AiProviders invoiceNumber={facts.invoiceFacts.invoiceNumber} />

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

/**
 * The approval preflight, refused.
 *
 * WOULD, NOT DID — the distinction the whole card is built around. A preflight
 * asks Sui to evaluate `approval::approve_scoped` without executing it: the
 * validator runs the real Move function against real treasury state and reports
 * the abort it would raise. Nothing is signed, nothing is submitted, no gas is
 * spent, and no funds move.
 *
 * That makes this stronger than a frontend limit check, and the card has to say
 * which it is. "$30,000 is over $25,000" is arithmetic any page could do; a
 * named abort from a named Move function is the chain's own answer, and the
 * constant is printed so a reader can go and find it in the source.
 */
function PreflightRefusal({ approval }: { approval: ApprovalResponse }) {
  const failed = approval.enforcement.checks.find((check) => !check.passed);
  const abort = failed ? approvalAbortFor(failed.code) : null;

  return (
    <div className="rounded-xl border border-neg/35 bg-neg-soft p-4">
      <Eyebrow className="text-neg">Sui preflight</Eyebrow>

      <div className="mt-2.5 text-[15px] font-semibold tracking-[-0.01em] text-neg">
        Sui would reject this approval
      </div>
      <p className="mt-1 text-[11.5px] text-neg/85">
        Preflight check · no transaction submitted
      </p>

      {failed?.limit && failed.actual ? (
        <dl className="mt-3.5 space-y-2 border-t border-neg/20 pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-neg/85">Authorization limit</dt>
            <dd className="tabular text-[13.5px] font-semibold text-neg">{failed.limit}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-neg/85">Requested</dt>
            <dd className="tabular text-[13.5px] font-semibold text-neg">{failed.actual}</dd>
          </div>
        </dl>
      ) : null}

      {/* The Move constant, not a paraphrase of it. Omitted entirely when the
          failed check is not one this path enforces, rather than guessed at. */}
      {abort ? (
        <div className="mt-3.5 border-t border-neg/20 pt-3">
          <div className="font-mono text-[12.5px] font-semibold text-neg">
            {formatAbort(abort)}
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-neg/75">{abort.location}</div>
        </div>
      ) : null}

      <p className="mt-3.5 border-t border-neg/20 pt-3 text-[12.5px] font-medium leading-relaxed text-neg">
        The real Move authorization rule rejects this amount. No transaction was submitted. No
        funds moved.
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-neg/85">
        This is the on-chain rule speaking, not a limit enforced in this interface — Sui evaluated{" "}
        <span className="font-mono text-[11px]">approval::approve_scoped</span> against live
        treasury state and reported the abort it would raise.
      </p>
    </div>
  );
}

function SafetyBlock({ entry }: { entry: InvoiceEntry }) {
  const analysis = entry.run!.analysis!;
  const { enforcement, paymentRequest } = analysis;
  const invoiceNumber = analysis.analysis.invoiceFacts.invoiceNumber;

  // What the chain currently holds against this invoice. Cached at module
  // scope, so asking here costs nothing the outcome box has not already paid.
  const { condition } = useConditionState(invoiceNumber);
  const { invoice: chainInvoice } = useChainInvoice(invoiceNumber);

  // A settled or committed invoice has chain state worth reporting, and
  // "nothing was submitted" would be false about it — a transaction did run,
  // in an earlier session or from the escrow flow.
  const settled = condition?.stage === "RELEASED" || chainInvoice?.status === "PAID";
  const committed =
    condition !== null && ["ESCROWED", "PROOF_SUBMITTED", "HELD", "ATTESTED"].includes(
      condition.stage,
    );

  if (settled || committed) {
    return <ChainStateBlock condition={condition} settled={settled} chainInvoice={chainInvoice} />;
  }

  // A preflight of the APPROVAL has already been run and refused. That verdict
  // is the useful thing to show here — far more so than "no payment request was
  // created", which was true, unexplanatory, and left a reader with no idea
  // which rule had spoken or what it said.
  const approvalPreflight = entry.run?.approval ?? null;
  if (approvalPreflight?.enforcement.outcome === "SUI_REJECT") {
    return <PreflightRefusal approval={approvalPreflight} />;
  }

  if (!paymentRequest || !enforcement) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
        <Eyebrow>Sui preflight</Eyebrow>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          Nothing has been submitted to the treasury contract for this invoice.
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
          The chain is never asked to authorise a payment the agent did not propose. An escalated
          invoice can still be approved by a person — and the chain then runs these same checks
          under the approver&rsquo;s limits before anything settles.
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
            Sui preflight
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
  // Two separate acts, two separate controls. Approving records a human's
  // authorization and pays nothing; executing submits the payment. Both reuse
  // the existing provider actions rather than a second approval system.
  const { executeInvoicePayment, approveInvoicePayment } = usePayflow();
  const run = entry.run!;
  const analysis = run.analysis!;
  const { enforcement, paymentRequest, decision } = analysis;

  // THE CHAIN, FIRST. What the AI recommended is advisory here; what has
  // already happened on chain is not. An invoice recommended for payment may by
  // now be escrowed, held or released, and this box answers to that.
  const { condition, resolved } = useConditionState(
    analysis.analysis.invoiceFacts.invoiceNumber,
  );

  // The invoice object's OWN status. A payment made in an earlier session — or
  // by a script, or by the escrow release — leaves no trace in this browser, so
  // asking the local run whether it was paid answers no and the box falls
  // through to a recommendation that is only refusing to pay it AGAIN.
  const { invoice: chainInvoice, resolved: chainResolved } = useChainInvoice(
    analysis.analysis.invoiceFacts.invoiceNumber,
  );

  const currency = analysis.analysis.invoiceFacts.currency;
  const executing = run.status === "EXECUTING";

  // The recommendation's verdict, which the action box treats as advisory.
  const autonomy = decideAutonomy({
    action: decision.action,
    finalOutcome: analysis.finalOutcome,
    hasPaymentRequest: paymentRequest !== null,
    enforcement,
    conditional: condition !== null,
    humanRejected: run.humanRejected,
  });

  // Chain state first; the recommendation only where the chain is silent.
  const action = availablePaymentAction({
    autonomy,
    conditionStage: condition?.stage ?? null,
    fundsHeldCents: condition?.fundsHeldCents ?? 0,
    amountCents:
      run.approval?.paymentRequest.amountCents ??
      paymentRequest?.amountCents ??
      analysis.analysis.invoiceFacts.amountCents,
    // Highest precedence there is: what the chain records against the invoice.
    chainInvoiceStatus: chainInvoice?.status ?? null,
    supplierName: analysis.analysis.invoiceFacts.supplierName,
    runStatus: run.status,
    hasReceipt: run.receipt !== null,
    // An approval the CHAIN refused is not an approval — the outcome, not the
    // click, is what counts.
    humanApproval: run.approval ? { outcome: run.approval.enforcement.outcome } : null,
    humanRejected: run.humanRejected,
  });

  // ---- CHAIN SETTLEMENT AND ESCROW STATE COME FIRST -----------------------
  // What has already happened outranks what was recommended. An invoice that
  // settled makes the guard refuse a SECOND payment, and reading that refusal
  // as the outcome turns "$4,800 reached the supplier" into "Rejected".
  if (chainResolved && resolved && (action.settled || action.fundsLocked)) {
    return (
      <ChainOutcome
        action={action}
        condition={condition}
        currency={currency}
        digest={run.receipt?.digest ?? null}
      />
    );
  }

  if (executing) {
    // Submitted and not yet confirmed. The only branch entitled to describe a
    // payment as in progress, because it is the only one where a transaction
    // actually exists.
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

  if (!enforcement || !paymentRequest) {
    // REJECT never offers an action. There is nothing to approve: the invoice
    // failed a check the chain would refuse anyway, so an approve button here
    // would be an invitation to do something impossible.
    //
    // Reached only when the chain has NOT settled this invoice — a settled one
    // returned above. So this is a genuine refusal of a payment that never
    // happened, not a guard declining to make a second one.
    if (decision.action === "REJECT") {
      return (
        <div className="flex flex-col rounded-xl border border-neg/35 bg-neg-soft p-4">
          <Eyebrow className="text-neg">Outcome</Eyebrow>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-[17px] leading-none text-neg">✕</span>
            <span className="text-[21px] font-semibold tracking-[-0.015em] text-neg">
              REJECTED
            </span>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
            The invoice was rejected before any payment request existed. No approval can create
            one.
          </p>
          <p className="mt-2.5 border-t border-neg/20 pt-2.5 text-[12px] font-medium text-neg">
            No payment action available.
          </p>
        </div>
      );
    }

    // HUMAN_APPROVAL: the operator's step.
    return <HumanApproval invoiceId={entry.invoice.id} analysis={analysis} run={run} />;
  }

  if (enforcement.outcome === "SUI_REJECT") {
    const primary = enforcement.checks.find((check) => !check.passed);
    return (
      <div className="flex flex-col rounded-xl border border-neg/35 bg-neg-soft p-4">
        <Eyebrow className="text-neg">Outcome</Eyebrow>
        {/* WOULD BE, not WAS. Nothing was submitted, so nothing on chain has
            rejected anything — the verdict comes from the policy mirror and the
            Sui preflight. "REJECTED" beside a $30,000 figure read as a payment
            that failed, rather than one that was never attempted. */}
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-[17px] leading-none text-neg">✕</span>
          <span className="text-[21px] font-semibold tracking-[-0.015em] text-neg">
            WOULD BE REFUSED BY SUI
          </span>
        </div>
        <p className="mt-1 text-[11.5px] text-neg/85">
          Preflight verdict · no transaction submitted
        </p>

        {primary?.limit && primary.actual ? (
          <dl className="mt-3.5 space-y-2 border-t border-neg/20 pt-3">
            <div className="flex items-baseline justify-between gap-3">
              {/* The ceiling is read from the treasury's approver record, so it
                  is named as an authorization rather than as "on-chain limit",
                  which suggested something had already been enforced. */}
              <dt className="text-[12px] text-neg/85">Authorization limit</dt>
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

        {/* The whole story, in the order it happened — and the second bullet is
            the one that matters: no approval was ever submitted, so nothing was
            signed, no HumanApproval object exists, and nothing was refused. The
            verdict is a prediction about what Sui WOULD do. */}
        <ul className="mt-3.5 space-y-1 border-t border-neg/20 pt-3 text-[12px] leading-relaxed text-neg/90">
          <li>· The AI recommended this payment.</li>
          <li>· No human approval transaction was submitted.</li>
          <li>
            · The approver&rsquo;s Chain-Doi authorization caps a single payment
            {primary?.limit ? ` at ${primary.limit}` : " below this amount"}.
          </li>
          <li>
            · A Sui preflight of{" "}
            <span className="font-mono text-[11px]">approval::approve_scoped</span> would abort
            with <span className="font-mono text-[11px]">601 EAboveApproverLimit</span>.
          </li>
        </ul>

        <p className="mt-3.5 border-t border-neg/20 pt-3 text-[12.5px] font-medium leading-relaxed text-neg">
          An AI recommendation cannot override treasury policy, and neither can a human
          approval — it raises whose limit applies, never the limit itself.
        </p>
        <p className="mt-2 text-[12px] text-neg/85">
          No transaction was submitted. No funds moved. No payment action available.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-xl border border-pos/30 bg-surface p-4">
      <Eyebrow className="text-pos">Outcome</Eyebrow>

      {/* The lead says what DID pass, so the headline beneath it can say what
          is still required without the two being read as one verdict. */}
      {resolved && action.lead ? (
        <div className="mt-2.5 flex items-baseline gap-1.5 text-[12.5px] font-medium text-pos">
          <span className="text-[13px] leading-none">✓</span>
          {action.lead.toUpperCase()}
        </div>
      ) : null}

      <div className={cn("flex items-baseline gap-2", resolved && action.lead ? "mt-1" : "mt-2.5")}>
        <span
          className={cn(
            "text-[17px] leading-none",
            action.tone === "warning" ? "text-warn" : "text-pos",
          )}
        >
          {action.tone === "warning" ? "⚠" : "✓"}
        </span>
        <span
          className={cn(
            "text-[21px] font-semibold tracking-[-0.015em]",
            action.tone === "warning" ? "text-warn" : "text-pos",
          )}
        >
          {resolved ? action.headline : "ALLOWED"}
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

      {/* THE ACTION BOX. Derived from chain state first and the recommendation
          only afterwards — see lib/payments/availableAction.ts.

          The autonomy badge belongs only to a payment the agent may actually
          make alone. Showing "agent authorized" beside a $30,000 invoice that
          needs a person would state the opposite of what is true. */}
      <div className="mt-3.5 border-t border-hairline pt-3">
        {autonomy.kind === "AUTONOMOUS" ? (
          <AutonomousBadge />
        ) : (
          <Badge tone="warning" dot>
            Above the agent&rsquo;s autonomous limit
          </Badge>
        )}
      </div>

      {/* Nothing is claimed about the payment state until the chain has been
          consulted. Rendering early would flash "Executing autonomously" on an
          invoice that is actually escrowed — the precise misreading this box
          exists to prevent. */}
      {!resolved ? (
        <div className="mt-3 rounded-lg border border-hairline bg-surface-sunken px-3.5 py-2.5">
          <div className="text-[13px] font-medium text-ink-faint">Reading chain state…</div>
        </div>
      ) : (
      <div
        className={cn(
          "mt-3 rounded-lg border px-3.5 py-2.5",
          action.tone === "positive" && "border-pos/35 bg-pos-soft",
          action.tone === "warning" && "border-warn/35 bg-warn-soft",
          action.tone === "chain" && "border-chain-border bg-chain-soft",
          action.tone === "neutral" && "border-hairline bg-surface-sunken",
          action.tone === "negative" && "border-neg/35 bg-neg-soft",
        )}
      >
        <div
          className={cn(
            "text-[13px] font-semibold",
            action.tone === "positive" && "text-pos",
            action.tone === "warning" && "text-warn",
            action.tone === "chain" && "text-chain",
            action.tone === "neutral" && "text-ink",
            action.tone === "negative" && "text-neg",
          )}
        >
          {action.status}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{action.detail}</p>

        {action.fundsLocked ? (
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-warn/30 bg-surface px-3 py-2">
            <span className="text-[13px]">🔒</span>
            <span className="text-[12.5px] font-medium text-ink">
              {formatMoneyRounded(condition?.fundsHeldCents ?? 0, currency)} locked · supplier has
              not been paid
            </span>
          </div>
        ) : null}

        {condition?.escrow ? (
          <a
            href={condition.escrow.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 block truncate font-mono text-[10.5px] text-chain underline"
          >
            {condition.escrow.objectId}
          </a>
        ) : null}

        {/* The control exists only where the state says one may.

            APPROVE records a human's authorization and pays nothing — the chain
            re-runs all ten checks under the approver's limits and can still
            refuse. EXECUTE_PAYMENT submits. Nothing above either claims a
            payment has been made. */}
        {action.action === "APPROVE" ? (
          <>
            <Button
              className="mt-3 w-full rounded-lg"
              onClick={() => void approveInvoicePayment(entry.invoice.id)}
            >
              {action.label}
            </Button>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Approving authorizes the amount; it does not pay. Sui re-checks every rule under the
              approver&rsquo;s limits, and execution stays a separate step.
            </p>
          </>
        ) : null}

        {action.action === "EXECUTE_PAYMENT" ? (
          <Button
            className="mt-3 w-full rounded-lg"
            onClick={() => void executeInvoicePayment(entry.invoice.id)}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      )}

      {/* A digest is shown ONLY for a network that actually settled one.
          The demo adapter returns network "demo", and rendering its digest in
          the same monospace as a real one is how a fabricated settlement came
          to look genuine. */}
      {run.receipt ? (
        run.receipt.network === "demo" ? (
          <div className="mt-2.5 rounded-lg border border-warn/30 bg-warn-soft px-2.5 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-warn">
              Simulated — not submitted to Sui
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">
              No transaction was sent and no funds moved. This identifier is generated locally and
              is not a Sui transaction digest.
            </p>
            <p className="mt-1 truncate font-mono text-[10.5px] text-ink-faint">
              {run.receipt.digest}
            </p>
          </div>
        ) : (
          <p className="mt-2.5 truncate font-mono text-[10.5px] text-ink-faint">
            {run.receipt.digest}
          </p>
        )
      ) : null}

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        {SIGNER_NOTE}
      </p>
    </div>
  );
}

/**
 * What the chain says has happened, when it has anything to say.
 *
 * Rendered INSTEAD of the recommendation-shaped outcomes, never beside them.
 * The distinction this carries is the one the page kept getting wrong:
 *
 *   the guard      "refuse a NEW payment for this invoice"
 *   the settlement "the payment already completed"
 *
 * Both can be true at once — a settled invoice is exactly why the guard refuses
 * another — and only the second belongs in the outcome box.
 *
 * Every line comes from `action`, which is derived chain-first, so this
 * component decides nothing. It has no button by construction: a settled or
 * escrowed invoice has nothing for anyone to press.
 */
/**
 * What the chain holds against this invoice, where the safety check would be.
 *
 * The middle box answers "what does Sui say". For an invoice with no payment
 * request that used to mean "nothing was submitted" — true of THIS session and
 * false of the invoice, which may have settled through the escrow flow or in an
 * earlier run. Reporting the escrow instead keeps the three boxes telling one
 * continuous story: what was recommended, what the chain holds, what happened.
 *
 * Every line is read from chain-derived state. Nothing here is inferred from
 * the recommendation.
 */
function ChainStateBlock({
  condition,
  settled,
  chainInvoice,
}: {
  condition: ConditionState | null;
  settled: boolean;
  chainInvoice: { status: string; amountCents: number } | null;
}) {
  const evidence = condition
    ? evaluateShipmentEvidence({
        invoiceNumber: condition.invoiceNumber,
        proof: condition.proof,
        attestation: condition.attestation,
      })
    : null;

  const amountCents = condition?.amountCents ?? chainInvoice?.amountCents ?? 0;
  const facts: { label: string; ok: boolean }[] = [];

  if (condition) {
    facts.push({
      label: settled ? "Escrow condition satisfied" : "Escrow condition not yet satisfied",
      ok: settled,
    });
    facts.push({
      label: evidence?.confirmed ? "Shipment confirmed" : "Shipment not confirmed",
      ok: evidence?.confirmed === true,
    });
    facts.push({
      label:
        evidence?.confirmed === true
          ? "Oracle attestation confirmed"
          : condition.attestation
            ? "Oracle attestation does not confirm this document"
            : "No oracle attestation on chain",
      ok: evidence?.confirmed === true,
    });
  }

  if (chainInvoice) {
    facts.push({
      label: `Invoice recorded as ${chainInvoice.status} on chain`,
      ok: settled,
    });
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        settled ? "border-pos/35 bg-pos-soft" : "border-warn/35 bg-warn-soft",
      )}
    >
      <Eyebrow className={settled ? "text-pos" : "text-warn"}>Sui / chain state</Eyebrow>

      <div className="mt-2.5 flex items-baseline gap-2">
        <span className={cn("text-[15px] leading-none", settled ? "text-pos" : "text-warn")}>
          {settled ? "✓" : "⚠"}
        </span>
        <span
          className={cn(
            "text-[17px] font-semibold tracking-[-0.01em]",
            settled ? "text-pos" : "text-warn",
          )}
        >
          {settled
            ? condition
              ? "Payment released"
              : "Payment settled"
            : "Payment held in escrow"}
        </span>
      </div>

      <div
        className={cn(
          "tabular mt-1 text-[19px] font-semibold tracking-[-0.015em]",
          settled ? "text-pos" : "text-warn",
        )}
      >
        {money(amountCents)}
      </div>

      <ul
        className={cn(
          "mt-3 space-y-1.5 border-t pt-3",
          settled ? "border-pos/20" : "border-warn/20",
        )}
      >
        {facts.map((fact) => (
          <li key={fact.label} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
            <span className={cn("shrink-0", fact.ok ? "text-pos" : "text-warn")}>
              {fact.ok ? "✓" : "·"}
            </span>
            {fact.label}
          </li>
        ))}
      </ul>

      {condition?.escrow ? (
        <a
          href={condition.escrow.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block truncate font-mono text-[10.5px] text-chain underline"
        >
          {condition.escrow.objectId}
        </a>
      ) : null}
    </div>
  );
}

function ChainOutcome({
  action,
  condition,
  currency,
  digest,
}: {
  action: PaymentActionState;
  condition: ConditionState | null;
  currency: string;
  digest: string | null;
}) {
  const positive = action.tone === "positive";

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border p-4",
        positive ? "border-pos/35 bg-pos-soft" : "border-warn/35 bg-warn-soft",
      )}
    >
      <Eyebrow className={positive ? "text-pos" : "text-warn"}>Outcome</Eyebrow>

      <div className="mt-2.5 flex items-baseline gap-2">
        <span className={cn("text-[17px] leading-none", positive ? "text-pos" : "text-warn")}>
          {positive ? "✓" : "⚠"}
        </span>
        <span
          className={cn(
            "text-[21px] font-semibold tracking-[-0.015em]",
            positive ? "text-pos" : "text-warn",
          )}
        >
          {action.headline}
        </span>
      </div>

      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{action.detail}</p>

      {action.facts.length > 0 ? (
        <ul
          className={cn(
            "mt-3 space-y-1.5 border-t pt-3",
            positive ? "border-pos/20" : "border-warn/20",
          )}
        >
          {action.facts.map((fact) => (
            <li key={fact} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-soft">
              <span className={cn("shrink-0", positive ? "text-pos" : "text-warn")}>
                {positive ? "✓" : "·"}
              </span>
              {fact}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Funds that left the treasury and have not reached the supplier. The
          one state that is neither payment nor rejection, and the whole reason
          escrow is worth showing. */}
      {action.fundsLocked ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-surface px-3 py-2">
          <span className="text-[13px]">🔒</span>
          <span className="text-[12.5px] font-medium text-ink">
            {formatMoneyRounded(condition?.fundsHeldCents ?? 0, currency)} locked · supplier has
            not been paid
          </span>
        </div>
      ) : null}

      {condition?.escrow ? (
        <a
          href={condition.escrow.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 block truncate font-mono text-[10.5px] text-chain underline"
        >
          {condition.escrow.objectId}
        </a>
      ) : null}

      {digest ? (
        <p className="mt-2.5 truncate font-mono text-[10.5px] text-ink-faint">{digest}</p>
      ) : null}
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
