/**
 * Policy enforcement — the mirror of the Move `assert!`s.
 *
 * This is the final authority. It re-derives every authorization question from
 * the treasury's own state and the agent's capability, and it does NOT trust
 * anything the AI concluded. The AI's decision is an input to be judged, not a
 * result to be honoured.
 *
 * Every assertion is recorded as a PolicyCheck whether it passes or fails, so
 * the interface can show the whole enforcement pass rather than only its
 * failures. `violations` remains the derived list of failed checks — callers
 * that only care about rejection are unaffected.
 *
 * The body is later replaced by a devInspect of the Move `evaluate()` function,
 * which returns the same ten results in the same order. The signature, the
 * violation codes, and the check order stay as they are, so nothing upstream
 * changes: authority moves to the chain, the prose stays here.
 */

import type {
  Cents,
  PaymentRecord,
  PaymentRequest,
  PolicyCheck,
  PolicyEnforcementResult,
  PolicyViolation,
  PolicyViolationCode,
  Supplier,
  TreasuryPolicy,
  TreasuryState,
} from "../types";
import type { Limits } from "./limits";
import { formatMoneyRounded } from "../util/money";

export interface EnforcementContext {
  request: PaymentRequest;
  /**
   * The limits this payment is measured against, and which authority they came
   * from. Derived by limitsFor() from the treasury's policy — never from the
   * request, and never from anything the AI produced.
   */
  limits: Readonly<Limits>;
  policy: Readonly<TreasuryPolicy>;
  treasury: Readonly<TreasuryState>;
  suppliers: readonly Supplier[];
  paymentHistory: readonly PaymentRecord[];
  /**
   * The instant enforcement runs, in epoch milliseconds. Passed in rather than
   * read from the clock so this stays pure; on chain it becomes
   * clock::timestamp_ms. Omit it and the expiry check is skipped, which is the
   * correct reading of "this caller has no notion of now".
   */
  nowMs?: number;
}

interface CheckInput {
  code: PolicyViolationCode;
  label: string;
  passed: boolean;
  /** Shown when the assertion holds. */
  passDetail: string;
  /** Shown when it does not — this text also becomes the violation detail. */
  failDetail: string;
  limit?: string | null;
  actual?: string | null;
}

