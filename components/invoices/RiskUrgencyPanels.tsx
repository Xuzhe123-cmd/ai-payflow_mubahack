"use client";

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { LevelMeter, ConfidenceBar } from "@/components/common/LevelMeter";
import { Badge } from "@/components/common/Badge";
import {
  RISK_EVIDENCE_LABEL,
  describeDueIn,
  formatFullDate,
  formatMoneyRounded,
} from "@/lib/format";
import { useChainInvoice } from "@/components/hooks/useChainInvoice";
import { useConditionState } from "@/components/hooks/useConditionState";
import { evaluateShipmentEvidence } from "@/lib/oracle/evidence";
import { isPaidOnChain } from "@/lib/payments/availableAction";
import {
  describeSettledRisk,
  isSettlementEvidence,
  type SettledRiskInput,
} from "@/lib/payments/settledRisk";
import { money } from "@/lib/escrow/present";
import { cn } from "@/lib/utils";
import type { DeterministicAnalysis, TreasuryDecision } from "@/lib/types";

/**
 * Risk assessment.
 *
 * The observations are deterministic facts; the LEVEL is the model's judgement
 * of them. Both are shown, in that order, so a reader can disagree with the
 * conclusion while still trusting the evidence.
 *
 * CHAIN FIRST, as everywhere else. Re-analysing a settled invoice answers a
 * question about a payment that does not exist — could we pay this now? no, it
 * is already paid — and rendering that answer as the invoice's risk turned a
 * completed payment into CRITICAL carrying a "Duplicate invoice" observation.
 * A settled invoice gets an assessment of the transaction that happened.
 */
