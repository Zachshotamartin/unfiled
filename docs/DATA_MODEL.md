# Data Model

The current Supabase schema has checked-in, forward-only migrations. They are the source of truth:

- [`20260830000000_initial_unfiled_schema.sql`](../supabase/migrations/20260830000000_initial_unfiled_schema.sql) creates extensions, enums, tables, indexes, and shared helpers.
- [`20260830000001_security_policies_and_capture_rpc.sql`](../supabase/migrations/20260830000001_security_policies_and_capture_rpc.sql) adds grants, RLS policies, and the atomic capture RPC.
- [`20260830000002_manual_notes_foundation.sql`](../supabase/migrations/20260830000002_manual_notes_foundation.sql) adds entity revisions, the server-only idempotency ledger, deterministic projection helpers, and immutable revision enforcement.
- [`20260830000003_manual_note_rpcs.sql`](../supabase/migrations/20260830000003_manual_note_rpcs.sql) adds atomic manual note creation and typed expected-revision mutations.
- [`20260830000004_note_history_undo.sql`](../supabase/migrations/20260830000004_note_history_undo.sql) adds inverse undo, soft-delete restore, and append-only revision restore.
- [`20260830000010_note_retention.sql`](../supabase/migrations/20260830000010_note_retention.sql) adds the bounded, service-only 30-day note-retention sweep and deletion-safe foreign-key actions.
- [`20260830000005_spaces_tags_security.sql`](../supabase/migrations/20260830000005_spaces_tags_security.sql) adds revisioned space/tag RPCs and removes direct client writes from entities and workflow tables.
- [`20260830000006_text_search_realtime.sql`](../supabase/migrations/20260830000006_text_search_realtime.sql) adds owner-scoped text search and publishes only the sync cursor to Realtime.
- [`20260830000007_structured_contract_validation.sql`](../supabase/migrations/20260830000007_structured_contract_validation.sql) enforces the frozen structured-data and typed-operation contracts, including strict ISO-offset timestamps and safe JSON-number round trips.
- [`20260830000008_conflict_reviews_and_delayed_organization.sql`](../supabase/migrations/20260830000008_conflict_reviews_and_delayed_organization.sql) commits durable structure/revision review outcomes, implements the one-replan delayed organization path, and adds contextual offset-based search.
- [`20260830000009_auth_otp_quota.sql`](../supabase/migrations/20260830000009_auth_otp_quota.sql) adds a privacy-safe, service-only rolling OTP request quota over email/IP HMAC digests.
- [`20260830000012_durable_capture_workflow.sql`](../supabase/migrations/20260830000012_durable_capture_workflow.sql) adds authenticated capture envelopes, strict deletion scrubbing, durable leases/heartbeats/recovery, content-free retry replay, receipts, and the service-only capture RPC boundary.
- [`20260830000013_organization_job_lease_privacy.sql`](../supabase/migrations/20260830000013_organization_job_lease_privacy.sql) removes direct queue reads so opaque lease and transition capabilities remain service-only.
- [`20260830000014_note_retention_workflow_lock_order.sql`](../supabase/migrations/20260830000014_note_retention_workflow_lock_order.sql) aligns note purging with the workflow lock order and converts affected receipts into bounded, non-actionable Inbox history before deleting their destinations.
- [`20260830000015_encrypted_library_expansion.sql`](../supabase/migrations/20260830000015_encrypted_library_expansion.sql) through [`20260830000020_encrypted_organizer_runtime.sql`](../supabase/migrations/20260830000020_encrypted_organizer_runtime.sql) add managed content-key custody, the typed encrypted aggregate, private RAG generations/jobs, queue liveness, canonical generation verification, and the historical eight-RPC organizer base.
- [`20260830000021_encrypted_only_cutover.sql`](../supabase/migrations/20260830000021_encrypted_only_cutover.sql) through [`20260830000026_encrypted_owner_export_and_deletion.sql`](../supabase/migrations/20260830000026_encrypted_owner_export_and_deletion.sql) add encrypted-only rollout, capture/taxonomy commands, retention, multi-note undo, owner export, and account deletion.
- [`20260830000027_encrypted_storage_contract.sql`](../supabase/migrations/20260830000027_encrypted_storage_contract.sql) installs the expand-compatible readiness/receipt control plane and the explicit database-owner/digest-bound operation that atomically removes the plaintext rollback contract.
- [`20260901000000_milestone_d_organizer_retrieval.sql`](../supabase/migrations/20260901000000_milestone_d_organizer_retrieval.sql) adds the two lease-bound encrypted retrieval RPCs, widens the organizer claim with authenticated capture/timing/routing context, and makes the current organizer database boundary ten RPCs.
- [`20260901000001_milestone_e0_interaction_contracts.sql`](../supabase/migrations/20260901000001_milestone_e0_interaction_contracts.sql) adds the shared Milestone E lifecycle, immutable settings snapshots, Vault-only metadata constraints, and typed interaction contract foundation without adding public E feature RPCs.
- [`20260901000002_encrypted_decision_corrections.sql`](../supabase/migrations/20260901000002_encrypted_decision_corrections.sql) implements E1 owner-authorized encrypted decision correction, Review resolution, server-derived mutation-batch discovery, all-or-nothing batch Undo, and the attested upgrade-only organizer-receipt timestamp projection repair.
- [`20260901000003_encrypted_routing_rules_and_personalization.sql`](../supabase/migrations/20260901000003_encrypted_routing_rules_and_personalization.sql) implements E2 encrypted routing-rule CRUD, learned-proposal observations, owner-wide observation serialization, replay-safe claims, content-free capture/job match snapshots, and organizer destination revalidation.
- [`20260901000004_encrypted_generated_blocks_and_duplicate_suggestions.sql`](../supabase/migrations/20260901000004_encrypted_generated_blocks_and_duplicate_suggestions.sql) implements E3 atomic encrypted generated-block/Review publication, owner-and-note-scoped generated-block keyset reads, non-destructive duplicate suggestions, replay-safe generated-block resolution, and seven-day rejected-block cleanup through the existing encrypted-retention capability.
- [`20260901000005_vault_byok_and_ai_settings.sql`](../supabase/migrations/20260901000005_vault_byok_and_ai_settings.sql) implements E4 owner AI settings, Vault-only OpenAI credential CRUD, replay receipts and monotonic credential revisions, lease-bound organizer credential resolution, exact-revision invalidation/fallback, and the organizer's sole eleventh RPC.

This document remains the readable schema reference and must change in the same change set as future migrations. If prose or an illustrative DDL excerpt differs from a migration, the migration wins.

