create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.caught_error(p_statement text)
returns jsonb
language plpgsql
as $$
begin
  execute p_statement;
  return null;
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

create function pg_temp.model_envelope(
  p_owner_id uuid,
  p_resource_id text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'model.ai.object.v1',
    'context', jsonb_build_object(
      'tenantId', p_owner_id::text,
      'resourceId', p_resource_id,
      'recordVersion', 1,
      'kind', 'capture'
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16),
      'ciphertext', repeat('D', 80)
    )
  );
$$;

create temporary table model_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on model_values to service_role;

-- Closed catalog and deterministic resolution.
select has_type(
  'public', 'organization_model_selection',
  'model preference is represented by a closed database enum'
);
select set_eq(
  $$select enumlabel::text
    from pg_enum
    where enumtypid = 'public.organization_model_selection'::regtype$$,
  $$values
    ('auto'), ('gpt-5.6-luna'), ('gpt-5.6-terra'), ('gpt-5.6-sol'),
    ('claude-sonnet-5'), ('claude-opus-5')$$,
  'the selectable model catalog is exactly registry v2'
);
select has_column(
  'public', 'profiles', 'model_selection',
  'owner settings persist a model preference'
);
select has_column(
  'public', 'organization_job_ai_settings', 'model_selection',
  'job settings snapshot the requested model preference'
);
select has_column(
  'public', 'organization_job_ai_settings', 'model_id',
  'job settings snapshot the resolved exact model'
);
select results_eq(
  $$values
    (private.resolve_organization_model_id(
      'openai', 'auto', 'economical'
    )),
    (private.resolve_organization_model_id(
      'openai', 'auto', 'standard'
    )),
    (private.resolve_organization_model_id(
      'openai', 'auto', 'thorough'
    )),
    (private.resolve_organization_model_id(
      'anthropic', 'auto', 'economical'
    )),
    (private.resolve_organization_model_id(
      'anthropic', 'auto', 'standard'
    )),
    (private.resolve_organization_model_id(
      'anthropic', 'auto', 'thorough'
    ))$$,
  $$values
    ('gpt-5.6-luna'::text),
    ('gpt-5.6-terra'::text),
    ('gpt-5.6-sol'::text),
    ('claude-sonnet-5'::text),
    ('claude-sonnet-5'::text),
    ('claude-opus-5'::text)$$,
  'Automatic maps provider and effort to one deterministic exact model'
);
select is(
  private.resolve_organization_model_id(
    'anthropic', 'claude-opus-5', 'economical'
  ),
  'claude-opus-5',
  'an explicit compatible model remains exact regardless of effort'
);
select is(
  private.resolve_organization_model_id(
    'openai', 'claude-sonnet-5', 'standard'
  ),
  null,
  'the resolver fails closed on a cross-provider model'
);

select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.organization_job_ai_settings'::regclass
      and conname = 'organization_job_ai_settings_job_model_fkey'
      and convalidated
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.organization_jobs'::regclass
      and conname = 'organization_jobs_id_user_id_model_id_key'
      and contype = 'u'
  ),
  'snapshot and job model IDs have a database-enforced identity binding'
);
select ok(
  pg_get_triggerdef((
    select oid from pg_trigger
    where tgrelid = 'public.organization_jobs'::regclass
      and tgname = 'b_resolve_organization_job_model'
  )) ilike '%before insert%'
  and pg_get_functiondef(
    'private.resolve_organization_job_model()'::regprocedure
  ) ilike '%for share%'
  and pg_get_functiondef(
    'private.insert_organization_job_ai_settings(text,uuid)'::regprocedure
  ) ilike '%organization_job_model_mismatch%',
  'job creation locks one settings revision before resolving and snapshotting'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_job_ai_settings'
      and column_name ~ '(credential|secret|vault|cipher|api_key|key_id)'
  ),
  'immutable job snapshots contain no credential or Vault locator fields'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public.get_user_provider_key_status(uuid,text)'::regprocedure,
      'public.put_user_provider_key(uuid,text,text,integer,text,boolean)'
        ::regprocedure,
      'public.delete_user_provider_key(uuid,text,integer,text)'::regprocedure,
      'private.get_lease_bound_organizer_provider_credential_impl(text,text)'
        ::regprocedure,
      'private.fail_encrypted_organizer_job_e4_impl(text,text,text,boolean,text,bigint)'
        ::regprocedure
    ]) as routine(function_oid)
    where pg_get_functiondef(routine.function_oid) ~
      $pattern$p_provider is distinct from 'openai'|selected_provider = 'openai'$pattern$
  ),
  'provider-key CRUD, lease resolution, and failure handling are provider-neutral'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '96969696-9696-4696-8696-969696969696',
  'authenticated', 'authenticated', 'model-settings@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

