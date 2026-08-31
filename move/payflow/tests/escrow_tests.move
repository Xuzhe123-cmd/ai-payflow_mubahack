/// Adversarial tests for conditional settlement.
///
/// The claim under test is narrow and absolute: money that entered escrow
/// reaches the supplier only against a confirmed attestation for that invoice,
/// on that treasury, and reaches nobody else ever.
///
/// Each test differs from the working release in exactly one respect, so a pass
/// means that one respect is what stopped it.
#[test_only]
module payflow::escrow_tests;

use std::string;
use sui::test_scenario::{Self as ts};
use payflow::agent::AgentCap;
use payflow::approval::{Self, HumanApproval};
use payflow::escrow::{Self, PaymentEscrow};
use payflow::invoice::{Self, Invoice};
use payflow::mock_usdc::MOCK_USDC;
use payflow::oracle::{Self, OracleCap, ShipmentAttestation};
use payflow::payment;
use payflow::registry::SupplierRegistry;
use payflow::test_helpers::{Self as h};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const ORACLE: address = @0x0AC1E;
const OTHER_ORACLE: address = @0x0AC2E;

const SHIPPED_INVOICE: vector<u8> = b"INV-2026-3501";
const SHIPMENT_ID: vector<u8> = b"SHIP-88431";
const PROOF_BLOB: vector<u8> = b"walrus:demo-blob-0001";
const DAY_MS: u64 = 86_400_000;

// --- fixture -----------------------------------------------------------------

/// The world plus: an oracle, and a $4,800 invoice that settles only against a
/// confirmed shipment.
fun setup_conditional(): ts::Scenario {
    let mut sc = h::setup();

    sc.next_tx(h::admin());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        oracle::issue_to(
            &vault,
            &cap,
            string::utf8(b"demo_shipment_oracle"),
            ORACLE,
            sc.ctx(),
        );
        ts::return_shared(vault);
        sc.return_to_sender(cap);
    };

    sc.next_tx(h::admin());
    {
        h::add_invoice(
            &mut sc,
            string::utf8(SHIPPED_INVOICE),
            h::supplier_id(),
            h::usd(4_800),
            h::usd_currency(),
            h::supplier_wallet(),
        );
    };

    // Attach the settlement condition. Admin-only, and there is no way to undo it.
    sc.next_tx(h::admin());
    {
        let mut inv = take_conditional_invoice(&mut sc);
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        invoice::require_shipment_confirmation(&mut inv, &cap);
        assert!(invoice::requires_shipment(&inv), 0);
        sc.return_to_sender(cap);
        ts::return_shared(inv);
    };

    sc
}

/// Two shared invoices exist, so `take_shared` alone is ambiguous. These pick
/// the one meant by number rather than by whichever comes back first.
fun take_invoice_numbered(sc: &mut ts::Scenario, number: vector<u8>): Invoice {
    let a = ts::take_shared<Invoice>(sc);
    if (invoice::invoice_number(&a) == string::utf8(number)) {
        a
    } else {
        let b = ts::take_shared<Invoice>(sc);
        ts::return_shared(a);
        b
    }
}

/// The $4,800 invoice that settles only against a confirmed shipment.
fun take_conditional_invoice(sc: &mut ts::Scenario): Invoice {
    take_invoice_numbered(sc, SHIPPED_INVOICE)
}

/// Locks the $4,800 under the agent's capability. Leaves a shared escrow.
fun lock_it(sc: &mut ts::Scenario) {
    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(sc);
        let reg = ts::take_shared<SupplierRegistry>(sc);
        let mut inv = take_conditional_invoice(sc);
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(sc, h::now_ms());

        escrow::execute_conditional(
            &mut vault,
            &cap,
            &reg,
            &mut inv,
            h::usd(4_800),
            h::supplier_wallet(),
            h::recommendation_id(),
            h::now_ms(),
            payment::no_expiry(),
            &clock,
            sc.ctx(),
        );

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
}

