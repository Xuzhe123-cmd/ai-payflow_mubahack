/**
 * Real settlement, or an honest refusal — never a manufactured receipt.
 *
 * WHAT WAS WRONG. `executePayment` threw `PaymentExecutionUnavailableError` on
 * every call: the stub was never replaced, so "Execute payment" could not
 * succeed by construction. Beside it sat `digestFor()`, a deterministic
 * pseudo-digest generator — a fabricated 0x… hash one line away from being
 * rendered as proof of a settlement that never happened.
 *
 * WHAT REPLACES IT. A POST to a server route that reads the invoice's terms
 * FROM CHAIN, calls `payment::execute_payment`, and re-reads the invoice before
 * anything is called settled. Three separate refusals to lie: no digest unless
 * Sui issued one, no PAID unless the re-read says so, and no amount or
 * recipient the caller could have chosen.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AgentCapMissingError, executePaymentCall } from "../../lib/payments/executeCall";
import { INVOICE_STATUS_PAID } from "../../lib/payments/invoiceLocator";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const route = code("app/api/payments/execute/route.ts");
const service = code("lib/services/suiService.ts");
const submit = code("lib/payments/executeSubmit.ts");

const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const V4 = "0x6d237a995924ad0529c0933a2d0eeca58fb2f3bebaa79bee46605960edbf21ed";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const AGENT_CAP = "0x780434ab1f1930878707aed3e6eca3101c5e61f56f6ace50e4358601b12ccb85";
const REGISTRY = "0xf37754631294381e009d00fcf0ebc1d400f0db941af5857a2e2de40d78b38fb8";

function manifest(overrides: Record<string, unknown> = {}): DeploymentManifest {
  return {
    network: "testnet",
    packageId: V1,
    coinType: `${V1}::mock_usdc::MOCK_USDC`,
    objects: {
      treasuryId: TREASURY,
      agentCapId: AGENT_CAP,
      supplierRegistryId: REGISTRY,
      ...(overrides.objects as object),
    },
    upgrade: { packageId: V4, version: 4 },
  } as unknown as DeploymentManifest;
}

/** INV-2026-3468 as the chain actually holds it. */
const invoice = {
  objectId: "0x71b592b7fd18308779b30528fd23ccc9efb80950f8368ffc94bf8dec1e192140",
  invoiceNumber: "INV-2026-3468",
  amount: "4800000000",
  recipient: "0x9d4e7b2a8c1f6053e2b7d94a6c81f305b7e29d4a8c16f350b2e7d94a6c81f305",
};

// --- the call ------------------------------------------------------------------

describe("the settlement call", () => {
  const plan = executePaymentCall(manifest(), invoice, "rec_test", 1_800_000_000_000);

  it("targets payment::execute_payment on the upgraded package", () => {
    expect(plan.module).toBe("payment");
    expect(plan.function).toBe("execute_payment");
    expect(plan.packageId).toBe(V4);
  });

  it("passes the Move arguments in signature order", () => {
    expect(plan.arguments).toEqual([
      TREASURY,
      AGENT_CAP,
      REGISTRY,
      invoice.objectId,
      "4800000000",
      invoice.recipient,
      "rec_test",
      "1800000000000",
      "1800086400000",
      "0x6",
    ]);
  });

  it("takes amount and recipient from the CHAIN object", () => {
    // Not from a request body: a caller cannot redirect the payment or inflate
    // it, whatever it sends.
    expect(plan.arguments).toContain(invoice.amount);
    expect(plan.arguments).toContain(invoice.recipient);
    expect(route).toContain("locateInvoice");
    expect(route).not.toMatch(/body as \{[^}]*amount/);
    expect(route).not.toMatch(/body as \{[^}]*recipient/);
  });

  it("refuses to build without an AgentCap rather than guessing one", () => {
    expect(() =>
      executePaymentCall(manifest({ objects: { agentCapId: undefined } }), invoice, "r", 1),
    ).toThrow(AgentCapMissingError);
  });
});

