"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { Panel, PanelBody, PanelHeader, Field } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { EmptyState } from "@/components/common/States";
import { listSuppliers, type SupplierView } from "@/lib/services/treasuryService";
import { useInvoiceEntries } from "@/components/hooks/usePayflowSelectors";
import {
  formatFullDate,
  formatMoney,
  formatMoneyRounded,
  formatPercent,
  shortWallet,
} from "@/lib/format";

/**
 * The supplier registry is authorization data, not a contact list.
 *
 * On chain it is written by the treasury owner and read by the Move module
 * during enforcement — which is why an unrecognised counterparty can never be
 * paid, no matter how convincing its invoice is.
 */
export function SupplierRegistry() {
  const suppliers = useMemo(() => listSuppliers(), []);
  const entries = useInvoiceEntries();
  const [selectedId, setSelectedId] = useState<string>(suppliers[0]?.id ?? "");

  const unrecognized = useMemo(() => {
    const seen = new Map<string, { name: string; amountCents: number; invoice: string }>();
    for (const entry of entries) {
      const facts = entry.run?.analysis?.analysis;
      if (!facts || facts.supplierFacts.supplierFound) continue;
      seen.set(facts.invoiceFacts.supplierName, {
        name: facts.invoiceFacts.supplierName,
        amountCents: facts.invoiceFacts.amountCents,
        invoice: facts.invoiceFacts.invoiceNumber,
      });
    }
    return [...seen.values()];
  }, [entries]);

  const selected = suppliers.find((supplier) => supplier.id === selectedId) ?? null;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-5">
        <Panel>
          <PanelHeader
            eyebrow="Approved registry"
            title="Suppliers the agent may pay"
            subtitle="Registry status and registered wallet are checked again on chain at execution time."
          />
          <PanelBody className="p-0">
            <ul className="divide-y divide-hairline">
              {suppliers.map((supplier) => (
                <li key={supplier.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(supplier.id)}
                    className={cn(
                      "flex w-full items-center gap-4 px-5 py-4 text-left transition-colors",
                      supplier.id === selectedId
                        ? "bg-surface-sunken"
                        : "hover:bg-surface-sunken/60",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5">
                        <span className="truncate text-[14px] font-medium text-ink">
                          {supplier.name}
                        </span>
                        <StatusChip status={supplier.registryStatus} />
                      </div>
                      <div className="mt-1 font-mono text-[11.5px] text-ink-faint">
                        {shortWallet(supplier.registeredWallet, 14, 8)}
                      </div>
                    </div>

                    <div className="hidden text-right sm:block">
                      <div className="tabular text-[13.5px] font-semibold text-ink">
                        {formatMoneyRounded(supplier.lifetimeVolumeCents)}
                      </div>
                      <div className="text-[11.5px] text-ink-faint">
                        {supplier.history.invoiceCount} invoices
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>

        {unrecognized.length > 0 ? (
          <Panel tone="negative">
            <PanelHeader
              tone="negative"
              eyebrow="Unrecognized counterparties"
              title="Seen on an invoice, absent from the registry"
              subtitle="These cannot be paid by the agent. Adding one is an owner action, taken on chain."
            />
            <PanelBody className="p-0">
              <ul className="divide-y divide-hairline">
                {unrecognized.map((item) => (
                  <li
                    key={item.name}
                    className="flex items-center justify-between gap-4 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-medium text-ink">
                        {item.name}
                      </div>
                      <div className="font-mono text-[11.5px] text-ink-faint">
                        {item.invoice}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular text-[13px] font-semibold text-ink">
                        {formatMoneyRounded(item.amountCents)}
                      </span>
                      <Badge tone="warning">Not registered</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        ) : null}
      </div>

      <div>
        {selected ? (
          <SupplierDetails supplier={selected} />
        ) : (
          <EmptyState title="Select a supplier" description="Choose a supplier to see its record." />
        )}
      </div>
    </div>
  );
}

function SupplierDetails({ supplier }: { supplier: SupplierView }) {
  const meanCents = supplier.history.meanAmountCents;

  return (
    <Panel className="sticky top-20">
      <PanelHeader
        eyebrow="Supplier record"
        title={supplier.name}
        actions={<StatusChip status={supplier.registryStatus} />}
      />
      <PanelBody className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Lifetime volume"
            value={
              <span className="tabular font-semibold">
                {formatMoney(supplier.lifetimeVolumeCents)}
              </span>
            }
          />
          <Field
            label="Invoices"
            value={<span className="tabular">{supplier.history.invoiceCount}</span>}
          />
          <Field
            label="Average invoice"
            value={<span className="tabular">{formatMoney(meanCents)}</span>}
          />
          <Field
            label="Largest invoice"
            value={
              <span className="tabular">{formatMoney(supplier.history.maxAmountCents)}</span>
            }
          />
          <Field
            label="Paid on time"
            value={formatPercent(supplier.history.onTimePaymentRate, 0)}
          />
          <Field label="Criticality" value={supplier.businessCriticality} />
          <Field
            label="First seen"
            value={formatFullDate(supplier.history.firstSeen)}
            className="col-span-2"
          />
          <Field
            label="Registered wallet"
            value={supplier.registeredWallet}
            mono
            className="col-span-2"
          />
        </div>

        <div className="border-t border-hairline pt-4">
          <Eyebrow>Settled payments</Eyebrow>
          {supplier.settledPayments.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-faint">
              No payments recorded in the current ledger window.
            </p>
          ) : (
            <ul className="mt-2.5 space-y-2">
              {supplier.settledPayments.map((payment) => (
                <li
                  key={payment.paymentId}
                  className="flex items-baseline justify-between gap-3 text-[12.5px]"
                >
                  <span className="font-mono text-ink-soft">{payment.invoiceNumber}</span>
                  <span className="text-ink-faint">{formatFullDate(payment.paidAt)}</span>
                  <span className="tabular font-semibold text-ink">
                    {formatMoneyRounded(payment.amountCents, payment.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {supplier.aliases.length > 0 ? (
          <div className="border-t border-hairline pt-4">
            <Eyebrow>Known aliases</Eyebrow>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {supplier.aliases.map((alias) => (
                <Badge key={alias} tone="neutral">
                  {alias}
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Aliases let extraction match a document to this record. They never
              relax the wallet check.
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "APPROVED" ? "positive" : status === "PENDING" ? "warning" : "negative";
  return (
    <Badge tone={tone} dot>
      {status === "APPROVED" ? "Approved" : status === "PENDING" ? "Pending verification" : status}
    </Badge>
  );
}
