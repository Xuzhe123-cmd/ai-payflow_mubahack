/// The human-approval path, and what the audit record says about it.
///
/// The whole point of splitting authority is that the SAME ten checks judge a
/// $30,000 human-approved payment and a $3,000 autonomous one — only the source
/// of the limits differs. These tests hold both halves of that: the approval
/// lets through what the agent cannot, and it does so without loosening
/// anything else.
///
/// `PaymentRecord.authority` is written by Move, so the interface cannot
/// mislabel a human-approved payment as autonomous. That is asserted here.
#[test_only]
module payflow::payment_tests;

use std::string;
use sui::test_scenario::{Self as ts, Scenario};
use payflow::agent::AgentCap;
use payflow::approval::{Self, HumanApproval};
use payflow::invoice::Invoice;
use payflow::limits;
use payflow::mock_usdc::MOCK_USDC;
use payflow::payment::{Self, PaymentRecord};
use payflow::registry::SupplierRegistry;
use payflow::test_helpers as h;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

/// $30,000 is six times the agent's ceiling. With a human approval it settles,
/// and the record says a human authorized it.
#[test]
fun human_approval_pays_above_the_agent_cap() {
    let mut scenario = h::setup();
    let invoice_id = big_invoice(&mut scenario);
    issue_approver(&mut scenario);
    approve(&mut scenario, string::utf8(b"INV-LARGE"), h::usd(30_000), h::supplier_wallet());

    execute_approved(&mut scenario, invoice_id);

    scenario.next_tx(h::admin());
    let vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    assert!(treasury::vault_value(&vault) == h::usd(70_000), 0);
    ts::return_shared(vault);

    let record = ts::take_immutable<PaymentRecord>(&scenario);
    assert!(payment::record_amount(&record) == h::usd(30_000), 1);
    assert!(payment::record_authority(&record) == limits::authority_human_approval(), 2);
    assert!(payment::record_recipient(&record) == h::supplier_wallet(), 3);
    ts::return_immutable(record);

    scenario.end();
}

/// The same amount, same invoice, same everything — attempted by the agent on
/// its own authority. This is the pairing that makes the point.
#[test, expected_failure(abort_code = payflow::payment::EExceedsMaxPayment)]
fun the_agent_cannot_pay_what_a_human_could() {
    let mut scenario = h::setup();
    let invoice_id = big_invoice(&mut scenario);

    scenario.next_tx(h::agent_addr());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let mut inv = ts::take_shared_by_id<Invoice>(&scenario, invoice_id);
    let cap = scenario.take_from_sender<AgentCap>();
    let clock = h::new_clock(&mut scenario, h::now_ms());

    payment::execute_payment(
        &mut vault,
        &cap,
        &reg,
        &mut inv,
        h::usd(30_000),
        h::supplier_wallet(),
        h::recommendation_id(),
        h::now_ms(),
        h::now_ms() + h::day_ms(),
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

/// An autonomous payment is recorded as autonomous.
#[test]
fun autonomous_payment_records_agent_authority() {
    let mut scenario = h::setup();

    scenario.next_tx(h::agent_addr());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let reg = scenario.take_shared<SupplierRegistry>();
        let mut inv = scenario.take_shared<Invoice>();
        let cap = scenario.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut scenario, h::now_ms());

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
            scenario.ctx(),
        );

        h::destroy_clock(clock);
        scenario.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };

    scenario.next_tx(h::admin());
    let record = ts::take_immutable<PaymentRecord>(&scenario);
    assert!(payment::record_authority(&record) == limits::authority_agent(), 0);
    assert!(payment::record_invoice_number(&record) == h::invoice_number(), 1);
    assert!(payment::record_recommendation_id(&record) == h::recommendation_id(), 2);
    ts::return_immutable(record);

    scenario.end();
}

/// An approval authorizes one payment, not a class of them. Signing off
/// INV-LARGE does not release funds against a different invoice.
#[test, expected_failure(abort_code = payflow::payment::EApprovalMismatch)]
fun approval_is_bound_to_its_invoice() {
    let mut scenario = h::setup();
    let _big = big_invoice(&mut scenario);

    scenario.next_tx(h::admin());
    let other_id = h::add_invoice(
        &mut scenario,
        string::utf8(b"INV-OTHER"),
        h::supplier_id(),
        h::usd(30_000),
        h::usd_currency(),
        h::supplier_wallet(),
    );

    issue_approver(&mut scenario);
    approve(&mut scenario, string::utf8(b"INV-LARGE"), h::usd(30_000), h::supplier_wallet());

    // Approval says INV-LARGE; the invoice presented is INV-OTHER.
    execute_approved(&mut scenario, other_id);
    scenario.end();
}

