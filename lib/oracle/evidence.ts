/**
 * When evidence counts as an oracle confirmation, and when it does not.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a proof document is not a verification. A
 * PDF that says DELIVERED proves that someone wrote DELIVERED in a PDF. What
 * makes a shipment confirmed is an attestation recorded on chain by the oracle,
 * saying confirmed, about THIS invoice and THIS shipment, carrying the digest
 * the document actually hashes to. Every clause is load-bearing:
 *
 *   - no attestation      → the document has been read by nobody
 *   - confirmed = false   → the oracle looked and did not confirm
 *   - other invoice/ship  → an attestation about something else
 *   - digest disagrees    → the attested document is not the one on file
 *
 * Kept pure and in one place because two surfaces render it — the invoice
 * detail page and the escrow page — and if they derived it separately they
 * would eventually disagree, which for this claim means showing "Verified by
 * Oracle" over evidence that verifies nothing.
 *
 * Note what is NOT here: releasing funds. The oracle attests; Sui enforces.
 * This function decides what a screen may say, never what a payment may do.
 */

import type { ShipmentAttestation, ShipmentProof } from "./shipment";

export type EvidenceVerdict =
  /** No document has been submitted. */
  | "NO_PROOF"
  /** A document exists and nothing has attested to it. */
  | "AWAITING_ATTESTATION"
  /** Attested, and about a different invoice or a different shipment. */
  | "SUBJECT_MISMATCH"
  /** Attested about the right subject, and the digest does not match. */
  | "HASH_MISMATCH"
  /** The oracle read it and did not confirm the delivery. */
  | "NOT_CONFIRMED"
  /** Every clause satisfied. The only verdict that may be called verified. */
  | "CONFIRMED";

export interface EvidenceInput {
  invoiceNumber: string;
  proof: ShipmentProof | null;
  attestation: ShipmentAttestation | null;
}

export interface ShipmentEvidenceResult {
  verdict: EvidenceVerdict;
  /** The single question a UI should ask. Never widen this to a truthy check. */
  confirmed: boolean;
  /** True only when a digest comparison was possible AND agreed. */
  hashMatches: boolean;
  /** Plain sentence for the screen, saying which clause failed. */
  detail: string;
}

export function evaluateShipmentEvidence(input: EvidenceInput): ShipmentEvidenceResult {
  const { proof, attestation, invoiceNumber } = input;

  if (!proof) {
    return {
      verdict: "NO_PROOF",
      confirmed: false,
      hashMatches: false,
      detail: "No delivery document has been submitted.",
    };
  }

  if (!attestation) {
    return {
      verdict: "AWAITING_ATTESTATION",
      confirmed: false,
      hashMatches: false,
      detail:
        "A proof document exists and nothing has attested to it. Evidence on its own does not " +
        "confirm a shipment.",
    };
  }

  // Checked before the digest, because an attestation about another shipment is
  // wrong regardless of what it hashes.
  if (attestation.invoiceNumber !== invoiceNumber || attestation.shipmentId !== proof.shipmentId) {
    return {
      verdict: "SUBJECT_MISMATCH",
      confirmed: false,
      hashMatches: false,
      detail: "The attestation on chain refers to a different invoice or shipment.",
    };
  }

  const hashMatches = attestation.proofSha256 === proof.sha256;
  if (!hashMatches) {
    return {
      verdict: "HASH_MISMATCH",
      confirmed: false,
      hashMatches: false,
      detail:
        "The document on file does not hash to the digest the oracle attested. It is not the " +
        "document that was verified.",
    };
  }

  if (!attestation.confirmed) {
    return {
      verdict: "NOT_CONFIRMED",
      confirmed: false,
      hashMatches: true,
      detail: "The oracle read this document and did not confirm the delivery.",
    };
  }

  return {
    verdict: "CONFIRMED",
    confirmed: true,
    hashMatches: true,
    detail:
      "The oracle attested this exact document on chain, for this invoice and this shipment.",
  };
}

