create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_ciphertext_length integer default 80
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
      'recordVersion', p_record_version,
      'kind', p_kind
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16),
      'ciphertext', repeat('D', p_ciphertext_length)
    )
  );
$$;

create function pg_temp.caught_error(statement text)
returns jsonb
language plpgsql
as $$
begin
  execute statement;
  return null;
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

-- The production verifier role intentionally starts NOLOGIN. Local pgTAP can
-- prove the public wrapper rejects SET ROLE, then exercise each reviewed
-- implementation through a test-owned definer without weakening production.
create function pg_temp.list_building_note_rag_index(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_cursor jsonb,
  p_limit integer,
  p_ciphertext_byte_budget integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.list_building_note_rag_index_impl(
    p_owner_id, p_generation_id, p_expected_revision_token,
    p_cursor, p_limit, p_ciphertext_byte_budget
  );
$$;

create function pg_temp.verify_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_attestation jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select jsonb_set(
    result.value,
    '{revisionToken}',
    to_jsonb(result.value ->> 'revisionToken'),
    false
  )
  from (
    select private.verify_rag_index_generation_impl(
      p_owner_id, p_generation_id, p_expected_revision_token, p_attestation
    ) as value
  ) as result;
$$;

create temporary table c5c_generation_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on table c5c_generation_values
  to service_role, unfiled_rag_verifier;
grant execute on function pg_temp.caught_error(text)
  to unfiled_rag_verifier;
grant execute on function pg_temp.list_building_note_rag_index(
  uuid, text, bigint, jsonb, integer, integer
) to unfiled_rag_verifier;
grant execute on function pg_temp.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) to unfiled_rag_verifier;

select has_table(
  'public', 'rag_index_generation_seed_batches',
  'seed request replay evidence is durable and content-free'
);
select has_table(
  'public', 'rag_index_maintenance_checkpoints',
  'phase-specific maintenance progress is durable'
);
select has_table(
  'public', 'rag_index_maintenance_page_requests',
  'maintenance response-loss replay evidence is durable and content-free'
);
select has_column(
  'public', 'rag_index_generations', 'failure_code',
  'failed generations retain a bounded safe reason'
);
select ok(
  (
    select count(*) = 3
      and bool_and(is_generated = 'ALWAYS')
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'note_rag_index'
      and column_name in (
        'attestation_envelope_digest',
        'attestation_key_reference_digest',
        'attestation_row_digest'
      )
  ),
  'attestation digests are database-generated stored row state'
);
select has_index(
  'public', 'rag_index_generations', 'rag_index_generations_one_building',
  'one owner can have at most one building generation'
);
select has_function(
  'public', 'list_rag_index_maintenance_candidates',
  array['text', 'integer', 'text', 'uuid', 'jsonb', 'integer'],
  'bounded maintenance discovery is available'
);
select has_function(
  'public', 'ensure_rag_index_generation',
  array['uuid', 'text', 'text', 'integer'],
  'generation ensure is available'
);
select has_function(
  'public', 'seed_rag_index_generation',
  array['uuid', 'text', 'bigint', 'uuid', 'jsonb', 'integer'],
  'bounded idempotent generation seed is available'
);
select has_function(
  'public', 'fail_rag_index_generation',
  array['uuid', 'text', 'bigint', 'safe_error_code'],
  'generation failure CAS is available'
);
select has_function(
  'public', 'list_building_note_rag_index',
  array['uuid', 'text', 'bigint', 'jsonb', 'integer', 'integer'],
  'the verifier has an exact building-generation read RPC'
);

select ok(
  (
    select count(*) = 2
    from pg_proc as procedure
    join pg_namespace as procedure_schema
      on procedure_schema.oid = procedure.pronamespace
    where procedure_schema.nspname = 'public'
      and has_function_privilege(
        'unfiled_rag_verifier', procedure.oid, 'EXECUTE'
      )
  )
    and has_function_privilege(
      'unfiled_rag_verifier',
      'public.list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_rag_verifier',
      'public.verify_rag_index_generation(uuid,text,bigint,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_rag_verifier',
      'public.ensure_rag_index_generation(uuid,text,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_rag_verifier',
      'public.activate_rag_index_generation(uuid,text,bigint)',
      'EXECUTE'
    )
    and not has_schema_privilege(
      'unfiled_rag_verifier', 'private', 'USAGE'
    )
    and not has_table_privilege(
      'unfiled_rag_verifier',
      'public.rag_index_generation_seed_batches', 'SELECT'
    ),
  'the verifier has exactly read plus attest and no control or relation access'
);
select ok(
  (
    select count(*) = 6
    from pg_proc as procedure
    join pg_namespace as procedure_schema
      on procedure_schema.oid = procedure.pronamespace
    where procedure_schema.nspname = 'public'
      and has_function_privilege(
        'unfiled_index_worker', procedure.oid, 'EXECUTE'
      )
  )
    and not has_function_privilege(
      'unfiled_index_worker',
      'public.list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_index_worker',
      'public.seed_rag_index_generation(uuid,text,bigint,uuid,jsonb,integer)',
      'EXECUTE'
    ),
  'the index worker remains at its exact six unrelated capabilities'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_rag_index_maintenance_candidates(text,integer,text,uuid,jsonb,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.ensure_rag_index_generation(uuid,text,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.seed_rag_index_generation(uuid,text,bigint,uuid,jsonb,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.fail_rag_index_generation(uuid,text,bigint,public.safe_error_code)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.verify_rag_index_generation(uuid,text,bigint,jsonb)',
      'EXECUTE'
    ),
  'the lifecycle service cannot impersonate the verifier'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'anon', 'authenticated', 'service_role',
      'unfiled_index_worker', 'unfiled_rag_verifier'
    ]) as checked_role(role_name)
    cross join unnest(array[
      'public.rag_index_maintenance_checkpoints',
      'public.rag_index_maintenance_page_requests'
    ]) as checked_table(table_name)
    cross join unnest(array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]) as checked_privilege(privilege_name)
    where has_table_privilege(
      checked_role.role_name,
      checked_table.table_name,
      checked_privilege.privilege_name
    )
  )
    and not has_function_privilege(
      'service_role',
      'private.rag_index_maintenance_candidate_rows(text,integer,uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_index_worker',
      'private.rag_index_maintenance_candidate_rows(text,integer,uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_rag_verifier',
      'private.rag_index_maintenance_candidate_rows(text,integer,uuid,integer)',
      'EXECUTE'
    ),
  'checkpoint, replay ledger, and candidate helper have no direct runtime access'
);

