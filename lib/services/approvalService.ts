/**
 * SWAP POINT — human approval.
 *
 * Today this asks the server to re-run policy enforcement under the approver's
 * limits. When real wallet signing lands, the same call becomes: build the PTB,
 * have the HUMAN's wallet sign it, and submit. The shape does not change,
 * because the approval is already a distinct step with its own authority.
 */

import type { ApprovalResponse } from "./contracts";

export class ApprovalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApprovalError";
  }
}

const ENDPOINT = process.env.NEXT_PUBLIC_APPROVE_ENDPOINT ?? "/api/approve";

export async function approvePayment(
  scenarioId: string,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
    signal,
    cache: "no-store",
  });

  const payload = (await response.json()) as ApprovalResponse | { error: string };
  if (!response.ok || "error" in payload) {
    throw new ApprovalError(
      "error" in payload ? payload.error : "Approval could not be evaluated.",
      response.status,
    );
  }
  return payload;
}
