-- Milestone E4: Vault-only BYOK custody, revisioned owner AI settings, and
-- lease-bound organizer credential resolution.

-- BYOK is deliberately unavailable unless the reviewed Supabase Vault API is
-- present. There is no application-ciphertext or content-key fallback.
do $$
begin
  if to_regclass('vault.secrets') is null
    or to_regclass('vault.decrypted_secrets') is null
    or to_regprocedure(
      'vault.create_secret(text,text,text,uuid)'
    ) is null
  then
    raise exception using
      errcode = 'P0001', message = 'provider_vault_unavailable';
  end if;
end;
$$;

-- E0 could represent providers that this E4 runtime does not implement. Do
-- not silently rewrite an owner's BYOK consent during deployment: an operator
-- must move each unsupported profile to app-default or OpenAI, then retry.
do $$
begin
  if exists (
    select 1
    from public.profiles
    where provider_mode = 'byok'
      and byok_provider is distinct from 'openai'::public.ai_provider
  ) or exists (
    select 1
    from public.user_provider_keys
    where provider is distinct from 'openai'::public.ai_provider
  ) then
    raise exception using errcode = 'P0001',
      message = 'unsupported_byok_provider_operator_remediation_required';
  end if;
end;
$$;

-- The suffix is returned to web and native clients. Fail closed on legacy
-- metadata that is not exactly four visible ASCII bytes; never normalize a
-- credential-derived display value on the owner's behalf.
do $$
begin
  if exists (
    select 1
    from public.user_provider_keys
    where char_length(key_last4) <> 4
      or octet_length(key_last4) <> 4
      or key_last4 !~ '^[!-~]{4}$'
  ) then
    raise exception using errcode = 'P0001',
      message = 'provider_key_last_four_operator_remediation_required';
  end if;
end;
$$;

-- Active means that the provider-validation boundary accepted the credential.
-- A legacy active/null row cannot be distinguished from an unvalidated key, so
-- deployment requires explicit operator remediation instead of assuming trust.
do $$
begin
  if exists (
    select 1
    from public.user_provider_keys
    where status = 'active' and validated_at is null
  ) then
    raise exception using errcode = 'P0001',
      message = 'provider_key_validation_operator_remediation_required';
  end if;
end;
$$;

alter table public.profiles
  drop constraint profiles_provider_mode_shape,
  add constraint profiles_provider_mode_shape check (
    (
      provider_mode = 'app_default'
      and byok_provider is null
      and not byok_fallback_to_app
    )
    or (
      provider_mode = 'byok'
      and byok_provider is not null
      and byok_provider = 'openai'::public.ai_provider
    )
  );

alter table public.user_provider_keys
  drop constraint user_provider_keys_key_last4_check,
  add constraint user_provider_keys_key_last4_check check (
    char_length(key_last4) = 4
    and octet_length(key_last4) = 4
    and key_last4 ~ '^[!-~]{4}$'
  ),
  add constraint user_provider_keys_e4_provider_supported check (
    provider = 'openai'::public.ai_provider
  ),
  add constraint user_provider_keys_active_validated check (
    status <> 'active'::public.key_status or validated_at is not null
  );

-- A Vault locator may belong to exactly one owner/provider binding. Do not add
-- a foreign key to Vault: Vault is extension-owned, and deletion must remain
-- an explicit, verified operation inside the reviewed capabilities below.
do $$
begin
  if exists (
    select 1
    from public.user_provider_keys
    group by vault_secret_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = 'P0001', message = 'provider_vault_locator_alias';
  end if;
end;
$$;

alter table public.user_provider_keys
  add constraint user_provider_keys_vault_secret_id_key
  unique (vault_secret_id);

alter table public.user_provider_keys force row level security;
alter table public.profiles force row level security;

-- Reads of the owner's non-secret profile remain covered by the established
-- owner RLS policy. All runtime writes now go through exact CAS capabilities.
revoke insert, update, delete on table public.profiles from authenticated;
revoke all on table public.profiles from service_role;
revoke all on table public.user_provider_keys
  from public, anon, authenticated, service_role;

-- Client and isolated-worker principals have no generic table or Vault
-- capability. Supabase Vault grants service_role from its extension owner;
-- these service_role REVOKEs are therefore best-effort when the migration
-- owner is not that grantor. Vault remains outside PostgREST's exposed schemas,
-- while SECURITY DEFINER functions below expose only bounded projections.
revoke all privileges on all tables in schema vault
  from public, anon, authenticated, service_role,
    unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function
  vault.create_secret(text, text, text, uuid),
  vault.update_secret(uuid, text, text, text, uuid),
  vault._crypto_aead_det_decrypt(bytea, bytea, bigint, bytea, bytea)
  from public, anon, authenticated, service_role,
    unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke usage on schema vault
  from public, anon, authenticated, service_role,
    unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

-- Content-free command receipts never hash or persist a provider credential.
-- Provider-key PUT replay is read-only but binds the receipt revision to the
-- current active row and compares the supplied secret exactly and transiently
-- with its live Vault value; no secret-derived fingerprint becomes durable.
-- A different non-secret receipt binding is rejected.
create table private.owner_ai_command_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 80
    and btrim(idempotency_key) = idempotency_key
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  scope text not null check (scope in (
    'update_ai_settings', 'put_provider_key', 'delete_provider_key'
  )),
  expected_revision integer not null check (expected_revision >= 0),
  provider public.ai_provider,
  request_fingerprint text not null
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_json jsonb not null check (jsonb_typeof(response_json) = 'object'),
  completed_at timestamptz not null default clock_timestamp(),
  primary key (user_id, idempotency_key),
  check (
    (scope = 'update_ai_settings' and provider is null)
    or (scope in ('put_provider_key', 'delete_provider_key')
      and provider is not null)
  )
);

