-- Private-beta AI routing: dual-provider Vault custody, explicit model
-- preferences, and immutable provider/model settings on every organizer job.
--
-- Organizer contract after this migration:
--   claim rows add selectedProvider, modelSelection, adapterRegistryVersion,
--   and settingsRevision (23 keys total); the lease-bound provider route adds
--   modelSelection, modelId, adapterRegistryVersion, and settingsRevision
--   (10 keys total). Both are copied from the immutable job snapshot only.

create type public.organization_model_selection as enum (
  'auto',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'claude-sonnet-5',
  'claude-opus-5'
);

alter table public.profiles
  add column model_selection public.organization_model_selection
    not null default 'auto';

alter table public.profiles
  drop constraint profiles_provider_mode_shape,
  add constraint profiles_provider_mode_shape check (
    (
      provider_mode = 'app_default'
      and byok_provider is null
      and not byok_fallback_to_app
      and model_selection = 'auto'
    )
    or (
      -- A null provider must evaluate to false, never to an unknown CHECK
      -- result, so BYOK mode cannot exist without exactly one provider.
      provider_mode = 'byok'
      and byok_provider is not null
      and (
        (
          byok_provider = 'openai'
          and model_selection in (
            'auto', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'
          )
        )
        or (
          byok_provider = 'anthropic'
          and model_selection in (
            'auto', 'claude-sonnet-5', 'claude-opus-5'
          )
        )
      )
    )
  );

-- Keep the historical constraint name so catalog consumers can recognize the
-- supported-provider boundary while expanding it honestly to both providers.
alter table public.user_provider_keys
  drop constraint user_provider_keys_e4_provider_supported,
  add constraint user_provider_keys_e4_provider_supported check (
    provider in ('openai', 'anthropic')
  );

