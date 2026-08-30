/**
 * Supplier, invoice and liquidity risk.
 *
 * `blocking: true` means exactly one thing: the corresponding Move check would
 * refuse this payment. It is a claim about the chain's rules, verifiable by
 * reading payment.move, not an opinion about how worrying something is. That is
 * what keeps this file a fact sheet rather than a second decision engine.
 *
 * Non-blocking findings are real risks the chain does not police — an overdue
 * invoice, a forecast trough — and they are exactly the material the LLM is
 * there to weigh.
 */

import type { IsoDate } from "../types";
import type { ChainInvoice, ChainSupplier, ChainTreasury } from "../sui/chainTypes";
import { daysBetween } from "../util/date";
import type {
  AuthorityEvaluation,
  CashFlowAnalysis,
  RiskFinding,
  SupplierEvaluation,
} from "./types";

/** Invoice states that can still be paid. */
const PAYABLE_STATUSES = new Set(["PENDING", "ANALYZING", "APPROVED", "SCHEDULED", "HUMAN_REVIEW"]);

/** Due within this many days counts as imminent. */
const IMMINENT_DAYS = 3;

export function evaluateSupplier(
  invoice: ChainInvoice,
  suppliers: readonly ChainSupplier[],
): SupplierEvaluation {
  const supplier = suppliers.find((entry) => entry.supplierId === invoice.supplierId) ?? null;
  return {
    supplierId: invoice.supplierId,
    found: supplier !== null,
    approved: supplier?.status === "APPROVED",
    registeredWallet: supplier?.registeredWallet ?? null,
    invoiceRecipient: invoice.recipient,
    // A supplier we do not know cannot vouch for any address, so this is false
    // rather than "unknown" — the chain treats it the same way.
    walletMatches: supplier !== null && sameAddress(supplier.registeredWallet, invoice.recipient),
  };
}

function sameAddress(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}

export interface RiskInput {
  asOf: IsoDate;
  invoice: ChainInvoice;
  treasury: ChainTreasury;
  supplier: SupplierEvaluation;
  authority: AuthorityEvaluation;
  cashFlow: CashFlowAnalysis;
}

