/**
 * The `payment::execute_approved` call — the human-approved settlement.
 *
 * TWO ENTRY POINTS SETTLE A PAYMENT, AND THEY MUST NOT BE MIXED:
 *
 *   payment::execute_payment   the agent acting on its own AgentCap. Judged
 *                              against the AGENT's limits, and withdrawn
 *                              entirely by the HUMAN_ONLY circuit breaker.
 *   payment::execute_approved  a person settling above that ceiling. Judged
 *                              against the approval object's own limits, which
 *                              are the approved amount exactly — so it cannot
 *                              be stretched — and left standing while the
 *                              breaker is tripped, because freezing autonomy
 *                              must not also freeze the humans.
 *
 * This builder targets the second. It takes NO amount and NO recipient: both
 * are read by Move off the `HumanApproval` object, which is why an approval for
 * one payment cannot be spent on another and why there is no field here through
 * which a caller could redirect a payment.
 *
 * IT NEEDS NO CAPABILITY. `HumanApproval` is a SHARED object and carries the
 * authority itself; the transaction sender is irrelevant to the authorization.
 * That is deliberate in the Move design — the authority was established when
 * the approver signed `approve_scoped`, and re-establishing it at execution
 * would mean the approver had to be online to spend their own approval.
 *
 * THE APPROVAL IS STILL RE-JUDGED. `approval::limits_for` re-asks the treasury
 * whether that approver is STILL authorised — revoked, expired, lowered or
 * membership-lapsed all refuse an approval that is already sitting on chain.
 * Holding the object is not the same as being allowed to spend it.
 */

import type { DeploymentManifest } from "../sui/deployment";
import { callPackageId } from "../sui/deployment";

/** `0x6` is the shared Clock. */
const CLOCK = "0x6";

export interface ExecuteApprovedPlan {
  packageId: string;
  module: "payment";
  function: "execute_approved";
  typeArguments: string[];
  arguments: string[];
  label: string;
  effect: string;
}

export class ApprovalMissingError extends Error {
  readonly code = "NO_APPROVAL";
  constructor(readonly invoiceNumber: string) {
    super(
      `No live HumanApproval exists on chain for ${invoiceNumber}, so there is nothing to ` +
        "execute. An approval must be submitted by an authorized approver first.",
    );
    this.name = "ApprovalMissingError";
  }
}

export interface OnChainApprovalRef {
  objectId: string;
  invoiceNumber: string;
}

export interface OnChainInvoiceObject {
  objectId: string;
  invoiceNumber: string;
}

/**
 * Builds the settlement call.
 *
 * `recommendationId` is recorded on the frozen PaymentRecord as provenance, and
 * the recommendation window is re-checked by Move's tenth assertion — which is
 * why both timestamps are passed rather than assumed.
 */
export function executeApprovedCall(
  manifest: DeploymentManifest,
  approval: OnChainApprovalRef,
  invoice: OnChainInvoiceObject,
  recommendationId: string,
  nowMs: number,
  windowMs = 86_400_000,
): ExecuteApprovedPlan {
  if (approval.invoiceNumber !== invoice.invoiceNumber) {
    // Move refuses this too (701 EApprovalMismatch). Refusing here makes the
    // reason legible without spending gas to hear it.
    throw new ApprovalMissingError(invoice.invoiceNumber);
  }

  return {
    packageId: callPackageId(manifest),
    module: "payment",
    function: "execute_approved",
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      // The authority. Amount and recipient are read from inside it by Move.
      approval.objectId,
      manifest.objects.supplierRegistryId,
      invoice.objectId,
      recommendationId,
      String(nowMs),
      String(nowMs + windowMs),
      CLOCK,
    ],
    label: `Settle ${invoice.invoiceNumber} under a human approval`,
    effect:
      "Consumes the HumanApproval, transfers from the treasury vault to the invoice's " +
      "registered recipient, and freezes a PaymentRecord marked human-approved. Move re-checks " +
      "all ten assertions and re-asks the treasury whether the approver is still authorised.",
  };
}
