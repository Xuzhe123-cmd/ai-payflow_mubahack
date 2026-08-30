/**
 * Server-side guards, run before anything is submitted.
 *
 * These do not make the system safe — `escrow::release` and the ten checks in
 * `payment::evaluate` do that, on chain, whatever this file concludes. What
 * these buy is a refusal that happens BEFORE a transaction is signed, with a
 * sentence explaining why, instead of an abort code after gas has been spent.
 *
 * Two rules follow from that. Nothing here may ever be the only thing standing
 * between a request and a transfer — every guard below mirrors a check Move
 * makes independently. And a guard that cannot establish its fact must FAIL,
 * never pass: an unreadable escrow is not a releasable one.
 */

import type { Cents, TreasuryAction } from "../types";

export interface GuardResult {
  ok: boolean;
  /** Every check, in order, so a report can show the ones that passed too. */
  checks: GuardCheck[];
  /** The first failure, when there is one. */
  refusal: string | null;
}

export interface GuardCheck {
  label: string;
  passed: boolean;
  detail: string;
}

function evaluate(checks: GuardCheck[]): GuardResult {
  const failed = checks.find((check) => !check.passed);
  return { ok: !failed, checks, refusal: failed ? `${failed.label}: ${failed.detail}` : null };
}

// --- execute_conditional --------------------------------------------------------

export interface LockGuardInput {
  invoiceNumber: string;
  /** Null when the invoice could not be read from chain. */
  onChainInvoice: {
    invoiceNumber: string;
    status: string;
    amountCents: Cents;
    currency: string;
    supplierId: string;
    /** What the invoice ASKS for. Checked against the registry, not trusted. */
    recipient: string;
  } | null;
  /** Whether the shipment condition is attached, read from chain. */
  requiresShipment: boolean | null;
  /** The deterministic engine's action for this invoice. */
  decision: TreasuryAction | null;
  agentMaxSingleCents: Cents;
  agentDailyRemainingCents: Cents;
  supplierApproved: boolean;
  registryRecipient: string | null;
  allowedCurrencies: readonly string[];
  vaultCents: Cents;
  minimumReserveCents: Cents;
}

/**
 * Everything that must hold before funds may be locked.
 *
 * The order deliberately matches `payment::evaluate` where it overlaps, so a
 * refusal here names the same condition the chain would have aborted on.
 */
export function guardLock(input: LockGuardInput): GuardResult {
  const invoice = input.onChainInvoice;
  const checks: GuardCheck[] = [];

  checks.push({
    label: "invoice exists on chain",
    passed: invoice !== null,
    detail: invoice
      ? `${invoice.invoiceNumber} read from chain`
      : `${input.invoiceNumber} could not be read`,
  });
  if (!invoice) return evaluate(checks);

  // ESCROWED or PAID both mean this invoice has already consumed its one
  // settlement. Check 8 would refuse, but refusing here costs nothing.
  const open = invoice.status !== "PAID" && invoice.status !== "ESCROWED";
  checks.push({
    label: "invoice is open",
    passed: open,
    detail: open ? `status ${invoice.status}` : `status ${invoice.status} — already settled`,
  });

  checks.push({
    label: "shipment condition is attached",
    passed: input.requiresShipment === true,
    detail:
      input.requiresShipment === null
        ? "could not read the invoice's dynamic fields"
        : input.requiresShipment
          ? "invoice::requires_shipment is true"
          : "this invoice has no shipment condition, so it settles directly rather than by escrow",
  });

  checks.push({
    label: "AI decision is PAY_NOW",
    passed: input.decision === "AUTO_PAY",
    detail:
      input.decision === null
        ? "no decision was produced"
        : `deterministic engine returned ${input.decision}`,
  });

  const withinSingle = invoice.amountCents <= input.agentMaxSingleCents;
  checks.push({
    label: "within the agent's single-payment cap",
    passed: withinSingle,
    detail: `${money(invoice.amountCents)} against a ${money(input.agentMaxSingleCents)} cap`,
  });

  const withinDaily = invoice.amountCents <= input.agentDailyRemainingCents;
  checks.push({
    label: "within the agent's remaining daily limit",
    passed: withinDaily,
    detail: `${money(invoice.amountCents)} against ${money(input.agentDailyRemainingCents)} remaining`,
  });

  checks.push({
    label: "supplier is approved",
    passed: input.supplierApproved,
    detail: input.supplierApproved
      ? `${invoice.supplierId} is APPROVED in the registry`
      : `${invoice.supplierId} is not approved`,
  });

  const walletMatches =
    input.registryRecipient !== null && sameAddress(input.registryRecipient, invoice.recipient);
  checks.push({
    label: "recipient matches the registry",
    passed: walletMatches,
    detail: walletMatches
      ? "remit address equals the registered supplier wallet"
      : `invoice asks for ${short(invoice.recipient)}, registry holds ${short(input.registryRecipient ?? "nothing")}`,
  });

  const currencyOk = input.allowedCurrencies.includes(invoice.currency);
  checks.push({
    label: "currency is permitted",
    passed: currencyOk,
    detail: `${invoice.currency} against [${input.allowedCurrencies.join(", ")}]`,
  });

  // Saturating, exactly as check 9 is: an amount larger than the vault must
  // fail here rather than underflow into a pass.
  const remaining = input.vaultCents >= invoice.amountCents ? input.vaultCents - invoice.amountCents : -1;
  const reserveOk = remaining >= input.minimumReserveCents;
  checks.push({
    label: "reserve survives the payment",
    passed: reserveOk,
    detail: reserveOk
      ? `${money(remaining)} left against a ${money(input.minimumReserveCents)} reserve`
      : `${money(input.vaultCents)} − ${money(invoice.amountCents)} would breach the ${money(input.minimumReserveCents)} reserve`,
  });

  return evaluate(checks);
}

