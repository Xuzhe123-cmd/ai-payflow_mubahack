/// Payment evaluation and execution — the only module that can move funds.
///
/// The central design decision lives here. Move aborts on the FIRST failed
/// assertion, but the interface has to show the whole enforcement pass: ten
/// checks, passed and failed alike. One aborting function cannot produce that.
///
/// So there are two entry points over ONE rule implementation. `evaluate` is
/// non-aborting and returns every result, for `devInspect` and the UI.
/// `execute_payment` calls that same `evaluate` and aborts with
/// `first_violation`. Because the rule body is shared, the report the interface
/// renders and the rule the chain enforces cannot drift apart — and because
/// `evaluate` moves no money, a caller who sees `approved: true` has gained
/// nothing they did not already have.
///
/// The abort code IS the check code. Codes 1..10 are positions in the check
/// vector and mirror `PolicyViolationCode` in lib/types.ts one for one, so a
/// Move abort decodes straight back to the violation the interface knows.
module payflow::payment;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use payflow::agent::{Self, AgentCap};
use payflow::approval::{Self, HumanApproval};
use payflow::invoice::{Self, Invoice};
use payflow::limits::{Self, Limits};
use payflow::policy;
use payflow::registry::{Self, SupplierRegistry};
use payflow::treasury::{Self, Treasury};

// --- The ten check codes. Order is the contract. -----------------------------

const EAgentNotAuthorized: u64 = 1;
const ECapabilityDisabled: u64 = 2;
const ESupplierNotApproved: u64 = 3;
const ERecipientWalletMismatch: u64 = 4;
const EExceedsMaxPayment: u64 = 5;
const EExceedsDailyLimit: u64 = 6;
const ECurrencyNotAllowed: u64 = 7;
const EInvoiceAlreadyPaid: u64 = 8;
const EInsufficientReserve: u64 = 9;
const ERecommendationExpired: u64 = 10;

const CHECK_COUNT: u64 = 10;

// --- Operational errors, deliberately far away from the check codes ----------

const EWrongTreasury: u64 = 700;
const EApprovalMismatch: u64 = 701;
const ERequestNotPending: u64 = 702;
/// This invoice settles only against a confirmed shipment, so it cannot be paid
/// from here. `escrow::execute_conditional` is the only way through.
const EConditionalInvoice: u64 = 703;

const REQUEST_PENDING: u8 = 0;
const REQUEST_EXECUTED: u8 = 1;
const REQUEST_REJECTED: u8 = 2;

/// Sentinel for "this payment carries no expiry" — an immediate payment rather
/// than a scheduled one. Check 10 passes trivially against it.
const NO_EXPIRY: u64 = 18_446_744_073_709_551_615;

// --- Types -------------------------------------------------------------------

public struct CheckResult has copy, drop, store {
    code: u8,
    passed: bool,
    /// The bound the chain enforces. Booleans report 1.
    limit: u64,
    /// What the request actually asked for. Booleans report 1 or 0.
    actual: u64,
}

public struct PaymentEvaluation has copy, drop {
    approved: bool,
    /// 0 when approved; otherwise the code of the first failed check.
    first_violation: u8,
    /// Always CHECK_COUNT entries, always in code order.
    checks: vector<CheckResult>,
}

/// Immutable audit record. Frozen after creation, so tampering is impossible at
/// the protocol level rather than by convention.
public struct PaymentRecord has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    supplier_id: String,
    recipient: address,
    amount: u64,
    coin_type: String,
    /// Written by Move, not by the caller. The interface reads this to label a
    /// payment autonomous or human-approved, so it cannot mislabel one.
    authority: u8,
    recommendation_id: String,
    executed_at_ms: u64,
    executed_by: address,
}

/// A scheduled intent. Stores what was asked for — never a verdict.
public struct PaymentRequest has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    amount: u64,
    recipient: address,
    requested_date: String,
    recommendation_id: String,
    recommended_at_ms: u64,
    expires_at_ms: u64,
    status: u8,
}

public struct PaymentExecuted has copy, drop {
    treasury_id: ID,
    record_id: ID,
    invoice_number: String,
    recipient: address,
    amount: u64,
    authority: u8,
    executed_at_ms: u64,
}

// --- Evaluation --------------------------------------------------------------

