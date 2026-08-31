"use client";

import { Panel, PanelBody, PanelHeader, Field } from "@/components/common/Panel";
import { CheckList, CheckRow } from "@/components/common/CheckRow";
import { Badge } from "@/components/common/Badge";
import { RiskBadge } from "@/components/invoices/InvoiceTable";
import {
  formatFullDate,
  formatMoney,
  formatMoneyRounded,
  formatPercent,
  shortWallet,
} from "@/lib/format";
import { describeDuplicateCheck } from "@/lib/payments/invoiceStatus";
import type { DeterministicAnalysis } from "@/lib/types";

/** Section A — what the extractor read off the document. */
export function InvoiceDetails({ facts }: { facts: DeterministicAnalysis }) {
  const invoice = facts.invoiceFacts;

  return (
    <Panel>
      <PanelHeader
        eyebrow="Invoice information"
        title="Extracted from the source document"
        subtitle="Parsed by deterministic code, not by the model. The AI never reads the raw document."
      />
      <PanelBody>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Supplier" value={invoice.supplierName} />
          <Field label="Invoice number" value={invoice.invoiceNumber} mono />
          <Field label="Purchase order" value={invoice.poNumber ?? "Not referenced"} mono />
          <Field
            label="Amount"
            value={
              <span className="tabular text-[15px] font-semibold">
                {formatMoney(invoice.amountCents, invoice.currency)}
              </span>
            }
          />
          <Field label="Due date" value={formatFullDate(invoice.dueDate)} />
          <Field label="Payment terms" value={invoice.paymentTerms ?? "—"} />
          <Field
            label="Recipient wallet"
            value={shortWallet(invoice.recipientWallet, 14, 8)}
            mono
            className="sm:col-span-2"
          />
          <Field
            label="Early-payment discount"
            value={
              invoice.discount ? (
                <span className="text-pos">
                  {invoice.discount.percent}% ·{" "}
                  {formatMoneyRounded(invoice.discount.amountCents, invoice.currency)} if paid by{" "}
                  {formatFullDate(invoice.discount.deadline)}
                </span>
              ) : (
                "None"
              )
            }
          />
        </div>

        {invoice.unresolvedFields.length > 0 ? (
          <div className="mt-5 rounded-lg border border-warn/30 bg-warn-soft px-3.5 py-2.5">
            <div className="text-[12.5px] font-medium text-warn">
              {invoice.unresolvedFields.length} field
              {invoice.unresolvedFields.length === 1 ? "" : "s"} could not be read
            </div>
            <div className="mt-0.5 text-[12px] text-warn/85">
              {invoice.unresolvedFields.join(", ")} — the model is told these are
              missing rather than being given a guess.
            </div>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** Section B — is this supplier who they claim to be? */
export function SupplierVerification({
  facts,
  riskLevel,
}: {
  facts: DeterministicAnalysis;
  riskLevel?: string;
}) {
  const supplier = facts.supplierFacts;

  return (
    <Panel>
      <PanelHeader
        eyebrow="Supplier verification"
        title="Registry and wallet"
        actions={
          riskLevel ? (
            <div className="text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
                Risk contribution
              </div>
              <div className="mt-1">
                <RiskBadge level={riskLevel as never} />
              </div>
            </div>
          ) : null
        }
      />
      <PanelBody className="py-2">
        <CheckList>
          <CheckRow
            passed={supplier.supplierFound}
            label="Supplier registered"
            detail={
              supplier.supplierFound
                ? `Matched to ${supplier.supplierId} in the approved registry.`
                : "No entry in the approved supplier registry."
            }
          />
          <CheckRow
            passed={supplier.registryStatus === "APPROVED"}
            label="Supplier approved"
            detail={`Registry status: ${supplier.registryStatus}.`}
          />
          <CheckRow
            passed={supplier.walletMatch}
            label="Wallet matches registry"
            detail={
              supplier.registeredWallet
                ? supplier.walletMatch
                  ? `Remit address matches ${shortWallet(supplier.registeredWallet, 12, 6)}.`
                  : `Invoice asks for ${shortWallet(supplier.invoiceRecipientWallet, 12, 6)}, registry holds ${shortWallet(supplier.registeredWallet, 12, 6)}.`
                : "No registered wallet on file to compare against."
            }
          />
          <CheckRow
            passed={(supplier.history?.invoiceCount ?? 0) > 0}
            label="Historical relationship"
            detail={
              supplier.history
                ? `${supplier.history.invoiceCount} prior invoices since ${formatFullDate(supplier.history.firstSeen)} · ${formatPercent(supplier.history.onTimePaymentRate)} paid on time.`
                : "No prior payments with this supplier."
            }
          />
        </CheckList>

        {supplier.businessCriticality ? (
          <div className="flex items-center justify-between gap-3 border-t border-hairline py-3">
            <span className="text-[12.5px] text-ink-faint">Business criticality</span>
            <Badge tone="neutral">{supplier.businessCriticality}</Badge>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** Section C — is this invoice itself sound? */
export function InvoiceValidation({ facts }: { facts: DeterministicAnalysis }) {
  const validation = facts.validationFacts;
  const invoice = facts.invoiceFacts;
  const currency = invoice.currency;

  // `isDuplicate` records that a payment already exists for this invoice
  // number — that is, THIS invoice was settled. The invoice is not a duplicate;
  // paying it again would be.
  const duplicateCheck = describeDuplicateCheck({
    invoiceNumber: invoice.invoiceNumber,
    alreadySettled: validation.isDuplicate,
    settledByPaymentId: validation.duplicateOfPaymentId,
  });

  return (
    <Panel>
      <PanelHeader eyebrow="Invoice validation" title="Purchase order and duplicates" />
      <PanelBody className="py-2">
        <CheckList>
          <CheckRow
            passed={validation.poFound && validation.poMatch !== false}
            label="Purchase order matched"
            detail={
              !invoice.poNumber
                ? "No purchase order referenced on the invoice."
                : !validation.poFound
                  ? `${invoice.poNumber} does not exist in the purchase-order ledger.`
                  : validation.poMatch
                    ? `${invoice.poNumber} authorises ${formatMoneyRounded(validation.poAmountCents ?? 0, currency)}.`
                    : `Invoice exceeds ${invoice.poNumber} by ${formatMoneyRounded(Math.abs(validation.poDeltaCents ?? 0), currency)}.`
            }
          />
          {/* Label and detail come from one rule, so they cannot contradict
              each other the way "✕ No duplicate detected / Already settled as
              payment chain_0x927e…" did. */}
          <CheckRow
            passed={duplicateCheck.passed}
            // Settled is a finding, not a fault. A red cross here accuses a
            // payment that completed exactly as intended.
            tone={duplicateCheck.passed ? "verify" : "warn"}
            label={duplicateCheck.label}
            detail={
              duplicateCheck.settlementReference
                ? `${duplicateCheck.detail} Original settlement: ${duplicateCheck.settlementReference}.`
                : duplicateCheck.detail
            }
            note={duplicateCheck.preventionNote}
          />
          <CheckRow
            passed={(validation.amountVsSupplierMaxRatio ?? 0) <= 1}
            label="Amount within historical range"
            detail={
              validation.amountVsSupplierMeanRatio === null
                ? "No history for this supplier to compare against."
                : `${validation.amountVsSupplierMeanRatio.toFixed(2)}× this supplier's average, ${(validation.amountVsSupplierMaxRatio ?? 0).toFixed(2)}× their largest prior invoice.`
            }
          />
          <CheckRow
            passed={validation.currencyAllowed}
            label="Currency permitted"
            detail={`Invoice is denominated in ${currency}.`}
          />
        </CheckList>
      </PanelBody>
    </Panel>
  );
}
