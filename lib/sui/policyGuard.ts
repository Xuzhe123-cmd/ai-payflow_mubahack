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
 * In Phase 6 the body is replaced by a Sui dry-run of the same Move function.
 * The signature, the violation codes, and the check order stay as they are, so
 * nothing upstream changes.
 */

import type {
  AgentCapability,
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
import { formatMoneyRounded } from "../util/money";

export interface EnforcementContext {
  request: PaymentRequest;
  capability: Readonly<AgentCapability>;
  policy: Readonly<TreasuryPolicy>;
  treasury: Readonly<TreasuryState>;
  suppliers: readonly Supplier[];
  paymentHistory: readonly PaymentRecord[];
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
  const { request, capability, policy, treasury, suppliers, paymentHistory } = ctx;
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

  record({
    code: "AGENT_NOT_AUTHORIZED",
    label: "Agent authorized",
    passed: capability.authorized,
    passDetail: `Agent ${request.agentId} holds a capability on this treasury.`,
    failDetail: `Agent ${request.agentId} is not authorized on this treasury.`,
  });

  record({
    code: "CAPABILITY_DISABLED",
    label: "Capability enabled",
    passed: capability.enabled,
    passDetail: "The agent capability is enabled.",
    failDetail: `Agent capability for ${request.agentId} is currently disabled.`,
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

  const exceedsSingle = request.amountCents > capability.maxSinglePaymentCents;
  record({
    code: "EXCEEDS_MAX_PAYMENT",
    label: "Within single-payment limit",
    passed: !exceedsSingle,
    passDetail: `${money(request.amountCents)} is within the agent's ${money(capability.maxSinglePaymentCents)} cap.`,
    failDetail: `Payment of ${money(request.amountCents)} exceeds the agent's single-payment cap of ${money(capability.maxSinglePaymentCents)}.`,
    limit: money(capability.maxSinglePaymentCents),
    actual: money(request.amountCents),
  });

  const projectedDaily = capability.dailySpentCents + request.amountCents;
  record({
    code: "EXCEEDS_DAILY_LIMIT",
    label: "Within daily limit",
    passed: projectedDaily <= capability.dailyLimitCents,
    passDetail: `Today's spend would reach ${money(projectedDaily)} of ${money(capability.dailyLimitCents)}.`,
    failDetail: `Payment of ${money(request.amountCents)} would take today's spend to ${money(projectedDaily)}, above the ${money(capability.dailyLimitCents)} daily limit.`,
    limit: money(capability.dailyLimitCents),
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

  const violations: PolicyViolation[] = checks
    .filter((check) => !check.passed)
    .map((check) => ({ code: check.code, detail: check.detail }));

  return {
    outcome: violations.length === 0 ? "APPROVED" : "SUI_REJECT",
    violations,
    checks,
  };
}
