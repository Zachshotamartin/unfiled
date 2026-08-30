# Operations and Test Plan

Environments, CI, the enumerated test inventory, release checklists, backups, and monitoring. Test IDs reference requirement IDs in [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md); commands are finalized at Milestone A bootstrap and recorded here.

## 1. Environments

| Env          | Web/API                    | Database                         | AI                                          | Secrets                               | Data                                   |
| ------------ | -------------------------- | -------------------------------- | ------------------------------------------- | ------------------------------------- | -------------------------------------- |
| `local`      | next dev / expo dev client | local Supabase (CLI)             | mock model adapter default; real key opt-in | `.env.local`, never committed         | seed fixtures only                     |
| `preview`    | Vercel preview per PR      | isolated Supabase branch/project | real adapter, non-prod budget, cheap tier   | Vercel preview scope                  | synthetic only — never production data |
| `production` | protected Vercel project   | protected Supabase project       | evaluated config                            | production scope, rotation documented | real user data                         |

Rules: preview never points at production; the mock model adapter is deterministic (fixture-driven) so every CI run is reproducible; no test requires production credentials (Milestone A gate).

## 2. Local development

1. `pnpm install` (pinned via `packageManager`), `supabase start`, `supabase db reset` (applies all migrations + seed).
2. `pnpm dev` runs web; `pnpm dev:mobile` runs Expo dev client against local API.
3. `pnpm test` runs all package unit tests; `pnpm test:db` runs SQL/RLS tests; `pnpm eval:routing` runs the deterministic routing cases against the mock adapter.
4. After `pnpm build` and a clean `supabase db reset`, `bash .github/workflows/scripts/milestone-b-http-e2e.sh` starts the built Next.js app and exercises the real HTTP, auth, repository, RPC, and database boundary with synthetic seed data.

## 3. CI pipeline (GitHub Actions, per PR)

| Stage                     | Contents                                                                                                                                        | Blocking |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1 static                  | format check, ESLint, strict `tsc` per package, package-boundary check (`domain` imports nothing platform)                                      | yes      |
| 2 unit                    | Vitest across packages; ≥80% lines/branches on core packages; scoped mobile auth/capture gate ≥90% statements/lines/functions and ≥85% branches | yes      |
| 3 database                | migrations apply from zero; SQL tests: RLS allow/deny, grants, functions, constraints                                                           | yes      |
| 4 contract                | shared API fixtures validated by web + mobile clients; error-code stability; OpenAPI generated and diffed                                       | yes      |
| 5 routing (deterministic) | full corpus against mock adapter: preservation, validation, banding, injection cases                                                            | yes      |
| 6 build                   | `next build`; Expo `npx expo export` type/bundle check                                                                                          | yes      |
| 7 local HTTP E2E          | built Next.js server + local Supabase: auth, create/replay/edit/stale/undo, create undo/redo, relations, Review, search                         | yes      |
| 8 automated security      | gitleaks committed-content scan and `pnpm audit --prod --audit-level high`                                                                      | yes      |

Preview Playwright, cloud canary-log inspection, performance smoke, stochastic real-provider evaluation, Maestro device coverage, and Lighthouse budgets are not represented as automated CI. They require cloud accounts, preview credentials, provider decisions, or physical devices and remain explicit gates in [HUMAN_SETUP.md](../HUMAN_SETUP.md). A release may not substitute the local HTTP gate for those later milestone gates.

Production deploy: merge to main → staging checks → migration approval gate (manual) → promote. Mobile: EAS preview channel per release branch; store builds only from tagged releases.

## 4. Test inventory — unit (package-level)

`domain`: capture validation (length/empty/unicode), idempotency-key semantics, note-type rules, revision math, inverse-operation correctness for every op type (append_raw, paragraphs, list_items, log_entry, structured patch, tags, relation, toggle, field edit, item edit/remove), undo compatibility checks, local-date logic (DST spring/fall, timezone change, midnight boundary), Markdown preservation, projection determinism (property test: same `structured_data` → identical bytes), re-parse vs structure-conflict classifier, privacy filtering.

`ai-routing`: rule matching per type (prefix/phrase/alias/destination_mention) incl. normalization and priority; candidate assembly incl. private-note exclusion predicate and cap; schema parsing incl. 20+ hostile fixtures (wrong IDs, extra fields, oversized arrays, wrong enums, injection payloads); preservation heuristic; scoring feature extraction + banding incl. hard overrides and warm-up; effort-tier config mapping (asserts effort never alters schema/validation/bands); provider adapters against recorded fixtures (both providers produce identical validated plans for identical fixture responses).

`sync`: outbox state machine (pending→synced, retry/backoff, permanent failure), restart recovery, duplicate suppression, cursor monotonicity, reconciliation.

`contracts`: Zod schema round-trips, error-code table completeness, version compatibility (previous schema fixtures still parse).

## 5. Test inventory — database (SQL)

1. RLS allow + cross-user deny for every table (generated per table; a new table without tests fails CI).
2. Grant tests: telemetry/mutation/key tables reject direct client writes; `user_provider_keys` rejects client reads.
3. `notes_daily_singleton` holds under concurrent inserts (two parallel `create_capture` for same-day shopping list → one note).
4. `create_capture_with_job` atomicity + idempotent replay.
5. `apply_mutation`: stale revision rejected; success writes revision+mutation+links+event in one transaction; replay returns original.
6. `undo_mutation`: inverse restores content hash; incompatible-later-edit path.
7. `purge_expired_deleted_notes`: service-only grants, dry-run default, exact 30-day cutoff,
   owner scope, bounded batches, cross-owner fail-closed behavior, cascades, telemetry nulling,
   idempotency-snapshot removal, and purge tombstones.
