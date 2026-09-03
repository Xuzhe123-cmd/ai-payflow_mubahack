/**
 * Settling a payment on Sui, for real.
 *
 * This is the route that used to not exist. `executePayment` returned a
 * fabricated receipt — a digest derived by hashing the invoice number, network
 * "demo", a hardcoded epoch — and the interface rendered it in monospace beside
 * "Payment executed". A $30,000 invoice was reported as settled against a
 * $25,000 on-chain authorization that nothing ever consulted. It was then
 * changed to throw rather than lie, which was right but left the button doing
 * nothing visible. This makes the button do the thing it says.
 *
 * EXECUTION MODE. Simulated unless PAYFLOW_PAYMENT_LIVE is set ON THE SERVER —
 * so the default cannot spend testnet gas by accident, and going live is a
 * deliberate act by whoever runs the process rather than a click by whoever
 * opened the page. A simulated response carries `digest: null` and says plainly
 * that nothing was submitted. Neither mode ever invents a digest.
 *
 * NEVER TRUST THE CLIENT. The request names an invoice and an authority; every
 * figure that governs the payment is re-derived here. The AMOUNT and the
 * RECIPIENT come from the Invoice object on chain, not from the body — a client
 * that asks to pay a different address or a larger sum gets the invoice's own
 * terms, and would get an abort from `payment::evaluate` even if it did not.
 * The object id is resolved by invoice number rather than accepted.
 *
 * WHAT MAKES THIS SAFE is not this file. It is `payment::evaluate`'s ten checks,
 * the AgentCap the agent path must hold, and `approve_scoped`'s membership and
 * scope conditions. This route can refuse early and legibly; it cannot permit
 * anything Move would not.
 */

import { NextResponse } from "next/server";

import { discoverInvoices } from "@/lib/sui/chainReader";
import { createSuiQueries, graphqlUrlFor } from "@/lib/sui/client";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import type { PaymentAuthority, PaymentSubmission } from "@/lib/sui/paymentExecution";
import type { PaymentRequest } from "@/lib/types";

export const runtime = "nodejs";
/** A settlement must never be served from a cache. */
export const dynamic = "force-dynamic";

/**
 * The refusal's own name, in the widest vocabulary that fits it.
 *
 * ORDER MATTERS. A failed policy check is reported as that check, because the
 * interface renders those against the ten-assertion list. Only when the abort
 * is NOT one of the ten does the wider Move dictionary answer — and only when
 * neither knows it does this fall back to "REFUSED".
 *
 * That fallback used to be the ONLY answer for every code above 10, which is
 * how `602 ENotAuthorizedApprover` — the most consequential refusal this
 * product raises — reached the screen as the word "REFUSED" beside a raw
 * MoveAbort dump.
 */
function refusalCodeFor(payment: PaymentSubmission | null | undefined): string {
  return payment?.violation ?? payment?.refusalCode ?? "REFUSED";
}

/**
 * The sentence shown to a person, with the chain's own text kept beside it.
 *
 * Never a substitute for the original: the decoded reason explains the rule and
 * the raw error proves which line raised it, and dropping either one leaves a
 * reader unable to check the other.
 */
function refusalMessageFor(payment: PaymentSubmission | null | undefined): string {
  if (!payment) return "The chain refused this payment.";
  if (!payment.reason) return payment.error ?? "The chain refused this payment.";
  const named = payment.abortName
    ? `Move abort ${payment.abortCode} ${payment.abortName}.`
    : `Move abort ${payment.abortCode}.`;
  return `${payment.reason} ${named}`;
}

/**
 * Whether this server will submit, and to which network.
 *
 * The interface asks once on load so it can describe execution accurately
 * before anyone clicks — "the treasury key will sign this on testnet" and
 * "nothing will be submitted" are different promises, and guessing which one
 * applies is how a simulated receipt came to be presented as a real one.
 */
