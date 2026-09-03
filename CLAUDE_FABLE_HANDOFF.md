# Claude Fable continuation prompt for Unfiled

Copy everything below the divider into a new Claude Fable task. It is intentionally self-contained and contains no secret values.

---

You are taking over an active production implementation, not starting a new project and not writing another plan. Continue from the existing dirty worktree until every safely achievable remaining requirement is implemented, tested, deployed, verified, committed, reviewed through a green PR, merged, and documented. Do not stop after an audit or a partial milestone while a safe in-scope next action remains.

## Objective

Finish **Unfiled** end to end through Milestone G. Deliver the native Swift iPhone app and Lock Screen capture widget, the dark web app and public website, the shared backend, encrypted note storage, per-user RAG/search, OpenAI and Claude bring-your-own-key support, production deployment, release evidence, and `FINAL_REPORT.md`. Push the existing branch, open a PR, wait for every required check, fix failures, merge only when green, then verify the merge and production deployment.

The product is named **Unfiled**. Never rename it to Soft Index. It is a native Swift/SwiftUI/WidgetKit iOS project, not Expo and not React Native.

The product promise is capture first: a person can type an untitled jot and Unfiled decides whether to create or update a note, folder/category, shopping list, workout log, mindset idea, or another structured destination. Manual navigation, editing, Review/correction, and Undo must remain clear and fully usable. The RAG/index layer must help find the correct existing note or decide to create a new one, without leaking note text to an unrelated provider or tenant.

## Workspace and source-control state

- Canonical worktree: `/Users/zacharymartin/Desktop/portfolio_projects/project ideas/unfiled-g-portfolio-release`
- Current branch: `milestone-g-portfolio-release`
- Current base/HEAD before the uncommitted Milestone G work: `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`
- Git remote: `https://github.com/Zachshotamartin/unfiled.git`
- GitHub account: `Zachshotamartin`
- `main` is the protected default branch. PRs and required green CI are mandatory. Do not push directly to `main`, weaken protection, skip checks, force-push, or merge red.
- The repository is public by the user's choice. Never commit secrets, local `.env` files, Vercel link metadata, provider keys, database passwords, OIDC tokens, or decrypted user content.
- The worktree currently has about 193 modified/untracked paths. They are intentional shared Milestone G changes. Preserve them. Do not reset, checkout, clean, stash, or discard them wholesale. Start with `git status --short`, `git diff --check`, and focused diffs. Reconcile partial edits in place.
- `CLAUDE_FABLE_HANDOFF.md` itself is a local operator handoff artifact created for this transition. Read it, but keep it out of the product PR unless the user explicitly asks to retain it in the repository.
- All previous parallel agents have been stopped. There should be no live concurrent writer now.
- `git diff --check` was clean at handoff.
- Vercel CLI was upgraded to `59.11.2` at handoff.
- Disk space was low. About 6.1 GiB was available after deleting only reproducible `.next`, `node_modules`, and Unfiled DerivedData caches from old completed milestone worktrees. Source was not deleted. Check `df -h` before large builds and remove only clearly reproducible build caches if necessary.

Read these before changing behavior:

1. `docs/BUILD_PLAN.md`
2. `docs/ROADMAP.md`
3. `docs/STATUS.md`
4. `HUMAN_SETUP.md`
5. `docs/ARCHITECTURE.md`
6. every `docs/decisions/ADR-*.md`, especially ADR-0006 through ADR-0015
7. `SECURITY.md`, `SUPPORT.md`, and `docs/evidence/README.md`
8. the original implementation brief at `/Users/zacharymartin/.codex/attachments/aff4e18e-3a50-49c1-8f29-4978f7a3fb30/pasted-text.txt`

Treat old status prose as historical evidence, not truth about the current dirty branch. Update it as facts change.

## User authorization and interaction rule

The user has authorized all ordinary in-scope app, GitHub, Supabase, Vercel, browser, and deployment steps. Take them yourself when tools permit. Do not repeatedly ask for generic permission.

Never ask the user to paste an OpenAI key, Claude key, database password, service-role key, OIDC token, or any other secret into chat. Provider keys must be entered through Unfiled's own settings UI and stored only through the reviewed Vault path. If a one-time code is required, ask only for the code at the moment it is genuinely unavoidable. Keep the user informed with concise progress updates during long work.

