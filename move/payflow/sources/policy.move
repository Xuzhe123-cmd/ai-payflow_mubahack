/// The company's hard financial policy.
///
/// Stored by value inside the Treasury rather than as its own object: it has no
/// independent lifecycle, and holding it inline makes "read the policy" a
/// single object fetch.
///
/// Every mutator here is `public(package)`. The only callers are the admin
/// entry points in `treasury`, each of which demands a `TreasuryOwnerCap`
/// first. There is deliberately no path from an `AgentCap` to any function in
/// this module — that is Invariant 1, and it is enforced by visibility rather
/// than by a runtime check.
module payflow::policy;

use std::string::{Self, String};
use std::type_name;

public struct TreasuryPolicy has store {
    /// Cash that must remain in the vault after any payment.
    min_reserve: u64,
    /// Above this, the agent's own capability is not sufficient authority.
    human_approval_threshold: u64,
    auto_pay_enabled: bool,
    /// Currency codes an invoice may be denominated in, e.g. b"USD".
    allowed_currencies: vector<String>,
    /// Fully-qualified coin types the treasury may settle in.
    allowed_coin_types: vector<String>,
    /// How stale a recommendation may be before the chain refuses to act on it.
    max_recommendation_age_ms: u64,
}

public(package) fun new(
    min_reserve: u64,
    human_approval_threshold: u64,
    auto_pay_enabled: bool,
    allowed_currencies: vector<String>,
    allowed_coin_types: vector<String>,
    max_recommendation_age_ms: u64,
): TreasuryPolicy {
    TreasuryPolicy {
        min_reserve,
        human_approval_threshold,
        auto_pay_enabled,
        allowed_currencies,
        allowed_coin_types,
        max_recommendation_age_ms,
    }
}

// --- Reads: open to anyone, including the agent ------------------------------

public fun min_reserve(self: &TreasuryPolicy): u64 { self.min_reserve }

public fun human_approval_threshold(self: &TreasuryPolicy): u64 {
    self.human_approval_threshold
}

public fun auto_pay_enabled(self: &TreasuryPolicy): bool { self.auto_pay_enabled }

public fun max_recommendation_age_ms(self: &TreasuryPolicy): u64 {
    self.max_recommendation_age_ms
}

public fun currency_allowed(self: &TreasuryPolicy, currency: &String): bool {
    self.allowed_currencies.contains(currency)
}

public fun coin_type_allowed(self: &TreasuryPolicy, coin_type: &String): bool {
    self.allowed_coin_types.contains(coin_type)
}

/// The canonical name of a coin type, as check 7 compares it.
///
/// Deliberately computed on chain rather than assembled off it. The string
/// embeds the package address, which does not exist until the moment of
/// publish, so a deployment script that tried to spell it out would be guessing
/// at a format — and getting it subtly wrong would allowlist nothing, leaving
/// every payment to fail check 7 for a reason nobody could see.
public fun coin_type_of<T>(): String {
    string::from_ascii(type_name::into_string(type_name::with_defining_ids<T>()))
}

// --- Writes: package-only, and every caller holds a TreasuryOwnerCap ---------

public(package) fun set_min_reserve(self: &mut TreasuryPolicy, value: u64) {
    self.min_reserve = value;
}

public(package) fun set_human_approval_threshold(self: &mut TreasuryPolicy, value: u64) {
    self.human_approval_threshold = value;
}

public(package) fun set_auto_pay_enabled(self: &mut TreasuryPolicy, value: bool) {
    self.auto_pay_enabled = value;
}

public(package) fun set_max_recommendation_age_ms(self: &mut TreasuryPolicy, value: u64) {
    self.max_recommendation_age_ms = value;
}

public(package) fun add_allowed_currency(self: &mut TreasuryPolicy, currency: String) {
    if (!self.allowed_currencies.contains(&currency)) {
        self.allowed_currencies.push_back(currency);
    }
}

public(package) fun add_allowed_coin_type(self: &mut TreasuryPolicy, coin_type: String) {
    if (!self.allowed_coin_types.contains(&coin_type)) {
        self.allowed_coin_types.push_back(coin_type);
    }
}
