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
  p_ciphertext_length integer default 64
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
  select private.verify_rag_index_generation_impl(
    p_owner_id, p_generation_id, p_expected_revision_token, p_attestation
  );
$$;

create temporary table c5_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on table c5_values to service_role, unfiled_rag_verifier;
grant select, insert, update on table c5_values to unfiled_index_worker;
grant execute on function pg_temp.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) to unfiled_rag_verifier;

select ok(
  private.valid_content_envelope(
    pg_temp.content_envelope(
      'kind-fixture:' || content_kind,
      '11111111-1111-4111-8111-111111111111', 1,
      content_kind, 'ai.object.v1'
    ),
    '11111111-1111-4111-8111-111111111111',
    'kind-fixture:' || content_kind, 1, content_kind, 'ai.object.v1'
  )
  and not private.valid_content_envelope(
    pg_temp.content_envelope(
      'kind-fixture:' || content_kind,
      '11111111-1111-4111-8111-111111111111', 1,
      content_kind, 'ai.object.v1'
    ) || jsonb_build_object('unexpected', true),
    '11111111-1111-4111-8111-111111111111',
    'kind-fixture:' || content_kind, 1, content_kind, 'ai.object.v1'
  ),
  format('the canonical %s envelope kind is accepted with exact shape only', content_kind)
)
from unnest(array[
  'space_display',
  'tag_display',
  'note_content',
  'note_revision',
  'organization_decision',
  'note_mutation',
  'generated_block',
  'review_item',
  'routing_rule',
  'organization_mutation_attempt',
  'idempotency_response',
  'capture_receipt',
  'note_rag_index'
]) as canonical_kind(content_kind);

select has_table('public', 'user_content_keys', 'owner-bound content key records exist');
select has_table(
  'public', 'content_encryption_rollouts',
  'per-owner encryption rollout state exists'
);
select has_table(
  'public', 'rag_index_generations',
  'per-owner RAG generation metadata exists'
);
select has_table(
  'public', 'note_rag_index',
  'encrypted per-note RAG documents exist'
);
select has_table(
  'public', 'note_index_jobs',
  'content-free index job metadata exists'
);

select ok(
  not rolcanlogin
    and not rolinherit
    and not rolbypassrls
    and not rolsuper
    and not rolcreatedb
    and not rolcreaterole
    and not rolreplication,
  'the dedicated index worker starts NOLOGIN/NOINHERIT/NOBYPASSRLS and unprivileged'
)
from pg_roles
where rolname = 'unfiled_index_worker';
select ok(
  not pg_has_role('unfiled_index_worker', 'service_role', 'MEMBER')
    and not exists (
      select 1
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
      join pg_roles as grantor on grantor.oid = membership.grantor
      where (
        granted.rolname = 'unfiled_index_worker'
        or member.rolname = 'unfiled_index_worker'
      )
        and not (
          granted.rolname = 'unfiled_index_worker'
          and member.rolname = 'postgres'
          and grantor.rolname = 'supabase_admin'
          and membership.admin_option
          and not membership.inherit_option
          and not membership.set_option
        )
    ),
  'the index worker has no workload membership beyond the inert platform admin edge'
);
select ok(
  has_schema_privilege('unfiled_index_worker', 'public', 'USAGE')
    and not has_schema_privilege('unfiled_index_worker', 'public', 'CREATE')
    and not has_schema_privilege('unfiled_index_worker', 'private', 'USAGE')
    and not has_schema_privilege('unfiled_index_worker', 'private', 'CREATE'),
  'the worker may resolve public RPCs but cannot create objects or enter private'
);
select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as relation_schema
      on relation_schema.oid = relation.relnamespace
    where relation_schema.nspname in ('public', 'private')
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_table_privilege('unfiled_index_worker', relation.oid, 'SELECT')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'INSERT')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'UPDATE')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'DELETE')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'TRUNCATE')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'REFERENCES')
        or has_table_privilege('unfiled_index_worker', relation.oid, 'TRIGGER')
      )
  ),
  'the index worker has no direct public/private table or view privileges'
);
select ok(
  not exists (
    select 1
    from pg_class as sequence_relation
    join pg_namespace as sequence_schema
      on sequence_schema.oid = sequence_relation.relnamespace
    where sequence_schema.nspname in ('public', 'private')
      and sequence_relation.relkind = 'S'
      and (
        has_sequence_privilege(
          'unfiled_index_worker', sequence_relation.oid, 'USAGE'
        )
        or has_sequence_privilege(
          'unfiled_index_worker', sequence_relation.oid, 'SELECT'
        )
        or has_sequence_privilege(
          'unfiled_index_worker', sequence_relation.oid, 'UPDATE'
        )
      )
  ),
  'the index worker has no direct public/private sequence privileges'
);

select has_column(
  'public', relation_name, envelope_column,
  format('%s has its expand-only %s', relation_name, envelope_column)
)
from (values
  ('spaces', 'display_envelope'),
  ('tags', 'display_envelope'),
  ('notes', 'content_envelope'),
  ('note_revisions', 'snapshot_envelope'),
  ('organization_decisions', 'decision_envelope'),
  ('note_mutations', 'mutation_envelope'),
  ('generated_blocks', 'content_envelope'),
  ('review_items', 'review_envelope'),
  ('routing_rules', 'condition_envelope'),
  ('organization_mutation_attempts', 'attempt_envelope'),
  ('api_idempotency_records', 'response_envelope'),
  ('capture_receipts', 'receipt_envelope')
) as expanded(relation_name, envelope_column);

select ok(
  to_regclass('public.note_chunks') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'notes' and column_name = 'title'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'notes'
        and column_name = 'body_markdown'
    ),
  'C.5a is expand-only and does not contract legacy plaintext paths'
);

