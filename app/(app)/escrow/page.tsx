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
 * Two invoices, identical in every respect the policy engine can see. The only
 * difference is what the delivery document says, and that difference decides
 * whether a supplier gets paid.
 */

import { useEffect, useState } from "react";

import { PageContainer } from "@/components/layout/PageContainer";
import { Eyebrow } from "@/components/common/Badge";
import { EscrowDemo, type EscrowDemoInvoice } from "@/components/escrow/EscrowDemo";
import { FlowDiagram, ResponsibilityGrid } from "@/components/escrow/FlowDiagram";
import { SHIPMENT_ORACLE_LABEL, SHIPMENT_ORACLE_DETAIL } from "@/lib/oracle/shipment";
import type { EscrowDemoState } from "@/lib/escrow/demoFlow";

/** Both invoices are real objects on testnet, created by scripts/seedEscrowDemo.ts. */
const INVOICE_C: EscrowDemoInvoice = {
  label: "Demo A — shipment confirmed",
  invoiceNumber: "INV-2026-3501",
  amountCents: 480_000,
  supplierName: "Northwind Components Ltd",
  recipient: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  objectId: "0x927e138efa55e1fa300522191d01ac72a8b8a4c183c37c230a646b1a63c6065a",
  claim:
    "Approved supplier, matching wallet, inside the agent's $5,000 cap, liquidity comfortable. " +
    "The delivery document reports DELIVERED, so the condition is met and the escrow releases.",
};

const INVOICE_D: EscrowDemoInvoice = {
  label: "Demo B — shipment not confirmed",
  invoiceNumber: "INV-2026-3502",
  amountCents: 400_000,
  supplierName: "Kestrel Logistics GmbH",
  recipient: "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308",
  objectId: "0x7a617b9c89938e79092b07fb2f8aada17fd5669dc96e970099464b2979b061dd",
  claim:
    "Identical in every respect the policy engine can see — and the delivery document reports " +
    "IN_TRANSIT. The payment is authorised, committed, and still does not reach the supplier.",
};

/** One invoice's state as /api/escrow/state reports it. */
interface LiveDemo {
  invoiceNumber: string;
  amountCents: number;
  recipient: string;
  stage: EscrowDemoState["stage"];
  escrow: { objectId: string; attestationId: string | null } | null;
  attestation: EscrowDemoState["attestation"];
  proof: EscrowDemoState["proof"];
}

export default function EscrowDemoPage() {
  const [live, setLive] = useState<Record<string, EscrowDemoState> | null>(null);
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
        const byInvoice: Record<string, EscrowDemoState> = {};
        for (const demo of payload.demos as LiveDemo[]) {
          byInvoice[demo.invoiceNumber] = {
            invoiceNumber: demo.invoiceNumber,
            amountCents: demo.amountCents,
            stage: demo.stage,
            recipient: demo.recipient,
            proof: demo.proof,
            attestation: demo.attestation,
            escrowObjectId: demo.escrow?.objectId ?? null,
            attestationObjectId: demo.escrow?.attestationId ?? null,
            transactions: [],
          };
        }
        setLive(byInvoice);
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
          something in the world has not happened yet. These two invoices differ in exactly one
          thing: what their delivery document says.
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
          Live escrow state could not be read: {error}. The panels below show the
          last state this page resolved, which may be behind the chain.
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <EscrowDemo invoice={INVOICE_C} live={live?.[INVOICE_C.invoiceNumber] ?? null} />
          <EscrowDemo invoice={INVOICE_D} live={live?.[INVOICE_D.invoiceNumber] ?? null} />
        </div>

        <div className="space-y-5">
          <ResponsibilityGrid />
          <FlowDiagram />
        </div>
      </div>
    </PageContainer>
  );
}
