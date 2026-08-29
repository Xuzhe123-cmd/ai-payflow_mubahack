/**
 * Recorded model output, for demos that must not depend on a live quota.
 *
 * These are verbatim Workers AI responses captured by `npm run record:llm`,
 * and they are replayed through the identical validation guard — so a replayed
 * decision really is the model's, just made earlier.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It is never selected automatically. A live call that fails escalates to
 *    the safety fallback, exactly as before. Silently substituting a recording
 *    for a failed call would be the interface pretending the AI ran.
 *  - It is never presented as a live call. The response carries
 *    engineMode: "recorded" and the interface labels it as a replay.
 */

import type { RecordedResponse } from "./recordedEngine";

import s1 from "../../tests/fixtures/llm/s1_normal.json";
import s2 from "../../tests/fixtures/llm/s2_cashflow.json";
import s3 from "../../tests/fixtures/llm/s3_discount.json";
import s4 from "../../tests/fixtures/llm/s4_new_supplier.json";
import s5 from "../../tests/fixtures/llm/s5_wallet_mismatch.json";
import s6 from "../../tests/fixtures/llm/s6_duplicate.json";
import s7 from "../../tests/fixtures/llm/s7_po_mismatch.json";
import s8 from "../../tests/fixtures/llm/s8_policy_violation.json";

export const RECORDED_RESPONSES: RecordedResponse[] = [
  s1, s2, s3, s4, s5, s6, s7, s8,
] as RecordedResponse[];

export function hasRecordingFor(scenarioId: string): boolean {
  return RECORDED_RESPONSES.some((entry) => entry.scenarioId === scenarioId);
}

/** How the decision was produced, for display. */
export type EngineMode = "live" | "recorded" | "fallback";

/**
 * Reads the operator's explicit choice.
 *
 *   PAYFLOW_ENGINE=recorded   replay captured responses
 *   PAYFLOW_ENGINE=live       call the model (default)
 */
export function readEngineMode(
  env: Record<string, string | undefined> = process.env,
): "live" | "recorded" {
  return env.PAYFLOW_ENGINE?.trim().toLowerCase() === "recorded" ? "recorded" : "live";
}
