# Data Model

The Milestone B Supabase schema has checked-in, forward-only migrations. They are the source of truth:

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

This document remains the readable schema reference and must change in the same change set as future migrations. If prose or an illustrative DDL excerpt differs from a migration, the migration wins. Verify pgvector and extension versions in each target Supabase environment before promotion.

Related: [BUILD_PLAN.md](./BUILD_PLAN.md) §12, [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) for RLS strategy and retention.

## 1. Conventions

- IDs: `text` primary keys with typed prefixes over ULIDs — `note_`, `cap_`, `spc_`, `rev_`, `mut_`, `dec_`, `job_`, `rule_`, `rvw_`, `blk_`, `tag_`, `lnk_`, `chk_`, `fbk_`, `key_`. Client-generated only for `captures.id`; all others server-generated.
- Every user-owned table: `user_id uuid not null references auth.users(id) on delete cascade`, `created_at timestamptz not null default now()`; mutable tables add `updated_at` maintained by trigger.
- Soft delete via `deleted_at timestamptz`; hard delete per retention schedule (§7).
- User write RPCs use one global `(user_id, idempotency_key)` namespace. A replay with equivalent canonical input returns the stored response; reusing a key for a different request raises `invalid_idempotency_key`.
- Notes, spaces, and tags expose `current_revision`. Mutable write RPCs lock the owned row and require an exact expected revision, returning `stale_revision` before any entity, history, receipt, or event state commits. Creation returns revision 1.
- All enums are PostgreSQL enum types; adding a value is a migration.
- Extensions: `pg_trgm`, `vector`, `pgcrypto`.

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
  vault_secret_id uuid,                -- Supabase Vault reference (selected mechanism)
  key_ciphertext text,                 -- fallback: app-layer AES-256-GCM if Vault unavailable
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
  raw_text text not null check (char_length(raw_text) between 1 and 10000),
  privacy privacy_mode not null default 'ai_assisted',
  explicit_destination_note_id text references notes(id),
  expansion_disabled boolean not null default false,
  client_created_at timestamptz not null,
  client_timezone text not null,
  received_at timestamptz not null default now(),
  status capture_status not null default 'pending',
  last_error_code safe_error_code,
  deleted_at timestamptz
);
create index captures_user_day on captures (user_id, received_at desc);
create index captures_inbox on captures (user_id) where status = 'inbox';

