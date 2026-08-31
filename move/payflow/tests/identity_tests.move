/// Company identity, and the authority it must never acquire.
///
/// Two kinds of test here. The ordinary ones check that membership works:
/// grant, read, revoke, restore. The important ones check the NEGATIVE
/// property this module was designed around — that a membership record grants
/// nothing that can move money, and that revoking one does not pretend to
/// withdraw a capability it never issued.
#[test_only]
module payflow::identity_tests;

use std::string;
use sui::clock;
use sui::test_scenario as ts;
use payflow::identity::{Self, Company, CompanyAdminCap};

const ADMIN: address = @0xA1;
const MEMBER: address = @0xB2;
const STRANGER: address = @0xC3;
/// Stands in for the existing deployed treasury.
const TREASURY: address = @0xDEAD;

fun treasury_id(): ID { object::id_from_address(TREASURY) }

fun manager_permissions(): u16 {
    identity::perm_view_invoices()
        | identity::perm_view_treasury()
        | identity::perm_approve_payments()
        | identity::perm_authorize_agent()
}

#[test]
fun creates_a_company_bound_to_a_treasury() {
    let mut sc = ts::begin(ADMIN);
    {
        identity::create_company_and_keep(
            string::utf8(b"Chain-Doi"),
            treasury_id(),
            sc.ctx(),
        );
    };

    sc.next_tx(ADMIN);
    {
        let company = sc.take_shared<Company>();
        assert!(identity::name(&company) == string::utf8(b"Chain-Doi"), 0);
        assert!(identity::treasury_id(&company) == treasury_id(), 1);
        assert!(identity::admin(&company) == ADMIN, 2);
        assert!(identity::member_count(&company) == 0, 3);
        ts::return_shared(company);
    };
    sc.end();
}

#[test]
fun grants_and_reads_a_treasury_manager_membership() {
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());

        identity::add_member(
            &mut company,
            &cap,
            MEMBER,
            identity::role_treasury_manager(),
            manager_permissions(),
            &c,
        );

        assert!(identity::is_member(&company, MEMBER), 0);
        assert!(identity::is_active_member(&company, MEMBER), 1);
        assert!(identity::role_of(&company, MEMBER) == identity::role_treasury_manager(), 2);
        assert!(identity::member_count(&company) == 1, 3);
        assert!(identity::has_permission(&company, MEMBER, identity::perm_approve_payments()), 4);

        clock::destroy_for_testing(c);
        sc.return_to_sender(cap);
        ts::return_shared(company);
    };
    sc.end();
}

#[test]
fun a_stranger_is_not_a_member_and_holds_nothing() {
    // Authentication is not membership. An address nobody granted anything to
    // has no role, no permission, and no way to acquire one by asking.
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());
        identity::add_member(
            &mut company, &cap, MEMBER, identity::role_treasury_manager(), manager_permissions(), &c,
        );

        assert!(!identity::is_member(&company, STRANGER), 0);
        assert!(!identity::is_active_member(&company, STRANGER), 1);
        assert!(!identity::has_permission(&company, STRANGER, identity::perm_view_invoices()), 2);
        assert!(!identity::has_permission(&company, STRANGER, identity::perm_approve_payments()), 3);

        clock::destroy_for_testing(c);
        sc.return_to_sender(cap);
        ts::return_shared(company);
    };
    sc.end();
}

