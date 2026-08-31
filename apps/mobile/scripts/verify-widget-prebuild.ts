import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_VARIANTS, extensionBundleIdentifier, resolveAppVariant } from "../config/appVariants";

const mobileRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const iosRoot = path.join(mobileRoot, "ios");
const targetName = "QuickCaptureWidget";
const variant = resolveAppVariant(process.env.UNFILED_APP_VARIANT);
const identifiers = APP_VARIANTS[variant];
const widgetBundleIdentifier = extensionBundleIdentifier(variant);

interface StructuralInventory {
  appExtensionTargets: number;
  bundleIdentifierSettings: number;
  embedPhases: number;
  embeddedProducts: number;
  productReferences: number;
  sqlCipherEnabled: boolean;
  sourceMembership: Record<string, number>;
  widgetFiles: Record<string, string>;
}

function fail(message: string): never {
  throw new Error(`Widget prebuild verification failed: ${message}`);
}

function occurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function requireText(source: string, expected: string, label: string): void {
  if (!source.includes(expected)) fail(`${label} is missing ${JSON.stringify(expected)}`);
}

async function filesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesRecursively(fullPath) : [fullPath];
    })
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function projectFile(): Promise<string> {
  const entries = await readdir(iosRoot, { withFileTypes: true });
  const projects = entries.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj")
  );
  if (projects.length !== 1) fail(`expected one xcodeproj, found ${projects.length}`);
  const project = projects[0];
  if (project === undefined) fail("the generated xcodeproj is missing");
  return path.join(iosRoot, project.name, "project.pbxproj");
}

async function inventory(): Promise<StructuralInventory> {
  const pbxProject = await readFile(await projectFile(), "utf8");
  const podfileProperties = JSON.parse(
    await readFile(path.join(iosRoot, "Podfile.properties.json"), "utf8")
  ) as Record<string, unknown>;
  const widgetRoot = path.join(iosRoot, targetName);
  const widgetFiles = await filesRecursively(widgetRoot);
  const sourceNames = [
    "QuickCaptureProvider.swift",
    "QuickCaptureWidget.swift",
    "QuickCaptureWidgetBundle.swift",
    "UnfiledCaptureMark.swift"
  ] as const;

  const sourceMembership = Object.fromEntries(
    sourceNames.map((name) => [
      name,
      occurrences(
        pbxProject,
        new RegExp(
          `/\\* ${name.replace(".", "\\.")} in Sources \\*/ = \\{isa = PBXBuildFile;`,
          "gu"
        )
      )
    ])
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      widgetFiles.map(
        async (file) => [path.relative(widgetRoot, file), await sha256(file)] as const
      )
    )
  );

  return {
    appExtensionTargets: occurrences(
      pbxProject,
      /productType = "com\.apple\.product-type\.app-extension";/gu
    ),
    bundleIdentifierSettings: occurrences(
      pbxProject,
      new RegExp(
        `PRODUCT_BUNDLE_IDENTIFIER = "?${widgetBundleIdentifier.replaceAll(".", "\\.")}"?;`,
        "gu"
      )
    ),
    embedPhases: occurrences(pbxProject, /name = "Embed App Extensions";/gu),
    embeddedProducts: occurrences(
      pbxProject,
      /\/\* QuickCaptureWidget\.appex in (?:Copy Files|Embed App Extensions) \*\/ = \{isa = PBXBuildFile;/gu
    ),
    productReferences: occurrences(
      pbxProject,
      /\/\* QuickCaptureWidget\.appex \*\/ = \{isa = PBXFileReference;[^\n]*explicitFileType = "wrapper\.app-extension";/gu
    ),
    sqlCipherEnabled: podfileProperties["expo.sqlite.useSQLCipher"] === "true",
    sourceMembership,
    widgetFiles: hashes
  };
}

async function verifyRenderedConfiguration(current: StructuralInventory): Promise<void> {
  if (!current.sqlCipherEnabled) {
    fail("Expo SQLite did not render the required SQLCipher native build property");
  }
  if (current.appExtensionTargets !== 1) {
    fail(`expected one app-extension target, found ${current.appExtensionTargets}`);
  }
  if (current.productReferences !== 1) {
    fail(`expected one widget product reference, found ${current.productReferences}`);
  }
  if (current.embedPhases !== 1) {
    fail(`expected one Embed App Extensions phase, found ${current.embedPhases}`);
  }
  if (current.embeddedProducts !== 1) {
    fail(`expected the widget product to be embedded once, found ${current.embeddedProducts}`);
  }
  if (current.bundleIdentifierSettings !== 2) {
    fail(
      `expected widget bundle identifier in Debug and Release, found ${current.bundleIdentifierSettings}`
    );
  }
  for (const [source, count] of Object.entries(current.sourceMembership)) {
    if (count !== 1) fail(`${source} has ${count} Sources build memberships`);
  }

  const provider = await readFile(
    path.join(iosRoot, targetName, "QuickCaptureProvider.swift"),
    "utf8"
  );
  const widget = await readFile(path.join(iosRoot, targetName, "QuickCaptureWidget.swift"), "utf8");
  const extensionEntitlements = await readFile(
    path.join(iosRoot, targetName, "QuickCaptureWidget.entitlements"),
    "utf8"
  );
  const extensionInfo = await readFile(path.join(iosRoot, targetName, "Info.plist"), "utf8");

  requireText(provider, identifiers.appGroupIdentifier, "widget provider");
  requireText(
    provider,
    `${identifiers.scheme}://capture?source=ios_lock_screen_widget`,
    "widget provider"
  );
  requireText(widget, ".accessoryCircular", "widget families");
  requireText(widget, ".accessoryRectangular", "widget families");
  requireText(widget, ".widgetURL(QuickCaptureWidgetConstants.captureURL)", "widget URL");
  requireText(extensionEntitlements, identifiers.appGroupIdentifier, "widget entitlements");
  requireText(extensionInfo, "com.apple.widgetkit-extension", "widget Info.plist");

  const allGeneratedFiles = await filesRecursively(iosRoot);
  const containingAppFiles = allGeneratedFiles.filter(
    (file) =>
      !file.startsWith(path.join(iosRoot, targetName)) &&
      /(?:Info\.plist|\.entitlements)$/u.test(file)
  );
  const containingAppText = (
    await Promise.all(containingAppFiles.map((file) => readFile(file, "utf8")))
  ).join("\n");
  requireText(containingAppText, identifiers.appGroupIdentifier, "containing app entitlements");
  requireText(containingAppText, identifiers.scheme, "containing app URL scheme");
}

function runPrebuild(): void {
  const result = spawnSync(
    "pnpm",
    ["exec", "expo", "prebuild", "--platform", "ios", "--clean", "--no-install"],
    {
      cwd: mobileRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1", UNFILED_APP_VARIANT: variant },
      stdio: "pipe"
    }
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`expo prebuild exited with ${result.status ?? "no status"}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--inspect-only")) {
    const current = await inventory();
    await verifyRenderedConfiguration(current);
    process.stdout.write(
      `QuickCaptureWidget generated project is structurally valid for ${variant}.\n`
    );
    return;
  }

  runPrebuild();
  const first = await inventory();
  await verifyRenderedConfiguration(first);

  runPrebuild();
  const second = await inventory();
  await verifyRenderedConfiguration(second);

  if (JSON.stringify(first) !== JSON.stringify(second)) {
    fail("the second clean prebuild changed the structural inventory");
  }
  process.stdout.write(
    `QuickCaptureWidget and SQLCipher prebuild are deterministic for ${variant}: one target, product, and embed phase.\n`
  );
}

await main();
