/// The limits a payment is judged against, and which authority they came from.
///
/// This is the hinge of the whole enforcement design. `evaluate` implements the
/// ten checks exactly once, against a `Limits` value — and that value is built
/// either from an agent's authorization or from a human approval. One rule
/// body, two sources of authority, so a $30,000 human-approved payment and a
/// $3,000 autonomous one are judged by identical code.
///
/// A `Limits` cannot be constructed outside this package: `new` is
/// `public(package)`, so no caller can hand `evaluate` a set of limits it
/// invented for itself.
module payflow::limits;

/// The agent acting under its own capability.
const AUTHORITY_AGENT: u8 = 0;
/// A person acting under an approval that only an approver can create.
const AUTHORITY_HUMAN_APPROVAL: u8 = 1;

public struct Limits has copy, drop {
    authority: u8,
    authorized: bool,
    enabled: bool,
    max_single: u64,
    daily_limit: u64,
    /// Spend already committed in the current day bucket, after rollover.
    effective_spent: u64,
}

public(package) fun new_agent(
    authorized: bool,
    enabled: bool,
    max_single: u64,
    daily_limit: u64,
    effective_spent: u64,
): Limits {
    Limits {
        authority: AUTHORITY_AGENT,
        authorized,
        enabled,
        max_single,
        daily_limit,
        effective_spent,
    }
}

public(package) fun new_human_approval(
    enabled: bool,
    max_single: u64,
    daily_limit: u64,
    effective_spent: u64,
): Limits {
    Limits {
        authority: AUTHORITY_HUMAN_APPROVAL,
        // Reaching this constructor at all requires holding an approval, which
        // only an ApproverCap holder can mint. Authorization is therefore
        // established by possession, exactly as it is for the agent.
        authorized: true,
        enabled,
        max_single,
        daily_limit,
        effective_spent,
    }
}

public fun authority(self: &Limits): u8 { self.authority }

public fun is_agent(self: &Limits): bool { self.authority == AUTHORITY_AGENT }

public fun authorized(self: &Limits): bool { self.authorized }

public fun enabled(self: &Limits): bool { self.enabled }

public fun max_single(self: &Limits): u64 { self.max_single }

public fun daily_limit(self: &Limits): u64 { self.daily_limit }

public fun effective_spent(self: &Limits): u64 { self.effective_spent }

public fun authority_agent(): u8 { AUTHORITY_AGENT }

public fun authority_human_approval(): u8 { AUTHORITY_HUMAN_APPROVAL }
