/// Scoped, revocable human payment authority.
///
/// WHAT THIS REPLACES. `ApproverCap` carried its own `max_single`, and only an
/// object's owner may mutate an object — so once issued it could never be
/// lowered and never withdrawn. The one on testnet authorises $25,000,000
/// against an $88,200 vault, and no function in the package can take it back.
///
/// The tests below are mostly NEGATIVE, because the value of this design is
/// entirely in what it refuses. A limit that cannot be exceeded, an expiry that
/// arrives, a revocation that lands — each is asserted, and each is asserted at
/// BOTH moments that matter: when an approval is minted, and again when it is
/// executed. Revocation that only stopped new approvals would be a pause.
#[test_only]
module payflow::approver_authorization_tests;

use std::string;
use sui::test_scenario as ts;
use payflow::approval;
use payflow::invoice::Invoice;
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment;
use payflow::registry::SupplierRegistry;
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};
use payflow::identity::Company;

const MONTH_MS: u64 = 30 * 86_400_000;

/// Authorises the approver with the given ceiling and scope.
fun grant(
    sc: &mut ts::Scenario,
    max_single: u64,
    daily_limit: u64,
    expires_at_ms: u64,
    allowed: vector<address>,
) {
    // Membership is the upper-level requirement; the treasury authorization is
    // bound to the company that grants it.
    let company_id = h::setup_company(sc);
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::init_approvers(&mut vault, &cap);
    treasury::authorize_approver(
        &mut vault,
        &cap,
        h::approver(),
        max_single,
        daily_limit,
        expires_at_ms,
        allowed,
        company_id,
        h::now_ms(),
    );
    ts::return_shared(vault);
    sc.return_to_sender(cap);
}

fun grant_default(sc: &mut ts::Scenario) {
    grant(sc, h::usd(25_000), h::usd(50_000), h::now_ms() + MONTH_MS, vector[]);
}

/// Mints an approval as the approver, at `at_ms`.
fun approve_at(sc: &mut ts::Scenario, amount: u64, recipient: address, at_ms: u64) {
    sc.next_tx(h::approver());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let company = sc.take_shared<Company>();
    let clock = h::new_clock(sc, at_ms);
    approval::approve_scoped(
        &mut vault,
        &company,
        h::invoice_number(),
        amount,
        recipient,
        at_ms + h::day_ms(),
        &clock,
        sc.ctx(),
    );
    h::destroy_clock(clock);
    ts::return_shared(company);
    ts::return_shared(vault);
}

/// Refreshes the treasury's mirror of the company's verdict. Permissionless.
fun sync(sc: &mut ts::Scenario, at_ms: u64) {
    sc.next_tx(h::approver());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let company = sc.take_shared<Company>();
    let clock = h::new_clock(sc, at_ms);
    approval::sync_membership(&mut vault, &company, h::approver(), &clock);
    h::destroy_clock(clock);
    ts::return_shared(company);
    ts::return_shared(vault);
}

/// Whether `limits_for` still reports the pending approval as live.
fun approval_live(sc: &mut ts::Scenario, at_ms: u64): bool {
    sc.next_tx(h::approver());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let appr = sc.take_shared<approval::HumanApproval>();
    let clock = h::new_clock(sc, at_ms);
    let live = payflow::limits::enabled(&approval::limits_for(&vault, &appr, &clock));
    h::destroy_clock(clock);
    ts::return_shared(appr);
    ts::return_shared(vault);
    live
}

fun revoke(sc: &mut ts::Scenario) {
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::set_approver_enabled(&mut vault, &cap, h::approver(), false);
    ts::return_shared(vault);
    sc.return_to_sender(cap);
}

// --- the authority exists and is bounded -------------------------------------

#[test]
fun an_authorized_approver_may_sign_within_their_ceiling() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());
    sc.end();
}

