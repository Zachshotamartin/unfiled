# Unfiled Product Documentation

This directory is the planning and implementation-reference set for **Unfiled**. Milestones A, B, and the credential-free portion of Milestone C are complete. C.5a supplies encrypted-schema expansion and managed-key custody; C.5b adds typed encrypted aggregates and managed adapters; C.5c supplies separate organizer, index-worker, and strict-decrypt-verifier runtimes; and C.5d wires the complete encrypted repository/search/export/retention surface plus an explicit irreversible plaintext-storage contract. Milestone D supplies the organizer's production cipher, encrypted RAG retrieval/selection, conservative routing policy, dedicated OpenAI embedding/Responses adapters, a deterministic production-component evaluation seam, and an optional explicit-key live runner in code. Milestone E0–E2 now supply the shared interaction foundation, owner-authorized encrypted correction/Review/batch Undo, and encrypted explicit and learned routing-rule personalization; E3–E4 and Milestones F–G remain pending. E2's credential-free local aggregate and built-local B–E2 HTTP gates are green as of 2026-09-01; pull-request CI is pending. The D seam reports its real exercised components and excludes database lease/heartbeat, encrypted seal/persist, and repository select/commit generation revalidation. The live runner is fixed at three samples per eligible synthetic case and emits content-free telemetry, but it has not been executed with credentials and no live-model report exists. Production has not applied the C.5d contract or completed the provider, cloud, backup-expiry, signing, archive, and physical-device evidence in `HUMAN_SETUP.md`; the four required Vercel projects are not provisioned or deployed. The production note library is therefore not yet eligible for a complete encrypted-at-rest claim, and no E2EE claim is made.

## Reading order

1. [BUILD_PLAN.md](./BUILD_PLAN.md) — the spine: product thesis, decisions, architecture, milestones, and gates. Read first.
2. [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) — user stories with acceptance criteria and edge cases, mapped to milestones.
3. [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) — the organization pipeline in full: rules, candidates, prompt, schema, validation, scoring, and the evaluation corpus.
4. [DATA_MODEL.md](./DATA_MODEL.md) — DDL for every table, RLS policies, transactional functions, structured-data schemas, and retention.
5. [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) — threat model, data path disclosure, redaction rules, deletion pipeline, and incident response.
6. [ENCRYPTION_ARCHITECTURE.md](./ENCRYPTION_ARCHITECTURE.md) — current crypto audit, trust boundary, key hierarchy, migration sequence, and verification gates.
7. [OPERATIONS_TEST_PLAN.md](./OPERATIONS_TEST_PLAN.md) — environments, CI, the enumerated test inventory, release checklists, backups, and monitoring.
8. [BRAND_SYSTEM_UNFILED.md](./BRAND_SYSTEM_UNFILED.md) — identity, voice, cross-platform application, asset manifest, and production handoff rules.
9. [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) — tokens, components, states, and accessibility rules. Initial skeleton; completed during Milestone 0.
10. [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md) — deferred decisions with defaults, options, and decision triggers.
11. [GLOSSARY.md](./GLOSSARY.md) — the product vocabulary used consistently across documents and code.
12. [decisions/](./decisions/) — architecture decision records: [ADR-0001 foundational choices](./decisions/ADR-0001-foundational-technology-and-scope-choices.md), [ADR-0002 BYOK provider strategy](./decisions/ADR-0002-byok-provider-strategy.md), [ADR-0003 immutable native identifiers](./decisions/ADR-0003-native-identifiers.md), [ADR-0004 structured note canonical data](./decisions/ADR-0004-structured-note-canonical-data-and-stable-items.md), [ADR-0005 durable capture job adapter](./decisions/ADR-0005-durable-capture-job-adapter.md), [ADR-0006 encrypted library/private RAG](./decisions/ADR-0006-application-encrypted-library-and-private-rag.md), [ADR-0007 dedicated worker database capability/root rewrap](./decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md), [ADR-0008 encrypted aggregate rollout/replay](./decisions/ADR-0008-encrypted-aggregate-rollout-and-replay.md), [ADR-0009 ciphertext-bearing index capabilities/separate organizer identity](./decisions/ADR-0009-private-rag-runtime-and-organizer-capability.md), [ADR-0010 native SwiftUI replacement](./decisions/ADR-0010-native-ios-client-replacement.md), [ADR-0011 encrypted owner interactions/personal rules](./decisions/ADR-0011-encrypted-owner-interactions-and-personal-rules.md), and [ADR-0012 Vault-only lease-bound BYOK](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md).
13. [HUMAN_SETUP.md](../HUMAN_SETUP.md) — account, cloud-preview, browser, canary-log, performance, and physical-device gates that cannot run credential-free in CI.