The genuinely human-only gates are likely:

- entering an OpenAI or Claude API key into the deployed Unfiled UI for a real live-provider canary;
- entering an email OTP if no safe administrative test-user path can avoid it;
- signing into an Apple Developer account, creating/choosing the final App ID/team/certificates, connecting a physical iPhone, and approving TestFlight/App Store steps;
- final legal/trademark/domain/support-mailbox decisions.

Implement and verify everything else. If a human-only gate remains, leave the product in a safe working beta state, record exactly what is blocked, and give one precise action rather than a vague setup list. Do not fabricate evidence.

## Latest product requirement: provider, model, effort, and related controls

This is mandatory on both web and iOS. Users must be able to save both OpenAI and Claude credentials independently and choose:

1. Provider: OpenAI or Claude.
2. Model: Automatic or one exact compatible model.
3. Effort: Efficient, Balanced, or Thorough. Stable wire values are `economical`, `standard`, and `thorough`.
4. Organization behavior: Cautious, Balanced, or Automatic.
5. Generated expansion: Off, Brief, or Detailed.
6. Managed fallback only when the deployment really provides an app-funded credential; it is off by default and the free beta must not promise app-funded inference.

Canonical registry v2:

| Provider         | Exact selectable models                        |
| ---------------- | ---------------------------------------------- |
| OpenAI           | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` |
| Anthropic/Claude | `claude-sonnet-5`, `claude-opus-5`             |

Automatic mapping:

| Provider  | Efficient         | Balanced          | Thorough        |
| --------- | ----------------- | ----------------- | --------------- |
| OpenAI    | `gpt-5.6-luna`    | `gpt-5.6-terra`   | `gpt-5.6-sol`   |
| Anthropic | `claude-sonnet-5` | `claude-sonnet-5` | `claude-opus-5` |

Map effort to provider-native `low`, `medium`, and `high`. Do not expose arbitrary model strings, arbitrary prompts, temperature, top-p, or undocumented knobs. Reject cross-provider model choices. Switching provider resets an incompatible model to Automatic but does not delete either saved key.

Resolve Automatic when a capture job is created. Snapshot the exact resolved provider, exact model ID, effort, expansion style, settings revision, and registry version immutably onto the job. Never put a key, Vault locator, bearer header, or plaintext note in a job. A lease resolves only the matching live provider credential immediately before a request.

Official references already checked on 2026-09-02:

- OpenAI: `https://developers.openai.com/api/docs/models` and `https://developers.openai.com/api/docs/guides/latest-model`
- Claude: `https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions` and `https://platform.claude.com/docs/en/build-with-claude/effort`

Recheck official primary docs if an API request shape is uncertain.

## Design direction

Preserve the established Unfiled visual system. It is a dark-first, calm, trust-forward consumer productivity product with warm near-black surfaces, off-white type, a coral accent, restrained mono metadata, generous hierarchy, and native-feeling controls. Avoid generic dashboard/card soup.

For settings in particular:

- use a clear Provider -> Model -> Effort hierarchy;
- put labels above fields, help text and errors below, and actions in their own layout region;
- never visually attach a button to a text input by accident;
- keep primary and destructive actions distinct;
- include loading, empty, success, invalid-key, stale-revision, ambiguous-retry, replacement, and deletion states;
- meet WCAG contrast, keyboard/focus, VoiceOver, Dynamic Type, 44-point touch target, reduced-motion, and narrow-screen requirements;
- retain the existing coral accent and do not introduce gradients or gratuitous animation.

The sign-in screenshot issue was specifically that the submit button looked fused to the email input. Preserve/fix explicit vertical separation and grouping anywhere that pattern occurs, including the new API-key forms.

## What was complete before this handoff

Milestones A through F were merged previously. PR #18 merged Milestone F into `main` at commit `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`; push workflow run `33612621827` was green. Existing functionality includes capture, notes/taxonomy, receipts, manual editing, Review, correction, Undo, encrypted aggregates, routing rules, generated blocks, duplicate suggestions, hybrid search, note context/backlinks, structured-log editing, export, account deletion, native SwiftUI screens, and a WidgetKit Lock Screen capture flow.

Milestone G branch work already includes substantial, uncommitted implementation for:

