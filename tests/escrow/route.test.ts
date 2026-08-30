/**
 * The escrow action API, with the chain as the authority.
 *
 * This suite used to drive the whole flow — lock, prove, attest, release — as
 * though the route held a state machine. It does not, and testing it that way
 * was testing a fiction: both demo escrows now exist on testnet, one RELEASED
 * and one LOCKED, and the route reads that before it will do anything.
 *
 * What is worth asserting is the refusal. Hiding a button is a rendering
 * decision a client can ignore; the requirement is that the API also says no.
 * So these check that an action which is not available for the invoice's real
 * on-chain stage is rejected server-side, with the stage named.
 *
 * NETWORK. The transition guard reads live chain state, so the cases below that
 * exercise it talk to testnet. The pure logic behind them — `stageFromChain`
 * and `availableActions` — is tested offline in chainStage.test.ts and
 * demoFlow.test.ts; these confirm the route actually consults it.
 */

import { describe, expect, it } from "vitest";

import { POST } from "../../app/api/escrow/route";

const DEMO_A = "INV-2026-3501";
const DEMO_B = "INV-2026-3502";

async function post(body: unknown) {
  const response = await POST(
    new Request("http://localhost/api/escrow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

describe("input validation, before anything is read", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/escrow", { method: "POST", body: "not json" }),
    );
    expect(response.status).toBe(400);
  });

  it("requires both an invoice and an action", async () => {
    expect((await post({ invoiceNumber: DEMO_A })).status).toBe(400);
    expect((await post({ action: "RELEASE_ESCROW" })).status).toBe(400);
  });

  it("rejects an invoice that is not part of the demo", async () => {
    const { status, body } = await post({
      invoiceNumber: "INV-2026-3455",
      action: "START_CONDITIONAL_PAYMENT",
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not one of the conditional demo invoices/i);
  });
});

describe("the API refuses actions the chain does not permit", () => {
  it("refuses to release Demo B — it is LOCKED with no confirmed attestation", async () => {
    // The single most important refusal in the system. The UI shows no release
    // control; this proves a client that ignores the UI gets nowhere either.
    const { status, body } = await post({
      invoiceNumber: DEMO_B,
      action: "RELEASE_ESCROW",
      escrowObjectId: "0x02dec759adcf39474a662284cae71740705e611085faa0ee961540ed7000f159",
    });

    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.stage).toBe("HELD");
    expect(body.permitted).toEqual([]);
    expect(body.error).toMatch(/not available/i);
  });

  it("refuses to re-lock Demo B — the funds are already committed", async () => {
    const { status, body } = await post({
      invoiceNumber: DEMO_B,
      action: "START_CONDITIONAL_PAYMENT",
    });
    expect(status).toBe(409);
    expect(body.stage).toBe("HELD");
  });

  it("refuses every action on Demo A — it has settled", async () => {
    for (const action of [
      "START_CONDITIONAL_PAYMENT",
      "SUBMIT_PROOF",
      "ORACLE_CONFIRM",
      "RELEASE_ESCROW",
    ]) {
      const { status, body } = await post({ invoiceNumber: DEMO_A, action });
      expect(status, action).toBe(409);
      expect(body.stage, action).toBe("RELEASED");
      // A settled payment offers nothing — no re-execution, no second release.
      expect(body.permitted, action).toEqual([]);
    }
    // Four sequential chain reads; the default 5s is not enough for a network
    // round trip per action.
  }, 30_000);

  it("names the stage it refused on, so the refusal is legible", async () => {
    const { body } = await post({ invoiceNumber: DEMO_A, action: "RELEASE_ESCROW" });
    expect(body.error).toContain("RELEASED");
    expect(body.error).toContain(DEMO_A);
  });

  it("never returns a digest for a refused action", async () => {
    // A refusal must not look like a transaction. There is nothing to show.
    const { body } = await post({ invoiceNumber: DEMO_B, action: "RELEASE_ESCROW" });
    expect(body.transaction).toBeUndefined();
    expect(body.digest).toBeUndefined();
  });
});
