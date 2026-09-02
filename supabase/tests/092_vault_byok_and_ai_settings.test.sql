create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.e4_envelope(
  p_owner_id uuid,
  p_resource_id text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'e4.ai.object.v1',
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
      'ciphertext', repeat(left(p_seed, 1), 80)
    )
  );
$$;

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

-- Exercise a missing Vault object inside an exception subtransaction. The
-- expected resolver error rolls the deletion back before this helper returns.
create function pg_temp.resolve_with_missing_vault(
  p_job_id text,
  p_lease_token text,
  p_vault_secret_id uuid
)
returns jsonb
language plpgsql
as $$
begin
  delete from vault.secrets where id = p_vault_secret_id;
  perform private.get_lease_bound_organizer_provider_credential_impl(
    p_job_id, p_lease_token
  );
  raise exception using
    errcode = 'P0001', message = 'resolver_succeeded_during_vault_outage';
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

create function pg_temp.replay_put_with_missing_vault(
  p_user_id uuid,
  p_api_key text,
  p_expected_revision integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets
  where id = (
    select vault_secret_id
    from public.user_provider_keys
    where user_id = p_user_id and provider = 'openai'
  );
  perform public.put_user_provider_key(
    p_user_id, 'openai', p_api_key, p_expected_revision,
    p_idempotency_key, true
  );
  raise exception using
    errcode = 'P0001', message = 'put_replay_succeeded_during_vault_outage';
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

create temporary table e4_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on e4_values to service_role, unfiled_organizer_worker;

-- Schema and exact capability boundary.
select has_table(
  'private', 'owner_ai_command_receipts',
  'E4 has a content-free command replay ledger'
);
select has_table(
  'private', 'provider_key_revision_counters',
  'provider revisions survive live-key deletion'
);
select has_table(
  'private', 'organizer_provider_resolutions',
  'lease-bound source/revision disclosures are retained without secrets'
);
select has_table(
  'private', 'organizer_provider_fallbacks',
  'each job can make at most one persistent fallback transition'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_provider_keys'::regclass
      and conname = 'user_provider_keys_vault_secret_id_key'
      and contype = 'u'
  ),
  'one Vault locator cannot be aliased across provider-key rows'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_provider_mode_shape'
      and convalidated
      and lower(pg_get_constraintdef(oid)) like '%byok_provider is not null%'
      and lower(pg_get_constraintdef(oid)) like '%byok_provider = ''openai''%'
      and lower(pg_get_constraintdef(oid))
        like '%byok_provider = ''anthropic''%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_provider_keys'::regclass
      and conname = 'user_provider_keys_key_last4_check'
      and convalidated
      and pg_get_constraintdef(oid) like '%octet_length(key_last4) = 4%'
      and pg_get_constraintdef(oid) like '%[!-~]{4}%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_provider_keys'::regclass
      and conname = 'user_provider_keys_e4_provider_supported'
      and convalidated
      and lower(pg_get_constraintdef(oid)) like '%provider%openai%'
      and lower(pg_get_constraintdef(oid)) like '%anthropic%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_provider_keys'::regclass
      and conname = 'user_provider_keys_active_validated'
      and convalidated
      and lower(pg_get_constraintdef(oid)) like '%active%validated_at%'
  ),
  'E4 constrains provider support, validation, consent, and visible metadata'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class where oid = 'public.user_provider_keys'::regclass
  ) and (
    select relrowsecurity and relforcerowsecurity
    from pg_class where oid = 'public.profiles'::regclass
  ),
  'provider metadata and profiles retain forced RLS behind exact RPCs'
);
select is(
  (
    select count(*) from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )
  ),
  11::bigint,
  'the organizer allowlist is exactly eleven public functions'
);
select ok(
  has_function_privilege(
    'unfiled_organizer_worker',
    'public.get_lease_bound_organizer_provider_credential(text,text)',
    'EXECUTE'
  ) and has_function_privilege(
    'unfiled_organizer_worker',
    'public.fail_encrypted_organizer_job(text,text,text,boolean,text,bigint)',
    'EXECUTE'
  ) and not has_function_privilege(
    'unfiled_organizer_worker',
    'public.fail_encrypted_organizer_job(text,text,text,boolean)',
    'EXECUTE'
  ),
  'E4 adds only the resolver and replaces the organizer fail overload'
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
      'unfiled_rag_verifier', 'unfiled_organizer_worker'
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
  ) and to_regprocedure(
    'public.put_user_provider_key(uuid,text,text,integer,text)'
  ) is null,
  'five owner capabilities are service-only and PUT has one exact signature'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'update_owner_ai_settings', 'put_user_provider_key',
        'delete_user_provider_key'
      )
      and (
        position(':encrypted-note-write:' in
          pg_get_functiondef(procedure.oid)) = 0
        or position(':encrypted-note-write:' in
          pg_get_functiondef(procedure.oid)) >
          position(':content-encryption-rollout' in
            pg_get_functiondef(procedure.oid))
      )
  ),
  'all E4 mutations serialize on the shared idempotency key before owner state'
);
select ok(
  not has_table_privilege(
    'authenticated', 'public.profiles', 'UPDATE'
  ) and not has_table_privilege(
    'service_role', 'public.profiles', 'SELECT'
  ) and not has_table_privilege(
    'service_role', 'public.user_provider_keys', 'SELECT'
  ),
  'direct profile writes and every provider-key table access are denied'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'anon', 'authenticated', 'unfiled_index_worker',
      'unfiled_rag_verifier', 'unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_schema_privilege(denied.role_name, 'vault', 'USAGE')
      or has_table_privilege(denied.role_name, 'vault.secrets', 'SELECT')
      or has_table_privilege(
        denied.role_name, 'vault.decrypted_secrets', 'SELECT'
      )
      or has_function_privilege(
        denied.role_name,
        'vault.create_secret(text,text,text,uuid)', 'EXECUTE'
      )
      or has_function_privilege(
        denied.role_name,
        'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE'
      )
  ),
  'no client or isolated worker has direct Vault access'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'private.owner_ai_command_receipts'::regclass,
      'private.provider_key_revision_counters'::regclass,
      'private.organizer_provider_resolutions'::regclass,
      'private.organizer_provider_fallbacks'::regclass
    ]) as evidence(table_oid)
    cross join unnest(array[
      'anon', 'authenticated', 'service_role', 'unfiled_index_worker',
      'unfiled_rag_verifier', 'unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_table_privilege(denied.role_name, evidence.table_oid, 'SELECT')
  ),
  'runtime roles cannot enumerate E4 replay, revision, or lease evidence'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_job_ai_settings'
      and column_name ~ '(credential|secret|vault|cipher|key_id)'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'private'
      and table_name in (
        'organizer_provider_resolutions', 'organizer_provider_fallbacks'
      )
      and column_name ~ '(secret|vault|cipher|api_key|key_id)'
  ),
  'job snapshots and lease evidence have no credential or Vault locator field'
);
select ok(
  lower(pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
      ::regprocedure
  )) like '%''routingeffort''%'
  and lower(pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
      ::regprocedure
  )) like '%''expansionstyle''%'
  and not exists (
    select 1
    from unnest(array[
      'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'
        ::regprocedure,
      'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'
        ::regprocedure,
      'private.list_encrypted_organizer_candidates_impl(text,text,integer)'
        ::regprocedure,
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'
        ::regprocedure
    ]) as guarded(function_oid)
    where lower(pg_get_functiondef(guarded.function_oid))
      not like '%private.effective_organizer_expansion_disabled%'
  ),
  'claim exposes immutable effort/style and every control path enforces expansion off'
);
select ok(
  lower(pg_get_functiondef(
    'private.get_lease_bound_organizer_provider_credential_impl(text,text)'
      ::regprocedure
  )) like '%key_row.validated_at is null%',
  'the lease resolver independently fails closed on unvalidated active metadata'
);

