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
use sui::dynamic_field as df;
use sui::table::{Self, Table};
use payflow::policy::{Self, TreasuryPolicy};

/// A capability issued for a different treasury than the one being acted on.
const EWrongTreasury: u64 = 100;
const EInsufficientVault: u64 = 101;
const EAgentAlreadyRegistered: u64 = 102;
const EAgentNotRegistered: u64 = 103;
const EApproversNotReady: u64 = 110;
const EApproverAlreadyAuthorized: u64 = 111;
const EApproverNotAuthorized: u64 = 112;
const EExpiryInPast: u64 = 113;
const EWrongCompany: u64 = 114;
/// The treasury is in HUMAN_ONLY mode and this path is not a human path.
const ECircuitBreakerActive: u64 = 115;
/// The breaker has not been installed on this treasury yet.
const EBreakerNotReady: u64 = 116;
/// Recovery attempted without a live, membership-verified human authorization.
const ENoHumanRecovery: u64 = 117;

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

/// A HUMAN approver's authority, held in admin-controlled treasury state.
///
/// THE FLAW THIS REPLACES. The original `ApproverCap` carried its own
/// `max_single` inside the capability object. Only an object's owner may mutate
/// it, so once issued the limit could never be lowered and the authority could
/// never be withdrawn — the deployed one authorises $25,000,000 against an
/// $88,200 vault and there is no function anywhere that can revoke it.
///
/// This follows `AgentAuthorization` instead, for the reason stated above that
/// struct: authority that lives in state the ADMIN owns can be changed by the
/// admin. Every field here is admin-writable, and `enabled` is the revocation.
///
/// KEYED BY ADDRESS, not by a capability object, and that is a deliberate
/// departure from the agent design. An `AgentCap` identifies a program; a
/// transferable object is a fine way to name one. A human approver's authority
/// is meant to be anchored to their zkLogin identity, and an object with
/// `store` can be handed to anyone — which would let the authority walk away
/// from the person the company authorised. An address cannot be transferred, so
/// `approve_scoped` checks `ctx.sender()` and the binding holds.
/// How long a mirrored membership reading stays usable.
///
/// The mirror exists because `approval::limits_for` — whose signature is frozen
/// by the published package — receives only `&Treasury` and can therefore never
/// be handed the `Company`. Membership has to be readable FROM the treasury,
/// which means a copy, and a copy of a mutable fact is only as good as its age.
///
/// So a stale mirror is not trusted. Past this window the authorization stops
/// being live until someone calls `approval::sync_membership`, which re-reads
/// the Company itself. Fail-closed in both directions: a revoked membership
/// kills it once synced, and never syncing kills it too.
const MEMBERSHIP_SYNC_MAX_AGE_MS: u64 = 3_600_000;

public fun membership_sync_max_age_ms(): u64 { MEMBERSHIP_SYNC_MAX_AGE_MS }

public struct ApproverAuthorization has store {
    /// Largest single payment this approver may authorise.
    max_single: u64,
    /// Ceiling on the total AUTHORISED per day.
    ///
    /// Counts approvals minted, not settlements executed — the execution path
    /// offers no hook this module could use without changing `payment`, and
    /// counting at mint time is the conservative direction: an approval that is
    /// never executed still consumes the day's budget.
    daily_limit: u64,
    authorized_today: u64,
    day_bucket: u64,
    /// The revocation. One flag, one admin transaction, effective immediately —
    /// including against approvals already minted and not yet executed.
    enabled: bool,
    /// Wall-clock expiry. Authority lapses on its own without an admin needing
    /// to remember to withdraw it.
    expires_at_ms: u64,
    /// Recipients this approver may authorise payment to. Empty means any,
    /// subject to every other limit here.
    allowed_recipients: vector<address>,
    /// The company whose ACTIVE membership this authorization requires.
    ///
    /// Recorded as a plain id rather than a reference so this module keeps no
    /// dependency on `identity` — the treasury stores which company it trusts;
    /// `approval` is where the two are actually compared.
    company_id: ID,
    /// The last reading of that company's membership for this approver.
    ///
    /// A MIRROR, not the source. Written only by `approval::sync_membership`,
    /// which copies what the live `Company` says and can therefore only make
    /// the treasury agree with it.
    membership_active: bool,
    membership_synced_at_ms: u64,
}

