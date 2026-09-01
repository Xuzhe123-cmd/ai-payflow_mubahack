/**
 * The human step, for payments the agent may not make alone.
 *
 * The distinction this has to carry is narrow and easy to get wrong. Approving
 * here overrides the AGENT's lack of authority — it does not override the
 * treasury's policy. The confirmation says so outright, and the behaviour backs
 * it up: approval triggers a fresh run of the same ten on-chain checks under
 * the approver's limits, and the payment can still come back refused.
 *
 * Three states, in order: the ask, the confirmation, and the chain's answer.
 * Nothing here executes on its own — each step is a separate deliberate click.
 *
 * A FOURTH THING IT NOW SHOWS: an execution that was attempted and refused.
 * That outcome always existed and was never rendered, so the button ticked
 * through its stages and quietly reset — which reads as a broken button rather
 * than as the treasury declining a payment.
 */

"use client";

import { useState } from "react";

import { Badge } from "@/components/common/Badge";
import { CheckRow } from "@/components/common/CheckRow";
import { Eyebrow } from "@/components/common/Badge";
import { ExecutionFailureNotice } from "@/components/payments/ExecutionFailureNotice";
import { usePayflow, type InvoiceRun } from "@/components/providers/PayflowProvider";
import type { ExecutionMode } from "@/lib/services/suiService";
import { formatMoneyRounded, shortWallet } from "@/lib/format";
import type { AnalysisResponse } from "@/lib/services/contracts";
import { cn } from "@/lib/utils";

/**
 * The one place the signer is described — accurately, in either mode.
 *
 * It used to say execution was simulated and the receipt generated locally,
 * which was true when nothing was submitted and became false the moment real
 * execution was wired in. It also credited the zkLogin session with signing,
 * which was never true: zkLogin establishes WHO is using the app and this build
 * has no proving service, so it cannot produce a signature. The treasury's own
 * server-held key signs.
 */
export function signerNote(mode: ExecutionMode): string {
  if (!mode.live) {
    return (
      "Live execution is off on this server. Pressing execute asks Sui what it would decide and " +
      "submits nothing — no transaction, no receipt, no funds moved."
    );
  }
  return (
    `Executing submits a real transaction to Sui ${mode.network ?? "testnet"}, signed by the ` +
    "treasury's server-held key. zkLogin establishes who is signed in; it does not sign this " +
    "payment. Any receipt shown is the digest the chain returned."
  );
}

function Button({
  onClick,
  variant,
  disabled,
  children,
}: {
  onClick: () => void;
  variant: "primary" | "ghost" | "danger";
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-9 rounded-lg px-3.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        variant === "primary" && "bg-warn text-white hover:bg-warn/90",
        variant === "danger" && "border border-neg/35 bg-surface text-neg hover:bg-neg-soft",
        variant === "ghost" && "border border-hairline bg-surface text-ink hover:bg-surface-sunken",
      )}
    >
      {children}
    </button>
  );
}

function Line({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-[12px] text-ink-faint">{label}</dt>
      <dd className={cn("truncate text-[12.5px] font-medium text-ink", mono && "font-mono text-[11.5px]")}>
        {value}
      </dd>
    </div>
  );
}

