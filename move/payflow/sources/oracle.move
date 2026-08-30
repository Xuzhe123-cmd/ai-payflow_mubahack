/// The shipment oracle: who may attest a real-world condition, and what an
/// attestation is.
///
/// This module holds no funds and has no access to any. It cannot reach
/// `treasury::split_vault`, it defines no function taking a `Balance` or a
/// `Coin`, and nothing here transfers anything. That is the entire security
/// argument for the oracle: it states a fact, and `escrow` decides what that
/// fact is worth.
///
/// An attestation is FROZEN on creation. Evidence that could be edited after
/// the fact is not evidence, and freezing makes that true at the protocol level
/// rather than by convention.
///
/// HONESTY: the attesting party in this build is a controlled hackathon oracle
/// — a "Demo Shipment Oracle". It is not a carrier integration, and nothing in
/// this package claims otherwise. Swapping in a real feed means changing who
/// holds the `OracleCap`, not changing anything here.
module payflow::oracle;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use payflow::treasury::{Self, Treasury, TreasuryOwnerCap};

const EWrongTreasury: u64 = 800;

/// Proves who may attest, and for which treasury. Owned, admin-issued, and
/// revocable the only way an owned capability can be: by the admin declining to
/// honour it — see `escrow`, which checks the attestation's treasury.
public struct OracleCap has key, store {
    id: UID,
    treasury_id: ID,
    /// Names the attesting party in the audit trail, e.g. "demo_shipment_oracle".
    oracle_id: String,
}

/// One statement about one shipment, frozen on creation.
///
/// `confirmed` is the only field `escrow::release` acts on. Everything else is
/// audit detail — including `ai_assessment`, which is advisory prose and is
/// deliberately never read by any function that moves money.
public struct ShipmentAttestation has key {
    id: UID,
    treasury_id: ID,
    invoice_number: String,
    shipment_id: String,
    confirmed: bool,
    /// Where the proof document lives — a Walrus blob id in the wired-up build.
    proof_blob_id: String,
    /// SHA-256 of the document bytes. This is what makes the reference
    /// verifiable independently of whether the blob is still retrievable.
    proof_sha256: vector<u8>,
    delivered_at_ms: u64,
    oracle_id: String,
    attested_by: address,
    attested_at_ms: u64,
    /// An old confirmation is not standing permission, for the same reason an
    /// old recommendation is not — see check 10 in `payment`.
    expires_at_ms: u64,
    /// ADVISORY ONLY. Whatever a model extracted from the document. No function
    /// in this package branches on it.
    ai_assessment: Option<String>,
}

public struct ShipmentAttested has copy, drop {
    attestation_id: ID,
    treasury_id: ID,
    invoice_number: String,
    confirmed: bool,
    oracle_id: String,
    attested_at_ms: u64,
}

// --- Issuing an oracle -------------------------------------------------------

public fun issue<T>(
    treasury: &Treasury<T>,
    cap: &TreasuryOwnerCap,
    oracle_id: String,
    ctx: &mut TxContext,
): OracleCap {
    treasury::assert_owner(treasury, cap);
    OracleCap { id: object::new(ctx), treasury_id: object::id(treasury), oracle_id }
}

#[allow(lint(self_transfer))]
public fun issue_to<T>(
    treasury: &Treasury<T>,
    cap: &TreasuryOwnerCap,
    oracle_id: String,
    recipient: address,
    ctx: &mut TxContext,
) {
    let oracle = issue(treasury, cap, oracle_id, ctx);
    transfer::public_transfer(oracle, recipient);
}

// --- Attesting ---------------------------------------------------------------

/// States whether a shipment is confirmed, and freezes the statement.
///
/// Requires an `OracleCap`, so an arbitrary sender cannot manufacture one. The
/// treasury is copied from the capability rather than accepted as an argument,
/// which is what stops an oracle for one treasury attesting against another.
///
/// A `confirmed: false` attestation is a legitimate and useful thing to make —
/// it records that the oracle looked and the shipment was not there. It cannot
/// release anything.
public fun attest(
    cap: &OracleCap,
    invoice_number: String,
    shipment_id: String,
    confirmed: bool,
    proof_blob_id: String,
    proof_sha256: vector<u8>,
    delivered_at_ms: u64,
    valid_for_ms: u64,
    ai_assessment: Option<String>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let now = clock::timestamp_ms(clock);
    let id = object::new(ctx);
    let attestation_id = object::uid_to_inner(&id);

    event::emit(ShipmentAttested {
        attestation_id,
        treasury_id: cap.treasury_id,
        invoice_number,
        confirmed,
        oracle_id: cap.oracle_id,
        attested_at_ms: now,
    });

    transfer::freeze_object(ShipmentAttestation {
        id,
        treasury_id: cap.treasury_id,
        invoice_number,
        shipment_id,
        confirmed,
        proof_blob_id,
        proof_sha256,
        delivered_at_ms,
        oracle_id: cap.oracle_id,
        attested_by: ctx.sender(),
        attested_at_ms: now,
        expires_at_ms: now + valid_for_ms,
        ai_assessment,
    });

    attestation_id
}

/// Guards against an attestation issued for a different treasury being used
/// here. `escrow` calls this before honouring one.
public fun assert_treasury<T>(att: &ShipmentAttestation, treasury: &Treasury<T>) {
    assert!(att.treasury_id == object::id(treasury), EWrongTreasury);
}

// --- Reads -------------------------------------------------------------------

public fun cap_treasury_id(cap: &OracleCap): ID { cap.treasury_id }

public fun cap_oracle_id(cap: &OracleCap): String { cap.oracle_id }

public fun treasury_id(att: &ShipmentAttestation): ID { att.treasury_id }

public fun invoice_number(att: &ShipmentAttestation): String { att.invoice_number }

public fun shipment_id(att: &ShipmentAttestation): String { att.shipment_id }

public fun confirmed(att: &ShipmentAttestation): bool { att.confirmed }

public fun proof_blob_id(att: &ShipmentAttestation): String { att.proof_blob_id }

public fun proof_sha256(att: &ShipmentAttestation): &vector<u8> { &att.proof_sha256 }

public fun delivered_at_ms(att: &ShipmentAttestation): u64 { att.delivered_at_ms }

public fun oracle_id(att: &ShipmentAttestation): String { att.oracle_id }

public fun attested_by(att: &ShipmentAttestation): address { att.attested_by }

public fun attested_at_ms(att: &ShipmentAttestation): u64 { att.attested_at_ms }

public fun expires_at_ms(att: &ShipmentAttestation): u64 { att.expires_at_ms }

/// Readable for display and audit. Nothing in this package branches on it.
public fun ai_assessment(att: &ShipmentAttestation): &Option<String> { &att.ai_assessment }
