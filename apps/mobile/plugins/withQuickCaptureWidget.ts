/* node-xcode exposes its project graph as an untyped mutable object through Expo's XcodeProject. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  createRunOncePlugin,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
  type ConfigPlugin,
  type XcodeProject
} from "@expo/config-plugins";
import { promises as fs } from "node:fs";
import path from "node:path";

const PLUGIN_NAME = "@unfiled/mobile/withQuickCaptureWidget";
const PLUGIN_VERSION = "1.0.0";
const INFO_PLIST_FILE = "Info.plist";
const ENTITLEMENTS_FILE = "QuickCaptureWidget.entitlements";
const APP_GROUP_TEMPLATE_TOKEN = "__UNFILED_APP_GROUP_IDENTIFIER__";
const SCHEME_TEMPLATE_TOKEN = "__UNFILED_SCHEME__";
const WIDGET_SWIFT_SOURCE_FILES = [
  "QuickCaptureProvider.swift",
  "QuickCaptureWidget.swift",
  "QuickCaptureWidgetBundle.swift",
  "UnfiledCaptureMark.swift"
] as const;
const WIDGET_RESOURCE_FILES = ["Assets.xcassets"] as const;

interface QuickCaptureWidgetOptions {
  appGroupIdentifier: string;
  bundleIdentifier: string;
  scheme: string;
  targetName: string;
}

function validateWidgetOptions(options: QuickCaptureWidgetOptions): void {
  const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/u;
  if (
    !options.appGroupIdentifier.startsWith("group.") ||
    !identifierPattern.test(options.appGroupIdentifier)
  ) {
    throw new TypeError("Quick Capture App Group identifier is invalid");
  }
  if (
    !identifierPattern.test(options.bundleIdentifier) ||
    !options.bundleIdentifier.endsWith(".quickcapture")
  ) {
    throw new TypeError("Quick Capture extension bundle identifier is invalid");
  }
  if (!/^[a-z][a-z0-9+.-]*$/u.test(options.scheme)) {
    throw new TypeError("Quick Capture URL scheme is invalid");
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(options.targetName)) {
    throw new TypeError("Quick Capture target name is invalid");
  }
}

function renderWidgetTemplate(source: string, options: QuickCaptureWidgetOptions): string {
  const rendered = source
    .replaceAll(APP_GROUP_TEMPLATE_TOKEN, options.appGroupIdentifier)
    .replaceAll(SCHEME_TEMPLATE_TOKEN, options.scheme);
  if (/__UNFILED_[A-Z_]+__/u.test(rendered)) {
    throw new TypeError("A Quick Capture native template token was not resolved");
  }
  return rendered;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

interface NativeTarget {
  pbxNativeTarget: {
    buildConfigurationList: string;
    buildPhases: { comment: string; value: string }[];
    name: string;
    productReference: string;
    productType: string;
  };
  uuid: string;
}

interface BuildConfiguration {
  buildSettings: Record<string, string>;
  name: string;
}

interface ConfigurationList {
  buildConfigurations: { value: string }[];
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/u, "$1");
}

function nativeTarget(project: XcodeProject, targetName: string): NativeTarget | null {
  const targets = project.pbxNativeTargetSection() as Record<
    string,
    NativeTarget["pbxNativeTarget"] | string
  >;
  for (const [uuid, candidate] of Object.entries(targets)) {
    if (uuid.endsWith("_comment") || typeof candidate === "string") continue;
    if (unquote(candidate.name) === targetName) return { pbxNativeTarget: candidate, uuid };
  }
  return null;
}

function configureTargetBuildSettings(
  project: XcodeProject,
  target: NativeTarget,
  options: QuickCaptureWidgetOptions
): void {
  const configurationLists = project.pbxXCConfigurationList() as Record<
    string,
    ConfigurationList | string
  >;
  const configurationList = configurationLists[target.pbxNativeTarget.buildConfigurationList];
  if (configurationList === undefined || typeof configurationList === "string") {
    throw new TypeError(`Missing build configuration list for ${options.targetName}`);
  }

  const configurations = project.pbxXCBuildConfigurationSection() as Record<
    string,
    BuildConfiguration | string
  >;
  for (const reference of configurationList.buildConfigurations) {
    const configuration = configurations[reference.value];
    if (configuration === undefined || typeof configuration === "string") continue;
    Object.assign(configuration.buildSettings, {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: '"AccentColor"',
      CODE_SIGN_ENTITLEMENTS: `"${options.targetName}/${ENTITLEMENTS_FILE}"`,
      CURRENT_PROJECT_VERSION: '"1"',
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `"${options.targetName}/${INFO_PLIST_FILE}"`,
      IPHONEOS_DEPLOYMENT_TARGET: "17.0",
      MARKETING_VERSION: '"0.1.0"',
      PRODUCT_BUNDLE_IDENTIFIER: `"${options.bundleIdentifier}"`,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SKIP_INSTALL: "YES",
      SWIFT_EMIT_LOC_STRINGS: "YES",
      SWIFT_VERSION: "5.9",
      TARGETED_DEVICE_FAMILY: '"1"'
    });
  }
}

function targetHasPhase(target: NativeTarget, name: string): boolean {
  return target.pbxNativeTarget.buildPhases.some((phase) => phase.comment === name);
}

function addWidgetBuildPhases(
  project: XcodeProject,
  target: NativeTarget,
  targetName: string
): void {
  if (!targetHasPhase(target, "Sources")) {
    project.addBuildPhase(
      WIDGET_SWIFT_SOURCE_FILES.map((file) => `${targetName}/${file}`),
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid
    );
  }
  if (!targetHasPhase(target, "Resources")) {
    project.addBuildPhase(
      WIDGET_RESOURCE_FILES.map((file) => `${targetName}/${file}`),
      "PBXResourcesBuildPhase",
      "Resources",
      target.uuid
    );
  }
  if (!targetHasPhase(target, "Frameworks")) {
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
    project.addFramework("WidgetKit.framework", { link: true, target: target.uuid });
    project.addFramework("SwiftUI.framework", { link: true, target: target.uuid });
  }
}

function normalizeEmbedPhase(project: XcodeProject, targetName: string): void {
  const applicationTarget = project.getFirstTarget() as {
    firstTarget: NativeTarget["pbxNativeTarget"];
    uuid: string;
  };
  const copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase as Record<
    string,
    { dstSubfolderSpec?: number; files?: { comment?: string }[]; name?: string } | string
  >;
  const candidate = [...applicationTarget.firstTarget.buildPhases].reverse().find((phase) => {
    const buildPhase = copyPhases[phase.value];
    if (buildPhase === undefined || typeof buildPhase === "string") return false;
    if (buildPhase.dstSubfolderSpec !== 13) return false;
    return (
      phase.comment === "Embed App Extensions" ||
      buildPhase.files?.some((file) => file.comment?.includes(`${targetName}.appex`)) === true
    );
  });
  if (candidate === undefined) {
    throw new TypeError(`The ${targetName} product was not embedded in the containing app`);
  }

  candidate.comment = "Embed App Extensions";
  const buildPhase = copyPhases[candidate.value];
  if (buildPhase !== undefined && typeof buildPhase !== "string") {
    buildPhase.name = '"Embed App Extensions"';
  }
  copyPhases[`${candidate.value}_comment`] = "Embed App Extensions";
}

function configureXcodeProject(
  project: XcodeProject,
  options: QuickCaptureWidgetOptions
): XcodeProject {
  let target = nativeTarget(project, options.targetName);
  target ??= project.addTarget(
    options.targetName,
    "app_extension",
    options.targetName,
    options.bundleIdentifier
  ) as NativeTarget;
  addWidgetBuildPhases(project, target, options.targetName);
  configureTargetBuildSettings(project, target, options);
  normalizeEmbedPhase(project, options.targetName);
  return project;
}

async function copyRenderedDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  options: QuickCaptureWidgetOptions
): Promise<void> {
  await fs.rm(destinationDirectory, { force: true, recursive: true });
  await fs.mkdir(destinationDirectory, { recursive: true });

  async function visit(source: string, destination: string): Promise<void> {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true });
        await visit(from, to);
      } else if (entry.isFile()) {
        const template = await fs.readFile(from, "utf8");
        await fs.writeFile(to, renderWidgetTemplate(template, options), "utf8");
      } else {
        throw new TypeError(`Unsupported native template entry: ${from}`);
      }
    }
  }

  await visit(sourceDirectory, destinationDirectory);
}

const withQuickCaptureWidget: ConfigPlugin<QuickCaptureWidgetOptions> = (config, options) => {
  validateWidgetOptions(options);

  config = withEntitlementsPlist(config, (entitlementsConfig) => {
    const key = "com.apple.security.application-groups";
    const current = entitlementsConfig.modResults[key];
    const groups = Array.isArray(current)
      ? current.filter((value): value is string => typeof value === "string")
      : [];
    entitlementsConfig.modResults[key] = uniqueSorted([...groups, options.appGroupIdentifier]);
    return entitlementsConfig;
  });

  config = withInfoPlist(config, (infoConfig) => {
    infoConfig.modResults.UnfiledAppGroupIdentifier = options.appGroupIdentifier;
    return infoConfig;
  });

  config = withDangerousMod(config, [
    "ios",
    async (dangerousConfig) => {
      const templateDirectory = path.join(
        dangerousConfig.modRequest.projectRoot,
        "native-targets",
        "quick-capture-widget"
      );
      const destinationDirectory = path.join(
        dangerousConfig.modRequest.platformProjectRoot,
        options.targetName
      );
      await copyRenderedDirectory(templateDirectory, destinationDirectory, options);
      return dangerousConfig;
    }
  ]);

  config = withXcodeProject(config, (xcodeConfig) => {
    xcodeConfig.modResults = configureXcodeProject(xcodeConfig.modResults, options);
    return xcodeConfig;
  });

  return config;
};

export default createRunOncePlugin(withQuickCaptureWidget, PLUGIN_NAME, PLUGIN_VERSION);
