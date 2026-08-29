import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * One assertion, drawn the same way whether it came from invoice validation or
 * from the chain. `tone` shifts the tick colour so an on-chain check reads as
 * enforcement rather than as another opinion.
 */
export function CheckRow({
  passed,
  label,
  detail,
  limit,
  actual,
  tone = "verify",
  index = 0,
  animate = false,
}: {
  passed: boolean;
  label: ReactNode;
  detail?: ReactNode;
  limit?: string | null;
  actual?: string | null;
  tone?: "verify" | "chain";
  index?: number;
  animate?: boolean;
}) {
  const markClass = passed
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
        {passed ? "✓" : "✕"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span
            className={cn(
              "text-[13.5px] font-medium leading-snug",
              passed ? "text-ink" : "text-neg",
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
