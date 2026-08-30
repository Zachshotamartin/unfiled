export const WIDGET_TEMPLATE_TOKENS = {
  appGroupIdentifier: "__UNFILED_APP_GROUP_IDENTIFIER__",
  scheme: "__UNFILED_SCHEME__"
} as const;

export const WIDGET_SWIFT_SOURCE_FILES = [
  "QuickCaptureProvider.swift",
  "QuickCaptureWidget.swift",
  "QuickCaptureWidgetBundle.swift",
  "UnfiledCaptureMark.swift"
] as const;

export const WIDGET_RESOURCE_FILES = ["Assets.xcassets"] as const;

export interface QuickCaptureWidgetOptions {
  appGroupIdentifier: string;
  bundleIdentifier: string;
  scheme: string;
  targetName: string;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/u;
const schemePattern = /^[a-z][a-z0-9+.-]*$/u;
const targetPattern = /^[A-Za-z][A-Za-z0-9]*$/u;

export function validateWidgetOptions(options: QuickCaptureWidgetOptions): void {
  if (
    !options.appGroupIdentifier.startsWith("group.") ||
    !identifierPattern.test(options.appGroupIdentifier)
  ) {
    throw new TypeError("Quick Capture App Group identifier is invalid");
  }
  if (!identifierPattern.test(options.bundleIdentifier)) {
    throw new TypeError("Quick Capture extension bundle identifier is invalid");
  }
  if (!options.bundleIdentifier.endsWith(".quickcapture")) {
    throw new TypeError("Quick Capture extension bundle identifier must end in .quickcapture");
  }
  if (!schemePattern.test(options.scheme)) {
    throw new TypeError("Quick Capture URL scheme is invalid");
  }
  if (!targetPattern.test(options.targetName)) {
    throw new TypeError("Quick Capture target name is invalid");
  }
}

export function renderWidgetTemplate(
  source: string,
  options: Pick<QuickCaptureWidgetOptions, "appGroupIdentifier" | "scheme">
): string {
  const rendered = source
    .replaceAll(WIDGET_TEMPLATE_TOKENS.appGroupIdentifier, options.appGroupIdentifier)
    .replaceAll(WIDGET_TEMPLATE_TOKENS.scheme, options.scheme);
  if (/__UNFILED_[A-Z_]+__/u.test(rendered)) {
    throw new TypeError("A Quick Capture native template token was not resolved");
  }
  return rendered;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
