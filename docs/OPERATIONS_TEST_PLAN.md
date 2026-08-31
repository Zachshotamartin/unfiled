# Operations and Test Plan

Environments, CI, the enumerated test inventory, release checklists, backups, and monitoring. Test IDs reference requirement IDs in [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md); commands are finalized at Milestone A bootstrap and recorded here.

## 1. Environments

| Env          | Web/API                    | Database                         | AI                                          | Secrets                                 | Data                                   |
| ------------ | -------------------------- | -------------------------------- | ------------------------------------------- | --------------------------------------- | -------------------------------------- |
| `local`      | next dev / expo dev client | local Supabase (CLI)             | mock model adapter default; real key opt-in | `.env.local`, never committed           | seed fixtures only                     |
| `preview`    | Vercel preview per PR      | isolated Supabase branch/project | real adapter, non-prod budget, cheap tier   | Vercel preview scope                    | synthetic only — never production data |
| `production` | protected Vercel project   | protected Supabase project       | evaluated config                            | KMS/HSM + short-lived workload identity | real user data                         |

Rules: preview never points at production; the mock model adapter is deterministic (fixture-driven) so every CI run is reproducible; no test requires production credentials (Milestone A gate).

## 2. Local development

1. `pnpm install` (pinned via `packageManager`), `supabase start`, `supabase db reset` (applies all migrations + seed).
2. `pnpm dev` runs web; `pnpm dev:mobile` runs Expo dev client against local API.
3. `pnpm test` runs all package unit tests; `pnpm test:db` runs SQL/RLS tests; `pnpm eval:routing` runs the deterministic routing cases against the mock adapter.
4. After `pnpm build` and a clean `supabase db reset`, `bash .github/workflows/scripts/milestone-b-http-e2e.sh` starts the built Next.js app and exercises the real HTTP, auth, repository, RPC, and database boundary with synthetic seed data.

## 3. CI pipeline (GitHub Actions, per PR)

| Stage                     | Contents                                                                                                                                         | Blocking |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1 static                  | format check, ESLint, strict `tsc` per package, package-boundary check (`domain` imports nothing platform)                                       | yes      |
| 2 unit                    | Vitest across packages; ≥80% lines/branches on core packages; scoped mobile auth/capture gate ≥90% statements/lines/functions and ≥85% branches  | yes      |
| 3 database                | migrations apply from zero; SQL tests: RLS/grants/functions plus C.5 envelope/index invariants when landed                                       | yes      |
| 4 contract                | shared API fixtures validated by web + mobile clients; error-code stability; OpenAPI generated and diffed                                        | yes      |
| 5 routing (deterministic) | full corpus against mock adapter: preservation, validation, banding, injection cases                                                             | yes      |
| 6 build                   | `next build`; Expo `npx expo export` type/bundle check                                                                                           | yes      |
| 7 local HTTP E2E          | built Next.js + local Supabase: auth/manual-note flows plus capture create/replay/drain/detail/receipt/delete and encrypted-row checks           | yes      |
| 8 automated security      | gitleaks committed-content scan and `pnpm audit --prod --audit-level high`                                                                       | yes      |
| 9 infrastructure          | Terraform format/validate/test for four KMS root families, exact-subject OIDC roles, context-bound policy, rotation states, and worker isolation | yes      |

Preview Playwright, cloud canary-log inspection, performance smoke, stochastic real-provider evaluation, Maestro device coverage, and Lighthouse budgets are not represented as automated CI. They require cloud accounts, preview credentials, provider decisions, or physical devices and remain explicit gates in [HUMAN_SETUP.md](../HUMAN_SETUP.md). A release may not substitute the local HTTP gate for those later milestone gates.

Production deploy: merge to main → staging checks → migration approval gate (manual) → promote. Mobile: EAS preview channel per release branch; store builds only from tagged releases.

## 4. Test inventory — unit (package-level)

`domain`: capture validation (length/empty/unicode), idempotency-key semantics, note-type rules, revision math, inverse-operation correctness for every op type (append_raw, paragraphs, list_items, log_entry, structured patch, tags, relation, toggle, field edit, item edit/remove), undo compatibility checks, local-date logic (DST spring/fall, timezone change, midnight boundary), Markdown preservation, projection determinism (property test: same `structured_data` → identical bytes), re-parse vs structure-conflict classifier, privacy filtering.

`ai-routing`: rule matching per type (prefix/phrase/alias/destination_mention) incl. normalization and priority; encrypted candidate assembly incl. tenant/private/generation/revision predicates, stale repair cap, cache invalidation, and incomplete-coverage fail-safe; schema parsing incl. 20+ hostile fixtures; preservation/scoring/banding; effort config; provider adapters.

