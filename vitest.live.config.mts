import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The live tier: calls real Workers AI. Opt-in via `npm run test:live` because
 * it costs real inference and its results are empirical rather than guaranteed.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    // Each scenario is sampled several times; give the model room.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Sampling in parallel would hammer the endpoint and skew latencies.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
