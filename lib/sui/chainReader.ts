/**
 * Reading the deployed PayFlow state from Sui.
 *
 * Every function takes a `ChainQueries` rather than reaching for a transport,
 * so the whole layer is testable against recorded testnet payloads. Object ids
 * come from the deployment manifest; none are written down here.
 *
 * Read-only. Nothing in this file builds, signs, or submits a transaction.
 *
 * On authority: these values ARE the policy. The figures in lib/demo/policies.ts
 * were a bootstrap for deployment only — once the package is live the treasury's
 * own fields are the truth, and where the two disagree the chain is right.
 */

import type { DeploymentManifest } from "./deployment";
import type { ChainQueries } from "./client";
import {
  directionFrom,
  invoiceStatusFrom,
  supplierStatusFrom,
  type ChainAgent,
  type ChainCashFlowEvent,
  type ChainInvoice,
  type ChainSnapshot,
  type ChainSupplier,
  type ChainTreasury,
} from "./chainTypes";
import {
  extractFields,
  isRecord,
  nestedFields,
  readBalance,
  readBool,
  readCents,
  readObjectId,
  readString,
  readStringArray,
  readTableId,
  readU64,
} from "./decode";
import { unitsToCents } from "./units";

export class ChainReadError extends Error {
  constructor(what: string, detail: string) {
    super(`Could not read ${what} from chain: ${detail}`);
    this.name = "ChainReadError";
  }
}

function requireFields(payload: unknown, what: string): Record<string, unknown> {
  const fields = extractFields(payload);
  if (Object.keys(fields).length === 0) {
    throw new ChainReadError(what, "the object has no readable Move fields");
  }
  return fields;
}

const MS_PER_DAY = 86_400_000;

/** Compares Sui addresses, which vary in case, `0x`, and leading zeros. */
function sameId(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) =>
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0"
      : null;
  const left = normalize(a);
  return left !== null && left === normalize(b);
}

// --- Treasury -----------------------------------------------------------------

export async function readTreasury(
  queries: ChainQueries,
  manifest: DeploymentManifest,
): Promise<ChainTreasury> {
  const objectId = manifest.objects.treasuryId;
  const fields = requireFields(await queries.getObjectFields(objectId), "the treasury");
  // TreasuryPolicy is stored BY VALUE inside the Treasury — there is no
  // separate policy object to fetch.
  const policy = nestedFields(fields, "policy");

  const balanceUnits = readBalance(fields, "vault");
  const balanceCents = balanceUnits === null ? 0 : unitsToCents(balanceUnits);
  const minimumReserveCents = readCents(policy, "min_reserve") ?? 0;

  return {
    objectId,
    owner: readString(fields, "owner") ?? manifest.publisher,
    balanceCents,
    minimumReserveCents,
    humanApprovalThresholdCents: readCents(policy, "human_approval_threshold") ?? 0,
    autoPayEnabled: readBool(policy, "auto_pay_enabled") ?? false,
    allowedCurrencies: readStringArray(policy, "allowed_currencies"),
    allowedCoinTypes: readStringArray(policy, "allowed_coin_types"),
    maxRecommendationAgeMs: Number(readU64(policy, "max_recommendation_age_ms") ?? 0),
    totalPaidCents: readCents(fields, "total_paid") ?? 0,
    paymentCount: Number(readU64(fields, "payment_count") ?? 0),
    // Floored: a treasury below its reserve has nothing available, not a
    // negative amount to render with a minus sign.
    availableCents: Math.max(0, balanceCents - minimumReserveCents),
  };
}

// --- Agent ---------------------------------------------------------------------

/**
 * An agent's limits live in a table on the treasury, keyed by the AgentCap's
 * object id — which is what lets the admin revoke an agent whose capability
 * object it does not hold.
 */
export async function readAgent(
  queries: ChainQueries,
  manifest: DeploymentManifest,
  now = Date.now(),
): Promise<ChainAgent | null> {
  const capObjectId = manifest.objects.agentCapId;
  const treasuryFields = requireFields(
    await queries.getObjectFields(manifest.objects.treasuryId),
    "the treasury",
  );
  const agentsTableId = readTableId(treasuryFields, "agents");
  if (!agentsTableId) return null;

  const entries = await queries.getDynamicFields(agentsTableId);
  const entry = entries.find((candidate) => sameId(candidate.name, capObjectId));
  if (!entry || !isRecord(entry.value)) return null;

  const auth = extractFields(entry.value);
  const dailyLimitCents = readCents(auth, "daily_limit") ?? 0;
  const spentTodayCents = effectiveSpentCents(auth, now);

  const capFields = extractFields(await queries.getObjectFields(capObjectId));

  return {
    capObjectId,
    agentId: readString(capFields, "agent_id") ?? "agent",
    enabled: readBool(auth, "enabled") ?? false,
    maxSinglePaymentCents: readCents(auth, "max_single") ?? 0,
    dailyLimitCents,
    spentTodayCents,
    remainingTodayCents: Math.max(0, dailyLimitCents - spentTodayCents),
  };
}