-- Isolate one seeded owner inside this rolled-back fixture.
delete from public.rag_index_generations
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.notes
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.user_content_keys
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.content_encryption_rollouts
where user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c19.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/76767676-7676-4767-8767-767676767671',
  decode(repeat('76', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c19.ai.object.v1'
);
reset role;

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values
(
  'note_76000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'C5c19 plaintext canary alpha', 'C5c19 plaintext body alpha', '{}',
  1, 'ai_assisted', '2026-08-31 19:00:00+00', '2026-08-31 19:00:00+00',
  pg_temp.content_envelope(
    'note_76000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'c5c19.ai.object.v1'
  ),
  'c5c19.ai.object.v1', 'ai_assisted', 'object_wrap', 1
),
(
  'note_76000000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'C5c19 plaintext canary beta', 'C5c19 plaintext body beta', '{}',
  1, 'ai_assisted', '2026-08-31 19:01:00+00', '2026-08-31 19:01:00+00',
  pg_temp.content_envelope(
    'note_76000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'c5c19.ai.object.v1'
  ),
  'c5c19.ai.object.v1', 'ai_assisted', 'object_wrap', 1
),
(
  'note_76000000000000000000000003',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'C5c19 private canary', 'C5c19 private body', '{}',
  1, 'private_manual', '2026-08-31 19:02:00+00', '2026-08-31 19:02:00+00',
  null, null, null, null, null
);

update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'candidate-before-ensure',
  public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000101', null, 25
  )
);
select ok(
  (select value #>> '{candidates,0,ownerId}'
    from c5c_generation_values where key = 'candidate-before-ensure')
      = '22222222-2222-4222-8222-222222222222'
    and (select value #>> '{candidates,0,action}'
      from c5c_generation_values where key = 'candidate-before-ensure')
      = 'create_build'
    and (select value #>> '{candidates,0,eligibleNoteCount}'
      from c5c_generation_values where key = 'candidate-before-ensure') = '2'
    and (select value #>> '{candidates,0,aiObjectWrapKeyReady}'
      from c5c_generation_values where key = 'candidate-before-ensure') = 'true',
  'maintenance discovery returns only bounded content-free owner state'
);

insert into c5c_generation_values (key, value) values (
  'ensure', public.ensure_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 'c5c19-embedding-v1', 8
  )
);
insert into c5c_generation_values (key, value) values (
  'ensure-replay', public.ensure_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 'c5c19-embedding-v1', 8
  )
);
select ok(
  (select value ->> 'replayed' from c5c_generation_values
    where key = 'ensure') = 'false'
    and (select value ->> 'replayed' from c5c_generation_values
      where key = 'ensure-replay') = 'true'
    and jsonb_typeof((select value -> 'revisionToken'
      from c5c_generation_values where key = 'ensure')) = 'string'
    and (select value ->> 'expectedNoteCount' from c5c_generation_values
      where key = 'ensure') = '2',
  'ensure is exact, replay-safe, and emits a precision-safe token'
);
select throws_ok(
  $$select public.ensure_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000009', 'c5c19-embedding-v1', 8
  )$$,
  'P0001', 'building_generation_exists',
  'a concurrent alternate build cannot pass the owner serialization boundary'
);

insert into c5c_generation_values (key, value) values (
  'seed-1', public.seed_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 0,
    '76000000-0000-4000-8000-000000000001', null, 1
  )
);
insert into c5c_generation_values (key, value) values (
  'seed-1-replay', public.seed_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 0,
    '76000000-0000-4000-8000-000000000001', null, 1
  )
);
select ok(
  (select value ->> 'enqueuedCount' from c5c_generation_values
    where key = 'seed-1') = '1'
    and (select value ->> 'hasMore' from c5c_generation_values
      where key = 'seed-1') = 'true'
    and (select value ->> 'replayed' from c5c_generation_values
      where key = 'seed-1-replay') = 'true'
    and (select value ->> 'revisionToken' from c5c_generation_values
      where key = 'seed-1') = '1'
    and (select value ->> 'blocked' from c5c_generation_values
      where key = 'seed-1') = 'false'
    and (select value #>> '{nextCursor,revisionToken}'
      from c5c_generation_values where key = 'seed-1') = '1',
  'the first seed page advances once and exact response loss replays'
);
select throws_ok(
  $$select public.seed_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 0,
    '76000000-0000-4000-8000-000000000001', null, 2
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a seed batch UUID cannot be rebound to a different request'
);

