/**
 * Sui service — policy reads and payment execution.
 *
 * WHY `executePayment` NOW THROWS.
 *
 * It used to return a fabricated receipt: a digest derived by hashing the
 * invoice number, `network: "demo"`, a hardcoded epoch. The interface rendered
 * that digest in monospace beside "Payment executed", indistinguishable from a
 * real one, and no payment had been made. A $30,000 invoice was reported as
 * settled against a $25,000 on-chain authorization that the path never
 * consulted.
 *
 * A mock that returns something plausible is worse than one that fails: the
 * failure is visible in a second, and the plausible lie survives all the way
 * to a judge. So this refuses, loudly, until a real PTB is wired in.
 *
 * SWAP POINT — Sui TypeScript SDK. `executePayment` becomes a PTB signed by
 * the zkLogin session. Until then, `/api/approval/preflight` asks the CHAIN
 * what it would decide, which is a true answer rather than an invented one.
 *
 * What must NOT move into the interface: the decision about whether a payment
 * is allowed. That answer comes from Move — never from a component.
 */

import type { AgentCapability, PaymentRequest, TreasuryPolicy } from "../types";
import { AGENT_CAPABILITY, TREASURY_POLICY } from "../demo/policies";

export interface OnChainPolicy {
  policy: TreasuryPolicy;
  capability: AgentCapability;
  /** Object ids, shown in the interface so the chain is visible, not hidden. */
  treasuryObjectId: string;
  capabilityObjectId: string;
  packageId: string;
  network: "demo" | "devnet" | "testnet" | "mainnet";
}

const DEMO_OBJECTS = {
  treasuryObjectId: "0x8c41f6d2b93a07e58c41f6d2b93a07e58c41f6d2b93a07e58c41f6d2b93a07e5",
  capabilityObjectId: "0x1d59e7a4c82b3f601d59e7a4c82b3f601d59e7a4c82b3f601d59e7a4c82b3f60",
  packageId: "0xa73e5c19f84d2b60a73e5c19f84d2b60a73e5c19f84d2b60a73e5c19f84d2b60",
} as const;

export async function readTreasuryPolicy(): Promise<OnChainPolicy> {
  return {
    policy: TREASURY_POLICY,
    capability: AGENT_CAPABILITY,
    ...DEMO_OBJECTS,
    network: "demo",
  };
}

export type ExecutionStageId = "build" | "sponsor" | "sign" | "submit" | "finalize";

export interface ExecutionStage {
  id: ExecutionStageId;
  label: string;
  durationMs: number;
}

export const EXECUTION_STAGES: ExecutionStage[] = [
  { id: "build", label: "Building programmable transaction block", durationMs: 520 },
  { id: "sponsor", label: "Requesting gas sponsorship", durationMs: 460 },
  { id: "sign", label: "Signing with zkLogin session", durationMs: 520 },
  { id: "submit", label: "Submitting to Sui", durationMs: 620 },
  { id: "finalize", label: "Awaiting finality", durationMs: 560 },
];

export interface ExecutionReceipt {
  digest: string;
  /** Move function the PTB called. */
  target: string;
  network: OnChainPolicy["network"];
  executedAt: string;
  gasSponsored: boolean;
  epoch: number;
}

/** Deterministic pseudo-digest so a replayed demo looks stable, not random. */
function digestFor(request: PaymentRequest): string {
  const seed = `${request.invoiceNumber}:${request.requestedDate}:${request.amountCents}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = "";
  let state = hash;
  while (out.length < 64) {
    state = Math.imul(state ^ (state >>> 15), 0x2545f491) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return `0x${out.slice(0, 64)}`;
}

/**
 * Mock execution. It is only ever called after enforcePolicy() has approved
 * the request — the interface does not get to skip that step.
 */
export class PaymentExecutionUnavailableError extends Error {
  readonly code = "EXECUTION_NOT_WIRED";
  constructor(readonly request: PaymentRequest) {
    super(
      `No payment was submitted for ${request.invoiceNumber}. On-chain execution is not wired ` +
        "up in this build, and this function will not invent a receipt for a payment that did " +
        "not happen. Use the on-chain preflight to see what Sui would decide.",
    );
    this.name = "PaymentExecutionUnavailableError";
  }
}

/**
 * Refuses, by design.
 *
 * There is deliberately no success path. Returning a receipt here would be
 * claiming a settlement that never reached a validator, which is exactly the
 * bug this replaced.
 */
export async function executePayment(request: PaymentRequest): Promise<ExecutionReceipt> {
  throw new PaymentExecutionUnavailableError(request);
}

export function explorerUrl(digest: string, network: OnChainPolicy["network"]): string | null {
  if (network === "demo") return null;
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
