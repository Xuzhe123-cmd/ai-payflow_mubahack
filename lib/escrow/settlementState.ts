/**
 * Telling three situations apart after a transaction that mutates an object.
 *
 * A verification that reads the wrong thing can fail for three quite different
 * reasons, and the runner's response to each should be different:
 *
 *   FAILED    the transaction did not succeed. There is nothing to wait for.
 *   STALE     the transaction succeeded and the index has not caught up. Wait.
 *   MISMATCH  the index is current and the state is genuinely not what was
 *             expected. Stop and get a person.
 *
 * Collapsing STALE into MISMATCH is what made a successful $4,800 release read
 * as a failed one: the escrow was RELEASED on the fullnode while GraphQL still
 * served the previous version, and the runner reported "expected RELEASED,
 * found LOCKED" as though the chain had disagreed with it.
 *
 * The discriminator is the object VERSION. A transaction that mutates an object
 * bumps its version; if the index still reports the pre-transaction version,
 * it is behind, whatever its contents say. Where a version is unavailable the
 * classification falls back on the transaction's own success, which is known
 * independently of the index.
 */

export type SettlementVerdict =
  | { kind: "FAILED"; reason: string }
  | { kind: "STALE"; observedVersion: string | null; expectedAfter: string; detail: string }
  | { kind: "CURRENT" };

export interface ClassifyInput {
  /** Did the chain accept the transaction? Known without the indexer. */
  transactionSucceeded: boolean;
  transactionError?: string | null;
  /** The object's version BEFORE the transaction, if it was known. */
  versionBefore: string | null;
  /** The version the index currently reports, if it could be read. */
  versionNow: string | null;
  /** Whether the read already shows the expected state. */
  stateMatches: boolean;
}

/**
 * Whether a disagreeing read should be waited on or acted on.
 *
 * Returns CURRENT when the state matches, so a caller can verify normally.
 */
export function classifySettlement(input: ClassifyInput): SettlementVerdict {
  if (!input.transactionSucceeded) {
    return {
      kind: "FAILED",
      reason: input.transactionError ?? "the transaction did not succeed",
    };
  }

  if (input.stateMatches) return { kind: "CURRENT" };

  // The transaction succeeded, so the object HAS moved on. A read that still
  // shows the old version is behind, not contradicting.
  const behind =
    input.versionNow !== null &&
    input.versionBefore !== null &&
    sameVersion(input.versionNow, input.versionBefore);

  if (behind) {
    return {
      kind: "STALE",
      observedVersion: input.versionNow,
      expectedAfter: input.versionBefore!,
      detail:
        "the index still reports the version this object had BEFORE the transaction, " +
        "so it is serving a stale copy rather than disagreeing about the state",
    };
  }

  if (input.versionNow === null) {
    return {
      kind: "STALE",
      observedVersion: null,
      expectedAfter: input.versionBefore ?? "unknown",
      detail:
        "the object's current version could not be read, so staleness cannot be ruled out — " +
        "a successful transaction is stronger evidence than an unconfirmed read",
    };
  }

  // The version has moved and the state is still not what was expected. That is
  // a real disagreement and nothing further should be attempted on it.
  return { kind: "CURRENT" };
}

/** What to tell the operator when a read never caught up. */
export function describeStale(
  verdict: Extract<SettlementVerdict, { kind: "STALE" }>,
  objectId: string,
): string {
  return (
    `The transaction SUCCEEDED, but the GraphQL index has not caught up: ${verdict.detail}. ` +
    "This is not evidence that the settlement failed. Confirm directly against the fullnode " +
    `with:\n      sui client object ${objectId}`
  );
}

function sameVersion(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
