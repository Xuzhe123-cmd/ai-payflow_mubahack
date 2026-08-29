/**
 * Verifies Cloudflare Workers AI credentials with one minimal call.
 *
 *   npm run check:ai
 *
 * Reports precisely which part is wrong — missing keys, bad token, wrong
 * account, or a model that does not support JSON Mode — so a failed demo setup
 * is diagnosable in one command instead of by guesswork.
 */

import { createWorkersAiClient, readWorkersAiConfig } from "../lib/ai/workersAiClient";
import { loadEnvLocal } from "./loadEnv";

const PROBE_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "Always true." },
    model: { type: "string", description: "Any short string." },
  },
  required: ["ok", "model"],
};

async function main(): Promise<void> {
  loadEnvLocal();

  const config = readWorkersAiConfig(process.env);
  if (!config) {
    console.error(
      [
        "",
        "  ✗ Credentials not found.",
        "",
        "    Add these to .env.local (no quotes, no spaces around the =):",
        "      CLOUDFLARE_ACCOUNT_ID=...",
        "      CLOUDFLARE_API_TOKEN=...",
        "",
        "    Account ID:  https://dash.cloudflare.com  →  Workers & Pages  →  Account ID",
        "                 (or run: npx wrangler whoami)",
        "    API token:   https://dash.cloudflare.com/profile/api-tokens",
        "                 Create Token → Create Custom Token → Permissions:",
        "                 Account · Workers AI · Read",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`\n  Account:  ${config.accountId.slice(0, 6)}…${config.accountId.slice(-4)}`);
  console.log(`  Model:    ${config.modelId}`);
  console.log(`  Gateway:  ${config.gatewayId ?? "(direct, no AI Gateway)"}`);
  console.log("\n  Calling Workers AI…");

  const client = createWorkersAiClient(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const started = Date.now();
    const response = await client.run(
      {
        messages: [
          { role: "system", content: "Reply with JSON only." },
          { role: "user", content: 'Return {"ok": true, "model": "workers-ai"}.' },
        ],
        jsonSchema: PROBE_SCHEMA,
        temperature: 0,
        seed: 1,
        maxTokens: 64,
      },
      controller.signal,
    );

    const elapsed = Date.now() - started;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      console.error(
        `\n  ✗ The model replied, but not with valid JSON. JSON Mode may not be\n` +
          `    supported by ${config.modelId}.\n` +
          `    See https://developers.cloudflare.com/workers-ai/features/json-mode/\n\n` +
          `    Raw reply: ${response.text.slice(0, 200)}\n`,
      );
      process.exit(1);
    }

    console.log(`\n  ✓ Workers AI reachable and returning schema-valid JSON (${elapsed}ms).`);
    console.log(`    Reply: ${JSON.stringify(parsed)}`);
    console.log("\n  Ready. Next: npm run scenarios\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ✗ Call failed:\n    ${message}\n`);

    if (message.includes("401") || message.includes("Authentication")) {
      console.error(
        "    The token was rejected. Check it was copied whole (it is shown only\n" +
          "    once) and that it has the Workers AI · Read permission.\n",
      );
    } else if (message.includes("404")) {
      console.error(
        "    Not found — usually a wrong Account ID, or a model name that does not\n" +
          "    exist. Confirm the ID with: npx wrangler whoami\n",
      );
    } else if (message.includes("403")) {
      console.error(
        "    Forbidden — the token is valid but lacks Workers AI access on this\n" +
          "    account.\n",
      );
    }
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
