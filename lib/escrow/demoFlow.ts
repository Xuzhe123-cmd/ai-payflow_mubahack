/**
 * The conditional-payment demo, as a state machine.
 *
 * The interesting requirement is negative: after a proof that says the shipment
 * did NOT arrive, there must be no way to release. Putting that in a component
 * would make it a rendering detail — one `&&` away from being wrong, and
 * untestable without a browser. So the available actions are computed here,
 * from state, and asserted directly.
 *
 * This layer is presentation only. It decides which BUTTON to show; it decides
 * nothing about money. `escrow::release` re-derives every one of these
 * conditions on chain and refuses regardless of what any screen offered — which
 * is why a bug here would be embarrassing rather than dangerous.
 */

import type { ShipmentAttestation, ShipmentProof } from "../oracle/shipment";
import type { Cents } from "../types";

/**
 * Where one invoice has got to.
 *
 * `HELD` is deliberately distinct from `ESCROWED`. Both mean the supplier has
 * not been paid, but ESCROWED is waiting for evidence and HELD is the state
 * after evidence arrived and did not support release — the difference the demo
 * exists to show.
 */
export type EscrowDemoStage =
  /** Analysed, authorised, nothing locked. */
  | "READY"
  /** Funds are in escrow; no proof yet. */
  | "ESCROWED"
  /** A proof has been submitted; the oracle has not ruled. */
  | "PROOF_SUBMITTED"
  /** The oracle attested CONFIRMED. Release is possible. */
  | "ATTESTED"
  /** Paid to the supplier. Terminal. */
  | "RELEASED"
  /** Evidence says the shipment did not arrive. Funds stay locked. */
  | "HELD";

export type EscrowDemoAction =
  | "START_CONDITIONAL_PAYMENT"
  | "SUBMIT_PROOF"
  | "ORACLE_CONFIRM"
  | "RELEASE_ESCROW";

export interface EscrowDemoState {
  invoiceNumber: string;
  amountCents: Cents;
  stage: EscrowDemoStage;
  /** Fixed when the escrow is created; nothing after that can change it. */
  recipient: string;
  proof: ShipmentProof | null;
  attestation: ShipmentAttestation | null;
  /**
   * Object ids created on chain, once they exist.
   *
   * Carried so the release step can name them. They are pointers only — the
   * server re-reads every fact about them from chain before submitting.
   */
  escrowObjectId: string | null;
  attestationObjectId: string | null;
  /** Digests of whatever has actually been submitted, in order. */
  transactions: EscrowDemoTransaction[];
}

export interface EscrowDemoTransaction {
  action: EscrowDemoAction;
  label: string;
  /** A real digest, or null. Never invented — see lib/escrow/executor.ts. */
  digest: string | null;
  /** As the chain reported it, when it reached one. */
  status?: string | null;
  explorerUrl?: string | null;
  /** Whether this reached the chain or was produced by the demo runner. */
  mode: "testnet" | "simulated";
  at: string;
}

export interface AvailableAction {
  action: EscrowDemoAction;
  label: string;
  /** What it will do, in one line. */
  detail: string;
  tone: "chain" | "ai" | "neutral";
}

/**
 * Which controls to offer.
 *
 * The RELEASE_ESCROW case is the one that matters: it is reachable only from
 * ATTESTED, and ATTESTED is reachable only through an attestation that says
 * confirmed. A proof that reports IN_TRANSIT never produces one.
 */
export function availableActions(state: EscrowDemoState): AvailableAction[] {
  switch (state.stage) {
    case "READY":
      return [
        {
          action: "START_CONDITIONAL_PAYMENT",
          label: "Start conditional payment",
          detail: "Runs the same ten on-chain checks, then locks the funds in escrow.",
          tone: "chain",
        },
      ];
    case "ESCROWED":
      return [
        {
          action: "SUBMIT_PROOF",
          label: "Submit shipment proof",
          detail: "Stores the delivery document and hashes it for the oracle to read.",
          tone: "neutral",
        },
      ];
    case "PROOF_SUBMITTED":
      // The oracle may only be asked to confirm a document that says delivered.
      // For anything else there is no control at all — not a disabled one.
      return proofSupportsConfirmation(state.proof)
        ? [
            {
              action: "ORACLE_CONFIRM",
              label: "Oracle: confirm shipment",
              detail: "The Demo Shipment Oracle attests the condition on chain.",
              tone: "ai",
            },
          ]
        : [];
    case "ATTESTED":
      return [
        {
          action: "RELEASE_ESCROW",
          label: "Release escrow",
          detail: "Sui checks the attestation and pays the fixed recipient.",
          tone: "chain",
        },
      ];
    case "RELEASED":
    case "HELD":
      return [];
  }
}

