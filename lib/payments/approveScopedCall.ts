/**
 * The `approval::approve_scoped` call, built from chain facts only.
 *
 * WHAT THIS TRANSACTION IS. It is the human approval itself — not a preview of
 * one. Submitting it creates a shared `HumanApproval` object bound to ONE
 * invoice number, ONE amount and ONE recipient, and `payment::execute_approved`
 * re-checks all three before it settles anything. An approval for one payment
 * cannot be spent on another.
 *
 * WHAT IT IS NOT. It is not a raised limit. Every scope the treasury holds for
 * this approver — the per-payment ceiling, the daily budget, the recipient
 * allowlist, the expiry, the enabled flag, active Chain-Doi membership and the
 * freshness of that membership reading — is asserted by Move at mint time and
 * asserted AGAIN by `approval::limits_for` at execution. None of those numbers
 * appears in this file, and none may: they live in treasury state, which is
 * what makes them revocable.
 *
 * THE SENDER IS THE AUTHORITY. `approve_scoped` reads `ctx.sender()` and looks
 * that address up in the treasury's approver table. The plan below therefore
 * carries the approver address explicitly — a transaction signed by anyone else
 * is a different transaction and aborts with 602, whatever this plan says.
 *
 * NOTHING HERE COMES FROM THE CLIENT. `amount` and `recipient` are read off the
 * on-chain `Invoice` object by the caller, so a request cannot ask to authorize
 * a different address or a larger sum.
 */

import type { DeploymentManifest } from "../sui/deployment";
import { callPackageId } from "../sui/deployment";
import { centsToUnits } from "../sui/units";
import type { OnChainInvoiceRef } from "./executeCall";

/** `0x6` is the shared Clock. */
const CLOCK = "0x6";

/**
 * How long a minted approval stays spendable.
 *
 * Short on purpose, and shorter than it needs to be for a demo: an approval
 * that outlives the sitting it was granted in is standing permission, which is
 * the thing a per-payment approval exists to avoid. Move refuses an expiry in
 * the past (603) and refuses to execute past it, so this is a ceiling the chain
 * enforces rather than a convention.
 */
export const APPROVAL_TTL_MS = 3_600_000;

export interface ApproveScopedPlan {
  packageId: string;
  module: "approval";
  function: "approve_scoped";
  typeArguments: string[];
  /** Ordered exactly as the Move signature declares them. */
  arguments: string[];
  /** Whose authority this runs under. MUST be the transaction sender. */
  sender: string;
  label: string;
  effect: string;
}

export class CompanyMissingError extends Error {
  readonly code = "NO_COMPANY";
  constructor() {
    super(
      "No Chain-Doi company exists in the deployment manifest, so no membership can be " +
        "re-read and no scoped approval can be minted.",
    );
    this.name = "CompanyMissingError";
  }
}

/**
 * Builds the approval call.
 *
 * `invoice` must be the object the chain holds, not anything a request supplied
 * — see `locateInvoice`. The amount is converted from the invoice's own base
 * units, so no cents/units conversion happens on a client-provided number.
 */
export function approveScopedCall(
  manifest: DeploymentManifest,
  invoice: OnChainInvoiceRef,
  approver: string,
  nowMs: number,
  ttlMs: number = APPROVAL_TTL_MS,
): ApproveScopedPlan {
  const companyId = manifest.identity?.companyId;
  if (!companyId) throw new CompanyMissingError();

  return {
    packageId: callPackageId(manifest),
    module: "approval",
    function: "approve_scoped",
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      companyId,
      invoice.invoiceNumber,
      // From the chain object, never from the request.
      invoice.amount,
      invoice.recipient,
      String(nowMs + ttlMs),
      CLOCK,
    ],
    sender: approver,
    label: `Authorize ${invoice.invoiceNumber} under this approver's Chain-Doi authorization`,
    effect:
      "Creates a shared HumanApproval bound to this invoice, amount and recipient. Moves no " +
      "funds. Move re-reads the live Company, re-checks the per-payment ceiling, the daily " +
      "budget, the recipient scope, the expiry and the enabled flag, and records the amount " +
      "against the approver's day.",
  };
}

/** Cents form, for callers that hold the figure rather than the object. */
export function approvalAmountUnits(amountCents: number): string {
  return centsToUnits(amountCents).toString();
}
