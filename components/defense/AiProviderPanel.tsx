"use client";

/**
 * Two providers, side by side, named.
 *
 * The layout is the argument: two columns that a reader can compare at a
 * glance, and a verdict underneath saying whether they agree. Collapsing them
 * into one "AI" badge would hide the only structural defence this layer has —
 * that a compromised model has to get a second, independently-reached opinion
 * to agree with it.
 *
 * A provider with no credentials renders as a stated absence with the variable
 * name that would fix it. It never borrows the other column's numbers.
 */

import { Badge, Eyebrow } from "@/components/common/Badge";
import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { PROVIDER_LABEL, type ProviderId, type ProviderResult } from "@/lib/ai/providers";
import { ProviderMark } from "./ProviderMark";
import {
  DEMO_DATA_LABEL,
  LIVE_LABEL,
  ORIGIN_LABEL,
} from "@/lib/demo/providerAnalysisCatalog";
import type { ProviderHealth } from "@/lib/ai/providerHealth";
import type { DefenseAnalysis, DefenseSnapshot } from "./types";
import { cn } from "@/lib/utils";

function RiskTone(risk: string): string {
  return risk === "LOW"
    ? "text-pos"
    : risk === "MEDIUM"
      ? "text-warn"
      : "text-neg";
}

/**
 * The connection light.
 *
 * CONNECTED is earned by a real round trip in `checkProviders`, never by the
 * mere presence of an environment variable — a revoked or out-of-quota key
 * would otherwise show green right up until it was needed.
 */
function HealthChip({
  health,
  fallback,
  live,
}: {
  health: ProviderHealth | undefined;
  /** True when THIS provider's shown result is recorded rather than live. */
  fallback: boolean;
  /** True when a live inference from this provider is what is on screen. */
  live?: boolean;
}) {
  // A liveness probe can pass while the inference call is refused for quota —
  // that is exactly what a 429 is. Showing CONNECTED beside a recorded opinion
  // would be the single most misleading thing on the page, so the analysis
  // outcome overrides the probe here.
  if (fallback) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-warn">
        <span className="text-[7px] leading-none">●</span>
        {DEMO_DATA_LABEL}
      </span>
    );
  }
  if (!health) return null;
  const connected = health.status === "CONNECTED";
  // A provider whose live answer IS being shown is LIVE, not merely reachable.
  if (connected && live) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-pos/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-pos">
        <span className="text-[7px] leading-none">●</span>
        {LIVE_LABEL}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em]",
        connected
          ? "bg-pos/15 text-pos"
          : health.status === "NOT_CONFIGURED"
            ? "bg-hairline text-ink-faint"
            : "bg-neg/15 text-neg",
      )}
      title={health.detail ?? `${health.modelId ?? ""} · ${health.latencyMs ?? "?"}ms`}
    >
      <span className="text-[7px] leading-none">●</span>
      {connected ? "CONNECTED" : health.status.replace(/_/g, " ")}
    </span>
  );
}