## Document status

| Document                   | Status                                                                         | Owned by milestone                  |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| BUILD_PLAN.md              | Current; A–E2 local implementation recorded; E3–E4 pending                     | revised at each milestone gate      |
| PRODUCT_REQUIREMENTS.md    | Complete for MVP scope                                                         | revised at each milestone gate      |
| AI_ROUTING_SPEC.md         | Mock + production-component seam implemented; credentialed live report pending | Milestone D                         |
| DATA_MODEL.md              | Checked-in migrations through E2 are authoritative; E3–E4 reserved             | Milestone A and every schema change |
| SECURITY_AND_PRIVACY.md    | C.5a–E2 data paths recorded; production/provider evidence remains              | Milestone C.5, D, E, and Gate 6     |
| ENCRYPTION_ARCHITECTURE.md | Capture through E2 owner interactions audited; production evidence remains     | Milestone C.5, D, and E             |
| OPERATIONS_TEST_PLAN.md    | E2 credential-free local gate green; PR CI and human gates remain              | every milestone                     |
| BRAND_SYSTEM_UNFILED.md    | Selected v1 creative direction; name clearance and vector production pending   | Milestone 0                         |
| DESIGN_SYSTEM.md           | Initial skeleton with token draft                                              | Milestone 0                         |
| OPEN_QUESTIONS.md          | Live document                                                                  | continuous                          |
| GLOSSARY.md                | Live document                                                                  | continuous                          |

## Milestone B Gate 2 evidence

The milestone owner recorded the credential-free aggregate Gate 2 code decision as green on 2026-08-30. Preview/browser/device evidence that requires cloud accounts or hardware remains listed in `HUMAN_SETUP.md` and is not claimed here.

| Evidence                                                            | Recorded result                   |
| ------------------------------------------------------------------- | --------------------------------- |
| contracts lint, typecheck, 24 tests, coverage, and build            | pass                              |
| API client lint, typecheck, 9 tests, coverage, and build            | pass                              |
| web lint/typecheck and 60 tests; mobile lint/typecheck and 61 tests | pass                              |
| generated OpenAPI freshness for the Milestone B contract baseline   | pass                              |
| fresh database reset and warning-level lint                         | pass; zero lint findings          |
| complete pgTAP suite                                                | pass; 15 files / 636 assertions   |
| built-app/local-Supabase HTTP E2E                                   | pass twice consecutively          |
| web responsive/auth smoke                                           | pass at desktop and 390 px mobile |
| aggregate credential-free Gate 2 decision                           | **green — 2026-08-30**            |

## Milestone C Gate 3 evidence

The milestone owner recorded the credential-free aggregate Gate 3 decision as green on 2026-08-30. Cloud, Apple-signing, and physical-device evidence remains explicitly pending and is not implied by this local code gate.

| Evidence                                                                                                               | Current result                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| capture contracts, `/api/v1/captures` OpenAPI surface, and shared API client                                           | pass; 33 contract tests and 14 API-client tests                |
| AES-256-GCM capture envelopes with owner/resource/version/kind binding and ciphertext-only active database persistence | implemented                                                    |
| capture tables and storage RPCs denied to clients; verified Next API uses service-only owner-scoped RPCs               | implemented                                                    |
| leased workflow claims, heartbeats, retry/recovery, dead-letter handling, receipts, and deletion scrubbing             | implemented                                                    |
| Web Crypto-encrypted IndexedDB intents/outbox and native GRDB/SQLCipher drafts/outbox                                  | pass; covered by the web and native test suites                |
| complete local pgTAP suite                                                                                             | pass; 18 files / 822 assertions                                |
| aggregate format, lint, typecheck, coverage, build, OpenAPI, native Xcode, database, and routing gates                 | pass                                                           |
| frozen-lockfile install, production dependency audit, and built-app/local-Supabase HTTP E2E                            | pass; zero known production vulnerabilities                    |
| responsive production UI and static assets                                                                             | pass at desktop and 390 px; no failed images                   |
| focused WidgetKit tests, Swift 6 checks, and generated-project/resource inspect gate                                   | pass                                                           |
| GRDB with SQLCipher plus the WidgetKit/App Intents target `QuickCaptureWidget`                                         | pass; native dependencies and target boundaries are explicit   |
| unsigned SwiftUI application and `QuickCaptureWidget` extension builds with selected Xcode 26.6                        | pass for the iPhone 17 Pro simulator only                      |
| Apple signing/archive, physical iPhone SQLCipher/widget matrix, cloud canary/log audit, and preview performance        | pending human evidence in `HUMAN_SETUP.md`                     |
| C.5a custody/expansion code                                                                                            | pass; 989 pgTAP + 12 Terraform tests; account evidence pending |
| C.5b encrypted aggregate and managed adapters                                                                          | implemented; focused evidence recorded below                   |
| C.5c–D private RAG/organizer and C.5d plaintext contraction                                                            | locally implemented; live-provider/production evidence pending |

