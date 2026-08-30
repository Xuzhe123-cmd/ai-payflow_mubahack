/**
 * The shape of the `sui client call` invocation, and how its response is read.
 *
 * `payment::execute_payment` is generic over the settlement coin and takes four
 * object references plus the Clock. Getting the argument list wrong produces a
 * CLI-level error that looks nothing like a policy rejection, so Scenario B
 * would report "could not read the failure reason" while the contract was
 * working perfectly.
 *
 * The `--type-args` case is called out specifically: a truncated or empty type
 * argument is the failure mode that is hardest to spot by eye, because the
 * command still looks broadly right.
 */

import { describe, expect, it } from "vitest";

import {
  interpretExecution,
  parseCliError,
  parseMoveAbort,
  renderCall,
} from "../../scripts/lib/suiCli";
import { classifyScenarioB } from "../../scripts/lib/scenarioB";

const PACKAGE = "0x8d520423e902a07edf2ab73d34d18efa5753d055f8ab46825b5fd7b4da67775d";
const COIN_TYPE = `${PACKAGE}::mock_usdc::MOCK_USDC`;

/** The ten non-ctx parameters of payment::execute_payment, in order. */
const EXECUTE_PAYMENT_ARGS = [
  "0x15f45303f80c591ea9777da30386c650df73a9277e478f43e128af123a57dd5a", // &mut Treasury<T>
  "0x780434ab1f1930878707aed3e6eca3101c5e61f56f6ace50e4358601b12ccb85", // &AgentCap
  "0xf37754631294381e009d00fcf0ebc1d400f0db941af5857a2e2de40d78b38fb8", // &SupplierRegistry
  "0x1cb9fd04484c4453c0c3f440613444e055b63315447b2410e316ff0e79bbbe46", // &mut Invoice
  "8000000000", // amount: u64 — $8,000 at six decimals
  "0x3f8b2d6a91c7e405b8d29a4f7c61e308b5d29a4f7c61e308b5d29a4f7c61e308", // recipient: address
  "rec_demo_b", // recommendation_id: String
  "1788063775758", // recommended_at_ms: u64
  "1788150175758", // expires_at_ms: u64
  "0x6", // &Clock — the well-known shared Clock object
];

const OPTIONS = {
  packageId: PACKAGE,
  module: "payment",
  function: "execute_payment",
  typeArgs: [COIN_TYPE],
  args: EXECUTE_PAYMENT_ARGS,
};

describe("execute_payment call construction", () => {
  it("passes the fully-qualified coin type, never a bare number", () => {
    const rendered = renderCall(OPTIONS);

    expect(rendered).toContain(`--type-args ${COIN_TYPE}`);
    // The exact malformed form that broke the real run.
    expect(rendered).not.toMatch(/--type-args\s+\d+(\s|$)/);
    expect(rendered).not.toMatch(/--type-args\s*(-{2}|$)/);
  });

  it("names a type argument that is a real Move type path", () => {
    for (const typeArg of OPTIONS.typeArgs) {
      // address::module::Type — three parts, first one hex.
      const parts = typeArg.split("::");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^0x[0-9a-f]{1,64}$/);
      expect(parts[1]).toBe("mock_usdc");
      expect(parts[2]).toBe("MOCK_USDC");
    }
  });

  it("supplies exactly the ten parameters the Move signature declares", () => {
    // treasury, cap, reg, inv, amount, recipient, recommendation_id,
    // recommended_at_ms, expires_at_ms, clock. TxContext is supplied by the
    // runtime and must NOT be passed.
    expect(OPTIONS.args).toHaveLength(10);
  });

  it("passes the Clock, which is what a missing trailing argument drops first", () => {
    expect(OPTIONS.args.at(-1)).toBe("0x6");
  });

  it("passes u64 amounts as decimal strings, not hex or numbers", () => {
    expect(OPTIONS.args[4]).toBe("8000000000");
    expect(OPTIONS.args[4]).toMatch(/^\d+$/);
  });

  it("omits --type-args entirely when a function is not generic", () => {
    const rendered = renderCall({
      packageId: PACKAGE,
      module: "registry",
      function: "create",
      args: ["0xcap"],
    });

    expect(rendered).not.toContain("--type-args");
  });
});

