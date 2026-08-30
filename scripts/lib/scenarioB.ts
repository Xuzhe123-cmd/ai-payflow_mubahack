/**
 * Classifying the Scenario B result.
 *
 * The demo claims one specific thing: an $8,000 autonomous payment is refused
 * because the agent's on-chain cap is $5,000. "The transaction failed" does not
 * prove that. A wrong supplier, a mismatched wallet, an expired recommendation,
 * a bad object reference, or an unrelated module aborting with a coincidental 5
 * would all look identical on screen.
 *
 * So the verdict is only ALLOWED to pass when the abort is code 5, raised by
 * this package's `payment::execute_payment`. Everything else is a distinct
 * failure with its own explanation — including success, which is the worst one.
 */

import { violationForAbortCode } from "../../lib/sui/errorCodes";
import type { PolicyViolationCode } from "../../lib/types";
import type { MoveAbortInfo } from "./suiCli";

/** EExceedsMaxPayment — the agent's single-payment ceiling. */
export const EXPECTED_ABORT_CODE = 5;
export const EXPECTED_MODULE = "payment";
export const EXPECTED_FUNCTION = "execute_payment";

export type ScenarioBVerdict =
  /** The chain let it through. A security failure, not a demo. */
  | { kind: "EXECUTED" }
  /** Exactly what the demo claims. */
  | { kind: "REJECTED_BY_CAP"; code: number }
  /** Refused, but by a different check — the demo would be misleading. */
  | { kind: "REJECTED_OTHER"; code: number; violation: PolicyViolationCode | null }
  /** Refused by code 5 somewhere that is not our payment path. */
  | {
      kind: "REJECTED_ELSEWHERE";
      code: number;
      module: string | null;
      functionName: string | null;
      /** Where it actually came from, and where it was expected from. */
      address: string | null;
      expectedAddress: string;
    }
  /** Refused, but the reason could not be read. Never counts as a pass. */
  | { kind: "UNPARSED"; error: string };

export interface ScenarioBInput {
  succeeded: boolean;
  abort: MoveAbortInfo | null;
  error: string;
  /** Package id from the manifest, so a foreign module cannot satisfy the check. */
  expectedPackageId: string;
}

/**
 * Sui addresses are case-insensitive hex and are rendered inconsistently: with
 * or without `0x`, in either case, and sometimes without leading zeros (`0x6`
 * for the Clock). All three have to compare equal.
 */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "") || "0";
}

export function classifyScenarioB(input: ScenarioBInput): ScenarioBVerdict {
  if (input.succeeded) return { kind: "EXECUTED" };

  const abort = input.abort;
  if (!abort) return { kind: "UNPARSED", error: input.error };

  if (abort.code !== EXPECTED_ABORT_CODE) {
    return {
      kind: "REJECTED_OTHER",
      code: abort.code,
      violation: violationForAbortCode(abort.code),
    };
  }

  // Code 5 alone is not enough. Confirm it came from our payment module, in the
  // package the manifest names — abort codes are per-module and small integers
  // collide freely across a dependency graph.
  const expectedAddress = normalizeAddress(input.expectedPackageId);
  const addressMatches =
    abort.address === null || normalizeAddress(abort.address) === expectedAddress;
  const moduleMatches = abort.module === null || abort.module === EXPECTED_MODULE;
  const functionMatches = abort.functionName === null || abort.functionName === EXPECTED_FUNCTION;

  if (!addressMatches || !moduleMatches || !functionMatches) {
    return {
      kind: "REJECTED_ELSEWHERE",
      code: abort.code,
      module: abort.module,
      functionName: abort.functionName,
      address: abort.address,
      expectedAddress: input.expectedPackageId,
    };
  }

  return { kind: "REJECTED_BY_CAP", code: abort.code };
}

// --- Scenario A0: the payment that SHOULD go through ------------------------

/**
 * The mirror image of Scenario B, and just as worth asserting.
 *
 * A treasury that refuses everything is trivially "secure" and completely
 * useless. Proving the agent CAN settle a $3,000 invoice on its own authority
 * is what makes the $8,000 refusal meaningful rather than an artifact of a
 * broken deployment.
 */
export type ScenarioA0Verdict =
  | { kind: "EXECUTED_AUTONOMOUSLY" }
  /** Refused. For A0 this is a failure, whatever the reason. */
  | { kind: "REFUSED"; code: number | null; violation: PolicyViolationCode | null }
  | { kind: "UNPARSED"; error: string };

export function classifyScenarioA0(input: {
  succeeded: boolean;
  abort: MoveAbortInfo | null;
  error: string;
}): ScenarioA0Verdict {
  if (input.succeeded) return { kind: "EXECUTED_AUTONOMOUSLY" };
  if (!input.abort) return { kind: "UNPARSED", error: input.error };
  return {
    kind: "REFUSED",
    code: input.abort.code,
    violation: violationForAbortCode(input.abort.code),
  };
}

export function describeA0Verdict(verdict: ScenarioA0Verdict): string {
  switch (verdict.kind) {
    case "EXECUTED_AUTONOMOUSLY":
      return "the agent settled it on its own authority, no human involved";
    case "REFUSED":
      return (
        `abort ${verdict.code} (${verdict.violation ?? "not a policy check"}) — ` +
        `this payment is within the agent's limits and should have gone through`
      );
    case "UNPARSED":
      return `could not read the failure reason: ${verdict.error.slice(0, 200)}`;
  }
}

/** One line for the verifier to print. */
export function describeVerdict(verdict: ScenarioBVerdict): string {
  switch (verdict.kind) {
    case "EXECUTED":
      return "the payment SUCCEEDED — the $5,000 cap is not being enforced";
    case "REJECTED_BY_CAP":
      return `abort ${verdict.code} EXCEEDS_MAX_PAYMENT from ${EXPECTED_MODULE}::${EXPECTED_FUNCTION}`;
    case "REJECTED_OTHER":
      return (
        `abort ${verdict.code} (${verdict.violation ?? "not a policy check"}) — ` +
        `rejected, but not by the payment cap; the seed data is masking the demo`
      );
    case "REJECTED_ELSEWHERE": {
      // The module and function are frequently identical on both sides, because
      // the mismatch is the PACKAGE — which is exactly what an upgrade changes.
      // Printing the same string twice made that failure unreadable, so the
      // differing part is named explicitly.
      const from = `${verdict.module ?? "?"}::${verdict.functionName ?? "?"}`;
      const expected = `${EXPECTED_MODULE}::${EXPECTED_FUNCTION}`;
      if (from === expected && verdict.address) {
        return (
          `abort ${verdict.code} came from ${expected} in package ${verdict.address}, ` +
          `but ${verdict.expectedAddress} was expected`
        );
      }
      return `abort ${verdict.code} came from ${from}, not ${expected}`;
    }
    case "UNPARSED":
      return `could not read the failure reason: ${verdict.error.slice(0, 200)}`;
  }
}