-- Exact owner settings, patch CAS, replay, provider gate, and timezone gate.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"service_role"}',
  true
);
insert into e4_values(key, value) values (
  'settings-initial', public.get_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111'
  )
);
insert into e4_values(key, value) values (
  'settings-update', public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 2,
    'e4-settings-update', jsonb_build_object(
      'organizationMode', 'automatic',
      'routingEffort', 'thorough',
      'timezone', 'America/Los_Angeles',
      'locale', 'en-US'
    )
  )
);
insert into e4_values(key, value) values (
  'settings-replay', public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 2,
    'e4-settings-update', jsonb_build_object(
      'organizationMode', 'automatic',
      'routingEffort', 'thorough',
      'timezone', 'America/Los_Angeles',
      'locale', 'en-US'
    )
  )
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 3,
    'e4-settings-fake-zone', '{"timezone":"Fake/Zone"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'unknown timezones fail before profile mutation'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 3,
    'e4-settings-cross-provider',
    '{"providerMode":"byok","byokProvider":"anthropic","modelSelection":"gpt-5.6-terra"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'a cross-provider model preference cannot be selected through settings'
);
select throws_ok(
  $$select public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 3,
    'e4-settings-unknown-provider',
    '{"providerMode":"byok","byokProvider":"gemini"}'::jsonb
  )$$,
  '22023', 'validation_failed',
  'a provider outside the catalog cannot be selected through settings'
);
reset role;
select is(
  pg_temp.caught_error($sql$
    update public.profiles
    set provider_mode = 'byok', byok_provider = 'anthropic',
      model_selection = 'gpt-5.6-terra'
    where id = '11111111-1111-4111-8111-111111111111'
  $sql$) ->> 'sqlstate',
  '23514',
  'the catalog also rejects cross-provider legacy-style BYOK consent'
);
select is(
  pg_temp.caught_error($sql$
    update public.profiles
    set provider_mode = 'byok', byok_provider = null
    where id = '11111111-1111-4111-8111-111111111111'
  $sql$) ->> 'sqlstate',
  '23514',
  'the catalog rejects BYOK consent without exactly one provider'
);
set local role service_role;
select throws_ok(
  $$select public.put_user_provider_key(
    '11111111-1111-4111-8111-111111111111', 'gemini',
    'sk-e4-unknown-provider-00000000000000', null,
    'e4-unknown-provider', false
  )$$,
  '22023', 'validation_failed',
  'a provider outside the catalog cannot reach Vault through the key capability'
);
-- Anthropic custody works through the same exact capabilities with its own
-- revision counter. The key is removed again so the OpenAI-only flow below
-- keeps addressing one live row for this owner.
insert into e4_values(key, value) values (
  'anthropic-put', public.put_user_provider_key(
    '11111111-1111-4111-8111-111111111111', 'anthropic',
    'sk-ant-e4-independent-000000000000001', null,
    'e4-anthropic-put', false
  )
);
insert into e4_values(key, value) values (
  'anthropic-status', public.get_user_provider_key_status(
    '11111111-1111-4111-8111-111111111111', 'anthropic'
  )
);
insert into e4_values(key, value) values (
  'anthropic-delete', public.delete_user_provider_key(
    '11111111-1111-4111-8111-111111111111', 'anthropic', 1,
    'e4-anthropic-delete'
  )
);
reset role;
select ok(
  (select value #>> '{providerKey,provider}' = 'anthropic'
    and value #>> '{providerKey,credentialRevision}' = '1'
    and value #>> '{providerKey,lastFour}' = '0001'
    and value ->> 'replayed' = 'false'
    from e4_values where key = 'anthropic-put')
  and (select value #>> '{providerKey,provider}' = 'anthropic'
    and value #>> '{providerKey,credentialRevision}' = '1'
    from e4_values where key = 'anthropic-status')
  and (select value ->> 'provider' = 'anthropic'
    and value ->> 'deleted' = 'true'
    and value ->> 'deletedCredentialRevision' = '1'
    from e4_values where key = 'anthropic-delete')
  and (select current_revision = 1
    from private.provider_key_revision_counters
    where user_id = '11111111-1111-4111-8111-111111111111'
      and provider = 'anthropic')
  and not exists (
    select 1 from public.user_provider_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
  ),
  'Anthropic key put/status/delete work with an independent revision counter'
);
set local role service_role;
select throws_ok(
  $$select public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 2,
    'e4-settings-stale', '{"routingEffort":"standard"}'::jsonb
  )$$,
  'P0001', 'stale_revision',
  'settings mutation uses exact CAS'
);
reset role;
select ok(
  (select value #>> '{settings,settingsRevision}' = '2'
    from e4_values where key = 'settings-initial')
  and (select value #>> '{settings,settingsRevision}' = '3'
    and value ->> 'replayed' = 'false'
    and value #>> '{settings,organizationMode}' = 'automatic'
    and value #>> '{settings,routingEffort}' = 'thorough'
    from e4_values where key = 'settings-update')
  and (select value ->> 'replayed' = 'true'
    from e4_values where key = 'settings-replay'),
  'settings get/update return exact revisioned DTOs and replay receipts'
);
select is(
  (select settings_revision from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'),
  3,
  'replay and rejected settings writes do not advance the revision'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.api_idempotency_records(
      user_id,idempotency_key,scope,request_hash
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'e4-settings-update','update_ai_settings',repeat('a',64)
    )
  $sql$) ->> 'message',
  'invalid_idempotency_key',
  'an E4 receipt blocks reuse in the shared API idempotency namespace'
);
insert into public.api_idempotency_records(
  user_id,idempotency_key,scope,request_hash
) values (
  '11111111-1111-4111-8111-111111111111',
  'e4-existing-api-key','unrelated_scope',repeat('b',64)
);
set local role service_role;
select throws_ok(
  $$select public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111',3,
    'e4-existing-api-key','{"locale":"en-GB"}'::jsonb
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a pre-existing API idempotency key rolls back an E4 settings write'
);
reset role;
select is(
  (select settings_revision from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'),
  3,
  'cross-family idempotency collision leaves settings unchanged'
);
set local role service_role;
insert into e4_values(key, value) values (
  'settings-noop', public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 3,
    'e4-settings-noop', '{"routingEffort":"thorough"}'::jsonb
  )
);
insert into e4_values(key, value) values (
  'settings-noop-replay', public.update_owner_ai_settings(
    '11111111-1111-4111-8111-111111111111', 3,
    'e4-settings-noop', '{"routingEffort":"thorough"}'::jsonb
  )
);
reset role;
select ok(
  (select value #>> '{settings,settingsRevision}' = '4'
    and value ->> 'replayed' = 'false'
    from e4_values where key = 'settings-noop')
  and (select value #>> '{settings,settingsRevision}' = '4'
    and value ->> 'replayed' = 'true'
    from e4_values where key = 'settings-noop-replay')
  and (select settings_revision = 4
    from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'),
  'an accepted no-op settings patch advances exactly once and replays safely'
);
select set_eq(
  $$select enumlabel::text
    from pg_enum
    where enumtypid = 'public.ai_provider'::regtype$$,
  $$values ('openai'), ('anthropic')$$,
  'the provider catalog is exactly the two implemented providers'
);
set local role service_role;
select ok(
  not exists (
    select 1
    from pg_enum
    where enumtypid = 'public.ai_provider'::regtype
      and pg_temp.caught_error(format(
        'select public.get_user_provider_key_status(%L, %L)',
        '11111111-1111-4111-8111-111111111111', enumlabel
      )) is not null
  ),
  'every provider label in the catalog is addressable by the E4 owner APIs'
);
reset role;
select is(
  pg_temp.caught_error($sql$
    insert into public.user_provider_keys(
      id, user_id, provider, vault_secret_id, key_last4
    ) values (
      'key_92000000000000000000000098',
      '11111111-1111-4111-8111-111111111111', 'openai',
      '92000000-0000-4000-8000-000000000098', 'A123'
    )
  $sql$) ->> 'sqlstate',
  '23514',
  'an active provider key must carry completed validation evidence'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.user_provider_keys(
      id, user_id, provider, vault_secret_id, key_last4, validated_at
    ) values (
      'key_92000000000000000000000099',
      '11111111-1111-4111-8111-111111111111', 'openai',
      '92000000-0000-4000-8000-000000000099', E'\n123', now()
    )
  $sql$) ->> 'sqlstate',
  '23514',
  'provider key last-four metadata must be exactly visible ASCII'
);
set local role service_role;
insert into e4_values(key, value) values (
  'other-owner-key', public.put_user_provider_key(
    '11111111-1111-4111-8111-111111111111', 'openai',
    'sk-e4-other-owner-isolation-0000007777', null,
    'e4-other-owner-key', false
  )
);
reset role;

