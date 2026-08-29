import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Eyebrow } from "./Badge";

/**
 * The top-of-page figure. Deliberately restrained: one number, one label, one
 * line of context. Anything more and the row stops reading as a summary.
 */
export function MetricCard({
  label,
  value,
  context,
  accent,
  trailing,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  context?: ReactNode;
  /** A thin colour rule on the left edge, for status-bearing metrics. */
  accent?: "ai" | "chain" | "pos" | "warn" | "neg" | null;
  trailing?: ReactNode;
  className?: string;
}) {
  const accentClass =
    accent === "ai"
      ? "before:bg-ai"
      : accent === "chain"
        ? "before:bg-chain"
        : accent === "pos"
          ? "before:bg-pos"
          : accent === "warn"
            ? "before:bg-warn"
            : accent === "neg"
              ? "before:bg-neg"
              : null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-hairline bg-surface px-5 py-4",
        "shadow-[0_1px_2px_rgba(16,20,32,0.04)]",
        accentClass &&
          cn(
            "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
            accentClass,
          ),
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>{label}</Eyebrow>
        {trailing}
      </div>
      <div className="tabular mt-2.5 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">
        {value}
      </div>
      {context ? (
        <div className="mt-2 text-[12.5px] leading-snug text-ink-faint">{context}</div>
      ) : null}
    </div>
  );
}
