# ADR-0003: Immutable native application identifiers

- Status: accepted
- Date: 2026-08-30
- Decision drivers: Apple identifiers become difficult to change after credentials and App Store records exist; preview and development builds must coexist with production; the Lock Screen extension and host app must share an explicit App Group.

## Context

Milestone A generates an iOS WidgetKit extension from Expo configuration. Apple signing requires the host bundle identifier, extension bundle identifier, and App Group identifier to match registered values exactly. Android likewise needs stable package names. The original planning examples used generic `app.unfiled.mobile` identifiers, which are not tied to a controlled reverse-DNS namespace.

## Decision

Use `com.zachshotamartin.unfiled` as the production host bundle identifier and Android package name. Use `com.zachshotamartin.unfiled.quickcapture` for the production widget extension and `group.com.zachshotamartin.unfiled` for the production App Group.

Development and preview builds append `.dev` or `.preview` to the host identifier and App Group before the `.quickcapture` extension suffix. Their URL schemes are `unfiled-dev` and `unfiled-preview`; production uses `unfiled`.

`apps/mobile/config/appVariants.ts` is the single source of truth. EAS configuration, Expo prebuild, entitlements, Info.plist values, tests, and human setup instructions derive from or must match this file.

## Alternatives considered

- `app.unfiled.mobile`: concise, but not tied to the developer's reverse-DNS namespace and already diverged from the generated native configuration.
- One identifier for every environment: simpler configuration, but prevents development, preview, and production builds from coexisting on a device and risks signing the wrong App Group.
- Commit hand-edited Xcode targets: avoids a config plugin, but makes a clean Expo prebuild nondeterministic and violates the selected managed-native strategy.

## Consequences

Apple App IDs, App Groups, EAS credentials, Android package records, associated domains, and store listings must use these exact identifiers. A future legal rename may change the display name and marketing domain without changing these identifiers. Changing the identifiers requires a superseding ADR and new platform records.
