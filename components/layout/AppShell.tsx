"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon, Robot01Icon } from "@hugeicons/core-free-icons";

import { usePayflow } from "@/components/providers/PayflowProvider";
import { Badge } from "@/components/common/Badge";
import { DemoPanel } from "@/components/demo/DemoPanel";
import { formatFullDate, formatWeekday } from "@/lib/format";
import { Sidebar, Wordmark } from "./Sidebar";

/**
 * The authenticated shell. Anything rendered inside it can assume a session
 * exists, which keeps the session check in exactly one place.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { state } = usePayflow();
  const router = useRouter();

  useEffect(() => {
    if (state.hydrated && !state.session) router.replace("/");
  }, [router, state.hydrated, state.session]);

  if (!state.hydrated) return <BootSplash />;
  if (!state.session) return <BootSplash />;

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1">{children}</main>
      </div>
      <DemoPanel />
    </div>
  );
}

function TopBar() {
  const { state, asOfDate } = usePayflow();

  const engine = useMemo(() => {
    for (const run of Object.values(state.runs)) {
      if (run.analysis) return run.analysis;
    }
    return null;
  }, [state.runs]);

  const analyzing = Object.values(state.runs).some((run) => run.status === "ANALYZING");

  return (
    <div className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-hairline bg-background/85 px-6 backdrop-blur-md lg:px-10">
      <div className="flex items-center gap-2 text-[13px] text-ink-faint">
        <HugeiconsIcon icon={Calendar03Icon} size={15} strokeWidth={1.8} />
        <span className="tabular">
          {formatWeekday(asOfDate)}, {formatFullDate(asOfDate)}
        </span>
        <span className="ml-1 rounded border border-hairline px-1.5 py-px text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">
          Demo clock
        </span>
      </div>

      <div className="flex items-center gap-2.5">
        {engine ? (
          <Badge tone={engine.engineMode === "fallback" ? "warning" : "ai"} dot>
            {/* Consistent with the AI analysis and cash-flow panels: the
                model being unreachable is a fact about the MODEL, and the
                phrase says so without implying the invoice is blocked. */}
            {engine.engineMode === "fallback"
              ? "Demo fallback — live AI unavailable"
              : `${engine.engineMode === "recorded" ? "Recorded" : "Workers AI"} · ${
                  engine.modelId?.split("/").pop() ?? "model"
                }`}
          </Badge>
        ) : null}

        <Badge tone={analyzing ? "ai" : "positive"} dot pulse={analyzing}>
          <HugeiconsIcon icon={Robot01Icon} size={12} strokeWidth={2} />
          {analyzing ? "Agent analyzing" : "Agent active"}
        </Badge>
      </div>
    </div>
  );
}

function BootSplash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Wordmark />
        <span className="size-4 animate-spin rounded-full border-2 border-ai/25 border-t-ai" />
      </div>
    </div>
  );
}
