# Unfiled project status

Snapshot date: **2026-09-02**

This page is the short, claim-safe status of the repository. Detailed historical evidence remains in [BUILD_PLAN.md](./BUILD_PLAN.md), [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md), and the architecture decision records. Live deployment, migration, and account evidence for the free private beta is recorded in `FINAL_REPORT.md`, not here.

## Status vocabulary

Unfiled uses these terms deliberately:

- **Implemented in code:** the repository contains the production-shaped implementation and tests.
- **Verified locally/CI:** a recorded credential-free test or build passed. This does not prove a cloud account, production identity, signed Apple artifact, or physical device.
- **Deployed and proved:** an account-controlled environment was exercised and its non-secret evidence was recorded.
- **Release-blocked:** implementation may exist, but a required external, legal, operational, or device gate is incomplete.

Passing a local or CI gate never upgrades a feature to “deployed and proved.”

## Free private-beta design

The current release target is a **$0 private beta**:

- one free remote Supabase project (`Unfiled Preview`, `us-west-2`) is the Production database; local Supabase is Development; Vercel Preview deployments are intentionally not built, so no second custodian ever targets the shared database;
- key custody is `UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1`: four independent AES-256 root families held only in Vercel Sensitive Environment Variables, bound to the exact Vercel project ID and the `production` environment ([ADR-0016](./decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)); AWS KMS/Terraform is preserved as deferred paid hardening and is not required or applied;
- AI organization is bring-your-own-key across two providers ([ADR-0015](./decisions/ADR-0015-user-selectable-provider-model-effort.md)): a user saves an OpenAI key, a Claude (Anthropic) key, or both in Supabase Vault and chooses Provider, Model (Automatic or one exact `organization-model-registry-v2` model), and Effort; the beta funds no app-default provider key, so an owner with no saved key makes no provider request: each capture stays saved and readable, is marked `failed` with `provider_unavailable` in Capture activity, the UI asks for a key, and the owner retries after saving one (automatic Inbox filing without a key is roadmap item G1d);
- retrieval embeddings are `unfiled-local-hash-v1` (512 dimensions): a deterministic, provider-neutral feature-hash vector computed in process, so no note or query text is sent to a provider merely for retrieval. It is not an AI semantic embedding; its relevance is weaker than a semantic embedding, and it must not be presented as semantic search;
- the storage promise is application encryption at rest with scoped server-side decryption. Unfiled is **not** end-to-end encrypted and **not** zero knowledge.
- the iPhone app follows the Paper design direction ([ADR-0019](./decisions/ADR-0019-paper-design-direction.md)): a light ground, one type scale with serif titles and serif thoughts, the mark once per tab screen (Inbox and Library, the Desk model), and glyphs drawn from the mark's tray-and-card vocabulary instead of system symbols; the web app still carries the earlier dark treatment.; every action shows its result at once and reverts only if the server refuses (ADR-0019, decision 9), and 250 phone unit tests pass;

## Current snapshot

