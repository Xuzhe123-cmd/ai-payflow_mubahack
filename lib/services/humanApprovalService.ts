/**
 * The browser's half of the human-approval path.
 *
 * Three calls, in the order a person makes them, each one asking the chain
 * rather than answering for it:
 *
 *   preflightApproval   dry-runs approve_scoped. A verdict, not an approval.
 *   submitApproval      submits it. Creates a HumanApproval, or refuses.
 *   readApproval        asks whether one exists. The gate on the Execute button.
 *
 * WHAT IS SENT: an invoice number, and the approver's own address. Nothing
 * else. The amount, the recipient, the treasury, the company and every limit
 * are read server-side from chain state, so there is no field here through
 * which a client could authorize a different payment. The address is not a
 * credential either — it names WHO to look up in the treasury's approver table,
 * and Move refuses anyone the table does not hold.
 */

import type { ApprovalObject, ApprovalPreflightVerdict } from "@/lib/payments/approvalFlow";

export interface PreflightResult extends ApprovalPreflightVerdict {
  /** Stated in the payload so no reader mistakes this for a settlement. */
  submitted: false;
  /** Net MIST the dry run measured, when the chain reported it. */
  gasMist: number | null;
}

export interface SubmitApprovalResult {
  /** The chain's, or null. Never generated here. */
  digest: string | null;
  explorerUrl: string | null;
  /** Read back from chain. Null when the object is not yet visible. */
  approval: ApprovalObject | null;
  /** True when this call found an approval that already existed. */
  alreadyApproved: boolean;
}

/**
 * A refusal, carried with whatever the chain called it.
 *
 * `NO_SIGNER` is deliberately distinguishable from a Move abort: it means this
 * build cannot ask on the approver's behalf, NOT that Sui said no. Rendering
 * the two the same way would report a refusal that never happened.
 */
export class ApprovalChainError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly abortCode: number | null = null,
    readonly abortName: string | null = null,
  ) {
    super(message);
    this.name = "ApprovalChainError";
  }
}

interface ApprovalPayload {
  ok?: boolean;
  error?: string | null;
  code?: string | null;
  abortCode?: number | null;
  abortName?: string | null;
  message?: string;
  wouldAuthorize?: boolean;
  gasMist?: number | null;
  digest?: string | null;
  explorerUrl?: string | null;
  approval?: RawApproval | null;
  alreadyApproved?: boolean;
}

interface RawApproval {
  objectId: string;
  amountCents: number;
  expiresAtMs: number;
}

async function post(url: string, body: Record<string, string>): Promise<ApprovalPayload> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return (await response.json()) as ApprovalPayload;
}

function refuse(payload: ApprovalPayload, fallback: string): ApprovalChainError {
  return new ApprovalChainError(
    payload.error ?? payload.message ?? fallback,
    payload.code ?? null,
    payload.abortCode ?? null,
    payload.abortName ?? null,
  );
}

/**
 * Asks Sui what it would decide. Submits nothing.
 *
 * A REFUSAL IS A RESULT, NOT AN ERROR. `wouldAuthorize: false` comes back as a
 * verdict the caller renders, because "Sui would refuse this, with code 601" is
 * the answer the operator asked for. Only a request that could not be evaluated
 * at all throws.
 */
export async function preflightApproval(
  invoiceNumber: string,
  approver: string,
): Promise<PreflightResult> {
  const payload = await post("/api/payments/approval/preflight", { invoiceNumber, approver });
  if (!payload.ok) throw refuse(payload, "The approval could not be evaluated.");

  return {
    wouldAuthorize: payload.wouldAuthorize === true,
    abortCode: payload.abortCode ?? null,
    abortName: payload.abortName ?? null,
    message: payload.message ?? "",
    gasMist: payload.gasMist ?? null,
    submitted: false,
  };
}

/**
 * Submits the approval for real.
 *
 * Throws on every refusal, including `NO_SIGNER`, because none of them leaves
 * the caller with an approval — and a caller that continued on a falsy result
 * would be one edit away from executing without one.
 */
export async function submitApproval(
  invoiceNumber: string,
  approver: string,
): Promise<SubmitApprovalResult> {
  const payload = await post("/api/payments/approval", { invoiceNumber, approver });
  if (!payload.ok) throw refuse(payload, "The approval was not submitted.");

  return {
    digest: payload.digest ?? null,
    explorerUrl: payload.explorerUrl ?? null,
    approval: payload.approval ?? null,
    alreadyApproved: payload.alreadyApproved === true,
  };
}

/**
 * Whether a live `HumanApproval` exists on chain for this invoice.
 *
 * Returns null for "there is none", which is a different fact from "the chain
 * could not be reached" — the latter throws. A caller must not treat an
 * unreadable chain as permission, and must not treat it as a refusal either.
 */
export async function readApproval(invoiceNumber: string): Promise<ApprovalObject | null> {
  const response = await fetch(
    `/api/payments/approval?invoiceNumber=${encodeURIComponent(invoiceNumber)}`,
    { cache: "no-store" },
  );
  const payload = (await response.json()) as ApprovalPayload;
  if (!payload.ok) throw refuse(payload, "The chain could not be read.");
  return payload.approval ?? null;
}