-- This private epoch survives deletion of the live metadata row. It prevents
-- ABA after delete/recreate and lets a late provider response invalidate only
-- the exact credential revision it actually used.
create table private.provider_key_revision_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.ai_provider not null,
  current_revision integer not null check (current_revision >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, provider)
);

insert into private.provider_key_revision_counters (
  user_id, provider, current_revision
)
select user_id, provider, credential_revision
from public.user_provider_keys
on conflict (user_id, provider) do update
set current_revision = greatest(
  private.provider_key_revision_counters.current_revision,
  excluded.current_revision
);

-- Resolver receipts carry only the exact lease-bound source and revision. They
-- authorize failure handling without retaining a key, Vault locator, name, or
-- derived credential value.
create table private.organizer_provider_resolutions (
  job_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt integer not null check (attempt between 1 and 5),
  lease_token uuid not null,
  provider public.ai_provider not null,
  source text not null check (source in ('app_default', 'byok')),
  credential_revision integer not null check (credential_revision >= 0),
  resolved_at timestamptz not null default clock_timestamp(),
  primary key (job_id, attempt, lease_token),
  constraint organizer_provider_resolutions_job_owner_fkey
    foreign key (job_id, user_id)
    references public.organization_jobs(id, user_id) on delete cascade,
  check (
    (source = 'app_default' and credential_revision = 0)
    or (source = 'byok' and credential_revision >= 1)
  )
);

-- Once a job transitions from BYOK to the application key it stays on that
-- route. This is one immutable-snapshot-authorized transition, not a toggle on
-- every retry.
create table private.organizer_provider_fallbacks (
  job_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.ai_provider not null,
  activated_attempt integer not null check (activated_attempt between 1 and 5),
  activated_lease_token uuid not null,
  credential_revision integer not null check (credential_revision >= 0),
  reason public.safe_error_code not null check (
    reason in ('provider_key_invalid', 'provider_unavailable')
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint organizer_provider_fallbacks_job_owner_fkey
    foreign key (job_id, user_id)
    references public.organization_jobs(id, user_id) on delete cascade
);

revoke all on table
  private.owner_ai_command_receipts,
  private.provider_key_revision_counters,
  private.organizer_provider_resolutions,
  private.organizer_provider_fallbacks
from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

-- Extend the single owner/idempotency namespace to E4. The existing triggers
-- on encrypted command families immediately pick up this replacement; E4's
-- private receipt table receives the same guard below.
create or replace function private.enforce_encrypted_idempotency_namespace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conflicting_claims integer;
  matching_claims integer;
begin
  if tg_op <> 'INSERT'
    or not (
      (
        tg_table_schema = 'public'
        and tg_table_name in (
          'api_idempotency_records', 'encrypted_note_write_claims',
          'encrypted_taxonomy_write_claims',
          'encrypted_owner_interaction_claims',
          'encrypted_routing_rule_write_claims'
        )
      ) or (
        tg_table_schema = 'private'
        and tg_table_name = 'owner_ai_command_receipts'
      )
    )
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_encrypted_idempotency_namespace_target';
  end if;

  if tg_table_name = 'api_idempotency_records' then
    select count(*), count(*) filter (where claim_scope = new.scope)
    into conflicting_claims, matching_claims
    from (
      select scope as claim_scope from public.encrypted_note_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_taxonomy_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_owner_interaction_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_routing_rule_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from private.owner_ai_command_receipts
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) as claims;
    if exists (
      select 1
      from private.encrypted_routing_rule_observation_abandonments
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) or exists (
      select 1 from private.owner_ai_command_receipts
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) or conflicting_claims > 1
      or (conflicting_claims = 1 and matching_claims <> 1)
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
  elsif exists (
    select 1
    from private.encrypted_routing_rule_observation_abandonments
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  ) or exists (
    select 1 from public.api_idempotency_records
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  ) or (tg_table_name <> 'encrypted_note_write_claims' and exists (
    select 1 from public.encrypted_note_write_claims
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  )) or (tg_table_name <> 'encrypted_taxonomy_write_claims' and exists (
    select 1 from public.encrypted_taxonomy_write_claims
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  )) or (tg_table_name <> 'encrypted_owner_interaction_claims' and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  )) or (tg_table_name <> 'encrypted_routing_rule_write_claims' and exists (
    select 1 from public.encrypted_routing_rule_write_claims
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  )) or (tg_table_name <> 'owner_ai_command_receipts' and exists (
    select 1 from private.owner_ai_command_receipts
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  )) then
    raise exception using errcode = 'P0001',
      message = 'invalid_idempotency_key';
  end if;
  return new;
end;
$$;

create trigger owner_ai_command_receipts_namespace_guard
before insert on private.owner_ai_command_receipts
for each row execute function private.enforce_encrypted_idempotency_namespace();

create function private.owner_ai_settings_projection(
  p_profile public.profiles
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'settingsRevision', p_profile.settings_revision,
    'organizationMode', p_profile.org_mode,
    'providerMode', p_profile.provider_mode,
    'byokProvider', case when p_profile.provider_mode = 'byok'
      then p_profile.byok_provider else null end,
    'byokFallbackToApp', case when p_profile.provider_mode = 'byok'
      then p_profile.byok_fallback_to_app else false end,
    'routingEffort', p_profile.routing_effort,
    'expansionStyle', case when p_profile.expansion_enabled
      then p_profile.expansion_style
      else 'off'::public.expansion_style end,
    'timezone', p_profile.timezone,
    'locale', p_profile.locale,
    'updatedAt', p_profile.updated_at
  );
$$;

create function private.provider_key_metadata_projection(
  p_key public.user_provider_keys
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'provider', p_key.provider,
    'lastFour', p_key.key_last4,
    'status', p_key.status,
    'credentialRevision', p_key.credential_revision,
    'validatedAt', p_key.validated_at,
    'updatedAt', p_key.updated_at
  );