export function enforcePolicy(ctx: EnforcementContext): PolicyEnforcementResult {
  const { request, limits, policy, treasury, suppliers, paymentHistory, nowMs } = ctx;
  const currency = request.currency || "USD";
  const money = (cents: Cents) => formatMoneyRounded(cents, currency);

  const checks: PolicyCheck[] = [];
  const record = (input: CheckInput) => {
    checks.push({
      code: input.code,
      label: input.label,
      passed: input.passed,
      detail: input.passed ? input.passDetail : input.failDetail,
      limit: input.limit ?? null,
      actual: input.actual ?? null,
    });
  };

  const underApproval = limits.authority === "HUMAN_APPROVAL";

  record({
    code: "AGENT_NOT_AUTHORIZED",
    label: underApproval ? "Approver authorized" : "Agent authorized",
    passed: limits.authorized,
    passDetail: underApproval
      ? `This payment is above the ${money(policy.humanApprovalThresholdCents)} threshold and carries a human approval.`
      : `Agent ${request.agentId} holds a capability on this treasury.`,
    failDetail: underApproval
      ? "No valid human approval was presented for this payment."
      : `Agent ${request.agentId} is not authorized on this treasury.`,
  });

  record({
    code: "CAPABILITY_DISABLED",
    label: underApproval ? "Approval still valid" : "Capability enabled",
    passed: limits.enabled,
    passDetail: underApproval
      ? "The human approval has not been revoked."
      : "The agent capability is enabled.",
    failDetail: underApproval
      ? "The human approval for this payment has been revoked."
      : `Agent capability for ${request.agentId} is currently disabled.`,
  });

  // Supplier authorization is re-checked here, independently of the AI.
  const supplier = request.supplierId
    ? suppliers.find((candidate) => candidate.id === request.supplierId)
    : undefined;

  record({
    code: "SUPPLIER_NOT_APPROVED",
    label: "Supplier approved",
    passed: supplier !== undefined && supplier.registryStatus === "APPROVED",
    passDetail: `${request.supplierName} is APPROVED in the on-chain registry.`,
    failDetail: supplier
      ? `Supplier ${supplier.id} has registry status ${supplier.registryStatus}.`
      : `Supplier "${request.supplierName}" is not in the approved registry.`,
    limit: "APPROVED",
    actual: supplier ? supplier.registryStatus : "NOT_FOUND",
  });

  record({
    code: "RECIPIENT_WALLET_MISMATCH",
    label: "Recipient wallet matches",
    passed: supplier !== undefined && supplier.registeredWallet === request.recipientWallet,
    passDetail: "The remit wallet matches the address registered for this supplier.",
    failDetail: supplier
      ? `Recipient wallet does not match the wallet registered for ${supplier.id}.`
      : "No registered wallet exists to compare the remit address against.",
    limit: supplier ? supplier.registeredWallet : null,
    actual: request.recipientWallet,
  });

  const exceedsSingle = request.amountCents > limits.maxSinglePaymentCents;
  record({
    code: "EXCEEDS_MAX_PAYMENT",
    label: "Within single-payment limit",
    passed: !exceedsSingle,
    passDetail: `${money(request.amountCents)} is within ${limits.holder}'s ${money(limits.maxSinglePaymentCents)} cap.`,
    failDetail: `Payment of ${money(request.amountCents)} exceeds ${limits.holder}'s single-payment cap of ${money(limits.maxSinglePaymentCents)}.`,
    limit: money(limits.maxSinglePaymentCents),
    actual: money(request.amountCents),
  });

  const projectedDaily = limits.dailySpentCents + request.amountCents;
  record({
    code: "EXCEEDS_DAILY_LIMIT",
    label: "Within daily limit",
    passed: projectedDaily <= limits.dailyLimitCents,
    passDetail: `Today's spend would reach ${money(projectedDaily)} of ${money(limits.dailyLimitCents)}.`,
    failDetail: `Payment of ${money(request.amountCents)} would take today's spend to ${money(projectedDaily)}, above the ${money(limits.dailyLimitCents)} daily limit.`,
    limit: money(limits.dailyLimitCents),
    actual: money(projectedDaily),
  });

  record({
    code: "CURRENCY_NOT_ALLOWED",
    label: "Currency permitted",
    passed: policy.allowedCurrencies.includes(request.currency),
    passDetail: `${request.currency} is a permitted settlement currency.`,
    failDetail: `Currency ${request.currency || "(none)"} is not permitted by treasury policy.`,
    limit: policy.allowedCurrencies.join(", "),
    actual: request.currency || "(none)",
  });

  const alreadyPaid = paymentHistory.some(
    (record_) => record_.invoiceNumber === request.invoiceNumber,
  );
  record({
    code: "INVOICE_ALREADY_PAID",
    label: "Invoice not previously paid",
    passed: !alreadyPaid,
    passDetail: `No settled payment exists for ${request.invoiceNumber}.`,
    failDetail: `Invoice ${request.invoiceNumber} has already been settled.`,
  });

  const remaining = treasury.currentCashCents - request.amountCents;
  record({
    code: "INSUFFICIENT_RESERVE",
    label: "Minimum reserve protected",
    passed: remaining >= policy.minimumReserveCents,
    passDetail: `${money(remaining)} remains, above the ${money(policy.minimumReserveCents)} reserve.`,
    failDetail: `Paying ${money(request.amountCents)} would leave ${money(remaining)}, below the ${money(policy.minimumReserveCents)} minimum reserve.`,
    limit: money(policy.minimumReserveCents),
    actual: money(remaining),
  });

  // An AI recommendation is intent, not standing permission. A scheduled
  // payment can sit for days before it executes, and by then the reasoning
  // behind it may describe a treasury that no longer exists.
  const expired = nowMs !== undefined && nowMs > request.expiresAtMs;
  const ageHours =
    nowMs !== undefined ? Math.round((nowMs - request.recommendedAtMs) / 3_600_000) : 0;
  record({
    code: "RECOMMENDATION_EXPIRED",
    label: "Recommendation still current",
    passed: !expired,
    passDetail:
      nowMs === undefined
        ? "Immediate payment — no expiry applies."
        : `Recommendation ${request.recommendationId} was made ${ageHours}h ago and is still within its validity window.`,
    failDetail: `Recommendation ${request.recommendationId} expired ${Math.round((nowMs! - request.expiresAtMs) / 3_600_000)}h ago and must be re-derived from current state.`,
    limit: nowMs === undefined ? null : new Date(request.expiresAtMs).toISOString(),
    actual: nowMs === undefined ? null : new Date(nowMs).toISOString(),
  });

  const violations: PolicyViolation[] = checks
    .filter((check) => !check.passed)
    .map((check) => ({ code: check.code, detail: check.detail }));

  return {
    outcome: violations.length === 0 ? "APPROVED" : "SUI_REJECT",
    violations,
    checks,
  };
}