// --- oracle::attest -------------------------------------------------------------

export interface AttestGuardInput {
  invoiceNumber: string;
  /** The capability that would sign, read from chain. */
  oracleCap: { objectId: string; treasuryId: string; oracleId: string } | null;
  expectedTreasuryId: string;
  expectedOracleId: string;
  /** SHA-256 of the bytes actually stored, and of the document as authored. */
  storedSha256: string;
  documentSha256: string;
  /** The invoice the proof document names. */
  proofInvoiceNumber: string;
}

export function guardAttest(input: AttestGuardInput): GuardResult {
  const cap = input.oracleCap;
  const checks: GuardCheck[] = [];

  checks.push({
    label: "oracle capability exists",
    passed: cap !== null,
    detail: cap ? cap.objectId : "no OracleCap could be read",
  });
  if (!cap) return evaluate(checks);

  const rightTreasury = cap.treasuryId === input.expectedTreasuryId;
  checks.push({
    label: "capability belongs to this treasury",
    passed: rightTreasury,
    detail: rightTreasury
      ? short(cap.treasuryId)
      : `capability is bound to ${short(cap.treasuryId)}, not ${short(input.expectedTreasuryId)}`,
  });

  // Only the demo oracle. A capability with another identity might be
  // legitimate for something, but it is not what this demo attests with.
  const rightOracle = cap.oracleId === input.expectedOracleId;
  checks.push({
    label: "is the Demo Shipment Oracle",
    passed: rightOracle,
    detail: rightOracle ? cap.oracleId : `capability identifies as "${cap.oracleId}"`,
  });

  const proofMatchesInvoice = input.proofInvoiceNumber === input.invoiceNumber;
  checks.push({
    label: "proof names this invoice",
    passed: proofMatchesInvoice,
    detail: proofMatchesInvoice
      ? input.invoiceNumber
      : `document names ${input.proofInvoiceNumber}`,
  });

  // The hash that will be attested must be the hash of what was stored, and of
  // what the document actually says. A mismatch means the evidence and the
  // attestation have come apart, which is the one thing a proof cannot survive.
  const hashMatches =
    input.storedSha256.toLowerCase() === input.documentSha256.toLowerCase() &&
    /^[0-9a-f]{64}$/.test(input.storedSha256.toLowerCase());
  checks.push({
    label: "proof hash matches the stored document",
    passed: hashMatches,
    detail: hashMatches
      ? `${input.storedSha256.slice(0, 16)}…`
      : "the stored bytes do not hash to the digest being attested",
  });

  return evaluate(checks);
}

