"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { PageContainer, PageHeader } from "@/components/layout/PageContainer";
import { ActivityTimeline } from "@/components/activity/ActivityTimeline";
import { usePayflow, type ActivityScope } from "@/components/providers/PayflowProvider";

type Filter = "ALL" | ActivityScope;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "ALL", label: "All events" },
  { id: "INBOX", label: "Inbox" },
  { id: "AI", label: "AI decisions" },
  { id: "CHAIN", label: "On chain" },
  { id: "SYSTEM", label: "System" },
];

export default function ActivityPage() {
  const { state } = usePayflow();
  const [filter, setFilter] = useState<Filter>("ALL");

  const events =
    filter === "ALL"
      ? state.activity
      : state.activity.filter((event) => event.scope === filter);

  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        subtitle="Every step the system took, in order, attributed to the layer that took it. This is what makes an autonomous decision reviewable after the fact."
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              filter === item.id
                ? "border-ink bg-ink text-background"
                : "border-hairline text-ink-soft hover:bg-surface-sunken",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <ActivityTimeline events={events} />
    </PageContainer>
  );
}
