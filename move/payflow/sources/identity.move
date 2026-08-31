/// Company identity and membership.
///
/// WHAT THIS MODULE IS FOR. Every other module here answers "may this payment
/// happen". This one answers a question none of them ask: "who is this human,
/// and what does the company say they are". A zkLogin address arriving at the
/// interface is just an address; this is where it becomes a named member of a
/// named company with a stated role.
///
/// WHAT THIS MODULE DELIBERATELY CANNOT DO — and the restraint is the design:
///
///   - it moves no money and holds no balance
///   - it takes no `Treasury`, no `AgentCap`, no `ApproverCap`
///   - nothing in `payment`, `escrow`, `approval` or `policy` reads it
///
/// So a membership record grants no spending authority whatsoever. It records
/// what the company DECLARES about a person. The chain's answer to "may this
/// payment happen" is unchanged and still lives entirely in `payment::evaluate`
/// and the capability each caller holds.
///
/// THE HONEST CONSEQUENCE, stated here because a reader deserves it in the
/// source and not only in a UI string: `PERMISSION_APPROVE_PAYMENTS` below is a
/// company-policy declaration. It is NOT a payment capability. Approving a
/// payment on chain requires an `ApproverCap`, `approval::approve` demands one,
/// and this module never issues one. Setting `active = false` therefore revokes
/// a declaration and nothing else — it cannot withdraw a capability, because
/// none was granted through here.
///
/// A later phase will rework `approval` along the `AgentCap` pattern, where
/// authority lives in admin-controlled treasury state keyed by capability id
/// and is therefore revocable. Only then can APPROVE_PAYMENTS become a real,
/// withdrawable on-chain authorization. Until it does, this module says so.
module payflow::identity;

use std::string::String;
use sui::table::{Self, Table};
use sui::clock::{Self, Clock};

const EAlreadyMember: u64 = 701;
const ENotMember: u64 = 702;
const EWrongCompany: u64 = 703;
const EUnknownRole: u64 = 704;

// --- Roles -------------------------------------------------------------------
// Numbered rather than named so the set can grow without a package upgrade
// changing an existing value. The interface maps these to labels.

const ROLE_ADMIN: u8 = 1;
const ROLE_TREASURY_MANAGER: u8 = 2;
const ROLE_APPROVER: u8 = 3;
const ROLE_VIEWER: u8 = 4;

public fun role_admin(): u8 { ROLE_ADMIN }
public fun role_treasury_manager(): u8 { ROLE_TREASURY_MANAGER }
public fun role_approver(): u8 { ROLE_APPROVER }
public fun role_viewer(): u8 { ROLE_VIEWER }

// --- Permissions -------------------------------------------------------------
// A bitmask, so a membership carries its whole permission set in one field and
// a new permission costs a bit rather than a struct change.
//
// READ THE MODULE HEADER BEFORE ASSUMING WHAT THESE ENFORCE. They are company
// declarations. No function in this package consults them before moving money,
// and none is intended to.

const PERM_VIEW_INVOICES: u16 = 1;
const PERM_VIEW_TREASURY: u16 = 2;
const PERM_APPROVE_PAYMENTS: u16 = 4;
const PERM_AUTHORIZE_AGENT: u16 = 8;

public fun perm_view_invoices(): u16 { PERM_VIEW_INVOICES }
public fun perm_view_treasury(): u16 { PERM_VIEW_TREASURY }
public fun perm_approve_payments(): u16 { PERM_APPROVE_PAYMENTS }
public fun perm_authorize_agent(): u16 { PERM_AUTHORIZE_AGENT }

// --- Objects -----------------------------------------------------------------