describe("reading the response of a transaction that aborts", () => {
  const abortError =
    `MoveAbort(MoveLocation { module: ModuleId { address: ${PACKAGE.slice(2)}, ` +
    `name: Identifier("payment") }, function: 5, instruction: 83, ` +
    `function_name: Some("execute_payment") }, 5) in command 0`;

  const digest = "5xJ2vQhZ8kR3mN7pT4wY6bC9dF1gH2jK3lM4nP5qR6sT";

  it("reads an abort from exit-0 JSON with a failure status", () => {
    const raw = JSON.stringify({
      digest,
      effects: { status: { status: "failure", error: abortError } },
    });

    const outcome = interpretExecution(raw);

    expect(outcome.ok).toBe(false);
    expect(outcome.digest).toBe(digest);
    expect(outcome.abort?.code).toBe(5);
    expect(outcome.abort?.functionName).toBe("execute_payment");
  });

  it("reads an abort when the CLI exited non-zero but still printed JSON", () => {
    // What execFileSync hands back: its own preamble, then the payload.
    const raw =
      `Command failed: sui client call --package ${PACKAGE} ...\n` +
      JSON.stringify({ digest, effects: { status: { status: "failure", error: abortError } } });

    const outcome = interpretExecution(raw);

    expect(outcome.abort?.code).toBe(5);
    expect(outcome.digest).toBe(digest);
  });

  it("reads an abort whose quotes are JSON-escaped", () => {
    // The same string as it appears inside an un-parsed JSON blob.
    const escaped = abortError.replace(/"/g, '\\"');
    const abort = parseMoveAbort(escaped);

    expect(abort?.code).toBe(5);
    expect(abort?.module).toBe("payment");
    expect(abort?.functionName).toBe("execute_payment");
  });

  it("reads an abort from plain text with no JSON at all", () => {
    const outcome = interpretExecution(`Error executing transaction: ${abortError}`);

    expect(outcome.ok).toBe(false);
    expect(outcome.abort?.code).toBe(5);
  });

  it("reports a CLI-level failure as unparsed rather than as a rejection", () => {
    // An argument error is NOT proof the payment cap held.
    const outcome = interpretExecution(
      "error: invalid value for '--type-args <TYPE_ARGS>': expected a type tag",
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.abort).toBeNull();

    const verdict = classifyScenarioB({
      succeeded: outcome.ok,
      abort: outcome.abort,
      error: outcome.error,
      expectedPackageId: PACKAGE,
    });
    expect(verdict.kind).toBe("UNPARSED");
  });

  it("recognises a successful execution as the security failure it would be", () => {
    const raw = JSON.stringify({ digest, effects: { status: { status: "success" } } });
    const outcome = interpretExecution(raw);

    expect(outcome.ok).toBe(true);

    const verdict = classifyScenarioB({
      succeeded: true,
      abort: null,
      error: "",
      expectedPackageId: PACKAGE,
    });
    expect(verdict.kind).toBe("EXECUTED");
  });

  it("keeps the digest of the refused payment, which is the demo artifact", () => {
    const raw = JSON.stringify({
      digest,
      effects: { status: { status: "failure", error: abortError } },
    });

    expect(interpretExecution(raw).digest).toBe(digest);
  });
});

describe("the Sui CLI's own error shape", () => {
  /**
   * Verbatim from the CLI. Note it is NOT JSON even though --json was passed,
   * and it arrives on STDOUT rather than stderr — which is why a wrapper that
   * only captured stderr saw nothing at all.
   */
  const CLI_ERROR =
    `code: 'Some requested entity was not found', ` +
    `message: "Object 0x00000000000000000000000000000000000000000000000000000000deadbeef not found"`;

  it("decodes code/message into something a human can act on", () => {
    expect(parseCliError(CLI_ERROR)).toBe(
      "Some requested entity was not found: Object 0x00000000000000000000000000000000000000000000000000000000deadbeef not found",
    );
  });

  it("surfaces the reason instead of an opaque dump", () => {
    const outcome = interpretExecution(CLI_ERROR);

    expect(outcome.ok).toBe(false);
    expect(outcome.abort).toBeNull();
    expect(outcome.digest).toBeNull();
    expect(outcome.error).toContain("not found");
    // The complete text is always retained, whatever else was parsed out.
    expect(outcome.raw).toBe(CLI_ERROR);
  });

  it("never lets a CLI failure count as Scenario B passing", () => {
    // No digest means the transaction never reached the chain, so nothing was
    // proven about the payment cap.
    const outcome = interpretExecution(CLI_ERROR);
    const verdict = classifyScenarioB({
      succeeded: outcome.ok,
      abort: outcome.abort,
      error: outcome.error,
      expectedPackageId: PACKAGE,
    });

    expect(verdict.kind).toBe("UNPARSED");
    expect(verdict.kind).not.toBe("REJECTED_BY_CAP");
  });

  it("handles a plain 'error: ...' line too", () => {
    expect(parseCliError("error: invalid value for '--type-args'")).toBe(
      "invalid value for '--type-args'",
    );
  });

  it("returns null when there is no recognisable error", () => {
    expect(parseCliError("")).toBeNull();
    expect(parseCliError("just some text")).toBeNull();
  });

  it("prefers a Move abort over the generic error decoder", () => {
    // A genuine abort must not be reduced to a generic CLI complaint.
    const moveAbort =
      `MoveAbort(MoveLocation { module: ModuleId { address: ${PACKAGE.slice(2)}, ` +
      `name: Identifier("payment") }, function: 5, instruction: 83, ` +
      `function_name: Some("execute_payment") }, 5) in command 0`;
    const outcome = interpretExecution(`error: transaction failed\n${moveAbort}`);

    expect(outcome.abort?.code).toBe(5);
    expect(outcome.error).toContain("MoveAbort");
  });
});