select ok(
  (
    select count(*) = 5
      and bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
    from pg_class as relation
    join pg_namespace as relation_schema
      on relation_schema.oid = relation.relnamespace
    where relation_schema.nspname = 'public'
      and relation.relname = any(array[
        'user_content_keys', 'content_encryption_rollouts',
        'rag_index_generations', 'note_rag_index', 'note_index_jobs'
      ])
  ),
  'every new public relation has enabled and forced RLS'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = any(array[
        'user_content_keys', 'content_encryption_rollouts',
        'rag_index_generations', 'note_rag_index', 'note_index_jobs'
      ])
  ),
  0::bigint,
  'new custody and retrieval relations have no client policy a future grant can reactivate'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('anon', table_name, privilege_name)
      and not has_table_privilege('authenticated', table_name, privilege_name)
    )
    from unnest(array[
      'public.user_content_keys', 'public.content_encryption_rollouts',
      'public.rag_index_generations', 'public.note_rag_index',
      'public.note_index_jobs'
    ]) as relation(table_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      as privilege(privilege_name)
  ),
  'anonymous and authenticated roles have no direct privilege on any new relation'
);

select ok(
  has_table_privilege('service_role', 'public.user_content_keys', 'SELECT')
    and not has_table_privilege('service_role', 'public.user_content_keys', 'INSERT')
    and not has_table_privilege('service_role', 'public.user_content_keys', 'UPDATE')
    and not has_table_privilege('service_role', 'public.user_content_keys', 'DELETE')
    and not has_table_privilege(
      'service_role', 'public.rag_index_generations', 'SELECT'
    )
    and not has_table_privilege('service_role', 'public.note_rag_index', 'SELECT')
    and not has_table_privilege('service_role', 'public.note_index_jobs', 'SELECT'),
  'service access is least-privilege: opaque key reads plus capability RPCs, not direct writes or RAG reads'
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_content_keys'
      and column_name ~ '(^|_)(raw|plaintext|plain_text|secret)(_.*|$)'
  )
  and (
    select data_type = 'bytea'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_content_keys'
      and column_name = 'wrapped_intermediate_key'
  ),
  'key records contain bounded KMS ciphertext and no raw/plaintext key column'
);

select ok(
  not exists (
    select 1
    from pg_attribute as attribute
    join pg_class as relation on relation.oid = attribute.attrelid
    join pg_namespace as relation_schema on relation_schema.oid = relation.relnamespace
    join pg_type as column_type on column_type.oid = attribute.atttypid
    where relation_schema.nspname = 'public'
      and relation.relname = 'note_rag_index'
      and attribute.attnum > 0
      and not attribute.attisdropped
      and (
        column_type.typname in ('vector', 'tsvector', 'float4', 'float8')
        or attribute.attname ~ '(^|_)(embedding|lexical|snippet|token|content)($|_)'
      )
  ),
  'the RAG table has no plaintext vector, float, token, snippet, or content column'
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'note_index_jobs'
      and column_name ~ '(content|envelope|embedding|snippet|lexical|payload|query)'
  ),
  'index jobs contain operational references only'
);

select ok(
  not has_function_privilege('anon', signature, 'EXECUTE')
    and not has_function_privilege('authenticated', signature, 'EXECUTE'),
  format('%s rejects anonymous and authenticated execution', signature)
)
from unnest(array[
  'public.register_user_content_key(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,bytea)',
  'public.activate_user_content_key(uuid,text)',
  'public.rewrap_user_content_key(uuid,text,text,integer,text,bytea)',
  'public.create_rag_index_generation(uuid,text,text,integer)',
  'public.enqueue_note_index_job(uuid,text,text,integer)',
  'public.claim_note_index_jobs(text,integer,integer)',
  'public.heartbeat_note_index_job(text,uuid,integer)',
  'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)',
  'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_note_index_jobs(integer)',
  'public.activate_rag_index_generation(uuid,text,bigint)',
  'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'
]) as protected(signature);

select ok(
  has_function_privilege('service_role', signature, 'EXECUTE'),
  format('%s remains executable by the interactive/admin service capability', signature)
)
from unnest(array[
  'public.register_user_content_key(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,bytea)',
  'public.activate_user_content_key(uuid,text)',
  'public.rewrap_user_content_key(uuid,text,text,integer,text,bytea)',
  'public.create_rag_index_generation(uuid,text,text,integer)',
  'public.enqueue_note_index_job(uuid,text,text,integer)',
  'public.claim_note_index_jobs(text,integer,integer)',
  'public.heartbeat_note_index_job(text,uuid,integer)',
  'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)',
  'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_note_index_jobs(integer)',
  'public.activate_rag_index_generation(uuid,text,bigint)',
  'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'
]) as service_capability(signature);

select ok(
  has_function_privilege('unfiled_index_worker', signature, 'EXECUTE'),
  format('%s is in the dedicated worker runtime allowlist', signature)
)
from unnest(array[
  'public.claim_note_index_jobs(text,integer,integer)',
  'public.heartbeat_note_index_job(text,uuid,integer)',
  'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)',
  'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_note_index_jobs(integer)',
  'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'
]) as worker_capability(signature);
select ok(
  not exists (
    select 1
    from pg_proc as function_entry
    join pg_namespace as function_schema
      on function_schema.oid = function_entry.pronamespace
    where function_schema.nspname = 'public'
      and has_function_privilege(
        'unfiled_index_worker', function_entry.oid, 'EXECUTE'
      )
      and function_entry.oid <> all(array[
        'public.claim_note_index_jobs(text,integer,integer)'::regprocedure::oid,
        'public.heartbeat_note_index_job(text,uuid,integer)'::regprocedure::oid,
        'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)'::regprocedure::oid,
        'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)'::regprocedure::oid,
        'public.recover_stale_note_index_jobs(integer)'::regprocedure::oid,
        'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'::regprocedure::oid
      ])
  ),
  'the dedicated worker has no executable public function outside its six-RPC allowlist'
);
select ok(
  not has_function_privilege('unfiled_index_worker', signature, 'EXECUTE'),
  format('%s remains outside the dedicated worker administrative boundary', signature)
)
from unnest(array[
  'public.register_user_content_key(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,bytea)',
  'public.activate_user_content_key(uuid,text)',
  'public.rewrap_user_content_key(uuid,text,text,integer,text,bytea)',
  'public.create_rag_index_generation(uuid,text,text,integer)',
  'public.enqueue_note_index_job(uuid,text,text,integer)',
  'public.activate_rag_index_generation(uuid,text,bigint)'
]) as worker_denial(signature);

