-- Unfiled initial schema.
-- Forward-only baseline for local, preview, and production Supabase projects.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

create type public.note_type as enum ('generic', 'list', 'log', 'principle', 'project');
create type public.capture_status as enum (
  'pending',
  'queued',
  'processing',
  'organized',
  'inbox',
  'needs_review',
  'failed',
  'deleted'
);
create type public.capture_source as enum (
  'mobile',
  'web',
  'ios_lock_screen_widget',
  'share_sheet',
  'import'
);
create type public.privacy_mode as enum ('ai_assisted', 'private_manual');
create type public.org_mode as enum ('cautious', 'balanced', 'automatic');
create type public.job_state as enum (
  'created',
  'running',
  'awaiting_retry',
  'succeeded',
  'failed',
  'dead_letter'
);
create type public.behavior_band as enum ('auto', 'review', 'inbox');
create type public.revision_source as enum (
  'manual',
  'organization',
  'undo',
  'import',
  'interactive'
);
create type public.rule_type as enum ('prefix', 'phrase', 'alias', 'destination_mention');
create type public.rule_source as enum ('explicit', 'correction_suggested');
create type public.review_type as enum (
  'low_confidence',
  'revision_conflict',
  'failed_job',
  'duplicate_suggestion',
  'pending_expansion',
  'structure_conflict'
);
create type public.review_state as enum ('open', 'resolved', 'dismissed');
create type public.block_state as enum ('proposed', 'accepted', 'rejected');
create type public.block_kind as enum ('summary', 'interpretation', 'suggestion', 'label');
create type public.link_type as enum ('reference', 'related');
create type public.link_source as enum ('manual', 'organization');
create type public.feedback_action as enum (
  'accepted',
  'moved',
  'undone',
  'expansion_accepted',
  'expansion_rejected',
  'rule_created',
  'review_resolved'
);
create type public.ai_provider as enum ('openai', 'anthropic');
create type public.provider_mode as enum ('app_default', 'byok');
create type public.routing_effort as enum ('economical', 'standard', 'thorough');
create type public.expansion_style as enum ('off', 'brief', 'detailed');
create type public.key_status as enum ('active', 'invalid', 'revoked');
create type public.safe_error_code as enum (
  'account_deletion_failed',
  'budget_exhausted',
  'capture_too_long',
  'conflict_requires_review',
  'forbidden',
  'invalid_capture',
  'invalid_idempotency_key',
  'invalid_plan',
  'not_found',
  'offline',
  'provider_key_invalid',
  'provider_unavailable',
  'rate_limited',
  'stale_revision',
  'structure_conflict',
  'unauthorized',
  'validation_failed'
);

-- ULIDs keep server-created IDs sortable while preserving the shared typed-ID contract.
create or replace function public.generate_ulid()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  crockford constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  value numeric;
  random_bytes bytea := extensions.gen_random_bytes(10);
  encoded text := '';
begin
  value := floor(extract(epoch from clock_timestamp()) * 1000);

  for index in 0..9 loop
    value := value * 256 + get_byte(random_bytes, index);
  end loop;

  for index in 1..26 loop
    encoded := substr(crockford, mod(value, 32)::integer + 1, 1) || encoded;
    value := trunc(value / 32);
  end loop;

  return encoded;
end;
$$;

create or replace function public.new_entity_id(prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
begin
  if prefix <> all (
    array[
      'blk', 'cap', 'chk', 'dec', 'ent', 'evt', 'fbk', 'itm', 'job', 'key',
      'lnk', 'mut', 'note', 'rev', 'rule', 'rvw', 'spc', 'tag'
    ]
  ) then
    raise exception using errcode = '22023', message = 'invalid_entity_prefix';
  end if;

  return prefix || '_' || public.generate_ulid();
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 100),
  locale text not null default 'en-US' check (char_length(locale) between 2 and 35),
  org_mode public.org_mode not null default 'balanced',
  expansion_enabled boolean not null default true,
  provider_mode public.provider_mode not null default 'app_default',
  byok_provider public.ai_provider,
  byok_fallback_to_app boolean not null default false,
  routing_effort public.routing_effort not null default 'standard',
  expansion_style public.expansion_style not null default 'brief',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider_mode = 'byok' or byok_provider is null)
);

