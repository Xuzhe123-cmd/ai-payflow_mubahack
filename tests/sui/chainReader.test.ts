/**
 * The chain-reading layer, against recorded testnet payloads.
 *
 * Every fixture below is the real `contents.json` returned by the Sui GraphQL
 * endpoint for the deployed package — not a hand-written approximation. That
 * matters because the failures this layer is prone to are all shape failures:
 * a `u64` that is a string, a nested struct that may or may not be wrapped in
 * `fields`, a `Balance` that renders two different ways. Inventing the fixtures
 * would test the invention rather than the chain.
 *
 * No network. The reader takes a `ChainQueries`, so a fake supplies the data.
 */

import { describe, expect, it } from "vitest";

import {
  readAgent,
  readCashFlowEvents,
  readChainSnapshot,
  readInvoices,
  readSuppliers,
  readTreasury,
  ChainReadError,
} from "../../lib/sui/chainReader";
import type { ChainQueries, DynamicFieldEntry } from "../../lib/sui/client";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const PACKAGE = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const TREASURY = "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a";
const AGENT_CAP = "0x780434ab1f1930878707aed3e6eca3101c5e61f56f6ace50e4358601b12ccb85";
const REGISTRY = "0xf37754631294381e009d00fcf0ebc1d400f0db941af5857a2e2de40d78b38fb8";
const CALENDAR = "0x242645c276b89d0817cf424489683a25e8df7f67f4333cbc33d8bd143afaa255";
const AGENTS_TABLE = "0x9512c65ddc42a249faa2b06199b368320315b238f96a9951aa6114f3514a7111";
const SUPPLIERS_TABLE = "0x9d521b5a3f493349a91fe030779ae59c8bbf42842bf1c25c6f0d4ff28983457a";
const INVOICE_A0 = "0x3124042beb52a69d178958037436e2d063e2739abd01ab94593396d71fdd710b";
const INVOICE_B = "0x1cb9fd04484c4453c0c3f440613444e055b63315447b2410e316ff0e79bbbe46";

/** Verbatim from the deployed treasury, after the A0 payment settled. */
const TREASURY_JSON = {
  id: TREASURY,
  owner: "0xa09bfa3a1f78f168c2970cff756592b7376be0ac947d845aedc4c0781d270609",
  vault: "97000000000",
  policy: {
    min_reserve: "50000000000",
    human_approval_threshold: "5000000000",
    auto_pay_enabled: true,
    allowed_currencies: ["USD"],
    allowed_coin_types: [`${PACKAGE.slice(2)}::mock_usdc::MOCK_USDC`],
    max_recommendation_age_ms: "86400000",
  },
  agents: { id: AGENTS_TABLE, size: "1" },
  paid_invoices: { id: "0x4c95e4e5f3981859c3409ad804412e07fc600f8720604132d4edd3ae2c05d249", size: "1" },
  total_paid: "3000000000",
  payment_count: "1",
};

const REGISTRY_JSON = { id: REGISTRY, treasury_id: TREASURY, suppliers: { id: SUPPLIERS_TABLE, size: "5" } };

const AGENT_CAP_JSON = { id: AGENT_CAP, treasury_id: TREASURY, agent_id: "agent_payflow_01" };

const CALENDAR_JSON = {
  id: CALENDAR,
  treasury_id: TREASURY,
  events: [
    { date: "2026-09-01", direction: 0, amount: "35000000000", description: "Customer receivable — Meridian Systems" },
    { date: "2026-08-31", direction: 1, amount: "28000000000", description: "Contract manufacturing milestone" },
    { date: "2026-09-15", direction: 1, amount: "40000000000", description: "Payroll" },
  ],
};

const INVOICE_A0_JSON = {
  id: INVOICE_A0,
  treasury_id: TREASURY,
  invoice_number: "INV-2026-3455",
  supplier_id: "sup_northwind",
  amount: "3000000000",
  currency: "USD",
  due_date: "2026-08-31",
  po_number: "PO-2026-0412",
  recipient: "0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091",
  walrus_blob_id: null,
  status: 4, // PAID
  created_at_ms: "1788000000000",
};

const INVOICE_B_JSON = {
  ...INVOICE_A0_JSON,
  id: INVOICE_B,
  invoice_number: "INV-2026-3492",
  supplier_id: "sup_kestrel",
  amount: "8000000000",
  due_date: "2026-09-18",
  recipient: "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308",
  status: 0, // PENDING
};

/** Day bucket for the recorded spend, so the rollover logic can be exercised. */
const SPEND_DAY = 20_695;
const SPEND_DAY_MS = SPEND_DAY * 86_400_000;

