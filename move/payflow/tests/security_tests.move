/// One test per way a payment can be refused.
///
/// Each `abort_code` below is simultaneously the Move error constant, the check
/// code in the evaluation vector, and the `PolicyViolationCode` the interface
/// renders — so these tests pin that whole chain of names in one place. If
/// anyone renumbers a check, this file stops compiling.
///
/// Every test starts from the honest fixture and changes exactly one thing.
#[test_only]
module payflow::security_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use payflow::agent::AgentCap;
use payflow::invoice::{Self, Invoice};
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment;
use payflow::registry::{Self, SupplierRegistry};
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

// --- The control -------------------------------------------------------------

/// The invoice exactly as issued: $3,000 to the registered wallet, inside every
/// limit. Everything below is this, with one thing broken.
#[test]
fun happy_path_pays() {
    let mut scenario = h::setup();
    pay_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet(), h::now_ms());

    scenario.next_tx(h::admin());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let inv = scenario.take_shared<Invoice>();

    assert!(treasury::vault_value(&vault) == h::usd(97_000), 0);
    assert!(treasury::payment_count(&vault) == 1, 1);
    assert!(treasury::total_paid(&vault) == h::usd(3_000), 2);
    assert!(invoice::is_paid(&inv), 3);
    assert!(treasury::invoice_paid(&vault, &h::invoice_number()), 4);

    ts::return_shared(vault);
    ts::return_shared(inv);
    scenario.end();
}

// --- §24 Test 1 — payment above the agent's cap ------------------------------