/**
 * Mirrors `treasury::agent_effective_spent`: a figure recorded on an earlier
 * day reads as zero rather than being carried forward. Showing the raw
 * `spent_today` would overstate today's usage every morning, and the interface
 * must agree with what the chain will actually enforce.
 */
function effectiveSpentCents(auth: Record<string, unknown>, now: number): number {
  const bucket = readU64(auth, "day_bucket");
  const today = BigInt(Math.floor(now / MS_PER_DAY));
  if (bucket === null || bucket !== today) return 0;
  return readCents(auth, "spent_today") ?? 0;
}

// --- Suppliers -----------------------------------------------------------------

export async function readSuppliers(
  queries: ChainQueries,
  manifest: DeploymentManifest,
): Promise<ChainSupplier[]> {
  const registryFields = requireFields(
    await queries.getObjectFields(manifest.objects.supplierRegistryId),
    "the supplier registry",
  );
  const tableId = readTableId(registryFields, "suppliers");
  if (!tableId) return [];

  const entries = await queries.getDynamicFields(tableId);

  return entries
    .map((entry) => {
      const supplierId = typeof entry.name === "string" ? entry.name : null;
      if (!supplierId || !isRecord(entry.value)) return null;
      const supplier = extractFields(entry.value);
      return {
        supplierId,
        name: readString(supplier, "name") ?? supplierId,
        registeredWallet: readString(supplier, "registered_wallet") ?? "",
        status: supplierStatusFrom(Number(readU64(supplier, "status") ?? 0)),
      } satisfies ChainSupplier;
    })
    .filter((entry): entry is ChainSupplier => entry !== null)
    .sort((a, b) => a.supplierId.localeCompare(b.supplierId));
}

// --- Invoices ------------------------------------------------------------------

/**
 * Invoices are shared objects with no registry to enumerate them, so their ids
 * come from the manifest's seed record, written when they were created.
 */
export async function readInvoices(
  queries: ChainQueries,
  manifest: DeploymentManifest,
): Promise<ChainInvoice[]> {
  const ids = (manifest.seed?.invoices ?? []).map((invoice) => invoice.objectId);
  if (ids.length === 0) return [];

  const payloads = await queries.multiGetObjectFields(ids);

  return payloads
    .map((payload) => {
      const fields = extractFields(payload);
      const invoiceNumber = readString(fields, "invoice_number");
      if (!invoiceNumber) return null;
      return {
        objectId: readObjectId(fields) ?? "",
        invoiceNumber,
        supplierId: readString(fields, "supplier_id") ?? "",
        amountCents: readCents(fields, "amount") ?? 0,
        currency: readString(fields, "currency") ?? "",
        dueDate: readString(fields, "due_date") ?? "",
        poNumber: readString(fields, "po_number") ?? "",
        recipient: readString(fields, "recipient") ?? "",
        status: invoiceStatusFrom(Number(readU64(fields, "status") ?? 0)),
        walrusBlobId: readOptionString(fields, "walrus_blob_id"),
      } satisfies ChainInvoice;
    })
    .filter((entry): entry is ChainInvoice => entry !== null)
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
}

/** `Option<String>` arrives as null, a bare string, or `{ vec: [...] }`. */
function readOptionString(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  if (isRecord(value)) {
    const vec = nestedFields(fields, key).vec;
    if (Array.isArray(vec)) return typeof vec[0] === "string" ? vec[0] : null;
  }
  return null;
}

// --- Cash-flow calendar ---------------------------------------------------------

export async function readCashFlowEvents(
  queries: ChainQueries,
  manifest: DeploymentManifest,
): Promise<ChainCashFlowEvent[]> {
  const fields = requireFields(
    await queries.getObjectFields(manifest.objects.cashFlowCalendarId),
    "the cash-flow calendar",
  );
  const raw = fields.events;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      const event = extractFields(entry);
      const date = readString(event, "date");
      if (!date) return null;
      return {
        date,
        direction: directionFrom(Number(readU64(event, "direction") ?? 0)),
        amountCents: readCents(event, "amount") ?? 0,
        description: readString(event, "description") ?? "",
      } satisfies ChainCashFlowEvent;
    })
    .filter((entry): entry is ChainCashFlowEvent => entry !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- The whole picture ----------------------------------------------------------

export async function readChainSnapshot(
  queries: ChainQueries,
  manifest: DeploymentManifest,
): Promise<ChainSnapshot> {
  const [treasury, agent, suppliers, invoices, cashFlowEvents] = await Promise.all([
    readTreasury(queries, manifest),
    readAgent(queries, manifest),
    readSuppliers(queries, manifest),
    readInvoices(queries, manifest),
    readCashFlowEvents(queries, manifest),
  ]);

  return {
    network: manifest.network,
    packageId: manifest.packageId,
    readAt: new Date().toISOString(),
    treasury,
    agent,
    suppliers,
    invoices,
    cashFlowEvents,
  };
}
