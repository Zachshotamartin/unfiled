create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
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
      'recordVersion', p_record_version,
      'kind', 'note_content'
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

create temporary table queue_liveness_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on table queue_liveness_values to service_role;

select ok(
  (
    select procedure.prosecdef
      and procedure.proconfig @> array['search_path=""']
    from pg_proc as procedure
    where procedure.oid =
      'public.claim_note_index_jobs(text,integer,integer)'::regprocedure
  ),
  'the liveness replacement remains SECURITY DEFINER with an empty search path'
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
    and has_function_privilege(
      'unfiled_index_worker',
      'public.claim_note_index_jobs(text,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.claim_note_index_jobs(text,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.claim_note_index_jobs(text,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_rag_verifier',
      'public.claim_note_index_jobs(text,integer,integer)',
      'EXECUTE'
    ),
  'the exact six-RPC worker boundary and claim denials are unchanged'
);
select ok(
  strpos(
    lower(pg_get_functiondef(
      'public.claim_note_index_jobs(text,integer,integer)'::regprocedure
    )),
    'candidate_scan_limit constant integer := 500'
  ) > 0
    and strpos(
      lower(pg_get_functiondef(
        'public.claim_note_index_jobs(text,integer,integer)'::regprocedure
      )),
      'limit candidate_scan_limit'
    ) > 0,
  'one claim scans a fixed 500-row page independent of the requested claim count'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'liveness.ai.old.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/75757575-7575-4757-8757-757575757571',
  decode(repeat('75', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'liveness.ai.old.v1'
);
select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'liveness.ai.current.v2', 'ai_assisted', 'object_wrap', 2,
  'arn:aws:kms:us-west-2:123456789012:key/75757575-7575-4757-8757-757575757572',
  decode(repeat('76', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'liveness.ai.current.v2'
);

select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'liveness.other.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/75757575-7575-4757-8757-757575757579',
  decode(repeat('77', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'liveness.other.v1'
);

select public.create_rag_index_generation(
  '11111111-1111-4111-8111-111111111111',
  'igen_75000000000000000000000001', 'liveness-embedding-v1', 8
);
select public.create_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_75000000000000000000000002', 'liveness-embedding-v1', 8
);

reset role;

-- Build a poisoned prefix larger than both p_limit * 10 and the fixed scan
-- page. The rows are valid when inserted and become permanently ineligible
-- only after their retired source key is explicitly revoked.
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
)
select
  'note_' || lpad(
    (75000000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '11111111-1111-4111-8111-111111111111',
  'spc_00000000000000000000000001', 'generic',
  'revoked source fixture ' || item, 'encrypted source fixture', '{}',
  1, 'ai_assisted',
  '2026-08-31 18:00:00+00'::timestamptz + make_interval(secs => item),
  '2026-08-31 18:00:00+00'::timestamptz + make_interval(secs => item),
  pg_temp.content_envelope(
    'note_' || lpad(
      (75000000000000000000000000::numeric + item)::text, 26, '0'
    ),
    '11111111-1111-4111-8111-111111111111', 1,
    'liveness.ai.old.v1'
  ),
  'liveness.ai.old.v1', 'ai_assisted', 'object_wrap', 1
from generate_series(1, 501) as series(item);

insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  available_at, created_at
)
select
  'ijob_' || lpad(
    (75100000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '11111111-1111-4111-8111-111111111111',
  'note_' || lpad(
    (75000000000000000000000000::numeric + item)::text, 26, '0'
  ),
  'igen_75000000000000000000000001', 1,
  'irw_' || lpad(
    (75200000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '2026-08-31 18:00:00+00'::timestamptz + make_interval(secs => item),
  '2026-08-31 18:00:00+00'::timestamptz + make_interval(secs => item)
from generate_series(1, 501) as series(item);

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_75900000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'newer eligible fixture', 'encrypted eligible fixture', '{}',
  1, 'ai_assisted', '2026-08-31 20:00:00+00', '2026-08-31 20:00:00+00',
  pg_temp.content_envelope(
    'note_75900000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'liveness.other.v1'
  ),
  'liveness.other.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  available_at, created_at
) values (
  'ijob_75900000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'note_75900000000000000000000001',
  'igen_75000000000000000000000002', 1,
  'irw_75900000000000000000000001',
  '2026-08-31 20:00:00+00', '2026-08-31 20:00:00+00'
);

update public.user_content_keys
set state = 'revoked', revoked_at = clock_timestamp()
where user_id = '11111111-1111-4111-8111-111111111111'
  and key_id = 'liveness.ai.old.v1';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into queue_liveness_values (key, value) values (
  'bounded-drain-1', public.claim_note_index_jobs(
    'liveness-worker-1', 1, 60
  )
);
reset role;

select ok(
  jsonb_array_length((
    select value -> 'jobs' from queue_liveness_values
    where key = 'bounded-drain-1'
  )) = 0
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and state = 'failed'
        and last_error_code = 'validation_failed'
    ) = 500
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and state = 'queued'
    ) = 1,
  'the first bounded drain terminalizes exactly one 500-row poisoned page'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into queue_liveness_values (key, value) values (
  'bounded-drain-2', public.claim_note_index_jobs(
    'liveness-worker-2', 1, 60
  )
);
reset role;

select ok(
  (select value #>> '{jobs,0,noteId}' from queue_liveness_values
    where key = 'bounded-drain-2') = 'note_75900000000000000000000001'
    and (select value #>> '{jobs,0,userId}' from queue_liveness_values
      where key = 'bounded-drain-2')
      = '22222222-2222-4222-8222-222222222222'
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and state = 'failed'
        and last_error_code = 'validation_failed'
    ) = 501,
  'a second bounded drain advances beyond 501 revoked-source blockers across users'
);
select ok(
  not exists (
    select 1 from public.note_index_jobs
    where user_id = '11111111-1111-4111-8111-111111111111'
      and state in ('queued', 'leased')
  )
    and exists (
      select 1 from public.note_index_jobs
      where id = 'ijob_75900000000000000000000001'
        and state = 'leased'
        and attempt = 1
    ),
  'permanent blockers are terminal while the newer eligible row receives the lease'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.fail_note_index_job(
  (select value #>> '{jobs,0,jobId}' from queue_liveness_values
    where key = 'bounded-drain-2'),
  (select (value #>> '{jobs,0,leaseToken}')::uuid
    from queue_liveness_values where key = 'bounded-drain-2'),
  'provider_unavailable', false, 0
);
reset role;

-- Target-key exhaustion is deliberately transient. Build a second prefix
-- larger than the 500-row scan window to prove persisted queue rotation, rather
-- than terminalization, makes bounded repeated drains fair across owners.
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
)
select
  'note_' || lpad(
    (75300000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '11111111-1111-4111-8111-111111111111',
  'spc_00000000000000000000000001', 'generic',
  'transient capacity fixture ' || item, 'encrypted transient fixture', '{}',
  1, 'ai_assisted',
  '2026-08-31 20:30:00+00'::timestamptz + make_interval(secs => item),
  '2026-08-31 20:30:00+00'::timestamptz + make_interval(secs => item),
  pg_temp.content_envelope(
    'note_' || lpad(
      (75300000000000000000000000::numeric + item)::text, 26, '0'
    ),
    '11111111-1111-4111-8111-111111111111', 1,
    'liveness.ai.current.v2'
  ),
  'liveness.ai.current.v2', 'ai_assisted', 'object_wrap', 2
from generate_series(1, 501) as series(item);

insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  available_at, created_at
)
select
  'ijob_' || lpad(
    (75400000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '11111111-1111-4111-8111-111111111111',
  'note_' || lpad(
    (75300000000000000000000000::numeric + item)::text, 26, '0'
  ),
  'igen_75000000000000000000000001', 1,
  'irw_' || lpad(
    (75500000000000000000000000::numeric + item)::text, 26, '0'
  ),
  '2026-08-31 20:30:00+00'::timestamptz + make_interval(secs => item),
  '2026-08-31 20:30:00+00'::timestamptz + make_interval(secs => item)
from generate_series(1, 501) as series(item);

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_75900000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'second eligible fixture', 'encrypted second eligible fixture', '{}',
  1, 'ai_assisted', '2026-08-31 20:45:00+00', '2026-08-31 20:45:00+00',
  pg_temp.content_envelope(
    'note_75900000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1,
    'liveness.other.v1'
  ),
  'liveness.other.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  available_at, created_at
) values (
  'ijob_75900000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'note_75900000000000000000000002',
  'igen_75000000000000000000000002', 1,
  'irw_75900000000000000000000002',
  '2026-08-31 20:45:00+00', '2026-08-31 20:45:00+00'
);

update public.user_content_keys
set wrap_operations = wrap_operation_limit
where user_id = '11111111-1111-4111-8111-111111111111'
  and key_id = 'liveness.ai.current.v2';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into queue_liveness_values (key, value) values (
  'transient-skip-1', public.claim_note_index_jobs(
    'liveness-worker-3', 1, 60
  )
);
reset role;

select ok(
  jsonb_array_length((
    select value -> 'jobs' from queue_liveness_values
    where key = 'transient-skip-1'
  )) = 0
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and generation_id = 'igen_75000000000000000000000001'
        and state = 'queued'
        and attempt = 0
        and last_error_code is null
        and target_reservation_id is null
        and lease_token is null
    ) = 501
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and generation_id = 'igen_75000000000000000000000001'
        and state = 'queued'
        and available_at > '2026-08-31 20:45:00+00'
    ) = 500,
  'the first bounded transient drain fairly rotates 500 jobs without poisoning or leasing them'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into queue_liveness_values (key, value) values (
  'transient-skip-2', public.claim_note_index_jobs(
    'liveness-worker-4', 1, 60
  )
);
reset role;

select ok(
  (select value #>> '{jobs,0,noteId}' from queue_liveness_values
    where key = 'transient-skip-2') = 'note_75900000000000000000000002'
    and (
      select count(*) from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and generation_id = 'igen_75000000000000000000000001'
        and state = 'queued'
        and attempt = 0
        and last_error_code is null
        and target_reservation_id is null
        and lease_token is null
    ) = 501,
  'a second bounded drain advances beyond 501 transient blockers and claims another owner'
);

-- Exercise the stale-revision fallback independently of the normal note
-- invalidation trigger, which ordinarily terminalizes this race first.
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_75900000000000000000000003',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'stale revision fixture', 'encrypted stale fixture', '{}',
  1, 'ai_assisted', '2026-08-31 20:50:00+00', '2026-08-31 20:50:00+00',
  pg_temp.content_envelope(
    'note_75900000000000000000000003',
    '22222222-2222-4222-8222-222222222222', 1,
    'liveness.other.v1'
  ),
  'liveness.other.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  available_at, created_at
) values (
  'ijob_75900000000000000000000003',
  '22222222-2222-4222-8222-222222222222',
  'note_75900000000000000000000003',
  'igen_75000000000000000000000002', 1,
  'irw_75900000000000000000000003',
  '2026-08-31 20:50:00+00', '2026-08-31 20:50:00+00'
);

set local session_replication_role = replica;
update public.note_index_jobs
set target_revision = 2
where id = 'ijob_75900000000000000000000003';
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into queue_liveness_values (key, value) values (
  'stale-fallback', public.claim_note_index_jobs(
    'liveness-worker-5', 1, 60
  )
);
reset role;

select ok(
  jsonb_array_length((
    select value -> 'jobs' from queue_liveness_values
    where key = 'stale-fallback'
  )) = 0
    and exists (
      select 1 from public.note_index_jobs
      where id = 'ijob_75900000000000000000000003'
        and state = 'failed'
        and last_error_code = 'stale_revision'
    )
    and exists (
      select 1 from public.note_index_jobs
      where user_id = '11111111-1111-4111-8111-111111111111'
        and generation_id = 'igen_75000000000000000000000001'
        and state = 'queued'
    ),
  'revision drift terminates as stale_revision while transient work remains queued'
);

select * from finish();
rollback;