// --- the route -----------------------------------------------------------------

describe("the execute route", () => {
  it("is POST-only, so nothing settles on a page load", () => {
    expect(route).toContain("export async function POST");
    expect(route).not.toContain("export async function GET");
  });

  it("accepts only an invoice number and a recommendation id", () => {
    expect(route).toContain("invoiceNumber");
    expect(route).toContain("recommendationId");
    expect(route).toContain("BAD_REQUEST");
  });

  it("refuses an invoice that is not on chain", () => {
    expect(route).toContain("NOT_ON_CHAIN");
    expect(route).toContain("Nothing was submitted");
  });

  it("refuses an already-settled invoice", () => {
    // Move refuses it too; refusing here makes the reason legible for free.
    expect(route).toContain("ALREADY_PAID");
    expect(route).toContain("INVOICE_STATUS_PAID");
    expect(INVOICE_STATUS_PAID).toBe(4);
  });

  it("re-reads the invoice before reporting settlement", () => {
    const afterSubmit = route.slice(route.indexOf("submitExecutePayment"));
    expect(afterSubmit).toContain("locateInvoice");
    expect(afterSubmit).toContain("settled: settled?.status === INVOICE_STATUS_PAID");
  });

  it("returns the real error and abort code on failure", () => {
    expect(route).toContain("SUBMIT_FAILED");
    expect(route).toContain("result.abortCode");
  });
});

// --- no fabrication anywhere ----------------------------------------------------

describe("nothing is manufactured", () => {
  it("the pseudo-digest generator is gone", () => {
    // It built a stable 0x… hash from the invoice fields — a fake receipt one
    // line from being rendered as proof.
    expect(service).not.toContain("digestFor");
    expect(service).not.toContain("0x811c9dc5");
    expect(service).not.toContain("pseudo-digest");
  });

  it("throws rather than returning a receipt without a digest", () => {
    expect(service).toContain("Sui returned no transaction digest");
  });

  it("throws rather than claiming settlement the chain has not shown", () => {
    expect(service).toContain("if (!payload.settled)");
    expect(service).toContain("not yet showing as");
  });

  it("never writes a digest literal", () => {
    for (const file of [service, route, submit]) {
      expect(file).not.toMatch(/digest:\s*["'`]0x[0-9a-f]/);
    }
  });

  it("never retries a Move abort", () => {
    // Retrying could double-submit a payment that actually succeeded.
    expect(submit).toContain("attempt.abortCode === null");
  });
});

// --- the boundary stays in Move -------------------------------------------------

describe("policy stays where it belongs", () => {
  it("the route makes no policy decision of its own", () => {
    // Every limit, the breaker, and the duplicate table are Move's. The only
    // local refusals are "not on chain" and "already paid", both of which Move
    // would also refuse.
    for (const banned of [
      "25000000000",
      "50000000000",
      "maxSinglePaymentCents",
      "dailyLimit",
      "assert_autonomy_allowed",
      "membership",
    ]) {
      expect(route, `the route must not decide ${banned}`).not.toContain(banned);
    }
  });

  it("relies on Move for the ten assertions and the breaker", () => {
    const payment = source("move/payflow/sources/payment.move");
    const body = payment.slice(
      payment.indexOf("public fun execute_payment"),
      payment.indexOf("public fun execute_approved"),
    );
    expect(body).toContain("treasury::assert_autonomy_allowed(treasury)");
    expect(body).toContain("evaluate(");
    expect(body).toContain("assert!(ev.approved, ev.first_violation as u64)");
  });

  it("keeps the human path a separate Move function", () => {
    const payment = source("move/payflow/sources/payment.move");
    expect(payment).toContain("public fun execute_approved");
    // Which needs a HumanApproval — the object this build never mints.
    const approved = payment.slice(payment.indexOf("public fun execute_approved"));
    expect(approved.slice(0, 400)).toContain("approval: &mut HumanApproval");
  });
});
