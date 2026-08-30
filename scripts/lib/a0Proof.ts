/**
 * Verifying the Scenario A0 proof that already exists.
 *
 * A0 claims the agent can settle a payment inside its own authority. That was
 * proven once, for real, and the proving made itself unrepeatable: INV-2026-3455
 * is now permanently PAID, so check 8 refuses any further attempt. A verifier
 * that keeps dry-running the payment reports `abort 8` forever and calls a
 * working system broken.
 *
 * So A0 is verified from evidence instead. The important part is what that must
 * NOT be allowed to mean. "The invoice is PAID, therefore PASS" would accept an
 * invoice paid by anyone, for any amount, to any address, at any time. The
 * question is narrower: was it paid by OUR transaction, autonomously, for the
 * amount claimed, to the registered supplier?
 *
 * That is why the frozen `PaymentRecord` is the anchor. Move wrote it in the
 * same transaction as the transfer and froze it, so it cannot be edited, and it
 * carries the authority the payment ran under. Checking it turns "the invoice is
 * paid" into "this specific payment happened, under agent authority".
 */

import type { Cents } from "../../lib/types";

/** What the manifest claims, and what the chain says about it. */
export interface A0ProofInput {
  /** The recorded proof. Null when the manifest has none. */
  claim: {
    invoiceNumber: string;
    amountCents: Cents;
    digest: string;
    packageId: string;
    module: string;
    function: string;
    invoiceObjectId: string;
    paymentRecordId: string;
    supplierId: string;
    recipient: string;
    authority: number;
  } | null;
  /** The transaction, as the chain reports it. */
  transaction: { exists: boolean; status: string | null } | null;
  /** The frozen PaymentRecord, as the chain reports it. Null when absent. */
  record: {
    invoiceNumber: string;
    amountCents: Cents;
    recipient: string;
    supplierId: string;
    authority: number;
    /** The type's package — the ORIGINAL, for a record created pre-upgrade. */
    packageId: string | null;
  } | null;
  /** Live invoice status, read from the chain. */
  invoiceStatus: string | null;
  /** The agent's on-chain single-payment ceiling. */
  agentCapCents: Cents;
  /** The wallet the registry currently holds for the supplier. */
  registeredRecipient: string | null;
}

export type A0ProofVerdict =
  | { kind: "PROVEN" }
  /** The invoice is settled, but not by anything we can vouch for. */
  | { kind: "PAID_UNVERIFIED"; reason: string }
  | { kind: "NO_CLAIM" }
  | { kind: "TRANSACTION_MISSING"; digest: string }
  | { kind: "TRANSACTION_FAILED"; digest: string; status: string | null }
  | { kind: "MISMATCH"; reason: string };

/** AUTHORITY_AGENT in payflow::limits. A0 is the autonomous claim. */
export const AUTHORITY_AGENT = 0;

/**
 * Decides whether the recorded proof genuinely establishes A0.
 *
 * Pure, so the failure modes are testable without a network — which matters,
 * because the failure modes are the point. Anything short of a complete match
 * is a distinct verdict rather than a shrug.
 */
