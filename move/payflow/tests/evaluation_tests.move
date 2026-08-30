/// The contract between `evaluate` and `execute_payment`.
///
/// These are the tests that keep the interface honest. The UI renders whatever
/// `evaluate` returns, so if its vector ever changed length, changed order, or
/// disagreed with what execution actually enforces, the "Sui safety check"
/// panel would be showing a story rather than a verdict.
#[test_only]
module payflow::evaluation_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use payflow::agent::{Self, AgentCap};
use payflow::invoice::Invoice;
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment;
use payflow::registry::{Self, SupplierRegistry};
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

/// Ten results, in code order, every time. The interface indexes this.
#[test]
fun evaluate_returns_ten_checks_in_order() {
    let mut scenario = h::setup();
    let ev = evaluate_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet());

    assert!(payment::check_count(&ev) == payment::expected_check_count(), 0);
    assert!(payment::check_count(&ev) == 10, 1);

    let mut i = 0;
    while (i < 10) {
        let result = payment::check_at(&ev, i);
        // Position i holds code i+1 — that is what makes the abort code and the
        // check code the same number.
        assert!(payment::result_code(result) == ((i + 1) as u8), 2);
        i = i + 1;
    };

    scenario.end();
}

/// A clean payment passes all ten and reports no violation.
#[test]
fun clean_payment_passes_every_check() {
    let mut scenario = h::setup();
    let ev = evaluate_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet());

    assert!(payment::approved(&ev), 0);
    assert!(payment::first_violation(&ev) == 0, 1);

    let mut i = 0;
    while (i < 10) {
        assert!(payment::result_passed(payment::check_at(&ev, i)), 2);
        i = i + 1;
    };

    scenario.end();
}

/// The security demonstration, seen through `evaluate` rather than an abort:
/// nine checks pass and exactly one fails, which is what lets the interface
/// show the whole enforcement pass instead of only the failure.
#[test]
fun over_cap_reports_nine_passes_and_one_failure() {
    let mut scenario = h::setup();
    let ev = evaluate_fixture(&mut scenario, h::usd(8_000), h::supplier_wallet());

    assert!(!payment::approved(&ev), 0);
    assert!(payment::first_violation(&ev) == 5, 1);

    let mut passes = 0u64;
    let mut failures = 0u64;
    let mut i = 0;
    while (i < 10) {
        if (payment::result_passed(payment::check_at(&ev, i))) {
            passes = passes + 1;
        } else {
            failures = failures + 1;
        };
        i = i + 1;
    };
    assert!(passes == 9, 2);
    assert!(failures == 1, 3);

    // And the numbers a judge will read off the screen.
    let capped = payment::check_at(&ev, 4);
    assert!(payment::result_limit(capped) == h::usd(5_000), 4);
    assert!(payment::result_actual(capped) == h::usd(8_000), 5);

    scenario.end();
}

/// `first_violation` is the FIRST failure in order, not an arbitrary one. A
/// payment that is wrong in several ways reports the earliest check.
#[test]
fun first_violation_is_the_earliest_failing_check() {
    let mut scenario = h::setup();

    // Revoke the supplier (check 3) AND overpay (check 5) AND misdirect
    // (check 4). The supplier check comes first.
    scenario.next_tx(h::admin());
    {
        let mut reg = scenario.take_shared<SupplierRegistry>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        registry::set_status(&mut reg, &cap, h::supplier_id(), registry::status_revoked());
        ts::return_shared(reg);
        scenario.return_to_sender(cap);
    };

    let ev = evaluate_fixture(&mut scenario, h::usd(8_000), h::attacker_wallet());
    assert!(payment::first_violation(&ev) == 3, 0);

    scenario.end();
}

/// `evaluate` is a read. Seeing `approved: true` grants a caller nothing, which
/// is why exposing it to the whole world is safe.
#[test]
fun evaluate_moves_no_money() {
    let mut scenario = h::setup();

    let before = vault_value(&mut scenario);
    let ev = evaluate_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet());
    assert!(payment::approved(&ev), 0);
    let after = vault_value(&mut scenario);

    assert!(before == after, 1);
    assert!(after == h::usd(100_000), 2);

    scenario.end();
}

/// A capability issued on ANOTHER treasury reports a failed check 1 rather than
/// aborting. This matters twice over: it is the cross-treasury attack, and it
/// is the one case where an abort would leave the interface with nothing at all
/// to explain to the user.
#[test]
fun foreign_capability_reports_unauthorized_rather_than_aborting() {
    let mut scenario = h::setup();

    // Remember the real treasury before a second one makes take_shared
    // ambiguous.
    scenario.next_tx(h::admin());
    let home_id = {
        let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let id = object::id(&vault);
        ts::return_shared(vault);
        id
    };

    // A rival treasury, and an agent legitimately registered on IT.
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

    scenario.next_tx(h::attacker_wallet());
    {
        let mut foreign = ts::take_shared_by_id<Treasury<MOCK_USDC>>(&scenario, foreign_id);
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        agent::issue_to(
            &mut foreign,
            &cap,
            string::utf8(b"agent_intruder"),
            h::usd(5_000),
            h::usd(20_000),
            h::attacker_wallet(),
            scenario.ctx(),
        );
        ts::return_shared(foreign);
        scenario.return_to_sender(cap);
    };

    // Now point that perfectly valid capability at the treasury it has no
    // business touching.
    scenario.next_tx(h::attacker_wallet());
    {
        let home = ts::take_shared_by_id<Treasury<MOCK_USDC>>(&scenario, home_id);
        let reg = scenario.take_shared<SupplierRegistry>();
        let inv = scenario.take_shared<Invoice>();
        let cap = scenario.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut scenario, h::now_ms());

        let lim = agent::limits_for(&home, &cap, &clock);
        let ev = payment::evaluate(
            &home,
            &lim,
            &reg,
            &inv,
            h::usd(3_000),
            h::supplier_wallet(),
            h::now_ms(),
            h::now_ms() + h::day_ms(),
            &clock,
        );

        // Reported, not thrown — and the limits come back zeroed rather than
        // borrowed from the treasury the agent does belong to.
        assert!(!payment::approved(&ev), 0);
        assert!(payment::first_violation(&ev) == 1, 1);
        assert!(payment::result_limit(payment::check_at(&ev, 4)) == 0, 2);

        h::destroy_clock(clock);
        scenario.return_to_sender(cap);
        ts::return_shared(home);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };

    scenario.end();
}

// --- helpers ------------------------------------------------------------------

fun evaluate_fixture(
    scenario: &mut Scenario,
    amount: u64,
    recipient: address,
): payment::PaymentEvaluation {
    scenario.next_tx(h::agent_addr());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let inv = scenario.take_shared<Invoice>();
    let cap = scenario.take_from_sender<AgentCap>();
    let clock = h::new_clock(scenario, h::now_ms());

    let lim = agent::limits_for(&vault, &cap, &clock);
    let ev = payment::evaluate(
        &vault,
        &lim,
        &reg,
        &inv,
        amount,
        recipient,
        h::now_ms(),
        h::now_ms() + h::day_ms(),
        &clock,
    );

    h::destroy_clock(clock);
    scenario.return_to_sender(cap);
    ts::return_shared(vault);
    ts::return_shared(reg);
    ts::return_shared(inv);
    ev
}

fun vault_value(scenario: &mut Scenario): u64 {
    scenario.next_tx(h::admin());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let value = treasury::vault_value(&vault);
    ts::return_shared(vault);
    value
}