#[test]
fun the_authority_is_recorded_where_the_admin_can_reach_it() {
    // The whole point of the design: every figure lives in treasury state, not
    // inside an object the holder owns.
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(50_000), h::now_ms() + MONTH_MS, vector[]);

    sc.next_tx(h::admin());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        assert!(treasury::approvers_ready(&vault), 0);
        assert!(treasury::has_approver(&vault, h::approver()), 1);
        assert!(treasury::approver_enabled(&vault, h::approver()), 2);
        assert!(treasury::approver_max_single(&vault, h::approver()) == h::usd(25_000), 3);
        assert!(treasury::approver_daily_limit(&vault, h::approver()) == h::usd(50_000), 4);
        assert!(treasury::approver_expires_at_ms(&vault, h::approver()) > h::now_ms(), 5);
        ts::return_shared(vault);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = payflow::approval::EAboveApproverLimit)]
fun an_amount_above_the_ceiling_is_refused() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(25_001), h::supplier_wallet(), h::now_ms());
    abort 0
}

#[test]
#[expected_failure(abort_code = payflow::approval::EAboveApproverDailyLimit)]
fun the_daily_ceiling_is_enforced_across_several_approvals() {
    // Two signatures inside the per-payment limit that together exceed the day.
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(30_000), h::now_ms() + MONTH_MS, vector[]);
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());
    abort 0
}

#[test]
fun the_daily_ceiling_resets_the_next_day() {
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(30_000), h::now_ms() + MONTH_MS, vector[]);
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());
    // Same amount again, a day later: a new bucket, not a carried-forward one.
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms() + h::day_ms());
    sc.end();
}

// --- expiry ------------------------------------------------------------------

#[test]
#[expected_failure(abort_code = payflow::approval::EApproverExpired)]
fun an_expired_authority_cannot_sign() {
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(50_000), h::now_ms() + h::day_ms(), vector[]);
    // Two days later the grant has lapsed on its own, with no admin action.
    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms() + 2 * h::day_ms());
    abort 0
}

#[test]
#[expected_failure(abort_code = payflow::treasury::EExpiryInPast)]
fun an_authority_cannot_be_granted_already_expired() {
    // A grant born expired is a configuration mistake, and accepting it would
    // leave an admin believing they had granted something.
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(50_000), h::now_ms() - 1, vector[]);
    abort 0
}

// --- revocation --------------------------------------------------------------

#[test]
#[expected_failure(abort_code = payflow::approval::EApproverRevoked)]
fun a_revoked_approver_cannot_sign() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    revoke(&mut sc);
    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    abort 0
}

#[test]
fun revocation_kills_an_approval_already_minted() {
    // THE PROPERTY THE OLD MODEL COULD NOT HAVE. An approval signed before the
    // revocation must not settle after it — otherwise revocation is a pause,
    // not a withdrawal. Asserted through `limits_for`, which is exactly what
    // `payment::execute_approved` consults.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());

    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let appr = sc.take_shared<approval::HumanApproval>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        // Live while the authority stands.
        assert!(payflow::limits::enabled(&approval::limits_for(&vault, &appr, &clock)), 0);
        h::destroy_clock(clock);
        ts::return_shared(appr);
        ts::return_shared(vault);
    };

    revoke(&mut sc);

    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let appr = sc.take_shared<approval::HumanApproval>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        // Dead the moment the admin withdrew it.
        assert!(!payflow::limits::enabled(&approval::limits_for(&vault, &appr, &clock)), 1);
        h::destroy_clock(clock);
        ts::return_shared(appr);
        ts::return_shared(vault);
    };
    sc.end();
}

#[test]
fun a_lowered_ceiling_kills_an_approval_already_minted() {
    // The same reach, through limits rather than the enabled flag.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());

    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        treasury::set_approver_limits(
            &mut vault,
            &cap,
            h::approver(),
            h::usd(5_000),
            h::usd(50_000),
            h::now_ms() + MONTH_MS,
        );
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let appr = sc.take_shared<approval::HumanApproval>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        assert!(!payflow::limits::enabled(&approval::limits_for(&vault, &appr, &clock)), 0);
        h::destroy_clock(clock);
        ts::return_shared(appr);
        ts::return_shared(vault);
    };
    sc.end();
}

#[test]
fun a_revoked_approver_can_be_restored() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    revoke(&mut sc);

    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        treasury::set_approver_enabled(&mut vault, &cap, h::approver(), true);
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    sc.end();
}