| Area                                                                                           | Status                                                                                                 | What the status means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture, receipts, correction, Review, Undo, notes, and taxonomy                               | Implemented in code; verified locally/CI                                                               | The shared backend, web surfaces, and native SwiftUI surfaces exist and have credential-free evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Encrypted aggregate and managed-key architecture                                               | Implemented in code; free-beta custodian; fresh owners auto-onboarded; live proof in `FINAL_REPORT.md` | The application-encryption design and fail-closed adapters exist for both custodians. The free beta uses the Vercel Sensitive environment root ring (ADR-0016). Migrations `20260902000000_managed_key_v2_environment_custody.sql` and `20260902000001_dual_provider_model_selection.sql` pass a clean local reset and the full pgTAP suite; their remote application is recorded in `FINAL_REPORT.md`. The irreversible storage contraction remains un-applied (`expand_compatible`) because its restore/PITR gate cannot be met on the free plan. |
| Routing, personal rules, generated blocks, duplicate suggestions, and AI settings              | Implemented in code (dual-provider BYOK); live canary pending                                          | ADR-0015 is implemented on web, iOS, database, and organizer: independent OpenAI and Claude keys in Vault, provider → model → effort selection, immutable per-job provider/model/effort snapshots, and strict OpenAI Responses and Claude Messages adapters. Live evaluation runners exist for both providers; no credentialed live run has been executed yet.                                                                                                                                                                                      |
| Hybrid search, source context, backlinks, structured-log editing, export, and account deletion | Implemented in code; verified locally/CI                                                               | Milestone F merged through PR #18 at commit `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`; the post-merge push CI run below succeeded. The AI-assisted search scope uses local-hash retrieval, which is lexical-strength rather than semantic; its deployed canary evidence is recorded in `FINAL_REPORT.md`.                                                                                                                                                                                                                                          |
| Native iPhone app                                                                              | Unsigned Simulator evidence only                                                                       | SwiftUI and WidgetKit targets build and test locally, including the ADR-0015 catalog, dual key sections, and the managed-fallback build flag. Apple signing, archive inspection, TestFlight, App Group, Keychain/SQLCipher, and physical-device behavior remain unproved.                                                                                                                                                                                                                                                                           |
| Web and isolated services                                                                      | Five Vercel projects exist; deployment proof in `FINAL_REPORT.md`                                      | `unfiled-web`, `unfiled-organizer`, `unfiled-worker`, `unfiled-verifier`, and `unfiled-search` exist in team `zach-2267`, linked to the GitHub repository with `main` as the production branch, region `sfo1`, Node 22, system environment variables, and the OIDC team issuer enabled. Deployment IDs, aliases, and the Deployment Protection setting (Vercel Authentication off; Hobby cannot protect Preview only) are recorded in `FINAL_REPORT.md`.                                                                                            |
| Public privacy, terms, support, and security surfaces                                          | Implemented locally; release-blocked                                                                   | `/privacy`, `/terms`, `/security`, `/support`, `/account-deletion`, and `/.well-known/security.txt` are implemented on the Milestone G branch and passed focused checks plus a Next.js production build. Legal review, operator/jurisdiction decisions, controlled-domain deployment proof, and a private account-support path remain pending.                                                                                                                                                                                                      |
| Vulnerability reporting                                                                        | Repository-private channel verified                                                                    | [GitHub private vulnerability reporting](https://github.com/Zachshotamartin/unfiled/security/advisories/new) was enabled and API-verified active on 2026-09-02. This proves only the private repository channel, not a deployed domain, mailbox, response operation, or production release.                                                                                                                                                                                                                                                         |
| Public support intake                                                                          | Branch-local implementation only                                                                       | A structured public GitHub issue template restricts reports to content-free details. It becomes active on `main` after merge and is not a private account-data channel.                                                                                                                                                                                                                                                                                                                                                                             |
| Launch name                                                                                    | Selected candidate; not cleared                                                                        | The product owner selected **Unfiled** as the launch candidate. Trademark clearance and control of domain, mailbox, App Store, package, project, and social channels are unproved.                                                                                                                                                                                                                                                                                                                                                                  |
| Milestone G portfolio release                                                                  | In progress on this branch                                                                             | Architecture, demo, status, roadmap, naming, operations, public-trust, dual-provider BYOK, and free-beta custody implementation exist on the branch. Deployment evidence, native beta, legal/operator decisions, private account support, monitoring, restore, and the final evidence report remain required.                                                                                                                                                                                                                                       |

## Recorded credential-free evidence

The Milestone F checkpoint records the following local or CI results:

- 27 of 27 applicable workspace quality tasks passed;
- 221 files and 2,198 tests passed under coverage;
- the Production build completed 17 of 17 tasks;
- four built-service health smokes passed;
- 41 database test files and 1,958 assertions passed on a fresh local gate;
- the built-local B–F HTTP suite and the semantic trust-domain integration passed;
- Terraform 1.13.3 validation and 26 of 26 policy tests passed; and
- the unsigned iOS build and 203 of 203 Swift tests passed.

GitHub records PR [#18](https://github.com/Zachshotamartin/unfiled/pull/18) as merged into `main` at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d` on 2026-09-02. The post-merge `push` workflow run [33612621827](https://github.com/Zachshotamartin/unfiled/actions/runs/33612621827) completed successfully for that exact commit. This is source-control and CI evidence only; it does not prove a Vercel deployment, hosted database migration, provider configuration, signed Apple build, physical device, name clearance, domain control, or mailbox delivery.

## Milestone G branch-local checkpoint evidence

The current Milestone G branch records these branch-local results (checkpoint evidence only, not deployment proof):

- contracts 72 tests; api-client 48 tests;
- web 120 files / 1,041 tests plus a Next.js production build;
- organizer 24 files / 401 tests (86% statements);
- ai-routing 83 tests; deterministic routing evaluation and production-component pipeline evaluation pass;
- retrieval capacity gate pass (cold p95 364 ms, warm p95 11 ms); concurrency regressions pass;
- database: migrations `20260902000000` and `20260902000001` pass a clean local reset and the full pgTAP suite (43 files, 2,033 assertions, zero lint findings); and
- dependency audit clean.

The branch also adds local implementations for `/privacy`, `/terms`, `/security`, `/support`, `/account-deletion`, `/.well-known/security.txt`, a structured content-free public support issue template, and root security and support policies. Until the branch is merged, the issue template is not active on `main`; until the exact web deployment is proved from a controlled account, none of the web routes is a proved public endpoint.

Separately, GitHub private vulnerability reporting was enabled and API-verified active for the repository on 2026-09-02. It is a usable private vulnerability-reporting path now. It does not establish domain/Vercel control, mailbox delivery, legal approval, staffed escalation, or a private product-account support channel. The target for an initial response through an active supported channel is **2 business days**, not a contractual service-level agreement.

These counts are checkpoint evidence, not a promise that the same counts remain current after later changes. The release owner must record a fresh final run in `FINAL_REPORT.md`.

## Production and public-beta blockers

The project is not ready to claim a production release until all applicable items below have recorded evidence:

1. Name clearance and control of the canonical domain and contact mailboxes.
2. Exact Vercel deployment provenance for all five projects, including the Deployment Protection change that protects Preview deployments only (recorded in `FINAL_REPORT.md`).
3. Remote application of the `20260902` migrations, dedicated database-login proofs, Vault, provider-key entry through the product UI, live provider canaries for both providers, root-ring rotation, and backup evidence. Paid PITR and the irreversible storage contraction remain deferred; all live writes remain encrypted and fail-closed.
4. Legal review and operator/jurisdiction decisions for the locally implemented privacy policy, terms, security policy, support path, and deletion instructions; merge and controlled-domain deployment proof for those routes; and an established private account-support path.
5. Monitoring dashboards, alerts, incident ownership, and a timed restore drill within the free plan's actual backup capability.
6. Apple identifiers and signing, a signed archive inspection, TestFlight distribution, and the physical-iPhone matrix.
7. A synthetic demo account provisioned through supported owner-authorized paths.
8. A recorded fresh-user iPhone-to-web flagship demonstration.
9. A final CI/security/dependency run and a complete release evidence report.

## Safe public wording

Safe while the blockers above remain:

> Unfiled is a working capture-first notes product implemented for the web and native iPhone, with local and CI evidence. Its free private beta uses your own OpenAI or Claude API key. Its production deployment, native beta, and public-data gates are still being completed.

Do not currently claim:

- that the product is generally available or production-ready;
- that all cloud identities, backups, or provider controls have been proved;
- that the iPhone app is App Store-ready based on Simulator evidence;
- that AI-assisted search is semantic search (the free beta's local-hash retrieval is lexical-strength);
- that app-funded AI is available in the free beta;
- that Unfiled is end-to-end encrypted, zero knowledge, or readable only by the user; or
- that **Unfiled** or `unfiled.app` is legally cleared or under proved project/mailbox control.

On 2026-09-03 the owner entered an OpenAI key on the phone and the first capture organized end to end on production (`job_01M1JFY4` succeeded at 02:30:16 UTC with `gpt-5.6-terra`, then `job_01M1JFR0` at 02:31:23 UTC); both became review items in the Inbox, the policy's warm-up behavior for an account's first five captures. Reading those captures then exposed a web defect of the same family as the receipt-less 503: the receipt matcher did not accept the content-free review reason the commit function projects onto the row, fixed on the same branch, and resolving a review with a new note exposed a second: a deferred plan has no operations to seed the note, also fixed there. With all three deployed, the owner filed a review item into a new note from the phone at 03:11 UTC and it appeared in the Library. Getting there took three organizer fixes on the `design/paper` branch: the strict Structured Outputs schema carried keywords OpenAI rejects, and the organizer now records a content-free provider error identity on every failed job so the next such defect names itself. The Claude path has not run live.

## Next source of truth

The ordered remaining work is in [ROADMAP.md](./ROADMAP.md). The final release report must cite evidence rather than replace this status page with unsupported completion language.
