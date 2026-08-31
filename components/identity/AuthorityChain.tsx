"use client";

/**
 * The chain of facts, drawn as a chain.
 *
 *   Google / zkLogin  →  who am I
 *   Chain-Doi         →  which company recognises me
 *   Role              →  what it calls me
 *   Authorization     →  what the TREASURY lets me authorize
 *   Sui Move          →  what actually decides
 *
 * Drawn as five separate links because they are five separate facts, and the
 * misunderstanding this whole phase exists to prevent is reading any of the
 * first four as the fifth. A green tick on "Treasury Manager" says nothing
 * about whether a payment can be authorized; only the fourth link does, and
 * only the fifth enforces it.
 *
 * Each link reports its own status independently, so a reader can see exactly
 * where the chain stops.
 */

import { cn } from "@/lib/utils";

export type LinkStatus = "ok" | "pending" | "warning" | "failed" | "unknown";

export interface AuthorityLink {
  label: string;
  /** What this link establishes — and, by implication, what it does not. */
  establishes: string;
  value: string;
  status: LinkStatus;
}

const MARK: Record<LinkStatus, string> = {
  ok: "✓",
  pending: "·",
  warning: "⚠",
  failed: "✕",
  unknown: "?",
};

const TONE: Record<LinkStatus, string> = {
  ok: "text-pos",
  pending: "text-ink-faint",
  warning: "text-warn",
  failed: "text-neg",
  unknown: "text-ink-faint",
};

const RING: Record<LinkStatus, string> = {
  ok: "border-pos/35 bg-pos-soft",
  pending: "border-hairline bg-surface-sunken",
  warning: "border-warn/35 bg-warn-soft",
  failed: "border-neg/35 bg-neg-soft",
  unknown: "border-hairline bg-surface-sunken",
};

export function AuthorityChain({ links }: { links: AuthorityLink[] }) {
  return (
    <ol className="space-y-0">
      {links.map((link, index) => (
        <li key={link.label}>
          <div className={cn("rounded-xl border px-4 py-3", RING[link.status])}>
            <div className="flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={cn("shrink-0 text-[13px]", TONE[link.status])}>
                  {MARK[link.status]}
                </span>
                <span className="text-[13px] font-medium text-ink">{link.label}</span>
              </div>
              <span
                className={cn(
                  "shrink-0 truncate text-[12.5px] font-medium",
                  TONE[link.status],
                )}
              >
                {link.value}
              </span>
            </div>
            {/* What this link proves, said next to it — so no reader has to
                infer that identity implies authority. */}
            <p className="mt-1 pl-5 text-[11px] leading-relaxed text-ink-faint">
              {link.establishes}
            </p>
          </div>

          {index < links.length - 1 ? (
            <div className="py-1 pl-6 text-[12px] leading-none text-ink-faint">↓</div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