$$;

create function private.replay_owner_ai_command(
  p_user_id uuid,
  p_idempotency_key text,
  p_scope text,
  p_expected_revision integer,
  p_provider public.ai_provider,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  receipt private.owner_ai_command_receipts%rowtype;
begin
  select * into receipt
  from private.owner_ai_command_receipts
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  for update;
  if not found then return null; end if;
  if receipt.scope <> p_scope
    or receipt.expected_revision <> p_expected_revision
    or receipt.provider is distinct from p_provider
    or receipt.request_fingerprint <> p_request_fingerprint
  then
    raise exception using
      errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return jsonb_set(
    receipt.response_json, '{replayed}', 'true'::jsonb, true
  );
end;
$$;

create function private.finish_owner_ai_command(
  p_user_id uuid,
  p_idempotency_key text,
  p_scope text,
  p_expected_revision integer,
  p_provider public.ai_provider,
  p_request_fingerprint text,
  p_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.owner_ai_command_receipts (
    user_id, idempotency_key, scope, expected_revision, provider,
    request_fingerprint, response_json
  ) values (
    p_user_id, p_idempotency_key, p_scope, p_expected_revision, p_provider,
    p_request_fingerprint, p_response
  );
end;
$$;

-- A profile can disable expansion globally while an individual capture can
-- also opt out. Missing job settings fail closed.
create function private.effective_organizer_expansion_disabled(
  p_job_id text,
  p_user_id uuid,
  p_capture_disabled boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_capture_disabled, true) or coalesce((
    select snapshot.expansion_style = 'off'
    from public.organization_job_ai_settings as snapshot
    where snapshot.job_id = p_job_id and snapshot.user_id = p_user_id
  ), true);
$$;

-- E4 settings commands are revisioned events, including an accepted no-op
-- patch. The exact service capability below supplies old+1 explicitly; normal
-- profile updates that do not touch settings continue to preserve the revision,
-- and jumps remain rejected.
create or replace function private.enforce_profile_settings_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  settings_changed boolean := row(
    new.org_mode,
    new.provider_mode,
    new.byok_provider,
    new.byok_fallback_to_app,
    new.routing_effort,
    new.expansion_style,
    new.expansion_enabled,
    new.timezone,
    new.locale
  ) is distinct from row(
    old.org_mode,
    old.provider_mode,
    old.byok_provider,
    old.byok_fallback_to_app,
    old.routing_effort,
    old.expansion_style,
    old.expansion_enabled,
    old.timezone,
    old.locale
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
  elsif new.settings_revision = old.settings_revision + 1 then
    -- An exact E4 no-op command still consumes one CAS revision.
    null;
  elsif new.settings_revision <> old.settings_revision then
    raise exception using
      errcode = 'P0001', message = 'settings_revision_without_change';
  end if;
  return new;
end;
$$;

-- Patch only the reviewed non-secret claim/control projections. Every patch is
-- cardinality-checked so upstream drift aborts the migration.
do $$
declare
  signature regprocedure;
  definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
  expected_occurrence_count integer;
begin
  signature :=
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
      ::regprocedure;
  definition := pg_catalog.pg_get_functiondef(signature);
  old_fragment := '''commandProjection'', coalesce((';
  new_fragment :=
    '''routingEffort'', (' || chr(10)
    || '        select snapshot.routing_effort' || chr(10)
    || '        from public.organization_job_ai_settings as snapshot' || chr(10)
    || '        where snapshot.job_id = job_row.id' || chr(10)
    || '          and snapshot.user_id = job_row.user_id' || chr(10)
    || '      ),' || chr(10)
    || '      ''expansionStyle'', (' || chr(10)
    || '        select snapshot.expansion_style' || chr(10)
    || '        from public.organization_job_ai_settings as snapshot' || chr(10)
    || '        where snapshot.job_id = job_row.id' || chr(10)
    || '          and snapshot.user_id = job_row.user_id' || chr(10)
    || '      ),' || chr(10)
    || '      ''commandProjection'', coalesce((';
  occurrence_count := (
    char_length(definition)
    - char_length(replace(definition, old_fragment, ''))
  ) / char_length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_settings_projection_drift';
  end if;
  execute replace(definition, old_fragment, new_fragment);

  foreach signature in array array[
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
      ::regprocedure,
    'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'
      ::regprocedure,
    'private.list_encrypted_organizer_candidates_impl(text,text,integer)'
      ::regprocedure,
    'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'
      ::regprocedure
  ] loop
    definition := pg_catalog.pg_get_functiondef(signature);
    if signature =
      'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
        ::regprocedure
    then
      old_fragment := 'capture_row.expansion_disabled';
      new_fragment := 'private.effective_organizer_expansion_disabled(' ||
        'job_row.id, job_row.user_id, capture_row.expansion_disabled)';
    else
      old_fragment := 'capture.expansion_disabled';
      new_fragment := 'private.effective_organizer_expansion_disabled(' ||
        'job_row.id, job_row.user_id, capture.expansion_disabled)';
    end if;
    expected_occurrence_count := case when signature =
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'
        ::regprocedure
      then 2 else 1 end;
    occurrence_count := (
      char_length(definition)
      - char_length(replace(definition, old_fragment, ''))
    ) / char_length(old_fragment);
    if occurrence_count <> expected_occurrence_count then
      raise exception using errcode = 'P0001',
        message = 'organizer_expansion_control_projection_drift';
    end if;
    execute replace(definition, old_fragment, new_fragment);
  end loop;
end;
$$;

create function public.get_owner_ai_settings(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into profile_row from public.profiles where id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return jsonb_build_object(
    'settings', private.owner_ai_settings_projection(profile_row)
  );
end;
$$;

create function public.update_owner_ai_settings(
  p_user_id uuid,
  p_expected_settings_revision integer,
  p_idempotency_key text,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  response_value jsonb;
  replay_value jsonb;
  fingerprint_value text;
  organization_mode_value public.org_mode;
  provider_mode_value public.provider_mode;
  byok_provider_value public.ai_provider;
  fallback_value boolean;
  routing_effort_value public.routing_effort;
  expansion_style_value public.expansion_style;
  timezone_value text;
  locale_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null
    or p_expected_settings_revision is null
    or p_expected_settings_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_patch is null
    or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb
    or p_patch - array[
      'organizationMode', 'providerMode', 'byokProvider',
      'byokFallbackToApp', 'routingEffort', 'expansionStyle',
      'timezone', 'locale'
    ] <> '{}'::jsonb
    or (p_patch ? 'organizationMode'
      and jsonb_typeof(p_patch -> 'organizationMode') <> 'string')
    or (p_patch ? 'providerMode'
      and jsonb_typeof(p_patch -> 'providerMode') <> 'string')
    or (p_patch ? 'byokProvider'
      and jsonb_typeof(p_patch -> 'byokProvider') not in ('null', 'string'))
    or (p_patch ? 'byokFallbackToApp'
      and jsonb_typeof(p_patch -> 'byokFallbackToApp') <> 'boolean')
    or (p_patch ? 'routingEffort'
      and jsonb_typeof(p_patch -> 'routingEffort') <> 'string')
    or (p_patch ? 'expansionStyle'
      and jsonb_typeof(p_patch -> 'expansionStyle') <> 'string')
    or (p_patch ? 'timezone'
      and jsonb_typeof(p_patch -> 'timezone') <> 'string')
    or (p_patch ? 'locale'
      and jsonb_typeof(p_patch -> 'locale') <> 'string')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  fingerprint_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.owner-ai-settings.v1',
    'expectedRevision', p_expected_settings_revision,
    'patch', p_patch
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_value := private.replay_owner_ai_command(
    p_user_id, p_idempotency_key, 'update_ai_settings',
    p_expected_settings_revision, null, fingerprint_value
  );
  if replay_value is not null then return replay_value; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':content-encryption-rollout', 0
  ));
  select * into profile_row
  from public.profiles
  where id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if profile_row.settings_revision <> p_expected_settings_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  organization_mode_value := profile_row.org_mode;
  provider_mode_value := profile_row.provider_mode;
  byok_provider_value := profile_row.byok_provider;
  fallback_value := profile_row.byok_fallback_to_app;
  routing_effort_value := profile_row.routing_effort;
  expansion_style_value := case when profile_row.expansion_enabled
    then profile_row.expansion_style else 'off'::public.expansion_style end;
  timezone_value := profile_row.timezone;
  locale_value := profile_row.locale;

  begin
    if p_patch ? 'organizationMode' then
      organization_mode_value :=
        (p_patch ->> 'organizationMode')::public.org_mode;
    end if;
    if p_patch ? 'providerMode' then
      provider_mode_value :=
        (p_patch ->> 'providerMode')::public.provider_mode;
    end if;
    if p_patch ? 'byokProvider' then
      byok_provider_value := case
        when jsonb_typeof(p_patch -> 'byokProvider') = 'null' then null
        else (p_patch ->> 'byokProvider')::public.ai_provider end;
    end if;
    if p_patch ? 'byokFallbackToApp' then
      fallback_value := (p_patch ->> 'byokFallbackToApp')::boolean;
    end if;
    if p_patch ? 'routingEffort' then
      routing_effort_value :=
        (p_patch ->> 'routingEffort')::public.routing_effort;
    end if;
    if p_patch ? 'expansionStyle' then
      expansion_style_value :=
        (p_patch ->> 'expansionStyle')::public.expansion_style;
    end if;
    if p_patch ? 'timezone' then
      timezone_value := p_patch ->> 'timezone';
    end if;
    if p_patch ? 'locale' then locale_value := p_patch ->> 'locale'; end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  if char_length(timezone_value) not between 1 and 100
    or btrim(timezone_value) <> timezone_value
    or not exists (
      select 1 from pg_catalog.pg_timezone_names()
      where name = timezone_value
    )
    or char_length(locale_value) not between 2 and 35
    or btrim(locale_value) <> locale_value
    or locale_value !~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
    or (
      provider_mode_value = 'app_default'
      and (byok_provider_value is not null or fallback_value)
    )
    or (
      provider_mode_value = 'byok'
      and byok_provider_value is distinct from 'openai'::public.ai_provider
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  update public.profiles
  set
    settings_revision = p_expected_settings_revision + 1,
    org_mode = organization_mode_value,
    provider_mode = provider_mode_value,
    byok_provider = byok_provider_value,
    byok_fallback_to_app = fallback_value,
    routing_effort = routing_effort_value,
    expansion_style = expansion_style_value,
    expansion_enabled = expansion_style_value <> 'off',
    timezone = timezone_value,
    locale = locale_value
  where id = p_user_id
  returning * into profile_row;

  response_value := jsonb_build_object(
    'settings', private.owner_ai_settings_projection(profile_row),
    'replayed', false
  );
  perform private.finish_owner_ai_command(
    p_user_id, p_idempotency_key, 'update_ai_settings',
    p_expected_settings_revision, null, fingerprint_value, response_value
  );
  return response_value;
end;
$$;

create function public.get_user_provider_key_status(
  p_user_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_row public.user_provider_keys%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null or p_provider is distinct from 'openai' then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = 'openai';
  return jsonb_build_object(
    'providerKey', case when found
      then private.provider_key_metadata_projection(key_row)
      else null end
  );
end;
$$;

create function public.put_user_provider_key(
  p_user_id uuid,
  p_provider text,
  p_api_key text,
  p_expected_credential_revision integer,
  p_idempotency_key text,
  p_replay_only boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  key_row public.user_provider_keys%rowtype;
  counter_row private.provider_key_revision_counters%rowtype;
  existing_found boolean;
  target_revision integer;
  old_vault_secret_id uuid;
  new_vault_secret_id uuid;
  fingerprint_value text;
  response_value jsonb;
  replay_value jsonb;
  replay_revision integer;
  replay_credential_value text;
  replay_vault_found boolean := false;
  expected_value integer := coalesce(p_expected_credential_revision, 0);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null
    or p_provider is distinct from 'openai'
    or (p_expected_credential_revision is not null
      and p_expected_credential_revision < 1)
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_replay_only is null
    or p_api_key is null
    or char_length(p_api_key) not between 20 and 500
    or octet_length(p_api_key) <> char_length(p_api_key)
    or p_api_key !~ '^[!-~]+$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- The fingerprint excludes every property of the repeated secret body.
  -- A replay compares the supplied key only transiently against the current
  -- Vault value; it never hashes or persists any property of the secret.
  fingerprint_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.provider-key-put.v1',
    'provider', p_provider,
    'expectedRevision', expected_value
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_value := private.replay_owner_ai_command(
    p_user_id, p_idempotency_key, 'put_provider_key', expected_value,
    'openai'::public.ai_provider, fingerprint_value
  );
  if replay_value is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_user_id::text || ':content-encryption-rollout', 0
    ));
    begin
      replay_revision :=
        (replay_value #>> '{providerKey,credentialRevision}')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = 'P0001', message = 'provider_unavailable';
    end;
    select * into key_row
    from public.user_provider_keys
    where user_id = p_user_id and provider = 'openai'
    for share;
    if not found
      or replay_revision is null
      or replay_value #>> '{providerKey,provider}' is distinct from 'openai'
      or key_row.credential_revision <> replay_revision
      or key_row.status <> 'active'
      or key_row.validated_at is null
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    begin
      select secret.decrypted_secret, true
      into replay_credential_value, replay_vault_found
      from vault.decrypted_secrets as secret
      where secret.id = key_row.vault_secret_id;
    exception when others then
      raise exception using
        errcode = 'P0001', message = 'provider_unavailable';
    end;
    if not replay_vault_found or replay_credential_value is null then
      raise exception using errcode = 'P0001', message = 'provider_unavailable';
    end if;
    if replay_credential_value <> p_api_key then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return replay_value;
  end if;
  if p_replay_only then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  insert into private.provider_key_revision_counters (
    user_id, provider, current_revision
  ) values (p_user_id, 'openai', 0)
  on conflict (user_id, provider) do nothing;
  select * into counter_row
  from private.provider_key_revision_counters
  where user_id = p_user_id and provider = 'openai'
  for update;

  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = 'openai'
  for update;
  existing_found := found;
  if (p_expected_credential_revision is null and existing_found)
    or (p_expected_credential_revision is not null and (
      not existing_found
      or key_row.credential_revision <> p_expected_credential_revision
    ))
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  if existing_found
    and counter_row.current_revision <> key_row.credential_revision
  then
    raise exception using
      errcode = 'P0001', message = 'provider_revision_counter_mismatch';
  end if;
  if counter_row.current_revision >= 2147483647 then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;
  target_revision := counter_row.current_revision + 1;
  old_vault_secret_id := case when existing_found
    then key_row.vault_secret_id else null end;

  begin
    new_vault_secret_id := vault.create_secret(
      p_api_key,
      'unfiled-byok-' || extensions.gen_random_uuid()::text,
      'Unfiled provider credential',
      null::uuid
    );
    if new_vault_secret_id is null or not exists (
      select 1 from vault.secrets where id = new_vault_secret_id
    ) then
      raise exception using errcode = 'P0001', message = 'vault_write_failed';
    end if;
  exception when others then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end;

  if existing_found then
    update public.user_provider_keys
    set
      vault_secret_id = new_vault_secret_id,
      key_ciphertext = null,
      key_last4 = right(p_api_key, 4),
      status = 'active',
      validated_at = clock_timestamp()
    where id = key_row.id
      and user_id = p_user_id
      and credential_revision = p_expected_credential_revision
    returning * into key_row;
    if not found or key_row.credential_revision <> target_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    delete from vault.secrets where id = old_vault_secret_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'provider_unavailable';
    end if;
  else
    insert into public.user_provider_keys (
      user_id, provider, vault_secret_id, key_ciphertext, key_last4,
      status, validated_at, credential_revision
    ) values (
      p_user_id, 'openai', new_vault_secret_id, null,
      right(p_api_key, 4), 'active', clock_timestamp(), target_revision
    ) returning * into key_row;
  end if;

  update private.provider_key_revision_counters
  set current_revision = target_revision, updated_at = clock_timestamp()
  where user_id = p_user_id and provider = 'openai';
  response_value := jsonb_build_object(
    'providerKey', private.provider_key_metadata_projection(key_row),
    'replayed', false
  );
  perform private.finish_owner_ai_command(
    p_user_id, p_idempotency_key, 'put_provider_key', expected_value,
    'openai'::public.ai_provider, fingerprint_value, response_value
  );
  return response_value;
end;
$$;

create function public.delete_user_provider_key(
  p_user_id uuid,
  p_provider text,
  p_expected_credential_revision integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  key_row public.user_provider_keys%rowtype;
  counter_row private.provider_key_revision_counters%rowtype;
  fingerprint_value text;
  response_value jsonb;
  replay_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null
    or p_provider is distinct from 'openai'
    or p_expected_credential_revision is null
    or p_expected_credential_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  fingerprint_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.provider-key-delete.v1',
    'provider', p_provider,
    'expectedRevision', p_expected_credential_revision
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_value := private.replay_owner_ai_command(
    p_user_id, p_idempotency_key, 'delete_provider_key',
    p_expected_credential_revision, 'openai'::public.ai_provider,
    fingerprint_value
  );
  if replay_value is not null then return replay_value; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':content-encryption-rollout', 0
  ));
  select * into counter_row
  from private.provider_key_revision_counters
  where user_id = p_user_id and provider = 'openai'
  for update;
  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = 'openai'
  for update;
  if not found
    or key_row.credential_revision <> p_expected_credential_revision
    or counter_row.current_revision is distinct from key_row.credential_revision
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  delete from vault.secrets where id = key_row.vault_secret_id;
  delete from public.user_provider_keys
  where id = key_row.id and user_id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  response_value := jsonb_build_object(
    'provider', key_row.provider,
    'deleted', true,
    'deletedCredentialRevision', key_row.credential_revision,
    'replayed', false
  );
  perform private.finish_owner_ai_command(
    p_user_id, p_idempotency_key, 'delete_provider_key',
    p_expected_credential_revision, 'openai'::public.ai_provider,
    fingerprint_value, response_value
  );
  return response_value;
end;
$$;

create function private.get_lease_bound_organizer_provider_credential_impl(
  p_job_id text,
  p_lease_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  snapshot_row public.organization_job_ai_settings%rowtype;
  key_row public.user_provider_keys%rowtype;
  prior_resolution private.organizer_provider_resolutions%rowtype;
  credential_value text;
  vault_found boolean := false;
  fallback_active boolean := false;
begin
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into snapshot_row
  from public.organization_job_ai_settings
  where job_id = job_row.id and user_id = job_row.user_id
  for share;
  if not found
    or snapshot_row.selected_provider <> 'openai'
    or snapshot_row.adapter_registry_version
      <> 'organization-model-registry-v1'
  then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;

  select * into prior_resolution
  from private.organizer_provider_resolutions
  where job_id = job_row.id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
  for update;
  if found and prior_resolution.source = 'app_default' then
    return jsonb_build_object(
      'provider', snapshot_row.selected_provider,
      'source', 'app_default',
      'credential', null,
      'credentialRevision', null,
      'routingEffort', snapshot_row.routing_effort,
      'expansionStyle', snapshot_row.expansion_style
    );
  end if;

  select true into fallback_active
  from private.organizer_provider_fallbacks
  where job_id = job_row.id
    and user_id = job_row.user_id
    and provider = snapshot_row.selected_provider;

  if snapshot_row.provider_mode = 'app_default' or fallback_active then
    insert into private.organizer_provider_resolutions (
      job_id, user_id, attempt, lease_token, provider, source,
      credential_revision
    ) values (
      job_row.id, job_row.user_id, job_row.attempt, job_row.lease_token,
      snapshot_row.selected_provider, 'app_default', 0
    ) on conflict (job_id, attempt, lease_token) do update
      set resolved_at = clock_timestamp();
    return jsonb_build_object(
      'provider', snapshot_row.selected_provider,
      'source', 'app_default',
      'credential', null,
      'credentialRevision', null,
      'routingEffort', snapshot_row.routing_effort,
      'expansionStyle', snapshot_row.expansion_style
    );
  end if;

  select * into key_row
  from public.user_provider_keys
  where user_id = job_row.user_id
    and provider = snapshot_row.selected_provider
  for share;
  if prior_resolution.job_id is not null and (
    not found
    or prior_resolution.source <> 'byok'
    or key_row.status <> 'active'
    or key_row.validated_at is null
    or key_row.credential_revision <> prior_resolution.credential_revision
  ) then
    -- Never disclose a second credential under one lease. A retry receives a
    -- fresh lease and may then resolve a valid replacement; deletion still
    -- resolves as provider_key_invalid on that new attempt.
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;
  if not found
    or key_row.status <> 'active'
    or key_row.validated_at is null
  then
    if snapshot_row.byok_fallback_to_app then
      insert into private.organizer_provider_fallbacks (
        job_id, user_id, provider, activated_attempt,
        activated_lease_token, credential_revision, reason
      ) values (
        job_row.id, job_row.user_id, snapshot_row.selected_provider,
        job_row.attempt, job_row.lease_token,
        case when found then key_row.credential_revision else 0 end,
        'provider_key_invalid'
      ) on conflict (job_id) do nothing;
      insert into private.organizer_provider_resolutions (
        job_id, user_id, attempt, lease_token, provider, source,
        credential_revision
      ) values (
        job_row.id, job_row.user_id, job_row.attempt, job_row.lease_token,
        snapshot_row.selected_provider, 'app_default', 0
      ) on conflict (job_id, attempt, lease_token) do update
        set resolved_at = clock_timestamp();
      return jsonb_build_object(
        'provider', snapshot_row.selected_provider,
        'source', 'app_default',
        'credential', null,
        'credentialRevision', null,
        'routingEffort', snapshot_row.routing_effort,
        'expansionStyle', snapshot_row.expansion_style
      );
    end if;
    raise exception using errcode = 'P0001', message = 'provider_key_invalid';
  end if;

  begin
    select secret.decrypted_secret, true
    into credential_value, vault_found
    from vault.decrypted_secrets as secret
    where secret.id = key_row.vault_secret_id;
  exception when others then
    credential_value := null;
    vault_found := false;
  end;
  if not vault_found
    or credential_value is null
    or char_length(credential_value) not between 20 and 500
    or credential_value !~ '^[!-~]+$'
  then
    if prior_resolution.job_id is not null then
      -- A lease that already received BYOK may never switch sources on replay,
      -- even if Vault later becomes unavailable. A retry must receive a fresh
      -- attempt/lease before immutable fallback policy can be applied.
      raise exception using errcode = 'P0001', message = 'provider_unavailable';
    end if;
    if snapshot_row.byok_fallback_to_app then
      insert into private.organizer_provider_fallbacks (
        job_id, user_id, provider, activated_attempt,
        activated_lease_token, credential_revision, reason
      ) values (
        job_row.id, job_row.user_id, snapshot_row.selected_provider,
        job_row.attempt, job_row.lease_token, key_row.credential_revision,
        'provider_unavailable'
      ) on conflict (job_id) do nothing;
      insert into private.organizer_provider_resolutions (
        job_id, user_id, attempt, lease_token, provider, source,
        credential_revision
      ) values (
        job_row.id, job_row.user_id, job_row.attempt, job_row.lease_token,
        snapshot_row.selected_provider, 'app_default', 0
      ) on conflict (job_id, attempt, lease_token) do update
        set resolved_at = clock_timestamp();
      return jsonb_build_object(
        'provider', snapshot_row.selected_provider,
        'source', 'app_default',
        'credential', null,
        'credentialRevision', null,
        'routingEffort', snapshot_row.routing_effort,
        'expansionStyle', snapshot_row.expansion_style
      );
    end if;
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;

  insert into private.organizer_provider_resolutions (
    job_id, user_id, attempt, lease_token, provider, source,
    credential_revision
  ) values (
    job_row.id, job_row.user_id, job_row.attempt, job_row.lease_token,
    snapshot_row.selected_provider, 'byok', key_row.credential_revision
  ) on conflict (job_id, attempt, lease_token) do update
    set resolved_at = clock_timestamp();
  return jsonb_build_object(
    'provider', snapshot_row.selected_provider,
    'source', 'byok',
    'credential', credential_value,
    'credentialRevision', key_row.credential_revision,
    'routingEffort', snapshot_row.routing_effort,
    'expansionStyle', snapshot_row.expansion_style
  );
end;
$$;

create function public.get_lease_bound_organizer_provider_credential(
  p_job_id text,
  p_lease_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_organizer_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.get_lease_bound_organizer_provider_credential_impl(
    p_job_id, p_lease_token
  );
end;
$$;

-- The four-argument fail capability is no longer granted. This overload binds
-- failure to the source/revision disclosed under the same live lease.
create function private.fail_encrypted_organizer_job_e4_impl(
  p_job_id text,
  p_lease_token text,
  p_error_code text,
  p_retryable boolean,
  p_provider_source text,
  p_credential_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  snapshot_row public.organization_job_ai_settings%rowtype;
  error_value public.safe_error_code;
  effective_error_value public.safe_error_code;
  lease_value uuid;
  request_hash_value text;
  next_state public.job_state;
  retry_at timestamptz;
  fallback_transition boolean := false;
  invalidated_revision integer;
begin
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_error_code is null
    or p_retryable is null
    or (
      p_provider_source is null and p_credential_revision is not null
    )
    or (
      p_provider_source = 'app_default' and p_credential_revision is not null
    )
    or (
      p_provider_source = 'byok' and (
        p_credential_revision is null
        or p_credential_revision not between 1 and 2147483647
      )
    )
    or p_provider_source not in ('app_default', 'byok')
      and p_provider_source is not null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    lease_value := p_lease_token::uuid;
    error_value := p_error_code::public.safe_error_code;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  effective_error_value := case
    when p_provider_source = 'app_default'
      and error_value = 'provider_key_invalid'
    then 'provider_unavailable'::public.safe_error_code
    else error_value end;
  request_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-organizer-fail.v2',
    'errorCode', error_value,
    'retryable', p_retryable,
    'providerSource', p_provider_source,
    'credentialRevision', p_credential_revision
  ));

  job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  if job_row.last_transition_lease_token = lease_value
    and job_row.last_transition_action = 'failed'
  then
    if job_row.last_transition_request_hash <> request_hash_value then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'jobId', job_row.id, 'state', job_row.state, 'replayed', true
    );
  end if;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into snapshot_row
  from public.organization_job_ai_settings
  where job_id = job_row.id and user_id = job_row.user_id
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;
  if p_provider_source is not null and not exists (
    select 1
    from private.organizer_provider_resolutions as resolution
    where resolution.job_id = job_row.id
      and resolution.user_id = job_row.user_id
      and resolution.attempt = job_row.attempt
      and resolution.lease_token = job_row.lease_token
      and resolution.provider = snapshot_row.selected_provider
      and resolution.source = p_provider_source
      and resolution.credential_revision =
        coalesce(p_credential_revision::integer, 0)
  ) then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if error_value = 'provider_key_invalid'
    and p_provider_source is null
    and exists (
      select 1
      from private.organizer_provider_resolutions as resolution
      where resolution.job_id = job_row.id
        and resolution.user_id = job_row.user_id
        and resolution.attempt = job_row.attempt
        and resolution.lease_token = job_row.lease_token
    )
  then
    -- Null source is reserved for resolver-side missing/deleted/invalid BYOK,
    -- before a route is disclosed. After disclosure, a 401/403 must bind the
    -- exact BYOK revision (or the app-default source) from the lease receipt.
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  if error_value = 'provider_key_invalid'
    and p_provider_source = 'byok'
  then
    insert into private.provider_key_revision_counters (
      user_id, provider, current_revision
    ) values (job_row.user_id, snapshot_row.selected_provider, 0)
    on conflict (user_id, provider) do nothing;
    perform 1
    from private.provider_key_revision_counters
    where user_id = job_row.user_id
      and provider = snapshot_row.selected_provider
    for update;
    if not found then
      raise exception using
        errcode = 'P0001', message = 'provider_revision_counter_mismatch';
    end if;
    update public.user_provider_keys
    set status = 'invalid'
    where user_id = job_row.user_id
      and provider = snapshot_row.selected_provider
      and status = 'active'
      and credential_revision = p_credential_revision::integer
    returning credential_revision into invalidated_revision;
    if found then
      update private.provider_key_revision_counters
      set
        current_revision = invalidated_revision,
        updated_at = clock_timestamp()
      where user_id = job_row.user_id
        and provider = snapshot_row.selected_provider
        and current_revision = p_credential_revision::integer;
      if not found then
        raise exception using
          errcode = 'P0001', message = 'provider_revision_counter_mismatch';
      end if;
    end if;
    if snapshot_row.byok_fallback_to_app
      and snapshot_row.selected_provider = 'openai'
      and job_row.attempt < 5
    then
      insert into private.organizer_provider_fallbacks (
        job_id, user_id, provider, activated_attempt,
        activated_lease_token, credential_revision, reason
      ) values (
        job_row.id, job_row.user_id, snapshot_row.selected_provider,
        job_row.attempt, job_row.lease_token,
        p_credential_revision::integer, 'provider_key_invalid'
      ) on conflict (job_id) do nothing;
      fallback_transition := true;
    end if;
  end if;

  perform private.burn_encrypted_organizer_reservations(
    job_row.id, lease_value
  );
  next_state := case
    when fallback_transition then 'awaiting_retry'::public.job_state
    when effective_error_value = 'provider_key_invalid'
      then 'failed'::public.job_state
    when p_retryable and job_row.attempt < 5
      then 'awaiting_retry'::public.job_state
    when p_retryable then 'dead_letter'::public.job_state
    else 'failed'::public.job_state
  end;
  retry_at := case when next_state = 'awaiting_retry' then
    clock_timestamp() + pg_catalog.make_interval(
      secs => least(300, (2 ^ greatest(job_row.attempt - 1, 0))::integer)
    ) else job_row.available_at end;

  update public.organization_jobs
  set
    state = next_state,
    available_at = retry_at,
    completed_at = case when next_state = 'awaiting_retry' then null
      else clock_timestamp() end,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    error_code = effective_error_value,
    last_transition_lease_token = lease_value,
    last_transition_action = 'failed',
    last_transition_request_hash = request_hash_value
  where id = job_row.id
    and state = 'running'
    and lease_token = lease_value
  returning * into job_row;
  if not found then
    raise exception using
      errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  update public.encrypted_organizer_preparations
  set
    write_reservation_id = null,
    decision_reservation_id = null,
    review_reservation_id = null,
    receipt_reservation_id = null,
    object_key_id = null,
    object_key_version = null,
    controls = null,
    updated_at = clock_timestamp()
  where job_id = job_row.id and completed_at is null;
  update public.captures
  set
    status = case
      when next_state = 'awaiting_retry' then 'queued'::public.capture_status
      when effective_error_value = 'provider_key_invalid'
        then 'inbox'::public.capture_status
      else 'failed'::public.capture_status end,
    last_error_code = effective_error_value
  where id = job_row.capture_id and user_id = job_row.user_id;
  perform private.emit_user_event(
    job_row.user_id, 'organization_job', job_row.id
  );
  perform private.emit_user_event(
    job_row.user_id, 'capture', job_row.capture_id
  );
  return jsonb_build_object(
    'jobId', job_row.id, 'state', job_row.state, 'replayed', false
  );
end;
$$;

create function public.fail_encrypted_organizer_job(
  p_job_id text,
  p_lease_token text,
  p_error_code text,
  p_retryable boolean,
  p_provider_source text,
  p_credential_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_organizer_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.fail_encrypted_organizer_job_e4_impl(
    p_job_id, p_lease_token, p_error_code, p_retryable,
    p_provider_source, p_credential_revision
  );
end;
$$;

-- Exact capability grants. The old fail overload stays present only for
-- migration-history test compatibility and is no longer executable by any
-- runtime role.
revoke execute on function public.get_owner_ai_settings(uuid)
  from public, anon, authenticated, unfiled_index_worker,
    unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.update_owner_ai_settings(
  uuid, integer, text, jsonb
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.get_user_provider_key_status(uuid, text)
  from public, anon, authenticated, unfiled_index_worker,
    unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.put_user_provider_key(
  uuid, text, text, integer, text, boolean
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.delete_user_provider_key(
  uuid, text, integer, text
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

grant execute on function public.get_owner_ai_settings(uuid) to service_role;
grant execute on function public.update_owner_ai_settings(
  uuid, integer, text, jsonb
) to service_role;
grant execute on function public.get_user_provider_key_status(uuid, text)
  to service_role;
grant execute on function public.put_user_provider_key(
  uuid, text, text, integer, text, boolean
) to service_role;
grant execute on function public.delete_user_provider_key(
  uuid, text, integer, text
) to service_role;

revoke execute on function public.fail_encrypted_organizer_job(
  text, text, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.fail_encrypted_organizer_job(
  text, text, text, boolean, text, bigint
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.get_lease_bound_organizer_provider_credential(
  text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
grant execute on function public.fail_encrypted_organizer_job(
  text, text, text, boolean, text, bigint
) to unfiled_organizer_worker;
grant execute on function public.get_lease_bound_organizer_provider_credential(
  text, text
) to unfiled_organizer_worker;

revoke execute on function private.owner_ai_settings_projection(
  public.profiles
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.provider_key_metadata_projection(
  public.user_provider_keys
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.replay_owner_ai_command(
  uuid, text, text, integer, public.ai_provider, text
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.finish_owner_ai_command(
  uuid, text, text, integer, public.ai_provider, text, jsonb
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.effective_organizer_expansion_disabled(
  text, uuid, boolean
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function
  private.get_lease_bound_organizer_provider_credential_impl(text, text)
from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.fail_encrypted_organizer_job_e4_impl(
  text, text, text, boolean, text, bigint
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