-- Configure the organizer owner and store one Vault-only OpenAI key.
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"service_role"}',
  true
);
insert into e4_values(key, value) values (
  'owner-settings-byok', public.update_owner_ai_settings(
    '22222222-2222-4222-8222-222222222222', 2,
    'e4-owner-byok-settings', jsonb_build_object(
      'providerMode', 'byok',
      'byokProvider', 'openai',
      'byokFallbackToApp', true,
      'routingEffort', 'thorough',
      'expansionStyle', 'brief'
    )
  )
);
select throws_ok(
  $$select public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222', 'openai',
    'sk-e4-replay-only-miss-0000000000009999', null,
    'e4-put-replay-only-miss', true
  )$$,
  'P0001', 'not_found',
  'a replay-only miss cannot create a Vault secret or receipt'
);
insert into e4_values(key, value) values (
  'put-one', public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222', 'openai',
    'sk-e4-canary-ALPHA-0000000000001234', null, 'e4-put-one', false
  )
);
insert into e4_values(key, value) values (
  'put-one-replay', public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222', 'openai',
    'sk-e4-canary-ALPHA-0000000000001234', null, 'e4-put-one', true
  )
);
select throws_ok(
  $$select public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222', 'openai',
    'sk-e4-different-OMEGA-0000000000001234', null, 'e4-put-one', true
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a replay secret mismatch is rejected even when last-four metadata matches'
);
select is(
  pg_temp.replay_put_with_missing_vault(
    '22222222-2222-4222-8222-222222222222',
    'sk-e4-canary-ALPHA-0000000000001234', null, 'e4-put-one'
  ) ->> 'message',
  'provider_unavailable',
  'an exact receipt cannot replay while its current Vault object is unavailable'
);
insert into e4_values(key, value) values (
  'key-status-one', public.get_user_provider_key_status(
    '22222222-2222-4222-8222-222222222222', 'openai'
  )
);
reset role;
select ok(
  (select value #>> '{providerKey,credentialRevision}' = '1'
    and value #>> '{providerKey,lastFour}' = '1234'
    and value #>> '{providerKey,status}' = 'active'
    and value ->> 'replayed' = 'false'
    and not (value::text ~ '(apiKey|vault|ciphertext)')
    from e4_values where key = 'put-one')
  and (select value ->> 'replayed' = 'true'
    and value #>> '{providerKey,lastFour}' = '1234'
    from e4_values where key = 'put-one-replay')
  and (select value #>> '{providerKey,credentialRevision}' = '1'
    from e4_values where key = 'key-status-one'),
  'put/status expose only content-free metadata and exact replay is read-only'
);
select is(
  (select count(*) from vault.secrets as secret
    join public.user_provider_keys as provider_key
      on provider_key.vault_secret_id = secret.id
    where provider_key.user_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'put replay creates exactly one Vault secret'
);
select is(
  (select count(*) from private.owner_ai_command_receipts
    where user_id = '22222222-2222-4222-8222-222222222222'
      and idempotency_key = 'e4-put-replay-only-miss'),
  0::bigint,
  'a replay-only miss retains no durable command evidence'
);
select ok(
  (select key_ciphertext is null and vault_secret_id is not null
    from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222')
  and not exists (
    select 1 from public.organization_jobs
    where row_to_json(organization_jobs)::text
      like '%sk-e4-canary-ALPHA-0000000000001234%'
  )
  and not exists (
    select 1 from private.owner_ai_command_receipts
    where row_to_json(owner_ai_command_receipts)::text
      like '%sk-e4-canary-ALPHA-0000000000001234%'
  )
  and not exists (
    select 1 from vault.secrets
    where secret = 'sk-e4-canary-ALPHA-0000000000001234'
  )
  and exists (
    select 1 from vault.decrypted_secrets
    where decrypted_secret = 'sk-e4-canary-ALPHA-0000000000001234'
  ),
  'the provider key exists only as Vault ciphertext plus allowed metadata'
);
insert into e4_values(key, value)
select 'vault-one', jsonb_build_object('id', vault_secret_id)
from public.user_provider_keys
where user_id = '22222222-2222-4222-8222-222222222222';

-- Minimal encrypted organizer source and live lease.
set local role service_role;
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'e4.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/92000000-0000-4000-8000-000000000001',
  decode(repeat('91', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'e4.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/92000000-0000-4000-8000-000000000002',
  decode(repeat('92', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'e4.ai.object.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'e4.ai.mac.v1'
);
reset role;
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '22222222-2222-4222-8222-222222222222';

insert into public.captures (
  id,user_id,source,raw_text,content_envelope,content_fingerprint,
  content_length,privacy,client_created_at,client_timezone,received_at,
  status,content_key_id,content_key_class,content_key_purpose,
  content_key_version,fingerprint_key_id,fingerprint_key_class,
  fingerprint_key_purpose,fingerprint_key_version,expansion_disabled
) values (
  'cap_92000000000000000000000001',
  '22222222-2222-4222-8222-222222222222','web','[encrypted]',
  pg_temp.e4_envelope(
    '22222222-2222-4222-8222-222222222222',
    'cap_92000000000000000000000001','D'
  ),encode(extensions.digest('e4-capture-one','sha256'),'hex'),30,
  'ai_assisted',clock_timestamp(),'UTC',clock_timestamp(),'queued',
  'e4.ai.object.v1','ai_assisted','object_wrap',1,
  'e4.ai.mac.v1','ai_assisted','content_mac',1,false
);
insert into public.organization_jobs(
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_92000000000000000000000001',
  'cap_92000000000000000000000001',
  '22222222-2222-4222-8222-222222222222','created','routing-v1',1
);

-- Later profile edits cannot alter the immutable job snapshot.
set local role service_role;
insert into e4_values(key, value) values (
  'later-settings', public.update_owner_ai_settings(
    '22222222-2222-4222-8222-222222222222', 3,
    'e4-later-settings', '{"routingEffort":"economical"}'::jsonb
  )
);
reset role;
insert into e4_values(key, value) values (
  'claim-one', private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
insert into e4_values(key, value)
select 'route-one', private.get_lease_bound_organizer_provider_credential_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
)
from e4_values where key = 'claim-one';
select ok(
  (select value #>> '{jobs,0,routingEffort}' = 'thorough'
    and value #>> '{jobs,0,expansionStyle}' = 'brief'
    and value #>> '{jobs,0,controls,expansionDisabled}' = 'false'
    and value #>> '{jobs,0,selectedProvider}' = 'openai'
    and value #>> '{jobs,0,modelSelection}' = 'auto'
    and value #>> '{jobs,0,modelId}' = 'gpt-5.6-sol'
    and value #>> '{jobs,0,adapterRegistryVersion}'
      = 'organization-model-registry-v2'
    and value #>> '{jobs,0,settingsRevision}' = '3'
    from e4_values where key = 'claim-one')
  and (select value ->> 'source' = 'byok'
    and value ->> 'provider' = 'openai'
    and value ->> 'credentialRevision' = '1'
    and value ->> 'credential' =
      'sk-e4-canary-ALPHA-0000000000001234'
    and value ->> 'routingEffort' = 'thorough'
    and value ->> 'expansionStyle' = 'brief'
    and value ->> 'modelSelection' = 'auto'
    and value ->> 'modelId' = 'gpt-5.6-sol'
    and value ->> 'adapterRegistryVersion'
      = 'organization-model-registry-v2'
    and value ->> 'settingsRevision' = '3'
    from e4_values where key = 'route-one'),
  'claim and resolver repeat the same immutable settings and resolve one live key'
);
select is(
  pg_temp.caught_error($sql$
    update public.organization_job_ai_settings
    set routing_effort = 'standard'
    where job_id = 'job_92000000000000000000000001'
  $sql$) ->> 'message',
  'immutable_job_snapshot',
  'job settings remain immutable after later owner changes'
);
select is(
  pg_temp.caught_error($sql$
    select private.get_lease_bound_organizer_provider_credential_impl(
      'job_92000000000000000000000001',
      '92000000-0000-4000-8000-000000000099'
    )
  $sql$) ->> 'message',
  'invalid_or_expired_lease',
  'a wrong lease cannot resolve any provider route'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.get_lease_bound_organizer_provider_credential_impl(%L,%L)',
      'job_00000000000000000000000001',
      value #>> '{jobs,0,leaseToken}'
    )) ->> 'message'
    from e4_values where key = 'claim-one'
  ),
  'invalid_or_expired_lease',
  'a lease cannot be replayed against another owner or job'
);
select is(
  (
    select pg_temp.resolve_with_missing_vault(
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
      ((select value ->> 'id' from e4_values
        where key = 'vault-one'))::uuid
    ) ->> 'message'
    from e4_values
    where key = 'claim-one'
  ),
  'provider_unavailable',
  'a lease that disclosed BYOK cannot switch to app fallback during Vault outage'
);
select ok(
  exists (
    select 1 from vault.decrypted_secrets
    where id = ((select value ->> 'id' from e4_values
      where key = 'vault-one'))::uuid
      and decrypted_secret = 'sk-e4-canary-ALPHA-0000000000001234'
  ),
  'the Vault outage subtransaction restores the exact object before replacement'
);

-- Replacement destroys the old Vault object. The same lease is not allowed a
-- second credential; a fresh retry lease may resolve the replacement.
set local role service_role;
insert into e4_values(key, value) values (
  'put-two', public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',
    'sk-e4-canary-BETA-0000000000005678',1,'e4-put-two',false
  )
);
select throws_ok(
  $$select public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',
    'sk-e4-canary-ALPHA-0000000000001234',null,'e4-put-one',true
  )$$,
  'P0001', 'stale_revision',
  'replacement makes the superseded put receipt stale'
);
reset role;
select ok(
  not exists (
    select 1 from vault.secrets
    where id = ((select value ->> 'id' from e4_values
      where key = 'vault-one'))::uuid
  ) and exists (
    select 1 from public.user_provider_keys as provider_key
    join vault.decrypted_secrets as secret
      on secret.id = provider_key.vault_secret_id
    where provider_key.user_id = '22222222-2222-4222-8222-222222222222'
      and provider_key.credential_revision = 2
      and secret.decrypted_secret = 'sk-e4-canary-BETA-0000000000005678'
  ),
  'replacement atomically destroys the superseded Vault secret'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.get_lease_bound_organizer_provider_credential_impl(%L,%L)',
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
    )) ->> 'message'
    from e4_values where key = 'claim-one'
  ),
  'provider_unavailable',
  'one lease never receives two different credential revisions'
);
insert into e4_values(key, value)
select 'replace-retry', private.fail_encrypted_organizer_job_e4_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'provider_unavailable',true,'byok',1
)
from e4_values where key = 'claim-one';
update public.organization_jobs
set available_at = clock_timestamp()
where id = 'job_92000000000000000000000001';
insert into e4_values(key, value) values (
  'claim-two', private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
insert into e4_values(key, value)
select 'route-two', private.get_lease_bound_organizer_provider_credential_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
)
from e4_values where key = 'claim-two';
select ok(
  (select value ->> 'state' = 'awaiting_retry'
    from e4_values where key = 'replace-retry')
  and (select value ->> 'source' = 'byok'
    and value ->> 'credentialRevision' = '2'
    and value ->> 'credential' = 'sk-e4-canary-BETA-0000000000005678'
    from e4_values where key = 'route-two'),
  'a fresh retry lease resolves the active same-owner/provider replacement'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.fail_encrypted_organizer_job_e4_impl(%L,%L,%L,false,null,null)',
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
      'provider_key_invalid'
    )) ->> 'message'
    from e4_values where key = 'claim-two'
  ),
  'forbidden',
  'after disclosure key-invalid must bind the exact BYOK source and revision'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.fail_encrypted_organizer_job_e4_impl(%L,%L,%L,false,%L,999)',
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
      'provider_key_invalid', 'byok'
    )) ->> 'message'
    from e4_values where key = 'claim-two'
  ),
  'forbidden',
  'key-invalid cannot forge a credential revision outside its lease receipt'
);