-- Settings reject unknown/cross-provider choices without consuming the CAS.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"96969696-9696-4696-8696-969696969696","role":"service_role"}',
  true
);
insert into model_values(key, value) values (
  'initial-settings', public.get_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696'
  )
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-cross-provider', jsonb_build_object(
      'providerMode', 'byok', 'byokProvider', 'openai',
      'modelSelection', 'claude-sonnet-5'
    )
  )$$,
  '22023', 'validation_failed',
  'OpenAI rejects a Claude model preference'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-invalid-choice', '{"modelSelection":"unknown-model"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'an unknown model ID fails closed'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-invalid-effort', '{"routingEffort":"maximum"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'an unsupported effort value fails closed'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-app-explicit', '{"modelSelection":"gpt-5.6-terra"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'app-default mode permits only Automatic model selection'
);
insert into model_values(key, value) values (
  'anthropic-settings', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-anthropic-settings', jsonb_build_object(
      'providerMode', 'byok',
      'byokProvider', 'anthropic',
      'byokFallbackToApp', true,
      'modelSelection', 'claude-opus-5',
      'routingEffort', 'thorough',
      'expansionStyle', 'detailed'
    )
  )
);
insert into model_values(key, value) values (
  'anthropic-settings-replay', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 1,
    'model-anthropic-settings', jsonb_build_object(
      'providerMode', 'byok',
      'byokProvider', 'anthropic',
      'byokFallbackToApp', true,
      'modelSelection', 'claude-opus-5',
      'routingEffort', 'thorough',
      'expansionStyle', 'detailed'
    )
  )
);
reset role;

select ok(
  (select value #>> '{settings,modelSelection}' = 'auto'
    from model_values where key = 'initial-settings')
  and (select value #>> '{settings,modelSelection}' = 'claude-opus-5'
    and value #>> '{settings,byokProvider}' = 'anthropic'
    and value #>> '{settings,routingEffort}' = 'thorough'
    and value ->> 'replayed' = 'false'
    from model_values where key = 'anthropic-settings')
  and (select value ->> 'replayed' = 'true'
    from model_values where key = 'anthropic-settings-replay')
  and (select settings_revision = 2
    from public.profiles
    where id = '96969696-9696-4696-8696-969696969696'),
  'model preference participates in projection, CAS, and idempotent replay'
);

-- Both provider credentials coexist, keep independent revisions, and expose
-- only bounded metadata.
set local role service_role;
insert into model_values(key, value) values (
  'put-openai', public.put_user_provider_key(
    '96969696-9696-4696-8696-969696969696', 'openai',
    'sk-model-openai-ALPHA-000000000001', null,
    'model-put-openai', false
  )
);
insert into model_values(key, value) values (
  'put-anthropic', public.put_user_provider_key(
    '96969696-9696-4696-8696-969696969696', 'anthropic',
    'sk-ant-model-BETA-0000000000000002', null,
    'model-put-anthropic', false
  )
);
insert into model_values(key, value) values (
  'status-openai', public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'openai'
  )
), (
  'status-anthropic', public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'anthropic'
  )
);
select throws_ok(
  $$select public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'gemini'
  )$$,
  '22023', 'validation_failed',
  'unknown provider lookup fails closed'
);
reset role;