/// Key for the approver table, held as a dynamic field on the treasury.
///
/// A dynamic field rather than a new struct field because `Treasury<T>` is
/// already published: a Move upgrade may add functions and structs, and may not
/// add a field to an existing one. The table therefore hangs off the treasury's
/// UID, which leaves it inside treasury state — where the admin controls it and
/// where `approval::limits_for` can reach it with the `&Treasury` it already
/// receives.
public struct ApproversKey has copy, drop, store {}

/// Key for the circuit breaker, held as a dynamic field for the same reason
/// `ApproversKey` is: `Treasury<T>` is published and cannot gain a field.
public struct CircuitBreakerKey has copy, drop, store {}

/// Treasury operating mode. NORMAL is the everyday state; HUMAN_ONLY withdraws
/// autonomy without withdrawing the treasury's ability to pay.
const MODE_NORMAL: u8 = 0;
const MODE_HUMAN_ONLY: u8 = 1;

public fun mode_normal(): u8 { MODE_NORMAL }
public fun mode_human_only(): u8 { MODE_HUMAN_ONLY }

/// The on-chain consequence of an off-chain judgement.
///
/// THE SCORE IS EVIDENCE, NOT AUTHORITY. `anomaly_score` and `reason_code` are
/// recorded so an operator can see WHY the treasury was frozen, and Move never
/// reads them back to decide anything — the only field with force is `mode`.
/// An attacker who could write a score here would gain nothing; an attacker who
/// could write `mode` would need the owner capability, which is the actual
/// boundary.
///
/// WHY MODE AND NOT A PAUSE. HUMAN_ONLY does not stop the treasury. It removes
/// the AGENT's authority and leaves every human path exactly as it was, so the
/// business keeps running through people while the automation is contained.
public struct CircuitBreaker has store {
    mode: u8,
    /// 0..100, as computed off chain. Recorded as evidence.
    anomaly_score: u8,
    /// A short machine code naming the dominant signal. Evidence, not logic.
    reason_code: String,
    tripped_at_ms: u64,
    /// Who tripped it. Always an address that held the owner cap.
    tripped_by: address,
    /// How many times this treasury has ever been frozen.
    trip_count: u64,
    reset_at_ms: u64,
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

/// The return leg of `split_vault`, for a refunded escrow.
///
/// `public(package)`, so only `escrow` can reach it, and it takes a `Balance`
/// that could only have come from this vault in the first place. It is not a
/// deposit path anyone can call with arbitrary funds — `deposit` is that, and
/// it is deliberately separate.
public(package) fun return_to_vault<T>(treasury: &mut Treasury<T>, funds: Balance<T>) {
    balance::join(&mut treasury.vault, funds);
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

// --- Approver administration -------------------------------------------------

/// Installs the approver table. Run once, by the admin, after the upgrade.
///
/// Separate from `create` because the treasury already exists on chain and a
/// published struct cannot gain a field. Until this has run, every approver
/// read reports "not authorised" — fail-closed, so an uninstalled table can
/// never be mistaken for an empty allowlist that permits anything.
public fun init_approvers<T>(treasury: &mut Treasury<T>, cap: &TreasuryOwnerCap) {
    assert_owner(treasury, cap);
    if (!df::exists(&treasury.id, ApproversKey {})) {
        df::add(&mut treasury.id, ApproversKey {}, vector<address>[]);
    };
}

/// Whether the approver table has been installed.
public fun approvers_ready<T>(treasury: &Treasury<T>): bool {
    df::exists(&treasury.id, ApproversKey {})
}

/// Grants a human the authority to authorise payments, within limits.
///
/// The expiry must be in the future: an authority that is born expired is a
/// configuration mistake, and accepting one silently would leave an admin
/// believing they had granted something.
public fun authorize_approver<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    approver: address,
    max_single: u64,
    daily_limit: u64,
    expires_at_ms: u64,
    allowed_recipients: vector<address>,
    company_id: ID,
    now_ms: u64,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, ApproversKey {}), EApproversNotReady);
    assert!(expires_at_ms > now_ms, EExpiryInPast);
    assert!(!df::exists(&treasury.id, approver), EApproverAlreadyAuthorized);

    df::add(
        &mut treasury.id,
        approver,
        ApproverAuthorization {
            max_single,
            daily_limit,
            authorized_today: 0,
            day_bucket: 0,
            enabled: true,
            expires_at_ms,
            allowed_recipients,
            company_id,
            // Starts UNVERIFIED and stale. Granting a treasury authorization
            // says nothing about membership; `approval::sync_membership` — or
            // the first `approve_scoped` — is what reads the Company.
            membership_active: false,
            membership_synced_at_ms: 0,
        },
    );

    let roster: &mut vector<address> = df::borrow_mut(&mut treasury.id, ApproversKey {});
    roster.push_back(approver);
}