-- A BYOK 401/403 invalidates only the disclosed revision and transitions once
-- to app-default when the immutable snapshot explicitly allowed fallback.
insert into e4_values(key, value)
select 'byok-invalid', private.fail_encrypted_organizer_job_e4_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'provider_key_invalid',false,'byok',2
)
from e4_values where key = 'claim-two';
select ok(
  (select status = 'invalid' and credential_revision = 3
    from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222')
  and (select value ->> 'state' = 'awaiting_retry'
    from e4_values where key = 'byok-invalid')
  and exists (
    select 1 from private.organizer_provider_fallbacks
    where job_id = 'job_92000000000000000000000001'
      and credential_revision = 2
  ),
  'BYOK invalidation is revision-bound and activates explicit fallback once'
);

-- Replace the invalid key before the retry. The job remains on its one-way
-- fallback route, and app-default failure cannot invalidate revision 4.
set local role service_role;
insert into e4_values(key, value) values (
  'put-three', public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',
    'sk-e4-canary-GAMMA-0000000000002468',3,'e4-put-three',false
  )
);
reset role;
update public.organization_jobs
set available_at = clock_timestamp()
where id = 'job_92000000000000000000000001';
insert into e4_values(key, value) values (
  'claim-three', private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
insert into e4_values(key, value)
select 'route-three', private.get_lease_bound_organizer_provider_credential_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
)
from e4_values where key = 'claim-three';
select ok(
  (select value ->> 'source' = 'app_default'
    and jsonb_typeof(value -> 'credential') = 'null'
    and jsonb_typeof(value -> 'credentialRevision') = 'null'
    from e4_values where key = 'route-three')
  and (select credential_revision = 4 and status = 'active'
    from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222'),
  'fallback stays app-default even when a new BYOK revision becomes active'
);
insert into e4_values(key, value)
select 'app-default-invalid', private.fail_encrypted_organizer_job_e4_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'provider_key_invalid',false,'app_default',null
)
from e4_values where key = 'claim-three';
select ok(
  (select credential_revision = 4 and status = 'active'
    from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222')
  and (select error_code = 'provider_unavailable'
    from public.organization_jobs
    where id = 'job_92000000000000000000000001'),
  'an app-default failure never invalidates a user provider key'
);

-- Deletion wins against every not-yet-completed resolution. A new attempt
-- without fallback reaches Inbox/provider_key_invalid and no provider call.
set local role service_role;
insert into e4_values(key, value) values (
  'settings-no-fallback', public.update_owner_ai_settings(
    '22222222-2222-4222-8222-222222222222',4,
    'e4-no-fallback-settings','{"byokFallbackToApp":false}'::jsonb
  )
);
reset role;
insert into public.captures (
  id,user_id,source,raw_text,content_envelope,content_fingerprint,
  content_length,privacy,client_created_at,client_timezone,received_at,
  status,content_key_id,content_key_class,content_key_purpose,
  content_key_version,fingerprint_key_id,fingerprint_key_class,
  fingerprint_key_purpose,fingerprint_key_version,expansion_disabled
) values (
  'cap_92000000000000000000000002',
  '22222222-2222-4222-8222-222222222222','web','[encrypted]',
  pg_temp.e4_envelope(
    '22222222-2222-4222-8222-222222222222',
    'cap_92000000000000000000000002','E'
  ),encode(extensions.digest('e4-capture-two','sha256'),'hex'),30,
  'ai_assisted',clock_timestamp(),'UTC',clock_timestamp(),'queued',
  'e4.ai.object.v1','ai_assisted','object_wrap',1,
  'e4.ai.mac.v1','ai_assisted','content_mac',1,false
);
insert into public.organization_jobs(
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_92000000000000000000000002',
  'cap_92000000000000000000000002',
  '22222222-2222-4222-8222-222222222222','created','routing-v1',1
);
insert into e4_values(key, value) values (
  'delete-claim-one',private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
insert into e4_values(key, value)
select 'delete-route-one',
  private.get_lease_bound_organizer_provider_credential_impl(
    value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}'
  )
from e4_values where key = 'delete-claim-one';
set local role service_role;
insert into e4_values(key, value) values (
  'delete-key',public.delete_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',4,'e4-delete-key'
  )
);
insert into e4_values(key, value) values (
  'delete-key-replay',public.delete_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',4,'e4-delete-key'
  )
);
select throws_ok(
  $$select public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',
    'sk-e4-canary-GAMMA-0000000000002468',3,'e4-put-three',true
  )$$,
  'P0001', 'stale_revision',
  'deletion makes the removed credential put receipt stale'
);
reset role;
select ok(
  (select value ->> 'deleted' = 'true'
    and value ->> 'deletedCredentialRevision' = '4'
    and value ->> 'replayed' = 'false'
    from e4_values where key = 'delete-key')
  and (select value ->> 'replayed' = 'true'
    from e4_values where key = 'delete-key-replay')
  and not exists (
    select 1 from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  'delete atomically destroys metadata and is response-loss replay safe'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.get_lease_bound_organizer_provider_credential_impl(%L,%L)',
      value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}'
    )) ->> 'message'
    from e4_values where key = 'delete-claim-one'
  ),
  'provider_unavailable',
  'the old lease cannot resolve a deleted credential or a replacement'
);
insert into e4_values(key, value)
select 'delete-retry',private.fail_encrypted_organizer_job_e4_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
  'provider_unavailable',true,'byok',4
)
from e4_values where key = 'delete-claim-one';
update public.organization_jobs set available_at = clock_timestamp()
where id = 'job_92000000000000000000000002';
insert into e4_values(key, value) values (
  'delete-claim-two',private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.get_lease_bound_organizer_provider_credential_impl(%L,%L)',
      value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}'
    )) ->> 'message'
    from e4_values where key = 'delete-claim-two'
  ),
  'provider_key_invalid',
  'a new no-fallback attempt fails before any provider request after deletion'
);
insert into e4_values(key, value)
select 'delete-terminal',private.fail_encrypted_organizer_job_e4_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
  'provider_key_invalid',true,null,null
)
from e4_values where key = 'delete-claim-two';
select ok(
  (select status = 'inbox' and last_error_code = 'provider_key_invalid'
    from public.captures where id = 'cap_92000000000000000000000002')
  and (select state = 'failed' and error_code = 'provider_key_invalid'
    from public.organization_jobs where id = 'job_92000000000000000000000002')
  and (select credential_revision = 1 and status = 'active'
    from public.user_provider_keys
    where user_id = '11111111-1111-4111-8111-111111111111'),
  'resolver-side missing BYOK is terminal and cannot mutate any credential'
);

