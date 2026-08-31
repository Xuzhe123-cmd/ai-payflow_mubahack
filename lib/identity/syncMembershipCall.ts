/**
 * The `approval::sync_membership` call, built and nothing more.
 *
 * Pure so the argument order can be tested without a chain, a keystore, or a
 * network. Submission lives in `syncMembershipSubmit`, which is server-only;
 * this file is safe to import anywhere.
 *
 * WHAT THIS TRANSACTION CAN AND CANNOT DO — the reason a button may call it:
 *
 *   It copies `identity::is_active_member && has_permission(APPROVE_PAYMENTS)`
 *   from the live Company into the treasury's mirror, and writes the clock
 *   reading beside it. That is the whole body.
 *
 *   It does NOT grant membership, create an authorization, raise `max_single`
 *   or `daily_limit`, touch `authorized_today`, or move a coin. A caller can
 *   make the treasury AGREE with the company and cannot make it disagree, so
 *   the worst a hostile caller achieves is telling the truth — which is why
 *   Move leaves it permissionless and why exposing it as a button is safe.
 *
 * If the company's verdict is "no", refreshing writes "no". The button is not a
 * way to become authorized; it is a way to stop being stale.
 */

import type { DeploymentManifest } from "../sui/deployment";
import { callPackageId } from "../sui/deployment";

/** `0x6` is the shared Clock, which supplies the sync timestamp. */
const CLOCK = "0x6";

export interface SyncMembershipPlan {
  packageId: string;
  module: "approval";
  function: "sync_membership";
  typeArguments: string[];
  /** Ordered exactly as the Move signature declares them. */
  arguments: string[];
  label: string;
}

export class CompanyNotDeployedError extends Error {
  readonly code = "NO_COMPANY";
  constructor() {
    super(
      "No Chain-Doi company object exists on chain, so there is no membership verdict to copy.",
    );
    this.name = "CompanyNotDeployedError";
  }
}

/**
 * Builds the call.
 *
 * The approver is an ARGUMENT rather than the sender: `sync_membership` names
 * the address it is syncing, so the transaction can be paid for by anyone.
 * That is what lets the server submit it on the signed-in user's behalf
 * without holding, or needing, that user's key.
 */
export function syncMembershipCall(
  manifest: DeploymentManifest,
  approver: string,
): SyncMembershipPlan {
  const companyId = manifest.identity?.companyId;
  if (!companyId) throw new CompanyNotDeployedError();

  return {
    packageId: callPackageId(manifest),
    module: "approval",
    function: "sync_membership",
    typeArguments: [manifest.coinType],
    arguments: [manifest.objects.treasuryId, companyId, approver, CLOCK],
    label: "Refresh the treasury's copy of this member's Chain-Doi status",
  };
}
