/**
 * Submits `approval::approve_scoped` for real — or refuses, and says why.
 *
 * SERVER ONLY. It reaches the Sui CLI keystore.
 *
 * THE CONSTRAINT THAT SHAPES THIS FILE. `approve_scoped` reads `ctx.sender()`
 * and looks that address up in the treasury's approver table. The authority is
 * the SENDER's — that is what makes it revocable and what binds it to a
 * zkLogin identity rather than to a transferable object someone could hand on.
 *
 * So an approval can only be submitted by a signer that actually holds the
 * approver's key. This module checks that BEFORE attempting anything, because
 * the alternative failure is worse than useless: submitting as whoever the CLI
 * happens to have would abort with 602 (that address holds no authorization),
 * and a reader would be shown a Move refusal that says nothing about the
 * approval they asked for.
 *
 * IT WILL NOT SUBSTITUTE A SIGNER. There is no fallback to the deployer, no
 * "demo mode" that approves as somebody else. An approval signed by the wrong
 * person is not that person's approval.
 */

import { execFileSync } from "node:child_process";

import type { SuiNetwork } from "../sui/deployment";
import type { ApproveScopedPlan } from "./approveScopedCall";
import { submitMoveCall, type ExecuteSubmitResult } from "./executeSubmit";

export class NoSignerError extends Error {
  readonly code = "NO_SIGNER";
  constructor(readonly approver: string) {
    super(
      `This server holds no signing key for ${approver}, the address the treasury authorizes ` +
        "to approve payments. An approval must be signed by the approver themselves, so no " +
        "transaction was submitted and no HumanApproval was created.",
    );
    this.name = "NoSignerError";
  }
}

/**
 * Addresses the local Sui keystore can sign for.
 *
 * Read rather than assumed. Returns an empty list when the CLI is absent or
 * unreadable, which fails CLOSED: no key found means no submission attempted.
 */
export function keystoreAddresses(): string[] {
  try {
    const raw = execFileSync("sui", ["keytool", "list", "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as { suiAddress?: string }[];
    return parsed
      .map((entry) => entry.suiAddress)
      .filter((value): value is string => typeof value === "string")
      .map(normalize);
  } catch {
    return [];
  }
}

export function canSignFor(address: string): boolean {
  return keystoreAddresses().includes(normalize(address));
}

/**
 * Submits the approval, having first established that the signer is the
 * approver the plan names.
 *
 * Throws `NoSignerError` rather than returning a failure result, so a caller
 * cannot accidentally render it beside a Move abort code — it is not a chain
 * refusal, it is this build being unable to ask.
 */
export function submitApproveScoped(
  plan: ApproveScopedPlan,
  network: SuiNetwork,
): ExecuteSubmitResult {
  if (!canSignFor(plan.sender)) throw new NoSignerError(plan.sender);
  return submitMoveCall(plan, network);
}

function normalize(address: string): string {
  const body = address.trim().toLowerCase().replace(/^0x/, "");
  return `0x${body.padStart(64, "0")}`;
}
