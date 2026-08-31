import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigContext } from "expo/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import createExpoConfig from "../app.config";
import { APP_VARIANTS, extensionBundleIdentifier, resolveAppVariant } from "../config/appVariants";
import {
  WIDGET_SWIFT_SOURCE_FILES,
  renderWidgetTemplate,
  uniqueSorted,
  validateWidgetOptions,
  type QuickCaptureWidgetOptions
} from "../plugins/quickCaptureWidgetConfig";

const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeTargetRoot = path.join(mobileRoot, "native-targets", "quick-capture-widget");
const configContext: ConfigContext = {
  projectRoot: mobileRoot,
  staticConfigPath: null,
  packageJsonPath: path.join(mobileRoot, "package.json"),
  config: {}
};

const validOptions: QuickCaptureWidgetOptions = {
  appGroupIdentifier: "group.com.zachshotamartin.unfiled.dev",
  bundleIdentifier: "com.zachshotamartin.unfiled.dev.quickcapture",
  scheme: "unfiled-dev",
  targetName: "QuickCaptureWidget"
};

describe("fixed app identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("locks distinct development, preview, and production identifiers", () => {
    expect(Object.keys(APP_VARIANTS)).toEqual(["development", "preview", "production"]);
    expect(
      new Set(Object.values(APP_VARIANTS).map(({ bundleIdentifier }) => bundleIdentifier)).size
    ).toBe(3);
    expect(new Set(Object.values(APP_VARIANTS).map(({ scheme }) => scheme)).size).toBe(3);
    for (const [variant, identifiers] of Object.entries(APP_VARIANTS)) {
      expect(identifiers.appGroupIdentifier).toBe(`group.${identifiers.bundleIdentifier}`);
      expect(extensionBundleIdentifier(variant as keyof typeof APP_VARIANTS)).toBe(
        `${identifiers.bundleIdentifier}.quickcapture`
      );
    }
  });

  it("builds every executable Expo config from the tested identity table", () => {
    for (const [variant, identifiers] of Object.entries(APP_VARIANTS)) {
      vi.stubEnv("UNFILED_APP_VARIANT", variant);
      const config = createExpoConfig(configContext);

      expect(config.name).toBe(identifiers.displayName);
      expect(config.scheme).toBe(identifiers.scheme);
      expect(config.ios?.bundleIdentifier).toBe(identifiers.bundleIdentifier);
      expect(config.ios?.config?.usesNonExemptEncryption).toBe(false);
      expect(config.ios?.entitlements?.["com.apple.security.application-groups"]).toEqual([
        identifiers.appGroupIdentifier
      ]);
      expect(config.android?.package).toBe(identifiers.packageName);
      expect(config.plugins).toContainEqual([
        "expo-secure-store",
        { configureAndroidBackup: true, faceIDPermission: false }
      ]);
    }
  });

  it("defaults local work to development and rejects misspelled build variants", () => {
    expect(resolveAppVariant(undefined)).toBe("development");
    expect(resolveAppVariant("")).toBe("development");
    expect(resolveAppVariant("production")).toBe("production");
    expect(() => resolveAppVariant("prod")).toThrow(/must be development, preview, or production/u);
  });
});

