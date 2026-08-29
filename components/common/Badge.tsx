import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "muted"
  | "positive"
  | "warning"
  | "negative"
  | "ai"
  | "chain";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-ink-soft border-hairline",
  muted: "bg-transparent text-ink-faint border-hairline",
  positive: "bg-pos-soft text-pos border-pos/25",
  warning: "bg-warn-soft text-warn border-warn/30",
  negative: "bg-neg-soft text-neg border-neg/25",
  ai: "bg-ai-soft text-ai border-ai-border",
  chain: "bg-chain-soft text-chain border-chain-border",
};

const DOT_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-ink-faint",
  muted: "bg-ink-faint",
  positive: "bg-pos",
  warning: "bg-warn",
  negative: "bg-neg",
  ai: "bg-ai",
  chain: "bg-chain",
};

export function Badge({
  tone = "neutral",
  dot = false,
  pulse = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
        "text-[11px] font-medium tracking-wide whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT_CLASS[tone],
            pulse && "animate-live",
          )}
        />
      ) : null}
      {children}
    </span>
  );
}

/** A quiet uppercase label used above panels and metric values. */
export function Eyebrow({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-faint",
        className,
      )}
    >
      {children}
    </span>
  );
}