reset role;
update public.note_index_jobs
set state = 'failed', last_error_code = 'validation_failed'
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_76000000000000000000000001'
  and note_id = 'note_76000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'seed-blocked', public.seed_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 1,
    '76000000-0000-4000-8000-000000000002', null, 1
  )
);
select ok(
  (select value ->> 'blocked' from c5c_generation_values
    where key = 'seed-blocked') = 'true'
    and (select value ->> 'failureCode' from c5c_generation_values
      where key = 'seed-blocked') = 'validation_failed'
    and (select value ->> 'complete' from c5c_generation_values
      where key = 'seed-blocked') = 'false'
    and (select value ->> 'enqueuedCount' from c5c_generation_values
      where key = 'seed-blocked') = '0',
  'a terminal current-revision job returns a typed fail-closed blocker'
);
reset role;
update public.note_index_jobs
set state = 'queued', last_error_code = null
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_76000000000000000000000001'
  and note_id = 'note_76000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'seed-2', public.seed_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001', 1,
    '76000000-0000-4000-8000-000000000003', null, 1
  )
);
reset role;
select ok(
  (select value ->> 'enqueuedCount' from c5c_generation_values
    where key = 'seed-2') = '1'
    and (select value ->> 'complete' from c5c_generation_values
      where key = 'seed-2') = 'true'
    and (select value -> 'nextCursor' from c5c_generation_values
      where key = 'seed-2') = 'null'::jsonb
    and (select value ->> 'blocked' from c5c_generation_values
      where key = 'seed-2') = 'false'
    and (select count(*) from public.note_index_jobs
      where user_id = '22222222-2222-4222-8222-222222222222'
        and generation_id = 'igen_76000000000000000000000001') = 2,
  'a null-cursor restart skips durable work and reaches later eligible notes'
);

insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision,
  index_envelope, index_key_id, index_key_class,
  index_key_purpose, index_key_version, encrypted_byte_length
)
select
  job.index_resource_id, job.user_id, job.note_id, job.generation_id,
  job.target_revision,
  pg_temp.content_envelope(
    job.index_resource_id, job.user_id, job.target_revision,
    'note_rag_index', 'c5c19.ai.object.v1'
  ),
  'c5c19.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
from public.note_index_jobs as job
where job.user_id = '22222222-2222-4222-8222-222222222222'
  and job.generation_id = 'igen_76000000000000000000000001'
order by job.note_id;
delete from public.note_index_jobs
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_76000000000000000000000001';
update public.rag_index_generations
set indexed_note_count = 2, revision_token = revision_token + 1
where user_id = '22222222-2222-4222-8222-222222222222'
  and id = 'igen_76000000000000000000000001';
insert into c5c_generation_values (key, value)
select 'building-token', jsonb_build_object('token', revision_token::text)
from public.rag_index_generations
where user_id = '22222222-2222-4222-8222-222222222222'
  and id = 'igen_76000000000000000000000001';

-- Membership plus SET ROLE is intentionally insufficient; production must
-- authenticate the exact verifier login.
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'set-role-error', pg_temp.caught_error(format(
    'select public.list_building_note_rag_index(%L,%L,%s,null,1,262160)',
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select value ->> 'token' from c5c_generation_values
      where key = 'building-token')
  ))
);
reset role;
select ok(
  (select value ->> 'sqlstate' from c5c_generation_values
    where key = 'set-role-error') = '42501'
    and (select value ->> 'message' from c5c_generation_values
      where key = 'set-role-error') = 'forbidden',
  'SET ROLE cannot impersonate the exact verifier database login'
);

set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'verify-page-1', pg_temp.list_building_note_rag_index(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_generation_values
      where key = 'building-token'),
    null, 1, 262160
  )
);
insert into c5c_generation_values (key, value) values (
  'verify-page-2', pg_temp.list_building_note_rag_index(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_generation_values
      where key = 'building-token'),
    (select value #> '{page,nextCursor}' from c5c_generation_values
      where key = 'verify-page-1'),
    1, 262160
  )
);
reset role;
select ok(
  (select value #>> '{generation,state}' from c5c_generation_values
    where key = 'verify-page-1') = 'building'
    and jsonb_typeof((select value #> '{generation,revisionToken}'
      from c5c_generation_values where key = 'verify-page-1')) = 'string'
    and (select value #>> '{page,hasMore}' from c5c_generation_values
      where key = 'verify-page-1') = 'true'
    and (select value #>> '{page,hasMore}' from c5c_generation_values
      where key = 'verify-page-2') = 'false'
    and (select value #>> '{page,returnedCount}' from c5c_generation_values
      where key = 'verify-page-1') = '1'
    and (select value #>> '{page,returnedCount}' from c5c_generation_values
      where key = 'verify-page-2') = '1'
    and jsonb_array_length((select value -> 'keys'
      from c5c_generation_values where key = 'verify-page-1')) = 1
    and (select value -> 'verification' from c5c_generation_values
      where key = 'verify-page-1') = 'null'::jsonb
    and (select value #>> '{verification,domain}'
      from c5c_generation_values where key = 'verify-page-2')
        = 'unfiled.rag-generation-verification.v1'
    and (select value #>> '{verification,attestationDigest}'
      from c5c_generation_values where key = 'verify-page-2')
        ~ '^[0-9a-f]{64}$',
  'pages stay ordered and token-pinned while only the terminal page attests'
);
select ok(
  strpos((select value::text from c5c_generation_values
    where key = 'verify-page-1'), 'C5c19 plaintext') = 0
    and strpos((select value::text from c5c_generation_values
      where key = 'verify-page-2'), 'C5c19 plaintext') = 0
    and (select value #>> '{items,0,cipher,keyClass}'
      from c5c_generation_values where key = 'verify-page-1') = 'ai_assisted'
    and (select value #>> '{keys,0,keyClass}'
      from c5c_generation_values where key = 'verify-page-1') = 'ai_assisted',
  'the independent read projects ciphertext and exact AI keys without plaintext'
);
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'verification', pg_temp.verify_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_generation_values
      where key = 'building-token'),
    (select value -> 'verification' from c5c_generation_values
      where key = 'verify-page-2')
  )
);
reset role;
select ok(
  (select value ->> 'verified' from c5c_generation_values
    where key = 'verification') = 'true'
    and jsonb_typeof((select value -> 'revisionToken'
      from c5c_generation_values where key = 'verification')) = 'string',
  'attestation succeeds only through the exact verifier and returns a string token'
);
revoke unfiled_rag_verifier from postgres;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'activate', public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_generation_values
      where key = 'building-token')
  )
);
insert into c5c_generation_values (key, value) values (
  'activate-replay', public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_generation_values
      where key = 'building-token')
  )
);
select ok(
  (select value ->> 'replayed' from c5c_generation_values
    where key = 'activate') = 'false'
    and (select value ->> 'replayed' from c5c_generation_values
      where key = 'activate-replay') = 'true'
    and jsonb_typeof((select value -> 'revisionToken'
      from c5c_generation_values where key = 'activate')) = 'string'
    and jsonb_typeof((select value -> 'revisionToken'
      from c5c_generation_values where key = 'activate-replay')) = 'string',
  'activation and response-lost replay preserve decimal string tokens'
);

