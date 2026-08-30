/**
 * The payment queue, one row per invoice.
 *
 * The row shows the verdict AND the reason it is not something else, because
 * "HUMAN APPROVAL" on its own reads as a cash problem when it is usually an
 * authority one. Two small chips — cash-flow and authority — carry that
 * distinction into the list rather than hiding it in the detail panel.
 *
 * Presentational: verdicts arrive pre-computed.
 */

"use client";

import { Badge, type BadgeTone } from "@/components/common/Badge";
import { ACTION_LABEL, ACTION_TONE, buildVerdicts } from "@/lib/decision/present";
import type { PaymentDecision } from "@/lib/decision/types";
import { formatMoneyRounded } from "@/lib/util/money";
import { cn } from "@/lib/utils";

const STATE_TONE = { PASS: "positive", WARN: "warning", FAIL: "negative" } as const;

export function InvoiceQueue({
  decisions,
  selectedId,
  onSelect,
}: {
  decisions: PaymentDecision[];
  selectedId: string | null;
  onSelect: (invoiceObjectId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      <div className="border-b border-hairline px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Payment queue</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          {decisions.length} invoice(s) read from the on-chain registry
        </p>
      </div>

      <ul className="divide-y divide-hairline">
        {decisions.map((decision) => {
          const verdicts = buildVerdicts(decision);
          const selected = decision.facts.invoiceObjectId === selectedId;

          return (
            <li key={decision.facts.invoiceObjectId}>
              <button
                type="button"
                onClick={() => onSelect(decision.facts.invoiceObjectId)}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "w-full px-4 py-3 text-left transition-colors",
                  selected ? "bg-surface-sunken" : "hover:bg-surface-sunken/60",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-ink">
                    {decision.facts.invoiceNumber}
                  </span>
                  <span className="shrink-0 tabular-nums text-sm text-ink">
                    {formatMoneyRounded(decision.facts.amountCents)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-ink-faint">
                  <span className="truncate">{decision.facts.supplier.supplierId}</span>
                  <span className="shrink-0">due {decision.facts.dueDate}</span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone={ACTION_TONE[decision.decision] as BadgeTone} dot>
                    {ACTION_LABEL[decision.decision]}
                  </Badge>
                  <Badge tone={STATE_TONE[verdicts.cashFlow.state]}>
                    cash {verdicts.cashFlow.headline}
                  </Badge>
                  <Badge tone={STATE_TONE[verdicts.authority.state]}>
                    authority {verdicts.authority.headline}
                  </Badge>
                  {verdicts.supplier.state === "FAIL" && (
                    <Badge tone="negative">supplier {verdicts.supplier.headline}</Badge>
                  )}
                  {verdicts.invoice.state === "FAIL" && (
                    <Badge tone="negative">invoice {verdicts.invoice.headline}</Badge>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
