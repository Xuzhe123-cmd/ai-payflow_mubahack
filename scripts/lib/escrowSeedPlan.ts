/**
 * Deciding what the escrow seed still has to do.
 *
 * Pulled out as a pure function because the interesting behaviour is resumption
 * after a partial run, and that is exactly the behaviour hardest to test
 * against a live chain: reproducing "half the objects exist" on testnet means
 * creating objects, which is the thing being guarded against.
 *
 * The failure this exists to prevent already happened once. The seed issued a
 * real OracleCap, failed to recognise the created object because it looked for
 * the wrong package's type, and exited without recording anything — leaving a
 * capability on chain that the manifest did not know about. Re-running would
 * have issued a second one.
 *
 * So the rule here is: nothing is created that already exists, and existence is
 * established from chain state rather than from the manifest alone.
 */

export interface ExistingOracleCap {
  objectId: string;
  /** Full type string, as the chain reports it. */
  objectType: string;
  owner: string | null;
  treasuryId: string | null;
  oracleId: string | null;
}

export interface OracleCapExpectation {
  /** `<defining package>::oracle::OracleCap`. */
  expectedType: string;
  expectedTreasuryId: string;
  expectedOwner: string;
  expectedOracleId: string;
}

export type OracleCapDecision =
  /** Nothing suitable exists; issue one. */
  | { kind: "ISSUE" }
  /** A valid capability is already on chain. Reuse it. */
  | { kind: "REUSE"; objectId: string }
  /** Something is there but wrong. Stop rather than issue a second one. */
  | { kind: "CONFLICT"; objectId: string; reason: string };

/**
 * Whether the oracle capability still needs issuing.
 *
 * A mismatch is deliberately NOT treated as "issue a fresh one". Two
 * capabilities for one treasury is a worse state than none, and the reason for
 * the mismatch is nearly always a mistake worth reading rather than routing
 * around.
 */
export function decideOracleCap(
  existing: ExistingOracleCap | null,
  expected: OracleCapExpectation,
): OracleCapDecision {
  if (!existing) return { kind: "ISSUE" };

  if (existing.objectType !== expected.expectedType) {
    return {
      kind: "CONFLICT",
      objectId: existing.objectId,
      reason:
        `its type is ${existing.objectType}, not ${expected.expectedType} — ` +
        "the manifest's module origins disagree with the chain",
    };
  }
  if (existing.treasuryId && existing.treasuryId !== expected.expectedTreasuryId) {
    return {
      kind: "CONFLICT",
      objectId: existing.objectId,
      reason: `it is bound to treasury ${existing.treasuryId}, not ${expected.expectedTreasuryId}`,
    };
  }
  if (existing.owner && existing.owner !== expected.expectedOwner) {
    return {
      kind: "CONFLICT",
      objectId: existing.objectId,
      reason: `it is owned by ${existing.owner}, not the active address ${expected.expectedOwner}`,
    };
  }
  if (existing.oracleId && existing.oracleId !== expected.expectedOracleId) {
    return {
      kind: "CONFLICT",
      objectId: existing.objectId,
      reason: `its oracle_id is "${existing.oracleId}", not "${expected.expectedOracleId}"`,
    };
  }

  return { kind: "REUSE", objectId: existing.objectId };
}

export interface PlannedInvoice {
  invoiceNumber: string;
  amountCents: number;
}

export interface InvoiceDecision {
  invoiceNumber: string;
  /** False when an invoice with this number is already on chain. */
  create: boolean;
  existingObjectId: string | null;
}

/**
 * Which invoices still need creating.
 *
 * Keyed by invoice NUMBER rather than object id, because the number is what
 * the treasury's replay ledger and check 8 key on — two objects carrying one
 * number is the duplicate that matters, whatever their ids.
 */
export function decideInvoices(
  planned: readonly PlannedInvoice[],
  onChain: readonly { invoiceNumber: string; objectId: string }[],
): InvoiceDecision[] {
  const existing = new Map(onChain.map((entry) => [entry.invoiceNumber, entry.objectId]));
  return planned.map((plan) => {
    const found = existing.get(plan.invoiceNumber) ?? null;
    return {
      invoiceNumber: plan.invoiceNumber,
      create: found === null,
      existingObjectId: found,
    };
  });
}

/** Nothing left to do. */
export function seedIsComplete(
  oracle: OracleCapDecision,
  invoices: readonly InvoiceDecision[],
): boolean {
  return oracle.kind === "REUSE" && invoices.every((invoice) => !invoice.create);
}
