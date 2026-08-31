"use client";

/**
 * The purchase order, on the invoice that cites it.
 *
 * WHY THIS EXISTS: the page used to say "PO mismatch" and show nothing else.
 * The order it was compared against — its number, its amount, whose it was —
 * appeared nowhere, so the claim could not be checked. That is an assertion,
 * not evidence, and it is the one thing this product cannot afford to ask for
 * on trust.
 *
 * The layout is a comparison rather than a verdict, deliberately:
 *
 *   PURCHASE ORDER  →  STRUCTURED COMPARISON  →  AI RECOMMENDATION
 *                          →  DETERMINISTIC GUARD  →  SUI ENFORCEMENT
 *
 * A reader follows the same steps the system did and can disagree at any one
 * of them. Every figure is read from the deterministic analysis — the same
 * `ValidationFacts` the model was given and the guard ruled on — so nothing
 * here is a second opinion about the invoice.
 *
 * CONDITION-DRIVEN, like the shipment panel. It renders for an invoice that
 * cites a purchase order and for no other. There is no invoice number in this
 * file and there must never be one.
 *
 * ENFORCEMENT LIVES ELSEWHERE. This panel states what the policy does with a
 * mismatch; it does not apply it, and a PO overage is not a blocking condition.
 */

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import {
  describePoPolicy,
  evaluatePoEvidence,
  hasPoEvidence,
  type PoComparisonRow,
  type PoEvidenceResult,
} from "@/lib/deterministic/poEvidence";
import { formatFullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeterministicAnalysis } from "@/lib/types";