/// Revocation. The whole reason this design exists.
public fun set_approver_enabled<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    approver: address,
    enabled: bool,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, approver), EApproverNotAuthorized);
    let auth: &mut ApproverAuthorization = df::borrow_mut(&mut treasury.id, approver);
    auth.enabled = enabled;
}

public fun set_approver_limits<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    approver: address,
    max_single: u64,
    daily_limit: u64,
    expires_at_ms: u64,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, approver), EApproverNotAuthorized);
    let auth: &mut ApproverAuthorization = df::borrow_mut(&mut treasury.id, approver);
    auth.max_single = max_single;
    auth.daily_limit = daily_limit;
    auth.expires_at_ms = expires_at_ms;
}

public fun set_approver_recipients<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    approver: address,
    allowed_recipients: vector<address>,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, approver), EApproverNotAuthorized);
    let auth: &mut ApproverAuthorization = df::borrow_mut(&mut treasury.id, approver);
    auth.allowed_recipients = allowed_recipients;
}

/// Copies a membership reading into the mirror.
///
/// `public(package)` on purpose: only `approval::sync_membership` may call it,
/// and that function reads the live `Company` immediately beforehand. Nothing
/// outside this package can assert a membership status, and nothing inside it
/// can assert one it did not just read.
public(package) fun set_membership_mirror<T>(
    treasury: &mut Treasury<T>,
    approver: address,
    active: bool,
    now_ms: u64,
) {
    assert!(df::exists(&treasury.id, approver), EApproverNotAuthorized);
    let auth: &mut ApproverAuthorization = df::borrow_mut(&mut treasury.id, approver);
    auth.membership_active = active;
    auth.membership_synced_at_ms = now_ms;
}

/// The company an authorization requires membership of.
public fun approver_company_id<T>(treasury: &Treasury<T>, approver: address): ID {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.company_id
}

/// Aborts unless the authorization is bound to this company.
public fun assert_approver_company<T>(
    treasury: &Treasury<T>,
    approver: address,
    company_id: ID,
) {
    assert!(df::exists(&treasury.id, approver), EApproverNotAuthorized);
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    assert!(auth.company_id == company_id, EWrongCompany);
}

// --- Approver reads ----------------------------------------------------------

public fun has_approver<T>(treasury: &Treasury<T>, approver: address): bool {
    df::exists(&treasury.id, approver)
}

public fun approver_enabled<T>(treasury: &Treasury<T>, approver: address): bool {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.enabled
}

public fun approver_max_single<T>(treasury: &Treasury<T>, approver: address): u64 {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.max_single
}

public fun approver_daily_limit<T>(treasury: &Treasury<T>, approver: address): u64 {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.daily_limit
}

