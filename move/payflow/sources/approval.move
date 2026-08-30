/// Human approval for payments above the agent's authority.
///
/// An approval is bound to one specific payment — invoice, amount, recipient —
/// and authorizes exactly that. It is not a raised limit; it is a signature on
/// a single transfer, and `execute_approved` re-checks that the payment in
/// front of it is the one that was signed for.
///
/// The agent cannot reach any of this. It holds no `ApproverCap`, so it cannot
/// mint an approval, and `payment::execute_payment` — the only function an
/// `AgentCap` can drive — never consults one. That is what stops the agent from
/// promoting itself past its own ceiling.
module payflow::approval;

use std::string::String;
use sui::clock::{Self, Clock};
use payflow::limits::{Self, Limits};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const EWrongTreasury: u64 = 600;
const EAboveApproverLimit: u64 = 601;

/// Issued by the admin to a person who may authorize large payments.
public struct ApproverCap has key, store {
    id: UID,
    treasury_id: ID,
    max_single: u64,
}

/// A single-use authorization for one specific payment.
public struct HumanApproval has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    amount: u64,
    recipient: address,
    approver: address,
    expires_at_ms: u64,
    consumed: bool,
}

// --- Approver capabilities ---------------------------------------------------

public fun issue_approver<T>(
    treasury: &Treasury<T>,
    cap: &TreasuryOwnerCap,
    max_single: u64,
    ctx: &mut TxContext,
): ApproverCap {
    treasury::assert_owner(treasury, cap);
    ApproverCap { id: object::new(ctx), treasury_id: object::id(treasury), max_single }
}

#[allow(lint(self_transfer))]
public fun issue_approver_to<T>(
    treasury: &Treasury<T>,
    cap: &TreasuryOwnerCap,
    max_single: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let approver = issue_approver(treasury, cap, max_single, ctx);
    transfer::public_transfer(approver, recipient);
}

// --- Approvals ---------------------------------------------------------------

/// Signs off one payment. Shared so the later execution transaction — which may
/// be sent by someone else entirely — can consume it.
public fun approve(
    cap: &ApproverCap,
    invoice_number: String,
    amount: u64,
    recipient: address,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(amount <= cap.max_single, EAboveApproverLimit);
    transfer::share_object(HumanApproval {
        id: object::new(ctx),
        treasury_id: cap.treasury_id,
        invoice_number,
        amount,
        recipient,
        approver: ctx.sender(),
        expires_at_ms,
        consumed: false,
    });
}

/// The approval authorizes this payment and no larger one: both the single and
/// the daily figure are the approved amount itself, so it cannot be stretched.
public fun limits_for<T>(
    treasury: &Treasury<T>,
    approval: &HumanApproval,
    clock: &Clock,
): Limits {
    let live =
        !approval.consumed
            && approval.treasury_id == object::id(treasury)
            && clock::timestamp_ms(clock) <= approval.expires_at_ms;

    limits::new_human_approval(live, approval.amount, approval.amount, 0)
}

public(package) fun consume(approval: &mut HumanApproval) {
    approval.consumed = true;
}

public fun assert_treasury<T>(approval: &HumanApproval, treasury: &Treasury<T>) {
    assert!(approval.treasury_id == object::id(treasury), EWrongTreasury);
}

// --- Reads -------------------------------------------------------------------

public fun invoice_number(approval: &HumanApproval): String { approval.invoice_number }

public fun amount(approval: &HumanApproval): u64 { approval.amount }

public fun recipient(approval: &HumanApproval): address { approval.recipient }

public fun approver(approval: &HumanApproval): address { approval.approver }

public fun expires_at_ms(approval: &HumanApproval): u64 { approval.expires_at_ms }

public fun consumed(approval: &HumanApproval): bool { approval.consumed }

public fun treasury_id(approval: &HumanApproval): ID { approval.treasury_id }

public fun approver_max_single(cap: &ApproverCap): u64 { cap.max_single }
