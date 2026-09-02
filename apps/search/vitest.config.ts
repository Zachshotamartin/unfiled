import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "test/milestone-f-trust-domain.integration.test.ts",
      "test/search-capacity.integration.test.ts"
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/entrypoint.ts", "src/server.ts"],
      thresholds: { branches: 80, functions: 85, lines: 88, statements: 85 }
    }
  }
});