`content-crypto`: randomized round trip; tampered payload/wrapped key/context; wrong owner/resource/version/kind/key; malformed/oversized envelope; resolver no-fallback; rewrap; plaintext-canary absence from errors.

`key-management`: exact four-field KMS context; owner/class/purpose/key-record binding; four distinct active roots; local-only resolver rejection in production; Vercel OIDC transport; static-AWS-credential rejection; GenerateDataKey/Decrypt readiness; worker AI-only generate/unwrap facade; private-root direct-denial evidence; root-rewrap authorization, monotonic lifecycle, replay, and abort propagation.

`worker`: exact Vercel Trusted Sources issuer/audience/subject/owner/project/environment validation; one-hour token bound; no authorization/bypass fallback; production environment denylist; active/retired AI-root registry parsing; no private root or global Supabase credential; real KMS readiness before authority; request/lease cancellation; retained-facade revocation; bounded JSON and content-free failure responses.

`sync`: outbox state machine (pending→synced, retry/backoff, permanent failure), restart recovery, duplicate suppression, cursor monotonicity, reconciliation.

`contracts`: Zod schema round-trips, error-code table completeness, version compatibility (previous schema fixtures still parse).

## 5. Test inventory — database (SQL)

1. RLS allow + cross-user deny for every table (generated per table; a new table without tests fails CI).
2. Grant tests: telemetry/mutation/key tables reject direct client writes; `user_provider_keys` rejects client reads.
3. `notes_daily_singleton` holds under concurrent inserts (two parallel organization mutations for the same-day shopping list → one note).
4. Capture storage functions are service-only, require an explicit owner selected by the verified application session, enforce ownership on every read/write, atomically insert one envelope + job, and return the same live capture on an equivalent replay without storing ciphertext in an idempotency snapshot.
5. Capture-envelope constraints reject malformed or plaintext active rows; deletion atomically destroys the envelope, fingerprint, and length. Leased job claims exclude competitors, heartbeat ownership is enforced, stale leases recover safely, retries stop at five attempts, dead-letter and receipt transitions replay exactly once, and retry/delete replays cannot resurrect deleted ciphertext.
6. `apply_mutation`: stale revision rejected; success writes revision+mutation+links+event in one transaction; replay returns original.
7. `undo_mutation`: inverse restores content hash; incompatible-later-edit path.
8. `purge_expired_deleted_notes`: service-only grants, dry-run default, exact 30-day cutoff,
   owner scope, bounded batches, cross-owner fail-closed behavior, cascades, telemetry nulling,
   workflow-wide lock order, active-job deferral, receipt downgrade to non-actionable history,
   bounded reason codes, idempotency-snapshot removal, and purge/capture cursor events.
9. Cascade tests: note delete removes chunks/embeddings/links/blocks; account delete leaves zero rows.
10. Export scope excludes other users; deletion reconciliation finds seeded orphans.
11. C.5 envelope schema rejects missing/wrong context; keyed idempotency replay is stable while ciphertext remains randomized.
12. RAG tables deny clients/cross-users; worker cannot claim private/deleted/stale notes; only the active generation/current revision is eligible; privacy/delete races exclude immediately.
13. Contract migration leaves no plaintext content column, FTS/trigram/vector index, `note_chunks`, or unkeyed content hash.
14. C.5a worker role is `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`, unprivileged, and outside every inherited role; it has no direct table/sequence/private-schema/admin-function capability and exactly six RAG RPC grants. `SET ROLE` cannot satisfy the functions' exact `session_user` guard.
15. Root rewrap is client/worker-denied and service-only; it locks the owner/key row, compares the expected old full ARN and counter, atomically writes new ciphertext/ARN/previous ARN/count/time, replays only an exact already-applied result, and rejects stale or mismatched calls.

## 6. Test inventory — routing evaluation

