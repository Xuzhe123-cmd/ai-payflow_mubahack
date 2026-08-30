"use client";

/**
 * Shipment proof and oracle evidence, on the invoice that depends on it.
 *
 * Rendered only for an invoice whose on-chain condition requires shipment
 * confirmation — decided by chain state, never by an invoice number. An
 * ordinary invoice gets nothing here, because inventing an oracle section would
 * suggest a verification that did not happen.
 *
 * THE DISTINCTION THIS EXISTS TO CARRY, in three separate boxes because they
 * are three separate things:
 *
 *   SHIPMENT PROOF      the evidence document. It proves nothing by itself.
 *   ORACLE ATTESTATION  what the Demo Shipment Oracle said about that document,
 *                       recorded on chain and matched to it by hash.
 *   SUI ESCROW          the enforcement layer. The only one that moves money.
 *
 * So "confirmed" is never shown because a document exists. It requires an
 * attestation that exists, says confirmed, names this invoice and shipment, and
 * carries the digest the document actually hashes to. Any one of those missing
 * and the section says so instead.
 *
 * Reuses ProofCard, the shipment types and the chain-derived escrow state — the
 * same data the escrow page renders, so there is one source of truth.
 */

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { ProofCard } from "@/components/escrow/ProofCard";
import { useConditionState, type ConditionState } from "@/components/hooks/useConditionState";
import type { ShipmentEvidenceResult } from "@/lib/oracle/evidence";
import type { EscrowDemoState } from "@/lib/escrow/demoFlow";
import { money } from "@/lib/escrow/present";
import { PROOF_DISCLAIMER } from "@/lib/escrow/proofDocument";
import { evaluateShipmentEvidence } from "@/lib/oracle/evidence";
import { SHIPMENT_ORACLE_LABEL } from "@/lib/oracle/shipment";
import { cn } from "@/lib/utils";

export function ShipmentEvidence({ invoiceNumber }: { invoiceNumber: string }) {
  const { condition, resolved } = useConditionState(invoiceNumber);

  // No condition on this invoice — an ordinary payment, and no oracle section.
  if (!resolved || !condition) return null;

  // One shared rule, so this page and the escrow page cannot disagree about
  // what counts as verified.
  const evidence = evaluateShipmentEvidence({
    invoiceNumber,
    proof: condition.proof,
    attestation: condition.attestation,
  });
  const oracleConfirmed = evidence.confirmed;
  const hashMatches = evidence.hashMatches;

  const released = condition.stage === "RELEASED";

  const state: EscrowDemoState = {
    invoiceNumber: condition.invoiceNumber,
    amountCents: condition.amountCents,
    stage: condition.stage,
    recipient: condition.recipient,
    proof: condition.proof,
    attestation: condition.attestation,
    escrowObjectId: condition.escrow?.objectId ?? null,
    attestationObjectId: condition.escrow?.attestationId ?? null,
    transactions: [],
  };

  return (
    <Panel tone={released ? "positive" : "default"}>
      <PanelHeader
        eyebrow="Shipment proof & oracle evidence"
        title="The condition this payment settles against"
        subtitle="Evidence, attestation and enforcement are three separate things. Only the last one moves money."
      />

      <PanelBody className="px-5 py-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_20px_minmax(0,0.85fr)]">
          {/* 1 — the document */}
          <ProofCard state={state} />
          <Arrow label="SHA-256" />

          {/* 2 — what the oracle said about it */}
          <AttestationCard condition={condition} evidence={evidence} />
          <Arrow label="enforces" />

          {/* 3 — the layer that actually moves money */}
          <EscrowCard condition={condition} confirmed={oracleConfirmed} />
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
          <ChainSummary condition={condition} evidence={evidence} />

          <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              Who does what
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
              The proof document is evidence. The oracle attests to the evidence. Sui escrow
              enforces the release condition. <strong className="text-ink">The oracle does not
              move funds.</strong>
            </p>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
              {PROOF_DISCLAIMER}. {SHIPMENT_ORACLE_LABEL} is a controlled hackathon oracle, not a
              carrier integration.
            </p>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 xl:py-0">
      <span className="text-[16px] leading-none text-ink-faint xl:rotate-0">↓</span>
      <span className="text-[9.5px] uppercase tracking-[0.06em] text-ink-faint">{label}</span>
    </div>
  );
}

