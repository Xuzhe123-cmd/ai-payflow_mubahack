"use client";

import { use, useEffect } from "react";

import { PageContainer } from "@/components/layout/PageContainer";
import { EmptyState } from "@/components/common/States";
import { LinkButton } from "@/components/common/LinkButton";
import { EngineNotice } from "@/components/common/EngineNotice";
import { InvoiceHeader } from "@/components/invoices/InvoiceHeader";
import {
  InvoiceDetails,
  InvoiceValidation,
  SupplierVerification,
} from "@/components/invoices/InvoiceFacts";
import { RiskPanel, UrgencyPanel } from "@/components/invoices/RiskUrgencyPanels";
import { CashFlowAnalysis } from "@/components/invoices/CashFlowAnalysis";
import { DecisionChain } from "@/components/payments/DecisionChain";
import { ShipmentEvidence } from "@/components/payments/ShipmentEvidence";
import { PurchaseOrderEvidence } from "@/components/invoices/PurchaseOrderEvidence";
import { ApprovalAuthority } from "@/components/payments/ApprovalAuthority";
import { OracleCard } from "@/components/dashboard/OracleCard";
import { PipelineStrip } from "@/components/dashboard/PipelineStrip";
import { buildInvoiceOracleFeed } from "@/lib/oracle/feed";
import {
  AnalysisFailed,
  AnalysisProgress,
} from "@/components/invoices/AnalysisProgress";
import { usePayflow } from "@/components/providers/PayflowProvider";
import { useInvoiceEntries } from "@/components/hooks/usePayflowSelectors";

export default function InvoiceAnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const entries = useInvoiceEntries();
  const { analyzeOne, setActiveInvoice, state } = usePayflow();

  const entry = entries.find((item) => item.invoice.id === id) ?? null;

  useEffect(() => {
    setActiveInvoice(id);
    return () => setActiveInvoice(null);
  }, [id, setActiveInvoice]);

  // An invoice opened directly, before the queue reached it, analyzes on view.
  useEffect(() => {
    if (!entry) return;
    if (!entry.run || entry.run.status === "DETECTED") void analyzeOne(id);
  }, [analyzeOne, entry, id]);

  if (!entry) {
    return (
      <PageContainer>
        <EmptyState
          title="Invoice not found"
          description={
            state.inboxStatus === "CONNECTED"
              ? "This invoice is not in the current inbox."
              : "The finance inbox is not connected yet, so no invoices have been detected."
          }
          action={
            <LinkButton href="/invoices" size="sm" className="rounded-lg">
              Back to invoices
            </LinkButton>
          }
        />
      </PageContainer>
    );
  }

  const run = entry.run;
  const analysis = run?.analysis ?? null;

  return (
    <PageContainer>
      <InvoiceHeader entry={entry} />

      {run?.status === "FAILED" ? (
        <AnalysisFailed
          message={run.error ?? "The analysis service did not return a decision."}
          onRetry={() => void analyzeOne(id)}
        />
      ) : null}

      {!analysis && run?.status !== "FAILED" ? (
        <AnalysisProgress run={run ?? { ...EMPTY, completedSteps: [] }} />
      ) : null}

      {analysis ? (
        <div className="space-y-5">
          <EngineNotice analysis={analysis} />

          {/* Oracle → AI → Guard → Sui, then the facts the oracle supplied for
              THIS invoice, before the decision they produced. */}
          <PipelineStrip />

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="animate-rise">
              <DecisionChain entry={entry} />
            </div>
            <OracleCard
              feed={buildInvoiceOracleFeed(analysis)}
              title="Reference data for this invoice"
              subtitle="Invoice and supplier facts, and which of them the chain re-derived independently. Shipment confirmation is a separate question, answered above."
            />
          </div>

          {/* Only renders for an invoice that carries a shipment condition —
              decided by chain state, never by an invoice number. An ordinary
              invoice shows nothing here. */}
          <ShipmentEvidence invoiceNumber={analysis.analysis.invoiceFacts.invoiceNumber} />

          {/* Renders only for an invoice that cites a purchase order — decided
              by the invoice's own PO reference, never by an invoice number. */}
          <PurchaseOrderEvidence facts={analysis.analysis} />

          {/* Shown only where a person is actually being asked to authorize.
              Reads the SAME chain-derived authority as the access page — the
              logic is not repeated here. */}
          {analysis.finalOutcome === "AWAITING_APPROVAL" ||
          analysis.finalOutcome === "HUMAN_REVIEW" ? (
            <ApprovalAuthority
              invoiceNumber={analysis.analysis.invoiceFacts.invoiceNumber}
              amountCents={analysis.analysis.invoiceFacts.amountCents}
              supplierName={analysis.analysis.invoiceFacts.supplierName}
              recipient={analysis.analysis.invoiceFacts.recipientWallet}
              treasuryId={TREASURY_ID}
            />
          ) : null}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
              <CashFlowAnalysis analysis={analysis} />
              <InvoiceDetails facts={analysis.analysis} />
              <div className="grid gap-5 lg:grid-cols-2">
                <SupplierVerification facts={analysis.analysis} />
                <InvoiceValidation facts={analysis.analysis} />
              </div>
            </div>

            <div className="space-y-5">
              {/* The invoice number enables the chain lookup: a settled
                  invoice is assessed on the payment that happened, not on a
                  hypothetical new one the guard would refuse. */}
              <RiskPanel
                facts={analysis.analysis}
                decision={analysis.decision}
                invoiceNumber={analysis.analysis.invoiceFacts.invoiceNumber}
              />
              <UrgencyPanel facts={analysis.analysis} decision={analysis.decision} />
              <ProvenanceCard
                engineMode={analysis.engineMode}
                modelId={analysis.modelId}
                latencyMs={analysis.latencyMs}
                sourceRef={entry.invoice.sourceRef}
              />
            </div>
          </div>
        </div>
      ) : null}
    </PageContainer>
  );
}

/** The treasury every authorization on this page is measured against. */
const TREASURY_ID =
  "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";

const EMPTY = {
  approval: null,
  humanRejected: false,
  status: "ANALYZING" as const,
  analysis: null,
  error: null,
  executionFailure: null,
  receipt: null,
  executionStage: null,
};

function ProvenanceCard({
  engineMode,
  modelId,
  latencyMs,
  sourceRef,
}: {
  engineMode: "live" | "recorded" | "fallback";
  modelId: string | null;
  latencyMs: number;
  sourceRef: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface px-5 py-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        Decision provenance
      </div>
      <dl className="mt-3 space-y-2 text-[12.5px]">
        <Row
          label="Engine"
          value={
            engineMode === "fallback"
              ? "Deterministic fallback · AI explanation unavailable"
              : engineMode === "recorded"
                ? "Workers AI (recorded)"
                : "Cloudflare Workers AI"
          }
        />
        <Row label="Model" value={modelId ?? "—"} mono />
        <Row
          label={engineMode === "recorded" ? "Call" : "Latency"}
          value={engineMode === "recorded" ? "replayed" : `${latencyMs} ms`}
        />
        <Row label="Source" value={sourceRef} mono />
      </dl>
    </div>
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd
        className={
          mono
            ? "truncate font-mono text-[11.5px] text-ink"
            : "truncate font-medium text-ink"
        }
      >
        {value}
      </dd>
    </div>
  );
}