Per [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §12: deterministic corpus in CI (mock), stochastic nightly (real, n=3, worst-of). Release gates: thresholds in AI spec §12.3, per `(provider, tier)` pair. Reports committed to `docs/eval-reports/` dated; a gating regression blocks merge.

## 7. Test inventory — end-to-end

Milestones B and C share one deterministic process-boundary suite at `.github/workflows/scripts/milestone-b-http-e2e.sh` (the historical filename is retained). It runs the built web server against a freshly reset local Supabase project and verifies:

- bearer-authenticated session reads;
- manual note creation and same-key replay;
- update, stale-revision rejection, and update undo;
- creation undo as a soft-delete revision and undo-of-undo restore;
- tag create/update/association, note link create/list/delete, search, and read-only Review pagination;
- capture creation and same-key replay through the authenticated public API;
- service-only workflow drain, then owner-authorized detail and receipt reads;
- an application-encrypted AES-256-GCM envelope in Postgres, a constant `raw_text` sentinel, and absence of the synthetic plaintext canary from the durable row and built-server logs;
- capture deletion through the public API, including content destruction and content-free replay behavior;
- sign-out.

This is HTTP E2E, not browser E2E: it crosses the built application, route handler, authentication provider, production repository adapter, PostgREST/RPC, and PostgreSQL boundaries, but it does not claim keyboard, focus, navigation, or rendering coverage. The current production repository has no truthful in-memory server mode, and `@playwright/test` is not an installed project dependency, so a synthetic Playwright lane was deliberately not advertised.

Preview Playwright (web) and Maestro (device) remain required for the full PRODUCT_REQUIREMENTS flows. The 13 critical flows from BUILD_PLAN §18.5 plus:

- E2E-14: set BYOK key (test key against provider sandbox/mock), route a capture, verify decision telemetry shows BYOK provider; delete key; verify next capture uses app default.
- E2E-15: set expansion style `off`; verify no generated block over 20 captures.
- E2E-16: airplane-mode toggle mid-session — toggle a checkbox offline (rejected gracefully, MVP requires connection), capture offline (queued), reconnect, verify both outcomes.
- E2E-17: stale-tab conflict — edit the same note in two web tabs; second save gets conflict affordance, no silent overwrite.
- E2E-18: seed unique canaries through capture, edit, route, Review, generated block, undo, search, export, and delete; inspect durable stores/telemetry for ciphertext-only persistence.
- E2E-19: provider spy observes zero calls and index rows for private content/query; flip/delete during retrieval and prove exclusion before model and write.
- E2E-20: KMS outage/tamper fails closed; retry retains ciphertext; restored authorized keys decrypt post-cutover backup, while a role lacking the correct class cannot.

Device matrix (Maestro, nightly): smallest supported iPhone + mid Android, keyboard-open capture, dynamic type at largest setting, dark mode only (MVP), VoiceOver/TalkBack smoke on capture→receipt→toggle.

## 8. Performance verification

NFR targets from PRODUCT_REQUIREMENTS §3 will be measured by Playwright traces, a k6 (or equivalent) capture smoke, and beta telemetry. C.5 adds a deterministic 1,000-note retrieval benchmark including envelope decryption/ranking: cold p95 < 2 s excluding query-embedding provider and warm p95 < 250 ms, with cache state explicit. Routing evaluation must keep candidate recall ≥0.98 and wrong auto-apply ≤0.01 with stale/missing-index cases. Until automated, record preview measurements manually; never exclude slow successes.

## 9. Release checklists

**Milestone B Gate 2:** recorded green for the credential-free code gate on 2026-08-30. Scoped package checks, production builds, OpenAPI freshness, a fresh database reset, warning-level database lint with zero findings, 636 pgTAP assertions, and repeated built-app HTTP E2E runs passed. Create-note undo/redo and stale-write behavior passed through the production repository path. Mobile auth, refresh recovery, and the Keychain/Keystore migration are included in the scoped coverage gate (97.25% statements, 92.35% branches, 98.52% functions, 97.82% lines). The cloud-preview browser matrix in HUMAN_SETUP remains required before a preview or public release and is not claimed as completed by this local gate.

**Milestone C Gate 3:** recorded green for the credential-free code gate on 2026-08-30. Shared capture contracts/OpenAPI/client support; owner-bound AES-256-GCM capture envelopes; service-only capture tables, queue capabilities, and owner-scoped RPCs; leased claims, heartbeats, retry/recovery, dead-letter handling, receipts, deletion scrubbing, and retention downgrades; Web Crypto-encrypted IndexedDB intents/outbox; and SQLCipher mobile drafts/outbox all passed their focused and aggregate gates. The final local database run applied every migration from zero, reported zero warning-level lint findings, and passed 18 files / 822 pgTAP assertions. Format, lint, strict typecheck, coverage, builds, OpenAPI, Expo dependency/prebuild, routing eval, frozen-lockfile install, production dependency audit, built-app HTTP E2E, static-asset, and responsive visual checks passed. Apple signing and archive inspection, the physical-iPhone SQLCipher/widget/restart matrix, cloud-preview canary/log inspection, and preview performance smoke remain pending human evidence in `HUMAN_SETUP.md` and are not implied by this code gate.

**Milestone C.5a code boundary:** recorded green for the credential-free code gate on 2026-08-30. The surface covers four independently versioned KMS root families, exact-context managed-key custody, separate exact-subject web/worker roles, an isolated trusted-caller worker, expand-only encrypted aggregate/RAG schema, race-safe encrypted index lifecycle, a dedicated non-bypass worker database role with exactly six RPCs, and a service-only root-rewrap CAS. The final run passed frozen-lockfile install and production dependency audit, format/lint/type/boundary/OpenAPI/Expo checks, all 15-package coverage lanes, deterministic routing evaluation, production builds, the local HTTP acceptance suite, a zero-from-scratch database rebuild with zero warning-level lint findings and 19 files / 989 pgTAP assertions, and 12 Terraform policy/rotation tests. Focused security suites passed 34 content-crypto, 46 key-management, and 62 worker tests; the final adversarial review reported no remaining P0–P3 findings. This code result is not the complete C.5 gate and does not prove a deployed trust path.

**C.5a account evidence (pending):** deploy the two exact Vercel projects; prove Trusted Sources header preservation; exchange the real worker OIDC identity through STS; generate and decrypt against both active AI roots; directly deny GenerateDataKey and Decrypt against both private roots; retain matching content-free CloudTrail management events; connect through hostname- and certificate-verified TLS with `session_user = 'unfiled_index_worker'`; prove that login has only the six-RPC surface; and complete outage, rotation/rewrap, rollback, and restored-backup drills. `HUMAN_SETUP.md` owns the exact procedure.

**Complete Milestone C.5 gate (not yet green):** C.5b–d must make REQ-E1/E2/R8/R9 and E2E-18–20 pass; complete the plaintext schema/index contract; witness managed-KMS separation, fail-closed behavior, rewrap, and restore; and pass encrypted retrieval performance/quality gates. Milestone D auto-routing and any complete-library “encrypted notes” product claim are blocked until then.

The production dependency audit reports zero known advisories. The root `pnpm` override resolves transitive `uuid` consumers to `uuid@11.1.1`, removing the previously reported Expo config-plugin build-chain advisory; Gate 3 reconfirmed this result from the frozen lockfile.

**Web/API release:** CI green including the applicable local and preview E2E lanes; migration gate approved; eval report current for active `(provider, tier)` pairs; cloud canary-log and performance checks recorded; error budget not exhausted; changelog updated; rollback = previous Vercel deployment + no destructive migration in window.

**Mobile release:** EAS build from tag; runtime env pinned; store metadata/privacy manifests current; deep links verified; upgrade test from previous build (SQLite migrations); staged rollout with crash-rate gate.

**First public beta additionally:** SECURITY_AND_PRIVACY §10 checklist complete; restore drill performed within last 30 days; support + security contact live; demo account seeded with labeled synthetic data.

## 10. Backups and restore drill

Supabase scheduled backups (verify plan tier ≥ daily + PITR if available). Quarterly drill: restore to scratch, restore only authorized KMS access separately, verify envelope authentication/content parity without logging plaintext, run deletion replay, time, and record gaps. Restore must retain each intermediate-key record's exact root ARN, wrapped bytes, version, previous root, rewrap count, and four KMS-context identifiers. A backup containing a deleted user's wrapped intermediate key can remain decryptable under the shared root until expiry; deletion copy and restore access controls must reflect this. Pre-cutover plaintext backups remain a documented risk until aged out.

## 11. Monitoring and alerting (initial thresholds)

| Signal                                           | Warn                 | Page                                  |
| ------------------------------------------------ | -------------------- | ------------------------------------- |
| capture API error rate                           | > 1% over 10 min     | > 5%                                  |
| workflow queue oldest age                        | > 2 min              | > 10 min                              |
| dead-letter jobs                                 | any                  | > 10/hour                             |
| receipt p95                                      | > 8 s                | > 20 s                                |
| invalid-plan rate                                | > 2%                 | > 10%                                 |
| wrong auto-apply (from corrections on auto-band) | > 1% weekly          | — (review + consider band tightening) |
| provider error rate                              | > 5%                 | circuit breaker stuck open > 15 min   |
| search index lag                                 | > 1 min              | > 10 min                              |
| active-generation coverage                       | < 100%               | repair fails or stale/missing > 50    |
| KMS decrypt/rewrap failures                      | any                  | sustained > 5 min or wrong-key access |
| deletion reconciliation findings                 | any                  | —                                     |
| note-retention cron failure                      | any                  | two consecutive daily failures        |
| note-retention batch limit reached               | any                  | three consecutive daily runs          |
| per-user model call anomaly (BYOK protection)    | 3× personal baseline | 10×                                   |

Dashboards: capture funnel (received→organized/inbox/review/failed), band distribution over time, correction/undo trend, model cost per active user, sync outbox age distribution. All content-free.

## 12. Runbooks (write at Milestone G, index here)

Provider outage; queue backlog drain; stuck circuit breaker; bad deploy rollback; migration failure mid-apply; restore from backup; user data-export support request; suspected key exposure (links SECURITY_AND_PRIVACY §9).
