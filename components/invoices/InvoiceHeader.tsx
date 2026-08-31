"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Cancel01Icon, File01Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/common/Badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import {
  hasContent,
  loadDocument,
  storedFrom,
  type StoredDocument,
} from "@/lib/services/documentService";
import { describeDueIn, formatFullDate, formatMoney } from "@/lib/format";
import type { InvoiceEntry } from "@/components/hooks/usePayflowSelectors";
import type { RawInvoiceDocument } from "@/lib/types";

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
              {/* The chain first: a settled invoice reads "Payment released",
                  not whatever the guard says about paying it again. */}
              <StatusBadge run={run} invoiceNumber={invoice.invoiceNumber} />
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
        // The invoice carries its own document text, so the viewer is handed
        // the document rather than an id to go and look up. A lookup that
        // misses can no longer cost a reader the document they already have.
        <DocumentViewer
          // Keyed by document, so opening a different invoice starts from a
          // clean LOADING state rather than reusing the previous one.
          key={invoice.document?.id ?? invoice.id}
          source={invoice.document}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The original invoice document.
 *
 * WHAT WAS WRONG: this held a single `doc: StoredDocument | null`, set once the
 * fetch resolved. `null` therefore meant two different things — "still
 * loading" and "there is no such document" — and the header rendered
 * `doc?.filename ?? "Loading…"`. Any lookup that found nothing left the modal
 * on "Loading…" with a blank body, permanently. The promise had no `.catch`
 * either, so a rejection did the same thing.
 *
 * Three separate ids missed that lookup: the two conditional invoices, whose
 * documents were registered elsewhere, and any invoice discovered on chain
 * with no local paperwork.
 *
 * So the state is explicit and every path terminates:
 *
 *   loading      the fetch is in flight, and only then
 *   ready        there is text to show
 *   unavailable  no document on file, or it carries no content
 *   error        the lookup threw. Offers a retry.
 *
 * INDEPENDENT OF EVERYTHING ELSE. It reads the document and nothing more — no
 * AI, no oracle, no escrow, no chain, no payment state. Viewing an invoice must
 * work when all of those are unavailable, which is exactly when someone most
 * wants to look at the paperwork.
 *
 * NOT the shipment proof. That is delivery evidence, lives in the oracle panel,
 * and is a different document entirely.
 */
type ViewerState =
  | { status: "loading" }
  | { status: "ready"; document: StoredDocument }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

/**
 * What can be known before any lookup runs.
 *
 * An invoice with no document, or one carrying no id to look up, is answered
 * from the props on the first render. Only a document that genuinely has to be
 * fetched ever shows "Loading invoice…".
 */
function initialViewerState(source: RawInvoiceDocument | null | undefined): ViewerState {
  const local = source && hasContent(source) ? storedFrom(source) : null;
  if (source?.id) return { status: "loading" };
  if (local) return { status: "ready", document: local };
  return { status: "unavailable", reason: "This invoice has no document attached." };
}

function DocumentViewer({
  source,
  onClose,
}: {
  /** The document the invoice already carries. */
  source: RawInvoiceDocument | null | undefined;
  onClose: () => void;
}) {
  // Whatever can be decided from the props alone is decided BEFORE the first
  // paint, not in an effect. An invoice with no id to look up never enters the
  // loading state at all, so there is no spinner to get stuck in.
  const [state, setState] = useState<ViewerState>(() => initialViewerState(source));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Already resolved from the props — nothing to fetch.
    if (state.status !== "loading") return;

    let cancelled = false;

    // The document the caller holds is the fallback, so a registry miss shows
    // the invoice rather than an apology.
    const local = source && hasContent(source) ? storedFrom(source) : null;

    void loadDocument(source!.id)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "found" && hasContent(result.document)) {
          setState({ status: "ready", document: result.document });
          return;
        }
        if (local) {
          setState({ status: "ready", document: local });
          return;
        }
        setState({
          status: "unavailable",
          reason:
            result.status === "missing"
              ? result.reason
              : "The document on file is empty.",
        });
      })
      .catch((error: unknown) => {
        // Without this the modal stayed on "Loading…" for ever.
        if (cancelled) return;
        if (local) {
          setState({ status: "ready", document: local });
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The document could not be read.",
        });
      });

    return () => {
      cancelled = true;
    };
    // `state.status` is deliberately not a dependency: the effect reads it as a
    // gate on first run, and re-running whenever it changed would refetch the
    // moment the fetch resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, attempt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const doc = state.status === "ready" ? state.document : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Invoice document"
    >
      <div
        className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-ink">
              {doc?.filename ?? source?.filename ?? "Invoice document"}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-faint">
              <span className="font-mono">{doc?.blobRef ?? source?.sourceRef ?? ""}</span>
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
          {state.status === "loading" ? (
            <p className="text-[12.5px] text-ink-faint">Loading invoice…</p>
          ) : state.status === "ready" ? (
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">
              {state.document.text}
            </pre>
          ) : state.status === "unavailable" ? (
            <div>
              <p className="text-[13px] font-medium text-ink">Invoice document unavailable</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">{state.reason}</p>
            </div>
          ) : (
            <div>
              <p className="text-[13px] font-medium text-neg">Unable to load invoice</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">{state.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 rounded-lg"
                onClick={() => {
                  setState({ status: "loading" });
                  setAttempt((value) => value + 1);
                }}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