**Status boundary:** C.5a–d implement the encrypted note/search overlay and the explicit plaintext-storage contract; Milestone D adds the checked-in lease-bound organizer retrieval path; and Milestone E0–E4 add the shared interaction foundation, encrypted correction/Review/batch Undo, encrypted routing-rule personalization, separately encrypted generated blocks, non-destructive duplicate suggestions, immutable AI settings, Vault-only OpenAI BYOK, and live-lease credential resolution. E2's credential-free aggregate/HTTP/PR-CI gate is green. E3's credential-free local database and built-local HTTP gates plus PR #16's required CI lanes are green; its deployed canary remains pending. E4's credential-free local database and built-local B–E4 HTTP gates are green, its independent final audit is clear, and PR #17's required CI lanes are green. Milestone F is implemented on the current branch with its one-use semantic-search capability records, encrypted note-context projections, and account export/deletion changes; final local/audit/PR evidence is still in progress. Milestone G has not started. Migration 27 is expand-compatible when installed, so a hosted database retains its pre-contract rollback columns until the separately approved operator call commits. Sections 2.1–2.3 describe the contracted target and checked-in implementation; they are local code evidence, not proof that Production has applied the contract, exercised live provider/Vault/KMS/database identities, or aged out exposed backups. The E4 database evidence is a clean reset with 39 pgTAP files / 1,901 assertions, focused `092` at 65/65, combined `087` + `092` at 148/148, zero lint findings, and local `Accept-Profile: vault` / `Content-Profile: vault` REST probes rejected with `406 PGRST106`. Production BYOK and semantic search remain disabled until their separate deployed account/provider/canary/backup gates pass.

Related: [BUILD_PLAN.md](./BUILD_PLAN.md) §12, [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) for RLS strategy and retention.

## 1. Conventions

- IDs: `text` primary keys with typed prefixes over ULIDs — `note_`, `cap_`, `spc_`, `rev_`, `mut_`, `dec_`, `job_`, `rule_`, `rvw_`, `blk_`, `tag_`, `lnk_`, `chk_`, `fbk_`, `key_`. Client-generated only for `captures.id`; all others server-generated.
- Every user-owned table: `user_id uuid not null references auth.users(id) on delete cascade`, `created_at timestamptz not null default now()`; mutable tables add `updated_at` maintained by trigger.
- Soft delete via `deleted_at timestamptz`; hard delete per retention schedule (§7).
- User write RPCs use one global `(user_id, idempotency_key)` namespace. A replay with equivalent canonical input returns the stored response; reusing a key for a different request raises `invalid_idempotency_key`.
- Notes, spaces, and tags expose `current_revision`. Mutable write RPCs lock the owned row and require an exact expected revision, returning `stale_revision` before any entity, history, receipt, or event state commits. Creation returns revision 1.
- All enums are PostgreSQL enum types; adding a value is a migration.
- Current extensions: `pg_trgm`, `vector`, `pgcrypto`. C.5 removes persisted plaintext FTS/vector use; an installed extension is not an accepted storage path, and future plaintext-vector use requires a new ADR.

```sql
create type note_type as enum ('generic','list','log','principle','project');
create type capture_status as enum ('pending','queued','processing','organized','inbox','needs_review','failed','deleted');
create type capture_source as enum ('mobile','web','ios_lock_screen_widget','share_sheet','import');
create type privacy_mode as enum ('ai_assisted','private_manual');
create type org_mode as enum ('cautious','balanced','automatic');
create type job_state as enum ('created','running','awaiting_retry','succeeded','failed','dead_letter');
create type behavior_band as enum ('auto','review','inbox');
create type revision_source as enum ('manual','organization','undo','import','interactive');
create type rule_type as enum ('prefix','phrase','alias','destination_mention');
create type rule_source as enum ('explicit','correction_suggested');
create type review_type as enum ('low_confidence','revision_conflict','failed_job','duplicate_suggestion','pending_expansion','structure_conflict');
create type review_state as enum ('open','resolved','dismissed');
create type block_state as enum ('proposed','accepted','rejected');
create type block_kind as enum ('summary','interpretation','suggestion','label');
create type link_type as enum ('reference','related');
create type link_source as enum ('manual','organization');
create type feedback_action as enum ('accepted','moved','undone','expansion_accepted','expansion_rejected','rule_created','review_resolved');
create type ai_provider as enum ('openai','anthropic');
create type provider_mode as enum ('app_default','byok');
create type routing_effort as enum ('economical','standard','thorough');
create type expansion_style as enum ('off','brief','detailed');
create type key_status as enum ('active','invalid','revoked');
create type safe_error_code as enum (
  'account_deletion_failed','budget_exhausted','capture_too_long',
  'conflict_requires_review','forbidden','invalid_capture',
  'invalid_idempotency_key','invalid_plan','not_found','offline',
  'provider_key_invalid','provider_unavailable','rate_limited',
  'stale_revision','structure_conflict','unauthorized','validation_failed'
);
```

## 2. Tables

The following excerpt describes the current checked-in schema, including legacy plaintext note/search columns that C.5 must remove after verified cutover.

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  timezone text not null default 'UTC',
  locale text not null default 'en-US',
  org_mode org_mode not null default 'balanced',
  expansion_enabled boolean not null default true,
  provider_mode provider_mode not null default 'app_default',
  byok_provider ai_provider,
  byok_fallback_to_app boolean not null default false,
  routing_effort routing_effort not null default 'standard',
  expansion_style expansion_style not null default 'brief',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_provider_keys (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider ai_provider not null,
  vault_secret_id uuid,                -- Supabase Vault reference (E4 accepted mechanism)
  key_ciphertext text,                 -- legacy placeholder; forbidden for product use and removed/constrained by E4
  key_last4 text not null check (char_length(key_last4) = 4),
  status key_status not null default 'active',
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider),
  check (vault_secret_id is not null or key_ciphertext is not null)
);

