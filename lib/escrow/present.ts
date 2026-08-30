/**
 * Turning escrow state into what a judge reads.
 *
 * Pure, and deliberately so: the sentence shown next to $4,000 that has left
 * the treasury and not reached a supplier is the whole demo, and it should be
 * assertable in a test rather than buried in JSX.
 *
 * The vocabulary is chosen to keep four different kinds of "no" apart:
 *   REJECT   the payment is wrong and will never be made
 *   HELD     the payment is right, and waiting on the world
 *   RELEASED settled
 *   REFUNDED abandoned, funds returned
 * Only the second is what escrow is for, and conflating it with rejection is
 * the single easiest way to misrepresent this system.
 */

import { SHIPMENT_ORACLE_LABEL } from "../oracle/shipment";
import { evaluateShipmentEvidence } from "../oracle/evidence";
import type { EscrowDemoState } from "./demoFlow";
import { canRelease, fundsAreLocked } from "./demoFlow";
import type { Cents } from "../types";

export interface SettlementSummary {
  /** The large word. */
  headline: string;
  detail: string;
  tone: "neutral" | "chain" | "warning" | "positive";
  /** True while the supplier has not been paid but the treasury has parted. */
  fundsLocked: boolean;
  amountLabel: string;
}

export function summariseSettlement(state: EscrowDemoState): SettlementSummary {
  const amount = money(state.amountCents);

  switch (state.stage) {
    case "READY":
      return {
        headline: "AUTHORIZED — NOT YET COMMITTED",
        detail:
          "Every on-chain check passes and the agent may settle this alone. The invoice also " +
          "carries a shipment condition, so payment goes to escrow rather than to the supplier.",
        tone: "chain",
        fundsLocked: false,
        amountLabel: amount,
      };

    case "ESCROWED":
      return {
        headline: "ESCROWED — AWAITING SHIPMENT CONFIRMATION",
        detail:
          `${amount} has left the treasury and is held by the escrow object. The supplier ` +
          "cannot be paid until the shipment condition is proven.",
        tone: "warning",
        fundsLocked: true,
        amountLabel: amount,
      };

    case "PROOF_SUBMITTED":
      return {
        headline: "ESCROWED — PROOF UNDER REVIEW",
        detail:
          `A delivery document has been submitted. ${amount} stays locked until the ` +
          `${SHIPMENT_ORACLE_LABEL} attests the condition on chain.`,
        tone: "warning",
        fundsLocked: true,
        amountLabel: amount,
      };

    case "ATTESTED":
      return {
        headline: "CONDITION MET — RELEASABLE",
        detail:
          "The oracle attested the shipment as confirmed. Sui will re-check the attestation " +
          "against the escrow before paying the recipient fixed at lock time.",
        tone: "chain",
        fundsLocked: true,
        amountLabel: amount,
      };

    case "RELEASED":
      return {
        headline: "RELEASED",
        detail: `${amount} released to the supplier.`,
        tone: "positive",
        fundsLocked: false,
        amountLabel: amount,
      };

    case "HELD":
      return {
        headline: "PAYMENT HELD",
        detail:
          `${amount} remains protected in escrow. The supplier has not received the funds. ` +
          "The money is committed but not released until the real-world condition is proven.",
        tone: "warning",
        fundsLocked: true,
        amountLabel: amount,
      };
  }
}

export interface ProofCardRow {
  label: string;
  value: string;
  tone: "default" | "positive" | "warning";
  mono?: boolean;
}

