"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, File01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/common/Badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { getDocument, type StoredDocument } from "@/lib/services/documentService";
import { describeDueIn, formatFullDate, formatMoney } from "@/lib/format";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";

export function InvoiceHeader({ entry }: { entry: InvoiceEntry }) {
  const { invoice, run } = entry;
  const [viewing, setViewing] = useState(false);

  return (
    <>
      <div className="mb-6">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-faint transition-colors hover:text-ink"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />
          All invoices
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {invoice.invoiceNumber}
              </h1>
              <StatusBadge run={run} />
              {invoice.hasDiscount ? (
                <Badge tone="positive">Early-payment discount</Badge>
              ) : null}
            </div>
            <p className="mt-1.5 text-[14px] text-ink-soft">
              {invoice.supplierName}
              <span className="mx-2 text-hairline">·</span>
              <span className="text-ink-faint">
                received {formatFullDate(invoice.receivedAt)}
              </span>
            </p>
          </div>

          <div className="flex items-end gap-8">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Amount
              </div>
              <div className="tabular mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">
                {formatMoney(invoice.amountCents, invoice.currency)}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Due
              </div>
              <div className="tabular mt-1 text-[15px] font-semibold text-ink">
                {formatFullDate(invoice.dueDate)}
              </div>
              <div
                className={cn(
                  "text-[12px]",
                  invoice.daysUntilDue < 0 ? "text-neg" : "text-ink-faint",
                )}
              >
                {describeDueIn(invoice.daysUntilDue)}
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => setViewing(true)}
            >
              <HugeiconsIcon icon={File01Icon} size={14} strokeWidth={1.8} />
              View invoice
            </Button>
          </div>
        </div>
      </div>

      {viewing ? (
        <DocumentViewer documentId={invoice.document.id} onClose={() => setViewing(false)} />
      ) : null}
    </>
  );
}

/**
 * The original document, fetched through the document service so the Walrus
 * swap is a change of adapter rather than a change of screen.
 */
function DocumentViewer({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<StoredDocument | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDocument(documentId).then((result) => {
      if (!cancelled) setDoc(result);
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink">
              {doc?.filename ?? "Loading…"}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-faint">
              <span className="font-mono">{doc?.blobRef ?? ""}</span>
              {doc ? (
                <Badge tone="muted">
                  {doc.storage === "walrus" ? "Walrus blob" : "Demo storage"}
                </Badge>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
            aria-label="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
          </button>
        </header>

        <div className="overflow-auto bg-surface-sunken px-6 py-5">
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">
            {doc?.text ?? ""}
          </pre>
        </div>
      </div>
    </div>
  );
}