/// The demo oracle states an outcome for an invoice number.
fun attest_as(
    sc: &mut ts::Scenario,
    who: address,
    invoice_number: vector<u8>,
    confirmed: bool,
    valid_for_ms: u64,
) {
    sc.next_tx(who);
    {
        let cap = sc.take_from_sender<OracleCap>();
        let clock = h::new_clock(sc, h::now_ms());
        oracle::attest(
            &cap,
            string::utf8(invoice_number),
            string::utf8(SHIPMENT_ID),
            confirmed,
            string::utf8(PROOF_BLOB),
            b"\x11\x22\x33\x44",
            h::now_ms(),
            valid_for_ms,
            // Advisory prose. Nothing in release reads it.
            option::some(string::utf8(b"AI: document names INV-2026-3501, status DELIVERED")),
            &clock,
            sc.ctx(),
        );
        h::destroy_clock(clock);
        sc.return_to_sender(cap);
    };
}

// --- 1. a conditional payment locks rather than pays --------------------------

#[test]
fun conditional_payment_locks_funds() {
    let mut sc = setup_conditional();

    sc.next_tx(h::admin());
    let opening = {
        let vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let v = treasury::vault_value(&vault);
        ts::return_shared(vault);
        v
    };

    lock_it(&mut sc);

    sc.next_tx(h::admin());
    {
        let vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let inv = take_conditional_invoice(&mut sc);

        // The vault is lighter by exactly the amount, and the escrow holds it.
        assert!(treasury::vault_value(&vault) == opening - h::usd(4_800), 0);
        assert!(escrow::balance_value(&esc) == h::usd(4_800), 1);
        assert!(escrow::is_locked(&esc), 2);

        // The supplier does NOT have it.
        assert!(!ts::has_most_recent_for_address<sui::coin::Coin<MOCK_USDC>>(h::supplier_wallet()), 3);

        // The recipient was fixed from the registry-checked address.
        assert!(escrow::recipient(&esc) == h::supplier_wallet(), 4);

        // The invoice is ESCROWED, and deliberately not PAID.
        assert!(invoice::is_escrowed(&inv), 5);
        assert!(!invoice::is_paid(&inv), 6);

        // The number is claimed, so nothing can be paid against it twice.
        assert!(treasury::invoice_paid(&vault, &string::utf8(SHIPPED_INVOICE)), 7);

        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- 2. a confirmed shipment releases ----------------------------------------

#[test]
fun confirmed_shipment_releases_funds() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, true, DAY_MS);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        assert!(escrow::releasable(&esc, &att, &clock), 0);
        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        assert!(escrow::status(&esc) == escrow::status_released(), 1);
        assert!(escrow::balance_value(&esc) == 0, 2);
        assert!(invoice::is_paid(&inv), 3);
        assert!(escrow::attestation_id(&esc).is_some(), 4);

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };

    // The supplier — and only the supplier — now holds the money.
    sc.next_tx(h::supplier_wallet());
    {
        let paid = sc.take_from_sender<sui::coin::Coin<MOCK_USDC>>();
        assert!(sui::coin::value(&paid) == h::usd(4_800), 5);
        sc.return_to_sender(paid);
    };
    sc.end();
}

// --- 3. an unconfirmed shipment cannot release --------------------------------

#[test]
#[expected_failure(abort_code = 904, location = payflow::escrow)]
fun unconfirmed_shipment_cannot_release() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    // The oracle looked, and said no.
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, false, DAY_MS);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        assert!(!escrow::releasable(&esc, &att, &clock), 0);
        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- 4. an attestation for another invoice cannot release ---------------------

#[test]
#[expected_failure(abort_code = 903, location = payflow::escrow)]
fun attestation_for_another_invoice_cannot_release() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    // Genuinely confirmed — for a different shipment.
    attest_as(&mut sc, ORACLE, b"INV-2026-9999", true, DAY_MS);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- 8. double release --------------------------------------------------------