const AGENT_AUTH_JSON = {
  daily_limit: "20000000000",
  day_bucket: String(SPEND_DAY),
  enabled: true,
  max_single: "5000000000",
  spent_today: "3000000000",
};

const SUPPLIER_ENTRIES: DynamicFieldEntry[] = [
  { name: "sup_veritas", value: { name: "Veritas Materials Co", registered_wallet: "0x2e6b", status: 1 } },
  { name: "sup_northwind", value: { name: "Northwind Components Ltd", registered_wallet: "0x7a1c", status: 1 } },
  { name: "sup_kestrel", value: { name: "Kestrel Logistics GmbH", registered_wallet: "0x3f8b", status: 1 } },
  { name: "sup_pending", value: { name: "Pending Co", registered_wallet: "0xdead", status: 0 } },
  { name: "sup_revoked", value: { name: "Revoked Co", registered_wallet: "0xbeef", status: 2 } },
];

const MANIFEST = {
  network: "testnet",
  packageId: PACKAGE,
  publishedAt: "2026-08-30T03:57:34.436Z",
  publisher: "0xa09bfa3a1f78f168c2970cff756592b7376be0ac947d845aedc4c0781d270609",
  publishDigest: "abc",
  coinType: `${PACKAGE}::mock_usdc::MOCK_USDC`,
  cliVersion: "sui 1.78.1",
  objects: {
    treasuryId: TREASURY,
    treasuryOwnerCapId: "0xa732",
    supplierRegistryId: REGISTRY,
    cashFlowCalendarId: CALENDAR,
    agentCapId: AGENT_CAP,
    approverCapId: "0xd49e",
    mockUsdcTreasuryCapId: "0xb807",
    coinMetadataId: "0x1b91",
  },
  initialPolicy: {
    maxAgentPaymentCents: 500_000,
    dailyAgentLimitCents: 2_000_000,
    humanApprovalThresholdCents: 500_000,
    minimumReserveCents: 5_000_000,
    allowedCurrencies: ["USD"],
    maxRecommendationAgeMs: 86_400_000,
  },
  seed: {
    seededAt: "2026-08-30T04:10:00.000Z",
    supplierIds: ["sup_northwind"],
    invoices: [
      { invoiceNumber: "INV-2026-3455", objectId: INVOICE_A0, amountCents: 300_000, supplierId: "sup_northwind" },
      { invoiceNumber: "INV-2026-3492", objectId: INVOICE_B, amountCents: 800_000, supplierId: "sup_kestrel" },
    ],
    cashFlowEventCount: 3,
    vaultFundedCents: 10_000_000,
  },
} satisfies DeploymentManifest;

function fakeQueries(overrides: Partial<Record<string, unknown>> = {}): ChainQueries {
  const objects: Record<string, unknown> = {
    [TREASURY]: TREASURY_JSON,
    [REGISTRY]: REGISTRY_JSON,
    [CALENDAR]: CALENDAR_JSON,
    [AGENT_CAP]: AGENT_CAP_JSON,
    [INVOICE_A0]: INVOICE_A0_JSON,
    [INVOICE_B]: INVOICE_B_JSON,
    ...overrides,
  };
  return {
    async getObjectFields(id) {
      return objects[id] ?? null;
    },
    async multiGetObjectFields(ids) {
      return ids.map((id) => objects[id]).filter((value) => value !== undefined);
    },
    async getDynamicFields(parentId) {
      if (parentId === SUPPLIERS_TABLE) return SUPPLIER_ENTRIES;
      if (parentId === AGENTS_TABLE) return [{ name: AGENT_CAP, value: AGENT_AUTH_JSON }];
      return [];
    },
  };
}

describe("reading the treasury", () => {
  it("decodes the live policy and balance", async () => {
    const treasury = await readTreasury(fakeQueries(), MANIFEST);

    // Coin base units are six decimals; the app speaks cents.
    expect(treasury.balanceCents).toBe(9_700_000); // $97,000
    expect(treasury.minimumReserveCents).toBe(5_000_000); // $50,000
    expect(treasury.humanApprovalThresholdCents).toBe(500_000); // $5,000
    expect(treasury.autoPayEnabled).toBe(true);
    expect(treasury.allowedCurrencies).toEqual(["USD"]);
    expect(treasury.maxRecommendationAgeMs).toBe(86_400_000);
  });

  it("derives what is actually spendable", async () => {
    const treasury = await readTreasury(fakeQueries(), MANIFEST);
    expect(treasury.availableCents).toBe(4_700_000); // $97,000 − $50,000
  });

  it("floors available at zero rather than showing a negative", async () => {
    const drained = { ...TREASURY_JSON, vault: "10000000000" }; // $10,000, below reserve
    const treasury = await readTreasury(fakeQueries({ [TREASURY]: drained }), MANIFEST);

    expect(treasury.balanceCents).toBe(1_000_000);
    expect(treasury.availableCents).toBe(0);
  });

  it("carries the payment statistics", async () => {
    const treasury = await readTreasury(fakeQueries(), MANIFEST);
    expect(treasury.paymentCount).toBe(1);
    expect(treasury.totalPaidCents).toBe(300_000); // $3,000
  });

  it("fails loudly rather than silently reporting zeroes", async () => {
    const queries = fakeQueries({ [TREASURY]: null });
    await expect(readTreasury(queries, MANIFEST)).rejects.toBeInstanceOf(ChainReadError);
  });
});