select ok(
  strpos(
    lower(pg_get_functiondef(signature::regprocedure)),
    'session_user <> ''unfiled_index_worker'''
  ) > 0,
  format('%s requires the exact dedicated connection identity', signature)
)
from unnest(array[
  'public.claim_note_index_jobs(text,integer,integer)',
  'public.heartbeat_note_index_job(text,uuid,integer)',
  'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)',
  'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_note_index_jobs(integer)',
  'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'
]) as worker_connection_guard(signature);

-- SET ROLE is deliberately insufficient: SECURITY DEFINER checks the original
-- connection identity. The temporary membership exists only inside this
-- rollback-only test because the NOLOGIN production role is intentionally not
-- impersonable by the non-superuser pgTAP connection.
reset role;
grant unfiled_index_worker to postgres;
set local role unfiled_index_worker;
insert into c5_values (key, value)
values (
  'worker-set-role-probe',
  jsonb_build_object(
    'sqlstate', pg_temp.caught_sqlstate(
      'select public.recover_stale_note_index_jobs(1)'
    )
  )
);
insert into c5_values (key, value)
values (
  'worker-admin-denial-probe',
  jsonb_build_object(
    'sqlstate', pg_temp.caught_sqlstate(
      $worker_denial$
        select public.rewrap_user_content_key(
          '11111111-1111-4111-8111-111111111111',
          'ai.object.v1',
          'arn:aws:kms:us-west-2:123456789012:key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          0,
          'arn:aws:kms:us-west-2:123456789012:key/18181818-1818-4818-8818-181818181818',
          decode(repeat('18', 32), 'hex')
        )
      $worker_denial$
    )
  )
);
reset role;
revoke unfiled_index_worker from postgres;
select is(
  (select value ->> 'sqlstate' from c5_values where key = 'worker-set-role-probe'),
  '42501',
  'role membership or SET ROLE cannot impersonate the dedicated worker connection'
);
select is(
  (
    select value ->> 'sqlstate'
    from c5_values where key = 'worker-admin-denial-probe'
  ),
  '42501',
  'the dedicated worker role is denied the interactive root-rewrap RPC'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select * from public.user_content_keys$$,
  '42501',
  'permission denied for table user_content_keys',
  'even an owning authenticated user cannot read wrapped key records'
);
select throws_ok(
  $$select public.register_user_content_key(
    '22222222-2222-4222-8222-222222222222',
    'forged-owner-key', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decode(repeat('ab', 32), 'hex')
  )$$,
  '42501',
  'permission denied for function register_user_content_key',
  'clients cannot supply any owner to key registration'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into c5_values (key, value)
values (
  'register-a-object',
  public.register_user_content_key(
    '11111111-1111-4111-8111-111111111111',
    'ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decode(repeat('ab', 32), 'hex')
  )
);
select is(
  (select value ->> 'state' from c5_values where key = 'register-a-object'),
  'pending',
  'new key material is persisted pending before atomic activation'
);
select ok(
  not ((select value from c5_values where key = 'register-a-object') ? 'wrappedIntermediateKey')
    and not ((select value from c5_values where key = 'register-a-object') ? 'kmsKeyId'),
  'key registration never returns KMS ciphertext or root identifiers'
);
select is(
  public.activate_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v1'
  ) ->> 'state',
  'active',
  'pending key activation succeeds through the reviewed capability'
);
select is(
  public.activate_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v1'
  ) ->> 'replayed',
  'true',
  'key activation is replay-safe'
);