/** The proof card, as rows. Empty until a proof has been submitted. */
export function proofCardRows(state: EscrowDemoState): ProofCardRow[] {
  const proof = state.proof;
  if (!proof) return [];

  const delivered = proof.deliveryStatus === "DELIVERED";
  const attestation = state.attestation;
  // The same rule the invoice page renders, so the two cannot disagree about
  // what "confirmed" means. An attestation alone is not a confirmation.
  const evidence = evaluateShipmentEvidence({
    invoiceNumber: state.invoiceNumber,
    proof,
    attestation,
  });

  return [
    { label: "Invoice", value: proof.invoiceNumber, tone: "default" },
    { label: "Shipment", value: proof.shipmentId, tone: "default" },
    { label: "Recipient", value: shorten(proof.recipient), tone: "default", mono: true },
    {
      label: "Status",
      value: delivered ? "DELIVERED" : "NOT CONFIRMED",
      tone: delivered ? "positive" : "warning",
    },
    {
      label: "Delivered",
      value: proof.deliveredAt ?? "—",
      tone: "default",
    },
    { label: "Proof hash", value: shorten(proof.sha256), tone: "default", mono: true },
    {
      label: "Storage",
      value: proof.storage === "walrus" ? "Walrus" : "Demo store",
      tone: "default",
    },
    { label: "Oracle", value: attestation ? SHIPMENT_ORACLE_LABEL : "WAITING", tone: "default" },
    {
      label: "Attestation",
      value: attestation ? (attestation.confirmed ? "CONFIRMED" : "NOT CONFIRMED") : "NONE",
      tone: evidence.confirmed ? "positive" : "warning",
    },
    {
      label: "Hash matches",
      value: attestation ? (evidence.hashMatches ? "TRUE" : "FALSE") : "—",
      tone: evidence.hashMatches ? "positive" : "warning",
    },
  ];
}

/**
 * The four questions, and who answers each.
 *
 * This is the slide. Keeping it as data means the page and any future
 * architecture view cannot drift into describing the system differently.
 */
export interface ResponsibilityRow {
  actor: string;
  question: string;
  answer: string;
  tone: "ai" | "chain" | "neutral" | "warning";
}

export const RESPONSIBILITIES: readonly ResponsibilityRow[] = [
  {
    actor: "AI",
    question: "Should we pay?",
    answer: "Reads the invoice and recommends. It never moves money.",
    tone: "ai",
  },
  {
    actor: "Sui",
    question: "Is this payment authorized?",
    answer: "Ten checks against live chain state. Refuses, or permits.",
    tone: "chain",
  },
  {
    actor: "Oracle",
    question: "Has the real-world condition happened?",
    answer: "Attests the shipment. Holds no funds and cannot move any.",
    tone: "neutral",
  },
  {
    actor: "Escrow",
    question: "Protect the money until it has.",
    answer: "Holds the balance. Releases only against a confirmed attestation.",
    tone: "warning",
  },
] as const;

/** The pipeline, top to bottom. */
export const FLOW_STEPS: readonly string[] = [
  "Invoice",
  "AI Decision",
  "Sui Policy Guard",
  "Conditional Payment",
  "Escrow",
  "Shipment Proof",
  "Oracle",
  "Sui Attestation",
  "Release / Hold",
] as const;

/**
 * What the AI is structurally unable to do.
 *
 * Phrased as capabilities rather than promises, because each one corresponds to
 * something absent from the Move source: no destination parameter on `release`,
 * no `OracleCap` in the agent's possession, no amount it can restate after the
 * lock. Verified in tests/sui/escrow.test.ts by reading escrow.move.
 */
export const AI_CANNOT: readonly string[] = [
  "choose the recipient — it is fixed inside the escrow at lock time",
  "change the amount — the balance is already held by the escrow object",
  "create a valid attestation — that needs an OracleCap it does not hold",
  "release the escrow — release requires a confirmed attestation Move verifies",
  "bypass the Sui checks — the same ten run on the conditional path",
] as const;

export function money(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

/** Whether the interface should be showing a release control. */
export function showsReleaseControl(state: EscrowDemoState): boolean {
  return canRelease(state);
}

export function showsHeldNotice(state: EscrowDemoState): boolean {
  return state.stage === "HELD" && fundsAreLocked(state);
}

function shorten(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