- privacy, terms, security, support, account-deletion, `security.txt`, robots, sitemap, public footer/header, and public-information tests;
- repository `SECURITY.md`, `SUPPORT.md`, issue template, architecture, roadmap, status, demo/evidence/runbook material, release probe, demo seed, and operations scripts;
- iOS privacy manifest, release evidence script, project settings, and Xcode workflow hardening;
- five Vercel manifests with `sfo1` region and production-shaped health/provenance handling;
- a provider-neutral V2 managed-key record and a Vercel Sensitive Environment Variables AES-256-GCM custodian/transport;
- local provider-independent hashed retrieval embeddings;
- the dual-provider/model/effort work described below.

Known already-green focused evidence from this dirty branch:

- key-management package: 126 tests, about 96.06% statements and 93.03% branches, plus lint/typecheck/build;
- managed-key V2 migration lane before the newest migration: clean local reset and full pgTAP, 42 files and 1,981 assertions;
- web custody/public work: six focused suites/66 tests, then full web 115 files/941 tests, lint, typecheck, production build, and diff check;
- local hash search package: 34 tests plus lint/typecheck;
- final targeted configuration suites after service custody edits: worker 17, organizer 39, search 28, verifier 44; all four service typechecks green;
- earlier full suites before the last small config cases: worker 18 files/168 tests, organizer 19/323, search 13/182, verifier 11/176.

These are checkpoint facts, not substitutes for a fresh final run.

## Exact partial-work handoff

### 1. Vercel-sensitive key custody and local retrieval

Core package and web integration are implemented. In organizer, worker, search, and verifier the stopped agent completed:

- strict `UNFILED_KEY_CUSTODIAN=aws-kms|vercel-sensitive-env-v1` selection;
- provider-specific V1/V2 record parsing;
- exact Vercel project/environment/root allowlists;
- rejection of AWS/static/local ambiguity in sensitive-env mode;
- preserved AWS path for future paid hardening;
- organizer/worker generate+decrypt and search/verifier decrypt-only authority;
- explicit `local-hash-v1` embedding mode in worker/search/organizer, with no OpenAI embedding request or key in that mode;
- generation model/dimension fail-closed behavior;
- matching `.env.example` changes.

Pending in this lane:

- rerun all four full test suites after the last config-only tests;
- run lint, builds, coverage, and built-server tests;
- add accurate README prose for Vercel-sensitive custody and local-hash mode;
- add service-runtime branch tests for the sensitive custodian if coverage shows a gap;
- seed the active search/index generation as `unfiled-local-hash-v1` with 512 dimensions;
- configure production values and deploy.

The local hash embedding is an honest deterministic feature-hash retrieval vector, not an AI semantic embedding. It is provider-neutral, normalized float32, 512 dimensions, and prevents note/query text from being sent to OpenAI merely for retrieval. Document its relevance limitations accurately.

### 2. Web, contracts, API client, and iOS AI settings

The stopped agent implemented unstaged/shared changes in:

- `packages/contracts/src/settings.ts`
- `packages/contracts/src/openapi.ts`
- `packages/api-client/src/index.ts`
- web settings repository/RPC/handlers, provider-key validation, view model, component, CSS, and associated call sites;
- iOS `SettingsModels.swift`, `APIClient+Settings.swift`, `AppModel.swift`, `AppShellView.swift`, and `SettingsView.swift`.

Implemented behavior includes the dual-provider catalog, provider-addressed key GET/PUT/DELETE, model setting, OpenAI model validation, Anthropic Models API validation using `x-api-key` plus `anthropic-version`, separate key tabs, provider/model/effort controls, and separate mobile action layout.

Already green:

- `pnpm --filter @unfiled/contracts typecheck`
- `pnpm --filter @unfiled/api-client typecheck`
- `pnpm --filter @unfiled/web typecheck`

This lane is **not finished**. The iOS integration is mid-flight even if files parse. Pending:

- update `packages/contracts/test/milestone-e-contracts.test.ts`, which still expects Anthropic rejection and omits the model field;
- update API-client behavior tests for provider-addressed metadata and provider-bound responses;
- update web handler/repository tests that still expect a provider query to be rejected;
- add thorough Claude validator tests, including timeout, malformed response, wrong provider, invalid key, status mapping, response-body cap, and no-secret logging;
- update all settings fixtures/JSON for required `modelSelection`;
- update iOS `AISettingsTests.swift` and `SettingsContractTests.swift` for dual keys, new method signatures, model selection, stale retry, deletion, and incompatible choices;
- finish Swift compile integration and accessibility checks;
- regenerate `packages/contracts/openapi/openapi.v1.json` with `pnpm generate:openapi` and verify with `pnpm check:openapi`;
- run lint, all relevant tests, web production build, and iOS build/tests.