select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  decode(repeat('bc', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'ai.mac.v1'
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  decode(repeat('cd', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'other.ai.object.v1'
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'other.private.object.v1', 'private_manual', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  decode(repeat('de', 32), 'hex')
);

select throws_ok(
  $$select public.register_user_content_key(
    '11111111-1111-4111-8111-111111111111',
    'ai.object.v3', 'ai_assisted', 'object_wrap', 3,
    'arn:aws:kms:us-west-2:123456789012:key/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    decode(repeat('ef', 32), 'hex')
  )$$,
  '22023',
  'invalid_key_version',
  'key versions must advance monotonically without gaps'
);

reset role;
set constraints all immediate;
select is(
  (
    select kms_encryption_context
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v1'
  ),
  jsonb_build_object(
    'UnfiledOwnerId', '11111111-1111-4111-8111-111111111111',
    'UnfiledKeyClass', 'ai_assisted',
    'UnfiledKeyPurpose', 'object_wrap',
    'UnfiledKeyRecordId', 'ai.object.v1'
  ),
  'KMS context is generated from the exact authoritative four-field binding'
);
select is(
  (
    select state::text
    from public.content_encryption_rollouts
    where user_id = '11111111-1111-4111-8111-111111111111'
  ),
  'expanded',
  'key registration starts the owner in the expand-only rollout state'
);

update public.user_content_keys
set state = 'revoked', revoked_at = now()
where user_id = '22222222-2222-4222-8222-222222222222'
  and key_id = 'other.private.object.v1';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.activate_user_content_key(
    '22222222-2222-4222-8222-222222222222', 'other.private.object.v1'
  )$$,
  'P0001',
  'invalid_key_state',
  'a revoked key can never become active again'
);

-- C.5b intentionally removes service-role direct table access. These are
-- fixture-only constraint probes; capability assertions above remain under
-- service_role and all application behavior continues to use RPCs.
reset role;
update public.notes
set
  content_envelope = pg_temp.content_envelope(
    id, user_id, current_revision, 'note_content', 'ai.object.v1'
  ),
  content_key_id = 'ai.object.v1',
  content_key_class = 'ai_assisted',
  content_key_purpose = 'object_wrap',
  content_key_version = 1
where id = 'note_00000000000000000000000001'
  and user_id = '11111111-1111-4111-8111-111111111111';
select ok(
  (
    select content_envelope is not null
    from public.notes
    where id = 'note_00000000000000000000000001'
  ),
  'a correctly owner/resource/revision/kind/key-bound note envelope is accepted'
);

select is(
  pg_temp.caught_sqlstate($statement$
    update public.notes
    set
      content_envelope = pg_temp.content_envelope(
        id, user_id, current_revision + 1, 'note_content', 'ai.object.v1'
      ),
      content_key_id = 'ai.object.v1',
      content_key_class = 'ai_assisted',
      content_key_purpose = 'object_wrap',
      content_key_version = 1
    where id = 'note_00000000000000000000000002'
  $statement$),
  '23514',
  'an envelope bound to the wrong authoritative revision fails closed'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.notes
    set
      content_envelope = pg_temp.content_envelope(
        id, user_id, current_revision, 'note_revision', 'ai.object.v1'
      ),
      content_key_id = 'ai.object.v1',
      content_key_class = 'ai_assisted',
      content_key_purpose = 'object_wrap',
      content_key_version = 1
    where id = 'note_00000000000000000000000002'
  $statement$),
  '23514',
  'an envelope bound to the wrong content kind fails closed'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.notes
    set
      content_envelope = pg_temp.content_envelope(
        id, user_id, current_revision, 'note_content', 'other.ai.object.v1'
      ),
      content_key_id = 'other.ai.object.v1',
      content_key_class = 'ai_assisted',
      content_key_purpose = 'object_wrap',
      content_key_version = 1
    where id = 'note_00000000000000000000000002'
  $statement$),
  '23503',
  'a cross-owner key reference is rejected even when envelope context is otherwise valid'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.notes
    set
      content_envelope = pg_temp.content_envelope(
        id, user_id, current_revision, 'note_content', 'ai.object.v1'
      ),
      content_key_id = 'ai.object.v1',
      content_key_class = 'ai_assisted',
      content_key_purpose = 'object_wrap',
      content_key_version = 1
    where id = 'note_00000000000000000000000004'
  $statement$),
  '23514',
  'a private-manual current note cannot use an AI-assisted content key'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.spaces
    set
      display_mac = repeat('a', 64),
      display_mac_key_id = 'ai.object.v1',
      display_mac_key_class = 'ai_assisted',
      display_mac_key_purpose = 'object_wrap',
      display_mac_key_version = 1
    where id = 'spc_00000000000000000000000001'
  $statement$),
  '23514',
  'a keyed MAC field cannot reuse an object-wrapping key purpose'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'ai.object.v2', 'ai_assisted', 'object_wrap', 2,
  'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
  decode(repeat('fa', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'ai.object.v2'
);

reset role;
select is(
  (
    select count(*)
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and state = 'active'
  ),
  1::bigint,
  'rotation preserves exactly one active key per owner/class/purpose'
);
select is(
  (
    select state::text
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v1'
  ),
  'retired',
  'activating the monotonic successor retires the prior active key'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set state = 'active', retired_at = null
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v1'
  $statement$),
  '23514',
  'a retired key cannot transition back to active'
);
select is(
  pg_temp.caught_sqlstate($statement$
    insert into public.user_content_keys (
      user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
      wrapped_intermediate_key, state, created_at, activated_at
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'private.mac.invalid-time', 'private_manual', 'content_mac', 1,
      'arn:aws:kms:us-west-2:123456789012:key/abababab-abab-4bab-8bab-abababababab',
      decode(repeat('ac', 32), 'hex'), 'active',
      '2026-08-31 01:00:00+00', '2026-08-31 00:59:59+00'
    )
  $statement$),
  '23514',
  'key lifecycle timestamps cannot precede key creation or activation'
);
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, created_at, activated_at, retired_at
) values (
  '22222222-2222-4222-8222-222222222222',
  'private.mac.rewrap-time', 'private_manual', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/14141414-1414-4414-8414-141414141414',
  decode(repeat('14', 32), 'hex'), 'retired',
  '2026-08-30 20:00:00+00', '2026-08-30 21:00:00+00',
  '2026-08-30 22:00:00+00'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set
      previous_kms_key_id = kms_key_id,
      kms_key_id = 'arn:aws:kms:us-west-2:123456789012:key/15151515-1515-4515-8515-151515151515',
      wrapped_intermediate_key = decode(repeat('15', 32), 'hex'),
      root_rewrap_count = root_rewrap_count + 1,
      last_root_rewrapped_at = '2026-08-30 21:30:00+00'
    where user_id = '22222222-2222-4222-8222-222222222222'
      and key_id = 'private.mac.rewrap-time'
  $statement$),
  '23514',
  'a retired-key rewrap time cannot precede its authoritative retirement time'
);
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, created_at
) values (
  '22222222-2222-4222-8222-222222222222',
  'private.mac.pending-rewrap', 'private_manual', 'content_mac', 2,
  'arn:aws:kms:us-west-2:123456789012:key/16161616-1616-4616-8616-161616161616',
  decode(repeat('16', 32), 'hex'), 'pending', '2026-08-30 20:00:00+00'
);
update public.user_content_keys
set
  previous_kms_key_id = kms_key_id,
  kms_key_id = 'arn:aws:kms:us-west-2:123456789012:key/17171717-1717-4717-8717-171717171717',
  wrapped_intermediate_key = decode(repeat('17', 32), 'hex'),
  root_rewrap_count = root_rewrap_count + 1,
  last_root_rewrapped_at = '2026-08-30 20:01:00+00'
