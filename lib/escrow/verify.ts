/**
 * Verifying what a transaction actually did, by re-reading it off chain.
 *
 * The runner these serve executes three transactions in sequence, and each one
 * spends real money or creates the authority to. So the rule between steps is
 * absolute: nothing proceeds on the strength of a transaction having been
 * *submitted*. It proceeds only after the resulting object has been read back
 * and found to say what it was supposed to say.
 *
 * Pure, because the runner cannot be tested without a chain and these can. Every
 * function takes what was read and what was expected, and returns a verdict —
 * no fetching, no submitting, no side effects.
 *
 * The bias throughout is toward refusing. A field that could not be read is a
 * failure, never a pass: an escrow whose status is unknown is not a locked one.
 */

import type { Cents } from "../types";

export interface VerificationCheck {
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface Verification {
  ok: boolean;
  checks: VerificationCheck[];
  /** The first failure, for a one-line refusal. */
  failure: string | null;
}

function verdict(checks: VerificationCheck[]): Verification {
  const failed = checks.find((check) => !check.passed);
  return {
    ok: !failed,
    checks,
    failure: failed ? `${failed.label}: expected ${failed.expected}, found ${failed.actual}` : null,
  };
}

function check(
  label: string,
  expected: string,
  actual: string,
  passed = expected === actual,
): VerificationCheck {
  return { label, passed, expected, actual };
}

/** What was read back from the chain after the lock. */
export interface ObservedEscrow {
  objectId: string;
  treasuryId: string;
  invoiceNumber: string;
  recipient: string;
  status: string;
  amountCents: Cents;
  heldCents: Cents;
}

export interface ExpectedEscrow {
  treasuryId: string;
  invoiceNumber: string;
  recipient: string;
  amountCents: Cents;
}

/**
 * The escrow the lock was supposed to create.
 *
 * `heldCents` is checked separately from `amountCents` because they answer
 * different questions: one is what the escrow says it is for, the other is what
 * it is actually holding. An escrow that records $4,800 and holds nothing is a
 * bug worth stopping on.
 */
export function verifyLockedEscrow(
  observed: ObservedEscrow | null,
  expected: ExpectedEscrow,
): Verification {
  if (!observed) {
    return verdict([
      check("escrow readable on chain", "an object", "nothing could be read", false),
    ]);
  }

  return verdict([
    check("escrow status", "LOCKED", observed.status),
    check("treasury", expected.treasuryId, observed.treasuryId, sameId(expected.treasuryId, observed.treasuryId)),
    check("invoice", expected.invoiceNumber, observed.invoiceNumber),
    check(
      "recipient",
      expected.recipient,
      observed.recipient,
      sameId(expected.recipient, observed.recipient),
    ),
    check("amount", money(expected.amountCents), money(observed.amountCents)),
    check("funds actually held", money(expected.amountCents), money(observed.heldCents)),
  ]);
}

export interface ObservedAttestation {
  attestationId: string | null;
  treasuryId: string | null;
  invoiceNumber: string;
  shipmentId: string;
  confirmed: boolean;
  proofSha256: string;
  expiresAtMs: number;
  oracleId: string;
}

export interface ExpectedAttestation {
  treasuryId: string;
  invoiceNumber: string;
  shipmentId: string;
  proofSha256: string;
  oracleId: string;
  nowMs: number;
}

/**
 * The attestation the oracle was supposed to make.
 *
 * The hash check is the one that matters most. An attestation whose digest does
 * not match the document that was stored is an attestation about some other
 * document, and releasing against it would mean the evidence chain proves
 * nothing.
 */
export function verifyAttestation(
  observed: ObservedAttestation | null,
  expected: ExpectedAttestation,
): Verification {
  if (!observed) {
    return verdict([
      check("attestation readable on chain", "an object", "nothing could be read", false),
    ]);
  }

  return verdict([
    check("confirmed", "true", String(observed.confirmed)),
    check("invoice", expected.invoiceNumber, observed.invoiceNumber),
    check("shipment", expected.shipmentId, observed.shipmentId),
    check(
      "treasury",
      expected.treasuryId,
      observed.treasuryId ?? "unreadable",
      observed.treasuryId !== null && sameId(expected.treasuryId, observed.treasuryId),
    ),
    check(
      "proof hash",
      expected.proofSha256.toLowerCase(),
      observed.proofSha256.toLowerCase(),
    ),
    check("oracle", expected.oracleId, observed.oracleId),
    check(
      "not expired",
      `expiry after ${expected.nowMs}`,
      String(observed.expiresAtMs),
      observed.expiresAtMs >= expected.nowMs,
    ),
  ]);
}

/**
 * The escrow after a release.
 *
 * Compared against what it looked like BEFORE, not only against expectations,
 * because the interesting property is that nothing moved except the status and
 * the balance. A release that also changed the recipient would be a different
 * and much worse event than a release that failed.
 */
export function verifyReleasedEscrow(
  before: ObservedEscrow,
  after: ObservedEscrow | null,
): Verification {
  if (!after) {
    return verdict([
      check("escrow readable after release", "an object", "nothing could be read", false),
    ]);
  }

  return verdict([
    check("escrow status", "RELEASED", after.status),
    check("escrow is now empty", "$0", money(after.heldCents)),
    // Nothing downstream of the lock may move these.
    check("recipient unchanged", before.recipient, after.recipient, sameId(before.recipient, after.recipient)),
    check("amount unchanged", money(before.amountCents), money(after.amountCents)),
    check("invoice unchanged", before.invoiceNumber, after.invoiceNumber),
    check("treasury unchanged", before.treasuryId, after.treasuryId, sameId(before.treasuryId, after.treasuryId)),
  ]);
}

export interface HeldEscrowExpectation {
  treasuryId: string;
  invoiceNumber: string;
  recipient: string;
  amountCents: Cents;
  /** The invoice's own status, read from chain. */
  invoiceStatus: string | null;
  /** Whether any attestation exists for this invoice. */
  attestationExists: boolean;
  /** The supplier's balance before and after — must not have moved. */
  supplierBalanceBeforeCents: Cents;
  supplierBalanceAfterCents: Cents;
}

/**
 * An escrow that is holding funds and must stay that way.
 *
 * The mirror of `verifyReleasedEscrow`, and the more interesting one. Demo B's
 * whole claim is a negative: the payment was authorised, the money left the
 * treasury, and the supplier still does not have it. Negatives are easy to
 * assert loosely — "no error occurred" would pass on a system that did nothing
 * at all — so each one here names the thing that must NOT have happened.
 */
export function verifyHeldEscrow(
  observed: ObservedEscrow | null,
  expected: HeldEscrowExpectation,
  attestationId: string | null,
): Verification {
  if (!observed) {
    return verdict([
      check("escrow readable on chain", "an object", "nothing could be read", false),
    ]);
  }

  return verdict([
    check("escrow status", "LOCKED", observed.status),
    check("escrow still holds the funds", money(expected.amountCents), money(observed.heldCents)),
    check("amount", money(expected.amountCents), money(observed.amountCents)),
    check("invoice", expected.invoiceNumber, observed.invoiceNumber),
    check(
      "recipient",
      expected.recipient,
      observed.recipient,
      sameId(expected.recipient, observed.recipient),
    ),
    check(
      "treasury",
      expected.treasuryId,
      observed.treasuryId,
      sameId(expected.treasuryId, observed.treasuryId),
    ),
    // The three negatives the demo rests on.
    check("no attestation linked", "none", attestationId ?? "none", attestationId === null),
    check(
      "no attestation exists for this invoice",
      "none",
      expected.attestationExists ? "one exists" : "none",
      !expected.attestationExists,
    ),
    check(
      "invoice is NOT paid",
      "anything but PAID",
      expected.invoiceStatus ?? "unreadable",
      expected.invoiceStatus !== null && expected.invoiceStatus !== "PAID",
    ),
    check(
      "supplier balance unchanged",
      money(expected.supplierBalanceBeforeCents),
      money(expected.supplierBalanceAfterCents),
      expected.supplierBalanceBeforeCents === expected.supplierBalanceAfterCents,
    ),
  ]);
}

/**
 * That the supplier is better off by exactly the escrow amount.
 *
 * Measured as a delta across the release rather than as an absolute balance:
 * the supplier wallet may hold coins from earlier demos, and "has at least
 * $4,800" would pass on money that arrived last week.
 */
export function verifySupplierPaid(input: {
  balanceBeforeCents: Cents;
  balanceAfterCents: Cents;
  amountCents: Cents;
}): Verification {
  const delta = input.balanceAfterCents - input.balanceBeforeCents;
  return verdict([
    check("supplier balance increased by the escrow amount", money(input.amountCents), money(delta)),
  ]);
}

/** Sui addresses compare equal across padding and case. */
function sameId(a: string, b: string): boolean {
  const norm = (v: string) =>
    `0x${v.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "").padStart(64, "0")}`;
  return norm(a) === norm(b);
}

function money(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}
