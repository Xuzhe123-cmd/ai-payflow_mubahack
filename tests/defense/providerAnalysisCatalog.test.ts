/**
 * Demo mode: usable without a quota, and never mistakable for live inference.
 *
 * THE RISK THIS GUARDS. A fallback exists so a demo survives a 429. The
 * temptation it creates is to present recorded data as a live model answer —
 * which would be the most dishonest thing in this codebase, because every other
 * claim on screen depends on the reader being able to trust the labels.
 *
 * The separation is enforced by the TYPE: a recorded analysis carries
 * `status: "DEMO_FALLBACK"`, a distinct member of the `ProviderResult` union,
 * and `isOpinion()` excludes it. Treating a fixture as a live answer does not
 * compile.
 *
 * The other property under test is that each invoice gets ITS OWN analysis.
 * Every entry is either recorded against that invoice or derived from that
 * invoice's own fact sheet — never another invoice's numbers.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEMO_DATA_LABEL,
  DEMO_MODE_BANNER,
  DEMO_MODE_DISCLAIMER,
  LIVE_LABEL,
  ORIGIN_LABEL,
  hasRecordedAnalysis,
  providerAnalysisFor,
} from "../../lib/demo/providerAnalysisCatalog";
import { isFallback, isOpinion, resolveConsensus } from "../../lib/ai/providers";
import { buildAnalysis } from "../../lib/deterministic/buildAnalysis";
import { DEMO_AS_OF_DATE } from "../../lib/demo/clock";
import { invoiceCatalog } from "../../lib/demo/invoiceCatalog";
import { SCENARIOS, scenarioById } from "../../lib/demo/scenarios";
import { conditionalDocumentFor, conditionalWorld } from "../../lib/escrow/conditionalInvoices";
import type { DeterministicAnalysis } from "../../lib/types";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const route = code("app/api/defense/analyze/route.ts");

/** Builds the real fact sheet for one invoice, exactly as the route does. */
async function analysisFor(invoiceNumber: string): Promise<{
  analysis: Readonly<DeterministicAnalysis>;
  scenarioId: string | null;
}> {
  const entry = (await invoiceCatalog()).find(
    (row) => row.invoiceNumber === invoiceNumber,
  );
  if (!entry) throw new Error(`${invoiceNumber} is not in the catalog`);

  const scenario = entry.scenarioId ? scenarioById(entry.scenarioId) : null;
  const document = scenario ? scenario.document : conditionalDocumentFor(invoiceNumber)!;
  const analysis = await buildAnalysis({
    document,
    world: scenario ? scenario.world : conditionalWorld(),
    asOf: DEMO_AS_OF_DATE,
  });
  return { analysis, scenarioId: entry.scenarioId };
}

async function pair(invoiceNumber: string) {
  const { analysis, scenarioId } = await analysisFor(invoiceNumber);
  return providerAnalysisFor({ invoiceNumber, scenarioId, analysis });
}

// --- 1 & 2: each invoice gets its own pair -----------------------------------