where user_id = '22222222-2222-4222-8222-222222222222'
  and key_id = 'private.mac.pending-rewrap';
select is(
  (
    select state::text || ':' || root_rewrap_count::text || ':'
      || (activated_at is null)::text
    from public.user_content_keys
    where user_id = '22222222-2222-4222-8222-222222222222'
      and key_id = 'private.mac.pending-rewrap'
  ),
  'pending:1:true',
  'a pending key may be root-rewrapped before its later lifecycle promotion'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set activated_at = activated_at + interval '1 second'
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'an activation timestamp is immutable after it is recorded'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set retired_at = retired_at + interval '1 second'
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v1'
  $statement$),
  '23514',
  'a retirement timestamp is immutable after it is recorded'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set revoked_at = revoked_at + interval '1 second'
    where user_id = '22222222-2222-4222-8222-222222222222'
      and key_id = 'other.private.object.v1'
  $statement$),
  '23514',
  'a revocation timestamp is immutable after it is recorded'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set wrap_operation_limit = wrap_operation_limit - 1
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'the per-key wrap operation limit is immutable custody policy'
);

update public.user_content_keys
set wrap_operations = 1
where user_id = '11111111-1111-4111-8111-111111111111'
  and key_id = 'ai.object.v2';
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set wrap_operations = 0
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'the wrap operation counter cannot move backward'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set root_rewrap_count = root_rewrap_count + 1,
        previous_kms_key_id = kms_key_id,
        last_root_rewrapped_at = now() + interval '1 minute'
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'root rewrap audit metadata cannot advance without replacing the root ciphertext'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set wrapped_intermediate_key = decode(repeat('fb', 32), 'hex')
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'wrapped intermediate material cannot change outside an atomic root rewrap'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    decode(repeat('12', 32), 'hex')
  )$$,
  '22023',
  'validation_failed',
  'a root rewrap requires a distinct destination ARN'
);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0, 'alias/not-a-full-key-arn', decode(repeat('12', 32), 'hex')
  )$$,
  '22023',
  'validation_failed',
  'a root rewrap rejects a destination that is not a full KMS key ARN'
);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    ''::bytea
  )$$,
  '22023',
  'validation_failed',
  'a root rewrap rejects empty KMS ciphertext'
);
insert into c5_values (key, value)
values (
  'root-rewrap-cas',
  public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    decode(repeat('12', 32), 'hex')
  )
);
select ok(
  (select value ->> 'replayed' from c5_values where key = 'root-rewrap-cas') = 'false'
    and (select value ->> 'rootRewrapCount' from c5_values where key = 'root-rewrap-cas') = '1'
    and not ((select value from c5_values where key = 'root-rewrap-cas') ? 'kmsKeyId')
    and not (
      (select value from c5_values where key = 'root-rewrap-cas')
        ? 'wrappedIntermediateKey'
    ),
  'the rewrap CAS returns status without KMS identifiers or wrapped key material'
);
select is(
  public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    decode(repeat('12', 32), 'hex')
  ) ->> 'replayed',
  'true',
  'an exact already-applied root rewrap replays without another state change'
);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    decode(repeat('13', 32), 'hex')
  )$$,
  'P0001',
  'invalid_idempotency_key',
  'a replay with different wrapped ciphertext is rejected'
);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '11111111-1111-4111-8111-111111111111', 'ai.object.v2',
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/13131313-1313-4313-8313-131313131313',
    decode(repeat('13', 32), 'hex')
  )$$,
  'P0001',
  'stale_revision',
  'a stale expected root-rewrap counter loses the compare-and-swap'
);
select throws_ok(
  $$select public.rewrap_user_content_key(
    '22222222-2222-4222-8222-222222222222', 'other.private.object.v1',
    'arn:aws:kms:us-west-2:123456789012:key/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    0,
    'arn:aws:kms:us-west-2:123456789012:key/18181818-1818-4818-8818-181818181818',
    decode(repeat('18', 32), 'hex')
  )$$,
  'P0001',
  'invalid_key_state',
  'a revoked intermediate key cannot be root-rewrapped'
);
select ok(
  strpos(
    lower(pg_get_functiondef(
      'public.rewrap_user_content_key(uuid,text,text,integer,text,bytea)'::regprocedure
    )),
    'for update of content_key;'
  ) > 0,
  'the root-rewrap compare-and-swap locks the exact owner/key row'
);

reset role;
select is(
  (
    select concat_ws(
      ':', root_rewrap_count, previous_kms_key_id,
      kms_key_id, encode(wrapped_intermediate_key, 'hex')
    )
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  ),
  concat_ws(
    ':', 1,
    'arn:aws:kms:us-west-2:123456789012:key/ffffffff-ffff-4fff-8fff-ffffffffffff',
    'arn:aws:kms:us-west-2:123456789012:key/12121212-1212-4212-8212-121212121212',
    repeat('12', 32)
  ),
  'an atomic root rewrap advances source, destination, ciphertext, count, and time together'
);
select is(
  (
    select last_root_rewrapped_at = now()
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  ),
  true,
  'the database, not the caller, stamps the root rewrap time'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set
      previous_kms_key_id = kms_key_id,
      kms_key_id = 'arn:aws:kms:us-west-2:123456789012:key/13131313-1313-4313-8313-131313131313',
      wrapped_intermediate_key = decode(repeat('13', 32), 'hex'),
      root_rewrap_count = root_rewrap_count + 1,
      last_root_rewrapped_at = last_root_rewrapped_at - interval '1 microsecond'
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'a subsequent root rewrap cannot move its audit timestamp backward'
);
select is(
  pg_temp.caught_sqlstate($statement$
    update public.user_content_keys
    set last_root_rewrapped_at = last_root_rewrapped_at + interval '1 second'
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'ai.object.v2'
  $statement$),
  '23514',
  'a root rewrap timestamp cannot be edited independently after persistence'
);

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_72000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic', 'C.5 encrypted index fixture', 'synthetic index body', '{}',
  1, 'ai_assisted', '2026-08-30 23:30:00+00', '2026-08-30 23:30:00+00',
  pg_temp.content_envelope(
    'note_72000000000000000000000009',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'other.ai.object.v1', 80
  ),
  'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5_values (key, value)
