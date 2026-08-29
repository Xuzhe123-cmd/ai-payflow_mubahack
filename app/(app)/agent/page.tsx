"use client";

import { PageContainer, PageHeader, SectionTitle } from "@/components/layout/PageContainer";
import { AgentStatusCard } from "@/components/dashboard/AgentStatusCard";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { ActivityTimeline } from "@/components/activity/ActivityTimeline";
import { usePayflow } from "@/components/providers/PayflowProvider";

/**
 * What the agent is, stated plainly.
 *
 * The boundaries are the interesting part of an autonomous system, so they get
 * as much space as the capabilities.
 */
export default function AgentPage() {
  const { state } = usePayflow();
  const aiEvents = state.activity.filter((event) => event.scope === "AI").slice(0, 12);

  return (
    <PageContainer>
      <PageHeader
        title="AI agent"
        subtitle="A bounded decision-maker. It reads verified facts, recommends an action, and has no authority to execute one on its own."
      />

      <div className="grid gap-5 xl:grid-cols-[352px_minmax(0,1fr)]">
        <AgentStatusCard />

        <div className="space-y-5">
          <Panel>
            <PanelHeader
              eyebrow="Operating model"
              title="How a decision is produced"
            />
            <PanelBody className="space-y-4">
              <Step
                index={1}
                title="Deterministic facts"
                body="Extraction, supplier lookup, duplicate and PO checks, and cash-flow simulation run in ordinary code. Every number the model sees is already exact — the model is never asked to do arithmetic."
                badge="No model involved"
              />
              <Step
                index={2}
                title="Frozen fact sheet"
                body="The facts are deep-frozen before the model is called. Policy limits, the reserve and supplier approval cannot be mutated on the way to a recommendation."
                badge="Immutable"
              />
              <Step
                index={3}
                title="Model judgement"
                body="The model assigns risk and urgency, picks one date from a fixed candidate set, and explains itself. It cannot invent a date, an amount or a recipient."
                badge="Cloudflare Workers AI"
                tone="ai"
              />
              <Step
                index={4}
                title="Output guard"
                body="Malformed output, an unknown action, a date outside the candidate set, or low confidence all downgrade the decision to human review rather than being trusted."
                badge="Fail closed"
              />
              <Step
                index={5}
                title="On-chain enforcement"
                body="Move re-derives every authorization question from treasury state and aborts if any assertion fails. This is the only step that can move money."
                badge="Sui"
                tone="chain"
              />
            </PanelBody>
          </Panel>

          <div>
            <SectionTitle
              title="Recent AI decisions"
              description="Every recommendation the agent has produced this session"
            />
            <ActivityTimeline events={aiEvents} />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

function Step({
  index,
  title,
  body,
  badge,
  tone = "neutral",
}: {
  index: number;
  title: string;
  body: string;
  badge: string;
  tone?: "neutral" | "ai" | "chain";
}) {
  return (
    <div className="flex gap-4">
      <span className="tabular mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-hairline bg-surface-sunken text-[11.5px] font-semibold text-ink-soft">
        {index}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
          <Badge tone={tone === "ai" ? "ai" : tone === "chain" ? "chain" : "neutral"}>
            {badge}
          </Badge>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">{body}</p>
      </div>
    </div>
  );
}
