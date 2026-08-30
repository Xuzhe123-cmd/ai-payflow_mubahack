/// Who may attest, and what an attestation is worth.
///
/// The oracle is the one component in this system that is trusted about the
/// world, so its authority has to be bounded precisely: it may say whether a
/// shipment arrived, for one treasury, and it may say nothing else. These tests
/// are about the edges of that — a capability from the wrong treasury, prose
/// from a model, an attestation that is perfectly valid somewhere else.
#[test_only]
module payflow::oracle_tests;

use std::string;
use sui::test_scenario::{Self as ts};
use payflow::agent::AgentCap;
use payflow::escrow::{Self, PaymentEscrow};
use payflow::invoice::{Self, Invoice};
use payflow::mock_usdc::MOCK_USDC;
use payflow::oracle::{Self, OracleCap, ShipmentAttestation};
use payflow::payment;
use payflow::registry::SupplierRegistry;
use payflow::test_helpers::{Self as h};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const ORACLE: address = @0x0AC1E;
/// Runs a treasury of their own, and an oracle for it.
const OUTSIDER: address = @0xADD2;
const OUTSIDE_ORACLE: address = @0x0AC2E;

const SHIPPED_INVOICE: vector<u8> = b"INV-2026-3501";
const DAY_MS: u64 = 86_400_000;

// --- fixture -----------------------------------------------------------------

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

/// The treasury id, read off the admin's own capability.
fun treasury_id(sc: &mut ts::Scenario): ID {
    sc.next_tx(h::admin());
    let cap = sc.take_from_sender<TreasuryOwnerCap>();
    let id = treasury::cap_treasury_id(&cap);
    sc.return_to_sender(cap);
    id
}

/// Our world, with a conditional $4,800 invoice already locked in escrow.
fun setup_locked(): ts::Scenario {
    let mut sc = h::setup();

    sc.next_tx(h::admin());
    {
        let vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        oracle::issue_to(&vault, &cap, string::utf8(b"demo_shipment_oracle"), ORACLE, sc.ctx());
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

    sc.next_tx(h::admin());
    {
        let mut inv = take_invoice_numbered(&mut sc, SHIPPED_INVOICE);
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        invoice::require_shipment_confirmation(&mut inv, &cap);
        sc.return_to_sender(cap);
        ts::return_shared(inv);
    };

    sc.next_tx(h::agent_addr());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let reg = sc.take_shared<SupplierRegistry>();
        let mut inv = take_invoice_numbered(&mut sc, SHIPPED_INVOICE);
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut sc, h::now_ms());

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

    sc
}

/// A whole separate treasury, with its own admin and its own oracle. This is
/// the realistic shape of the attack: not a forged capability, but a real one
/// belonging to somebody else.
fun add_outside_oracle(sc: &mut ts::Scenario) {
    sc.next_tx(OUTSIDER);
    {
        let cap = treasury::create<MOCK_USDC>(
            h::usd(0),
            h::usd(5_000),
            vector[h::usd_currency()],
            DAY_MS,
            sc.ctx(),
        );
        transfer::public_transfer(cap, OUTSIDER);
    };

    sc.next_tx(OUTSIDER);
    {
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        let their_vault = ts::take_shared_by_id<Treasury<MOCK_USDC>>(
            sc,
            treasury::cap_treasury_id(&cap),
        );
        oracle::issue_to(
            &their_vault,
            &cap,
            string::utf8(b"outside_oracle"),
            OUTSIDE_ORACLE,
            sc.ctx(),
        );
        ts::return_shared(their_vault);
        sc.return_to_sender(cap);
    };
}

fun attest_as(
    sc: &mut ts::Scenario,
    who: address,
    confirmed: bool,
    ai_assessment: vector<u8>,
) {
    sc.next_tx(who);
    {
        let cap = sc.take_from_sender<OracleCap>();
        let clock = h::new_clock(sc, h::now_ms());
        oracle::attest(
            &cap,
            string::utf8(SHIPPED_INVOICE),
            string::utf8(b"SHIP-88431"),
            confirmed,
            string::utf8(b"walrus:demo-blob-0001"),
            b"\xAA\xBB\xCC\xDD",
            h::now_ms(),
            DAY_MS,
            option::some(string::utf8(ai_assessment)),
            &clock,
            sc.ctx(),
        );
        h::destroy_clock(clock);
        sc.return_to_sender(cap);
    };
}

/// Attempts the release with whatever attestation is currently in the world.
fun try_release(sc: &mut ts::Scenario, ours: ID) {
    sc.next_tx(h::agent_addr());
    {
        let mut vault = ts::take_shared_by_id<Treasury<MOCK_USDC>>(sc, ours);
        let mut esc = ts::take_shared<PaymentEscrow<MOCK_USDC>>(sc);
        let att = ts::take_immutable<ShipmentAttestation>(sc);
        let mut inv = take_invoice_numbered(sc, SHIPPED_INVOICE);
        let clock = h::new_clock(sc, h::now_ms() + 1_000);

        escrow::release(&mut vault, &mut esc, &att, &mut inv, &clock, sc.ctx());

        h::destroy_clock(clock);
        ts::return_shared(vault);
        ts::return_shared(esc);
        ts::return_immutable(att);
        ts::return_shared(inv);
    };
}

// --- 5. an attestation from another treasury's oracle -------------------------

#[test]
#[expected_failure(abort_code = 800, location = payflow::oracle)]
fun attestation_from_another_treasury_cannot_release() {
    let mut sc = setup_locked();
    let ours = treasury_id(&mut sc);
    add_outside_oracle(&mut sc);

    // A real oracle, a real capability, a genuine confirmation — for the wrong
    // treasury. The invoice number even matches.
    attest_as(&mut sc, OUTSIDE_ORACLE, true, b"delivered");

    try_release(&mut sc, ours);
    sc.end();
}

