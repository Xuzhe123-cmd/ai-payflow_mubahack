/**
 * The four verdicts, and the one they add up to.
 *
 * This component exists to stop a viewer conflating two different things. An
 * $8,000 invoice against a $97,000 treasury is perfectly affordable and still
 * cannot be paid autonomously — showing a single verdict would make that look
 * like a cash problem, which is the opposite of what happened.
 *
 * Purely presentational: every string and state comes from buildVerdicts().
 */

import { Badge, type BadgeTone } from "@/components/common/Badge";
import type { DecisionVerdicts, Verdict, VerdictState } from "@/lib/decision/present";
import { cn } from "@/lib/utils";

const STATE_TONE: Record<VerdictState, BadgeTone> = {
  PASS: "positive",
  WARN: "warning",
  FAIL: "negative",
};

function VerdictRow({ label, verdict }: { label: string; verdict: Verdict }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className="w-40 shrink-0 text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      <Badge tone={STATE_TONE[verdict.state]} dot>
        {verdict.headline}
      </Badge>
      <span className="min-w-0 flex-1 text-sm text-ink-soft">{verdict.detail}</span>
    </div>
  );
}

export function VerdictChips({ verdicts }: { verdicts: DecisionVerdicts }) {
  const { finalAction } = verdicts;

  return (
    <div>
      {/* The verdict leads, because it is what a viewer is looking for. The
          four checks beneath it are the working, not the answer. */}
      <div
        className={cn(
          "rounded-lg border p-4",
          finalAction.tone === "positive" && "border-pos/25 bg-pos-soft",
          finalAction.tone === "chain" && "border-chain-border bg-chain-soft",
          finalAction.tone === "warning" && "border-warn/30 bg-warn-soft",
          finalAction.tone === "negative" && "border-neg/25 bg-neg-soft",
        )}
      >
        <div className="text-xs uppercase tracking-wide text-ink-faint">Decision</div>
        <div
          className={cn(
            "mt-0.5 text-2xl font-semibold tracking-tight",
            finalAction.tone === "positive" && "text-pos",
            finalAction.tone === "chain" && "text-chain",
            finalAction.tone === "warning" && "text-warn",
            finalAction.tone === "negative" && "text-neg",
          )}
        >
          {finalAction.label}
        </div>
        <p className="mt-1.5 text-sm text-ink-soft">{finalAction.because}</p>

        {finalAction.keyInsight && (
          <p className="mt-2.5 border-t border-current/15 pt-2.5 text-[13.5px] font-medium text-ink">
            {finalAction.keyInsight}
          </p>
        )}
      </div>

      <div className="mt-3 divide-y divide-hairline border-t border-hairline">
        <VerdictRow label="Cash-flow" verdict={verdicts.cashFlow} />
        <VerdictRow label="Autonomous authority" verdict={verdicts.authority} />
        <VerdictRow label="Supplier verification" verdict={verdicts.supplier} />
        <VerdictRow label="Invoice status" verdict={verdicts.invoice} />
      </div>
    </div>
  );
}
