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
///
/// ─────────────────────────────────────────────────────────────────────────
/// SCOPED, REVOCABLE APPROVERS — and why `ApproverCap` was not enough.
///
/// `ApproverCap` carries its own `max_single`. Only an object's owner may
/// mutate an object, so once the admin has transferred one they can neither
/// lower that limit nor take the authority back: there is no revocation
/// function in this module and there cannot be one. The cap deployed on
/// testnet authorises $25,000,000 against an $88,200 vault.
///
/// `approve_scoped` replaces it. Authority now lives in treasury state, keyed
/// by the approver's ADDRESS, exactly as `AgentAuthorization` does for agents
/// and for the same stated reason — state the admin owns is state the admin
/// can change. It carries a per-payment ceiling, a daily ceiling, an expiry,
/// a recipient allowlist and an `enabled` flag.
///
/// REVOCATION REACHES APPROVALS ALREADY MINTED. `limits_for` is called by
/// `payment::execute_approved` at execution time and now re-asks the treasury
/// whether the approver is still authorised. An approval signed this morning
/// and revoked at noon does not settle this afternoon. Revocation that only
/// stopped NEW approvals would not be revocation; it would be a pause.
///
/// The legacy path is left standing because a published package may not remove
/// public functions, and it is now inert: `limits_for` refuses any approval
/// whose approver is not authorised in treasury state, and an `ApproverCap`
/// holder is not, unless an admin separately authorised their address.
/// ─────────────────────────────────────────────────────────────────────────
module payflow::approval;

use std::string::String;
use sui::clock::{Self, Clock};
use payflow::limits::{Self, Limits};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};
use payflow::identity::{Self, Company};

const EWrongTreasury: u64 = 600;
const EAboveApproverLimit: u64 = 601;
/// The sender holds no authorisation at all in this treasury's approver state.
const ENotAuthorizedApprover: u64 = 602;
const EExpiryInPast: u64 = 603;
/// The admin has revoked this approver.
const EApproverRevoked: u64 = 604;
/// The authority has lapsed on its own.
const EApproverExpired: u64 = 605;
/// Outside the recipients this approver may authorise payment to.
const ERecipientNotInScope: u64 = 606;
/// Would take the approver past what they may authorise in a day.
const EAboveApproverDailyLimit: u64 = 607;
/// The legacy `ApproverCap` path. Sealed — see `approve`.
const ELegacyApprovalPathSealed: u64 = 608;
/// The company presented is not the one this authorization is bound to.
const EWrongCompany: u64 = 609;
/// The company does not recognise this address as an active member.
const ENotAnActiveMember: u64 = 610;
/// An active member whose role does not carry APPROVE_PAYMENTS.
const EMemberCannotApprove: u64 = 611;
/// The mirrored membership reading is too old to rely on.
const EMembershipReadingStale: u64 = 612;

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

/// SEALED. The legacy `ApproverCap` path, retained only because a published
/// package may not remove a public function.
///
/// WHY IT ABORTS RATHER THAN MERELY BEING INERT. `limits_for` already refuses
/// any approval whose approver holds no treasury authorisation, which stops a
/// bare `ApproverCap` on its own. But an address holding BOTH a cap and a
/// treasury authorisation could still mint through here — and this function
/// never calls `record_approver_authorization`, so those approvals would not
/// consume the day's budget. The per-payment ceiling would still bind at
/// execution; the DAILY ceiling would not.
///
/// That is a narrow hole — it needs an admin to have authorised the same
/// address that holds a cap — and a hole in a limit is not something to leave
/// standing on the strength of it being hard to reach. Sealing the entry point
/// turns "no legacy path can bypass the limits" from a conditional argument
/// into an unconditional one.
///
/// Use `approve_scoped`, which reads authority the treasury can withdraw.
public fun approve(
    _cap: &ApproverCap,
    _invoice_number: String,
    _amount: u64,
    _recipient: address,
    _expires_at_ms: u64,
    _ctx: &mut TxContext,
) {
    abort ELegacyApprovalPathSealed
}

