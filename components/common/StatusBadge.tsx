import type { FinalOutcome } from "@/lib/types";
import type { InvoiceRun } from "@/components/providers/PayflowProvider";
import { Badge, type BadgeTone } from "./Badge";

/**
 * The single place an invoice's state becomes a word on screen.
 *
 * The state shown is the CHAIN's outcome, not the AI's preference: a payment
 * the model wanted but Sui refused reads "Blocked on chain", never "Scheduled".
 */

export interface StatusDescriptor {
  label: string;
  tone: BadgeTone;
  pulse?: boolean;
}

export function describeRun(run: InvoiceRun | null | undefined): StatusDescriptor {
  if (!run || run.status === "DETECTED") {
    return { label: "Detected", tone: "neutral" };
  }
  if (run.status === "ANALYZING") {
    return { label: "Analyzing", tone: "ai", pulse: true };
  }
  if (run.status === "FAILED") {
    return { label: "Analysis failed", tone: "negative" };
  }
  if (run.status === "EXECUTING") {
    return { label: "Executing", tone: "chain", pulse: true };
  }
  if (run.status === "PAID") {
    return { label: "Paid", tone: "positive" };
  }

  const outcome = run.analysis?.finalOutcome;
  return outcome ? describeOutcome(outcome) : { label: "Analyzed", tone: "neutral" };
}

export function describeOutcome(outcome: FinalOutcome): StatusDescriptor {
  switch (outcome) {
    case "EXECUTED":
      return { label: "Approved", tone: "positive" };
    case "SCHEDULED":
      return { label: "Scheduled", tone: "chain" };
    // Every chain check passed — what is missing is a person, not a permission.
    case "AWAITING_APPROVAL":
      return { label: "Awaiting approval", tone: "warning" };
    case "HUMAN_REVIEW":
      return { label: "Human approval", tone: "warning" };
    case "REJECTED":
      return { label: "Rejected", tone: "negative" };
    case "SUI_REJECT":
      return { label: "Blocked on chain", tone: "negative" };
  }
}

export function StatusBadge({ run }: { run: InvoiceRun | null | undefined }) {
  const status = describeRun(run);
  return (
    <Badge tone={status.tone} dot pulse={status.pulse}>
      {status.label}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: FinalOutcome }) {
  const status = describeOutcome(outcome);
  return (
    <Badge tone={status.tone} dot>
      {status.label}
    </Badge>
  );
}