## Milestone C.5a boundary

C.5a is an expand-only security foundation, not the encrypted-library release gate. It adds owner/class/purpose/version-bound intermediate-key records; four distinct KMS root families with exact-context policies; web-versus-worker OIDC identities; encrypted-column and content-free RAG/job schema; a separately deployable worker that accepts only an exact trusted web caller; and the `unfiled_index_worker` PostgreSQL role with no login, RLS bypass, inherited role, table, sequence, or private-schema capability. Its runtime allowlist is exactly six RAG RPCs. Root rewrap remains a service-only, locked CAS operation and is unavailable to the worker. See [ADR-0007](./decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md).

The checked-in tests can prove policy shape and fail-closed behavior without credentials. They cannot prove the deployed Vercel header path, STS exchange, direct private-KMS denial, CloudTrail capture, production database connection identity, key rotation, or backup restore. Those account-bound checks remain pending in [HUMAN_SETUP.md](../HUMAN_SETUP.md).

## Milestone C.5b boundary

C.5b implements the application-side typed encrypted aggregate and strict service-only database capabilities described in [ADR-0008](./decisions/ADR-0008-encrypted-aggregate-rollout-and-replay.md). The database owns stable write identities, wrap reservations, request-MAC replay claims, exact revision compare-and-swap, envelope projections, verification evidence, resumable owner-scoped backfill, and only the `expanded → dual_write → encrypted_read` portion of rollout. Managed adapters create fresh callback-scoped custody/runtime clients and do not fall back to the legacy repository when an encrypted operation fails.

The private-manual capture branch can seal and persist its source and receipt through the encrypted aggregate. C.5c supplies the atomic organizer database and application boundary for AI-assisted captures, and Milestone D composes the production cipher, encrypted per-owner retrieval, strict provider plan, deterministic extraction/preservation, and conservative create-or-append policy behind it. C.5d composes the complete encrypted repository behind authoritative rollout state; pre-contract states retain a deliberate rollback adapter, while state/RPC/KMS errors never downgrade to it. Checked-in implementation still does not imply that Production has executed the global contract or passed a real-provider routing gate.

The C.5c index slice implements the encrypted index capability contract, strict float32 encrypted payload codec, bounded exact-scan retrieval/ranking primitives, a production-composed index worker, resumable shadow-generation maintenance, and an independent decrypt-only verifier. Worker and verifier use different exact Vercel, database, and AWS identities: the worker retains six RAG RPCs and AI object-wrap key generation/decryption, while the verifier has exactly two RPCs and AI object-wrap decryption only. The verifier's fixed admission capacity is 1,000 notes: 33 pages provide 1,023 physical worst-row slots under the fixed ciphertext budget, deliberately capped at the accepted retrieval gate; larger libraries defer without repeatedly creating bad generations. A separate fixed four-key-record limit bounds KMS work. The historical C.5c-2 focused evidence is 158 worker tests, 436 web tests, 168 verifier unit tests plus the dedicated 1,000-document capacity gate, 13 Terraform tests, and a clean 23-file / 1,185-assertion database run.

### Milestone C.5c organizer boundary

`apps/organizer` is a fourth Vercel trust domain, distinct from web, index worker, and verifier. Production web sends only `{"trigger":"schedule|recovery|manual"}` to its exact proved `*.vercel.app` origin with a short-lived Vercel Trusted Sources token. The organizer rejects browser sessions, cookies, `Authorization`, protection-bypass credentials, request-supplied owner IDs, broad Supabase credentials, static AWS credentials, private-manual keys, ambient provider keys, and user BYOK. Production accepts exactly one server-only `UNFILED_ORGANIZER_OPENAI_API_KEY` from a dedicated OpenAI project/service account. Its own deadline is at most 49 seconds; an organization commit atomically enqueues content-free index work, and Production deliberately leaves that queue to the independent index-recovery path rather than chaining a second long-running worker request.

The exact PostgreSQL login is `unfiled_organizer_worker`: initially `NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`, with no relation, sequence, private-schema, or public-create privilege. It can execute exactly ten job/lease-scoped functions: claim, heartbeat/revalidate, bounded candidate projection, encrypted-RAG pagination, exact ranked-candidate selection, prepare create, prepare append, atomic commit, fail, and stale-job recovery. The database derives ownership from the live lease, issues stable IDs and key reservations, and allows one replan before forcing Review. The matching AWS workload is limited to AI-assisted object-wrap and content-MAC roots and cannot use private-manual roots, rewrap a root, or create a grant.

