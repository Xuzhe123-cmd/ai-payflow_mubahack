/// The company treasury: the vault, the policy, and the agent register.
///
/// Shared, because three different senders mutate it in independent
/// transactions — the admin setting policy, the agent paying an invoice, and an
/// approver settling one above the threshold. An owned object could only be
/// mutated by its owner, which would force the agent to *be* the treasury
/// owner, and that is precisely what this design exists to prevent.
///
/// Money leaves through exactly one door: `split_vault`, which is
/// `public(package)` and is called from `payment` and nowhere else, after the
/// ten checks have passed. No function here hands a caller a `&mut Balance<T>`,
/// and there is no withdrawal path an `AgentCap` can reach.
module payflow::treasury;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use payflow::policy::{Self, TreasuryPolicy};

/// A capability issued for a different treasury than the one being acted on.
const EWrongTreasury: u64 = 100;
const EInsufficientVault: u64 = 101;
const EAgentAlreadyRegistered: u64 = 102;
const EAgentNotRegistered: u64 = 103;

const MS_PER_DAY: u64 = 86_400_000;

public struct Treasury<phantom T> has key {
    id: UID,
    owner: address,
    /// The only money in the system.
    vault: Balance<T>,
    policy: TreasuryPolicy,
    /// Keyed by AgentCap object id. Limits live HERE, in admin-controlled
    /// state, not inside the capability the agent holds — otherwise the admin
    /// could never revoke or re-limit an agent, since only an object's owner
    /// may mutate it.
    agents: Table<ID, AgentAuthorization>,
    /// invoice_number -> PaymentRecord id. Written in the same transaction as
    /// the transfer, which is what makes replay impossible.
    paid_invoices: Table<String, ID>,
    total_paid: u64,
    payment_count: u64,
}

/// The sole key to every policy mutation. Owned, never shared, and never minted
/// inside a function an agent can call.
public struct TreasuryOwnerCap has key, store {
    id: UID,
    treasury_id: ID,
}

public struct AgentAuthorization has store {
    max_single: u64,
    daily_limit: u64,
    enabled: bool,
    spent_today: u64,
    day_bucket: u64,
}

// --- Construction ------------------------------------------------------------

/// Shares the treasury and returns the owner capability to the caller.
///
/// The settlement coin allowlist is seeded with T itself, computed on chain.
/// A `Treasury<T>` obviously permits T, and deriving it here means a deployment
/// script never has to spell out a type string containing a package address it
/// has only just learned. Further coin types are added by the admin later.
public fun create<T>(
    min_reserve: u64,
    human_approval_threshold: u64,
    allowed_currencies: vector<String>,
    max_recommendation_age_ms: u64,
    ctx: &mut TxContext,
): TreasuryOwnerCap {
    let id = object::new(ctx);
    let treasury_id = object::uid_to_inner(&id);

    let treasury = Treasury<T> {
        id,
        owner: ctx.sender(),
        vault: balance::zero<T>(),
        policy: policy::new(
            min_reserve,
            human_approval_threshold,
            true,
            allowed_currencies,
            vector[policy::coin_type_of<T>()],
            max_recommendation_age_ms,
        ),
        agents: table::new(ctx),
        paid_invoices: table::new(ctx),
        total_paid: 0,
        payment_count: 0,
    };
    transfer::share_object(treasury);

    TreasuryOwnerCap { id: object::new(ctx), treasury_id }
}

/// Convenience wrapper for a one-shot setup transaction. `create` is the
/// composable form and is what a PTB should use.
#[allow(lint(self_transfer))]
public fun create_and_transfer<T>(
    min_reserve: u64,
    human_approval_threshold: u64,
    allowed_currencies: vector<String>,
    max_recommendation_age_ms: u64,
    ctx: &mut TxContext,
) {
    let cap = create<T>(
        min_reserve,
        human_approval_threshold,
        allowed_currencies,
        max_recommendation_age_ms,
        ctx,
    );
    transfer::public_transfer(cap, ctx.sender());
}

// --- Authorization -----------------------------------------------------------

/// Every admin path starts here. A cap valid for treasury A cannot act on B.
public fun assert_owner<T>(treasury: &Treasury<T>, cap: &TreasuryOwnerCap) {
    assert!(cap.treasury_id == object::id(treasury), EWrongTreasury);
}

public fun cap_treasury_id(cap: &TreasuryOwnerCap): ID { cap.treasury_id }

// --- Funding -----------------------------------------------------------------

/// Anyone may add funds; only the owner may remove them.
public fun deposit<T>(treasury: &mut Treasury<T>, funds: Coin<T>) {
    balance::join(&mut treasury.vault, coin::into_balance(funds));
}

public fun withdraw<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert_owner(treasury, cap);
    assert!(balance::value(&treasury.vault) >= amount, EInsufficientVault);
    coin::from_balance(balance::split(&mut treasury.vault, amount), ctx)
}

/// The single exit for treasury funds on the payment path. Package-visible so
/// only `payment` can call it, and only after `evaluate` has approved.
public(package) fun split_vault<T>(
    treasury: &mut Treasury<T>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(balance::value(&treasury.vault) >= amount, EInsufficientVault);
    coin::from_balance(balance::split(&mut treasury.vault, amount), ctx)
}

// --- Policy administration (TreasuryOwnerCap required on every one) ----------

public fun set_min_reserve<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    value: u64,
) {
    assert_owner(treasury, cap);
    policy::set_min_reserve(&mut treasury.policy, value);
}

