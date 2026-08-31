/**
 * Whether each provider is actually reachable — checked, not assumed.
 *
 * "CONNECTED" is a claim about the world, so it is earned by a real round trip
 * rather than by the presence of an environment variable. A key that is set but
 * revoked, out of quota, or pointed at a model the account cannot serve is NOT
 * connected, and saying otherwise would put a green light on a provider that
 * will fail at the moment it is needed.
 *
 * THREE STATES, KEPT APART:
 *
 *   CONNECTED       credentials present AND the endpoint answered.
 *   NOT_CONFIGURED  no credentials. Nothing was attempted.
 *   UNREACHABLE     credentials present, the endpoint refused or timed out.
 *                   The real status or error is carried, never softened.
 */

import { readGeminiConfig } from "./geminiClient";
import { readWorkersAiConfig } from "./workersAiClient";
import { PROVIDER_LABEL, type ProviderId } from "./providers";

export type HealthStatus = "CONNECTED" | "NOT_CONFIGURED" | "UNREACHABLE";

export interface ProviderHealth {
  provider: ProviderId;
  label: string;
  status: HealthStatus;
  /** The model the check was made against, when there was one. */
  modelId: string | null;
  /** Why it is not connected. Null when it is. */
  detail: string | null;
  /** Round-trip time of the check, for a reader judging a slow provider. */
  latencyMs: number | null;
}

const PROBE_TIMEOUT_MS = 8_000;

/**
 * A cheap liveness probe per provider.
 *
 * Deliberately not a full decision: the question is "can this credential reach
 * this vendor", and asking for an invoice analysis to answer it would cost a
 * real inference on every page load.
 */
export async function checkProviders(
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderHealth[]> {
  return Promise.all([checkGemini(env), checkCloudflare(env)]);
}

async function checkGemini(
  env: Record<string, string | undefined>,
): Promise<ProviderHealth> {
  const base = { provider: "gemini" as const, label: PROVIDER_LABEL.gemini };
  const config = readGeminiConfig(env);
  if (!config) {
    return {
      ...base,
      status: "NOT_CONFIGURED",
      modelId: null,
      detail: "GEMINI_API_KEY is not set.",
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Asks for THIS model's metadata, so a key that works but cannot serve the
    // configured model is reported unreachable rather than connected.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}`,
      { signal: controller.signal, headers: { "x-goog-api-key": config.apiKey } },
    );
    if (!response.ok) {
      return {
        ...base,
        status: "UNREACHABLE",
        modelId: config.modelId,
        detail: `Gemini returned ${response.status} for ${config.modelId}.`,
        latencyMs: Date.now() - startedAt,
      };
    }
    return {
      ...base,
      status: "CONNECTED",
      modelId: config.modelId,
      detail: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      status: "UNREACHABLE",
      modelId: config.modelId,
      detail: error instanceof Error ? error.message : "Gemini could not be reached.",
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkCloudflare(
  env: Record<string, string | undefined>,
): Promise<ProviderHealth> {
  const base = { provider: "cloudflare" as const, label: PROVIDER_LABEL.cloudflare };
  const config = readWorkersAiConfig(env);
  if (!config) {
    return {
      ...base,
      status: "NOT_CONFIGURED",
      modelId: null,
      detail: "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not set.",
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // The account's model list: authenticates the token against the account
    // without spending an inference.
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/models/search?per_page=1`,
      { signal: controller.signal, headers: { authorization: `Bearer ${config.apiToken}` } },
    );
    if (!response.ok) {
      return {
        ...base,
        status: "UNREACHABLE",
        modelId: config.modelId,
        detail: `Cloudflare returned ${response.status}.`,
        latencyMs: Date.now() - startedAt,
      };
    }
    return {
      ...base,
      status: "CONNECTED",
      modelId: config.modelId,
      detail: null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      status: "UNREACHABLE",
      modelId: config.modelId,
      detail: error instanceof Error ? error.message : "Cloudflare could not be reached.",
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** True only when BOTH providers answered. Two is the whole point. */
export function bothConnected(health: readonly ProviderHealth[]): boolean {
  return (
    health.length === 2 && health.every((entry) => entry.status === "CONNECTED")
  );
}
