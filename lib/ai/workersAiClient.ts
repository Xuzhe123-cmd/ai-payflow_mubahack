/**
 * Workers AI transport.
 *
 * Uses the native /ai/run/{model} endpoint, which is what Cloudflare's JSON
 * Mode documentation specifies: response_format takes the schema directly,
 * unlike the OpenAI-compatible endpoint's nested {name, schema} envelope.
 * JSON Mode does not support streaming, so this is a single request.
 *
 * The interface is the seam for Phase 6+: a Worker deployment swaps this for
 * the `env.AI` binding without the engine noticing.
 */

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface WorkersAiRequest {
  messages: ChatMessage[];
  jsonSchema: unknown;
  temperature: number;
  seed: number;
  maxTokens: number;
}

export interface WorkersAiResponse {
  /** Raw model output as text, ready for JSON.parse. */
  text: string;
  modelId: string;
}

export interface WorkersAiClient {
  readonly id: string;
  readonly modelId: string;
  run(request: WorkersAiRequest, signal: AbortSignal): Promise<WorkersAiResponse>;
}

export interface WorkersAiConfig {
  accountId: string;
  apiToken: string;
  modelId: string;
  gatewayId?: string;
}

export const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Reads credentials from the environment. Returns null when unconfigured. */
export function readWorkersAiConfig(
  env: Record<string, string | undefined> = process.env,
): WorkersAiConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) return null;
  return {
    accountId,
    apiToken,
    modelId: env.PAYFLOW_MODEL?.trim() || DEFAULT_MODEL_ID,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID?.trim() || undefined,
  };
}

function endpointFor(config: WorkersAiConfig): string {
  if (config.gatewayId) {
    // AI Gateway gives request logging and caching in front of the same model.
    return `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/workers-ai/${config.modelId}`;
  }
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${config.modelId}`;
}

/** Workers AI returns result.response as either a JSON string or a parsed object. */
function extractText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = (payload as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return null;
  const response = (result as { response?: unknown }).response;
  if (typeof response === "string") return response;
  if (typeof response === "object" && response !== null) return JSON.stringify(response);
  return null;
}

function describeErrors(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "unknown error";
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return "unknown error";
  return errors
    .map((entry) =>
      typeof entry === "object" && entry !== null && "message" in entry
        ? String((entry as { message: unknown }).message)
        : JSON.stringify(entry),
    )
    .join("; ");
}

export function createWorkersAiClient(config: WorkersAiConfig): WorkersAiClient {
  return {
    id: config.gatewayId ? "workers-ai-gateway" : "workers-ai",
    modelId: config.modelId,

    async run(request, signal) {
      const response = await fetch(endpointFor(config), {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: request.messages,
          temperature: request.temperature,
          seed: request.seed,
          max_tokens: request.maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: request.jsonSchema,
          },
        }),
      });

      const bodyText = await response.text();

      if (!response.ok) {
        throw new Error(
          `Workers AI returned HTTP ${response.status}: ${bodyText.slice(0, 400)}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new Error(`Workers AI returned non-JSON body: ${bodyText.slice(0, 400)}`);
      }

      if (typeof payload === "object" && payload !== null && "success" in payload) {
        if ((payload as { success: unknown }).success === false) {
          throw new Error(`Workers AI reported failure: ${describeErrors(payload)}`);
        }
      }

      const text = extractText(payload);
      if (text === null) {
        throw new Error(
          `Workers AI response had no result.response field: ${bodyText.slice(0, 400)}`,
        );
      }

      return { text, modelId: config.modelId };
    },
  };
}
