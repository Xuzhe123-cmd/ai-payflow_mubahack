/**
 * What the oracle supplies, and which of it the chain could check.
 *
 * The second column is the one that matters. An oracle can assert anything;
 * what makes this architecture trustworthy is that the claims which decide a
 * payment — supplier approval, remit address, whether an invoice is already
 * settled — are re-derived on chain and refused when they disagree. The rows
 * the chain cannot confirm (a forecast, an expected receivable) are marked as
 * such rather than being dressed up as verified.
 *
 * Presentational: every row comes from lib/oracle/feed.ts.
 */

import { Badge, type BadgeTone } from "@/components/common/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import type { OracleFeed, OracleSignalState } from "@/lib/oracle/feed";

const STATE_TONE: Record<OracleSignalState, BadgeTone> = {
  VERIFIED: "positive",
  LIVE: "chain",
  MISMATCH: "negative",
  // Already paid. A settled invoice is a good outcome, not a data fault, and it
  // must never be coloured like one.
  SETTLED: "positive",
  UNAVAILABLE: "warning",
  COUNT: "neutral",
};

export function OracleCard({
  feed,
  title = "Oracle data",
  subtitle,
}: {
  feed: OracleFeed;
  title?: string;
  subtitle?: string;
}) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="Real-world facts"
        title={title}
        subtitle={
          subtitle ??
          "Information the chain cannot know on its own — invoices, suppliers, and expected cash movements."
        }
        actions={
          // Not "Verified on chain": this panel is about invoice and supplier
          // facts, and beside a shipment-oracle section that word would be read
          // as a delivery having been confirmed. Says what it actually did.
          //
          // "Discrepancy found" is reserved for a signal the chain re-derived
          // and DISAGREED with. An invoice that is already settled is not one:
          // it used to raise this badge, telling a reader the oracle data was
          // wrong about an invoice that had in fact been paid correctly.
          <Badge tone={feed.allVerified ? "positive" : "negative"} dot>
            {feed.allVerified ? "Cross-checked on chain" : "Discrepancy found"}
          </Badge>
        }
      />

      <PanelBody className="py-2">
        <ul className="divide-y divide-hairline">
          {feed.signals.map((signal) => (
            <li key={signal.label} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13.5px] font-medium text-ink">{signal.label}</span>
                <Badge tone={STATE_TONE[signal.state]} dot={signal.state !== "COUNT"}>
                  {signal.value}
                </Badge>
              </div>
              <p className="mt-0.5 pr-2 text-[12px] leading-snug text-ink-faint">
                {signal.detail}
              </p>
              {/* Said plainly, per row, so no reader has to infer it. */}
              <p className="mt-1 text-[11px] uppercase tracking-[0.06em] text-ink-faint">
                {signal.state === "SETTLED"
                  ? "Chain settlement state — not an oracle discrepancy"
                  : signal.chainVerified
                    ? "Re-derived on chain before settlement"
                    : "Advisory — the chain does not verify this"}
              </p>
            </li>
          ))}
        </ul>
      </PanelBody>

      <footer className="border-t border-hairline bg-surface-sunken px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">
          Source
        </div>
        <div className="mt-0.5 text-[13px] text-ink">{feed.sourceLabel}</div>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{feed.sourceDetail}</p>
      </footer>
    </Panel>
  );
}