select ok(
  (select count(*) = 2
    and count(distinct provider) = 2
    and min(credential_revision) = 1
    and max(credential_revision) = 1
    from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696')
  and (select value #>> '{providerKey,provider}' = 'openai'
    and value #>> '{providerKey,credentialRevision}' = '1'
    from model_values where key = 'status-openai')
  and (select value #>> '{providerKey,provider}' = 'anthropic'
    and value #>> '{providerKey,credentialRevision}' = '1'
    from model_values where key = 'status-anthropic'),
  'OpenAI and Anthropic keys coexist with independent revision streams'
);
select ok(
  not exists (
    select 1 from private.owner_ai_command_receipts
    where row_to_json(owner_ai_command_receipts)::text like '%sk-model-%'
      or row_to_json(owner_ai_command_receipts)::text like '%sk-ant-model-%'
  ) and not exists (
    select 1 from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696'
      and key_ciphertext is not null
  ),
  'provider CRUD retains no credential-derived receipt or ciphertext fallback'
);

-- Create a job under Claude/Opus, then switch the live profile. The insert
-- trigger overrides an untrusted caller model and freezes the exact route.
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, expansion_disabled
) values (
  'cap_96000000000000000000000001',
  '96969696-9696-4696-8696-969696969696', 'web', '[encrypted]',
  pg_temp.model_envelope(
    '96969696-9696-4696-8696-969696969696',
    'cap_96000000000000000000000001'
  ), encode(extensions.digest('model-capture', 'sha256'), 'hex'), 24,
  'ai_assisted', clock_timestamp(), 'UTC', clock_timestamp(), 'processing',
  'model.ai.object.v1', 'ai_assisted', 'object_wrap', 1, false
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, attempt, prompt_version, schema_version,
  model_id, started_at, lease_owner, lease_token, lease_expires_at,
  last_heartbeat_at
) values (
  'job_96000000000000000000000001',
  'cap_96000000000000000000000001',
  '96969696-9696-4696-8696-969696969696', 'running', 1,
  'routing-v1', 1, 'gpt-5.6-luna', clock_timestamp(), 'model-worker',
  '96000000-0000-4000-8000-000000000001',
  clock_timestamp() + interval '15 minutes', clock_timestamp()
);

select ok(
  (select job.model_id = 'claude-opus-5'
      and snapshot.model_id = job.model_id
      and snapshot.model_selection = 'claude-opus-5'
      and snapshot.selected_provider = 'anthropic'
      and snapshot.routing_effort = 'thorough'
      and snapshot.expansion_style = 'detailed'
      and snapshot.adapter_registry_version = 'organization-model-registry-v2'
    from public.organization_jobs as job
    join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = job.id and snapshot.user_id = job.user_id
    where job.id = 'job_96000000000000000000000001'),
  'job insertion ignores caller model and snapshots one resolved v2 route'
);

set local role service_role;
insert into model_values(key, value) values (
  'provider-switch', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 2,
    'model-switch-provider', jsonb_build_object(
      'byokProvider', 'openai',
      'routingEffort', 'economical'
    )
  )
);
reset role;

select ok(
  (select value #>> '{settings,byokProvider}' = 'openai'
      and value #>> '{settings,modelSelection}' = 'auto'
    from model_values where key = 'provider-switch')
  and (select selected_provider = 'anthropic'
      and model_selection = 'claude-opus-5'
      and model_id = 'claude-opus-5'
      and routing_effort = 'thorough'
    from public.organization_job_ai_settings
    where job_id = 'job_96000000000000000000000001'),
  'provider switching resets an incompatible live choice but not queued work'
);
select is(
  pg_temp.caught_error($sql$
    update public.organization_jobs set model_id = 'gpt-5.6-sol'
    where id = 'job_96000000000000000000000001'
  $sql$) ->> 'message',
  'immutable_job_model',
  'a resolved job model cannot be changed'
);
select is(
  pg_temp.caught_error($sql$
    update public.organization_job_ai_settings
    set model_selection = 'auto'
    where job_id = 'job_96000000000000000000000001'
  $sql$) ->> 'message',
  'immutable_job_snapshot',
  'the provider/model/effort snapshot cannot be changed'
);

insert into model_values(key, value) values (
  'anthropic-route',
  private.get_lease_bound_organizer_provider_credential_impl(
    'job_96000000000000000000000001',
    '96000000-0000-4000-8000-000000000001'
  )
);
select ok(
  (select value ->> 'provider' = 'anthropic'
      and value ->> 'source' = 'byok'
      and value ->> 'credential' = 'sk-ant-model-BETA-0000000000000002'
      and value ->> 'credentialRevision' = '1'
      and value ->> 'modelSelection' = 'claude-opus-5'
      and value ->> 'modelId' = 'claude-opus-5'
      and value ->> 'routingEffort' = 'thorough'
      and value ->> 'adapterRegistryVersion'
        = 'organization-model-registry-v2'
    from model_values where key = 'anthropic-route'),
  'credential lease binds the exact frozen provider/model/effort/registry'
);
select ok(
  not exists (
    select 1 from public.organization_job_ai_settings
    where job_id = 'job_96000000000000000000000001'
      and row_to_json(organization_job_ai_settings)::text
        like '%sk-ant-model-BETA%'
  ),
  'the live credential never enters the immutable job snapshot'
);

