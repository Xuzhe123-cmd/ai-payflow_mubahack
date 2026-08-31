import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * One assertion, drawn the same way whether it came from invoice validation or
 * from the chain. `tone` shifts the tick colour so an on-chain check reads as
 * enforcement rather than as another opinion.
 *
 * THE THIRD STATE. `passed` alone cannot describe every finding: an invoice
 * that has already been settled is neither a pass nor a fault. Drawn as a red
 * ✕ it reads as an accusation against a payment that completed correctly, and
 * that is how "✕ No duplicate detected / Already settled as payment
 * chain_0x927e…" came to sit on screen. `tone="warn"` draws it as ⚠ and leaves
 * the label uncoloured — a finding worth reading, not a failure.
 */
export function CheckRow({
  passed,
  label,
  detail,
  note,
  limit,
  actual,
  tone = "verify",
  index = 0,
  animate = false,
}: {
  passed: boolean;
  label: ReactNode;
  detail?: ReactNode;
  /** A smaller line under the detail: what follows from the finding. */
  note?: ReactNode;
  limit?: string | null;
  actual?: string | null;
  tone?: "verify" | "chain" | "warn";
  index?: number;
  animate?: boolean;
}) {
  const warn = tone === "warn";
  const markClass = warn
    ? "border-warn/35 bg-warn-soft text-warn"
    : passed
      ? tone === "chain"
        ? "border-chain/30 bg-chain-soft text-chain"
        : "border-pos/30 bg-pos-soft text-pos"
      : "border-neg/30 bg-neg-soft text-neg";

  return (
    <li
      className={cn(
        "flex items-start gap-3 py-2",
        animate && "animate-rise",
      )}
      style={animate ? { animationDelay: `${index * 70}ms` } : undefined}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border text-[10px] font-bold",
          markClass,
        )}
      >
        {warn ? "⚠" : passed ? "✓" : "✕"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span
            className={cn(
              "text-[13.5px] font-medium leading-snug",
              warn ? "text-warn" : passed ? "text-ink" : "text-neg",
            )}
          >
            {label}
          </span>
          {limit !== undefined && limit !== null && actual ? (
            <span className="tabular text-[11.5px] text-ink-faint">
              limit <span className="font-medium text-ink-soft">{limit}</span>
              <span className="mx-1.5 text-hairline">|</span>
              requested{" "}
              <span
                className={cn(
                  "font-medium",
                  passed ? "text-ink-soft" : "text-neg",
                )}
              >
                {actual}
              </span>
            </span>
          ) : null}
        </div>
        {detail ? (
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-faint">{detail}</p>
        ) : null}
        {note ? (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{note}</p>
        ) : null}
      </div>
    </li>
  );
}

export function CheckList({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <ul className={cn("divide-y divide-hairline", className)}>{children}</ul>;
}
