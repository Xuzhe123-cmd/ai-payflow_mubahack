/**
 * Reading back an object that was created moments ago.
 *
 * This exists because of a real incident. The Demo A runner locked $4,800 on
 * testnet, captured the escrow id correctly, read it back immediately, got
 * nothing, and halted reporting "found nothing could be read". The escrow was
 * perfectly fine — Sui's GraphQL endpoint is an indexer that trails the
 * fullnode, and the lock's checkpoint had not been ingested yet.
 *
 * Two properties follow, and both are tested here. A read-back retries rather
 * than concluding on the first miss. And a read that never resolves is reported
 * as UNRESOLVED, never as absence — "I could not see it" and "it is not there"
 * are different facts, and a runner that conflates them will either halt on a
 * healthy chain or continue on a broken one.
 */

import { describe, expect, it, vi } from "vitest";

import { awaitCondition, awaitObject, describeUnresolved } from "../../lib/sui/awaitObject";

/** Never actually waits; records what the delays would have been. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("awaitObject", () => {
  it("returns immediately when the object is already readable", async () => {
    const read = vi.fn().mockResolvedValue({ id: "0xesc" });
    const result = await awaitObject(read, { sleep: async () => {} });

    expect(result).toEqual({ kind: "FOUND", value: { id: "0xesc" }, attempts: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries until the indexer catches up — the real failure mode", async () => {
    // Three misses then a hit, which is roughly what a checkpoint of lag looks
    // like in practice.
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "0xesc" });

    const { sleep, delays } = fakeSleep();
    const result = await awaitObject(read, { sleep });

    expect(result.kind).toBe("FOUND");
    expect(result.kind === "FOUND" && result.attempts).toBe(4);
    expect(read).toHaveBeenCalledTimes(4);
    // Backoff, not a tight loop.
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("backs off exponentially up to a ceiling", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { sleep, delays } = fakeSleep();

    await awaitObject(read, { attempts: 8, sleep });

    expect(delays).toEqual([500, 1000, 2000, 4000, 4000, 4000, 4000]);
  });

  it("reports UNRESOLVED rather than absence when it never appears", async () => {
    // The distinction that matters. A caller must not read this as proof the
    // object does not exist.
    const read = vi.fn().mockResolvedValue(null);
    const { sleep } = fakeSleep();

    const result = await awaitObject(read, { attempts: 3, sleep });

    expect(result.kind).toBe("UNRESOLVED");
    expect(result.kind === "UNRESOLVED" && result.attempts).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("says out loud that an unresolved read proves nothing", async () => {
    const message = describeUnresolved({ attempts: 8, waitedMs: 17_500 });
    expect(message).toMatch(/does NOT establish that it is absent/i);
    expect(message).toMatch(/indexer trails the fullnode/i);
    // And tells the reader how to settle it definitively.
    expect(message).toMatch(/sui client object/);
  });

  it("treats undefined the same as null", async () => {
    const read = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ ok: true });
    const { sleep } = fakeSleep();

    const result = await awaitObject(read, { sleep });
    expect(result.kind).toBe("FOUND");
  });

  it("does not swallow an exception into a timeout", async () => {
    // An unreachable endpoint or a malformed object is a different problem from
    // a lagging index, and hiding it behind eight retries would waste the time
    // and lose the reason.
    const read = vi.fn().mockRejectedValue(new Error("endpoint unreachable"));
    await expect(awaitObject(read, { sleep: async () => {} })).rejects.toThrow(
      "endpoint unreachable",
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("honours a single-attempt configuration without sleeping", async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { sleep, delays } = fakeSleep();

    const result = await awaitObject(read, { attempts: 1, sleep });
    expect(result.kind).toBe("UNRESOLVED");
    expect(delays).toEqual([]);
  });
});

/**
 * The second incident, and a different shape of the same problem. After the
 * release the escrow was readable throughout — at its previous version, still
 * saying LOCKED with $4,800 in it. Retrying on null does nothing there, because
 * the read succeeds; it just answers with the old state. What has to be waited
 * for is the CHANGE.
 */
describe("awaitCondition", () => {
  /** Typed so the predicate below is not inferring against `unknown`. */
  const reader = (...values: ({ status: string } | null)[]) => {
    const read = vi.fn<() => Promise<{ status: string } | null>>();
    for (const value of values.slice(0, -1)) read.mockResolvedValueOnce(value);
    read.mockResolvedValue(values.at(-1)!);
    return read;
  };

  it("returns as soon as the predicate holds", async () => {
    const read = reader({ status: "RELEASED" });
    const result = await awaitCondition(read, (e) => e.status === "RELEASED", {
      sleep: async () => {},
    });

    expect(result.kind).toBe("SATISFIED");
    expect(result.kind === "SATISFIED" && result.attempts).toBe(1);
  });

  it("keeps waiting while a readable object still shows the old state", async () => {
    const read = reader({ status: "LOCKED" }, { status: "LOCKED" }, { status: "RELEASED" });

    const { sleep, delays } = fakeSleep();
    const result = await awaitCondition(read, (e) => e.status === "RELEASED", { sleep });

    expect(result.kind).toBe("SATISFIED");
    expect(result.kind === "SATISFIED" && result.attempts).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("returns the LAST value seen when it never satisfies", async () => {
    // So the caller can say what it did see, rather than only that it failed.
    const read = reader({ status: "LOCKED" });
    const { sleep } = fakeSleep();

    const result = await awaitCondition(read, (e) => e.status === "RELEASED", {
      attempts: 3,
      sleep,
    });

    expect(result.kind).toBe("NOT_SATISFIED");
    expect(result.kind === "NOT_SATISFIED" && result.last).toEqual({ status: "LOCKED" });
    expect(result.kind === "NOT_SATISFIED" && result.attempts).toBe(3);
  });

  it("is not called a mismatch — that judgement belongs to the caller", async () => {
    // Whether an unsatisfied read is stale or genuinely wrong depends on the
    // transaction result and the object version, neither of which this knows.
    const read = reader({ status: "LOCKED" });
    const result = await awaitCondition(read, () => false, {
      attempts: 2,
      sleep: async () => {},
    });
    expect(result.kind).toBe("NOT_SATISFIED");
  });

  it("tolerates a read that is null before it is anything", async () => {
    const read = reader(null, { status: "RELEASED" });
    const { sleep } = fakeSleep();

    const result = await awaitCondition(read, (e) => e.status === "RELEASED", { sleep });
    expect(result.kind).toBe("SATISFIED");
  });
});