-- Anthropic invalidation uses the exact lease receipt and can activate the
-- same one-way explicit app-funded fallback policy as OpenAI.
insert into model_values(key, value) values (
  'anthropic-invalid', private.fail_encrypted_organizer_job_e4_impl(
    'job_96000000000000000000000001',
    '96000000-0000-4000-8000-000000000001',
    'provider_key_invalid', false, 'byok', 1
  )
);
select ok(
  (select status = 'invalid' and credential_revision = 2
    from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696'
      and provider = 'anthropic')
  and (select status = 'active' and credential_revision = 1
    from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696'
      and provider = 'openai')
  and (select value ->> 'state' = 'awaiting_retry'
    from model_values where key = 'anthropic-invalid')
  and exists (
    select 1 from private.organizer_provider_fallbacks
    where job_id = 'job_96000000000000000000000001'
      and provider = 'anthropic'
      and credential_revision = 1
  ),
  'Anthropic failure invalidates only its lease-bound key and activates fallback'
);

update public.captures
set status = 'processing'
where id = 'cap_96000000000000000000000001';
update public.organization_jobs
set
  state = 'running',
  attempt = 2,
  available_at = clock_timestamp(),
  completed_at = null,
  error_code = null,
  lease_owner = 'model-worker',
  lease_token = '96000000-0000-4000-8000-000000000002',
  lease_expires_at = clock_timestamp() + interval '15 minutes',
  last_heartbeat_at = clock_timestamp(),
  last_transition_lease_token = null,
  last_transition_action = null,
  last_transition_request_hash = null
where id = 'job_96000000000000000000000001';
insert into model_values(key, value) values (
  'anthropic-fallback-route',
  private.get_lease_bound_organizer_provider_credential_impl(
    'job_96000000000000000000000001',
    '96000000-0000-4000-8000-000000000002'
  )
);
select ok(
  (select value ->> 'provider' = 'anthropic'
      and value ->> 'source' = 'app_default'
      and jsonb_typeof(value -> 'credential') = 'null'
      and value ->> 'modelId' = 'claude-opus-5'
      and value ->> 'routingEffort' = 'thorough'
      and value ->> 'adapterRegistryVersion'
        = 'organization-model-registry-v2'
    from model_values where key = 'anthropic-fallback-route'),
  'fallback preserves the frozen Anthropic model route without a user key'
);

-- Claims need an encrypted source key and an active rollout for this owner.
set local role service_role;
select public.register_user_content_key(
  '96969696-9696-4696-8696-969696969696',
  'model.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/96000000-0000-4000-8000-000000000011',
  decode(repeat('96', 32), 'hex')
);
select public.register_user_content_key(
  '96969696-9696-4696-8696-969696969696',
  'model.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/96000000-0000-4000-8000-000000000012',
  decode(repeat('97', 32), 'hex')
);
select public.activate_user_content_key(
  '96969696-9696-4696-8696-969696969696', 'model.ai.object.v1'
);
select public.activate_user_content_key(
  '96969696-9696-4696-8696-969696969696', 'model.ai.mac.v1'
);
reset role;
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '96969696-9696-4696-8696-969696969696';

-- A queued OpenAI job (revision 3: OpenAI/Automatic/Efficient) keeps its
-- snapshot after the owner switches to Claude without fallback.
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version, expansion_disabled
) values (
  'cap_96000000000000000000000002',
  '96969696-9696-4696-8696-969696969696', 'web', '[encrypted]',
  pg_temp.model_envelope(
    '96969696-9696-4696-8696-969696969696',
    'cap_96000000000000000000000002'
  ), encode(extensions.digest('model-capture-two', 'sha256'), 'hex'), 24,
  'ai_assisted', clock_timestamp(), 'UTC', clock_timestamp(), 'queued',
  'model.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'model.ai.mac.v1', 'ai_assisted', 'content_mac', 1, false
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_96000000000000000000000002',
  'cap_96000000000000000000000002',
  '96969696-9696-4696-8696-969696969696', 'created', 'routing-v1', 1
);
set local role service_role;
insert into model_values(key, value) values (
  'switch-to-anthropic', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 3,
    'model-switch-to-anthropic', jsonb_build_object(
      'byokProvider', 'anthropic',
      'byokFallbackToApp', false
    )
  )
);
reset role;
select ok(
  (select value #>> '{settings,byokProvider}' = 'anthropic'
      and value #>> '{settings,modelSelection}' = 'auto'
      and value #>> '{settings,byokFallbackToApp}' = 'false'
      and value #>> '{settings,settingsRevision}' = '4'
    from model_values where key = 'switch-to-anthropic')
  and (select selected_provider = 'openai'
      and model_selection = 'auto'
      and model_id = 'gpt-5.6-luna'
      and routing_effort = 'economical'
      and byok_fallback_to_app
      and settings_revision = 3
      and adapter_registry_version = 'organization-model-registry-v2'
    from public.organization_job_ai_settings
    where job_id = 'job_96000000000000000000000002'),
  'a queued OpenAI job keeps its snapshot after the owner switches to Claude'
);

