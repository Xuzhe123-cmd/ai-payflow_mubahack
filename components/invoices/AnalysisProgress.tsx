"use client";

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { StageList } from "@/components/common/States";
import { Badge } from "@/components/common/Badge";
import { STEP_LABELS, type InvoiceRun } from "@/components/providers/PayflowProvider";
import type { PipelineStepName } from "@/lib/types";

/**
 * The pipeline, made visible.
 *
 * Order matters and is not cosmetic: facts are assembled and frozen BEFORE the
 * model is called, and policy is enforced AFTER it answers. Showing the stages
 * in that order is the clearest way to explain why the model cannot quietly
 * grant itself permission.
 */
const STEP_ORDER: PipelineStepName[] = [
  "extract",
  "supplier",
  "validate",
  "forecast",
  "policy_read",
  "analysis",
  "ai_decision",
  "policy_enforce",
];

const STEP_GROUP: Record<PipelineStepName, string> = {
  extract: "Deterministic",
  supplier: "Deterministic",
  validate: "Deterministic",
  forecast: "Deterministic",
  policy_read: "On chain",
  analysis: "Deterministic",
  ai_decision: "AI",
  policy_enforce: "On chain",
};

export function AnalysisProgress({ run }: { run: InvoiceRun }) {
  const completed = new Set(run.completedSteps);
  const activeIndex = STEP_ORDER.findIndex((step) => !completed.has(step));

  return (
    <Panel tone="ai">
      <PanelHeader
        tone="ai"
        eyebrow="Analysis in progress"
        title="The agent is working through this invoice"
        actions={<Badge tone="ai" dot pulse>Live</Badge>}
      />
      <PanelBody>
        <StageList
          stages={STEP_ORDER.map((step, index) => ({
            id: step,
            label: STEP_LABELS[step],
            detail: STEP_GROUP[step],
            state: completed.has(step)
              ? ("done" as const)
              : index === activeIndex
                ? ("active" as const)
                : ("pending" as const),
          }))}
        />
      </PanelBody>
    </Panel>
  );
}

export function AnalysisFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Panel tone="negative">
      <PanelHeader
        tone="negative"
        eyebrow="Analysis failed"
        title="The agent could not complete this analysis"
      />
      <PanelBody className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-soft">{message}</p>
        <p className="text-[12.5px] leading-relaxed text-ink-faint">
          No decision was produced, so nothing was submitted to the treasury.
          Nothing is ever paid on a failed analysis.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-sunken"
        >
          Retry analysis
        </button>
      </PanelBody>
    </Panel>
  );
}