export function evaluateRisk(input: RiskInput): RiskFinding[] {
  const { asOf, invoice, treasury, supplier, authority, cashFlow } = input;
  const findings: RiskFinding[] = [];

  // --- Blocking: each of these maps to a Move check that would refuse --------

  if (!supplier.found) {
    findings.push({
      code: "SUPPLIER_NOT_IN_REGISTRY",
      blocking: true,
      detail: `Supplier "${supplier.supplierId}" is not in the on-chain registry.`,
      evidence: { supplierId: supplier.supplierId },
    });
  } else if (!supplier.approved) {
    findings.push({
      code: "SUPPLIER_NOT_APPROVED",
      blocking: true,
      detail: `Supplier "${supplier.supplierId}" is in the registry but not approved.`,
      evidence: { supplierId: supplier.supplierId },
    });
  }

  if (supplier.found && !supplier.walletMatches) {
    findings.push({
      code: "RECIPIENT_WALLET_MISMATCH",
      blocking: true,
      detail:
        `The invoice asks to be paid to ${short(supplier.invoiceRecipient)}, but the registry ` +
        `holds ${short(supplier.registeredWallet ?? "")} for this supplier.`,
      evidence: {
        invoiceRecipient: supplier.invoiceRecipient,
        registeredWallet: supplier.registeredWallet,
      },
    });
  }

  if (!treasury.allowedCurrencies.includes(invoice.currency)) {
    findings.push({
      code: "CURRENCY_NOT_ALLOWED",
      blocking: true,
      detail: `${invoice.currency} is not a settlement currency this treasury permits.`,
      evidence: { currency: invoice.currency, allowed: treasury.allowedCurrencies.join(", ") },
    });
  }

  if (invoice.status === "PAID") {
    findings.push({
      code: "INVOICE_ALREADY_PAID",
      blocking: true,
      detail: `${invoice.invoiceNumber} has already been settled on chain.`,
      evidence: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
    });
  } else if (!PAYABLE_STATUSES.has(invoice.status)) {
    findings.push({
      code: "INVOICE_NOT_PAYABLE",
      blocking: true,
      detail: `${invoice.invoiceNumber} is ${invoice.status} and cannot be paid.`,
      evidence: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
    });
  }

  // Reserve is blocking only when NO date clears it. If a later date works,
  // that is a timing question, not a refusal — and answering it is the point of
  // the cash-flow layer.
  if (cashFlow.earliestSafeDate === null) {
    findings.push({
      code: "NO_SAFE_PAYMENT_DATE",
      blocking: true,
      detail:
        `No date in the horizon leaves the vault above its ${money(treasury.minimumReserveCents)} ` +
        `reserve after paying ${money(cashFlow.amountCents)}.`,
      evidence: {
        balanceCents: treasury.balanceCents,
        reserveCents: treasury.minimumReserveCents,
        amountCents: cashFlow.amountCents,
      },
    });
  }

  // --- Non-blocking: real, but not something the chain polices ---------------

  if (cashFlow.today.breachesReserveImmediately && cashFlow.earliestSafeDate !== null) {
    findings.push({
      code: "INSUFFICIENT_RESERVE_TODAY",
      blocking: false,
      detail:
        `Paying today would leave ${money(cashFlow.today.balanceAfterPaymentCents)}, below the ` +
        `${money(treasury.minimumReserveCents)} reserve. ${cashFlow.earliestSafeDate} clears it.`,
      evidence: {
        balanceAfterPaymentCents: cashFlow.today.balanceAfterPaymentCents,
        reserveCents: treasury.minimumReserveCents,
        earliestSafeDate: cashFlow.earliestSafeDate,
      },
    });
  }

  const safeOption = cashFlow.candidates.find((option) => !option.breachesReserveImmediately);
  if (safeOption?.projectedReserveBreach) {
    findings.push({
      code: "PROJECTED_RESERVE_BREACH",
      blocking: false,
      detail:
        `The chain would accept this payment, but the forecast still dips to ` +
        `${money(safeOption.projectedMinimumCashCents)} on ${safeOption.projectedMinimumCashDate}.`,
      evidence: {
        projectedMinimumCashCents: safeOption.projectedMinimumCashCents,
        onDate: safeOption.projectedMinimumCashDate,
      },
    });
  }

  if (!authority.withinAutonomousAuthority) {
    findings.push({
      code: "EXCEEDS_AUTONOMOUS_AUTHORITY",
      // Not blocking: a human can still approve it. What it blocks is the agent
      // acting alone, which is a different statement.
      blocking: false,
      detail: `${money(authority.amountCents)} is ${authorityPhrase(authority)}.`,
      evidence: {
        status: authority.status,
        amountCents: authority.amountCents,
        maxSinglePaymentCents: authority.maxSinglePaymentCents,
        remainingTodayCents: authority.remainingTodayCents,
        thresholdCents: authority.humanApprovalThresholdCents,
      },
    });
  }

  const daysUntilDue = daysBetween(asOf, invoice.dueDate);
  if (daysUntilDue < 0) {
    findings.push({
      code: "OVERDUE",
      blocking: false,
      detail: `${invoice.invoiceNumber} was due ${Math.abs(daysUntilDue)} day(s) ago.`,
      evidence: { dueDate: invoice.dueDate, daysOverdue: Math.abs(daysUntilDue) },
    });
  } else if (daysUntilDue <= IMMINENT_DAYS) {
    findings.push({
      code: "DUE_IMMINENT",
      blocking: false,
      detail: `${invoice.invoiceNumber} is due in ${daysUntilDue} day(s).`,
      evidence: { dueDate: invoice.dueDate, daysUntilDue },
    });
  }

  return findings;
}

export function hasBlockingRisk(risks: readonly RiskFinding[]): boolean {
  return risks.some((risk) => risk.blocking);
}

function authorityPhrase(authority: AuthorityEvaluation): string {
  switch (authority.status) {
    case "EXCEEDS_SINGLE_LIMIT":
      return `above the agent's ${money(authority.maxSinglePaymentCents)} per-payment ceiling`;
    case "EXCEEDS_DAILY_LIMIT":
      return `more than the ${money(authority.remainingTodayCents)} the agent has left today`;
    case "REQUIRES_HUMAN_APPROVAL":
      return `above the ${money(authority.humanApprovalThresholdCents)} human-approval threshold`;
    case "AGENT_DISABLED":
      return "not payable because the agent capability is disabled";
    case "AGENT_NOT_REGISTERED":
      return "not payable because no agent is registered on this treasury";
    case "WITHIN_AUTONOMOUS":
      return "within the agent's authority";
  }
}

function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}
