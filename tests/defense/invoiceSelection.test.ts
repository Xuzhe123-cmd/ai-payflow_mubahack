/**
 * The analysis follows the invoice, and never quietly analyzes another one.
 *
 * THE BUG THIS GUARDS. The defense page named one invoice in its heading while
 * the analysis path was pinned to it in code. A judge selecting a different
 * invoice would have read two models' opinions about INV-2026-3468 under
 * another invoice's name — a fabrication produced by omission rather than by
 * intent, which is exactly as misleading.
 *
 * So the catalog is asserted to be DERIVED (change a scenario and it follows),
 * an unknown invoice is asserted to fail rather than fall back, and the source
 * of every screen in the analysis path is scanned for a pinned invoice number.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_INVOICE_NUMBER,
  findByInvoiceNumber,
  invoiceCatalog,
} from "../../lib/demo/invoiceCatalog";
import { SCENARIOS } from "../../lib/demo/scenarios";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

/** Source with comments stripped — what actually executes. */
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

/** Every file that decides WHICH invoice gets analyzed. */
const ANALYSIS_PATH = [
  "app/(app)/defense/page.tsx",
  "app/api/defense/analyze/route.ts",
  "components/defense/AiProviderPanel.tsx",
  "components/payments/AiProviders.tsx",
  "components/hooks/useProviderAnalysis.ts",
  "lib/ai/dualAnalysis.ts",
];

// --- the catalog is derived, not typed in ------------------------------------

describe("the invoice catalog", () => {
  it("covers every scenario AND the conditional invoices", async () => {
    // The escrow invoices are analyzable too, and their invoice pages are where
    // a judge looks first — leaving them out made those pages request an
    // invoice the endpoint would refuse.
    const catalog = await invoiceCatalog();
    expect(catalog).toHaveLength(SCENARIOS.length + 2);
    expect(catalog.filter((entry) => entry.conditional)).toHaveLength(2);
    expect(catalog.map((entry) => entry.invoiceNumber)).toContain("INV-2026-3502");
  });

  it("marks conditional invoices as such, with no scenario", async () => {
    const escrow = (await invoiceCatalog()).find(
      (entry) => entry.invoiceNumber === "INV-2026-3502",
    )!;
    expect(escrow.conditional).toBe(true);
    expect(escrow.scenarioId).toBeNull();
    expect(escrow.amountCents).toBe(400_000);
  });

  it("reads each invoice number and amount from the analysis, not a literal", async () => {
    // Proof it is derived: the catalog's numbers must equal what the pipeline
    // computes, and the catalog module contains none of them as literals.
    const catalog = await invoiceCatalog();
    const catalogSource = source("lib/demo/invoiceCatalog.ts");
    for (const entry of catalog) {
      if (entry.invoiceNumber === DEFAULT_INVOICE_NUMBER) continue;
      expect(
        catalogSource,
        `${entry.invoiceNumber} must not be written into the catalog`,
      ).not.toContain(entry.invoiceNumber);
    }
  });

  it("includes the three invoices the demo walks through", async () => {
    const numbers = (await invoiceCatalog()).map((entry) => entry.invoiceNumber);
    expect(numbers).toContain("INV-2026-3468");
    expect(numbers).toContain("INV-2026-3461");
    expect(numbers).toContain("INV-2026-3486");
  });

  it("carries the real amount for each", async () => {
    const catalog = await invoiceCatalog();
    const amount = (invoiceNumber: string) =>
      catalog.find((entry) => entry.invoiceNumber === invoiceNumber)?.amountCents;
    expect(amount("INV-2026-3468")).toBe(480_000);
    expect(amount("INV-2026-3461")).toBe(3_000_000);
    expect(amount("INV-2026-3486")).toBe(1_470_000);
  });

  it("maps each invoice to the scenario that produces it", async () => {
    expect((await findByInvoiceNumber("INV-2026-3461"))?.scenarioId).toBe("s2_cashflow");
    expect((await findByInvoiceNumber("INV-2026-3486"))?.scenarioId).toBe("s7_po_mismatch");
  });

  it("is case-insensitive about the number it is given", async () => {
    expect((await findByInvoiceNumber("inv-2026-3461"))?.invoiceNumber).toBe("INV-2026-3461");
  });
});

// --- an unknown invoice fails rather than falling back -----------------------

describe("an invoice that does not exist", () => {
  it("resolves to null instead of the default", async () => {
    expect(await findByInvoiceNumber("INV-9999-0000")).toBeNull();
    // The failure this prevents: silently returning the default entry.
    expect(await findByInvoiceNumber("INV-9999-0000")).not.toEqual(
      await findByInvoiceNumber(DEFAULT_INVOICE_NUMBER),
    );
  });

  it("is answered with a 404 by the route, not a substitution", () => {
    const route = code("app/api/defense/analyze/route.ts");
    expect(route).toContain("status: 404");
    expect(route).toContain("Nothing was analyzed");
    // The route must not reach for the default after a failed lookup.
    const afterLookup = route.slice(route.indexOf("if (!entry)"));
    expect(afterLookup.slice(0, afterLookup.indexOf("}"))).not.toContain(
      "DEFAULT_INVOICE_NUMBER",
    );
  });
});

// --- nothing in the analysis path is pinned to one invoice -------------------