function AttestationCard({
  condition,
  evidence,
}: {
  condition: ConditionState;
  evidence: ShipmentEvidenceResult;
}) {
  const attestation = condition.attestation;
  const confirmed = evidence.confirmed;
  const hashMatches = evidence.hashMatches;

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        confirmed ? "border-pos/35 bg-pos-soft" : "border-hairline bg-surface",
      )}
    >
      <Eyebrow className={confirmed ? "text-pos" : undefined}>Oracle attestation</Eyebrow>

      {!attestation ? (
        <>
          <div className="mt-2.5 text-[17px] font-semibold tracking-[-0.01em] text-warn">
            WAITING
          </div>
          <dl className="mt-3 divide-y divide-hairline">
            <Row label="Oracle" value={SHIPMENT_ORACLE_LABEL} />
            <Row label="Status" value="WAITING" tone="warning" />
            <Row label="Attestation" value="NONE" tone="warning" />
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">{evidence.detail}</p>
        </>
      ) : (
        <>
          <div
            className={cn(
              "mt-2.5 text-[17px] font-semibold tracking-[-0.01em]",
              confirmed ? "text-pos" : "text-warn",
            )}
          >
            {attestation.confirmed ? "CONFIRMED" : "NOT CONFIRMED"}
          </div>
          <dl className="mt-3 divide-y divide-hairline">
            <Row label="Oracle" value={attestation.oracleId} />
            <Row
              label="Status"
              value={attestation.confirmed ? "CONFIRMED" : "NOT CONFIRMED"}
              tone={attestation.confirmed ? "positive" : "warning"}
            />
            <Row label="Invoice" value={attestation.invoiceNumber} />
            <Row label="Shipment" value={attestation.shipmentId} />
            <Row label="Proof hash" value={shorten(attestation.proofSha256)} mono />
            <Row
              label="Hash matches"
              value={hashMatches ? "TRUE" : "FALSE"}
              tone={hashMatches ? "positive" : "negative"}
            />
            <Row
              label="Attestation"
              value={shorten(condition.escrow?.attestationId ?? "—")}
              mono
            />
          </dl>
          {!confirmed ? (
            <p className="mt-3 text-[11.5px] leading-relaxed text-warn">{evidence.detail}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function EscrowCard({
  condition,
  confirmed,
}: {
  condition: ConditionState;
  confirmed: boolean;
}) {
  const released = condition.stage === "RELEASED";
  const status = condition.escrow?.status ?? "none";

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        released ? "border-pos/35 bg-pos-soft" : "border-warn/35 bg-warn-soft",
      )}
    >
      <Eyebrow className={released ? "text-pos" : "text-warn"}>Sui escrow</Eyebrow>
      <div
        className={cn(
          "mt-2.5 text-[17px] font-semibold tracking-[-0.01em]",
          released ? "text-pos" : "text-warn",
        )}
      >
        {released ? "RELEASED" : status}
      </div>

      <dl className="mt-3 divide-y divide-warn/15">
        <Row
          label="Condition"
          value={confirmed ? "Shipment confirmed" : "Shipment not confirmed"}
          tone={confirmed ? "positive" : "warning"}
        />
        <Row label="Escrow" value={money(condition.amountCents)} />
        <Row label="Status" value={status} />
        <Row
          label="Payment"
          value={released ? "RELEASED" : "NOT RELEASED"}
          tone={released ? "positive" : "warning"}
        />
        {!released ? <Row label="Locked" value={money(condition.fundsHeldCents)} tone="warning" /> : null}
      </dl>

      {condition.escrow ? (
        <a
          href={condition.escrow.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block truncate font-mono text-[10.5px] text-chain underline"
        >
          {condition.escrow.objectId}
        </a>
      ) : null}
    </div>
  );
}

function ChainSummary({
  condition,
  evidence,
}: {
  condition: ConditionState;
  evidence: ShipmentEvidenceResult;
}) {
  const confirmed = evidence.confirmed;
  const hashMatches = evidence.hashMatches;
  const released = condition.stage === "RELEASED";
  const hasProof = condition.proof !== null;
  const attestation = condition.attestation;

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        Evidence chain
      </div>
      <ol className="mt-3 space-y-2.5">
        <Step ok={hasProof} label="Proof available" detail={condition.proof?.filename ?? "none"} />
        <Step
          ok={hashMatches}
          pending={attestation === null}
          label={hashMatches ? "Hash matches attestation" : "No attestation to match against"}
          detail={
            attestation === null
              ? "the document has not been attested"
              : hashMatches
                ? shorten(condition.proof?.sha256 ?? "")
                : evidence.detail
          }
        />
        <Step
          ok={confirmed}
          pending={attestation === null}
          label={confirmed ? "Oracle confirmed" : attestation === null ? "Oracle waiting" : "Oracle did not confirm"}
          detail={
            attestation === null
              ? `${SHIPMENT_ORACLE_LABEL} has not attested this shipment`
              : SHIPMENT_ORACLE_LABEL
          }
        />
        <Step
          ok={confirmed}
          pending={!confirmed}
          label={confirmed ? "Escrow condition satisfied" : "Escrow condition not satisfied"}
          detail={
            confirmed
              ? "Sui verified the attestation against the escrow"
              : `${money(condition.fundsHeldCents)} remains locked`
          }
        />
        <Step
          ok={released}
          pending={!released}
          label={released ? "Payment released" : "Payment not released"}
          detail={
            released
              ? `${money(condition.amountCents)} paid to the registered supplier wallet`
              : "the supplier has not received the funds"
          }
        />
      </ol>
    </div>
  );
}

function Step({
  ok,
  pending = false,
  label,
  detail,
}: {
  ok: boolean;
  pending?: boolean;
  label: string;
  detail: string;
}) {
  return (
    <li className="flex gap-2.5">
      <span
        className={cn(
          "mt-[2px] shrink-0 text-[12px] font-semibold",
          ok ? "text-pos" : pending ? "text-warn" : "text-neg",
        )}
      >
        {ok ? "✓" : pending ? "⏳" : "✕"}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        <span className="block truncate text-[11.5px] text-ink-faint">{detail}</span>
      </span>
    </li>
  );
}

function Row({
  label,
  value,
  tone = "default",
  mono = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "warning" | "negative";
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11.5px] text-ink-faint">{label}</dt>
      <dd
        className={cn(
          "truncate text-[12px] font-medium",
          mono && "font-mono text-[11px]",
          tone === "positive" && "text-pos",
          tone === "warning" && "text-warn",
          tone === "negative" && "text-neg",
          tone === "default" && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function shorten(value: string): string {
  if (!value || value.length <= 20) return value || "—";
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}