public fun approver_expires_at_ms<T>(treasury: &Treasury<T>, approver: address): u64 {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.expires_at_ms
}

/// Authorised in the CURRENT day bucket. A figure from an earlier day reads as
/// zero rather than carrying forward, exactly as the agent's does.
public fun approver_authorized_today<T>(
    treasury: &Treasury<T>,
    approver: address,
    now_ms: u64,
): u64 {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    if (auth.day_bucket == day_of(now_ms)) auth.authorized_today else 0
}

public fun approver_membership_active<T>(treasury: &Treasury<T>, approver: address): bool {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.membership_active
}

public fun approver_membership_synced_at_ms<T>(
    treasury: &Treasury<T>,
    approver: address,
): u64 {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.membership_synced_at_ms
}

/// Whether the mirrored membership reading is recent enough to rely on.
public fun approver_membership_fresh<T>(
    treasury: &Treasury<T>,
    approver: address,
    now_ms: u64,
): bool {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.membership_synced_at_ms > 0
        && now_ms >= auth.membership_synced_at_ms
        && now_ms - auth.membership_synced_at_ms <= MEMBERSHIP_SYNC_MAX_AGE_MS
}

public fun approver_allows_recipient<T>(
    treasury: &Treasury<T>,
    approver: address,
    recipient: address,
): bool {
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);
    auth.allowed_recipients.is_empty() || auth.allowed_recipients.contains(&recipient)
}

/// Every condition, in one place, asked the same way by the mint path and the
/// execution path.
///
/// Returns false rather than aborting for an unknown approver, because both
/// callers want a verdict rather than a failure — `limits_for` in particular
/// must be able to report a dead approval without killing the transaction that
/// merely asked about it.
/// Whether the company and the treasury both still vouch for this person.
///
/// Everything `approver_can_authorize` checks EXCEPT the per-payment scope: the
/// authorization exists, is enabled, has not expired, and the company's
/// membership verdict is both positive and fresh.
///
/// Extracted so `reset_breaker` can require a human in good standing without
/// inventing an amount and a recipient to satisfy a payment-shaped signature —
/// with Atlas-only scoping in force, any invented recipient would have failed.
public fun approver_in_good_standing<T>(
    treasury: &Treasury<T>,
    approver: address,
    now_ms: u64,
): bool {
    if (!df::exists(&treasury.id, approver)) return false;
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);

    if (!auth.enabled) return false;
    if (now_ms > auth.expires_at_ms) return false;

    // MEMBERSHIP IS AN UPPER-LEVEL REQUIREMENT. A treasury authorization is not
    // sufficient on its own: the company must still recognise this person, and
    // the reading proving it must be current. A revoked membership fails the
    // first test once synced; a mirror nobody has refreshed fails the second.
    if (!auth.membership_active) return false;
    if (auth.membership_synced_at_ms == 0) return false;
    if (now_ms < auth.membership_synced_at_ms) return false;
    if (now_ms - auth.membership_synced_at_ms > MEMBERSHIP_SYNC_MAX_AGE_MS) return false;

    true
}

public fun approver_can_authorize<T>(
    treasury: &Treasury<T>,
    approver: address,
    amount: u64,
    recipient: address,
    now_ms: u64,
): bool {
    // Standing first, then the per-payment scope. Split so recovery can ask the
    // first question without the second: un-freezing a treasury is not a
    // payment, and has no amount or recipient to be scoped by.
    if (!approver_in_good_standing(treasury, approver, now_ms)) return false;
    let auth: &ApproverAuthorization = df::borrow(&treasury.id, approver);

    if (amount > auth.max_single) return false;
    if (!auth.allowed_recipients.is_empty() && !auth.allowed_recipients.contains(&recipient)) {
        return false
    };

    let used = if (auth.day_bucket == day_of(now_ms)) auth.authorized_today else 0;
    used + amount <= auth.daily_limit
}

