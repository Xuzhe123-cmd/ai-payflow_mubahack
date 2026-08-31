/**
 * A human approving a payment the agent is not authorized to make.
 *
 * This is the only way an escalated invoice can acquire a PaymentRequest. The
 * agent cannot reach it: `buildPaymentRequest` refuses to build one for
 * HUMAN_REVIEW, so an AI recommendation alone never produces something the
 * execution path will accept.
 *
 * What approval changes is WHOSE limits apply — the approver's rather than the
 * agent's — and nothing else. The same `enforcePolicy` runs over the same ten
 * checks against the same live chain state. A human can lift the agent's
 * ceiling; a human cannot lift the minimum reserve, vouch for an unapproved
 * supplier, redirect a payment, or settle an invoice twice. Those refuse the
 * approval exactly as they would refuse the agent.
 */

import { NextResponse } from "next/server";

import { buildAnalysis } from "@/lib/deterministic/buildAnalysis";
import { DEMO_CLOCK_MS } from "@/lib/demo/clock";
import { scenarioById } from "@/lib/demo/scenarios";
import { readChainSnapshot } from "@/lib/sui/chainReader";
import { worldFromChain } from "@/lib/sui/chainWorld";
import { createSuiQueries } from "@/lib/sui/client";
import { limitsFor } from "@/lib/sui/limits";
import { readApproverLimits } from "@/lib/sui/approverLimits";
import { configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import { enforcePolicy } from "@/lib/sui/policyGuard";
import type { ApprovalResponse } from "@/lib/services/contracts";
import type { PaymentRequest } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const scenarioId =
    typeof body === "object" && body !== null && "scenarioId" in body
      ? (body as { scenarioId: unknown }).scenarioId
      : undefined;
  // WHO is approving. Without it there is no address to look an authorization
  // up under, and the fixture figure would silently stand in for the chain's.
  const approverAddress =
    typeof body === "object" && body !== null && "approver" in body
      ? (body as { approver: unknown }).approver
      : undefined;
  if (typeof scenarioId !== "string") {
    return NextResponse.json({ error: "scenarioId (string) is required." }, { status: 400 });
  }

  let scenario;
  try {
    scenario = scenarioById(scenarioId);
  } catch {
    return NextResponse.json({ error: `Unknown scenario: ${scenarioId}` }, { status: 404 });
  }

  // Same world the analysis used, read fresh: the treasury may have moved since
  // the recommendation was made, and the approval must be judged against now.
  let world = scenario.world;
  let worldSource: "chain" | "fixture" = "fixture";
  try {
    const network = configuredNetwork();
    const snapshot = await readChainSnapshot(createSuiQueries(network), loadManifest(network));
    world = worldFromChain(snapshot);
    worldSource = "chain";
  } catch {
    // Left as the fixture world; reported below.
  }

  const analysis = await buildAnalysis({
    document: scenario.document,
    world,
    asOf: scenario.asOfDate,
  });

  // Pay on the first date the forecast clears, falling back to today. The
  // amount is the deterministic candidate figure — discount-adjusted where one
  // applies — never a number chosen here.
  const candidate =
    analysis.cashFlowScenarios.find((option) => !option.reserveBreach) ??
    analysis.cashFlowScenarios[0];

  if (!candidate) {
    return NextResponse.json(
      { error: "No payment date could be costed for this invoice." },
      { status: 422 },
    );
  }

  // Demo clock, so the approval's timestamps belong to demo day and the
  // expiry check is judged the same way on every machine.
  const now = DEMO_CLOCK_MS;
  const paymentRequest: PaymentRequest = {
    invoiceNumber: analysis.invoiceFacts.invoiceNumber,
    supplierId: analysis.supplierFacts.supplierId,
    supplierName: analysis.invoiceFacts.supplierName,
    amountCents: candidate.paymentAmountCents,
    currency: analysis.invoiceFacts.currency,
    recipientWallet: analysis.invoiceFacts.recipientWallet,
    requestedDate: candidate.paymentDate,
    // Attributed to the agent identity the treasury registered, because that is
    // what the capability names — but judged under the APPROVER's limits below.
    agentId: world.capability.agentId,
    recommendationId: `human_${now.toString(36)}`,
    recommendedAtMs: now,
    expiresAtMs: now + 86_400_000,
  };

  // THE CHAIN IS THE SOURCE OF TRUTH FOR WHAT A HUMAN MAY AUTHORIZE.
  //
  // The treasury's own approver record is read for this address and used in
  // place of the fixture figure. Where no record exists the fixture stands, and
  // the response says which was used — a caller must never have to guess
  // whether a limit came from the chain or from a constant.
  const onChain = await readApproverLimits(
    typeof approverAddress === "string" ? approverAddress : null,
  );
  const approverLimits = onChain ?? world.approver;

  const enforcement = enforcePolicy({
    request: paymentRequest,
    // The one thing approval changes.
    limits: limitsFor("HUMAN_APPROVAL", world.capability, approverLimits),
    policy: world.policy,
    treasury: world.treasury,
    suppliers: world.suppliers,
    paymentHistory: world.paymentHistory,
    nowMs: now,
  });

  const payload: ApprovalResponse = {
    scenarioId,
    worldSource,
    paymentRequest,
    enforcement,
    approvedUnder: "HUMAN_APPROVAL",
    agentMaxSinglePaymentCents: world.capability.maxSinglePaymentCents,
    approverMaxSinglePaymentCents: approverLimits.maxSinglePaymentCents,
    /** Where that ceiling came from. Stated, never inferred. */
    approverLimitSource: onChain ? "CHAIN" : "FIXTURE",
  };
  return NextResponse.json(payload);
}