create table organization_jobs (
  id text primary key,
  capture_id text not null references captures(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state job_state not null default 'created',
  attempt integer not null default 0 check (attempt <= 5),
  workflow_provider_id text,
  prompt_version text not null,
  schema_version integer not null,
  model_id text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code safe_error_code,
  created_at timestamptz not null default now(),
  unique (capture_id)                  -- one job per capture; retries reuse the row
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
-- Vector index (HNSW vs IVFFlat) chosen after representative data exists (BUILD_PLAN §20).

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
- `captures`, `organization_jobs`, `organization_decisions`, `note_mutations`, `generated_blocks`, `capture_note_links`, `routing_rules`, `review_items`, `note_chunks`, `feedback_events`, `user_events`, and `organization_mutation_attempts`: owner-scoped `select` only; writes happen exclusively through reviewed functions or the service role inside the workflow, so clients cannot forge decisions, mutations, retries, or cursor events.
- `user_provider_keys`: **no client access at all** — not even `select`. Until later reviewed key-custody functions exist, only the service role can reach this table; plaintext is never stored or returned.
- `api_idempotency_records`: **no client access at all**. Reviewed functions claim and complete receipts in the same transaction as the requested write.
- `auth_otp_quota_events`: **no direct table access for any API role**. The service-only quota function uses advisory locks and stores only HMAC-SHA256 digests.
- Join ownership is checked inside the reviewed relation operations; a forged tag, note, link target, space, or parent fails the entire transaction.

Every policy has an allow test and a cross-user deny test in `supabase/tests` (see OPERATIONS_TEST_PLAN §5.2).

## 4. Transactional functions

Reviewed SQL (`security definer`, empty `search_path`, owner derived only from `auth.uid()`) — the only write paths for captures and Milestone B manual entities:

- `create_capture_with_job(capture jsonb) returns capture_row` — inserts capture + job atomically; on conflict (same `id`) returns the existing row unchanged (idempotency).
- `create_note(idempotency_key, type, title, body_markdown, space_id, privacy, structured_data, tag_ids, links)` — validates owned tags/link targets and canonical body/structure agreement, creates revision 1 plus a real `mut_` receipt (`0 → 1`), relations, and cursor events atomically. Its inverse is a soft-delete intent, so creation is undoable without erasing history.
- `apply_user_note_mutation(note_id, expected_revision, operations, idempotency_key)` — locks the note, strictly validates and applies up to 20 typed operations, saves a full inverse snapshot (including tag/link sets), appends a revision and mutation receipt, increments `current_revision`, and emits all cursor events atomically. Archive/delete timestamps use the contract's ISO-or-null shape; `is_open` is derived from list/project checklist state. Ambiguous structural Markdown commits one deduplicated open review while leaving the note and revision unchanged, returning `{errorCode:"structure_conflict",reviewItemId,replayed}` for the API adapter to map to HTTP 409.
- `undo_user_mutation(mutation_id, expected_revision, idempotency_key)` — permits an inverse only while the target mutation remains the current compatible revision, restores its full snapshot and relations, appends an undo snapshot/receipt, and marks the original mutation undone. Undoing creation stamps `deleted_at` at undo time; undoing that undo restores the active revision-1 snapshot.
- `restore_note_revision(note_id, revision_id, expected_revision, idempotency_key)` — verifies the typed revision belongs to the owned note, copies its immutable content snapshot into a new current revision, and never rewrites history.
- `restore_note(note_id, expected_revision, idempotency_key)` — idempotently clears the note soft-delete marker through the typed mutation pipeline.
- `create_space(idempotency_key, name, parent_id, slug, sort_key)`, `update_space(space_id, expected_revision, patch, idempotency_key)`, `archive_space(space_id, expected_revision, archived, idempotency_key)` — honor caller sort order, enforce owner-only parents and one child level, and provide idempotent stale-revision protection.
- `create_tag(idempotency_key, name)`, `update_tag(tag_id, expected_revision, name, idempotency_key)`, and `delete_tag(tag_id, expected_revision, idempotency_key)` — expose the reviewed authenticated tag CRUD surface, normalize names, and provide idempotent stale-revision protection without granting direct table writes.
- `apply_delayed_organization_mutation(job_id, note_id, expected_revision, operations, idempotency_key)` — service-only. It applies at revision N, replans exactly once if the note reached N+1, then creates a durable `revision_conflict` review on another conflict without overwriting manual content.
- `search_notes(query, archive_filter, limit, offset)` — owner-scoped search over exactly title, body, updated date, and root/child space path, with contextual plain-text snippets around late body matches, deleted-row exclusion, explicit archive filtering, deterministic ordering, and bounded offset pagination. `private_manual` notes remain searchable by their owner and are never sent to an AI path.
- `consume_auth_otp_quota(email_hash, ip_hash, now)` — service-only, accepts lowercase 64-byte-hex HMAC digests, permits 5 requests per email and 20 per IP in a rolling hour, and raises the PostgREST `PGRST` signal with HTTP 429 metadata when limited. `Retry-After` is the exact positive whole-second wait until both dimensions permit another request (the later limiting deadline, ceiled and clamped to 1–3600 seconds).

Provider-key, general organization-decision orchestration, review-resolution, and account-deletion functions remain later-milestone work; the tables stay non-writable to clients until those reviewed paths exist.

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

Milestone B establishes the durable substrate for Milestone C sync: a per-user monotonic
`user_events (seq bigserial, user_id, entity, entity_id, occurred_at)` append-only table written by
the transactional functions. The current web and mobile manual-note clients poll every four seconds
and refresh on focus/activation; reload is the Milestone B correctness fallback.
Milestone C will add `GET /sync/pull?cursor=`, persisted client cursors, and Realtime invalidation.

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
`supabase_realtime`, ready for Milestone C clients to treat each event as an invalidation hint while
advancing through the future durable cursor endpoint.

## 7. Retention schedule

| Data                                     | Active retention                     | After deletion trigger                       |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------- |
| captures, notes, revisions               | indefinite while account active      | soft-delete window 30 days, then hard delete |
| rejected generated_blocks                | 7 days (undo window)                 | hard delete                                  |
| organization telemetry (decisions, jobs) | 180 days                             | deleted with account                         |
| feedback_events                          | 365 days                             | deleted with account                         |
| note_chunks/embeddings                   | tied to live note revision           | deleted with note (cascade)                  |
| OTP quota HMAC events                    | rolling hour; cleanup after 24 hours | no plaintext email/IP is stored              |
| backups                                  | provider schedule, target ≤ 30 days  | age out; documented in privacy policy        |

`purge_expired_deleted_notes(owner_id, now, batch_size, execute)` selects at most 500 notes
whose `deleted_at` is at least 30 days old. It is executable only by `service_role`, defaults to a
non-destructive dry run, locks candidates with `SKIP LOCKED`, and fails the transaction if any
dependent row belongs to another owner. An executing batch cascades note revisions, chunks and
embeddings, generated blocks, note relations, review items, and mutation history; removes
note-bearing idempotency snapshots; clears the destination from retained capture/decision/feedback
telemetry; removes note-target routing rules; and emits a content-free `note_purged` cursor event.

The daily Vercel Cron route is protected by `CRON_SECRET`. Missing or false
`NOTE_RETENTION_EXECUTION_ENABLED` keeps every scheduled invocation in dry-run mode. Production hard
deletion begins only after a human reviews the dry-run count and explicitly enables the gate.

## 8. Migration conventions

- One migration per change set, forward-only, in `supabase/migrations`; CI applies all from zero on every PR.
- Enum additions, new tables, and new nullable columns are safe; anything else needs a two-step expand/contract migration and an ADR if it touches a contract.
- `seed.sql` creates the deterministic local fixture users and library used by tests and the demo account (clearly labeled synthetic data).