insert into model_values(key, value) values (
  'openai-claim',
  private.claim_encrypted_organizer_jobs_impl('model-worker', 1, 900)
);
insert into model_values(key, value)
select 'openai-route',
  private.get_lease_bound_organizer_provider_credential_impl(
    value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
  )
from model_values where key = 'openai-claim';
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value #> '{jobs,0}')
      as projected(name)
    where model_values.key = 'openai-claim'),
  array[
    'accountCaptureOrdinal', 'adapterRegistryVersion', 'attempt', 'captureId',
    'clientTimezone', 'commandProjection', 'controls', 'expansionStyle',
    'jobId', 'leaseExpiresAt', 'leaseToken', 'modelId', 'modelSelection',
    'occurredAt', 'ownerId', 'promptVersion', 'replanCount', 'routingEffort',
    'routingMode', 'schemaVersion', 'selectedProvider', 'settingsRevision',
    'source'
  ]::text[],
  'an OpenAI claim row projects exactly the 23 organizer contract keys'
);
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value) as projected(name)
    where model_values.key = 'openai-route'),
  array[
    'adapterRegistryVersion', 'credential', 'credentialRevision',
    'expansionStyle', 'modelId', 'modelSelection', 'provider',
    'routingEffort', 'settingsRevision', 'source'
  ]::text[],
  'an OpenAI provider route projects exactly the 10 organizer contract keys'
);
select ok(
  (select claim.value #>> '{jobs,0,jobId}' = 'job_96000000000000000000000002'
      and claim.value #>> '{jobs,0,selectedProvider}'
        = snapshot.selected_provider::text
      and claim.value #>> '{jobs,0,modelSelection}'
        = snapshot.model_selection::text
      and claim.value #>> '{jobs,0,modelId}' = snapshot.model_id
      and claim.value #>> '{jobs,0,modelId}' = job.model_id
      and claim.value #>> '{jobs,0,adapterRegistryVersion}'
        = snapshot.adapter_registry_version
      and (claim.value #>> '{jobs,0,settingsRevision}')::integer
        = snapshot.settings_revision
      and claim.value #>> '{jobs,0,routingEffort}'
        = snapshot.routing_effort::text
      and claim.value #>> '{jobs,0,expansionStyle}'
        = snapshot.expansion_style::text
      and snapshot.selected_provider = 'openai'
      and snapshot.model_selection = 'auto'
      and snapshot.model_id = 'gpt-5.6-luna'
      and snapshot.settings_revision = 3
      and snapshot.adapter_registry_version
        = 'organization-model-registry-v2'
    from model_values as claim
    join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = claim.value #>> '{jobs,0,jobId}'
    join public.organization_jobs as job on job.id = snapshot.job_id
    where claim.key = 'openai-claim')
  and (select route.value ->> 'provider' = 'openai'
      and route.value ->> 'source' = 'byok'
      and route.value ->> 'credential' = 'sk-model-openai-ALPHA-000000000001'
      and route.value ->> 'credentialRevision' = '1'
      and route.value ->> 'modelSelection' = snapshot.model_selection::text
      and route.value ->> 'modelId' = snapshot.model_id
      and route.value ->> 'adapterRegistryVersion'
        = snapshot.adapter_registry_version
      and (route.value ->> 'settingsRevision')::integer
        = snapshot.settings_revision
      and route.value ->> 'routingEffort' = snapshot.routing_effort::text
      and route.value ->> 'expansionStyle' = snapshot.expansion_style::text
    from model_values as route
    join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = 'job_96000000000000000000000002'
    where route.key = 'openai-route'),
  'the OpenAI claim and route repeat its snapshot and disclose only the OpenAI key'
);

-- A queued Claude job (revision 4: Claude/Automatic/Efficient, no fallback)
-- resolves claude-sonnet-5 and never the OpenAI key.
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version, expansion_disabled
) values (
  'cap_96000000000000000000000003',
  '96969696-9696-4696-8696-969696969696', 'web', '[encrypted]',
  pg_temp.model_envelope(
    '96969696-9696-4696-8696-969696969696',
    'cap_96000000000000000000000003'
  ), encode(extensions.digest('model-capture-three', 'sha256'), 'hex'), 24,
  'ai_assisted', clock_timestamp(), 'UTC', clock_timestamp(), 'queued',
  'model.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'model.ai.mac.v1', 'ai_assisted', 'content_mac', 1, false
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_96000000000000000000000003',
  'cap_96000000000000000000000003',
  '96969696-9696-4696-8696-969696969696', 'created', 'routing-v1', 1
);
insert into model_values(key, value) values (
  'anthropic-claim',
  private.claim_encrypted_organizer_jobs_impl('model-worker', 1, 900)
);
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value #> '{jobs,0}')
      as projected(name)
    where model_values.key = 'anthropic-claim'),
  array[
    'accountCaptureOrdinal', 'adapterRegistryVersion', 'attempt', 'captureId',
    'clientTimezone', 'commandProjection', 'controls', 'expansionStyle',
    'jobId', 'leaseExpiresAt', 'leaseToken', 'modelId', 'modelSelection',
    'occurredAt', 'ownerId', 'promptVersion', 'replanCount', 'routingEffort',
    'routingMode', 'schemaVersion', 'selectedProvider', 'settingsRevision',
    'source'
  ]::text[],
  'an Anthropic claim row projects exactly the same 23 contract keys'
);
select ok(
  (select claim.value #>> '{jobs,0,jobId}' = 'job_96000000000000000000000003'
      and claim.value #>> '{jobs,0,selectedProvider}'
        = snapshot.selected_provider::text
      and claim.value #>> '{jobs,0,modelSelection}'
        = snapshot.model_selection::text
      and claim.value #>> '{jobs,0,modelId}' = snapshot.model_id
      and claim.value #>> '{jobs,0,modelId}' = job.model_id
      and claim.value #>> '{jobs,0,adapterRegistryVersion}'
        = snapshot.adapter_registry_version
      and (claim.value #>> '{jobs,0,settingsRevision}')::integer
        = snapshot.settings_revision
      and snapshot.selected_provider = 'anthropic'
      and snapshot.model_selection = 'auto'
      and snapshot.model_id = 'claude-sonnet-5'
      and snapshot.settings_revision = 4
      and not snapshot.byok_fallback_to_app
      and snapshot.adapter_registry_version
        = 'organization-model-registry-v2'
    from model_values as claim
    join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = claim.value #>> '{jobs,0,jobId}'
    join public.organization_jobs as job on job.id = snapshot.job_id
    where claim.key = 'anthropic-claim'),
  'the Anthropic claim repeats its immutable Claude snapshot'
);
select is(
  (select pg_temp.caught_error(format(
      'select private.get_lease_bound_organizer_provider_credential_impl(%L,%L)',
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
    )) ->> 'message'
    from model_values where key = 'anthropic-claim'),
  'provider_key_invalid',
  'an invalid Claude key without snapshotted fallback yields provider_key_invalid'
);
select ok(
  not exists (
    select 1 from private.organizer_provider_resolutions
    where job_id = 'job_96000000000000000000000003'
  ) and not exists (
    select 1 from private.organizer_provider_fallbacks
    where job_id = 'job_96000000000000000000000003'
  ) and (select status = 'active' and credential_revision = 1
    from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696'
      and provider = 'openai'),
  'a refused Claude resolution discloses no source, activates no fallback, and never touches the OpenAI key'
);
set local role service_role;
insert into model_values(key, value) values (
  'put-anthropic-replacement', public.put_user_provider_key(
    '96969696-9696-4696-8696-969696969696', 'anthropic',
    'sk-ant-model-GAMMA-000000000000003', 2,
    'model-put-anthropic-replacement', false
  )
);
reset role;
insert into model_values(key, value)
select 'anthropic-route-two',
  private.get_lease_bound_organizer_provider_credential_impl(
    value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
  )
from model_values where key = 'anthropic-claim';
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value) as projected(name)
    where model_values.key = 'anthropic-route-two'),
  array[
    'adapterRegistryVersion', 'credential', 'credentialRevision',
    'expansionStyle', 'modelId', 'modelSelection', 'provider',
    'routingEffort', 'settingsRevision', 'source'
  ]::text[],
  'an Anthropic provider route projects exactly the 10 organizer contract keys'
);
select ok(
  (select value #>> '{providerKey,credentialRevision}' = '3'
    from model_values where key = 'put-anthropic-replacement')
  and (select route.value ->> 'provider' = 'anthropic'
      and route.value ->> 'source' = 'byok'
      and route.value ->> 'credential' = 'sk-ant-model-GAMMA-000000000000003'
      and route.value ->> 'credentialRevision' = '3'
      and route.value ->> 'modelSelection' = snapshot.model_selection::text
      and route.value ->> 'modelId' = snapshot.model_id
      and route.value ->> 'modelId' = 'claude-sonnet-5'
      and route.value ->> 'adapterRegistryVersion'
        = snapshot.adapter_registry_version
      and (route.value ->> 'settingsRevision')::integer
        = snapshot.settings_revision
      and route.value ->> 'settingsRevision' = '4'
      and route.value ->> 'routingEffort' = snapshot.routing_effort::text
      and route.value ->> 'expansionStyle' = snapshot.expansion_style::text
    from model_values as route
    join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = 'job_96000000000000000000000003'
    where route.key = 'anthropic-route-two'),
  'a replacement Claude key resolves only for the Claude-snapshot job under its live lease'
);