/// Runs all ten checks and returns every result. Aborts on nothing.
///
/// Every value below is read from chain state. The only caller-supplied inputs
/// are `amount` and `recipient` — which are precisely what the checks are
/// about — plus the two recommendation timestamps, which check 10 judges rather
/// than trusts. There is no parameter through which the AI could assert that
/// its own payment is safe.
public fun evaluate<T>(
    treasury: &Treasury<T>,
    lim: &Limits,
    reg: &SupplierRegistry,
    inv: &Invoice,
    amount: u64,
    recipient: address,
    recommended_at_ms: u64,
    expires_at_ms: u64,
    clock: &Clock,
): PaymentEvaluation {
    let pol = treasury::policy(treasury);
    let now = clock::timestamp_ms(clock);
    let supplier_id = invoice::supplier_id(inv);
    let invoice_number = invoice::invoice_number(inv);
    let currency = invoice::currency(inv);
    let vault = treasury::vault_value(treasury);

    let mut checks = vector[];

    // 1 — the capability is registered on THIS treasury.
    let authorized = limits::authorized(lim);
    checks.push_back(check(code(EAgentNotAuthorized), authorized, 1, bit(authorized)));

    // 2 — and has not been revoked.
    let enabled = limits::enabled(lim);
    checks.push_back(check(code(ECapabilityDisabled), enabled, 1, bit(enabled)));

    // 3 — the registry is the authority on who may be paid, not the invoice.
    let approved = registry::is_approved(reg, &supplier_id);
    checks.push_back(check(code(ESupplierNotApproved), approved, 1, bit(approved)));

    // 4 — and on where. This is the payment-redirection check.
    let wallet_ok = registry::wallet_matches(reg, &supplier_id, recipient);
    checks.push_back(check(code(ERecipientWalletMismatch), wallet_ok, 1, bit(wallet_ok)));

    // 5 — the ceiling on a single payment under this authority.
    let max_single = limits::max_single(lim);
    checks.push_back(check(code(EExceedsMaxPayment), amount <= max_single, max_single, amount));

    // 6 — and across the day, after the clock-based rollover.
    let daily_limit = limits::daily_limit(lim);
    let projected = limits::effective_spent(lim) + amount;
    checks.push_back(
        check(code(EExceedsDailyLimit), projected <= daily_limit, daily_limit, projected),
    );

    // 7 — both the invoice's stated currency and the coin actually being moved.
    let currency_ok =
        policy::currency_allowed(pol, &currency)
            && policy::coin_type_allowed(pol, &policy::coin_type_of<T>());
    checks.push_back(check(code(ECurrencyNotAllowed), currency_ok, 1, bit(currency_ok)));

    // 8 — replay protection, from the treasury's own record and the invoice.
    let unpaid = !treasury::invoice_paid(treasury, &invoice_number) && !invoice::is_paid(inv);
    checks.push_back(check(code(EInvoiceAlreadyPaid), unpaid, 1, bit(unpaid)));

    // 9 — the reserve, against the vault as it stands right now. Saturating, so
    // an amount larger than the balance fails HERE rather than underflowing.
    let min_reserve = policy::min_reserve(pol);
    let remaining = if (vault >= amount) vault - amount else 0;
    let reserve_ok = vault >= amount && remaining >= min_reserve;
    checks.push_back(check(code(EInsufficientReserve), reserve_ok, min_reserve, remaining));

    // 10 — an old recommendation is not standing permission. Guarded against a
    // timestamp in the future, which would otherwise underflow.
    let age = if (now >= recommended_at_ms) now - recommended_at_ms else 0;
    let fresh = now <= expires_at_ms && age <= policy::max_recommendation_age_ms(pol);
    checks.push_back(check(code(ERecommendationExpired), fresh, expires_at_ms, now));

    let first_violation = first_failure(&checks);
    PaymentEvaluation { approved: first_violation == 0, first_violation, checks }
}

fun check(code: u8, passed: bool, limit: u64, actual: u64): CheckResult {
    CheckResult { code, passed, limit, actual }
}

/// The abort code and the check code are the same number, by construction.
/// Writing the checks in terms of the error constants is what keeps them that
/// way — there is no second list of numbers to fall out of step.
fun code(error_code: u64): u8 { error_code as u8 }

fun bit(value: bool): u64 { if (value) 1 else 0 }

fun first_failure(checks: &vector<CheckResult>): u8 {
    let mut i = 0;
    let n = checks.length();
    while (i < n) {
        if (!checks[i].passed) return checks[i].code;
        i = i + 1;
    };
    0
}


// --- Execution ---------------------------------------------------------------

