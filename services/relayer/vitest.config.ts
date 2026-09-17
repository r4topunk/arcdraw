import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against SDK sources so `pnpm test` does not require a prior SDK build.
    alias: { "@arcdraw/sdk": fileURLToPath(new URL("../../packages/sdk/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
