"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LockIcon, Shield01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { readTreasuryPolicy, type OnChainPolicy } from "@/lib/services/suiService";
import { formatMoney } from "@/lib/format";

export function useOnChainPolicy(): OnChainPolicy | null {
  const [policy, setPolicy] = useState<OnChainPolicy | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readTreasuryPolicy().then((result) => {
      if (!cancelled) setPolicy(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return policy;
}

/**
 * Policy is displayed, never edited here.
 *
 * These values are owned by the treasury holder on chain. An interface that
 * offered to change them would be claiming an authority it does not have — and
 * an agent that could change them would not be constrained at all.
 */
export function TreasuryPolicyPanel({ policy }: { policy: OnChainPolicy | null }) {
  return (
    <Panel tone="chain">
      <PanelHeader
        tone="chain"
        eyebrow={
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon icon={Shield01Icon} size={11} strokeWidth={2} />
            Treasury policy
          </span>
        }
        title="Protected by Sui"
        subtitle="Owner-signed on-chain values. Read-only from this interface and from the agent."
        actions={<Badge tone="chain">Move object</Badge>}
      />
      <PanelBody className="space-y-4">
        <PolicyRow
          label="Autonomous payment"
          value={policy?.capability.enabled ? "Enabled" : "Disabled"}
          tone={policy?.capability.enabled ? "pos" : "neg"}
        />
        <PolicyRow
          label="Maximum AI payment"
          value={policy ? formatMoney(policy.capability.maxSinglePaymentCents) : "—"}
        />
        <PolicyRow
          label="Daily AI payment limit"
          value={policy ? formatMoney(policy.capability.dailyLimitCents) : "—"}
        />
        <PolicyRow
          label="Minimum cash reserve"
          value={policy ? formatMoney(policy.policy.minimumReserveCents) : "—"}
        />
        <PolicyRow
          label="Human approval threshold"
          value={policy ? formatMoney(policy.capability.maxSinglePaymentCents) : "—"}
          note="Anything above the agent's cap requires a treasury operator"
        />
        <PolicyRow
          label="Allowed currencies"
          value={policy ? policy.policy.allowedCurrencies.join(", ") : "—"}
        />

        <div className="flex items-start gap-2.5 rounded-lg border border-chain-border bg-chain-soft px-3.5 py-3">
          <HugeiconsIcon
            icon={LockIcon}
            size={15}
            strokeWidth={1.8}
            className="mt-px shrink-0 text-chain"
          />
          <p className="text-[12px] leading-relaxed text-chain">
            Changing any of these requires a transaction signed by the treasury
            owner. Neither the AI agent nor this interface holds that authority —
            the agent&apos;s capability object grants spending rights only.
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function OnChainObjectsPanel({ policy }: { policy: OnChainPolicy | null }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="On-chain objects"
        title="Where the rules actually live"
        actions={
          policy ? (
            <Badge tone="neutral">{policy.network === "demo" ? "Demo network" : policy.network}</Badge>
          ) : null
        }
      />
      <PanelBody className="space-y-3.5">
        <ObjectRow label="Package" value={policy?.packageId} />
        <ObjectRow label="Treasury object" value={policy?.treasuryObjectId} />
        <ObjectRow label="Agent capability" value={policy?.capabilityObjectId} />
        <ObjectRow label="Agent id" value={policy?.capability.agentId} />
        <p className="pt-1 text-[11.5px] leading-relaxed text-ink-faint">
          Enforcement currently runs against the Move mirror in{" "}
          <span className="font-mono">lib/sui/policyGuard.ts</span>, which returns
          the same violation codes the module aborts with. Swapping in a dry-run
          against the deployed package changes no interface code.
        </p>
      </PanelBody>
    </Panel>
  );
}

function PolicyRow({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-hairline pb-3.5 last:border-0 last:pb-0">
      <div>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {note ? <div className="mt-0.5 text-[11.5px] text-ink-faint">{note}</div> : null}
      </div>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "tabular text-[14px] font-semibold",
            tone === "pos" && "text-pos",
            tone === "neg" && "text-neg",
            !tone && "text-ink",
          )}
        >
          {value}
        </span>
        <HugeiconsIcon
          icon={LockIcon}
          size={13}
          strokeWidth={1.8}
          className="shrink-0 text-ink-faint"
        />
      </div>
    </div>
  );
}

function ObjectRow({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1 break-all font-mono text-[11.5px] text-ink-soft">
        {value ?? "—"}
      </div>
    </div>
  );
}
