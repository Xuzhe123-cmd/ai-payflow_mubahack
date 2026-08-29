"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/common/States";
import type { ActivityEvent, ActivityScope } from "@/components/providers/PayflowProvider";

const SCOPE_STYLE: Record<ActivityScope, { label: string; dot: string; chip: string }> = {
  SYSTEM: { label: "System", dot: "bg-ink-faint", chip: "text-ink-faint bg-surface-sunken" },
  INBOX: { label: "Inbox", dot: "bg-ink-soft", chip: "text-ink-soft bg-surface-sunken" },
  AI: { label: "AI", dot: "bg-ai", chip: "text-ai bg-ai-soft" },
  CHAIN: { label: "Sui", dot: "bg-chain", chip: "text-chain bg-chain-soft" },
};

/**
 * The audit trail.
 *
 * Each entry names WHO acted — the inbox, the model, or the chain — because
 * "the system did something" is not an auditable statement. Ordering is
 * newest-first; the record is append-only and nothing here can edit it.
 */
export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Connect the finance inbox to start the audit trail."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      <ol className="divide-y divide-hairline">
        {events.map((event) => {
          const style = SCOPE_STYLE[event.scope];
          return (
            <li key={event.id} className="flex gap-4 px-5 py-3.5">
              <div className="tabular w-16 shrink-0 pt-0.5 text-[12px] text-ink-faint">
                {event.at}
              </div>

              <div className="relative flex shrink-0 flex-col items-center pt-1.5">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    event.tone === "negative"
                      ? "bg-neg"
                      : event.tone === "positive"
                        ? "bg-pos"
                        : style.dot,
                  )}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span
                    className={cn(
                      "text-[13.5px] font-medium",
                      event.tone === "negative" ? "text-neg" : "text-ink",
                    )}
                  >
                    {event.title}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em]",
                      style.chip,
                    )}
                  >
                    {style.label}
                  </span>
                  {event.invoiceId ? (
                    <Link
                      href={`/invoices/${event.invoiceId}`}
                      className="text-[11.5px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                    >
                      open invoice
                    </Link>
                  ) : null}
                </div>
                {event.detail ? (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-faint">
                    {event.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