-- Provider switching: an explicit mismatch fails closed; app-default resets
-- an explicit Claude choice to Automatic.
set local role service_role;
insert into model_values(key, value) values (
  'explicit-opus', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 4,
    'model-explicit-opus', '{"modelSelection":"claude-opus-5"}'::jsonb
  )
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 5,
    'model-switch-mismatch',
    '{"byokProvider":"openai","modelSelection":"claude-opus-5"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'an explicitly mismatched model is rejected even while switching provider'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 5,
    'model-anthropic-openai-model',
    '{"modelSelection":"gpt-5.6-sol"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'Claude rejects an OpenAI model preference'
);
insert into model_values(key, value) values (
  'switch-to-app-default', public.update_owner_ai_settings(
    '96969696-9696-4696-8696-969696969696', 5,
    'model-switch-app-default', jsonb_build_object(
      'providerMode', 'app_default',
      'byokProvider', null,
      'byokFallbackToApp', false
    )
  )
);
reset role;
select ok(
  (select value #>> '{settings,modelSelection}' = 'claude-opus-5'
      and value #>> '{settings,settingsRevision}' = '5'
    from model_values where key = 'explicit-opus')
  and (select value #>> '{settings,providerMode}' = 'app_default'
      and jsonb_typeof(value #> '{settings,byokProvider}') = 'null'
      and value #>> '{settings,modelSelection}' = 'auto'
      and value #>> '{settings,settingsRevision}' = '6'
    from model_values where key = 'switch-to-app-default')
  and (select settings_revision = 6 and model_selection = 'auto'
    from public.profiles
    where id = '96969696-9696-4696-8696-969696969696'),
  'switching to app-default resets an explicit Claude choice to Automatic and rejected patches consume no revision'
);

-- Deleting one provider key leaves the other intact; each provider is
-- deleted on its own revision and neither status endpoint can leak the other.
set local role service_role;
insert into model_values(key, value) values (
  'delete-anthropic', public.delete_user_provider_key(
    '96969696-9696-4696-8696-969696969696', 'anthropic', 3,
    'model-delete-anthropic'
  )
);
insert into model_values(key, value) values (
  'status-openai-after-anthropic-delete', public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'openai'
  )
), (
  'status-anthropic-deleted', public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'anthropic'
  )
);
insert into model_values(key, value) values (
  'delete-openai', public.delete_user_provider_key(
    '96969696-9696-4696-8696-969696969696', 'openai', 1,
    'model-delete-openai'
  )
);
insert into model_values(key, value) values (
  'status-openai-deleted', public.get_user_provider_key_status(
    '96969696-9696-4696-8696-969696969696', 'openai'
  )
);
reset role;
select ok(
  (select value ->> 'deleted' = 'true'
      and value ->> 'provider' = 'anthropic'
      and value ->> 'deletedCredentialRevision' = '3'
    from model_values where key = 'delete-anthropic')
  and (select value #>> '{providerKey,provider}' = 'openai'
      and value #>> '{providerKey,status}' = 'active'
      and value #>> '{providerKey,credentialRevision}' = '1'
    from model_values where key = 'status-openai-after-anthropic-delete')
  and (select jsonb_typeof(value -> 'providerKey') = 'null'
    from model_values where key = 'status-anthropic-deleted')
  and (select value ->> 'deleted' = 'true'
      and value ->> 'provider' = 'openai'
      and value ->> 'deletedCredentialRevision' = '1'
    from model_values where key = 'delete-openai')
  and (select jsonb_typeof(value -> 'providerKey') = 'null'
    from model_values where key = 'status-openai-deleted')
  and not exists (
    select 1 from public.user_provider_keys
    where user_id = '96969696-9696-4696-8696-969696969696'
  )
  and (select count(*) = 2
    from private.provider_key_revision_counters
    where user_id = '96969696-9696-4696-8696-969696969696'),
  'deleting one provider key leaves the other intact until its own deletion'
);

