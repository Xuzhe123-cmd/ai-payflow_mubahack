/**
 * Reading a Move abort out of a Sui 1.78 failure, and judging Scenario B by it.
 *
 * The fixture below is the verbatim `effects.status.error` string from the real
 * testnet dry run of the $8,000 payment. The original parser returned null on
 * it, so Scenario B could not be proven at all.
 *
 * There is a trap in the format worth stating plainly: `function: 5` is the
 * function's INDEX in the module, and for `execute_payment` it happens to equal
 * the abort code. A pattern that grabs "the first number after MoveAbort" reads
 * the wrong field and passes by luck. Several tests here use a fixture where
 * the two deliberately differ, so that mistake cannot hide.
 */

import { describe, expect, it } from "vitest";

import { parseAbortCode, parseDigest, parseMoveAbort } from "../../scripts/lib/suiCli";
import {
  classifyScenarioA0,
  classifyScenarioB,
  describeA0Verdict,
  describeVerdict,
} from "../../scripts/lib/scenarioB";

const PACKAGE = "8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";

/** Verbatim from the deployed testnet treasury's dry run. */
const REAL_ABORT =
  `MoveAbort(MoveLocation { module: ModuleId { address: ${PACKAGE}, ` +
  `name: Identifier("payment") }, function: 5, instruction: 83, ` +
  `function_name: Some("execute_payment") }, 5) in command 0`;

/** Same shape, but the function index and abort code differ. */
const RESERVE_ABORT =
  `MoveAbort(MoveLocation { module: ModuleId { address: ${PACKAGE}, ` +
  `name: Identifier("payment") }, function: 3, instruction: 120, ` +
  `function_name: Some("execute_scheduled") }, 9) in command 0`;

describe("parsing a Sui 1.78 Move abort", () => {
  it("extracts the abort code from the real Scenario B failure", () => {
    const abort = parseMoveAbort(REAL_ABORT);

    expect(abort).not.toBeNull();
    expect(abort!.code).toBe(5);
    expect(abort!.module).toBe("payment");
    expect(abort!.functionName).toBe("execute_payment");
    expect(abort!.address).toBe(PACKAGE);
  });

  it("reads the abort code, not the function index", () => {
    // function: 3, abort: 9. Anything that returns 3 is reading the wrong field.
    const abort = parseMoveAbort(RESERVE_ABORT);

    expect(abort!.code).toBe(9);
    expect(abort!.code).not.toBe(3);
    expect(abort!.functionName).toBe("execute_scheduled");
  });

  it("is not confused by the parentheses inside the location", () => {
    // Identifier("payment") and Some("execute_payment") both contain a ")",
    // which is precisely where the original [^)]* pattern stopped.
    expect(REAL_ABORT).toContain('Identifier("payment")');
    expect(REAL_ABORT).toContain('Some("execute_payment")');
    expect(parseAbortCode(REAL_ABORT)).toBe(5);
  });

  it("is not confused by trailing text after the closing paren", () => {
    // The original end-anchored pattern failed because of " in command 0".
    expect(REAL_ABORT.trimEnd().endsWith(")")).toBe(false);
    expect(parseAbortCode(REAL_ABORT)).toBe(5);
  });

  it("still handles the alternative renderings", () => {
    expect(parseAbortCode("... sub status 7 ...")).toBe(7);
    expect(parseAbortCode("abort_code: 10")).toBe(10);
  });

  it("returns null when there is genuinely no abort", () => {
    for (const message of ["", "InsufficientGas", "Object not found", "network unreachable"]) {
      expect(parseMoveAbort(message)).toBeNull();
    }
  });
});

/**
 * The format a REAL execution produces, which is structurally different from
 * the dry run's `MoveAbort(MoveLocation { … }, 5)`. Both carry the same facts;
 * a parser written for one silently fails on the other, which is exactly what
 * happened.
 *
 * This string is verbatim from the testnet run. The digest in it was confirmed
 * on chain: status failure, checkpoint 377629608, 1,086,412 MIST charged.
 */
