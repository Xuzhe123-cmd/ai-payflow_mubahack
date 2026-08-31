"use client";

/**
 * The two providers behind one recommendation, compactly.
 *
 * WHY IT SITS INSIDE THE AI CARD. The Decision Chain used to show a single
 * verdict — "Pay now" — with no indication that two independent models produced
 * it. A judge had to visit the defense page to learn the architecture. This puts
 * the evidence next to the conclusion.
 *
 * EVERY FIGURE IS THE MODELS'. The recommendation, the confidence and the risk
 * come from `/api/defense/analyze` for THIS invoice. Nothing here has a default
 * or a placeholder number: a provider that has not answered shows "Analyzing…",
 * and one that cannot shows its real status.
 *
 * ADVISORY, AND IT SAYS SO. Agreement between two models is still only an
 * opinion — the disclaimer is part of the component rather than something the
 * caller may forget to add.
 */

import { PROVIDER_LABEL, type ProviderResult } from "@/lib/ai/providers";
import { DEMO_DATA_LABEL, LIVE_LABEL } from "@/lib/demo/providerAnalysisCatalog";
import { ProviderMark } from "@/components/defense/ProviderMark";
import { useProviderAnalysis } from "@/components/hooks/useProviderAnalysis";
import { cn } from "@/lib/utils";

function riskTone(risk: string): string {
  return risk === "LOW" ? "text-pos" : risk === "MEDIUM" ? "text-warn" : "text-neg";
}

function ProviderLine({
  provider,
  result,
  analyzing,
}: {
  provider: "gemini" | "cloudflare";
  result: ProviderResult | undefined;
  analyzing: boolean;
}) {
  const label = PROVIDER_LABEL[provider];

  let body: React.ReactNode;
  if (!result) {
    body = (
      <span className="text-[11.5px] text-ink-faint">
        {analyzing ? "Analyzing…" : "No opinion"}
      </span>
    );
  } else if (result.status === "OK") {
    body = (
      <span className="text-[11.5px] text-ink-soft">
        <span className="font-semibold text-ink">{result.action.replace(/_/g, " ")}</span>
        {" · "}
        {Math.round(result.confidence * 100)}% confidence{" · "}
        <span className={cn("font-medium", riskTone(result.risk))}>{result.risk}</span>
      </span>
    );
  } else if (result.status === "DEMO_FALLBACK") {
    // Labelled on the line itself, so the figure is never read without it.
    body = (
      <span className="text-[11.5px] text-ink-soft">
        <span className="font-semibold text-warn">{DEMO_DATA_LABEL}</span>
        {" · "}
        <span className="font-semibold text-ink">{result.action.replace(/_/g, " ")}</span>
        {result.confidence !== null ? ` · ${Math.round(result.confidence * 100)}% confidence` : ""}
        {result.risk !== "UNKNOWN" ? (
          <>
            {" · "}
            <span className={cn("font-medium", riskTone(result.risk))}>{result.risk}</span>
          </>
        ) : (
          " · risk UNKNOWN"
        )}
      </span>
    );
  } else {
    body = (
      <span className="text-[11.5px] text-ink-faint">
        {result.status === "UNCONFIGURED" ? "Not configured" : "Unavailable"}
      </span>
    );
  }

  return (
    <div className="flex items-start gap-2 py-1">
      {/* The same mark the defense page uses, so a judge who has seen one
          screen recognises the other. */}
      <ProviderMark
        provider={provider}
        className={cn("size-4 rounded", result ? undefined : "opacity-60")}
      />
      <span className="w-[64px] shrink-0 pt-0.5 text-[11.5px] font-medium text-ink">{label}</span>
      <span className="pt-0.5">{body}</span>
    </div>
  );
}

export function AiProviders({ invoiceNumber }: { invoiceNumber: string }) {
  const { analysis, analyzing, error } = useProviderAnalysis(invoiceNumber);
  const consensus = analysis?.consensus ?? null;

  const resultFor = (provider: "gemini" | "cloudflare") =>
    analysis?.providers.find((entry) => entry.provider === provider);

  const agreed = consensus?.kind === "CONSENSUS";
  const fallback = analysis?.mode === "DEMO_FALLBACK";
  const disagreed = consensus?.kind === "DISAGREEMENT";
  const single = consensus?.kind === "SINGLE_PROVIDER";

  return (
    <div className="mt-3 border-t border-ai-border/60 pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ai">
          AI providers
        </div>
        {/* The invoice these opinions are about, named — so a stale result
            under the wrong invoice would be visible rather than silent. */}
        {analysis ? (
          <div className="font-mono text-[9.5px] text-ink-faint">{analysis.invoiceNumber}</div>
        ) : null}
      </div>

      {/* LIVE OR RECORDED, before any figure below it. */}
      {analysis ? (
        <div
          className={cn(
            "mt-1.5 rounded-lg border px-2.5 py-1.5",
            fallback ? "border-warn/30 bg-warn-soft" : "border-pos/30 bg-pos-soft",
          )}
        >
          <div className={cn("text-[10.5px] font-semibold", fallback ? "text-warn" : "text-pos")}>
            {fallback ? "DEMO MODE" : `${LIVE_LABEL} AI ANALYSIS`}
          </div>
          {fallback ? (
            <div className="mt-0.5 text-[10px] leading-relaxed text-ink-soft">
              {analysis.disclaimer}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1.5">
        <ProviderLine provider="gemini" result={resultFor("gemini")} analyzing={analyzing} />
        <ProviderLine
          provider="cloudflare"
          result={resultFor("cloudflare")}
          analyzing={analyzing}
        />
      </div>

      {error ? (
        <div className="mt-2 rounded-lg border border-neg/30 bg-neg-soft px-2.5 py-1.5">
          <div className="text-[11px] leading-relaxed text-neg">{error}</div>
        </div>
      ) : null}

      {consensus ? (
        <div
          className={cn(
            "mt-2 rounded-lg border px-2.5 py-2",
            agreed ? "border-pos/30 bg-pos-soft" : "border-warn/30 bg-warn-soft",
          )}
        >
          <div className={cn("text-[11.5px] font-semibold", agreed ? "text-pos" : "text-warn")}>
            {agreed
              ? "✓ AI CONSENSUS"
              : disagreed
                ? "⚠ AI DISAGREEMENT — HUMAN REVIEW"
                : single
                  ? "⚠ SINGLE PROVIDER — HUMAN REVIEW"
                  : "⚠ NO PROVIDER — HUMAN REVIEW"}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-soft">
            {consensus.recommendedAction.replace(/_/g, " ")}
            {consensus.meanConfidence !== null
              ? ` · ${Math.round(consensus.meanConfidence * 100)}% mean confidence`
              : null}
          </div>
        </div>
      ) : null}

      {/* Part of the component, so no caller can render the verdict without it. */}
      <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
        Two independent AI providers analyzed this invoice. AI consensus is advisory — it does
        not authorize payment.
      </p>
    </div>
  );
}