create table spaces (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id text references spaces(id),
  name text not null check (char_length(name) between 1 and 60),
  slug text not null,
  sort_key text not null default 'a0',
  current_revision integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
-- Reviewed RPCs allow one nesting level: a parent must itself be a root.

create table notes (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  space_id text references spaces(id),
  type note_type not null,
  title text not null check (char_length(title) between 1 and 200),
  body_markdown text not null default '' check (char_length(body_markdown) <= 200000),
  structured_data jsonb not null default '{}'::jsonb,
  current_revision integer not null default 1,
  daily_date date,                 -- local date for daily notes, else null
  is_open boolean not null default true,   -- lists and projects
  pinned_at timestamptz,
  privacy privacy_mode not null default 'ai_assisted',
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index notes_daily_singleton
  on notes (user_id, space_id, type, daily_date)
  nulls not distinct
  where daily_date is not null and deleted_at is null;
create index notes_fts on notes
  using gin (to_tsvector('simple', title || ' ' || body_markdown));
create index notes_title_trgm on notes using gin (title gin_trgm_ops);
create index notes_user_active on notes (user_id, updated_at desc)
  where deleted_at is null and archived_at is null;

create table note_revisions (
  id text primary key,
  note_id text not null references notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null,
  source revision_source not null,
  space_id text,
  type note_type not null,
  title text not null,
  body_markdown text not null,
  structured_data jsonb not null,
  is_open boolean not null,
  pinned_at timestamptz,
  privacy privacy_mode not null,
  archived_at timestamptz,
  deleted_at timestamptz,
  tag_ids jsonb not null default '[]'::jsonb,
  links jsonb not null default '[]'::jsonb,
  content_hash text not null,          -- sha256 of canonical serialization
  actor text not null,                 -- 'user:<device>' | 'organization:<jobId>' | 'undo:<mutId>'
  mutation_id text,
  created_at timestamptz not null default now(),
  unique (note_id, revision)
);
-- Full immutable canonical snapshots in MVP, including relations and lifecycle
-- fields; restoring history always appends a new revision.

create table captures (
  id text primary key,                 -- client ULID; doubles as idempotency key
  user_id uuid not null references auth.users(id) on delete cascade,
  source capture_source not null,
  device_id text not null default '',
  raw_text text not null,               -- `[encrypted]` or `[deleted]`; never content
  content_envelope jsonb,
  content_fingerprint text,             -- keyed server HMAC; never a raw content hash
  content_length integer,
  privacy privacy_mode not null default 'ai_assisted',
  explicit_destination_note_id text references notes(id),
  expansion_disabled boolean not null default false,
  client_created_at timestamptz not null,
  client_timezone text not null,
  received_at timestamptz not null default now(),
  status capture_status not null default 'pending',
  last_error_code safe_error_code,
  deleted_at timestamptz,
  check (
    (deleted_at is null and status <> 'deleted' and raw_text = '[encrypted]'
      and content_envelope is not null
      and content_fingerprint ~ '^[0-9a-f]{64}$'
      and content_length between 1 and 10000)
    or
    (deleted_at is not null and status = 'deleted' and raw_text = '[deleted]'
      and content_envelope is null and content_fingerprint is null
      and content_length is null)
  )
);
create index captures_user_day on captures (user_id, received_at desc);
create index captures_inbox on captures (user_id) where status = 'inbox';

create table organization_jobs (
  id text primary key,
  capture_id text not null references captures(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state job_state not null default 'created',
  attempt integer not null default 0 check (attempt <= 5),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  last_transition_lease_token uuid,
  last_transition_action text,
  last_transition_request_hash text,
  workflow_provider_id text,
  prompt_version text not null,
  schema_version integer not null,
  model_id text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code safe_error_code,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (capture_id)                  -- one job per capture; retries reuse the row
);

create table capture_receipts (
  capture_id text primary key references captures(id) on delete cascade,
  job_id text not null unique references organization_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references organization_decisions(id),
  review_item_id text references review_items(id) on delete set null,
  mutation_id text references note_mutations(id) on delete set null,
  outcome text not null,
  headline text not null,              -- bounded generic copy, never captured text
  destination_note_id text references notes(id) on delete set null,
  inserted_content jsonb not null default '[]'::jsonb, -- C.5 encrypts this content-bearing field
  actions jsonb not null default '[]'::jsonb,
  reason_codes text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table organization_decisions (
  id text primary key,
  capture_id text not null references captures(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_manifest jsonb not null,   -- ids + metadata only, never bodies
  signals jsonb not null,              -- deterministic feature values
  validated_plan jsonb,                -- null when validation failed
  band behavior_band not null,
  score numeric(4,3),
  margin numeric(4,3),
  destination_note_id text references notes(id),
  reason_codes text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table note_mutations (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references organization_decisions(id),  -- null for user-initiated typed ops
  note_id text not null references notes(id) on delete cascade,
  idempotency_key text not null,
  before_revision integer not null,
  after_revision integer not null,
  operations jsonb not null,           -- applied typed operations
  inverse jsonb not null,              -- inverse ops or before-snapshot ref
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table generated_blocks (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null references notes(id) on delete cascade,
  decision_id text not null references organization_decisions(id),
  kind block_kind not null,
  content text not null check (char_length(content) <= 600),
  state block_state not null default 'proposed',
  model_id text not null,
  prompt_version text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table capture_note_links (
  capture_id text not null references captures(id) on delete cascade,
  note_id text not null references notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null references note_mutations(id),
  relation text not null default 'routed',   -- routed | source_removed
  inserted_item_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (capture_id, note_id, mutation_id)
);

create table routing_rules (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  rule_type rule_type not null,
  condition_normalized text not null,
  destination_note_id text references notes(id),
  destination_space_id text references spaces(id),
  priority integer not null default 100,
  source rule_source not null,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (destination_note_id is not null or destination_space_id is not null)
);

create table review_items (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_id text references captures(id) on delete cascade,
  note_id text references notes(id) on delete cascade,   -- structure conflicts
  type review_type not null,
  choices jsonb not null default '[]'::jsonb,            -- suggested destinations
  state review_state not null default 'open',
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Legacy current table: removed by the C.5 contract migration.
create table note_chunks (
  id text primary key,
  note_id text not null references notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null,
  ordinal integer not null,
  text_hash text not null,
  content text not null,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector(1536),              -- null for private notes; dim per chosen model
  created_at timestamptz not null default now(),
  unique (note_id, revision, ordinal)
);
create index note_chunks_fts on note_chunks using gin (fts);
-- No vector index is accepted for this plaintext table. ADR-0006 selects an
-- encrypted exact per-user retrieval path.

create table tags (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  current_revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)               -- name stored normalized lowercase
);

create table note_tags (
  note_id text not null references notes(id) on delete cascade,
  tag_id text not null references tags(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source link_source not null default 'manual',
  mutation_id text references note_mutations(id),
  created_at timestamptz not null default now(),
  primary key (note_id, tag_id)
);

create table note_links (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_note_id text not null references notes(id) on delete cascade,
  to_note_id text not null references notes(id) on delete cascade,
  link_type link_type not null default 'reference',
  source link_source not null default 'manual',
  mutation_id text references note_mutations(id),
  created_at timestamptz not null default now(),
  unique (from_note_id, to_note_id, link_type)
);

create table feedback_events (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references organization_decisions(id),
  action feedback_action not null,
  old_destination_note_id text references notes(id),
  new_destination_note_id text references notes(id),
  reason_code text,
  created_at timestamptz not null default now()
);

create table api_idempotency_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  scope text not null,
  request_hash text not null,             -- sha256 of canonical JSON input
  response_json jsonb,                    -- set only after the transaction succeeds
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, idempotency_key)
);
-- Server-only: authenticated and anon have no grants and no policies.

create table organization_mutation_attempts (
  job_id text not null references organization_jobs(id) on delete cascade,
  note_id text not null references notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  planned_revision integer not null,
  replan_count integer not null default 0 check (replan_count between 0 and 1),
  operations jsonb not null,
  state text not null check (state in ('replanned','applied','needs_review')),
  review_item_id text references review_items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, note_id)
);

create table auth_otp_quota_events (
  id bigint generated always as identity primary key,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default now()
);
-- Hash-only, force-RLS service state. No table role, including service_role,
-- receives direct grants; the reviewed quota function is the only write path.
```

Milestone C capture clients have no direct table privileges and cannot invoke the storage RPCs. The authenticated Next API derives the owner from the verified session, then calls service-only RPCs with that owner identifier. Those RPCs enforce owner predicates before returning an envelope to the server decryptor; the product API returns only authenticated plaintext DTOs and strips the envelope, fingerprint, and key identifier. Job claim, heartbeat, completion, failure, and recovery functions are also service-only. A claimed job uses `FOR UPDATE SKIP LOCKED`, a bounded lease token, at most five attempts, and replay-safe terminal transitions.

### 2.1 Milestone C.5 encrypted overlay (implemented; Production contraction pending)

`ContentEnvelopeV1` is a strictly validated JSON/column group containing cipher/version, content ciphertext + nonce, wrapped DEK + nonce, and wrapping-key ID. Its authenticated context is supplied externally and binds `{user_id, resource_id, record_version, content_kind}`. The target keeps ownership, foreign keys, revision counters, privacy, lifecycle timestamps, queue state, and other bounded operational metadata plaintext. Object sizes, types, timestamps, opaque graph relationships, and access patterns therefore remain visible.

The contract migration replaces these content-bearing fields; it does not merely add database-at-rest encryption:

| Current table                    | C.5 encrypted field(s) / replacement                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `spaces`, `tags`                 | display name/slug in `display_envelope`; user-scoped keyed MAC only where uniqueness is required                    |
| `notes`                          | title, body, and structured data in `content_envelope`                                                              |
| `note_revisions`                 | full immutable content/relations snapshot in `snapshot_envelope`; unkeyed `content_hash` removed or replaced by MAC |
| `captures`                       | authenticated capture envelope already introduced by Milestone C; no raw-text compatibility value is user content   |
| `organization_decisions`         | candidate manifest, signals, and validated plan in `decision_envelope`                                              |
| `note_mutations`                 | typed operations and inverse/before snapshot in `mutation_envelope`                                                 |
| `generated_blocks`               | generated text in `content_envelope`                                                                                |
| `review_items`                   | choices and resolution in `review_envelope`                                                                         |
| `routing_rules`                  | normalized condition/alias in `condition_envelope`; rules are decrypted as a bounded per-user set                   |
| `organization_mutation_attempts` | planned operations in `attempt_envelope`                                                                            |
| `api_idempotency_records`        | stable keyed request MAC plus `response_envelope`; no plaintext content response                                    |
| `note_chunks`                    | removed, along with its content, `tsvector`, unkeyed hash, and vector columns                                       |

Production key metadata is service-only:

```sql
-- Conceptual target; the implementing migration is authoritative.
create table user_content_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  key_class text not null check (key_class in ('ai_assisted','private_manual')),
  key_version integer not null,
  kms_key_id text not null,
  wrapped_intermediate_key bytea not null,
  state text not null check (state in ('active','retiring','retired','revoked')),
  created_at timestamptz not null default now(),
  primary key (user_id, key_class, key_version)
);
```

The excerpt above remains faithful to the initial migration, but its `key_ciphertext` alternative is not an accepted shipping path. [ADR-0012](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md) supersedes the application-ciphertext fallback. Shared E0 migration `20260901000001_milestone_e0_interaction_contracts.sql` fails closed if any legacy ciphertext remains, requires a Vault locator with null application ciphertext, and installs monotonic settings and credential revisions. It never erases a legacy credential based only on an unverified UUID. E4 migration `20260901000005_vault_byok_and_ai_settings.sql` adds the exact owner CRUD and lease-bound credential capabilities, permanently enforces Vault-only OpenAI state, and aborts rather than silently normalizing unsupported legacy credentials. The table remains directly unreachable from product clients and isolated workloads; production BYOK remains disabled until deployed Vault custody evidence passes.

The KMS root is not stored here. A wrapped intermediate key copied into a backup can remain decryptable under the retained shared root, so deleting the live row is not immediate backup erasure.

The accepted retrieval target stores no plaintext tokens, snippets, `tsvector`, or vectors:

```sql
create table rag_index_generations (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  embedding_model_id text not null,
  state text not null check (state in ('building','active','retired','failed')),
  expected_note_count integer not null default 0,
  indexed_note_count integer not null default 0,
  revision_token bigint not null default 0,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
-- A partial unique index permits at most one active generation per user.

create table note_rag_index (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null references notes(id) on delete cascade,
  generation_id text not null references rag_index_generations(id) on delete cascade,
  indexed_revision integer not null,
  index_envelope jsonb not null, -- lexical features, headings, snippet, bounded embeddings
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, generation_id)
);

create table note_index_jobs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null references notes(id) on delete cascade,
  generation_id text not null references rag_index_generations(id) on delete cascade,
  target_revision integer not null,
  state text not null check (state in ('queued','leased','succeeded','failed')),
  attempt integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, generation_id, target_revision)
);
```

Only current, non-deleted `ai_assisted` notes can be claimed or committed by the index worker. A note mutation enqueues the target revision atomically. Query joins the active generation to the current note row and requires equal revisions; a privacy flip or delete makes a row ineligible before asynchronous cleanup. Generation activation requires exact verified coverage. More detail, including the bounded stale repair path, is in [AI_ROUTING_SPEC.md](./AI_ROUTING_SPEC.md) §4.1.

### 2.2 Milestone D–E4 organizer retrieval and credential boundary

Milestone D established ten public RPCs for the `unfiled_organizer_worker` database identity; E4 adds only the eleventh listed below:

1. `claim_encrypted_organizer_jobs`
2. `heartbeat_encrypted_organizer_job`
3. `list_encrypted_organizer_candidates`
4. `prepare_encrypted_organizer_create`
5. `prepare_encrypted_organizer_append`
6. `commit_encrypted_organizer_job`
7. `fail_encrypted_organizer_job`
8. `recover_stale_encrypted_organizer_jobs`
9. `list_encrypted_organizer_rag_page`
10. `select_encrypted_organizer_candidates`
11. `get_lease_bound_organizer_provider_credential`

The two Milestone D additions accept a job ID and lease token, never an owner ID. `list_encrypted_organizer_rag_page` revalidates the live disclosure lease, derives the owner from the locked job, and pages only that owner's active encrypted index through the reviewed exact-scan path. The organizer decrypts and ranks those index records within its AI-only key boundary, then submits an ordered selection of one to eight `{noteId,indexedRevision}` pairs with the active generation ID and revision token. `select_encrypted_organizer_candidates` revalidates the lease, active-generation attestation, complete current coverage, absence of queued/leased index work, note privacy/lifecycle, current note revision, key record, and an 8 MiB aggregate-envelope budget before returning the selected encrypted note aggregates. It records the content-free controls and candidate manifest used by the existing heartbeat/prepare/commit revalidation fence. E4's eleventh RPC likewise accepts only job ID and live lease token, derives owner/provider/settings from the immutable job, and returns one current credential source/revision; it cannot enumerate owners, metadata, Vault locators, or arbitrary secrets.

Milestone D also extends the claim projection with the source capture's content MAC and MAC-key record plus database-owned occurrence time, timezone, account capture ordinal, routing mode, and exact command projection (`legacy` or `encrypted_only`). The database selects `encrypted_only` as soon as a plaintext scrub exists or the rollout reaches `encrypted_only`/`contracted`; the organizer cannot infer it from a stale rollout label. The encrypted capture and note envelopes remain opaque to PostgreSQL and to the web caller; only the isolated organizer receives AI-assisted object-wrap/content-MAC material. The original bounded candidate RPC remains the explicit-destination and degraded fallback, now with the same complete relational metadata needed to build an append snapshot.

At the historical Milestone D boundary, a model-returned `generatedExpansion` was discarded. E3 now extends organizer preparation/commit to reserve, seal, and atomically publish a separate `proposed` generated block plus its encrypted pending-expansion Review.

### 2.3 Milestone E encrypted-interaction boundary

[ADR-0011](./decisions/ADR-0011-encrypted-owner-interactions-and-personal-rules.md) and [ADR-0012](./decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md) freeze migration ownership and public function names. E0 is the shared structural foundation and E1–E4 are implemented. This table prevents parallel lanes from choosing overlapping timestamps or generic capabilities.

| Lane | Status      | Assigned migration                                                        | Exact function ownership                                                                                                                                                                                                                 |
| ---- | ----------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0   | Implemented | `20260901000001_milestone_e0_interaction_contracts.sql`                   | None; shared revision, lifecycle, Vault-only metadata, immutable settings-snapshot, and service-only evidence structures                                                                                                                 |
| E1   | Implemented | `20260901000002_encrypted_decision_corrections.sql`                       | `prepare_encrypted_decision_correction`, `commit_encrypted_decision_correction`, `prepare_encrypted_review_resolution`, `commit_encrypted_review_resolution`, `get_encrypted_mutation_batch`, `undo_encrypted_mutation_batch`            |
| E2   | Implemented | `20260901000003_encrypted_routing_rules_and_personalization.sql`          | Exactly five service-only RPCs: `get_encrypted_routing_rule_observation_epoch`, `get_encrypted_routing_rule_write_claim`, `prepare_encrypted_routing_rule_write`, `commit_encrypted_routing_rule_write`, `delete_encrypted_routing_rule` |
| E3   | Implemented | `20260901000004_encrypted_generated_blocks_and_duplicate_suggestions.sql` | extend `prepare_encrypted_organizer_create`, `prepare_encrypted_organizer_append`, and `commit_encrypted_organizer_job`; add only `resolve_encrypted_generated_block`                                                                    |
| E4   | Implemented | `20260901000005_vault_byok_and_ai_settings.sql`                           | `get_owner_ai_settings`, `update_owner_ai_settings`, `get_user_provider_key_status`, `put_user_provider_key`, `delete_user_provider_key`, `get_lease_bound_organizer_provider_credential`                                                |

Timestamps `20260901000001` through `20260901000005` are implemented by E0 through E4. None of the assigned timestamps or names may be reused or replaced with a generic table gateway, arbitrary Vault getter, or caller-owner function.

E2's two getters expose operational coordinates, not rule content. `get_encrypted_routing_rule_write_claim` binds a retry to the original owner/idempotency claim, operation scope, rule and revision coordinates, request-MAC key coordinates, and an opaque encrypted response when already complete. It makes update and learned-offer acceptance replay unambiguous after current rule state changes. `get_encrypted_routing_rule_observation_epoch` exposes only a monotonic owner-wide epoch; learned prepare records the expected epoch, successful commit advances it, and a distinct stale correction must reread, decrypt, and replan instead of creating a second proposal. Neither getter stores or returns a plaintext condition, alias, sample capture, normalized condition, deterministic equality token, or condition hash.

E2 adds `routing_rule_proposal_observations`, `routing_rule_observation_epochs`, and `encrypted_routing_rule_write_claims`. Observation rows bind one feedback event to one learned rule and prevent double counting. The per-owner epoch serializes the read/decrypt/plan/commit split without exposing condition equality. Write claims bind the global idempotency namespace to operation scope, stable rule ID, public and condition revisions, optional expected epoch, exact request-MAC key coordinates, and the encrypted completed response. All three tables are force-RLS, have no direct runtime table grants, and are accessed only through the reviewed functions. A stale unfinished observation claim burns its exact grouped wrap reservation before replacement and leaves only a content-free authenticated abandonment tombstone.

The proposal lifecycle is `observing → offered → accepted` or `observing/offered → declined`, with `enabled = false` required until acceptance. Explicit rules have no proposal state. Owner-visible reads expose explicit, offered, and accepted rules; observing and declined learned state remains hidden. An offered delete records decline for durable suppression, while explicit and accepted deletion removes the rule aggregate. Conditions, canonical text, aliases, and learned examples remain inside the `private_manual` condition envelope. The frozen canonical form rejects raw input over 500 UTF-16 units, trims/collapses only Unicode `White_Space`, applies NFKC and locale-independent lowercase, strips trailing punctuation/whitespace, and requires 1–500 UTF-16 units after normalization. U+0085 is whitespace; U+FEFF is not.

The fixed capacity contract is 1,000 retained rules, 256 active owner-confirmed rules, and 8 MiB of decrypted active-rule payload per match. Owner-visible API reads use stable cursor pages of at most 50 DTOs and 8 MiB. The clients traverse at most the 1,000 retained records and reject duplicate IDs or cursors. These bounds are application and database invariants, not environment settings.

E1 prepare calls claim the owner/idempotency key, validate current decision/Review/mutation references and expected revisions, create stable identities, and issue exact wrap reservations. Correction prepare returns mutually exclusive `applied` and `needs_review` plans because exact safety is known only after owner-authorized decryption. The web service authenticates the encrypted source capture, derives all result snapshots, seals exactly one branch, self-verifies it, and submits a canonical request MAC. Commit locks every affected note in ascending note-ID order, validates the complete set before its first write, consumes the selected reservations, invalidates unused sibling reservations, and publishes the selected revisions, mutations, one shared feedback event, Review/receipt state, cursor events, and index jobs atomically. Both sides of a two-note correction reference that one feedback-event ID. A correction removes old content only through the original mutation's exact compatible inverse and applies the authenticated source contribution to the destination; otherwise neither note changes, encrypted Review is created, and the receipt becomes `needs_review`. That fallback remains bound to the authenticated source decision and capture, so it may resolve through `route`, `create`, `keep_inbox`, or `dismiss`.

`get_encrypted_mutation_batch` accepts one anchor mutation but derives both the canonical anchor and the complete bounded 1–16-note membership from server history; a caller cannot choose, omit, or substitute hidden members. A grouped non-anchor member is rejected, and an Undo-generated batch is terminal: none of its generated mutations can become a new batch-Undo anchor. `undo_encrypted_mutation_batch` applies every exact inverse or changes no note. Its unsafe branch persists an owner-bound encrypted `revision_conflict` Review with no decision lineage, permits only `keep_inbox` or `dismiss`, and returns the typed private conflict boundary. Receipts, Review payloads, mutation snapshots, and idempotency responses remain encrypted and owner-bound on both branches.

The E1 upgrade also repairs only the relational `capture_receipts.created_at` projection for legacy organizer receipts whose authenticated payload already used the source capture occurrence time. The private migration function requires the exact same-owner job/capture/preparation, completed transition and reservation, valid envelope, and matching verification digest before changing a row. It copies authoritative `captures.client_created_at` without changing the receipt ciphertext, revision, or verification record, re-enables the ordinary encrypted-write guard, and fails the upgrade on unattested or incomplete state. Runtime roles cannot execute it, and a completed repair replays as zero changes.

E2 stores every condition/alias under the private-manual key class. The owner-authorized web process evaluates plaintext and binds only `{ruleId, ruleRevision, destinationKind, destinationId, priority, matched}` to the capture/job. The organizer never receives rule text or private key material. Learned rules remain disabled proposals until explicit owner confirmation.

The immutable job snapshot is inserted only for an `ai_assisted` capture without an explicit destination and is checked under the owner routing-rule lock against the exact enabled explicit/accepted rule, revision, priority, and destination. `last_fired_at` advances without changing the rule CAS revision or command `updated_at`. Private-manual captures and explicit-destination captures cannot carry a rule snapshot. Organizer candidate reads and commit revalidate the snapshot and destination lifecycle; missing, closed, archived, deleted, private, incompatible, ambiguous, or stale destinations fail to Review rather than being silently rerouted.

E3 freezes `organization_jobs.model_id` as immutable provenance and extends the existing organizer preparation/commit shapes without adding an organizer capability. An applied create or append may atomically publish one separate AI-assisted encrypted `proposed` block and one encrypted pending-expansion Review; the generated bytes never enter the note envelope or its structured data. Duplicate suspicions publish only an encrypted Review with a bounded explanation and two or three distinct, current, authorized note/revision choices.

The service-only generated-block list overload is scoped by both owner and note. Its partial index and query exclude `rejected` rows and rows without a content envelope before applying the ascending block-ID cursor and limit. The server requests 51 eligible rows, returns at most 50, and derives `hasMore` plus `nextCursor` from that lookahead, so a rejected block never consumes a visible slot or hides an eligible continuation row. The exact authenticated block read used by Review also binds the expected note and returns no rejected block. Public list/detail schemas therefore admit only `proposed` and `accepted`; the resolution response may still carry the terminal rejected transition without making that block publicly readable afterward.

`resolve_encrypted_generated_block` is the sole new public E3 resolver and the only accept/reject commit path. It consumes the E1 owner-interaction preparation, enforces the block/Review/receipt envelope digests and block state revision, advances the block from `proposed` to `accepted` or `rejected`, resolves the Review, writes encrypted replay/receipt evidence and one feedback event, and leaves the note envelope and revision untouched. The generic Review commit cannot bypass it. `Keep both` and `Dismiss` resolve duplicate Review metadata only; neither path can merge, delete, archive, rewrite, or redirect a note. The organizer remains at exactly ten public RPCs through E3.

E0 writes an immutable non-secret settings snapshot when a capture/job is accepted. It includes organization mode, provider mode/provider, effort, expansion style, explicit fallback, registry version, and settings revision, but no provider key, credential revision, Vault ID, authorization header, ciphertext, or wrapping material. E4 implements the owner settings/provider-key capabilities and `get_lease_bound_organizer_provider_credential`, which derives the owner/provider from one live job lease and returns exactly one current active Vault credential to the organizer. The organizer allowlist is therefore exactly eleven functions after E4.

E4 keeps replay and lease evidence in force-RLS private tables that contain only content-free operation scope, revisions, source state, timestamps, and safe response JSON. `put_user_provider_key` has an explicit replay-only mode used before any external validation. If a receipt exists, it requires the current metadata row and credential revision to match the receipt, retrieves the current Vault value inside the security-definer transaction, compares the submitted key exactly in transient memory, and returns the original safe response only on equality. It stores no secret-derived hash or fingerprint. Missing live secret/revision drift fails closed, a changed secret raises `invalid_idempotency_key`, and only a replay miss permits the web boundary to validate externally and invoke the normal atomic Vault create/replace path. Deletion atomically destroys the live Vault secret and binding. Lease resolution records one source/revision per job lease so a retry cannot switch credentials; exact-revision 401/403 invalidation and an explicitly snapshotted one-time app-default fallback are bound to that disclosed source.

The credential-free E4 local evidence is green: a clean reset passed 39 pgTAP files / 1,901 assertions, focused `092` passed 65/65, combined `087` + `092` passed 148/148, database lint returned zero findings, and local service-key requests using both Vault profile headers failed closed with `406 PGRST106`. The built-local B–E4 HTTP suite passed replay/CAS, external-validator accounting, secret-free snapshot, live-lease, delete/recreate ABA, and canary checks. Web passed 97 files / 827 tests; organizer 19 / 314; API client 4 / 38; contracts 7 / 55; encrypted aggregate 8 / 144; AI routing 11 / 79; and Swift 181/181. Workspace lint/typecheck/coverage passed 26/26, build passed 16/16, all three built-server smokes and focused configuration 35/35 passed, boundaries/OpenAPI were green, routing passed 175/175, the pipeline passed 15/15 with `liveProviderEvidence=false`, verifier capacity passed 1/1, retrieval recorded cold p95 392.80 ms and warm p95 12.98 ms, and the dependency audit found no known vulnerabilities. The independent final audit is clear, and PR #17's required CI lanes are green. These are local credential-free results, not deployed Vault/provider/account/canary/backup, production, Apple-hardware, or E2EE evidence.

## 3. Row Level Security

Every table above enables RLS. Entity and workflow reads are owner-filtered; client writes do not have table grants or write policies. `notes` is representative:

```sql
alter table notes enable row level security;
create policy notes_select on notes for select using (user_id = auth.uid());
revoke insert, update, delete on notes from authenticated;
```

Deviations from the template:

- `profiles`: `id = auth.uid()` instead of `user_id`.
- `spaces`, `notes`, `note_revisions`, `tags`, `note_tags`, and `note_links`: owner-scoped `select`; all writes happen through the reviewed Milestone B functions below. Revision snapshots cannot be updated even through a privileged accidental path because an immutable-history trigger rejects updates.
- `captures`: no direct client table privileges and no client-callable storage RPCs. The verified Next API calls service-only functions with its authenticated owner ID; every function repeats the owner predicate before reading or mutating a row.
- `organization_jobs`: service-only. Rows contain opaque worker lease and transition capabilities; clients receive only reviewed capture-state projections from the authenticated server API.
- `organization_decisions`, `note_mutations`, `generated_blocks`, `capture_note_links`, `routing_rules`, `review_items`, legacy `note_chunks`, `feedback_events`, `user_events`, and `organization_mutation_attempts`: owner-scoped `select` only; writes happen exclusively through reviewed functions or the service role inside the workflow, so clients cannot forge decisions, mutations, retries, or cursor events.
- C.5 `user_content_keys`, `rag_index_generations`, `note_rag_index`, and `note_index_jobs`: no direct client access. Reviewed owner-authorized services return decrypted product DTOs; the index worker has only the AI-assisted KMS class and service functions required to lease/commit eligible work.
- `user_provider_keys`: **no client access at all** — not even `select`. E4 exposes only the exact owner status/put/delete plus lease-bound organizer functions in ADR-0012; clients and isolated workloads retain no direct table/Vault access, and plaintext is never stored in the table or returned to a client.
- `api_idempotency_records`: **no client access at all**. Reviewed functions claim and complete receipts in the same transaction as the requested write.
- `auth_otp_quota_events`: **no direct table access for any API role**. The service-only quota function uses advisory locks and stores only HMAC-SHA256 digests.
- Join ownership is checked inside the reviewed relation operations; a forged tag, note, link target, space, or parent fails the entire transaction.

Every policy has an allow test and a cross-user deny test in `supabase/tests` (see OPERATIONS_TEST_PLAN §5.2).

## 4. Transactional functions

Reviewed SQL uses `security definer` with an empty `search_path`. Authenticated manual-entity wrappers derive ownership only from `auth.uid()`. Capture storage functions instead require `service_role` and an explicit owner ID supplied only after the Next API verifies the application session; they repeat the owner predicate in every query.

- `create_capture_with_job(owner_id, capture)` — service-only; inserts the owner-bound encrypted capture + job atomically and returns the existing live row on an equivalent replay.
- `list_captures(owner_id, ...)`, `get_capture_detail(owner_id, capture_id)`, and `get_capture_receipt(owner_id, capture_id)` — service-only reads that require the explicit owner predicate; envelopes can reach only the authorized server decryptor and never the public product DTO.
- `retry_capture(owner_id, capture_id, idempotency_key)` and `delete_capture(owner_id, capture_id, idempotency_key, ...)` — service-only, replay-safe transitions. Retry idempotency storage is content-free and reattaches only the current live envelope after rechecking ownership/status. Delete atomically removes envelope/fingerprint/length and purges retry snapshots so a later replay cannot resurrect ciphertext; optional inserted-content removal uses the same owner-scoped undo core as the authenticated undo wrapper.
- `claim_capture_jobs`, `heartbeat_capture_job`, `complete_capture_job`, `fail_capture_job`, and `recover_stale_capture_jobs` — service-only lease transitions with bounded attempts, lease-token ownership, replay-safe terminal actions, and dead-letter handling.
- `create_note(idempotency_key, type, title, body_markdown, space_id, privacy, structured_data, tag_ids, links)` — validates owned tags/link targets and canonical body/structure agreement, creates revision 1 plus a real `mut_` receipt (`0 → 1`), relations, and cursor events atomically. Its inverse is a soft-delete intent, so creation is undoable without erasing history.
- `apply_user_note_mutation(note_id, expected_revision, operations, idempotency_key)` — locks the note, strictly validates and applies up to 20 typed operations, saves a full inverse snapshot (including tag/link sets), appends a revision and mutation receipt, increments `current_revision`, and emits all cursor events atomically. Archive/delete timestamps use the contract's ISO-or-null shape; `is_open` is derived from list/project checklist state. Ambiguous structural Markdown commits one deduplicated open review while leaving the note and revision unchanged, returning `{errorCode:"structure_conflict",reviewItemId,replayed}` for the API adapter to map to HTTP 409.
- `undo_user_mutation(mutation_id, expected_revision, idempotency_key)` — permits an inverse only while the target mutation remains the current compatible revision, restores its full snapshot and relations, appends an undo snapshot/receipt, and marks the original mutation undone. Undoing creation stamps `deleted_at` at undo time; undoing that undo restores the active revision-1 snapshot.
- `restore_note_revision(note_id, revision_id, expected_revision, idempotency_key)` — verifies the typed revision belongs to the owned note, copies its immutable content snapshot into a new current revision, and never rewrites history.
- `restore_note(note_id, expected_revision, idempotency_key)` — idempotently clears the note soft-delete marker through the typed mutation pipeline.
- `create_space(idempotency_key, name, parent_id, slug, sort_key)`, `update_space(space_id, expected_revision, patch, idempotency_key)`, `archive_space(space_id, expected_revision, archived, idempotency_key)` — honor caller sort order, enforce owner-only parents and one child level, and provide idempotent stale-revision protection.
- `create_tag(idempotency_key, name)`, `update_tag(tag_id, expected_revision, name, idempotency_key)`, and `delete_tag(tag_id, expected_revision, idempotency_key)` — expose the reviewed authenticated tag CRUD surface, normalize names, and provide idempotent stale-revision protection without granting direct table writes.
- `apply_delayed_organization_mutation(job_id, lease_token, note_id, expected_revision, operations, idempotency_key)` — service-only. The current unexpired worker lease authorizes the effect but is excluded from its logical idempotency identity, so a reclaimed job can replay a lost response without duplicating the mutation. It applies at revision N, replans exactly once if the note reached N+1, then creates a durable `revision_conflict` review on another conflict without overwriting manual content.
- `search_notes(query, archive_filter, limit, offset)` — current owner-scoped plaintext search. C.5 retires this SQL function and its indexes; the replacement is an authenticated `POST` service over authorized in-memory decryption, with lexical-only private-note handling.
- `consume_auth_otp_quota(email_hash, ip_hash, now)` — service-only, accepts lowercase 64-byte-hex HMAC digests, permits 5 requests per email and 20 per IP in a rolling hour, and raises the PostgREST `PGRST` signal with HTTP 429 metadata when limited. `Retry-After` is the exact positive whole-second wait until both dimensions permit another request (the later limiting deadline, ceiled and clamped to 1–3600 seconds).

E1 interactive correction, Review-resolution, and mutation-batch Undo functions, E2 routing-rule functions, the E3 generated-block resolver, and the E4 provider-key/settings/live-lease functions are implemented as listed in §2.3. Encrypted organizer create/append/Review publication and owner export/account deletion use reviewed service/worker paths; their tables remain directly non-writable to clients.

**C.5 target transaction:** the server authorizes and decrypts revision N, validates/applies the shared typed operation in memory, and calls a service-only `apply_encrypted_note_mutation` RPC. That RPC locks the owned note, requires `current_revision = N`, and atomically commits the new note envelope, immutable revision envelope, encrypted mutation/inverse and idempotency response, content-free cursor event, and target-revision index job. A keyed MAC over canonical input preserves same-key replay detection despite randomized ciphertext. A stale revision or mismatched owner commits nothing. Create, undo, restore, Review resolution, and AI application follow the same envelope/CAS pattern.

## 5. `structured_data` schemas

Versioned per note type; validated by Zod at the application boundary and by `check`-constraint on `schemaVersion` presence for list/log notes.

### 5.1 `list` (canonical for items)

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "id": "itm_01H...",
      "text": "milk",
      "checked": false,
      "checkedAt": null,
      "ordinal": "a0",
      "sourceCaptureId": "cap_01H...",
      "createdAt": "2026-08-30T17:04:00Z"
    }
  ]
}
```

### 5.2 `log` (canonical for entries)

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "ent_01H...",
      "occurredAt": "2026-08-30T17:04:00Z",
      "fields": {
        "exercise": "bench",
        "weight": 135,
        "reps": 8,
        "note": null
      }
    }
  ]
}
```

Each field value is a string of at most 500 characters, a finite JSON number that round-trips through the shared JavaScript-number subset, or `null`. Entry timestamps must be strict ISO datetimes with an explicit `Z` or numeric offset.

### 5.3 Projection rules

`body_markdown` for lists and logs is a deterministic projection. Lists accept blank lines, `##`–`######` section headings, and `-`, `*`, or `+` bullets with an optional `[ ]`/`[x]`; checked items render after `## Completed`. Duplicate normalized item text or any other nonblank line is a structure conflict. Reconciliation preserves IDs by normalized text, then by ordinal when unambiguous.

