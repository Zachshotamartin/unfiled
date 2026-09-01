import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/capacity.integration.test.ts"],
    maxWorkers: 1
  }
});
