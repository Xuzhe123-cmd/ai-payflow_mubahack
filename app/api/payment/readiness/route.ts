/**
 * What the chain currently permits for one invoice. Reads only.
 *
 * WHY IT IS A SEPARATE, GET-ONLY ROUTE. The interface has to know whether a
 * payment can run BEFORE it offers a control, and the only honest source for
 * that is chain state. But asking must not cost anything and must not be able
 * to move money — so this reads the treasury, the agent's registration, the
 * approver roster, the breaker and the invoice, submits nothing, and has no
 * POST. A prefetch or a crawler can hit it safely, which is the point.
 *
 * NO DRY RUN HERE, DELIBERATELY. A dry run needs a fully-formed transaction and
 * a sender, and running one per invoice on every page load would spend real
 * time on the CLI for a question these reads already answer. The dry run stays
 * where it belongs: immediately before a submission, in the execute route.
 *
 * THIS IS NOT THE GATE. Move re-checks all ten assertions, the approval and the
 * breaker on the real transaction. What this governs is what the screen may
 * CLAIM — see `lib/payments/executionReadiness.ts`.
 */

import { NextResponse } from "next/server";

import { readRecoveryRoster } from "@/lib/defense/recoveryApprover";
import type { ReadinessFacts } from "@/lib/payments/executionReadiness";
import { executionReadiness } from "@/lib/payments/executionReadiness";
import { discoverInvoices, readAgent } from "@/lib/sui/chainReader";
import { readBreakerState } from "@/lib/sui/breakerReader";
import { createSuiQueries, graphqlUrlFor } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";

export const runtime = "nodejs";
/** An answer about live authorization must never come from a cache. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const invoiceNumber = new URL(request.url).searchParams.get("invoiceNumber")?.trim();
  if (!invoiceNumber) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "invoiceNumber is required." },
      { status: 400 },
    );
  }

  let network;
  let manifest;
  try {
    network = configuredNetwork();
    manifest = loadManifest(network);
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const queries = createSuiQueries(network);
  const graphqlUrl = graphqlUrlFor(network);
  const nowMs = Date.now();

  try {
    const [agentState, roster, breaker, invoices] = await Promise.all([
      // Judged against REAL time, not the demo clock: the day bucket that
      // decides whether `spent_today` still counts is the chain's.
      readAgent(queries, manifest, nowMs),
      readRecoveryRoster(queries, manifest.objects.treasuryId, nowMs),
      readBreakerState(queries, manifest.objects.treasuryId),
      discoverInvoices(queries, manifest, graphqlUrl),
    ]);

    const invoice = invoices.find((entry) => entry.invoiceNumber === invoiceNumber);
    if (!invoice) {
      return NextResponse.json(
        {
          ok: false,
          code: "INVOICE_NOT_ON_CHAIN",
          message: `No Invoice object for ${invoiceNumber} exists in this deployment.`,
        },
        { status: 404 },
      );
    }

    // Loaded here rather than in the pure rule, which must stay offline.
    const { findReusableApproval } = await import("@/lib/sui/paymentExecution");
    const liveApprovalId = await findReusableApproval(
      manifest,
      graphqlUrl,
      {
        invoiceNumber: invoice.invoiceNumber,
        amountCents: invoice.amountCents,
        recipient: invoice.recipient,
      },
      nowMs,
    );

    const approver = roster.eligible ?? roster.refreshable ?? roster.approvers[0] ?? null;

    const facts: ReadinessFacts = {
      agent: agentState
        ? {
            authorized: true,
            enabled: agentState.enabled,
            maxSingleCents: agentState.maxSinglePaymentCents,
            dailyLimitCents: agentState.dailyLimitCents,
            spentTodayCents: agentState.spentTodayCents,
          }
        : {
            authorized: false,
            enabled: false,
            maxSingleCents: 0,
            dailyLimitCents: 0,
            spentTodayCents: 0,
          },
      approver: approver
        ? {
            inGoodStanding: approver.inGoodStanding,
            maxSingleCents: approver.maxSingleCents,
            dailyLimitCents: approver.dailyLimitCents,
            authorizedTodayCents: approver.authorizedTodayCents,
            staleOnly: approver.staleOnly,
          }
        : {
            inGoodStanding: false,
            maxSingleCents: 0,
            dailyLimitCents: 0,
            authorizedTodayCents: 0,
            staleOnly: false,
          },
      liveApproval: liveApprovalId
        ? { objectId: liveApprovalId, amountCents: invoice.amountCents }
        : null,
      // Reported only when there is no live one: an approval that CAN be spent
      // makes the dead ones beside it irrelevant.
      deadApprovals: [],
      breaker: breaker.mode,
      invoiceStatus: invoice.status,
      amountCents: invoice.amountCents,
      // WHICH PACKAGE IS ACTUALLY DEPLOYED decides how the day's budget is
      // counted at settlement, and the interface must track the chain rather
      // than the repo. Read from the manifest's upgrade record, so shipping the
      // v5 fix changes this without anyone editing a rule.
      approvalBudgetRule:
        (manifest.upgrade?.version ?? 1) >= 5 ? "V5_BOOKED_ONCE" : "V4_DOUBLE_COUNT",
    };

    return NextResponse.json({
      ok: true,
      invoiceNumber,
      readiness: executionReadiness(facts),
      facts,
      checkedAtMs: nowMs,
    });
  } catch (error) {
    // An unreadable chain is not permission and is not a refusal. The caller is
    // told the reading failed and must claim nothing either way.
    const message = error instanceof Error ? error.message : "The chain could not be read.";
    return NextResponse.json({ ok: false, code: "CHAIN_UNAVAILABLE", message }, { status: 503 });
  }
}