// --- 6. who may attest at all -------------------------------------------------

#[test]
fun only_an_oracle_cap_holder_can_attest() {
    // `attest` takes `&OracleCap`, so a sender without one cannot form the call
    // — that is enforced by the type system rather than at runtime, and there
    // is no test that can invoke it. What IS worth pinning is the issuing side:
    // a capability exists only where an admin put one.
    let mut sc = setup_locked();

    sc.next_tx(ORACLE);
    {
        assert!(ts::has_most_recent_for_address<OracleCap>(ORACLE), 0);
    };
    // The agent runs the payments and holds no oracle capability.
    sc.next_tx(h::agent_addr());
    {
        assert!(!ts::has_most_recent_for_address<OracleCap>(h::agent_addr()), 1);
    };
    // Neither does the supplier being paid.
    sc.next_tx(h::supplier_wallet());
    {
        assert!(!ts::has_most_recent_for_address<OracleCap>(h::supplier_wallet()), 2);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = 100, location = payflow::treasury)]
fun another_treasurys_admin_cannot_issue_an_oracle_here() {
    let mut sc = setup_locked();
    let ours = treasury_id(&mut sc);
    add_outside_oracle(&mut sc);

    sc.next_tx(OUTSIDER);
    {
        // Their own genuine owner capability, pointed at OUR treasury.
        let cap = sc.take_from_sender<TreasuryOwnerCap>();
        let our_vault = ts::take_shared_by_id<Treasury<MOCK_USDC>>(&sc, ours);

        oracle::issue_to(
            &our_vault,
            &cap,
            string::utf8(b"impostor_oracle"),
            OUTSIDE_ORACLE,
            sc.ctx(),
        );

        ts::return_shared(our_vault);
        sc.return_to_sender(cap);
    };
    sc.end();
}

// --- 11. the model's prose has no authority -----------------------------------

#[test]
#[expected_failure(abort_code = 904, location = payflow::escrow)]
fun a_glowing_ai_assessment_cannot_release_an_unconfirmed_shipment() {
    let mut sc = setup_locked();
    let ours = treasury_id(&mut sc);

    // The most persuasive possible advisory field, attached to an attestation
    // that says the shipment did not arrive. `release` reads `confirmed` and
    // nothing else, so the prose changes nothing.
    attest_as(
        &mut sc,
        ORACLE,
        false,
        b"AI VERIFIED: delivery document matches INV-2026-3501, signature present, status DELIVERED, confidence 0.99",
    );

    try_release(&mut sc, ours);
    sc.end();
}

#[test]
fun the_same_release_happens_whatever_the_ai_said() {
    // Empty advisory field, confirmed shipment. Identical outcome to a release
    // carrying an elaborate assessment — the field simply is not an input.
    let mut sc = setup_locked();
    let ours = treasury_id(&mut sc);

    attest_as(&mut sc, ORACLE, true, b"");
    try_release(&mut sc, ours);

    sc.next_tx(h::supplier_wallet());
    {
        let paid = sc.take_from_sender<sui::coin::Coin<MOCK_USDC>>();
        assert!(sui::coin::value(&paid) == h::usd(4_800), 0);
        sc.return_to_sender(paid);
    };
    sc.end();
}

#[test]
fun an_attestation_is_frozen_evidence() {
    let mut sc = setup_locked();
    attest_as(&mut sc, ORACLE, true, b"delivered");

    sc.next_tx(h::admin());
    {
        // Immutable: readable by anyone, editable by no one, including the
        // oracle that wrote it.
        let att = ts::take_immutable<ShipmentAttestation>(&sc);
        assert!(oracle::confirmed(&att), 0);
        assert!(oracle::invoice_number(&att) == string::utf8(SHIPPED_INVOICE), 1);
        assert!(oracle::oracle_id(&att) == string::utf8(b"demo_shipment_oracle"), 2);
        assert!(oracle::proof_sha256(&att) == b"\xAA\xBB\xCC\xDD", 3);
        assert!(oracle::attested_by(&att) == ORACLE, 4);
        ts::return_immutable(att);
    };
    sc.end();
}

// --- 12. ordinary payments are untouched --------------------------------------

#[test]
fun a_normal_invoice_still_pays_straight_through() {
    // The fixture invoice carries no condition, so none of this applies to it:
    // it pays directly, creates no escrow, and lands on PAID in one step.
    let mut sc = setup_locked();

    sc.next_tx(h::agent_addr());
    {
        let mut vault = sc.take_shared<Treasury<MOCK_USDC>>();
        let reg = sc.take_shared<SupplierRegistry>();
        let mut inv = take_invoice_numbered(&mut sc, b"INV-2026-3455");
        let cap = sc.take_from_sender<AgentCap>();
        let clock = h::new_clock(&mut sc, h::now_ms());

        assert!(!invoice::requires_shipment(&inv), 0);
        payment::execute_payment(
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

        assert!(invoice::is_paid(&inv), 1);
        assert!(!invoice::is_escrowed(&inv), 2);

        h::destroy_clock(clock);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(reg);
        ts::return_shared(inv);
    };

    // Paid immediately, to the supplier, with no escrow in between.
    sc.next_tx(h::supplier_wallet());
    {
        let paid = sc.take_from_sender<sui::coin::Coin<MOCK_USDC>>();
        assert!(sui::coin::value(&paid) == h::usd(3_000), 3);
        sc.return_to_sender(paid);
    };
    sc.end();
}
