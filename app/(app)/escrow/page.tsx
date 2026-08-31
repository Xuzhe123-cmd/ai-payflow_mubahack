"use client";

/**
 * The Oracle + Escrow demonstration.
 *
 * A page of its own rather than an addition to the invoice view, because it
 * answers a different question. The invoice view asks whether a payment is
 * authorised; this asks what happens to an authorised payment whose real-world
 * condition has not been met — and the answer, that the money leaves the
 * treasury and then waits, needs room to be shown rather than a badge.
 *
 * EVERY INVOICE HERE COMES FROM THE CHAIN. This page used to name two of them
 * in constants, with their amounts, suppliers, escrow ids and a hand-written
 * sentence each. That made the demo pair special in the rendering rather than
 * in the data: a third conditional invoice would not have appeared, and the two
 * that did would have kept describing themselves from a fixture even after the
 * chain moved on. Now the list is whatever carries a shipment condition, and
 * the labels are derived from state.
 */

import { useEffect, useState } from "react";

import { PageContainer } from "@/components/layout/PageContainer";
import { Eyebrow } from "@/components/common/Badge";
import { EscrowDemo, type EscrowDemoInvoice } from "@/components/escrow/EscrowDemo";
import { FlowDiagram, ResponsibilityGrid } from "@/components/escrow/FlowDiagram";
import { evaluateShipmentEvidence } from "@/lib/oracle/evidence";
import { money } from "@/lib/escrow/present";
import { SHIPMENT_ORACLE_LABEL, SHIPMENT_ORACLE_DETAIL } from "@/lib/oracle/shipment";
import type { EscrowDemoState } from "@/lib/escrow/demoFlow";

/** One invoice's state as /api/escrow/state reports it. */
interface LiveDemo {
  invoiceNumber: string;
  amountCents: number;
  supplierName: string;
  recipient: string;
  stage: EscrowDemoState["stage"];
  escrow: { objectId: string; attestationId: string | null } | null;
  attestation: EscrowDemoState["attestation"];
  proof: EscrowDemoState["proof"];
}

interface ConditionalInvoice {
  invoice: EscrowDemoInvoice;
  state: EscrowDemoState;
}

export default function EscrowDemoPage() {
  const [invoices, setInvoices] = useState<ConditionalInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read the chain once on mount. The page reports what the escrows say; it
  // does not assemble a state from what has been clicked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/escrow/state");
        const payload = await response.json();
        if (cancelled) return;
        if (!payload.ok) {
          setError(payload.message ?? "Live escrow state is unavailable.");
          return;
        }
        setInvoices((payload.demos as LiveDemo[]).map(describe));
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Live escrow state is unavailable.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer>
      <header className="mb-6">
        <Eyebrow>Conditional settlement</Eyebrow>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-ink">
          Oracle, escrow, and the payment that waits
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-ink-soft">
          An invoice can pass every check a treasury can make — approved supplier, registered
          wallet, inside the agent&rsquo;s limits, liquidity fine — and still not be due, because
          something in the world has not happened yet. These invoices differ in exactly one
          thing: what their delivery document says, and whether the oracle confirmed it.
        </p>
      </header>

      <div className="mb-5 rounded-xl border border-hairline bg-surface-sunken px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-ink">{SHIPMENT_ORACLE_LABEL}</span>
          <span className="text-[12px] text-ink-faint">{SHIPMENT_ORACLE_DETAIL}</span>
        </div>
      </div>

      {error ? (
        <div className="mb-5 rounded-xl border border-warn/35 bg-warn-soft px-5 py-3 text-[12.5px] text-ink-soft">
          Live escrow state could not be read: {error}. Nothing is shown below rather than a
          state assembled from fixtures, which would not be the chain&rsquo;s.
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {invoices === null && !error ? (
            <div className="rounded-xl border border-hairline bg-surface-sunken px-5 py-4 text-[13px] text-ink-faint">
              Reading escrow state from chain…
            </div>
          ) : null}

          {invoices?.length === 0 ? (
            <div className="rounded-xl border border-hairline bg-surface-sunken px-5 py-4 text-[13px] text-ink-soft">
              No invoice currently carries a shipment condition. This page lists whatever does —
              it names no invoice of its own.
            </div>
          ) : null}

          {invoices?.map((entry) => (
            <EscrowDemo
              key={entry.invoice.invoiceNumber}
              invoice={entry.invoice}
              live={entry.state}
            />
          ))}
        </div>

        <div className="space-y-5">
          <ResponsibilityGrid />
          <FlowDiagram />
        </div>
      </div>
    </PageContainer>
  );
}

/**
 * The label and the claim, derived from what the chain holds.
 *
 * Written as a function of state rather than a table keyed by invoice number,
 * so a conditional invoice created tomorrow describes itself correctly without
 * anyone editing this file.
 */
function describe(demo: LiveDemo): ConditionalInvoice {
  const evidence = evaluateShipmentEvidence({
    invoiceNumber: demo.invoiceNumber,
    proof: demo.proof,
    attestation: demo.attestation,
  });

  const released = demo.stage === "RELEASED";
  const status = demo.proof?.deliveryStatus ?? "no delivery document";

  return {
    invoice: {
      label: evidence.confirmed ? "Shipment confirmed" : "Shipment not confirmed",
      invoiceNumber: demo.invoiceNumber,
      amountCents: demo.amountCents,
      supplierName: demo.supplierName,
      recipient: demo.recipient,
      objectId: demo.escrow?.objectId ?? "",
      claim: released
        ? `The delivery document reports ${status} and the oracle attested it on chain, so the ` +
          `escrow condition was satisfied and ${money(demo.amountCents)} reached the supplier.`
        : `Approved supplier, matching wallet, inside the agent's limits — and the delivery ` +
          `document reports ${status}. The payment is authorised, committed, and still does not ` +
          `reach the supplier.`,
    },
    state: {
      invoiceNumber: demo.invoiceNumber,
      amountCents: demo.amountCents,
      stage: demo.stage,
      recipient: demo.recipient,
      proof: demo.proof,
      attestation: demo.attestation,
      escrowObjectId: demo.escrow?.objectId ?? null,
      attestationObjectId: demo.escrow?.attestationId ?? null,
      transactions: [],
    },
  };
}