export function PurchaseOrderEvidence({ facts }: { facts: DeterministicAnalysis }) {
  const invoice = facts.invoiceFacts;

  // No purchase order cited — an ordinary invoice, and no section. Showing one
  // would display a comparison that never ran.
  if (!hasPoEvidence(invoice.poNumber)) return null;

  const evidence = evaluatePoEvidence({
    poNumber: invoice.poNumber,
    invoiceSupplierName: invoice.supplierName,
    invoiceAmountCents: invoice.amountCents,
    invoiceCurrency: invoice.currency,
    lineItems: invoice.lineItems,
    validation: facts.validationFacts,
  });

  const unavailable = evidence.verdict === "PO_UNAVAILABLE";
  const tone = evidence.matched ? "positive" : unavailable ? "default" : "negative";

  return (
    <Panel tone={tone === "negative" ? "negative" : tone === "positive" ? "positive" : "default"}>
      <PanelHeader
        eyebrow="Purchase order evidence"
        title="The order this invoice bills against"
        subtitle="The record the deterministic comparison ran against, shown so the conclusion can be checked rather than trusted."
        actions={
          <Badge tone={evidence.matched ? "positive" : unavailable ? "warning" : "negative"} dot>
            {evidence.badge}
          </Badge>
        }
      />

      <PanelBody className="px-5 py-5">
        {/* THE VERDICT, once. */}
        <div
          className={cn(
            "flex items-baseline gap-2.5 rounded-xl border px-4 py-3",
            evidence.matched
              ? "border-pos/35 bg-pos-soft"
              : unavailable
                ? "border-hairline bg-surface-sunken"
                : "border-neg/35 bg-neg-soft",
          )}
        >
          <span
            className={cn(
              "text-[15px] leading-none",
              evidence.matched ? "text-pos" : unavailable ? "text-ink-faint" : "text-neg",
            )}
          >
            {evidence.matched ? "✓" : unavailable ? "?" : "✕"}
          </span>
          <span
            className={cn(
              "text-[17px] font-semibold tracking-[-0.01em]",
              evidence.matched ? "text-pos" : unavailable ? "text-ink" : "text-neg",
            )}
          >
            {evidence.headline}
          </span>
        </div>

        {evidence.reason ? (
          <p
            className={cn(
              "mt-2.5 text-[12.5px] leading-relaxed",
              unavailable ? "text-ink-soft" : "text-neg",
            )}
          >
            {evidence.reason}
          </p>
        ) : null}

        {unavailable ? null : (
          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,290px)]">
            <div>
              <ComparisonTable rows={evidence.rows} />

              {/* THE DIFFERENCE, as its own figure. The number a reader wants
                  is the one they would otherwise have to compute themselves. */}
              {evidence.deltaCents !== null && evidence.deltaCents !== 0 ? (
                <div className="mt-3 flex items-baseline justify-between rounded-xl border border-neg/30 bg-neg-soft px-4 py-3">
                  <span className="text-[12px] font-medium uppercase tracking-[0.06em] text-neg">
                    Difference
                  </span>
                  <span className="tabular text-[19px] font-semibold tracking-[-0.015em] text-neg">
                    {evidence.deltaLabel}
                  </span>
                </div>
              ) : null}

              {evidence.lineItems.length > 0 ? (
                <LineItems evidence={evidence} />
              ) : null}
            </div>

            <div className="space-y-4">
              <EvidenceChain evidence={evidence} />

              <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  What the policy does with this
                </div>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                  {describePoPolicy(evidence.verdict)}
                </p>
              </div>

              {evidence.orderDescription || evidence.orderIssuedAt ? (
                <div className="rounded-xl border border-hairline bg-surface p-4">
                  <Eyebrow>Ledger record</Eyebrow>
                  {evidence.orderDescription ? (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-ink">
                      {evidence.orderDescription}
                    </p>
                  ) : null}
                  {evidence.orderIssuedAt ? (
                    <p className="mt-1 text-[11.5px] text-ink-faint">
                      Issued {formatFullDate(evidence.orderIssuedAt)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

/** The two documents, field by field, with the disagreement marked. */
function ComparisonTable({ rows }: { rows: PoComparisonRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
      <table className="w-full min-w-[420px] border-collapse">
        <thead>
          <tr className="border-b border-hairline">
            <th className="w-[28%] px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
              Field
            </th>
            <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
              Invoice
            </th>
            <th className="px-4 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
              Purchase order
            </th>
            <th className="w-[8%] px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-hairline last:border-0">
              <td className="px-4 py-2.5 text-[12px] text-ink-faint">{row.label}</td>
              <td
                className={cn(
                  "px-4 py-2.5 text-[12.5px] font-medium text-ink",
                  row.mono && "font-mono text-[11.5px]",
                )}
              >
                {row.invoice}
              </td>
              <td
                className={cn(
                  "px-4 py-2.5 text-[12.5px] font-medium",
                  row.mono && "font-mono text-[11.5px]",
                  row.agrees === false ? "text-neg" : "text-ink",
                )}
              >
                {row.purchaseOrder}
              </td>
              <td className="px-4 py-2.5 text-right text-[12px]">
                {row.agrees === null ? (
                  <span className="text-ink-faint">·</span>
                ) : row.agrees ? (
                  <span className="text-pos">✓</span>
                ) : (
                  <span className="text-neg">✕</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The billed lines, with the one the order names marked.
 *
 * A string comparison and labelled as one. It is what makes an overage legible
 * — the order covers this line, the invoice adds that one — without pretending
 * the policy reads it. The guard compares amounts, and the note says so.
 */
function LineItems({ evidence }: { evidence: PoEvidenceResult }) {
  return (
    <div className="mt-3 rounded-xl border border-hairline bg-surface">
      <div className="border-b border-hairline px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
        Invoice line items
      </div>
      <ul>
        {evidence.lineItems.map((item) => (
          <li
            key={`${item.description}-${item.amountLabel}`}
            className="flex items-baseline justify-between gap-4 border-b border-hairline px-4 py-2.5 last:border-0"
          >
            <span className="min-w-0 text-[12.5px] text-ink">
              {item.description}
              {evidence.orderDescription ? (
                <span
                  className={cn(
                    "ml-2 text-[11px]",
                    item.matchesOrderDescription ? "text-pos" : "text-neg",
                  )}
                >
                  {item.matchesOrderDescription
                    ? "· named on the order"
                    : "· not named on the order"}
                </span>
              ) : null}
            </span>
            <span className="tabular shrink-0 text-[12.5px] font-medium text-ink">
              {item.amountLabel}
            </span>
          </li>
        ))}
      </ul>
      {evidence.orderDescription ? (
        <p className="border-t border-hairline px-4 py-2.5 text-[11px] leading-relaxed text-ink-faint">
          Line descriptions are compared against the order&apos;s recorded description as text.
          The deterministic check compares amounts — this only shows where the difference arose.
        </p>
      ) : null}
    </div>
  );
}

/** Evidence → AI → guard → Sui, with this panel's place in it marked. */
function EvidenceChain({ evidence }: { evidence: PoEvidenceResult }) {
  const steps: { label: string; value: string; tone: "default" | "positive" | "negative" }[] = [
    {
      label: "Purchase order",
      value: evidence.rows.find((row) => row.label === "PO number")?.purchaseOrder ?? "—",
      tone: "default",
    },
    {
      label: "Structured comparison",
      value: evidence.matched ? "MATCHES" : "MISMATCH",
      tone: evidence.matched ? "positive" : "negative",
    },
    { label: "AI recommendation", value: "reasons over this", tone: "default" },
    { label: "Deterministic guard", value: "constrains it", tone: "default" },
    { label: "Sui", value: "enforces the policy", tone: "default" },
  ];

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <Eyebrow>Evidence chain</Eyebrow>
      <ol className="mt-3 space-y-1">
        {steps.map((step, index) => (
          <li key={step.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-ink-faint">{step.label}</span>
              <span
                className={cn(
                  "truncate text-[12.5px] font-semibold",
                  step.tone === "positive" && "text-pos",
                  step.tone === "negative" && "text-neg",
                  step.tone === "default" && "text-ink",
                )}
              >
                {step.value}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <div className="py-0.5 text-[11px] leading-none text-ink-faint">↓</div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