### 3. Database migration for dual provider/model selection

New coherent files:

- `supabase/migrations/20260902000001_dual_provider_model_selection.sql`
- `supabase/tests/096_dual_provider_model_selection.test.sql`

The migration implements:

- exact provider/model catalog and deterministic Automatic mappings;
- provider/model constraints and profile invariants;
- settings projection, compare-and-swap revision handling, idempotency, and provider-switch model reset;
- provider-neutral Vault get/put/delete with independent OpenAI/Anthropic revisions;
- immutable model preference, resolved ID, effort, and registry-v2 job snapshots;
- a pre-insert profile lock and model resolution;
- composite job/snapshot consistency constraints;
- provider-neutral lease resolution, invalidation, and fallback;
- claim and credential responses bound to provider/model/effort/registry.

The migration applied manually once before its final small provider-switch-reset clause was added. That is not final evidence. Pending:

- clean local `supabase db reset` with the final file;
- run new test 096 and the complete pgTAP suite;
- run database lint and concurrency tests;
- update `supabase/tests/087_milestone_e0_interaction_contracts.test.sql` from registry v1 expectations to v2 where appropriate;
- update `supabase/tests/092_vault_byok_and_ai_settings.test.sql`: four assertions currently expect Anthropic to be unsupported; replace them with cross-provider and unknown-provider coverage, and update exact claim output assertions with `selectedProvider`, `modelSelection`, resolved model, and registry fields;
- inspect every changed RPC signature against TypeScript and organizer parsers before pushing remotely.

### 4. Organizer provider adapter is the largest missing implementation

The organizer is still OpenAI-only and its managed composition still requires `UNFILED_ORGANIZER_OPENAI_API_KEY`. It also currently requires an app-default key before constructing credential access, which incorrectly blocks a BYOK-only free deployment.

Implement all of the following atomically:

- make BYOK-only production composition valid with no operator-funded provider key;
- keep app-default optional and fail closed only for jobs that actually require an unavailable managed credential;
- consume the exact new database claim fields: selected provider, model preference, resolved model ID, effort, settings revision, and adapter registry version;
- update exact parsers/tests so schema drift is rejected rather than silently ignored;
- make the OpenAI planner use the immutable job model ID instead of the old hardcoded model;
- map effort to the OpenAI Responses API reasoning setting `low|medium|high`;
- add a strict Anthropic Messages API planner for `POST https://api.anthropic.com/v1/messages` with `x-api-key`, the reviewed `anthropic-version`, bounded timeouts/body limits, and provider-safe errors;
- use a forced organization tool/schema and accept exactly one matching `tool_use` result;
- reject plain text, zero/multiple/wrong tool calls, malformed JSON/schema, unknown candidate IDs, ownership/revision mismatches, disallowed operations, oversized results, and provider-injected content;
- preserve ephemeral candidate IDs and final owner/revision authorization;
- never send a Claude key to OpenAI, an OpenAI key to Anthropic, or either key into local retrieval;
- never log, persist, return, or snapshot a key or provider response body containing note text;
- implement equivalent OpenAI and Claude unit/contract/error/replay tests and provider-specific evaluation fixtures;
- keep deterministic mock routing and pipeline evals green, and add a live Claude runner only if it can emit content-free telemetry and remain optional.

Do not weaken the provider boundary merely to get a test green.

## Cloud/account state already established

### GitHub

- CLI is authenticated as `Zachshotamartin`.
- Repo is `Zachshotamartin/unfiled`, public by explicit user choice.
- `main` is default/protected.
- There was no open PR at handoff.
- GitHub private vulnerability reporting was enabled and API-verified.

### Supabase

