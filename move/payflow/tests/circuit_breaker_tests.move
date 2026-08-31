/// The circuit breaker, and the exact shape of what it withdraws.
///
/// The claim under test is narrow and worth stating precisely: HUMAN_ONLY
/// removes the AGENT's authority and leaves every human path intact. A breaker
/// that froze the whole treasury would be easy to write and useless in
/// practice — the business still has to pay people while the automation is
/// contained. So the tests come in pairs: the autonomous path aborts, and the
/// human path settling the SAME invoice still works.
///
/// The other half is recovery. Tripping takes the owner capability; resetting
/// takes the owner capability AND a person the company still vouches for. Every
/// way that second requirement can fail is asserted, because an un-freeze that
/// a revoked operator could perform would make the breaker decorative.
#[test_only]
module payflow::circuit_breaker_tests;

use std::string;
use sui::test_scenario as ts;
use payflow::agent::{Self, AgentCap};
use payflow::approval;
use payflow::identity::Company;
use payflow::invoice::Invoice;
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment;
use payflow::registry::SupplierRegistry;
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const MONTH_MS: u64 = 30 * 86_400_000;

/// Installs the breaker, armed.
fun arm(sc: &mut ts::Scenario) {
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::init_breaker(&mut vault, &cap, sc.ctx());
    ts::return_shared(vault);
    sc.return_to_sender(cap);
}

/// Trips the breaker with a score and a reason code.
fun trip(sc: &mut ts::Scenario, score: u8) {
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::trip_breaker(
        &mut vault,
        &cap,
        score,
        string::utf8(b"PAYMENT_FREQUENCY"),
        h::now_ms(),
        sc.ctx(),
    );
    ts::return_shared(vault);
    sc.return_to_sender(cap);
}

/// Grants the approver a live, membership-verified authorization.
fun grant_approver(sc: &mut ts::Scenario) {
    let company_id = h::setup_company(sc);
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::init_approvers(&mut vault, &cap);
    treasury::authorize_approver(
        &mut vault,
        &cap,
        h::approver(),
        h::usd(25_000),
        h::usd(50_000),
        h::now_ms() + MONTH_MS,
        vector[],
        company_id,
        h::now_ms(),
    );
    ts::return_shared(vault);
    sc.return_to_sender(cap);

    // The membership mirror has to be fresh, exactly as a real approval needs.
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let company = sc.take_shared<Company>();
    let clock = h::new_clock(sc, h::now_ms());
    approval::sync_membership(&mut vault, &company, h::approver(), &clock);
    h::destroy_clock(clock);
    ts::return_shared(company);
    ts::return_shared(vault);
}

/// The agent paying the fixture invoice on its own capability.
fun agent_pays(sc: &mut ts::Scenario) {
    sc.next_tx(h::agent_addr());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let reg = sc.take_shared<SupplierRegistry>();
    let mut inv = sc.take_shared<Invoice>();
    let cap = sc.take_from_sender<AgentCap>();
    let clock = h::new_clock(sc, h::now_ms());

    payment::execute_payment(
        &mut vault,
        &cap,
        &reg,
        &mut inv,
        h::usd(3_000),
        h::supplier_wallet(),
        h::recommendation_id(),
        h::now_ms(),
        h::now_ms() + h::day_ms(),
        &clock,
        sc.ctx(),
    );

    h::destroy_clock(clock);
    sc.return_to_sender(cap);
    ts::return_shared(inv);
    ts::return_shared(reg);
    ts::return_shared(vault);
}

// --- installation ------------------------------------------------------------

#[test]
fun an_uninstalled_breaker_reports_normal_and_changes_nothing() {
    // The upgrade must not freeze a live treasury the moment it lands. Absence
    // permits, and is only reachable before installation because no function
    // removes the field.
    let mut sc = h::setup();
    sc.next_tx(h::admin());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    assert!(!treasury::breaker_ready(&vault), 0);
    assert!(treasury::breaker_mode(&vault) == treasury::mode_normal(), 1);
    assert!(!treasury::breaker_human_only(&vault), 2);
    ts::return_shared(vault);

    // And the autonomous path still works, exactly as before this phase.
    agent_pays(&mut sc);
    sc.end();
}