-- Recreate advances to revision five rather than resetting to one. A late old
-- lease failure cannot invalidate that new key.
set local role service_role;
insert into e4_values(key, value) values (
  'put-after-delete',public.put_user_provider_key(
    '22222222-2222-4222-8222-222222222222','openai',
    'sk-e4-canary-DELTA-0000000000001357',null,
    'e4-put-after-delete',false
  )
);
reset role;
select is(
  (select value #>> '{providerKey,credentialRevision}'
    from e4_values where key = 'put-after-delete'),
  '5',
  'credential revision remains monotonic across delete and recreate'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.fail_encrypted_organizer_job_e4_impl(%L,%L,%L,false,%L,4)',
      value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
      'provider_key_invalid','byok'
    )) ->> 'message'
    from e4_values where key = 'delete-claim-one'
  ),
  'invalid_or_expired_lease',
  'a late old-lease failure cannot alias the new credential epoch'
);
select ok(
  (select credential_revision = 5 and status = 'active'
    from public.user_provider_keys
    where user_id = '22222222-2222-4222-8222-222222222222'),
  'late failure leaves the recreated credential active'
);

-- Expansion off is an immutable effective control and app-default never opens
-- Vault. This also proves direct wrapper impersonation remains denied.
set local role service_role;
insert into e4_values(key, value) values (
  'settings-app-default-off',public.update_owner_ai_settings(
    '22222222-2222-4222-8222-222222222222',5,
    'e4-app-default-off',jsonb_build_object(
      'providerMode','app_default','byokProvider',null,
      'byokFallbackToApp',false,'expansionStyle','off'
    )
  )
);
reset role;
insert into public.captures (
  id,user_id,source,raw_text,content_envelope,content_fingerprint,
  content_length,privacy,client_created_at,client_timezone,received_at,
  status,content_key_id,content_key_class,content_key_purpose,
  content_key_version,fingerprint_key_id,fingerprint_key_class,
  fingerprint_key_purpose,fingerprint_key_version,expansion_disabled
) values (
  'cap_92000000000000000000000003',
  '22222222-2222-4222-8222-222222222222','web','[encrypted]',
  pg_temp.e4_envelope(
    '22222222-2222-4222-8222-222222222222',
    'cap_92000000000000000000000003','F'
  ),encode(extensions.digest('e4-capture-three','sha256'),'hex'),30,
  'ai_assisted',clock_timestamp(),'UTC',clock_timestamp(),'queued',
  'e4.ai.object.v1','ai_assisted','object_wrap',1,
  'e4.ai.mac.v1','ai_assisted','content_mac',1,false
);
insert into public.organization_jobs(
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_92000000000000000000000003',
  'cap_92000000000000000000000003',
  '22222222-2222-4222-8222-222222222222','created','routing-v1',1
);
insert into e4_values(key, value) values (
  'off-claim',private.claim_encrypted_organizer_jobs_impl('e4-worker',1,900)
);
insert into e4_values(key, value)
select 'off-route',private.get_lease_bound_organizer_provider_credential_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}'
)
from e4_values where key = 'off-claim';
select ok(
  (select value #>> '{jobs,0,expansionStyle}' = 'off'
    and value #>> '{jobs,0,controls,expansionDisabled}' = 'true'
    from e4_values where key = 'off-claim')
  and (select value ->> 'source' = 'app_default'
    and value ->> 'provider' = 'openai'
    and value ->> 'expansionStyle' = 'off'
    and value ->> 'modelSelection' = 'auto'
    and value ->> 'modelId' = 'gpt-5.6-luna'
    and value ->> 'settingsRevision' = '6'
    and jsonb_typeof(value -> 'credential') = 'null'
    and jsonb_typeof(value -> 'credentialRevision') = 'null'
    from e4_values where key = 'off-route'),
  'global expansion off overrides capture opt-in and app-default returns no key'
);
grant unfiled_organizer_worker to postgres;
set local role unfiled_organizer_worker;
insert into e4_values(key, value) values (
  'set-role-error', pg_temp.caught_error($sql$
    select public.get_lease_bound_organizer_provider_credential(
      'job_92000000000000000000000003',
      '92000000-0000-4000-8000-000000000099'
    )
  $sql$)
);
reset role;
select is(
  (select value ->> 'message' from e4_values where key = 'set-role-error'),
  'forbidden',
  'SET ROLE cannot impersonate the exact organizer login'
);

