-- Milestone E0: revisioned settings, immutable organization inputs, and
-- content-free interaction evidence.
--
-- This migration is deliberately structural.  It does not add correction,
-- generated-block resolution, rule-management, or provider-key RPCs.  Those
-- operations will be introduced behind their own reviewed boundaries in the
-- following Milestone E slices.

-- An application ciphertext cannot be proven to match an accessible Vault
-- secret from its UUID alone.  Abort on every legacy ciphertext before
-- changing the catalog, even when the row also carries a Vault locator, and
-- expose only a constant, content-free operator error.  An operator must
-- complete and verify the Vault migration before retrying E0.
do $$
begin
  if exists (
    select 1
    from public.user_provider_keys
    where key_ciphertext is not null
  ) then
    raise exception using
      errcode = 'P0001', message = 'provider_key_vault_migration_required';
  end if;
end;
$$;

-- Existing app-default rows may carry a meaningless fallback bit under the
-- original one-way constraint.  Normalize that content-free setting before
-- installing the exact provider-mode shape.
update public.profiles
set byok_fallback_to_app = false
where provider_mode = 'app_default'
  and byok_fallback_to_app;

do $$
begin
  if exists (
    select 1
    from public.profiles
    where provider_mode = 'byok'
      and byok_provider is null
  ) then
    raise exception using
      errcode = 'P0001', message = 'invalid_profile_provider_mode_shape';
  end if;
end;
$$;

alter table public.profiles
  add column settings_revision integer not null default 1,
  drop constraint profiles_check,
  add constraint profiles_settings_revision_positive
    check (settings_revision >= 1),
  add constraint profiles_provider_mode_shape check (
    (
      provider_mode = 'app_default'
      and byok_provider is null
      and not byok_fallback_to_app
    )
    or (
      provider_mode = 'byok'
      and byok_provider is not null
    )
  );

create or replace function private.enforce_profile_settings_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  settings_changed boolean := row(
    new.timezone,
    new.locale,
    new.org_mode,
    new.expansion_enabled,
    new.provider_mode,
    new.byok_provider,
    new.byok_fallback_to_app,
    new.routing_effort,
    new.expansion_style
  ) is distinct from row(
    old.timezone,
    old.locale,
    old.org_mode,
    old.expansion_enabled,
    old.provider_mode,
    old.byok_provider,
    old.byok_fallback_to_app,
    old.routing_effort,
    old.expansion_style
  );
