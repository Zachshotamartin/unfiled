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

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_key_id text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', p_key_id,
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

create function pg_temp.capture_cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_key_id text,
  p_reservation_id text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_key_id
    ),
    'keyId', p_key_id,
    'keyClass', 'ai_assisted',
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id
  );
$$;

create function pg_temp.capture_mac(p_seed text, p_key_id text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', p_key_id,
    'keyClass', 'ai_assisted',
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

-- Exact catalog shape.
select has_table(
  'public', 'organization_job_ai_settings',
  'immutable per-job AI settings snapshots exist'
);
select has_table(
  'public', 'organization_job_rule_matches',
  'content-free matched-rule evidence exists'
);
select has_table(
  'public', 'feedback_event_mutations',
  'correction feedback can bind its two mutation roles'
);
select has_type(
  'public', 'feedback_mutation_role',
  'feedback mutation roles use a closed enum'
);

select has_column(
  'public', 'profiles', 'settings_revision',
  'profiles expose a monotonic settings revision'
);
select has_column(
  'public', 'user_provider_keys', 'credential_revision',
  'provider credentials expose a monotonic revision'
);
select has_column(
  'public', 'routing_rules', 'current_revision',
  'routing rules expose a public CAS revision'
);
select has_column(
  'public', 'generated_blocks', 'state_revision',
  'generated-block state has a monotonic revision'
);
select has_column(
  'public', 'generated_blocks', 'review_item_id',
  'a generated block can bind its pending-expansion review'
);
select has_column(
  'public', 'feedback_events', 'review_item_id',
  'feedback can identify its review item'
);
select has_column(
  'public', 'feedback_events', 'generated_block_id',
  'feedback can identify its generated block'
);
select has_column(
  'public', 'feedback_events', 'routing_rule_id',
  'feedback can identify its routing rule'
);
select has_column(
  'public', 'feedback_events', 'idempotency_key',
  'feedback has an owner-scoped idempotency key'
);
select has_column(
  'public', 'organization_job_ai_settings', 'adapter_registry_version',
  'job settings freeze the adapter/model registry version'
);
select hasnt_column(
  'public', 'organization_job_ai_settings', 'provider_key_id',
  'job settings never pin a provider-key locator'
);
select hasnt_column(
  'public', 'organization_job_ai_settings', 'provider_credential_revision',
  'job settings never pin a provider credential revision'
);
select has_column(
  'public', 'organization_job_rule_matches', 'destination_kind',
  'rule evidence stores an explicit destination kind'
);
select has_column(
  'public', 'organization_job_rule_matches', 'destination_id',
  'rule evidence stores an explicit destination ID'
);
select has_column(
  'public', 'organization_job_rule_matches', 'priority',
  'rule evidence freezes the matched rule priority'
);
select has_column(
  'public', 'organization_job_rule_matches', 'matched',
  'rule evidence stores an explicit match outcome'
);
select hasnt_column(
  'public', 'organization_job_rule_matches', 'destination_note_id',
  'rule evidence does not imply destination kind from a nullable note column'
);
select hasnt_column(
  'public', 'organization_job_rule_matches', 'destination_space_id',
  'rule evidence does not imply destination kind from a nullable space column'
);

select ok(
  (
    select is_nullable = 'NO' and column_default = '1'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'settings_revision'
  ) and (
    select is_nullable = 'NO' and column_default = '1'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'user_provider_keys'
      and column_name = 'credential_revision'
  ) and (
    select is_nullable = 'NO' and column_default = '1'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'routing_rules'
      and column_name = 'current_revision'
  ) and (
    select is_nullable = 'NO' and column_default = '1'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'generated_blocks'
      and column_name = 'state_revision'
  ),
  'all four revision columns are non-null and begin at one'
);

select ok(
  (
    select condeferrable and condeferred
    from pg_constraint
    where conrelid = 'public.generated_blocks'::regclass
      and conname = 'generated_blocks_review_item_id_fkey'
  ) and (
    select condeferrable and condeferred
    from pg_constraint
    where conrelid = 'public.generated_blocks'::regclass
      and conname = 'generated_blocks_review_item_id_key'
  ),
  'the nullable one-to-one block/review binding is fully deferred'
);
select ok(
  (
    select pg_get_constraintdef(oid) ilike '%vault_secret_id IS NOT NULL%'
      and pg_get_constraintdef(oid) ilike '%key_ciphertext IS NULL%'
    from pg_constraint
    where conrelid = 'public.user_provider_keys'::regclass
      and conname = 'user_provider_keys_vault_only'
  ) and not exists (
    select 1 from public.user_provider_keys where key_ciphertext is not null
  ),
  'provider credentials are Vault-only and retain no ciphertext fallback'
);
select ok(
  (
    select pg_get_constraintdef(oid) ilike '%provider_mode = ''app_default''%'
      and pg_get_constraintdef(oid) ilike '%byok_provider IS NOT NULL%'
      and pg_get_constraintdef(oid) ilike '%NOT byok_fallback_to_app%'
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_provider_mode_shape'
  ),
  'profile provider mode has an exact app-default/BYOK shape'
);
select ok(
  (
    select is_nullable = 'NO'
      and column_default = '''organization-model-registry-v1''::text'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_job_ai_settings'
      and column_name = 'adapter_registry_version'
  ) and (
    select pg_get_constraintdef(oid)
      ilike '%char_length(adapter_registry_version) >= 1%'
      and pg_get_constraintdef(oid)
        ilike '%char_length(adapter_registry_version) <= 100%'
      and pg_get_constraintdef(oid)
        ilike '%adapter_registry_version ~%'
    from pg_constraint
    where conrelid = 'public.organization_job_ai_settings'::regclass
      and conname = 'organization_job_ai_settings_adapter_registry_version'
  ),
  'the adapter registry pin has a frozen, bounded, version-safe default'
);
select ok(
  pg_get_functiondef(
    'private.insert_organization_job_ai_settings(text,uuid)'::regprocedure
  ) !~ '(user_provider_keys|vault_secret|credential_revision|provider_key_id)',
  'settings snapshotting cannot inspect or pin live credential metadata'
);
select ok(
  pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
  ) like '%from public.organization_job_ai_settings as snapshot%'
  and pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
  ) not like '%select profile.org_mode%',
  'organizer claim projects routing mode only from the immutable job snapshot'
);
select ok(
  (
    select bool_and(is_nullable = 'NO' and column_default is null)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_job_rule_matches'
      and column_name = any(array[
        'destination_kind', 'destination_id', 'priority', 'matched'
      ])
  ) and (
    select pg_get_constraintdef(oid) ilike '%destination_kind = ''note''%'
      and pg_get_constraintdef(oid) ilike '%destination_kind = ''space''%'
      and pg_get_constraintdef(oid) ilike '%destination_id ~%'
    from pg_constraint
    where conrelid = 'public.organization_job_rule_matches'::regclass
      and conname = 'organization_job_rule_matches_destination_shape'
  ) and (
    select pg_get_constraintdef(oid) ilike '%priority >= 0%'
      and pg_get_constraintdef(oid) ilike '%priority <= 10000%'
    from pg_constraint
    where conrelid = 'public.organization_job_rule_matches'::regclass
      and conname = 'organization_job_rule_matches_priority_check'
  ) and (
    select pg_get_constraintdef(oid) = 'CHECK (matched)'
    from pg_constraint
    where conrelid = 'public.organization_job_rule_matches'::regclass
      and conname = 'organization_job_rule_matches_matched_check'
  ),
  'rule snapshots require explicit, bounded destination/priority/match fields'
);
select ok(
  (
    select pg_get_constraintdef(oid) ilike '%state = ''open''%'
      and pg_get_constraintdef(oid) ilike '%resolved_at IS NULL%'
    from pg_constraint
    where conrelid = 'public.review_items'::regclass
      and conname = 'review_items_state_resolution_shape'
  ) and (
    select pg_get_constraintdef(oid) ilike '%state = ''proposed''%'
      and pg_get_constraintdef(oid) ilike '%state_revision = 1%'
    from pg_constraint
    where conrelid = 'public.generated_blocks'::regclass
      and conname = 'generated_blocks_state_resolution_shape'
  ),
  'review and generated-block lifecycle constraints are installed'
);
select ok(
  (
    select array_agg(enum_value.enumlabel order by enum_value.enumsortorder)::text
    from pg_enum as enum_value
    join pg_type as enum_type on enum_type.oid = enum_value.enumtypid
    join pg_namespace as enum_schema on enum_schema.oid = enum_type.typnamespace
    where enum_schema.nspname = 'public'
      and enum_type.typname = 'feedback_mutation_role'
  ) = '{source_removal,destination_write}',
  'feedback mutation roles are exactly source-removal and destination-write'
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any(array[
        'organization_job_ai_settings',
        'organization_job_rule_matches',
        'feedback_event_mutations'
      ])
      and (
        data_type in ('json', 'jsonb', 'bytea')
        or column_name ~ '(secret|ciphertext|envelope|content|prompt|response|last4)'
      )
  ),
  'new job and feedback evidence tables have no content or secret channel'
);

-- RLS, policies, grants, and capability boundaries.
select ok(
  (
    select count(*) = 3
      and bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'organization_job_ai_settings',
        'organization_job_rule_matches',
        'feedback_event_mutations'
      ])
  ),
  'all E0 evidence tables have enabled and forced RLS'
);
select is(
  (
    select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        'organization_job_ai_settings',
        'organization_job_rule_matches',
        'feedback_event_mutations'
      ])
  ),
  0::bigint,
  'E0 evidence tables have no direct-client policy'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public', 'anon', 'authenticated', 'service_role',
      'unfiled_organizer_worker', 'unfiled_index_worker',
      'unfiled_rag_verifier'
    ]) as runtime(role_name)
    cross join unnest(array[
      'organization_job_ai_settings',
      'organization_job_rule_matches',
      'feedback_event_mutations'
    ]) as target(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as access(privilege_name)
    where has_table_privilege(
      runtime.role_name,
      format('public.%I', target.table_name),
      access.privilege_name
    )
  ),
  'no client, service, or isolated worker has direct E0 table capability'
);
select ok(
  (
    select count(*) = 11
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )
  ),
  'E4 widens the organizer boundary by exactly its lease-bound resolver'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.insert_organization_job_ai_settings(text,uuid)', 'EXECUTE'
  ) and not has_function_privilege(
    'unfiled_organizer_worker',
    'private.insert_organization_job_ai_settings(text,uuid)', 'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'private.enforce_organization_job_rule_match()', 'EXECUTE'
  ),
  'snapshot and binding trigger helpers are not callable runtime capabilities'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select * from public.organization_job_ai_settings$$,
  '42501', 'permission denied for table organization_job_ai_settings',
  'authenticated clients cannot read job AI snapshots directly'
);
select throws_ok(
  $$insert into public.organization_job_rule_matches(
    job_id, user_id, rule_id, rule_revision, destination_kind,
    destination_id, priority, matched
  ) values (
    'job_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'rule_00000000000000000000000001', 1, 'note',
    'note_00000000000000000000000001', 10, true
  )$$,
  '42501', 'permission denied for table organization_job_rule_matches',
  'authenticated clients cannot forge matched-rule evidence'
);
select throws_ok(
  $$select * from public.feedback_event_mutations$$,
  '42501', 'permission denied for table feedback_event_mutations',
  'authenticated clients cannot read correction mutation evidence directly'
);
reset role;

-- Every existing job is backfilled exactly once with its then-current profile
-- configuration and the frozen adapter/model registry version.
select ok(
  not exists (
    select 1
    from public.organization_jobs as job
    left join public.organization_job_ai_settings as snapshot
      on snapshot.job_id = job.id and snapshot.user_id = job.user_id
    where snapshot.job_id is null
  ),
  'every pre-E0 organization job has an AI settings snapshot'
);
select ok(
  not exists (
    select 1
    from public.organization_job_ai_settings as snapshot
    join public.profiles as profile on profile.id = snapshot.user_id
    where snapshot.provider_mode = 'app_default'
      and (
        snapshot.settings_revision <> profile.settings_revision
        or snapshot.org_mode <> profile.org_mode
        or snapshot.selected_provider <> 'openai'
        or snapshot.byok_fallback_to_app
        or snapshot.adapter_registry_version
          <> 'organization-model-registry-v1'
      )
  ),
  'backfilled app-default jobs capture exact content-free profile settings'
);

-- Profile settings revisions advance exactly once for a settings change and
-- cannot be forged independently.
create temporary table e0_values (
  key text primary key,
  value jsonb not null
) on commit drop;

insert into e0_values(key, value)
select 'profile-before', jsonb_build_object(
  'revision', settings_revision,
  'orgMode', org_mode,
  'displayName', display_name
)
from public.profiles
where id = '11111111-1111-4111-8111-111111111111';

update public.profiles
set org_mode = case
  when org_mode = 'balanced' then 'automatic'::public.org_mode
  else 'balanced'::public.org_mode
end
where id = '11111111-1111-4111-8111-111111111111';
select is(
  (
    select settings_revision from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  (
    select (value ->> 'revision')::integer + 1
    from e0_values where key = 'profile-before'
  ),
  'a settings edit advances settings_revision exactly once'
);

insert into e0_values(key, value)
select 'profile-after-setting', jsonb_build_object(
  'revision', settings_revision
)
from public.profiles
where id = '11111111-1111-4111-8111-111111111111';

update public.profiles
set display_name = display_name || ' revised'
where id = '11111111-1111-4111-8111-111111111111';
select is(
  (
    select settings_revision from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
  ),
  (
    select (value ->> 'revision')::integer
    from e0_values where key = 'profile-after-setting'
  ),
  'display metadata does not impersonate an AI settings edit'
);
select is(
  pg_temp.caught_error($sql$
    update public.profiles
    set settings_revision = settings_revision + 5
    where id = '11111111-1111-4111-8111-111111111111'
  $sql$) ->> 'message',
  'settings_revision_without_change',
  'settings_revision cannot advance without a settings change'
);
select is(
  pg_temp.caught_error($sql$
    update public.profiles
    set byok_fallback_to_app = true
    where id = '11111111-1111-4111-8111-111111111111'
      and provider_mode = 'app_default'
  $sql$) ->> 'sqlstate',
  '23514',
  'app-default mode cannot carry a BYOK fallback setting'
);
select is(
  pg_temp.caught_error($sql$
    update public.profiles
    set provider_mode = 'byok', byok_provider = null
    where id = '11111111-1111-4111-8111-111111111111'
  $sql$) ->> 'sqlstate',
  '23514',
  'BYOK mode requires an explicit provider'
);

-- Vault-only provider credentials reject every legacy storage shape and
-- revision their operational state without leaking key material.
select is(
  pg_temp.caught_error($sql$
    insert into public.user_provider_keys(
      id, user_id, provider, key_ciphertext, key_last4
    ) values (
      'key_87000000000000000000000002',
      '22222222-2222-4222-8222-222222222222',
      'openai', 'legacy-ciphertext', '0002'
    )
  $sql$) ->> 'sqlstate',
  '23502',
  'a ciphertext-only provider key is rejected'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.user_provider_keys(
      id, user_id, provider, vault_secret_id, key_ciphertext, key_last4
    ) values (
      'key_87000000000000000000000002',
      '22222222-2222-4222-8222-222222222222', 'openai',
      '87000000-0000-4000-8000-000000000002',
      'redundant-ciphertext', '0002'
    )
  $sql$) ->> 'sqlstate',
  '23514',
  'a Vault locator cannot retain a redundant ciphertext copy'
);

insert into public.user_provider_keys(
  id, user_id, provider, vault_secret_id, key_last4, status, validated_at
) values (
  'key_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111', 'openai',
  '87000000-0000-4000-8000-000000000001', '0001', 'active', now()
);
select is(
  pg_temp.caught_error($sql$
    update public.user_provider_keys
    set credential_revision = credential_revision + 5
    where id = 'key_87000000000000000000000001'
  $sql$) ->> 'message',
  'credential_revision_without_change',
  'credential_revision cannot be forged without a credential change'
);

-- Create three synthetic captures up front.  The capture text is the existing
-- deleted sentinel, never user content.
insert into public.captures(
  id, user_id, source, raw_text, privacy, client_created_at,
  client_timezone, status, deleted_at
) values
(
  'cap_87000000000000000000000001',
  '22222222-2222-4222-8222-222222222222', 'web', '[deleted]',
  'ai_assisted', now(), 'UTC', 'deleted', now()
),
(
  'cap_87000000000000000000000002',
  '11111111-1111-4111-8111-111111111111', 'web', '[deleted]',
  'ai_assisted', now(), 'UTC', 'deleted', now()
),
(
  'cap_87000000000000000000000003',
  '11111111-1111-4111-8111-111111111111', 'web', '[deleted]',
  'ai_assisted', now(), 'UTC', 'deleted', now()
),
(
  'cap_87000000000000000000000004',
  '11111111-1111-4111-8111-111111111111', 'web', '[deleted]',
  'ai_assisted', now(), 'UTC', 'deleted', now()
),
(
  'cap_87000000000000000000000005',
  '11111111-1111-4111-8111-111111111111', 'web', '[deleted]',
  'ai_assisted', now(), 'UTC', 'deleted', now()
);

-- A BYOK profile snapshots only selection/fallback/registry settings.  Live
-- credential availability is intentionally outside the durable job row and
-- is resolved under the E4 lease boundary.
update public.profiles
set provider_mode = 'byok', byok_provider = 'openai',
  byok_fallback_to_app = false
where id = '22222222-2222-4222-8222-222222222222';
insert into public.organization_jobs(
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_87000000000000000000000001',
  'cap_87000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'created', 'routing-v1', 1
);
select ok(
  (
    select provider_mode = 'byok'
      and selected_provider = 'openai'
      and not byok_fallback_to_app
      and adapter_registry_version = 'organization-model-registry-v1'
    from public.organization_job_ai_settings
    where job_id = 'job_87000000000000000000000001'
  ),
  'a BYOK job snapshots settings without inspecting credential availability'
);

-- A matching Vault metadata row still does not add a key locator or credential
-- revision to the immutable settings snapshot.
update public.profiles
set provider_mode = 'byok', byok_provider = 'openai',
  byok_fallback_to_app = true
where id = '11111111-1111-4111-8111-111111111111';
insert into public.organization_jobs(
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_87000000000000000000000002',
  'cap_87000000000000000000000002',
  '11111111-1111-4111-8111-111111111111',
  'created', 'routing-v1', 1
);
select ok(
  (
    select snapshot.settings_revision = profile.settings_revision
      and snapshot.provider_mode = 'byok'
      and snapshot.selected_provider = 'openai'
      and snapshot.byok_fallback_to_app
      and snapshot.adapter_registry_version
        = 'organization-model-registry-v1'
    from public.organization_job_ai_settings as snapshot
    join public.profiles as profile on profile.id = snapshot.user_id
    where snapshot.job_id = 'job_87000000000000000000000002'
  ),
  'a new job freezes settings and registry without pinning a credential'
);
select is(
  pg_temp.caught_error($sql$
    update public.organization_job_ai_settings
    set routing_effort = 'thorough'
    where job_id = 'job_87000000000000000000000002'
  $sql$) ->> 'message',
  'immutable_job_snapshot',
  'job AI settings cannot be edited after insertion'
);

update public.user_provider_keys
set status = 'invalid'
where id = 'key_87000000000000000000000001';
select ok(
  (
    select credential_revision = 2 and status = 'invalid'
    from public.user_provider_keys
    where id = 'key_87000000000000000000000001'
  ) and (
    select provider_mode = 'byok'
      and selected_provider = 'openai'
      and byok_fallback_to_app
      and adapter_registry_version = 'organization-model-registry-v1'
    from public.organization_job_ai_settings
    where job_id = 'job_87000000000000000000000002'
  ),
  'credential invalidation advances live metadata without mutating settings'
);

insert into public.organization_jobs(
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_87000000000000000000000003',
  'cap_87000000000000000000000003',
  '11111111-1111-4111-8111-111111111111',
  'created', 'routing-v1', 1
);
select ok(
  (
    select provider_mode = 'byok'
      and selected_provider = 'openai'
      and byok_fallback_to_app
      and adapter_registry_version = 'organization-model-registry-v1'
    from public.organization_job_ai_settings
    where job_id = 'job_87000000000000000000000003'
  ),
  'a later job also snapshots settings independently of credential state'
);

-- The durable organizer claim must use the job's organization-mode snapshot,
-- not reinterpret an already queued capture through the owner's live profile.
update public.profiles
set org_mode = 'cautious'
where id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'e0.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/87000000-0000-4000-8000-000000000011',
  decode(repeat('81', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'e0.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/87000000-0000-4000-8000-000000000012',
  decode(repeat('82', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'e0.private.object.v1', 'private_manual', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/87000000-0000-4000-8000-000000000013',
  decode(repeat('83', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'e0.ai.object.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'e0.ai.mac.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'e0.private.object.v1'
);
reset role;

update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '87000000-0000-4000-8000-000000000020',
  'ai_assisted', 'e0.ai.object.v1', 1, 1
);
select public.create_encrypted_capture_with_job(
  '22222222-2222-4222-8222-222222222222',
  jsonb_build_object(
    'clientCaptureId', 'cap_87000000000000000000000006',
    'jobId', 'job_87000000000000000000000006',
    'occurredAt', timestamp_value,
    'contentCipher', pg_temp.capture_cipher(
      'cap_87000000000000000000000006',
      '22222222-2222-4222-8222-222222222222',
      'e0.ai.object.v1', '87000000-0000-4000-8000-000000000020'
    ),
    'contentMac', pg_temp.capture_mac('e0-routing-mode', 'e0.ai.mac.v1'),
    'contentLength', 20,
    'source', 'web',
    'deviceId', 'e0-web',
    'clientCreatedAt', timestamp_value,
    'clientTimezone', 'UTC',
    'privacy', 'ai_assisted',
    'explicitDestinationNoteId', null,
    'expansionDisabled', false,
    'routingRuleMatch', null,
    'privateReceiptCipher', null,
    'privateReceiptVerificationMac', null
  )
)
from (
  select to_char(
    clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) as timestamp_value
) as current_timestamp_value;
reset role;

select ok(
  (
    select org_mode = 'cautious'
    from public.organization_job_ai_settings
    where job_id = 'job_87000000000000000000000006'
  ),
  'encrypted capture acceptance freezes its current organization mode'
);
update public.profiles
set org_mode = 'automatic'
where id = '22222222-2222-4222-8222-222222222222';

insert into e0_values(key, value) values (
  'routing-claim',
  private.claim_encrypted_organizer_jobs_impl('e0-routing-worker', 1, 60)
);
select ok(
  (
    select org_mode = 'automatic'
    from public.profiles
    where id = '22222222-2222-4222-8222-222222222222'
  ) and (
    select value #>> '{jobs,0,jobId}'
      = 'job_87000000000000000000000006'
      and value #>> '{jobs,0,routingMode}' = 'cautious'
    from e0_values where key = 'routing-claim'
  ),
  'later profile changes do not alter a queued job claim routingMode'
);

-- This test transaction later exercises legacy cross-owner mutation fixtures.
-- Return only the synthetic owner's rollout label after the claim proof; the
-- entire file rolls back, including the encrypted capture and key records.
update public.content_encryption_rollouts
set state = 'expanded'
where user_id = '22222222-2222-4222-8222-222222222222';

-- Rule-match evidence binds the enabled rule revision and exact owned
-- destination at insertion, then survives later rule edits unchanged.
insert into public.organization_jobs(
  id, capture_id, user_id, state, prompt_version, schema_version
) values
(
  'job_87000000000000000000000004',
  'cap_87000000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  'created', 'routing-v1', 1
),
(
  'job_87000000000000000000000005',
  'cap_87000000000000000000000005',
  '11111111-1111-4111-8111-111111111111',
  'created', 'routing-v1', 1
);

insert into public.organization_job_rule_matches(
  job_id, user_id, rule_id, rule_revision, destination_kind,
  destination_id, priority, matched
) values (
  'job_87000000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  'rule_00000000000000000000000001', 1, 'note',
  'note_00000000000000000000000001', 10, true
);
select ok(
  (
    select destination_kind = 'note'
      and destination_id = 'note_00000000000000000000000001'
      and priority = 10
      and matched
    from public.organization_job_rule_matches
    where job_id = 'job_87000000000000000000000004'
  ),
  'matched-rule evidence explicitly freezes destination, priority, and outcome'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.organization_job_rule_matches(
      job_id, user_id, rule_id, rule_revision, destination_kind,
      destination_id, priority, matched
    ) values (
      'job_87000000000000000000000005',
      '11111111-1111-4111-8111-111111111111',
      'rule_00000000000000000000000001', 1, 'note',
      'note_00000000000000000000000001', 9, true
    )
  $sql$) ->> 'message',
  'routing_rule_match_stale',
  'a rule snapshot cannot forge the matched rule priority'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.organization_job_rule_matches(
      job_id, user_id, rule_id, rule_revision, destination_kind,
      destination_id, priority, matched
    ) values (
      'job_87000000000000000000000005',
      '11111111-1111-4111-8111-111111111111',
      'rule_00000000000000000000000001', 1, 'note',
      'note_00000000000000000000000001', 10, false
    )
  $sql$) ->> 'message',
  'routing_rule_match_stale',
  'the matched-rule table rejects an explicit non-match outcome'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.organization_job_rule_matches(
      job_id, user_id, rule_id, rule_revision, destination_kind,
      destination_id, priority, matched
    ) values (
      'job_87000000000000000000000005',
      '11111111-1111-4111-8111-111111111111',
      'rule_00000000000000000000000001', 1, 'space',
      'spc_00000000000000000000000001', 10, true
    )
  $sql$) ->> 'message',
  'routing_rule_match_stale',
  'a rule snapshot cannot forge a different destination kind or ID'
);
select is(
  pg_temp.caught_error($sql$
    update public.organization_job_rule_matches
    set rule_revision = 2
    where job_id = 'job_87000000000000000000000004'
  $sql$) ->> 'message',
  'immutable_job_snapshot',
  'matched-rule evidence is immutable'
);

update public.routing_rules
set priority = priority + 1
where id = 'rule_00000000000000000000000001';
select ok(
  (
    select current_revision = 2
    from public.routing_rules
    where id = 'rule_00000000000000000000000001'
  ) and (
    select rule_revision = 1 and priority = 10 and matched
    from public.organization_job_rule_matches
    where job_id = 'job_87000000000000000000000004'
  ),
  'a logical rule edit advances current_revision without rewriting job evidence'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.organization_job_rule_matches(
      job_id, user_id, rule_id, rule_revision, destination_kind,
      destination_id, priority, matched
    ) values (
      'job_87000000000000000000000005',
      '11111111-1111-4111-8111-111111111111',
      'rule_00000000000000000000000001', 1, 'note',
      'note_00000000000000000000000001', 10, true
    )
  $sql$) ->> 'message',
  'routing_rule_match_stale',
  'a stale rule revision cannot be attached to a job'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.organization_job_rule_matches(
      job_id, user_id, rule_id, rule_revision, destination_kind,
      destination_id, priority, matched
    ) values (
      'job_87000000000000000000000005',
      '22222222-2222-4222-8222-222222222222',
      'rule_00000000000000000000000001', 2, 'note',
      'note_00000000000000000000000001', 11, true
    )
  $sql$) ->> 'message',
  'routing_rule_match_stale',
  'job ownership cannot be forged on a rule match'
);

delete from public.organization_jobs
where id = 'job_87000000000000000000000004';
select ok(
  not exists (
    select 1 from public.organization_job_ai_settings
    where job_id = 'job_87000000000000000000000004'
  ) and not exists (
    select 1 from public.organization_job_rule_matches
    where job_id = 'job_87000000000000000000000004'
  ),
  'deleting a job cascades both immutable job snapshots'
);

-- Review/generated-block state and one-to-one ownership binding.
set constraints generated_blocks_review_binding immediate;
set constraints generated_blocks_review_item_id_key immediate;

insert into public.review_items(
  id, user_id, note_id, type, choices, state
) values (
  'rvw_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_00000000000000000000000001',
  'pending_expansion', '[]', 'open'
);
insert into public.generated_blocks(
  id, user_id, note_id, decision_id, kind, content, state,
  model_id, prompt_version, review_item_id
) values (
  'blk_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_00000000000000000000000001',
  'dec_00000000000000000000000001', 'suggestion', '[encrypted]',
  'proposed', 'synthetic-model', 'routing-v1',
  'rvw_87000000000000000000000001'
);
select ok(
  (
    select state = 'proposed' and state_revision = 1
      and resolved_at is null
    from public.generated_blocks
    where id = 'blk_87000000000000000000000001'
  ),
  'a proposed generated block begins at state revision one'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.generated_blocks(
      id, user_id, note_id, decision_id, kind, content, state,
      model_id, prompt_version, review_item_id
    ) values (
      'blk_87000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'note_00000000000000000000000003',
      'dec_00000000000000000000000002', 'suggestion', '[encrypted]',
      'proposed', 'synthetic-model', 'routing-v1',
      'rvw_00000000000000000000000001'
    )
  $sql$) ->> 'message',
  'generated_block_review_binding_invalid',
  'a non-expansion review cannot be attached to a generated block'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.generated_blocks(
      id, user_id, note_id, decision_id, kind, content, state,
      model_id, prompt_version, review_item_id
    ) values (
      'blk_87000000000000000000000003',
      '11111111-1111-4111-8111-111111111111',
      'note_00000000000000000000000001',
      'dec_00000000000000000000000001', 'suggestion', '[encrypted]',
      'proposed', 'synthetic-model', 'routing-v1',
      'rvw_87000000000000000000000001'
    )
  $sql$) ->> 'sqlstate',
  '23505',
  'one pending review cannot authorize two generated blocks'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.generated_blocks(
      id, user_id, note_id, decision_id, kind, content, state,
      model_id, prompt_version, resolved_at
    ) values (
      'blk_87000000000000000000000004',
      '11111111-1111-4111-8111-111111111111',
      'note_00000000000000000000000001',
      'dec_00000000000000000000000001', 'suggestion', '[encrypted]',
      'proposed', 'synthetic-model', 'routing-v1', now()
    )
  $sql$) ->> 'sqlstate',
  '23514',
  'a proposed block cannot carry a resolution timestamp'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.review_items(
      id, user_id, note_id, type, choices, state, resolved_at
    ) values (
      'rvw_87000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'note_00000000000000000000000001',
      'low_confidence', '[]', 'open', now()
    )
  $sql$) ->> 'sqlstate',
  '23514',
  'an open review cannot carry a resolution timestamp'
);

insert into public.review_items(
  id, user_id, note_id, type, choices, state, resolved_at
) values (
  'rvw_87000000000000000000000003',
  '11111111-1111-4111-8111-111111111111',
  'note_00000000000000000000000001',
  'low_confidence', '[]', 'dismissed', now()
);
select is(
  pg_temp.caught_error($sql$
    update public.review_items
    set state = 'resolved'
    where id = 'rvw_87000000000000000000000003'
  $sql$) ->> 'message',
  'invalid_review_state_transition',
  'a terminal review resolution cannot be rewritten'
);

update public.generated_blocks
set state = 'accepted', state_revision = 2, resolved_at = now()
where id = 'blk_87000000000000000000000001';
select ok(
  (
    select state = 'accepted' and state_revision = 2
      and resolved_at is not null
    from public.generated_blocks
    where id = 'blk_87000000000000000000000001'
  ),
  'a proposed block resolves with exactly one state-revision advance'
);
select is(
  pg_temp.caught_error($sql$
    update public.generated_blocks
    set state = 'rejected', state_revision = 3, resolved_at = now()
    where id = 'blk_87000000000000000000000001'
  $sql$) ->> 'message',
  'invalid_generated_block_transition',
  'a terminal generated-block decision cannot be rewritten'
);

-- Feedback references and correction mutation roles are owner-bound and
-- idempotent while remaining content-free.
set constraints feedback_events_owner_bindings immediate;
set constraints feedback_event_mutations_owner_binding immediate;

select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_events(id, user_id, action)
    values (
      'fbk_87000000000000000000000004',
      '11111111-1111-4111-8111-111111111111', 'accepted'
    )
  $sql$) ->> 'sqlstate',
  '23502',
  'feedback without an explicit idempotency key fails closed'
);

insert into public.feedback_events(
  id, user_id, decision_id, action, old_destination_note_id,
  new_destination_note_id, review_item_id, generated_block_id,
  routing_rule_id, idempotency_key, reason_code
) values (
  'fbk_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'dec_00000000000000000000000001', 'expansion_accepted',
  'note_00000000000000000000000003',
  'note_00000000000000000000000001',
  'rvw_87000000000000000000000001',
  'blk_87000000000000000000000001',
  'rule_00000000000000000000000001',
  'e0-feedback-1', 'user_correction'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_events(
      id, user_id, action, idempotency_key
    ) values (
      'fbk_87000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'accepted', 'e0-feedback-1'
    )
  $sql$) ->> 'sqlstate',
  '23505',
  'feedback idempotency keys are unique within an owner'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_events(
      id, user_id, action, generated_block_id, idempotency_key
    ) values (
      'fbk_87000000000000000000000003',
      '22222222-2222-4222-8222-222222222222',
      'expansion_rejected',
      'blk_87000000000000000000000001',
      'e0-feedback-cross-owner'
    )
  $sql$) ->> 'message',
  'feedback_owner_binding_invalid',
  'feedback cannot reference another owner''s generated block'
);

insert into public.feedback_events(
  id, user_id, action, idempotency_key
) values (
  'fbk_87000000000000000000000002',
  '11111111-1111-4111-8111-111111111111',
  'accepted', 'e0-feedback-2'
);
insert into public.note_mutations(
  id, user_id, note_id, idempotency_key, before_revision, after_revision,
  operations, inverse
) values
(
  'mut_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_00000000000000000000000002', 'e0-owner-mutation', 1, 2,
  '[]', '[]'
),
(
  'mut_87000000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'note_00000000000000000000000009', 'e0-other-mutation', 1, 2,
  '[]', '[]'
);

insert into public.feedback_event_mutations(
  feedback_event_id, user_id, mutation_id, role
) values
(
  'fbk_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'mut_00000000000000000000000001', 'destination_write'
),
(
  'fbk_87000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'mut_87000000000000000000000001', 'source_removal'
);
select is(
  (
    select count(*) from public.feedback_event_mutations
    where feedback_event_id = 'fbk_87000000000000000000000001'
  ),
  2::bigint,
  'one correction binds exactly one source removal and destination write'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_event_mutations(
      feedback_event_id, user_id, mutation_id, role
    ) values (
      'fbk_87000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'mut_87000000000000000000000001', 'destination_write'
    )
  $sql$) ->> 'sqlstate',
  '23505',
  'one mutation cannot be attributed to multiple feedback events'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_event_mutations(
      feedback_event_id, user_id, mutation_id, role
    ) values (
      'fbk_87000000000000000000000001',
      '11111111-1111-4111-8111-111111111111',
      'mut_87000000000000000000000002', 'destination_write'
    )
  $sql$) ->> 'sqlstate',
  '23505',
  'one feedback event cannot have two destination writes'
);
select is(
  pg_temp.caught_error($sql$
    insert into public.feedback_event_mutations(
      feedback_event_id, user_id, mutation_id, role
    ) values (
      'fbk_87000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'mut_87000000000000000000000002', 'source_removal'
    )
  $sql$) ->> 'message',
  'feedback_mutation_owner_binding_invalid',
  'feedback mutation links cannot cross owner boundaries'
);

delete from public.feedback_events
where id = 'fbk_87000000000000000000000001';
select is(
  (
    select count(*) from public.feedback_event_mutations
    where feedback_event_id = 'fbk_87000000000000000000000001'
  ),
  0::bigint,
  'deleting feedback cascades its mutation-role links'
);

select * from finish();
rollback;
