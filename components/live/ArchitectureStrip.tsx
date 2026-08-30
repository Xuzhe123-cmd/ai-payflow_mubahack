/**
 * The three layers, and which one is actually in charge.
 *
 * A judge watching a demo sees one recommendation and can reasonably assume the
 * AI produced it end to end. This states the arrangement outright: the model
 * suggests, deterministic rules bound what it may suggest, and Sui re-checks
 * everything again on chain regardless of what either concluded.
 *
 * Static — it describes the architecture, not the current state of a request.
 */

import { Badge } from "@/components/common/Badge";

const LAYERS = [
  {
    tone: "ai" as const,
    title: "AI Decision Engine",
    verb: "recommends",
    detail: "Reads the facts and chooses an action. Writes the explanation. Moves nothing.",
  },
  {
    tone: "warning" as const,
    title: "Deterministic Guard",
    verb: "constrains",
    detail:
      "Computes what the rules permit from live chain state, then clamps the model to it. It can only ever be more cautious.",
  },
  {
    tone: "chain" as const,
    title: "Sui On-Chain Enforcement",
    verb: "decides",
    detail:
      "Re-derives every limit at execution and aborts if one fails. The final authority, and the only thing that can move funds.",
  },
];

export function ArchitectureStrip({ packageId }: { packageId: string }) {
  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-ink">AI recommends · Sui enforces</h2>
        <span className="font-mono text-[11px] text-ink-faint">
          package {packageId.slice(0, 10)}…{packageId.slice(-4)}
        </span>
      </header>

      <ol className="grid gap-3 md:grid-cols-3">
        {LAYERS.map((layer, index) => (
          <li key={layer.title} className="relative rounded-lg border border-hairline bg-surface-sunken p-3.5">
            <div className="flex items-center gap-2">
              <Badge tone={layer.tone} dot>
                {layer.verb}
              </Badge>
              {index < LAYERS.length - 1 && (
                <span aria-hidden className="ml-auto text-ink-faint md:hidden">
                  ↓
                </span>
              )}
            </div>
            <h3 className="mt-2 text-[13.5px] font-semibold text-ink">{layer.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">{layer.detail}</p>

            {/* The arrow between layers, on wide screens only. */}
            {index < LAYERS.length - 1 && (
              <span
                aria-hidden
                className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-ink-faint md:block"
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>

      <p className="mt-3 text-xs text-ink-faint">
        A recommendation is not permission. Every verdict below is computed from live testnet state,
        and the chain would re-check all ten policy rules again before any payment settled.
      </p>
    </section>
  );
}
