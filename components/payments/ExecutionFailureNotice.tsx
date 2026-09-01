/**
 * A payment that was attempted and did not settle.
 *
 * WHY THIS EXISTS. The execute button ran five animated stages, the submission
 * failed, the run reverted to ANALYZED, and the button came back — with nothing
 * on screen to say why. The reason was stored in `run.error`, which is only
 * rendered for a FAILED run, and an execution failure is not a failed run. So a
 * real refusal, correctly detected and correctly recorded, was invisible: it
 * looked exactly like a button that did nothing.
 *
 * THE DISTINCTION THIS CARRIES. A digest means a REAL transaction reached
 * consensus and was rejected by the treasury's own rules — gas was spent, and
 * the refusal is permanently on chain. No digest means nothing was ever
 * submitted. Both are honest outcomes and they are not the same event, so this
 * never renders one as the other.
 */

import type { ExecutionFailure } from "@/components/providers/PayflowProvider";
import { Eyebrow } from "@/components/common/Badge";
import { executionFailureHeadline } from "@/lib/payments/executionFailure";

export function ExecutionFailureNotice({ failure }: { failure: ExecutionFailure }) {
  const headline = executionFailureHeadline(failure.code);

  return (
    <div
      role="alert"
      className="rounded-lg border border-neg/35 bg-neg-soft p-3"
      data-testid="execution-failure"
    >
      <Eyebrow className="text-neg">Payment not completed</Eyebrow>
      <div className="mt-1.5 text-[13px] font-semibold text-neg">{headline}</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft">{failure.message}</p>

      {/* "Still unpaid, try again" is the usual case and the wrong thing to
          say about an invoice that is already settled — retrying that one is
          refused by check 8 forever, which is the point of check 8. */}
      <p className="mt-2 border-t border-neg/20 pt-2 text-[11px] leading-relaxed text-ink-faint">
        {failure.code === "INVOICE_ALREADY_PAID"
          ? "This invoice has already been settled. It cannot be paid a second time."
          : "The invoice remains unpaid and can be executed again."}
        {failure.abortCode !== null ? ` Move abort code ${failure.abortCode}.` : ""}
      </p>

      {/* Shown ONLY when a transaction genuinely exists. A rejected transaction
          is still a real one — it reached consensus and consumed gas — and that
          is a materially different claim from "nothing was sent". */}
      {failure.digest ? (
        <div className="mt-2 border-t border-neg/20 pt-2">
          <div className="text-[11px] text-ink-faint">
            A transaction was submitted and rejected on chain:
          </div>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">
            {failure.digest}
          </p>
          {failure.explorerUrl ? (
            <a
              className="mt-1 inline-block text-[11px] font-medium text-chain underline underline-offset-2"
              href={failure.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              View on Suiscan
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
