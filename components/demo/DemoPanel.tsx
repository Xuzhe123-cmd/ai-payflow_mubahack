"use client";

/**
 * Presenter controls.
 *
 * This panel changes DATA and PACING only. It cannot switch the interface into
 * a different mode, because there is no per-scenario screen to switch to — all
 * eight scenarios render through the same components. If a control here could
 * change the layout, the demo would be staged rather than real.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  DashboardSquare01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/common/Badge";
import { Eyebrow } from "@/components/common/Badge";
import { describeRun } from "@/components/common/StatusBadge";
import { usePayflow, type DemoSpeed } from "@/components/providers/PayflowProvider";
import { formatMoneyRounded } from "@/lib/format";

const SPEEDS: { id: DemoSpeed; label: string; hint: string }[] = [
  { id: "instant", label: "Instant", hint: "No staged delays" },
  { id: "brisk", label: "Brisk", hint: "Recommended on stage" },
  { id: "cinematic", label: "Cinematic", hint: "Full step timing" },
];

export function DemoPanel() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { state, setSpeed, reset, analyzeAll, connectInbox } = usePayflow();

  // Whatever the first completed analysis reports is what the engine is doing.
  const engineMode =
    Object.values(state.runs).find((run) => run.analysis)?.analysis?.engineMode ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-hairline",
            "bg-surface px-3.5 py-2 text-[12.5px] font-medium text-ink-soft shadow-lg",
            "transition-colors hover:text-ink",
          )}
        >
          <HugeiconsIcon icon={DashboardSquare01Icon} size={15} strokeWidth={1.8} />
          Demo
          <kbd className="rounded border border-hairline px-1 text-[10px] text-ink-faint">
            ⌘D
          </kbd>
        </button>
      ) : null}

      <div
        className={cn(
          "fixed bottom-0 right-0 top-0 z-50 w-[352px] border-l border-hairline bg-surface shadow-2xl",
          "flex flex-col transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div>
            <Eyebrow>Presenter controls</Eyebrow>
            <h2 className="mt-1 text-[15px] font-semibold text-ink">Demo scenarios</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
            aria-label="Close demo panel"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="space-y-2">
            <Eyebrow>Pacing</Eyebrow>
            <div className="grid grid-cols-3 gap-1.5">
              {SPEEDS.map((speed) => (
                <button
                  key={speed.id}
                  type="button"
                  onClick={() => setSpeed(speed.id)}
                  title={speed.hint}
                  className={cn(
                    "rounded-lg border px-2 py-2 text-[12px] font-medium transition-colors",
                    state.speed === speed.id
                      ? "border-ai bg-ai-soft text-ai"
                      : "border-hairline text-ink-soft hover:bg-surface-sunken",
                  )}
                >
                  {speed.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              Pacing controls staged delays only. Model latency is real and is
              never simulated.
            </p>
          </section>

          <section className="space-y-2">
            <Eyebrow>Invoices in this demo</Eyebrow>
            {state.invoices.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-ink-faint">
                The finance inbox is not connected yet. Connect it from the
                dashboard to detect invoices.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {state.invoices.map((invoice) => {
                  const run = state.runs[invoice.id];
                  const status = describeRun(run);
                  return (
                    <li key={invoice.id}>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        onClick={() => setOpen(false)}
                        className="block rounded-lg border border-hairline px-3 py-2.5 transition-colors hover:bg-surface-sunken"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12.5px] font-medium text-ink">
                            {invoice.scenarioName}
                          </span>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[11.5px] text-ink-faint">
                          <span className="truncate">{invoice.supplierName}</span>
                          <span className="tabular shrink-0">
                            {formatMoneyRounded(invoice.amountCents, invoice.currency)}
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <Eyebrow>Actions</Eyebrow>
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full rounded-lg"
                onClick={() => void analyzeAll()}
              >
                <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} />
                Analyze pending invoices
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full rounded-lg"
                onClick={() => {
                  reset();
                  setOpen(false);
                  router.push("/dashboard");
                }}
              >
                Reset demo state
              </Button>
              {state.inboxStatus === "DISCONNECTED" ? (
                <Button
                  size="sm"
                  className="w-full rounded-lg"
                  onClick={() => {
                    setOpen(false);
                    void connectInbox();
                  }}
                >
                  Connect finance inbox
                </Button>
              ) : null}
            </div>
          </section>

          <section className="space-y-2 rounded-lg bg-surface-sunken p-3.5">
            <Eyebrow>Integration status</Eyebrow>
            <ul className="space-y-1.5 text-[11.5px] text-ink-faint">
              <IntegrationRow
                label="AI decision"
                value={
                  engineMode === "recorded"
                    ? "Workers AI (recorded)"
                    : engineMode === "fallback"
                      ? "Safety fallback"
                      : "Cloudflare Workers AI"
                }
                live={engineMode === "live"}
              />
              <IntegrationRow label="Deterministic facts" value="In-process" live />
              <IntegrationRow
                label="Engine mode"
                value={engineMode ?? "not yet run"}
                live={engineMode === "live"}
                badge={engineMode === "recorded" ? "replay" : "—"}
              />
              <IntegrationRow label="Policy enforcement" value="Move mirror" />
              <IntegrationRow label="Payment execution" value="PTB · sponsored" />
              <IntegrationRow label="Authentication" value="zkLogin" />
              <IntegrationRow label="Documents" value="Walrus" />
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}

function IntegrationRow({
  label,
  value,
  live = false,
  badge = "mock",
}: {
  label: string;
  value: string;
  live?: boolean;
  badge?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-ink-soft">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="truncate">{value}</span>
        <span
          className={cn(
            "rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide",
            live ? "bg-pos-soft text-pos" : "bg-surface text-ink-faint",
          )}
        >
          {live ? "live" : badge}
        </span>
      </span>
    </li>
  );
}
