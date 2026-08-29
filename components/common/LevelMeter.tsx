import { cn } from "@/lib/utils";
import type { Level } from "@/lib/types";
import { LEVEL_INDEX, LEVELS } from "@/lib/format";
import { Eyebrow } from "./Badge";

/**
 * Risk and urgency are different questions, so they are drawn in different
 * colour families. Risk escalates green -> amber -> red because a high risk is
 * a warning. Urgency stays inside one blue family because a high urgency is a
 * schedule fact, not a danger — colouring it red would tell the operator
 * something untrue.
 *
 * There is no 0-100 score here on purpose: the deterministic layer produces
 * facts and the model produces a level. Inventing a number in the interface
 * would be the interface making the judgement.
 */

const RISK_COLOR: Record<Level, { fill: string; text: string }> = {
  LOW: { fill: "bg-pos", text: "text-pos" },
  MEDIUM: { fill: "bg-warn", text: "text-warn" },
  HIGH: { fill: "bg-neg", text: "text-neg" },
  CRITICAL: { fill: "bg-neg", text: "text-neg" },
};

const URGENCY_COLOR = { fill: "bg-chain", text: "text-chain" };

export function LevelMeter({
  kind,
  level,
  caption,
  className,
}: {
  kind: "risk" | "urgency";
  level: Level;
  caption?: string;
  className?: string;
}) {
  const filled = LEVEL_INDEX[level] + 1;
  const palette = kind === "risk" ? RISK_COLOR[level] : URGENCY_COLOR;

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "text-[19px] font-semibold tracking-[-0.01em]",
            palette.text,
          )}
        >
          {level}
        </span>
        <Eyebrow>{kind === "risk" ? "Risk level" : "Urgency"}</Eyebrow>
      </div>

      <div className="flex gap-1" aria-label={`${kind} ${level}`}>
        {LEVELS.map((step, index) => (
          <div
            key={step}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors duration-500",
              index < filled ? palette.fill : "bg-surface-sunken",
            )}
          />
        ))}
      </div>

      <div className="flex justify-between text-[10px] font-medium uppercase tracking-[0.06em] text-ink-faint">
        {LEVELS.map((step) => (
          <span key={step} className={cn(step === level && palette.text)}>
            {step.slice(0, 3)}
          </span>
        ))}
      </div>

      {caption ? (
        <p className="text-[12.5px] leading-relaxed text-ink-soft">{caption}</p>
      ) : null}
    </div>
  );
}

/** Model confidence. Shown next to every AI conclusion, never on its own. */
export function ConfidenceBar({
  confidence,
  className,
}: {
  confidence: number;
  className?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <Eyebrow>Model confidence</Eyebrow>
        <span className="tabular text-[12.5px] font-semibold text-ink">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-ai transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
