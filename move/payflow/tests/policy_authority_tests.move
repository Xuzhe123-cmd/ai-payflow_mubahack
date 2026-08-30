/// Who may change the rules.
///
/// The strongest statement here is one no test can make, because it is
/// structural: every policy mutator in `treasury` takes a `&TreasuryOwnerCap`,
/// and the agent holds no such object. There is no call an `AgentCap` can write
/// that reaches `policy::set_*` at all — the code simply does not typecheck, so
/// there is nothing to execute and nothing to assert.
///
/// What CAN be tested at runtime is the adjacent property: holding *a* valid
/// owner capability is not enough. It has to be the capability for the treasury
/// being acted on, otherwise anyone could stand up their own treasury and use
/// its cap to rewrite someone else's policy.
///
/// The compile-time half is covered instead by tests/sui/policySettersGuard.test.ts,
/// which reads these sources and fails if a mutator ever loses its cap argument.
#[test_only]
module payflow::policy_authority_tests;

use sui::test_scenario::{Self as ts, Scenario};
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment;
use payflow::policy;
use payflow::registry::{Self, SupplierRegistry};
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

/// The admin can, of course. Without this the tests below would pass even if
/// the setters were broken outright.
#[test]
fun admin_can_change_policy() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();

        treasury::set_min_reserve(&mut vault, &cap, h::usd(60_000));
        assert!(policy::min_reserve(treasury::policy(&vault)) == h::usd(60_000), 0);

        treasury::set_human_approval_threshold(&mut vault, &cap, h::usd(1_000));
        assert!(
            policy::human_approval_threshold(treasury::policy(&vault)) == h::usd(1_000),
            1,
        );

        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    scenario.end();
}

/// §24 Test 8 — a capability for a different treasury cannot set policy here.
#[test, expected_failure(abort_code = payflow::treasury::EWrongTreasury)]
fun foreign_cap_cannot_change_policy() {
    let mut scenario = h::setup();
    let (home_id, _) = second_treasury(&mut scenario);

    scenario.next_tx(h::attacker_wallet());
    {
        let mut home = ts::take_shared_by_id<Treasury<MOCK_USDC>>(&scenario, home_id);
        let foreign_cap = scenario.take_from_sender<TreasuryOwnerCap>();
        // Perfectly valid capability. Wrong treasury.
        treasury::set_min_reserve(&mut home, &foreign_cap, 0);
        ts::return_shared(home);
        scenario.return_to_sender(foreign_cap);
    };

    scenario.end();
}

/// Nor can it disable someone else's agent — the denial-of-service version of
/// the same attack.
#[test, expected_failure(abort_code = payflow::treasury::EWrongTreasury)]
fun foreign_cap_cannot_revoke_agent() {
    let mut scenario = h::setup();
    let cap_id = h::agent_cap_id(&mut scenario);
    let (home_id, _) = second_treasury(&mut scenario);

    scenario.next_tx(h::attacker_wallet());
    {
        let mut home = ts::take_shared_by_id<Treasury<MOCK_USDC>>(&scenario, home_id);
        let foreign_cap = scenario.take_from_sender<TreasuryOwnerCap>();
        treasury::set_agent_enabled(&mut home, &foreign_cap, cap_id, false);
        ts::return_shared(home);
        scenario.return_to_sender(foreign_cap);
    };

    scenario.end();
}

/// Nor rewrite the supplier register, which is where a redirected wallet would
/// be laundered into legitimacy.
#[test, expected_failure(abort_code = payflow::registry::EWrongTreasury)]
fun foreign_cap_cannot_repoint_supplier_wallet() {
    let mut scenario = h::setup();
    let (_, _) = second_treasury(&mut scenario);

    scenario.next_tx(h::attacker_wallet());
    {
        let mut reg = scenario.take_shared<SupplierRegistry>();
        let foreign_cap = scenario.take_from_sender<TreasuryOwnerCap>();
        registry::set_wallet(
            &mut reg,
            &foreign_cap,
            h::supplier_id(),
            h::attacker_wallet(),
        );
        ts::return_shared(reg);
        scenario.return_to_sender(foreign_cap);
    };

    scenario.end();
}

// --- helpers ------------------------------------------------------------------

/// Stands up a rival treasury and hands its owner capability to the attacker.
/// Returns (home treasury id, rival treasury id).
fun second_treasury(scenario: &mut Scenario): (ID, ID) {
    scenario.next_tx(h::admin());
    let home_id = {
        let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let id = object::id(&vault);
        ts::return_shared(vault);
        id
    };

    scenario.next_tx(h::admin());
    let foreign_id = {
        let cap = treasury::create<MOCK_USDC>(
            h::usd(50_000),
            h::usd(5_000),
            vector[h::usd_currency()],
            h::day_ms(),
            scenario.ctx(),
        );
        let id = treasury::cap_treasury_id(&cap);
        transfer::public_transfer(cap, h::attacker_wallet());
        id
    };

    (home_id, foreign_id)
}
