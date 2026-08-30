/**
 * The executive dashboard: the cash position and the agent's leash.
 *
 * Two rows, deliberately. The top is what the company HAS; the bottom is what
 * the agent may DO with it. Those are the two quantities a viewer has to keep
 * apart to understand any verdict on this screen.
 *
 * Presentational: every figure is read from the snapshot, already decoded.
 */

import { Badge } from "@/components/common/Badge";
import type { ChainSnapshot } from "@/lib/sui/chainTypes";
import { formatMoneyRounded } from "@/lib/util/money";
import { cn } from "@/lib/utils";

function Stat({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: "positive" | "warning" | "neutral";
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-ink-faint">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
          emphasis === "positive" && "text-pos",
          emphasis === "warning" && "text-warn",
          !emphasis && "text-ink",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

export function TreasuryOverview({ snapshot }: { snapshot: ChainSnapshot }) {
  const t = snapshot.treasury;
  const a = snapshot.agent;
  const reserveHealthy = t.balanceCents > t.minimumReserveCents;

  return (
    <section className="rounded-xl border border-hairline bg-surface p-5">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium text-ink">Treasury</h2>
        <Badge tone="chain" dot>
          live · {snapshot.network}
        </Badge>
        <span className="text-xs text-ink-faint">
          read {new Date(snapshot.readAt).toLocaleTimeString()}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        <Stat
          label="Balance"
          value={formatMoneyRounded(t.balanceCents)}
          emphasis={reserveHealthy ? "positive" : "warning"}
        />
        <Stat label="Minimum reserve" value={formatMoneyRounded(t.minimumReserveCents)} hint="enforced on chain" />
        <Stat label="Available" value={formatMoneyRounded(t.availableCents)} hint="above the reserve" />
        <Stat
          label="Settled"
          value={`${t.paymentCount}`}
          hint={`${formatMoneyRounded(t.totalPaidCents)} paid to date`}
        />
      </div>

      <div className="mt-5 border-t border-hairline pt-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-faint">Agent authority</span>
          {a ? (
            <Badge tone={a.enabled ? "ai" : "negative"} dot>
              {a.enabled ? a.agentId : "disabled"}
            </Badge>
          ) : (
            <Badge tone="negative" dot>
              no agent registered
            </Badge>
          )}
        </div>

        {a && (
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            <Stat label="Max single payment" value={formatMoneyRounded(a.maxSinglePaymentCents)} />
            <Stat label="Daily limit" value={formatMoneyRounded(a.dailyLimitCents)} />
            <Stat label="Spent today" value={formatMoneyRounded(a.spentTodayCents)} />
            <Stat
              label="Remaining today"
              value={formatMoneyRounded(a.remainingTodayCents)}
              hint="without a human"
            />
          </div>
        )}
      </div>
    </section>
  );
}
