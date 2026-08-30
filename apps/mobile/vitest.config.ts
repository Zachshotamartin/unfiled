import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      include: [
        "config/**/*.ts",
        "plugins/quickCaptureWidgetConfig.ts",
        "src/features/capture/{captureSource,captureSubmission,nativeIntent}.ts"
      ],
      provider: "v8",
      thresholds: { branches: 85, functions: 90, lines: 90, statements: 90 }
    },
    environment: "node"
  }
});