values (
  'generation',
  public.create_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_72000000000000000000000001',
    'synthetic-embedding-v1', 8
  )
);
select is(
  (select value ->> 'expectedNoteCount' from c5_values where key = 'generation'),
  '1',
  'generation coverage counts only current non-deleted AI-assisted notes'
);

insert into c5_values (key, value)
values (
  'enqueue',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000009',
    'igen_72000000000000000000000001', 1
  )
);
insert into c5_values (key, value)
values (
  'enqueue-replay',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000009',
    'igen_72000000000000000000000001', 1
  )
);
select ok(
  (select value ->> 'jobId' from c5_values where key = 'enqueue')
    = (select value ->> 'jobId' from c5_values where key = 'enqueue-replay')
    and (select value ->> 'replayed' from c5_values where key = 'enqueue-replay') = 'true',
  'natural note/generation/revision identity makes enqueue replay deterministic'
);

select throws_ok(
  $$select public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_00000000000000000000000009',
    'igen_72000000000000000000000001', 1
  )$$,
  '42501',
  'ineligible_note_index_job',
  'private-manual notes can never be enqueued for RAG'
);
select throws_ok(
  $$select public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_00000000000000000000000001',
    'igen_72000000000000000000000001', 2
  )$$,
  '42501',
  'ineligible_note_index_job',
  'cross-owner notes are hidden behind the same ineligible result'
);

select throws_ok(
  $$select public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_72000000000000000000000001', 1
  )$$,
  'P0001',
  'generation_not_verified',
  'a generation cannot activate before strict decryption verification'
);

insert into c5_values (key, value)
values ('claim', public.claim_note_index_jobs('c5-index-worker', 1, 60));
select is(
  jsonb_array_length((select value -> 'jobs' from c5_values where key = 'claim')),
  1,
  'the worker claims one eligible content-free job'
);
select is(
  public.heartbeat_note_index_job(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5_values where key = 'claim'),
    60
  ) ->> 'jobId',
  (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
  'the lease capability heartbeats its exact job'
);
select throws_ok(
  format(
    'select public.heartbeat_note_index_job(%L, %L::uuid, 60)',
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    '88888888-8888-4888-8888-888888888888'
  ),
  '42501',
  'invalid_or_expired_lease',
  'heartbeat rejects a forged lease capability'
);
select is(
  jsonb_array_length(public.claim_note_index_jobs('competing-worker', 1, 60) -> 'jobs'),
  0,
  'SKIP LOCKED leasing prevents a competing claim'
);

select throws_ok(
  format(
    'select public.commit_note_rag_index(%L, %L::uuid, %L, %L::jsonb, %L, %L, %L, 1, 60)',
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    '99999999-9999-4999-8999-999999999999',
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    )::text,
    'other.ai.object.v1', 'ai_assisted', 'object_wrap'
  ),
  '42501',
  'invalid_or_expired_lease',
  'an incorrect lease capability cannot commit an index document'
);
select throws_ok(
  format(
    'select public.commit_note_rag_index(%L, %L::uuid, %L, %L::jsonb, %L, %L, %L, 1, 60)',
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    (select value #>> '{jobs,0,leaseToken}' from c5_values where key = 'claim'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
      '11111111-1111-4111-8111-111111111111', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    )::text,
    'other.ai.object.v1', 'ai_assisted', 'object_wrap'
  ),
  '22023',
  'validation_failed',
  'an index envelope bound to the wrong owner is rejected before persistence'
);

insert into c5_values (key, value)
values (
  'commit',
  public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5_values where key = 'claim'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    ),
    'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  )
);
select is(
  (select value ->> 'committed' from c5_values where key = 'commit'),
  'true',
  'a current AI-assisted note commits one encrypted index document'
);
select is(
  public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5_values where key = 'claim'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    ),
    'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  ) ->> 'replayed',
  'true',
  'terminal index commit replay is deterministic for the same lease request'
);
select is(
  jsonb_array_length(public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50
  ) -> 'items'),
  0,
  'a complete shadow generation remains unreadable until atomic activation'
);

reset role;
insert into c5_values (key, value)
select
  'activation-token',
  jsonb_build_object('revisionToken', revision_token)
from public.rag_index_generations
where id = 'igen_72000000000000000000000001';
grant unfiled_rag_verifier to postgres;
set local role unfiled_rag_verifier;
select pg_temp.verify_rag_index_generation(
  '22222222-2222-4222-8222-222222222222',
  'igen_72000000000000000000000001',
  (
    select (value ->> 'revisionToken')::bigint
    from c5_values where key = 'activation-token'
  ),
  pg_temp.generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_72000000000000000000000001',
    (
      select (value ->> 'revisionToken')::bigint
      from c5_values where key = 'activation-token'
    )
  )
);
reset role;
revoke unfiled_rag_verifier from postgres;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5_values (key, value)
values (
  'activation',
  public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_72000000000000000000000001',
    (
      select (value ->> 'revisionToken')::bigint
      from c5_values where key = 'activation-token'
    )
  )
);
select is(
  jsonb_array_length(public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50
  ) -> 'items'),
  1,
  'active-generation retrieval returns exact current-revision owner rows only'
);
select throws_ok(
  $$select * from public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 51
  )$$,
  '22023',
  'validation_failed',
  'encrypted exact-scan pages remain conservatively memory bounded'
);
select is(
  public.activate_rag_index_generation(
    '22222222-2222-4222-8222-222222222222',
    'igen_72000000000000000000000001',
    ((select value ->> 'revisionToken' from c5_values where key = 'activation')::bigint - 1)
  ) ->> 'replayed',
  'true',
  'generation activation is compare-and-swap replay safe'
);
select throws_ok(
  $$select public.activate_rag_index_generation(
    '11111111-1111-4111-8111-111111111111',
    'igen_72000000000000000000000001', 0
  )$$,
  'P0001',
  'not_found',
  'generation activation fails closed on an owner mismatch'
);

