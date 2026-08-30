/**
 * The exact Move calls the conditional-payment demo would submit.
 *
 * Built as data rather than executed, for two reasons. It makes the package-id
 * rules testable without a network — and those rules have already broken this
 * project once, when a seed looked for a v1 `OracleCap` that the chain had
 * created at v2. And it lets the interface show a judge precisely what would be
 * sent before anything is sent.
 *
 * THE THREE PACKAGE IDS, which are genuinely all different here:
 *   callPackageId    where the call goes — the newest version (v2)
 *   coinType         the settlement coin, defined by the ORIGINAL publish (v1)
 *   structTypesFor   each object type at the version that DEFINED its module,
 *                    so OracleCap is v2 while Invoice is v1
 */

import {
  callPackageId,
  structTypesFor,
  type DeploymentManifest,
} from "../sui/deployment";
import { centsToUnitsString } from "../sui/units";
import type { Cents } from "../types";

export interface MoveCallPlan {
  /** What this step accomplishes, for the interface. */
  label: string;
  packageId: string;
  module: string;
  function: string;
  typeArguments: string[];
  /** Arguments in order. `0x6` is the shared Clock. */
  arguments: string[];
  /** The type of object this call is expected to create, if any. */
  createsType: string | null;
}

const CLOCK = "0x6";

/**
 * How the Sui CLI wants an `Option<T>` argument.
 *
 * Verified against the deployed package by dry run: `[]` is None and
 * `["value"]` is Some. A bare string — the obvious guess — is rejected with
 * `CommandArgumentError { kind: InvalidBCSBytes }`, which names the argument
 * index and nothing about why.
 */
function optionArg(value: string | null): string {
  return value === null || value.length === 0 ? "[]" : JSON.stringify([value]);
}
/** payment::no_expiry() — an immediate payment carries no recommendation TTL. */
const NO_EXPIRY = "18446744073709551615";

export interface ConditionalPaymentInput {
  manifest: DeploymentManifest;
  invoiceObjectId: string;
  amountCents: Cents;
  recipient: string;
  recommendationId: string;
  recommendedAtMs: number;
}

/**
 * Locks the funds. Runs the identical ten checks `execute_payment` runs.
 *
 * The agent capability is passed because this is the agent's own authority —
 * the same capability, the same limits, the same abort codes. What differs is
 * only where the money lands.
 */
export function lockCall(input: ConditionalPaymentInput): MoveCallPlan {
  const { manifest } = input;
  const types = structTypesFor(manifest);
  return {
    label: `Lock ${formatMoney(input.amountCents)} into escrow`,
    packageId: callPackageId(manifest),
    module: "escrow",
    function: "execute_conditional",
    // The settlement coin keeps the ORIGINAL package id.
    typeArguments: [manifest.coinType],
    arguments: [
      manifest.objects.treasuryId,
      manifest.objects.agentCapId,
      manifest.objects.supplierRegistryId,
      input.invoiceObjectId,
      centsToUnitsString(input.amountCents),
      input.recipient,
      input.recommendationId,
      String(input.recommendedAtMs),
      NO_EXPIRY,
      CLOCK,
    ],
    createsType: types.paymentEscrow,
  };
}

export interface AttestInput {
  manifest: DeploymentManifest;
  invoiceNumber: string;
  shipmentId: string;
  confirmed: boolean;
  proofBlobId: string;
  /** Lowercase hex, no 0x. Passed to Move as a vector<u8>. */
  proofSha256: string;
  deliveredAtMs: number;
  validForMs: number;
  /** ADVISORY. Recorded for audit; `release` never reads it. */
  aiAssessment: string | null;
}

/**
 * The oracle's statement.
 *
 * Note what is NOT here: no treasury argument, no escrow, no recipient, no
 * amount. The capability supplies the treasury and the attestation carries only
 * a claim about the world. An oracle holding this call cannot move anything.
 */
export function attestCall(input: AttestInput): MoveCallPlan {
  const { manifest } = input;
  const types = structTypesFor(manifest);
  const capId = manifest.escrowDemo?.oracleCapId ?? "<oracle cap not seeded>";
  return {
    label: input.confirmed
      ? `Attest shipment ${input.shipmentId} CONFIRMED`
      : `Attest shipment ${input.shipmentId} NOT CONFIRMED`,
    packageId: callPackageId(manifest),
    module: "oracle",
    function: "attest",
    typeArguments: [],
    arguments: [
      capId,
      input.invoiceNumber,
      input.shipmentId,
      String(input.confirmed),
      input.proofBlobId,
      `0x${input.proofSha256}`,
      String(input.deliveredAtMs),
      String(input.validForMs),
      optionArg(input.aiAssessment),
      CLOCK,
    ],
    createsType: types.shipmentAttestation,
  };
}

export interface ReleaseInput {
  manifest: DeploymentManifest;
  escrowObjectId: string;
  attestationObjectId: string;
  invoiceObjectId: string;
}

/**
 * Pays the supplier.
 *
 * There is no recipient argument, and that absence is the security property:
 * the destination was fixed inside the escrow when the funds were locked, from
 * an address that had just passed the registry check. Nothing a caller passes
 * here can redirect a cent.
 */
export function releaseCall(input: ReleaseInput): MoveCallPlan {
  return {
    label: "Release the escrow to the registered supplier wallet",
    packageId: callPackageId(input.manifest),
    module: "escrow",
    function: "release",
    typeArguments: [input.manifest.coinType],
    arguments: [
      input.manifest.objects.treasuryId,
      input.escrowObjectId,
      input.attestationObjectId,
      input.invoiceObjectId,
      CLOCK,
    ],
    createsType: null,
  };
}

/** Renders a plan as the CLI command it corresponds to. */
export function renderPlan(plan: MoveCallPlan): string {
  const typeArgs =
    plan.typeArguments.length > 0 ? ` --type-args ${plan.typeArguments.join(" ")}` : "";
  const args = plan.arguments.map((value) => `"${value}"`).join(" ");
  return (
    `sui client call --package ${plan.packageId} --module ${plan.module} ` +
    `--function ${plan.function}${typeArgs} --args ${args}`
  );
}

function formatMoney(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}