// --- scope -------------------------------------------------------------------

#[test]
#[expected_failure(abort_code = payflow::approval::ERecipientNotInScope)]
fun a_recipient_outside_the_allowlist_is_refused() {
    let mut sc = h::setup();
    grant(
        &mut sc,
        h::usd(25_000),
        h::usd(50_000),
        h::now_ms() + MONTH_MS,
        vector[h::supplier_wallet()],
    );
    approve_at(&mut sc, h::usd(1_000), h::attacker_wallet(), h::now_ms());
    abort 0
}

#[test]
fun an_allowlisted_recipient_is_permitted() {
    let mut sc = h::setup();
    grant(
        &mut sc,
        h::usd(25_000),
        h::usd(50_000),
        h::now_ms() + MONTH_MS,
        vector[h::supplier_wallet()],
    );
    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    sc.end();
}

// --- who may sign at all -----------------------------------------------------

#[test]
#[expected_failure(abort_code = payflow::approval::ENotAuthorizedApprover)]
fun an_unauthorized_address_cannot_sign() {
    // Being able to send a transaction is not authority. This is the case a
    // zkLogin member with no approver grant falls into: identity, membership
    // and role are all irrelevant here — only the treasury's own record counts.
    let mut sc = h::setup();
    grant_default(&mut sc);

    sc.next_tx(h::attacker_wallet());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let company = sc.take_shared<Company>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        approval::approve_scoped(
            &mut vault,
            &company,
            h::invoice_number(),
            h::usd(1_000),
            h::supplier_wallet(),
            h::now_ms() + h::day_ms(),
            &clock,
            sc.ctx(),
        );
        abort 0
    }
}

#[test]
#[expected_failure(abort_code = payflow::approval::ENotAuthorizedApprover)]
fun no_authority_exists_before_the_admin_grants_one() {
    // The table is installed and empty. Fail-closed: an empty allowlist
    // authorises nobody rather than everybody.
    //
    // The company DOES recognise this person — active membership, the right
    // role, APPROVE_PAYMENTS declared. None of that is payment authority.
    let mut sc = h::setup();
    h::setup_company(&mut sc);
    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        treasury::init_approvers(&mut vault, &cap);
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    abort 0
}

#[test]
fun an_uninstalled_table_authorises_nobody() {
    // Before the migration has run at all, every read reports no authority —
    // rather than an absent table being mistaken for an open one.
    let mut sc = h::setup();
    sc.next_tx(h::admin());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        assert!(!treasury::approvers_ready(&vault), 0);
        assert!(!treasury::has_approver(&vault, h::approver()), 1);
        assert!(
            !treasury::approver_can_authorize(
                &vault,
                h::approver(),
                h::usd(1),
                h::supplier_wallet(),
                h::now_ms(),
            ),
            2,
        );
        ts::return_shared(vault);
    };
    sc.end();
}

// --- the treasury binding ----------------------------------------------------

#[test]
fun the_approval_is_bound_to_the_treasury_that_authorised_it() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());

    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let appr = sc.take_shared<approval::HumanApproval>();
        assert!(approval::treasury_id(&appr) == object::id(&vault), 0);
        approval::assert_treasury(&appr, &vault);
        ts::return_shared(appr);
        ts::return_shared(vault);
    };
    sc.end();
}

// --- replay ------------------------------------------------------------------