/** Whether a document says, in as many words, that the goods arrived. */
export function proofSupportsConfirmation(proof: ShipmentProof | null): boolean {
  return proof !== null && proof.deliveryStatus === "DELIVERED";
}

/**
 * Whether the release control may be shown.
 *
 * Stated separately from `availableActions` because it is the security-shaped
 * claim, and a claim worth asserting on its own rather than inferring from a
 * list length.
 */
export function canRelease(state: EscrowDemoState): boolean {
  return (
    state.stage === "ATTESTED" &&
    state.attestation !== null &&
    state.attestation.confirmed &&
    state.attestation.invoiceNumber === state.invoiceNumber
  );
}

/** Every stage the money is committed but the supplier does not have it. */
export function fundsAreLocked(state: EscrowDemoState): boolean {
  return (
    state.stage === "ESCROWED" ||
    state.stage === "PROOF_SUBMITTED" ||
    state.stage === "ATTESTED" ||
    state.stage === "HELD"
  );
}

export class InvalidTransition extends Error {
  constructor(stage: EscrowDemoStage, action: EscrowDemoAction) {
    super(`${action} is not available from ${stage}.`);
    this.name = "InvalidTransition";
  }
}

export interface TransitionInput {
  state: EscrowDemoState;
  action: EscrowDemoAction;
  proof?: ShipmentProof | null;
  attestation?: ShipmentAttestation | null;
  escrowObjectId?: string | null;
  attestationObjectId?: string | null;
  transaction?: EscrowDemoTransaction;
}

/**
 * Advances the demo.
 *
 * Refuses any action the current stage does not offer, so a stale button or a
 * replayed request cannot skip a step — the UI and this function agree because
 * both read `availableActions`.
 */
export function advance(input: TransitionInput): EscrowDemoState {
  const { state, action } = input;
  const allowed = availableActions(state).some((entry) => entry.action === action);
  if (!allowed) throw new InvalidTransition(state.stage, action);

  const transactions = input.transaction
    ? [...state.transactions, input.transaction]
    : state.transactions;

  switch (action) {
    case "START_CONDITIONAL_PAYMENT":
      return {
        ...state,
        stage: "ESCROWED",
        escrowObjectId: input.escrowObjectId ?? state.escrowObjectId,
        transactions,
      };

    case "SUBMIT_PROOF": {
      // A document reporting IN_TRANSIT settles the matter on arrival: there is
      // nothing for the oracle to confirm, so the escrow goes straight to HELD
      // and never offers a release control at all.
      const proof = input.proof ?? null;
      return { ...state, stage: stageAfterProof(proof), proof, transactions };
    }

    case "ORACLE_CONFIRM": {
      const attestation = input.attestation ?? null;
      // An oracle that declines is a legitimate outcome, and it is the one
      // Demo B rests on: the funds stay exactly where they are.
      const confirmed =
        attestation !== null &&
        attestation.confirmed &&
        attestation.invoiceNumber === state.invoiceNumber;
      return {
        ...state,
        stage: confirmed ? "ATTESTED" : "HELD",
        attestation,
        attestationObjectId: input.attestationObjectId ?? state.attestationObjectId,
        transactions,
      };
    }

    case "RELEASE_ESCROW":
      return { ...state, stage: "RELEASED", transactions };
  }
}

/**
 * The stage a proof leaves an escrow in once the oracle has read it.
 *
 * Demo B never reaches ORACLE_CONFIRM — there is no control for it — so this is
 * what moves it to HELD when the proof is submitted.
 */
export function stageAfterProof(proof: ShipmentProof | null): EscrowDemoStage {
  return proofSupportsConfirmation(proof) ? "PROOF_SUBMITTED" : "HELD";
}

export function initialState(input: {
  invoiceNumber: string;
  amountCents: Cents;
  recipient: string;
}): EscrowDemoState {
  return {
    invoiceNumber: input.invoiceNumber,
    amountCents: input.amountCents,
    stage: "READY",
    recipient: input.recipient,
    proof: null,
    attestation: null,
    escrowObjectId: null,
    attestationObjectId: null,
    transactions: [],
  };
}