begin
  if settings_changed then
    if new.settings_revision not in (
      old.settings_revision,
      old.settings_revision + 1
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_settings_revision';
    end if;
    new.settings_revision := old.settings_revision + 1;
  elsif new.settings_revision <> old.settings_revision then
    raise exception using
      errcode = 'P0001', message = 'settings_revision_without_change';
  end if;
  return new;
end;
$$;

create trigger profiles_enforce_settings_revision
before update on public.profiles
for each row execute function private.enforce_profile_settings_revision();

alter table public.user_provider_keys
  add column credential_revision integer not null default 1,
  alter column vault_secret_id set not null,
  drop constraint user_provider_keys_check,
  add constraint user_provider_keys_credential_revision_positive
    check (credential_revision >= 1),
  add constraint user_provider_keys_vault_only
    check (vault_secret_id is not null and key_ciphertext is null);

create or replace function private.enforce_provider_key_credential_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  credential_changed boolean := row(
    new.provider,
    new.vault_secret_id,
    new.key_ciphertext,
    new.key_last4,
    new.status,
    new.validated_at
  ) is distinct from row(
    old.provider,
    old.vault_secret_id,
    old.key_ciphertext,
    old.key_last4,
    old.status,
    old.validated_at
  );
begin
  if credential_changed then
    if new.credential_revision not in (
      old.credential_revision,
      old.credential_revision + 1
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_credential_revision';
    end if;
    new.credential_revision := old.credential_revision + 1;
  elsif new.credential_revision <> old.credential_revision then
    raise exception using
      errcode = 'P0001', message = 'credential_revision_without_change';
  end if;
  return new;
end;
$$;

create trigger user_provider_keys_enforce_credential_revision
before update on public.user_provider_keys
for each row execute function private.enforce_provider_key_credential_revision();

-- current_revision is the public rule/CAS revision.  condition_revision
-- remains the encrypted-condition AAD revision, so key rewraps do not create a
-- user-visible rule edit.
alter table public.routing_rules
  add column current_revision integer not null default 1,
  add constraint routing_rules_current_revision_positive
    check (current_revision >= 1);

update public.routing_rules
set current_revision = condition_revision
where current_revision <> condition_revision;

create or replace function private.enforce_routing_rule_current_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rule_changed boolean := row(
    new.enabled,
    new.rule_type,
    new.condition_revision,
    new.destination_note_id,
    new.destination_space_id,
    new.priority,
    new.source
  ) is distinct from row(
    old.enabled,
    old.rule_type,
    old.condition_revision,
    old.destination_note_id,
    old.destination_space_id,
    old.priority,
    old.source
  );
begin
  if rule_changed then
    if new.current_revision not in (
      old.current_revision,
      old.current_revision + 1
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_routing_rule_revision';
    end if;
    new.current_revision := old.current_revision + 1;
  elsif new.current_revision <> old.current_revision then
    raise exception using
      errcode = 'P0001', message = 'routing_rule_revision_without_change';
  end if;
  return new;
end;
$$;

create trigger routing_rules_enforce_current_revision
before update on public.routing_rules
for each row execute function private.enforce_routing_rule_current_revision();

-- Terminal review/block states always carry a database timestamp; open or
-- proposed states never do.  The encrypted review envelope, rather than the
-- legacy resolution projection, remains authoritative after contraction.
do $$
begin
  if exists (
    select 1 from public.review_items
    where (state = 'open') <> (resolved_at is null)
  ) then
    raise exception using
      errcode = 'P0001', message = 'invalid_review_state_shape';
  end if;
  if exists (
    select 1 from public.generated_blocks
    where (state = 'proposed') <> (resolved_at is null)
  ) then
    raise exception using
      errcode = 'P0001', message = 'invalid_generated_block_state_shape';
  end if;
end;
$$;

alter table public.review_items
  add constraint review_items_state_resolution_shape check (
    (state = 'open' and resolved_at is null)
    or (state in ('resolved', 'dismissed') and resolved_at is not null)
  );

create or replace function private.enforce_review_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is distinct from old.state then
    if old.state <> 'open' or new.state not in ('resolved', 'dismissed') then
      raise exception using
        errcode = 'P0001', message = 'invalid_review_state_transition';
    end if;
  elsif new.resolved_at is distinct from old.resolved_at then
    raise exception using
      errcode = 'P0001', message = 'invalid_review_state_transition';
  end if;
  return new;
end;
$$;

create trigger review_items_enforce_state_transition
before update on public.review_items
for each row execute function private.enforce_review_state_transition();

alter table public.generated_blocks
  add column state_revision integer,
  add column review_item_id text;

update public.generated_blocks
set state_revision = case when state = 'proposed' then 1 else 2 end;

alter table public.generated_blocks
  alter column state_revision set not null,
  alter column state_revision set default 1,
  add constraint generated_blocks_state_revision_positive
    check (state_revision >= 1),
  add constraint generated_blocks_state_resolution_shape check (
    (state = 'proposed' and state_revision = 1 and resolved_at is null)
    or (
      state in ('accepted', 'rejected')
      and state_revision >= 2
      and resolved_at is not null
    )
  ),
  add constraint generated_blocks_review_item_id_fkey
    foreign key (review_item_id) references public.review_items(id)
    on delete set null deferrable initially deferred,
  add constraint generated_blocks_review_item_id_key
    unique (review_item_id) deferrable initially deferred;

create or replace function private.enforce_generated_block_state_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is distinct from old.state then
    if old.state <> 'proposed'
      or new.state not in ('accepted', 'rejected')
      or new.state_revision <> old.state_revision + 1
    then
      raise exception using
        errcode = 'P0001', message = 'invalid_generated_block_transition';
    end if;
  elsif new.resolved_at is distinct from old.resolved_at then
    raise exception using
      errcode = 'P0001', message = 'invalid_generated_block_transition';
  elsif new.state_revision <> old.state_revision then
    raise exception using
      errcode = 'P0001', message = 'block_revision_without_state_change';
  end if;
  return new;
end;
$$;

create trigger generated_blocks_enforce_state_revision
before update on public.generated_blocks
for each row execute function private.enforce_generated_block_state_revision();

create or replace function private.enforce_generated_block_review_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  block_row public.generated_blocks%rowtype;
  review_row public.review_items%rowtype;
begin
  select * into block_row
  from public.generated_blocks
  where id = new.id;
  if not found or block_row.review_item_id is null then
    return null;
  end if;

  select * into review_row
  from public.review_items
  where id = block_row.review_item_id;
  if not found
    or review_row.user_id <> block_row.user_id
    or review_row.note_id is distinct from block_row.note_id
    or review_row.type <> 'pending_expansion'
  then
    raise exception using
      errcode = '23514', message = 'generated_block_review_binding_invalid';
  end if;
  return null;
end;
$$;

create constraint trigger generated_blocks_review_binding
after insert or update of review_item_id, user_id, note_id
on public.generated_blocks
deferrable initially deferred
for each row execute function private.enforce_generated_block_review_binding();

-- Interaction evidence references encrypted resources only by typed IDs.  A
-- legacy row receives a deterministic opaque idempotency key derived from its
-- already-public event identifier; no note or capture content is copied.
alter table public.feedback_events
  add column review_item_id text,
  add column generated_block_id text,
  add column routing_rule_id text,
  add column idempotency_key text;

update public.feedback_events
set idempotency_key = 'legacy:' || id
where idempotency_key is null;

alter table public.feedback_events
  alter column idempotency_key set not null,
  add constraint feedback_events_review_item_id_fkey
    foreign key (review_item_id) references public.review_items(id)
    on delete set null deferrable initially deferred,
  add constraint feedback_events_generated_block_id_fkey
    foreign key (generated_block_id) references public.generated_blocks(id)
    on delete set null deferrable initially deferred,
  add constraint feedback_events_routing_rule_id_fkey
    foreign key (routing_rule_id) references public.routing_rules(id)
    on delete set null deferrable initially deferred,
  add constraint feedback_events_idempotency_key_shape check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  add constraint feedback_events_user_idempotency_key
    unique (user_id, idempotency_key);

create or replace function private.enforce_feedback_event_bindings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row public.feedback_events%rowtype;
begin
  select * into event_row
  from public.feedback_events
  where id = new.id;
  if not found then return null; end if;

  if event_row.decision_id is not null and not exists (
    select 1 from public.organization_decisions
    where id = event_row.decision_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  if event_row.old_destination_note_id is not null and not exists (
    select 1 from public.notes
    where id = event_row.old_destination_note_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  if event_row.new_destination_note_id is not null and not exists (
    select 1 from public.notes
    where id = event_row.new_destination_note_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  if event_row.review_item_id is not null and not exists (
    select 1 from public.review_items
    where id = event_row.review_item_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  if event_row.generated_block_id is not null and not exists (
    select 1 from public.generated_blocks
    where id = event_row.generated_block_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  if event_row.routing_rule_id is not null and not exists (
    select 1 from public.routing_rules
    where id = event_row.routing_rule_id and user_id = event_row.user_id
  ) then
    raise exception using errcode = '23514', message = 'feedback_owner_binding_invalid';
  end if;
  return null;
end;
$$;

create constraint trigger feedback_events_owner_bindings
after insert or update of
  user_id, decision_id, old_destination_note_id, new_destination_note_id,
  review_item_id, generated_block_id, routing_rule_id
on public.feedback_events
deferrable initially deferred
for each row execute function private.enforce_feedback_event_bindings();

create type public.feedback_mutation_role as enum (
  'source_removal',
  'destination_write'
);

create table public.feedback_event_mutations (
  feedback_event_id text not null
    references public.feedback_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id text not null
    references public.note_mutations(id) on delete cascade,
  role public.feedback_mutation_role not null,
  created_at timestamptz not null default now(),
  primary key (feedback_event_id, role),
  unique (feedback_event_id, mutation_id),
  unique (mutation_id)
);

create or replace function private.enforce_feedback_event_mutation_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  link_row public.feedback_event_mutations%rowtype;
begin
  select * into link_row
  from public.feedback_event_mutations
  where feedback_event_id = new.feedback_event_id
    and role = new.role;
  if not found then return null; end if;

  if not exists (
    select 1 from public.feedback_events
    where id = link_row.feedback_event_id and user_id = link_row.user_id
  ) or not exists (
    select 1 from public.note_mutations
    where id = link_row.mutation_id and user_id = link_row.user_id
  ) then
    raise exception using
      errcode = '23514', message = 'feedback_mutation_owner_binding_invalid';
  end if;
  return null;
end;
$$;

create constraint trigger feedback_event_mutations_owner_binding
after insert or update of feedback_event_id, user_id, mutation_id
on public.feedback_event_mutations
deferrable initially deferred
for each row execute function private.enforce_feedback_event_mutation_binding();

-- Composite job ownership keeps both immutable job snapshots bound to the
-- exact tenant even for migration-owner writes.
alter table public.organization_jobs
  add constraint organization_jobs_id_user_id_key unique (id, user_id);

create table public.organization_job_ai_settings (
  job_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  settings_revision integer not null check (settings_revision >= 1),
  org_mode public.org_mode not null,
  provider_mode public.provider_mode not null,
  selected_provider public.ai_provider not null,
  byok_fallback_to_app boolean not null,
  routing_effort public.routing_effort not null,
  expansion_style public.expansion_style not null,
  adapter_registry_version text not null
    default 'organization-model-registry-v1',
  created_at timestamptz not null default now(),
  constraint organization_job_ai_settings_job_owner_fkey
    foreign key (job_id, user_id)
    references public.organization_jobs(id, user_id) on delete cascade,
  constraint organization_job_ai_settings_adapter_registry_version check (
    char_length(adapter_registry_version) between 1 and 100
    and adapter_registry_version ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
  ),
  constraint organization_job_ai_settings_provider_shape check (
    (
      provider_mode = 'app_default'
      and selected_provider = 'openai'
      and not byok_fallback_to_app
    )
    or provider_mode = 'byok'
  )
);

create or replace function private.insert_organization_job_ai_settings(
  p_job_id text,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  settings_revision_value integer := 1;
  org_mode_value public.org_mode := 'balanced'::public.org_mode;
  provider_mode_value public.provider_mode :=
    'app_default'::public.provider_mode;
  selected_provider_value public.ai_provider := 'openai'::public.ai_provider;
  fallback_value boolean := false;
  routing_effort_value public.routing_effort :=
    'standard'::public.routing_effort;
  expansion_style_value public.expansion_style :=
    'brief'::public.expansion_style;
begin
  select * into profile_row
  from public.profiles
  where id = p_user_id
  for share;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'organization_job_profile_missing';
  end if;
  settings_revision_value := profile_row.settings_revision;
  org_mode_value := profile_row.org_mode;
  provider_mode_value := profile_row.provider_mode;
  selected_provider_value := case
    when profile_row.provider_mode = 'byok'
      then profile_row.byok_provider
    else 'openai'::public.ai_provider
  end;
  fallback_value := case
    when profile_row.provider_mode = 'byok'
      then profile_row.byok_fallback_to_app
    else false
  end;
  routing_effort_value := profile_row.routing_effort;
  expansion_style_value := case
    when profile_row.expansion_enabled then profile_row.expansion_style
    else 'off'::public.expansion_style
  end;

  -- The adapter/model registry pin is a content-free server configuration
  -- version.  The linked organization job already freezes prompt_version and
  -- schema_version.  Credentials are deliberately resolved live from the
  -- owner/provider under the future E4 lease boundary and never enter this
  -- immutable snapshot.
  insert into public.organization_job_ai_settings (
    job_id, user_id, settings_revision, org_mode, provider_mode,
    selected_provider, byok_fallback_to_app, routing_effort,
    expansion_style, adapter_registry_version
  ) values (
    p_job_id, p_user_id, settings_revision_value, org_mode_value,
    provider_mode_value, selected_provider_value, fallback_value,
    routing_effort_value, expansion_style_value,
    'organization-model-registry-v1'
  );
end;
$$;

create or replace function private.snapshot_organization_job_ai_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.insert_organization_job_ai_settings(new.id, new.user_id);
  return new;
end;
$$;

create trigger organization_jobs_snapshot_ai_settings
after insert on public.organization_jobs
for each row execute function private.snapshot_organization_job_ai_settings();

select private.insert_organization_job_ai_settings(job.id, job.user_id)
from public.organization_jobs as job
where not exists (
  select 1 from public.organization_job_ai_settings as snapshot
  where snapshot.job_id = job.id
);

-- Milestone D projected routingMode from the live profile because immutable
-- settings snapshots did not yet exist.  Replace only that projection in the
-- reviewed claim function: lease, owner, privacy, lock ordering, encrypted
-- source validation, and grants remain byte-for-byte unchanged.  A missing
-- snapshot yields JSON null and is rejected by the organizer parser; it never
-- falls back to a mutable profile or a guessed mode.
do $$
declare
  function_definition text;
  occurrence_count integer;
  old_projection constant text := $old$'routingMode', coalesce((
        select profile.org_mode
        from public.profiles as profile
        where profile.id = job_row.user_id
      ), 'balanced'::public.org_mode),$old$;
  new_projection constant text := $new$'routingMode', (
        select snapshot.org_mode
        from public.organization_job_ai_settings as snapshot
        where snapshot.job_id = job_row.id
          and snapshot.user_id = job_row.user_id
      ),$new$;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'private'
    and procedure.proname = 'claim_encrypted_organizer_jobs_impl'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      = 'p_worker_id text, p_claim_limit integer, p_lease_seconds integer';

  occurrence_count := case
    when function_definition is null then 0
    else (
      pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(
        pg_catalog.replace(function_definition, old_projection, '')
      )
    ) / pg_catalog.char_length(old_projection)
  end;
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_routing_snapshot_definition_mismatch';
  end if;

  execute pg_catalog.replace(
    function_definition, old_projection, new_projection
  );
end;
$$;

create table public.organization_job_rule_matches (
  job_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id text not null
    check (rule_id ~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'),
  rule_revision integer not null check (rule_revision >= 1),
  destination_kind text not null
    check (destination_kind in ('note', 'space')),
  destination_id text not null,
  priority integer not null check (priority between 0 and 10000),
  matched boolean not null check (matched),
  created_at timestamptz not null default now(),
  constraint organization_job_rule_matches_job_owner_fkey
    foreign key (job_id, user_id)
    references public.organization_jobs(id, user_id) on delete cascade,
  constraint organization_job_rule_matches_destination_shape check (
    (
      destination_kind = 'note'
      and destination_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    ) or (
      destination_kind = 'space'
      and destination_id ~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
    )
  )
);

create or replace function private.enforce_organization_job_rule_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule_row public.routing_rules%rowtype;
begin
  select * into rule_row
  from public.routing_rules
  where id = new.rule_id
    and user_id = new.user_id
  for share;

  if not found
    or not rule_row.enabled
    or rule_row.current_revision <> new.rule_revision
    or rule_row.priority <> new.priority
    or not new.matched
    or (
      new.destination_kind = 'note'
      and (
        rule_row.destination_note_id is distinct from new.destination_id
        or rule_row.destination_space_id is not null
      )
    )
    or (
      new.destination_kind = 'space'
      and (
        rule_row.destination_space_id is distinct from new.destination_id
        or rule_row.destination_note_id is not null
      )
    )
  then
    raise exception using
      errcode = '23514', message = 'organization_rule_match_invalid';
  end if;

  if new.destination_kind = 'note' and not exists (
    select 1 from public.notes
    where id = new.destination_id
      and user_id = new.user_id
      and deleted_at is null
  ) then
    raise exception using
      errcode = '23514', message = 'organization_rule_destination_invalid';
  end if;
  if new.destination_kind = 'space' and not exists (
    select 1 from public.spaces
    where id = new.destination_id
      and user_id = new.user_id
  ) then
    raise exception using
      errcode = '23514', message = 'organization_rule_destination_invalid';
  end if;
  return new;
end;
$$;

create trigger organization_job_rule_matches_validate
before insert on public.organization_job_rule_matches
for each row execute function private.enforce_organization_job_rule_match();

create or replace function private.reject_immutable_job_snapshot_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'immutable_job_snapshot';
end;
$$;

create trigger organization_job_ai_settings_immutable
before update on public.organization_job_ai_settings
for each row execute function private.reject_immutable_job_snapshot_update();

create trigger organization_job_rule_matches_immutable
before update on public.organization_job_rule_matches
for each row execute function private.reject_immutable_job_snapshot_update();

-- New evidence tables have no direct runtime surface.  Future Milestone E RPCs
-- will remain security-definer, owner-scoped capabilities.
alter table public.organization_job_ai_settings enable row level security;
alter table public.organization_job_ai_settings force row level security;
alter table public.organization_job_rule_matches enable row level security;
alter table public.organization_job_rule_matches force row level security;
alter table public.feedback_event_mutations enable row level security;
alter table public.feedback_event_mutations force row level security;

revoke all on table public.organization_job_ai_settings
  from public, anon, authenticated, service_role;
revoke all on table public.organization_job_rule_matches
  from public, anon, authenticated, service_role;
revoke all on table public.feedback_event_mutations
  from public, anon, authenticated, service_role;

do $$
declare
  capability_role text;
begin
  foreach capability_role in array array[
    'unfiled_organizer_worker',
    'unfiled_index_worker',
    'unfiled_rag_verifier'
  ] loop
    if exists (
      select 1 from pg_catalog.pg_roles where rolname = capability_role
    ) then
      execute format(
        'revoke all on table public.organization_job_ai_settings, '
          || 'public.organization_job_rule_matches, '
          || 'public.feedback_event_mutations from %I',
        capability_role
      );
    end if;
  end loop;
end;
$$;

revoke execute on function private.enforce_profile_settings_revision()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_provider_key_credential_revision()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_routing_rule_current_revision()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_generated_block_state_revision()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_review_state_transition()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_generated_block_review_binding()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_feedback_event_bindings()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_feedback_event_mutation_binding()
  from public, anon, authenticated, service_role;
revoke execute on function private.insert_organization_job_ai_settings(text, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.snapshot_organization_job_ai_settings()
  from public, anon, authenticated, service_role;
revoke execute on function private.enforce_organization_job_rule_match()
  from public, anon, authenticated, service_role;
revoke execute on function private.reject_immutable_job_snapshot_update()
  from public, anon, authenticated, service_role;
