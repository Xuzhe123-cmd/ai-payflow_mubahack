"use client";

/**
 * What the chain currently permits for one invoice.
 *
 * WHY A HOOK AND NOT A PROP. The answer changes without this browser doing
 * anything: an admin revokes the agent, the breaker trips, another operator
 * spends the approver's day, an approval expires. A value computed once when
 * the page rendered would be stale in exactly the situations that matter, so it
 * is read from the chain on mount and re-read on demand.
 *
 * `verdict` stays null until the chain has answered, and callers MUST render
 * nothing authorization-shaped while it is. Guessing in the permissive
 * direction is the failure this exists to remove — the outcome box used to say
 * "AUTHORIZED · READY" from the pipeline's own forecast, before any chain read,
 * and went on saying it while the approver's daily budget was spent and no
 * approval on chain could be executed.
 *
 * RESOLUTION IS DERIVED, NOT SET. The result records which invoice it belongs
 * to, and `resolved` compares that against the invoice being asked about. So
 * switching invoices reads as unresolved immediately, with no synchronous state
 * write in the effect and no window in which the last invoice's answer is shown
 * beside this one's number.
 */

import { useCallback, useEffect, useState } from "react";

import type { ReadinessFacts, ReadinessVerdict } from "@/lib/payments/executionReadiness";

export interface ExecutionReadiness {
  /** Null until the chain has answered, or when it could not be reached. */
  verdict: ReadinessVerdict | null;
  /** The figures the verdict was reached from, for showing the reader. */
  facts: ReadinessFacts | null;
  /** False until a read for THIS invoice has completed, either way. */
  resolved: boolean;
  /** Why the read failed, when it did. Never treated as a verdict. */
  error: string | null;
  refresh: () => void;
}

interface Payload {
  ok?: boolean;
  readiness?: ReadinessVerdict;
  facts?: ReadinessFacts;
  message?: string;
}

interface Result {
  /** Which invoice this answer is about. Compared, never assumed. */
  forInvoice: string;
  verdict: ReadinessVerdict | null;
  facts: ReadinessFacts | null;
  error: string | null;
}

export function useExecutionReadiness(invoiceNumber: string | null): ExecutionReadiness {
  const [result, setResult] = useState<Result | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!invoiceNumber) return;
    let cancelled = false;

    void fetch(`/api/payment/readiness?invoiceNumber=${encodeURIComponent(invoiceNumber)}`, {
      cache: "no-store",
    })
      .then((response) => response.json() as Promise<Payload>)
      .then((payload) => {
        if (cancelled) return;
        setResult(
          payload.ok && payload.readiness
            ? {
                forInvoice: invoiceNumber,
                verdict: payload.readiness,
                facts: payload.facts ?? null,
                error: null,
              }
            : {
                // An unreadable chain is neither permission nor refusal. The
                // verdict stays null and the caller keeps claiming nothing.
                forInvoice: invoiceNumber,
                verdict: null,
                facts: null,
                error: payload.message ?? "The chain could not be read.",
              },
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult({
          forInvoice: invoiceNumber,
          verdict: null,
          facts: null,
          error: cause instanceof Error ? cause.message : "The chain could not be read.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [invoiceNumber, nonce]);

  const matches = result !== null && result.forInvoice === invoiceNumber;

  return {
    verdict: matches ? result.verdict : null,
    facts: matches ? result.facts : null,
    resolved: invoiceNumber === null || matches,
    error: matches ? result.error : null,
    refresh,
  };
}
