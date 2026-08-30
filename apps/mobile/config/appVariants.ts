export const APP_VARIANTS = {
  development: {
    appGroupIdentifier: "group.com.zachshotamartin.unfiled.dev",
    bundleIdentifier: "com.zachshotamartin.unfiled.dev",
    displayName: "Unfiled Dev",
    packageName: "com.zachshotamartin.unfiled.dev",
    scheme: "unfiled-dev"
  },
  preview: {
    appGroupIdentifier: "group.com.zachshotamartin.unfiled.preview",
    bundleIdentifier: "com.zachshotamartin.unfiled.preview",
    displayName: "Unfiled Preview",
    packageName: "com.zachshotamartin.unfiled.preview",
    scheme: "unfiled-preview"
  },
  production: {
    appGroupIdentifier: "group.com.zachshotamartin.unfiled",
    bundleIdentifier: "com.zachshotamartin.unfiled",
    displayName: "Unfiled",
    packageName: "com.zachshotamartin.unfiled",
    scheme: "unfiled"
  }
} as const;

export type AppVariant = keyof typeof APP_VARIANTS;

export function resolveAppVariant(value: string | undefined): AppVariant {
  if (value === undefined || value.length === 0) return "development";
  if (Object.hasOwn(APP_VARIANTS, value)) return value as AppVariant;
  throw new TypeError(
    `UNFILED_APP_VARIANT must be development, preview, or production; received ${JSON.stringify(value)}`
  );
}

export function extensionBundleIdentifier(variant: AppVariant): string {
  return `${APP_VARIANTS[variant].bundleIdentifier}.quickcapture`;
}