reset role;
select is(
  pg_temp.caught_sqlstate($statement$
    insert into public.note_rag_index (
      id, user_id, note_id, generation_id, indexed_revision, index_envelope,
      index_key_id, index_key_class, index_key_purpose, index_key_version,
      encrypted_byte_length
    ) values (
      'irw_72000000000000000000000002',
      '22222222-2222-4222-8222-222222222222',
      'note_00000000000000000000000001',
      'igen_72000000000000000000000001', 2,
      pg_temp.content_envelope(
        'irw_72000000000000000000000002',
        '22222222-2222-4222-8222-222222222222', 2,
        'note_rag_index', 'other.ai.object.v1', 80
      ),
      'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
    )
  $statement$),
  '23514',
  'direct cross-owner index insertion is rejected before any foreign-key leak'
);

update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'other.ai.object.v1', 80
  )
where id = 'note_72000000000000000000000009'
  and user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  jsonb_array_length(public.list_active_note_rag_index(
    '22222222-2222-4222-8222-222222222222', null, 50
  ) -> 'items'),
  0,
  'stale indexed revisions disappear from retrieval immediately'
);

insert into c5_values (key, value)
values (
  'enqueue-v2',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000009',
    'igen_72000000000000000000000001', 2
  )
);
insert into c5_values (key, value)
values ('claim-v2', public.claim_note_index_jobs('c5-index-worker-v2', 1, 60));
select is(
  (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-v2'),
  (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim'),
  'revision N+1 reuses the note/generation stable envelope resource ID'
);
insert into c5_values (key, value)
values (
  'commit-v2',
  public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-v2'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5_values where key = 'claim-v2'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-v2'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-v2'),
      '22222222-2222-4222-8222-222222222222', 2,
      'note_rag_index', 'other.ai.object.v1', 80
    ),
    'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  )
);
select ok(
  (select value ->> 'committed' from c5_values where key = 'commit-v2') = 'true'
    and public.list_active_note_rag_index(
      '22222222-2222-4222-8222-222222222222', null, 50
    ) #>> '{items,0,indexedRevision}' = '2',
  'revision N+1 atomically replaces the encrypted document and becomes retrievable'
);
select is(
  public.commit_note_rag_index(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-v2'),
    (select (value #>> '{jobs,0,leaseToken}')::uuid from c5_values where key = 'claim-v2'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-v2'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-v2'),
      '22222222-2222-4222-8222-222222222222', 2,
      'note_rag_index', 'other.ai.object.v1', 80
    ),
    'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
  ) ->> 'replayed',
  'true',
  'revision N+1 terminal commit is replay safe'
);

reset role;
update public.notes
set
  privacy = 'private_manual',
  content_envelope = null,
  content_key_id = null,
  content_key_class = null,
  content_key_purpose = null,
  content_key_version = null
where id = 'note_72000000000000000000000009'
  and user_id = '22222222-2222-4222-8222-222222222222';
select is(
  (
    select count(*)
    from public.note_rag_index
    where note_id = 'note_72000000000000000000000009'
  ),
  0::bigint,
  'privacy transition removes encrypted RAG rows in the note transaction'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000009',
    'igen_72000000000000000000000001', 2
  )$$,
  '42501',
  'ineligible_note_index_job',
  'a private transition cannot enqueue a replacement index job'
);

reset role;
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_72000000000000000000000008',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic', 'C.5 lease recovery fixture', 'synthetic lease body', '{}',
  1, 'ai_assisted', '2026-08-30 23:31:00+00', '2026-08-30 23:31:00+00',
  pg_temp.content_envelope(
    'note_72000000000000000000000008',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'other.ai.object.v1', 80
  ),
  'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5_values (key, value)
values (
  'enqueue-recovery',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000008',
    'igen_72000000000000000000000001', 1
  )
);
insert into c5_values (key, value)
values ('claim-recovery-1', public.claim_note_index_jobs('retry-worker-1', 1, 60));
insert into c5_values (key, value)
values (
  'fail-retry',
  public.fail_note_index_job(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-recovery-1'),
    (
      select (value #>> '{jobs,0,leaseToken}')::uuid
      from c5_values where key = 'claim-recovery-1'
    ),
    'provider_unavailable', true, 0
  )
);
select is(
  (select value ->> 'state' from c5_values where key = 'fail-retry'),
  'queued',
  'a bounded retryable failure returns the index job to the queue'
);
select is(
  public.fail_note_index_job(
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-recovery-1'),
    (
      select (value #>> '{jobs,0,leaseToken}')::uuid
      from c5_values where key = 'claim-recovery-1'
    ),
    'provider_unavailable', true, 0
  ) ->> 'replayed',
  'true',
  'a retried failure transition replays without another attempt'
);
insert into c5_values (key, value)
values ('claim-recovery-2', public.claim_note_index_jobs('retry-worker-2', 1, 60));

reset role;
update public.note_index_jobs
set lease_expires_at = now() - interval '1 second'
where id = (
  select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-recovery-2'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.recover_stale_note_index_jobs(10) ->> 'recoveredCount',
  '1',
  'expired eligible leases recover once to the deterministic queue'
);
select is(
  public.recover_stale_note_index_jobs(10) ->> 'recoveredCount',
  '0',
  'stale lease recovery does not recover the same transition twice'
);

reset role;
update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'other.ai.object.v1', 80
  )
where id = 'note_72000000000000000000000008'
  and user_id = '22222222-2222-4222-8222-222222222222';
select is(
  (
    select state::text || ':' || last_error_code::text
    from public.note_index_jobs
    where id = (
      select value #>> '{jobs,0,jobId}'
      from c5_values where key = 'claim-recovery-2'
    )
  ),
  'failed:stale_revision',
  'a newer note revision invalidates an obsolete queued index job atomically'
);

-- pgTAP runs this file in one rollback-only session, so a blocking two-session
-- interleave cannot be driven without deadlocking the test harness. Pin the
-- reviewed lock order structurally, then exercise both possible "note update
-- wins" outcomes below. The ordinary successful commit cases above cover the
-- converse outcome; its held note lock makes the later invalidation clean up.
select ok(
  note_lock_at > 0
    and note_for_update_at > note_lock_at
    and job_lock_at > note_for_update_at
    and job_for_update_at > job_lock_at
    and generation_lock_at > job_for_update_at
    and generation_for_update_at > generation_lock_at,
  'index commit pins the global note -> job -> generation row-lock order'
)
from (
  select
    definition,
    strpos(definition, 'select * into note_row') as note_lock_at,
    strpos(definition, 'for update of note;') as note_for_update_at,
    strpos(definition, 'select * into job_row') as job_lock_at,
    strpos(definition, 'for update of job;') as job_for_update_at,
    strpos(definition, 'select * into generation_row') as generation_lock_at,
    strpos(definition, 'for update of generation;') as generation_for_update_at
  from (
    select lower(pg_get_functiondef(
      'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)'::regprocedure
    )) as definition
  ) as commit_definition
) as lock_contract;

reset role;
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_72000000000000000000000007',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic', 'C.5 privacy race fixture', 'synthetic privacy race body', '{}',
  1, 'ai_assisted', '2026-08-30 23:32:00+00', '2026-08-30 23:32:00+00',
  pg_temp.content_envelope(
    'note_72000000000000000000000007',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'other.ai.object.v1', 80
  ),
  'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5_values (key, value)
values (
  'enqueue-private-race',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000007',
    'igen_72000000000000000000000001', 1
  )
);
insert into c5_values (key, value)
values ('claim-private-race', public.claim_note_index_jobs('privacy-race-worker', 1, 60));