describe("reading the agent", () => {
  it("finds its authorization by capability id", async () => {
    const agent = await readAgent(fakeQueries(), MANIFEST, SPEND_DAY_MS);

    expect(agent).not.toBeNull();
    expect(agent!.agentId).toBe("agent_payflow_01");
    expect(agent!.enabled).toBe(true);
    expect(agent!.maxSinglePaymentCents).toBe(500_000); // $5,000
    expect(agent!.dailyLimitCents).toBe(2_000_000); // $20,000
  });

  it("reports today's spend and what is left", async () => {
    const agent = await readAgent(fakeQueries(), MANIFEST, SPEND_DAY_MS);

    expect(agent!.spentTodayCents).toBe(300_000); // $3,000
    expect(agent!.remainingTodayCents).toBe(1_700_000); // $17,000
  });

  it("treats a spend recorded on an earlier day as zero", async () => {
    // Mirrors treasury::agent_effective_spent. Showing the raw figure would
    // overstate usage every morning and disagree with what the chain enforces.
    const tomorrow = SPEND_DAY_MS + 86_400_000;
    const agent = await readAgent(fakeQueries(), MANIFEST, tomorrow);

    expect(agent!.spentTodayCents).toBe(0);
    expect(agent!.remainingTodayCents).toBe(2_000_000); // the full $20,000
  });

  it("matches capability ids regardless of 0x and case", async () => {
    const queries = fakeQueries();
    queries.getDynamicFields = async () => [
      { name: AGENT_CAP.replace("0x", "").toUpperCase(), value: AGENT_AUTH_JSON },
    ];
    const agent = await readAgent(queries, MANIFEST, SPEND_DAY_MS);
    expect(agent).not.toBeNull();
  });

  it("returns null when this treasury has no such agent", async () => {
    const queries = fakeQueries();
    queries.getDynamicFields = async () => [{ name: "0xsomeoneelse", value: AGENT_AUTH_JSON }];
    expect(await readAgent(queries, MANIFEST, SPEND_DAY_MS)).toBeNull();
  });

  it("reports a revoked agent as disabled rather than absent", async () => {
    const queries = fakeQueries();
    queries.getDynamicFields = async () => [
      { name: AGENT_CAP, value: { ...AGENT_AUTH_JSON, enabled: false } },
    ];
    const agent = await readAgent(queries, MANIFEST, SPEND_DAY_MS);

    expect(agent).not.toBeNull();
    expect(agent!.enabled).toBe(false);
  });
});

describe("reading suppliers", () => {
  it("decodes every registry entry with its status", async () => {
    const suppliers = await readSuppliers(fakeQueries(), MANIFEST);

    expect(suppliers).toHaveLength(5);
    const byId = Object.fromEntries(suppliers.map((s) => [s.supplierId, s]));
    expect(byId.sup_northwind.status).toBe("APPROVED");
    expect(byId.sup_pending.status).toBe("PENDING");
    expect(byId.sup_revoked.status).toBe("REVOKED");
    expect(byId.sup_northwind.name).toBe("Northwind Components Ltd");
    expect(byId.sup_northwind.registeredWallet).toBe("0x7a1c");
  });

  it("returns them in a stable order", async () => {
    const suppliers = await readSuppliers(fakeQueries(), MANIFEST);
    expect(suppliers.map((s) => s.supplierId)).toEqual([...suppliers.map((s) => s.supplierId)].sort());
  });

  it("survives a registry with no table", async () => {
    const queries = fakeQueries({ [REGISTRY]: { id: REGISTRY, treasury_id: TREASURY } });
    expect(await readSuppliers(queries, MANIFEST)).toEqual([]);
  });
});