8. Cascade tests: note delete removes chunks/embeddings/links/blocks; account delete leaves zero rows.
9. Export scope excludes other users; deletion reconciliation finds seeded orphans.

## 6. Test inventory — routing evaluation

Per [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §12: deterministic corpus in CI (mock), stochastic nightly (real, n=3, worst-of). Release gates: thresholds in AI spec §12.3, per `(provider, tier)` pair. Reports committed to `docs/eval-reports/` dated; a gating regression blocks merge.

## 7. Test inventory — end-to-end

Milestone B has one deterministic process-boundary suite at `.github/workflows/scripts/milestone-b-http-e2e.sh`. It runs the built web server against a freshly reset local Supabase project and verifies:

- bearer-authenticated session reads;
- manual note creation and same-key replay;
- update, stale-revision rejection, and update undo;
- creation undo as a soft-delete revision and undo-of-undo restore;
- tag create/update/association, note link create/list/delete, search, and read-only Review pagination;
- sign-out.

This is HTTP E2E, not browser E2E: it crosses the built application, route handler, authentication provider, production repository adapter, PostgREST/RPC, and PostgreSQL boundaries, but it does not claim keyboard, focus, navigation, or rendering coverage. The current production repository has no truthful in-memory server mode, and `@playwright/test` is not an installed project dependency, so a synthetic Playwright lane was deliberately not advertised.

Preview Playwright (web) and Maestro (device) remain required for the full PRODUCT_REQUIREMENTS flows. The 13 critical flows from BUILD_PLAN §18.5 plus:

- E2E-14: set BYOK key (test key against provider sandbox/mock), route a capture, verify decision telemetry shows BYOK provider; delete key; verify next capture uses app default.
- E2E-15: set expansion style `off`; verify no generated block over 20 captures.
- E2E-16: airplane-mode toggle mid-session — toggle a checkbox offline (rejected gracefully, MVP requires connection), capture offline (queued), reconnect, verify both outcomes.
- E2E-17: stale-tab conflict — edit the same note in two web tabs; second save gets conflict affordance, no silent overwrite.

Device matrix (Maestro, nightly): smallest supported iPhone + mid Android, keyboard-open capture, dynamic type at largest setting, dark mode only (MVP), VoiceOver/TalkBack smoke on capture→receipt→toggle.

## 8. Performance verification

NFR targets from PRODUCT_REQUIREMENTS §3 will be measured by Playwright traces for INP/LCP, a k6 (or equivalent) capture-endpoint smoke, and beta receipt telemetry. Those checks are not implemented by the Milestone B CI because the capture endpoint begins in Milestone C and cloud preview is HUMAN_SETUP. Until their later milestone owners automate them, record the preview measurements manually; cold starts remain separate and slow successes are never excluded from p95.

## 9. Release checklists

**Milestone B Gate 2:** recorded green for the credential-free code gate on 2026-08-30. Scoped package checks, production builds, OpenAPI freshness, a fresh database reset, warning-level database lint with zero findings, 636 pgTAP assertions, and repeated built-app HTTP E2E runs passed. Create-note undo/redo and stale-write behavior passed through the production repository path. Mobile auth, refresh recovery, and the Keychain/Keystore migration are included in the scoped coverage gate (97.25% statements, 92.35% branches, 98.52% functions, 97.82% lines). The cloud-preview browser matrix in HUMAN_SETUP remains required before a preview or public release and is not claimed as completed by this local gate.

The production dependency audit has zero high or critical advisories. One reviewed moderate advisory remains in the Expo config-plugin build chain (`xcode` → `uuid@7.0.3`) for caller-supplied buffers in UUID v3/v5/v6. Unfiled does not call those APIs, and this package is used for native project generation rather than the shipped application runtime. Track the Expo dependency for an upstream upgrade; do not force an incompatible major override into the release.

**Web/API release:** CI green including the applicable local and preview E2E lanes; migration gate approved; eval report current for active `(provider, tier)` pairs; cloud canary-log and performance checks recorded; error budget not exhausted; changelog updated; rollback = previous Vercel deployment + no destructive migration in window.

**Mobile release:** EAS build from tag; runtime env pinned; store metadata/privacy manifests current; deep links verified; upgrade test from previous build (SQLite migrations); staged rollout with crash-rate gate.

**First public beta additionally:** SECURITY_AND_PRIVACY §10 checklist complete; restore drill performed within last 30 days; support + security contact live; demo account seeded with labeled synthetic data.

## 10. Backups and restore drill

Supabase scheduled backups (verify plan tier ≥ daily + PITR if available). Quarterly drill, documented each time: restore latest backup to a scratch project, run migration-consistency check, verify fixture-user content integrity via content hashes, time the procedure, record gaps. Deletion interplay: restored data older than a user's deletion must be re-deleted by replaying the deletion audit log against the restore — tested in the drill.

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
| deletion reconciliation findings                 | any                  | —                                     |
| note-retention cron failure                      | any                  | two consecutive daily failures        |
| note-retention batch limit reached               | any                  | three consecutive daily runs          |
| per-user model call anomaly (BYOK protection)    | 3× personal baseline | 10×                                   |

Dashboards: capture funnel (received→organized/inbox/review/failed), band distribution over time, correction/undo trend, model cost per active user, sync outbox age distribution. All content-free.

## 12. Runbooks (write at Milestone G, index here)

Provider outage; queue backlog drain; stuck circuit breaker; bad deploy rollback; migration failure mid-apply; restore from backup; user data-export support request; suspected key exposure (links SECURITY_AND_PRIVACY §9).
