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

create function pg_temp.generation_attestation(
  p_owner_id uuid,
  p_generation_id text,
  p_revision_token bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  attestation_value jsonb;
  attestation_digest_value text;
begin
  attestation_value := private.rag_generation_attestation(
    p_owner_id, p_generation_id, p_revision_token
  );
  attestation_digest_value := private.request_hash(attestation_value);
  return jsonb_build_object(
    'domain', 'unfiled.rag-generation-verification.v1',
    'attestationDigest', attestation_digest_value
  );
end;
$$;

create function pg_temp.caught_sqlstate(statement text)
returns text
language plpgsql
as $$
begin
  execute statement;
  return null;
exception when others then
  return sqlstate;
end;
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

create temporary table c5c_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on table c5c_values to service_role, unfiled_rag_verifier;
grant execute on function pg_temp.caught_error(text) to unfiled_rag_verifier;

select has_table(
  'public', 'rag_index_generation_verifications',
  'strict generation verification evidence is durable'
);
select has_column(
  'public', 'note_index_jobs', 'target_reservation_id',
  'index leases persist their target reservation'
);
select has_column(
  'public', 'note_index_jobs', 'target_reservation_lease_token',
  'index reservations bind the exact lease capability'
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
  ),
  'the dedicated index worker still has exactly six RPC grants'
);
select ok(
  has_function_privilege(
    'unfiled_index_worker',
    'public.list_active_note_rag_index(uuid,jsonb,integer,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'unfiled_index_worker',
      'public.verify_rag_index_generation(uuid,text,bigint,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_index_worker',
      'public.activate_rag_index_generation(uuid,text,bigint)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.verify_rag_index_generation(uuid,text,bigint,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_rag_verifier',
      'public.verify_rag_index_generation(uuid,text,bigint,jsonb)',
      'EXECUTE'
    )
    and not has_table_privilege(
      'unfiled_index_worker',
      'public.rag_index_generation_verifications',
      'SELECT'
    ),
  'verification uses a separate verifier while activation stays outside the worker'
);
select ok(
  (
    select not rolsuper
      and not rolcreaterole
      and not rolcreatedb
      and not rolcanlogin
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
    from pg_roles
    where rolname = 'unfiled_rag_verifier'
  )
    and not exists (
      select 1
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
      join pg_roles as grantor on grantor.oid = membership.grantor
      where (
        member.rolname = 'unfiled_rag_verifier'
        or granted.rolname = 'unfiled_rag_verifier'
      )
        and not (
          granted.rolname = 'unfiled_rag_verifier'
          and member.rolname = 'postgres'
          and grantor.rolname = 'supabase_admin'
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
    ),
  'the verifier has no workload membership beyond the inert platform admin edge'
);
select ok(
  (
    select count(*) = 1
    from pg_proc as procedure
    join pg_namespace as procedure_schema
      on procedure_schema.oid = procedure.pronamespace
    where procedure_schema.nspname = 'public'
      and has_function_privilege(
        'unfiled_rag_verifier', procedure.oid, 'EXECUTE'
      )
  )
    and not has_schema_privilege(
      'unfiled_rag_verifier', 'private', 'USAGE'
    )
    and not has_table_privilege(
      'unfiled_rag_verifier',
      'public.rag_index_generation_verifications', 'SELECT'
    ),
  'the verifier has exactly one public RPC and no private or relation access'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/74747474-7474-4747-8747-747474747471',
  decode(repeat('74', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'c5c.ai.object.v1'
);

insert into c5c_values (key, value) values (
  'no-active-page', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 25, 1048576
  )
);
reset role;
select ok(
  (select value -> 'generation' from c5c_values where key = 'no-active-page')
      = 'null'::jsonb
    and (select value #>> '{coverage,repairCount}' from c5c_values
      where key = 'no-active-page') = '0'
    and (select value #>> '{page,returnedCount}' from c5c_values
      where key = 'no-active-page') = '0',
  'structured coverage metadata is returned even with no active generation'
);

select public.create_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001', 'c5c-embedding-v1', 8
);
select throws_ok(
  $$select public.verify_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001', 0,
    jsonb_build_object(
      'domain', 'unfiled.rag-generation-verification.v1',
      'attestationDigest', repeat('a', 64)
    )
  )$$,
  '42501', 'forbidden',
  'service role cannot turn arbitrary hex into generation verification'
);
reset role;
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
insert into c5c_values (key, value) values (
  'bogus-mac-attestation',
  pg_temp.caught_error($bogus_mac_attestation$
    select public.verify_rag_index_generation(
      '22222222-2222-4222-8222-222222222222',
      'igen_74000000000000000000000001', 0,
      pg_temp.generation_attestation(
        '22222222-2222-4222-8222-222222222222',
        'igen_74000000000000000000000001', 0
      ) || jsonb_build_object(
        'verificationMac', jsonb_build_object('mac', repeat('b', 64))
      )
    )
  $bogus_mac_attestation$)
);
insert into c5c_values (key, value) values (
  'arbitrary-verifier-attestation',
  pg_temp.caught_error($arbitrary_attestation$
    select public.verify_rag_index_generation(
      '22222222-2222-4222-8222-222222222222',
      'igen_74000000000000000000000001', 0,
      jsonb_build_object(
        'domain', 'unfiled.rag-generation-verification.v1',
        'attestationDigest', repeat('a', 64)
      )
    )
  $arbitrary_attestation$)
);
select public.verify_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001', 0,
  pg_temp.generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001', 0
  )
);
reset role;
select ok(
  (
    select value ->> 'sqlstate' = '22023'
      and value ->> 'message' = 'validation_failed'
    from c5c_values where key = 'bogus-mac-attestation'
  ),
  'verification input rejects a bogus legacy MAC as an extra field'
);
select ok(
  (
    select value ->> 'sqlstate' = 'P0001'
      and value ->> 'message' = 'invalid_generation_attestation'
    from c5c_values where key = 'arbitrary-verifier-attestation'
  ),
  'the verifier cannot substitute arbitrary hex for the canonical manifest digest'
);
update public.rag_index_generation_verifications
set attestation_digest = repeat('e', 64)
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_74000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001',
    0
  )$$,
  'P0001', 'generation_not_verified',
  'activation revalidates and rejects mutated verification evidence'
);
reset role;
set local role unfiled_rag_verifier;
select public.verify_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001', 0,
  pg_temp.generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001', 0
  )
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.activate_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001', 0
);
insert into c5c_values (key, value) values (
  'empty-active-page', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 25, 1048576
  )
);
select ok(
  (select value #>> '{generation,generationId}' from c5c_values
    where key = 'empty-active-page') = 'igen_74000000000000000000000001'
    and (select value #>> '{coverage,verified}' from c5c_values
      where key = 'empty-active-page') = 'true'
    and (select value #>> '{coverage,complete}' from c5c_values
      where key = 'empty-active-page') = 'true'
    and jsonb_array_length((select value -> 'items' from c5c_values
      where key = 'empty-active-page')) = 0,
  'a verified empty generation returns an explicit complete empty page'
);