describe("no hard-coded invoice in the analysis path", () => {
  it.each(ANALYSIS_PATH)("%s contains no literal invoice number", (file) => {
    const text = code(file);
    const literals = text.match(/INV-\d{4}-\d{4}/g) ?? [];
    expect(literals, `${file} pins ${literals.join(", ")}`).toEqual([]);
  });

  it("keeps the default in exactly one named place", () => {
    // A default is legitimate; scattering it is not. It lives in the catalog
    // and is imported, so there is one line to change.
    expect(DEFAULT_INVOICE_NUMBER).toBe("INV-2026-3468");
    expect(code("lib/demo/invoiceCatalog.ts")).toContain(DEFAULT_INVOICE_NUMBER);
  });

  it("takes the invoice from the URL on the defense page", () => {
    const page = code("app/(app)/defense/page.tsx");
    expect(page).toContain('searchParams.get("invoice")');
    expect(page).toContain("DEFAULT_INVOICE_NUMBER");
  });

  it("passes the selected invoice through to the analyze endpoint", () => {
    // One fetch site, in the shared hook. Both screens go through it, so
    // neither can request a different invoice than it displays.
    expect(code("components/hooks/useProviderAnalysis.ts")).toContain(
      "/api/defense/analyze?invoice=",
    );
    expect(code("components/hooks/useProviderAnalysis.ts")).toContain(
      "encodeURIComponent(invoiceNumber)",
    );
  });

  it("has exactly one place that asks the providers", () => {
    // A second AI path would drift, and the two screens would eventually
    // disagree about what the same models said about the same invoice.
    for (const file of ["app/(app)/defense/page.tsx", "components/payments/AiProviders.tsx"]) {
      expect(code(file)).toContain("useProviderAnalysis");
      expect(code(file)).not.toContain("/api/defense/analyze");
    }
  });

  it("asks about the invoice the Decision Chain is displaying", () => {
    const chain = code("components/payments/DecisionChain.tsx");
    expect(chain).toContain("<AiProviders invoiceNumber={facts.invoiceFacts.invoiceNumber} />");
  });
});

// --- a stale result never sits under a new invoice's name --------------------

describe("switching invoices", () => {
  it("stores the answer with the invoice it describes", () => {
    // Structural, not defensive: a result carries its own invoice, so a stale
    // one cannot be mistaken for a current one by any caller.
    const hook = code("components/hooks/useProviderAnalysis.ts");
    expect(hook).toContain("invoice: string;");
    expect(hook).toContain("invoice: invoiceNumber");
  });

  it("treats an answer for another invoice as not-yet-answered", () => {
    // The guard against showing INV-2026-3468's opinions on INV-2026-3461.
    const hook = code("components/hooks/useProviderAnalysis.ts");
    expect(hook).toContain("answer.invoice === invoiceNumber");
    // Derived from that comparison, so "analyzing" cannot disagree with it.
    expect(hook).toContain("analyzing: invoiceNumber !== null && current === null");
  });

  it("never returns an analysis while reporting a different invoice", () => {
    // The two returned fields come from the SAME keyed record, so they cannot
    // describe different invoices.
    const hook = code("components/hooks/useProviderAnalysis.ts");
    expect(hook).toContain("analysis: current?.analysis ?? null");
    expect(hook).toContain("error: current?.error ?? null");
  });

  it("re-runs when the invoice changes", () => {
    const hook = code("components/hooks/useProviderAnalysis.ts");
    expect(hook).toContain("}, [invoiceNumber]);");
  });

  it("names the analyzed invoice beside the opinions", () => {
    // So a mismatch would be visible rather than silent.
    expect(code("components/payments/AiProviders.tsx")).toContain("analysis.invoiceNumber");
    expect(code("components/defense/AiProviderPanel.tsx")).toContain("analysis.invoiceNumber");
  });
});

// --- the providers section shows no invented figures -------------------------

describe("the Decision Chain providers section", () => {
  const providers = code("components/payments/AiProviders.tsx");

  it("renders confidence and risk from the provider result only", () => {
    expect(providers).toContain("result.confidence");
    expect(providers).toContain("result.risk");
    expect(providers).toContain("result.action");
    // The figures from the brief, which must never be typed in.
    for (const literal of ["98", "90", "94", "AUTO_PAY"]) {
      expect(providers, `must not hard-code ${literal}`).not.toContain(`"${literal}"`);
    }
  });

  it("shows Analyzing… rather than a placeholder opinion", () => {
    expect(providers).toContain("Analyzing…");
  });

  it("labels a single provider as such rather than as consensus", () => {
    expect(providers).toContain("SINGLE PROVIDER — HUMAN REVIEW");
    expect(providers).toContain("AI DISAGREEMENT — HUMAN REVIEW");
  });

  it("carries the advisory disclaimer itself", () => {
    // Whitespace collapsed: JSX wraps the sentence across source lines and the
    // browser joins it back, so the test reads what the reader reads.
    const rendered = providers.replace(/\s+/g, " ");
    expect(rendered).toContain("Two independent AI providers analyzed this invoice");
    expect(rendered).toContain("AI consensus is advisory");
    expect(rendered).toContain("does not authorize payment");
  });

  it("reuses the shared analysis rather than building a second AI path", () => {
    expect(providers).toContain("useProviderAnalysis");
    // No direct model access from a component.
    expect(providers).not.toContain("runGemini");
    expect(providers).not.toContain("createWorkersAiClient");
  });
});

// --- the attack simulation is independent of invoice selection ---------------

describe("the attack simulation stays separate", () => {
  it("is driven by ?simulate, not by ?invoice", () => {
    const route = code("app/api/defense/route.ts");
    expect(route).toContain('searchParams.get("simulate")');
    expect(route).not.toContain('searchParams.get("invoice")');
  });

  it("builds its pattern without reference to the selected invoice", () => {
    const sim = code("lib/defense/attackSimulation.ts");
    expect(sim).not.toContain("invoice=");
    expect(sim).not.toContain("catalog");
  });
});
