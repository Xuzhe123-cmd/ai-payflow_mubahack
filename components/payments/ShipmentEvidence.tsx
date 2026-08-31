"use client";

/**
 * Shipment proof and oracle evidence, on the invoice that depends on it.
 *
 * CONDITION-DRIVEN, WITH NO EXCEPTIONS. This renders for an invoice that has a
 * shipment condition on chain and for no other, and it learns which is which by
 * asking the chain. There is no invoice number in this file, and there must
 * never be one — the conditional invoices that exist today are the ones the
 * demo data happens to define, not the ones the code knows about. An invoice
 * created tomorrow with the same condition gets the same panel, unchanged.
 *
 * The claim it exists to keep honest:
 *
 *   SHIPMENT PROOF   the document. Evidence, and evidence only.
 *          ↓
 *   SHA-256          what those exact bytes hash to.
 *          ↓
 *   ORACLE           CONFIRMED / WAITING — the only verdict that counts.
 *          ↓
 *   SUI ESCROW       the enforcement layer, and the only one that moves money.
 *          ↓
 *   RELEASE / HOLD
 *
 * So a proof document never makes a shipment confirmed. Confirmation needs an
 * attestation on chain that says confirmed, names this invoice and shipment,
 * and carries the digest the document actually hashes to — the shared rule in
 * lib/oracle/evidence.ts, which the escrow page uses too.
 *
 * TWO QUESTIONS, TWO BLOCKS, and keeping them apart is why this file changed:
 *
 *   REAL-WORLD FACTS   what the oracle established about the shipment
 *   CHAIN SETTLEMENT   what Sui did about the money
 *
 * Run together, a settlement state gets read as an evidence result — which is
 * how an invoice that was paid correctly came to be reported as a discrepancy.
 * The escrow being RELEASED is not something the oracle said, and the oracle
 * confirming a delivery is not something the chain checked.
 */

import { Panel, PanelBody, PanelHeader } from "@/components/common/Panel";
import { Badge, Eyebrow } from "@/components/common/Badge";
import { useConditionState, type ConditionState } from "@/components/hooks/useConditionState";
import {
  chainSettlementSummary,
  evaluateShipmentEvidence,
  evidenceBadge,
  evidenceConclusion,
  shipmentEvidenceRows,
  type EvidenceCheck,
  type EvidenceRow,
} from "@/lib/oracle/evidence";
import { money } from "@/lib/escrow/present";
import { PROOF_DISCLAIMER } from "@/lib/escrow/proofDocument";
import { SHIPMENT_ORACLE_LABEL } from "@/lib/oracle/shipment";
import { cn } from "@/lib/utils";