/**
 * The badge over the evidence, saying only what was actually established.
 *
 * "Verified on chain" is banned here, and the ban is the point. The chain can
 * establish that an escrow exists, that it is LOCKED or RELEASED, that an
 * attestation is present, that it says confirmed, and that its digest matches
 * the document on file. It cannot establish that a lorry arrived. Putting
 * "Verified on chain" over an unconfirmed shipment — on the grounds that the
 * escrow object is real — claims the one thing the chain never checked.
 *
 * So the badge names the ORACLE's state, and the three cases stay apart:
 *
 *   ORACLE CONFIRMED        an attestation confirms this exact document
 *   ORACLE WAITING          nothing has attested yet. Not a failure.
 *   SHIPMENT NOT CONFIRMED  something attested, and it did not confirm
 */
export type EvidenceBadge = "ORACLE CONFIRMED" | "ORACLE WAITING" | "SHIPMENT NOT CONFIRMED";

export function evidenceBadge(verdict: EvidenceVerdict): EvidenceBadge {
  switch (verdict) {
    case "CONFIRMED":
      return "ORACLE CONFIRMED";
    // Nothing has attested. The oracle has not declined — it has not spoken.
    case "NO_PROOF":
    case "AWAITING_ATTESTATION":
      return "ORACLE WAITING";
    // An attestation exists and does not confirm THIS document. A real answer,
    // and a negative one.
    case "SUBJECT_MISMATCH":
    case "HASH_MISMATCH":
    case "NOT_CONFIRMED":
      return "SHIPMENT NOT CONFIRMED";
  }
}

/** The word in the "Oracle status" row. The same three cases, shorter. */
export function oracleStatusWord(verdict: EvidenceVerdict): string {
  switch (verdict) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "NO_PROOF":
    case "AWAITING_ATTESTATION":
      return "WAITING";
    case "SUBJECT_MISMATCH":
    case "HASH_MISMATCH":
    case "NOT_CONFIRMED":
      return "NOT CONFIRMED";
  }
}

/**
 * The evidence as rows on screen, in the order a reader needs them.
 *
 * The order IS the argument: the document, then what it hashes to, then who
 * attested to that hash. Read top to bottom it walks the chain of custody from
 * a PDF to an on-chain claim about that exact PDF.
 *
 * Two shapes, because a confirmed shipment and an unconfirmed one are not the
 * same story with a different word at the top. A confirmed one has a digest
 * that was actually compared; an unconfirmed one has nothing to compare it to,
 * and printing a hash beside "WAITING" invites the reader to assume it was
 * checked. So the digest appears only where a comparison happened.
 *
 * Pure, and driven entirely by the state passed in — there is no invoice number
 * anywhere in here, and there must never be one.
 */
export interface EvidenceRow {
  label: string;
  value: string;
  tone: "default" | "positive" | "warning";
  mono?: boolean;
}

export interface EvidenceRowsInput extends EvidenceInput {
  oracleName: string;
  attestationId: string | null;
}

/**
 * Note what this input does NOT carry: escrow status, held funds, released.
 *
 * Those answer what SUI did about the money, and they live in
 * `chainSettlementSummary`. They used to be rows in this list, which is how a
 * settlement state came to be read as an oracle result. The rows below describe
 * evidence; nothing here can see the escrow.
 */

export function shipmentEvidenceRows(input: EvidenceRowsInput): EvidenceRow[] {
  const { proof, attestation } = input;
  const evidence = evaluateShipmentEvidence(input);

  const rows: EvidenceRow[] = [
    {
      label: "Shipment proof",
      value: proof?.shipmentId ?? "NONE",
      tone: proof ? "default" : "warning",
    },
    {
      label: "Shipment status",
      value: proof?.deliveryStatus ?? "UNKNOWN",
      tone: proof?.deliveryStatus === "DELIVERED" ? "positive" : "warning",
    },
  ];

  // Only where the document actually carries one. A shipment still in transit
  // has no delivery date, and a row reading "—" is worse than no row.
  if (proof?.deliveredAt) {
    rows.push({ label: "Delivery date", value: proof.deliveredAt, tone: "default" });
  }

  rows.push({
    label: "Proof document",
    value: proof?.filename ?? "NONE",
    tone: proof ? "default" : "warning",
  });

  if (evidence.confirmed) {
    // The digest is shown where — and only where — it was compared against an
    // attestation. Elsewhere it reads as a check that did not happen.
    rows.push({
      label: "SHA-256",
      value: proof?.sha256 ?? "—",
      tone: "default",
      mono: true,
    });
  }

  rows.push({ label: "Oracle", value: input.oracleName, tone: "default" });
  rows.push({
    label: "Oracle status",
    value: oracleStatusWord(evidence.verdict),
    tone: evidence.confirmed ? "positive" : "warning",
  });
  rows.push({
    label: "Attestation",
    value: attestation ? (input.attestationId ?? "RECORDED") : "NONE",
    tone: attestation && evidence.confirmed ? "positive" : "warning",
    mono: attestation !== null,
  });

  return rows;
}

