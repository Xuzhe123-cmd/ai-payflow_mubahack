import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Eyebrow } from "./Badge";

export type PanelTone = "default" | "ai" | "chain" | "positive" | "negative";

const TONE: Record<PanelTone, { shell: string; head: string }> = {
  default: { shell: "border-hairline bg-surface", head: "" },
  ai: { shell: "border-ai-border bg-surface", head: "bg-ai-soft" },
  chain: { shell: "border-chain-border bg-surface", head: "bg-chain-soft" },
  positive: { shell: "border-pos/30 bg-surface", head: "bg-pos-soft" },
  negative: { shell: "border-neg/30 bg-surface", head: "bg-neg-soft" },
};

export function Panel({
  tone = "default",
  className,
  children,
}: {
  tone?: PanelTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(16,20,32,0.04)]",
        TONE[tone].shell,
        className,
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  tone = "default",
  className,
}: {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tone?: PanelTone;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-hairline px-5 py-4",
        TONE[tone].head,
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? <Eyebrow className="block">{eyebrow}</Eyebrow> : null}
        {title ? (
          <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
        ) : null}
        {subtitle ? (
          <p className="text-[13px] leading-snug text-ink-faint">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

/** A label/value row, the workhorse of the invoice detail screens. */
export function Field({
  label,
  value,
  mono = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
        {label}
      </div>
      <div
        className={cn(
          "text-[13.5px] leading-snug text-ink",
          mono && "font-mono text-[12.5px] break-all",
        )}
      >
        {value}
      </div>
    </div>
  );
}
