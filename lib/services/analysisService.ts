/**
 * Analysis service — the only place the interface talks to the AI pipeline.
 *
 * SWAP POINT — Cloudflare Worker.
 *   Point ANALYZE_ENDPOINT at the Worker URL. The response contract
 *   (AnalysisResponse) is shared by both implementations, so no component
 *   changes.
 *
 * The prompt lives in lib/ai/prompt.ts and the model call happens server-side.
 * Nothing in components/ may import either.
 */

import type { AnalysisResponse } from "./contracts";

const ANALYZE_ENDPOINT =
  process.env.NEXT_PUBLIC_ANALYZE_ENDPOINT ?? "/api/analyze";

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

export async function analyzeInvoice(
  scenarioId: string,
  signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const response = await fetch(ANALYZE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
    signal,
  });

  if (!response.ok) {
    let detail = `Analysis failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // Keep the status-based message.
    }
    throw new AnalysisError(detail, response.status);
  }

  return (await response.json()) as AnalysisResponse;
}
