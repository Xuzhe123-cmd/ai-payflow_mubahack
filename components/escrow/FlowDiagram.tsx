"use client";

/**
 * The architecture, and the division of authority.
 *
 * Two components that answer different questions. The flow shows WHAT happens
 * in order; the responsibility grid shows WHO is allowed to decide what — which
 * is the part a judge is actually assessing, and the part that a sequence
 * diagram alone hides.
 *
 * Both read from lib/escrow/present.ts rather than restating the architecture,
 * so the page and the tests cannot describe the system differently.
 */

import { Eyebrow } from "@/components/common/Badge";
import { AI_CANNOT, FLOW_STEPS, RESPONSIBILITIES } from "@/lib/escrow/present";
import type { EscrowDemoStage } from "@/lib/escrow/demoFlow";
import { cn } from "@/lib/utils";

/** Which flow step a stage corresponds to, for highlighting. */
const STAGE_STEP: Record<EscrowDemoStage, number> = {
  READY: 2,
  ESCROWED: 4,
  PROOF_SUBMITTED: 5,
  ATTESTED: 7,
  RELEASED: 8,
  HELD: 8,
};

export function FlowDiagram({ stage }: { stage?: EscrowDemoStage }) {
  const active = stage ? STAGE_STEP[stage] : -1;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <Eyebrow>Conditional settlement flow</Eyebrow>
      <ol className="mt-3.5 space-y-0">
        {FLOW_STEPS.map((step, index) => {
          const reached = index <= active;
          const current = index === active;
          return (
            <li key={step}>
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                    current
                      ? "border-chain bg-chain text-white"
                      : reached
                        ? "border-chain/40 bg-chain-soft text-chain"
                        : "border-hairline bg-surface-sunken text-ink-faint",
                  )}
                >
                  {index + 1}
                </span>
                <span
                  className={cn(
                    "text-[13px]",
                    current
                      ? "font-semibold text-ink"
                      : reached
                        ? "text-ink"
                        : "text-ink-faint",
                  )}
                >
                  {step}
                </span>
              </div>
              {index < FLOW_STEPS.length - 1 ? (
                <div
                  className={cn(
                    "ml-[9px] h-3 w-px",
                    index < active ? "bg-chain/40" : "bg-hairline",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  ai: "border-ai-border bg-ai-soft text-ai",
  chain: "border-chain-border bg-chain-soft text-chain",
  warning: "border-warn/35 bg-warn-soft text-warn",
  neutral: "border-hairline bg-surface-sunken text-ink",
};

export function ResponsibilityGrid() {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <Eyebrow>Who decides what</Eyebrow>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
        Four layers, four different questions. Only the last one moves money, and it answers to
        the chain rather than to anything above it.
      </p>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {RESPONSIBILITIES.map((row) => (
          <div
            key={row.actor}
            className={cn("rounded-lg border p-3.5", TONE_CLASS[row.tone] ?? TONE_CLASS.neutral)}
          >
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em]">
              {row.actor}
            </div>
            <div className="mt-1.5 text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
              {row.question}
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{row.answer}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-neg/25 bg-neg-soft p-3.5">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neg">
          The AI cannot
        </div>
        <ul className="mt-2 space-y-1.5">
          {AI_CANNOT.map((line) => (
            <li key={line} className="flex gap-2 text-[12px] leading-relaxed text-ink-soft">
              <span className="mt-[1px] shrink-0 font-semibold text-neg">✗</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          Each line corresponds to something absent from the Move source rather than to a promise
          — <span className="font-mono">release</span> has no destination parameter, and the agent
          holds no <span className="font-mono">OracleCap</span>.
        </p>
      </div>
    </div>
  );
}