/// The headline security demonstration: the AI asks for $8,000, the capability
/// allows $5,000, and the chain refuses. Nothing else about the invoice is
/// wrong.
#[test, expected_failure(abort_code = payflow::payment::EExceedsMaxPayment)]
fun over_cap_payment_aborts() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    let id = h::add_invoice(
        &mut scenario,
        string::utf8(b"INV-OVER-CAP"),
        h::supplier_id(),
        h::usd(8_000),
        h::usd_currency(),
        h::supplier_wallet(),
    );

    pay_by_id(&mut scenario, id, h::usd(8_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

// --- §24 Test 2 — the daily ceiling ------------------------------------------

/// Four $5,000 payments reach the $20,000 limit exactly and are allowed; the
/// fifth is refused. Separate invoices throughout, so the duplicate check stays
/// out of it and the daily total is genuinely what fails.
#[test, expected_failure(abort_code = payflow::payment::EExceedsDailyLimit)]
fun daily_limit_aborts() {
    let mut scenario = h::setup();

    let a = add(&mut scenario, b"INV-D1", h::usd(5_000));
    let b = add(&mut scenario, b"INV-D2", h::usd(5_000));
    let c = add(&mut scenario, b"INV-D3", h::usd(5_000));
    let d = add(&mut scenario, b"INV-D4", h::usd(5_000));
    let e = add(&mut scenario, b"INV-D5", h::usd(1_000));

    pay_by_id(&mut scenario, a, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, b, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, c, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, d, h::usd(5_000), h::supplier_wallet(), h::now_ms());

    // 20,000 spent, limit 20,000. One more dollar is one too many.
    pay_by_id(&mut scenario, e, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

/// The counter rolls over. Without this, "daily limit" would just be a lifetime
/// limit that happens to be named after a day.
#[test]
fun daily_limit_resets_next_day() {
    let mut scenario = h::setup();

    let a = add(&mut scenario, b"INV-R1", h::usd(5_000));
    let b = add(&mut scenario, b"INV-R2", h::usd(5_000));
    let c = add(&mut scenario, b"INV-R3", h::usd(5_000));
    let d = add(&mut scenario, b"INV-R4", h::usd(5_000));
    let e = add(&mut scenario, b"INV-R5", h::usd(5_000));

    pay_by_id(&mut scenario, a, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, b, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, c, h::usd(5_000), h::supplier_wallet(), h::now_ms());
    pay_by_id(&mut scenario, d, h::usd(5_000), h::supplier_wallet(), h::now_ms());

    // Same amount again, one day later — allowed, because the bucket moved.
    let tomorrow = h::now_ms() + h::day_ms();
    pay_by_id(&mut scenario, e, h::usd(5_000), h::supplier_wallet(), tomorrow);

    scenario.next_tx(h::admin());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    assert!(treasury::payment_count(&vault) == 5, 0);
    ts::return_shared(vault);
    scenario.end();
}

// --- §24 Test 3 — supplier authorization -------------------------------------

#[test, expected_failure(abort_code = payflow::payment::ESupplierNotApproved)]
fun revoked_supplier_aborts() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    {
        let mut reg = scenario.take_shared<SupplierRegistry>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        registry::set_status(&mut reg, &cap, h::supplier_id(), registry::status_revoked());
        ts::return_shared(reg);
        scenario.return_to_sender(cap);
    };

    pay_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

/// A supplier the registry has never heard of. The lookup must report "not
/// approved" rather than aborting, so the check can fail with a reason.
#[test, expected_failure(abort_code = payflow::payment::ESupplierNotApproved)]
fun unknown_supplier_aborts() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    let id = h::add_invoice(
        &mut scenario,
        string::utf8(b"INV-STRANGER"),
        string::utf8(b"sup_never_seen"),
        h::usd(1_000),
        h::usd_currency(),
        h::supplier_wallet(),
    );

    pay_by_id(&mut scenario, id, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

// --- §24 Test 4 — recipient wallet -------------------------------------------

/// Payment redirection: an approved supplier, a legitimate invoice, and a remit
/// address the registry does not recognise.
#[test, expected_failure(abort_code = payflow::payment::ERecipientWalletMismatch)]
fun wallet_mismatch_aborts() {
    let mut scenario = h::setup();
    pay_fixture(&mut scenario, h::usd(3_000), h::attacker_wallet(), h::now_ms());
    scenario.end();
}

// --- §24 Test 5 — duplicate ---------------------------------------------------

#[test, expected_failure(abort_code = payflow::payment::EInvoiceAlreadyPaid)]
fun duplicate_invoice_aborts() {
    let mut scenario = h::setup();
    pay_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet(), h::now_ms());
    pay_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

// --- §24 Test 6 — revoked capability -----------------------------------------

/// The admin disables the agent between issuing the capability and the payment.
/// One transaction, and the agent can no longer spend — which is the whole
/// reason the limits live on the treasury rather than inside the AgentCap.
#[test, expected_failure(abort_code = payflow::payment::ECapabilityDisabled)]
fun disabled_capability_aborts() {
    let mut scenario = h::setup();
    let cap_id = h::agent_cap_id(&mut scenario);

    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        treasury::set_agent_enabled(&mut vault, &cap, cap_id, false);
        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    pay_fixture(&mut scenario, h::usd(3_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

// --- Reserve and currency -----------------------------------------------------

/// The reserve holds even when every other check passes. The agent's ceiling is
/// raised first, so that the reserve is genuinely what fails rather than the
/// cap failing earlier and hiding it.
#[test, expected_failure(abort_code = payflow::payment::EInsufficientReserve)]
fun reserve_breach_aborts() {
    let mut scenario = h::setup();
    let cap_id = h::agent_cap_id(&mut scenario);

    scenario.next_tx(h::admin());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        treasury::set_agent_limits(&mut vault, &cap, cap_id, h::usd(90_000), h::usd(90_000));
        ts::return_shared(vault);
        scenario.return_to_sender(cap);
    };

    // $100,000 vault, $50,000 floor: $60,000 would leave $40,000.
    let id = add(&mut scenario, b"INV-BIG", h::usd(60_000));
    pay_by_id(&mut scenario, id, h::usd(60_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

#[test, expected_failure(abort_code = payflow::payment::ECurrencyNotAllowed)]
fun disallowed_currency_aborts() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    let id = h::add_invoice(
        &mut scenario,
        string::utf8(b"INV-EUR"),
        h::supplier_id(),
        h::usd(1_000),
        string::utf8(b"EUR"),
        h::supplier_wallet(),
    );

    pay_by_id(&mut scenario, id, h::usd(1_000), h::supplier_wallet(), h::now_ms());
    scenario.end();
}

// --- Recommendation expiry ----------------------------------------------------

/// A recommendation older than the policy allows is not standing permission,
/// however sound it was when it was made.
#[test, expected_failure(abort_code = payflow::payment::ERecommendationExpired)]
fun expired_recommendation_aborts() {
    let mut scenario = h::setup();

    scenario.next_tx(h::agent_addr());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let mut inv = scenario.take_shared<Invoice>();
    let cap = scenario.take_from_sender<AgentCap>();

    // Recommended two days ago, expired one day ago, executed now.
    let recommended_at = h::now_ms();
    let clock = h::new_clock(&mut scenario, recommended_at + 2 * h::day_ms());

    payment::execute_payment(
        &mut vault,
        &cap,
        &reg,
        &mut inv,
        h::usd(3_000),
        h::supplier_wallet(),
        h::recommendation_id(),
        recommended_at,
        recommended_at + h::day_ms(),
        &clock,
        scenario.ctx(),
    );

    h::destroy_clock(clock);
    scenario.return_to_sender(cap);
    ts::return_shared(vault);
    ts::return_shared(reg);
    ts::return_shared(inv);
    scenario.end();
}

// --- Shared helpers -----------------------------------------------------------

/// Adds an invoice for the approved supplier at the given amount.
fun add(scenario: &mut Scenario, number: vector<u8>, amount: u64): ID {
    scenario.next_tx(h::admin());
    h::add_invoice(
        scenario,
        string::utf8(number),
        h::supplier_id(),
        amount,
        h::usd_currency(),
        h::supplier_wallet(),
    )
}

/// Pays the fixture invoice — the only shared Invoice when no others exist.
fun pay_fixture(scenario: &mut Scenario, amount: u64, recipient: address, at_ms: u64) {
    scenario.next_tx(h::agent_addr());
    let inv = scenario.take_shared<Invoice>();
    let id = object::id(&inv);
    ts::return_shared(inv);
    pay_by_id(scenario, id, amount, recipient, at_ms);
}

/// Drives the agent's autonomous path against one specific invoice.
fun pay_by_id(
    scenario: &mut Scenario,
    invoice_id: ID,
    amount: u64,
    recipient: address,
    at_ms: u64,
) {
    scenario.next_tx(h::agent_addr());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let mut inv = ts::take_shared_by_id<Invoice>(scenario, invoice_id);
    let cap = scenario.take_from_sender<AgentCap>();
    let clock = h::new_clock(scenario, at_ms);

    payment::execute_payment(
        &mut vault,
        &cap,
        &reg,
        &mut inv,
        amount,
        recipient,
        h::recommendation_id(),
        at_ms,
        at_ms + h::day_ms(),
        &clock,
        scenario.ctx(),
    );

    h::destroy_clock(clock);
    scenario.return_to_sender(cap);
    ts::return_shared(vault);
    ts::return_shared(reg);
    ts::return_shared(inv);
}
