/// Shared fixture for the Move test suite.
///
/// Builds one honest world — funded treasury, approved supplier, registered
/// agent, a payable invoice — so that every security test differs from the
/// happy path in exactly one respect. A test that has to arrange five things to
/// make its point is not demonstrating the thing it claims to.
///
/// Figures match the demo policy: agent capped at $5,000 a payment and $20,000
/// a day, human approval required above $5,000, $50,000 reserve, $100,000 vault.
#[test_only]
module payflow::test_helpers;

use std::string::{Self, String};
use sui::clock::{Self, Clock};
use sui::coin::{Self, TreasuryCap};
use sui::test_scenario::{Self as ts, Scenario};
use payflow::agent::{Self, AgentCap};
use payflow::invoice;
use payflow::identity::{Self, Company, CompanyAdminCap};
use payflow::mock_usdc::{Self, MOCK_USDC};
use payflow::payment;
use payflow::registry::{Self, SupplierRegistry};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const ADMIN: address = @0xAD;
const AGENT: address = @0xA6E7;
const APPROVER: address = @0xAB;
const SUPPLIER_WALLET: address = @0x5011;
const ATTACKER_WALLET: address = @0xBAD;

/// MOCK_USDC has six decimals, so one dollar is 1_000_000 base units.
const UNIT: u64 = 1_000_000;
const DAY_MS: u64 = 86_400_000;
/// An arbitrary but fixed "now", so nothing in the suite depends on wall clock.
const NOW_MS: u64 = 1_800_000_000_000;

public fun admin(): address { ADMIN }

public fun agent_addr(): address { AGENT }

public fun approver(): address { APPROVER }

public fun supplier_wallet(): address { SUPPLIER_WALLET }

public fun attacker_wallet(): address { ATTACKER_WALLET }

public fun day_ms(): u64 { DAY_MS }

public fun now_ms(): u64 { NOW_MS }

public fun usd(dollars: u64): u64 { dollars * UNIT }

public fun supplier_id(): String { string::utf8(b"sup_northwind") }

public fun invoice_number(): String { string::utf8(b"INV-2026-3455") }

public fun recommendation_id(): String { string::utf8(b"rec_demo0001") }

public fun usd_currency(): String { string::utf8(b"USD") }

/// The whole world, ready for a test to take shared objects out of.
public fun setup(): Scenario {
    let mut scenario = ts::begin(ADMIN);

    mock_usdc::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = treasury::create<MOCK_USDC>(
            usd(50_000),
            usd(5_000),
            vector[usd_currency()],
            DAY_MS,
            scenario.ctx(),
        );
        registry::create(&cap, scenario.ctx());
        transfer::public_transfer(cap, ADMIN);
    };

    scenario.next_tx(ADMIN);
    {
        let mut vault = scenario.take_shared<Treasury<MOCK_USDC>>();
        let mut reg = scenario.take_shared<SupplierRegistry>();
        let cap = scenario.take_from_sender<TreasuryOwnerCap>();
        let mut minter = scenario.take_from_sender<TreasuryCap<MOCK_USDC>>();

        let funds = coin::mint(&mut minter, usd(100_000), scenario.ctx());
        treasury::deposit(&mut vault, funds);

        registry::upsert(
            &mut reg,
            &cap,
            supplier_id(),
            string::utf8(b"Northwind Components Ltd"),
            SUPPLIER_WALLET,
            registry::status_approved(),
        );

        agent::issue_to(
            &mut vault,
            &cap,
            string::utf8(b"agent_payflow_01"),
            usd(5_000),
            usd(20_000),
            AGENT,
            scenario.ctx(),
        );

        invoice::create(
            &cap,
            invoice_number(),
            supplier_id(),
            usd(3_000),
            usd_currency(),
            string::utf8(b"2026-08-31"),
            string::utf8(b"PO-2026-0412"),
            SUPPLIER_WALLET,
            NOW_MS,
            scenario.ctx(),
        );
        // The fixture invoice is the only shared Invoice at this point, so
        // tests can reach it with take_shared. Extra ones are addressed by id.

        ts::return_shared(vault);
        ts::return_shared(reg);
        scenario.return_to_sender(cap);
        scenario.return_to_sender(minter);
    };

    scenario
}

/// Adds another invoice and returns its id, so a test holding several at once
/// can address the one it means rather than whichever take_shared finds first.
/// Must be called in a transaction sent by the admin.
public fun add_invoice(
    scenario: &mut Scenario,
    number: String,
    supplier: String,
    amount: u64,
    currency: String,
    recipient: address,
): ID {
    let cap = scenario.take_from_sender<TreasuryOwnerCap>();
    let id = invoice::create(
        &cap,
        number,
        supplier,
        amount,
        currency,
        string::utf8(b"2026-09-18"),
        string::utf8(b"PO-2026-0455"),
        recipient,
        NOW_MS,
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    id
}

/// The agent capability's object id — the key its limits are stored under, and
/// what the admin needs in order to revoke it.
public fun agent_cap_id(scenario: &mut Scenario): ID {
    scenario.next_tx(AGENT);
    let cap = scenario.take_from_sender<AgentCap>();
    let id = agent::cap_id(&cap);
    scenario.return_to_sender(cap);
    id
}

public fun new_clock(scenario: &mut Scenario, ms: u64): Clock {
    let mut c = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut c, ms);
    c
}

public fun destroy_clock(c: Clock) {
    clock::destroy_for_testing(c);
}

/// Creates a Chain-Doi company and makes `approver()` an active Treasury
/// Manager, returning the company id.
///
/// Membership is now an upper-level requirement for payment authority, so
/// every approval fixture needs a company that recognises the approver. This
/// is the one place that is arranged.
public fun setup_company(scenario: &mut Scenario): ID {
    scenario.next_tx(ADMIN);
    identity::create_company_and_keep(
        string::utf8(b"Chain-Doi"),
        object::id_from_address(@0xDEAD),
        scenario.ctx(),
    );

    scenario.next_tx(ADMIN);
    let company_id = {
        let mut company = scenario.take_shared<Company>();
        let cap = scenario.take_from_sender<CompanyAdminCap>();
        let clock = new_clock(scenario, NOW_MS);
        identity::add_member(
            &mut company,
            &cap,
            APPROVER,
            identity::role_treasury_manager(),
            identity::perm_view_invoices()
                | identity::perm_view_treasury()
                | identity::perm_approve_payments()
                | identity::perm_authorize_agent(),
            &clock,
        );
        let id = object::id(&company);
        destroy_clock(clock);
        scenario.return_to_sender(cap);
        ts::return_shared(company);
        id
    };
    company_id
}

/// Revokes the approver's membership. The higher-level block.
public fun revoke_membership(scenario: &mut Scenario) {
    scenario.next_tx(ADMIN);
    let mut company = scenario.take_shared<Company>();
    let cap = scenario.take_from_sender<CompanyAdminCap>();
    let clock = new_clock(scenario, NOW_MS);
    identity::revoke_member(&mut company, &cap, APPROVER, &clock);
    destroy_clock(clock);
    scenario.return_to_sender(cap);
    ts::return_shared(company);
}