#[test]
fun a_consumed_approval_is_not_live_again() {
    // Uses the fixture invoice the setup already creates, rather than adding a
    // second one under the same number.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(3_000), h::supplier_wallet(), h::now_ms());

    sc.next_tx(h::approver());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let mut appr = sc.take_shared<approval::HumanApproval>();
        let reg = sc.take_shared<SupplierRegistry>();
        let mut inv = sc.take_shared<Invoice>();
        let clock = h::new_clock(&mut sc, h::now_ms());

        payment::execute_approved(
            &mut vault,
            &mut appr,
            &reg,
            &mut inv,
            h::recommendation_id(),
            h::now_ms(),
            h::now_ms() + h::day_ms(),
            &clock,
            sc.ctx(),
        );

        // Consumed, and therefore dead — the same approval cannot fund a second
        // transfer however many times it is presented.
        assert!(approval::consumed(&appr), 0);
        assert!(!payflow::limits::enabled(&approval::limits_for(&vault, &appr, &clock)), 1);

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(appr);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- the legacy path is sealed -----------------------------------------------

#[test]
#[expected_failure(abort_code = payflow::approval::ELegacyApprovalPathSealed)]
fun the_legacy_approver_cap_path_is_sealed() {
    // THE AUDIT QUESTION, ANSWERED AT THE ENTRY POINT. A published package may
    // not remove a public function, so `approve` still exists and still takes
    // the $25,000,000 cap. It mints nothing: an address holding both a cap and
    // a treasury authorisation could otherwise have minted approvals here
    // WITHOUT consuming the day's budget, because this path never called
    // `record_approver_authorization`.
    let mut sc = h::setup();

    sc.next_tx(h::admin());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        approval::issue_approver_to(&vault, &cap, h::usd(25_000_000), h::approver(), sc.ctx());
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    sc.next_tx(h::approver());
    {
        let cap = sc.take_from_sender<approval::ApproverCap>();
        approval::approve(
            &cap,
            h::invoice_number(),
            h::usd(1),
            h::supplier_wallet(),
            h::now_ms() + h::day_ms(),
            sc.ctx(),
        );
        abort 0
    }
}

#[test]
fun a_bare_approver_cap_grants_no_treasury_authority() {
    // Holding the cap does not put an address into the treasury's approver
    // state, which is the only record `limits_for` and `approve_scoped` read.
    let mut sc = h::setup();

    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        approval::issue_approver_to(&vault, &cap, h::usd(25_000_000), h::approver(), sc.ctx());
        treasury::init_approvers(&mut vault, &cap);
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        assert!(!treasury::has_approver(&vault, h::approver()), 0);
        assert!(
            !treasury::approver_can_authorize(
                &vault,
                h::approver(),
                h::usd(1),
                h::supplier_wallet(),
                h::now_ms(),
            ),
            1,
        );
        ts::return_shared(vault);
    };
    sc.end();
}

// --- membership as an UPPER-LEVEL requirement --------------------------------
//
// The property these prove: a treasury authorization is necessary and NOT
// sufficient. The company must still recognise the person holding it, and that
// has to hold at execution as well as at signing.

#[test]
fun an_active_member_with_an_active_authorization_may_sign() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());
    assert!(approval_live(&mut sc, h::now_ms()), 0);
    sc.end();
}

