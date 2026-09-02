import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../web/src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ["test/milestone-f-trust-domain.integration.test.ts"],
    maxWorkers: 1,
    testTimeout: 60_000
  }
});
