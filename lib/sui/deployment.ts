/**
 * The deployment manifest — the single place object IDs live.
 *
 * Nothing in the application may hardcode a package or object ID. They are
 * written once by scripts/deploy.ts and read from here, so re-deploying is a
 * matter of regenerating one file rather than hunting identifiers through
 * component source.
 *
 * The manifest records identity only. It never contains a private key, a
 * recovery phrase, or anything else that could move funds — the Sui CLI keeps
 * the keystore, and no script in this repo reads it.
 */

import type { Cents } from "../types";

export type SuiNetwork = "testnet" | "devnet" | "localnet";

/**
 * Objects created at deployment.
 *
 * Note two absences, which are deliberate rather than oversights:
 *
 *  - There is no `policyId`. TreasuryPolicy is stored BY VALUE inside the
 *    Treasury, because it has no independent lifecycle and inlining it makes
 *    "read the policy" a single object fetch. Read it from `treasuryId`.
 *
 *  - There is no `agentAuthorizationId`. An agent's limits are a table entry
 *    inside the Treasury, keyed by the AgentCap's object id — which is what
 *    lets the admin revoke an agent it does not hold the capability for. Read
 *    them from `treasuryId`, keyed by `agentCapId`.
 */
export interface DeploymentObjects {
  /** Shared. Holds the vault, the policy, the agent register, paid invoices. */
  treasuryId: string;
  /** Owned by the admin. The sole key to every policy mutation. */
  treasuryOwnerCapId: string;
  /** Shared. The authority on who may be paid and at which address. */
  supplierRegistryId: string;
  /** Shared. Known future inflows and outflows, for the off-chain forecaster. */
  cashFlowCalendarId: string;
  /** Owned by the agent. A bearer token; its limits live on the treasury. */
  agentCapId: string;
  /** Owned by the human approver, for payments above the threshold. */
  approverCapId: string;
  /** Owned by the admin. Demo coin minting only. */
  mockUsdcTreasuryCapId: string;
  /** Frozen coin metadata. */
  coinMetadataId: string;
}

export interface SeededInvoice {
  invoiceNumber: string;
  objectId: string;
  amountCents: Cents;
  supplierId: string;
}

export interface SeedRecord {
  seededAt: string;
  /** supplier_id -> registry entry key. Suppliers are table rows, not objects. */
  supplierIds: string[];
  invoices: SeededInvoice[];
  cashFlowEventCount: number;
  vaultFundedCents: Cents;
}

/**
 * Policy values as written at initialization.
 *
 * Recorded for provenance only. After deployment the chain is authoritative:
 * the interface reads the live policy from `treasuryId` and must never present
 * these numbers as current. If they disagree, the chain is right.
 */
export interface InitialPolicy {
  maxAgentPaymentCents: Cents;
  dailyAgentLimitCents: Cents;
  humanApprovalThresholdCents: Cents;
  minimumReserveCents: Cents;
  allowedCurrencies: string[];
  maxRecommendationAgeMs: number;
}

export interface DeploymentManifest {
  network: SuiNetwork;
  packageId: string;
  publishedAt: string;
  publisher: string;
  publishDigest: string;
  /** Fully-qualified settlement coin type, as check 7 compares it. */
  coinType: string;
  cliVersion: string;
  objects: DeploymentObjects;
  initialPolicy: InitialPolicy;
  /** Absent until scripts/seed.ts has run. */
  seed?: SeedRecord;
}

/** Where a manifest lives for a given network. */
export function manifestPath(network: SuiNetwork): string {
  return `deployments/${network}.json`;
}

export function isDeploymentManifest(value: unknown): value is DeploymentManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DeploymentManifest>;
  return (
    typeof candidate.packageId === "string" &&
    typeof candidate.network === "string" &&
    typeof candidate.coinType === "string" &&
    typeof candidate.objects === "object" &&
    candidate.objects !== null
  );
}

/**
 * Move call targets, derived from the package id so no string is assembled by
 * hand at a call site.
 */
export function targets(packageId: string) {
  return {
    treasuryCreate: `${packageId}::treasury::create_and_transfer`,
    registryCreate: `${packageId}::registry::create`,
    registryUpsert: `${packageId}::registry::upsert`,
    calendarCreate: `${packageId}::cashflow::create`,
    calendarAddEvent: `${packageId}::cashflow::add_event`,
    agentIssue: `${packageId}::agent::issue_to`,
    approverIssue: `${packageId}::approval::issue_approver_to`,
    invoiceCreate: `${packageId}::invoice::create`,
    treasuryDeposit: `${packageId}::treasury::deposit`,
    mintMockUsdc: `${packageId}::mock_usdc::mint`,
    executePayment: `${packageId}::payment::execute_payment`,
    executeApproved: `${packageId}::payment::execute_approved`,
    evaluate: `${packageId}::payment::evaluate`,
  } as const;
}

/** Struct types, for filtering objectChanges out of a transaction response. */
export function structTypes(packageId: string) {
  return {
    treasury: `${packageId}::treasury::Treasury`,
    treasuryOwnerCap: `${packageId}::treasury::TreasuryOwnerCap`,
    supplierRegistry: `${packageId}::registry::SupplierRegistry`,
    cashFlowCalendar: `${packageId}::cashflow::CashFlowCalendar`,
    agentCap: `${packageId}::agent::AgentCap`,
    approverCap: `${packageId}::approval::ApproverCap`,
    invoice: `${packageId}::invoice::Invoice`,
    paymentRecord: `${packageId}::payment::PaymentRecord`,
    paymentRequest: `${packageId}::payment::PaymentRequest`,
    humanApproval: `${packageId}::approval::HumanApproval`,
  } as const;
}

export function explorerObjectUrl(id: string, network: SuiNetwork): string {
  return `https://suiscan.xyz/${network}/object/${id}`;
}

export function explorerTxUrl(digest: string, network: SuiNetwork): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