reset role;
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_74000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'C.5c source fixture', 'encrypted source fixture', '{}',
  1, 'ai_assisted', '2026-08-31 16:00:00+00', '2026-08-31 16:00:00+00',
  pg_temp.content_envelope(
    'note_74000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'c5c.ai.object.v1'
  ),
  'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_values (key, value) values (
  'enqueue-v1', public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_74000000000000000000000001',
    'igen_74000000000000000000000001', 1
  )
);
insert into c5c_values (key, value) values (
  'claim-v1', public.claim_note_index_jobs('c5c-worker-v1', 1, 60)
);
select ok(
  jsonb_array_length((select value -> 'jobs' from c5c_values
    where key = 'claim-v1')) = 1
    and (select value #>> '{jobs,0,targetRevision}' from c5c_values
      where key = 'claim-v1') = '1'
    and (select value #>> '{jobs,0,noteType}' from c5c_values
      where key = 'claim-v1') = 'generic'
    and (select value #>> '{jobs,0,spaceId}' from c5c_values
      where key = 'claim-v1') = 'spc_00000000000000000000000009'
    and (select value #>> '{jobs,0,embeddingModelId}' from c5c_values
      where key = 'claim-v1') = 'c5c-embedding-v1'
    and (select value #>> '{jobs,0,embeddingDimensions}' from c5c_values
      where key = 'claim-v1') = '8',
  'claim returns bounded source metadata and the exact generation contract'
);
select ok(
  (select value #>> '{jobs,0,sourceNoteCipher,keyId}' from c5c_values
    where key = 'claim-v1') = 'c5c.ai.object.v1'
    and (select value #>> '{jobs,0,sourceKey,ownerId}' from c5c_values
      where key = 'claim-v1') = '22222222-2222-4222-8222-222222222222'
    and (select value #>> '{jobs,0,sourceKey,keyClass}' from c5c_values
      where key = 'claim-v1') = 'ai_assisted'
    and (select value #>> '{jobs,0,targetKey,purpose}' from c5c_values
      where key = 'claim-v1') = 'object_wrap'
    and (select value #>> '{jobs,0,reservation,operationCount}' from c5c_values
      where key = 'claim-v1') = '1',
  'claim returns exact AI source/target managed keys and one reservation'
);
select ok(
  (select (value #>> '{sourceEnvelopeBytes}')::integer from c5c_values
    where key = 'claim-v1')
      <= (select (value #>> '{sourceEnvelopeByteBudget}')::integer
        from c5c_values where key = 'claim-v1')
    and (select wrap_operations from public.user_content_keys
      where user_id = '22222222-2222-4222-8222-222222222222'
        and key_id = 'c5c.ai.object.v1') = 1,
  'claim enforces its aggregate byte budget and atomically burns capacity'
);
-- Fixture-only storage inspection runs as the reset owner; runtime capability
-- assertions and calls remain under service_role.
reset role;
select ok(
  exists (
    select 1
    from public.note_index_jobs as job
    join public.content_key_operation_reservations as reservation
      on reservation.user_id = job.user_id
      and reservation.reservation_id = job.target_reservation_id
    where job.id = (select value #>> '{jobs,0,jobId}' from c5c_values
      where key = 'claim-v1')
      and job.target_reservation_attempt = job.attempt
      and job.target_reservation_lease_token = job.lease_token
      and reservation.key_id = job.target_key_id
      and reservation.consumed_at is null
  ),
  'the reservation is durably bound to job, attempt, lease, resource, and key'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  jsonb_array_length(public.claim_note_index_jobs('c5c-competitor', 1, 60)
    -> 'jobs'),
  0,
  'a competing claim cannot duplicate a live lease or reservation'
);
select is(
  public.heartbeat_note_index_job(
    (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-v1'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
      where key = 'claim-v1'),
    60
  ) ->> 'disclosureAuthorized',
  'true',
  'heartbeat is the final current-note/key disclosure authorization point'
);
select throws_ok(
  format(
    'select public.commit_note_rag_index(%L,%L::uuid,%L,%L::jsonb,%L,%L,%L,1,60)',
    (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-v1'),
    (select value #>> '{jobs,0,leaseToken}' from c5c_values where key = 'claim-v1'),
    (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'c5c.ai.object.v1'
    )::text,
    'wrong.ai.object.v1', 'ai_assisted', 'object_wrap'
  ),
  '22023', 'invalid_index_reservation',
  'commit rejects a key that differs from the claim-bound reservation'
);
insert into c5c_values (key, value) values (
  'commit-v1', public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-v1'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
      where key = 'claim-v1'),
    (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'c5c.ai.object.v1'
    ),
    'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  )
);
-- Fixture-only storage inspection runs as the reset owner; the commit itself and
-- replay/capability assertions remain under service_role.
reset role;
select ok(
  (select value ->> 'committed' from c5c_values where key = 'commit-v1') = 'true'
    and exists (
      select 1 from public.content_key_operation_reservations
      where user_id = '22222222-2222-4222-8222-222222222222'
        and reservation_id = (
          select (value #>> '{jobs,0,reservation,reservationId}')::uuid
          from c5c_values where key = 'claim-v1'
        )
        and consumed_by_type = 'note_rag_index'
        and consumed_by_id = (
          select value #>> '{jobs,0,indexResourceId}'
          from c5c_values where key = 'claim-v1'
        )
    ),
  'commit atomically consumes the exact reservation with the index row'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-v1'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
      where key = 'claim-v1'),
    (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v1'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'c5c.ai.object.v1'
    ),
    'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  ) ->> 'replayed',
  'true',
  'terminal commit replay does not consume or reserve again'
);

reset role;
update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'c5c.ai.object.v1'
  )
where id = 'note_74000000000000000000000001';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_values (key, value) values (
  'enqueue-v2', public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_74000000000000000000000001',
    'igen_74000000000000000000000001', 2
  )
);
insert into c5c_values (key, value) values (
  'claim-v2-abandoned', public.claim_note_index_jobs('c5c-worker-v2a', 1, 60)
);
select is(
  (select value #>> '{jobs,0,indexResourceId}' from c5c_values
    where key = 'claim-v2-abandoned'),
  (select value #>> '{jobs,0,indexResourceId}' from c5c_values
    where key = 'claim-v1'),
  'revision N+1 reuses the same advisory-serialized index resource ID'
);
select public.fail_note_index_job(
  (select value #>> '{jobs,0,jobId}' from c5c_values
    where key = 'claim-v2-abandoned'),
  (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
    where key = 'claim-v2-abandoned'),
  'provider_unavailable', true, 0
);
reset role;
select ok(
  exists (
    select 1 from public.content_key_operation_reservations
    where user_id = '22222222-2222-4222-8222-222222222222'
      and reservation_id = (
        select (value #>> '{jobs,0,reservation,reservationId}')::uuid
        from c5c_values where key = 'claim-v2-abandoned'
      )
      and consumed_by_id like 'abandoned:%'
  ),
  'a failed attempt terminally burns its abandoned reservation'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_values (key, value) values (
  'claim-v2', public.claim_note_index_jobs('c5c-worker-v2b', 1, 60)
);
select isnt(
  (select value #>> '{jobs,0,reservation,reservationId}' from c5c_values
    where key = 'claim-v2'),
  (select value #>> '{jobs,0,reservation,reservationId}' from c5c_values
    where key = 'claim-v2-abandoned'),
  'a retry receives a fresh reservation while retaining the stable resource'
);
select public.commit_note_rag_index(
  (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-v2'),
  (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
    where key = 'claim-v2'),
  (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v2'),
  pg_temp.content_envelope(
    (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-v2'),
    '22222222-2222-4222-8222-222222222222', 2,
    'note_rag_index', 'c5c.ai.object.v1'
  ),
  'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
);

reset role;
insert into c5c_values (key, value)
select 'verify-token-v2', jsonb_build_object('token', revision_token)
from public.rag_index_generations
where id = 'igen_74000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
reset role;
set local role unfiled_rag_verifier;
select public.verify_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001',
  (select (value ->> 'token')::bigint from c5c_values where key = 'verify-token-v2'),
  pg_temp.generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_values where key = 'verify-token-v2')
  )
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_values (key, value) values (
  'complete-page-v2', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50, 1048576
  )
);
select ok(
  (select value #>> '{coverage,complete}' from c5c_values
    where key = 'complete-page-v2') = 'true'
    and (select value #>> '{coverage,expectedNoteCount}' from c5c_values
      where key = 'complete-page-v2') = '1'
    and (select value #>> '{coverage,indexedNoteCount}' from c5c_values
      where key = 'complete-page-v2') = '1'
    and jsonb_array_length((select value -> 'keys' from c5c_values
      where key = 'complete-page-v2')) = 1,
  'verified list exposes exact coverage and deduplicated page key records'
);

reset role;
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_74000000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'C.5c page fixture', 'encrypted page fixture', '{}',
  1, 'ai_assisted', '2026-08-31 16:01:00+00', '2026-08-31 16:01:00+00',
  pg_temp.content_envelope(
    'note_74000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'c5c.ai.object.v1'
  ),
  'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.enqueue_note_index_job(
  '22222222-2222-4222-8222-222222222222',
  'note_74000000000000000000000002',
  'igen_74000000000000000000000001', 1
);
insert into c5c_values (key, value) values (
  'claim-page', public.claim_note_index_jobs('c5c-page-worker', 1, 60)
);
select public.commit_note_rag_index(
  (select value #>> '{jobs,0,jobId}' from c5c_values where key = 'claim-page'),
  (select (value #>> '{jobs,0,leaseToken}')::uuid from c5c_values
    where key = 'claim-page'),
  (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-page'),
  pg_temp.content_envelope(
    (select value #>> '{jobs,0,indexResourceId}' from c5c_values where key = 'claim-page'),
    '22222222-2222-4222-8222-222222222222', 1,
    'note_rag_index', 'c5c.ai.object.v1'
  ),
  'c5c.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
);
reset role;
insert into c5c_values (key, value)
select 'page-token', jsonb_build_object('token', revision_token)
from public.rag_index_generations
where id = 'igen_74000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
reset role;
set local role unfiled_rag_verifier;
select public.verify_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_74000000000000000000000001',
  (select (value ->> 'token')::bigint from c5c_values where key = 'page-token'),
  pg_temp.generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_74000000000000000000000001',
    (select (value ->> 'token')::bigint from c5c_values where key = 'page-token')
  )
);
reset role;
select ok(
  exists (
    select 1
    from public.rag_index_generation_verifications as verification
    where verification.user_id = '22222222-2222-4222-8222-222222222222'
      and verification.generation_id = 'igen_74000000000000000000000001'
      and verification.attestation_digest
        = private.request_hash(verification.attestation)
      and verification.attestation ->> 'ownerId'
        = '22222222-2222-4222-8222-222222222222'
      and verification.attestation ->> 'generationId'
        = 'igen_74000000000000000000000001'
      and verification.attestation ->> 'revisionToken'
        = (select value ->> 'token' from c5c_values where key = 'page-token')
      and verification.attestation ->> 'embeddingModelId'
        = 'c5c-embedding-v1'
      and verification.attestation ->> 'embeddingDimensions' = '8'
      and verification.attestation ->> 'envelopeSchemaVersion' = '1'
      and verification.attestation ->> 'expectedNoteCount' = '2'
      and verification.attestation ->> 'indexedNoteCount' = '2'
      and verification.attestation ->> 'entryCount' = '2'
      and private.jsonb_has_exact_keys(
        verification.attestation -> 'orderedDigestEntries',
        array[
          'rowDigestChain', 'envelopeDigestChain',
          'keyReferenceDigestChain'
        ]
      )
      and verification.attestation
        #>> '{orderedDigestEntries,rowDigestChain}' ~ '^[0-9a-f]{64}$'
      and verification.attestation
        #>> '{orderedDigestEntries,envelopeDigestChain}' ~ '^[0-9a-f]{64}$'
      and verification.attestation
        #>> '{orderedDigestEntries,keyReferenceDigestChain}' ~ '^[0-9a-f]{64}$'
      and strpos(lower(pg_get_functiondef(
        'private.rag_generation_attestation(uuid,text,bigint)'::regprocedure
      )), 'order by index_value.id') > 0
  ),
  'the canonical attestation binds owner, generation contract, count, and ordered row/envelope/key digests'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5c_values (key, value) values (
  'page-1', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 1, 262160
  )
);
insert into c5c_values (key, value) values (
  'page-2', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222',
    (select value #> '{page,nextCursor}' from c5c_values where key = 'page-1'),
    1, 262160
  )
);
select ok(
  (select value #>> '{page,hasMore}' from c5c_values where key = 'page-1') = 'true'
    and (select value #>> '{page,returnedCount}' from c5c_values
      where key = 'page-1') = '1'
    and (select value #>> '{page,hasMore}' from c5c_values where key = 'page-2') = 'false'
    and (select value #>> '{page,returnedCount}' from c5c_values
      where key = 'page-2') = '1'
    and (select value #>> '{generation,revisionToken}' from c5c_values
      where key = 'page-1') = (select value #>> '{generation,revisionToken}'
        from c5c_values where key = 'page-2'),
  'structured pages stay pinned to one generation revision token'
);

reset role;
update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'c5c.ai.object.v1'
  )
where id = 'note_74000000000000000000000002';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  format(
    'select public.list_active_note_rag_index(%L,%L::jsonb,1,262160)',
    '22222222-2222-4222-8222-222222222222',
    (select (value #> '{page,nextCursor}')::text from c5c_values where key = 'page-1')
  ),
  'P0001', 'stale_rag_cursor',
  'a note revision change invalidates an in-flight page cursor'
);

reset role;
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at
)
select
  'note_' || lpad((74000000000000000000000100::numeric + item)::text, 26, '0'),
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'repair fixture ' || item, 'repair fixture body', '{}',
  1, 'ai_assisted',
  '2026-08-31 17:00:00+00'::timestamptz + make_interval(secs => item),
  '2026-08-31 17:00:00+00'::timestamptz + make_interval(secs => item)
from generate_series(1, 51) as series(item);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $enqueue_repair$
declare
  item integer;
  note_value text;
begin
  for item in 1..51
  loop
    note_value := 'note_' || lpad(
      (74000000000000000000000100::numeric + item)::text, 26, '0'
    );
    perform public.enqueue_note_index_job(
      '22222222-2222-4222-8222-222222222222', note_value,
      'igen_74000000000000000000000001', 1
    );
  end loop;
end;
$enqueue_repair$;
insert into c5c_values (key, value) values (
  'repair-page', public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50, 1048576
  )
);
select ok(
  (select value #>> '{coverage,repairCount}' from c5c_values
    where key = 'repair-page') = '51'
    and (select value #>> '{coverage,repairLimitExceeded}' from c5c_values
      where key = 'repair-page') = 'true'
    and jsonb_array_length((select value #> '{coverage,repairCandidates}'
      from c5c_values where key = 'repair-page')) = 50
    and (select value #>> '{coverage,complete}' from c5c_values
      where key = 'repair-page') = 'false',
  'repair coverage uses sentinel 51 and returns at most 50 actionable references'
);
select throws_ok(
  $$select public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50, 262159
  )$$,
  '22023', 'validation_failed',
  'ciphertext pages reject a byte budget below one maximum row'
);

reset role;
select ok(
  strpos(lower(pg_get_functiondef(
    'private.stable_note_rag_resource_id(uuid,text,text)'::regprocedure
  )), 'pg_advisory_xact_lock') > 0
    and strpos(lower(pg_get_functiondef(
      'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)'::regprocedure
    )), 'target_reservation_lease_token') > 0
    and strpos(lower(pg_get_functiondef(
      'public.heartbeat_note_index_job(text,uuid,integer)'::regprocedure
    )), 'content_key.state in (''active'', ''retired'')') > 0,
  'resource, reservation, and disclosure race guards are explicit in SQL'
);

select * from finish();
rollback;
