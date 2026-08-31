"use client";

/**
 * The signed-in human's authority over ONE invoice.
 *
 * Shown on the invoice page, and deliberately holding no logic of its own: it
 * calls the same `useCurrentAuthorization` hook and the same `checkPayment`
 * rule the access page uses, so the two screens cannot report different
 * authority for the same person. Duplicating the check here is how they would
 * eventually disagree.
 *
 * WHAT IT IS NOT. It is not a gate. Move refuses an approval whose limits do
 * not hold, whatever this renders, and the text says so — a reader who thinks
 * the button is the boundary has misunderstood the architecture, and this
 * component's job is to prevent that misunderstanding rather than to look
 * reassuring.
 */

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge } from "@/components/common/Badge";
import { useCurrentAuthorization } from "@/components/hooks/useAuthorization";
import { checkPayment, describeAuthority } from "@/lib/identity/paymentAuthority";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { cn } from "@/lib/utils";
import type { Cents } from "@/lib/types";

const money = (cents: Cents) => `$${(cents / 100).toLocaleString("en-US")}`;

export function ApprovalAuthority({
  invoiceNumber,
  amountCents,
  supplierName,
  recipient,
  treasuryId,
}: {
  invoiceNumber: string;
  amountCents: Cents;
  supplierName: string;
  recipient: string;
  treasuryId: string;
}) {
  const { state: payflow } = usePayflow();
  const { paymentAuthority, readAtMs } = useCurrentAuthorization();

  // Nobody signed in: the invoice page says nothing about authority rather
  // than implying it was withheld.
  if (!payflow.session || !paymentAuthority || readAtMs === null) return null;

  const described = describeAuthority(paymentAuthority);
  const check = checkPayment({
    state: paymentAuthority,
    amountCents,
    recipient,
    treasuryId,
    nowMs: readAtMs,
  });

  const active = paymentAuthority.kind === "ACTIVE";
  const auth = "authorization" in paymentAuthority ? paymentAuthority.authorization : null;

  return (
    <Panel tone={check.wouldAuthorize ? "positive" : "default"}>
      <PanelHeader
        eyebrow="Human authorization"
        title="Your authority over this payment"
        subtitle="Read from the treasury's own approver record — the same state the access page shows."
        actions={
          <Badge
            tone={
              described.tone === "positive"
                ? "positive"
                : described.tone === "negative"
                  ? "negative"
                  : "warning"
            }
            dot
          >
            {active ? "AUTHORIZATION ACTIVE" : described.headline}
          </Badge>
        }
      />

      <PanelBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Row label="Invoice" value={invoiceNumber} mono />
          <Row label="Amount" value={money(amountCents)} />
          <Row label="Supplier" value={supplierName} />
          <Row label="Approver" value={payflow.session.operatorEmail ?? "—"} />
        </div>

        {auth ? (
          <div className="grid gap-3 border-t border-hairline pt-3.5 sm:grid-cols-2">
            <Row label="Your single-payment limit" value={money(auth.maxSingleCents)} />
            <Row
              label="Remaining today"
              value={money(Math.max(0, auth.dailyLimitCents - auth.authorizedTodayCents))}
            />
          </div>
        ) : null}

        <div
          className={cn(
            "rounded-xl border px-4 py-3",
            check.wouldAuthorize ? "border-pos/35 bg-pos-soft" : "border-neg/30 bg-neg-soft",
          )}
        >
          <div className="flex items-baseline gap-2">
            <span className={cn("text-[13px]", check.wouldAuthorize ? "text-pos" : "text-neg")}>
              {check.wouldAuthorize ? "✓" : "✕"}
            </span>
            <span
              className={cn(
                "text-[13.5px] font-semibold",
                check.wouldAuthorize ? "text-pos" : "text-neg",
              )}
            >
              {check.headline}
            </span>
          </div>

          {check.refusal === "AMOUNT_EXCEEDS_LIMIT" && check.limitCents !== null ? (
            <dl className="mt-2 space-y-0.5 pl-5 text-[12px]">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">Requested amount</dt>
                <dd className="tabular font-medium text-ink">
                  {money(check.requestedCents ?? 0)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-faint">Authorization limit</dt>
                <dd className="tabular font-medium text-ink">{money(check.limitCents)}</dd>
              </div>
            </dl>
          ) : null}

          <p className="mt-1.5 pl-5 text-[11.5px] leading-relaxed text-ink-soft">
            {check.detail}
          </p>
        </div>

        {/* No control is rendered without a live authorization. A disabled
            button would suggest the interface is what stops the payment. */}
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Sui Move re-checks the limit, the expiry, the recipient scope and the revocation flag
          when an approval is submitted. This panel previews that decision; it does not make it.
        </p>
      </PanelBody>
    </Panel>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </div>
      <div className={cn("mt-1 truncate text-[13px] text-ink", mono && "font-mono text-[11.5px]")}>
        {value}
      </div>
    </div>
  );
}
