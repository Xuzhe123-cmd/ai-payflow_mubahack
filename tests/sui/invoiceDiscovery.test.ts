/**
 * The invoice list comes from the chain, not from a fixture.
 *
 * THE BUG THIS PREVENTS: the list used to be the eight demo scenarios, so an
 * invoice created on chain AFTER the seed did not exist as far as the interface
 * was concerned. The conditional pair — real objects, real escrows, real oracle
 * evidence — were unreachable, and the fix that suggests itself (add their
 * numbers to a constant) fails the moment a ninth invoice is created.
 *
 * So the test that matters is the one below with an object the manifest has
 * never heard of. It must appear, purely because the chain says it exists.
 *
 * No network: `fetch` is stubbed with a GraphQL response, and the object reads
 * go through a fake `ChainQueries`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { discoverInvoices } from "../../lib/sui/chainReader";
import type { ChainQueries } from "../../lib/sui/client";
import type { DeploymentManifest } from "../../lib/sui/deployment";

const PACKAGE = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const UPGRADED = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SEEDED = "0x3124042beb52a69d178958037436e2d063e2739abd01ab94593396d71fdd710b";
/** Created long after the seed, and named in no manifest anywhere. */
const POST_SEED = "0x9999999999999999999999999999999999999999999999999999999999999999";

function invoiceJson(objectId: string, number: string, amount: string, status: number) {
  return {
    id: objectId,
    invoice_number: number,
    supplier_id: "sup_northwind",
    amount,
    currency: "USD",
    due_date: "2026-09-12",
    po_number: "PO-88213",
    recipient: "0xsupplier",
    status: String(status),
    walrus_blob_id: null,
  };
}

const OBJECTS: Record<string, unknown> = {
  [SEEDED]: invoiceJson(SEEDED, "INV-2026-3455", "3000000000", 1),
  // Status 7 = ESCROWED, which only a post-upgrade invoice can be.
  [POST_SEED]: invoiceJson(POST_SEED, "INV-2026-3502", "4000000000", 7),
};

const MANIFEST = {
  network: "testnet",
  packageId: PACKAGE,
  publishedAt: "2026-08-30T03:57:34.436Z",
  publisher: "0xa09b",
  publishDigest: "abc",
  coinType: `${PACKAGE}::mock_usdc::MOCK_USDC`,
  cliVersion: "sui 1.78.1",
  objects: {
    treasuryId: "0x15f4",
    treasuryOwnerCapId: "0xa732",
    supplierRegistryId: "0xf377",
    cashFlowCalendarId: "0x2426",
    agentCapId: "0x7804",
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
      {
        invoiceNumber: "INV-2026-3455",
        objectId: SEEDED,
        amountCents: 300_000,
        supplierId: "sup_northwind",
      },
    ],
    cashFlowEventCount: 3,
    vaultFundedCents: 10_000_000,
  },
  // An upgrade happened, so the CALL package and the TYPE package differ.
  upgrade: {
    packageId: UPGRADED,
    upgradedAt: "2026-08-30T09:00:00.000Z",
    digest: "def",
    previousPackageId: PACKAGE,
    moduleOrigins: { escrow: UPGRADED, oracle: UPGRADED },
  },
} as unknown as DeploymentManifest;

const QUERIES = {
  async getObjectFields(id: string) {
    return OBJECTS[id] ?? null;
  },
  async multiGetObjectFields(ids: string[]) {
    return ids.map((id) => OBJECTS[id]).filter((value) => value !== undefined);
  },
  async getDynamicFields() {
    return [];
  },
} as unknown as ChainQueries;

function stubGraphql(addresses: string[] | null) {
  const capture: { query: string | null } = { query: null };
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    capture.query = JSON.parse(init.body).query as string;
    if (addresses === null) {
      return { ok: false, async json() { return {}; } } as unknown as Response;
    }
    return {
      ok: true,
      async json() {
        return { data: { objects: { nodes: addresses.map((address) => ({ address })) } } };
      },
    } as unknown as Response;
  });
  return capture;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovering invoices from chain state", () => {
  it("returns an invoice the manifest has never heard of", async () => {
    // The whole point. This object was created after the seed; nothing local
    // names it; it must still appear.
    stubGraphql([SEEDED, POST_SEED]);

    const invoices = await discoverInvoices(QUERIES, MANIFEST, "https://graphql.test");
    const numbers = invoices.map((invoice) => invoice.invoiceNumber);

    expect(numbers).toContain("INV-2026-3502");
    expect(MANIFEST.seed?.invoices.map((entry) => entry.objectId)).not.toContain(POST_SEED);
  });

  it("reads the post-seed invoice's own on-chain status", async () => {
    // ESCROWED is a status only the upgraded package can set. Reading it as
    // UNKNOWN would make a live escrow look like a missing one.
    stubGraphql([POST_SEED]);

    const [invoice] = await discoverInvoices(QUERIES, MANIFEST, "https://graphql.test");

    expect(invoice.status).toBe("ESCROWED");
    expect(invoice.amountCents).toBe(400_000);
  });

  it("queries the package that DEFINED the invoice module, not the upgraded one", async () => {
    // A type's address is its defining version. Filtering on the call package
    // after an upgrade silently returns nothing.
    const capture = stubGraphql([SEEDED]);

    await discoverInvoices(QUERIES, MANIFEST, "https://graphql.test");

    expect(capture.query).toContain(`${PACKAGE}::invoice::Invoice`);
    expect(capture.query).not.toContain(`${UPGRADED}::invoice::Invoice`);
  });

  it("falls back to the manifest when discovery is unavailable", async () => {
    // Offline, the demo still shows the seeded invoices rather than an empty
    // list. It cannot show the post-seed ones, which is why the caller reports
    // the fallback instead of hiding it.
    stubGraphql(null);

    const invoices = await discoverInvoices(QUERIES, MANIFEST, "https://graphql.test");

    expect(invoices.map((invoice) => invoice.invoiceNumber)).toEqual(["INV-2026-3455"]);
  });
});

describe("the list layer names no invoice", () => {
  const SOURCES = [
    "app/api/invoices/route.ts",
    "lib/services/invoiceListService.ts",
    "lib/sui/chainReader.ts",
  ];

  it("hard-codes no invoice number anywhere in the list path", () => {
    // Adding "INV-2026-3501" to a constant would fix today's demo and break the
    // next invoice created. Membership is the chain's answer, not ours.
    for (const path of SOURCES) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source, path).not.toMatch(/INV-\d{4}-\d{4}/);
    }
  });
});
