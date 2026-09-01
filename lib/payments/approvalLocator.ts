/**
 * Finds the `HumanApproval` object on chain, or reports that there is none.
 *
 * THE CLAIM THIS EXISTS TO GOVERN. The interface may say "cleared for
 * execution" only when a real, live, unconsumed `HumanApproval` for THIS
 * invoice exists on Sui. Before this module the screen said it on the strength
 * of a TypeScript policy mirror having returned APPROVED — a forecast, made
 * without any approval having been minted, signed or submitted.
 *
 * So the question is asked of the chain: is there an object, what does it say,
 * and is it still spendable.
 *
 * NOT THE SECURITY BOUNDARY. `approval::limits_for` re-judges every one of
 * these conditions inside `payment::execute_approved`, and re-asks the treasury
 * whether the approver is STILL authorised — something that cannot be read off
 * the approval object at all. What is computed here decides what the interface
 * may CLAIM and which control it may offer; Move decides what settles.
 */

import type { SuiNetwork } from "../sui/deployment";
import { graphqlUrlFor } from "../sui/client";
import { unitsToCents } from "../sui/units";

interface ApprovalNode {
  address?: string;
  asMoveObject?: { contents?: { json?: Record<string, unknown> } };
}

export interface OnChainApproval {
  objectId: string;
  invoiceNumber: string;
  /** Base units, as the chain holds them. */
  amount: string;
  amountCents: number;
  recipient: string;
  approver: string;
  treasuryId: string;
  expiresAtMs: number;
  consumed: boolean;
}

export interface ApprovalLiveness {
  /** Every condition readable from the object itself is satisfied. */
  live: boolean;
  /** Which one failed, when one did. Null when live. */
  reason: string | null;
}

/**
 * Reads every `HumanApproval` and returns the ones for this invoice number.
 *
 * The TYPE package is the original publish, not the upgraded one: Move type
 * identity is fixed at the address that first defined the struct, so an
 * upgraded package id here matches nothing and would report "no approval
 * exists" about an approval that does.
 */
export async function locateApprovals(
  network: SuiNetwork,
  typePackageId: string,
  invoiceNumber: string,
): Promise<OnChainApproval[]> {
  const query = `{
    objects(filter: {type: "${typePackageId}::approval::HumanApproval"}) {
      nodes { address asMoveObject { contents { json } } }
    }
  }`;

  const response = await fetch(graphqlUrlFor(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`The chain could not be read (HTTP ${response.status}).`);
  }

  const body = (await response.json()) as {
    data?: { objects?: { nodes?: ApprovalNode[] } };
  };

  const wanted = invoiceNumber.trim().toUpperCase();
  const found: OnChainApproval[] = [];

  for (const node of body.data?.objects?.nodes ?? []) {
    const fields = node.asMoveObject?.contents?.json;
    if (!fields || typeof node.address !== "string") continue;
    if (String(fields.invoice_number ?? "").toUpperCase() !== wanted) continue;

    const amount = String(fields.amount ?? "0");
    found.push({
      objectId: node.address,
      invoiceNumber: String(fields.invoice_number),
      amount,
      amountCents: unitsToCents(amount),
      recipient: String(fields.recipient ?? ""),
      approver: String(fields.approver ?? ""),
      treasuryId: String(fields.treasury_id ?? ""),
      expiresAtMs: Number(fields.expires_at_ms ?? 0),
      consumed: Boolean(fields.consumed),
    });
  }

  return found;
}

/**
 * Whether an approval object is still spendable, from what the object says.
 *
 * Mirrors the object-readable half of `approval::limits_for`. The treasury half
 * — is this approver still authorised, still a member, still inside their daily
 * budget — is deliberately NOT guessed at here; it is re-asked by Move, and a
 * caller that wants a preview of it should dry-run the execution rather than
 * re-implement the rule.
 */
export function judgeApproval(
  approval: OnChainApproval,
  treasuryId: string,
  nowMs: number,
): ApprovalLiveness {
  if (approval.consumed) {
    return { live: false, reason: "This approval has already been spent on a payment." };
  }
  if (!sameId(approval.treasuryId, treasuryId)) {
    return { live: false, reason: "This approval was minted against a different treasury." };
  }
  if (nowMs > approval.expiresAtMs) {
    return { live: false, reason: "This approval has expired and authorizes nothing." };
  }
  return { live: true, reason: null };
}

/**
 * The one approval that may be executed for this invoice, or null.
 *
 * Where several exist — a second approval minted after a first went unused —
 * the one expiring LAST is chosen, because it is the one that will still be
 * live by the time a settlement lands.
 */
export function liveApproval(
  approvals: readonly OnChainApproval[],
  treasuryId: string,
  nowMs: number,
): OnChainApproval | null {
  const live = approvals.filter((entry) => judgeApproval(entry, treasuryId, nowMs).live);
  if (live.length === 0) return null;
  return live.reduce((best, entry) => (entry.expiresAtMs > best.expiresAtMs ? entry : best));
}

function sameId(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
  return normalize(a) === normalize(b);
}