/// One company. Shared, so any member's session can read its own membership
/// without the admin having to hand anything over.
public struct Company has key {
    id: UID,
    name: String,
    /// The treasury this company operates. Recorded so a reader can confirm
    /// the company and the money belong together; this module never touches
    /// the treasury itself.
    treasury_id: ID,
    admin: address,
    /// zkLogin address -> membership. The address is the key because it is the
    /// only identifier both the chain and the login flow agree on. No email,
    /// no name, no Google subject: none of them belong on chain, and none of
    /// them could be checked by anyone reading this object.
    members: Table<address, Membership>,
    member_count: u64,
}

/// What the company declares about one member.
public struct Membership has store {
    role: u8,
    permissions: u16,
    /// False once revoked. The record is KEPT rather than deleted, so a
    /// revocation is visible history instead of an absence someone has to
    /// infer.
    active: bool,
    granted_at_ms: u64,
    revoked_at_ms: u64,
}

/// The sole key to membership changes. Owned, never shared.
public struct CompanyAdminCap has key, store {
    id: UID,
    company_id: ID,
}

// --- Events ------------------------------------------------------------------

public struct CompanyCreated has copy, drop {
    company_id: ID,
    name: String,
    treasury_id: ID,
    admin: address,
}

public struct MemberGranted has copy, drop {
    company_id: ID,
    member: address,
    role: u8,
    permissions: u16,
    granted_at_ms: u64,
}

public struct MemberRevoked has copy, drop {
    company_id: ID,
    member: address,
    revoked_at_ms: u64,
}

// --- Construction ------------------------------------------------------------

/// Creates the company and returns its admin capability to the caller.
///
/// Takes no treasury capability on purpose. Recording which treasury a company
/// operates is a statement about that company, not a change to the treasury,
/// and requiring the `TreasuryOwnerCap` here would imply this module can do
/// something to the treasury. It cannot.
public fun create_company(
    name: String,
    treasury_id: ID,
    ctx: &mut TxContext,
): CompanyAdminCap {
    let company = Company {
        id: object::new(ctx),
        name,
        treasury_id,
        admin: ctx.sender(),
        members: table::new(ctx),
        member_count: 0,
    };
    let company_id = object::id(&company);

    sui::event::emit(CompanyCreated {
        company_id,
        name: company.name,
        treasury_id,
        admin: company.admin,
    });

    transfer::share_object(company);
    CompanyAdminCap { id: object::new(ctx), company_id }
}

#[allow(lint(self_transfer))]
public fun create_company_and_keep(
    name: String,
    treasury_id: ID,
    ctx: &mut TxContext,
) {
    let cap = create_company(name, treasury_id, ctx);
    transfer::public_transfer(cap, ctx.sender());
}

// --- Membership --------------------------------------------------------------

/// Authorization is possession of the capability, bound to THIS company.
///
/// `company.admin` is recorded for a reader's benefit and deliberately not
/// checked here: the cap is transferable, so the address that created the
/// company is history rather than a live permission. Checking it would make
/// handing administration to someone else impossible without also making the
/// record wrong.
fun assert_admin(company: &Company, cap: &CompanyAdminCap) {
    assert!(cap.company_id == object::id(company), EWrongCompany);
}

fun assert_known_role(role: u8) {
    assert!(
        role == ROLE_ADMIN
            || role == ROLE_TREASURY_MANAGER
            || role == ROLE_APPROVER
            || role == ROLE_VIEWER,
        EUnknownRole,
    );
}

/// Adds a member. The address is a zkLogin-derived Sui address.
///
/// Aborts rather than overwriting if the address is already a member: a silent
/// overwrite could change someone's role without leaving a trace, and the
/// caller who meant to do that should say so through `set_role`.
public fun add_member(
    company: &mut Company,
    cap: &CompanyAdminCap,
    member: address,
    role: u8,
    permissions: u16,
    clock: &Clock,
) {
    assert_admin(company, cap);
    assert_known_role(role);
    assert!(!table::contains(&company.members, member), EAlreadyMember);

    let now = clock::timestamp_ms(clock);
    let company_id = object::id(company);
    table::add(
        &mut company.members,
        member,
        Membership {
            role,
            permissions,
            active: true,
            granted_at_ms: now,
            revoked_at_ms: 0,
        },
    );
    company.member_count = company.member_count + 1;

    sui::event::emit(MemberGranted {
        company_id,
        member,
        role,
        permissions,
        granted_at_ms: now,
    });
}

