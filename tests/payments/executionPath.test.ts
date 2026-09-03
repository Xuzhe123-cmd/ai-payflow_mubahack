/**
 * The execution path, and the four bugs it took to make it honest.
 *
 * Each section below is a real failure that reached a user, and the assertion
 * that stops it coming back:
 *
 *   1. ROUTING       a $4,800 payment inside the agent's cap must not mint a
 *                    human approval, and an $8,000 one must not be measured
 *                    against the agent's $5,000.
 *   2. ABORT 2       `payment::evaluate` runs one rule body against a `Limits`
 *                    built from either authority, so check 2 fires for both.
 *                    Reported in its agent sense on the human path, it sent a
 *                    reader to inspect an AgentCap that was enabled and fine.
 *   3. BUDGET LEAK   `approve_scoped` books the amount at MINT time. Minting
 *                    afresh on every click spent $45,300 of a $50,000 daily
 *                    authorization, $30,600 of it on approvals never executed.
 *   4. STALE CACHE   the invoice list is cached per page and
 *                    `refreshChainInvoices()` was never called, so a settled
 *                    invoice kept offering Execute until the tab was reloaded.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { abortMeaning } from "../../lib/payments/approvalAborts";
import { executionFailureHeadline } from "../../lib/payments/executionFailure";
import { availablePaymentAction } from "../../lib/payments/availableAction";
import {
  executionReadiness,
  isSettled,
  type ReadinessFacts,
} from "../../lib/payments/executionReadiness";
import { violationForAbortCode } from "../../lib/sui/errorCodes";
import type { AutonomyVerdict } from "../../lib/payments/autonomy";
import type { DeploymentManifest } from "../../lib/sui/deployment";
import type { PaymentRequest } from "../../lib/types";

const objectsOfType = vi.hoisted(() => vi.fn());
vi.mock("../../scripts/lib/suiCli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/suiCli")>()),
  objectsOfType,
}));

const { agentPaymentCall, executeApprovedCall, findReusableApproval } = await import(
  "../../lib/sui/paymentExecution"
);

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const provider = source("components/providers/PayflowProvider.tsx");
const route = source("app/api/payment/execute/route.ts");
const execution = source("lib/sui/paymentExecution.ts");
const action = source("lib/payments/availableAction.ts");
const chain = source("components/payments/DecisionChain.tsx");

const V1 = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const V4 = "0x6d237a995924ad0529c0933a2d0eeca58fb2f3bebaa79bee46605960edbf21ed";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const AGENT_CAP = "0x780434ab1f1930878707aed3e6eca3101c5e61f56f6ace50e4358601b12ccb85";
const REGISTRY = "0xf37754631294381e009d00fcf0ebc1d400f0db941af5857a2e2de40d78b38fb8";
const RECIPIENT = "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308";
const NOW = 1_788_432_878_325;

const manifest = {
  network: "testnet",
  packageId: V1,
  coinType: `${V1}::mock_usdc::MOCK_USDC`,
  objects: { treasuryId: TREASURY, agentCapId: AGENT_CAP, supplierRegistryId: REGISTRY },
  identity: { companyId: `0x${"2".repeat(64)}` },
  upgrade: { packageId: V4, version: 4 },
} as unknown as DeploymentManifest;

const input = (amountCents: number, invoiceNumber: string) => ({
  manifest,
  network: "testnet" as const,
  invoiceObjectId: `0x${"7".repeat(64)}`,
  nowMs: NOW,
  request: {
    invoiceNumber,
    amountCents,
    recipientWallet: RECIPIENT,
    recommendationId: "rec_test",
  } as unknown as PaymentRequest,
});

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    agent: {
      authorized: true,
      enabled: true,
      maxSingleCents: 500_000,
      dailyLimitCents: 2_000_000,
      spentTodayCents: 0,
    },
    approver: {
      inGoodStanding: true,
      maxSingleCents: 2_500_000,
      dailyLimitCents: 5_000_000,
      authorizedTodayCents: 0,
      staleOnly: false,
    },
    liveApproval: null,
    deadApprovals: [],
    breaker: "NORMAL",
    invoiceStatus: "PENDING",
    amountCents: 480_000,
    ...overrides,
  };
}

// --- 1. routing --------------------------------------------------------------------

describe("each invoice takes the path its authority permits", () => {
  it("$4,800 builds execute_payment on the CURRENT package, holding the AgentCap", () => {
    const plan = agentPaymentCall(input(480_000, "INV-2026-3468"));
    expect(plan.function).toBe("execute_payment");
    expect(plan.packageId).toBe(V4);
    expect(plan.typeArgs).toEqual([`${V1}::mock_usdc::MOCK_USDC`]);
    expect(plan.args).toContain(AGENT_CAP);
    // Cents → base units, exactly once.
    expect(plan.args?.[4]).toBe("4800000000");
  });

  it("$8,000 is never AUTONOMOUS_READY", () => {
    expect(executionReadiness(facts({ amountCents: 800_000 })).state).toBe(
      "HUMAN_APPROVAL_REQUIRED",
    );
  });

  it("execute_approved carries no amount and no recipient", () => {
    // Move reads both from the approval, which is what stops one payment's
    // authorization being spent on a larger one.
    const plan = executeApprovedCall(input(800_000, "INV-2026-3492"), "0xapproval");
    expect(plan.function).toBe("execute_approved");
    expect(plan.args?.[1]).toBe("0xapproval");
    expect(plan.args).not.toContain("8000000000");
    expect(plan.args).not.toContain(AGENT_CAP);
  });

  it("the agent branch of the route mints nothing", () => {
    const branch = route.slice(
      route.indexOf('if (authority === "AGENT")'),
      route.indexOf("// AN APPROVAL ALREADY ON CHAIN IS SPENT"),
    );
    expect(branch).toContain("executeAgentPayment(shared)");
    expect(branch).not.toContain("approve_scoped");
  });

  it("the authority is chosen from a chain-read approval, not from a click", () => {
    expect(provider).toContain(
      'const authority: PaymentAuthority = run.approval ? "HUMAN_APPROVAL" : "AGENT"',
    );
  });
});

// --- 2. abort 2 belongs to the path that raised it ---------------------------------

describe("check 2 is described by the authority that failed it", () => {
  it("on the human path it is the APPROVAL, not the agent capability", () => {
    const meaning = abortMeaning(2, `${V1}::payment::execute_approved`);
    expect(meaning?.code).toBe("APPROVAL_NOT_LIVE");
    expect(meaning?.message).not.toMatch(/^That authority has been revoked/);
    expect(meaning?.message).toMatch(/agent's own capability is not involved/i);
    for (const cause of [/spent/i, /expired/i, /revoked/i, /membership/i, /today/i]) {
      expect(meaning?.message).toMatch(cause);
    }
  });

  it("on the agent path it is still the AgentCap", () => {
    expect(abortMeaning(2, `${V1}::payment::execute_payment`)?.code).toBe(
      "CAPABILITY_DISABLED",
    );
    expect(abortMeaning(2)?.code).toBe("CAPABILITY_DISABLED");
  });

  it("602 names the signer, not a generic refusal", () => {
    expect(abortMeaning(602)?.name).toBe("ENotAuthorizedApprover");
    expect(executionFailureHeadline("NOT_AUTHORIZED_APPROVER")).toMatch(
      /not an authorized approver/i,
    );
  });

  it("601 stays the approver's ceiling and is not one of the ten checks", () => {
    expect(abortMeaning(601)?.name).toBe("EAboveApproverLimit");
    expect(violationForAbortCode(601)).toBeNull();
  });

  it("an unknown code is not given an invented meaning", () => {
    expect(abortMeaning(9999)).toBeNull();
    expect(executionFailureHeadline("NOBODY_MAPPED_THIS")).toBe("No payment was submitted");
  });

  it("the route prefers the ten checks, then the wider dictionary, then REFUSED", () => {
    expect(route).toContain('return payment?.violation ?? payment?.refusalCode ?? "REFUSED";');
    expect(route).toContain("payment.error");
  });
});

// --- 3. the budget leak ------------------------------------------------------------

describe("an approval already on chain is spent, not duplicated", () => {
  const approval = (overrides: Record<string, unknown> = {}) => ({
    objectId: "0xappr",
    fields: {
      treasury_id: TREASURY,
      invoice_number: "INV-2026-3492",
      amount: "8000000000",
      recipient: RECIPIENT,
      expires_at_ms: String(NOW + 600_000),
      consumed: false,
      ...overrides,
    },
  });
  const find = () =>
    findReusableApproval(
      manifest,
      "https://graphql",
      { invoiceNumber: "INV-2026-3492", amountCents: 800_000, recipient: RECIPIENT },
      NOW,
    );

  beforeEach(() => objectsOfType.mockReset());

  it("finds the live approval for exactly this payment", async () => {
    objectsOfType.mockResolvedValue([approval()]);
    await expect(find()).resolves.toBe("0xappr");
  });

  it.each([
    ["consumed", { consumed: true }],
    ["expired", { expires_at_ms: String(NOW - 1) }],
    ["a different amount", { amount: "7000000000" }],
    ["a different recipient", { recipient: `0x${"9".repeat(64)}` }],
    ["a different invoice", { invoice_number: "INV-2026-3486" }],
    ["another treasury", { treasury_id: `0x${"1".repeat(64)}` }],
  ])("refuses to reuse one that is %s", async (_label, overrides) => {
    objectsOfType.mockResolvedValue([approval(overrides)]);
    await expect(find()).resolves.toBeNull();
  });

  it("prefers the one that stays live longest", async () => {
    objectsOfType.mockResolvedValue([
      { objectId: "0xsoon", fields: { ...approval().fields, expires_at_ms: String(NOW + 1_000) } },
      { objectId: "0xlater", fields: { ...approval().fields, expires_at_ms: String(NOW + 9_000) } },
    ]);
    await expect(find()).resolves.toBe("0xlater");
  });

  it("fails closed rather than reading an unreachable chain as 'there is none'", () => {
    // That mistake mints the duplicate this lookup exists to prevent.
    const cli = source("scripts/lib/suiCli.ts");
    expect(cli.slice(cli.indexOf("export async function objectsOfType"))).toContain(
      "Refusing to treat an ",
    );
    const finder = execution.slice(
      execution.indexOf("export async function findReusableApproval"),
      execution.indexOf("function normalizeId"),
    );
    expect(finder).toContain("await objectsOfType(");
    expect(finder).not.toContain("catch");
  });

  it("reusing mints nothing at all", () => {
    const branch = execution.slice(
      execution.indexOf("if (reusableApprovalId) {"),
      execution.indexOf("if (!companyId)"),
    );
    expect(branch).toContain("reusedApproval: true");
    expect(branch).toContain("settleWithApproval");
    expect(branch).not.toContain("approveScopedCall");
  });

  it("the route looks before it mints, and stops if it cannot look", () => {
    const at = route.indexOf("await findReusableApproval(");
    expect(at).toBeGreaterThan(-1);
    expect(route.indexOf("executeApprovedPayment(shared, reusableApprovalId)")).toBeGreaterThan(at);
    expect(route.slice(at, at + 1400)).toContain("CHAIN_UNAVAILABLE");
  });

  it("both paths settle through one shared function", () => {
    expect(execution).toContain("function settleWithApproval");
  });

  it("the day's budget rule is never re-implemented in TypeScript", () => {
    for (const file of [route, execution]) {
      expect(file).not.toContain("daily_limit");
      expect(file).not.toContain("authorized_today");
    }
  });
});

// --- readiness: exists / live / executable-now -------------------------------------

describe("readiness distinguishes what the chain actually permits", () => {
  it("AUTONOMOUS_READY for $4,800 inside the agent's authorization", () => {
    expect(executionReadiness(facts()).state).toBe("AUTONOMOUS_READY");
  });

  it("BLOCKED for $30,000, above the approver's own authorization", () => {
    const verdict = executionReadiness(facts({ amountCents: 3_000_000 }));
    expect(verdict.state).toBe("BLOCKED");
    expect(verdict.reason).toMatch(/\$25,000/);
  });

  it("an approval that exists but cannot settle is APPROVAL_NOT_LIVE", () => {
    const verdict = executionReadiness(
      facts({
        amountCents: 800_000,
        liveApproval: { objectId: "0xappr", amountCents: 800_000 },
        approver: { ...facts().approver!, authorizedTodayCents: 4_530_000 },
      }),
    );
    expect(verdict.state).toBe("APPROVAL_NOT_LIVE");
    expect(verdict.offersExecution).toBe(false);
    expect(verdict.reason).not.toMatch(/agent capability/i);
  });

  it("the same state settles once v5 charges the amount only once", () => {
    const verdict = executionReadiness(
      facts({
        amountCents: 800_000,
        liveApproval: { objectId: "0xappr", amountCents: 800_000 },
        approver: { ...facts().approver!, authorizedTodayCents: 4_530_000 },
        approvalBudgetRule: "V5_BOOKED_ONCE",
      }),
    );
    expect(verdict.state).toBe("HUMAN_APPROVAL_READY");
  });

  it("a tripped breaker blocks autonomy and leaves the human route open", () => {
    const verdict = executionReadiness(facts({ breaker: "HUMAN_ONLY" }));
    expect(verdict.state).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(verdict.reason).toMatch(/circuit breaker/i);
  });

  it("claims nothing before the chain answers", () => {
    expect(executionReadiness(facts({ agent: null })).state).toBe("UNKNOWN");
    const box = availablePaymentAction({
      autonomy: { kind: "AUTONOMOUS", action: "EXECUTE", reason: "" } as AutonomyVerdict,
      conditionStage: null,
      fundsHeldCents: 0,
      amountCents: 480_000,
      runStatus: "ANALYZED",
      hasReceipt: false,
      readiness: null,
    });
    expect(box.action).toBe("NONE");
    expect(box.headline).toBe("READING CHAIN STATE…");
  });

  it("the veto can only remove a control, never add one", () => {
    const settled = availablePaymentAction({
      autonomy: { kind: "AUTONOMOUS", action: "EXECUTE", reason: "" } as AutonomyVerdict,
      conditionStage: null,
      fundsHeldCents: 0,
      amountCents: 480_000,
      chainInvoiceStatus: "PAID",
      runStatus: "ANALYZED",
      hasReceipt: false,
      readiness: { state: "AUTONOMOUS_READY", reason: "", offersExecution: true },
    });
    expect(settled.settled).toBe(true);
    expect(settled.action).toBe("NONE");
  });

  it("callers that do not consult the chain are left as they were", () => {
    const box = availablePaymentAction({
      autonomy: { kind: "AUTONOMOUS", action: "EXECUTE", reason: "" } as AutonomyVerdict,
      conditionStage: null,
      fundsHeldCents: 0,
      amountCents: 480_000,
      runStatus: "ANALYZED",
      hasReceipt: false,
    });
    expect(box.action).toBe("EXECUTE_PAYMENT");
  });
});

// --- 4. the stale cache -------------------------------------------------------------

describe("a settled invoice stops offering to settle again", () => {
  it("a fresh SETTLED reading overrides a stale cached PENDING", () => {
    const stale = availablePaymentAction({
      autonomy: { kind: "AUTONOMOUS", action: "EXECUTE", reason: "" } as AutonomyVerdict,
      conditionStage: null,
      fundsHeldCents: 0,
      amountCents: 480_000,
      chainInvoiceStatus: "PENDING",
      runStatus: "ANALYZED",
      hasReceipt: false,
      readiness: { state: "SETTLED", reason: "Already settled.", offersExecution: false },
    });
    expect(stale.action).toBe("NONE");
    expect(stale.settled).toBe(true);
    expect(stale.headline).toBe("PAID");
    expect(action).toContain(
      'input.readiness?.state === "SETTLED" ? "PAID" : input.chainInvoiceStatus',
    );
  });

  it("the cache is dropped after a settlement and after ALREADY_PAID", () => {
    expect(provider).toContain("refreshChainInvoices");
    const at = provider.indexOf("const receipt = await submitPayment(request, authority)");
    const after = provider.slice(at, at + 900);
    expect(after).toContain("refreshChainInvoices()");
    expect(after.indexOf("refreshChainInvoices()")).toBeLessThan(after.indexOf('status: "PAID"'));
    expect(provider).toContain('error.code === "INVOICE_ALREADY_PAID"');
  });

  it("ESCROWED is not settlement", () => {
    expect(isSettled("ESCROWED")).toBe(false);
    expect(isSettled("PAID")).toBe(true);
  });

  it("a failed readiness read is actionable, not a vanished button", () => {
    expect(chain).toContain("readiness.error");
    expect(chain).toContain("Try reading the chain again");
  });
});

// --- PAID is the chain's word --------------------------------------------------------

describe("PAID only after chain confirmation", () => {
  it("is written in exactly one place, after a receipt", () => {
    expect(provider.match(/status:\s*"PAID"/g) ?? []).toHaveLength(1);
    const at = provider.indexOf('status: "PAID"');
    expect(provider.slice(Math.max(0, at - 900), at)).toContain(
      "await submitPayment(request, authority)",
    );
  });

  it("a refusal returns to ANALYZED and stays unpaid", () => {
    const at = provider.lastIndexOf("executionFailure: {");
    expect(provider.slice(Math.max(0, at - 400), at)).toContain('status: "ANALYZED"');
  });

  it("repeated clicks cannot reach a second submission", () => {
    expect(provider).toContain(
      'if (run.status === "EXECUTING" || run.status === "PAID") return;',
    );
  });

  it("the route refuses a settled invoice before composing a transaction", () => {
    expect(route.indexOf('onChainInvoice.status === "PAID"')).toBeLessThan(
      route.indexOf("executeAgentPayment(shared)"),
    );
  });
});