/// An approver cannot sign for more than their own ceiling.
#[test, expected_failure(abort_code = payflow::approval::EAboveApproverLimit)]
fun approver_cannot_exceed_their_own_limit() {
    let mut scenario = h::setup();
    issue_approver(&mut scenario);

    scenario.next_tx(h::approver());
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let company = scenario.take_shared<payflow::identity::Company>();
        let clock = h::new_clock(&mut scenario, h::now_ms());
        approval::approve_scoped(
            &mut vault,
            &company,
            string::utf8(b"INV-ENORMOUS"),
            h::usd(500_000),
            h::supplier_wallet(),
            h::now_ms() + h::day_ms(),
            &clock,
            scenario.ctx(),
        );
        h::destroy_clock(clock);
        ts::return_shared(company);
        ts::return_shared(vault);
    };

    scenario.end();
}

/// A consumed approval cannot be spent again. The invoice is also already paid,
/// so two independent checks refuse it — the capability check simply comes
/// first.
#[test, expected_failure(abort_code = payflow::payment::ECapabilityDisabled)]
fun approval_is_single_use() {
    let mut scenario = h::setup();
    let invoice_id = big_invoice(&mut scenario);
    issue_approver(&mut scenario);
    approve(&mut scenario, string::utf8(b"INV-LARGE"), h::usd(30_000), h::supplier_wallet());

    execute_approved(&mut scenario, invoice_id);
    execute_approved(&mut scenario, invoice_id);

    scenario.end();
}

/// Human approval raises the ceiling. It does not switch off the reserve, the
/// registry, or anything else — those checks run identically on both paths.
#[test, expected_failure(abort_code = payflow::payment::ERecipientWalletMismatch)]
fun human_approval_does_not_bypass_the_other_checks() {
    let mut scenario = h::setup();

    scenario.next_tx(h::admin());
    let redirected = h::add_invoice(
        &mut scenario,
        string::utf8(b"INV-REDIRECT"),
        h::supplier_id(),
        h::usd(30_000),
        h::usd_currency(),
        h::attacker_wallet(),
    );

    issue_approver(&mut scenario);
    approve(&mut scenario, string::utf8(b"INV-REDIRECT"), h::usd(30_000), h::attacker_wallet());

    execute_approved(&mut scenario, redirected);
    scenario.end();
}

// --- helpers ------------------------------------------------------------------

fun big_invoice(scenario: &mut Scenario): ID {
    scenario.next_tx(h::admin());
    h::add_invoice(
        scenario,
        string::utf8(b"INV-LARGE"),
        h::supplier_id(),
        h::usd(30_000),
        h::usd_currency(),
        h::supplier_wallet(),
    )
}

/// Authorises the approver in TREASURY STATE.
///
/// Was `issue_approver_to`, which minted an `ApproverCap` carrying its own
/// limit and could never be revoked. The authority now lives where the admin
/// can withdraw it, so the fixture grants it the same way production will.
fun issue_approver(scenario: &mut Scenario) {
    // Membership is an upper-level requirement now: the company must recognise
    // the approver before a treasury authorization means anything.
    let company_id = h::setup_company(scenario);
    scenario.next_tx(h::admin());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let cap = scenario.take_from_sender<TreasuryOwnerCap>();
    treasury::init_approvers(&mut vault, &cap);
    treasury::authorize_approver(
        &mut vault,
        &cap,
        h::approver(),
        h::usd(250_000),
        h::usd(1_000_000),
        h::now_ms() + h::day_ms() * 30,
        vector[],
        company_id,
        h::now_ms(),
    );
    ts::return_shared(vault);
    scenario.return_to_sender(cap);
}

fun approve(
    scenario: &mut Scenario,
    invoice_number: string::String,
    amount: u64,
    recipient: address,
) {
    scenario.next_tx(h::approver());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let company = scenario.take_shared<payflow::identity::Company>();
    let clock = h::new_clock(scenario, h::now_ms());
    approval::approve_scoped(
        &mut vault,
        &company,
        invoice_number,
        amount,
        recipient,
        h::now_ms() + h::day_ms(),
        &clock,
        scenario.ctx(),
    );
    h::destroy_clock(clock);
    ts::return_shared(company);
    ts::return_shared(vault);
}

fun execute_approved(scenario: &mut Scenario, invoice_id: ID) {
    scenario.next_tx(h::approver());
    let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
    let mut appr = scenario.take_shared<HumanApproval>();
    let reg = scenario.take_shared<SupplierRegistry>();
    let mut inv = ts::take_shared_by_id<Invoice>(scenario, invoice_id);
    let clock = h::new_clock(scenario, h::now_ms());

    payment::execute_approved(
        &mut vault,
        &mut appr,
        &reg,
        &mut inv,
        h::recommendation_id(),
        h::now_ms(),
        h::now_ms() + h::day_ms(),
        &clock,
        scenario.ctx(),
    );

    h::destroy_clock(clock);
    ts::return_shared(vault);
    ts::return_shared(appr);
    ts::return_shared(reg);
    ts::return_shared(inv);
}