export function ShipmentEvidence({ invoiceNumber }: { invoiceNumber: string }) {
  const { condition, resolved } = useConditionState(invoiceNumber);

  // No shipment condition on this invoice — an ordinary payment, and no oracle
  // section. Inventing one would claim a verification that never happened.
  if (!resolved || !condition) return null;

  const evidence = evaluateShipmentEvidence({
    invoiceNumber,
    proof: condition.proof,
    attestation: condition.attestation,
  });
  const confirmed = evidence.confirmed;
  const released = condition.stage === "RELEASED";
  const badge = evidenceBadge(evidence.verdict);

  // Evidence only. The escrow is deliberately not in scope here — what Sui did
  // with the money is a separate question, answered by the block below.
  const rows = shipmentEvidenceRows({
    invoiceNumber,
    proof: condition.proof,
    attestation: condition.attestation,
    oracleName: SHIPMENT_ORACLE_LABEL,
    attestationId: condition.escrow?.attestationId ?? null,
  });

  const conclusion = evidenceConclusion({
    invoiceNumber,
    proof: condition.proof,
    attestation: condition.attestation,
    released,
  });

  // The money, asked as its own question. Released reports what left; held
  // reports what is still locked, which are different amounts.
  const settlement = chainSettlementSummary({
    released,
    amountLabel: money(released ? condition.amountCents : condition.fundsHeldCents),
  });

  return (
    <Panel tone={confirmed ? "positive" : "default"}>
      <PanelHeader
        eyebrow="Real-world facts"
        title="The condition this payment settles against"
        subtitle="A proof document is evidence. The oracle decides. Sui enforces."
        actions={
          // Names the ORACLE's state, and only that. The chain holding an
          // escrow object says nothing about whether a delivery happened, so no
          // badge here may claim the chain verified the shipment itself.
          <Badge tone={confirmed ? "positive" : "warning"} dot>
            {badge}
          </Badge>
        }
      />

      <PanelBody className="px-5 py-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <div>
            {/* The verdict, stated once and in one place. */}
            <div
              className={cn(
                "flex items-baseline gap-2.5 rounded-xl border px-4 py-3",
                confirmed ? "border-pos/35 bg-pos-soft" : "border-warn/35 bg-warn-soft",
              )}
            >
              <span
                className={cn(
                  "text-[15px] leading-none",
                  confirmed ? "text-pos" : "text-warn",
                )}
              >
                {confirmed ? "✓" : "⚠"}
              </span>
              <span
                className={cn(
                  "text-[17px] font-semibold tracking-[-0.01em]",
                  confirmed ? "text-pos" : "text-warn",
                )}
              >
                {conclusion.headline}
              </span>
            </div>

            <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-soft">
              {conclusion.detail}
            </p>

            <dl className="mt-3.5 divide-y divide-hairline rounded-xl border border-hairline bg-surface px-4">
              {rows.map((row) => (
                <Row key={row.label} row={row} />
              ))}
            </dl>

            {/* What the evidence establishes, as claims rather than values. */}
            <ul className="mt-3.5 space-y-1.5">
              {conclusion.checks.map((check) => (
                <Check key={check.label} check={check} />
              ))}
            </ul>

            {/* THE MONEY, ASKED SEPARATELY. Sui enforced the condition; the
                oracle did not, and this block never borrows its voice. */}
            <div
              className={cn(
                "mt-4 rounded-xl border px-4 py-3",
                settlement.released
                  ? "border-pos/35 bg-pos-soft"
                  : "border-warn/35 bg-warn-soft",
              )}
            >
              <Eyebrow className={settlement.released ? "text-pos" : "text-warn"}>
                Chain settlement
              </Eyebrow>
              <div className="mt-2 flex items-baseline gap-2.5">
                <span
                  className={cn(
                    "text-[15px] leading-none",
                    settlement.released ? "text-pos" : "text-warn",
                  )}
                >
                  {settlement.released ? "✓" : "⚠"}
                </span>
                <span
                  className={cn(
                    "text-[15px] font-semibold tracking-[-0.01em]",
                    settlement.released ? "text-pos" : "text-warn",
                  )}
                >
                  {settlement.headline}
                </span>
              </div>
              <div
                className={cn(
                  "tabular mt-1 text-[19px] font-semibold tracking-[-0.015em]",
                  settlement.released ? "text-pos" : "text-warn",
                )}
              >
                {settlement.amountLabel}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                {settlement.detail}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <Flow confirmed={confirmed} condition={condition} released={released} />

            <div className="rounded-xl border border-hairline bg-surface-sunken p-4">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Who does what
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                The document is evidence. The oracle attests to it. Sui escrow enforces the
                release condition. <strong className="text-ink">The oracle does not move
                funds.</strong>
              </p>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
                {PROOF_DISCLAIMER}. {SHIPMENT_ORACLE_LABEL} is a controlled hackathon oracle, not
                a carrier integration.
              </p>
            </div>

            {condition.escrow ? (
              <a
                href={condition.escrow.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate rounded-lg border border-hairline bg-surface px-3 py-2 font-mono text-[10.5px] text-chain underline"
              >
                {condition.escrow.objectId}
              </a>
            ) : null}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

/**
 * The chain of custody, top to bottom, with each link named.
 *
 * Read as a sequence it says the payment happened ONCE and says why: a
 * document, its digest, an attestation over that digest, the escrow condition
 * that digest satisfied, the release, and then nothing further. The last step
 * exists to close it off — without it a reader can wonder whether the flow is
 * still running and another payment is due.
 */
function Flow({
  confirmed,
  condition,
  released,
}: {
  confirmed: boolean;
  condition: ConditionState;
  released: boolean;
}) {
  const steps: { label: string; value: string; tone: "default" | "positive" | "warning" }[] = [
    {
      label: "Shipment proof",
      value: condition.proof?.deliveryStatus ?? "NONE",
      tone: condition.proof?.deliveryStatus === "DELIVERED" ? "positive" : "warning",
    },
    {
      label: "SHA-256 hash",
      // Truncated: the full digest is a row above, and this column is 300px.
      value: condition.proof ? `${condition.proof.sha256.slice(0, 10)}…` : "NONE",
      tone: condition.proof ? "default" : "warning",
    },
    {
      label: "Oracle attestation",
      value: confirmed ? "CONFIRMED" : condition.attestation ? "NOT CONFIRMED" : "WAITING",
      tone: confirmed ? "positive" : "warning",
    },
    {
      label: "Sui escrow condition",
      value: confirmed ? "SATISFIED" : "NOT SATISFIED",
      tone: confirmed ? "positive" : "warning",
    },
    {
      label: released ? "Released" : "Held",
      value: released ? money(condition.amountCents) : money(condition.fundsHeldCents),
      tone: released ? "positive" : "warning",
    },
  ];

  // Only once the money has actually moved. On a held escrow the invoice is not
  // paid and a further action is exactly what is still expected.
  if (released) {
    steps.push({ label: "Invoice", value: "PAID", tone: "positive" });
    steps.push({ label: "Further payment", value: "NONE", tone: "default" });
  }

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <Eyebrow>Flow</Eyebrow>
      <ol className="mt-3 space-y-1">
        {steps.map((step, index) => (
          <li key={step.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-ink-faint">{step.label}</span>
              <span
                className={cn(
                  "truncate text-[12.5px] font-semibold",
                  step.tone === "positive" && "text-pos",
                  step.tone === "warning" && "text-warn",
                  step.tone === "default" && "text-ink",
                )}
              >
                {step.value}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <div className="py-0.5 text-[11px] leading-none text-ink-faint">↓</div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Check({ check }: { check: EvidenceCheck }) {
  return (
    <li className="flex items-baseline gap-2 text-[12.5px] leading-relaxed">
      <span className={cn("shrink-0", check.ok ? "text-pos" : "text-warn")}>
        {check.ok ? "✓" : "⚠"}
      </span>
      <span className={check.ok ? "text-ink-soft" : "text-warn"}>{check.label}</span>
    </li>
  );
}

function Row({ row }: { row: EvidenceRow }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-[12px] text-ink-faint">{row.label}</dt>
      <dd
        className={cn(
          "truncate text-[12.5px] font-medium",
          row.mono && "font-mono text-[11px]",
          row.tone === "positive" && "text-pos",
          row.tone === "warning" && "text-warn",
          row.tone === "default" && "text-ink",
        )}
      >
        {row.value}
      </dd>
    </div>
  );
}
