/**
 * On-chain authorization for one Sui address.
 *
 * Reads the `payflow::identity::Company` object and looks the address up in
 * its member table. Everything returned here is chain-derived — the role, the
 * permission bitmask, the active flag — so the interface renders what the
 * chain says rather than what the session hoped.
 *
 * THREE ANSWERS, AND THEY ARE NOT THE SAME:
 *
 *   NOT_DEPLOYED   no company object exists yet. Nobody is a member of
 *                  anything, and saying so is honest rather than an error.
 *   NO_MEMBERSHIP  the company exists and has no record for this address.
 *   OK             a record exists; role and permissions come back with it.
 *
 * A failed read is none of the three. It is reported as a failure, because
 * "we could not check" must never resolve to "not a member" — that would lock
 * out a real member — nor to "member", which would be far worse.
 */

import { NextResponse } from "next/server";

import { createSuiQueries } from "@/lib/sui/client";
import { unitsToCents } from "@/lib/sui/units";
import { MissingDeploymentError, configuredNetwork, loadManifest } from "@/lib/sui/manifest";
import {
  extractFields,
  readBool,
  readString,
  readStringArray,
  readTableId,
  readU64,
} from "@/lib/sui/decode";

export const runtime = "nodejs";
/** Membership can be granted or revoked at any time; a cached answer is stale. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "address is required." },
      { status: 400 },
    );
  }

  let manifest;
  try {
    manifest = loadManifest(configuredNetwork());
  } catch (error) {
    if (error instanceof MissingDeploymentError) {
      return NextResponse.json(
        { ok: false, code: "NOT_DEPLOYED", message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }

  const identity = manifest.identity;
  if (!identity?.companyId) {
    // The company has not been created. Reported as a state rather than an
    // error: the application is working correctly and there is simply no
    // company on chain to belong to yet.
    return NextResponse.json({
      ok: true,
      status: "NOT_DEPLOYED",
      message: "No on-chain company identity has been created yet.",
    });
  }

  try {
    const queries = createSuiQueries(configuredNetwork());
    const fields = extractFields(await queries.getObjectFields(identity.companyId));
    if (Object.keys(fields).length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "COMPANY_UNREADABLE",
          message: "The company object could not be read from chain.",
        },
        { status: 503 },
      );
    }

    const membersTableId = readTableId(fields, "members");
    if (!membersTableId) {
      return NextResponse.json(
        { ok: false, code: "COMPANY_UNREADABLE", message: "The member table could not be read." },
        { status: 503 },
      );
    }

    // The table is a dynamic-field collection keyed by address.
    const entries = await queries.getDynamicFields(membersTableId);
    const entry = entries.find((row) => sameAddress(String(row.name ?? ""), address));

    const company = {
      companyId: identity.companyId,
      // The chain's own name, not the manifest's copy of it. The manifest is a
      // convenience; the object is the record.
      companyName: readString(fields, "name") ?? identity.companyName,
      treasuryId: readString(fields, "treasury_id") ?? identity.treasuryId,
      admin: readString(fields, "admin"),
      memberCount: Number(readU64(fields, "member_count") ?? 0),
    };

    // Read regardless of membership: the two are separate facts, and an
    // authorization without a membership is exactly the kind of inconsistency
    // an operator would want to see rather than have hidden.
    const authorization = await readApproverAuthorization(
      queries,
      company.treasuryId,
      address,
    );

    if (!entry) {
      return NextResponse.json({ ok: true, status: "NO_MEMBERSHIP", company, authorization });
    }

    const value = extractFields(entry.value);
    return NextResponse.json({
      ok: true,
      status: "OK",
      company,
      authorization,
      membership: {
        memberAddress: address,
        roleCode: Number(readU64(value, "role") ?? 0),
        permissionMask: Number(readU64(value, "permissions") ?? 0),
        // Defaults to false. An unreadable flag must not read as active.
        active: readBool(value, "active") ?? false,
        grantedAtMs: Number(readU64(value, "granted_at_ms") ?? 0),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The chain could not be read.";
    return NextResponse.json({ ok: false, code: "CHAIN_UNAVAILABLE", message }, { status: 503 });
  }
}

/**
 * The treasury's approver record for one address, if it holds one.
 *
 * Read from the dynamic field the authorization lives in, keyed by the
 * approver's address. Returns null for "no record" and throws for "could not
 * read" — the two must not collapse, because one means unauthorized and the
 * other means unknown.
 */
async function readApproverAuthorization(
  queries: ReturnType<typeof createSuiQueries>,
  treasuryId: string,
  address: string,
): Promise<{
  approver: string;
  treasuryId: string;
  maxSingleCents: number;
  dailyLimitCents: number;
  authorizedTodayCents: number;
  enabled: boolean;
  expiresAtMs: number;
  allowedRecipients: string[];
  companyId: string;
  membershipActive: boolean;
  membershipSyncedAtMs: number;
} | null> {
  const entries = await queries.getDynamicFields(treasuryId);
  const entry = entries.find((row) => sameAddress(String(row.name ?? ""), address));
  if (!entry) return null;

  const value = extractFields(entry.value);
  // A field under this key that does not decode as an authorization is not an
  // authorization. Reported as absent rather than guessed at.
  if (readU64(value, "max_single") === null) return null;

  return {
    approver: address,
    treasuryId,
    maxSingleCents: unitsToCents(readU64(value, "max_single") ?? BigInt(0)),
    dailyLimitCents: unitsToCents(readU64(value, "daily_limit") ?? BigInt(0)),
    authorizedTodayCents: unitsToCents(readU64(value, "authorized_today") ?? BigInt(0)),
    enabled: readBool(value, "enabled") ?? false,
    expiresAtMs: Number(readU64(value, "expires_at_ms") ?? BigInt(0)),
    allowedRecipients: readStringArray(value, "allowed_recipients"),
    companyId: readString(value, "company_id") ?? "",
    // Defaults to false. An unreadable mirror must never read as active.
    membershipActive: readBool(value, "membership_active") ?? false,
    membershipSyncedAtMs: Number(readU64(value, "membership_synced_at_ms") ?? BigInt(0)),
  };
}

function sameAddress(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}
