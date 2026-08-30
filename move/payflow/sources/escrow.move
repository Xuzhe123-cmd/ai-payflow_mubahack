/// Conditional settlement: funds that have left the treasury but have not
/// reached the supplier.
///
/// An invoice can be entirely legitimate — approved supplier, matching wallet,
/// inside every limit, comfortable liquidity — and still not be payable yet,
/// because something in the real world has not happened. This module is where
/// that gap lives.
///
/// The design principle is CUSTODY, not flags. Once locked, the money is a
/// `Balance` inside the escrow object, and the only function in the package
/// that can move it to the supplier demands a confirmed attestation. There is
/// no permission bit to flip and no privileged caller who can skip the check,
/// because the check is not a permission — it is the only route the coin has.
///
/// Layering, and the reason it is acyclic: escrow -> payment -> treasury.
/// `payment` knows nothing about escrow. It refuses conditional invoices in
/// `settle`, which is the single point its three entry points share, and this
/// module picks them up.
module payflow::escrow;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::event;
use payflow::agent::{Self, AgentCap};
use payflow::approval::{Self, HumanApproval};
use payflow::invoice::{Self, Invoice};
use payflow::limits;
use payflow::oracle::{Self, ShipmentAttestation};
use payflow::payment;
use payflow::registry::{Self, SupplierRegistry};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const EWrongTreasury: u64 = 900;
/// Routing an unconditional invoice through escrow would hide a plain payment
/// behind a condition nobody asked for.
const ENotConditional: u64 = 901;
/// Already released or already refunded. Both are terminal.
const ENotLocked: u64 = 902;
/// The attestation is for a different invoice.
const EAttestationMismatch: u64 = 903;
/// The oracle looked and the shipment was not confirmed.
const EShipmentNotConfirmed: u64 = 904;
/// An old confirmation is not standing permission.
const EAttestationExpired: u64 = 905;

const STATUS_LOCKED: u8 = 0;
const STATUS_RELEASED: u8 = 1;
const STATUS_REFUNDED: u8 = 2;

/// Money in transit, and the terms it is held under.
///
/// `recipient` is written once, at lock time, from the address that had just
/// passed check 4 against the supplier registry. Nothing reads a destination
/// from a caller after that point — which is the whole answer to "can the
/// oracle redirect the payment".
public struct PaymentEscrow<phantom T> has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    supplier_id: String,
    recipient: address,
    /// The actual money. Not a claim on the vault — the vault no longer has it.
    funds: Balance<T>,
    amount: u64,
    /// AGENT or HUMAN_APPROVAL — which authority locked it, for the audit trail.
    authority: u8,
    recommendation_id: String,
    status: u8,
    locked_at_ms: u64,
    released_at_ms: u64,
    attestation_id: Option<ID>,
}

public struct EscrowLocked has copy, drop {
    escrow_id: ID,
    treasury_id: ID,
    invoice_number: String,
    recipient: address,
    amount: u64,
    authority: u8,
    locked_at_ms: u64,
}

public struct EscrowReleased has copy, drop {
    escrow_id: ID,
    treasury_id: ID,
    invoice_number: String,
    recipient: address,
    amount: u64,
    attestation_id: ID,
    released_at_ms: u64,
}

public struct EscrowRefunded has copy, drop {
    escrow_id: ID,
    treasury_id: ID,
    invoice_number: String,
    amount: u64,
    refunded_at_ms: u64,
}

// --- Locking -----------------------------------------------------------------