insert into c5c_generation_values (key, value) values (
  'ensure-failure-build', public.ensure_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000002', 'c5c19-embedding-v1', 8
  )
);
insert into c5c_generation_values (key, value) values (
  'candidate-resume', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000102', null, 25
  )
);
select is(
  (select value #>> '{candidates,0,action}'
    from c5c_generation_values where key = 'candidate-resume'),
  'resume_build',
  'a matching shadow generation is returned for resume'
);
insert into c5c_generation_values (key, value) values (
  'fail', public.fail_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000002', 0, 'provider_unavailable'
  )
);
insert into c5c_generation_values (key, value) values (
  'fail-replay', public.fail_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000002', 0, 'provider_unavailable'
  )
);
select ok(
  (select value ->> 'state' from c5c_generation_values where key = 'fail')
      = 'failed'
    and (select value ->> 'failureCode' from c5c_generation_values
      where key = 'fail') = 'provider_unavailable'
    and (select value ->> 'replayed' from c5c_generation_values
      where key = 'fail-replay') = 'true'
    and jsonb_typeof((select value -> 'revisionToken'
      from c5c_generation_values where key = 'fail-replay')) = 'string',
  'failure is a safe-reason CAS with exact replay semantics'
);
select throws_ok(
  $$select public.fail_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_76000000000000000000000002', 0, 'validation_failed'
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a completed failure cannot be rebound to a different safe reason'
);
insert into c5c_generation_values (key, value) values (
  'candidate-after-fail', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000103', null, 25
  )
);
select is(
  (select value #>> '{page,returnedCount}' from c5c_generation_values
    where key = 'candidate-after-fail'),
  '0',
  'a matching active generation needs no replacement after shadow failure'
);
reset role;

-- Candidate pages must make progress even when more than one complete page of
-- lower UUID owners is durably unready. Owners with an existing build remain
-- visible for one failure CAS, then disappear until their readiness changes.
set local session_replication_role = replica;
insert into public.content_encryption_rollouts (user_id, state)
select
  ('00000000-0000-4000-8000-' || lpad(series.value::text, 12, '0'))::uuid,
  'expanded'
from generate_series(1, 25) as series(value);
insert into public.content_encryption_rollouts (user_id, state) values
  ('ffffffff-ffff-4fff-bfff-ffffffffffff', 'dual_write');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version,
  kms_key_id, wrapped_intermediate_key, state, activated_at
) values (
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
  'c5c19.fair.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/81818181-8181-4181-8181-818181818181',
  decode(repeat('81', 32), 'hex'), 'active', now()
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-later-owner', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000201', null, 20
  )
);
select ok(
  (select value #>> '{page,returnedCount}' from c5c_generation_values
    where key = 'fairness-later-owner') = '1'
    and (select value #>> '{candidates,0,ownerId}'
      from c5c_generation_values where key = 'fairness-later-owner')
      = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    and (select value #>> '{page,hasMore}' from c5c_generation_values
      where key = 'fairness-later-owner') = 'false',
  'more than twenty unready owners cannot starve a later actionable owner'
);
reset role;

set local session_replication_role = replica;
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '00000000-0000-4000-8000-000000000001';
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version,
  kms_key_id, wrapped_intermediate_key, state, activated_at
) values (
  '00000000-0000-4000-8000-000000000001',
  'c5c19.ready.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/82828282-8282-4282-8282-828282828282',
  decode(repeat('82', 32), 'hex'), 'active', now()
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-readiness-change', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000202', null, 20
  )
);
select ok(
  exists (
    select 1
    from jsonb_array_elements((select value -> 'candidates'
      from c5c_generation_values where key = 'fairness-readiness-change'))
      as candidate(value)
    where candidate.value ->> 'ownerId'
      = '00000000-0000-4000-8000-000000000001'
  ),
  'a previously excluded owner becomes discoverable when readiness changes'
);
reset role;

