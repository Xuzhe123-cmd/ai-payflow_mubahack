/// The AI agent's capability.
///
/// `AgentCap` is a bearer token and nothing more: it proves identity and names
/// the treasury it belongs to. It carries no limits, and it has no mutable
/// field at all.
///
/// That is deliberate, and it is the strongest form of Invariant 2. Limits
/// inside an object owned by the agent could never be lowered by the admin,
/// because in Sui only an object's owner may mutate it. Keeping the limits in
/// `Treasury.agents` — behind the owner capability — makes revoking or
/// re-limiting an agent a single admin transaction, and leaves the agent with
/// nothing it is able to rewrite.
module payflow::agent;

use std::string::String;
use sui::clock::{Self, Clock};
use payflow::limits::{Self, Limits};
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

public struct AgentCap has key, store {
    id: UID,
    treasury_id: ID,
    agent_id: String,
}

/// Mints the capability and registers its limits on the treasury. Requires the
/// owner capability, so an agent can never mint another agent.
public fun issue<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    agent_id: String,
    max_single: u64,
    daily_limit: u64,
    ctx: &mut TxContext,
): AgentCap {
    treasury::assert_owner(treasury, cap);

    let id = object::new(ctx);
    let cap_id = object::uid_to_inner(&id);
    treasury::register_agent(treasury, cap_id, max_single, daily_limit);

    AgentCap { id, treasury_id: object::id(treasury), agent_id }
}

#[allow(lint(self_transfer))]
public fun issue_to<T>(
    treasury: &mut Treasury<T>,
    cap: &TreasuryOwnerCap,
    agent_id: String,
    max_single: u64,
    daily_limit: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    let agent_cap = issue(treasury, cap, agent_id, max_single, daily_limit, ctx);
    transfer::public_transfer(agent_cap, recipient);
}

/// Builds the limits this agent is judged against.
///
/// Non-aborting by design. An unregistered or cross-treasury capability comes
/// back as unauthorized with zeroed limits rather than killing the transaction,
/// so `evaluate` can report a failed check 1 with detail instead of the
/// interface receiving nothing at all.
public fun limits_for<T>(treasury: &Treasury<T>, cap: &AgentCap, clock: &Clock): Limits {
    let cap_id = object::id(cap);
    let authorized =
        cap.treasury_id == object::id(treasury) && treasury::has_agent(treasury, cap_id);

    if (!authorized) {
        return limits::new_agent(false, false, 0, 0, 0)
    };

    limits::new_agent(
        true,
        treasury::agent_enabled(treasury, cap_id),
        treasury::agent_max_single(treasury, cap_id),
        treasury::agent_daily_limit(treasury, cap_id),
        treasury::agent_effective_spent(treasury, cap_id, clock::timestamp_ms(clock)),
    )
}

public fun cap_id(cap: &AgentCap): ID { object::id(cap) }

public fun treasury_id(cap: &AgentCap): ID { cap.treasury_id }

public fun agent_id(cap: &AgentCap): String { cap.agent_id }
