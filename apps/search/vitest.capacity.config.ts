import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["test/search-capacity.integration.test.ts"],
    maxWorkers: 1,
    testTimeout: 180_000
  }
});