#[test]
#[expected_failure(abort_code = payflow::approval::ENotAnActiveMember)]
fun a_revoked_member_cannot_sign_even_with_a_live_authorization() {
    // The exact gap this phase closes. The treasury authorization is untouched
    // and perfectly valid; the company has stopped recognising the person.
    let mut sc = h::setup();
    grant_default(&mut sc);
    h::revoke_membership(&mut sc);
    approve_at(&mut sc, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    abort 0
}

#[test]
fun revoking_membership_kills_an_approval_already_signed() {
    // THE REQUIREMENT, at execution time rather than signing time. Membership
    // revocation must reach an approval that is already sitting on chain.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());
    assert!(approval_live(&mut sc, h::now_ms()), 0);

    h::revoke_membership(&mut sc);
    // The mirror is refreshed from the live company — permissionless, and it
    // can only copy what the company says.
    sync(&mut sc, h::now_ms());

    assert!(!approval_live(&mut sc, h::now_ms()), 1);
    sc.end();
}

#[test]
fun a_stale_membership_reading_is_not_trusted() {
    // Fail-closed the other way: if nobody refreshes the mirror, the reading
    // ages out and the authorization stops being live. A revocation nobody
    // synced can therefore never be silently ignored for long.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());

    let stale_at = h::now_ms() + treasury::membership_sync_max_age_ms() + 1;
    assert!(!approval_live(&mut sc, stale_at), 0);

    // Refreshed, and live again — the company still recognises this person.
    sync(&mut sc, stale_at);
    assert!(approval_live(&mut sc, stale_at), 1);
    sc.end();
}

#[test]
fun membership_and_authorization_are_revoked_independently() {
    // Requirement 3: the treasury authorization stays separately revocable.
    // Membership ACTIVE, authorization REVOKED -> refused.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());
    assert!(approval_live(&mut sc, h::now_ms()), 0);

    revoke(&mut sc);
    assert!(!approval_live(&mut sc, h::now_ms()), 1);

    // Membership was never touched — the company still recognises them.
    sync(&mut sc, h::now_ms());
    assert!(!approval_live(&mut sc, h::now_ms()), 2);
    sc.end();
}

#[test]
#[expected_failure(abort_code = payflow::treasury::EApproverNotAuthorized)]
fun a_member_with_no_treasury_authorization_cannot_sign() {
    // The other direction: the company says yes and the treasury has never been
    // told. Membership is not payment authority.
    let mut sc = h::setup();
    h::setup_company(&mut sc);

    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        treasury::init_approvers(&mut vault, &cap);
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    sync(&mut sc, h::now_ms());
    abort 0
}

#[test]
#[expected_failure(abort_code = payflow::treasury::EWrongCompany)]
fun another_companys_word_does_not_count() {
    // An authorization bound to Chain-Doi cannot be vouched for by a different
    // company, however active a member this person is there.
    let mut sc = h::setup();
    grant_default(&mut sc);

    sc.next_tx(h::admin());
    {
        payflow::identity::create_company_and_keep(
            std::string::utf8(b"Other Co"),
            object::id_from_address(@0xDEAD),
            sc.ctx(),
        );
    };

    sc.next_tx(h::approver());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        // The most recently shared Company is the impostor.
        let other_id = ts::most_recent_id_shared<Company>().extract();
        let other = sc.take_shared_by_id<Company>(other_id);
        let clock = h::new_clock(&mut sc, h::now_ms());
        approval::sync_membership(&mut vault, &other, h::approver(), &clock);
        abort 0
    }
}

// --- the day's budget is charged ONCE ----------------------------------------
//
// THE BUG THESE HOLD SHUT. `approve_scoped` books the amount against the day at
// MINT time. `approval::limits_for` then re-asked the treasury at EXECUTION
// time, and the question it asked — through `approver_can_authorize` — was the
// mint question: "may this approver authorize `amount` MORE today?" By then the
// amount was already in `authorized_today`, so it was charged twice, and an
// approver who had legitimately minted several approvals inside their daily
// limit could settle none of them.

/// Reads the settle-time verdict without going through a HumanApproval object,
/// so a test with several pending approvals can name the one it means.
fun can_settle(sc: &mut ts::Scenario, amount: u64, at_ms: u64): bool {
    sc.next_tx(h::approver());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let verdict = treasury::approver_can_settle(
        &vault,
        h::approver(),
        amount,
        h::supplier_wallet(),
        at_ms,
    );
    ts::return_shared(vault);
    verdict
}

/// The MINT-time verdict, whose semantics this change deliberately leaves alone.
fun can_authorize_more(sc: &mut ts::Scenario, amount: u64, at_ms: u64): bool {
    sc.next_tx(h::approver());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let verdict = treasury::approver_can_authorize(
        &vault,
        h::approver(),
        amount,
        h::supplier_wallet(),
        at_ms,
    );
    ts::return_shared(vault);
    verdict
}

fun lower_daily_limit(sc: &mut ts::Scenario, daily_limit: u64) {
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::set_approver_limits(
        &mut vault,
        &cap,
        h::approver(),
        h::usd(25_000),
        daily_limit,
        h::now_ms() + MONTH_MS,
    );
    ts::return_shared(vault);
    sc.return_to_sender(cap);
}

#[test]
fun several_approvals_inside_the_day_can_all_be_settled() {
    // $25,000 + $20,000 = $45,000 booked against a $50,000 day. Every one of
    // them was granted legitimately, so every one of them must be spendable.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(25_000), h::supplier_wallet(), h::now_ms());
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());

    assert!(can_settle(&mut sc, h::usd(25_000), h::now_ms()), 0);
    assert!(can_settle(&mut sc, h::usd(20_000), h::now_ms()), 1);
    sc.end();
}

