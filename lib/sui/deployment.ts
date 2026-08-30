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

/**
 * What a package upgrade produced.
 *
 * Recorded ALONGSIDE the original publish rather than replacing it, because
 * after an upgrade the two ids mean different things and both are needed. See
 * `callPackageId` / `typePackageId` — confusing them is the classic way to
 * break a working deployment.
 */
export interface UpgradeRecord {
  /** The new package id. Move CALLS go here. */
  packageId: string;
  /** The id this upgrade replaced, for the audit trail. */
  previousPackageId: string;
  /** On-chain package version after the upgrade. The first publish is 1. */
  version: number;
  upgradeCapId: string;
  upgradedAt: string;
  digest: string;
  /** Modules added by this upgrade, for the record. */
  addedModules: string[];
}

/**
 * A real settlement that already happened, kept as evidence.
 *
 * Recorded because a demo claim ages badly. "The agent can pay autonomously"
 * was proven once, by a transaction, and the invoice it settled is now
 * permanently PAID — so re-running the payment to re-prove it is impossible by
 * construction. What the verifier does instead is check this record against the
 * chain, which is a stronger statement anyway: not "it would work" but "it did".
 *
 * `packageId` is the version the call actually ran against. A proof made before
 * an upgrade stays valid afterwards; the transaction is history, and history
 * does not move to the new package.
 */
export interface PaymentProof {
  /** Which demo claim this establishes. */
  scenario: "A0";
  invoiceNumber: string;
  amountCents: Cents;
  /** The real transaction digest. */
  digest: string;
  /** The package the call executed against, which may predate an upgrade. */
  packageId: string;
  module: string;
  function: string;
  /** The Invoice object the transaction settled. */
  invoiceObjectId: string;
  /** The frozen PaymentRecord it created — the cross-check that makes this
   *  proof about OUR payment rather than about the invoice merely being paid. */
  paymentRecordId: string;
  supplierId: string;
  recipient: string;
  /** 0 = AGENT (autonomous), 1 = HUMAN_APPROVAL. A0 must be 0. */
  authority: number;
  executedAt: string;
}

/** Objects created after the escrow upgrade. Absent until they exist. */
export interface EscrowDemoRecord {
  createdAt: string;
  /** Owned by the demo shipment oracle. */
  oracleCapId: string;
  oracleId: string;
  /** The two conditional demo invoices. */
  invoices: SeededInvoice[];
  /** Escrow objects, once locked. */
  escrowIds: string[];
  /** Frozen attestations, once made. */
  attestationIds: string[];
}

export interface DeploymentManifest {
  network: SuiNetwork;
  /**
   * The ORIGINAL published package id, and permanently so.
   *
   * Every object created before an upgrade carries a type anchored to this
   * address — `Treasury`, `Invoice`, and the settlement coin all resolve here
   * forever. Never overwrite it with an upgraded id.
   */
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
  /** Owned by the publisher. Required to upgrade the package. */
  upgradeCapId?: string;
  /** Absent until the package has been upgraded. Latest upgrade only. */
  upgrade?: UpgradeRecord;
  /** Absent until the escrow demo objects have been created. */
  escrowDemo?: EscrowDemoRecord;
  /** Real settlements already executed, kept as evidence rather than re-run. */
  proofs?: { a0?: PaymentProof };
  /**
   * Module name -> the package version that first defined it.
   *
   * A Move type is addressed by the package version that DEFINED its module,
   * not by the current one. Modules from the original publish keep the original
   * address forever; a module introduced by an upgrade is addressed at that
   * upgrade's package and stays there through later upgrades too.
   *
   * Verified on testnet after the escrow upgrade: `AgentCap` still reads
   * `<v1>::agent::AgentCap` while the newly added `OracleCap` reads
   * `<v2>::oracle::OracleCap`. Anything absent here belongs to the original
   * publish.
   */
  moduleOrigins?: Record<string, string>;
}

/**
 * Where to send a Move CALL: the newest package version.
 *
 * An upgrade publishes a new id, and only that id has the new modules. Calling
 * the original after an upgrade reaches the old code, which is occasionally
 * what you want and almost never what you meant.
 */
export function callPackageId(manifest: DeploymentManifest): string {
  return manifest.upgrade?.packageId ?? manifest.packageId;
}

/**
 * Where a TYPE lives: always the original package.
 *
 * Move type identity is fixed at the address that first defined the struct. The
 * treasury shared in the first publish is still
 * `<original>::treasury::Treasury<<original>::mock_usdc::MOCK_USDC>` after any
 * number of upgrades, so type arguments and objectChanges filters must use this
 * — never the upgraded id.
 */
export function typePackageId(manifest: DeploymentManifest): string {
  return manifest.packageId;
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
    executeScheduled: `${packageId}::payment::execute_scheduled`,
    evaluate: `${packageId}::payment::evaluate`,
    // Added by the escrow upgrade. Reachable only on the upgraded package.
    requireShipment: `${packageId}::invoice::require_shipment_confirmation`,
    oracleIssue: `${packageId}::oracle::issue_to`,
    oracleAttest: `${packageId}::oracle::attest`,
    executeConditional: `${packageId}::escrow::execute_conditional`,
    executeConditionalApproved: `${packageId}::escrow::execute_conditional_approved`,
    escrowRelease: `${packageId}::escrow::release`,
    escrowRefund: `${packageId}::escrow::refund`,
    escrowReleasable: `${packageId}::escrow::releasable`,
  } as const;
}

/**
 * Where a module's types live.
 *
 * The distinction that matters: `callPackageId` answers "where do I send a
 * call", this answers "what will the created object's type string say". They
 * differ for every module that existed before the current version.
 */
export function modulePackageId(manifest: DeploymentManifest, moduleName: string): string {
  return manifest.moduleOrigins?.[moduleName] ?? manifest.packageId;
}

/**
 * Every struct type, each resolved against the version that defined its module.
 *
 * Prefer this over `structTypes` wherever a manifest is in hand. Passing one
 * package id for all of them is only correct before the first upgrade — it is
 * what made the escrow seed fail, looking for `<v1>::oracle::OracleCap` when
 * the chain had created `<v2>::oracle::OracleCap`.
 */
export function structTypesFor(manifest: DeploymentManifest) {
  const original = structTypes(manifest.packageId);
  return {
    ...original,
    paymentEscrow: `${modulePackageId(manifest, "escrow")}::escrow::PaymentEscrow`,
    oracleCap: `${modulePackageId(manifest, "oracle")}::oracle::OracleCap`,
    shipmentAttestation: `${modulePackageId(manifest, "oracle")}::oracle::ShipmentAttestation`,
  } as const;
}

/**
 * Struct types under ONE package id.
 *
 * Correct only when every module was defined by that version. After an upgrade
 * that adds modules, use `structTypesFor`.
 */
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
    // The escrow upgrade adds these. Their types anchor to the ORIGINAL package
    // id from the moment the upgraded code first creates one.
    paymentEscrow: `${packageId}::escrow::PaymentEscrow`,
    oracleCap: `${packageId}::oracle::OracleCap`,
    shipmentAttestation: `${packageId}::oracle::ShipmentAttestation`,
  } as const;
}

export function explorerObjectUrl(id: string, network: SuiNetwork): string {
  return `https://suiscan.xyz/${network}/object/${id}`;
}

export function explorerTxUrl(digest: string, network: SuiNetwork): string {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