/// Revokes a membership.
///
/// Flips a flag; the record stays. Note what this does NOT do: it withdraws no
/// capability, because this module issues none. If a later phase gives a member
/// a real payment capability, revoking here will not take it back — that will
/// need the capability's own revocation path.
public fun revoke_member(
    company: &mut Company,
    cap: &CompanyAdminCap,
    member: address,
    clock: &Clock,
) {
    assert_admin(company, cap);
    assert!(table::contains(&company.members, member), ENotMember);

    // Read the id before borrowing the table mutably: `object::id` needs an
    // immutable borrow of the whole object, which the entry borrow forbids.
    let company_id = object::id(company);
    let now = clock::timestamp_ms(clock);

    let entry = table::borrow_mut(&mut company.members, member);
    entry.active = false;
    entry.revoked_at_ms = now;

    sui::event::emit(MemberRevoked { company_id, member, revoked_at_ms: now });
}

/// Restores a revoked membership, or changes a role and permission set.
public fun set_role(
    company: &mut Company,
    cap: &CompanyAdminCap,
    member: address,
    role: u8,
    permissions: u16,
    active: bool,
    clock: &Clock,
) {
    assert_admin(company, cap);
    assert_known_role(role);
    assert!(table::contains(&company.members, member), ENotMember);

    let entry = table::borrow_mut(&mut company.members, member);
    entry.role = role;
    entry.permissions = permissions;
    entry.active = active;
    if (active) {
        entry.granted_at_ms = clock::timestamp_ms(clock);
        entry.revoked_at_ms = 0;
    } else {
        entry.revoked_at_ms = clock::timestamp_ms(clock);
    }
}

// --- Reads -------------------------------------------------------------------

/// Which company an admin capability administers.
///
/// Lets a caller confirm a cap matches the company it is about to be used on
/// before submitting, rather than discovering the mismatch as an abort.
public fun cap_company_id(cap: &CompanyAdminCap): ID { cap.company_id }

public fun name(company: &Company): String { company.name }

public fun treasury_id(company: &Company): ID { company.treasury_id }

public fun admin(company: &Company): address { company.admin }

public fun member_count(company: &Company): u64 { company.member_count }

public fun is_member(company: &Company, who: address): bool {
    table::contains(&company.members, who)
}

/// True only for a member whose record is active. The single question a
/// caller should ask; widening it to `is_member` would treat a revoked
/// membership as a current one.
public fun is_active_member(company: &Company, who: address): bool {
    table::contains(&company.members, who) && table::borrow(&company.members, who).active
}

public fun role_of(company: &Company, who: address): u8 {
    assert!(table::contains(&company.members, who), ENotMember);
    table::borrow(&company.members, who).role
}

public fun permissions_of(company: &Company, who: address): u16 {
    assert!(table::contains(&company.members, who), ENotMember);
    table::borrow(&company.members, who).permissions
}

public fun granted_at_ms(company: &Company, who: address): u64 {
    assert!(table::contains(&company.members, who), ENotMember);
    table::borrow(&company.members, who).granted_at_ms
}

/// Whether a member holds a declared permission.
///
/// A COMPANY DECLARATION, not an authorization to spend. Nothing in the
/// payment path calls this, and nothing should start: a permission bit that
/// gated a transfer would be a second, weaker approval mechanism sitting
/// beside `ApproverCap`, which is exactly what this design refuses to build.
public fun has_permission(company: &Company, who: address, permission: u16): bool {
    if (!is_active_member(company, who)) return false;
    let entry = table::borrow(&company.members, who);
    (entry.permissions & permission) == permission
}
