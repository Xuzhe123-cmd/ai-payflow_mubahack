/**
 * Gemini transport — the second, independent intelligence provider.
 *
 * INDEPENDENCE IS THE WHOLE VALUE. A second opinion from the same vendor, the
 * same weights, or the same prompt-injection surface is not a second opinion.
 * Gemini is reached over Google's own endpoint with its own credential, so a
 * compromise of Cloudflare's account, token, or model does not reach it — and a
 * disagreement between the two is evidence one of them is behaving oddly.
 *
 * IT AUTHORIZES NOTHING. Like every other model in this codebase, it returns an
 * opinion. No function takes a Gemini response and produces a transaction, and
 * Move never sees one.
 *
 * UNCONFIGURED IS A REPORTED STATE, NOT A SILENT DEFAULT. With no API key this
 * returns null and the panel says so by name. It is never stood in for by the
 * other provider, by a recording, or by an invented confidence — a fabricated
 * second opinion would defeat the only reason a second provider exists.
 */

export interface GeminiConfig {
  apiKey: string;
  modelId: string;
}

/**
 * The default model. Overridable with PAYFLOW_GEMINI_MODEL.
 *
 * Chosen by probing the live API rather than from the docs: `models.list`
 * still advertises older flash models, but `generateContent` refuses them with
 * "no longer available to new users" and names this one. The listing and the
 * serving endpoint disagree, so the serving endpoint wins.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

export function readGeminiConfig(
  env: Record<string, string | undefined> = process.env,
): GeminiConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_AI_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, modelId: env.PAYFLOW_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL };
}

export interface GeminiRequest {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: unknown;
  temperature: number;
}

export interface GeminiResponse {
  /** Raw model output as text, ready for JSON.parse. */
  text: string;
  modelId: string;
}

/**
 * Calls Gemini's generateContent with a response schema.
 *
 * The schema is passed as `responseSchema` with `responseMimeType: application/json`,
 * which is Gemini's structured-output contract — the same role Workers AI's
 * `response_format` plays for the other provider. Output still goes through the
 * shared validation guard: a provider that returns malformed or out-of-range
 * output is escalated, never trusted because it answered.
 */
export async function runGemini(
  config: GeminiConfig,
  request: GeminiRequest,
  signal: AbortSignal,
): Promise<GeminiResponse> {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.modelId)}:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      // Header rather than a query parameter, so the key never lands in a URL
      // that could be logged by a proxy or an error reporter.
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        temperature: request.temperature,
        responseMimeType: "application/json",
        responseSchema: request.jsonSchema,
      },
    }),
  });

  if (!response.ok) {
    // The real status and body. A provider that refused must not be reported
    // as one that answered.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Gemini returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Gemini returned no candidate text.");
  }

  return { text, modelId: config.modelId };
}
