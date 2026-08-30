import type { ConfigContext, ExpoConfig } from "expo/config";

import {
  APP_VARIANTS,
  extensionBundleIdentifier,
  resolveAppVariant
} from "./config/appVariants.ts";

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = resolveAppVariant(process.env.UNFILED_APP_VARIANT);
  const identifiers = APP_VARIANTS[variant];
  const widgetBundleIdentifier = extensionBundleIdentifier(variant);

  return {
    ...config,
    name: identifiers.displayName,
    slug: "unfiled",
    version: "0.1.0",
    orientation: "portrait",
    scheme: identifiers.scheme,
    userInterfaceStyle: "dark",
    ios: {
      bundleIdentifier: identifiers.bundleIdentifier,
      entitlements: {
        "com.apple.security.application-groups": [identifiers.appGroupIdentifier]
      },
      infoPlist: {
        UnfiledAppGroupIdentifier: identifiers.appGroupIdentifier,
        UIUserInterfaceStyle: "Dark"
      },
      supportsTablet: false
    },
    android: {
      package: identifiers.packageName,
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: false,
          category: ["BROWSABLE", "DEFAULT"],
          data: [{ scheme: identifiers.scheme }]
        }
      ]
    },
    plugins: [
      "expo-router",
      "expo-sqlite",
      ["expo-build-properties", { ios: { deploymentTarget: "17.0" } }],
      [
        "./plugins/withQuickCaptureWidget",
        {
          appGroupIdentifier: identifiers.appGroupIdentifier,
          bundleIdentifier: widgetBundleIdentifier,
          scheme: identifiers.scheme,
          targetName: "QuickCaptureWidget"
        }
      ]
    ],
    experiments: {
      typedRoutes: true
    },
    extra: {
      appVariant: variant,
      appGroupIdentifier: identifiers.appGroupIdentifier,
      eas: {
        build: {
          experimental: {
            ios: {
              appExtensions: [
                {
                  targetName: "QuickCaptureWidget",
                  bundleIdentifier: widgetBundleIdentifier,
                  entitlements: {
                    "com.apple.security.application-groups": [identifiers.appGroupIdentifier]
                  }
                }
              ]
            }
          }
        }
      }
    }
  };
};
