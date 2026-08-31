"use client";

/**
 * One conditional invoice, from authorised to settled or held.
 *
 * The control row is rendered from `availableActions(state)` and from nothing
 * else. That is deliberate: the requirement "no release button after an
 * unconfirmed proof" is then a property of a pure function with tests, rather
 * than of a condition written inline here where it could quietly rot.
 *
 * Nothing in this component decides anything about money. It calls the API for
 * the artifacts an action needs and applies the same `advance` the tests drive.
 */

import { useEffect, useState } from "react";

import { Badge, Eyebrow } from "@/components/common/Badge";
import { ProofCard } from "./ProofCard";
import {
  advance,
  availableActions,
  initialState,
  type EscrowDemoAction,
  type EscrowDemoState,
} from "@/lib/escrow/demoFlow";
import { money, summariseSettlement } from "@/lib/escrow/present";
import { SHIPMENT_ORACLE_LABEL } from "@/lib/oracle/shipment";
import { cn } from "@/lib/utils";

export interface EscrowDemoInvoice {
  label: string;
  invoiceNumber: string;
  amountCents: number;
  supplierName: string;
  recipient: string;
  objectId: string;
  /** What this half of the demo is meant to show. */
  claim: string;
}

const TONE_SHELL: Record<string, string> = {
  neutral: "border-hairline bg-surface",
  chain: "border-chain-border bg-chain-soft",
  warning: "border-warn/35 bg-warn-soft",
  positive: "border-pos/35 bg-pos-soft",
};

const TONE_TEXT: Record<string, string> = {
  neutral: "text-ink",
  chain: "text-chain",
  warning: "text-warn",
  positive: "text-pos",
};