set local session_replication_role = replica;
insert into public.content_encryption_rollouts (user_id, state) values
  ('10000000-0000-4000-8000-000000000001', 'dual_write');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version,
  kms_key_id, wrapped_intermediate_key, state, activated_at
) values (
  '10000000-0000-4000-8000-000000000001',
  'c5c19.capacity.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/83838383-8383-4383-8383-838383838383',
  decode(repeat('83', 32), 'hex'), 'active', now()
);
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy
)
select
  'note_81' || lpad(series.value::text, 24, '0'),
  '10000000-0000-4000-8000-000000000001',
  'generic', 'x', '', '{}', 1, 'ai_assisted'
from generate_series(1, 1000) as series(value);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-capacity-admitted', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000203', null, 20
  )
);
select ok(
  exists (
    select 1
    from jsonb_array_elements((select value -> 'candidates'
      from c5c_generation_values where key = 'fairness-capacity-admitted'))
      as candidate(value)
    where candidate.value ->> 'ownerId'
      = '10000000-0000-4000-8000-000000000001'
  ),
  'an owner at the exact 1,000-note admission boundary remains actionable'
);
reset role;

set local session_replication_role = replica;
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy
) values (
  'note_81' || lpad('1001', 24, '0'),
  '10000000-0000-4000-8000-000000000001',
  'generic', 'x', '', '{}', 1, 'ai_assisted'
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-capacity-excluded', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000204', null, 20
  )
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements((select value -> 'candidates'
      from c5c_generation_values where key = 'fairness-capacity-excluded'))
      as candidate(value)
    where candidate.value ->> 'ownerId'
      = '10000000-0000-4000-8000-000000000001'
  ),
  'an over-capacity owner without a build cannot consume a candidate slot'
);
reset role;

set local session_replication_role = replica;
insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  state, expected_note_count, indexed_note_count, revision_token
) values
(
  'igen_81000000000000000000000001',
  '10000000-0000-4000-8000-000000000001',
  'c5c19-embedding-v1', 8, 'building', 1001, 0, 0
),
(
  'igen_81000000000000000000000002',
  '00000000-0000-4000-8000-000000000002',
  'c5c19-embedding-v1', 8, 'building', 0, 0, 0
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-reconcile-builds', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000205', null, 20
  )
);
select ok(
  (
    select count(*) = 2
    from jsonb_array_elements((select value -> 'candidates'
      from c5c_generation_values where key = 'fairness-reconcile-builds'))
      as candidate(value)
    where candidate.value ->> 'ownerId' in (
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )
      and candidate.value -> 'buildingGeneration' <> 'null'::jsonb
  ),
  'existing unready and over-capacity builds remain visible for reconciliation'
);
reset role;
set local session_replication_role = replica;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.fail_rag_index_generation(
  '10000000-0000-4000-8000-000000000001',
  'igen_81000000000000000000000001', 0, 'validation_failed'
);
select public.fail_rag_index_generation(
  '00000000-0000-4000-8000-000000000002',
  'igen_81000000000000000000000002', 0, 'validation_failed'
);
set local session_replication_role = origin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'fairness-after-reconcile', public.list_rag_index_maintenance_candidates(
    'c5c19-embedding-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000206', null, 20
  )
);
select ok(
  not exists (
    select 1
    from jsonb_array_elements((select value -> 'candidates'
      from c5c_generation_values where key = 'fairness-after-reconcile'))
      as candidate(value)
    where candidate.value ->> 'ownerId' in (
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    )
  ),
  'failed non-actionable builds are excluded until owner readiness changes'
);
reset role;

-- A durable per-phase checkpoint must rotate across more than one cron page of
-- owners even when every lower owner keeps an actionable building generation.
-- Request UUID replay makes advancing that checkpoint safe after response loss.
set local session_replication_role = replica;
insert into public.content_encryption_rollouts (user_id, state)
select
  ('30000000-0000-4000-8000-' || lpad(series.value::text, 12, '0'))::uuid,
  'dual_write'
from generate_series(1, 25) as series(value);
insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  state, expected_note_count, indexed_note_count, revision_token
)
select
  'igen_82' || lpad(series.value::text, 24, '0'),
  ('30000000-0000-4000-8000-' || lpad(series.value::text, 12, '0'))::uuid,
  'c5c19-persistent-old-v1', 8, 'building', 0, 0, 0
from generate_series(1, 25) as series(value);
insert into public.content_encryption_rollouts (user_id, state) values
  ('eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee', 'dual_write');
insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  state, expected_note_count, indexed_note_count, revision_token
) values (
  'igen_83000000000000000000000001',
  'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee',
  'c5c19-persistent-old-v1', 8, 'building', 0, 0, 0
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_generation_values (key, value) values (
  'rotation-first', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000301', null, 20
  )
);
insert into c5c_generation_values (key, value) values (
  'rotation-first-replay', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000301', null, 20
  )
);
select ok(
  (select value #>> '{page,checkpointRevision}'
    from c5c_generation_values where key = 'rotation-first') = '1'
    and (select value #>> '{page,returnedCount}'
      from c5c_generation_values where key = 'rotation-first') = '20'
    and (select value #>> '{page,hasMore}'
      from c5c_generation_values where key = 'rotation-first') = 'true'
    and (select value #>> '{page,nextCursor,phase}'
      from c5c_generation_values where key = 'rotation-first') = 'seed'
    and (select value #>> '{page,nextCursor,checkpointRevision}'
      from c5c_generation_values where key = 'rotation-first') = '1'
    and (select value #>> '{page,replayed}'
      from c5c_generation_values where key = 'rotation-first-replay') = 'true'
    and (select value -> 'candidates'
      from c5c_generation_values where key = 'rotation-first-replay')
      = (select value -> 'candidates'
        from c5c_generation_values where key = 'rotation-first')
    and (select value #> '{page,nextCursor}'
      from c5c_generation_values where key = 'rotation-first-replay')
      = (select value #> '{page,nextCursor}'
        from c5c_generation_values where key = 'rotation-first'),
  'a null-start lost response replays exactly without changing its cursor'
);
select throws_ok(
  $$select public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000301', null, 19
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a page request UUID cannot be rebound to a different request'
);
insert into c5c_generation_values (key, value) values (
  'rotation-second-null-start', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000302', null, 20
  )
);
select ok(
  (select value #>> '{page,checkpointRevision}'
    from c5c_generation_values where key = 'rotation-second-null-start') = '2'
    and (select value #>> '{page,hasMore}'
      from c5c_generation_values where key = 'rotation-second-null-start') = 'false'
    and (select value #> '{page,nextCursor}'
      from c5c_generation_values where key = 'rotation-second-null-start')
      = 'null'::jsonb
    and exists (
      select 1
      from jsonb_array_elements((select value -> 'candidates'
        from c5c_generation_values where key = 'rotation-second-null-start'))
        as candidate(value)
      where candidate.value ->> 'ownerId'
        = 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee'
    ),
  'a later owner is reached despite more than twenty persistent lower builds'
);
insert into c5c_generation_values (key, value) values (
  'rotation-stale-error', pg_temp.caught_error(format(
    'select public.list_rag_index_maintenance_candidates(%L,%s,%L,%L,%L::jsonb,%s)',
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000303',
    (select (value #> '{page,nextCursor}')::text
      from c5c_generation_values where key = 'rotation-first'),
    20
  ))
);
select ok(
  (select value ->> 'sqlstate' from c5c_generation_values
    where key = 'rotation-stale-error') = 'P0001'
    and (select value ->> 'message' from c5c_generation_values
      where key = 'rotation-stale-error') = 'stale_maintenance_cursor',
  'a concurrent winner makes an older explicit cursor fail closed'
);

insert into c5c_generation_values (key, value) values (
  'verify-phase-first', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'verify',
    '76000000-0000-4000-8000-000000000304', null, 20
  )
);
insert into c5c_generation_values (key, value) values (
  'verify-phase-second', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'verify',
    '76000000-0000-4000-8000-000000000305',
    (select value #> '{page,nextCursor}'
      from c5c_generation_values where key = 'verify-phase-first'), 20
  )
);
select ok(
  (select value #>> '{target,phase}' from c5c_generation_values
    where key = 'verify-phase-first') = 'verify'
    and (select value #>> '{page,checkpointRevision}'
      from c5c_generation_values where key = 'verify-phase-first') = '1'
    and (select value #>> '{page,checkpointRevision}'
      from c5c_generation_values where key = 'verify-phase-second') = '2'
    and (select value #>> '{page,hasMore}'
      from c5c_generation_values where key = 'verify-phase-second') = 'false'
    and (select value #> '{page,nextCursor}'
      from c5c_generation_values where key = 'verify-phase-second')
      = 'null'::jsonb,
  'verify has an independent checkpoint and explicit cursors advance once'
);

insert into c5c_generation_values (key, value) values (
  'rotation-wrapped', public.list_rag_index_maintenance_candidates(
    'c5c19-fairness-v2', 8, 'seed',
    '76000000-0000-4000-8000-000000000306', null, 20
  )
);
select ok(
  (select value #>> '{page,checkpointRevision}'
    from c5c_generation_values where key = 'rotation-wrapped') = '3'
    and (select value #>> '{candidates,0,ownerId}'
      from c5c_generation_values where key = 'rotation-wrapped')
      = (select value #>> '{candidates,0,ownerId}'
        from c5c_generation_values where key = 'rotation-first')
    and (select value #>> '{page,hasMore}'
      from c5c_generation_values where key = 'rotation-wrapped') = 'true',
  'a terminal durable checkpoint wraps safely on the next null-start request'
);
reset role;

select ok(
  (select revision_token = 3
    from public.rag_index_maintenance_checkpoints
    where embedding_model_id = 'c5c19-fairness-v2'
      and embedding_dimensions = 8 and phase = 'seed')
    and (select revision_token = 2
      from public.rag_index_maintenance_checkpoints
      where embedding_model_id = 'c5c19-fairness-v2'
        and embedding_dimensions = 8 and phase = 'verify'),
  'seed and verify persist independent monotonic revisions'
);

insert into public.rag_index_maintenance_checkpoints (
  embedding_model_id, embedding_dimensions, phase,
  after_owner_id, revision_token
) values (
  'c5c19-exhaustion-v1', 8, 'seed', null, 9223372036854775807
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.list_rag_index_maintenance_candidates(
    'c5c19-exhaustion-v1', 8, 'seed',
    '76000000-0000-4000-8000-000000000307', null, 20
  )$$,
  'P0001', 'revision_exhausted',
  'checkpoint revision exhaustion fails closed instead of wrapping'
);
select throws_ok(
  $$select public.list_rag_index_maintenance_candidates(
    'c5c19-exhaustion-v1', 8, null,
    '76000000-0000-4000-8000-000000000308', null, 20
  )$$,
  '22023', 'validation_failed',
  'a null maintenance phase is rejected before checkpoint mutation'
);