reset role;
update public.notes
set
  privacy = 'private_manual',
  content_envelope = null,
  content_key_id = null,
  content_key_class = null,
  content_key_purpose = null,
  content_key_version = null
where id = 'note_72000000000000000000000007'
  and user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_sqlstate(format(
    'select public.commit_note_rag_index(%L, %L::uuid, %L, %L::jsonb, %L, %L, %L, 1, 60)',
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-private-race'),
    (select value #>> '{jobs,0,leaseToken}' from c5_values where key = 'claim-private-race'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-private-race'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-private-race'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    )::text,
    'other.ai.object.v1', 'ai_assisted', 'object_wrap'
  )),
  '42501',
  'a privacy transition that wins the note lock invalidates the lease before commit'
);

reset role;
select is(
  (
    select state::text || ':' || last_error_code::text
    from public.note_index_jobs
    where id = (
      select value #>> '{jobs,0,jobId}'
      from c5_values where key = 'claim-private-race'
    )
  ),
  'failed:validation_failed',
  'the winning private transition records a content-free terminal job outcome'
);
select is(
  (
    select count(*)
    from public.note_rag_index
    where note_id = 'note_72000000000000000000000007'
  ),
  0::bigint,
  'a commit cannot publish an encrypted RAG row after the note becomes private'
);

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_72000000000000000000000006',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic', 'C.5 revision race fixture', 'synthetic revision race body', '{}',
  1, 'ai_assisted', '2026-08-30 23:33:00+00', '2026-08-30 23:33:00+00',
  pg_temp.content_envelope(
    'note_72000000000000000000000006',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'other.ai.object.v1', 80
  ),
  'other.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5_values (key, value)
values (
  'enqueue-revision-race',
  public.enqueue_note_index_job(
    '22222222-2222-4222-8222-222222222222',
    'note_72000000000000000000000006',
    'igen_72000000000000000000000001', 1
  )
);
insert into c5_values (key, value)
values ('claim-revision-race', public.claim_note_index_jobs('revision-race-worker', 1, 60));

reset role;
update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'other.ai.object.v1', 80
  )
where id = 'note_72000000000000000000000006'
  and user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_sqlstate(format(
    'select public.commit_note_rag_index(%L, %L::uuid, %L, %L::jsonb, %L, %L, %L, 1, 60)',
    (select value #>> '{jobs,0,jobId}' from c5_values where key = 'claim-revision-race'),
    (select value #>> '{jobs,0,leaseToken}' from c5_values where key = 'claim-revision-race'),
    (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-revision-race'),
    pg_temp.content_envelope(
      (select value #>> '{jobs,0,indexResourceId}' from c5_values where key = 'claim-revision-race'),
      '22222222-2222-4222-8222-222222222222', 1,
      'note_rag_index', 'other.ai.object.v1', 80
    )::text,
    'other.ai.object.v1', 'ai_assisted', 'object_wrap'
  )),
  '42501',
  'a revision transition that wins the note lock invalidates the lease before commit'
);

reset role;
select is(
  (
    select state::text || ':' || last_error_code::text
    from public.note_index_jobs
    where id = (
      select value #>> '{jobs,0,jobId}'
      from c5_values where key = 'claim-revision-race'
    )
  ),
  'failed:stale_revision',
  'the winning revision transition records a content-free stale outcome'
);
select is(
  (
    select count(*)
    from public.note_rag_index
    where note_id = 'note_72000000000000000000000006'
  ),
  0::bigint,
  'a commit cannot publish an encrypted RAG row for an obsolete note revision'
);

select * from finish();
rollback;