export function RiskPanel({
  facts,
  decision,
  invoiceNumber,
}: {
  facts: DeterministicAnalysis;
  decision: TreasuryDecision;
  /** Enables the chain lookup. Without it the panel describes the local run. */
  invoiceNumber?: string;
}) {
  const { invoice: chainInvoice, resolved: chainResolved } = useChainInvoice(
    invoiceNumber ?? "",
  );
  const { condition, resolved: conditionResolved } = useConditionState(invoiceNumber ?? "");

  const settled =
    Boolean(invoiceNumber) &&
    chainResolved &&
    conditionResolved &&
    (condition?.stage === "RELEASED" || isPaidOnChain(chainInvoice?.status ?? null));

  if (settled) {
    return (
      <SettledRiskPanel
        conditionStage={condition?.stage ?? null}
        oracleConfirmed={
          condition
            ? evaluateShipmentEvidence({
                invoiceNumber: condition.invoiceNumber,
                proof: condition.proof,
                attestation: condition.attestation,
              }).confirmed
            : false
        }
        chainInvoiceStatus={chainInvoice?.status ?? null}
        amountLabel={money(condition?.amountCents ?? chainInvoice?.amountCents ?? 0)}
      />
    );
  }

  // Settlement facts are not anomalies, so they never appear under "flagged".
  // The completed payment is described by the settled panel instead.
  const evidence = facts.riskEvidence.filter((item) => !isSettlementEvidence(item.code));

  return (
    <Panel>
      <PanelHeader eyebrow="AI risk assessment" title="Trustworthiness of this payment" />
      <PanelBody className="space-y-5">
        <LevelMeter kind="risk" level={decision.risk} />

        <p className="text-[13px] leading-relaxed text-ink-soft">
          {decision.riskExplanation}
        </p>

        <div>
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            {evidence.length > 0
              ? `${evidence.length} observation${evidence.length === 1 ? "" : "s"} flagged`
              : "Observations"}
          </div>

          {evidence.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-pos/25 bg-pos-soft px-3 py-2.5">
              <span className="text-[11px] font-bold text-pos">✓</span>
              <span className="text-[12.5px] text-pos">
                No payment anomalies detected in the deterministic checks.
              </span>
            </div>
          ) : (
            <ul className="space-y-2">
              {evidence.map((item) => (
                <li
                  key={item.code}
                  className="rounded-lg border border-hairline bg-surface-sunken px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-ink">
                      {RISK_EVIDENCE_LABEL[item.code] ?? item.code}
                    </span>
                    <Badge tone="muted">fact</Badge>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
                    {item.observation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ConfidenceBar confidence={decision.confidence} />
      </PanelBody>
    </Panel>
  );
}

/**
 * The risk panel for an invoice that has already been paid.
 *
 * Reports the completed transaction: what the chain established, in the order
 * it happened. There is deliberately no risk LEVEL — a level answers "how
 * dangerous would this payment be", and the payment is no longer a prospect.
 */
function SettledRiskPanel({
  conditionStage,
  oracleConfirmed,
  chainInvoiceStatus,
  amountLabel,
}: {
  conditionStage: SettledRiskInput["conditionStage"];
  oracleConfirmed: boolean;
  chainInvoiceStatus: string | null;
  amountLabel: string;
}) {
  const view = describeSettledRisk({
    conditionStage,
    oracleConfirmed,
    chainInvoiceStatus,
    amountLabel,
  });

  return (
    <Panel tone="positive">
      <PanelHeader eyebrow="Payment status" title="What happened to this payment" />
      <PanelBody className="space-y-4">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[15px] leading-none text-pos">✓</span>
          <span className="text-[17px] font-semibold uppercase tracking-[-0.01em] text-pos">
            {view.headline}
          </span>
        </div>

        <p className="text-[13px] leading-relaxed text-ink-soft">{view.assessment}</p>

        <div>
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            Evidence
          </div>
          <ul className="space-y-1.5">
            {view.checks.map((check) => (
              <li key={check.label} className="flex items-baseline gap-2 text-[12.5px]">
                <span className={cn("shrink-0", check.ok ? "text-pos" : "text-ink-faint")}>
                  {check.ok ? "✓" : "·"}
                </span>
                <span className={check.ok ? "text-ink-soft" : "text-ink-faint"}>
                  {check.label}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="border-t border-hairline pt-3 text-[12px] leading-relaxed text-ink-faint">
          {view.note}
        </p>
      </PanelBody>
    </Panel>
  );
}

/**
 * Urgency is a separate question from risk and is drawn in a separate colour
 * family. A HIGH urgency invoice from a trusted supplier is not dangerous — it
 * is simply due soon.
 */
export function UrgencyPanel({
  facts,
  decision,
}: {
  facts: DeterministicAnalysis;
  decision: TreasuryDecision;
}) {
  const urgency = facts.urgencyFacts;

  return (
    <Panel>
      <PanelHeader eyebrow="Payment urgency" title="How soon this has to move" />
      <PanelBody className="space-y-5">
        <LevelMeter
          kind="urgency"
          level={decision.urgency}
          caption={
            urgency.isOverdue
              ? `Overdue by ${Math.abs(urgency.daysUntilDue)} days.`
              : `${urgency.daysUntilDue} day${urgency.daysUntilDue === 1 ? "" : "s"} until the due date.`
          }
        />

        <dl className="space-y-2.5 border-t border-hairline pt-4">
          <Row label="Payment deadline" value={formatFullDate(urgency.dueDate)} />
          <Row label="Time remaining" value={describeDueIn(urgency.daysUntilDue)} />
          <Row
            label="Early-payment discount"
            value={
              urgency.discountAmountCents && urgency.discountDeadline ? (
                <span className="text-pos">
                  {formatMoneyRounded(urgency.discountAmountCents)} until{" "}
                  {formatFullDate(urgency.discountDeadline)}
                </span>
              ) : (
                "None"
              )
            }
          />
          <Row label="Supplier criticality" value={urgency.businessCriticality ?? "Unknown"} />
          <Row label="Payment terms" value={urgency.paymentTerms ?? "—"} />
        </dl>

        <p className="text-[12px] leading-relaxed text-ink-faint">
          Urgency describes timing only. It never raises or lowers the risk
          level, and it can never authorise a payment on its own.
        </p>
      </PanelBody>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[12.5px] text-ink-faint">{label}</dt>
      <dd className="text-right text-[12.5px] font-medium text-ink">{value}</dd>
    </div>
  );
}
