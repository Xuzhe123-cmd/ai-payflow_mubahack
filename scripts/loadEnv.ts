/**
 * Minimal .env.local loader for the CLI scripts.
 *
 * Next.js loads .env.local automatically; plain `tsx` runs do not, and adding a
 * dotenv dependency for four lines is not worth it. Existing process.env values
 * always win, so `CLOUDFLARE_API_TOKEN=... npm run scenarios` still works.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvLocal(cwd = process.cwd()): void {
  for (const filename of [".env.local", ".env"]) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      if (key.length === 0 || process.env[key] !== undefined) continue;

      let value = trimmed.slice(separator + 1).trim();
      // Strip an inline trailing comment on unquoted values.
      if (!value.startsWith('"') && !value.startsWith("'")) {
        const hash = value.indexOf(" #");
        if (hash !== -1) value = value.slice(0, hash).trim();
      }
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}
