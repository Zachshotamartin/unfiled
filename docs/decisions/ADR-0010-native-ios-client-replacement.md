# ADR-0010: Replace the mobile client with native SwiftUI

- Status: accepted
- Date: 2026-08-31
- Decision drivers: reliable Lock Screen capture; predictable lifecycle and keyboard behavior; secure offline storage; first-class accessibility; deterministic Apple target generation; reduce bridge and dependency risk.
- Supersedes: the mobile-client portions of ADR-0001 and the generation mechanism in ADR-0003

## Context

Unfiled's defining mobile interaction crosses application, extension, deep-link, backgrounding, local durability, and signing boundaries. The earlier client approach added a second runtime and native bridge precisely where the product needs direct control. It also made local SQLCipher verification, App Group ownership, WidgetKit timelines, App Intents, scene restoration, and Apple release diagnostics harder to reason about as one system.

The backend, database, web client, API contract, and encryption architecture remain valid. This decision replaces only the phone client and its delivery tooling.

## Decision

1. `apps/ios` is the sole canonical phone client for the current milestone. It supports iPhone on iOS 17 or later. A second mobile platform is outside this milestone and requires a separately scoped decision.
2. Build application screens in SwiftUI. Use WidgetKit and App Intents for the quick-capture extension and system actions. Use native URL routing for the allowlisted capture deep link.
3. Use GRDB backed by SQLCipher for encrypted drafts, outbox records, and bounded cached read models. Keep session secrets and database-key material in the iOS Keychain with unlocked-only, this-device-only accessibility; protect the database directory/file with complete file protection. Retry work is foreground-only and stops when the scene becomes inactive. Do not place note or capture text in ordinary preferences or widget timelines.
4. `apps/ios/project.yml`, `apps/ios/Config/*.xcconfig`, source files, resource catalogs, entitlements, and privacy manifests are the authored project inputs. XcodeGen generates `apps/ios/Unfiled.xcodeproj`. Generated project files are never the place to introduce lasting configuration.
5. The Swift client consumes the existing versioned HTTPS/OpenAPI backend. Compatibility must be established with strict Swift models, shared cross-language fixture tests, and end-to-end behavior—not shared runtime code. The shared-fixture lane is a native release requirement, even if the first implementation uses hand-authored Swift fixtures.
6. Repository scripts provide clean project generation, an unsigned iOS Simulator build, and simulator tests from the command line. macOS CI runs those lanes with code signing disabled.
7. Simulator CI is intentionally limited. A release still requires an Apple Developer team, registered host/extension/App Group identifiers, matching provisioning profiles, a signed archive inspection, installation on a physical iPhone, Keychain/SQLCipher restart checks, Lock Screen widget and App Intent checks, and accessibility/performance evidence.
8. Retire the former client and its package/build configuration as part of this replacement. It is not a fallback release path. Historical test results remain evidence of the backend at that time, not evidence for the new client.

## Native release gate

The replacement is canonical immediately, but it is eligible for release only when all of the following are true:

- clean XcodeGen output builds the application, widget extension, and tests with the selected Xcode version;
- native auth, Today, capture, library, search, review, note detail/editor/history, settings, and offline states are functional and accessible;
- a submitted capture is durably stored in SQLCipher before acknowledgement and replays idempotently after restart;
- the Lock Screen widget opens the focused composer through its parameter-free App Intent, the equivalent allowlisted URL reaches the same destination, and neither route renders protected content;
- unit, repository, networking, migration, and UI smoke tests pass on an iOS 17+ simulator;
- the signed physical-device and archive gates in `HUMAN_SETUP.md` are recorded.

## Consequences

- Product behavior can use Apple frameworks directly and has one concurrency/lifecycle model on iPhone.
- The repository now maintains TypeScript and Swift. Contract drift becomes a test and release concern.
- Web visual components are not reusable in the phone client; semantic tokens and interaction specifications are.
- SQLCipher adds native build and migration obligations. CI must prove the dependency links, while hardware tests must prove encrypted persistence survives real lifecycle transitions.
- No release statement may infer signing, entitlement, App Group, or physical-device correctness from an unsigned simulator build.

## Rollback

The backend and web application remain independently deployable. Before public native release, a failed replacement can delay the iPhone client without rolling back database or API work. Once users have native SQLCipher data, rollback must preserve the native database and outbox schema; reinstalling or reverting to the retired client is not a supported data-migration strategy.
