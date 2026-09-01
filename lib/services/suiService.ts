/**
 * Sui service — policy reads and payment execution.
 *
 * WHAT `executePayment` DOES NOW.
 *
 * It used to return a fabricated receipt: a digest derived by hashing the
 * invoice number, `network: "demo"`, a hardcoded epoch. The interface rendered
 * that digest in monospace beside "Payment executed", indistinguishable from a
 * real one, and no payment had been made. A $30,000 invoice was reported as
 * settled against a $25,000 on-chain authorization that the path never
 * consulted.
 *
 * It was then made to throw unconditionally, which was the right correction and
 * an incomplete one: the interface ticked through five execution stages, failed
 * silently, and put the button back. Honest, and indistinguishable from a bug.
 *
 * Now it asks the server to submit the real Move call. The receipt carries the
 * digest the chain returned and the checkpoint it landed in, or the call
 * refuses and says which of the ten checks did it. There is still no local
 * success path — a receipt exists only when Sui produced one.
 *
 * WHO SIGNS. The server's own Sui keystore, the same signer the escrow flow and
 * the circuit breaker use. NOT the zkLogin session: this build derives an
 * address from a Google identity and reads membership with it, but has no
 * proving service and so cannot produce a zkLogin signature. `SIGNER_NOTE` in
 * HumanApproval says exactly that, in whichever mode the server is running.
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
  network: "demo" | "localnet" | "devnet" | "testnet" | "mainnet";
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
  /** Move function the transaction called. */
  target: string;
  network: OnChainPolicy["network"];
  executedAt: string;
  gasSponsored: boolean;
  /**
   * The checkpoint the transaction landed in, once it has one.
   *
   * Replaces the `epoch` the fabricated receipt carried. A checkpoint is the
   * thing worth stating — it is proof the transaction reached consensus, read
   * back from the chain rather than asserted by the caller — and it is null
   * while the transaction is submitted but not yet checkpointed.
   */
  checkpoint: string | null;
  explorerUrl: string | null;
}

/** Which authority a payment is being made under. */
export type PaymentAuthority = "AGENT" | "HUMAN_APPROVAL";

/**
 * A payment that did not happen, and why.
 *
 * Carries the chain's own vocabulary wherever there is one: the Move abort
 * code, and the policy check it decodes to. A refusal with `digest` set is a
 * real transaction that reached consensus and was rejected — which is a
 * different fact from one that never left the server, and the interface is
 * entitled to say which.
 */
export class PaymentRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: {
      abortCode: number | null;
      violation: string | null;
      digest: string | null;
      explorerUrl: string | null;
    } = { abortCode: null, violation: null, digest: null, explorerUrl: null },
  ) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

/** How this server is configured to execute. Asked once, stated plainly. */
export interface ExecutionMode {
  live: boolean;
  network: string | null;
}

export async function readExecutionMode(signal?: AbortSignal): Promise<ExecutionMode> {
  try {
    const response = await fetch("/api/payment/execute", { signal, cache: "no-store" });
    const payload = (await response.json()) as { live?: boolean; network?: string | null };
    return { live: payload.live === true, network: payload.network ?? null };
  } catch {
    // An unreachable server cannot be submitting anything, so reporting
    // "simulated" is the safe direction to be wrong in.
    return { live: false, network: null };
  }
}

interface ExecuteResponse {
  ok: boolean;
  live?: boolean;
  network?: string;
  code?: string | null;
  message?: string;
  payment?: {
    digest: string | null;
    checkpoint: string | null;
    target: string;
    abortCode: number | null;
    violation: string | null;
    explorerUrl: string | null;
    error: string | null;
  } | null;
}

/**
 * Submits a payment and returns the chain's receipt.
 *
 * Throws `PaymentRefusedError` for every outcome that is not a settlement —
 * live execution being off, the invoice already being paid, a Move abort. The
 * caller is expected to show that refusal rather than swallow it; a button that
 * resets itself with nothing said is how a silent failure looked like a
 * cosmetic glitch for as long as it did.
 */
export async function executePayment(
  request: PaymentRequest,
  authority: PaymentAuthority,
  signal?: AbortSignal,
): Promise<ExecutionReceipt> {
  let payload: ExecuteResponse;
  try {
    const response = await fetch("/api/payment/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, authority }),
      signal,
      cache: "no-store",
    });
    payload = (await response.json()) as ExecuteResponse;
  } catch (error) {
    throw new PaymentRefusedError(
      "SERVER_UNREACHABLE",
      error instanceof Error
        ? `No payment was submitted: ${error.message}`
        : "No payment was submitted. The execution service could not be reached.",
    );
  }

  if (!payload.ok) {
    throw new PaymentRefusedError(
      payload.code ?? "REFUSED",
      payload.message ?? "The chain refused this payment.",
      {
        abortCode: payload.payment?.abortCode ?? null,
        violation: payload.payment?.violation ?? null,
        digest: payload.payment?.digest ?? null,
        explorerUrl: payload.payment?.explorerUrl ?? null,
      },
    );
  }

  const digest = payload.payment?.digest;
  // A success without a digest is not a success. Rather than manufacture one —
  // which is the original bug, exactly — this refuses and says so.
  if (!digest) {
    throw new PaymentRefusedError(
      "NO_DIGEST",
      "The server reported success but returned no transaction digest, so there is nothing to " +
        "show as proof. No receipt was created.",
    );
  }

  return {
    digest,
    target: payload.payment?.target ?? "payment::execute_payment",
    network: (payload.network ?? "testnet") as OnChainPolicy["network"],
    executedAt: new Date().toISOString(),
    // Sponsorship is not wired up. The stage is shown because the PTB path
    // exists for it; claiming it happened would be the same class of lie.
    gasSponsored: false,
    checkpoint: payload.payment?.checkpoint ?? null,
    explorerUrl: payload.payment?.explorerUrl ?? null,
  };
}

export function explorerUrl(digest: string, network: OnChainPolicy["network"]): string | null {
  if (network === "demo") return null;
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
