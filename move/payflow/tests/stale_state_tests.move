/// A scheduled payment is revalidated at execution.
///
/// This is Demo C, and Invariants 5 and 6. The AI recommends a date; days pass;
/// the treasury changes underneath the recommendation. What must NOT happen is
/// the payment executing on the strength of an assessment that was true when it
/// was made and is not true any more.
///
/// `execute_scheduled` reads only the amount, the recipient and the timestamps
/// off the request. It reads no verdict, and nothing in the ten checks consults
/// the fact that the request was once considered sound.
#[test_only]
module payflow::stale_state_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use payflow::agent::AgentCap;
use payflow::invoice::Invoice;
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment::{Self, PaymentRequest};
use payflow::registry::{Self, SupplierRegistry};
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

/// The control: nothing changes between recommendation and execution, and the
/// scheduled payment settles.
#[test]
fun scheduled_payment_executes_when_state_is_unchanged() {
    let mut scenario = h::setup();
    let id = schedule_30k(&mut scenario);

    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());

    scenario.next_tx(h::admin());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let req = scenario.take_shared<PaymentRequest>();
    assert!(treasury::vault_value(&vault) == h::usd(70_000), 0);
    assert!(payment::request_status(&req) == payment::request_executed(), 1);
    ts::return_shared(vault);
    ts::return_shared(req);

    scenario.end();
}

/// Demo C. $100,000 treasury, $50,000 floor, $30,000 scheduled — sound when it
/// was recommended. Then an unexpected $40,000 goes out, and the same payment
/// would now leave $30,000 against a $50,000 reserve.
///
/// The old recommendation does not get to override the current state.
#[test, expected_failure(abort_code = payflow::payment::EInsufficientReserve)]
fun stale_recommendation_rejected_when_reserve_would_break() {
    let mut scenario = h::setup();
    let id = schedule_30k(&mut scenario);

    // The unexpected outflow.
    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        let drained = treasury::withdraw(&mut vault, &cap, h::usd(40_000), scenario.ctx());
        transfer::public_transfer(drained, h::admin());
        assert!(treasury::vault_value(&vault) == h::usd(60_000), 0);
        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());
    scenario.end();
}

/// The supplier is revoked after the recommendation. Same principle, different
/// check — revalidation is not special-cased to liquidity.
#[test, expected_failure(abort_code = payflow::payment::ESupplierNotApproved)]
fun stale_recommendation_rejected_when_supplier_revoked() {
    let mut scenario = h::setup();
    let id = schedule_30k(&mut scenario);

    scenario.next_tx(h::admin());
    {
        let mut reg = scenario.take_shared<SupplierRegistry>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        registry::set_status(&mut reg, &cap, h::supplier_id(), registry::status_revoked());
        ts::return_shared(reg);
        scenario.return_to_sender(cap);
    };

    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());
    scenario.end();
}

/// The agent is disabled after the recommendation.
#[test, expected_failure(abort_code = payflow::payment::ECapabilityDisabled)]
fun stale_recommendation_rejected_when_agent_disabled() {
    let mut scenario = h::setup();
    let id = schedule_30k(&mut scenario);
    let cap_id = h::agent_cap_id(&mut scenario);

    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        treasury::set_agent_enabled(&mut vault, &cap, cap_id, false);
        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());
    scenario.end();
}

/// Executing a request twice is refused — the request itself is consumed, and
/// the invoice is paid, so two independent things stop it.
#[test, expected_failure(abort_code = payflow::payment::ERequestNotPending)]
fun scheduled_request_cannot_be_executed_twice() {
    let mut scenario = h::setup();
    let id = schedule_30k(&mut scenario);

    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());
    run_scheduled(&mut scenario, id, h::now_ms() + h::day_ms());

    scenario.end();
}

// --- helpers ------------------------------------------------------------------

/// Raises the agent ceiling to $90,000 and schedules a $30,000 payment, so that
/// the checks under test are the ones that changed — not the cap.
fun schedule_30k(scenario: &mut Scenario): ID {
    let cap_id = h::agent_cap_id(scenario);

    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        treasury::set_agent_limits(&mut vault, &cap, cap_id, h::usd(90_000), h::usd(90_000));
        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(h::admin());
    let invoice_id = h::add_invoice(
        scenario,
        string::utf8(b"INV-SCHEDULED"),
        h::supplier_id(),
        h::usd(30_000),
        h::usd_currency(),
        h::supplier_wallet(),
    );

    scenario.next_tx(h::agent_addr());
    {
        let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let inv = ts::take_shared_by_id<Invoice>(scenario, invoice_id);
        let cap = scenario.take_from_sender<AgentCap>();

        payment::request(
            &vault,
            &cap,
            &inv,
            h::usd(30_000),
            h::supplier_wallet(),
            string::utf8(b"2026-09-05"),
            h::recommendation_id(),
            h::now_ms(),
            // Deliberately generous, so expiry is never what fails in this file.
            h::now_ms() + 30 * h::day_ms(),
            scenario.ctx(),
        );

        scenario.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(inv);
    };

    invoice_id
}

fun run_scheduled(scenario: &mut Scenario, invoice_id: ID, at_ms: u64) {
    scenario.next_tx(h::agent_addr());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let mut req = scenario.take_shared<PaymentRequest>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let mut inv = ts::take_shared_by_id<Invoice>(scenario, invoice_id);
    let cap = scenario.take_from_sender<AgentCap>();
    let clock = h::new_clock(scenario, at_ms);

    payment::execute_scheduled(
        &mut vault,
        &mut req,
        &cap,
        &reg,
        &mut inv,
        &clock,
        scenario.ctx(),
    );

    h::destroy_clock(clock);
    scenario.return_to_sender(cap);
    ts::return_shared(vault);
    ts::return_shared(req);
    ts::return_shared(reg);
    ts::return_shared(inv);
}
