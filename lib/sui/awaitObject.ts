/**
 * Reading back an object that was created moments ago.
 *
 * Sui's GraphQL endpoint is an INDEXER, and it trails the fullnode by a few
 * checkpoints. A transaction can succeed, return a created object id, and have
 * that object be unreadable through GraphQL for the next second or two — the
 * object exists, the index simply has not caught up.
 *
 * This bit us for real. The Demo A runner locked $4,800, captured the escrow id
 * correctly, read it back immediately, got nothing, and halted with "escrow
 * readable on chain — found nothing could be read". The escrow was fine; the
 * read was early. Diagnosis: the lock landed in checkpoint 377857633 while the
 * indexer was still behind it.
 *
 * So a read-back is not a single query. It retries, and — this is the part that
 * matters — a read that never resolves is reported as UNRESOLVED rather than as
 * absence. "I could not see it" and "it is not there" are different facts, and
 * a runner that confuses them will either halt on a healthy chain or continue
 * on a broken one.
 *
 * IT HAPPENED TWICE, in two different shapes. The first was an object that did
 * not exist in the index yet, which `awaitObject` handles. The second was worse
 * and is what `awaitCondition` is for: after the release, the escrow DID exist
 * in the index — at its previous version, still reading LOCKED with $4,800 in
 * it. Retrying on null does nothing there, because the read succeeds; it just
 * answers with yesterday's state. Waiting for existence is not the same as
 * waiting for a CHANGE, and a released escrow was reported as an unreleased one
 * on the strength of that difference.
 */

export type ObjectReader<T> = () => Promise<T | null>;

export interface AwaitOptions {
  /** How many times to look before giving up. */
  attempts?: number;
  /** Delay before the first retry; doubles each time, to a ceiling. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, for progress output. */
  onRetry?: (attempt: number, delayMs: number) => void;
}

export type AwaitResult<T> =
  /** Found, with the number of attempts it took. */
  | { kind: "FOUND"; value: T; attempts: number }
  /**
   * Never became readable. Deliberately NOT "absent": the object may exist and
   * be unindexed, and a caller must not treat this as proof it does not.
   */
  | { kind: "UNRESOLVED"; attempts: number; waitedMs: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries a read until it returns something, with exponential backoff.
 *
 * Only null is retried. An exception is a different kind of problem — a
 * malformed object, an unreachable endpoint — and is left to the caller rather
 * than swallowed into a timeout.
 */
export async function awaitObject<T>(
  read: ObjectReader<T>,
  options: AwaitOptions = {},
): Promise<AwaitResult<T>> {
  const attempts = options.attempts ?? 8;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const sleep = options.sleep ?? defaultSleep;

  let delay = initialDelayMs;
  let waitedMs = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined) {
      return { kind: "FOUND", value, attempts: attempt };
    }

    if (attempt === attempts) break;

    options.onRetry?.(attempt, delay);
    await sleep(delay);
    waitedMs += delay;
    delay = Math.min(delay * 2, maxDelayMs);
  }

  return { kind: "UNRESOLVED", attempts, waitedMs };
}

export type ConditionResult<T> =
  /** The predicate held. */
  | { kind: "SATISFIED"; value: T; attempts: number }
  /**
   * The object was readable throughout, and never became what was expected.
   *
   * `last` is the most recent read, so a caller can say what it DID see. This
   * is deliberately not called a mismatch: whether the state is wrong or merely
   * stale is not something this function can tell, and the caller usually can.
   */
  | { kind: "NOT_SATISFIED"; last: T | null; attempts: number; waitedMs: number };

/**
 * Retries until a read satisfies a predicate, not merely until it returns.
 *
 * The distinction matters after a transaction MUTATES an existing object. The
 * object is readable the whole time, so waiting for existence returns instantly
 * with the pre-transaction state. What has to be waited for is the change.
 */
export async function awaitCondition<T>(
  read: ObjectReader<T>,
  satisfied: (value: T) => boolean,
  options: AwaitOptions = {},
): Promise<ConditionResult<T>> {
  const attempts = options.attempts ?? 8;
  const initialDelayMs = options.initialDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const sleep = options.sleep ?? defaultSleep;

  let delay = initialDelayMs;
  let waitedMs = 0;
  let last: T | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const value = await read();
    if (value !== null && value !== undefined) {
      last = value;
      if (satisfied(value)) return { kind: "SATISFIED", value, attempts: attempt };
    }

    if (attempt === attempts) break;

    options.onRetry?.(attempt, delay);
    await sleep(delay);
    waitedMs += delay;
    delay = Math.min(delay * 2, maxDelayMs);
  }

  return { kind: "NOT_SATISFIED", last, attempts, waitedMs };
}

/** One line explaining an unresolved read, in terms of what it does not prove. */
export function describeUnresolved(result: {
  attempts: number;
  waitedMs: number;
}): string {
  return (
    `the object was not readable after ${result.attempts} attempts over ` +
    `${(result.waitedMs / 1000).toFixed(1)}s. This does NOT establish that it is absent — ` +
    "the GraphQL indexer trails the fullnode, so a freshly created object can be invisible " +
    "to it for a short while. Check the object id directly with `sui client object` before " +
    "concluding anything."
  );
}
