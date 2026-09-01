import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "test/capacity.integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/entrypoint.ts", "src/server.ts"],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 }
    }
  }
});
