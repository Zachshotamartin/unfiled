import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

type BoundaryRule = Readonly<{
  forbidden: readonly string[];
  sourceRoots: readonly string[];
}>;

// Keep retired client runtimes forbidden even after their source tree is deleted. This prevents
// server/domain packages from quietly reintroducing the superseded dependency boundary.
const retiredClientDependencies = ["expo", "react-native", "@unfiled/mobile"] as const;

const rules: Readonly<Record<string, BoundaryRule>> = Object.freeze({
  "packages/domain": {
    forbidden: [
      "next",
      "react",
      ...retiredClientDependencies,
      "@supabase",
      "@vercel",
      "openai",
      "@anthropic-ai"
    ],
    sourceRoots: ["src"]
  },
  "packages/contracts": {
    forbidden: [
      "next",
      "react",
      ...retiredClientDependencies,
      "@supabase",
      "@vercel",
      "openai",
      "@anthropic-ai"
    ],
    sourceRoots: ["src"]
  },
  "packages/ai-routing": {
    forbidden: ["next", "react", ...retiredClientDependencies, "@supabase", "@vercel"],
    sourceRoots: ["src"]
  },
  "packages/key-management": {
    forbidden: [
      "next",
      "react",
      ...retiredClientDependencies,
      "@supabase",
      "openai",
      "@anthropic-ai"
    ],
    sourceRoots: ["src"]
  },
  "packages/encrypted-aggregate": {
    forbidden: [
      "next",
      "react",
      ...retiredClientDependencies,
      "@supabase",
      "@vercel",
      "openai",
      "@anthropic-ai"
    ],
    sourceRoots: ["src"]
  },
  "apps/worker": {
    forbidden: ["next", "react", ...retiredClientDependencies, "@unfiled/web"],
    sourceRoots: ["src", "api"]
  }
});

const manifestSections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

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

function importedSpecifiers(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];

  const addStringLiteral = (value: ts.Expression | undefined): void => {
    if (value !== undefined && ts.isStringLiteralLike(value)) specifiers.push(value.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      addStringLiteral(node.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isForbiddenSpecifier(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function sourceViolations(
  relativeFile: string,
  source: string,
  forbiddenImports: readonly string[]
): string[] {
  const specifiers = importedSpecifiers(source, relativeFile);
  return forbiddenImports.flatMap((forbidden) =>
    specifiers.some((specifier) => isForbiddenSpecifier(specifier, forbidden))
      ? [`${relativeFile} imports ${forbidden}`]
      : []
  );
}

function manifestViolations(
  relativeDirectory: string,
  manifest: unknown,
  forbiddenDependencies: readonly string[]
): string[] {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`${relativeDirectory}/package.json must contain a JSON object`);
  }
  const record = manifest as Readonly<Record<string, unknown>>;
  return manifestSections.flatMap((section) => {
    const dependencies = record[section];
    if (dependencies === undefined) return [];
    if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
      throw new Error(`${relativeDirectory}/package.json has an invalid ${section} object`);
    }
    return Object.keys(dependencies).flatMap((dependency) =>
      forbiddenDependencies.some((forbidden) => isForbiddenSpecifier(dependency, forbidden))
        ? [`${relativeDirectory}/package.json declares ${dependency} in ${section}`]
        : []
    );
  });
}

function assertScannerSelfTest(): void {
  const workerRule = rules["apps/worker"];
  if (workerRule === undefined || !workerRule.sourceRoots.includes("api")) {
    throw new Error("Boundary scanner self-test failed: worker API root is not covered");
  }
  const apiFixture = sourceViolations(
    "apps/worker/api/internal/fixture.ts",
    'import { unsafe } from "@unfiled/web/server";\nvoid unsafe;',
    workerRule.forbidden
  );
  const manifestFixture = manifestViolations(
    "apps/worker",
    { dependencies: { "@unfiled/mobile": "workspace:*" } },
    workerRule.forbidden
  );
  if (apiFixture.length !== 1 || manifestFixture.length !== 1) {
    throw new Error("Boundary scanner self-test failed: worker violations were not detected");
  }
}

assertScannerSelfTest();

const violations: string[] = [];
for (const [relativeDirectory, rule] of Object.entries(rules)) {
  for (const sourceRoot of rule.sourceRoots) {
    const directory = path.join(repositoryRoot, relativeDirectory, sourceRoot);
    for (const file of await sourceFiles(directory)) {
      const source = await readFile(file, "utf8");
      violations.push(
        ...sourceViolations(path.relative(repositoryRoot, file), source, rule.forbidden)
      );
    }
  }

  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, relativeDirectory, "package.json"), "utf8")
  ) as unknown;
  violations.push(...manifestViolations(relativeDirectory, packageManifest, rule.forbidden));
}

if (violations.length > 0) {
  process.stderr.write(
    `Package boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Package source, API, and manifest boundaries verified.\n");
}
