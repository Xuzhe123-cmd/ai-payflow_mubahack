/**
 * Risk, for an invoice whose payment has already happened.
 *
 * THE CONFUSION THIS RESOLVES. When a settled invoice is opened, the pipeline
 * re-runs and answers a perfectly sensible question:
 *
 *   "Could we pay this invoice now?"   →  No. It is already settled.
 *
 * That answer is correct, and it is about a payment that does not exist. The
 * risk panel then rendered it as though it described THIS invoice, and the
 * result was a completed $4,800 payment reported as CRITICAL risk with the
 * observation "Duplicate invoice". Every word of that was wrong about the thing
 * the reader was looking at.
 *
 *   CURRENT PAYMENT        $4,800, released. Finished, and it went well.
 *   NEW PAYMENT ATTEMPT    not permitted, because the invoice is settled.
 *
 * So a settled invoice gets a panel describing the transaction that happened.
 * The refusal of a hypothetical second payment is not deleted — it is simply
 * not this invoice's risk assessment, and it belongs where a second payment
 * would actually be initiated.
 *
 * Pure, and driven entirely by chain-derived state. No invoice number decides
 * anything here, and none may.
 */

import type { EscrowDemoStage } from "../escrow/demoFlow";

export interface SettledRiskCheck {
  label: string;
  ok: boolean;
}

export interface SettledRiskView {
  /** The word where a risk LEVEL would otherwise sit. */
  headline: string;
  /** What the assessment is actually of: the completed transaction. */
  assessment: string;
  /** What the chain establishes about how it completed. */
  checks: SettledRiskCheck[];
  /** Said once, plainly, so no reader infers a pending action. */
  note: string;
}

export interface SettledRiskInput {
  /** The escrow stage, or null when the invoice carries no shipment condition. */
  conditionStage: EscrowDemoStage | null;
  /** Whether the shared evidence rule confirms the shipment. */
  oracleConfirmed: boolean;
  /** The invoice object's own status on chain. */
  chainInvoiceStatus: string | null;
  /** The amount that reached the supplier. */
  amountLabel: string;
}

/**
 * The risk panel's content for a settled invoice.
 *
 * Two shapes, because a conditional payment and an ordinary one completed
 * differently and the evidence for each is different. Padding the ordinary case
 * out with shipment ticks would claim an oracle confirmation that never
 * happened — the same error, pointed the other way.
 */
export function describeSettledRisk(input: SettledRiskInput): SettledRiskView {
  const released = input.conditionStage === "RELEASED";

  if (released) {
    return {
      headline: "Payment settled",
      assessment:
        "Payment was successfully released after the shipment condition was satisfied. " +
        `${input.amountLabel} reached the supplier.`,
      checks: [
        { label: "Shipment confirmed", ok: true },
        { label: "Oracle attestation confirmed", ok: input.oracleConfirmed },
        { label: "Escrow condition satisfied", ok: true },
        { label: "Payment released", ok: true },
        {
          label: "Invoice paid on chain",
          ok: isSettledStatus(input.chainInvoiceStatus),
        },
      ],
      note: "No further payment action is available because this invoice has already been settled.",
    };
  }

  return {
    headline: "Payment settled",
    assessment:
      `Payment completed and settled on chain. ${input.amountLabel} reached the supplier. ` +
      "The deterministic checks passed before it was made.",
    checks: [
      { label: "Payment settled on chain", ok: true },
      { label: "Invoice recorded as paid", ok: isSettledStatus(input.chainInvoiceStatus) },
    ],
    note: "No further payment action is available because this invoice has already been settled.",
  };
}

/**
 * Evidence codes that describe settlement rather than an anomaly.
 *
 * Filtered out of the flagged-observations list, because "this invoice was
 * paid" listed under "1 observation flagged" reads as a fault found. The fact
 * itself is not dropped — it is stated by the settled panel above, which is
 * where a completed payment belongs.
 */
export const SETTLEMENT_EVIDENCE_CODES: readonly string[] = ["INVOICE_ALREADY_SETTLED"];

export function isSettlementEvidence(code: string): boolean {
  return SETTLEMENT_EVIDENCE_CODES.includes(code);
}

function isSettledStatus(status: string | null): boolean {
  return status === "PAID" || status === "SETTLED";
}