create table public.user_provider_keys (
  id text primary key default public.new_entity_id('key'),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.ai_provider not null,
  vault_secret_id uuid,
  key_ciphertext text,
  key_last4 text not null check (char_length(key_last4) = 4),
  status public.key_status not null default 'active',
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider),
  check (vault_secret_id is not null or key_ciphertext is not null),
  check (id ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.spaces (
  id text primary key default public.new_entity_id('spc'),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id text references public.spaces(id),
  name text not null check (char_length(name) between 1 and 60),
  slug text not null check (char_length(slug) between 1 and 80),
  sort_key text not null default 'a0' check (char_length(sort_key) between 1 and 100),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug),
  check (id ~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (parent_id is null or parent_id <> id)
);

create table public.notes (
  id text primary key default public.new_entity_id('note'),
  user_id uuid not null references auth.users(id) on delete cascade,
  space_id text references public.spaces(id),
  type public.note_type not null,
  title text not null check (char_length(title) between 1 and 200),
  body_markdown text not null default '' check (char_length(body_markdown) <= 200000),
  structured_data jsonb not null default '{}'::jsonb,
  current_revision integer not null default 1 check (current_revision >= 1),
  daily_date date,
  is_open boolean not null default true,
  pinned_at timestamptz,
  privacy public.privacy_mode not null default 'ai_assisted',
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (jsonb_typeof(structured_data) = 'object'),
  check (
    type not in ('list', 'log')
    or (
      structured_data ? 'schemaVersion'
      and jsonb_typeof(structured_data -> 'schemaVersion') = 'number'
    )
  )
);

create table public.note_revisions (
  id text primary key default public.new_entity_id('rev'),
  note_id text not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null check (revision >= 1),
  source public.revision_source not null,
  title text not null,
  body_markdown text not null,
  structured_data jsonb not null check (jsonb_typeof(structured_data) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  actor text not null check (char_length(actor) between 1 and 200),
  mutation_id text,
  created_at timestamptz not null default now(),
  unique (note_id, revision),
  check (id ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.captures (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source public.capture_source not null,
  device_id text not null default '' check (char_length(device_id) <= 120),
  raw_text text not null check (
    char_length(raw_text) between 1 and 10000
    and btrim(raw_text) <> ''
  ),
  privacy public.privacy_mode not null default 'ai_assisted',
  explicit_destination_note_id text references public.notes(id),
  expansion_disabled boolean not null default false,
  client_created_at timestamptz not null,
  client_timezone text not null check (char_length(client_timezone) between 1 and 100),
  received_at timestamptz not null default now(),
  status public.capture_status not null default 'pending',
  last_error_code public.safe_error_code,
  deleted_at timestamptz,
  check (id ~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.organization_jobs (
  id text primary key default public.new_entity_id('job'),
  capture_id text not null references public.captures(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state public.job_state not null default 'created',
  attempt integer not null default 0 check (attempt between 0 and 5),
  workflow_provider_id text,
  prompt_version text not null check (char_length(prompt_version) between 1 and 100),
  schema_version integer not null check (schema_version >= 1),
  model_id text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code public.safe_error_code,
  created_at timestamptz not null default now(),
  unique (capture_id),
  check (id ~ '^job_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.organization_decisions (
  id text primary key default public.new_entity_id('dec'),
  capture_id text not null references public.captures(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_manifest jsonb not null check (jsonb_typeof(candidate_manifest) = 'object'),
  signals jsonb not null check (jsonb_typeof(signals) = 'object'),
  validated_plan jsonb,
  band public.behavior_band not null,
  score numeric(4, 3) check (score between 0 and 1),
  margin numeric(4, 3) check (margin between 0 and 1),
  destination_note_id text references public.notes(id),
  reason_codes text[] not null default '{}',
  created_at timestamptz not null default now(),
  check (id ~ '^dec_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (validated_plan is null or jsonb_typeof(validated_plan) = 'object')
);

create table public.note_mutations (
  id text primary key default public.new_entity_id('mut'),
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references public.organization_decisions(id),
  note_id text not null references public.notes(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  before_revision integer not null check (before_revision >= 1),
  after_revision integer not null check (after_revision = before_revision + 1),
  operations jsonb not null check (jsonb_typeof(operations) = 'array'),
  inverse jsonb not null check (jsonb_typeof(inverse) in ('array', 'object')),
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check (id ~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$')
);

alter table public.note_revisions
  add constraint note_revisions_mutation_id_fkey
  foreign key (mutation_id) references public.note_mutations(id);

create table public.generated_blocks (
  id text primary key default public.new_entity_id('blk'),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null references public.notes(id) on delete cascade,
  decision_id text not null references public.organization_decisions(id),
  kind public.block_kind not null,
  content text not null check (char_length(content) between 1 and 600),
  state public.block_state not null default 'proposed',
  model_id text not null,
  prompt_version text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (id ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.capture_note_links (
  capture_id text not null references public.captures(id) on delete cascade,
  note_id text not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null references public.note_mutations(id),
  relation text not null default 'routed' check (relation in ('routed', 'source_removed')),
  inserted_item_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (capture_id, note_id, mutation_id)
);

create table public.routing_rules (
  id text primary key default public.new_entity_id('rule'),
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  rule_type public.rule_type not null,
  condition_normalized text not null check (char_length(condition_normalized) between 1 and 500),
  destination_note_id text references public.notes(id),
  destination_space_id text references public.spaces(id),
  priority integer not null default 100 check (priority between 0 and 10000),
  source public.rule_source not null,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (id ~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (num_nonnulls(destination_note_id, destination_space_id) = 1)
);

create table public.review_items (
  id text primary key default public.new_entity_id('rvw'),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_id text references public.captures(id) on delete cascade,
  note_id text references public.notes(id) on delete cascade,
  type public.review_type not null,
  choices jsonb not null default '[]'::jsonb check (jsonb_typeof(choices) = 'array'),
  state public.review_state not null default 'open',
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (id ~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (resolution is null or jsonb_typeof(resolution) = 'object')
);

create table public.note_chunks (
  id text primary key default public.new_entity_id('chk'),
  note_id text not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null check (revision >= 1),
  ordinal integer not null check (ordinal >= 0),
  text_hash text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  content text not null,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  unique (note_id, revision, ordinal),
  check (id ~ '^chk_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.tags (
  id text primary key default public.new_entity_id('tag'),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (
    char_length(name) between 1 and 40
    and name = lower(btrim(name))
  ),
  created_at timestamptz not null default now(),
  unique (user_id, name),
  check (id ~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$')
);

create table public.note_tags (
  note_id text not null references public.notes(id) on delete cascade,
  tag_id text not null references public.tags(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source public.link_source not null default 'manual',
  mutation_id text references public.note_mutations(id),
  created_at timestamptz not null default now(),
  primary key (note_id, tag_id)
);

create table public.note_links (
  id text primary key default public.new_entity_id('lnk'),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_note_id text not null references public.notes(id) on delete cascade,
  to_note_id text not null references public.notes(id) on delete cascade,
  link_type public.link_type not null default 'reference',
  source public.link_source not null default 'manual',
  mutation_id text references public.note_mutations(id),
  created_at timestamptz not null default now(),
  unique (from_note_id, to_note_id, link_type),
  check (id ~ '^lnk_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (from_note_id <> to_note_id)
);

create table public.feedback_events (
  id text primary key default public.new_entity_id('fbk'),
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references public.organization_decisions(id),
  action public.feedback_action not null,
  old_destination_note_id text references public.notes(id),
  new_destination_note_id text references public.notes(id),
  reason_code text,
  created_at timestamptz not null default now(),
  check (id ~ '^fbk_[0-9A-HJKMNP-TV-Z]{26}$')
);

-- Global sequence values may contain gaps; each user's filtered stream remains monotonic.
create table public.user_events (
  seq bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null check (char_length(entity) between 1 and 80),
  entity_id text not null check (char_length(entity_id) between 1 and 80),
  occurred_at timestamptz not null default now()
);

create unique index notes_daily_singleton
  on public.notes (user_id, space_id, type, daily_date)
  nulls not distinct
  where daily_date is not null and deleted_at is null;
create index notes_fts
  on public.notes using gin (to_tsvector('simple', title || ' ' || body_markdown));
create index notes_title_trgm
  on public.notes using gin (title extensions.gin_trgm_ops);
create index notes_user_active
  on public.notes (user_id, updated_at desc)
  where deleted_at is null and archived_at is null;
create index note_revisions_user_note
  on public.note_revisions (user_id, note_id, revision desc);
create index captures_user_day on public.captures (user_id, received_at desc);
create index captures_inbox
  on public.captures (user_id, received_at desc)
  where status = 'inbox';
create index organization_jobs_user_state
  on public.organization_jobs (user_id, state, created_at);
create index organization_decisions_user_capture
  on public.organization_decisions (user_id, capture_id, created_at desc);
create index note_mutations_user_note
  on public.note_mutations (user_id, note_id, created_at desc);
create index generated_blocks_user_note
  on public.generated_blocks (user_id, note_id, state);
create index capture_note_links_user_capture
  on public.capture_note_links (user_id, capture_id);
create index routing_rules_user_priority
  on public.routing_rules (user_id, enabled, priority);
create index review_items_user_open
  on public.review_items (user_id, created_at desc)
  where state = 'open';
create index note_chunks_fts on public.note_chunks using gin (fts);
create index note_chunks_user_note on public.note_chunks (user_id, note_id, revision);
create index note_tags_user on public.note_tags (user_id, note_id);
create index note_links_user_from on public.note_links (user_id, from_note_id);
create index note_links_user_to on public.note_links (user_id, to_note_id);
create index feedback_events_user_created
  on public.feedback_events (user_id, created_at desc);
create index user_events_user_cursor on public.user_events (user_id, seq);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger user_provider_keys_set_updated_at
before update on public.user_provider_keys
for each row execute function public.set_updated_at();

create trigger spaces_set_updated_at
before update on public.spaces
for each row execute function public.set_updated_at();

create trigger notes_set_updated_at
before update on public.notes
for each row execute function public.set_updated_at();

create trigger routing_rules_set_updated_at
before update on public.routing_rules
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created_unfiled
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.owns_space(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.spaces
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.owns_root_space(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.spaces
      where id = object_id and user_id = auth.uid() and parent_id is null
    );
$$;

create or replace function private.owns_note(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.notes
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.owns_capture(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.captures
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.owns_decision(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.organization_decisions
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.owns_mutation(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.note_mutations
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.owns_tag(object_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.tags
      where id = object_id and user_id = auth.uid()
    );
$$;

create or replace function private.emit_user_event(
  owner_id uuid,
  entity_name text,
  object_id text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_seq bigint;
begin
  insert into public.user_events (user_id, entity, entity_id)
  values (owner_id, entity_name, object_id)
  returning seq into event_seq;

  return event_seq;
end;
$$;
