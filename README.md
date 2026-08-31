# Unfiled

Unfiled is a capture-first notes product: write before deciding where a thought belongs, then inspect, correct, or undo the organization result.

The canonical phone client is the native Apple app in [`apps/ios`](./apps/ios). It targets iOS 17 and newer and uses SwiftUI, a WidgetKit Lock Screen extension driven by App Intents, and an Xcode project generated from [`apps/ios/project.yml`](./apps/ios/project.yml) with XcodeGen. Its local capture outbox and note cache use GRDB's SQLCipher build, complete file protection, and a device-generated database key that Keychain releases only while the device is unlocked. The web client and iOS app share the same authenticated backend contracts. [ADR-0010](./docs/decisions/ADR-0010-native-ios-client-replacement.md) records the replacement. Android is intentionally outside this milestone; there is no supported Android client in the current product surface.

The repository still requires account-bound Vercel, AWS, database-login, CloudTrail, Apple signing, archive, and physical-iPhone evidence before production release. Unsigned simulator builds verify compilation and tests, but do not establish provisioning, App Group behavior, Keychain/SQLCipher behavior on hardware, extension packaging, or App Store readiness. The product must not be described as end-to-end encrypted.

## Native iOS quick start

Install full Xcode and the repository-pinned XcodeGen 2.46.0 release, then run these commands from the repository root. The exact generator version is required because later XcodeGen releases may produce a different checked-in project order:

```bash
pnpm ios:generate
pnpm ios:resolve
pnpm ios:build
pnpm ios:test
```

`pnpm ios:ci` runs those phases in order. The test script selects an available iPhone Simulator; set `UNFILED_IOS_TEST_DESTINATION` when a specific runtime/device is required.

The generated project exposes `Unfiled Development`, `Unfiled Preview`, and `Unfiled` schemes. Development points at `http://127.0.0.1:3000/api/v1`; Preview and Production origins are defined with the same required `/api/v1` path in the corresponding files under [`apps/ios/Config`](./apps/ios/Config).

Start with the [documentation index](./docs/README.md), the [brand system](./docs/BRAND_SYSTEM_UNFILED.md), the [full build plan](./docs/BUILD_PLAN.md), or the [human-owned release gates](./HUMAN_SETUP.md).

## Working product sentence

> Just write. It finds its place.

The product and repository are named Unfiled. Trademark, App Store, package-name, social-handle, and domain clearance remain required before public launch.
