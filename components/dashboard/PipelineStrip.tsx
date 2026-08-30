/**
 * The four layers, across the top of the dashboard.
 *
 * A judge has about five seconds to work out what this product is. Without
 * this, the screen looks like an AI that pays invoices — which is both wrong
 * and the opposite of the point. Each stage is labelled with what it is
 * ALLOWED to do, because supplying a fact, recommending, constraining and
 * enforcing are four different kinds of authority and only the last moves
 * money.
 *
 * Presentational: the stages come from lib/oracle/feed.ts.
 */

import { PIPELINE_STAGES, PIPELINE_SUMMARY, type PipelineStage } from "@/lib/oracle/feed";
import { cn } from "@/lib/utils";

const TONE: Record<PipelineStage["tone"], { chip: string; label: string }> = {
  neutral: { chip: "border-hairline bg-surface-sunken", label: "text-ink-soft" },
  ai: { chip: "border-ai-border bg-ai-soft", label: "text-ai" },
  warning: { chip: "border-warn/30 bg-warn-soft", label: "text-warn" },
  chain: { chip: "border-chain-border bg-chain-soft", label: "text-chain" },
};

export function PipelineStrip({ className }: { className?: string }) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-hairline bg-surface shadow-[0_1px_2px_rgba(16,20,32,0.04)]",
        className,
      )}
      aria-label="How a payment decision is made"
    >
      <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-stretch md:gap-0">
        {PIPELINE_STAGES.map((stage, index) => (
          <div key={stage.key} className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className={cn(
                "min-w-0 flex-1 rounded-lg border px-3.5 py-3",
                TONE[stage.tone].chip,
              )}
            >
              <div
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-[0.08em]",
                  TONE[stage.tone].label,
                )}
              >
                {stage.label}
              </div>
              <div className="mt-1 text-[12.5px] leading-snug text-ink-soft">{stage.role}</div>
            </div>

            {index < PIPELINE_STAGES.length - 1 && (
              <span aria-hidden className="shrink-0 px-1 text-ink-faint">
                <span className="hidden md:inline">→</span>
                <span className="md:hidden">↓</span>
              </span>
            )}
          </div>
        ))}
      </div>

      <p className="border-t border-hairline px-5 py-2.5 text-[12.5px] text-ink-faint">
        {PIPELINE_SUMMARY} The oracle authorizes nothing, and the agent never holds the funds.
      </p>
    </section>
  );
}
