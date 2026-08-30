# Data Model

The Milestone A Supabase schema now has checked-in, forward-only migrations. They are the source of truth:

- [`20260830000000_initial_unfiled_schema.sql`](../supabase/migrations/20260830000000_initial_unfiled_schema.sql) creates extensions, enums, tables, indexes, and shared helpers.
- [`20260830000001_security_policies_and_capture_rpc.sql`](../supabase/migrations/20260830000001_security_policies_and_capture_rpc.sql) adds grants, RLS policies, and the atomic capture RPC.

This document remains the readable schema reference and must change in the same change set as future migrations. If prose or an illustrative DDL excerpt differs from a migration, the migration wins. Verify pgvector and extension versions in each target Supabase environment before promotion.

Related: [BUILD_PLAN.md](./BUILD_PLAN.md) §12, [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) for RLS strategy and retention.

## 1. Conventions

- IDs: `text` primary keys with typed prefixes over ULIDs — `note_`, `cap_`, `spc_`, `rev_`, `mut_`, `dec_`, `job_`, `rule_`, `rvw_`, `blk_`, `tag_`, `lnk_`, `chk_`, `fbk_`, `key_`. Client-generated only for `captures.id`; all others server-generated.
- Every user-owned table: `user_id uuid not null references auth.users(id) on delete cascade`, `created_at timestamptz not null default now()`; mutable tables add `updated_at` maintained by trigger.
- Soft delete via `deleted_at timestamptz`; hard delete per retention schedule (§7).
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
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
-- App-level: MVP allows exactly one nesting level (parent must have null parent).

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
  title text not null,
  body_markdown text not null,
  structured_data jsonb not null,
  content_hash text not null,          -- sha256 of canonical serialization
  actor text not null,                 -- 'user:<device>' | 'organization:<jobId>' | 'undo:<mutId>'
  mutation_id text,
  created_at timestamptz not null default now(),
  unique (note_id, revision)
);
-- Full snapshots in MVP (BUILD_PLAN §12.1); patches only after size evidence.

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
  created_at timestamptz not null default now(),
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
```

## 3. Row Level Security

Every table above enables RLS. The standard policy set, applied per table (template shown for `notes`):

```sql
alter table notes enable row level security;
create policy notes_select on notes for select using (user_id = auth.uid());
create policy notes_insert on notes for insert with check (user_id = auth.uid());
create policy notes_update on notes for update using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy notes_delete on notes for delete using (user_id = auth.uid());
```

Deviations from the template:

- `profiles`: `id = auth.uid()` instead of `user_id`.
- `organization_jobs`, `organization_decisions`, `note_mutations`, `note_chunks`, `feedback_events`: user gets `select` only; `insert/update` happen exclusively through `security definer` functions or the service role inside the workflow, so clients cannot forge decisions or mutations.
- `user_provider_keys`: **no client access at all** — not even `select`. All reads and writes go through `security definer` functions (`set_provider_key`, `get_provider_key_status`, `delete_provider_key`) that expose only provider, last-four, and status. The `vault_secret_id` / `key_ciphertext` columns are decrypted exclusively inside the workflow via the service role.
- Join tables verify ownership of **both** referenced rows in `with check`.

Every policy has an allow test and a cross-user deny test in `supabase/tests` (see OPERATIONS_TEST_PLAN §5.2).

## 4. Transactional functions

Reviewed SQL (`security definer`, `search_path` pinned) — the only write paths for organization and interactive edits:

- `create_capture_with_job(capture jsonb) returns capture_row` — inserts capture + job atomically; on conflict (same `id`) returns the existing row unchanged (idempotency).
- `apply_mutation(p_note_id text, p_expected_revision int, p_operations jsonb, p_decision_id text, p_idempotency_key text) returns mutation_result` — locks the note row, verifies `current_revision = p_expected_revision` (else raises `stale_revision`), applies operations to `structured_data`/`body_markdown`, regenerates the projection for list/log types, writes `note_revisions`, `note_mutations`, `capture_note_links`, bumps `current_revision`, and emits the receipt event — one transaction. Replay with the same idempotency key returns the original result.
- `undo_mutation(p_mutation_id text) returns mutation_result` — verifies compatibility (no incompatible later ops on the affected items), applies `inverse` via `apply_mutation` semantics with source `undo`, sets `undone_at`.
- `resolve_review(p_review_id text, p_resolution jsonb)` — applies the chosen destination via `apply_mutation`, updates capture status and review state atomically.
- `set_provider_key(p_provider ai_provider, p_key text)` / `get_provider_key_status()` / `delete_provider_key(p_provider ai_provider)` — key custody functions; `set` stores via Supabase Vault (or AES-256-GCM fallback with the KEK in server env), records last-four, and never persists or returns plaintext; `delete` also destroys the Vault secret.
- `delete_account(p_user_id uuid)` — see SECURITY_AND_PRIVACY §8; cascades cover most rows, function handles queued work, Vault secret destruction, and verification counts.

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
      "occurredOn": "2026-08-30",
      "kind": "workout",
      "raw": "bench 135 x 8, 145 x 6",
      "exercises": [
        {
          "name": "bench",
          "sets": [
            { "weight": 135, "unit": "lb", "reps": 8 },
            { "weight": 145, "unit": "lb", "reps": 6 }
          ]
        }
      ],
      "unparsed": [],
      "sourceCaptureId": "cap_01H..."
    }
  ]
}
```

`unit` comes from user preference, never invented; a capture without units stores `"unit": null` and renders without one. Non-workout log entries use `kind: "generic"` with `raw` only.

### 5.3 Projection rules

`body_markdown` for list/log is regenerated inside `apply_mutation`: stable templates, items in ordinal order, checked items under `## Completed`, log entries as dated `###` sections. Byte-deterministic for identical `structured_data` (property-tested). Prose types never regenerate; their `structured_data` holds metadata only.

## 6. Sync cursors

`GET /sync/pull?cursor=` uses a per-user monotonic sequence: a `user_events (seq bigserial, user_id, entity, entity_id, occurred_at)` append-only table written by the transactional functions. Clients store the last seq. Realtime is an optimization; the cursor is the correctness mechanism.

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

`user_events` has user-scoped `select` only. Transactional functions and the service role append events; clients cannot forge cursor entries.

## 7. Retention schedule

| Data                                     | Active retention                    | After deletion trigger                       |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------- |
| captures, notes, revisions               | indefinite while account active     | soft-delete window 30 days, then hard delete |
| rejected generated_blocks                | 7 days (undo window)                | hard delete                                  |
| organization telemetry (decisions, jobs) | 180 days                            | deleted with account                         |
| feedback_events                          | 365 days                            | deleted with account                         |
| note_chunks/embeddings                   | tied to live note revision          | deleted with note (cascade)                  |
| backups                                  | provider schedule, target ≤ 30 days | age out; documented in privacy policy        |

## 8. Migration conventions

- One migration per change set, forward-only, in `supabase/migrations`; CI applies all from zero on every PR.
- Enum additions, new tables, and new nullable columns are safe; anything else needs a two-step expand/contract migration and an ADR if it touches a contract.
- `seed.sql` creates the deterministic local fixture users and library used by tests and the demo account (clearly labeled synthetic data).
