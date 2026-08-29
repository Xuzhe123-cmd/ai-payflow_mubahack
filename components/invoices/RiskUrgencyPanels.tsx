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
import type { DeterministicAnalysis, TreasuryDecision } from "@/lib/types";

/**
 * Risk assessment.
 *
 * The observations are deterministic facts; the LEVEL is the model's judgement
 * of them. Both are shown, in that order, so a reader can disagree with the
 * conclusion while still trusting the evidence.
 */
export function RiskPanel({
  facts,
  decision,
}: {
  facts: DeterministicAnalysis;
  decision: TreasuryDecision;
}) {
  const evidence = facts.riskEvidence;

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