export async function GET() {
  const { paymentExecutionEnabled } = await import("@/lib/sui/paymentExecution");
  try {
    return NextResponse.json({
      ok: true,
      live: paymentExecutionEnabled(),
      network: configuredNetwork(),
    });
  } catch {
    return NextResponse.json({ ok: true, live: false, network: null });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const input = body as { request?: unknown; authority?: unknown };
  const paymentRequest = input.request as PaymentRequest | undefined;
  const authority = input.authority as PaymentAuthority | undefined;

  if (
    !paymentRequest ||
    typeof paymentRequest.invoiceNumber !== "string" ||
    typeof paymentRequest.recommendationId !== "string"
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "BAD_REQUEST",
        message: "request.invoiceNumber and request.recommendationId are required.",
      },
      { status: 400 },
    );
  }
  if (authority !== "AGENT" && authority !== "HUMAN_APPROVAL") {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "authority must be AGENT or HUMAN_APPROVAL." },
      { status: 400 },
    );
  }

  // Loaded lazily and only here. The module reaches the CLI keystore through
  // `node:child_process`, so importing it at module scope would drag that into
  // every build of this route whether or not anyone intends to submit.
  const {
    paymentExecutionEnabled,
    executeAgentPayment,
    executeApprovedPayment,
    findReusableApproval,
  } = await import("@/lib/sui/paymentExecution");

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

  // The invoice as the CHAIN holds it. This is the object the payment settles,
  // and its own amount and recipient are the ones that govern — the request is
  // provenance, not authority.
  let onChainInvoice;
  try {
    const invoices = await discoverInvoices(
      createSuiQueries(network),
      manifest,
      graphqlUrlFor(network),
    );
    onChainInvoice = invoices.find(
      (invoice) => invoice.invoiceNumber === paymentRequest.invoiceNumber,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The chain could not be reached.";
    return NextResponse.json(
      { ok: false, code: "CHAIN_UNAVAILABLE", message },
      { status: 503 },
    );
  }

  if (!onChainInvoice) {
    return NextResponse.json({
      ok: false,
      live: paymentExecutionEnabled(),
      network,
      code: "INVOICE_NOT_ON_CHAIN",
      message:
        `No Invoice object for ${paymentRequest.invoiceNumber} exists in this deployment, so ` +
        "there is nothing to settle. Seed it before executing.",
    });
  }

  // Replay protection is enforced by check 8 in Move, which is what actually
  // stops a second settlement. Reading it here only makes the refusal legible
  // before gas is spent.
  if (onChainInvoice.status === "PAID") {
    return NextResponse.json({
      ok: false,
      live: paymentExecutionEnabled(),
      network,
      code: "INVOICE_ALREADY_PAID",
      message:
        `${paymentRequest.invoiceNumber} is already marked PAID on chain. The treasury refuses ` +
        "a second settlement of the same invoice.",
    });
  }

  // The chain's own terms, substituted for whatever the client sent.
  const governed: PaymentRequest = {
    ...paymentRequest,
    amountCents: onChainInvoice.amountCents,
    recipientWallet: onChainInvoice.recipient,
    supplierId: onChainInvoice.supplierId,
  };

  if (!paymentExecutionEnabled()) {
    return NextResponse.json({
      ok: false,
      live: false,
      network,
      code: "EXECUTION_DISABLED",
      // No dry run is claimed here, because none was made. The ten checks are
      // asked by /api/approval/preflight, which is a different call the
      // interface makes at a different moment — saying they ran would be the
      // same overclaim as a fabricated digest, in a smaller way.
      message:
        "Live execution is off on this server, so nothing was submitted and no funds moved. " +
        `The invoice exists on ${network} and its terms were read, but no transaction was ` +
        "composed or signed. Set PAYFLOW_PAYMENT_LIVE=1 on the server to let the treasury key " +
        "sign this payment.",
      invoiceObjectId: onChainInvoice.objectId,
      governed: { amountCents: governed.amountCents, recipient: governed.recipientWallet },
    });
  }

  const nowMs = Date.now();
  const shared = {
    manifest,
    network,
    request: governed,
    invoiceObjectId: onChainInvoice.objectId,
    nowMs,
  };

  if (authority === "AGENT") {
    const payment = executeAgentPayment(shared);
    return NextResponse.json({
      ok: payment.ok,
      live: true,
      network,
      authority,
      code: payment.ok ? null : refusalCodeFor(payment),
      message: payment.ok ? `Settled on ${network}.` : refusalMessageFor(payment),
      payment,
      invoiceObjectId: onChainInvoice.objectId,
    });
  }

  // AN APPROVAL ALREADY ON CHAIN IS SPENT RATHER THAN DUPLICATED.
  //
  // `approve_scoped` books the amount against the approver's daily budget at
  // MINT time, permanently, whether or not the settlement that follows
  // succeeds. Minting afresh on every click therefore spends the day's
  // authorization on retries — and once it is gone, Move refuses every further
  // payment with `execute_approved`'s abort 2, which is correct and looks
  // exactly like a revoked capability.
  //
  // An unreachable chain is NOT read as "there is none": that mistake mints the
  // duplicate this lookup exists to avoid, so it is reported instead.
  let reusableApprovalId: string | null = null;
  try {
    reusableApprovalId = await findReusableApproval(
      manifest,
      graphqlUrlFor(network),
      {
        invoiceNumber: governed.invoiceNumber,
        amountCents: governed.amountCents,
        recipient: governed.recipientWallet,
      },
      nowMs,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The chain could not be reached.";
    return NextResponse.json(
      {
        ok: false,
        live: true,
        network,
        authority,
        code: "CHAIN_UNAVAILABLE",
        message:
          "Existing approvals could not be read, so nothing was submitted. Minting another " +
          `approval without checking would spend the day's authorization twice. ${message}`,
      },
      { status: 503 },
    );
  }

  const outcome = executeApprovedPayment(shared, reusableApprovalId);
  // The mint is a real authorization and a real transaction whether or not the
  // settlement that follows succeeds, so it is reported either way rather than
  // collapsed into a single verdict.
  const failed = outcome.payment ?? outcome.approval;
  const ok = outcome.payment?.ok === true;

  return NextResponse.json({
    ok,
    live: true,
    network,
    authority,
    code: ok ? null : refusalCodeFor(failed),
    message: ok
      ? `Settled on ${network} under a scoped human approval.`
      : refusalMessageFor(failed),
    payment: outcome.payment,
    approval: outcome.approval,
    approvalObjectId: outcome.approvalObjectId,
    /** True when an approval already on chain was spent, not a new one minted. */
    reusedApproval: outcome.reusedApproval,
    invoiceObjectId: onChainInvoice.objectId,
  });
}