do $maintenance_ledger$
declare
  request_number integer;
begin
  for request_number in 1..65 loop
    perform public.list_rag_index_maintenance_candidates(
      'c5c19-ledger-v1', 8, 'seed',
      ('76000000-0000-4000-8000-'
        || lpad((400 + request_number)::text, 12, '0'))::uuid,
      null, 1
    );
  end loop;
end;
$maintenance_ledger$;
reset role;
select ok(
  (select count(*) = 64
    from public.rag_index_maintenance_page_requests
    where embedding_model_id = 'c5c19-ledger-v1'
      and embedding_dimensions = 8 and phase = 'seed')
    and not exists (
      select 1
      from public.rag_index_maintenance_page_requests
      where response::text like '%C5c19 plaintext canary%'
    ),
  'the replay ledger retains at most 64 content-free pages per phase lane'
);
update public.rag_index_maintenance_page_requests
set created_at = clock_timestamp() - interval '25 hours'
where embedding_model_id = 'c5c19-ledger-v1'
  and embedding_dimensions = 8 and phase = 'seed'
  and request_id = (
    select request_id
    from public.rag_index_maintenance_page_requests
    where embedding_model_id = 'c5c19-ledger-v1'
      and embedding_dimensions = 8 and phase = 'seed'
    order by created_at, request_id
    limit 1
  );
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.list_rag_index_maintenance_candidates(
  'c5c19-ledger-v1', 8, 'seed',
  '76000000-0000-4000-8000-000000000999', null, 1
);
reset role;
select ok(
  (select count(*) = 64
    from public.rag_index_maintenance_page_requests
    where embedding_model_id = 'c5c19-ledger-v1'
      and embedding_dimensions = 8 and phase = 'seed')
    and not exists (
      select 1
      from public.rag_index_maintenance_page_requests
      where created_at < clock_timestamp() - interval '24 hours'
    ),
  'page replay evidence is pruned globally after its bounded retry window'
);

-- A valid library may contain large normalized lexical payloads. Prove the
-- terminal page and the final database recomputation both remain below the
-- verifier's production-default 250 ms statement timeout without trusting a
-- caller-provided digest. All fixture changes roll back with this test file.
set local session_replication_role = replica;
delete from public.notes
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.rag_index_generations
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.user_content_keys
where user_id = '22222222-2222-4222-8222-222222222222';

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version,
  kms_key_id, wrapped_intermediate_key, state, activated_at
) values (
  '22222222-2222-4222-8222-222222222222',
  'c5c19.max.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/76767676-7676-4767-8767-767676767671',
  decode(repeat('76', 32), 'hex'), 'active', now()
);
insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  state, expected_note_count, indexed_note_count, revision_token
) values (
  'igen_78000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'c5c19-max-payload-v1', 1536, 'building', 500, 500, 42
);
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy
)
select
  'note_78' || lpad(series.value::text, 24, '0'),
  '22222222-2222-4222-8222-222222222222',
  'generic', 'x', '', '{}', 1, 'ai_assisted'
from generate_series(1, 500) as series(value);
insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision,
  index_envelope, index_key_id, index_key_class,
  index_key_purpose, index_key_version, encrypted_byte_length
)
select
  'irw_79' || lpad(series.value::text, 24, '0'),
  '22222222-2222-4222-8222-222222222222',
  'note_78' || lpad(series.value::text, 24, '0'),
  'igen_78000000000000000000000001', 1,
  pg_temp.content_envelope(
    'irw_79' || lpad(series.value::text, 24, '0'),
    '22222222-2222-4222-8222-222222222222', 1,
    'note_rag_index', 'c5c19.max.ai.object.v1', 327680
  ),
  'c5c19.max.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 245760
from generate_series(1, 500) as series(value);
set local session_replication_role = origin;

set local statement_timeout = '250ms';
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'max-terminal-page', pg_temp.list_building_note_rag_index(
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 42,
    jsonb_build_object(
      'generationId', 'igen_78000000000000000000000001',
      'revisionToken', '42',
      'afterIndexId', 'irw_79' || lpad('466', 24, '0')
    ),
    50, 8388608
  )
);
insert into c5c_generation_values (key, value) values (
  'max-verification', pg_temp.verify_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 42,
    (select value -> 'verification' from c5c_generation_values
    where key = 'max-terminal-page')
  )
);
reset role;
revoke unfiled_rag_verifier from postgres;
set local statement_timeout = 0;
select ok(
  (select value #>> '{page,returnedCount}' from c5c_generation_values
    where key = 'max-terminal-page') = '34'
    and (select value #>> '{page,hasMore}' from c5c_generation_values
      where key = 'max-terminal-page') = 'false'
    and (select value #>> '{verification,attestationDigest}'
      from c5c_generation_values where key = 'max-terminal-page')
        ~ '^[0-9a-f]{64}$'
    and (select value ->> 'verified' from c5c_generation_values
      where key = 'max-verification') = 'true'
    and (select value ->> 'verifiedNoteCount' from c5c_generation_values
      where key = 'max-verification') = '500',
  'maximum-payload terminal read and final verification fit 250 ms'
);

