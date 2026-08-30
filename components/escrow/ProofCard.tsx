"use client";

/**
 * The shipment proof, as evidence a judge can read.
 *
 * Two things are load-bearing here and neither is decoration. The disclaimer is
 * rendered inside the card rather than beside it, so the claim travels with the
 * evidence wherever it is screenshotted. And the status row is the only place
 * this component makes a judgement — everything else is transcription.
 */

import { Eyebrow } from "@/components/common/Badge";
import { PROOF_DISCLAIMER } from "@/lib/escrow/proofDocument";
import { proofCardRows } from "@/lib/escrow/present";
import type { EscrowDemoState } from "@/lib/escrow/demoFlow";
import { cn } from "@/lib/utils";

export function ProofCard({ state }: { state: EscrowDemoState }) {
  const rows = proofCardRows(state);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-hairline bg-surface-sunken p-5">
        <Eyebrow>Shipment proof</Eyebrow>
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-faint">
          No delivery document has been submitted yet. The escrow stays locked until one is,
          and until the oracle attests it on chain.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-hairline bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Shipment proof</Eyebrow>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
          {state.proof?.filename}
        </span>
      </div>

      <dl className="mt-3.5 divide-y divide-hairline">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 py-2">
            <dt className="shrink-0 text-[12px] text-ink-faint">{row.label}</dt>
            <dd
              className={cn(
                "truncate text-[12.5px] font-medium",
                row.mono && "font-mono text-[11.5px]",
                row.tone === "positive" && "text-pos",
                row.tone === "warning" && "text-warn",
                row.tone === "default" && "text-ink",
              )}
            >
              {row.value}
              {row.tone === "positive" ? " ✓" : null}
            </dd>
          </div>
        ))}
      </dl>

      {/* Inside the card deliberately: the caveat must survive a screenshot. */}
      <p className="mt-3.5 rounded-lg border border-hairline bg-surface-sunken px-3 py-2 text-[11.5px] leading-relaxed text-ink-faint">
        {PROOF_DISCLAIMER}. The document is demonstration evidence and the attesting party is a
        controlled hackathon oracle, not a logistics provider.
      </p>
    </div>
  );
}