- Project ref: `vfcssfoimrlnlcdfezhm`
- Project name: `Unfiled Preview`
- Region: `us-west-2`
- Plan: free private beta
- CLI is linked and authenticated.
- Remote migrations are applied through `20260901000007`.
- Local `20260902000000_managed_key_v2_environment_custody.sql` and `20260902000001_dual_provider_model_selection.sql` are not yet remote.
- A recent remote catalog/table estimate found zero rows in every application/public product table. Reconfirm immediately before migrations or any irreversible operation.
- Supabase Auth Site URL is `https://unfiled-web.vercel.app`.
- Allowed redirect URL is `https://unfiled-web.vercel.app/**`.
- The free beta deliberately uses one remote Supabase project for Production. Preview should not be given a competing environment-bound key custodian against that same live database.
- Dedicated database roles already exist and were previously tested with `verify-full` expectations:
  - `unfiled_index_worker`
  - `unfiled_rag_verifier`
  - `unfiled_organizer_worker`
  - `unfiled_search_worker`
- Role passwords are in macOS Keychain service `unfiled-beta-database-role-password`, using the role name as the account.
- The administrator database password is in Keychain service `unfiled-supabase-db-password`, account `unfiled-preview`.
- Retrieve Supabase API keys through the authenticated CLI/API without printing them. A known command is `supabase projects api-keys --project-ref vfcssfoimrlnlcdfezhm --reveal --output json`; pipe selected values directly into configuration and never echo the JSON.
- Use the shared transaction pooler for Vercel serverless workloads: host `aws-0-us-west-2.pooler.supabase.com`, port `6543`, database `postgres`, username `<role>.vfcssfoimrlnlcdfezhm`, prepared statements disabled, and certificate/hostname verification equivalent to `sslmode=verify-full`.
- Download the current canonical Supabase CA from the project dashboard/official endpoint and pass it as base64 to each workload's exact CA variable. Do not guess or disable verification.

### Vercel

All five projects exist, are linked locally, use Node 22, have automatic system variables enabled, use the same GitHub repo and `main`, and have OIDC Team Issuer enabled. Their Production environment variable lists were empty at the last check, and no successful production deployment has been proved yet.

| App       | Project             | Project ID                         | Expected production alias              |
| --------- | ------------------- | ---------------------------------- | -------------------------------------- |
| Web       | `unfiled-web`       | `prj_cj3dxdYhekAe1kNNELAf5wQQi6El` | `https://unfiled-web.vercel.app`       |
| Organizer | `unfiled-organizer` | `prj_EPvZ8mQw9J6iVTOg3VrngcLMv6p1` | `https://unfiled-organizer.vercel.app` |
| Worker    | `unfiled-worker`    | `prj_UB5jL9qhnGorUW7POtM2SC7lEa95` | `https://unfiled-worker.vercel.app`    |
| Verifier  | `unfiled-verifier`  | `prj_SqWb52Cpc70p12sV5flNGeK7h0EQ` | `https://unfiled-verifier.vercel.app`  |
| Search    | `unfiled-search`    | `prj_DVDQCen0mZlYsoTkCwvhrEl95v0b` | `https://unfiled-search.vercel.app`    |

Vercel owner/team:

- scope/team slug: `zach-2267`
- owner ID: `team_aGAHqPlsj6W4hT4CL8U4IOt9`
- exact Production OIDC subject form: `owner:zach-2267:project:<project-name>:environment:production`
- exact trusted caller is the web project above.

Each app directory has ignored `.vercel` and `.env.local` material from linking/OIDC. Never print or commit it. Use `vercel env` from the linked app directory, and use **Production-only Sensitive** values for the free beta. Do not deploy Preview against the same database with a competing custodian.

Every `vercel.json` has been changed to use region `sfo1`, near Supabase `us-west-2`.

Vercel Hobby cannot provide all paid deployment protection/PITR assurances. The production aliases can remain public, while workload endpoints must enforce the checked-in app-level OIDC identity verifier. Standard preview protection is configured where available. Do not claim paid protection.

### AWS

Do not apply the AWS Terraform/KMS stack. The user explicitly chose the $0 free-beta path. AWS work is deferred hardening, not a deployment blocker for this beta after the Vercel-sensitive custodian is verified. Preserve the Terraform code for later and update docs that still incorrectly say AWS is mandatory now.

## Encryption and custody requirements

Notes, captures, taxonomy, routing rules, generated content, interactions, and index text must not be stored as durable plaintext. The current product architecture is application encryption at rest with scoped server-side decryption, not end-to-end encryption and not zero knowledge. Never claim otherwise.

