/**
 * Policy enforcement — the mirror of the Move `assert!`s.
 *
 * This is the final authority. It re-derives every authorization question from
 * the treasury's own state and the agent's capability, and it does NOT trust
 * anything the AI concluded. The AI's decision is an input to be judged, not a
 * result to be honoured.
 *
 * In Phase 6 the body is replaced by a Sui dry-run of the same Move function.
 * The signature and the violation codes stay as they are, so nothing upstream
 * changes.
 */

import type {
  AgentCapability,
  PaymentRecord,
  PaymentRequest,
  PolicyEnforcementResult,
  PolicyViolation,
  Supplier,
  TreasuryPolicy,
  TreasuryState,
} from "../types";

export interface EnforcementContext {
  request: PaymentRequest;
  capability: Readonly<AgentCapability>;
  policy: Readonly<TreasuryPolicy>;
  treasury: Readonly<TreasuryState>;
  suppliers: readonly Supplier[];
  paymentHistory: readonly PaymentRecord[];
}

export function enforcePolicy(ctx: EnforcementContext): PolicyEnforcementResult {
  const { request, capability, policy, treasury, suppliers, paymentHistory } = ctx;
  const violations: PolicyViolation[] = [];

  if (!capability.authorized) {
    violations.push({
      code: "AGENT_NOT_AUTHORIZED",
      detail: `Agent ${request.agentId} is not authorized on this treasury.`,
    });
  }

  if (!capability.enabled) {
    violations.push({
      code: "CAPABILITY_DISABLED",
      detail: `Agent capability for ${request.agentId} is currently disabled.`,
    });
  }

  if (request.amountCents > capability.maxSinglePaymentCents) {
    violations.push({
      code: "EXCEEDS_MAX_PAYMENT",
      detail: `Payment of ${request.amountCents} exceeds the agent's single-payment cap of ${capability.maxSinglePaymentCents}.`,
    });
  }

  if (capability.dailySpentCents + request.amountCents > capability.dailyLimitCents) {
    violations.push({
      code: "EXCEEDS_DAILY_LIMIT",
      detail: `Payment of ${request.amountCents} would take today's spend to ${capability.dailySpentCents + request.amountCents}, above the ${capability.dailyLimitCents} daily limit.`,
    });
  }

  if (!policy.allowedCurrencies.includes(request.currency)) {
    violations.push({
      code: "CURRENCY_NOT_ALLOWED",
      detail: `Currency ${request.currency || "(none)"} is not permitted by treasury policy.`,
    });
  }

  // Supplier authorization is re-checked here, independently of the AI.
  const supplier = request.supplierId
    ? suppliers.find((candidate) => candidate.id === request.supplierId)
    : undefined;

  if (!supplier) {
    violations.push({
      code: "SUPPLIER_NOT_APPROVED",
      detail: `Supplier "${request.supplierName}" is not in the approved registry.`,
    });
  } else {
    if (supplier.registryStatus !== "APPROVED") {
      violations.push({
        code: "SUPPLIER_NOT_APPROVED",
        detail: `Supplier ${supplier.id} has registry status ${supplier.registryStatus}.`,
      });
    }
    if (supplier.registeredWallet !== request.recipientWallet) {
      violations.push({
        code: "RECIPIENT_WALLET_MISMATCH",
        detail: `Recipient wallet does not match the wallet registered for ${supplier.id}.`,
      });
    }
  }

  if (paymentHistory.some((record) => record.invoiceNumber === request.invoiceNumber)) {
    violations.push({
      code: "INVOICE_ALREADY_PAID",
      detail: `Invoice ${request.invoiceNumber} has already been settled.`,
    });
  }

  if (treasury.currentCashCents - request.amountCents < policy.minimumReserveCents) {
    violations.push({
      code: "INSUFFICIENT_RESERVE",
      detail: `Paying ${request.amountCents} would leave the treasury below its ${policy.minimumReserveCents} minimum reserve.`,
    });
  }

  return {
    outcome: violations.length === 0 ? "APPROVED" : "SUI_REJECT",
    violations,
  };
}