describe("Quick Capture config plugin invariants", () => {
  it("validates identifiers before native generation", () => {
    expect(() => validateWidgetOptions(validOptions)).not.toThrow();
    expect(() => validateWidgetOptions({ ...validOptions, scheme: "Unfiled Dev" })).toThrow(
      /scheme is invalid/u
    );
    expect(() =>
      validateWidgetOptions({ ...validOptions, bundleIdentifier: "com.example.widget" })
    ).toThrow(/must end in .quickcapture/u);
    expect(() => validateWidgetOptions({ ...validOptions, targetName: "../Widget" })).toThrow(
      /target name is invalid/u
    );
  });

  it("renders native sources deterministically and fails closed on unknown tokens", () => {
    const template = "group=__UNFILED_APP_GROUP_IDENTIFIER__ url=__UNFILED_SCHEME__://capture";
    const first = renderWidgetTemplate(template, validOptions);
    const second = renderWidgetTemplate(template, validOptions);
    expect(first).toBe(second);
    expect(first).toBe("group=group.com.zachshotamartin.unfiled.dev url=unfiled-dev://capture");
    expect(() => renderWidgetTemplate("__UNFILED_UNKNOWN__", validOptions)).toThrow(
      /was not resolved/u
    );
    expect(uniqueSorted(["group.b", "group.a", "group.b"])).toEqual(["group.a", "group.b"]);
  });

  it("checks in a complete, privacy-minimal widget source set", async () => {
    expect(WIDGET_SWIFT_SOURCE_FILES).toEqual([
      "QuickCaptureProvider.swift",
      "QuickCaptureWidget.swift",
      "QuickCaptureWidgetBundle.swift",
      "UnfiledCaptureMark.swift"
    ]);
    const sources = await Promise.all(
      WIDGET_SWIFT_SOURCE_FILES.map((file) => readFile(path.join(nativeTargetRoot, file), "utf8"))
    );
    const combined = sources.join("\n");
    expect(combined).toContain("StaticConfiguration");
    expect(combined).toContain(".accessoryCircular");
    expect(combined).toContain(".accessoryRectangular");
    expect(combined).toContain(".widgetURL(QuickCaptureWidgetConstants.captureURL)");
    expect(combined).toContain("ios_lock_screen_widget");
    expect(combined).not.toMatch(
      /rawContent|raw_content|accessToken|refreshToken|email|noteTitle/iu
    );
  });

  it("configures one app-extension target, App Group, frameworks, and embed phase", async () => {
    const pluginSource = await readFile(
      path.join(mobileRoot, "plugins", "withQuickCaptureWidget.ts"),
      "utf8"
    );
    expect(pluginSource).toContain('"app_extension"');
    expect(pluginSource).toContain('"Embed App Extensions"');
    expect(pluginSource).toContain('"WidgetKit.framework"');
    expect(pluginSource).toContain('"SwiftUI.framework"');
    expect(pluginSource).toContain('APPLICATION_EXTENSION_API_ONLY: "YES"');
    expect(pluginSource).toContain("withEntitlementsPlist");
    expect(pluginSource).toContain("withDangerousMod");
    expect(pluginSource).not.toMatch(/TODO|FIXME|placeholder/iu);

    const entitlements = await readFile(
      path.join(nativeTargetRoot, "QuickCaptureWidget.entitlements"),
      "utf8"
    );
    expect(entitlements).toContain("com.apple.security.application-groups");
    expect(entitlements).toContain("__UNFILED_APP_GROUP_IDENTIFIER__");
  });

  it("keeps the Expo bridge module distinct from the WidgetKit extension", async () => {
    const bridgePodspec = await readFile(
      path.join(
        mobileRoot,
        "modules",
        "quick-capture-widget",
        "ios",
        "UnfiledQuickCaptureBridge.podspec"
      ),
      "utf8"
    );
    expect(bridgePodspec).toContain('spec.name = "UnfiledQuickCaptureBridge"');
    expect(bridgePodspec).not.toContain(`spec.name = "${validOptions.targetName}"`);
  });

  it("checks in a clean-prebuild-twice structural gate", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(mobileRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    const verifier = await readFile(
      path.join(mobileRoot, "scripts", "verify-widget-prebuild.ts"),
      "utf8"
    );
    expect(packageJson.scripts["verify:widget-prebuild"]).toBe(
      "tsx scripts/verify-widget-prebuild.ts"
    );
    expect(verifier).toContain('"--clean"');
    expect(verifier).toContain('"--no-install"');
    expect(verifier.match(/runPrebuild\(\);/gu)).toHaveLength(2);
    expect(verifier).toContain("Copy Files|Embed App Extensions");
    expect(verifier).toContain("the second clean prebuild changed the structural inventory");
  });
});