/// The agent settling a payment on its own capability.
///
/// This is the autonomous claim, so it is measured against the agent's own
/// limits — which is what makes an over-cap payment abort with code 5 instead
/// of quietly finding a larger authority to run under.
public fun execute_payment<T>(
    treasury: &mut Treasury<T>,
    cap: &AgentCap,
    reg: &SupplierRegistry,
    inv: &mut Invoice,
    amount: u64,
    recipient: address,
    recommendation_id: String,
    recommended_at_ms: u64,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(invoice::treasury_id(inv) == object::id(treasury), EWrongTreasury);
    assert!(registry::treasury_id(reg) == object::id(treasury), EWrongTreasury);

    let lim = agent::limits_for(treasury, cap, clock);
    let ev = evaluate(
        treasury,
        &lim,
        reg,
        inv,
        amount,
        recipient,
        recommended_at_ms,
        expires_at_ms,
        clock,
    );
    assert!(ev.approved, ev.first_violation as u64);

    let cap_id = agent::cap_id(cap);
    settle(
        treasury,
        inv,
        amount,
        recipient,
        recommendation_id,
        option::some(cap_id),
        limits::authority_agent(),
        clock,
        ctx,
    );
}

/// A person settling a payment above the agent's authority.
///
/// The approval is bound to one invoice, amount and recipient, and all three
/// are re-checked here — an approval for one payment cannot be spent on
/// another.
public fun execute_approved<T>(
    treasury: &mut Treasury<T>,
    approval: &mut HumanApproval,
    reg: &SupplierRegistry,
    inv: &mut Invoice,
    recommendation_id: String,
    recommended_at_ms: u64,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(invoice::treasury_id(inv) == object::id(treasury), EWrongTreasury);
    assert!(registry::treasury_id(reg) == object::id(treasury), EWrongTreasury);
    approval::assert_treasury(approval, treasury);
    assert!(
        approval::invoice_number(approval) == invoice::invoice_number(inv),
        EApprovalMismatch,
    );

    let amount = approval::amount(approval);
    let recipient = approval::recipient(approval);
    let lim = approval::limits_for(treasury, approval, clock);
    let ev = evaluate(
        treasury,
        &lim,
        reg,
        inv,
        amount,
        recipient,
        recommended_at_ms,
        expires_at_ms,
        clock,
    );
    assert!(ev.approved, ev.first_violation as u64);

    approval::consume(approval);
    settle(
        treasury,
        inv,
        amount,
        recipient,
        recommendation_id,
        option::none(),
        limits::authority_human_approval(),
        clock,
        ctx,
    );
}

/// Effects, in one transaction: move the coin, bump the counters, mark the
/// invoice, freeze a record. Private, and reached only after `assert!(approved)`.
///
/// THE CONDITIONAL GATE lives here, at the one point all three entry points
/// pass through. An invoice that settles only against a confirmed shipment
/// cannot be paid by the agent, by an approver, or by a scheduled request —
/// none of them can reach a transfer without coming through this function, and
/// this function refuses. That is why the rule needed no change to any existing
/// signature: it is enforced below every caller rather than beside them.
fun settle<T>(
    treasury: &mut Treasury<T>,
    inv: &mut Invoice,
    amount: u64,
    recipient: address,
    recommendation_id: String,
    agent_cap_id: Option<ID>,
    authority: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!invoice::requires_shipment(inv), EConditionalInvoice);

    let funds = treasury::split_vault(treasury, amount, ctx);
    transfer::public_transfer(funds, recipient);

    record_settlement(
        treasury,
        inv,
        amount,
        recipient,
        recommendation_id,
        agent_cap_id,
        authority,
        clock,
        ctx,
    );
}

/// The bookkeeping half of a settlement: counters, invoice status, the frozen
/// record, the event. Everything except moving the coin.
///
/// Split out so `escrow` can complete a release without this module needing to
/// know escrow exists — the dependency runs escrow -> payment and never back,
/// which is what keeps the two modules acyclic.
public(package) fun record_settlement<T>(
    treasury: &mut Treasury<T>,
    inv: &mut Invoice,
    amount: u64,
    recipient: address,
    recommendation_id: String,
    agent_cap_id: Option<ID>,
    authority: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock::timestamp_ms(clock);
    let treasury_id = object::id(treasury);
    let invoice_number = invoice::invoice_number(inv);

    if (agent_cap_id.is_some()) {
        treasury::record_agent_spend(treasury, *agent_cap_id.borrow(), amount, now);
    };

    invoice::mark_paid(inv);
    treasury::record_payment(treasury, amount);

    let uid = object::new(ctx);
    let record_id = object::uid_to_inner(&uid);
    // Written in the SAME transaction as the transfer, which is what makes a
    // replay impossible rather than merely unlikely. For an escrow release the
    // number was already claimed at lock time; this re-points that entry at the
    // record, which is why the ledger write is idempotent on the key.
    treasury::mark_invoice_paid(treasury, invoice_number, record_id);

    event::emit(PaymentExecuted {
        treasury_id,
        record_id,
        invoice_number,
        recipient,
        amount,
        authority,
        executed_at_ms: now,
    });

    transfer::freeze_object(PaymentRecord {
        id: uid,
        treasury_id,
        invoice_number,
        supplier_id: invoice::supplier_id(inv),
        recipient,
        amount,
        coin_type: policy::coin_type_of<T>(),
        authority,
        recommendation_id,
        executed_at_ms: now,
        executed_by: ctx.sender(),
    });
}

