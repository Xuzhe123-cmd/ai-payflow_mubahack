"use client";

import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/PageContainer";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { MetricCard } from "@/components/common/MetricCard";
import { CheckList, CheckRow } from "@/components/common/CheckRow";
import { EmptyState } from "@/components/common/States";
import { LinkButton } from "@/components/common/LinkButton";
import { Badge } from "@/components/common/Badge";
import {
  OnChainObjectsPanel,
  useOnChainPolicy,
} from "@/components/settings/PolicyPanels";
import { useInvoiceEntries, useInvoiceStats } from "@/components/hooks/usePayflowSelectors";
import { formatMoneyRounded } from "@/lib/format";

/**
 * The security view answers one question: what stopped, and why.
 *
 * Blocked payments are the product working, not the product failing, so they
 * are given the most prominent treatment on this page.
 */
export default function SecurityPage() {
  const policy = useOnChainPolicy();
  const entries = useInvoiceEntries();
  const stats = useInvoiceStats();

  const blocked = entries.filter(
    (entry) => entry.run?.analysis?.enforcement?.outcome === "SUI_REJECT",
  );
  // Categories, not raw outcomes. An invoice the guard refuses a SECOND payment
  // for is settled, not rejected, and counting it here claimed the treasury had
  // turned away a payment it had in fact made.
  const rejected = entries.filter((entry) => entry.category === "rejected");
  const escalated = entries.filter((entry) => entry.category === "review");

  return (
    <PageContainer>
      <PageHeader
        title="Security"
        subtitle="Where the AI's authority ends. Every payment crosses an on-chain boundary that re-derives its own answer from treasury state."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Blocked on chain"
          value={String(blocked.length)}
          context="Move aborted the transaction"
          accent={blocked.length > 0 ? "neg" : null}
        />
        <MetricCard
          label="Rejected by AI"
          value={String(rejected.length)}
          context="Never reached the treasury"
        />
        <MetricCard
          label="Escalated to a human"
          value={String(escalated.length)}
          context="The agent declined to decide alone"
          accent={escalated.length > 0 ? "warn" : null}
        />
        <MetricCard
          label="Agent payment cap"
          value={policy ? formatMoneyRounded(policy.capability.maxSinglePaymentCents) : "—"}
          context="Per-payment ceiling enforced by Move"
          accent="chain"
        />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <div>
            <SectionTitle
              title="Payments stopped by policy"
              description="Recommendations the chain refused to execute"
            />
            {blocked.length === 0 ? (
              <EmptyState
                title="Nothing has been blocked"
                description="No AI recommendation has yet exceeded what the treasury permits."
              />
            ) : (
              <div className="space-y-4">
                {blocked.map((entry) => {
                  const analysis = entry.run!.analysis!;
                  const failed =
                    analysis.enforcement?.checks.filter((check) => !check.passed) ?? [];
                  return (
                    <Panel key={entry.invoice.id} tone="negative">
                      <PanelHeader
                        tone="negative"
                        eyebrow="Blocked"
                        title={`${entry.invoice.invoiceNumber} · ${entry.invoice.supplierName}`}
                        subtitle={`The model recommended ${analysis.decision.action.replace("_", " ")} for ${formatMoneyRounded(
                          analysis.paymentRequest?.amountCents ?? entry.invoice.amountCents,
                          entry.invoice.currency,
                        )}.`}
                        actions={
                          <LinkButton
                            href={`/invoices/${entry.invoice.id}`}
                            variant="outline"
                            size="sm"
                            className="rounded-lg"
                          >
                            View analysis
                          </LinkButton>
                        }
                      />
                      <PanelBody className="py-2">
                        <CheckList>
                          {failed.map((check, index) => (
                            <CheckRow
                              key={check.code}
                              passed={false}
                              label={check.label}
                              detail={check.detail}
                              limit={check.limit}
                              actual={check.actual}
                              tone="chain"
                              index={index}
                            />
                          ))}
                        </CheckList>
                      </PanelBody>
                    </Panel>
                  );
                })}
              </div>
            )}
          </div>

          <Panel>
            <PanelHeader
              eyebrow="Enforcement model"
              title="Four independent boundaries"
            />
            <PanelBody className="space-y-4">
              <Boundary
                title="The model never sees money"
                body="Amounts, recipients and balances are extracted and simulated deterministically. The model chooses whether and when to pay — never how much, or to whom."
              />
              <Boundary
                title="The candidate set is closed"
                body="A recommended date outside the simulated candidates is rejected by the output guard before a payment request exists."
                badge="Guard"
              />
              <Boundary
                title="Only two actions create a request"
                body="Human review and rejection are terminal. The chain is never asked to authorise something the agent did not explicitly propose."
              />
              <Boundary
                title="Move re-checks everything"
                body="Authorization, supplier approval, wallet, limits, duplicates and the reserve are all re-derived on chain. Nothing the AI concluded is taken on trust."
                badge="Sui"
                tone="chain"
              />
            </PanelBody>
          </Panel>
        </div>

        <div className="space-y-5">
          <OnChainObjectsPanel policy={policy} />

          <Panel>
            <PanelHeader eyebrow="Session totals" title="This demo session" />
            <PanelBody>
              <dl className="space-y-2.5 text-[13px]">
                <Row label="Invoices analyzed" value={String(stats.total - stats.pending)} />
                <Row label="Cleared to pay" value={String(stats.approved + stats.paid)} />
                <Row label="Scheduled" value={String(stats.scheduled)} />
                <Row label="Escalated" value={String(stats.needsReview)} />
                <Row label="Blocked or rejected" value={String(stats.blocked + stats.rejected)} />
              </dl>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </PageContainer>
  );
}

function Boundary({
  title,
  body,
  badge,
  tone = "neutral",
}: {
  title: string;
  body: string;
  badge?: string;
  tone?: "neutral" | "chain";
}) {
  return (
    <div className="border-b border-hairline pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {badge ? <Badge tone={tone === "chain" ? "chain" : "neutral"}>{badge}</Badge> : null}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{body}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="tabular font-semibold text-ink">{value}</dd>
    </div>
  );
}
