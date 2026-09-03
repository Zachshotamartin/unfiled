# Self-Organizing Notes Product: Full Build Plan

Product and repository name: **Unfiled**. Trademark, App Store, package-name, social-handle, and domain review remain required before public launch.

Implementation status: **The server/web portions of Milestones A–C are complete; [ADR-0010](./decisions/ADR-0010-native-ios-client-replacement.md) makes `apps/ios` the canonical phone client and reopens native release evidence. C.5a–d are implemented and locally verified in code, including the encrypted aggregate, private RAG/index boundary, isolated verifier and organizer, complete encrypted web repository composition, and the explicit irreversible plaintext-storage contract. Milestone D has an integrated production cipher, encrypted exact-scan RAG candidate path, deterministic policy/application layer, dedicated OpenAI embedding/Responses adapters, a deterministic production-component evaluation seam, and an optional explicit-key live runner. Milestone E0–E4 now implement the shared interaction foundation, owner-authorized encrypted correction/Review/batch Undo, encrypted explicit and learned routing-rule personalization, separately encrypted generated blocks, non-destructive duplicate suggestions, immutable AI settings, Vault-only OpenAI BYOK, and live-lease credential resolution. E2's credential-free local aggregate and built-local B–E2 HTTP gates are green as of 2026-09-01, and PR #15's required CI lanes are green. E3's credential-free local aggregate and built-local B–E3 HTTP gates plus PR #16's required CI lanes are also green; its deployed canary remains pending. E4's credential-free local aggregate and built-local B–E4 HTTP gates are green, its independent final audit is clear, and PR #17's required CI lanes are green. [ADR-0013](./decisions/ADR-0013-user-hybrid-search-trust-domain.md) is implemented on the current branch through the fifth search service, one-use capability/database and decrypt-only KMS boundary, web/native search and note-context surfaces, structured-log editing, streaming export, and atomic account deletion. F's credential-free local aggregate is green and its independent final audit is clear; F merged into `main` as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d` with a successful post-merge CI run. Milestone G is in progress on the current branch: [ADR-0015](./decisions/ADR-0015-user-selectable-provider-model-effort.md) dual-provider BYOK (OpenAI and Claude adapters, registry `organization-model-registry-v2`) and [ADR-0016](./decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md) free-beta custody (`vercel-sensitive-env-v1` root ring, `unfiled-local-hash-v1` retrieval, AWS KMS deferred) are implemented, and migrations `20260902000000`/`20260902000001` pass a clean local reset.** Migration 27 installs expand-compatibly; production has not executed its database-owner-only contraction operation. The component seam explicitly excludes database lease/heartbeat, encrypted seal/persist, and repository select/commit generation revalidation. The live runner is fixed at three samples per eligible synthetic case and safe content-free telemetry, but it has not been executed with credentials and no stochastic report exists. The five Vercel projects exist in team `zach-2267`; their deployment, remote-migration, database-login, root-ring, provider-key (through the UI), live-evaluation (both providers), canary/rollback, rotation, restore, backup, native SQLCipher, Apple signing, signed archive, and physical-device evidence is recorded in `FINAL_REPORT.md` per `HUMAN_SETUP.md`. The free beta offers no app-funded AI, its AI-assisted search is lexical-strength local-hash retrieval rather than semantic search, and the storage contraction stays deferred. Those production proofs and the native release gate remain launch-blocking, so local implementation evidence is not yet a production encrypted-library or native-release claim and does not support an E2EE claim.

This plan is the spine of a full documentation set; see [docs/README.md](./README.md) for reading order. Companion documents:

- [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md): user stories, acceptance criteria, and edge cases per epic
- [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md): pipeline contracts, prompt, schemas, scoring, provider/effort settings, and evaluation corpus
- [DATA_MODEL.md](./DATA_MODEL.md): full DDL, RLS policies, transactional functions, structured-data schemas, retention
- [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md): threat model, BYOK key custody, disclosure, deletion pipeline, incident handling
- [ENCRYPTION_ARCHITECTURE.md](./ENCRYPTION_ARCHITECTURE.md): implemented capture, custody, aggregate, encrypted-index, verifier, organizer, and explicit encrypted-storage contraction boundary
- [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md): environments, CI, enumerated test inventory, release checklists, backups, monitoring
- [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md): tokens, components, states, accessibility rules (skeleton; completed during Milestone 0)
- [BRAND_SYSTEM_UNFILED.md](./BRAND_SYSTEM_UNFILED.md): identity, voice, in-app, Lock Screen, signed-in web, and marketing-site application
- [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md): deferred decisions with defaults and decision triggers
- [GLOSSARY.md](./GLOSSARY.md) and [decisions/](./decisions/): shared vocabulary and architecture decision records

When this plan disagrees with a companion document on a detail, the companion document wins and this plan gets corrected.

## Plan Review Outcome

Build the product, but keep its thesis narrower than "Obsidian with AI." Several products already combine capture, AI, graphs, daily notes, and automatic organization. The distinctive product is a phone-first capture layer that reliably turns a short message into a visible update to a living note without asking the user to choose a folder or title first.

The plan makes the following decisions:

1. **The capture is the durable source of truth.** Save it before any model call. AI processing can fail without losing what the user wrote.
2. **AI proposes typed organization operations.** It never receives unrestricted database tools and never writes arbitrary SQL or document patches.
3. **Every automatic change produces a receipt and an undo path.** The user can see what happened, correct it in one or two taps, and teach the system a stable preference.
4. **Manual notes remain a complete product.** Navigation, search, editing, folders or spaces, history, export, and recovery cannot depend on AI.
5. **Start with text capture and five note types.** Voice, images, web clipping, collaboration, public publishing, and deep research workflows follow only after routing quality is proven.
6. **Share one versioned API contract, not one stretched client runtime.** The Next.js web application and native SwiftUI iPhone application use platform-appropriate models and screens. OpenAPI, representative fixtures, semantic design tokens, and behavior tests keep them aligned; server TypeScript is not imported into the Swift client.
7. **Use a durable background workflow for organization.** The request that accepts a capture returns quickly; routing and expansion continue reliably and can be retried idempotently.
8. **Cloud sync is part of the MVP, but capture is offline-capable.** A phone without a connection can still accept a thought into a local outbox and sync it later.
9. **Do not claim end-to-end encryption while server-side AI reads note content.** Provide a manual-only private-note mode and disclose the actual data path precisely.
10. **Design the complete core loop before bootstrapping application code.** Start with information architecture, iPhone wireframes, dark-mode tokens, high-fidelity core screens, responsive web adaptations, and a clickable prototype. The first coded vertical slice follows the approved design rather than inventing the product while implementing it.
11. **Prove a vertical slice before building a broad knowledge platform.** The first convincing coded demo is capture, route, append, receipt, correction, undo, and cross-device sync.
12. **Treat Lock Screen capture as a core input surface.** The iPhone widget is part of the durable capture path, not a decorative status widget or a post-MVP extra. One tap must open a focused composer, save locally before any network call, and reuse the same idempotent sync path as an in-app capture.
13. **Make encrypted library storage a gate before AI routing.** Milestone C.5 moves all content-bearing note, history, workflow, review, and retrieval material to application-encrypted envelopes. The server remains an authorized decryptor for the selected organizer, so this is not E2EE. The accepted first retrieval path is an encrypted, exact, per-user scan; persisted plaintext vectors require a future ADR.

## 0. Priority Feature: iPhone Lock Screen Quick Capture

### 0.1 Product outcome and non-negotiable platform constraint

The desired experience is: take out the phone, tap the Lock Screen widget, type a thought immediately, press Send, and put the phone away. The user must not choose a title, folder, note type, or destination before writing.