describe("every invoice gets its own recorded analysis", () => {
  it("returns one entry per provider, in a stable order", async () => {
    const entries = await pair("INV-2026-3468");
    expect(entries.map((entry) => entry.provider)).toEqual(["gemini", "cloudflare"]);
  });

  it("covers every invoice in the catalog", async () => {
    const catalog = await invoiceCatalog();
    for (const entry of catalog) {
      const entries = await pair(entry.invoiceNumber);
      expect(entries).toHaveLength(2);
      for (const opinion of entries) {
        expect(opinion.action).toBeTruthy();
        expect(opinion.reasons.length).toBeGreaterThan(0);
        expect(opinion.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives different invoices different analyses", async () => {
    const a = await pair("INV-2026-3468");
    const b = await pair("INV-2026-3461");
    const c = await pair("INV-2026-3486");
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it("never hands one invoice another invoice's numbers", async () => {
    // The specific failure: 3468's AUTO_PAY leaking onto every card.
    const reference = await pair("INV-2026-3468");
    const catalog = await invoiceCatalog();
    for (const entry of catalog) {
      if (entry.invoiceNumber === "INV-2026-3468") continue;
      expect(await pair(entry.invoiceNumber)).not.toEqual(reference);
    }
  });

  it("derives from the invoice's own facts when nothing was recorded", async () => {
    // s1_normal has a recorded Cloudflare fixture but no recorded Gemini, so
    // Gemini is derived — from THIS invoice, with no invented confidence.
    const [gemini] = await pair("INV-2026-3455");
    expect(gemini.origin).toBe("derived-from-facts");
    expect(gemini.confidence).toBeNull();
  });

  it("states the provenance of every entry", async () => {
    const catalog = await invoiceCatalog();
    for (const entry of catalog) {
      for (const opinion of await pair(entry.invoiceNumber)) {
        expect(Object.keys(ORIGIN_LABEL)).toContain(opinion.origin);
      }
    }
  });
});

// --- 3-6: the four demo invoices ---------------------------------------------

describe("the demo invoices", () => {
  it("3468 → AUTO_PAY consensus at 94% mean", async () => {
    const entries = await pair("INV-2026-3468");
    const [gemini, cloudflare] = entries;
    expect(gemini.action).toBe("AUTO_PAY");
    expect(gemini.confidence).toBe(0.98);
    expect(gemini.risk).toBe("LOW");
    expect(cloudflare.action).toBe("AUTO_PAY");
    expect(cloudflare.confidence).toBe(0.9);
    expect(cloudflare.risk).toBe("LOW");

    const consensus = resolveConsensus(entries);
    expect(consensus.kind).toBe("CONSENSUS");
    expect(consensus.recommendedAction).toBe("AUTO_PAY");
    expect(consensus.meanConfidence).toBeCloseTo(0.94, 3);
  });

  it("3461 → AI DISAGREEMENT → HUMAN_REVIEW", async () => {
    const entries = await pair("INV-2026-3461");
    const [gemini, cloudflare] = entries;
    expect(gemini.action).toBe("HUMAN_REVIEW");
    expect(gemini.confidence).toBe(0.95);
    expect(cloudflare.action).toBe("SCHEDULE");
    expect(cloudflare.confidence).toBe(0.9);

    const consensus = resolveConsensus(entries);
    expect(consensus.kind).toBe("DISAGREEMENT");
    // A disagreement escalates, whatever either provider said.
    expect(consensus.recommendedAction).toBe("HUMAN_REVIEW");
  });

  it("explains the 3461 divergence without inventing facts", async () => {
    const [gemini, cloudflare] = await pair("INV-2026-3461");
    const g = gemini.reasons.join(" ").toLowerCase();
    expect(g).toContain("exceeds");
    expect(g).toContain("authorization");
    const c = cloudflare.reasons.join(" ").toLowerCase();
    // Cloudflare's own recorded reasoning, about timing rather than authority.
    expect(c).toMatch(/reserve|cash|schedul|date|today/);
  });

  it("3486 → HUMAN_REVIEW consensus at HIGH risk", async () => {
    const entries = await pair("INV-2026-3486");
    const consensus = resolveConsensus(entries);
    expect(consensus.kind).toBe("CONSENSUS");
    expect(consensus.recommendedAction).toBe("HUMAN_REVIEW");
    expect(consensus.highestRisk).toBe("HIGH");
    expect(entries[0].confidence).toBe(0.95);
    expect(entries[1].confidence).toBe(0.8);
  });

  it("3502 → HUMAN_REVIEW, and never claims settlement", async () => {
    const entries = await pair("INV-2026-3502");
    expect(resolveConsensus(entries).recommendedAction).toBe("HUMAN_REVIEW");
    const text = entries
      .flatMap((entry) => [entry.summary, ...entry.reasons])
      .join(" ")
      .toLowerCase();
    expect(text).toContain("escrow");
    expect(text).toMatch(/confirm/);
    // Nothing may read as though the payment already went through.
    expect(text).not.toContain("settled");
    expect(text).not.toContain("has been paid");
    expect(text).not.toContain("released");
  });
});

// --- 7: an unknown invoice does not fall back to another one -----------------

describe("an unknown invoice", () => {
  it("is refused by the route rather than substituted", () => {
    expect(route).toContain("status: 404");
    expect(route).toContain("Nothing was analyzed");
  });

  it("never reaches the catalog with another invoice's identity", async () => {
    const catalog = await invoiceCatalog();
    expect(catalog.map((entry) => entry.invoiceNumber)).not.toContain("INV-9999-0000");
  });
});

// --- 8: a 429 activates demo mode --------------------------------------------

describe("when demo mode engages", () => {
  it("tries the live providers first", () => {
    const liveIndex = route.indexOf("analyzeWithBothProviders");
    const fallbackIndex = route.indexOf("providerAnalysisFor");
    expect(liveIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(liveIndex);
  });

  it("engages when ANY provider fails", () => {
    // 429, quota, timeout, missing credential — every trigger arrives as a
    // non-OK status, so one condition covers them all.
    expect(route).toContain('live.filter((result) => result.status !== "OK")');
    expect(route).toContain("failures.length > 0");
  });

  it("uses recorded data for BOTH providers, never a mixed row", () => {
    // A live Gemini beside an unavailable Cloudflare would read as a broken
    // product. One partial failure puts both columns on recorded data.
    expect(route).toContain("usingFallback\n    ? providerAnalysisFor(");
  });

  it("reports LIVE only when both providers answered", () => {
    expect(route).toContain('usingFallback ? "DEMO_FALLBACK" : "LIVE"');
  });

  it("keeps the provider errors for the disclosure, not the headline", () => {
    expect(route).toContain("liveFailures");
  });
});

// --- 11: the interface never labels recorded data LIVE -----------------------

describe("what the interface may claim", () => {
  const panel = code("components/defense/AiProviderPanel.tsx");
  const compact = code("components/payments/AiProviders.tsx");

  it("excludes a recorded analysis from isOpinion", async () => {
    for (const entry of await pair("INV-2026-3468")) {
      expect(isOpinion(entry)).toBe(false);
      expect(isFallback(entry)).toBe(true);
    }
  });

  it("carries no modelId, so no model can be named that was not called", async () => {
    for (const entry of await pair("INV-2026-3468")) {
      expect(entry).not.toHaveProperty("modelId");
    }
  });

  it("overrides the health chip when the shown result is recorded", () => {
    // A liveness probe can pass while inference is refused for quota — that is
    // exactly what a 429 is. Showing CONNECTED beside recorded data would be
    // the most misleading thing on the page.
    expect(panel).toContain("if (fallback) {");
    expect(panel).toContain("DEMO_DATA_LABEL");
    expect(panel).toContain("fallback={isFallbackResult}");
  });

  it("shows LIVE only when a live answer is on screen", () => {
    expect(panel).toContain("if (connected && live) {");
    expect(panel).toContain("live={isLiveResult}");
  });

  it("renders a recorded analysis as a full card, not as an error", () => {
    // The failure this replaced: a recorded opinion rendering as "Unavailable".
    expect(panel).toContain('result.status !== "OK" && result.status !== "DEMO_FALLBACK"');
  });

  it("folds the raw provider errors behind a disclosure", () => {
    expect(panel).toContain("Why demo mode?");
    expect(panel).toContain("<details");
  });

  it("uses the calm banner wording, not an alarm", () => {
    expect(DEMO_MODE_BANNER).toBe("DEMO MODE — LIVE AI QUOTA UNAVAILABLE");
    expect(DEMO_MODE_DISCLAIMER).toContain("Live AI temporarily unavailable");
    expect(DEMO_MODE_DISCLAIMER).toContain("No live model inference was used");
    expect(DEMO_DATA_LABEL).toBe("DEMO DATA");
    expect(LIVE_LABEL).toBe("LIVE");
    // Amber, not red.
    expect(panel).toContain('fallback ? "border-warn/35 bg-warn-soft"');
  });

  it("names both providers, never a generic AI label", () => {
    for (const file of [panel, compact]) {
      expect(file).toContain("PROVIDER_LABEL");
    }
    // The header names them outright rather than saying "AI" — the two-provider
    // architecture is the claim, so the claim is spelled out.
    const rendered = panel.replace(/\s+/g, " ");
    expect(rendered).toContain("Gemini + Cloudflare independently analyze the same invoice");
    expect(rendered).toContain("AI consensus is advisory");
  });

  it("gives each provider its own identity mark", () => {
    // Visual identity is the mark's job; card background stays reserved for the
    // LIVE / DEMO DATA distinction so the two signals never compete.
    expect(panel).toContain("ProviderMark");
    const mark = code("components/defense/ProviderMark.tsx");
    expect(mark).toContain("gemini:");
    expect(mark).toContain("cloudflare:");
    // Inline SVG, so no runtime network fetch on a security screen.
    expect(mark).toContain("<svg");
    expect(mark).not.toContain("http");
  });

  it("shows both provider actions inside the consensus card", () => {
    // The conclusion is auditable on its face: each input is restated beside
    // the verdict it produced.
    const rendered = panel.replace(/\s+/g, " ");
    expect(rendered).toContain('(["gemini", "cloudflare"] as const).map((id)');
    expect(rendered).toContain("Consensus →");
    expect(rendered).toContain("consensus.recommendedAction");
  });

  it("carries the legend for the three provenances", () => {
    expect(panel).toContain("Reading this page");
    expect(panel).toContain("Real model inference");
    expect(panel).toContain("Pre-recorded provider analysis");
    expect(panel).toContain("Read directly from Sui");
  });

  it("keeps the advisory statement permanently visible", () => {
    expect(panel).toContain("What this does not do");
    expect(panel).toContain("consensusCaveat");
    // Whitespace collapsed: JSX wraps the sentence and the browser rejoins it.
    expect(compact.replace(/\s+/g, " ")).toContain("does not authorize payment");
  });

  it("shows no confidence percentage where none was measured", () => {
    expect(panel).toContain('result.confidence === null ? "—"');
    expect(compact).toContain("result.confidence !== null ?");
  });
});

// --- 9 & 10: demo mode cannot reach the chain --------------------------------

describe("demo mode changes nothing", () => {
  const catalog = code("lib/demo/providerAnalysisCatalog.ts");

  it("imports nothing that could submit or authorize", () => {
    for (const banned of [
      "suiCli",
      "child_process",
      "fetch(",
      "HumanApproval",
      "AgentCap",
      "TreasuryOwnerCap",
      "trip_breaker",
      "approve_scoped",
      "execute_payment",
      "execute_conditional",
    ]) {
      expect(catalog, `the catalog must not reference ${banned}`).not.toContain(banned);
    }
  });

  it("is unreachable from Move", () => {
    for (const file of ["treasury.move", "payment.move", "escrow.move", "approval.move"]) {
      const move = readFileSync(
        resolve(process.cwd(), "move/payflow/sources", file),
        "utf8",
      ).toLowerCase();
      expect(move).not.toContain("demo");
      expect(move).not.toContain("fallback");
    }
  });

  it("leaves the analyze route read-only", () => {
    expect(route).toContain("export async function GET");
    expect(route).not.toContain("export async function POST");
  });

  it("never claims THIS analysis produced a transaction", async () => {
    // Narrowly scoped on purpose. A duplicate invoice truthfully reports that
    // an EARLIER payment settled on chain — that is a fact the deterministic
    // layer established and the reason the invoice is refused. What must never
    // appear is a claim that demo mode itself submitted, signed, or settled
    // anything.
    const catalog = await invoiceCatalog();
    for (const entry of catalog) {
      const text = (await pair(entry.invoiceNumber))
        .flatMap((opinion) => [opinion.summary, ...opinion.reasons])
        .join(" ")
        .toLowerCase();
      for (const banned of [
        "transaction was submitted",
        "we submitted",
        "digest",
        "signed the transaction",
        "funds were released",
        "payment was executed",
      ]) {
        expect(text, `${entry.invoiceNumber} must not claim "${banned}"`).not.toContain(banned);
      }
      // And no transaction hash may appear anywhere in recorded prose.
      expect(text).not.toMatch(/0x[0-9a-f]{16,}/);
    }
  });

  it("keeps the Sui preflight independent of the AI layer", () => {
    // The preflight reads the live authorization; the catalog knows nothing
    // about it and must not appear to.
    expect(catalog).not.toContain("25_000");
    expect(catalog).not.toContain("EAboveApproverLimit");
    expect(catalog).not.toContain("601");
    expect(source("lib/demo/providerAnalysisCatalog.ts").toLowerCase()).not.toContain(
      "refused by sui",
    );
  });
});

// --- 12: the breaker simulation is separate ----------------------------------

describe("the circuit-breaker simulation stays separate", () => {
  it("is driven by ?simulate, never by provider availability", () => {
    const fast = code("app/api/defense/route.ts");
    expect(fast).toContain('searchParams.get("simulate")');
    expect(fast).not.toContain("providerAnalysisFor");
  });

  it("builds its pattern without reference to any provider", () => {
    const sim = code("lib/defense/attackSimulation.ts");
    expect(sim).not.toContain("gemini");
    expect(sim).not.toContain("cloudflare");
    expect(sim).not.toContain("fallback");
  });

  it("says WOULD trip, and that nothing on chain changed", () => {
    // The box now presents the finding and the action as two steps, so the
    // wording moved — but the two claims it must make are unchanged: the
    // breaker WOULD trip, and simulating has not altered treasury state.
    const breaker = code("components/defense/CircuitBreakerPanel.tsx").replace(/\s+/g, " ");
    expect(breaker).toContain("Anomaly threshold exceeded — requesting circuit breaker…");
    expect(breaker).toContain(
      "The behavioral engine requested the freeze. It cannot perform one",
    );
    expect(breaker).toContain("stays exactly as it is until Sui confirms");
    expect(breaker).toContain("Demo Attack Simulation — no real AI model was compromised.");
  });

  it("still reads the real mode from Sui", () => {
    const breaker = code("components/defense/CircuitBreakerPanel.tsx");
    expect(breaker).toContain('breaker.mode === "HUMAN_ONLY"');
    expect(breaker).not.toContain("setTripped");
  });
});

// --- the recordings behind Cloudflare are real -------------------------------

describe("Cloudflare's recorded answers are the real ones", () => {
  it("comes from the verbatim Workers AI recordings", async () => {
    // Parsed from the fixture rather than transcribed, so it cannot drift from
    // what the model actually returned.
    for (const scenario of SCENARIOS) {
      const fixture = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `tests/fixtures/llm/${scenario.id}.json`),
          "utf8",
        ).toString(),
      ) as { raw: string };
      const recorded = JSON.parse(fixture.raw) as { action: string; confidence: number };

      const { analysis } = await analysisFor(
        (await invoiceCatalog()).find((entry) => entry.scenarioId === scenario.id)!
          .invoiceNumber,
      );
      const [, cloudflare] = providerAnalysisFor({
        invoiceNumber: (await invoiceCatalog()).find(
          (entry) => entry.scenarioId === scenario.id,
        )!.invoiceNumber,
        scenarioId: scenario.id,
        analysis,
      });

      expect(cloudflare.action).toBe(recorded.action);
      expect(cloudflare.confidence).toBe(recorded.confidence);
      expect(cloudflare.origin).toBe("recorded-fixture");
    }
  });

  it("reports which invoices have a recording", async () => {
    expect(hasRecordedAnalysis("INV-2026-3468", "s3_discount")).toBe(true);
    expect(hasRecordedAnalysis("INV-2026-3502", null)).toBe(true);
    expect(hasRecordedAnalysis("INV-9999-0000", null)).toBe(false);
  });
});
