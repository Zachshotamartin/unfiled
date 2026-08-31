# Unfiled Product Documentation

This directory is the planning and implementation-reference set for **Unfiled**. Milestones A, B, and the credential-free portion of Milestone C are complete. Gate 3 was recorded green on 2026-08-30 with a clean database rebuild, zero database-lint findings, and 18 pgTAP files / 822 assertions. C.5a supplies the expand-only encrypted schema and RAG lifecycle, managed-key package and Terraform policy, isolated worker trust boundary, dedicated non-bypass worker database role, and root-rewrap CAS contract. The current C.5b change set adds the typed encrypted aggregate, service-only rollout/backfill/write/read capabilities, and managed note/capture adapters. The production repository factory is not yet wired to those adapters; fresh AI-assisted capture remains deliberately fail-closed until C.5c adds the organizer atomic writer, and C.5d must still remove the plaintext contract. Account-bound cloud and physical-device evidence remains pending in `HUMAN_SETUP.md`, so the note library is not yet eligible for a complete encrypted-at-rest claim.

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
12. [decisions/](./decisions/) — architecture decision records: [ADR-0001 foundational choices](./decisions/ADR-0001-foundational-technology-and-scope-choices.md), [ADR-0002 BYOK provider strategy](./decisions/ADR-0002-byok-provider-strategy.md), [ADR-0003 immutable native identifiers](./decisions/ADR-0003-native-identifiers.md), [ADR-0004 structured note canonical data](./decisions/ADR-0004-structured-note-canonical-data-and-stable-items.md), [ADR-0005 durable capture job adapter](./decisions/ADR-0005-durable-capture-job-adapter.md), [ADR-0006 encrypted library/private RAG](./decisions/ADR-0006-application-encrypted-library-and-private-rag.md), [ADR-0007 dedicated worker database capability/root rewrap](./decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md), [ADR-0008 encrypted aggregate rollout/replay](./decisions/ADR-0008-encrypted-aggregate-rollout-and-replay.md), and [ADR-0009 ciphertext-bearing index capabilities/separate organizer identity](./decisions/ADR-0009-private-rag-runtime-and-organizer-capability.md).
13. [HUMAN_SETUP.md](../HUMAN_SETUP.md) — account, cloud-preview, browser, canary-log, performance, and physical-device gates that cannot run credential-free in CI.

## Document status

| Document                   | Status                                                                       | Owned by milestone                  |
| -------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| BUILD_PLAN.md              | Current; A/B/C code gates and C.5b implementation status recorded            | revised at each milestone gate      |
| PRODUCT_REQUIREMENTS.md    | Complete for MVP scope                                                       | revised at each milestone gate      |
| AI_ROUTING_SPEC.md         | Complete; weights and thresholds are initial values pending evaluation       | Milestone D                         |
| DATA_MODEL.md              | Initial migrations landed; checked-in migrations are authoritative           | Milestone A and every schema change |
| SECURITY_AND_PRIVACY.md    | C.5b aggregate boundary implemented; production cutover remains              | Milestone C.5 and Gate 6            |
| ENCRYPTION_ARCHITECTURE.md | Capture + C.5a/b custody and aggregate audit; C.5c/d remain                  | Milestone C.5                       |
| OPERATIONS_TEST_PLAN.md    | Current; B/C gates and C.5a/b code evidence recorded; human gates remain     | every milestone                     |
| BRAND_SYSTEM_UNFILED.md    | Selected v1 creative direction; name clearance and vector production pending | Milestone 0                         |
| DESIGN_SYSTEM.md           | Initial skeleton with token draft                                            | Milestone 0                         |
| OPEN_QUESTIONS.md          | Live document                                                                | continuous                          |
| GLOSSARY.md                | Live document                                                                | continuous                          |

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
| C.5c private RAG/organizer and C.5d plaintext contraction                                                              | index worker implemented; verifier/organizer/cutover pending   |

## Milestone C.5a boundary

C.5a is an expand-only security foundation, not the encrypted-library release gate. It adds owner/class/purpose/version-bound intermediate-key records; four distinct KMS root families with exact-context policies; web-versus-worker OIDC identities; encrypted-column and content-free RAG/job schema; a separately deployable worker that accepts only an exact trusted web caller; and the `unfiled_index_worker` PostgreSQL role with no login, RLS bypass, inherited role, table, sequence, or private-schema capability. Its runtime allowlist is exactly six RAG RPCs. Root rewrap remains a service-only, locked CAS operation and is unavailable to the worker. See [ADR-0007](./decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md).

The checked-in tests can prove policy shape and fail-closed behavior without credentials. They cannot prove the deployed Vercel header path, STS exchange, direct private-KMS denial, CloudTrail capture, production database connection identity, key rotation, or backup restore. Those account-bound checks remain pending in [HUMAN_SETUP.md](../HUMAN_SETUP.md).

## Milestone C.5b boundary

C.5b implements the application-side typed encrypted aggregate and strict service-only database capabilities described in [ADR-0008](./decisions/ADR-0008-encrypted-aggregate-rollout-and-replay.md). The database owns stable write identities, wrap reservations, request-MAC replay claims, exact revision compare-and-swap, envelope projections, verification evidence, resumable owner-scoped backfill, and only the `expanded → dual_write → encrypted_read` portion of rollout. Managed adapters create fresh callback-scoped custody/runtime clients and do not fall back to the legacy repository when an encrypted operation fails.

The private-manual capture branch can seal and persist its source and receipt through the encrypted aggregate. A fresh AI-assisted capture is intentionally rejected with `encrypted_organizer_write_unavailable` until C.5c can atomically commit generated notes, mutations, receipts, and index work. The production repository factory still selects the legacy path, so checked-in adapter code and backfill machinery do not imply production cutover.

The current C.5c slice implements the encrypted index capability contract, generation attestation/activation gate, strict float32 encrypted payload codec, bounded exact-scan retrieval/ranking primitives, a production-composed index worker, and a content-free web wake-up/recovery caller. The worker is isolated behind exact Vercel OIDC source claims, a hostname- and certificate-verified dedicated PostgreSQL login with only six RPCs, and AI-only KMS custody. The shadow-generation seed/verifier controller and atomic organizer remain deliberately absent and fail closed, so this is not a complete production index or C.5 claim. Local evidence for this slice is 29/29 search tests, 103/103 encrypted-aggregate tests, 158/158 worker tests, 378/378 web tests, and 22 database files / 1,132 assertions from a clean rebuild.

Local C.5b evidence established in this change set includes 93/93 encrypted-aggregate package tests, 38/38 note read/write/coordinator security tests, 14/14 adversarial note-repository tests, and 20 database test files / 1,091 assertions, including 101/101 assertions in `073_encrypted_aggregate_dual_write.test.sql`. C.5c must connect the organizer and encrypted retrieval adapter; C.5d must stop plaintext writes, remove plaintext reads/search/indexes/columns, pass canary and restore gates, and age out or destroy exposed backups before any complete-library encryption-at-rest claim.

## Rules for maintaining this set

- A change to scope, schema, or contract lands in the owning document in the same change set as the code, never after.
- BUILD_PLAN.md stays the summary; when it disagrees with a companion document on a detail, the companion document wins and BUILD_PLAN.md gets corrected.
- Every non-obvious decision gets an ADR; ADRs are never edited after acceptance, only superseded.
- Open questions move from OPEN_QUESTIONS.md into an ADR when decided; they are not deleted.