#[test]
fun the_old_mint_question_would_have_refused_them() {
    // The same state, asked the wrong question. $45,000 is already booked, so
    // "may I authorize $20,000 MORE?" is correctly NO — and that is precisely
    // why it was the wrong thing to ask at execution, where the $20,000 had
    // already been paid for.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(25_000), h::supplier_wallet(), h::now_ms());
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());

    assert!(!can_authorize_more(&mut sc, h::usd(20_000), h::now_ms()), 0);
    assert!(can_settle(&mut sc, h::usd(20_000), h::now_ms()), 1);
    sc.end();
}

#[test]
fun a_lone_approval_is_no_longer_charged_against_itself() {
    // One $20,000 approval against a $30,000 day. The old rule evaluated
    // $20,000 + $20,000 = $40,000 and refused it; nothing else had happened.
    let mut sc = h::setup();
    grant(&mut sc, h::usd(25_000), h::usd(30_000), h::now_ms() + MONTH_MS, vector[]);
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());

    assert!(!can_authorize_more(&mut sc, h::usd(20_000), h::now_ms()), 0);
    assert!(can_settle(&mut sc, h::usd(20_000), h::now_ms()), 1);
    // And the approval object itself now reports live, which is what
    // `payment::execute_approved` consults.
    assert!(approval_live(&mut sc, h::now_ms()), 2);
    sc.end();
}

#[test]
fun lowering_the_daily_limit_still_kills_a_pending_approval() {
    // THE PROPERTY THE FIX MUST NOT COST. Settle-time re-checking exists so an
    // admin can withdraw authority AFTER an approval was minted. Dropping the
    // day's ceiling below what has already been booked must still stop it.
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(20_000), h::supplier_wallet(), h::now_ms());
    assert!(can_settle(&mut sc, h::usd(20_000), h::now_ms()), 0);

    lower_daily_limit(&mut sc, h::usd(10_000));
    assert!(!can_settle(&mut sc, h::usd(20_000), h::now_ms()), 1);
    assert!(!approval_live(&mut sc, h::now_ms()), 2);
    sc.end();
}

#[test]
fun settling_still_respects_every_other_scope() {
    // The change touches the daily arithmetic and nothing else. Revocation,
    // expiry, the per-payment ceiling and the recipient allowlist all still
    // refuse through the same function.
    let mut sc = h::setup();
    grant(
        &mut sc,
        h::usd(25_000),
        h::usd(50_000),
        h::now_ms() + MONTH_MS,
        vector[h::supplier_wallet()],
    );
    approve_at(&mut sc, h::usd(4_800), h::supplier_wallet(), h::now_ms());

    // Above the per-payment ceiling.
    assert!(!can_settle(&mut sc, h::usd(30_000), h::now_ms()), 0);
    // Past the expiry.
    assert!(!can_settle(&mut sc, h::usd(4_800), h::now_ms() + 2 * MONTH_MS), 1);

    // Outside the recipient allowlist.
    sc.next_tx(h::approver());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        assert!(
            !treasury::approver_can_settle(
                &vault,
                h::approver(),
                h::usd(4_800),
                h::attacker_wallet(),
                h::now_ms(),
            ),
            2,
        );
        ts::return_shared(vault);
    };

    // And revocation.
    revoke(&mut sc);
    assert!(!can_settle(&mut sc, h::usd(4_800), h::now_ms()), 3);
    sc.end();
}

#[test]
fun the_day_still_rolls_over() {
    let mut sc = h::setup();
    grant_default(&mut sc);
    approve_at(&mut sc, h::usd(25_000), h::supplier_wallet(), h::now_ms());
    // A day later the bucket is stale, so nothing is counted as used at all.
    // The membership mirror has to be refreshed first: a reading that old is
    // not trusted, which is a separate rule and still in force.
    sync(&mut sc, h::now_ms() + h::day_ms());
    assert!(can_settle(&mut sc, h::usd(25_000), h::now_ms() + h::day_ms()), 0);
    sc.end();
}
