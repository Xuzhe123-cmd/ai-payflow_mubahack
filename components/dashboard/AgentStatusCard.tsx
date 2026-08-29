"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Shield01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { formatMoneyRounded } from "@/lib/format";
import { useActiveTreasury, useInvoiceStats } from "@/components/hooks/usePayflowSelectors";
import { usePayflow } from "@/components/providers/PayflowProvider";

/**
 * What the agent has done, and what it is permitted to do.
 *
 * The two halves are separated deliberately: activity is a record, capability
 * is a constraint the agent cannot alter. Showing them together is what makes
 * "the agent has limits" a visible property rather than a claim.
 */
export function AgentStatusCard() {
  const { state } = usePayflow();
  const stats = useInvoiceStats();
  const { view } = useActiveTreasury();
  const capability = view.capability;

  const decisions = state.invoices.filter(
    (invoice) => state.runs[invoice.id]?.analysis,
  ).length;

  const active = capability.authorized && capability.enabled;

  return (
    <Panel>
      <PanelHeader
        eyebrow="AI treasury agent"
        title={
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 rounded-full",
                active ? "animate-live bg-pos" : "bg-ink-faint",
              )}
            />
            {active ? "Active" : "Disabled"}
          </span>
        }
        actions={
          <Badge tone="chain">
            <HugeiconsIcon icon={Shield01Icon} size={11} strokeWidth={2} />
            On-chain capability
          </Badge>
        }
      />

      <PanelBody className="space-y-5">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3.5">
          <Stat label="Monitoring" value={`${stats.total} invoices`} />
          <Stat label="Decisions today" value={String(decisions)} />
          <Stat
            label="Cleared to pay"
            value={String(stats.approved + stats.paid)}
            tone={stats.approved + stats.paid > 0 ? "pos" : undefined}
          />
          <Stat
            label="Sent to a human"
            value={String(stats.needsReview)}
            tone={stats.needsReview > 0 ? "warn" : undefined}
          />
          <Stat
            label="Rejected by AI"
            value={String(stats.rejected)}
            tone={stats.rejected > 0 ? "neg" : undefined}
          />
          <Stat
            label="Blocked by Sui"
            value={String(stats.blocked)}
            tone={stats.blocked > 0 ? "neg" : undefined}
          />
        </dl>

        <div className="rounded-xl border border-chain-border bg-chain-soft p-3.5">
          <Eyebrow className="text-chain">Agent capability</Eyebrow>
          <dl className="mt-2.5 space-y-2">
            <CapabilityRow
              label="Maximum single payment"
              value={formatMoneyRounded(capability.maxSinglePaymentCents)}
            />
            <CapabilityRow
              label="Daily limit"
              value={formatMoneyRounded(capability.dailyLimitCents)}
            />
            <CapabilityRow
              label="Spent today"
              value={formatMoneyRounded(capability.dailySpentCents)}
            />
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-chain/85">
            Enforced by Move. The agent cannot raise these limits, and neither
            can this interface.
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "pos" | "warn" | "neg";
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
        {label}
      </dt>
      <dd
        className={cn(
          "tabular mt-1 text-[17px] font-semibold tracking-[-0.01em]",
          tone === "pos" && "text-pos",
          tone === "warn" && "text-warn",
          tone === "neg" && "text-neg",
          !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function CapabilityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12.5px] text-chain/85">{label}</dt>
      <dd className="tabular text-[13px] font-semibold text-chain">{value}</dd>
    </div>
  );
}