/// The agent settling a conditional invoice under its own capability.
///
/// Runs the identical ten checks `execute_payment` runs — same `evaluate`, same
/// `Limits`, same abort codes — and then puts the money somewhere the agent
/// cannot get it back out of. Being authorized to pay is not the same as being
/// able to, and this is where those two come apart.
public fun execute_conditional<T>(
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
    assert!(agent::treasury_id(cap) == object::id(treasury), EWrongTreasury);

    let lim = agent::limits_for(treasury, cap, clock);
    let ev = payment::evaluate(
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
    assert!(payment::approved(&ev), payment::first_violation(&ev) as u64);

    lock(
        treasury,
        inv,
        amount,
        recipient,
        recommendation_id,
        option::some(agent::cap_id(cap)),
        limits::authority_agent(),
        clock,
        ctx,
    );
}

/// A person settling a conditional invoice above the agent's authority.
///
/// The approval raises WHO may authorize the amount. It does not touch the
/// shipment condition, and there is no argument here through which it could —
/// this function locks, exactly as the agent's does, and release still needs
/// the oracle.
public fun execute_conditional_approved<T>(
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
    approval::assert_treasury(approval, treasury);
    assert!(
        approval::invoice_number(approval) == invoice::invoice_number(inv),
        EAttestationMismatch,
    );

    let amount = approval::amount(approval);
    let recipient = approval::recipient(approval);
    let lim = approval::limits_for(treasury, approval, clock);
    let ev = payment::evaluate(
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
    assert!(payment::approved(&ev), payment::first_violation(&ev) as u64);

    approval::consume(approval);
    lock(
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

/// Moves the coin out of the vault and into a shared escrow.
///
/// Two things happen here that matter beyond the transfer. The invoice number
/// is claimed in the treasury's replay ledger, so check 8 refuses any second
/// payment against it while the first is still in escrow — without that, the
/// vault could be drained twice over one invoice. And the agent's daily spend
/// is recorded now rather than at release, because the money is committed the
/// moment it leaves the vault.
fun lock<T>(
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
    assert!(invoice::treasury_id(inv) == object::id(treasury), EWrongTreasury);
    assert!(invoice::requires_shipment(inv), ENotConditional);

    let now = clock::timestamp_ms(clock);
    let treasury_id = object::id(treasury);
    let invoice_number = invoice::invoice_number(inv);

    let funds = treasury::split_vault(treasury, amount, ctx);

    if (agent_cap_id.is_some()) {
        treasury::record_agent_spend(treasury, *agent_cap_id.borrow(), amount, now);
    };

    let id = object::new(ctx);
    let escrow_id = object::uid_to_inner(&id);

    treasury::mark_invoice_paid(treasury, invoice_number, escrow_id);
    invoice::mark_escrowed(inv);

    event::emit(EscrowLocked {
        escrow_id,
        treasury_id,
        invoice_number,
        recipient,
        amount,
        authority,
        locked_at_ms: now,
    });

    transfer::share_object(PaymentEscrow<T> {
        id,
        treasury_id,
        invoice_number,
        supplier_id: invoice::supplier_id(inv),
        recipient,
        funds: coin::into_balance(funds),
        amount,
        authority,
        recommendation_id,
        status: STATUS_LOCKED,
        locked_at_ms: now,
        released_at_ms: 0,
        attestation_id: option::none(),
    });
}

// --- Release -----------------------------------------------------------------

/// Pays the supplier, if and only if the shipment is confirmed.
///
/// Deliberately permissionless: it takes no capability, because every term of
/// the payment was fixed at lock time and the attestation supplies the only
/// missing fact. There is nothing left for a caller to influence — no
/// destination, no amount, no choice of invoice — so requiring a particular
/// sender would add ceremony without adding safety.
///
/// Note what is NOT re-checked: the reserve. The funds left the vault at lock,
/// when the reserve was checked against them. Re-checking here would be asking
/// whether the treasury can afford money it has already parted with.
public fun release<T>(
    treasury: &mut Treasury<T>,
    escrow: &mut PaymentEscrow<T>,
    att: &ShipmentAttestation,
    inv: &mut Invoice,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // Terminal states stay terminal. This is what stops a double release, and
    // equally a release after a refund.
    assert!(escrow.status == STATUS_LOCKED, ENotLocked);
    assert!(escrow.treasury_id == object::id(treasury), EWrongTreasury);
    assert!(invoice::invoice_number(inv) == escrow.invoice_number, EAttestationMismatch);

    // The attestation must be about THIS treasury and THIS invoice. Without
    // both, a confirmation for some other shipment would open this escrow.
    oracle::assert_treasury(att, treasury);
    assert!(oracle::invoice_number(att) == escrow.invoice_number, EAttestationMismatch);

    assert!(oracle::confirmed(att), EShipmentNotConfirmed);
    assert!(clock::timestamp_ms(clock) <= oracle::expires_at_ms(att), EAttestationExpired);

    let now = clock::timestamp_ms(clock);
    escrow.status = STATUS_RELEASED;
    escrow.released_at_ms = now;
    escrow.attestation_id = option::some(object::id(att));

    // The destination is the escrow's own field. No parameter reaches it.
    let amount = balance::value(&escrow.funds);
    let funds = balance::withdraw_all(&mut escrow.funds);
    transfer::public_transfer(coin::from_balance(funds, ctx), escrow.recipient);

    event::emit(EscrowReleased {
        escrow_id: object::id(escrow),
        treasury_id: escrow.treasury_id,
        invoice_number: escrow.invoice_number,
        recipient: escrow.recipient,
        amount,
        attestation_id: object::id(att),
        released_at_ms: now,
    });

    // The spend was already counted at lock, so the record must not count it
    // again — hence `none` for the cap id here.
    payment::record_settlement(
        treasury,
        inv,
        amount,
        escrow.recipient,
        escrow.recommendation_id,
        option::none(),
        escrow.authority,
        clock,
        ctx,
    );
}

// --- Refund ------------------------------------------------------------------

/// Returns unreleased funds to the vault. Admin only.
///
/// The exit for a shipment that never arrives. It requires the
/// `TreasuryOwnerCap` because it is the one operation that undoes a committed
/// payment, and neither the agent nor the oracle should be able to.
///
/// The invoice number stays claimed in the replay ledger afterwards. That is
/// deliberate: re-opening it would allow a lock/refund/lock cycle against the
/// same invoice, and a refund is rare enough that an admin re-issuing the
/// invoice is the safer path.
public fun refund<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    escrow: &mut PaymentEscrow<T>,
    clock: &Clock,
) {
    treasury::assert_owner(treasury, cap);
    assert!(escrow.status == STATUS_LOCKED, ENotLocked);
    assert!(escrow.treasury_id == object::id(treasury), EWrongTreasury);

    escrow.status = STATUS_REFUNDED;

    let amount = balance::value(&escrow.funds);
    let funds = balance::withdraw_all(&mut escrow.funds);
    treasury::return_to_vault(treasury, funds);

    event::emit(EscrowRefunded {
        escrow_id: object::id(escrow),
        treasury_id: escrow.treasury_id,
        invoice_number: escrow.invoice_number,
        amount,
        refunded_at_ms: clock::timestamp_ms(clock),
    });
}

// --- Reads -------------------------------------------------------------------

/// Whether this attestation would in fact open this escrow, without trying it.
/// For `devInspect` from the interface, so a screen can say "releasable" with
/// the same logic `release` enforces rather than a second opinion about it.
public fun releasable<T>(
    escrow: &PaymentEscrow<T>,
    att: &ShipmentAttestation,
    clock: &Clock,
): bool {
    escrow.status == STATUS_LOCKED
        && oracle::treasury_id(att) == escrow.treasury_id
        && oracle::invoice_number(att) == escrow.invoice_number
        && oracle::confirmed(att)
        && clock::timestamp_ms(clock) <= oracle::expires_at_ms(att)
}

public fun treasury_id<T>(escrow: &PaymentEscrow<T>): ID { escrow.treasury_id }

public fun invoice_number<T>(escrow: &PaymentEscrow<T>): String { escrow.invoice_number }

public fun supplier_id<T>(escrow: &PaymentEscrow<T>): String { escrow.supplier_id }

public fun recipient<T>(escrow: &PaymentEscrow<T>): address { escrow.recipient }

public fun amount<T>(escrow: &PaymentEscrow<T>): u64 { escrow.amount }

/// What the escrow still holds. Zero once released or refunded.
public fun balance_value<T>(escrow: &PaymentEscrow<T>): u64 { balance::value(&escrow.funds) }

public fun authority<T>(escrow: &PaymentEscrow<T>): u8 { escrow.authority }

public fun status<T>(escrow: &PaymentEscrow<T>): u8 { escrow.status }

public fun is_locked<T>(escrow: &PaymentEscrow<T>): bool { escrow.status == STATUS_LOCKED }

public fun locked_at_ms<T>(escrow: &PaymentEscrow<T>): u64 { escrow.locked_at_ms }

public fun released_at_ms<T>(escrow: &PaymentEscrow<T>): u64 { escrow.released_at_ms }

public fun attestation_id<T>(escrow: &PaymentEscrow<T>): &Option<ID> { &escrow.attestation_id }

public fun recommendation_id<T>(escrow: &PaymentEscrow<T>): String { escrow.recommendation_id }

public fun status_locked(): u8 { STATUS_LOCKED }

public fun status_released(): u8 { STATUS_RELEASED }

public fun status_refunded(): u8 { STATUS_REFUNDED }

/// Kept so a caller can confirm the registry agrees about the escrow's
/// recipient — the address is fixed at lock, and this is how a reader verifies
/// it was fixed to the right thing.
public fun recipient_matches_registry<T>(
    escrow: &PaymentEscrow<T>,
    reg: &SupplierRegistry,
): bool {
    registry::wallet_matches(reg, &escrow.supplier_id, escrow.recipient)
}
