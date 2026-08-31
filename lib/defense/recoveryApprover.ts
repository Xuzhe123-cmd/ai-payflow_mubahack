/**
 * Who may recover the treasury, resolved from chain.
 *
 * NOT TAKEN FROM THE CLIENT, for the same reason the trip route recomputes its
 * own anomaly score: an address arriving in a request is a claim, and a reset
 * is the one action that gives autonomy back. The roster is read from the
 * treasury's own dynamic fields, so the interface can only ever ask to recover
 * as somebody Move already recognises.
 *
 * IT DECIDES NOTHING. Move re-checks every condition in
 * `approver_in_good_standing` when `reset_breaker` runs, and refuses with 117
 * regardless of what this function concluded. This exists so the interface can
 * say WHICH condition is unmet before spending gas to find out — the same role
 * the Sui preflight plays for payments.
 *
 * THE FRESHNESS RULE IS MIRRORED, NOT REIMPLEMENTED. `MEMBERSHIP_SYNC_MAX_AGE_MS`
 * comes from the same constant the rest of the app reads, which mirrors
 * `treasury::MEMBERSHIP_SYNC_MAX_AGE_MS`. Nothing here may relax it.
 */

import type { createSuiQueries } from "../sui/client";
import { extractFields, readBool, readU64 } from "../sui/decode";
import { MEMBERSHIP_SYNC_MAX_AGE_MS } from "../identity/paymentAuthority";

export interface RecoveryApprover {
  address: string;
  enabled: boolean;
  expiresAtMs: number;
  membershipActive: boolean;
  membershipSyncedAtMs: number;
  /** Age of the membership reading, in ms. Null when never synced. */
  membershipAgeMs: number | null;
  /** Every condition `approver_in_good_standing` checks, already true. */
  inGoodStanding: boolean;
  /**
   * True when the ONLY unmet condition is freshness.
   *
   * Distinguished because it is the one case a refresh can fix — and the one
   * the demo hits constantly, since rehearsing takes longer than an hour.
   */
  staleOnly: boolean;
}

export interface RecoveryRoster {
  /** Every approver the treasury holds an authorization for. */
  approvers: RecoveryApprover[];
  /** The first one Move would accept, or null when none qualifies. */
  eligible: RecoveryApprover | null;
  /** The first one a membership refresh would make eligible, or null. */
  refreshable: RecoveryApprover | null;
}

/**
 * Reads the treasury's approver authorizations and judges each one.
 *
 * A dynamic field whose value has no `max_single` is not an authorization — it
 * is the approver roster vector, or the circuit breaker — and is skipped rather
 * than guessed at.
 */
export async function readRecoveryRoster(
  queries: ReturnType<typeof createSuiQueries>,
  treasuryId: string,
  nowMs: number,
): Promise<RecoveryRoster> {
  const entries = await queries.getDynamicFields(treasuryId);
  const approvers: RecoveryApprover[] = [];

  for (const entry of entries) {
    // Keyed by address; anything else on this UID is not an approver record.
    const address = typeof entry.name === "string" ? entry.name : null;
    if (!address || !address.startsWith("0x")) continue;

    const value = extractFields(entry.value);
    if (readU64(value, "max_single") === null) continue;

    const enabled = readBool(value, "enabled") ?? false;
    const expiresAtMs = Number(readU64(value, "expires_at_ms") ?? BigInt(0));
    const membershipActive = readBool(value, "membership_active") ?? false;
    const syncedAtMs = Number(readU64(value, "membership_synced_at_ms") ?? BigInt(0));

    // Mirrors the Move checks in order. A never-synced mirror (0) has no age.
    const neverSynced = syncedAtMs === 0;
    const membershipAgeMs = neverSynced ? null : nowMs - syncedAtMs;
    const fresh =
      !neverSynced &&
      membershipAgeMs !== null &&
      membershipAgeMs >= 0 &&
      membershipAgeMs <= MEMBERSHIP_SYNC_MAX_AGE_MS;

    const withoutFreshness = enabled && nowMs <= expiresAtMs && membershipActive;

    approvers.push({
      address,
      enabled,
      expiresAtMs,
      membershipActive,
      membershipSyncedAtMs: syncedAtMs,
      membershipAgeMs,
      inGoodStanding: withoutFreshness && fresh,
      // Everything else holds; only the reading has aged out.
      staleOnly: withoutFreshness && !fresh,
    });
  }

  return {
    approvers,
    eligible: approvers.find((entry) => entry.inGoodStanding) ?? null,
    refreshable: approvers.find((entry) => entry.staleOnly) ?? null,
  };
}