The free beta uses four independent AES-256 root families:

1. AI-assisted object wrap
2. AI-assisted content MAC
3. private-manual object wrap
4. private-manual content MAC

Generate four independent 32-byte base64url materials and four unique root IDs. Do not print them. Store/retrieve them through a safe local secret mechanism such as Keychain and pipe them directly into Vercel Sensitive environment variables. Bind every key-ring JSON document to its exact Vercel project ID and `production` environment. The metadata registry contains IDs/status only; the sensitive ring contains only the subset that workload is authorized to receive:

- web: all four roots;
- organizer: AI object-wrap and AI content-MAC;
- worker: AI object-wrap only;
- verifier: AI object-wrap only;
- search: AI object-wrap only.

Canonical production settings include:

- `UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1`
- web `UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON`
- sensitive `UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1`
- each workload's exact active-root-ID and retired-root-ID variables from its parser/example.

Never colocate AWS variables, static AWS credentials, legacy local key variables, public key variables, service-role keys, generic database variables, or provider keys where the config explicitly rejects them. Derive the final complete environment matrix from the current config parsers and `.env.example` files after integration; do not rely on stale prose or guess variable names. Add tests for every actual Production configuration before setting it.

User provider keys belong only in Supabase Vault through owner-authorized RPCs. Both keys may coexist. No provider key belongs in a job, browser storage, iOS plist, source control, Vercel client variable, logs, or error text.

Migration 27 installed a one-way encrypted-storage contraction function, but Production is still `expand_compatible`; old plaintext columns/indexes exist even though safe adapters write ciphertext plus fixed non-content sentinels. `HUMAN_SETUP.md` currently requires PITR plus an isolated restore before irreversible contraction, which the free plan does not supply. Do not pretend that gate passed. Because the remote application tables were empty, you may evaluate and document a narrowly reviewed empty-store/bootstrap exception, but only after reconfirming zero users/objects, running the entire final schema/test suite, proving signup works in `contracted`, and preserving rollback by reproducibly rebuilding the empty project. Otherwise leave the contract un-applied, keep all live writes encrypted/fail-closed, and state the exact limitation. Never delete real user data or weaken readiness checks just to claim completion.

## Ordered execution plan

Use parallel agents/worktrees if your environment supports them, but give each lane exclusive files and integrate through the canonical worktree. A good split is:

- Lane A: TypeScript contracts/API/web settings tests and OpenAPI generation.
- Lane B: Swift settings integration, widget/app builds, unit tests, simulator/UI accessibility review.
- Lane C: database clean reset, tests 087/092/096, pgTAP, migration/RPC review.
- Coordinator: organizer OpenAI+Claude adapter, full integration, cloud env/deploy, docs, PR, final report.

Recommended order:

1. Stabilize the dirty tree. Inspect all partial diffs and finish compile/test fixture integration. Do not commit broken intermediates.
2. Complete the TypeScript/web/iOS settings lane and regenerate OpenAPI.
3. Complete the database migration/test lane on a clean local reset.
4. Implement and test the organizer provider multiplexer, exact model/effort handling, and BYOK-only production composition.
5. Reconcile every contract at the boundaries: web <-> database, web <-> iOS, web -> workloads, organizer <-> database, key records <-> every runtime, and embedding model/dimensions <-> active generation.
6. Run formatting and focused suites, then the complete local gate. At minimum run:

   ```bash
   pnpm format
   pnpm check
   pnpm build
   pnpm db:reset
   pnpm test:db
   pnpm test:db:concurrency
   pnpm test:http:e2e
   pnpm test:search-trust-domain
   pnpm test:retrieval-capacity
   pnpm test:search-capacity
   pnpm ios:ci
   ```

   Also run Terraform validation/tests for preservation even though AWS is not applied, secret scanning, dependency/security audit, `git diff --check`, and any release/demo probes. Do not reduce coverage thresholds or delete tests to get green.

