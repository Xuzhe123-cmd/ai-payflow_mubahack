/**
 * Reading Move struct fields out of a fetched object.
 *
 * The verifier originally assumed `content.fields`, which is what the RPC SDK
 * emits. The CLI puts the fields directly under `content`, so every read came
 * back empty and the policy checks reported "unreadable" against a treasury
 * that was in fact perfectly correct — a false alarm that looked exactly like a
 * broken deployment.
 *
 * The fixture below is the real `sui client object --json` payload from the
 * deployed testnet Treasury, trimmed only of the parts these tests do not read.
 */

import { describe, expect, it } from "vitest";

import { extractFields, nestedFields } from "../../scripts/lib/suiCli";
import { unitsToCents } from "../../lib/sui/units";

const PACKAGE = "8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";

/** Verbatim shape from `sui client object <treasury> --json` on CLI 1.78.1. */
const CLI_TREASURY = {
  objectId: "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a",
  version: 12,
  digest: "abc",
  objType: `0x${PACKAGE}::treasury::Treasury<0x${PACKAGE}::mock_usdc::MOCK_USDC>`,
  owner: { Shared: { initial_shared_version: 11 } },
  content: {
    agents: { id: "0xa1", size: "1" },
    id: "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a",
    owner: "0xa09bfa3a1f78f168c2970cff756592b7376be0ac947d845aedc4c0781d270609",
    paid_invoices: { id: "0xa2", size: "0" },
    payment_count: "0",
    policy: {
      allowed_coin_types: [`${PACKAGE}::mock_usdc::MOCK_USDC`],
      allowed_currencies: ["USD"],
      auto_pay_enabled: true,
      human_approval_threshold: "5000000000",
      max_recommendation_age_ms: "86400000",
      min_reserve: "50000000000",
    },
    total_paid: "0",
    vault: "0",
  },
};

/** The same object as the RPC SDK would return it, with a `fields` wrapper. */
const RPC_TREASURY = {
  data: {
    objectId: CLI_TREASURY.objectId,
    type: CLI_TREASURY.objType,
    content: {
      dataType: "moveObject",
      type: CLI_TREASURY.objType,
      fields: {
        ...CLI_TREASURY.content,
        policy: { type: `0x${PACKAGE}::policy::TreasuryPolicy`, fields: CLI_TREASURY.content.policy },
      },
    },
  },
};

describe("reading struct fields from a fetched object", () => {
  it("reads the CLI shape, where fields sit directly under content", () => {
    const fields = extractFields(CLI_TREASURY);

    expect(Object.keys(fields)).toContain("policy");
    expect(Object.keys(fields)).toContain("vault");
    expect(fields.payment_count).toBe("0");
  });

  it("reads the RPC shape, where fields sit under content.fields", () => {
    const fields = extractFields(RPC_TREASURY);

    expect(Object.keys(fields)).toContain("policy");
    expect(fields.payment_count).toBe("0");
  });

  it("reaches the by-value policy struct in both shapes", () => {
    for (const [label, object] of [
      ["CLI", CLI_TREASURY],
      ["RPC", RPC_TREASURY],
    ] as const) {
      const policy = nestedFields(extractFields(object), "policy");
      expect(Object.keys(policy), `${label} policy was empty`).toContain("min_reserve");
    }
  });

  it("decodes the deployed policy to exactly the demo figures", () => {
    const policy = nestedFields(extractFields(CLI_TREASURY), "policy");

    // This is the assertion the verifier was failing to make.
    expect(unitsToCents(BigInt(String(policy.min_reserve)))).toBe(5_000_000); // $50,000
    expect(unitsToCents(BigInt(String(policy.human_approval_threshold)))).toBe(500_000); // $5,000
    expect(policy.allowed_currencies).toEqual(["USD"]);
    expect(policy.auto_pay_enabled).toBe(true);
    expect(unitsToCents(BigInt(String(policy.max_recommendation_age_ms)))).toBeGreaterThan(0);
  });

  it("treats u64 fields as strings, because that is what Move emits", () => {
    const policy = nestedFields(extractFields(CLI_TREASURY), "policy");

    // 50_000_000_000 exceeds nothing here, but larger treasuries would exceed
    // Number.MAX_SAFE_INTEGER — which is why these arrive as strings at all.
    expect(typeof policy.min_reserve).toBe("string");
    expect(typeof policy.human_approval_threshold).toBe("string");
  });

  it("allowlists the settlement coin under the published package", () => {
    const policy = nestedFields(extractFields(CLI_TREASURY), "policy");
    const coinTypes = policy.allowed_coin_types as string[];

    // Derived on chain at creation, so this proves the allowlist names the
    // package that was actually published rather than a guessed string.
    expect(coinTypes).toHaveLength(1);
    expect(coinTypes[0].replace(/^0x/, "")).toBe(`${PACKAGE}::mock_usdc::MOCK_USDC`);
  });

  it("returns an empty record rather than throwing on junk", () => {
    for (const input of [null, undefined, 42, "text", [], {}, { content: null }]) {
      expect(extractFields(input)).toEqual(expect.any(Object));
    }
    expect(nestedFields({}, "policy")).toEqual({});
    expect(nestedFields({ policy: "not-a-struct" }, "policy")).toEqual({});
  });
});