export function EscrowDemo({
  invoice,
  live,
}: {
  invoice: EscrowDemoInvoice;
  /** State derived from the chain. Absent only before the first read. */
  live?: EscrowDemoState | null;
}) {
  const [state, setState] = useState<EscrowDemoState>(() =>
    live ??
      initialState({
        invoiceNumber: invoice.invoiceNumber,
        amountCents: invoice.amountCents,
        recipient: invoice.recipient,
      }),
  );

  // The chain is the authority. When a fresh read arrives it replaces whatever
  // the local flow believed — a reload must show what the escrow says, not a
  // story assembled from clicks.
  useEffect(() => {
    if (live) setState(live);
  }, [live]);
  const [working, setWorking] = useState<EscrowDemoAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPlan, setLastPlan] = useState<string | null>(null);
  /** "testnet" once the server is executing for real. */
  const [mode, setMode] = useState<"simulated" | "testnet">("simulated");

  const actions = availableActions(state);
  const summary = summariseSettlement(state);

  async function run(action: EscrowDemoAction) {
    setWorking(action);
    setError(null);
    try {
      const response = await fetch("/api/escrow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: invoice.invoiceNumber,
          action,
          // Pointers only. The server re-reads every fact from chain.
          escrowObjectId: state.escrowObjectId,
          attestationObjectId: state.attestationObjectId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The demo step failed.");

      setLastPlan(payload.plan?.rendered ?? null);
      setMode(payload.mode ?? "simulated");

      // A refusal is not a transition. The chain, or a guard, said no — and the
      // flow must stay exactly where it was rather than pretend otherwise.
      if (payload.ok === false) {
        const refusal = payload.guard?.refusal ?? payload.error ?? "The step was refused.";
        // "on chain" only where a transaction actually reached the network.
        // In simulated mode nothing is submitted, so the same abort code has to
        // be described as a preflight verdict rather than a rejection.
        const submitted = (payload.mode ?? "simulated") !== "simulated";
        setError(
          payload.abortCode
            ? submitted
              ? `Rejected by Sui with abort code ${payload.abortCode}. ${refusal}`
              : `Would be refused by Sui with abort code ${payload.abortCode}. ` +
                `No transaction was submitted and no funds moved. ${refusal}`
            : refusal,
        );
        return;
      }

      setState((current) =>
        advance({
          state: current,
          action,
          proof: payload.proof ?? undefined,
          attestation: payload.attestation ?? undefined,
          escrowObjectId: payload.escrowObjectId ?? undefined,
          attestationObjectId: payload.attestationObjectId ?? undefined,
          transaction: payload.transaction,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="rounded-xl border border-hairline bg-surface">
      {/* --- the invoice ---------------------------------------------------- */}
      <div className="border-b border-hairline px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <Eyebrow>{invoice.label}</Eyebrow>
            <div className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">
              {invoice.invoiceNumber} · {money(invoice.amountCents)}
            </div>
            <div className="mt-0.5 text-[12.5px] text-ink-soft">{invoice.supplierName}</div>
          </div>
          <div className="flex items-center gap-2">
            {mode === "testnet" ? (
              <Badge tone="chain" dot>
                Real testnet transaction
              </Badge>
            ) : null}
            <Badge tone="warning" dot>
              Shipment condition required
            </Badge>
          </div>
        </div>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">{invoice.claim}</p>
      </div>

      {/* --- what the AI and the guard already decided ----------------------- */}
      <div className="grid gap-px border-b border-hairline bg-hairline sm:grid-cols-3">
        <Fact label="AI recommendation" value="PAY NOW" tone="ai" />
        <Fact label="Autonomous authority" value="WITHIN LIMIT" tone="positive" />
        <Fact label="Shipment condition" value="REQUIRED" tone="warning" />
      </div>

      {/* --- settlement state ------------------------------------------------ */}
      <div className={cn("border-b border-hairline px-5 py-4", TONE_SHELL[summary.tone])}>
        <div className={cn("text-[17px] font-semibold tracking-[-0.01em]", TONE_TEXT[summary.tone])}>
          {summary.headline}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{summary.detail}</p>

        {summary.fundsLocked ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-surface px-3 py-2">
            <span className="text-[13px]">🔒</span>
            <span className="text-[12.5px] font-medium text-ink">
              {summary.amountLabel} locked · supplier has not been paid
            </span>
          </div>
        ) : null}

        {state.escrowObjectId || state.attestationObjectId ? (
          <dl className="mt-3 space-y-1">
            {state.escrowObjectId ? (
              <ObjectRow label="Escrow object" id={state.escrowObjectId} />
            ) : null}
            {state.attestationObjectId ? (
              <ObjectRow label="Attestation" id={state.attestationObjectId} />
            ) : null}
          </dl>
        ) : null}

        {state.stage === "RELEASED" ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-pos/30 bg-surface px-3 py-2">
            <span className="text-[13px]">✓</span>
            <span className="text-[12.5px] font-medium text-ink">
              Supplier PAID · {summary.amountLabel} · escrow now holds $0
            </span>
          </div>
        ) : null}
      </div>

      {/* --- proof ----------------------------------------------------------- */}
      <div className="px-5 py-4">
        <ProofCard state={state} />
      </div>

      {/* --- controls, from state and nothing else --------------------------- */}
      <div className="border-t border-hairline px-5 py-4">
        {actions.length > 0 ? (
          <div className="space-y-2.5">
            {actions.map((entry) => (
              <div key={entry.action}>
                <button
                  type="button"
                  disabled={working !== null}
                  onClick={() => void run(entry.action)}
                  className={cn(
                    "h-9 rounded-lg px-3.5 text-[13px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                    entry.tone === "chain" && "bg-chain hover:bg-chain/90",
                    entry.tone === "ai" && "bg-ai hover:bg-ai/90",
                    entry.tone === "neutral" && "bg-ink hover:bg-ink/90",
                  )}
                >
                  {working === entry.action ? "Working…" : entry.label}
                </button>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">
                  {entry.detail}
                </p>
              </div>
            ))}
          </div>
        ) : state.stage === "HELD" ? (
          // Not a disabled release button — no release control at all.
          <div className="rounded-lg border border-warn/35 bg-warn-soft px-4 py-3">
            <div className="text-[13px] font-semibold text-warn">Funds held in escrow</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">
              There is no release control here, because there is nothing that could authorise one.
              The {SHIPMENT_ORACLE_LABEL} has not attested this shipment as delivered, and{" "}
              <span className="font-mono">escrow::release</span> would abort with{" "}
              <span className="font-mono">EShipmentNotConfirmed</span> if it were called anyway.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-pos/30 bg-pos-soft px-4 py-3 text-[12.5px] text-ink-soft">
            Settled. The escrow is empty and the payment record is frozen on chain.
          </div>
        )}

        {error ? (
          <p className="mt-3 rounded-lg border border-neg/30 bg-neg-soft px-3 py-2 text-[12px] text-neg">
            {error}
          </p>
        ) : null}
      </div>

      {/* --- what would be submitted ----------------------------------------- */}
      {state.transactions.length > 0 ? (
        <div className="border-t border-hairline bg-surface-sunken px-5 py-4">
          <Eyebrow>Steps taken</Eyebrow>
          <ol className="mt-2.5 space-y-1.5">
            {state.transactions.map((entry, index) => (
              <li key={`${entry.action}-${index}`}>
                <div className="flex items-baseline gap-2.5">
                  <span className="text-[11px] text-ink-faint">{index + 1}.</span>
                  <span className="text-[12px] text-ink">{entry.label}</span>
                  <span className="ml-auto shrink-0 rounded border border-hairline px-1.5 py-px text-[10px] uppercase tracking-wide text-ink-faint">
                    {entry.mode}
                  </span>
                </div>
                {entry.digest ? (
                  <div className="ml-[18px] mt-0.5 flex items-baseline gap-2">
                    <span className="truncate font-mono text-[10.5px] text-ink-soft">
                      {entry.digest}
                    </span>
                    {entry.explorerUrl ? (
                      <a
                        href={entry.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-[10.5px] text-chain underline"
                      >
                        explorer
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          {lastPlan ? (
            <pre className="mt-3 overflow-x-auto rounded-lg border border-hairline bg-surface p-3 text-[10.5px] leading-relaxed text-ink-soft">
              {lastPlan}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** An on-chain object id, shown only once the chain has produced one. */
function ObjectRow({ label, id }: { label: string; id: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-ink-faint">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-ink-soft">{id}</dd>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ai" | "positive" | "warning";
}) {
  return (
    <div className="bg-surface px-5 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">{label}</div>
      <div
        className={cn(
          "mt-1 text-[13.5px] font-semibold",
          tone === "ai" && "text-ai",
          tone === "positive" && "text-pos",
          tone === "warning" && "text-warn",
        )}
      >
        {value}
      </div>
    </div>
  );
}