Logs render each entry as `## <strict ISO-offset occurredAt>`, a blank line, then sorted `- key: value` rows; entries sort by timestamp then ID. Reconciliation preserves same-timestamp identities by deterministic occurrence position (the prior IDs are sorted), rejects duplicate field keys and all non-log lines, decodes quoted JSON strings, and emits finite numbers as plain decimal rather than exponent notation.

Project Markdown remains byte-authoritative. Only checklist lines matching `- [ ] text` / `- [x] text` (also `*`/`+`) enter `checklistItems`; all other prose stays untouched. Checklist IDs reconcile by normalized text, then stable line index, and duplicate normalized checklist text conflicts. A direct structured create or restored snapshot must exactly agree with the body projection. Plain note types use only `{ "schemaVersion": 1 }`.

## 6. Sync cursors

Milestone B establishes the durable substrate for later manual-note cursor sync: a per-user monotonic
`user_events (seq bigserial, user_id, entity, entity_id, occurred_at)` append-only table written by
the transactional functions. The current web and mobile manual-note clients poll every four seconds
and refresh on focus/activation; reload is the Milestone B correctness fallback.
Milestone C adds durable capture queues independently; `GET /sync/pull?cursor=`, persisted manual-note
client cursors, and Realtime invalidation remain later roadmap work.

