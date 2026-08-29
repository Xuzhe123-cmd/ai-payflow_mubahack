import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-sweep rounded-md",
        "bg-[linear-gradient(90deg,var(--surface-sunken)_25%,color-mix(in_oklch,var(--surface-sunken)_55%,var(--background))_37%,var(--surface-sunken)_63%)]",
        className,
      )}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-hairline",
        "bg-surface px-6 py-14 text-center",
        className,
      )}
    >
      {icon ? <div className="mb-3 text-ink-faint">{icon}</div> : null}
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-faint">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * The staged progress list used by inbox connection, analysis and execution.
 * Stages are shown in full from the start so the operator can see what the
 * system is going to do, not only what it has done.
 */
export function StageList({
  stages,
  className,
}: {
  stages: {
    id: string;
    label: string;
    state: "pending" | "active" | "done" | "failed";
    detail?: string | null;
  }[];
  className?: string;
}) {
  return (
    <ol className={cn("space-y-2.5", className)}>
      {stages.map((stage) => (
        <li key={stage.id} className="flex items-start gap-3">
          <StageMark state={stage.state} />
          <div className="min-w-0 flex-1 pt-px">
            <span
              className={cn(
                "text-[13px] leading-snug transition-colors duration-300",
                stage.state === "pending" && "text-ink-faint",
                stage.state === "active" && "font-medium text-ink",
                stage.state === "done" && "text-ink-soft",
                stage.state === "failed" && "font-medium text-neg",
              )}
            >
              {stage.label}
            </span>
            {stage.detail ? (
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-faint">
                {stage.detail}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StageMark({ state }: { state: "pending" | "active" | "done" | "failed" }) {
  if (state === "done") {
    return (
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border border-pos/30 bg-pos-soft text-[10px] font-bold text-pos">
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border border-neg/30 bg-neg-soft text-[10px] font-bold text-neg">
        ✕
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
        <span className="size-[13px] animate-spin rounded-full border-[1.5px] border-ai/25 border-t-ai" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
      <span className="size-1.5 rounded-full bg-hairline" />
    </span>
  );
}
