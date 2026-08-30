/// A demo settlement stablecoin, six decimals, minted by this package.
///
/// The treasury and payment modules are generic over `Coin<T>`, so nothing in
/// the enforcement path knows or cares that this is the coin in use — swapping
/// in real USDC is a type argument, not a code change. This exists so the demo
/// vault can be funded to an exact figure without depending on a faucet.
///
/// Testnet only. It has no value and the mint capability stays with the
/// publisher.
/// `coin::create_currency` is deprecated in favour of the coin registry. It is
/// kept here deliberately: this is a throwaway demo coin, and the simpler API
/// keeps the module small enough to read at a glance. Nothing in the
/// enforcement path depends on it.
#[allow(deprecated_usage)]
module payflow::mock_usdc;

use sui::coin::{Self, TreasuryCap};

/// One-time witness. Must match the module name in upper case.
public struct MOCK_USDC has drop {}

fun init(witness: MOCK_USDC, ctx: &mut TxContext) {
    let (treasury_cap, metadata) = coin::create_currency(
        witness,
        6,
        b"MUSDC",
        b"PayFlow Mock USDC",
        b"Demo settlement coin for AI PayFlow. Testnet only, no value.",
        option::none(),
        ctx,
    );
    // Metadata is immutable; the mint capability goes to the publisher.
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury_cap, ctx.sender());
}

public fun mint(
    cap: &mut TreasuryCap<MOCK_USDC>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    coin::mint_and_transfer(cap, amount, recipient, ctx);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(MOCK_USDC {}, ctx);
}
