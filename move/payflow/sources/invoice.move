/// An invoice as an on-chain object.
///
/// Shared, because its status is transitioned by senders that are not its
/// creator — the agent while analyzing, and the payment path when it settles.
///
/// The document itself never touches Sui: `walrus_blob_id` points at it. The
/// fields kept here are only those the chain actually reasons about, plus the
/// audit detail a payment record needs to be meaningful.
module payflow::invoice;

use std::string::String;
use sui::dynamic_field as df;
use payflow::treasury::{Self, TreasuryOwnerCap};

const EWrongTreasury: u64 = 300;
const EAlreadyPaid: u64 = 301;

const STATUS_PENDING: u8 = 0;
const STATUS_ANALYZING: u8 = 1;
const STATUS_APPROVED: u8 = 2;
const STATUS_SCHEDULED: u8 = 3;
const STATUS_PAID: u8 = 4;
const STATUS_REJECTED: u8 = 5;
const STATUS_HUMAN_REVIEW: u8 = 6;
/// Funds have left the vault into escrow, but the supplier does not have them.
/// Deliberately NOT `PAID`: the invoice is not settled until the escrow is
/// released, and calling it paid here would be a lie the audit trail keeps.
const STATUS_ESCROWED: u8 = 7;

/// Key for the dynamic field marking an invoice as settling through escrow.
///
/// A dynamic field rather than a struct field because `Invoice` is already
/// deployed and its layout cannot change. It also happens to be the better
/// design: the condition travels with the invoice, so every code path that
/// already holds an `&Invoice` can see it without gaining a parameter.
public struct ShipmentRequired has copy, drop, store {}

public struct Invoice has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    supplier_id: String,
    amount: u64,
    currency: String,
    /// ISO date, carried for audit and display. The chain does no date maths.
    due_date: String,
    po_number: String,
    /// Where the invoice asks to be paid — a claim, checked against the
    /// registry rather than trusted.
    recipient: address,
    walrus_blob_id: Option<String>,
    status: u8,
    created_at_ms: u64,
}

public fun create(
    cap: &TreasuryOwnerCap,
    invoice_number: String,
    supplier_id: String,
    amount: u64,
    currency: String,
    due_date: String,
    po_number: String,
    recipient: address,
    created_at_ms: u64,
    ctx: &mut TxContext,
): ID {
    let id = object::new(ctx);
    let invoice_id = object::uid_to_inner(&id);
    transfer::share_object(Invoice {
        id,
        treasury_id: treasury::cap_treasury_id(cap),
        invoice_number,
        supplier_id,
        amount,
        currency,
        due_date,
        po_number,
        recipient,
        walrus_blob_id: option::none(),
        status: STATUS_PENDING,
        created_at_ms,
    });
    invoice_id
}

fun assert_owner(invoice: &Invoice, cap: &TreasuryOwnerCap) {
    assert!(treasury::cap_treasury_id(cap) == invoice.treasury_id, EWrongTreasury);
}

/// A paid invoice is terminal. Nothing may move it back to a payable state —
/// that would reopen the replay hole that check 8 closes.
public fun set_status(invoice: &mut Invoice, cap: &TreasuryOwnerCap, status: u8) {
    assert_owner(invoice, cap);
    assert!(invoice.status != STATUS_PAID, EAlreadyPaid);
    invoice.status = status;
}

/// Marks this invoice as settling only against a confirmed shipment.
///
/// Admin-only. The agent cannot set this, and — far more importantly — cannot
/// clear it: there is no removal function in this module at all, so a condition
/// once attached is permanent for the life of the invoice.
public fun require_shipment_confirmation(invoice: &mut Invoice, cap: &TreasuryOwnerCap) {
    assert_owner(invoice, cap);
    assert!(invoice.status != STATUS_PAID, EAlreadyPaid);
    if (!df::exists(&invoice.id, ShipmentRequired {})) {
        df::add(&mut invoice.id, ShipmentRequired {}, true);
    }
}

/// Whether this invoice carries a settlement condition.
///
/// `payment::settle` consults this and refuses, which is what keeps the direct
/// paths — agent, human-approved and scheduled alike — out of a conditional
/// invoice.
public fun requires_shipment(invoice: &Invoice): bool {
    df::exists(&invoice.id, ShipmentRequired {})
}

/// Called only from `escrow`, when funds move from the vault into escrow.
public(package) fun mark_escrowed(invoice: &mut Invoice) {
    invoice.status = STATUS_ESCROWED;
}

public fun attach_blob(invoice: &mut Invoice, cap: &TreasuryOwnerCap, blob_id: String) {
    assert_owner(invoice, cap);
    invoice.walrus_blob_id = option::some(blob_id);
}

/// Called only from `payment`, in the same transaction as the transfer.
public(package) fun mark_paid(invoice: &mut Invoice) {
    invoice.status = STATUS_PAID;
}

// --- Reads -------------------------------------------------------------------

public fun treasury_id(invoice: &Invoice): ID { invoice.treasury_id }

public fun invoice_number(invoice: &Invoice): String { invoice.invoice_number }

public fun supplier_id(invoice: &Invoice): String { invoice.supplier_id }

public fun amount(invoice: &Invoice): u64 { invoice.amount }

public fun currency(invoice: &Invoice): String { invoice.currency }

public fun due_date(invoice: &Invoice): String { invoice.due_date }

public fun po_number(invoice: &Invoice): String { invoice.po_number }

public fun recipient(invoice: &Invoice): address { invoice.recipient }

public fun status(invoice: &Invoice): u8 { invoice.status }

public fun is_paid(invoice: &Invoice): bool { invoice.status == STATUS_PAID }

public fun walrus_blob_id(invoice: &Invoice): &Option<String> { &invoice.walrus_blob_id }

public fun created_at_ms(invoice: &Invoice): u64 { invoice.created_at_ms }

public fun status_pending(): u8 { STATUS_PENDING }

public fun status_analyzing(): u8 { STATUS_ANALYZING }

public fun status_approved(): u8 { STATUS_APPROVED }

public fun status_scheduled(): u8 { STATUS_SCHEDULED }

public fun status_paid(): u8 { STATUS_PAID }

public fun status_rejected(): u8 { STATUS_REJECTED }

public fun status_human_review(): u8 { STATUS_HUMAN_REVIEW }

public fun status_escrowed(): u8 { STATUS_ESCROWED }

public fun is_escrowed(invoice: &Invoice): bool { invoice.status == STATUS_ESCROWED }