The implementation must describe this honestly. WidgetKit widgets do not generally support free-form text input. Apple documents widgets as snapshot-based surfaces and limits direct interactive controls to actions such as buttons and toggles; unsupported views such as a live text editor are ignored. A Lock Screen widget therefore cannot host a normal keyboard-backed `TextField` inside the widget itself. See [Creating a widget extension](https://developer.apple.com/documentation/WidgetKit/Creating-a-Widget-Extension) and [Adding interactivity to widgets and Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities).

The production contract is consequently **one tap from the Lock Screen into an app-owned composer that is already focused with the keyboard open**. If the phone is locked, iOS may require Face ID, Touch ID, or the passcode before the app appears. The application must not claim it can bypass that system protection.

Initial platform target: iPhone on iOS 17 or later. Build both supported Lock Screen shapes:

- `accessoryCircular`: a single recognizable capture glyph and an accessibility label such as `New capture`.
- `accessoryRectangular`: the glyph plus `Write something` or `Capture a thought`; optionally show a non-sensitive pending count.
- Do not show note text, recent captures, destination names, or AI receipts on the Lock Screen by default.
- Keep `accessoryInline` as an evaluated follow-up, not an MVP requirement; its tiny surface adds little to the primary action.

Apple supports circular, rectangular, and inline accessory families on the iPhone Lock Screen. The widget must adapt to monochrome, accented, tinted, and clear appearances rather than assuming the app's dark palette will render literally. See [Apple's widget design guidance](https://developer.apple.com/design/human-interface-guidelines/widgets) and [supporting additional widget sizes](https://developer.apple.com/documentation/widgetkit/supporting-additional-widget-sizes).

### 0.2 Exact user flow

#### Setup

1. After the user's first successful in-app capture, show an optional `Add Lock Screen capture` education card.
2. Explain the native steps with current screenshots: touch and hold the Lock Screen, choose Customize, select the Lock Screen, add the application's circular or rectangular widget, then tap Done.
3. Provide `Not now` and never block normal app use. iOS does not provide an API that silently installs a widget for the user.

#### Capture from the Lock Screen

1. The user taps the widget.
2. WidgetKit runs `OpenQuickCaptureIntent`, which signals the fixed source and opens the host; an allowlisted `<app-scheme>://capture?source=ios_lock_screen_widget` URL provides the equivalent direct route.
3. iOS authenticates the user if the device is locked.
4. The SwiftUI application consumes the App Group signal (or handles the equivalent allowlisted URL) and presents its dedicated capture destination, not the home screen or the last open note.
5. The composer appears with no intermediate animation, onboarding, loading skeleton, folder picker, or AI greeting.
6. The multiline input receives focus after the SwiftUI scene is active; the keyboard opens automatically.
7. The user types and presses Send from the keyboard or taps the 44-point send control.
8. The app commits the raw capture and its client ULID to the SQLCipher database through one GRDB transaction before displaying `Saved` or triggering haptics.
9. Sync begins immediately when possible. The app may close or remain available for another capture; either way, organization continues independently.
10. A short local acknowledgement says `Saved` and, only when already known, `Queued offline`. It must not invent the future destination.

#### Interrupted flow

- Persist the composer draft locally as the user types. Backgrounding, locking the phone, an incoming call, a crash, or memory pressure must not erase entered text.
- Reopening the widget within 30 minutes restores the unfinished widget-originated draft. The composer visibly labels it `Unsaved draft` so restoration is not mistaken for a submitted capture.
- Canceling a non-empty draft requires `Keep draft` or `Discard`; an empty draft dismisses immediately.
- An expired cloud session does not destroy capture ability for a previously signed-in local profile. Save to the local outbox, mark it `Waiting for sign-in`, and sync after reauthentication. A never-authenticated installation routes to sign-in because it has no local user boundary.

### 0.3 Performance and interaction budget

Measure from the app-active callback because device authentication time belongs to iOS and varies by user:

- warm launch to focused input: p50 under 300 ms, p95 under 700 ms
- cold launch to focused input: p50 under 900 ms, p95 under 1.8 s on the oldest supported test phone
- Send tap to local durable acknowledgement: p95 under 150 ms
- no network or model call may block focus, typing, local persistence, acknowledgement, or dismissal
- dropped characters, double submission, and blank-screen launches are release blockers

Record only timings, route source, outcome codes, app version, and device class. Never put capture text in analytics, crash breadcrumbs, widget snapshots, or logs.

### 0.4 Architecture

```text
iPhone Lock Screen
  -> WidgetKit accessory widget
  -> OpenQuickCaptureIntent
  -> content-free App Group signal
  -> native intent/URL router
  -> focused SwiftUI CaptureComposer
  -> SQLCipher/GRDB transaction: draft + capture outbox row
  -> existing idempotent POST /api/v1/captures
  -> durable organization workflow
  -> receipt visible in Today on iPhone and web

Main SwiftUI app
  -> App Group snapshot writer
  -> WidgetCenter timeline reload
  -> WidgetKit reads generic pending count only
```

The widget is a native iOS app extension and runs in a separate process. It must not import the database client, call the AI provider, contain authentication tokens, or reproduce the capture service. Its only MVP responsibilities are rendering a safe launch surface, invoking the parameter-free App Intent, and optionally reading a small non-sensitive snapshot from an App Group container. The configured capture URL reaches the same destination for direct system routing.

### 0.5 Native project strategy

The canonical phone client is a native SwiftUI iPhone application. WidgetKit and App Intents live beside the application in one declaratively generated Xcode project. ADR-0010 records the replacement decision; ADR-0003 records immutable identifiers.

Authored project inputs live here:

```text
apps/ios/
  project.yml                         # XcodeGen source of truth
  Config/
    Base.xcconfig
    Development.xcconfig
    Preview.xcconfig
    Production.xcconfig
  Shared/                             # App Group constants and brand primitives
  Unfiled/
    Application/                      # app entry point, scene routing, composition
    Auth/                             # session and Keychain boundary
    Domain/                           # native models and operations
    Networking/                       # versioned HTTPS client and strict DTOs
    Persistence/                      # GRDB + SQLCipher database and migrations
    Sync/                             # durable outbox and reconciliation
    Features/                         # SwiftUI feature surfaces
    Resources/
    Supporting/                       # plist, entitlements, privacy manifest
  QuickCaptureWidget/
    QuickCaptureWidget.swift
    OpenQuickCaptureIntent.swift
    Resources/
    Supporting/
  UnfiledTests/
```

`apps/ios/project.yml` declares the application, `QuickCaptureWidget`, and test targets; Swift Package dependencies; build configurations; shared schemes; target membership; and iOS 17 deployment floor. `Config/*.xcconfig` supplies fixed per-environment bundle IDs, App Group IDs, URL schemes, display names, and API origins. XcodeGen produces `apps/ios/Unfiled.xcodeproj` deterministically. Never introduce a durable change only through Xcode's project editor: change the declarative inputs and regenerate.

The application and extension share Swift sources only when those sources are extension-safe. The extension must not link persistence, networking, auth, or server-domain modules. Both targets receive the same App Group entitlement and environment-specific identifier through checked configuration. A clean generation/build check must prove that the extension is embedded once and that repeated generation is stable.

Local and CI commands are exposed at the repository root:

- `pnpm ios:generate` — generate the Xcode project from `project.yml`;
- `pnpm ios:build` — perform a code-signing-disabled iOS Simulator build from the generated project;
- `pnpm ios:test` — run the native tests on the selected Simulator;
- `pnpm ios:ci` — generate, resolve Swift packages, build, and test in the same order as the macOS CI lane.

These commands require macOS and the selected Xcode/XcodeGen toolchain. They deliberately do not manage Apple credentials. Signing identities, App IDs, App Groups, and provisioning profiles are created and verified through the human release gate.

### 0.6 WidgetKit implementation

Use `StaticConfiguration` because the user has no widget-side destination to configure. The full widget contains one `Button(intent:)` backed by an `AppIntent` whose only effect is to signal the allowlisted quick-capture route and open the host application. Do not put competing tap targets or parameters in the Lock Screen version.

Representative Swift structure:

```swift
import AppIntents
import SwiftUI
import WidgetKit

struct OpenQuickCaptureIntent: AppIntent {
  static let title: LocalizedStringResource = "Write in Unfiled"
  static let openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    AppGroupConfiguration.signalQuickCapture()
    return .result()
  }
}

struct QuickCaptureEntry: TimelineEntry {
  let date: Date
  let pendingCount: Int
}

struct QuickCaptureProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickCaptureEntry {
    .init(date: .now, pendingCount: 0)
  }

  func getSnapshot(
    in context: Context,
    completion: @escaping (QuickCaptureEntry) -> Void
  ) {
    completion(entry())
  }

  func getTimeline(
    in context: Context,
    completion: @escaping (Timeline<QuickCaptureEntry>) -> Void
  ) {
    completion(Timeline(entries: [entry()], policy: .never))
  }

  private func entry() -> QuickCaptureEntry {
    let defaults = AppGroupConfiguration.sharedDefaults
    return .init(
      date: .now,
      pendingCount: defaults?.integer(forKey: AppGroupConfiguration.pendingCaptureCountKey) ?? 0
    )
  }
}

struct QuickCaptureWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: QuickCaptureEntry

  var body: some View {
    Button(intent: OpenQuickCaptureIntent()) {
      Group {
        if family == .accessoryRectangular {
          HStack(spacing: 8) {
            Image(systemName: "square.and.pencil")
            VStack(alignment: .leading, spacing: 1) {
              Text("Write something").font(.headline)
              if entry.pendingCount > 0 {
                Text("\(entry.pendingCount) waiting to sync").font(.caption)
              }
            }
          }
        } else {
          ZStack {
            AccessoryWidgetBackground()
            Image(systemName: "square.and.pencil")
          }
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("New capture")
  }
}

struct QuickCaptureWidget: Widget {
  let kind = "QuickCaptureWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickCaptureProvider()) {
      QuickCaptureWidgetView(entry: $0)
        .containerBackground(for: .widget) { Color.clear }
    }
    .configurationDisplayName("Quick Capture")
    .description("Open a blank capture without choosing where it belongs.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular])
  }
}
```

Read identifiers through checked build settings and the shared configuration helper; never interpolate placeholders or environment variables at runtime. Verify the final Swift code against the selected Xcode and iOS SDK because WidgetKit appearance APIs evolve.

### 0.7 URL routing and composer implementation

The SwiftUI application receives URLs through its scene and sends them to one typed router. The router parses the configured scheme, rejects unknown hosts and paths, and maps the quick-capture source to a presentation value rather than performing the persistence side effect itself. See [SwiftUI `onOpenURL`](<https://developer.apple.com/documentation/swiftui/view/onopenurl(perform:)>) and [Migrating to the SwiftUI life cycle](https://developer.apple.com/documentation/swiftui/migrating-to-the-swiftui-life-cycle).

Implementation rules:

- The router requires the configured scheme and `capture` host, reads only a recognized `source` enum, and ignores all other path/query material. A missing or unrecognized source becomes the ordinary in-app capture origin. Never accept note content, destination IDs, operations, credentials, or arbitrary return URLs.
- The scene-level router normalizes the widget signal to the `ios_lock_screen_widget` source. A URL with the wrong scheme or host is inert; every accepted URL can only present a blank composer.
- The source enum adds `ios_lock_screen_widget`; analytics and the API may receive that enum, but server behavior and authorization stay identical.
- On a warm launch, dismiss a conflicting sheet and present the dedicated composer. On a cold launch, resolve capture intent during application composition so the normal home screen does not flash first.
- Keep one draft row per local profile and capture source. Update it through the GRDB repository with a short debounce and flush immediately when the scene backgrounds.
- Use SwiftUI focus state after the scene becomes active. Schedule focus on the main actor after presentation, retry once if the editor is not focused, and cancel pending work when the composer disappears.
- The keyboard Return key inserts a newline in multiline mode. Provide a separate accessible Send button and an optional keyboard accessory Send action; never make an accidental Return submit a multi-line capture.
- Submission asks one persistence actor to run a GRDB transaction that inserts the capture, inserts or updates the outbox record, and deletes the draft. Only after the SQLCipher transaction commits may the UI show `Saved` and emit success haptics.
- Disable Send only while the local transaction is committing. Trim for the empty check, but preserve the user's original whitespace and exact raw body in the stored source capture according to the capture contract.
- Generate the ULID before the transaction and reuse it as the API idempotency key. A rapid double tap, app restart, or sync retry must still produce one server capture.

### 0.8 App Group snapshot and widget refresh

`AppGroupConfiguration` is a small extension-safe Swift helper shared by target membership. The host writes only a schema version, a bounded non-negative pending count, and the one-shot capture signal to `UserDefaults(suiteName:)`, then calls `WidgetCenter.shared.reloadTimelines(ofKind:)` after a debounced count change. WidgetKit controls the actual reload schedule, so the count is informative, never authoritative.

The App Intent may set only the capture signal before asking iOS to open the host. The application consumes and clears that signal, then resolves the same allowlisted route used by its URL handler. Repeated intent delivery is harmless and cannot submit content.

Do not share the SQLCipher file, Supabase session, raw captures, drafts, user email, note titles, destination names, or key material with the extension. If App Group provisioning fails, the widget can still render but its intent signal is unavailable; direct URL routing is a separately testable entry, not a silent widget fallback. This configuration failure blocks release and must be caught by the signed physical-device gate.

### 0.9 Backend and data-contract changes

The widget does not get a special backend endpoint. Reuse the normal capture pipeline:

- add `ios_lock_screen_widget` to the versioned `CaptureSource` schema and database constraint
- send `client_capture_id`, `raw_content`, `client_created_at`, timezone, and source through `POST /api/v1/captures`
- keep the existing auth, ownership, size limit, rate limit, idempotency, privacy mode, and workflow behavior
- preserve the raw capture before routing
- do not auto-increase AI priority because the source was the Lock Screen
- expose the resulting processing state and receipt through the normal Today and Review surfaces

### 0.10 Signing, builds, and developer workflow

Simulator CI is intentionally unsigned. Use a signed development configuration and a physical iPhone for the primary widget, App Intent, protected-data, and SQLCipher workflow.

Before the first shared build:

1. Register the main App ID and the explicit widget-extension App ID in the Apple Developer portal.
2. Register one App Group and enable it on both identifiers.
3. Add the application and extension capabilities before generating provisioning profiles.
4. Generate or refresh profiles for both targets after App Group membership exists.
5. Run `pnpm ios:generate` from a clean checkout and confirm XcodeGen reproduces the application, extension, schemes, package dependencies, build settings, and entitlements.
6. Build the Development scheme with Xcode previews, then install the signed application on a real phone.
7. Test the release provisioning profile before TestFlight; Debug success alone is insufficient evidence.

Keep an automated native-project inspection script that fails CI if the generated extension is missing its bundle identifier, App Group entitlement, embedded appex product, supported families, or shared scheme URL.

### 0.11 Test matrix and release gate

Automated coverage:

- unit tests for source allowlisting, native-path rewriting, draft persistence, outbox transaction, and duplicate submission
- contract test proving `ios_lock_screen_widget` is accepted by client, API, and database schemas
- XcodeGen test that generates twice and compares targets, schemes, package references, build phases, plist paths, and entitlements
- Swift tests for App Group snapshot defaults and schema migration
- Xcode snapshot or preview coverage for circular and rectangular families in accented, tinted, clear, dark, and light contexts
- API restart test proving the same ULID syncs exactly once
- native integration tests for both the App Intent signal and configured URL, asserting capture presentation, focused input, encrypted local save, and queued state

Physical-device matrix:

- app terminated, backgrounded, foregrounded, and suspended
- device unlocked and locked with Face ID required
- online, airplane mode, connection loss during send, and later reconnection
- valid session, expired session for a known local profile, and first-run signed-out state
- device reboot before first unlock
- Dynamic Type through the largest accessibility sizes
- VoiceOver, Switch Control, Reduce Motion, Reduce Transparency, and Bold Text
- dark, light, tinted, clear, and always-on-display presentation where supported
- rapid double tap, repeated deep link, empty send, very long capture, emoji, right-to-left text, and dictation through the system keyboard
- storage pressure, locked/unavailable database-key material, and simulated SQLCipher transaction failure, which must show an honest error rather than `Saved`

Release gate:

- 100 consecutive cold and warm widget launches on physical devices produce no blank or wrong route
- at least 99 of 100 launches focus the composer without an extra tap; any reproducible miss must be fixed before release
- every locally acknowledged capture survives termination and syncs exactly once
- no sensitive note or capture content appears in the Lock Screen snapshot, analytics, logs, or crash reports
- App Store archive contains a correctly signed embedded widget extension
- the widget remains useful offline and when the AI provider is unavailable

### 0.12 Delivery order

1. Add the native capture URL route and prove reliable cold- and warm-start focus using a temporary URL before creating the widget target.
2. Add draft persistence and the GRDB/SQLCipher outbox transaction; pass termination and duplicate tests.
3. Prototype both widget families in a minimal native test host and approve the Lock Screen design states.
4. Implement and determinism-test the XcodeGen application, extension, test targets, schemes, and environment configurations.
5. Add the extension-safe App Group snapshot helper and App Intent.
6. Run the physical-device matrix and tune launch performance.
7. Add onboarding instructions, telemetry without content, CI project inspection, and TestFlight validation.
8. Only after the Lock Screen path passes its gate, reuse the same deep link for an optional Home Screen widget, Action Button shortcut, App Shortcut, or Control Center control.

## 1. Product Definition

### One-sentence pitch

> A phone-first notes app where you write one message and the right living note updates itself, with the original capture preserved and every AI change visible, correctable, and reversible.

### The problem

Many people do not fail at note-taking because they dislike writing. They fail at the moment before writing:

- Which note should this go in?
- Does a matching note already exist?
- What should the title be?
- Is this a task, a list item, a journal entry, or an idea?
- Will I remember where I put it later?

The cost of that filing decision is enough to make the person open a blank note, write an untitled fragment, or write nothing. The fragment then becomes hard to find and impossible to build on.

### Product thesis

Separate **capture** from **organization**.

The user should be able to write a message in seconds. The system should save it immediately, determine the likely note type and destination, add it to an existing note or create an appropriate note, and show a plain-language receipt. If the system is unsure, it should ask for a small routing decision without discarding the capture.

Organization should become more accurate through explicit corrections and deterministic personal rules, not through hidden behavior the user cannot inspect.

### The flagship demonstration

A user opens the native iPhone app and submits three messages over a day:

1. `shopping: milk, spinach, batteries`
2. `bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets`
3. `Roosevelt method: tell people you can do it, then figure out how to do it later`

The product:

1. Adds three unchecked items to `Shopping / August 30`.
2. Creates or updates `Workouts / August 30`, preserves the raw line, extracts exercises and sets into a readable workout entry, and offers an optional summary.
3. Adds the exact thought to `Mindset / Principles`, labels the proposed interpretation as AI-generated, and does not assert that the name or attribution is historically correct.

Each result appears in a processing receipt with `Open`, `Move`, and `Undo`. A later message, `add bananas`, goes to the currently active shopping note because the server considers explicit wording, recent destinations, open list state, and the user's prior routing decisions.

The same notes are visible and manually editable in the hosted web application.

## 2. Positioning and Existing Product Landscape

This category exists. The opportunity is a focused behavior and trust model, not the absence of competitors.

| Product    | Relevant strength                                                      | Gap this product should target                                                                                               |
| ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Obsidian   | Local files, links, plugins, deep research workflows                   | Organization still depends heavily on user-created structure and desktop-oriented habits                                     |
| Mem        | Capture without organizing and an agent with broad workspace context   | Broader chief-of-staff direction; this product should make routing receipts, correction, and small personal notes the center |
| Tana       | Structured nodes, supertags, capture, and AI                           | Powerful schema and outliner concepts introduce setup and vocabulary before value                                            |
| Capacities | Daily notes, object types, mobile capture, and review                  | The user still selects destinations and performs substantial review or conversion work                                       |
| Reflect    | Fast networked notes, sync, encryption, and AI assistance              | AI-assisted writing and graph features are broader than message-to-note routing                                              |
| Rill       | Very close thesis: capture, automatic entities, tasks, and connections | Desktop and coding-agent orientation leaves room for a consumer phone-first product with a shared hosted web app             |

### Selected differentiation

The product is not marketed as a second brain, research tool, or autonomous chief of staff. Its promise is smaller and testable:

- Capture has no filing question.
- One message can update an existing note.
- The user always knows what changed.
- A wrong decision is easy to correct and undo.
- Corrections become stable personal routing rules.
- The native iPhone app is the primary capture surface, not a companion afterthought.
- Manual browsing and editing are obvious enough that the user never feels trapped behind AI.

### Product language

Prefer functional labels in the application:

- `Capture`
- `Today`
- `Notes`
- `Review`
- `Search`
- `Spaces`
- `Moved to Shopping`
- `Added to today's workout`
- `Needs your input`

Do not force the brand metaphor into every control. The name can be expressive while the interface stays literal.

## 3. Product Principles and Invariants

### 3.1 Capture first

The system acknowledges a locally or remotely durable capture before starting organization. A model outage cannot turn the Save button into data loss.

### 3.2 Original text survives transformation

Every organized block links back to its source capture. Generated expansions are distinct from the user's words. A user can inspect the source, remove generated material, or restore a prior note revision.

### 3.3 AI does not own the information architecture

The model chooses from server-provided note IDs, note types, spaces, and allowed operations. Creating a new destination is an explicit operation with a validated title and type. The model cannot invent an existing note ID or bypass ownership checks.

### 3.4 Automatic changes are inspectable and reversible

Every applied organization plan records:

- source capture
- chosen destination
- operation type
- model and prompt version
- deterministic signals used
- confidence band
- before and after note revisions
- user correction or undo, if any

### 3.5 Confidence changes behavior

High-confidence actions may apply automatically. Medium-confidence actions may apply with prominent correction controls or wait in Review, depending on the user's preference. Low-confidence actions remain safely in the Inbox with suggested destinations.

Do not trust a model's self-reported probability by itself. Calibrate the decision score from evaluated model output plus deterministic signals such as explicit keywords, exact aliases, open list state, recency, prior corrections, and candidate separation.

### 3.6 Manual behavior is first-class

The user can always:

- create a note directly
- choose a space and note type
- rename, move, archive, or delete a note
- edit the full note without an AI command
- move a capture or block to another note
- pin a note as the active destination for a phrase
- search by text, date, type, tag, or space
- export readable Markdown and JSON

### 3.7 Personal rules beat repeated inference

When the user says `Always put "groceries" in my Shopping list`, or corrects the same pattern repeatedly, store an explicit routing rule. Evaluate these rules before calling a model. Rules are visible, editable, and removable.

Rule-condition plaintext stays in the owner-authorized web trust domain under the private-manual key class. Web evaluates it while accepting the capture and binds only a content-free rule ID/revision/destination snapshot to the job; the organizer never receives the condition. Repeated corrections create a disabled proposal only, and every learned rule requires explicit confirmation before activation.

### 3.8 No silent expansion

Generated summaries, interpretations, or recommendations are marked as generated. The system may automatically format clearly structured facts, such as list items or workout sets, but it must not silently turn a short opinion into a long essay inside the user's note.

### 3.9 The system is useful without a graph view

Relationships and semantic links may improve retrieval, but a graph visualization is not part of the MVP. It does not solve the capture problem and can distract from a simpler information hierarchy.

### 3.10 Deletion means deletion

Undo history has a bounded retention window. The MVP default: full revision history is retained without pruning, direct one-tap undo of an AI mutation is guaranteed for 30 days, and older changes remain reversible through revision restore. Automatic pruning is deferred until real storage metrics justify it, and any future pruning policy is published before it takes effect. Account deletion and note deletion behavior are documented, testable, and propagated to search indexes, embeddings, generated artifacts, and backups according to the published retention policy.

## 4. Target User and Jobs to Be Done

### Primary user

A person who already uses a phone notes app but has many untitled, duplicated, or abandoned notes. They want to capture personal logistics, workouts, ideas, principles, errands, and project fragments without adopting a knowledge-management methodology.

### Core jobs

1. **When a thought occurs, let me save it before I decide where it belongs.**
2. **When I add a fragment later, find the note I meant and update it.**
3. **When a capture contains a familiar shape, turn it into a useful list or log without changing its meaning.**
4. **When the system is uncertain or wrong, let me fix it quickly and remember that preference.**
5. **When I want control, let me navigate and edit the note structure manually.**
6. **When I need something later, let me find it by ordinary words, approximate meaning, or date.**

### Secondary users after MVP

- people who prefer voice capture while walking or driving
- users who want a simple workout or habit log without a dedicated fitness system
- students capturing small ideas but not building a research vault
- neurodivergent users who benefit from eliminating the filing decision

Do not make medical, therapeutic, or accessibility claims without appropriate evidence and review.

## 5. Scope

### 5.1 MVP scope

- Email magic-link or one-time-code authentication
- native SwiftUI iPhone application for iOS 17 or later; another mobile platform is outside this milestone
- iPhone Lock Screen quick-capture widget that opens a focused, offline-capable composer through a deep link
- Responsive web application and marketing page hosted on Vercel
- Text capture from native iPhone and web
- Offline native capture outbox
- Five note types: generic note, list, log, principle, project
- Interactive typed note surfaces: tap-to-toggle checklist items on list and project notes, tap-to-edit numeric fields on log entries
- Spaces, notes, tags, date views, archive, and manual editor
- AI create-or-append routing
- Structured list and workout-log extraction
- Separate optional generated expansion block
- Processing receipts, Review queue, correction, and undo
- Full-text, date, type, and semantic search
- Revision history for AI and manual edits
- Data export and account deletion
- Bring-your-own-key: user-supplied OpenAI or Anthropic API key, encrypted at rest, with model-effort settings
- Dark-first visual system with accessible token architecture
- Shared backend, contracts, auth, database, search, and AI workflow

### 5.2 Explicit non-goals for MVP

- Real-time multi-user collaboration
- Public publishing
- Obsidian plugin compatibility
- Arbitrary nested databases, formulas, rollups, cross-table relations, or database views
- Canvas or graph visualization
- PDF research ingestion
- Web browsing or factual research on the user's behalf
- Calendar, email, or task-manager integrations
- Automatic reminders and notifications based on inferred intent
- Push notifications; processing receipts surface in-app only in MVP, and a capture whose receipt is never seen still lands safely and appears in Today
- Handwriting recognition
- Images and file attachments
- Continuous background agent behavior
- Fully local inference
- End-to-end encryption claims
- Billing and team administration

### 5.3 Candidate v1.1 additions

- Voice recording and transcription
- Share-sheet text and URL capture
- Home-screen capture and status widget that reuses the proven Lock Screen route and App Group bridge
- User-defined note templates, including templates with checkbox, number, and single-select input fields
- `table` note type: typed columns (text, number, checkbox, date, single-select), tap-to-edit cells, row operations, sort, and CSV export — no formulas, relations, or views
- Interactive workout plans on the `log` type: a planned session the user ticks through set by set, with per-set numeric quick-entry and optional rest timers
- Offline toggling and field edits for cached notes, synced through the outbox with conflict handling
- Reminder extraction with explicit confirmation
- Private, manual-only notes excluded from AI
- Import from Apple Notes, Google Keep, Markdown folders, and Obsidian
- Saved search views

### 5.4 Later possibilities

- On-device classification for common routes
- Optional local-only vault
- Calendar and health integrations with narrow permissions
- Photo and receipt capture
- Shared household shopping and planning spaces
- Plugin or automation API

## 6. Information Architecture and UX

### 6.1 Native iPhone navigation

Use a five-destination bottom navigation:

1. `Today`
2. `Notes`
3. central `Capture` action
4. `Review`
5. `Search`

`Settings`, `Archive`, `Routing rules`, and account controls live behind the profile button. The capture action opens a focused composer rather than switching to a permanent tab screen.

The iPhone application has no dedicated Inbox tab. Inbox captures surface in two places: a `Needs a home` section at the top of `Today`, and inside `Review` when they carry suggested destinations. The web rail keeps a dedicated `Inbox` entry because desktop has room for it. Both surfaces read from the same underlying state: a capture whose processing status is `inbox`.

### 6.2 Web navigation

Use a compact left rail:

- Today
- Inbox
- Notes
- Spaces
- Review
- Search
- Archive
- Settings

The center pane shows the active note or view. A narrow optional right inspector shows routing history, backlinks, source captures, and note properties. Do not make the inspector necessary for ordinary editing.

### 6.3 Today

Today is the default landing view. It contains:

- a persistent capture field
- today's captures and processing state
- a `Needs a home` section for Inbox captures awaiting a destination
- notes updated today
- unresolved Review items
- active lists, such as today's Shopping list, with tappable checkboxes inline

It is a chronological operational view, not a mandatory daily journal.

### 6.4 Notes

The Notes screen provides manual navigation:

- pinned notes
- recent notes
- spaces
- note types
- all notes

On iPhone, opening a note shows a clear back path and a compact breadcrumb such as `Health / Workouts / Aug 30`. On web, the hierarchy remains visible in the rail.

### 6.5 Capture composer

The text field opens ready for input. The default flow is:

1. Type or paste.
2. Tap Save or press the submit key.
3. Receive an immediate `Saved` acknowledgement.
4. Dismiss the composer while processing continues.
5. Receive an in-app receipt when organization completes.

Optional controls can set an explicit destination, mark a capture private, or disable expansion. They must not be required for the common path.

### 6.6 Processing receipt

A receipt is a compact event, not a chat response:

```text
Added 3 items to Shopping / Aug 30

milk
spinach
batteries

[Open] [Move] [Undo]
```

If the system created a note, say so. If it generated an expansion, identify the generated block. If it is uncertain, show at most three suggested destinations plus `New note`.

### 6.7 Review

Review is an exception queue, not required daily maintenance. It contains:

- low-confidence destinations
- conflicts caused by concurrent edits
- failed organization jobs
- proposed merges or duplicate notes
- optional generated expansions waiting for acceptance

The empty state should explain that captures still remain safely in the Inbox.

### 6.8 Manual editor

The MVP editor supports:

- title
- Markdown-style paragraphs
- headings
- bullet and numbered lists
- checklists
- quotes
- inline links
- simple tags and note links
- undo and redo

Avoid a custom block editor in the first milestone. Use revision checks for writes and add a richer editor only when equivalent web/Swift behavior is proven. The canonical content source differs by note type; Section 6.9 and Section 12.1 define the rule.

### 6.9 Interactive typed note surfaces

A note type is not only a routing label. Each type renders an interaction surface appropriate to its data, so the note is usable in place rather than read-only output of the AI pipeline:

- **`list`:** every item renders with a tappable checkbox. Toggling an item is a first-class typed operation, not a hand-edit of Markdown syntax. Checked items stay in place with their check, a fully checked list can be marked complete, and completing a list updates the open-state signal that candidate retrieval already uses.
- **`log`:** each entry renders its extracted fields as compact editable values. For a workout entry, exercise name is text, and weight, repetitions, and sets are numeric fields. Tapping a numeric value opens the platform numeric keypad with plus and minus steppers; the most recent prior entry for the same exercise pre-fills as a placeholder so logging a repeat set takes one or two taps. Field edits update `structured_data` and re-render the readable entry.
- **`project`:** checklist blocks inside a project note behave exactly like `list` items, including toggling and completion state.
- **`generic` and `principle`:** standard Markdown editing. Checklists authored with checkbox syntax are tappable; no other interactive blocks exist for these types in MVP.

Interaction rules, which apply to every interactive control:

1. Every interactive edit goes through the same typed-operation, expected-revision, mutation, and undo pipeline that AI organization uses. A checkbox toggle produces a mutation with an inverse, exactly like an AI append, so receipts, history, and undo need no second code path.
2. Toggles and field edits apply optimistically in the UI and roll back visibly with a brief explanation if the server rejects the revision.
3. Checkboxes and numeric fields meet the 44-point touch-target minimum and are reachable by keyboard on web.
4. Interactive edits require a connection in MVP. Offline interactivity arrives with broader offline editing, not as silent local divergence; the offline outbox remains capture-only.
5. Screen readers announce state changes, such as `milk, checked, 2 of 5 remaining`.

### 6.10 First-run and cold start

A brand-new account has zero notes, so routing has no candidates. Define this experience explicitly rather than letting the empty state fall out of the pipeline:

- Onboarding offers, but does not force, a small set of starter spaces such as Shopping, Health, Mindset, and Projects. Declining leaves an empty library; nothing is silently pre-created.
- With an empty or sparse library, the expected decisions are `create_note` and `add_to_inbox`. The scoring policy must not hallucinate an append destination that does not exist, and the evaluation corpus includes empty-library and first-week cases.
- The first receipt teaches the loop: when the first capture creates a note, the receipt explains in one line that future related captures will land in the same note.
- Onboarding shows, and lets the user try, three example captures matching the flagship demonstration so the value is experienced within the first minute.

Interactive tables are not an MVP surface. A `table` note type is a v1.1 candidate with this shape: user-defined typed columns limited to text, number, checkbox, date, and single-select; tap-to-edit cells using the same typed-operation pipeline; row add, reorder, and archive; column sort; CSV export. Formulas, cross-table relations, rollups, and database views stay out of scope per Section 5.2 — the table type is a structured grid, not a spreadsheet. Interactive workout _plans_ (a planned session the user ticks through set by set, with rest timers) are likewise deferred to v1.1 as a template feature layered on the `log` type.

## 7. Core User Flows

### 7.1 Shopping list

Input:

```text
shopping list milk, eggs, paper towels
```

Default behavior:

1. Save the exact capture.
2. Detect explicit list intent and the Shopping alias.
3. Find an open Shopping list for the user's local date.
4. If none exists, create `Shopping / Aug 30` inside the `Shopping` space.
5. Add normalized, unchecked items while preserving the raw source. The server assigns each item a stable item ID.
6. Return a receipt.

In the store, the user opens the list and taps each item's checkbox as they pick it up. Each toggle is a typed operation that creates a revision and syncs, so the same list on the web app shows live progress. Checked items collapse into `Completed`.

Later input:

```text
add bananas
```

Candidate selection should prefer the recent open Shopping list only if the phrase, recent context, and prior user behavior support that choice. Otherwise, keep it for Review. The user can switch the preference from daily shopping notes to one living Shopping note.

### 7.2 Workout log

Input:

```text
bench 135 x 8, 145 x 6, 155 x 4; incline dumbbell 45 x 10 for 3 sets
```

Default behavior:

1. Route to today's workout log.
2. Preserve the raw text.
3. Extract exercise name, weight, repetitions, and sets into `structured_data`.
4. Render a readable entry in the note with each numeric field editable in place: a mistyped `145` becomes `155` through a tap and stepper, not a text edit.
5. Offer, but do not silently insert, a short summary or next-workout suggestion.

The product must avoid medical conclusions and should not invent missing units, exercise variations, or personal records.

### 7.3 Principle or mindset note

Input:

```text
Roosevelt method: telling people that you can do it and then later figuring out how to do it
```

Default behavior:

1. Route to `Mindset / Principles` if that destination is a strong match.
2. Store the exact user-authored statement.
3. Optionally propose a label such as `public commitment` or `accountability` in a generated block.
4. Do not validate the attribution, present it as historical fact, or rewrite the user's idea as a quotation.

### 7.4 Ambiguous capture

Input:

```text
get batteries
```

Possible meanings include a shopping item, a task, or a project supply. If deterministic signals do not separate the candidates, save it to Inbox and ask:

```text
Where should this go?
[Shopping] [Tasks] [Garage project] [New note]
```

The correction becomes evidence for later routing. It does not automatically become a universal rule after one ambiguous example. `Tasks` in this prompt is an ordinary user note of type `list`, not a separate task subsystem; the five note types are the complete type vocabulary in MVP.

### 7.5 Manual update

The user opens `Notes`, selects `Mindset`, opens `Principles`, edits the text, and saves. The server creates a new revision. A concurrent AI job that was based on the older revision must re-plan or enter Review; it cannot overwrite the manual edit.

### 7.6 Undo

Undo validates that the note has not changed incompatibly since the mutation. If safe, it applies the stored inverse mutation and creates a new revision. If later edits depend on the generated block, show a focused diff and let the user remove only the affected material.

## 8. Domain Model

Use stable product terms in code and copy.

### Capture

The original user submission. It has a client-generated idempotency key, source device, local timestamp, server timestamp, content, privacy mode, and processing state.

### Note

A living document with a stable ID, title, note type, space, canonical Markdown body, structured metadata, and current revision.

### Note type

One of:

- `generic`
- `list`
- `log`
- `principle`
- `project`

Types guide rendering and extraction but do not lock the user out of editing.

### Note item

An addressable unit inside a `list` or `log` note: a checklist item or a log entry. It has a stable server-assigned ID, ordinal, text or typed fields, checked state where applicable, and a link to the capture that created it. Typed operations reference items by ID, which keeps toggles, field edits, and undo unambiguous across revisions.

### Space

A manually visible top-level grouping such as Shopping, Health, Mindset, or Projects. Spaces may contain subspaces after MVP, but deep nesting is discouraged.

### Organization plan

A validated model output describing zero or more allowed operations against server-provided candidates.

### Mutation

The transactional application of one organization plan. It records the before revision, after revision, inserted content identifiers, inverse operation, and audit metadata.

### Routing rule

A deterministic user-owned rule evaluated before model inference. Examples:

- exact prefix `workout:` routes to the current Workout log
- phrase `shopping list` routes to the Shopping space
- alias `Roosevelt method` suggests the Principles note

### Review item

An unresolved decision or failure that needs user input. The capture remains available regardless of Review state.

### Generated block

Model-generated text stored with explicit provenance and acceptance state. It is not merged invisibly into the user's source text.

## 9. AI Organization System

### 9.1 Pipeline

```text
client capture
  -> durable capture row
  -> durable organization workflow
  -> deterministic rule evaluation
  -> candidate retrieval
  -> structured model plan
  -> schema and ownership validation
  -> calibrated policy decision
  -> transactional note mutation or Review item
  -> encrypted index job
  -> receipt event
```

### 9.2 Candidate retrieval

Do not send the entire note library on every request. Candidate retrieval is a tenant-scoped service over the active encrypted index generation selected in [ADR-0006](./decisions/ADR-0006-application-encrypted-library-and-private-rag.md). It loads only the authenticated user's current `ai_assisted` index documents, decrypts them into a bounded process-memory working set, and combines:

1. explicit routing rules and aliases
2. currently pinned or active notes
3. note type inferred from syntax
4. recency and open-state signals
5. lexical and trigram matches over decrypted normalized features
6. semantic similarity over decrypted bounded embeddings
7. prior confirmed destinations for similar captures

Rank with `0.35 lexical + 0.15 trigram + 0.30 semantic + 0.10 recency + 0.10 title exact`, then apply the pinned boost `×1.2`. Send at most eight candidate IDs, titles, relevant headings, bounded snippets, and necessary metadata to the model—never full bodies.

Private-manual notes are excluded before index access and have no embedding or RAG row. A candidate is eligible only when its owner, privacy, deletion state, active generation, and `indexed_revision == notes.current_revision` all match; revalidate those conditions before model context and before mutation. Missing or stale rows never surface silently. Retrieval may directly decrypt and rank at most 50 recently changed eligible notes as a repair bridge; materially incomplete coverage disables RAG-based auto-apply and sends the capture to Review or Inbox unless an explicit deterministic rule resolves it.

The initial implementation performs an exact scan of encrypted per-user index documents, with a bounded five-minute in-process cache keyed by user, generation, model, and revision token. No plaintext shared cache, PostgreSQL FTS index, or persisted plaintext vector is allowed. Reindex builds a complete shadow generation and flips it atomically; a privacy change or deletion excludes the note immediately even if cleanup is pending. Key rotation rewraps index DEKs without re-embedding, while an embedding-model change builds a new generation. See [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §4 for lifecycle and failure behavior.

### 9.3 Structured organization schema

The model returns a strict JSON schema similar to:

```json
{
  "schemaVersion": 1,
  "captureKind": "list_items",
  "decision": "append_to_note",
  "destination": {
    "candidateId": "note_01...",
    "newNote": null
  },
  "operations": [
    {
      "type": "append_list_items",
      "section": "Open items",
      "items": ["milk", "spinach", "batteries"]
    }
  ],
  "generatedExpansion": null,
  "reasonCodes": ["explicit_shopping_intent", "open_daily_list"]
}
```

Allowed decisions:

- `append_to_note`
- `create_note`
- `add_to_inbox`
- `needs_review`

Allowed operations are implemented and validated by the domain layer. The first release should support:

- append raw capture
- append paragraphs
- append list items
- append a log entry
- update typed structured data
- add tags from an allowed set
- add a relation to an allowed note ID
- create a note with a validated title and type

No arbitrary search-and-replace or delete operation is exposed to the model in MVP.

The same operation vocabulary serves user-initiated interactions. `toggle_item_checked`, `update_log_field`, `edit_item_text`, and `remove_item` are user-only operations: they run through identical schema validation, revision preconditions, transactional mutation, and undo machinery, but they are never granted to the model in MVP. One validated operation layer, two callers.

### 9.4 Scoring and behavior bands

The server computes a routing score from features that have evaluation evidence. Initial features may include:

- explicit user rule match
- explicit capture prefix or destination mention
- exact candidate alias
- note type compatibility
- destination recency
- open-list or same-day log state
- semantic similarity and gap to the second candidate
- prior accepted and corrected decisions
- model reason-code consistency

Threshold values are not chosen by intuition and hard-coded forever. Tune them against a versioned evaluation set. The default product behavior is:

- **Auto:** evidence is strong enough to apply and show an Undo receipt.
- **Review:** plausible destination, but applying could pollute the wrong living note.
- **Inbox:** no useful candidate or an invalid plan.

Users may choose a more cautious mode where every AI route waits for approval.

### 9.5 Expansion policy

There are three distinct behaviors:

1. **Formatting:** convert clear list or log syntax without changing meaning. May be automatic.
2. **Organization:** choose a destination and note type. May be automatic when calibrated.
3. **Expansion:** add interpretation, summary, suggestion, or context. Generated and separate by default.

Do not combine these into one opaque "AI improved your note" operation.

### 9.6 Personalization

Personalization sources, in priority order:

1. explicit routing rules
2. pinned aliases and active-note settings
3. accepted or corrected prior decisions
4. aggregate feature weights derived from the user's history
5. generic model inference

Never train a global model on private note content without a separate explicit program, consent design, privacy review, and legal review. MVP personalization is retrieval and rule based.

### 9.7 Model and provider boundary

Create an `OrganizationModel` port owned by the domain-facing AI package, with a gated provider registry behind it. Current and planned adapters are:

- **OpenAI adapter — implemented in D; live/account gate pending:** Responses API with strict Structured Outputs and `store: false`.
- **Anthropic (Claude) adapter — implemented under [ADR-0015](./decisions/ADR-0015-user-selectable-provider-model-effort.md):** `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, `output_config.effort`, and one forced strict tool (`tool_choice: {type:"tool"}`, parallel tool use disabled) whose input schema is derived from the OpenAI schema; exactly one matching `tool_use` block is accepted, and text-only, zero/multiple/wrong tool calls, `max_tokens`, refusals, and non-object inputs defer to Review. Selectable with the user's own Claude key; its credentialed live report is pending.

Keep model IDs and per-effort model tiers in versioned server configuration so routing evaluation can select current cost-appropriate models per provider without changing domain code.

At the historical D checkpoint, the runtime used only its dedicated application-owned OpenAI key and rejected user BYOK. E4 now resolves the credential used per request from one live lease: the user's Vault-held OpenAI key or the application key selected by the immutable non-secret job snapshot. BYOK requests bypass the application's per-user model budget, since the spend is the user's, but keep all rate limits, payload caps, and validation. An invalid or revoked user key sends captures to Inbox with `provider_key_invalid` and a settings banner; there is no fallback to the application key unless that job's snapshot records the user's explicit choice.

User-facing effort settings shape each call (full mapping in `AI_ROUTING_SPEC.md`): routing effort selects the model tier and candidate budget; expansion style controls whether and how long generated expansions may be.

Send the minimum candidate context. Record token counts, latency, provider, prompt version, schema version, and response status, but keep raw note text and API keys out of all logs.

The selected provider API must support the pinned schema-constrained contract. Reconfirm exact SDK/model behavior against current official documentation and rerun the full provider×tier gate before exposing a provider or version.

### 9.8 Prompt injection and untrusted note content

Treat every capture and note snippet as untrusted data. The model prompt clearly delimits it and grants no tools. Model output is data that must pass:

- strict JSON schema validation
- known candidate ID validation
- user ownership validation
- operation allowlist validation
- length and item-count limits
- note revision preconditions
- deterministic policy checks

Prompt text cannot authorize a database operation.

### 9.9 Evaluation corpus

Maintain versioned cases that cover:

- empty-library and sparse first-week libraries
- same-day list continuation
- cross-day list behavior
- workouts with varied shorthand
- generic journal entries
- mindset and principle fragments
- project updates
- ambiguous tasks versus shopping items
- duplicate or near-duplicate notes
- adversarial instructions inside captures
- wrong candidate IDs
- stale revisions
- private notes that must never enter model context
- multilingual and code-switching cases before claiming support

Each case includes expected candidate set, permitted decisions, forbidden destinations, required preservation, and whether auto-apply is allowed.

## 10. System Architecture

### 10.1 Selected stack

- **Monorepo:** pnpm workspaces plus Turborepo
- **Web:** Next.js App Router, React, TypeScript, deployed to Vercel
- **Native iPhone:** Swift 6, SwiftUI, WidgetKit, App Intents, iOS 17+, and XcodeGen
- **API:** versioned Next.js route handlers in the web deployment for MVP
- **Auth, database, storage, realtime:** Supabase
- **Database:** PostgreSQL with Row Level Security; encrypted content envelopes and encrypted per-user retrieval documents
- **Key custody:** managed KMS/HSM in production through a provider interface; environment-backed keys are local/synthetic-preview only
- **Durable background processing:** authoritative PostgreSQL leases/queues with separately deployable Vercel organizer, index-worker, and verifier adapters
- **AI:** official OpenAI JavaScript SDK, Responses API, strict Structured Outputs
- **Validation:** Zod at application boundaries plus database constraints
- **Web styling:** Tailwind CSS with semantic CSS variables
- **Native styling:** SwiftUI semantic theme primitives derived from the approved visual tokens, with Dynamic Type and system accessibility behavior
- **Server data access:** generated Supabase types plus reviewed SQL functions for transactional mutations
- **Client data fetching:** TanStack Query on web; actor-isolated `URLSession` client with strict `Codable` DTOs on iPhone
- **Local native persistence:** GRDB backed by SQLCipher for drafts, capture outbox, sync metadata, and bounded cached read models; database key in Keychain
- **Web offline draft storage:** IndexedDB
- **Testing:** Vitest or Node test runner for packages, built-server HTTP E2E, XCTest for native behavior, and SQL tests for RLS and database functions. Playwright/XCUITest browser or UI lanes are future release work and are not installed or run in current CI.
- **Observability:** Vercel logs and traces plus Sentry for client and server errors, with note content redacted

Pin actual versions during bootstrap after verifying current compatibility. Do not copy version numbers from this planning date into a future lockfile without checking official release guidance.

### 10.2 Why two clients

This product benefits from two optimized client surfaces:

- The native app needs offline capture, keyboard behavior, haptics, share sheet, widgets, notifications, and app-store delivery.
- The hosted web product needs a strong desktop editor, responsive split-pane navigation, marketing routes, metadata, and Vercel-native APIs.

Share the versioned HTTPS/OpenAPI contract, fixtures, behavioral rules, and semantic visual tokens. Do not duplicate the backend or claim runtime-code sharing between TypeScript and Swift.

### 10.3 Logical architecture

```text
Native SwiftUI iPhone app             Next.js web app
  | SQLCipher outbox                     | web capture/editor
  |                                       |
  +------------- versioned HTTPS API -----+
                        |
                 auth and rate limits
                        |
              authenticated web/API
                  |         |
                  |         +-> isolated organizer (49 s maximum)
                  |               | exact Trusted Source + organizer OIDC
                  |               | AI object-wrap/content-MAC only
                  |               +-> atomic create/append + index job
                  |
          Supabase Postgres <----+---- isolated index worker
          RLS, ciphertext, jobs  |       | AI object-wrap + embeddings
                  |              |       +-> encrypted RAG document
                  |              |
                  |              +---- isolated strict verifier
                  |                      | decrypt-only AI object-wrap
                  |                      +-> generation attestation
          realtime receipt events
                        |
                both clients refresh
```

The iOS input edge sits in front of the SwiftUI application:

```text
Lock Screen WidgetKit extension
  -> App Intent / allowlisted URL
  -> SwiftUI capture destination
  -> the same local outbox and API path shown above
```

### 10.4 Request path

1. Client creates a ULID and stores the capture locally.
2. Client sends `POST /api/v1/captures` with the idempotency key.
3. Server validates auth, limits, content size, and workspace ownership.
4. Database transaction inserts the capture and workflow record once.
5. API returns `202 Accepted` with the capture and job status.
6. In Production and development, web makes a content-free OIDC-verified call to the isolated organizer (Preview deployments are not built in the free beta). The deterministic in-process adapter is an explicitly injected test fixture only.
7. The organizer derives ownership from the leased job, opens only eligible AI-assisted ciphertext, revalidates disclosure, authorizes the plan, obtains database-owned IDs/reservations, and atomically commits the encrypted result, receipt, and content-free index job.
8. Index work proceeds independently through its own durable queue and recovery schedule; it is never chained onto the organizer's 49-second response budget.
9. Clients receive a realtime change or poll the status endpoint.
10. The local outbox marks the capture synced only after server acknowledgement.

### 10.5 Why durable workflows

Organization includes database reads, an external model call, validation, a conditional write, indexing, and receipt emission. It must survive deployment, timeout, and transient provider failure. PostgreSQL job/lease state is authoritative; Vercel supplies four isolated deployment identities rather than one request-lifetime transaction. The organizer, index worker, and verifier keep narrow ports so another queue/runtime can replace them without weakening the database capability boundaries. A lost `after()` wake-up or organizer response cannot lose committed work because separate authenticated recovery schedules drain the organization and index queues.

## 11. Repository Layout

```text
unfiled/
  apps/
    web/                    # marketing, authenticated app, owner-authorized API
    organizer/              # isolated encrypted create-or-append runtime; AI-only KMS role
    worker/                 # separately deployed encrypted index worker; AI-only KMS role
    verifier/               # separately deployed strict-decrypt generation verifier
    ios/                    # native SwiftUI iPhone application and generated Xcode project
      Config/               # checked build settings for each environment
      Shared/               # extension-safe App Group and brand primitives
      Unfiled/              # app, domain, networking, persistence, sync, and feature sources
      QuickCaptureWidget/   # WidgetKit extension and App Intent
      UnfiledTests/         # Swift unit, integration, and presentation tests
      project.yml           # XcodeGen source of truth
  packages/
    contracts/              # versioned API schemas and DTOs
    domain/                 # notes, captures, routing, revisions, undo
    ai-routing/             # candidates, prompt schemas, scoring, model port
    api-client/             # typed TypeScript client used by web/server tests
    database/               # migrations, generated types, SQL functions, RLS tests
    sync/                   # outbox, idempotency, cursors, reconciliation
    search/                 # encrypted retrieval documents, ranking, index lifecycle
    design-tokens/          # color, type, spacing, motion, z-index, icon rules
    test-fixtures/          # deterministic users, notes, captures, AI cases
  supabase/
    migrations/
    seed.sql
    tests/
  docs/
    README.md               # documentation index and maintenance rules
    BUILD_PLAN.md
    GLOSSARY.md
    PRODUCT_REQUIREMENTS.md
    AI_ROUTING_SPEC.md
    DATA_MODEL.md
    SECURITY_AND_PRIVACY.md
    OPERATIONS_TEST_PLAN.md
    DESIGN_SYSTEM.md
    OPEN_QUESTIONS.md
    decisions/              # architecture decision records
  scripts/
  .github/workflows/
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
```

Dependency direction:

```text
contracts <- domain <- application services <- web/organizer/worker/verifier adapters
                         ^
                         |-- database adapter
                         |-- workflow adapter
                         |-- OpenAI adapter
                         |-- search adapter

OpenAPI + fixtures <-> native Swift DTOs/repositories/views
```

The TypeScript `domain` package must not import Next.js, Supabase, Vercel, Apple frameworks, or the OpenAI SDK. Swift domain and persistence code must not import server packages; the native network boundary depends only on the versioned API contract and fixtures.

## 12. Data Model

Every user-owned table includes `user_id`, timestamps, and database constraints. Enable RLS on every exposed table and test both allowed and cross-user-denied cases.

### 12.1 Core tables

#### `profiles`

- `id` references the auth user
- display name
- timezone and locale
- organization mode: cautious, balanced, or automatic
- expansion preference
- AI provider mode: app default, or bring-your-own-key per provider
- routing effort and expansion style settings
- created and updated timestamps

#### `user_provider_keys`

- `id`
- `user_id`
- provider: openai or anthropic
- Supabase Vault secret binding (never plaintext, never application-layer provider-key ciphertext)
- key last-four for display
- status: active, invalid, revoked
- monotonic credential revision
- validated, created, and updated timestamps

The Vault binding is not readable by clients. E4 implements exact owner CRUD only through the authenticated web service, and credential disclosure happens only through one live organizer lease. [ADR-0012](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md) supersedes the former application-ciphertext fallback and defines the full custody boundary. The implementation is locally verified, but production BYOK remains disabled until its deployed Vault/account/provider/canary/backup gates pass.

#### `spaces`

- `id`
- `user_id`
- optional `parent_id`
- `name`
- stable slug
- sort key
- archived timestamp

Limit nesting depth in application validation for MVP.

#### `notes`

- `id`
- `user_id`
- `space_id`
- `type`
- `title`
- `body_markdown`
- `structured_data jsonb`
- `current_revision`
- local-date key for daily notes when applicable
- open or completed state for lists and projects
- pinned, private, archived, and deleted timestamps
- created and updated timestamps

Use a unique partial index for note identities that must be singular, such as one daily Shopping list per user and local date.

Canonical content source by note type:

- `generic`, `principle`, `project` prose: `body_markdown` is canonical; `structured_data` holds metadata only. Checklist blocks inside `project` notes are the exception and follow the structured rule below.
- `list` and `log`: `structured_data` is canonical for items and entries — stable item IDs, text, checked state, typed numeric fields, and source capture ID. `body_markdown` is a deterministic projection regenerated inside the same transaction as every structured mutation; it feeds search chunks, export, and fallback rendering.
- A manual free-text edit that touches a projected region re-parses into structured items when the edit is unambiguous, such as adding or rewording plain list lines. An ambiguous structural edit creates a Review item as a structure conflict instead of guessing.

`structured_data` payloads carry their own `schemaVersion` per note type so extraction formats can evolve without breaking old notes.

#### `note_revisions`

- `id`
- `note_id`
- revision number
- source: manual, organization, undo, import
- full snapshot or storage-efficient patch
- content hash
- actor and mutation ID
- created timestamp

Start with full snapshots for correctness and simplicity. Revisit patch storage only after real size metrics justify it.

#### `captures`

- `id`, generated by the client
- `user_id`
- source: mobile, web, ios_lock_screen_widget, share sheet, import
- device ID
- raw text
- privacy mode
- client-created timestamp and timezone
- server-received timestamp
- processing status
- last error code
- deleted timestamp

#### `organization_jobs`

- `id`
- `capture_id`
- state
- attempt count
- workflow provider ID
- prompt, model, and schema versions
- started and completed timestamps
- safe error code

#### `organization_decisions`

- `id`
- `capture_id`
- candidate manifest
- deterministic signals
- model plan after validation
- computed behavior band
- selected destination
- reason codes
- created timestamp

Keep user text out of ordinary decision telemetry. The capture already owns the content.

#### `note_mutations`

- `id`
- decision ID
- note ID
- before revision
- after revision
- applied operation list
- inverse operation or before snapshot reference
- undone timestamp

#### `generated_blocks`

- `id`
- `user_id`
- note ID
- decision ID that produced it
- generated content
- kind: summary, interpretation, suggestion, label
- state: proposed, accepted, rejected
- model and prompt versions
- created and resolved timestamps

This table backs the Generated block domain entity in Section 8. A proposed block renders in the note as a clearly marked pending element; accepting it keeps it visible with provenance, rejecting it removes it. Rejected blocks are retained briefly for undo, then hard-deleted on the published retention schedule.

#### `capture_note_links`

- capture ID
- note ID
- mutation ID
- relation type
- inserted content marker

#### `routing_rules`

- `id`
- `user_id`
- enabled flag
- rule type and normalized condition
- destination note or space
- priority
- source: explicit or correction-suggested
- created and updated timestamps

An inferred pattern is never activated as a rule without explicit owner confirmation. Repeated accepted corrections may create a disabled proposal, including a narrow alias proposal, but they do not silently enable it.

Aliases referenced by search and candidate retrieval are routing rules with rule type `alias`; there is no separate alias store.

#### `tags` and `note_tags`

- `tags`: `id`, `user_id`, normalized unique name, created timestamp
- `note_tags`: note ID, tag ID, source: manual or organization, mutation ID when AI-applied, created timestamp

The AI `add tags from an allowed set` operation may only reference existing tag IDs from this table; it cannot create tags in MVP.

#### `note_links`

- `id`
- `user_id`
- from note ID and to note ID
- link type: reference, related
- source: manual or organization
- mutation ID when AI-applied
- created timestamp

This table backs the `add a relation to an allowed note ID` operation, inline note links in the editor, and the backlinks list in the web inspector.

#### `review_items`

- `id`
- `user_id`
- `capture_id`
- type
- candidate choices
- state
- resolution
- created and resolved timestamps

#### Encrypted library envelopes and retrieval index (Milestone C.5 target)

Content-bearing note columns and dependent snapshots become authenticated envelopes bound to owner, resource, version, and content kind. This covers note title/body/structured data, revisions, generated blocks, mutation and inverse snapshots, review and organization payloads, content-bearing idempotency responses, and derived search material. Plaintext columns retain only operational metadata required for RLS, CAS, queueing, filtering, and retention.

- `rag_index_generations`: user, embedding model/version, state, coverage counters, activation timestamp
- `note_rag_index`: user, note, generation, indexed revision, eligibility metadata, and one encrypted document containing lexical features, headings, bounded snippet, and bounded embeddings
- `note_index_jobs`: user, note, target revision/generation, lease and retry metadata; no content

`note_chunks` and its plaintext `tsvector`, content, hashes, and vector are removed by the verified C.5d contract. Deleting a note cascades every retrieval generation row and pending job. [DATA_MODEL.md](./DATA_MODEL.md) distinguishes the installed expand-compatible rollback schema from the implemented contracted target and its still-pending Production operation.

#### `feedback_events`

- stable prepared feedback event ID
- decision ID
- action: accepted, moved, undone, expansion accepted, expansion rejected
- old and new destination
- old-side and new-side mutation references for a correction; both reference the same feedback event
- optional reason code
- created timestamp

### 12.2 Transactional requirements

- Capture creation and job creation commit together.
- An organization mutation checks the note revision it planned against.
- Mutation, new revision, note update, capture link, decision status, and receipt event commit together.
- Duplicate capture submissions return the original result.
- A stale revision never overwrites a newer manual revision.
- A note mutation atomically enqueues its target retrieval revision, but indexing may complete asynchronously.
- Retrieval accepts only the active generation at the exact current note revision; stale rows are never eligible.
- Typed operations, CAS, idempotency responses, revision history, undo, export, and deletion retain their behavior after content moves to encrypted envelopes.

## 13. API Contract

Use `/api/v1` from the start. Publish OpenAPI from shared Zod schemas or generate both from a single reviewed source.

### Captures

- `POST /api/v1/captures`
- `GET /api/v1/captures` with date, status, and pagination filters, backing Today and Inbox views
- `GET /api/v1/captures/:id`
- `GET /api/v1/captures/:id/receipt`
- `POST /api/v1/captures/:id/retry`
- `DELETE /api/v1/captures/:id`

Deleting a capture removes the capture itself. Note content it produced stays in the note, with the provenance link marked as source-removed; the confirmation dialog offers to also remove the inserted blocks, which runs as an ordinary undoable mutation.

### Notes

- `GET /api/v1/notes`
- `POST /api/v1/notes`
- `GET /api/v1/notes/:id`
- `PATCH /api/v1/notes/:id` with expected revision
- `POST /api/v1/notes/:id/operations` with expected revision, for typed interactive operations: toggle an item, update a log field, edit or remove an item
- `POST /api/v1/notes/:id/move`
- `POST /api/v1/notes/:id/archive`
- `GET /api/v1/notes/:id/revisions`
- `POST /api/v1/notes/:id/restore`

### Spaces and tags

- `GET /api/v1/spaces`
- `POST /api/v1/spaces`
- `PATCH /api/v1/spaces/:id`
- `POST /api/v1/spaces/:id/archive`
- `GET /api/v1/tags`
- `POST /api/v1/tags`
- `DELETE /api/v1/tags/:id`

### Review and undo

- `GET /api/v1/review-items`
- `POST /api/v1/review-items/:reviewItemId/resolve`
- `POST /api/v1/mutations/:mutationId/undo` for a legacy single mutation that is not part of an E1 batch
- `POST /api/v1/mutation-batches/:mutationId/undo` with an anchor mutation; the server derives and validates every hidden member
- `POST /api/v1/decisions/:decisionId/correct`

### Search and sync

- `POST /api/v1/search` with the private query and paging fields in a strict JSON body; the API never accepts search text in its URL
- `POST /api/v1/sync/push`
- `GET /api/v1/sync/pull?cursor=`

### Rules and settings

- `GET /api/v1/routing-rules`
- `POST /api/v1/routing-rules`
- `PATCH /api/v1/routing-rules/:id`
- `DELETE /api/v1/routing-rules/:id`
- `GET /api/v1/me`
- `PATCH /api/v1/me/settings` for organization mode, AI provider mode, routing effort, expansion style, timezone, and locale
- `GET /api/v1/me/provider-key` returning provider, key last-four, and validation status only — never the key
- `PUT /api/v1/me/provider-key` validating the key with a minimal test call before encrypted storage
- `DELETE /api/v1/me/provider-key`
- `GET /api/v1/me/export`
- `DELETE /api/v1/me`

Every mutation accepts an idempotency key. Errors use stable machine codes and safe human messages.

## 14. Offline Capture and Sync

### 14.1 Native iPhone outbox

The native iPhone client commits each capture through GRDB into its SQLCipher database before showing success. The row includes:

- client ULID
- raw content
- client timestamp and timezone
- privacy and explicit destination options
- sync state
- retry count and last safe error

A foreground-owned sync loop sends pending rows with bounded exponential backoff. It starts or wakes when the scene is active, connectivity returns, or the user retries, and stops as soon as the scene becomes inactive. Server-side organization continues independently after durable acceptance; the native client does not decrypt its protected database or promise network retries while backgrounded.

### 14.2 Server authority

The server is authoritative for organization, notes, revisions, and receipts. The local client may optimistically show a pending capture but does not predict an AI destination as final.

### 14.3 Conflict policy

- Manual edits win over plans based on older revisions.
- AI append operations may re-plan once against the newest revision.
- A second conflict goes to Review rather than looping.
- Two identical client submissions with the same idempotency key produce one capture.
- Two distinct captures with identical text remain distinct events.

### 14.4 Web offline behavior

The web app stores unsent composer text and pending submissions in IndexedDB. Full offline note-library access is not required for MVP, but losing a browser connection after typing must not lose the draft.

## 15. Visual and Interaction Direction

### Design read

A calm personal utility, dark-first and phone-first, with the hierarchy of a good editor rather than the density of a research dashboard. It should feel private, grounded, and fast. Avoid AI-purple gradients, glowing agent avatars, chat bubbles as the primary UI, and decorative knowledge graphs.

Working design dials:

- `DESIGN_VARIANCE: 5`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 5`

### 15.1 Design-first execution protocol

Complete this sequence before framework and database bootstrap:

1. **Journey map:** diagram the paths from idea to durable capture, pending organization, receipt, correction, Review, manual edit, search, and undo.
2. **Information architecture:** finalize the iPhone tab navigation, web rail, note hierarchy, breadcrumbs, and the relationship between Today, Inbox, Notes, Spaces, and Review.
3. **Low-fidelity iPhone wireframes:** design the smallest supported phone first for Today, Capture, Lock Screen widget entry, processing, receipt, Notes, note editor, Review, Search, offline, and error states.
4. **Low-fidelity desktop wireframes:** adapt the same tasks to a left-rail and editor layout. Do not merely stretch the iPhone screen.
5. **Brand foundation:** use [BRAND_SYSTEM_UNFILED.md](./BRAND_SYSTEM_UNFILED.md) to produce the vector mark/wordmark, app and WidgetKit variants, public-site narrative, voice rules, and a documented name-clearance outcome.
6. **Dark visual system:** convert the brand palette into semantic color, type, spacing, radius, icon, motion, focus, and elevation tokens with contrast evidence.
7. **High-fidelity iPhone screens:** create the complete flagship flow, including both Lock Screen widget families, locked and unlocked entry, keyboard-open capture, restored draft, optimistic Saved state, background processing, receipt, Move, and Undo. Include the interactive surfaces: checking items off a list one-handed and tap-to-edit numeric fields on a workout entry.
8. **High-fidelity web screens:** create Today, the manual Notes library, the editor, Search, and Review at laptop and wide-desktop sizes.
9. **Public website system:** implement the six-section narrative defined by the brand system as separate responsive sections with real product crops and one global CTA contract.
10. **Clickable prototype:** connect the flagship shopping, workout, mindset, ambiguous-routing, manual-edit, and undo flows using realistic copy.
11. **Usability check:** test whether a person can capture without a filing decision, understand where content went, correct a wrong route, and find the manual editor without explanation.
12. **Design handoff:** record component anatomy, responsive rules, platform differences, empty/loading/offline/error states, and accessibility annotations in `DESIGN_SYSTEM.md`.

Apply the taste-skill preflight to the marketing surface and the relevant product-design rules to the application. The product UI is a daily utility, so prioritize clarity over landing-page spectacle. Do not use fake dashboard screenshots, generic three-card layouts, decorative glows, unexplained motion, or a chat-first shell.

Design approval means the core loop is coherent across iPhone and web. It does not mean every future settings page is polished before engineering starts.

### Theme

Dark is the default product expression. Build semantic tokens that can support a future light theme without rewriting components.

Selected Unfiled starting palette, subject to contrast testing:

- canvas / Ink: `#0B0C0E`
- primary surface / Graphite: `#181B1F`
- raised surface: `#22262A`
- border: `rgba(242, 239, 232, 0.14)`
- primary text / Warm Paper: `#F2EFE8`
- secondary text / Fog: `#9DA3A6`
- accent / Persimmon: `#EE6F55`
- danger: a separate muted red selected during M0; never overload Persimmon with both primary-action and destructive meaning

Use one accent across the product. Avoid pure black and pure white.

### Typography and icons

- Geist Sans or another compact, highly legible sans for UI
- Geist Mono only for timestamps, extracted measurements, and technical metadata
- Phosphor icons with one global weight
- no emoji as navigation icons

### Shape system

- containers: 12px radius
- inputs: 10px radius
- buttons: 10px radius
- circular icon buttons only when the hit target and meaning are clear

### Motion

Motion communicates state:

- composer submission compresses into a pending capture row
- receipt enters when processing finishes
- undo visibly restores the prior content
- note moves use a short layout transition

Honor reduced motion. Do not use perpetual AI shimmer after loading completes.

### Accessibility

- WCAG AA minimum, AAA target for primary reading text
- minimum 44 by 44 point touch targets
- Dynamic Type and font scaling on iPhone
- keyboard navigation and visible focus on web
- screen-reader labels and live announcements for Save, processing, receipt, error, and undo
- reduced motion and reduced transparency behavior
- color never serves as the only processing-state indicator
- loading skeletons match the actual layout

### Core UI states

Every primary surface must specify:

- loading
- empty
- offline
- queued
- processing
- completed
- needs review
- failed with retry
- partial sync
- deleted or restored

## 16. Security and Privacy

### 16.1 Trust boundaries

Untrusted inputs include:

- client requests
- note and capture content
- model output
- imported Markdown
- deep links and share-sheet payloads
- widget-originated URLs and any query parameters supplied with them

Trusted enforcement points include:

- API authentication and ownership validation
- database grants, constraints, and RLS
- organization-plan schema validation
- transactional mutation functions
- workflow idempotency
- exact Vercel Trusted Sources/OIDC identities and separate organizer/index/verifier database capabilities

### 16.2 Authentication and authorization

- Supabase Auth issues the user session.
- API routes verify the token and derive the user ID server-side.
- Every database table exposed through the Data API has RLS and least-privilege grants.
- Cross-user access tests run in CI.
- Service-role credentials stay server-side and are not used for routine user CRUD when a user-scoped path is available.
- Administrative operations require separate reviewed functions and audit records.

### 16.3 AI privacy modes

Provide two note modes:

1. `AI-assisted`: relevant bounded content may be sent to the configured model provider for routing and expansion.
2. `Private manual`: content is excluded from model candidate retrieval, embeddings, generated summaries, and AI search.

The product must explain that AI-assisted cloud notes are not end-to-end encrypted from the application server. The organizer sets `store: false` on the foreground OpenAI Responses request, which disables Responses application-state storage; it is not a Zero Data Retention guarantee. The separate Embeddings request has no `store` parameter. Under OpenAI's default controls, abuse-monitoring logs for either endpoint may contain customer content and may be retained for up to 30 days unless the project is approved and configured for Modified Abuse Monitoring or Zero Data Retention. This provider control is not a substitute for a complete privacy policy or data-processing disclosure.

Milestone C.5 application-encrypts both modes at rest. Production object DEKs are wrapped through per-user intermediate keys backed by managed KMS/HSM custody; no root content key lives in Vercel or Supabase. Separate key classes and principals prevent the organization worker from decrypting `private_manual` content. The owner-authorized interactive API may still decrypt private notes for CRUD, export, and lexical search, so the mode is not E2EE. KMS failure must fail closed without plaintext persistence.

### 16.4 Secrets and logging

- OpenAI, Anthropic, and Supabase application secrets exist only in server or build-secret stores.
- User-supplied provider keys in E4 live only in Supabase Vault, are disclosed only through one live organizer lease, display only last-four/status metadata, and never enter jobs, application ciphertext, logs, exports, or client responses.
- Do not log request bodies, note text, capture text, generated text, auth tokens, magic links, or service keys.
- Logs use user-independent trace IDs or a one-way pseudonymous identifier.
- Sentry breadcrumbs and replay features are configured to redact text fields.
- Production database access uses reviewed roles and rotation procedures.

### 16.5 Abuse and cost controls

- per-user and per-IP capture rate limits
- rate limits on typed note operations and all other mutation endpoints, tuned so rapid legitimate toggling is never blocked
- maximum capture length and candidate context size
- model token and request budgets
- bounded retry attempts
- queue age and depth alerts
- circuit breaker that preserves captures in Inbox when the provider is unavailable
- hashed safety identifier when required by the provider and appropriate under the privacy design

### 16.6 Export and deletion

Export contains:

- Markdown files by space and note
- JSON manifest with IDs, types, dates, tags, source captures, and links
- routing rules
- optional revision history

Deletion removes active envelopes, wrapped DEKs, every retrieval generation, queued index work, and provider-facing pending artifacts. Old backups may still contain a decryptable wrapped intermediate key under the shared KMS root until they expire; do not claim immediate cryptographic erasure. Publish backup-retention timing and test deletion reconciliation.

## 17. Search

### MVP search stack

Use the C.5 encrypted per-user retrieval service for AI-assisted notes:

1. exact title and alias match
2. lexical rank over decrypted index features
3. trigram similarity for spelling variation
4. semantic similarity over decrypted embeddings
5. recency and pinned-note boost
6. note-type and space filters

Results display the matching snippet, note path, and date. AI answer generation over the library is not required. Search should return notes, not synthesize facts the user did not ask for.

Persisted retrieval documents are ciphertext; PostgreSQL never receives plaintext snippets, token indexes, or vectors in the accepted initial path. Owner-authorized user search may scan private-manual notes lexically in process memory, but must not send either the private query or private content to an embedding provider. Search queries use authenticated `POST` bodies, not URL parameters.

### Indexing rules

- Every retrieval row records user, generation, note, and exact source revision.
- Query accepts only the active generation and current revision, then revalidates privacy/ownership before returning a result.
- Private-manual notes have no RAG row or embedding in any generation.
- Index jobs are content-free, leased, idempotent, and atomically enqueued with the note mutation.
- Privacy changes and deletion exclude immediately; physical cleanup follows by cascade/reconciliation.
- Model changes build and verify a shadow generation before activation; key rotation rewraps without re-embedding.
- A bounded direct-decrypt repair path covers at most 50 recent missing/stale notes. Material coverage loss disables RAG-based auto-apply.
- A plaintext vector or FTS design requires a future ADR and privacy review.

## 18. Testing and Evaluation

### 18.1 Unit tests

- capture validation and idempotency
- note type rules
- deterministic routing rules
- candidate ranking
- organization schema parsing
- operation allowlist
- revision conflict behavior
- inverse mutations and undo
- item ID stability across mutations
- toggle and field-edit operations, including idempotent repeat and stale-revision rejection
- Markdown projection determinism for list and log notes
- free-text re-parse versus structure-conflict classification
- local-date logic across time zones and daylight-saving transitions
- Markdown preservation
- privacy-mode filtering
- envelope context/tamper rejection, resolver fail-closed behavior, key rewrap, and canary absence from errors
- encrypted candidate ranking, active-generation selection, stale-index fallback cap, and incomplete-coverage fail-safe

### 18.2 Database tests

- RLS permits a user to access only owned data
- anonymous and cross-user writes fail
- unique daily-note constraints hold under concurrency
- capture and job insert atomically
- conditional revision mutation rejects stale writes
- delete cascades remove encrypted retrieval generations, jobs, and derived data
- export scope excludes other users
- content canaries are absent from persisted rows, indexes, idempotency responses, queues, Realtime payloads, and logs
- index jobs cannot claim private notes; cross-user, stale-revision, and inactive-generation retrieval is denied

### 18.3 Contract tests

- Swift and web clients validate the same versioned API fixtures
- server returns stable error codes
- old supported client schema versions remain compatible
- idempotent retries return the original capture and mutation

### 18.4 AI routing evaluation

Track at least:

- candidate recall
- exact destination accuracy
- note-type accuracy
- wrong auto-apply rate
- Review rate
- correction rate
- create-versus-append accuracy
- source-preservation failures
- invalid-plan rate
- latency and token cost by case type

Separate deterministic tests from stochastic model evaluations. Pin prompt, schema, candidate algorithm, and model configuration for a baseline. Run repeated samples where model variance matters.

### 18.5 End-to-end tests

Critical flows:

1. sign in on web and the native iPhone client
2. open the app from the Lock Screen widget while terminated and reach a focused blank composer
3. type from the system keyboard, save locally, terminate immediately, and recover the capture
4. save a capture online
5. save a capture offline, restart the app, reconnect, and sync once
6. route a shopping list and append a second message
7. check off a shopping item on iPhone and observe the change on web
8. route a workout log and correct a numeric field through tap-to-edit
9. send an ambiguous capture to Review
10. correct a destination and create a routing rule
11. undo an AI mutation
12. manually edit during an active organization job
13. search and open the updated note on the other client
14. export data
15. delete the account
16. seed unique canaries across every content-bearing artifact, exercise route/edit/review/undo/search, and prove durable stores and telemetry contain ciphertext only
17. flip an indexed note to private or delete it during retrieval and prove it cannot enter candidate/model context

### 18.6 Performance targets

Targets for the portfolio MVP:

- local capture acknowledgement feels immediate and does not wait for network or AI
- Lock Screen warm and cold launch focus meets the budgets in Section 0.3 on the oldest supported iPhone
- authenticated API acknowledgement p95 under 500 ms in the primary region, excluding cold-start outliers tracked separately
- typical organization receipt p95 under 8 seconds
- web LCP under 2.5 seconds for the authenticated shell on a representative connection
- web INP under 200 ms
- no capture loss in crash, retry, duplicate, and offline test matrices
- at 1,000 eligible notes, encrypted exact candidate retrieval p95 under 2 seconds cold (excluding query-embedding provider) and 250 ms warm
- candidate recall at least 0.98 and wrong auto-apply rate at most 0.01 with stale/missing-index cases included

Tune or revise targets from measured baselines. Do not hide failures by excluding slow successful jobs.

## 19. Observability and Cost Control

### Operational metrics

- capture acceptance count and error rate
- offline outbox age
- Lock Screen widget open-to-active, active-to-focused, focus-miss, draft-restore, and local-save timings without content
- workflow queue depth and oldest age
- workflow attempts, failures, and dead letters
- organization latency by stage
- model latency, tokens, and estimated cost
- invalid plan rate
- auto, Review, and Inbox distribution
- correction and undo rates
- stale revision conflicts
- search indexing lag
- realtime delivery failures

### Product-behavior metrics

The go/no-go gates in Section 22 require product evidence, not only operational health. Instrument, with content excluded:

- captures per active user per day, and the share submitted without an explicit destination (Gate 1)
- auto, Review, and Inbox distribution trend over a user's first weeks (Gate 3)
- correction and undo rate trend after each correction, per user (Gate 4)
- repeat-mistake rate: identical correction applied more than once by the same user (Gate 4)
- week-two capture retention: users still capturing in their second week
- interactive engagement: share of list notes with at least one toggle and log notes with at least one field edit

### Tracing

One trace connects:

```text
capture ID -> workflow ID -> candidate manifest -> model response ID
           -> decision ID -> mutation ID -> note revision -> receipt ID
```

Trace metadata excludes note content.

### Cost strategy

- deterministic rules short-circuit the model
- bounded candidate context
- small structured-output model selected by evaluation for normal routes
- stronger model fallback only for allowed ambiguous cases if it measurably improves outcomes
- encrypted index documents and embeddings recomputed only for changed note revisions or a new model generation
- no AI call for manual edits
- per-user daily budget with graceful Inbox fallback

## 20. Deployment and Operations

### Environments

- `local`: local Supabase stack, mock model adapter by default
- `preview`: Vercel Preview with non-production AI budget; for the current private beta it
  intentionally targets the same approved free remote Supabase project as Production
- `production`: protected Vercel Production scope targeting that one remote private-beta Supabase
  project

The shared private-beta database is an explicit cost-constrained exception, not isolation. Preview
can reach the same beta records as Production, so keep Preview access-controlled, use synthetic
canaries, and never treat it as a disposable public sandbox. Local Supabase remains Development.
Separate remote Preview/Production projects and paid PITR are deferred hardening requirements.

### Web and backend

- Deploy `apps/web`, `apps/organizer`, `apps/worker`, `apps/verifier`, and `apps/search` as five distinct Vercel projects with exact Preview and Production OIDC subjects.
- Prove each exact `*.vercel.app` alias belongs to its recorded project and the `production` environment before an OIDC-bearing call. The isolated services enforce the exact web caller through the checked-in app-level OIDC verifier; dashboard Trusted Sources rules are a deferred Vercel Pro control, and the free beta has no Preview deployments.
- Keep provider projects/keys, Terraform state, AWS accounts/roles/KMS roots, Vercel identities/settings, and recovery evidence separate by environment. The current private beta deliberately reuses one remote Supabase project and one least-privilege login per workload across the two managed scopes; this provides no database environment isolation. No isolated workload receives a global Supabase service-role/secret key, and no managed environment falls back to a local bearer, deterministic provider, or synthetic key authority. Dual remote databases and paid PITR remain deferred before broader release or irreversible contraction.
- Keep API routes and workflows in the same region as the primary database where practical.
- Protect internal workflow callbacks.
- Use migration checks before production promotion.
- Configure custom domain only after the working name passes review.

### Native iPhone

- XcodeGen Development scheme and unsigned Simulator build for local/CI checks
- signed Preview scheme distributed through the TestFlight internal group after archive inspection
- production iPhone build only after privacy manifest, icons, screenshots, URL routes, account deletion, SQLCipher migration, WidgetKit, and App Intent flows are complete
- API origin, bundle identifier, App Group, URL scheme, and display name pinned in the selected `.xcconfig`
- Apple signing, App Group provisioning, signed entitlements, and physical-device behavior remain human gates and are never inferred from Simulator CI

### Database

- all schema changes through checked-in migrations
- production migrations run through CI with an explicit approval gate
- scheduled backups and a documented restore drill
- connection pooling configured for Vercel workloads
- application-content keys resolve through managed KMS/HSM with short-lived workload identity; environment root keys are rejected in Vercel Preview and Production
- persisted plaintext FTS/vector indexes are absent after the C.5 contract migration

### CI checks

- formatting and lint
- strict TypeScript
- package-boundary test
- unit and contract tests
- migration lint and local apply-from-zero
- RLS tests
- deterministic mock-model scenarios
- web build
- clean `pnpm ios:generate` and deterministic XcodeGen target/configuration inspection
- `pnpm ios:build` and `pnpm ios:test` with signing disabled on an iOS 17+ Simulator
- human-owned signed iOS archive check for the embedded widget appex and shared App Group entitlement; current CI builds only with signing disabled
- future Playwright critical path after the dependency, browser fixtures, and truthful preview environment are added; current CI has no Playwright lane
- secret scanning and dependency audit

## 21. Milestones

Effort assumes one developer working part-time with AI assistance, including tests and documentation. Calendar time depends on native build and account setup. Do not trade milestone evidence for a promised date.

### Checkpoint execution protocol

Use this protocol for every remaining checkpoint so parallel work converges once instead of discovering shared-contract gaps at the release gate:

1. **Freeze first:** before implementation, freeze the migration/API/payload contract, trust and ownership boundaries, lifecycle and failure invariants, and one acceptance matrix covering success, denial, stale/replay, migration/upgrade, and built HTTP/native paths. Every row has one owning lane and an executable test or named human gate.
2. **Parallelize by ownership boundary:** after that freeze, run non-overlapping database, web/runtime, native, and documentation/security-audit lanes concurrently. Keep one writer for each migration and shared contract; integration follows the frozen dependency order, and a lane may not silently redefine another lane's DTO, timestamp, or state machine.
3. **Audit forward compatibility during implementation:** each lane tests both its local behavior and the next consumer's assumptions, including legacy/backfill state, response-loss replay, terminal history, authorization, and the real process boundary. Run the smallest vertical built-path smoke as soon as the first complete slice exists instead of waiting for final polish.
4. **Batch the release gate once:** after integration, run one clean from-zero database/lint/concurrency gate and one repository batch covering tests/coverage, builds, built-server smokes, HTTP E2E, native, capacity/evaluation, dependency/security checks, boundaries, and OpenAPI. Record one consistent evidence snapshot in the docs; rerun only the affected slice plus the final batch when a release-blocking fix changes code.
5. **Do not expand scope late:** a newly desired capability goes into the next checkpoint unless it fixes a proven invariant, security, data-loss, or acceptance failure. A true blocker requires an explicit contract amendment, updated acceptance rows, and targeted regression coverage before implementation resumes.

### Milestone 0: Design sprint and clickable prototype, 4-7 days

Deliver:

- journey map and finalized information architecture
- low-fidelity iPhone and desktop wireframes
- Unfiled vector mark/wordmark, app icon, WidgetKit template variants, and recorded name-clearance status
- six-section public-site responsive design based on `design/brand/web/01-hero.png` through `06-final-cta.png`
- dark-first semantic token sheet with contrast checks
- high-fidelity flagship iPhone flow
- circular and rectangular Lock Screen widget designs plus locked, cold-launch, restored-draft, offline, and focus-failure states
- high-fidelity manual Notes, editor, Search, and Review web screens
- realistic loading, offline, processing, receipt, ambiguity, failure, and undo states
- clickable prototype for the shopping, workout, mindset, and ambiguous examples
- usability notes and resolved design decisions
- initial `DESIGN_SYSTEM.md`

Gate:

- a tester can capture without choosing a destination first
- a tester understands the routing receipt without an explanation
- Move, Review, manual edit, and Undo are discoverable
- the smallest supported phone layout works with the keyboard open
- the widget-to-composer prototype requires one tap after device authentication and no filing choice
- desktop navigation fits on one line or one rail without ambiguous duplicate destinations
- contrast, focus, touch target, reduced-motion, and text-scaling requirements are annotated

### Milestone A: Repository and product contracts, 3-5 days

Deliver:

- monorepo bootstrap
- strict TypeScript and package boundaries
- local Supabase project
- shared IDs, schemas, errors, and time abstractions
- product requirements and initial design system documents
- deterministic fake organization model
- Lock Screen deep-link and native-extension feasibility spike, including fixed bundle and App Group identifiers for each build environment
- CI baseline

Gate:

- web and native iPhone shells compile
- clean XcodeGen runs create one valid application, `QuickCaptureWidget`, and test target on both the first and second generation
- packages test independently
- local database migrates from zero
- no production credentials are required for tests

### Milestone B: Manual notes vertical slice, 1-2 weeks

Deliver:

- authentication
- spaces and five note types
- create, read, edit, move, archive, search by text
- interactive checklist toggling on list and project notes through typed operations
- tags and note links
- revisions
- native iPhone and web navigation
- dark-first tokens and core states

Gate:

- a user can use the product as a normal synchronized notes app without AI
- checking an item off creates a revision, is undoable, and appears on the other client
- cross-user RLS suite passes
- manual edits survive refresh and cross-device access

### Milestone C: Durable capture, Lock Screen entry, and receipt, 2-3 weeks

**Implementation status (2026-08-31):** the credential-free backend/web portion of Gate 3 is recorded green. Its final local database gate applied every migration from zero with zero lint findings and passed 18 pgTAP files / 822 assertions; the aggregate code, coverage, dependency, HTTP E2E, static-asset, and responsive visual checks also passed. Earlier client/widget evidence belongs to the superseded client and does not establish the SwiftUI replacement. ADR-0010 therefore reopens the native portion of this gate. Clean XcodeGen generation, SQLCipher persistence, Swift tests, unsigned Simulator build, Apple signing, physical-device widget/restart behavior, archive inspection, and cloud-preview canary/performance evidence must be recorded independently.

Deliver:

- native GRDB/SQLCipher outbox and migration layer
- native capture route with reliable cold- and warm-start focus
- circular and rectangular WidgetKit Lock Screen extension declared by XcodeGen, with one App Intent
- content-free App Group snapshot helper, Apple application/extension credentials, and physical-device launch matrix
- locally persisted widget-originated drafts and expired-session recovery
- web IndexedDB draft and submission queue
- idempotent capture API
- durable workflow adapter with fake decisions
- processing status and receipts
- retry and failure states
- selected OQ-4 behavior: close the composer after the local durable save acknowledgement; burst-entry mode remains deferred

Gate:

- offline capture survives app termination and syncs exactly once
- a widget-originated capture reaches a focused composer in one tap after system authentication and is locally durable before acknowledgement
- the extension archive is signed correctly and never exposes capture content on the Lock Screen
- provider and workflow failures never lose the source capture
- a receipt can be observed on both clients

### Milestone C.5: Encrypted Library + Private RAG, 2-3 weeks

This security milestone is a hard prerequisite for Milestone D. It implements [ADR-0006](./decisions/ADR-0006-application-encrypted-library-and-private-rag.md), [ADR-0007](./decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md), and [ADR-0008](./decisions/ADR-0008-encrypted-aggregate-rollout-and-replay.md); until the complete C.5 gate is green, documentation and product copy must not claim that the note library is fully encrypted.

Current status: C.5a's custody/expansion boundary, C.5b's encrypted aggregate/managed adapters, C.5c's isolated organizer/index/verifier runtimes, C.5d's encrypted application cutover plus irreversible database contract, and Milestone D's production organizer composition are present in code. The production repository composition selects the complete encrypted note and capture adapters from authoritative rollout state and never downgrades on a state/KMS/RPC failure. Migration `20260830000027_encrypted_storage_contract.sql` is deliberately expand-compatible on install; only an explicit database-owner call with the exact confirmation phrase and a freshly recomputed readiness digest removes the rollback schema. Production has not executed that operation. The organizer now composes its content cipher, lease-bound encrypted RAG retrieval, OpenAI embedding/query path, strict Responses planner, conservative policy, and atomic create-or-append/Review publication. The account-bound provider/deployment, live stochastic evaluation, KMS/CloudTrail/rotation/restore, canary/rollback, backup-expiry, signing, and physical-device evidence in `HUMAN_SETUP.md` remain launch-blocking.

[ADR-0009](./decisions/ADR-0009-private-rag-runtime-and-organizer-capability.md) resolves the C.5c runtime capability boundary: the index identity remains limited to the six RAG functions from ADR-0007, those functions may return only byte-bounded owner/revision-bound AI-assisted ciphertext and wrapped-key projections needed for their named operation, and atomic organization receives the separate non-bypass `unfiled_organizer_worker` identity. Milestone D expands only that organizer identity from eight to exactly ten RPCs by adding bounded encrypted-RAG pagination and exact ranked-candidate selection. The two AI pipelines do not share a database credential and neither receives `service_role`. Production, Preview, and development web `after()` plus recovery routes invoke the isolated organizer with a content-free Trusted Sources request; deterministic organization is an explicit test seam only.

The implemented C.5c index slice includes encrypted lease/commit/read projections; canonical generation attestation and activation gates; strict float32 payload encoding; bounded exact-scan retrieval and deterministic hybrid ranking; stale-coverage repair and cache zeroization; and a production-composed worker. Its database session is hostname/certificate verified, pinned to the exact `unfiled_index_worker` identity, and restricted in code to the six reviewed RPCs. Processing orders `open → disclosure heartbeat → embed → strict build/seal → publication heartbeat → commit`, wipes embedding buffers, and exactly replays ambiguous terminal requests once. A bounded web controller creates, resumes, replaces, seeds, drains, verifies, and activates shadow generations through service-only RPCs. The separate `apps/verifier` deployment has a distinct exact database login and decrypt-only AWS identity, strictly opens every note-derived encrypted index document, and can call only the exact page-read and attestation RPCs. Its fixed admission capacity is 1,000 notes: 33 fixed pages, a 50-row ceiling, and a fixed 8 MiB ciphertext budget provide 1,023 physical slots at 31 database-maximum rows per page, deliberately capped at the accepted retrieval gate. A separate fixed four-key-record limit bounds KMS work. Larger owners are content-free deferred before creation, and an over-cap building generation is failed once rather than churned. Increasing either limit requires a reviewed incremental-verification design and performance evidence, not an environment override. Historical C.5c-2 focused evidence is 158 worker tests, 436 web tests, 168 verifier unit tests plus the dedicated 1,000-document capacity gate, 13 Terraform tests, and a clean 23-file / 1,185-assertion database run.

The implemented C.5c–D organizer slice adds `apps/organizer` as a fourth exact Vercel/OIDC/KMS trust domain. Its maximum request deadline is 49 seconds. Preview and Production each accept only their exact same-environment web Trusted Source and a body containing a bounded drain trigger; they reject cross-environment subjects, browser/user authorization, local bearer secrets, cookies, bypass credentials, owner IDs, global Supabase credentials, static AWS credentials, ambient provider keys, user BYOK, and every private-manual identifier. Each managed environment accepts exactly its own dedicated organizer-only OpenAI project/service-account key and uses its own AWS/KMS resources. The private beta deliberately reuses the one workload-specific database login in its shared remote Supabase project; this is not database isolation. Its AWS role can use only AI-assisted object-wrap and content-MAC roots. The `unfiled_organizer_worker` TLS login has no relation/private-schema capability and exactly ten RPCs: claim, heartbeat/revalidate, bounded candidate projection, encrypted-RAG pagination, exact ranked-candidate selection, prepare create, prepare append, atomic commit, fail, and recovery. Database leases derive owner scope, issue stable IDs/reservations, and linearize disclosure and commit. Unknown plans are authorized against the candidate manifest before preparation and materialized only with database-issued IDs. A stale append can replan once; a second conflict becomes Review. The atomic commit also creates index work, but neither managed environment chains the index drain onto the organizer request; independent recovery owns it.

The final historical C.5c-3 credential-free evidence passes 449 web, 159 worker, 168 verifier, and 132 organizer tests. Organizer coverage is 87.01% statements / 83.29% branches / 93.29% functions / 90.17% lines. A clean database rebuild and zero-finding lint accompany 24 pgTAP files / 1,227 assertions, including 42/42 focused organizer assertions. A separate real-PostgreSQL lane proves six rollout-lock behaviors without deadlock or fixture residue, the fixed 1,000-document verifier capacity lane completes in 8.18 seconds, the production dependency audit reports zero known vulnerabilities, and the unsigned native gate passes 81 Swift tests. C.5d extends that local database gate to 32 files / 1,417 assertions, adds 41 zero-owner/nonzero-owner contraction assertions, and adds a fail-fast concurrent-application regression that returns `contract_application_in_progress` without a receipt or catalog change. Milestone D adds a 175-case deterministic mock corpus around the real parser, extraction, preservation, authorization, and policy boundary. Historical/local evidence does not satisfy the dedicated OpenAI project, live stochastic evaluation, account-bound cloud, canary/rollback, signing, or physical-device gates, and it does not mean production has been contracted.

Deliver:

- **C.5a custody/expansion — implemented in code, account evidence pending:** a production managed-KMS resolver using short-lived workload identity; independent object-wrap/content-MAC purposes; per-user intermediate keys; owner/class/purpose/key-bound resolution; and separate AI-assisted/private key classes
- separately deployed `apps/organizer`, `apps/worker`, and `apps/verifier` Vercel projects with exact OIDC subjects and least-privilege AI-only AWS roles; dedicated `unfiled_organizer_worker`, `unfiled_index_worker`, and `unfiled_rag_verifier` database roles that start `NOLOGIN`/`NOBYPASSRLS` with exactly eleven after E4, six, and two RPCs respectively and no table or administrative capability; and a distinct interactive web/API subject, role, and service-only root-rewrap CAS path
- **C.5b encrypted aggregate — implemented and wired behind authoritative rollout state:** server-side domain operations plus service-only envelope/CAS RPCs and a database rollout state `expanded → dual_write → encrypted_read → encrypted_only → contracted`; C.5b owns the safe transitions through `encrypted_read`, while C.5d owns `encrypted_only` and the explicit global contraction
- versioned AES-256-GCM envelopes for note title/body/structured data, revisions, generated blocks, organization/review payloads, mutation and idempotency snapshots, and routing-rule content
- server-side typed mutation/CAS/idempotency RPCs that atomically persist encrypted current state, history, receipts, and a content-free index job
- a resumable expand/backfill/verify/cutover/contract migration that removes legacy plaintext columns, functions, indexes, and `note_chunks`
- content-free resource references for encrypted idempotency responses and sticky private classification for revisions/mutations spanning a privacy transition
- **C.5c–D atomic organizer — production composition implemented; live/account evidence pending:** separate 49-second runtime, exact Trusted Source, AI-only object-wrap/content-MAC custody, dedicated organizer-only OpenAI key, ten-RPC lease/RAG/prepare/commit database surface through E3 plus E4's sole live-lease credential resolver, canonical plan authorization/materialization, one-replan-then-Review policy, and atomic encrypted note/decision/receipt/index-work publication
- **C.5c private RAG:** paged encrypted exact scan with bounded concurrency/memory, strict versioned float32 embedding encoding, shadow-generation activation, stale-index repair, and incomplete-coverage fail-safe
- `rag_index_generations`, encrypted one-document-per-note `note_rag_index`, and content-free leased `note_index_jobs`
- hybrid lexical/trigram/semantic/recency/title ranking by exact per-user in-memory scan, with stale-index repair and incomplete-coverage fail-safe
- **C.5d cutover/contract — implemented in code; production operation/evidence pending:** encrypted read/write/search/export/retention paths, authenticated `POST` search bodies, `no-store` responses, fail-closed rollout selection, database-owner/digest-bound plaintext contract removal, zero/nonzero-owner and concurrency regressions, and the production canary/runbook in `HUMAN_SETUP.md`
- owner-authorized streaming export, live-data deletion, backup-expiry handling, rotation/rewrap, restore, and reindex runbooks
- client note caches that preserve the native GRDB/SQLCipher and encrypted web IndexedDB boundaries

C.5b's established local evidence is 93/93 `@unfiled/encrypted-aggregate` tests, 38/38 focused note read/write/coordinator security tests, 14/14 adversarial note aggregate repository tests, and 20 database files / 1,091 assertions, including 101/101 assertions for `073_encrypted_aggregate_dual_write.test.sql`. These are code and local-database results, not production KMS, CloudTrail, database-login, Apple-signing, physical-device, or backup-restore evidence.

Gate:

- canary fixtures prove no title, body, structured value, revision, generated content, operation/inverse, review/decision payload, snippet, token, embedding, or unkeyed content hash persists in rows, indexes, queues, idempotency responses, Realtime, logs, traces, or analytics
- RLS and KMS IAM deny cross-user access; an independent worker deployment cannot decrypt the private key class even if its role is exercised directly; KMS failure never falls back to plaintext
- CRUD, typed mutations, CAS, replay, history, undo, sync, export, soft/hard deletion, and restore retain parity through encrypted storage
- private notes produce zero index rows and zero model/embedding calls; privacy flips and deletes exclude them immediately under race tests
- only active-generation rows at the current note revision are eligible; stale/missing coverage follows the bounded repair path and cannot authorize unsafe auto-apply
- the 1,000-note exact-retrieval latency and routing-quality targets in §18.6 pass
- production key rotation/rewrap and backup restore succeed; pre-cutover backup exposure is documented until expiry

### Milestone D: AI create-or-append routing, 2-3 weeks

**Implementation status (2026-09-01): credential-free local implementation gate green; external release evidence pending.** The organizer now composes the production content cipher, encrypted exact-scan RAG retrieval, strict provider plan, deterministic extraction/source-preservation layer, conservative banding policy, and atomic create-or-append/Review publication. Its database login has exactly ten reviewed RPCs: the original eight lease/prepare/commit functions plus bounded encrypted-RAG pagination and exact ranked-candidate selection. The OpenAI integration uses one dedicated organizer-only project/service-account key for the capture-query embedding and a pinned foreground Responses request. It does not use tools, conversations, streaming, background mode, or an environment-selectable model/base URL.

**Recorded local evidence:** the deterministic safety corpus passed 175/175 cases, and the deterministic production-component seam passed 15/15 with `liveProviderEvidence=false`; it is not live-provider evidence. The organizer passed 18 files / 277 tests at 84.72% statements, 80.85% branches, 92.07% functions, and 88.37% lines. The final deterministic local-custody 1,000-note encrypted-retrieval gate recorded cold p95 389.18 ms and warm p95 12.63 ms, excluding cloud KMS, network, and embedding-provider time. A clean database rebuild passed 33 pgTAP files / 1,429 assertions, and the unsigned Swift/Xcode Simulator gate passed 88 tests. The live OpenAI evaluation, production deployment/account configuration, Trusted Sources/OIDC and database-login canaries, managed-KMS/CloudTrail evidence, Apple signing, and physical-device acceptance remain pending.

Deliver:

- encrypted per-user candidate retrieval wired to the organization pipeline: lease-bound pagination of the active complete generation, in-memory exact hybrid ranking, and exact current-revision candidate selection
- strict organization schema plus exact unknown-output parsing, candidate authorization, source-preservation inspection, and deterministic extraction override
- OpenAI Embeddings and Responses adapters with bounded inputs/outputs, caller cancellation, absolute deadlines, narrow retries, strict Structured Outputs, no tools, and `store: false` on Responses
- deterministic scoring policy with privacy, stale-index, explicit-destination, ambiguity, duplicate, and failure overrides
- deterministic create-note, append-raw, list, log, principle, and project application with database-issued stable IDs and encrypted aggregate sealing
- encrypted Review publication for ambiguity, conflicts, and unavailable explicit destinations. At the historical D boundary a returned `generatedExpansion` was discarded; E3 now preserves it as a separate encrypted proposal
- a 175-case deterministic evaluation harness covering sparse libraries, same/cross-day lists, workout shorthand, journals, principles, projects, ambiguity, duplicates, hostile output/injection, stale revisions, private exclusion, index races, cross-tenant retrieval, and multilingual input
- a separate deterministic production-component retrieval-through-application seam with an explicit exercised/excluded/simulated scope report, plus an optional explicit-key OpenAI runner fixed at three samples per eligible frozen synthetic case and content-free status/latency/token/cost/version/hash/decision telemetry

Credential-free gate:

- source-preservation suite has zero failures
- invalid model plans fail closed to Inbox or Review
- the 175-case deterministic mock corpus meets candidate, destination, auto-apply, create/append, preservation, invalid-plan, and injection thresholds through `pnpm eval:routing`
- the deterministic production-component cases pass through `pnpm eval:routing:pipeline`, declare `liveProviderEvidence=false`, and report their exercised, excluded, and simulated boundaries
- direct competitor examples do not require hard-coded demo branches

External release gate:

- create a dedicated OpenAI project/service account, configure budget/rate alerts and the approved data-retention posture, and store only `UNFILED_ORGANIZER_OPENAI_API_KEY` in the organizer Production secret store
- run `pnpm eval:routing:live` with only `UNFILED_ROUTING_EVAL_OPENAI_API_KEY`; it must execute exactly three independent samples per eligible frozen synthetic pipeline case and produce a dated content-free worst-of report with latency/token/cost summaries, version pins, and hashes but no note content, prompt/response body, or key
- keep the deterministic report and live stochastic report distinct: a green mock report cannot authorize provider traffic, and a live report cannot replace parser/policy safety tests
- run the synthetic create, append, explicit-destination, ambiguous Review, privacy/race, replay, and dependency-outage canaries in `HUMAN_SETUP.md`; verify ciphertext-only durable state and the rollback/restore boundary before enabling a small cohort

The live OpenAI evaluation and deployed canary have not been run from this repository state and must not be described as complete.

### Milestone E: Correction, undo, and personalization, 1-2 weeks

**Implementation status (2026-09-01): E0–E4 are implemented and their credential-free local aggregate/HTTP gates are green. PR #15 records E2 CI, PR #16 records E3 CI, and PR #17's required E4 CI lanes are green. E4's independent final audit is clear. Every deployed canary and production account gate remains pending.** E1 adds the six reserved database capabilities, owner-authorized web runtime and public handlers, and SwiftUI correction, Review-resolution, receipt-detail, destination-picker, and batch-Undo interactions. Correction prepare is outcome-neutral; web authenticates and decrypts the source material, selects exactly one sealed branch, and commit either publishes an exact two-note/two-mutation/one-feedback correction or changes no note and creates encrypted Review. The correction fallback retains authenticated decision/capture lineage, so its Review permits `route`, `create`, `keep_inbox`, or `dismiss`. Batch membership and its canonical anchor are server-derived, bounded to 1–16 distinct owned notes, and all-or-nothing; a non-anchor member and every mutation created by a prior batch Undo are rejected as new anchors. An unsafe batch creates a decision-less encrypted Review that permits only `keep_inbox` or `dismiss` and returns private `409 conflict_requires_review` without fabricating a success response. Receipts, Review payloads, mutations, and replay history remain encrypted and owner-bound throughout both paths.

E3 extends the existing organizer prepare/commit payloads rather than its database allowlist. When an applied create or append includes an authorized expansion, the same transaction persists a separate AI-assisted encrypted `proposed` block, its immutable model/prompt provenance, and an encrypted pending-expansion Review. The block never becomes part of the user-authored note snapshot. `resolve_encrypted_generated_block` is the sole new public resolver and the sole accept/reject commit path: it advances only the block and Review state, writes encrypted receipt/replay evidence and one feedback event, and leaves note content, structured data, and revision unchanged. Accepted blocks remain separately visible with provenance; rejected blocks are hidden and become purge-eligible after seven days through the existing encrypted note-retention capability. Owner-visible list reads are owner-and-note-scoped, traverse block IDs in ascending keyset order, fetch 51 eligible rows to return exact 50-item pages, and remove rejected rows before applying the keyset and limit. Review hydrates one proposal through authenticated `GET /generated-blocks/{blockId}` rather than scanning an owner-wide collection. Public list/detail response schemas admit only `proposed` or `accepted`; only the resolver response can return the resulting rejected state. A duplicate suspicion creates only an encrypted Review with an explanation and two or three distinct, current, owner-authorized note/revision choices. `Keep both` and `Dismiss` resolve metadata only; no E3 action merges, deletes, archives, rewrites, or redirects a note. Web and Swift use the same authenticated read and `POST /generated-blocks/{blockId}/resolve` contracts and render the same separate generated-block and duplicate-review surfaces, including exact-request retry and authoritative stale/replay refresh behavior.

E4 implements OpenAI BYOK and AI settings without putting a credential in an application table, content envelope, job, export, log, or client response. Exact owner-scoped settings and provider-key CRUD run only through the authenticated web boundary; `user_provider_keys` contains only Vault locator and display/lifecycle metadata, while the job snapshot contains only immutable, secret-free settings. The organizer's one new capability accepts job ID plus live lease token, derives owner/provider/settings, and resolves exactly one active credential from Vault. Provider-key PUT replay is checked before external validation: the first database replay probe compares the submitted key transiently against the live Vault secret and receipt-bound credential revision. No secret-derived fingerprint is stored durably; secret or revision drift fails closed, exact replay returns the original safe response without another provider call, and only a replay miss invokes external validation and the atomic Vault store/replace path. Web and Swift lock settings controls after an ambiguous write until the exact attempted draft is retried or explicitly discarded. OpenAI is the only selectable provider; Anthropic and unevaluated provider/model choices remain hidden.

The recorded credential-free E1 gate is green: the full built-local HTTP B–E1 suite passed; web passed 78 files / 651 tests; organizer, worker, and verifier passed 18 / 281, 18 / 159, and 11 / 168 respectively; a clean database reset plus strict private/public schema lint passed with zero warnings, followed by 36 pgTAP files / 1,671 assertions and the database concurrency gate; and Xcode built the Swift app plus `QuickCaptureWidget` and passed 135/135 tests. The workspace format/lint/typecheck/coverage gate passed 26/26 tasks, the build passed 16/16 tasks, all three built-server smokes passed, boundaries and OpenAPI were green, and the dependency audit reported no known vulnerabilities. Deterministic routing passed 175/175 cases, the production-component seam passed 15/15 cases, verifier capacity passed 1/1, and the 1,000-note organizer retrieval gate recorded cold p95 407.03 ms and warm p95 18.07 ms. This evidence does not establish Production KMS/Vercel/provider/account evidence, Apple signing, deployment, or physical-device behavior.

E1 also contains a migration-owned, runtime-inaccessible repair for legacy organizer receipt timestamp projections. It runs only during upgrade after proving the exact owner/job/capture/preparation/reservation/envelope/verification chain, changes only `capture_receipts.created_at` to the authoritative capture `client_created_at`, preserves the ciphertext envelope, receipt revision, and verification evidence, restores the encrypted-write guard, and is idempotent. Unattested or incomplete state aborts the upgrade.

[ADR-0011](./decisions/ADR-0011-encrypted-owner-interactions-and-personal-rules.md) keeps correction, Review resolution, rule plaintext, and generated-block resolution in the owner-authorized web trust domain. [ADR-0012](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md) makes Supabase Vault the sole BYOK store and adds one lease-bound organizer credential capability only in E4.

Implementation lanes are dependency-ordered at the shared contract, then may proceed independently without migration/RPC collisions:

| Lane                     | Status      | Assigned migration                                                        | Frozen capability boundary                                                                                                                                                                                                               |
| ------------------------ | ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 correction/Review     | Implemented | `20260901000002_encrypted_decision_corrections.sql`                       | `prepare_encrypted_decision_correction`, `commit_encrypted_decision_correction`, `prepare_encrypted_review_resolution`, `commit_encrypted_review_resolution`, `get_encrypted_mutation_batch`, `undo_encrypted_mutation_batch`            |
| E2 rules/personalization | Implemented | `20260901000003_encrypted_routing_rules_and_personalization.sql`          | Exactly five service-only RPCs: `get_encrypted_routing_rule_observation_epoch`, `get_encrypted_routing_rule_write_claim`, `prepare_encrypted_routing_rule_write`, `commit_encrypted_routing_rule_write`, `delete_encrypted_routing_rule` |
| E3 expansions/duplicates | Implemented | `20260901000004_encrypted_generated_blocks_and_duplicate_suggestions.sql` | extend existing organizer prepare/commit payloads; add only `resolve_encrypted_generated_block`                                                                                                                                          |
| E4 settings/BYOK         | Implemented | `20260901000005_vault_byok_and_ai_settings.sql`                           | `get_owner_ai_settings`, `update_owner_ai_settings`, `get_user_provider_key_status`, `put_user_provider_key`, `delete_user_provider_key`, `get_lease_bound_organizer_provider_credential`                                                |

`20260901000001_milestone_e0_interaction_contracts.sql` implements the shared Milestone E foundation; E1, E2, E3, and E4 own their assigned `00002` through `00005` migrations. E3 leaves the organizer allowlist at exactly ten RPCs. The implemented E4 migration changes it to exactly eleven by adding only the live-lease Vault credential resolver. Deployed Vault evidence is still required before production BYOK can be enabled.

E2 deliberately expands its frozen boundary from three to exactly five service-only RPCs. `get_encrypted_routing_rule_write_claim` makes response-lost update and offer-acceptance replay unambiguous by returning the stable owner/idempotency-bound scope, rule/revision and request-MAC key coordinates, plus only an opaque encrypted response when the claim is complete. `get_encrypted_routing_rule_observation_epoch` provides the content-free owner-wide epoch/CAS needed when distinct learned corrections both decrypt an initial state with no matching rule: one commit advances the epoch, while the stale caller rereads, decrypts, and replans against the new rule instead of creating a duplicate proposal. Neither getter exposes or stores plaintext rule conditions, aliases, sample captures, normalized conditions, deterministic equality tokens, or condition hashes.

The E2 lifecycle is explicit and owner-controlled. A directly created rule has source `explicit`, no proposal state, and may be enabled immediately. The first matching correction creates or updates a hidden, disabled `observing` learned rule; the threshold observation moves it to owner-visible, disabled `offered`; only explicit acceptance produces `accepted` and permits enablement. Decline moves the offer to hidden, disabled `declined` so the same suggestion is suppressed. Deleting an offered learned rule is therefore a decline; deleting an explicit or accepted rule hard-deletes its encrypted aggregate and replay-safe tombstone response. A blocked destination can be preserved only while pausing the exact unchanged rule; it cannot be re-enabled or retargeted to an ineligible destination.

Condition canonicalization is one frozen cross-platform contract used for validation, matching, learning, encryption, web, and Swift: reject raw request text over 500 UTF-16 code units; trim only the Unicode `White_Space` property at request-display edges; apply NFKC; lowercase with the locale-independent `und` locale; collapse each Unicode `White_Space` run to ASCII U+0020; trim it; then strip trailing Unicode punctuation and whitespace. The canonical form must contain 1–500 UTF-16 code units, so punctuation-only and NFKC-expanding overflow inputs fail. U+0085 is `White_Space` and is collapsed/trimmed; U+FEFF is deliberately not in that frozen set and must not acquire JavaScript `trim()` semantics.

Capacity is fixed rather than environment-tunable: at most 1,000 retained rules per owner, at most 256 active owner-confirmed rules, and at most 8 MiB of decrypted active-rule payload per match. The owner API returns cursor-bound pages of at most 50 rules and at most 8 MiB each. Browser and Swift clients follow all pages, reject duplicate IDs, repeated cursors, malformed continuation state, more than 1,000 retained rules, or an oversized/malformed response. The server's shared JSON reader incrementally enforces a 250,000-byte request limit, cancels overflow, and zeroes buffered request chunks; the TypeScript and Swift routing-rule transports incrementally enforce the 8 MiB response ceiling instead of trusting `Content-Length` alone.

Mutation clients treat `replayed: true` as a signal to perform an authoritative list refresh. Rule collections merge monotonically by revision, a stale refresh cannot roll back a newer rule, and a failed reconciliation retains the exact body and idempotency key for retry. A `stale_revision` response also triggers an authoritative refresh. Invalid JSON, malformed error envelopes, invalid success DTOs, truncated bodies, and response-limit failures become sanitized ambiguous transport errors rather than proof that a write did not commit.

Rule matches never bypass organizer safety. PostgreSQL validates the immutable six-field capture/job snapshot against the enabled owner-confirmed rule and exact destination/revision/priority. A note destination must still be current, open, unarchived, undeleted, type-compatible, and eligible: list captures append only to lists, log captures only to logs, and generic/principle/project captures use exact raw append. A space destination uses the capture-local date for list/log daily-note append-or-create and may create a generic/principle/project prose note in that exact space. Missing, private, closed, archived, deleted, ambiguous, incompatible, or otherwise stale targets go to Review; the hard long-capture policy (over 2,000 characters) also remains Review even after a deterministic rule match.

Correction learning is part of correction acknowledgement, not a best-effort tail. The public correction route acknowledges an applied result only after its feedback-bound observation commits. A bounded observation timeout or KMS/database failure returns sanitized retryable `provider_unavailable`; replaying the exact correction body and idempotency key reopens the committed correction result and resumes the idempotent observation without applying note effects twice.

Implemented in E1:

- owner-authorized two-phase correction and Review resolution with request MACs, one feedback event, sorted multi-note locks, and all validation before the first write
- mutation-batch history and exact safe inverse operations; an incompatible decision-bound correction changes no note, creates a routable Review, and repoints the receipt to `needs_review`; an incompatible decision-less batch changes no note, persists acknowledgement-only Review, and returns private `409 conflict_requires_review`
- server-derived batch membership and canonical anchor through `get_encrypted_mutation_batch`; callers cannot choose or omit hidden members, non-anchor members fail closed, and batch Undo is terminal rather than an undo-of-undo source
- one feedback event that anchors both sides of a correction plus content-free feedback metrics

Implemented in E2:

- editable encrypted routing rules whose plaintext is evaluated only by web; the organizer receives only a content-free rule ID/revision/destination snapshot
- learned-rule proposals that require explicit confirmation before any prefix, phrase, alias, or destination rule is enabled
- fixed-capacity encrypted matching, safe destination routing, owner-visible web/Swift lifecycle controls, cursor pagination, replay reconciliation, and stale-revision refresh

Implemented in E3:

- separately encrypted generated-expansion proposals whose accept/reject transition never rewrites user-authored note content
- owner-and-note-scoped ascending keyset reads with 51-row lookahead/50-item pages, rejected-before-pagination filtering, exact Review hydration, and public read schemas that exclude rejected blocks
- encrypted duplicate-note suggestions with only non-destructive `Keep both` and `Dismiss` outcomes
- seven-day rejected-block hard deletion through the existing bounded encrypted-retention capability, without adding an organizer or public retention RPC
- matching web and Swift note/Review surfaces with provenance, accessible action separation, exact-request retry, and authoritative reconciliation

Remaining for E4 release:

- complete the deployed Vault/account/provider/canary/backup gates; E4's independent final audit and PR #17 required CI lanes are green, while production BYOK remains disabled and Anthropic/tier choices stay hidden until their adapter and eval gates pass (historical E4 checkpoint; superseded by ADR-0015 on 2026-09-02)

Remaining aggregate Milestone E gate:

- every AI-applied mutation in scope can be undone or restored through revision history
- stale revisions cannot overwrite manual edits
- a correction affects later matching through visible rules or tested preference features
- cross-owner, replay, stale-revision, reservation/MAC substitution, lock-order, partial-failure, private-key-denial, Vault-deletion, lease-expiry, and plaintext-canary gates pass
- the organizer has exactly eleven E4 RPCs—the ten prior capabilities plus the sole live-lease credential resolver; clients and isolated workloads cannot enumerate provider keys or Vault secrets, and Supabase's built-in `service_role` cannot reach the unexposed `vault` schema through PostgREST

**Milestone E2 credential-free gate (green locally and in PR #15 CI on 2026-09-01):** a clean reset applied through `20260901000003`, database lint reported zero schema errors, all 37 pgTAP files / 1,769 assertions passed (including the previously verified focused `090` result of 98/98), database concurrency passed, and the full built-local HTTP B–E2 suite passed. Web passed 88 files / 752 tests; organizer 18 / 299; worker 18 / 159; verifier 11 / 168; API client 4 / 30; encrypted aggregate 8 / 143; contracts 7 / 55; and AI routing 11 / 79. Xcode built the Swift app plus `QuickCaptureWidget` and passed 150/150 tests. Format was clean, all 26/26 applicable lint/typecheck/coverage tasks passed, the Production build passed 16/16 tasks, all three built-server smokes passed, boundaries and OpenAPI were current, deterministic routing passed 175/175, the production-component pipeline passed 15/15 with `liveProviderEvidence=false`, verifier capacity passed 1/1, and the 1,000-note retrieval gate recorded cold p95 398.10 ms and warm p95 13.09 ms. The production dependency audit reported no known vulnerabilities, and the final independent security/harness audit was clear. PR #15 independently passed the required KMS/workload-policy, quality/database, unsigned iOS app/widget, and aggregate CI gates. This remains credential-free evidence only: Vercel/deployment, production credential/KMS/provider, Apple signing/archive/device, Playwright, E2EE, and E3+ evidence are not claimed.

**Milestone E3 credential-free local and PR gate (green on 2026-09-01; deployed canary pending):** a clean reset applied through `20260901000004`, database lint returned zero findings, all 38 pgTAP files / 1,836 assertions passed (including focused `091` at 67/67), database concurrency passed, and the full built-local HTTP B–E3 suite passed. The E3 HTTP slice executed 36 requests and scanned 17 unique plaintext canaries without disclosure. Web passed 92 files / 787 tests; organizer 18 / 302; API client 4 / 36; encrypted aggregate 8 / 144; contracts 7 / 55; AI routing 11 / 79; and Xcode passed 165/165 Swift tests. Format was clean, all 26/26 applicable lint/typecheck/coverage tasks passed, the Production build passed 16/16 tasks, all three built-server health smokes passed, package/API/manifest boundaries were verified, and OpenAPI was current. Deterministic routing passed 175/175, the production-component pipeline passed 15/15 with `liveProviderEvidence=false`, verifier capacity passed 1/1, and the 1,000-note retrieval gate recorded cold p95 381.58 ms and warm p95 11.98 ms. The production dependency audit reported no known vulnerabilities, the independent final security/hygiene audit was clear, and PR #16's required KMS/workload-policy, quality/database, unsigned iOS app/widget, and aggregate CI checks passed. This E3 checkpoint was credential-free only: its deployed canary, all four Vercel projects, production credential/KMS/provider, Apple signing/archive/device, Playwright, and E2EE remained pending; E4 had not yet landed at that checkpoint.

**Milestone E4 credential-free local gate, independent final audit, and required CI (green on 2026-09-01; deployed gates pending):** a clean reset applied through `20260901000005`, database lint returned zero findings, all 39 pgTAP files / 1,901 assertions passed, focused `092` passed 65/65, and combined `087` + `092` passed 148/148. Service-key REST requests with both `Accept-Profile: vault` and `Content-Profile: vault` failed closed with `406 PGRST106`. The full built-local B–E4 HTTP suite passed exact replay/CAS, validator-call accounting, immutable secret-free snapshot, live-lease resolver, delete/recreate ABA, and plaintext-canary checks. Web passed 97 files / 827 tests; organizer 19 / 314; API client 4 / 38; contracts 7 / 55; encrypted aggregate 8 / 144; AI routing 11 / 79; and Xcode passed 181/181 Swift tests. Workspace lint/typecheck/coverage passed 26/26 tasks, the Production build passed 16/16, all three built-server smokes passed, focused configuration passed 35/35, boundaries and OpenAPI were current, deterministic routing passed 175/175, the production-component pipeline passed 15/15 with `liveProviderEvidence=false`, verifier capacity passed 1/1, and the 1,000-note retrieval gate recorded cold p95 392.80 ms and warm p95 12.98 ms. The production dependency audit reported no known vulnerabilities, the independent final audit is clear, and PR #17's final required CI lanes are green on run 33592465794: KMS and workload policy, Quality and database, iOS app and widget (unsigned simulator), and aggregate CI. This evidence is credential-free and local only: production BYOK remains disabled until deployed Vault/account/provider/canary/backup gates pass; no Vercel project has been provisioned or deployed; and no production credential/KMS/provider, Apple signing/archive/device, Playwright, or E2EE evidence is claimed. At this historical E4 checkpoint, Milestone F implementation and Milestone G remained pending.

### Milestone F: Hybrid search and polish, 1-2 weeks

**Implementation status (2026-09-02):** [ADR-0013](./decisions/ADR-0013-user-hybrid-search-trust-domain.md) is accepted and implemented; the credential-free local aggregate is green, the independent final audit is clear, and F merged into `main` as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d` with a successful post-merge CI run. Amended 2026-09-02: Milestone F merged as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`; Milestone G is in progress on the current branch with dual-provider BYOK ([ADR-0015](./decisions/ADR-0015-user-selectable-provider-model-effort.md)) and free-beta custody ([ADR-0016](./decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)); the five Vercel projects exist and their deployment evidence is recorded in `FINAL_REPORT.md`. In the free beta the search service computes `unfiled-local-hash-v1` in process (no provider key), so the AI-assisted scope is lexical-strength retrieval rather than semantic search.

**F implementation inventory:**

- `apps/search` is a separately deployable, request-scoped service with exact caller authentication, fixed provider/model configuration, strict request and response bounds, content-free logging, a TLS-only database adapter, decrypt-only key management, deterministic ranking, buffer release, health/build smoke, unit tests, and a 1,000-document capacity harness.
- Migration `20260901000006_user_hybrid_search_trust_domain.sql`, pgTAP `093`, shared search contracts, and the web capability adapter implement the service-role-only ticket issuer plus the `unfiled_search_worker` five-RPC claim/page/verify/complete/fail lifecycle, one-use 30-second secrets and leases, generation/filter/digest binding, and cross-role denials.
- Web implements explicit privacy scope, authenticated cursor-bound lexical/hybrid merge and dedupe, one-use search-service coordination, owner-authorized current-note hydration, lexical-only fallback, lazy encrypted source/backlink sections, structured log editing with exact idempotent retry, streaming human-readable export, and atomic account deletion.
- Migration `20260901000007_encrypted_note_context.sql`, pgTAP `094`, strict encrypted projection adapters, and note-context handlers implement owner-scoped source-capture and backlink pagination without adding either capability to search.
- Native SwiftUI implements explicit search scope, pagination, offline/failure/deleted states, owner-authorized note sources/backlinks, structured log controls, secure temporary export sharing, and destructive account deletion with local-state cleanup. Unsigned simulator validation is not Apple signing or physical-device evidence.
- `infra/aws-kms` defines the fifth exact Vercel OIDC/IAM role and decrypt-only active/registered-retired AI-assisted object-wrap policy while excluding data-key generation, content-MAC, private-manual, staged, grant, rewrap, and administration authority. Terraform shape tests are not real AWS authorization evidence.

**F credential-free local evidence (green on 2026-09-02; independent audit clear; PR pending):** the frozen-lockfile install succeeded; format, lint, typecheck, coverage, built-service smokes, boundaries, and OpenAPI passed across 27/27 applicable quality tasks. Coverage passed 221 files / 2,198 tests. The principal slices were web 108 files / 894 tests at 68.50% statements, 66.10% branches, 66.23% functions, and 71.51% lines; search 13 / 172 at 91.66% / 89.81% / 92.64% / 95.01%; organizer 19 / 314; worker 18 / 159; verifier 11 / 168; contracts 8 / 62; API client 4 / 38; content crypto 1 / 35; encrypted aggregate 8 / 144; key management 7 / 49; and AI routing 11 / 79. The Production build passed 17/17 tasks, Next produced 33 static pages, and built worker, verifier, organizer, and search health smokes passed.

A fresh database reset applied through `20260901000007`, database lint returned zero findings, and all 41 pgTAP files / 1,958 assertions passed. The concurrency gate passed seven lock-order cases, the encrypted-storage-contract contender failed closed in 2 ms, and the search-ticket race produced exactly one winner with seven denied callers. The successful 1/1 semantic trust-domain integration exercised actual web ticket issuance/coordinator logic, isolated search HTTP/auth, all five exact `unfiled_search_worker` RPCs, encrypted ranking plus owner-authorized hydration, replay denial, and provider-failure lexical fallback. The built-local B–F HTTP suite passed note link/backlink/source inspection, explicit-AI semantic fallback, streaming export, atomic deletion and unauthenticated receipt replay, and plaintext log/database regression scans; no request count is claimed.

The isolated search capacity gate processed 1,000 encrypted 1,536-dimensional documents across four keys for 20 scans: p50 277.97 ms, p95 291.24 ms, maximum 296.28 ms, recall@8 1.00, MRR@8 0.99, top-one 0.98, heap growth 49 MiB, RSS growth 73.58 MiB, and exactly four unwraps per scan. Organizer retrieval recorded cold p95 367.89 ms and warm p95 11.81 ms; verifier capacity passed 1/1. Deterministic routing passed 175/175, and the production-component pipeline passed 15/15 with `liveProviderEvidence=false`. XcodeGen generation, project inspection, dependency resolution, and unsigned simulator build passed with 203/203 Swift tests. Terraform 1.13.3 format/validate and 26/26 tests passed, and the production dependency audit found no known vulnerabilities.

**F evidence ledger:**

| Evidence lane                                                            | Current state        | Recorded result                                                                                                           |
| ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| workspace quality/coverage/build/boundaries/OpenAPI/audit                | local gate green     | 27/27 quality tasks; 221 files / 2,198 tests; build 17/17; 33 static pages; four built-service smokes; no vulnerabilities |
| database reset/lint/pgTAP/concurrency                                    | local gate green     | through `20260901000007`; zero lint; 41 files / 1,958 assertions; 7 lock cases; 2 ms contract denial; 1/7 ticket race     |
| built-local HTTP B–F                                                     | local gate green     | link/backlink/source, explicit-AI fallback, export, deletion/replay, and plaintext regression coverage                    |
| semantic trust-domain integration                                        | local gate green     | 1/1 actual web → isolated search → five RPCs → rank/hydrate; replay denial and provider-failure fallback                  |
| search correctness/security/capacity and deterministic retrieval quality | local gate green     | 1,000 × 1,536 across 4 keys/20 scans; p95 291.24 ms; recall@8 1.00; MRR@8 0.99; top-one 0.98; 4 unwraps/scan              |
| native XcodeGen/inspect/resolve/build/test                               | local gate green     | unsigned simulator build; Swift 203/203                                                                                   |
| Terraform policy                                                         | local gate green     | Terraform 1.13.3 format/validate; 26/26 tests                                                                             |
| independent final audit                                                  | clear                | no unresolved finding                                                                                                     |
| required PR checks and merge                                             | PR not yet opened    | no PR/run ID, green-PR, merge, or post-merge claim                                                                        |
| Vercel/OpenAI/AWS/KMS/CloudTrail/hosted database/canary/Apple device     | pending account work | evidence from `HUMAN_SETUP.md`; never infer from local or PR checks                                                       |

Semantic retrieval is a fifth Vercel trust domain with its own exact Trusted Sources caller, `unfiled_search_worker` TLS database login, five-RPC allowlist, Vercel OIDC/AWS role, decrypt-only access to active/retired AI-assisted index object-wrap roots, and fixed provider credential/model. It receives no owner ID and no organizer, index, verifier, note-write, repair, generation, content-MAC, private-manual, BYOK, service-role, direct-table, or arbitrary provider/endpoint authority.

For each semantic page, web authenticates the owner and creates a 30-second one-use database ticket binding the owner, versioned digest of the normalized query plus every filter/cursor field, active complete generation snapshot, and hash of a random claim secret. Web sends the ticket, raw claim secret, and exact body—but no owner ID—to search. Search recomputes the digest, atomically claims the ticket, embeds only through the fixed adapter, pages/decrypts/ranks only bound active/current AI-assisted rows, revalidates every selected result and cursor against the same generation/filters, and then completes or fails the ticket. No query/content telemetry or cross-request plaintext cache is permitted.

Semantic/provider dispatch occurs only when the privacy filter is explicitly `ai_assisted`. Default, mixed, and `private_manual` requests remain owner-authorized lexical-only, so private content and private-intent queries never reach search or its provider. Stale or incomplete generations, races, dependency failures, and ticket/cursor mismatch fail closed to a fresh lexical-only result. Source-capture inspection, note links, and backlinks remain owner-authorized web/native work and are not search-service capabilities.

Deliver:

- implement the exact ADR-0013 ticket, database, KMS, provider, caller, logging, cursor, and fail-closed boundaries in a separately deployable `apps/search` service
- user-facing hybrid search and relevance polish over the encrypted retrieval service, with semantic behavior only for explicit AI-assisted scope
- note links and source-capture inspector
- tap-to-edit numeric fields on log entries with stepper quick-entry and prior-value placeholders
- accessibility pass
- loading, empty, offline, failure, and deleted states
- performance profiling
- export and account deletion

Gate:

- critical web and native accessibility flows pass
- ticket normalization/digest parity, 30-second expiry, single-claim concurrency, replay/wrong-secret/wrong-caller denial, five-RPC ACL, no-owner request shape, and exact Trusted Sources/OIDC/KMS allow-and-deny probes pass
- search ignores stale generations; incomplete or changing generations degrade to lexical-only; default/mixed/private-manual queries and content never enter the search service or provider
- cursor integrity binds the normalized query, every filter, ranking version, and active generation, and current owner-authorized hydration rejects stale semantic references
- query/content canaries are absent from durable state, caches, Vercel/provider diagnostics, database parameters/logs, KMS/CloudTrail context, traces, analytics, errors, and health output
- export is human-readable and complete
- deletion reconciliation passes

### Milestone G: Portfolio release, 1-2 weeks

**Implementation status (2026-09-02):** in progress on the current branch. It adds [ADR-0015](./decisions/ADR-0015-user-selectable-provider-model-effort.md) dual-provider BYOK, [ADR-0016](./decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md) free-beta custody and local-hash retrieval, public trust routes, and the status/roadmap/architecture/operations set. The claim-safe view is [STATUS.md](./STATUS.md); ordered remaining work is [ROADMAP.md](./ROADMAP.md); live evidence is recorded in `FINAL_REPORT.md`. "Vercel production deployment" below means the free-beta topology (five Hobby projects, one shared Supabase project, no Preview builds), not a paid production environment.

Deliver:

- Vercel production deployment
- internal native iPhone beta builds
- seeded demo account with clearly labeled synthetic data
- architecture diagram and demo video
- privacy policy, terms, security contact, and support path
- monitoring dashboards and restore drill
- launch-name decision

Gate:

- a fresh user can complete the flagship demonstration on iPhone and inspect the same result on web
- CI, migrations, backups, alerts, and deletion flow have recorded evidence
- the README distinguishes implemented features from roadmap items

### Credible schedule

- Portfolio MVP through Milestone D: approximately 8-13 part-time weeks
- Strong personal beta through Milestone F: approximately 12-18 part-time weeks
- Release-quality web plus native iPhone beta: approximately 13-20 part-time weeks

These ranges intentionally exceed the sum of the individual milestone estimates: they include integration work between milestones, rework from gate failures, and review overhead that per-milestone numbers do not capture.

The ranges now include the iPhone Lock Screen widget. Voice, imports, Home Screen widget variants, share extensions, and store review add separate platform work.

## 22. Go or No-Go Gates

### Gate 1: Does removing the filing decision change capture behavior?

Test a clickable or working prototype with representative users. Continue only if one-field capture and visible routing receipts are materially preferred to selecting a note first.

### Gate 2: Is the manual notes product good enough?

Do not connect a real model until manual navigation, editing, revisions, and search form a credible small notes app. AI cannot compensate for a confusing library.

### Gate 3: Is automatic routing trustworthy?

Auto-apply only categories whose wrong-destination rate is low enough on held-out cases and personal beta data. Keep ambiguous categories in Review. A high overall accuracy number cannot hide a harmful auto-apply subset.

### Gate 4: Does correction improve the system?

Verify that a user correction changes later decisions in a visible and predictable way. If the app repeatedly makes the same mistake, stop expanding features and fix personalization.

### Gate 5: Is native worth maintaining?

Continue the native iPhone client only if offline capture, keyboard behavior, system integration, or widgets show real value beyond the responsive web app. Otherwise narrow the native surface while preserving the durable capture path. Any additional platform requires its own scope and maintenance decision after this milestone.

### Gate 6: Is this ready for public personal data?

Require tested RLS, deletion, export, logging redaction, provider disclosure, backup restore, and incident contact before inviting users outside a controlled beta.

## 23. Initial Engineering Backlog

Create these issues after repository bootstrap:

1. Lock the iOS URL scheme, main bundle identifier, widget bundle identifier, and App Group identifier for Development, Preview, and Release configurations.
2. Build the SwiftUI capture destination, source allowlisting, native URL handling, and the cold- and warm-start focus harness.
3. Add widget-originated draft persistence plus the GRDB/SQLCipher outbox transaction and restart recovery test.
4. Prototype circular and rectangular Lock Screen widget views in SwiftUI.
5. Implement and determinism-test `apps/ios/project.yml`, all three `.xcconfig` environments, and clean XcodeGen output.
6. Implement the extension-safe App Group snapshot, App Intent, and WidgetCenter refresh helper.
7. Define versioned IDs, errors, note types, capture states, capture sources, and organization operations.
8. Create the initial Supabase schema, grants, RLS policies, and cross-user tests.
9. Build the fake-model shopping-list vertical slice through a transactional note revision.
10. Implement the idempotent capture API and status endpoint.
11. Build native Today, Notes, Capture, Review, and Search navigation shells with Dynamic Type and accessibility identifiers.
12. Implement the Markdown editor and expected-revision save contract on the web and native clients.
13. Implement mutation receipts and safe undo.
14. Complete C.5 encrypted-library migration and build exact per-user candidate retrieval with deterministic rules, lexical/trigram features, recency, and optional encrypted embeddings.
15. Define the strict organization JSON schema and hostile-output fixtures.
16. Add the OpenAI Responses adapter behind `OrganizationModel`.
17. Build the routing evaluation runner and baseline report.
18. Add private manual notes and assert they never enter model or embedding requests.
19. Add export and deletion reconciliation.
20. Deploy preview web; generate a signed native Preview archive; inspect the embedded extension and entitlements; distribute to the TestFlight internal group.
21. Implement typed user operations — toggle, field edit, item edit and remove — through `POST /api/v1/notes/:id/operations` with the shared mutation and undo pipeline.
22. Implement the list and log Markdown projection with determinism tests and the re-parse versus structure-conflict rule.

## 24. Selected Defaults and Open Decisions

The plan proceeds with these defaults so implementation can start without waiting for more product choices:

| Decision                   | Selected default                                                                                                                                                   | Revisit trigger                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Name                       | `Unfiled` selected creative direction; clearance pending                                                                                                           | candidate passes meaning, collision, trademark, store, package, handle, and domain review            |
| Audience                   | single-user personal notes                                                                                                                                         | repeated household or collaboration demand                                                           |
| Platforms                  | responsive web plus a native SwiftUI iPhone client on iOS 17+; no second mobile platform in this milestone                                                         | post-release evidence supports a separately scoped platform                                          |
| iPhone quick capture       | Lock Screen WidgetKit extension and App Intent open a focused native composer; no inline widget text field                                                         | Apple adds supported secure text input to widgets or physical-device evidence favors another surface |
| Input                      | text first                                                                                                                                                         | routing and sync gates pass                                                                          |
| Composer after save (OQ-4) | close after local durable acknowledgement; implemented in Milestone C                                                                                              | M0 usability evidence favors rapid-entry burst mode                                                  |
| Note storage               | Markdown canonical for prose types; `structured_data` canonical for list and log with deterministic Markdown projection                                            | editor requirements exceed safe patching model                                                       |
| Interactive surfaces       | checklist toggling and log field editing in MVP; `table` type, input templates, and workout plans in v1.1                                                          | early usage shows tables or plans are the retention driver                                           |
| Undo retention             | full revision history kept; one-tap AI undo guaranteed 30 days                                                                                                     | storage metrics justify pruning                                                                      |
| Organization               | rules, retrieval, strict model plan, policy                                                                                                                        | evaluation shows a simpler path performs better                                                      |
| Automation                 | balanced mode with Review for ambiguity                                                                                                                            | beta users choose cautious or automatic behavior                                                     |
| AI provider                | OpenAI adapter implemented; provider/tier options are hidden until their adapter and full eval gate pass                                                           | privacy, cost, quality, or availability evidence                                                     |
| BYOK custody               | Supabase Vault only; lease-bound server disclosure; no application-ciphertext fallback; E4 implemented locally, production disabled pending deployed custody gates | a new accepted ADR after custody evidence—not Vault unavailability alone                             |
| Content-key custody        | per-object DEKs, per-user intermediate keys, and managed production KMS/HSM through short-lived workload identity                                                  | independent review changes the hierarchy or local-first becomes the thesis                           |
| Retrieval storage          | encrypted exact per-user index scan; no persisted plaintext FTS or vectors; user hybrid search only through ADR-0013's separately gated trust domain               | 1,000-note latency/relevance evidence or a new accepted privacy/security decision changes the design |
| Hosting                    | Vercel plus Supabase                                                                                                                                               | operational limits or cost justify migration                                                         |
| Privacy                    | cloud sync, private manual note option, no E2EE claim                                                                                                              | local-first product becomes the primary thesis                                                       |
| Collaboration              | out of scope                                                                                                                                                       | solo workflow is stable and demand is validated                                                      |

Questions to answer through prototypes and beta evidence:

- Should today's shopping list remain one note per day or roll into one open list?
- Should a medium-confidence route apply with Undo or always wait in Review?
- How much generated expansion feels helpful before it feels intrusive?
- Should the default capture close immediately or remain open for rapid consecutive entries?
- Should onboarding starter spaces be opt-in, opt-out, or created lazily on first matching capture?
- Which corrections deserve a permanent rule suggestion?
- At what library size does semantic ranking materially improve candidate recall enough to justify its provider cost?
- After the iPhone release gate is green, is there enough validated demand to plan another native client in a separate ADR?

## 25. Definition of Done for the First Public Portfolio Version

The project is ready to present when all of the following are true:

- A user can capture offline on iPhone and close the app without losing the thought.
- A user can tap the iPhone Lock Screen widget, authenticate if required, type into an already-focused composer, and receive a local durable acknowledgement without choosing a destination.
- The capture syncs once and produces a visible organization receipt.
- Shopping, workout, principle, project, and generic examples route through the same system.
- A second message can update the intended living note.
- The original capture remains inspectable.
- A shopping item can be checked off on one device and observed on the other, and a workout number can be corrected with a tap.
- Wrong routes can be moved and undone.
- Manual navigation and editing are obvious on iPhone and web.
- A manual edit cannot be overwritten by a stale AI job.
- Search finds content by exact words, approximate words, date, space, and meaning.
- Private manual notes never enter model requests or embeddings.
- Durable note, history, workflow, review, and retrieval content is application-encrypted; production keys are KMS-backed and product copy makes no E2EE claim.
- Candidate retrieval is owner-isolated, revision-fresh, and fails safe when its encrypted index is incomplete.
- RLS, idempotency, crash recovery, deletion, and export have automated evidence.
- Web is deployed to Vercel and the native iPhone application has an installable, signed beta build.
- The product explains its AI and privacy behavior plainly.
- The repository documents architecture, tradeoffs, test results, current limitations, and next steps.

## 26. Current Primary Risks

### Trust risk

One wrong append can make the user distrust all future automatic changes. Mitigate with conservative auto-apply bands, receipts, undo, revision history, and strong routing evaluation.

### Product sprawl

Notes products attract tasks, calendars, reminders, graphs, publishing, collaboration, and research features. Protect the create-or-append capture loop until it is excellent.

### Multi-client editor complexity

A sophisticated block editor can consume the project. Start with canonical Markdown, platform-native editing behavior, and a constrained feature set.

### Sync and duplicate risk

Offline retry can duplicate captures or list items. Client IDs, idempotent APIs, transactional mutation IDs, and restart tests are mandatory.

### AI cost and latency

Calling a large model for every fragment will feel slow and expensive. Deterministic rules, bounded candidates, measured model selection, and Inbox fallback control the cost.

### Privacy mismatch

Personal notes are sensitive. A dark theme and reassuring copy do not create privacy. Claims must match the actual Vercel, Supabase, and model-provider data path.

### Naming risk

The notes category is crowded and the launch name is unresolved. Do not invest in final logo, domain, store assets, bundle identifiers, URL schemes, or legal copy before formal screening. Once selected, record the name and immutable native identifiers in an ADR before generating Apple credentials.

## 27. Research and Documentation Anchors

Product landscape reviewed while creating this plan:

- [Mem](https://mem.ai/)
- [Tana](https://outliner.tana.inc/)
- [Capacities mobile documentation](https://docs.capacities.io/reference/mobile)
- [Capacities daily notes](https://docs.capacities.io/reference/use-cases/daily-notes)
- [Reflect](https://reflect.app/home)
- [Rill](https://rill.md/)

Current implementation guidance to recheck at bootstrap and major upgrades:

- [Apple: SwiftUI](https://developer.apple.com/documentation/swiftui)
- [Apple: App Intents](https://developer.apple.com/documentation/appintents)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)
- [SQLCipher GRDB](https://github.com/sqlcipher/GRDB.swift)
- [Apple: Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple: Creating a widget extension](https://developer.apple.com/documentation/WidgetKit/Creating-a-Widget-Extension)
- [Apple: Linking to app scenes from a widget](https://developer.apple.com/documentation/widgetkit/linking-to-specific-app-scenes-from-your-widget-or-live-activity)
- [Apple: Widget interactivity](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)
- [Apple: Widget design guidance](https://developer.apple.com/design/human-interface-guidelines/widgets)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns)
- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Vercel durable workflow overview](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
- [Vercel Functions limits](https://vercel.com/docs/functions/limitations)
- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

## Final Recommendation

Build the product as a **capture router with a trustworthy notes product underneath it**.

The portfolio story is strongest when the demo shows more than a model classification call: offline capture, idempotent sync, hybrid retrieval, strict structured output, transactional revisions, conflict handling, reversible mutations, personal routing rules, search, privacy boundaries, native and web clients, and a durable hosted workflow.

Begin with the design sprint in Section 15.1 and Milestone 0. Once the core interaction has passed the design gate, the first implementation should not begin with voice, a graph, a rich block editor, or a landing page. Begin with one fake-model vertical slice:

```text
"shopping: milk and batteries"
  -> durable capture
  -> deterministic organization plan
  -> Shopping / today
  -> two unchecked items
  -> receipt
  -> undo
```

Make that flow survive duplicates, refreshes, offline restart, stale revisions, and failures. Then replace the fake planner with the evaluated structured-output model adapter. That order turns the idea into a reliable product instead of a compelling demo that loses notes.
