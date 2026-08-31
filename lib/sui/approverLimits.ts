/**
 * The approver's limits, read from the treasury rather than from a constant.
 *
 * WHY THIS EXISTS. `/api/approve` used to judge a human approval against
 * `APPROVER_AUTHORITY`, a TypeScript constant of $250,000. The live on-chain
 * authorization permitted $25,000. A $30,000 invoice therefore passed, and the
 * interface offered an Execute Payment button on the strength of a number that
 * no validator had ever seen.
 *
 * The chain holds the answer, so the chain is asked.
 *
 * ADVISORY EVEN SO. What this returns feeds the off-chain forecast and the
 * explanation shown beside it. It is not the enforcement — `approve_scoped`
 * re-reads the same record when an approval is actually minted, and Move
 * refuses whatever this said. Reading it here makes the PREVIEW honest; it does
 * not make the preview a gate.
 */

import { createSuiQueries } from "./client";
import { extractFields, readBool, readU64 } from "./decode";
import { configuredNetwork, loadManifest } from "./manifest";
import { unitsToCents } from "./units";
import type { ApproverAuthority } from "../types";

function sameAddress(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}

/**
 * The treasury's approver record for one address, as spending limits.
 *
 * Returns null when the treasury holds no record, when the record is not
 * usable, or when the chain cannot be read. Null means "the chain did not
 * authorize this" — never "assume the fixture is fine for spending", which is
 * the caller's decision to state explicitly.
 *
 * A revoked or expired record returns ZERO limits rather than null: the
 * distinction matters, because null lets a caller fall back to a fixture and
 * zero does not.
 */
export async function readApproverLimits(
  approver: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<ApproverAuthority | null> {
  if (!approver) return null;

  try {
    const network = configuredNetwork();
    const manifest = loadManifest(network);
    const queries = createSuiQueries(network);

    const fields = await queries.getDynamicFields(manifest.objects.treasuryId);
    const entry = fields.find((row) => sameAddress(String(row.name ?? ""), approver));
    if (!entry) return null;

    const value = extractFields(entry.value);
    const maxSingle = readU64(value, "max_single");
    if (maxSingle === null) return null;

    const enabled = readBool(value, "enabled") ?? false;
    const expiresAtMs = Number(readU64(value, "expires_at_ms") ?? BigInt(0));
    const membershipActive = readBool(value, "membership_active") ?? false;

    // Revoked, lapsed, or blocked by membership authorizes nothing. Reported as
    // zero rather than as the recorded ceiling, so a forecast built on this
    // cannot describe authority the chain would refuse.
    const live = enabled && membershipActive && nowMs <= expiresAtMs;
    if (!live) {
      return { maxSinglePaymentCents: 0, dailyLimitCents: 0, dailySpentCents: 0 };
    }

    return {
      maxSinglePaymentCents: unitsToCents(maxSingle),
      dailyLimitCents: unitsToCents(readU64(value, "daily_limit") ?? BigInt(0)),
      dailySpentCents: unitsToCents(readU64(value, "authorized_today") ?? BigInt(0)),
    };
  } catch {
    // Unreadable chain is not permission. The caller is told nothing was found
    // and decides what to do about it.
    return null;
  }
}
