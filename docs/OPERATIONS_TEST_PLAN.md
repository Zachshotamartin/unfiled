# Operations and Test Plan

Environments, CI, the enumerated test inventory, release checklists, backups, and monitoring. Test IDs reference requirement IDs in [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md); commands are finalized at Milestone A bootstrap and recorded here.

## 1. Environments

| Env | Web/API | Database | AI | Secrets | Data |
| --- | --- | --- | --- | --- | --- |
| `local` | next dev / expo dev client | local Supabase (CLI) | mock model adapter default; real key opt-in | `.env.local`, never committed | seed fixtures only |
| `preview` | Vercel preview per PR | isolated Supabase branch/project | real adapter, non-prod budget, cheap tier | Vercel preview scope | synthetic only — never production data |
| `production` | protected Vercel project | protected Supabase project | evaluated config | production scope, rotation documented | real user data |

Rules: preview never points at production; the mock model adapter is deterministic (fixture-driven) so every CI run is reproducible; no test requires production credentials (Milestone A gate).

## 2. Local development

1. `pnpm install` (pinned via `packageManager`), `supabase start`, `supabase db reset` (applies all migrations + seed).
2. `pnpm dev` runs web; `pnpm dev:mobile` runs Expo dev client against local API.
3. `pnpm test` runs all package unit tests; `pnpm test:db` runs SQL/RLS tests; `pnpm eval:routing` runs the deterministic routing cases against the mock adapter.

## 3. CI pipeline (GitHub Actions, per PR)

| Stage | Contents | Blocking |
| --- | --- | --- |
| 1 static | format check, ESLint, strict `tsc` per package, package-boundary check (`domain` imports nothing platform) | yes |
| 2 unit | Vitest across packages, coverage gate ≥ 80% lines/branches on `domain`, `ai-routing`, `sync`, `contracts` | yes |
| 3 database | migrations apply from zero; SQL tests: RLS allow/deny, grants, functions, constraints | yes |
| 4 contract | shared API fixtures validated by web + mobile clients; error-code stability; OpenAPI generated and diffed | yes |
| 5 routing (deterministic) | full corpus against mock adapter: preservation, validation, banding, injection cases | yes |
| 6 build | `next build`; Expo `npx expo export` type/bundle check | yes |
| 7 e2e (web) | Playwright critical path against preview deploy + branch DB | yes |
| 8 security | gitleaks secret scan, `pnpm audit` (fail on high), canary-key log audit on E2E output | yes |
| nightly | full stochastic eval (n=3) on main; Maestro device suite on EAS build; Lighthouse budgets | report + alert |

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
7. Cascade tests: note delete removes chunks/embeddings/links/blocks; account delete leaves zero rows.
8. Export scope excludes other users; deletion reconciliation finds seeded orphans.

## 6. Test inventory — routing evaluation

Per [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §12: deterministic corpus in CI (mock), stochastic nightly (real, n=3, worst-of). Release gates: thresholds in AI spec §12.3, per `(provider, tier)` pair. Reports committed to `docs/eval-reports/` dated; a gating regression blocks merge.

## 7. Test inventory — end-to-end

Playwright (web) and Maestro (device) implement PRODUCT_REQUIREMENTS flows. The 13 critical flows from BUILD_PLAN §18.5 plus:

- E2E-14: set BYOK key (test key against provider sandbox/mock), route a capture, verify decision telemetry shows BYOK provider; delete key; verify next capture uses app default.
- E2E-15: set expansion style `off`; verify no generated block over 20 captures.
- E2E-16: airplane-mode toggle mid-session — toggle a checkbox offline (rejected gracefully, MVP requires connection), capture offline (queued), reconnect, verify both outcomes.
- E2E-17: stale-tab conflict — edit the same note in two web tabs; second save gets conflict affordance, no silent overwrite.

Device matrix (Maestro, nightly): smallest supported iPhone + mid Android, keyboard-open capture, dynamic type at largest setting, dark mode only (MVP), VoiceOver/TalkBack smoke on capture→receipt→toggle.

## 8. Performance verification

NFR targets from PRODUCT_REQUIREMENTS §3 measured by: Playwright trace for INP/LCP budgets in CI (soft-fail preview, hard-fail release); k6 (or equivalent) smoke on capture endpoint at 10 rps sustained verifying p95 and zero loss; receipt latency histogram from telemetry in beta. Cold starts tracked separately; slow successes are never excluded from p95.

## 9. Release checklists

**Web/API release:** CI green including E2E; migration gate approved; eval report current for active `(provider, tier)` pairs; error budget not exhausted; changelog updated; rollback = previous Vercel deployment + no destructive migration in window.

**Mobile release:** EAS build from tag; runtime env pinned; store metadata/privacy manifests current; deep links verified; upgrade test from previous build (SQLite migrations); staged rollout with crash-rate gate.

**First public beta additionally:** SECURITY_AND_PRIVACY §10 checklist complete; restore drill performed within last 30 days; support + security contact live; demo account seeded with labeled synthetic data.

## 10. Backups and restore drill

Supabase scheduled backups (verify plan tier ≥ daily + PITR if available). Quarterly drill, documented each time: restore latest backup to a scratch project, run migration-consistency check, verify fixture-user content integrity via content hashes, time the procedure, record gaps. Deletion interplay: restored data older than a user's deletion must be re-deleted by replaying the deletion audit log against the restore — tested in the drill.

## 11. Monitoring and alerting (initial thresholds)

| Signal | Warn | Page |
| --- | --- | --- |
| capture API error rate | > 1% over 10 min | > 5% |
| workflow queue oldest age | > 2 min | > 10 min |
| dead-letter jobs | any | > 10/hour |
| receipt p95 | > 8 s | > 20 s |
| invalid-plan rate | > 2% | > 10% |
| wrong auto-apply (from corrections on auto-band) | > 1% weekly | — (review + consider band tightening) |
| provider error rate | > 5% | circuit breaker stuck open > 15 min |
| search index lag | > 1 min | > 10 min |
| deletion reconciliation findings | any | — |
| per-user model call anomaly (BYOK protection) | 3× personal baseline | 10× |

Dashboards: capture funnel (received→organized/inbox/review/failed), band distribution over time, correction/undo trend, model cost per active user, sync outbox age distribution. All content-free.

## 12. Runbooks (write at Milestone G, index here)

Provider outage; queue backlog drain; stuck circuit breaker; bad deploy rollback; migration failure mid-apply; restore from backup; user data-export support request; suspected key exposure (links SECURITY_AND_PRIVACY §9).