/**
 * What the evidence establishes, as ticks — and what it does not.
 *
 * Separate from the rows because a row carries a VALUE and these are CLAIMS.
 * Each is something a reader would otherwise have to derive by comparing two
 * rows themselves, and each is false unless the shared rule above says so.
 */
export interface EvidenceCheck {
  label: string;
  ok: boolean;
}

export interface EvidenceConclusion {
  ok: boolean;
  /** The line in the panel's own voice. */
  headline: string;
  detail: string;
  checks: EvidenceCheck[];
}

export function evidenceConclusion(
  input: EvidenceInput & { released: boolean },
): EvidenceConclusion {
  const evidence = evaluateShipmentEvidence(input);

  if (evidence.confirmed) {
    return {
      ok: true,
      headline: "Shipment confirmed",
      detail: evidence.detail,
      checks: [
        { label: "Proof hash matches attestation", ok: true },
        { label: "Shipment confirmed", ok: true },
        { label: "Escrow condition satisfied", ok: true },
        {
          label: input.released ? "Payment released" : "Payment not yet released",
          ok: input.released,
        },
      ],
    };
  }

  // Nothing has attested. "Pending" rather than "failed": the oracle has not
  // declined anything, and a proof document on its own confirms nothing.
  if (evidence.verdict === "NO_PROOF" || evidence.verdict === "AWAITING_ATTESTATION") {
    return {
      ok: false,
      headline: "Shipment confirmation pending",
      detail:
        evidence.verdict === "NO_PROOF"
          ? "No delivery document has been submitted. No confirmed oracle attestation exists."
          : "Proof available — not yet confirmed by oracle. No confirmed oracle attestation exists.",
      checks: [
        { label: "No confirmed oracle attestation exists", ok: false },
        { label: "Escrow condition not satisfied", ok: false },
      ],
    };
  }

  // An attestation exists and does not confirm this document. A real negative,
  // and it must say which clause failed rather than reading as silence.
  return {
    ok: false,
    headline: "Shipment not confirmed",
    detail: evidence.detail,
    checks: [
      {
        label:
          evidence.verdict === "HASH_MISMATCH"
            ? "Proof hash does not match the attestation"
            : "The attestation does not confirm this shipment",
        ok: false,
      },
      { label: "Escrow condition not satisfied", ok: false },
    ],
  };
}

/**
 * What the CHAIN did about the money, stated apart from the evidence.
 *
 * Deliberately its own block. The oracle attests and the escrow enforces, and
 * running the two together is exactly what let a settlement state be read as an
 * oracle result — an already-paid invoice reported as a discrepancy in the
 * evidence. This reports only what Sui holds.
 */
export interface ChainSettlementSummary {
  released: boolean;
  headline: string;
  amountLabel: string;
  detail: string;
}

export function chainSettlementSummary(input: {
  released: boolean;
  /** The released amount, or what the escrow still holds. */
  amountLabel: string;
}): ChainSettlementSummary {
  if (input.released) {
    return {
      released: true,
      headline: "Payment released",
      amountLabel: input.amountLabel,
      detail: "The escrow condition was satisfied and the funds reached the supplier.",
    };
  }

  return {
    released: false,
    headline: "Payment held in escrow",
    amountLabel: input.amountLabel,
    detail: `${input.amountLabel} remains locked. Supplier has not been paid.`,
  };
}
