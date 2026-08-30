import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const rules: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "packages/domain": ["next", "expo", "react", "@supabase", "@vercel", "openai", "@anthropic-ai"],
  "packages/contracts": [
    "next",
    "expo",
    "react",
    "@supabase",
    "@vercel",
    "openai",
    "@anthropic-ai"
  ],
  "packages/ai-routing": ["next", "expo", "react", "@supabase", "@vercel"]
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [fullPath] : [];
    })
  );
  return nested.flat();
}

const violations: string[] = [];
for (const [relativeDirectory, forbiddenImports] of Object.entries(rules)) {
  const directory = path.join(repositoryRoot, relativeDirectory, "src");
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    for (const forbidden of forbiddenImports) {
      const pattern = new RegExp(
        `(?:from\\s+["']|import\\s*\\(["'])${forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "u"
      );
      if (pattern.test(source))
        violations.push(`${path.relative(repositoryRoot, file)} imports ${forbidden}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Package boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Package boundaries verified.\n");
}