// --- Scheduled payments ------------------------------------------------------

/// Records an intent to pay later. Moves nothing.
public fun request<T>(
    treasury: &Treasury<T>,
    cap: &AgentCap,
    inv: &Invoice,
    amount: u64,
    recipient: address,
    requested_date: String,
    recommendation_id: String,
    recommended_at_ms: u64,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(agent::treasury_id(cap) == object::id(treasury), EWrongTreasury);
    assert!(invoice::treasury_id(inv) == object::id(treasury), EWrongTreasury);

    transfer::share_object(PaymentRequest {
        id: object::new(ctx),
        treasury_id: object::id(treasury),
        invoice_number: invoice::invoice_number(inv),
        amount,
        recipient,
        requested_date,
        recommendation_id,
        recommended_at_ms,
        expires_at_ms,
        status: REQUEST_PENDING,
    });
}

/// Executes a scheduled request — re-running every check against the state as
/// it stands NOW.
///
/// The request supplies the amount, the recipient and the timestamps. It
/// supplies no verdict, and none of the checks consult the fact that it was
/// once approved. The treasury may have been drained, the supplier revoked, the
/// agent disabled, or the recommendation gone stale in the meantime, and any of
/// those refuses the payment here.
public fun execute_scheduled<T>(
    treasury: &mut Treasury<T>,
    req: &mut PaymentRequest,
    cap: &AgentCap,
    reg: &SupplierRegistry,
    inv: &mut Invoice,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(req.treasury_id == object::id(treasury), EWrongTreasury);
    assert!(req.status == REQUEST_PENDING, ERequestNotPending);
    assert!(req.invoice_number == invoice::invoice_number(inv), EApprovalMismatch);

    let lim = agent::limits_for(treasury, cap, clock);
    let ev = evaluate(
        treasury,
        &lim,
        reg,
        inv,
        req.amount,
        req.recipient,
        req.recommended_at_ms,
        req.expires_at_ms,
        clock,
    );

    if (!ev.approved) {
        req.status = REQUEST_REJECTED;
        abort ev.first_violation as u64
    };

    req.status = REQUEST_EXECUTED;
    let cap_id = agent::cap_id(cap);
    settle(
        treasury,
        inv,
        req.amount,
        req.recipient,
        req.recommendation_id,
        option::some(cap_id),
        limits::authority_agent(),
        clock,
        ctx,
    );
}

// --- Reads -------------------------------------------------------------------

public fun approved(ev: &PaymentEvaluation): bool { ev.approved }

public fun first_violation(ev: &PaymentEvaluation): u8 { ev.first_violation }

public fun checks(ev: &PaymentEvaluation): &vector<CheckResult> { &ev.checks }

public fun check_count(ev: &PaymentEvaluation): u64 { ev.checks.length() }

public fun check_at(ev: &PaymentEvaluation, index: u64): &CheckResult { &ev.checks[index] }

public fun result_code(result: &CheckResult): u8 { result.code }

public fun result_passed(result: &CheckResult): bool { result.passed }

public fun result_limit(result: &CheckResult): u64 { result.limit }

public fun result_actual(result: &CheckResult): u64 { result.actual }

public fun record_amount(record: &PaymentRecord): u64 { record.amount }

public fun record_authority(record: &PaymentRecord): u8 { record.authority }

public fun record_invoice_number(record: &PaymentRecord): String { record.invoice_number }

public fun record_recipient(record: &PaymentRecord): address { record.recipient }

public fun record_recommendation_id(record: &PaymentRecord): String {
    record.recommendation_id
}

public fun record_executed_at_ms(record: &PaymentRecord): u64 { record.executed_at_ms }

public fun request_status(req: &PaymentRequest): u8 { req.status }

public fun request_amount(req: &PaymentRequest): u64 { req.amount }

public fun expected_check_count(): u64 { CHECK_COUNT }

public fun no_expiry(): u64 { NO_EXPIRY }

public fun request_pending(): u8 { REQUEST_PENDING }

public fun request_executed(): u8 { REQUEST_EXECUTED }

public fun request_rejected(): u8 { REQUEST_REJECTED }

/// Lets a test build the same coin-type string check 7 compares against,
/// rather than hard-coding an address that changes between builds.
#[test_only]
public fun coin_type_of<T>(): String { policy::coin_type_of<T>() }
