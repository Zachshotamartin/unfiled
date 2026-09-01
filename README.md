# Unfiled

Unfiled is a capture-first notes product: write before deciding where a thought belongs, then inspect, correct, or undo the organization result.

The canonical phone client is the native Apple app in [`apps/ios`](./apps/ios). It targets iOS 17 and newer and uses SwiftUI, a WidgetKit Lock Screen extension driven by App Intents, and an Xcode project generated from [`apps/ios/project.yml`](./apps/ios/project.yml) with XcodeGen. Its local capture outbox and note cache use GRDB's SQLCipher build, complete file protection, and a device-generated database key that Keychain releases only while the device is unlocked. The web client and iOS app share the same authenticated backend contracts. [ADR-0010](./docs/decisions/ADR-0010-native-ios-client-replacement.md) records the replacement. Android is intentionally outside this milestone; there is no supported Android client in the current product surface.

The repository still requires account-bound Vercel, AWS, database-login, CloudTrail, Apple signing, archive, and physical-iPhone evidence before production release. The required four Vercel projects (`web`, `organizer`, `worker`, and `verifier`) have not been provisioned or deployed. Unsigned simulator builds verify compilation and tests, but do not establish provisioning, App Group behavior, Keychain/SQLCipher behavior on hardware, extension packaging, or App Store readiness. The product must not be described as end-to-end encrypted.

The encrypted server path is split across four trust domains: `apps/web` owns authenticated lifecycle orchestration, `apps/organizer` owns the lease-linearized encrypted create-or-append transaction, `apps/worker` decrypts AI-assisted note aggregates to build encrypted index documents, and `apps/verifier` independently decrypts and validates one shadow generation before activation. Milestone D now wires the organizer's production content cipher, encrypted exact-scan RAG retrieval, deterministic policy, and dedicated OpenAI embedding/Responses adapters behind an exact ten-RPC database capability. Checked-in evaluation tooling includes the 175-case deterministic mock gate, a deterministic production-component seam with an explicit scope report, and an optional explicit-key live runner with exactly three samples per eligible synthetic case and content-free telemetry. The seam uses the real retrieval/ranking, authorization, preservation, materialization, policy, and application components, but explicitly excludes database lease/heartbeat, encrypted seal/persist, and repository select/commit generation revalidation. No credentialed live evaluation has run, so Production still requires the dedicated provider project/key, stochastic report, account-bound Vercel/AWS/database evidence, canary rollout, and the explicit C.5d plaintext-contract operation; the current repository is not a production release.

Milestone E2's credential-free local gate is green: authenticated web and native clients can page, create, edit, pause, accept, decline, and remove owner-visible routing rules; repeated corrections can produce a disabled learned-rule offer; and an owner must explicitly accept that offer before it can match. Conditions and aliases stay in a `private_manual` encrypted aggregate and are opened only by the owner-authorized web service. Capture acceptance persists only the content-free `{ruleId, ruleRevision, destinationKind, destinationId, priority, matched}` snapshot for the isolated organizer. The final aggregate and built-local B–E2 HTTP gates passed on 2026-09-01, and PR #15's required CI lanes are green. No cloud deployment, production credential/KMS/provider, Apple signing/archive/device, or E2EE evidence is claimed; E3–E4 and Milestones F–G remain pending.

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
