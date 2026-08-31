/**
 * Two providers, and the one thing their agreement must never be mistaken for.
 *
 * The consensus layer fails towards the human in every direction: disagreement
 * escalates, a single provider escalates, no provider escalates. Only two
 * independently-reached answers that match leave the recommendation alone. That
 * asymmetry is the defence — a compromised model has to find a second,
 * separately-credentialed model to agree with it before anything is proposed
 * autonomously, and even then Move still decides.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONSENSUS_GRANTS_NOTHING,
  PROVIDER_LABEL,
  isOpinion,
  resolveConsensus,
  type ProviderResult,
} from "../../lib/ai/providers";
import { DEFAULT_GEMINI_MODEL, readGeminiConfig } from "../../lib/ai/geminiClient";
import { analyzeWithBothProviders } from "../../lib/ai/dualAnalysis";
import { checkProviders, bothConnected } from "../../lib/ai/providerHealth";
import type { DeterministicAnalysis } from "../../lib/types";
import type { Level, TreasuryAction } from "../../lib/types";

function opinion(
  provider: "gemini" | "cloudflare",
  action: TreasuryAction,
  confidence = 0.9,
  risk: Level = "LOW",
): ProviderResult {
  return {
    status: "OK",
    provider,
    modelId: `${provider}-test-model`,
    action,
    confidence,
    risk,
    summary: "test",
    reasons: ["test"],
  };
}

// --- 1 & 2: each provider is represented in its own right --------------------

describe("provider representation", () => {
  it("names both providers distinctly", () => {
    expect(PROVIDER_LABEL.gemini).toBe("Gemini");
    expect(PROVIDER_LABEL.cloudflare).toBe("Cloudflare");
  });

  it("carries a recommendation, confidence, risk and reasoning per provider", () => {
    const result = opinion("gemini", "AUTO_PAY", 0.92, "LOW");
    expect(isOpinion(result)).toBe(true);
    if (!isOpinion(result)) return;
    expect(result.action).toBe("AUTO_PAY");
    expect(result.confidence).toBe(0.92);
    expect(result.risk).toBe("LOW");
    expect(result.modelId.length).toBeGreaterThan(0);
  });

  it("always returns one entry per provider, in a stable order", async () => {
    // Two columns render whether or not either model answered, so the shape is
    // fixed even with no credentials at all.
    const results = await analyzeWithBothProviders({} as DeterministicAnalysis, { env: {} });
    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.provider)).toEqual(["gemini", "cloudflare"]);
  });

  it("never invents an opinion for an unconfigured provider", async () => {
    const results = await analyzeWithBothProviders({} as DeterministicAnalysis, { env: {} });
    for (const result of results) {
      expect(result.status).toBe("UNCONFIGURED");
      if (result.status === "OK") continue;
      // The honest shape: a named reason, and no recommendation-shaped fields.
      if (result.status === "DEMO_FALLBACK") continue;
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty("confidence");
      expect(result).not.toHaveProperty("action");
      expect(result).not.toHaveProperty("risk");
    }
  });

  it("names the missing credential for each provider", async () => {
    const [gemini, cloudflare] = await analyzeWithBothProviders(
      {} as DeterministicAnalysis,
      { env: {} },
    );
    if (gemini.status === "UNCONFIGURED") expect(gemini.reason).toContain("GEMINI_API_KEY");
    if (cloudflare.status === "UNCONFIGURED") {
      expect(cloudflare.reason).toContain("CLOUDFLARE_ACCOUNT_ID");
    }
  });

  it("falls back to HUMAN_REVIEW when neither provider is configured", async () => {
    const results = await analyzeWithBothProviders({} as DeterministicAnalysis, { env: {} });
    expect(resolveConsensus(results).recommendedAction).toBe("HUMAN_REVIEW");
  });

  it("reads Gemini credentials from a named variable", () => {
    expect(readGeminiConfig({})).toBeNull();
    const configured = readGeminiConfig({ GEMINI_API_KEY: "test-key" });
    expect(configured?.apiKey).toBe("test-key");
    expect(configured?.modelId).toBe(DEFAULT_GEMINI_MODEL);
  });
});

// --- 3 & 4: agreement and disagreement ---------------------------------------

describe("consensus", () => {
  it("reports consensus when both independently agree", () => {
    const result = resolveConsensus([
      opinion("gemini", "AUTO_PAY", 0.92),
      opinion("cloudflare", "AUTO_PAY", 0.89),
    ]);
    expect(result.kind).toBe("CONSENSUS");
    expect(result.agreedAction).toBe("AUTO_PAY");
    expect(result.recommendedAction).toBe("AUTO_PAY");
    expect(result.meanConfidence).toBeCloseTo(0.905, 3);
  });

  it("reports disagreement, and escalates it to a human", () => {
    const result = resolveConsensus([
      opinion("gemini", "AUTO_PAY"),
      opinion("cloudflare", "SCHEDULE"),
    ]);
    expect(result.kind).toBe("DISAGREEMENT");
    expect(result.agreedAction).toBeNull();
    // Two systems that cannot agree are not a basis for autonomy.
    expect(result.recommendedAction).toBe("HUMAN_REVIEW");
    expect(result.detail).toContain("Gemini");
    expect(result.detail).toContain("Cloudflare");
  });

  it("takes the WORST risk either provider reported", () => {
    const result = resolveConsensus([
      opinion("gemini", "AUTO_PAY", 0.9, "LOW"),
      opinion("cloudflare", "AUTO_PAY", 0.9, "HIGH"),
    ]);
    expect(result.highestRisk).toBe("HIGH");
  });

  it("escalates when only one provider answered", () => {
    const result = resolveConsensus([
      opinion("cloudflare", "AUTO_PAY"),
      { provider: "gemini", status: "UNCONFIGURED", reason: "no key" },
    ]);
    expect(result.kind).toBe("SINGLE_PROVIDER");
    expect(result.recommendedAction).toBe("HUMAN_REVIEW");
  });

  it("escalates when neither answered", () => {
    const result = resolveConsensus([
      { provider: "gemini", status: "UNCONFIGURED", reason: "no key" },
      { provider: "cloudflare", status: "FAILED", reason: "timeout" },
    ]);
    expect(result.kind).toBe("NO_PROVIDERS");
    expect(result.recommendedAction).toBe("HUMAN_REVIEW");
    expect(result.meanConfidence).toBeNull();
  });
});

// --- 5: agreement grants nothing ---------------------------------------------

describe("what AI cannot do", () => {
  it("states that consensus authorizes nothing", () => {
    expect(CONSENSUS_GRANTS_NOTHING).toContain("does not authorize a payment");
    expect(CONSENSUS_GRANTS_NOTHING).toContain("Sui Move enforces");
  });

  it("exposes no field through which a provider could grant authority", () => {
    const result = resolveConsensus([
      opinion("gemini", "AUTO_PAY", 1),
      opinion("cloudflare", "AUTO_PAY", 1),
    ]);
    // Total agreement at full confidence still produces only a recommendation.
    expect(Object.keys(result).sort()).toEqual(
      ["agreedAction", "detail", "highestRisk", "kind", "meanConfidence", "recommendedAction"].sort(),
    );
  });

  it("keeps every AI module out of the Move sources", () => {
    // The architectural rule: no model, no score, no provider inside Move.
    const dir = resolve(process.cwd(), "move/payflow/sources");
    for (const file of ["treasury.move", "payment.move", "escrow.move", "approval.move"]) {
      // Comments stripped: treasury.move deliberately explains, in prose, that
      // Gemini and Cloudflare live OFF chain. Saying so is the opposite of
      // depending on them, and must not fail the check.
      const source = readFileSync(resolve(dir, file), "utf8")
        .replace(/^\s*\/\/.*$/gm, " ")
        .toLowerCase();
      for (const banned of ["gemini", "cloudflare", "llm", "openai", "workers ai"]) {
        expect(source, `${file} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });
});

// --- the connection check -----------------------------------------------------

describe("provider health", () => {
  it("reports NOT_CONFIGURED without attempting a call", async () => {
    const health = await checkProviders({});
    expect(health.map((entry) => entry.status)).toEqual([
      "NOT_CONFIGURED",
      "NOT_CONFIGURED",
    ]);
    // Nothing was attempted, so there is no latency to report.
    expect(health.every((entry) => entry.latencyMs === null)).toBe(true);
    expect(bothConnected(health)).toBe(false);
  });

  it("names the variable that would fix each one", async () => {
    const health = await checkProviders({});
    expect(health[0].detail).toContain("GEMINI_API_KEY");
    expect(health[1].detail).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("requires BOTH providers before reporting a connected pair", async () => {
    const health = await checkProviders({});
    const oneUp = [
      { ...health[0], status: "CONNECTED" as const },
      health[1],
    ];
    // One provider is not a second opinion, and the badge must not imply it is.
    expect(bothConnected(oneUp)).toBe(false);
  });
});

// --- both providers see the same input ----------------------------------------

describe("independence", () => {
  /**
   * The module's code, comments stripped.
   *
   * Its docblock names the prompt and the schema while explaining that both
   * providers get the identical one — saying so must not be counted as a third
   * call site.
   */
  const dualCode = readFileSync(resolve(process.cwd(), "lib/ai/dualAnalysis.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("sends both providers the identical prompt and schema", () => {
    const dual = dualCode;
    // The same fact sheet, the same system prompt, the same schema — so a
    // divergence is about the model rather than about what it was told.
    expect(dual.match(/SYSTEM_PROMPT/g)?.length).toBeGreaterThanOrEqual(2);
    expect(dual.match(/buildUserMessage\(analysis\)/g)?.length).toBe(2);
    expect(dual.match(/DECISION_JSON_SCHEMA/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("puts both through the same validation guard", () => {
    const dual = dualCode;
    // A provider is not trusted merely because it answered.
    expect(dual.match(/validateDecision\(/g)?.length).toBe(2);
  });

  it("asks them concurrently, so neither sees the other's answer", () => {
    const dual = dualCode;
    expect(dual).toContain("Promise.all([");
    expect(dual).toContain("askGemini");
    expect(dual).toContain("askCloudflare");
  });

  it("never lets one provider stand in for the other", () => {
    const dual = dualCode;
    // No fallback that copies an opinion across, and no recorded substitute.
    expect(dual).not.toContain("recordings");
    expect(dual).not.toContain("fallbackDecision");
  });
});