-- Exact owner DTO key sets, catalog invariants, and unchanged role surfaces.
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value -> 'settings')
      as projected(name)
    where model_values.key = 'initial-settings'),
  array[
    'byokFallbackToApp', 'byokProvider', 'expansionStyle', 'locale',
    'modelSelection', 'organizationMode', 'providerMode', 'routingEffort',
    'settingsRevision', 'timezone', 'updatedAt'
  ]::text[],
  'owner settings project exactly the eleven registry-v2 DTO keys'
);
select is(
  (select array_agg(projected.name order by projected.name)
    from model_values
    cross join lateral jsonb_object_keys(value -> 'providerKey')
      as projected(name)
    where model_values.key = 'status-openai'),
  array[
    'credentialRevision', 'lastFour', 'provider', 'status', 'updatedAt',
    'validatedAt'
  ]::text[],
  'provider-key status projects exactly six content-free keys'
);
select ok(
  not exists (
    select 1 from public.organization_job_ai_settings
    where adapter_registry_version <> 'organization-model-registry-v2'
      or model_id is null
      or model_id is distinct from private.resolve_organization_model_id(
        selected_provider, model_selection, routing_effort
      )
  ) and not exists (
    select 1
    from public.organization_jobs as job
    left join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = job.id and snapshot.user_id = job.user_id
    where snapshot.job_id is null
      or snapshot.model_id <> job.model_id
      or job.model_id not in (
        'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol',
        'claude-sonnet-5', 'claude-opus-5'
      )
  ),
  'no registry-v1 or unresolved snapshot survives the dual-provider catalog upgrade'
);
select is(
  (select count(*)
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )),
  11::bigint,
  'the organizer allowlist remains exactly eleven public functions'
);
select is(
  (select count(*)
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_search_worker', procedure.oid, 'EXECUTE'
      )),
  5::bigint,
  'the search worker allowlist remains exactly five public functions'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public.get_owner_ai_settings(uuid)'::regprocedure,
      'public.update_owner_ai_settings(uuid,integer,text,jsonb)'::regprocedure,
      'public.get_user_provider_key_status(uuid,text)'::regprocedure,
      'public.put_user_provider_key(uuid,text,text,integer,text,boolean)'
        ::regprocedure,
      'public.delete_user_provider_key(uuid,text,integer,text)'::regprocedure
    ]) as capability(function_oid)
    cross join unnest(array[
      'public', 'anon', 'authenticated', 'unfiled_index_worker',
      'unfiled_rag_verifier', 'unfiled_organizer_worker',
      'unfiled_search_worker'
    ]) as denied(role_name)
    where has_function_privilege(
      denied.role_name, capability.function_oid, 'EXECUTE'
    )
  ) and not exists (
    select 1
    from unnest(array[
      'public.get_owner_ai_settings(uuid)'::regprocedure,
      'public.update_owner_ai_settings(uuid,integer,text,jsonb)'::regprocedure,
      'public.get_user_provider_key_status(uuid,text)'::regprocedure,
      'public.put_user_provider_key(uuid,text,text,integer,text,boolean)'
        ::regprocedure,
      'public.delete_user_provider_key(uuid,text,integer,text)'::regprocedure
    ]) as capability(function_oid)
    where not has_function_privilege(
      'service_role', capability.function_oid, 'EXECUTE'
    )
  ),
  'only service_role may execute the five owner AI capabilities'
);

select * from finish();
rollback;
