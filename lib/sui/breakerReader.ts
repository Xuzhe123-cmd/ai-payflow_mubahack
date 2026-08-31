/**
 * The circuit breaker, read from the chain.
 *
 * THE ONLY SOURCE THE UI IS ALLOWED TO BELIEVE. The breaker's whole value is
 * that it is not a React flag, so the interface must never derive its state
 * from a click, an anomaly score, or a request it just sent. It renders what
 * this returns and nothing else.
 *
 * THREE ANSWERS, AND THEY ARE NOT THE SAME:
 *
 *   NOT_INSTALLED  the dynamic field does not exist. Move treats this as
 *                  NORMAL and so does this reader — but it is reported
 *                  separately, because "armed" and "no breaker here at all"
 *                  must never look alike on a security screen.
 *   NORMAL         installed and armed. Autonomy permitted.
 *   HUMAN_ONLY     tripped. Move refuses autonomous and conditional paths.
 *
 * An unreadable chain is none of the three and is reported as a failure. "We
 * could not check" must not resolve to "armed", which would claim a protection
 * nobody has verified.
 */

import type { createSuiQueries } from "./client";
import { extractFields, readString, readU64 } from "./decode";

export type BreakerMode = "NOT_INSTALLED" | "NORMAL" | "HUMAN_ONLY";

export interface BreakerState {
  mode: BreakerMode;
  installed: boolean;
  /** The score recorded at the last trip. Evidence, not logic. */
  anomalyScore: number;
  /** The dominant signal, as recorded on chain. Empty when never tripped. */
  reasonCode: string;
  trippedAtMs: number;
  tripCount: number;
  resetAtMs: number;
  /** Where this was read from, so the UI can name the object. */
  treasuryId: string;
}

/** Move's `MODE_HUMAN_ONLY`. Mirrored, and asserted against Move in tests. */
const MODE_HUMAN_ONLY = 1;

/**
 * Reads the breaker's dynamic field off the treasury.
 *
 * Returns NOT_INSTALLED when the field is absent, and THROWS when the chain
 * could not be read — the two are different facts and collapsing them would
 * turn an RPC hiccup into a confident "no breaker".
 */
export async function readBreakerState(
  queries: ReturnType<typeof createSuiQueries>,
  treasuryId: string,
): Promise<BreakerState> {
  const entries = await queries.getDynamicFields(treasuryId);

  // IDENTIFIED BY TYPE, NOT BY NAME. `CircuitBreakerKey {}` is an empty struct:
  // its decoded name is an empty object carrying nothing to match on, unlike
  // the approver fields, which are keyed by address. Matching on `name` found
  // the field on no chain at all and silently reported NOT_INSTALLED for a
  // breaker that existed.
  const entry = entries.find(
    (row) => typeof row.nameType === "string" && row.nameType.includes("CircuitBreakerKey"),
  );

  if (!entry) {
    return {
      mode: "NOT_INSTALLED",
      installed: false,
      anomalyScore: 0,
      reasonCode: "",
      trippedAtMs: 0,
      tripCount: 0,
      resetAtMs: 0,
      treasuryId,
    };
  }

  const value = extractFields(entry.value);
  const mode = Number(readU64(value, "mode") ?? BigInt(0));

  return {
    // Anything that is not explicitly HUMAN_ONLY is reported as NORMAL, which
    // matches Move's own `!= MODE_HUMAN_ONLY` test rather than second-guessing
    // it from this side.
    mode: mode === MODE_HUMAN_ONLY ? "HUMAN_ONLY" : "NORMAL",
    installed: true,
    anomalyScore: Number(readU64(value, "anomaly_score") ?? BigInt(0)),
    reasonCode: readString(value, "reason_code") ?? "",
    trippedAtMs: Number(readU64(value, "tripped_at_ms") ?? BigInt(0)),
    tripCount: Number(readU64(value, "trip_count") ?? BigInt(0)),
    resetAtMs: Number(readU64(value, "reset_at_ms") ?? BigInt(0)),
    treasuryId,
  };
}

/** What the breaker permits, stated the way the UI needs it. */
export interface BreakerConsequences {
  autonomousAllowed: boolean;
  conditionalAllowed: boolean;
  /** Always true. HUMAN_ONLY withdraws autonomy, never the human path. */
  humanAllowed: boolean;
  label: string;
  detail: string;
}

export function breakerConsequences(state: BreakerState): BreakerConsequences {
  if (state.mode === "HUMAN_ONLY") {
    return {
      autonomousAllowed: false,
      conditionalAllowed: false,
      humanAllowed: true,
      label: "TRIPPED",
      detail:
        "Sui refuses autonomous and conditional payments while the treasury is in HUMAN_ONLY " +
        "mode. Human and multisig paths are unaffected.",
    };
  }
  if (state.mode === "NOT_INSTALLED") {
    return {
      autonomousAllowed: true,
      conditionalAllowed: true,
      humanAllowed: true,
      label: "NOT INSTALLED",
      // Said plainly. An operator must not read this screen as protection.
      detail:
        "No circuit breaker exists on this treasury yet. Payments behave exactly as they did " +
        "before this phase, and nothing would be refused on these grounds.",
    };
  }
  return {
    autonomousAllowed: true,
    conditionalAllowed: true,
    humanAllowed: true,
    label: "ARMED",
    detail:
      "The breaker is installed and the treasury is in NORMAL mode. Autonomous and conditional " +
      "payments proceed under their existing limits.",
  };
}