export function HumanApproval({
  invoiceId,
  analysis,
  run,
}: {
  invoiceId: string;
  analysis: AnalysisResponse;
  run: InvoiceRun;
}) {
  const { approveInvoicePayment, rejectInvoicePayment, executeInvoicePayment, state } =
    usePayflow();
  const signerLine = signerNote(state.executionMode);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  const facts = analysis.analysis.invoiceFacts;
  const policy = analysis.analysis.policyFacts;
  const approval = run.approval;
  const enforcement = approval?.enforcement ?? null;

  // --- the human already declined -------------------------------------------
  if (run.humanRejected) {
    return (
      <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
        <Eyebrow>Outcome</Eyebrow>
        <div className="mt-2.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">
          Declined by operator
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          No payment request was submitted. The invoice stays open for a different decision.
        </p>
      </div>
    );
  }

  // --- the chain has answered the approval ----------------------------------
  if (enforcement) {
    const approved = enforcement.outcome === "APPROVED";
    return (
      <div
        className={cn(
          "rounded-xl border p-4",
          approved ? "border-warn/35 bg-warn-soft" : "border-neg/35 bg-neg-soft",
        )}
      >
        <Eyebrow className={approved ? "text-warn" : "text-neg"}>
          {approved ? "Approved by operator" : "Would be refused by Sui"}
        </Eyebrow>
        <div
          className={cn(
            "mt-2.5 text-[19px] font-semibold tracking-[-0.01em]",
            approved ? "text-warn" : "text-neg",
          )}
        >
          {approved ? "Cleared for execution" : "Approval refused"}
        </div>

        {/* NOBODY APPROVED ANYTHING HERE. This branch is reached when the
            preflight refuses, which happens BEFORE any approval is minted — no
            HumanApproval object exists, no wallet signed, no transaction was
            sent. "A human approved this, and the chain still refused it"
            described two events, neither of which occurred. */}
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          {approved
            ? `Re-checked under the approver's ${formatMoneyRounded(approval!.approverMaxSinglePaymentCents)} limit rather than the agent's ${formatMoneyRounded(approval!.agentMaxSinglePaymentCents)}. Every rule still passed.`
            : "Preflight verdict · no transaction submitted. No human approval transaction was " +
              "submitted, so no approval exists to be refused — Sui would refuse one if it were. " +
              "An approval raises whose limit applies, never the limit itself."}
        </p>

        {!approved ? (
          <ul className="mt-3 border-t border-neg/20 pt-2">
            {enforcement.checks
              .filter((check) => !check.passed)
              .map((check, index) => (
                <CheckRow
                  key={check.code}
                  passed={false}
                  tone="chain"
                  index={index}
                  label={check.label}
                  detail={check.detail}
                  limit={check.limit}
                  actual={check.actual}
                />
              ))}
          </ul>
        ) : null}

        {approved && run.status !== "PAID" && run.status !== "EXECUTING" ? (
          <div className="mt-3.5 border-t border-warn/20 pt-3">
            {/* ABOVE the button, deliberately. The reason a payment did not go
                through has to be read before the same button is pressed
                again — underneath it, the retry is the nearer affordance and
                the explanation is the thing scrolled past. */}
            {run.executionFailure ? (
              <div className="mb-3">
                <ExecutionFailureNotice failure={run.executionFailure} />
              </div>
            ) : null}
            <Button
              variant="primary"
              disabled={working}
              onClick={() => {
                setWorking(true);
                void executeInvoicePayment(invoiceId).finally(() => setWorking(false));
              }}
            >
              {working
                ? "Submitting…"
                : run.executionFailure
                  ? "Try payment again"
                  : "Execute payment"}
            </Button>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">{signerLine}</p>
          </div>
        ) : null}
      </div>
    );
  }

  // --- the confirmation step -------------------------------------------------
  if (confirming) {
    return (
      <div className="rounded-xl border border-warn/40 bg-warn-soft p-4">
        <Eyebrow className="text-warn">Approve payment</Eyebrow>

        <dl className="mt-3 divide-y divide-warn/15">
          <Line label="Invoice" value={facts.invoiceNumber} />
          <Line label="Amount" value={formatMoneyRounded(facts.amountCents, facts.currency)} />
          <Line label="Supplier" value={analysis.analysis.supplierFacts.supplierId ?? facts.supplierName} />
          <Line label="Recipient" value={shortWallet(facts.recipientWallet)} mono />
          <Line label="Decision" value="HUMAN_APPROVAL" />
          <Line label="Cash-flow" value="SAFE" />
          <Line label="Agent authority" value="EXCEEDED" />
          <Line label="Human approval" value="REQUIRED" />
        </dl>

        {/* The sentence that has to be exactly right. */}
        <p className="mt-3 rounded-lg border border-warn/25 bg-surface p-3 text-[12.5px] leading-relaxed text-ink">
          You are overriding the <strong>agent&rsquo;s lack of authority</strong> — not treasury
          policy. Sui will re-run all ten checks against live state, and can still refuse this
          payment.
        </p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={working}
            onClick={() => {
              setWorking(true);
              void approveInvoicePayment(invoiceId).finally(() => setWorking(false));
            }}
          >
            {working ? "Re-checking on chain…" : "Confirm & pay"}
          </Button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">{signerLine}</p>
      </div>
    );
  }

  // --- the ask ---------------------------------------------------------------
  return (
    <div className="rounded-xl border border-warn/35 bg-warn-soft p-4">
      <Eyebrow className="text-warn">Human approval required</Eyebrow>
      <div className="mt-2.5 text-[19px] font-semibold tracking-[-0.01em] text-warn">
        Awaiting an operator
      </div>

      <dl className="mt-3 divide-y divide-warn/15">
        <Line label="Payment" value={formatMoneyRounded(facts.amountCents, facts.currency)} />
        <Line label="Agent limit" value={formatMoneyRounded(policy.maxSinglePaymentCents)} />
      </dl>

      <p className="mt-3 text-[12.5px] font-medium leading-relaxed text-ink">
        This payment is financially safe, but the AI agent is not authorized to execute it
        autonomously.
      </p>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-warn/20 pt-3">
        <Button variant="danger" onClick={() => rejectInvoicePayment(invoiceId)}>
          Reject
        </Button>
        <Button variant="primary" onClick={() => setConfirming(true)}>
          Approve &amp; pay
        </Button>
      </div>

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
        Approving is a human action. The agent cannot take it, and cannot grant itself the
        authority to.
      </p>
    </div>
  );
}

/** Shown for PAY_NOW, where the agent needs no one. */
export function AutonomousBadge() {
  return (
    <Badge tone="positive" dot>
      Agent authorized to execute autonomously
    </Badge>
  );
}