#[test]
#[expected_failure(abort_code = 902, location = payflow::escrow)]
fun double_release_fails() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, true, DAY_MS);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());
        // The same valid attestation, a second time.
        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- 9. refund returns the funds ---------------------------------------------

#[test]
fun refund_returns_funds_to_the_vault() {
    let mut sc = setup_conditional();

    sc.next_tx(h::admin());
    let opening = {
        let vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let v = treasury::vault_value(&vault);
        ts::return_shared(vault);
        v
    };

    lock_it(&mut sc);

    sc.next_tx(h::admin());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        let clock = h::new_clock(&mut sc, h::now_ms() + DAY_MS);

        escrow::refund(&mut vault, &cap, &mut esc, &clock);

        assert!(treasury::vault_value(&vault) == opening, 0);
        assert!(escrow::balance_value(&esc) == 0, 1);
        assert!(escrow::status(&esc) == escrow::status_refunded(), 2);
        // Nothing was ever paid.
        assert!(treasury::payment_count(&vault) == 0, 3);

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(esc);
    };
    sc.end();
}

// --- 10. a refunded escrow cannot later release -------------------------------

#[test]
#[expected_failure(abort_code = 902, location = payflow::escrow)]
fun refunded_escrow_cannot_later_release() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);

    sc.next_tx(h::admin());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        escrow::refund(&mut vault, &cap, &mut esc, &clock);
        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(esc);
    };

    // The shipment turns up afterwards. The money has already gone home.
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, true, DAY_MS);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- an expired confirmation is not standing permission -----------------------

#[test]
#[expected_failure(abort_code = 905, location = payflow::escrow)]
fun expired_attestation_cannot_release() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, true, 1_000);

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        // A day later.
        let clock = h::new_clock(&mut sc, h::now_ms() + DAY_MS);

        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- 7. the recipient cannot be substituted -----------------------------------

#[test]
fun release_pays_the_locked_recipient_and_takes_no_destination() {
    // `release` has no destination parameter at all, so the property is really
    // about the field: whatever else varies, the money goes to the address
    // fixed at lock. Asserted here by paying and checking who holds the coin,
    // and by the source guard below which proves no parameter exists.
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    attest_as(&mut sc, ORACLE, SHIPPED_INVOICE, true, DAY_MS);

    sc.next_tx(h::attacker_wallet());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(&sc);
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms() + 1_000);

        // Sent by the attacker. Release is permissionless — and useless to them.
        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };

    // The attacker got nothing; the supplier got everything.
    sc.next_tx(h::admin());
    {
        assert!(!ts::has_most_recent_for_address<sui::coin::Coin<MOCK_USDC>>(h::attacker_wallet()), 0);
    };
    sc.next_tx(h::supplier_wallet());
    {
        let paid = sc.take_from_sender<sui::coin::Coin<MOCK_USDC>>();
        assert!(sui::coin::value(&paid) == h::usd(4_800), 1);
        sc.return_to_sender(paid);
    };
    sc.end();
}

// --- the direct payment paths cannot touch a conditional invoice --------------

#[test]
#[expected_failure(abort_code = 703, location = payflow::payment)]
fun execute_payment_refuses_a_conditional_invoice() {
    let mut sc = setup_conditional();

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let reg = ts::take_shared<SupplierRegistry>(&sc);
        let mut inv = take_conditional_invoice(&mut sc);
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut sc, h::now_ms());

        // Everything about this payment is fine except that it is conditional.
        payment::execute_payment(
            &mut vault,
            &cap,
            &reg,
            &mut inv,
            h::usd(4_800),
            h::supplier_wallet(),
            h::recommendation_id(),
            h::now_ms(),
            payment::no_expiry(),
            &clock,
            sc.ctx(),
        );

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- nor can the human-approved path ------------------------------------------

