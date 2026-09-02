# Unfiled

Unfiled is a capture-first notes product: write before deciding where a thought belongs, then inspect, correct, or undo the organization result.

The canonical phone client is the native Apple app in [`apps/ios`](./apps/ios). It targets iOS 17 and newer and uses SwiftUI, a WidgetKit Lock Screen extension driven by App Intents, and an Xcode project generated from [`apps/ios/project.yml`](./apps/ios/project.yml) with XcodeGen. Its local capture outbox and note cache use GRDB's SQLCipher build, complete file protection, and a device-generated database key that Keychain releases only while the device is unlocked. The web client and iOS app share the same authenticated backend contracts. [ADR-0010](./docs/decisions/ADR-0010-native-ios-client-replacement.md) records the replacement. Android is intentionally outside this milestone; there is no supported Android client in the current product surface.

## Current state

Milestone F merged into `main` as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`. Milestone G, the portfolio release, is in progress on the `milestone-g-portfolio-release` branch. The claim-safe status is in [docs/STATUS.md](./docs/STATUS.md); live deployment, migration, and account evidence is recorded in `FINAL_REPORT.md`, not inferred from this README.

The release target is a **free private beta**:

- **Bring your own key, two providers.** A user saves an OpenAI key, a Claude (Anthropic) key, or both in Supabase Vault and chooses Provider, Model (Automatic or one exact `organization-model-registry-v2` model: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `claude-sonnet-5`, `claude-opus-5`), and Effort (Efficient, Balanced, Thorough). The exact provider, model, and effort are snapshotted immutably on each job; keys are never in jobs. The beta funds no app-default provider key, so a capture without a usable key fails closed to Inbox and the UI asks for a key ([ADR-0015](./docs/decisions/ADR-0015-user-selectable-provider-model-effort.md)).
- **Free-beta key custody.** Four independent AES-256 root families live only in Vercel Sensitive Environment Variables, bound to the exact project and the `production` environment; each isolated service receives only its subset. AWS KMS/Terraform is preserved as deferred paid hardening and is not required ([ADR-0016](./docs/decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)).
- **Provider-free retrieval.** The encrypted index uses `unfiled-local-hash-v1` (512 dimensions), a deterministic feature-hash vector computed in process. No note or query text is sent to a provider merely for retrieval. It is a lexical retrieval signal, not an AI semantic embedding, and its relevance is weaker than a semantic embedding; AI-assisted search must not be described as semantic search.
- **One shared database, one deployed environment.** One free remote Supabase project is the Production database; local Supabase is Development. Vercel Preview deployments are intentionally not built.

The encrypted server path is split across five trust domains: `apps/web` owns authenticated lifecycle orchestration and final owner-authorized hydration, `apps/organizer` owns the lease-linearized encrypted create-or-append transaction and the dual-provider planner, `apps/worker` decrypts AI-assisted note aggregates to build encrypted index documents, `apps/verifier` independently decrypts and validates one shadow generation before activation, and `apps/search` serves explicit AI-assisted queries through one-use database capabilities without receiving an owner ID. The organizer has an exact eleven-RPC database capability, the worker six, the verifier two, and `unfiled_search_worker` five. The five Vercel projects (`unfiled-web`, `unfiled-organizer`, `unfiled-worker`, `unfiled-verifier`, `unfiled-search`) exist in team `zach-2267`; their deployment evidence is recorded in `FINAL_REPORT.md`.

Checked-in evaluation tooling includes the deterministic mock routing gate, a deterministic production-component seam with an explicit scope report, and two optional explicit-key live runners (`pnpm eval:routing:live` for OpenAI and `pnpm eval:routing:live:anthropic` for Claude) with exactly three samples per eligible synthetic case and content-free telemetry. No credentialed live run has been executed yet.

The repository still requires Apple signing, archive inspection, TestFlight, physical-iPhone evidence, name/legal/mailbox clearance, provider-key entry through the product UI, live provider canaries, and the Vercel Deployment Protection change described in [HUMAN_SETUP.md](./HUMAN_SETUP.md) before a production release claim. Unsigned simulator builds verify compilation and tests, but do not establish provisioning, App Group behavior, Keychain/SQLCipher behavior on hardware, extension packaging, or App Store readiness. Paid point-in-time recovery and the irreversible storage contraction remain deferred. The product must not be described as end-to-end encrypted or zero knowledge.

## Native iOS quick start

Install full Xcode and the repository-pinned XcodeGen 2.46.0 release, then run these commands from the repository root. The exact generator version is required because later XcodeGen releases may produce a different checked-in project order:

```bash
pnpm ios:generate
pnpm ios:resolve
pnpm ios:build
pnpm ios:test
```

`pnpm ios:ci` runs those phases in order. The test script selects an available iPhone Simulator; set `UNFILED_IOS_TEST_DESTINATION` when a specific runtime/device is required.

The generated project exposes `Unfiled Development`, `Unfiled Preview`, and `Unfiled` schemes. Development points at `http://127.0.0.1:3000/api/v1`; Preview and Production origins are defined with the same required `/api/v1` path in the corresponding files under [`apps/ios/Config`](./apps/ios/Config). The managed-fallback capability is a build-configuration flag that is off in every configuration for the free beta.

Start with the [documentation index](./docs/README.md), the [status page](./docs/STATUS.md), the [architecture overview](./docs/ARCHITECTURE.md), the [full build plan](./docs/BUILD_PLAN.md), or the [human-owned release gates](./HUMAN_SETUP.md).

## Working product sentence

> Just write. It finds its place.

The product and repository are named Unfiled. Trademark, App Store, package-name, social-handle, and domain clearance remain required before public launch.