Production, Preview, and development invoke only the isolated organizer; deterministic organization is an explicit test fixture, not a deployed fallback. Milestone D connects the production cipher, encrypted exact-scan RAG candidate path, strict OpenAI planner, and policy/materialization boundary. The Responses call is foreground, tool-free, and `store: false`; that flag is not a Zero Data Retention guarantee, and default abuse-monitoring retention can still apply to both routing and embedding traffic. C.5d has switched application reads/writes/search/export/retention to encrypted adapters and implemented removal of plaintext columns/indexes as a separate database-owner operation. The live stochastic evaluation plus all OpenAI-project, Vercel, OIDC, AWS KMS, CloudTrail, database-login, rotation, contraction, backup-expiry, and canary evidence remains pending in `HUMAN_SETUP.md`.

Milestone D does not persist model-returned generated-expansion text: the current application discards it rather than claiming a recoverable pending proposal. E1 now implements the owner-authorized correction, Review-resolution, and mutation-batch Undo portion of [ADR-0011](./decisions/ADR-0011-encrypted-owner-interactions-and-personal-rules.md). Correction fallback remains decision-bound and supports route/create/keep-inbox/dismiss; batch-Undo conflict is decision-less and supports only keep-inbox/dismiss. The server derives the canonical batch anchor and hidden membership, rejects non-anchor members and undo-of-undo anchors, and keeps receipts/history encrypted and owner-bound. Its upgrade-only organizer-receipt timestamp repair requires exact attestation and preserves ciphertext, revision, and verification. Private explicit and learned rules are implemented by E2; generated blocks and duplicate suggestions remain E3, and [ADR-0012](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md) keeps Vault-only custody in pending E4. User BYOK and Anthropic remain unavailable until their migrations, adapter/evaluation evidence, and release gates land.

The final historical C.5c-3 local aggregate gate passes 449 web, 159 worker, 168 verifier, and 132 organizer tests, with organizer coverage at 87.01% statements / 83.29% branches / 93.29% functions / 90.17% lines. C.5d extends the clean database gate to 32 files / 1,417 assertions with zero lint findings, including 41 focused contract assertions and a fail-fast concurrent-application regression. The historical Milestone D native gate passes 88 Swift tests; D also adds a 175-case deterministic mock corpus, a 15-case deterministic production-component seam with explicit exercised/excluded/simulated scope, and an optional explicit-key live runner fixed at three samples per eligible synthetic case with content-free telemetry. The live runner has not been executed with credentials and no report exists; these checked-in lanes do not replace live provider evidence, cloud-account evidence, production contraction, Apple signing, or physical-device evidence.

### Milestone E1 local implementation evidence

The credential-free E1 gate is green on 2026-09-01: the full built-local HTTP B–E1 suite passed; web passed 78 files / 651 tests; organizer, worker, and verifier passed 18 / 281, 18 / 159, and 11 / 168; a clean database reset, strict private/public lint with zero warnings, 36 pgTAP files / 1,671 assertions, and database concurrency passed; and Xcode built the app plus `QuickCaptureWidget` and passed 135/135 Swift tests. Workspace format/lint/typecheck/coverage passed 26/26 tasks, build passed 16/16, all three built-server smokes passed, boundaries and OpenAPI were green, and dependency audit reported no known vulnerabilities. Deterministic routing passed 175/175 cases, the production-component pipeline passed 15/15, verifier capacity passed 1/1, and organizer 1,000-note retrieval recorded cold p95 407.03 ms and warm p95 18.07 ms. Production KMS/Vercel/provider/account, Apple-signing, deployment, archive, and physical-device gates remain outstanding.

Local C.5b evidence established 93/93 encrypted-aggregate package tests, 38/38 note read/write/coordinator security tests, 14/14 adversarial note-repository tests, and 20 database test files / 1,091 assertions, including 101/101 assertions in `073_encrypted_aggregate_dual_write.test.sql`. C.5d now implements the encrypted repository/search surface and the atomic plaintext-contract removal. Production must still pass the explicit contraction, canary/restore, managed-custody, and backup-expiry gates before any complete-library encryption-at-rest claim.

## Rules for maintaining this set

- A change to scope, schema, or contract lands in the owning document in the same change set as the code, never after.
- BUILD_PLAN.md stays the summary; when it disagrees with a companion document on a detail, the companion document wins and BUILD_PLAN.md gets corrected.
- Every non-obvious decision gets an ADR; ADRs are never edited after acceptance, only superseded.
- Open questions move from OPEN_QUESTIONS.md into an ADR when decided; they are not deleted.