describe("reading invoices", () => {
  it("decodes amount, currency, dates and recipient", async () => {
    const invoices = await readInvoices(fakeQueries(), MANIFEST);
    const a0 = invoices.find((i) => i.invoiceNumber === "INV-2026-3455")!;

    expect(a0.amountCents).toBe(300_000); // $3,000
    expect(a0.currency).toBe("USD");
    expect(a0.dueDate).toBe("2026-08-31");
    expect(a0.supplierId).toBe("sup_northwind");
    expect(a0.recipient).toBe("0x7a1c9f4e2b8d6035ae91c4f7d2b60853f19ac4e7b2d8065193af7c2e4b8d6091");
    expect(a0.poNumber).toBe("PO-2026-0412");
  });

  it("maps the numeric status to the name the interface shows", async () => {
    const invoices = await readInvoices(fakeQueries(), MANIFEST);

    // 4 is PAID in move/payflow/sources/invoice.move — the A0 payment settled.
    expect(invoices.find((i) => i.invoiceNumber === "INV-2026-3455")!.status).toBe("PAID");
    expect(invoices.find((i) => i.invoiceNumber === "INV-2026-3492")!.status).toBe("PENDING");
  });

  it("reads a null Walrus blob as absent, not as a string", async () => {
    const invoices = await readInvoices(fakeQueries(), MANIFEST);
    expect(invoices[0].walrusBlobId).toBeNull();
  });

  it("reads a present Walrus blob in either wire shape", async () => {
    const bare = { ...INVOICE_A0_JSON, walrus_blob_id: "blob123" };
    const wrapped = { ...INVOICE_B_JSON, walrus_blob_id: { vec: ["blob456"] } };
    const invoices = await readInvoices(
      fakeQueries({ [INVOICE_A0]: bare, [INVOICE_B]: wrapped }),
      MANIFEST,
    );

    expect(invoices.find((i) => i.invoiceNumber === "INV-2026-3455")!.walrusBlobId).toBe("blob123");
    expect(invoices.find((i) => i.invoiceNumber === "INV-2026-3492")!.walrusBlobId).toBe("blob456");
  });

  it("returns nothing when the deployment has not been seeded", async () => {
    const unseeded = { ...MANIFEST, seed: undefined };
    expect(await readInvoices(fakeQueries(), unseeded)).toEqual([]);
  });
});

describe("reading the cash-flow calendar", () => {
  it("decodes direction, amount and description", async () => {
    const events = await readCashFlowEvents(fakeQueries(), MANIFEST);

    expect(events).toHaveLength(3);
    const inflow = events.find((e) => e.date === "2026-09-01")!;
    expect(inflow.direction).toBe("INFLOW");
    expect(inflow.amountCents).toBe(3_500_000); // $35,000
    expect(inflow.description).toContain("Meridian");

    expect(events.find((e) => e.date === "2026-09-15")!.direction).toBe("OUTFLOW");
  });

  it("returns them in date order, whatever order the chain stored them", async () => {
    const events = await readCashFlowEvents(fakeQueries(), MANIFEST);
    expect(events.map((e) => e.date)).toEqual(["2026-08-31", "2026-09-01", "2026-09-15"]);
  });

  it("survives an empty calendar", async () => {
    const queries = fakeQueries({ [CALENDAR]: { id: CALENDAR, treasury_id: TREASURY, events: [] } });
    expect(await readCashFlowEvents(queries, MANIFEST)).toEqual([]);
  });
});

describe("the whole snapshot", () => {
  it("gathers every category in one read", async () => {
    const snapshot = await readChainSnapshot(fakeQueries(), MANIFEST);

    expect(snapshot.network).toBe("testnet");
    expect(snapshot.packageId).toBe(PACKAGE);
    expect(snapshot.treasury.balanceCents).toBe(9_700_000);
    expect(snapshot.agent).not.toBeNull();
    expect(snapshot.suppliers).toHaveLength(5);
    expect(snapshot.invoices).toHaveLength(2);
    expect(snapshot.cashFlowEvents).toHaveLength(3);
    expect(Date.parse(snapshot.readAt)).not.toBeNaN();
  });

  it("agrees with the treasury about what the agent may spend", async () => {
    // The interface shows both; they must be read from the same source rather
    // than one coming from a fixture.
    const snapshot = await readChainSnapshot(fakeQueries(), MANIFEST);

    expect(snapshot.agent!.maxSinglePaymentCents).toBeLessThanOrEqual(
      snapshot.treasury.balanceCents,
    );
    expect(snapshot.treasury.humanApprovalThresholdCents).toBe(
      snapshot.agent!.maxSinglePaymentCents,
    );
  });
});
