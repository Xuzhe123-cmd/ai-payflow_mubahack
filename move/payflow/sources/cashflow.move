/// Known future cash-flow events.
///
/// Move STORES these and protects who may write them; it does no forecasting
/// with them. Projecting a cash position across a horizon, comparing candidate
/// payment dates, and weighing an early-payment discount are all the AI layer's
/// work — and none of that reasoning is ever accepted back as proof that a
/// payment is safe. The chain's own liquidity question is far narrower: does
/// the vault still clear the minimum reserve after this transfer, right now.
module payflow::cashflow;

use std::string::String;
use payflow::treasury::{Self, TreasuryOwnerCap};

const EWrongTreasury: u64 = 400;
const EIndexOutOfBounds: u64 = 401;

const DIRECTION_INFLOW: u8 = 0;
const DIRECTION_OUTFLOW: u8 = 1;

public struct CashFlowEvent has store, copy, drop {
    /// ISO date. Read by the off-chain forecaster, never parsed on chain.
    date: String,
    direction: u8,
    amount: u64,
    description: String,
}

public struct CashFlowCalendar has key {
    id: UID,
    treasury_id: ID,
    /// A vector rather than a table: the demo calendar holds a handful of
    /// entries and is always read whole.
    events: vector<CashFlowEvent>,
}

public fun create(cap: &TreasuryOwnerCap, ctx: &mut TxContext) {
    transfer::share_object(CashFlowCalendar {
        id: object::new(ctx),
        treasury_id: treasury::cap_treasury_id(cap),
        events: vector[],
    });
}

fun assert_owner(calendar: &CashFlowCalendar, cap: &TreasuryOwnerCap) {
    assert!(treasury::cap_treasury_id(cap) == calendar.treasury_id, EWrongTreasury);
}

public fun add_event(
    calendar: &mut CashFlowCalendar,
    cap: &TreasuryOwnerCap,
    date: String,
    direction: u8,
    amount: u64,
    description: String,
) {
    assert_owner(calendar, cap);
    calendar.events.push_back(CashFlowEvent { date, direction, amount, description });
}

public fun remove_event(calendar: &mut CashFlowCalendar, cap: &TreasuryOwnerCap, index: u64) {
    assert_owner(calendar, cap);
    assert!(index < calendar.events.length(), EIndexOutOfBounds);
    calendar.events.remove(index);
}

// --- Reads -------------------------------------------------------------------

public fun event_count(calendar: &CashFlowCalendar): u64 { calendar.events.length() }

public fun events(calendar: &CashFlowCalendar): &vector<CashFlowEvent> { &calendar.events }

public fun event_at(calendar: &CashFlowCalendar, index: u64): &CashFlowEvent {
    assert!(index < calendar.events.length(), EIndexOutOfBounds);
    &calendar.events[index]
}

public fun event_date(event: &CashFlowEvent): String { event.date }

public fun event_direction(event: &CashFlowEvent): u8 { event.direction }

public fun event_amount(event: &CashFlowEvent): u64 { event.amount }

public fun event_description(event: &CashFlowEvent): String { event.description }

public fun treasury_id(calendar: &CashFlowCalendar): ID { calendar.treasury_id }

public fun direction_inflow(): u8 { DIRECTION_INFLOW }

public fun direction_outflow(): u8 { DIRECTION_OUTFLOW }