/// Books an authorisation against the day's budget. Called at mint time.
public(package) fun record_approver_authorization<T>(
    treasury: &mut Treasury<T>,
    approver: address,
    amount: u64,
    now_ms: u64,
) {
    let today = day_of(now_ms);
    let auth: &mut ApproverAuthorization = df::borrow_mut(&mut treasury.id, approver);
    if (auth.day_bucket == today) {
        auth.authorized_today = auth.authorized_today + amount;
    } else {
        auth.day_bucket = today;
        auth.authorized_today = amount;
    };
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

/// Claims an invoice number in the replay ledger, which is what check 8 reads.
///
/// Idempotent on the KEY, not on the value: an escrow claims the number when
/// funds leave the vault, and the release that follows re-points the same entry
/// at the payment record. The claim is what matters — once a number is in this
/// table no further payment can be made against it, whether the first one is
/// still sitting in escrow or has already settled.
public(package) fun mark_invoice_paid<T>(
    treasury: &mut Treasury<T>,
    invoice_number: String,
    record_id: ID,
) {
    if (treasury.paid_invoices.contains(invoice_number)) {
        *treasury.paid_invoices.borrow_mut(invoice_number) = record_id;
    } else {
        treasury.paid_invoices.add(invoice_number, record_id);
    };
}

public(package) fun record_payment<T>(treasury: &mut Treasury<T>, amount: u64) {
    treasury.total_paid = treasury.total_paid + amount;
    treasury.payment_count = treasury.payment_count + 1;
}

// --- Circuit breaker ---------------------------------------------------------
//
// The security consequence of an off-chain judgement, enforced here.
//
// WHAT LIVES OFF CHAIN. Gemini, Cloudflare, the behavioural statistics and the
// anomaly score. None of it is in Move and none of it should be: a model's
// opinion is not a fact a validator can check, and putting a score on chain
// would only move the trust problem, not solve it.
//
// WHAT LIVES HERE. One byte of mode, and the refusal that follows from it. That
// is the part an attacker cannot argue with, reach around, or re-render.

/// Installs the breaker, ARMED.
///
/// Separate from `create` because the treasury is already published and cannot
/// gain a field. Until this runs, `breaker_ready` is false and the payment
/// paths behave exactly as they did before this phase — see
/// `assert_autonomy_allowed` for why absence permits rather than refuses.
public fun init_breaker<T>(treasury: &mut Treasury<T>, cap: &TreasuryOwnerCap, ctx: &TxContext) {
    assert_owner(treasury, cap);
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) {
        df::add(
            &mut treasury.id,
            CircuitBreakerKey {},
            CircuitBreaker {
                mode: MODE_NORMAL,
                anomaly_score: 0,
                reason_code: b"".to_string(),
                tripped_at_ms: 0,
                tripped_by: ctx.sender(),
                trip_count: 0,
                reset_at_ms: 0,
            },
        );
    };
}

/// Whether the breaker has been installed.
public fun breaker_ready<T>(treasury: &Treasury<T>): bool {
    df::exists(&treasury.id, CircuitBreakerKey {})
}

/// The current mode. NORMAL when the breaker is not installed.
public fun breaker_mode<T>(treasury: &Treasury<T>): u8 {
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) return MODE_NORMAL;
    let breaker: &CircuitBreaker = df::borrow(&treasury.id, CircuitBreakerKey {});
    breaker.mode
}

public fun breaker_human_only<T>(treasury: &Treasury<T>): bool {
    breaker_mode(treasury) == MODE_HUMAN_ONLY
}

public fun breaker_score<T>(treasury: &Treasury<T>): u8 {
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) return 0;
    let breaker: &CircuitBreaker = df::borrow(&treasury.id, CircuitBreakerKey {});
    breaker.anomaly_score
}

public fun breaker_reason<T>(treasury: &Treasury<T>): String {
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) return b"".to_string();
    let breaker: &CircuitBreaker = df::borrow(&treasury.id, CircuitBreakerKey {});
    breaker.reason_code
}

