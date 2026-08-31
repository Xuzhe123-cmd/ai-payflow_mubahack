/**
 * Read-only check: what the outcome box will say for every live invoice.
 *
 * Runs the real rule over real chain state and prints the headline, so the
 * "settled invoice reads as Rejected" class of bug is visible without opening a
 * browser. Queries only — this submits nothing and executes no payment.
 *
 * Usage: npx tsx scripts/checkOutcomes.ts   (with the dev server running)
 */

import { availablePaymentAction } from "../lib/payments/availableAction";
import { describeInvoiceStatus } from "../lib/payments/invoiceStatus";
import { decideAutonomy } from "../lib/payments/autonomy";
import type { EscrowDemoStage } from "../lib/escrow/demoFlow";

const BASE = process.env.PAYFLOW_BASE_URL ?? "http://localhost:3000";

async function main() {
  const invoices = await getJson(`${BASE}/api/invoices`);
  const escrow = await getJson(`${BASE}/api/escrow/state`);

  const conditions = new Map<string, { stage: EscrowDemoStage; fundsHeldCents: number }>();
  for (const demo of escrow.demos ?? []) {
    conditions.set(demo.invoiceNumber, {
      stage: demo.stage,
      fundsHeldCents: demo.fundsHeldCents,
    });
  }

  for (const invoice of invoices.invoices ?? []) {
    const analysis = await postJson(`${BASE}/api/analyze`, { scenarioId: invoice.id });
    if (analysis.error) {
      console.log(`${invoice.invoiceNumber}  ANALYSIS FAILED: ${analysis.error}`);
      continue;
    }

    const condition = conditions.get(invoice.invoiceNumber) ?? null;
    const autonomy = decideAutonomy({
      action: analysis.decision.action,
      finalOutcome: analysis.finalOutcome,
      hasPaymentRequest: analysis.paymentRequest !== null,
      enforcement: analysis.enforcement,
      conditional: condition !== null,
    });

    const action = availablePaymentAction({
      autonomy,
      conditionStage: condition?.stage ?? null,
      fundsHeldCents: condition?.fundsHeldCents ?? 0,
      amountCents: invoice.amountCents,
      chainInvoiceStatus: invoice.chainStatus,
      supplierName: invoice.supplierName,
      runStatus: "ANALYZED",
      hasReceipt: false,
    });

    // NOTE on the `outcome` column: it is the ACTION BOX's headline. An invoice
    // awaiting a person is routed to the approval component before the action
    // box is reached, so it prints "NO PAYMENT" here while the page shows the
    // approval step. The badge and tab columns are what the list actually uses.
    const badge = describeInvoiceStatus({
      runStatus: "ANALYZED",
      finalOutcome: analysis.finalOutcome,
      chainInvoiceStatus: invoice.chainStatus,
      conditionStage: condition?.stage ?? null,
    });

    console.log(
      `${invoice.invoiceNumber.padEnd(14)} chain=${String(invoice.chainStatus).padEnd(9)} ` +
        `ai=${String(analysis.decision.action).padEnd(12)} ` +
        `risk=${String(analysis.decision.risk).padEnd(9)} ` +
        `badge=[${badge.label}]`.padEnd(26) +
        // The tab the /invoices page files it under. Printed beside the badge
        // because the bug was these two disagreeing on the same row.
        `tab=${badge.category.padEnd(10)} ` +
        `outcome=${action.headline.padEnd(24)} button=${action.label ?? "none"}`,
    );
  }
}

async function getJson(url: string) {
  const response = await fetch(url);
  return response.json();
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