public fun set_human_approval_threshold<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    value: u64,
) {
    assert_owner(treasury, cap);
    policy::set_human_approval_threshold(&mut treasury.policy, value);
}

public fun set_auto_pay_enabled<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    value: bool,
) {
    assert_owner(treasury, cap);
    policy::set_auto_pay_enabled(&mut treasury.policy, value);
}

public fun set_max_recommendation_age_ms<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    value: u64,
) {
    assert_owner(treasury, cap);
    policy::set_max_recommendation_age_ms(&mut treasury.policy, value);
}

public fun add_allowed_currency<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    currency: String,
) {
    assert_owner(treasury, cap);
    policy::add_allowed_currency(&mut treasury.policy, currency);
}

public fun add_allowed_coin_type<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    coin_type: String,
) {
    assert_owner(treasury, cap);
    policy::add_allowed_coin_type(&mut treasury.policy, coin_type);
}

// --- Agent administration ----------------------------------------------------

/// Called by `agent::issue` once it has minted the capability object.
public(package) fun register_agent<T>(
    treasury: &mut Treasury<T>,
    agent_id: ID,
    max_single: u64,
    daily_limit: u64,
) {
    assert!(!treasury.agents.contains(agent_id), EAgentAlreadyRegistered);
    treasury
        .agents
        .add(
            agent_id,
            AgentAuthorization {
                max_single,
                daily_limit,
                enabled: true,
                spent_today: 0,
                day_bucket: 0,
            },
        );
}

/// Revocation by object id, because the admin does not hold the agent's cap —
/// the agent does. This is what makes disabling an agent one transaction.
public fun set_agent_enabled<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    agent_id: ID,
    enabled: bool,
) {
    assert_owner(treasury, cap);
    assert!(treasury.agents.contains(agent_id), EAgentNotRegistered);
    treasury.agents.borrow_mut(agent_id).enabled = enabled;
}

public fun set_agent_limits<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    agent_id: ID,
    max_single: u64,
    daily_limit: u64,
) {
    assert_owner(treasury, cap);
    assert!(treasury.agents.contains(agent_id), EAgentNotRegistered);
    let auth = treasury.agents.borrow_mut(agent_id);
    auth.max_single = max_single;
    auth.daily_limit = daily_limit;
}

// --- Reads -------------------------------------------------------------------

public fun policy<T>(treasury: &Treasury<T>): &TreasuryPolicy { &treasury.policy }

public fun vault_value<T>(treasury: &Treasury<T>): u64 { balance::value(&treasury.vault) }

public fun owner<T>(treasury: &Treasury<T>): address { treasury.owner }

public fun total_paid<T>(treasury: &Treasury<T>): u64 { treasury.total_paid }

public fun payment_count<T>(treasury: &Treasury<T>): u64 { treasury.payment_count }

public fun has_agent<T>(treasury: &Treasury<T>, agent_id: ID): bool {
    treasury.agents.contains(agent_id)
}

public fun agent_enabled<T>(treasury: &Treasury<T>, agent_id: ID): bool {
    treasury.agents.borrow(agent_id).enabled
}

public fun agent_max_single<T>(treasury: &Treasury<T>, agent_id: ID): u64 {
    treasury.agents.borrow(agent_id).max_single
}

public fun agent_daily_limit<T>(treasury: &Treasury<T>, agent_id: ID): u64 {
    treasury.agents.borrow(agent_id).daily_limit
}

/// Spend committed in the CURRENT day bucket. A stored figure from an earlier
/// day reads as zero rather than being carried forward, and both `evaluate` and
/// `execute_payment` call this same function so a report and the execution that
/// follows it can never disagree about the rollover.
public fun agent_effective_spent<T>(
    treasury: &Treasury<T>,
    agent_id: ID,
    now_ms: u64,
): u64 {
    let auth = treasury.agents.borrow(agent_id);
    if (auth.day_bucket == day_of(now_ms)) auth.spent_today else 0
}

public fun invoice_paid<T>(treasury: &Treasury<T>, invoice_number: &String): bool {
    treasury.paid_invoices.contains(*invoice_number)
}

public fun day_of(now_ms: u64): u64 { now_ms / MS_PER_DAY }

// --- Payment bookkeeping (package-only) --------------------------------------

public(package) fun record_agent_spend<T>(
    treasury: &mut Treasury<T>,
    agent_id: ID,
    amount: u64,
    now_ms: u64,
) {
    let today = day_of(now_ms);
    let auth = treasury.agents.borrow_mut(agent_id);
    if (auth.day_bucket == today) {
        auth.spent_today = auth.spent_today + amount;
    } else {
        auth.day_bucket = today;
        auth.spent_today = amount;
    };
}

public(package) fun mark_invoice_paid<T>(
    treasury: &mut Treasury<T>,
    invoice_number: String,
    record_id: ID,
) {
    treasury.paid_invoices.add(invoice_number, record_id);
}

public(package) fun record_payment<T>(treasury: &mut Treasury<T>, amount: u64) {
    treasury.total_paid = treasury.total_paid + amount;
    treasury.payment_count = treasury.payment_count + 1;
}

// --- Test support ------------------------------------------------------------

#[test_only]
public fun destroy_cap_for_testing(cap: TreasuryOwnerCap) {
    let TreasuryOwnerCap { id, treasury_id: _ } = cap;
    id.delete();
}