#[test]
fun installing_the_breaker_arms_it_without_freezing_anything() {
    let mut sc = h::setup();
    arm(&mut sc);

    sc.next_tx(h::admin());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    assert!(treasury::breaker_ready(&vault), 0);
    assert!(treasury::breaker_mode(&vault) == treasury::mode_normal(), 1);
    assert!(treasury::breaker_trip_count(&vault) == 0, 2);
    ts::return_shared(vault);

    agent_pays(&mut sc);
    sc.end();
}

// --- what HUMAN_ONLY withdraws ----------------------------------------------

#[test]
#[expected_failure(abort_code = 115, location = payflow::treasury)]
fun human_only_blocks_the_autonomous_payment() {
    let mut sc = h::setup();
    arm(&mut sc);
    trip(&mut sc, 94);
    agent_pays(&mut sc);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 115, location = payflow::treasury)]
fun human_only_blocks_the_conditional_lock() {
    let mut sc = h::setup();
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::agent_addr());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let reg = sc.take_shared<SupplierRegistry>();
    let mut inv = sc.take_shared<Invoice>();
    let cap = sc.take_from_sender<AgentCap>();
    let clock = h::new_clock(&mut sc, h::now_ms());

    payflow::escrow::execute_conditional(
        &mut vault,
        &cap,
        &reg,
        &mut inv,
        h::usd(3_000),
        h::supplier_wallet(),
        h::recommendation_id(),
        h::now_ms(),
        h::now_ms() + h::day_ms(),
        &clock,
        sc.ctx(),
    );

    h::destroy_clock(clock);
    sc.return_to_sender(cap);
    ts::return_shared(inv);
    ts::return_shared(reg);
    ts::return_shared(vault);
    sc.end();
}

#[test]
fun the_human_path_still_settles_the_same_invoice_while_frozen() {
    // The pair to the two aborts above, and the reason the breaker is usable:
    // containment removes autonomy, not the treasury's ability to pay.
    let mut sc = h::setup();
    grant_approver(&mut sc);
    arm(&mut sc);
    trip(&mut sc, 94);

    // Minting the approval is itself a human path, and it works while frozen.
    sc.next_tx(h::approver());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let company = sc.take_shared<Company>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        approval::approve_scoped(
            &mut vault,
            &company,
            h::invoice_number(),
            h::usd(3_000),
            h::supplier_wallet(),
            h::now_ms() + h::day_ms(),
            &clock,
            sc.ctx(),
        );
        h::destroy_clock(clock);
        ts::return_shared(company);
        ts::return_shared(vault);
    };

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

        // It really settled, while HUMAN_ONLY was active.
        assert!(treasury::payment_count(&vault) == 1, 0);
        assert!(treasury::breaker_human_only(&vault), 1);

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(appr);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- evidence ----------------------------------------------------------------

#[test]
fun the_breaker_records_why_it_tripped() {
    let mut sc = h::setup();
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::admin());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    assert!(treasury::breaker_human_only(&vault), 0);
    assert!(treasury::breaker_score(&vault) == 94, 1);
    assert!(treasury::breaker_reason(&vault) == string::utf8(b"PAYMENT_FREQUENCY"), 2);
    assert!(treasury::breaker_tripped_at_ms(&vault) == h::now_ms(), 3);
    assert!(treasury::breaker_trip_count(&vault) == 1, 4);
    ts::return_shared(vault);
    sc.end();
}