public fun breaker_tripped_at_ms<T>(treasury: &Treasury<T>): u64 {
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) return 0;
    let breaker: &CircuitBreaker = df::borrow(&treasury.id, CircuitBreakerKey {});
    breaker.tripped_at_ms
}

public fun breaker_trip_count<T>(treasury: &Treasury<T>): u64 {
    if (!df::exists(&treasury.id, CircuitBreakerKey {})) return 0;
    let breaker: &CircuitBreaker = df::borrow(&treasury.id, CircuitBreakerKey {});
    breaker.trip_count
}

/// THE GATE. Every autonomous and conditional path calls this.
///
/// Fails CLOSED once installed and OPEN while absent, and the asymmetry is
/// deliberate. Treating "not installed" as HUMAN_ONLY would mean the package
/// upgrade itself froze the treasury before anyone armed anything — a change in
/// behaviour nobody asked for, arriving at the moment least expected. Absence
/// is only reachable before installation, because no function in this module
/// removes the field.
public fun assert_autonomy_allowed<T>(treasury: &Treasury<T>) {
    assert!(breaker_mode(treasury) != MODE_HUMAN_ONLY, ECircuitBreakerActive);
}

/// Freezes autonomy.
///
/// REQUIRES THE OWNER CAPABILITY, and that is the answer to "can the anomaly
/// engine trip this by itself": no. The engine produces a score and a reason,
/// and a holder of the cap decides whether to act on them. Making the trip
/// permissionless would hand every passer-by a treasury freeze; making it
/// automatic would put a model's output directly in charge of the chain, which
/// is the exact architecture this phase exists to avoid.
///
/// Idempotent, so a second trip while already frozen records the new evidence
/// without pretending it is a new event.
public fun trip_breaker<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    anomaly_score: u8,
    reason_code: String,
    now_ms: u64,
    ctx: &TxContext,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, CircuitBreakerKey {}), EBreakerNotReady);

    let sender = ctx.sender();
    let breaker: &mut CircuitBreaker = df::borrow_mut(&mut treasury.id, CircuitBreakerKey {});
    let already = breaker.mode == MODE_HUMAN_ONLY;

    breaker.mode = MODE_HUMAN_ONLY;
    breaker.anomaly_score = anomaly_score;
    breaker.reason_code = reason_code;
    breaker.tripped_at_ms = now_ms;
    breaker.tripped_by = sender;
    if (!already) {
        breaker.trip_count = breaker.trip_count + 1;
    };
}

/// Restores autonomy. STRICTLY HARDER THAN TRIPPING.
///
/// Takes the owner capability AND requires a named human who holds a live,
/// membership-verified approver authorization on this treasury — the Phase 1
/// record, with its enabled flag, its expiry, its company binding and its
/// membership freshness all re-checked here through `approver_can_authorize`.
///
/// The asymmetry is the point. Restricting the treasury needs one signature;
/// releasing it needs a signature AND a person the company still vouches for.
/// An operator whose Chain-Doi membership has been revoked, whose authorization
/// has expired, or whose membership reading has gone stale cannot un-freeze the
/// treasury, and neither can any amount of AI output.
public fun reset_breaker<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    recovering_approver: address,
    now_ms: u64,
) {
    assert_owner(treasury, cap);
    assert!(df::exists(&treasury.id, CircuitBreakerKey {}), EBreakerNotReady);

    // Read BEFORE the mutable borrow: the authorization is another dynamic
    // field on the same UID, and borrowing the breaker first would lock it.
    assert!(approver_in_good_standing(treasury, recovering_approver, now_ms), ENoHumanRecovery);

    let breaker: &mut CircuitBreaker = df::borrow_mut(&mut treasury.id, CircuitBreakerKey {});
    breaker.mode = MODE_NORMAL;
    breaker.reset_at_ms = now_ms;
}

// --- Test support ------------------------------------------------------------

#[test_only]
public fun destroy_cap_for_testing(cap: TreasuryOwnerCap) {
    let TreasuryOwnerCap { id, treasury_id: _ } = cap;
    id.delete();
}