-- Owner isolation remains exact at the service capability boundary.
set local role service_role;
insert into e4_values(key, value) values (
  'other-owner-status',public.get_user_provider_key_status(
    '11111111-1111-4111-8111-111111111111','openai'
  )
);
reset role;
select ok(
  (select value #>> '{providerKey,credentialRevision}' = '1'
    and value #>> '{providerKey,status}' = 'active'
    from e4_values where key = 'other-owner-status')
  and not exists (
    select 1 from private.organizer_provider_resolutions
    where user_id = '11111111-1111-4111-8111-111111111111'
  ),
  'status and lease evidence never cross owners'
);

-- The accepted account-deletion capability collects Vault locators before the
-- auth cascade. Prove that an E4-created secret, not a hand-built fixture, is
-- destroyed together with its metadata and principal.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '93939393-9393-4393-8393-939393939393',
  'authenticated', 'authenticated', 'e4-delete@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e4_values(key, value) values (
  'account-delete-put', public.put_user_provider_key(
    '93939393-9393-4393-8393-939393939393', 'openai',
    'sk-e4-account-delete-canary-0000004242', null,
    'e4-account-delete-put', false
  )
);
reset role;
insert into e4_values(key, value)
select 'account-delete-vault-id', jsonb_build_object('id', vault_secret_id)
from public.user_provider_keys
where user_id = '93939393-9393-4393-8393-939393939393';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e4_values(key, value) values (
  'account-delete-receipt', public.delete_encrypted_owner_account(
    '93939393-9393-4393-8393-939393939393', repeat('9', 64), repeat('8', 64)
  )
);
reset role;
select ok(
  (select value ->> 'liveDataDeleted' = 'true'
    and value ->> 'replayed' = 'false'
    from e4_values where key = 'account-delete-receipt')
  and not exists (
    select 1 from auth.users
    where id = '93939393-9393-4393-8393-939393939393'
  )
  and not exists (
    select 1 from public.user_provider_keys
    where user_id = '93939393-9393-4393-8393-939393939393'
  )
  and not exists (
    select 1 from vault.secrets
    where id = ((select value ->> 'id' from e4_values
      where key = 'account-delete-vault-id'))::uuid
  ),
  'account deletion destroys the E4-created Vault secret before owner cascade'
);

select * from finish();
rollback;