function ProviderColumn({
  provider,
  result,
  health,
  pending,
}: {
  /** Which column this is, known before any answer arrives. */
  provider: ProviderId;
  result: ProviderResult | undefined;
  health: ProviderHealth | undefined;
  pending: boolean;
}) {
  const label = health?.label ?? PROVIDER_LABEL[provider];
  const isFallbackResult = result?.status === "DEMO_FALLBACK";
  const isLiveResult = result?.status === "OK";

  // Waiting on a real inference. Reported as waiting, never as a blank opinion.
  if (!result) {
    return (
      <div className="flex h-full flex-col rounded-xl border border-hairline bg-surface-sunken px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <ProviderMark provider={provider} className="opacity-60" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{label}</div>
              <HealthChip health={health} fallback={false} />
            </div>
          </div>
        </div>
        <div className="mt-3 border-t border-hairline/70 pt-3 text-[15px] font-semibold text-ink-faint">
          {pending ? "Analyzing…" : "No opinion"}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
          {pending
            ? "The invoice has been sent to this provider. Nothing is shown until it answers."
            : "This provider has not been asked for an opinion on this invoice."}
        </p>
      </div>
    );
  }

  // A RECORDED analysis is not an unavailable provider. It renders as a full
  // card — the judge still sees a recommendation, a confidence and a risk —
  // with its provenance stated on it rather than an error in its place.
  if (result.status !== "OK" && result.status !== "DEMO_FALLBACK") {
    return (
      <div className="flex h-full flex-col rounded-xl border border-hairline bg-surface-sunken px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <ProviderMark provider={result.provider} className="opacity-60" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{label}</div>
              <HealthChip health={health} fallback={false} />
            </div>
          </div>
        </div>
        <div className="mt-3 border-t border-hairline/70 pt-3 text-[15px] font-semibold text-ink-faint">
          {result.status === "UNCONFIGURED" ? "Not configured" : "Unavailable"}
        </div>
        {/* The real reason, including the variable name. No invented figure. */}
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{result.reason}</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-xl border px-4 py-3.5",
        // Background and border carry the LIVE / DEMO DATA distinction and
        // nothing else. Provider identity is the mark's job, so the two signals
        // never compete for the same pixels.
        isFallbackResult ? "border-warn/30 bg-warn-soft" : "border-ai/30 bg-ai-soft",
      )}
    >
      {/* Identity: who answered, and whether this is their live answer. */}
      <div className="flex items-start gap-2.5">
        <ProviderMark provider={result.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="text-[13px] font-semibold tracking-[-0.01em] text-ink">{label}</div>
            <HealthChip health={health} fallback={isFallbackResult} live={isLiveResult} />
          </div>
          <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.07em] text-ink-faint">
            {result.status === "DEMO_FALLBACK" ? "Recorded provider analysis" : "Model"}
          </div>
          <div className="truncate font-mono text-[10px] text-ink-soft" title={
            result.status === "DEMO_FALLBACK" ? ORIGIN_LABEL[result.origin] : result.modelId
          }>
            {result.status === "DEMO_FALLBACK" ? ORIGIN_LABEL[result.origin] : result.modelId}
          </div>
        </div>
      </div>

      {/* The verdict, given the weight a reader scanning two columns needs. */}
      <div className="mt-3 border-t border-hairline/70 pt-3">
        <div className="text-[21px] font-semibold leading-none tracking-[-0.02em] text-ink">
          {result.action.replace(/_/g, " ")}
        </div>

        <dl className="mt-2.5 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[11.5px] text-ink-faint">Confidence</dt>
            <dd className="flex items-center gap-2">
              {/* A bar as well as a number: two columns are compared far faster
                  by length than by reading two percentages. Omitted entirely
                  when no figure was measured, rather than drawn at zero. */}
              {result.confidence !== null ? (
                <span className="h-1 w-14 overflow-hidden rounded-full bg-hairline">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      isFallbackResult ? "bg-warn/70" : "bg-ai/70",
                    )}
                    style={{ width: `${Math.round(result.confidence * 100)}%` }}
                  />
                </span>
              ) : null}
              <span className="tabular text-[13px] font-semibold text-ink">
                {result.confidence === null ? "—" : `${Math.round(result.confidence * 100)}%`}
              </span>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[11.5px] text-ink-faint">Risk</dt>
            <dd className={cn("text-[13px] font-semibold", RiskTone(result.risk))}>
              {result.risk}
            </dd>
          </div>
        </dl>
      </div>

      <p className="mt-2.5 border-t border-ai/20 pt-2.5 text-[11.5px] leading-relaxed text-ink-soft">
        {result.summary}
      </p>

      {result.reasons.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {result.reasons.slice(0, 4).map((reason) => (
            <li key={reason} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-soft">
              <span
                className={cn(
                  "mt-[6px] size-1 shrink-0 rounded-full",
                  isFallbackResult ? "bg-warn/50" : "bg-ai/50",
                )}
              />
              {reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

export function AiProviderPanel({
  snapshot,
  analysis,
  analyzing,
  analysisError,
  invoice,
  onSelectInvoice,
}: {
  snapshot: DefenseSnapshot | null;
  analysis: DefenseAnalysis | null;
  analyzing: boolean;
  analysisError: string | null;
  /** The invoice the URL selects. Both providers are asked about this one. */
  invoice: string;
  onSelectInvoice: (invoiceNumber: string) => void;
}) {
  const catalog = snapshot?.catalog ?? [];
  const selected = catalog.find((entry) => entry.invoiceNumber === invoice) ?? null;
  const health = snapshot?.health ?? [];
  const healthFor = (provider: "gemini" | "cloudflare") =>
    health.find((entry) => entry.provider === provider);
  const resultFor = (provider: "gemini" | "cloudflare") =>
    analysis?.providers.find((entry) => entry.provider === provider);

  const consensus = analysis?.consensus ?? null;
  const agreed = consensus?.kind === "CONSENSUS";
  const fallback = analysis?.mode === "DEMO_FALLBACK";

  return (
    <Panel>
      <PanelHeader
        eyebrow="Intelligence"
        title="AI treasury intelligence"
        subtitle={
          // The claim first, then WHICH invoice it was made about — read from
          // the analysis rather than the selection, so the heading always names
          // the invoice that was actually analyzed.
          analysis
            ? `Gemini + Cloudflare independently analyze the same invoice. AI consensus is advisory. · ${analysis.invoiceNumber} — ${money(analysis.amountCents)}`
            : selected
              ? `Gemini + Cloudflare independently analyze the same invoice. · ${selected.invoiceNumber} — ${money(selected.amountCents)}`
              : "Gemini + Cloudflare independently analyze the same invoice. AI consensus is advisory."
        }
        actions={
          <Badge
            tone={fallback ? "warning" : analysis ? "positive" : "neutral"}
            dot
          >
            {analyzing ? "ANALYZING" : fallback ? "DEMO FALLBACK" : analysis ? "LIVE AI ANALYSIS" : "IDLE"}
          </Badge>
        }
      />
      <PanelBody className="space-y-4">
        {/* DEMO MODE, stated calmly and before any figure below it.
            Amber rather than red: an exhausted free-tier quota is an expected
            operating condition of a hackathon demo, not a failure of the
            system, and a red alarm here would misdescribe what happened. */}
        {analysis ? (
          <div
            className={cn(
              "rounded-xl border px-4 py-3",
              fallback ? "border-warn/35 bg-warn-soft" : "border-pos/35 bg-pos-soft",
            )}
          >
            <div className={cn("text-[13px] font-semibold", fallback ? "text-warn" : "text-pos")}>
              {fallback ? "DEMO MODE" : "LIVE AI ANALYSIS"}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
              {fallback
                ? analysis.disclaimer
                : "Both providers returned a live inference for this invoice."}
            </p>

            {/* The raw provider errors, folded away. A judge does not need a
                429 payload in their eyeline; an engineer asking "why?" does. */}
            {fallback && analysis.liveFailures.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium text-ink-soft underline decoration-dotted underline-offset-2">
                  Why demo mode?
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {analysis.liveFailures.map((failure) => (
                    <li
                      key={failure.provider}
                      className="break-words font-mono text-[10px] leading-relaxed text-ink-faint"
                    >
                      <span className="font-semibold">{failure.provider}</span> · {failure.status}
                      {failure.reason ? ` — ${failure.reason.slice(0, 400)}` : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        {/* WHICH INVOICE. Placed above the columns so it reads as the subject of
            the analysis rather than as a filter applied after the fact. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline bg-surface-sunken px-3.5 py-2.5">
          <label
            htmlFor="defense-invoice"
            className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint"
          >
            Invoice under analysis
          </label>
          <select
            id="defense-invoice"
            value={invoice}
            disabled={catalog.length === 0}
            onChange={(event) => onSelectInvoice(event.target.value)}
            className="h-8 rounded-lg border border-hairline bg-surface px-2 text-[12.5px] font-medium text-ink disabled:opacity-55"
          >
            {catalog.length === 0 ? (
              <option value={invoice}>{invoice}</option>
            ) : (
              catalog.map((entry) => (
                <option key={entry.invoiceNumber} value={entry.invoiceNumber}>
                  {entry.invoiceNumber} — {money(entry.amountCents)} — {entry.label}
                </option>
              ))
            )}
          </select>
          {selected ? (
            <span className="tabular text-[12px] text-ink-soft">
              {money(selected.amountCents)} · {selected.label}
            </span>
          ) : null}
          {analyzing ? (
            <span className="text-[11.5px] text-ink-faint">re-running both providers…</span>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {(["gemini", "cloudflare"] as const).map((provider) => (
            <ProviderColumn
              key={provider}
              provider={provider}
              result={resultFor(provider)}
              health={healthFor(provider)}
              pending={analyzing}
            />
          ))}
        </div>

        {analysisError ? (
          <div className="rounded-xl border border-neg/35 bg-neg-soft px-4 py-3">
            <div className="text-[13px] font-semibold text-neg">Analysis failed</div>
            {/* The real error. No opinion is shown in its place. */}
            <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{analysisError}</p>
          </div>
        ) : null}

        {/* THE CONNECTOR. Two columns feeding one verdict, drawn with borders
            rather than a diagram — the relationship is the point, and a reader
            should get it without stopping to parse a picture. */}
        {consensus ? (
          <div aria-hidden className="flex items-stretch justify-center pt-1">
            <div className="h-3 w-1/2 border-r border-t border-hairline" />
            <div className="h-3 w-1/2 border-l border-t border-hairline" />
          </div>
        ) : null}

        {/* The verdict, shown as the RESULT of the two cards above it: each
            provider's action restated, then the arrow, then the consensus. */}
        {consensus ? (
          <div
            className={cn(
              "rounded-xl border px-4 py-3.5",
              agreed ? "border-pos/35 bg-pos-soft" : "border-warn/35 bg-warn-soft",
            )}
          >
            <div className={cn("text-[13.5px] font-semibold", agreed ? "text-pos" : "text-warn")}>
              {agreed ? "✓ AI CONSENSUS" : "⚠ AI DISAGREEMENT"}
            </div>

            {/* The inputs, named, so the conclusion is auditable on its face. */}
            <dl className="mt-2.5 space-y-1">
              {(["gemini", "cloudflare"] as const).map((id) => {
                const entry = resultFor(id);
                // Narrowed positively: TypeScript cannot split the union-typed
                // discriminant on ProviderUnavailable, so the readable cases
                // are named rather than excluded.
                const action =
                  !entry
                    ? "—"
                    : entry.status === "OK" || entry.status === "DEMO_FALLBACK"
                      ? entry.action.replace(/_/g, " ")
                      : entry.status === "UNCONFIGURED"
                        ? "not configured"
                        : "unavailable";
                return (
                  <div key={id} className="flex items-baseline gap-2">
                    <ProviderMark provider={id} className="size-4 rounded" />
                    <dt className="w-[76px] shrink-0 text-[11.5px] text-ink-soft">
                      {PROVIDER_LABEL[id]}
                    </dt>
                    <dd className="text-[11.5px] font-semibold text-ink">{action}</dd>
                  </div>
                );
              })}
            </dl>

            <div aria-hidden className="mt-2 text-center text-[11px] leading-none text-ink-faint">
              ↓
            </div>

            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline/60 pt-2.5">
              <div className="text-[12px] text-ink-soft">
                Consensus →{" "}
                <span
                  className={cn("text-[14px] font-semibold", agreed ? "text-pos" : "text-warn")}
                >
                  {consensus.recommendedAction.replace(/_/g, " ")}
                </span>
              </div>
              <div className="tabular text-[11px] text-ink-faint">
                {consensus.meanConfidence !== null
                  ? `Mean confidence ${Math.round(consensus.meanConfidence * 100)}%`
                  : "No confidence recorded"}
                {consensus.highestRisk ? ` · Highest risk ${consensus.highestRisk}` : ""}
              </div>
            </div>

            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-soft">{consensus.detail}</p>
          </div>
        ) : null}

        {/* THE LEGEND. Three provenances, named once, so every dot elsewhere on
            the page can be read without explanation. */}
        <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
          <Eyebrow>Reading this page</Eyebrow>
          <dl className="mt-1.5 space-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[9px] leading-none text-pos">●</span>
              <dt className="w-[74px] shrink-0 text-[11px] font-semibold text-ink">LIVE</dt>
              <dd className="text-[11px] leading-relaxed text-ink-soft">Real model inference.</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[9px] leading-none text-warn">●</span>
              <dt className="w-[74px] shrink-0 text-[11px] font-semibold text-ink">DEMO DATA</dt>
              <dd className="text-[11px] leading-relaxed text-ink-soft">
                Pre-recorded provider analysis, used when live inference is unavailable.
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[9px] leading-none text-chain">●</span>
              <dt className="w-[74px] shrink-0 text-[11px] font-semibold text-ink">ON-CHAIN</dt>
              <dd className="text-[11px] leading-relaxed text-ink-soft">
                Read directly from Sui.
              </dd>
            </div>
          </dl>
        </div>

        {/* The claim this panel is not allowed to support, stated on the panel
            itself rather than left to the reader to infer. Permanently visible:
            it is the security argument, not a caveat to be dismissed. */}
        <div className="rounded-xl border border-hairline bg-surface-sunken px-3.5 py-3">
          <Eyebrow>What this does not do</Eyebrow>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
            {analysis?.consensusCaveat ?? snapshot?.consensusCaveat ?? ""}
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}