```sql
create table user_events (
  seq bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null,
  entity_id text not null,
  occurred_at timestamptz not null default now()
);
create index user_events_user_cursor on user_events (user_id, seq);
```

`user_events` has user-scoped `select` only. Transactional functions and the service role append
events; clients cannot forge cursor entries. It is the only Milestone B table added to
`supabase_realtime`, ready for later clients to treat each event as an invalidation hint while
advancing through the future durable cursor endpoint.

## 7. Retention schedule

| Data                                     | Active retention                     | After deletion trigger                                       |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| capture source content                   | encrypted while capture is active    | ciphertext, fingerprint, and length destroyed atomically     |
| content-free capture provenance/receipts | while account is active              | retained for source-removal/undo audit; deleted with account |
| notes and revisions                      | indefinite while account active      | soft-delete window 30 days, then hard delete                 |
| rejected generated_blocks                | 7 days (undo window)                 | hard delete                                                  |
| organization telemetry (decisions, jobs) | 180 days                             | deleted with account                                         |
| feedback_events                          | 365 days                             | deleted with account                                         |
| encrypted RAG generations/jobs           | tied to eligible live note/model     | deleted with note/account (cascade)                          |
| OTP quota HMAC events                    | rolling hour; cleanup after 24 hours | no plaintext email/IP is stored                              |
| backups                                  | provider schedule, target ≤ 30 days  | age out; documented in privacy policy                        |

