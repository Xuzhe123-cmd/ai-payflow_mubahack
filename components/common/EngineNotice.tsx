"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { describeEngineFailure } from "@/lib/format";
import type { AnalysisResponse } from "@/lib/services/contracts";

/**
 * Says plainly that no model ran.
 *
 * The one thing this interface must never do is present a safety fallback as
 * an AI decision. When the engine is unavailable every invoice is escalated to
 * a human, and the operator is told why rather than being left to infer it
 * from eight identical "needs review" badges.
 */
export function EngineNotice({
  analysis,
  className,
}: {
  analysis: AnalysisResponse;
  className?: string;
}) {
  if (analysis.engine === "LLM") return null;

  // Credentials missing is reported by the selector; a live failure arrives in
  // the fallback decision's own reasons.
  const raw =
    analysis.engineNotice ??
    analysis.decision.reasons.find((reason) => /Workers AI|could not be reached/i.test(reason)) ??
    null;

  return (
    <div
      className={cn(
        "rounded-xl border border-warn/35 bg-warn-soft px-4 py-3.5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <HugeiconsIcon
          icon={Alert01Icon}
          size={17}
          strokeWidth={1.9}
          className="mt-px shrink-0 text-warn"
        />
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-warn">
            No AI reasoning was performed — {describeEngineFailure(raw)}
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-warn/90">
            Every invoice was escalated to human review rather than being decided
            without a model. Deterministic extraction, validation and cash-flow
            simulation still ran, and on-chain policy is unaffected.
          </p>
          {raw ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11.5px] font-medium text-warn/85">
                Engine detail
              </summary>
              <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-warn/80">
                {raw}
              </p>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}