7. Visually inspect web at desktop and narrow mobile widths, plus the booted iPhone Simulator. Verify the sign-in input/button separation and the complete dual-provider settings states. Capture content-free screenshots/evidence if the repository's evidence policy permits them.
8. Update `HUMAN_SETUP.md`, `docs/STATUS.md`, `docs/ROADMAP.md`, architecture/ADR/readmes/runbooks, and privacy/security wording to match the actual free-beta design. Remove stale claims that the Vercel projects do not exist or that AWS is mandatory. Preserve truthful limitations: shared single Supabase beta, no paid PITR, no environment isolation, local-hash retrieval limitations, no E2EE/zero-knowledge claim, and no signed-device proof until it exists.
9. Reconfirm remote database emptiness and migration drift. Apply only reviewed final migrations 00000 and 00001 with the linked CLI. Capture content-free migration evidence. Never run a remote migration before the clean local reset and complete DB tests are green.
10. Build a tested exact Production environment matrix from the parsers. Configure all five linked Vercel projects with Production-only variables, using Sensitive values for every secret. Pipe credentials from Supabase CLI/Keychain/generators without printing them. Configure local-hash retrieval as `unfiled-local-hash-v1` with 512 dimensions. Do not add an operator OpenAI key merely to satisfy old organizer code; fix BYOK-only composition.
11. Deploy isolated workloads and inspect their authenticated management-plane project/deployment/alias mapping. Then configure/prove the exact web origins and OIDC caller/target fields. Deploy web. Verify every `/health` response is `no-store` and exact-matches environment, full commit SHA, and SHA-256 deployment provenance through the release probe.
12. Run live synthetic beta verification: signup/login/session/signout, encrypted note capture, deterministic organization, create-or-append, manual edit/history/Undo, Review/correction, taxonomy, local-hash indexing/search/context/backlinks, export, retention dry run, account deletion, malformed/unauthorized cross-tenant requests, outage/fail-closed behavior, and ciphertext/log canaries. Do not put note text in URLs or logs.
13. Have the user enter one real provider key through the deployed settings UI, not chat. Prove provider metadata can be stored, replaced, selected, used, invalidated, and deleted without ever returning the key. Run a minimal synthetic OpenAI or Claude organization canary using the selected exact model/effort. A second provider's live key is optional unless the user owns one, but both adapters and mocked protocol suites must be fully green.
14. Build/test the native app against the deployed API. The available toolchain at handoff was Xcode 26.6 with an iOS 26.5 Simulator and an iPhone 17 Simulator booted. `security find-identity -p codesigning` returned zero valid identities. Finish every unsigned/simulator test yourself; request Apple login/team/device action only for signed archive/TestFlight/physical-widget proof.
15. Create `FINAL_REPORT.md` with a requirement -> implementation -> automated test -> live evidence -> limitation mapping. Include exact commands, counts, commit/deployment IDs, migration versions, URLs, and unresolved human-only gates without secrets or user content. Do not call the release complete if required evidence is absent.
16. Review the final diff for secrets, generated junk, stale Soft Index/Expo references, unsupported completion claims, and accidental user changes. Commit coherent changes on `milestone-g-portfolio-release`, push, open a PR, wait for all required checks, diagnose/fix every failure, and merge only when green. Then pull/inspect `main`, verify the merge commit and post-merge CI, verify all five Production deployments are built from the intended merged commit, rerun the release probe and critical live smoke tests, and update final evidence if deployment IDs changed.

## Definition of done

Do not say “done” merely because code exists. Done means all of these are true, or a genuinely human-only item is explicitly and narrowly marked blocked:

- native Swift app and WidgetKit widget build and tests pass;
- web app/public site build and tests pass;
- shared backend, encrypted storage, queues, create-or-append organizer, Review/Undo, export/deletion, and RAG/search work;
- both OpenAI and Claude BYOK protocols are implemented, isolated, and fully tested;
- provider/model/effort/behavior/expansion controls work on web and iOS;
- keys and note data obey the documented custody boundaries;
- the final database migration suite passes cleanly and remote migrations match;
- the free Supabase/Vercel production beta is configured and deployed without AWS or a required app-funded provider key;
- exact live health/provenance and representative encrypted flows are proved;
- docs describe reality rather than future steps;
- no secrets or plaintext canaries appear in git, logs, URLs, evidence, or responses;
- `FINAL_REPORT.md` contains a truthful evidence matrix;
- the PR is green, merged, `main` CI is green, and the merged production deployments are verified.

Begin by reporting the dirty-tree and toolchain facts you verified, then execute. Do not generate another high-level plan and stop.