`purge_expired_deleted_notes(owner_id, now, batch_size, execute)` selects at most 500 notes
whose `deleted_at` is at least 30 days old. It is executable only by `service_role`, defaults to a
non-destructive dry run, and acquires every related job and capture in deterministic workflow order
before snapshot-idempotency rows and the note lock. It defers active workflows and fails the transaction
if any dependent capture, receipt, or other row belongs to another owner. Before deleting a terminal
destination it converts its receipt to `kept_in_inbox`, clears mutation/review/destination references,
inserted content, and actions, bounds the `destination_expired` reason marker to 20 entries, and emits
capture plus receipt invalidations. After C.5, the batch also cascades encrypted RAG generations/jobs;
it removes note-bearing idempotency snapshots, clears retained decision/feedback destinations, removes
note-target routing rules, and emits a content-free `note_purged` cursor event.

The daily Vercel Cron route is protected by `CRON_SECRET`. Missing or false
`NOTE_RETENTION_EXECUTION_ENABLED` keeps every scheduled invocation in dry-run mode. Production hard
deletion begins only after a human reviews the dry-run count and explicitly enables the gate.

E3 extends the existing bounded `claim_encrypted_note_retention` execution internally; it does not add
a public retention function or change that function's response. On a dry run the private hook computes
eligibility without deleting a block. A new executed run purges at most the requested bounded batch of
blocks whose `state = rejected` and `resolved_at` is at least seven days old, skips unfinished resolution
claims, removes encrypted replay state and reservations through the existing cascades, emits a
content-free purge invalidation, and does not consume a second block batch when the same retention run
is replayed.

## 8. Migration conventions

- One migration per change set, forward-only, in `supabase/migrations`; CI applies all from zero on every PR.
- Milestone E0–E4 own implemented timestamps `20260901000001`–`00005`. A parallel lane may not take another lane's timestamp or rename the public RPCs frozen in §2.3.
- Enum additions, new tables, and new nullable columns are safe; anything else needs a two-step expand/contract migration and an ADR if it touches a contract.
- C.5 uses expand/backfill/verify/read-cutover/write-cutover/contract. Contract drops all legacy plaintext columns/functions/indexes only after canary scans and rollback approval; old backups may remain decryptable until their documented expiry.
- `seed.sql` creates the deterministic local fixture users and library used by tests and the demo account (clearly labeled synthetic data).