create function private.organization_model_matches_provider(
  p_provider public.ai_provider,
  p_model_selection public.organization_model_selection
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case p_provider
    when 'openai' then p_model_selection in (
      'auto', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'
    )
    when 'anthropic' then p_model_selection in (
      'auto', 'claude-sonnet-5', 'claude-opus-5'
    )
    else false
  end;
$$;

create function private.resolve_organization_model_id(
  p_provider public.ai_provider,
  p_model_selection public.organization_model_selection,
  p_routing_effort public.routing_effort
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when not private.organization_model_matches_provider(
      p_provider, p_model_selection
    ) then null
    when p_model_selection <> 'auto'
      then p_model_selection::text
    when p_provider = 'openai' and p_routing_effort = 'economical'
      then 'gpt-5.6-luna'
    when p_provider = 'openai' and p_routing_effort = 'standard'
      then 'gpt-5.6-terra'
    when p_provider = 'openai' and p_routing_effort = 'thorough'
      then 'gpt-5.6-sol'
    when p_provider = 'anthropic'
      and p_routing_effort in ('economical', 'standard')
      then 'claude-sonnet-5'
    when p_provider = 'anthropic' and p_routing_effort = 'thorough'
      then 'claude-opus-5'
    else null
  end;
$$;

revoke execute on function private.organization_model_matches_provider(
  public.ai_provider, public.organization_model_selection
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.resolve_organization_model_id(
  public.ai_provider, public.organization_model_selection,
  public.routing_effort
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.owner_ai_settings_projection(
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
    'modelSelection', p_profile.model_selection,
    'routingEffort', p_profile.routing_effort,
    'expansionStyle', case when p_profile.expansion_enabled
      then p_profile.expansion_style
      else 'off'::public.expansion_style end,
    'timezone', p_profile.timezone,
    'locale', p_profile.locale,
    'updatedAt', p_profile.updated_at
  );
$$;

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
    new.model_selection,
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
    old.model_selection,
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
    -- An accepted no-op CAS command still consumes one revision.
    null;
  elsif new.settings_revision <> old.settings_revision then
    raise exception using
      errcode = 'P0001', message = 'settings_revision_without_change';
  end if;
  return new;
end;
$$;

create or replace function public.update_owner_ai_settings(
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
  model_selection_value public.organization_model_selection;
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
      'byokFallbackToApp', 'modelSelection', 'routingEffort',
      'expansionStyle', 'timezone', 'locale'
    ] <> '{}'::jsonb
    or (p_patch ? 'organizationMode'
      and jsonb_typeof(p_patch -> 'organizationMode') <> 'string')
    or (p_patch ? 'providerMode'
      and jsonb_typeof(p_patch -> 'providerMode') <> 'string')
    or (p_patch ? 'byokProvider'
      and jsonb_typeof(p_patch -> 'byokProvider') not in ('null', 'string'))
    or (p_patch ? 'byokFallbackToApp'
      and jsonb_typeof(p_patch -> 'byokFallbackToApp') <> 'boolean')
    or (p_patch ? 'modelSelection'
      and jsonb_typeof(p_patch -> 'modelSelection') <> 'string')
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
  model_selection_value := profile_row.model_selection;
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
    if p_patch ? 'modelSelection' then
      model_selection_value :=
        (p_patch ->> 'modelSelection')::public.organization_model_selection;
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

  -- A provider switch without an explicit model choice resets an incompatible
  -- prior choice to Automatic. An explicitly mismatched choice still fails.
  if not (p_patch ? 'modelSelection') and (
    (
      p_patch ? 'providerMode'
      and provider_mode_value = 'app_default'
    )
    or (
      p_patch ? 'byokProvider'
      and (
        byok_provider_value is null
        or not private.organization_model_matches_provider(
          byok_provider_value, model_selection_value
        )
      )
    )
  ) then
    model_selection_value := 'auto';
  end if;

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
      and (
        byok_provider_value is not null
        or fallback_value
        or model_selection_value <> 'auto'
      )
    )
    or (
      provider_mode_value = 'byok'
      and (
        byok_provider_value is null
        or not private.organization_model_matches_provider(
          byok_provider_value, model_selection_value
        )
      )
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
    model_selection = model_selection_value,
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

create or replace function public.get_user_provider_key_status(
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
  provider_value public.ai_provider;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null or p_provider is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    provider_value := p_provider::public.ai_provider;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = provider_value;
  return jsonb_build_object(
    'providerKey', case when found
      then private.provider_key_metadata_projection(key_row)
      else null end
  );
end;
$$;

create or replace function public.put_user_provider_key(
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
  provider_value public.ai_provider;
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
    or p_provider is null
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
  begin
    provider_value := p_provider::public.ai_provider;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  -- The fingerprint is provider-specific but excludes every secret-derived
  -- property. Replay compares the supplied secret transiently with Vault.
  fingerprint_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.provider-key-put.v1',
    'provider', provider_value,
    'expectedRevision', expected_value
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_value := private.replay_owner_ai_command(
    p_user_id, p_idempotency_key, 'put_provider_key', expected_value,
    provider_value, fingerprint_value
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
    where user_id = p_user_id and provider = provider_value
    for share;
    if not found
      or replay_revision is null
      or replay_value #>> '{providerKey,provider}'
        is distinct from provider_value::text
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
  ) values (p_user_id, provider_value, 0)
  on conflict (user_id, provider) do nothing;
  select * into counter_row
  from private.provider_key_revision_counters
  where user_id = p_user_id and provider = provider_value
  for update;

  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = provider_value
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
      'unfiled-byok-' || provider_value::text || '-'
        || extensions.gen_random_uuid()::text,
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
      and provider = provider_value
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
      p_user_id, provider_value, new_vault_secret_id, null,
      right(p_api_key, 4), 'active', clock_timestamp(), target_revision
    ) returning * into key_row;
  end if;

  update private.provider_key_revision_counters
  set current_revision = target_revision, updated_at = clock_timestamp()
  where user_id = p_user_id and provider = provider_value;
  response_value := jsonb_build_object(
    'providerKey', private.provider_key_metadata_projection(key_row),
    'replayed', false
  );
  perform private.finish_owner_ai_command(
    p_user_id, p_idempotency_key, 'put_provider_key', expected_value,
    provider_value, fingerprint_value, response_value
  );
  return response_value;
end;
$$;

create or replace function public.delete_user_provider_key(
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
  provider_value public.ai_provider;
  fingerprint_value text;
  response_value jsonb;
  replay_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_user_id is null
    or p_provider is null
    or p_expected_credential_revision is null
    or p_expected_credential_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    provider_value := p_provider::public.ai_provider;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  fingerprint_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.provider-key-delete.v1',
    'provider', provider_value,
    'expectedRevision', p_expected_credential_revision
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_value := private.replay_owner_ai_command(
    p_user_id, p_idempotency_key, 'delete_provider_key',
    p_expected_credential_revision, provider_value, fingerprint_value
  );
  if replay_value is not null then return replay_value; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_user_id::text || ':content-encryption-rollout', 0
  ));
  select * into counter_row
  from private.provider_key_revision_counters
  where user_id = p_user_id and provider = provider_value
  for update;
  select * into key_row
  from public.user_provider_keys
  where user_id = p_user_id and provider = provider_value
  for update;
  if not found
    or key_row.credential_revision <> p_expected_credential_revision
    or counter_row.current_revision is distinct from key_row.credential_revision
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  -- Deletion is the owner's safety override and must win even when the Vault
  -- object is already absent: a missing secret can never be disclosed, while
  -- an undeletable binding would strand the owner. A Vault outage still
  -- raises here and rolls the whole command back.
  delete from vault.secrets where id = key_row.vault_secret_id;
  delete from public.user_provider_keys
  where id = key_row.id
    and user_id = p_user_id
    and provider = provider_value;
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
    p_expected_credential_revision, provider_value,
    fingerprint_value, response_value
  );
  return response_value;
end;
$$;

-- Existing job/snapshot rows are upgraded as one catalog change while their
-- immutability triggers are temporarily absent. No credential material is
-- involved in this backfill.
drop trigger organization_job_ai_settings_immutable
  on public.organization_job_ai_settings;
drop trigger organization_job_model_immutable on public.organization_jobs;

alter table public.organization_job_ai_settings
  add column model_selection public.organization_model_selection
    not null default 'auto',
  add column model_id text,
  alter column adapter_registry_version
    set default 'organization-model-registry-v2',
  drop constraint organization_job_ai_settings_provider_shape;

update public.organization_job_ai_settings as snapshot
set
  model_id = private.resolve_organization_model_id(
    snapshot.selected_provider,
    snapshot.model_selection,
    snapshot.routing_effort
  ),
  adapter_registry_version = 'organization-model-registry-v2';

update public.organization_jobs as job
set model_id = snapshot.model_id
from public.organization_job_ai_settings as snapshot
where snapshot.job_id = job.id
  and snapshot.user_id = job.user_id
  and job.model_id is distinct from snapshot.model_id;

alter table public.organization_job_ai_settings
  alter column model_id set not null,
  add constraint organization_job_ai_settings_provider_shape check (
    (
      provider_mode = 'app_default'
      and selected_provider = 'openai'
      and not byok_fallback_to_app
      and model_selection = 'auto'
    )
    or (
      provider_mode = 'byok'
      and private.organization_model_matches_provider(
        selected_provider, model_selection
      )
    )
  ),
  add constraint organization_job_ai_settings_model_resolution check (
    model_id = private.resolve_organization_model_id(
      selected_provider, model_selection, routing_effort
    )
  ),
  add constraint organization_job_ai_settings_registry_v2 check (
    adapter_registry_version = 'organization-model-registry-v2'
  );

alter table public.organization_jobs
  alter column model_id set default 'gpt-5.6-terra',
  drop constraint organization_jobs_model_id_shape,
  add constraint organization_jobs_model_id_shape check (
    model_id in (
      'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol',
      'claude-sonnet-5', 'claude-opus-5'
    )
  ),
  add constraint organization_jobs_id_user_id_model_id_key
    unique (id, user_id, model_id);

alter table public.organization_job_ai_settings
  add constraint organization_job_ai_settings_job_model_fkey
    foreign key (job_id, user_id, model_id)
    references public.organization_jobs(id, user_id, model_id)
    on delete cascade;

create or replace function private.resolve_organization_job_model()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_row public.profiles%rowtype;
  selected_provider_value public.ai_provider;
  resolved_model_value text;
begin
  select * into profile_row
  from public.profiles
  where id = new.user_id
  for share;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'organization_job_profile_missing';
  end if;
  selected_provider_value := case
    when profile_row.provider_mode = 'byok' then profile_row.byok_provider
    else 'openai'::public.ai_provider
  end;
  resolved_model_value := private.resolve_organization_model_id(
    selected_provider_value,
    profile_row.model_selection,
    profile_row.routing_effort
  );
  if resolved_model_value is null then
    raise exception using
      errcode = 'P0001', message = 'organization_model_unavailable';
  end if;
  new.model_id := resolved_model_value;
  return new;
end;
$$;

create trigger b_resolve_organization_job_model
before insert on public.organization_jobs
for each row execute function private.resolve_organization_job_model();

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
  job_model_value text;
  selected_provider_value public.ai_provider;
  resolved_model_value text;
  expansion_style_value public.expansion_style;
begin
  select * into profile_row
  from public.profiles
  where id = p_user_id
  for share;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'organization_job_profile_missing';
  end if;
  select model_id into job_model_value
  from public.organization_jobs
  where id = p_job_id and user_id = p_user_id;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'organization_job_missing';
  end if;

  selected_provider_value := case
    when profile_row.provider_mode = 'byok' then profile_row.byok_provider
    else 'openai'::public.ai_provider
  end;
  resolved_model_value := private.resolve_organization_model_id(
    selected_provider_value,
    profile_row.model_selection,
    profile_row.routing_effort
  );
  if resolved_model_value is null
    or job_model_value is distinct from resolved_model_value
  then
    raise exception using
      errcode = 'P0001', message = 'organization_job_model_mismatch';
  end if;
  expansion_style_value := case
    when profile_row.expansion_enabled then profile_row.expansion_style
    else 'off'::public.expansion_style
  end;

  insert into public.organization_job_ai_settings (
    job_id, user_id, settings_revision, org_mode, provider_mode,
    selected_provider, byok_fallback_to_app, model_selection, model_id,
    routing_effort, expansion_style, adapter_registry_version
  ) values (
    p_job_id, p_user_id, profile_row.settings_revision,
    profile_row.org_mode, profile_row.provider_mode,
    selected_provider_value,
    case when profile_row.provider_mode = 'byok'
      then profile_row.byok_fallback_to_app else false end,
    profile_row.model_selection, resolved_model_value,
    profile_row.routing_effort, expansion_style_value,
    'organization-model-registry-v2'
  );
end;
$$;

create trigger organization_job_ai_settings_immutable
before update on public.organization_job_ai_settings
for each row execute function private.reject_immutable_job_snapshot_update();

create trigger organization_job_model_immutable
before update of model_id on public.organization_jobs
for each row execute function private.enforce_organization_job_model_immutable();

revoke execute on function private.resolve_organization_job_model()
from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

create function private.organizer_provider_route_projection(
  p_snapshot public.organization_job_ai_settings,
  p_source text,
  p_credential text,
  p_credential_revision integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'provider', p_snapshot.selected_provider,
    'source', p_source,
    'credential', p_credential,
    'credentialRevision', p_credential_revision,
    'modelSelection', p_snapshot.model_selection,
    'modelId', p_snapshot.model_id,
    'routingEffort', p_snapshot.routing_effort,
    'expansionStyle', p_snapshot.expansion_style,
    'adapterRegistryVersion', p_snapshot.adapter_registry_version,
    'settingsRevision', p_snapshot.settings_revision
  );
$$;

create or replace function private.get_lease_bound_organizer_provider_credential_impl(
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
    or snapshot_row.adapter_registry_version
      <> 'organization-model-registry-v2'
    or snapshot_row.model_id is distinct from job_row.model_id
    or snapshot_row.model_id is distinct from
      private.resolve_organization_model_id(
        snapshot_row.selected_provider,
        snapshot_row.model_selection,
        snapshot_row.routing_effort
      )
  then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;

  select * into prior_resolution
  from private.organizer_provider_resolutions
  where job_id = job_row.id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
  for update;
  if found and prior_resolution.provider <> snapshot_row.selected_provider then
    raise exception using errcode = 'P0001', message = 'provider_unavailable';
  end if;
  if found and prior_resolution.source = 'app_default' then
    return private.organizer_provider_route_projection(
      snapshot_row, 'app_default', null, null
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
    return private.organizer_provider_route_projection(
      snapshot_row, 'app_default', null, null
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
    -- One live lease can never receive two credentials or switch sources.
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
      return private.organizer_provider_route_projection(
        snapshot_row, 'app_default', null, null
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
    or octet_length(credential_value) <> char_length(credential_value)
    or credential_value !~ '^[!-~]+$'
  then
    if prior_resolution.job_id is not null then
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
      return private.organizer_provider_route_projection(
        snapshot_row, 'app_default', null, null
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
  return private.organizer_provider_route_projection(
    snapshot_row, 'byok', credential_value, key_row.credential_revision
  );
end;
$$;

revoke execute on function private.organizer_provider_route_projection(
  public.organization_job_ai_settings, text, text, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

-- E4 originally permitted fallback only for OpenAI. Replace that single
-- reviewed policy guard without copying the large lease-transition function.
do $$
declare
  signature constant regprocedure :=
    'private.fail_encrypted_organizer_job_e4_impl(text,text,text,boolean,text,bigint)'
      ::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(signature);
  old_fragment constant text := $old$if snapshot_row.byok_fallback_to_app
      and snapshot_row.selected_provider = 'openai'
      and job_row.attempt < 5$old$;
  new_fragment constant text := $new$if snapshot_row.byok_fallback_to_app
      and job_row.attempt < 5$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    char_length(definition)
    - char_length(replace(definition, old_fragment, ''))
  ) / char_length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_provider_fallback_policy_drift';
  end if;
  execute replace(definition, old_fragment, new_fragment);
end;
$$;

-- The claim is the immutable processing lease. Project the provider,
-- preference, and registry pin in addition to its already-resolved model.
do $$
declare
  signature constant regprocedure :=
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
      ::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(signature);
  old_fragment constant text := $old$      'routingEffort', ($old$;
  new_fragment constant text := $new$      'selectedProvider', (
        select snapshot.selected_provider
        from public.organization_job_ai_settings as snapshot
        where snapshot.job_id = job_row.id
          and snapshot.user_id = job_row.user_id
      ),
      'modelSelection', (
        select snapshot.model_selection
        from public.organization_job_ai_settings as snapshot
        where snapshot.job_id = job_row.id
          and snapshot.user_id = job_row.user_id
      ),
      'adapterRegistryVersion', (
        select snapshot.adapter_registry_version
        from public.organization_job_ai_settings as snapshot
        where snapshot.job_id = job_row.id
          and snapshot.user_id = job_row.user_id
      ),
      'settingsRevision', (
        select snapshot.settings_revision
        from public.organization_job_ai_settings as snapshot
        where snapshot.job_id = job_row.id
          and snapshot.user_id = job_row.user_id
      ),
      'routingEffort', ($new$;
  occurrence_count integer;
begin
  occurrence_count := (
    char_length(definition)
    - char_length(replace(definition, old_fragment, ''))
  ) / char_length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_model_projection_drift';
  end if;
  execute replace(definition, old_fragment, new_fragment);
end;
$$;

-- Reassert exact privileges for replaced and newly introduced routines.
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