const REAL_EXECUTION_ERROR =
  `Error executing transaction '7AJy75zwcXCkqp7QdpkqvwRvB7q7diGKp2TcAuuNoRgn': ` +
  `1st command aborted within function ` +
  `'0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d::payment::execute_payment' ` +
  `at instruction 83 with code 5`;

describe("parsing the real execution failure format", () => {
  it("extracts code, package, module and function", () => {
    const abort = parseMoveAbort(REAL_EXECUTION_ERROR);

    expect(abort).not.toBeNull();
    expect(abort!.code).toBe(5);
    expect(abort!.address).toBe(PACKAGE);
    expect(abort!.module).toBe("payment");
    expect(abort!.functionName).toBe("execute_payment");
  });

  it("does not mistake the instruction number for the abort code", () => {
    // "at instruction 83 with code 5" — 83 appears first.
    expect(parseAbortCode(REAL_EXECUTION_ERROR)).toBe(5);
    expect(parseAbortCode(REAL_EXECUTION_ERROR)).not.toBe(83);
  });

  it("extracts the transaction digest", () => {
    expect(parseDigest(REAL_EXECUTION_ERROR)).toBe(
      "7AJy75zwcXCkqp7QdpkqvwRvB7q7diGKp2TcAuuNoRgn",
    );
  });

  it("classifies it as REJECTED_BY_CAP — the demo's whole claim", () => {
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: parseMoveAbort(REAL_EXECUTION_ERROR),
      error: REAL_EXECUTION_ERROR,
      expectedPackageId: `0x${PACKAGE}`,
    });

    expect(verdict.kind).toBe("REJECTED_BY_CAP");
    expect(describeVerdict(verdict)).toContain("EXCEEDS_MAX_PAYMENT");
  });

  it("rejects the same format when the code is not 5", () => {
    const other = REAL_EXECUTION_ERROR.replace("with code 5", "with code 9");
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: parseMoveAbort(other),
      error: other,
      expectedPackageId: `0x${PACKAGE}`,
    });

    expect(verdict.kind).toBe("REJECTED_OTHER");
    expect(describeVerdict(verdict)).toContain("INSUFFICIENT_RESERVE");
  });

  it("rejects the same format from a different package", () => {
    const foreign = REAL_EXECUTION_ERROR.replace(PACKAGE, "a".repeat(64));
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: parseMoveAbort(foreign),
      error: foreign,
      expectedPackageId: `0x${PACKAGE}`,
    });

    expect(verdict.kind).toBe("REJECTED_ELSEWHERE");
  });

  it("rejects the same format from a different function", () => {
    const other = REAL_EXECUTION_ERROR.replace("::execute_payment", "::execute_scheduled");
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: parseMoveAbort(other),
      error: other,
      expectedPackageId: `0x${PACKAGE}`,
    });

    expect(verdict.kind).toBe("REJECTED_ELSEWHERE");
  });

  it("handles command ordinals other than the first", () => {
    for (const ordinal of ["2nd", "3rd", "11th"]) {
      const message = REAL_EXECUTION_ERROR.replace("1st command", `${ordinal} command`);
      expect(parseMoveAbort(message)?.code, ordinal).toBe(5);
    }
  });

  it("still reads the dry-run format, so both surfaces work", () => {
    expect(parseMoveAbort(REAL_ABORT)?.code).toBe(5);
    expect(parseMoveAbort(REAL_EXECUTION_ERROR)?.code).toBe(5);
  });
});