/// Copies the company's verdict on one member into the treasury.
///
/// PERMISSIONLESS, and safe to be. It takes no capability because it grants
/// nothing: it reads the live `Company` and writes exactly what that Company
/// says. A caller can make the treasury agree with the company and cannot make
/// it disagree, so the worst a hostile caller achieves is telling the truth.
///
/// It exists because `limits_for` — whose signature the published package has
/// frozen — sees only `&Treasury` and can never be handed the `Company`.
/// Membership therefore has to be readable from treasury state, and a copy of a
/// mutable fact needs a way to be refreshed. This is that way.
///
/// Anyone may call it, and someone MUST: past
/// `treasury::membership_sync_max_age_ms` the reading is treated as stale and
/// the authorization stops being live until it is refreshed.
public fun sync_membership<T>(
    treasury: &mut Treasury<T>,
    company: &Company,
    approver: address,
    clock: &Clock,
) {
    // The authorization names the company it trusts; another company's word
    // about this person is not evidence about this authorization.
    treasury::assert_approver_company(treasury, approver, object::id(company));

    // Active membership AND the permission the company attaches to it. A member
    // whose role lost APPROVE_PAYMENTS is mirrored as inactive, so the
    // treasury's gate closes without the admin touching the treasury.
    let active =
        identity::is_active_member(company, approver)
            && identity::has_permission(company, approver, identity::perm_approve_payments());

    treasury::set_membership_mirror(treasury, approver, active, clock::timestamp_ms(clock));
}

/// Signs off one payment, under an authority the treasury can withdraw.
///
/// Takes no capability object. The authority is the SENDER's, looked up in
/// treasury state, which is what makes it revocable and what binds it to the
/// zkLogin address rather than to a transferable object someone could pass on.
///
/// TAKES THE COMPANY, and re-reads it. Membership is an upper-level
/// requirement: a treasury authorization is not sufficient while the company
/// has stopped recognising the person holding it. The live `Company` is
/// consulted here, and the reading is mirrored into the treasury so
/// `limits_for` can re-check it at execution — which it cannot do directly,
/// because its signature is frozen and receives no company.
///
/// Every scope is checked here at mint time, and checked again by `limits_for`
/// at execution time, because the two moments are different and both the
/// authority and the membership can be withdrawn in between.
public fun approve_scoped<T>(
    treasury: &mut Treasury<T>,
    company: &Company,
    invoice_number: String,
    amount: u64,
    recipient: address,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock::timestamp_ms(clock);
    let approver = ctx.sender();

    // ---- the upper-level requirement, read from the live Company ----------
    assert!(treasury::has_approver(treasury, approver), ENotAuthorizedApprover);
    treasury::assert_approver_company(treasury, approver, object::id(company));
    assert!(identity::is_active_member(company, approver), ENotAnActiveMember);
    assert!(
        identity::has_permission(company, approver, identity::perm_approve_payments()),
        EMemberCannotApprove,
    );
    // Mirrored now, so the execution-time check has a current reading to read.
    sync_membership(treasury, company, approver, clock);

    // Each condition asked separately, so a refusal says WHICH one failed.
    // `limits_for` uses the combined `approver_can_authorize` because it needs
    // a verdict rather than a reason; here the caller is a person who deserves
    // to be told whether they were revoked, have expired, or simply asked for
    // too much.
    assert!(treasury::approver_enabled(treasury, approver), EApproverRevoked);
    assert!(now <= treasury::approver_expires_at_ms(treasury, approver), EApproverExpired);
    assert!(amount <= treasury::approver_max_single(treasury, approver), EAboveApproverLimit);
    assert!(
        treasury::approver_allows_recipient(treasury, approver, recipient),
        ERecipientNotInScope,
    );
    assert!(
        treasury::approver_authorized_today(treasury, approver, now) + amount
            <= treasury::approver_daily_limit(treasury, approver),
        EAboveApproverDailyLimit,
    );
    // An approval that is already expired authorises nothing and would only
    // sit on chain looking like permission.
    assert!(expires_at_ms > now, EExpiryInPast);

    treasury::record_approver_authorization(treasury, approver, amount, now);

    transfer::share_object(HumanApproval {
        id: object::new(ctx),
        treasury_id: object::id(treasury),
        invoice_number,
        amount,
        recipient,
        approver,
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
    let now = clock::timestamp_ms(clock);

    // The approver's authority is re-checked HERE, at execution, not merely at
    // the moment the approval was minted. Revocation, expiry, a lowered ceiling
    // or a narrowed recipient list all take effect against approvals that are
    // already sitting on chain waiting to be executed.
    //
    // This is also what makes the legacy `ApproverCap` path inert: an approval
    // minted by `approve` names an approver who holds no treasury authorisation,
    // so `can_authorize` is false and the approval is not live.
    //
    // `approver_can_authorize` also asks whether the company still recognises
    // this person — from the mirror, and only while that reading is fresh. A
    // membership revoked after this approval was signed therefore kills it, as
    // does a mirror nobody has refreshed. Both directions fail closed.
    let live =
        !approval.consumed
            && approval.treasury_id == object::id(treasury)
            && now <= approval.expires_at_ms
            && treasury::approver_can_authorize(
                treasury,
                approval.approver,
                approval.amount,
                approval.recipient,
                now,
            );

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