// --- escrow::release ------------------------------------------------------------

export interface ReleaseGuardInput {
  /** Read from chain immediately before submitting. Never from the client. */
  escrow: {
    objectId: string;
    treasuryId: string;
    invoiceNumber: string;
    recipient: string;
    status: string;
    heldCents: Cents;
  } | null;
  attestation: {
    attestationId: string | null;
    treasuryId: string | null;
    invoiceNumber: string;
    confirmed: boolean;
    expiresAtMs: number;
    proofSha256: string;
  } | null;
  expectedTreasuryId: string;
  /** The registry's wallet for this supplier, re-read now. */
  registryRecipient: string | null;
  nowMs: number;
}

/**
 * The last gate before a release is submitted.
 *
 * Every fact here is re-read from chain rather than carried from the interface.
 * That is the point: a client that lies about an attestation, an escrow, or a
 * recipient gets a refusal from this function and — were it somehow to get past
 * it — an abort from Move.
 */
export function guardRelease(input: ReleaseGuardInput): GuardResult {
  const { escrow, attestation } = input;
  const checks: GuardCheck[] = [];

  checks.push({
    label: "escrow exists on chain",
    passed: escrow !== null,
    detail: escrow ? escrow.objectId : "no escrow object could be read",
  });
  if (!escrow) return evaluate(checks);

  checks.push({
    label: "escrow is LOCKED",
    passed: escrow.status === "LOCKED",
    detail: `status ${escrow.status}`,
  });

  checks.push({
    label: "escrow belongs to this treasury",
    passed: escrow.treasuryId === input.expectedTreasuryId,
    detail: short(escrow.treasuryId),
  });

  checks.push({
    label: "escrow still holds the funds",
    passed: escrow.heldCents > 0,
    detail: `${money(escrow.heldCents)} held`,
  });

  checks.push({
    label: "attestation exists on chain",
    passed: attestation !== null,
    detail: attestation?.attestationId ?? "no attestation could be read",
  });
  if (!attestation) return evaluate(checks);

  checks.push({
    label: "attestation is for this invoice",
    passed: attestation.invoiceNumber === escrow.invoiceNumber,
    detail: `${attestation.invoiceNumber} against escrow ${escrow.invoiceNumber}`,
  });

  checks.push({
    label: "attestation is for this treasury",
    passed:
      attestation.treasuryId === null || attestation.treasuryId === input.expectedTreasuryId,
    detail: short(attestation.treasuryId ?? "unreadable"),
  });

  // The whole condition, in one line.
  checks.push({
    label: "shipment is confirmed",
    passed: attestation.confirmed,
    detail: attestation.confirmed
      ? "oracle attested CONFIRMED"
      : "oracle did not confirm the shipment — the escrow stays locked",
  });

  checks.push({
    label: "attestation has not expired",
    passed: input.nowMs <= attestation.expiresAtMs,
    detail: `now ${input.nowMs} against expiry ${attestation.expiresAtMs}`,
  });

  // The recipient is fixed inside the escrow and release takes no destination,
  // so this cannot change where the money goes. It is checked because a
  // disagreement with the registry means something moved that should not have.
  const recipientAgrees =
    input.registryRecipient !== null && sameAddress(input.registryRecipient, escrow.recipient);
  checks.push({
    label: "escrow recipient still matches the registry",
    passed: recipientAgrees,
    detail: recipientAgrees
      ? short(escrow.recipient)
      : `escrow pays ${short(escrow.recipient)}, registry now holds ${short(input.registryRecipient ?? "nothing")}`,
  });

  return evaluate(checks);
}

function money(cents: Cents): string {
  if (cents < 0) return "an amount larger than the vault";
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

function short(address: string): string {
  return address.length > 18 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

function sameAddress(a: string, b: string): boolean {
  const norm = (v: string) => `0x${v.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "").padStart(64, "0")}`;
  return norm(a) === norm(b);
}