#[test]
fun tripping_twice_does_not_inflate_the_trip_count() {
    let mut sc = h::setup();
    arm(&mut sc);
    trip(&mut sc, 91);
    trip(&mut sc, 96);

    sc.next_tx(h::admin());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    // Still one freeze; the newer evidence overwrote the older.
    assert!(treasury::breaker_trip_count(&vault) == 1, 0);
    assert!(treasury::breaker_score(&vault) == 96, 1);
    ts::return_shared(vault);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 116, location = payflow::treasury)]
fun tripping_an_uninstalled_breaker_is_refused() {
    let mut sc = h::setup();
    trip(&mut sc, 94);
    sc.end();
}

// --- recovery ----------------------------------------------------------------

#[test]
fun recovery_restores_autonomy_when_a_vouched_human_signs_off() {
    let mut sc = h::setup();
    grant_approver(&mut sc);
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::reset_breaker(&mut vault, &cap, h::approver(), h::now_ms());
    assert!(!treasury::breaker_human_only(&vault), 0);
    // The history is kept. Recovery is not amnesia.
    assert!(treasury::breaker_trip_count(&vault) == 1, 1);
    ts::return_shared(vault);
    sc.return_to_sender(cap);

    // And autonomy is genuinely back.
    agent_pays(&mut sc);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 117, location = payflow::treasury)]
fun recovery_refuses_an_address_with_no_authorization() {
    // The owner capability alone is not enough. This is what stops a
    // compromised server key from simply un-freezing what it froze.
    let mut sc = h::setup();
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::reset_breaker(&mut vault, &cap, h::attacker_wallet(), h::now_ms());
    ts::return_shared(vault);
    sc.return_to_sender(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 117, location = payflow::treasury)]
fun recovery_refuses_a_revoked_member() {
    let mut sc = h::setup();
    grant_approver(&mut sc);
    arm(&mut sc);
    trip(&mut sc, 94);

    // The company withdraws recognition, and the mirror is refreshed so the
    // treasury knows about it.
    h::revoke_membership(&mut sc);
    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let company = sc.take_shared<Company>();
    let clock = h::new_clock(&mut sc, h::now_ms());
    approval::sync_membership(&mut vault, &company, h::approver(), &clock);
    h::destroy_clock(clock);
    ts::return_shared(company);
    ts::return_shared(vault);

    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    treasury::reset_breaker(&mut vault, &cap, h::approver(), h::now_ms());
    ts::return_shared(vault);
    sc.return_to_sender(cap);
    sc.end();
}

#[test]
#[expected_failure(abort_code = 117, location = payflow::treasury)]
fun recovery_refuses_a_stale_membership_reading() {
    // The one-hour freshness rule applies to recovery too. An operator whose
    // standing cannot be confirmed right now cannot un-freeze a treasury.
    let mut sc = h::setup();
    grant_approver(&mut sc);
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::admin());
    let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    // Two hours later, with no re-sync in between.
    treasury::reset_breaker(&mut vault, &cap, h::approver(), h::now_ms() + 2 * 3_600_000);
    ts::return_shared(vault);
    sc.return_to_sender(cap);
    sc.end();
}

// --- Phase 1 is untouched ----------------------------------------------------

#[test]
fun the_breaker_does_not_change_the_approver_limits() {
    let mut sc = h::setup();
    grant_approver(&mut sc);
    arm(&mut sc);
    trip(&mut sc, 94);

    sc.next_tx(h::admin());
    let vault = sc.take_shared<Treasury<MOCK_USDC>>();
    // $25,000 still authorizes, $25,001 still does not — the breaker withdrew
    // autonomy, not the human ceiling.
    assert!(
        treasury::approver_can_authorize(
            &vault,
            h::approver(),
            h::usd(25_000),
            h::supplier_wallet(),
            h::now_ms(),
        ),
        0,
    );
    assert!(
        !treasury::approver_can_authorize(
            &vault,
            h::approver(),
            h::usd(25_001),
            h::supplier_wallet(),
            h::now_ms(),
        ),
        1,
    );
    ts::return_shared(vault);
    sc.end();
}