describe("judging Scenario B", () => {
  const base = { error: "", expectedPackageId: `0x${PACKAGE}` };

  it("passes only on abort 5 from payment::execute_payment", () => {
    const verdict = classifyScenarioB({
      ...base,
      succeeded: false,
      abort: parseMoveAbort(REAL_ABORT),
    });

    expect(verdict.kind).toBe("REJECTED_BY_CAP");
    expect(describeVerdict(verdict)).toContain("EXCEEDS_MAX_PAYMENT");
  });

  it("fails when the payment SUCCEEDS", () => {
    const verdict = classifyScenarioB({ ...base, succeeded: true, abort: null });

    expect(verdict.kind).toBe("EXECUTED");
    expect(describeVerdict(verdict)).toContain("not being enforced");
  });

  it("fails when another check refuses it — the masking case", () => {
    // A revoked supplier would also stop the payment, and would look identical
    // on screen. The demo would then be claiming something it had not shown.
    const supplierAbort = REAL_ABORT.replace("}, 5) in command 0", "}, 3) in command 0");
    const verdict = classifyScenarioB({
      ...base,
      succeeded: false,
      abort: parseMoveAbort(supplierAbort),
    });

    expect(verdict.kind).toBe("REJECTED_OTHER");
    expect(describeVerdict(verdict)).toContain("SUPPLIER_NOT_APPROVED");
    expect(describeVerdict(verdict)).toContain("masking");
  });

  it("fails when the reason cannot be read", () => {
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: null,
      error: "InsufficientGas",
      expectedPackageId: `0x${PACKAGE}`,
    });

    // Never a pass. "It failed somehow" does not prove the cap held.
    expect(verdict.kind).toBe("UNPARSED");
  });

  it("fails when abort 5 comes from a different module", () => {
    const foreign = REAL_ABORT.replace('Identifier("payment")', 'Identifier("registry")').replace(
      'Some("execute_payment")',
      'Some("upsert")',
    );
    const verdict = classifyScenarioB({
      ...base,
      succeeded: false,
      abort: parseMoveAbort(foreign),
    });

    expect(verdict.kind).toBe("REJECTED_ELSEWHERE");
  });

  it("fails when abort 5 comes from a different package", () => {
    const verdict = classifyScenarioB({
      succeeded: false,
      abort: parseMoveAbort(REAL_ABORT),
      error: "",
      expectedPackageId: "0xdeadbeef",
    });

    expect(verdict.kind).toBe("REJECTED_ELSEWHERE");
  });

  it("accepts a package id with or without the 0x prefix", () => {
    for (const id of [PACKAGE, `0x${PACKAGE}`, `0X${PACKAGE.toUpperCase()}`]) {
      const verdict = classifyScenarioB({
        succeeded: false,
        abort: parseMoveAbort(REAL_ABORT),
        error: "",
        expectedPackageId: id,
      });
      expect(verdict.kind, `failed for ${id}`).toBe("REJECTED_BY_CAP");
    }
  });
});

describe("judging Scenario A0 — the payment that should succeed", () => {
  it("passes when the agent settles it autonomously", () => {
    const verdict = classifyScenarioA0({ succeeded: true, abort: null, error: "" });

    expect(verdict.kind).toBe("EXECUTED_AUTONOMOUSLY");
    expect(describeA0Verdict(verdict)).toContain("no human involved");
  });

  it("fails when the chain refuses a payment that is within the limits", () => {
    // A treasury that refuses everything is trivially "secure" and useless.
    // This is what stops Scenario B's rejection being an artifact of a broken
    // deployment rather than a working policy.
    const capAbort =
      `Error executing transaction 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA': ` +
      `1st command aborted within function ` +
      `'0x${PACKAGE}::payment::execute_payment' at instruction 83 with code 5`;

    const verdict = classifyScenarioA0({
      succeeded: false,
      abort: parseMoveAbort(capAbort),
      error: capAbort,
    });

    expect(verdict.kind).toBe("REFUSED");
    expect(describeA0Verdict(verdict)).toContain("should have gone through");
  });

  it("names the specific check that wrongly refused it", () => {
    const reserveAbort =
      `1st command aborted within function ` +
      `'0x${PACKAGE}::payment::execute_payment' at instruction 90 with code 9`;

    const verdict = classifyScenarioA0({
      succeeded: false,
      abort: parseMoveAbort(reserveAbort),
      error: reserveAbort,
    });

    expect(verdict.kind).toBe("REFUSED");
    expect(describeA0Verdict(verdict)).toContain("INSUFFICIENT_RESERVE");
  });

  it("never treats an unreadable failure as success", () => {
    const verdict = classifyScenarioA0({
      succeeded: false,
      abort: null,
      error: "Some requested entity was not found",
    });

    expect(verdict.kind).toBe("UNPARSED");
    expect(verdict.kind).not.toBe("EXECUTED_AUTONOMOUSLY");
  });
});
