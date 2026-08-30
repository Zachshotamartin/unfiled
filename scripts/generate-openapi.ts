import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { format, resolveConfig } from "prettier";

import { openApiDocument } from "../packages/contracts/src/openapi.js";

const outputPath = path.resolve(
  import.meta.dirname,
  "../packages/contracts/openapi/openapi.v1.json"
);
const prettierConfig = await resolveConfig(outputPath);
const serialized = await format(JSON.stringify(openApiDocument), {
  ...prettierConfig,
  filepath: outputPath
});

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== serialized) {
    process.stderr.write("OpenAPI artifact is stale. Run pnpm generate:openapi.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("OpenAPI artifact is current.\n");
  }
} else {
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`Wrote ${outputPath}\n`);
}