update public.note_rag_index
set index_envelope = jsonb_set(
  index_envelope, '{payload,ciphertext}', to_jsonb(repeat('E', 327680))
)
where id = 'irw_79' || lpad('500', 24, '0');
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'max-tamper-error', pg_temp.caught_error(format(
    'select pg_temp.verify_rag_index_generation(%L,%L,%s,%L::jsonb)',
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 42,
    (select (value -> 'verification')::text
      from c5c_generation_values where key = 'max-terminal-page')
  ))
);
reset role;
revoke unfiled_rag_verifier from postgres;
select ok(
  (select value ->> 'sqlstate' from c5c_generation_values
    where key = 'max-tamper-error') = 'P0001'
    and (select value ->> 'message' from c5c_generation_values
      where key = 'max-tamper-error') = 'invalid_generation_attestation'
    and (select attestation_envelope_digest
      from public.note_rag_index
      where id = 'irw_79' || lpad('500', 24, '0'))
      = private.request_hash((select index_envelope
        from public.note_rag_index
        where id = 'irw_79' || lpad('500', 24, '0'))),
  'ciphertext tamper regenerates its digest and invalidates prior evidence'
);

update public.rag_index_generations
set revision_token = revision_token + 1
where user_id = '22222222-2222-4222-8222-222222222222'
  and id = 'igen_78000000000000000000000001';
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'max-stale-page-error', pg_temp.caught_error(format(
    'select pg_temp.list_building_note_rag_index(%L,%L,%s,null,1,262160)',
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 42
  ))
);
reset role;
revoke unfiled_rag_verifier from postgres;
select ok(
  (select value ->> 'sqlstate' from c5c_generation_values
    where key = 'max-stale-page-error') = 'P0001'
    and (select value ->> 'message' from c5c_generation_values
      where key = 'max-stale-page-error') = 'stale_revision',
  'every page remains protected by the exact generation revision CAS'
);

-- The byte-budget regression above is deliberately payload-heavy. Separately
-- exercise the full shared admission count with compact envelopes so the final
-- fixed-digest scan is proved at all 1,000 admitted rows under the same timeout.
set local session_replication_role = replica;
update public.rag_index_generations
set expected_note_count = 1000, indexed_note_count = 1000
where user_id = '22222222-2222-4222-8222-222222222222'
  and id = 'igen_78000000000000000000000001';
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy
)
select
  'note_78' || lpad(series.value::text, 24, '0'),
  '22222222-2222-4222-8222-222222222222',
  'generic', 'x', '', '{}', 1, 'ai_assisted'
from generate_series(501, 1000) as series(value);
insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision,
  index_envelope, index_key_id, index_key_class,
  index_key_purpose, index_key_version, encrypted_byte_length
)
select
  'irw_79' || lpad(series.value::text, 24, '0'),
  '22222222-2222-4222-8222-222222222222',
  'note_78' || lpad(series.value::text, 24, '0'),
  'igen_78000000000000000000000001', 1,
  pg_temp.content_envelope(
    'irw_79' || lpad(series.value::text, 24, '0'),
    '22222222-2222-4222-8222-222222222222', 1,
    'note_rag_index', 'c5c19.max.ai.object.v1'
  ),
  'c5c19.max.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
from generate_series(501, 1000) as series(value);
set local session_replication_role = origin;

set local statement_timeout = '250ms';
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_generation_values (key, value) values (
  'max-count-terminal-page', pg_temp.list_building_note_rag_index(
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 43,
    jsonb_build_object(
      'generationId', 'igen_78000000000000000000000001',
      'revisionToken', '43',
      'afterIndexId', 'irw_79' || lpad('969', 24, '0')
    ),
    50, 8388608
  )
);
insert into c5c_generation_values (key, value) values (
  'max-count-verification', pg_temp.verify_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_78000000000000000000000001', 43,
    (select value -> 'verification' from c5c_generation_values
      where key = 'max-count-terminal-page')
  )
);
reset role;
revoke unfiled_rag_verifier from postgres;
set local statement_timeout = 0;
select ok(
  (select value #>> '{page,returnedCount}' from c5c_generation_values
    where key = 'max-count-terminal-page') = '31'
    and (select value #>> '{page,hasMore}' from c5c_generation_values
      where key = 'max-count-terminal-page') = 'false'
    and (select value ->> 'verified' from c5c_generation_values
      where key = 'max-count-verification') = 'true'
    and (select value ->> 'verifiedNoteCount' from c5c_generation_values
      where key = 'max-count-verification') = '1000',
  'all 1,000 admitted rows attest and verify within 250 ms'
);

select ok(
  strpos(lower(pg_get_functiondef(
    'public.ensure_rag_index_generation(uuid,text,text,integer)'::regprocedure
  )), 'pg_advisory_xact_lock') > 0
    and strpos(lower(pg_get_functiondef(
      'public.seed_rag_index_generation(uuid,text,bigint,uuid,jsonb,integer)'::regprocedure
    )), 'for update') > 0
    and strpos(lower(pg_get_functiondef(
      'public.fail_rag_index_generation(uuid,text,bigint,public.safe_error_code)'::regprocedure
    )), 'for update') > 0
    and strpos(lower(pg_get_functiondef(
      'public.list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)'::regprocedure
    )), 'session_user <> ''unfiled_rag_verifier''') > 0
    and strpos(lower(pg_get_functiondef(
      'private.rag_generation_attestation(uuid,text,bigint)'::regprocedure
    )), 'attestation_row_digest') > 0
    and strpos(lower(pg_get_functiondef(
      'private.rag_generation_attestation(uuid,text,bigint)'::regprocedure
    )), 'index_envelope') = 0,
  'owner locks, CAS, exact login, and fixed-size manifest reads are explicit'
);

select * from finish();
rollback;