#[test]
fun revoking_clears_every_permission_but_keeps_the_record() {
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());

        identity::add_member(
            &mut company, &cap, MEMBER, identity::role_treasury_manager(), manager_permissions(), &c,
        );
        identity::revoke_member(&mut company, &cap, MEMBER, &c);

        // The record survives, so the revocation is visible history.
        assert!(identity::is_member(&company, MEMBER), 0);
        assert!(!identity::is_active_member(&company, MEMBER), 1);
        // Every declared permission reads false once inactive.
        assert!(!identity::has_permission(&company, MEMBER, identity::perm_view_invoices()), 2);
        assert!(!identity::has_permission(&company, MEMBER, identity::perm_approve_payments()), 3);

        // Restored, and current again.
        identity::set_role(
            &mut company, &cap, MEMBER, identity::role_viewer(), identity::perm_view_invoices(), true, &c,
        );
        assert!(identity::is_active_member(&company, MEMBER), 4);
        assert!(identity::role_of(&company, MEMBER) == identity::role_viewer(), 5);
        assert!(identity::has_permission(&company, MEMBER, identity::perm_view_invoices()), 6);
        assert!(!identity::has_permission(&company, MEMBER, identity::perm_approve_payments()), 7);

        clock::destroy_for_testing(c);
        sc.return_to_sender(cap);
        ts::return_shared(company);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = payflow::identity::EAlreadyMember)]
fun a_member_cannot_be_added_twice() {
    // A silent overwrite could change a role without leaving a trace.
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());
        identity::add_member(
            &mut company, &cap, MEMBER, identity::role_treasury_manager(), manager_permissions(), &c,
        );
        identity::add_member(
            &mut company, &cap, MEMBER, identity::role_viewer(), identity::perm_view_invoices(), &c,
        );
        abort 0
    }
}

#[test]
#[expected_failure(abort_code = payflow::identity::EUnknownRole)]
fun an_unknown_role_is_refused() {
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());
        identity::add_member(&mut company, &cap, MEMBER, 99, manager_permissions(), &c);
        abort 0
    }
}

#[test]
#[expected_failure(abort_code = payflow::identity::EWrongCompany)]
fun an_admin_cap_for_another_company_is_refused() {
    // Two companies, with the objects paired DELIBERATELY crossed: company B
    // administered with company A's capability. Taking "a company" and "a cap"
    // and hoping they disagree does not test anything — the scenario hands
    // back a matching pair.
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    // Capture A's capability id while it is the only one in existence.
    sc.next_tx(ADMIN);
    let cap_a_id = {
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let id = object::id(&cap);
        sc.return_to_sender(cap);
        id
    };

    sc.next_tx(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Other Co"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        // The most recently shared Company is B.
        let b_id = ts::most_recent_id_shared<Company>().extract();
        let mut company_b = sc.take_shared_by_id<Company>(b_id);
        let cap_a = sc.take_from_sender_by_id<CompanyAdminCap>(cap_a_id);
        let c = clock::create_for_testing(sc.ctx());

        assert!(identity::cap_company_id(&cap_a) != b_id, 0);

        identity::add_member(
            &mut company_b, &cap_a, MEMBER, identity::role_treasury_manager(), manager_permissions(), &c,
        );
        abort 0
    }
}

#[test]
fun permission_bits_are_independent() {
    // A member granted only viewing must not read as an approver.
    let mut sc = ts::begin(ADMIN);
    { identity::create_company_and_keep(string::utf8(b"Chain-Doi"), treasury_id(), sc.ctx()); };

    sc.next_tx(ADMIN);
    {
        let mut company = sc.take_shared<Company>();
        let cap = sc.take_from_sender<CompanyAdminCap>();
        let c = clock::create_for_testing(sc.ctx());

        identity::add_member(
            &mut company, &cap, MEMBER, identity::role_viewer(),
            identity::perm_view_invoices() | identity::perm_view_treasury(), &c,
        );

        assert!(identity::has_permission(&company, MEMBER, identity::perm_view_invoices()), 0);
        assert!(identity::has_permission(&company, MEMBER, identity::perm_view_treasury()), 1);
        assert!(!identity::has_permission(&company, MEMBER, identity::perm_approve_payments()), 2);
        assert!(!identity::has_permission(&company, MEMBER, identity::perm_authorize_agent()), 3);

        clock::destroy_for_testing(c);
        sc.return_to_sender(cap);
        ts::return_shared(company);
    };
    sc.end();
}
