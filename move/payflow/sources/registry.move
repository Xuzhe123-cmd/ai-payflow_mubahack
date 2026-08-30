/// The approved-supplier register.
///
/// Shared, because `evaluate` reads it on every payment; written only by a
/// holder of the treasury's owner capability. This is the authority on who may
/// be paid and at which address — the invoice is merely a claim, and the two
/// disagreeing is exactly what check 4 exists to catch.
///
/// Suppliers are `store` structs inside one table rather than objects of their
/// own: they are only ever reached by a `supplier_id` lookup, so a table gives
/// the exact access shape with one shared object instead of N.
module payflow::registry;

use std::string::String;
use sui::table::{Self, Table};
use payflow::treasury::{Self, TreasuryOwnerCap};

const EWrongTreasury: u64 = 200;
const ESupplierNotFound: u64 = 201;

const STATUS_PENDING: u8 = 0;
const STATUS_APPROVED: u8 = 1;
const STATUS_REVOKED: u8 = 2;

public struct Supplier has store {
    name: String,
    registered_wallet: address,
    status: u8,
}

public struct SupplierRegistry has key {
    id: UID,
    treasury_id: ID,
    suppliers: Table<String, Supplier>,
}

public fun create(cap: &TreasuryOwnerCap, ctx: &mut TxContext) {
    transfer::share_object(SupplierRegistry {
        id: object::new(ctx),
        treasury_id: treasury::cap_treasury_id(cap),
        suppliers: table::new(ctx),
    });
}

fun assert_owner(registry: &SupplierRegistry, cap: &TreasuryOwnerCap) {
    assert!(treasury::cap_treasury_id(cap) == registry.treasury_id, EWrongTreasury);
}

// --- Administration (owner capability required) ------------------------------

public fun upsert(
    registry: &mut SupplierRegistry,
    cap: &TreasuryOwnerCap,
    supplier_id: String,
    name: String,
    registered_wallet: address,
    status: u8,
) {
    assert_owner(registry, cap);
    if (registry.suppliers.contains(supplier_id)) {
        let supplier = registry.suppliers.borrow_mut(supplier_id);
        supplier.name = name;
        supplier.registered_wallet = registered_wallet;
        supplier.status = status;
    } else {
        registry.suppliers.add(supplier_id, Supplier { name, registered_wallet, status });
    };
}

public fun set_status(
    registry: &mut SupplierRegistry,
    cap: &TreasuryOwnerCap,
    supplier_id: String,
    status: u8,
) {
    assert_owner(registry, cap);
    assert!(registry.suppliers.contains(supplier_id), ESupplierNotFound);
    registry.suppliers.borrow_mut(supplier_id).status = status;
}

public fun set_wallet(
    registry: &mut SupplierRegistry,
    cap: &TreasuryOwnerCap,
    supplier_id: String,
    registered_wallet: address,
) {
    assert_owner(registry, cap);
    assert!(registry.suppliers.contains(supplier_id), ESupplierNotFound);
    registry.suppliers.borrow_mut(supplier_id).registered_wallet = registered_wallet;
}

// --- Reads -------------------------------------------------------------------
//
// Deliberately non-aborting where `evaluate` uses them: an unknown supplier has
// to come back as "not approved" so the report can show a failed check, rather
// than aborting and denying the interface any detail at all.

public fun contains(registry: &SupplierRegistry, supplier_id: &String): bool {
    registry.suppliers.contains(*supplier_id)
}

public fun is_approved(registry: &SupplierRegistry, supplier_id: &String): bool {
    if (!registry.suppliers.contains(*supplier_id)) return false;
    registry.suppliers.borrow(*supplier_id).status == STATUS_APPROVED
}

public fun wallet_matches(
    registry: &SupplierRegistry,
    supplier_id: &String,
    candidate: address,
): bool {
    if (!registry.suppliers.contains(*supplier_id)) return false;
    registry.suppliers.borrow(*supplier_id).registered_wallet == candidate
}

public fun status(registry: &SupplierRegistry, supplier_id: &String): u8 {
    assert!(registry.suppliers.contains(*supplier_id), ESupplierNotFound);
    registry.suppliers.borrow(*supplier_id).status
}

public fun registered_wallet(registry: &SupplierRegistry, supplier_id: &String): address {
    assert!(registry.suppliers.contains(*supplier_id), ESupplierNotFound);
    registry.suppliers.borrow(*supplier_id).registered_wallet
}

public fun treasury_id(registry: &SupplierRegistry): ID { registry.treasury_id }

public fun status_pending(): u8 { STATUS_PENDING }

public fun status_approved(): u8 { STATUS_APPROVED }

public fun status_revoked(): u8 { STATUS_REVOKED }