export function verifyA0Proof(input: A0ProofInput): A0ProofVerdict {
  const { claim, transaction, record, invoiceStatus, agentCapCents } = input;

  // The invoice being paid with nothing recorded about it is precisely the
  // case this function exists to refuse.
  if (!claim) {
    return invoiceStatus === "PAID"
      ? {
          kind: "PAID_UNVERIFIED",
          reason:
            "the invoice is PAID on chain but the manifest records no A0 proof, so nothing " +
            "establishes WHY it is paid",
        }
      : { kind: "NO_CLAIM" };
  }

  if (!transaction || !transaction.exists) {
    return { kind: "TRANSACTION_MISSING", digest: claim.digest };
  }
  if (transaction.status !== "success") {
    return { kind: "TRANSACTION_FAILED", digest: claim.digest, status: transaction.status };
  }

  // A transaction that succeeded proves something happened. The record proves
  // WHAT happened.
  if (!record) {
    return {
      kind: "MISMATCH",
      reason: `PaymentRecord ${claim.paymentRecordId} does not exist on chain`,
    };
  }

  if (record.invoiceNumber !== claim.invoiceNumber) {
    return {
      kind: "MISMATCH",
      reason: `the payment record settles ${record.invoiceNumber}, not ${claim.invoiceNumber}`,
    };
  }
  if (record.amountCents !== claim.amountCents) {
    return {
      kind: "MISMATCH",
      reason: `the payment record is for ${record.amountCents} cents, the claim says ${claim.amountCents}`,
    };
  }
  if (!sameAddress(record.recipient, claim.recipient)) {
    return {
      kind: "MISMATCH",
      reason: `the payment record paid ${record.recipient}, the claim says ${claim.recipient}`,
    };
  }
  if (record.supplierId !== claim.supplierId) {
    return {
      kind: "MISMATCH",
      reason: `the payment record names supplier ${record.supplierId}, the claim says ${claim.supplierId}`,
    };
  }

  // The whole claim of A0: no human was involved.
  if (record.authority !== AUTHORITY_AGENT) {
    return {
      kind: "MISMATCH",
      reason:
        `the payment ran under authority ${record.authority}, not AGENT — ` +
        "this was not an autonomous payment, so it does not prove A0",
    };
  }

  // The payment had to be inside the agent's ceiling for the agent to have made
  // it. Move already enforced this; re-stating it is what makes the report a
  // demonstration rather than an assertion.
  if (claim.amountCents > agentCapCents) {
    return {
      kind: "MISMATCH",
      reason: `${claim.amountCents} cents exceeds the agent cap of ${agentCapCents} cents`,
    };
  }

  // The registry may have been re-pointed since; if so, say so rather than
  // silently comparing against a wallet that no longer means anything.
  if (
    input.registeredRecipient &&
    !sameAddress(input.registeredRecipient, record.recipient)
  ) {
    return {
      kind: "MISMATCH",
      reason:
        `the payment went to ${record.recipient}, but the registry now holds ` +
        `${input.registeredRecipient} for ${record.supplierId}`,
    };
  }

  if (invoiceStatus !== "PAID") {
    return {
      kind: "MISMATCH",
      reason: `the transaction succeeded but the invoice reads ${invoiceStatus ?? "unknown"}, not PAID`,
    };
  }

  return { kind: "PROVEN" };
}

/**
 * Whether the proof's package is the one currently deployed.
 *
 * Informational, deliberately NOT part of the verdict. An upgrade publishes a
 * new package id; a transaction that ran before it still ran, and expecting
 * historical evidence to point at the current version would invalidate every
 * proof on every upgrade.
 */
export function describeProofPackage(
  proofPackageId: string,
  currentPackageId: string,
  originalPackageId: string,
): string {
  if (proofPackageId === currentPackageId) return "current package";
  if (proofPackageId === originalPackageId) {
    return "original package (executed before the upgrade — still valid evidence)";
  }
  return "a package this manifest does not recognise";
}

export function describeA0Proof(verdict: A0ProofVerdict): string {
  switch (verdict.kind) {
    case "PROVEN":
      return "previously accepted by every on-chain check — existing A0 proof verified";
    case "NO_CLAIM":
      return "no A0 proof is recorded and the invoice is not paid";
    case "PAID_UNVERIFIED":
      return verdict.reason;
    case "TRANSACTION_MISSING":
      return `transaction ${verdict.digest} does not exist on chain`;
    case "TRANSACTION_FAILED":
      return `transaction ${verdict.digest} is on chain with status ${verdict.status ?? "unknown"}, not success`;
    case "MISMATCH":
      return `the recorded proof does not match the chain: ${verdict.reason}`;
  }
}

function sameAddress(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function normalise(address: string): string {
  const body = address.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return `0x${body.padStart(64, "0")}`;
}