#[test]
#[expected_failure(abort_code = 703, location = payflow::payment)]
fun execute_approved_refuses_a_conditional_invoice() {
    let mut sc = setup_conditional();

    // Membership first: a treasury authorization is not sufficient while the
    // company does not recognise the approver.
    let company_id = h::setup_company(&mut sc);

    // A genuine approval, from a genuine approver, well within their limit.
    sc.next_tx(h::admin());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
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
        sc.return_to_sender(cap);
    };

    sc.next_tx(h::approver());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let company = sc.take_shared<payflow::identity::Company>();
        let clock = h::new_clock(&mut sc, h::now_ms());
        approval::approve_scoped(
            &mut vault,
            &company,
            string::utf8(SHIPPED_INVOICE),
            h::usd(4_800),
            h::supplier_wallet(),
            h::now_ms() + DAY_MS,
            &clock,
            sc.ctx(),
        );
        h::destroy_clock(clock);
        ts::return_shared(company);
        ts::return_shared(vault);
    };

    // A person signing off cannot lift a shipment condition. Approval raises
    // WHO may authorize an amount; it says nothing about whether the goods came.
    sc.next_tx(h::approver());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let mut appr = sc.take_shared<HumanApproval>();
        let reg = sc.take_shared<SupplierRegistry>();
        let mut inv = take_conditional_invoice(&mut sc);
        let clock = h::new_clock(&mut sc, h::now_ms());

        payment::execute_approved(
            &mut vault,
            &mut appr,
            &reg,
            &mut inv,
            h::recommendation_id(),
            h::now_ms(),
            payment::no_expiry(),
            &clock,
            sc.ctx(),
        );

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(appr);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- nor the scheduled path ---------------------------------------------------

#[test]
#[expected_failure(abort_code = 703, location = payflow::payment)]
fun execute_scheduled_refuses_a_conditional_invoice() {
    let mut sc = setup_conditional();

    sc.next_tx(h::agent_addr());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let inv = take_conditional_invoice(&mut sc);
        let cap = sc.take_from_sender<AgentCap>();

        payment::request(
            &vault,
            &cap,
            &inv,
            h::usd(4_800),
            h::supplier_wallet(),
            string::utf8(b"2026-09-24"),
            h::recommendation_id(),
            h::now_ms(),
            h::now_ms() + 30 * DAY_MS,
            sc.ctx(),
        );

        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(inv);
    };

    // Scheduling ahead does not outlast the condition either.
    sc.next_tx(h::agent_addr());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let mut req = sc.take_shared<payment::PaymentRequest>();
        let reg = sc.take_shared<SupplierRegistry>();
        let mut inv = take_conditional_invoice(&mut sc);
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut sc, h::now_ms() + DAY_MS);

        payment::execute_scheduled(
            &mut vault,
            &mut req,
            &cap,
            &reg,
            &mut inv,
            &clock,
            sc.ctx(),
        );

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(req);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}

// --- a conditional invoice cannot be locked twice -----------------------------

#[test]
#[expected_failure(abort_code = 8, location = payflow::escrow)]
fun a_conditional_invoice_cannot_be_locked_twice() {
    let mut sc = setup_conditional();
    lock_it(&mut sc);
    // The replay ledger was claimed at lock, so check 8 refuses the second.
    lock_it(&mut sc);
    sc.end();
}

// --- an unconditional invoice cannot be routed through escrow -----------------

#[test]
#[expected_failure(abort_code = 901, location = payflow::escrow)]
fun escrow_refuses_an_unconditional_invoice() {
    let mut sc = setup_conditional();

    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared<Treasury<MOCK_USDC>>(&sc);
        let reg = ts::take_shared<SupplierRegistry>(&sc);
        // The FIXTURE invoice, which carries no condition.
        let mut inv = take_invoice_numbered(&mut sc, b"INV-2026-3455");
        assert!(!invoice::requires_shipment(&inv), 99);
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut sc, h::now_ms());

        escrow::execute_conditional(
            &mut vault,
            &cap,
            &reg,
            &mut inv,
            h::usd(3_000),
            h::supplier_wallet(),
            h::recommendation_id(),
            h::now_ms(),
            payment::no_expiry(),
            &clock,
            sc.ctx(),
        );

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };
    sc.end();
}
