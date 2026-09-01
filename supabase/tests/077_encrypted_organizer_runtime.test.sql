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
  p_seed text default 'D'
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
      'ciphertext', repeat(left(p_seed, 1), 80)
    )
  );
$$;

create function pg_temp.cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_reservation_id text,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_record_version, p_kind, p_key_id, p_seed
    ),
    'keyId', p_key_id,
    'keyClass', 'ai_assisted',
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id
  );
$$;

create function pg_temp.mac(p_seed text, p_key_id text)
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

create function pg_temp.note_state(p_title text, p_body text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'spaceId', null,
    'type', 'generic',
    'title', p_title,
    'bodyMarkdown', p_body,
    'structuredData', jsonb_build_object('schemaVersion', 1),
    'dailyDate', null,
    'isOpen', true,
    'privacy', 'ai_assisted',
    'pinnedAt', null,
    'archivedAt', null,
    'deletedAt', null,
    'tagIds', jsonb_build_array(),
    'links', jsonb_build_array()
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

create function pg_temp.disclosure_manifest(page_value jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'controls', page_value -> 'controls',
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'candidateId', candidate ->> 'candidateId',
        'noteId', candidate ->> 'noteId',
        'revision', candidate -> 'revision',
        'isOpen', candidate -> 'metadata' -> 'isOpen'
      ) order by ordinal)
      from jsonb_array_elements(page_value -> 'candidates')
        with ordinality as listed(candidate, ordinal)
    ), '[]'::jsonb)
  );
$$;

create temporary table organizer_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on organizer_values to service_role, unfiled_organizer_worker;

select has_table(
  'public', 'encrypted_organizer_preparations',
  'organizer stable IDs and reservations are durable'
);
select has_table(
  'public', 'encrypted_organizer_candidate_pages',
  'candidate disclosure manifests are retained behind a server-side fence'
);
select has_column(
  'public', 'organization_jobs', 'replan_count',
  'organization jobs retain the one-replan fence'
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
    where rolname = 'unfiled_organizer_worker'
  ),
  'the organizer starts as a non-login, non-inheriting, non-bypass role'
);
select ok(
  (
    select count(*) = 10
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )
  ),
  'the organizer has exactly ten lease-bound public RPC capabilities'
);
select ok(
  has_function_privilege(
    'unfiled_organizer_worker',
    'public.claim_encrypted_organizer_jobs(text,integer,integer)', 'EXECUTE'
  )
    and has_function_privilege(
      'unfiled_organizer_worker',
      'public.heartbeat_encrypted_organizer_job(text,text,integer,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_organizer_worker',
      'public.commit_encrypted_organizer_job(text,text,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'public.claim_note_index_jobs(text,integer,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'public.list_active_note_rag_index(uuid,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'public.register_user_content_key(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,bytea)',
      'EXECUTE'
    )
    and not has_schema_privilege(
      'unfiled_organizer_worker', 'private', 'USAGE'
    )
    and not has_table_privilege(
      'unfiled_organizer_worker', 'public.captures', 'SELECT'
    )
    and not has_table_privilege(
      'unfiled_organizer_worker', 'public.notes', 'UPDATE'
    ),
  'the exact-ten role has no unbound index, key lifecycle, private schema, or relation access'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.claim_encrypted_organizer_jobs(text,integer,integer)', 'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.commit_encrypted_organizer_job(text,text,jsonb)', 'EXECUTE'
    ),
  'service and client roles cannot borrow the organizer capability'
);
select ok(
  (
    select procedure.pronargdefaults = 2
      and pg_get_expr(procedure.proargdefaults, 0) = '2, 60'
    from pg_proc as procedure
    where procedure.oid =
      'public.claim_encrypted_organizer_jobs(text,integer,integer)'::regprocedure
  ),
  'the public claim wrapper defaults to the bounded two-job runtime batch'
);
select throws_ok(
  $$select private.claim_encrypted_organizer_jobs_impl('claim-limit-probe', 5, 60)$$,
  '22023',
  'validation_failed',
  'the database rejects claim batches above the four-job runtime ceiling'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'public.encrypted_organizer_preparations'::regclass
  ),
  'organizer preparation state has enabled and forced RLS'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'public.encrypted_organizer_candidate_pages'::regclass
  ),
  'candidate disclosure manifests have enabled and forced RLS'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'private.try_prelock_content_encryption_rollout()'::regprocedure,
      'private.serialize_content_rollout_delete()'::regprocedure,
      'private.enforce_encrypted_organizer_rollout_write()'::regprocedure,
      'private.lock_encrypted_organizer_job_rollout(text)'::regprocedure,
      'private.assert_encrypted_organizer_lease(text,text,boolean)'::regprocedure,
      'private.organizer_key_projection(public.user_content_keys)'::regprocedure,
      'private.encrypted_organizer_preparation_projection(public.encrypted_organizer_preparations,public.user_content_keys,public.user_content_keys,boolean)'::regprocedure,
      'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure,
      'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'::regprocedure,
      'private.list_encrypted_organizer_candidates_impl(text,text,integer)'::regprocedure,
      'private.list_encrypted_organizer_rag_page_impl(text,text,jsonb,integer,integer)'::regprocedure,
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'::regprocedure,
      'private.prepare_encrypted_organizer_write_impl(text,text,text,text,bigint,text)'::regprocedure,
      'private.prepare_encrypted_organizer_create_impl(text,text,text,text)'::regprocedure,
      'private.prepare_encrypted_organizer_append_impl(text,text,text,bigint,text)'::regprocedure,
      'private.consume_encrypted_organizer_reservation(public.encrypted_organizer_preparations,jsonb,uuid,text)'::regprocedure,
      'private.burn_encrypted_organizer_reservations(text,uuid)'::regprocedure,
      'private.encrypted_organizer_reason_codes(jsonb)'::regprocedure,
      'private.insert_encrypted_organizer_decision(public.encrypted_organizer_preparations,jsonb,text,boolean)'::regprocedure,
      'private.insert_encrypted_organizer_review(public.encrypted_organizer_preparations,jsonb,text)'::regprocedure,
      'private.insert_encrypted_organizer_receipt(public.encrypted_organizer_preparations,jsonb,text,text,boolean,text)'::regprocedure,
      'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure,
      'private.fail_encrypted_organizer_job_impl(text,text,text,boolean)'::regprocedure,
      'private.recover_stale_encrypted_organizer_jobs_impl(integer)'::regprocedure
    ]) as helper(function_oid)
    cross join unnest(array[
      'anon', 'authenticated', 'service_role', 'unfiled_index_worker',
      'unfiled_rag_verifier', 'unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_function_privilege(
      denied.role_name, helper.function_oid, 'EXECUTE'
    )
  ),
  'no client, service, index, verifier, or organizer role can execute a private organizer helper'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    cross join lateral aclexplode(coalesce(
      procedure.proacl,
      acldefault('f', procedure.proowner)
    )) as privilege
    where procedure.oid = any(array[
      'private.try_prelock_content_encryption_rollout()'::regprocedure,
      'private.serialize_content_rollout_delete()'::regprocedure,
      'private.enforce_encrypted_organizer_rollout_write()'::regprocedure,
      'private.lock_encrypted_organizer_job_rollout(text)'::regprocedure,
      'private.assert_encrypted_organizer_lease(text,text,boolean)'::regprocedure,
      'private.organizer_key_projection(public.user_content_keys)'::regprocedure,
      'private.encrypted_organizer_preparation_projection(public.encrypted_organizer_preparations,public.user_content_keys,public.user_content_keys,boolean)'::regprocedure,
      'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure,
      'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'::regprocedure,
      'private.list_encrypted_organizer_candidates_impl(text,text,integer)'::regprocedure,
      'private.list_encrypted_organizer_rag_page_impl(text,text,jsonb,integer,integer)'::regprocedure,
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'::regprocedure,
      'private.prepare_encrypted_organizer_write_impl(text,text,text,text,bigint,text)'::regprocedure,
      'private.prepare_encrypted_organizer_create_impl(text,text,text,text)'::regprocedure,
      'private.prepare_encrypted_organizer_append_impl(text,text,text,bigint,text)'::regprocedure,
      'private.consume_encrypted_organizer_reservation(public.encrypted_organizer_preparations,jsonb,uuid,text)'::regprocedure,
      'private.burn_encrypted_organizer_reservations(text,uuid)'::regprocedure,
      'private.encrypted_organizer_reason_codes(jsonb)'::regprocedure,
      'private.insert_encrypted_organizer_decision(public.encrypted_organizer_preparations,jsonb,text,boolean)'::regprocedure,
      'private.insert_encrypted_organizer_review(public.encrypted_organizer_preparations,jsonb,text)'::regprocedure,
      'private.insert_encrypted_organizer_receipt(public.encrypted_organizer_preparations,jsonb,text,text,boolean,text)'::regprocedure,
      'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure,
      'private.fail_encrypted_organizer_job_impl(text,text,text,boolean)'::regprocedure,
      'private.recover_stale_encrypted_organizer_jobs_impl(integer)'::regprocedure
    ])
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'private organizer helpers have no implicit PUBLIC execute ACL'
);

select ok(
  (
    select
      pg_catalog.strpos(
        source, 'new.user_id is distinct from old.user_id'
      ) > 0
      and pg_catalog.strpos(
        source, 'new.user_id is distinct from old.user_id'
      ) < pg_catalog.strpos(source, 'pg_try_advisory_xact_lock')
      and pg_catalog.strpos(source, 'content_encryption_rollout_busy') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.enforce_encrypted_organizer_rollout_write()'::regprocedure
      )) as source
    ) as guard
  ),
  'organization job ownership is rejected as immutable before the rollout advisory lookup'
);
select ok(
  (
    select
      pg_catalog.strpos(
        source, 'new.user_id is distinct from old.user_id'
      ) > 0
      and pg_catalog.strpos(
        source, 'new.user_id is distinct from old.user_id'
      ) < pg_catalog.strpos(source, 'pg_try_advisory_xact_lock')
      and pg_catalog.strpos(source, 'content_owner_immutable') > 0
      and pg_catalog.strpos(source, 'content_encryption_rollout_busy') > 0
      and pg_catalog.strpos(source, 'errcode = ''40001''') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.try_prelock_content_encryption_rollout()'::regprocedure
      )) as source
    ) as prelock
  ),
  'the global row-trigger fence rejects owner changes and fails fast on a held rollout advisory'
);
select ok(
  (
    select
      pg_catalog.strpos(source, 'pg_try_advisory_xact_lock') > 0
      and pg_catalog.strpos(source, 'content_encryption_rollout_busy') > 0
      and pg_catalog.strpos(source, 'errcode = ''40001''') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.serialize_content_rollout_delete()'::regprocedure
      )) as source
    ) as deletion
  ),
  'rollout-serialized deletes fail fast instead of waiting while holding rows'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'spaces', 'tags', 'notes', 'note_revisions', 'note_mutations',
      'organization_decisions', 'generated_blocks', 'review_items',
      'routing_rules', 'organization_mutation_attempts',
      'api_idempotency_records', 'capture_receipts', 'captures',
      'organization_jobs'
    ]) as guarded(table_name)
    where not exists (
      select 1
      from pg_catalog.pg_trigger as trigger
      join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = guarded.table_name
        and trigger.tgname = 'a_content_rollout_advisory_prelock'
        and not trigger.tgisinternal
        and trigger.tgenabled <> 'D'
        and trigger.tgfoid =
          'private.try_prelock_content_encryption_rollout()'::regprocedure
    )
  ),
  'every rollout-guarded content and organization-job table has the enabled fail-fast prelock trigger'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_trigger as validation_trigger
    join pg_catalog.pg_class as relation
      on relation.oid = validation_trigger.tgrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and validation_trigger.tgname like '%encrypted_rollout_guard'
      and not validation_trigger.tgisinternal
      and not exists (
        select 1
        from pg_catalog.pg_trigger as prelock_trigger
        where prelock_trigger.tgrelid = validation_trigger.tgrelid
          and prelock_trigger.tgname = 'a_content_rollout_advisory_prelock'
          and prelock_trigger.tgname < validation_trigger.tgname
          and not prelock_trigger.tgisinternal
          and prelock_trigger.tgenabled <> 'D'
      )
  ),
  'the fail-fast prelock fires alphabetically before every blocking encrypted rollout validator'
);
select ok(
  (
    select (trigger.tgtype::integer & 31) = 31
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.organization_jobs'::regclass
      and trigger.tgname = 'a_content_rollout_advisory_prelock'
      and not trigger.tgisinternal
  ),
  'organization-job inserts, updates, and deletes all pass through the fail-fast owner fence'
);
select ok(
  (
    select
      pg_catalog.strpos(source, 'pg_advisory_xact_lock') > 0
      and pg_catalog.strpos(source, 'pg_advisory_xact_lock')
        < pg_catalog.strpos(source, 'for update of job')
      and pg_catalog.strpos(source, 'for update of job') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.lock_encrypted_organizer_job_rollout(text)'::regprocedure
      )) as source
    ) as helper
  ),
  'the single-job lock helper takes the owner rollout advisory before its job row lock'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'::regprocedure,
      'private.list_encrypted_organizer_candidates_impl(text,text,integer)'::regprocedure,
      'private.list_encrypted_organizer_rag_page_impl(text,text,jsonb,integer,integer)'::regprocedure,
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'::regprocedure,
      'private.prepare_encrypted_organizer_write_impl(text,text,text,text,bigint,text)'::regprocedure,
      'private.prepare_encrypted_organizer_append_impl(text,text,text,bigint,text)'::regprocedure
    ]) as guarded(function_oid)
    where pg_catalog.strpos(
      pg_catalog.lower(pg_catalog.pg_get_functiondef(guarded.function_oid)),
      'private.assert_encrypted_organizer_lease'
    ) = 0
  ),
  'heartbeat, list, and both prepare mutation paths enter through the advisory-first lease helper'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure,
      'private.fail_encrypted_organizer_job_impl(text,text,text,boolean)'::regprocedure
    ]) as guarded(function_oid)
    cross join lateral (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        guarded.function_oid
      )) as source
    ) as definition
    where pg_catalog.strpos(
      definition.source, 'private.lock_encrypted_organizer_job_rollout'
    ) = 0
  ),
  'commit and fail acquire the owner rollout advisory before replay or active row locks'
);
select ok(
  (
    select
      pg_catalog.strpos(source, 'select distinct locked_owner.user_id') > 0
      and pg_catalog.strpos(source, 'order by locked_owner.user_id')
        > pg_catalog.strpos(source, 'select distinct locked_owner.user_id')
      and pg_catalog.strpos(source, 'pg_advisory_xact_lock')
        < pg_catalog.strpos(source, 'pg_try_advisory_xact_lock')
      and pg_catalog.strpos(source, 'pg_advisory_xact_lock')
        < pg_catalog.strpos(source, 'for update of job')
      and pg_catalog.strpos(source, 'job.created_at = candidate.created_at') > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
      )) as source
    ) as claim
  ),
  'multi-owner claim prelocks distinct owners in UUID order before per-job advisory and row locks'
);
select ok(
  (
    select
      pg_catalog.strpos(source, 'select distinct locked_owner.user_id') > 0
      and pg_catalog.strpos(source, 'order by locked_owner.user_id')
        > pg_catalog.strpos(source, 'select distinct locked_owner.user_id')
      and pg_catalog.strpos(source, 'pg_advisory_xact_lock')
        < pg_catalog.strpos(source, 'for update;')
      and pg_catalog.strpos(source, 'for update skip locked') = 0
      and pg_catalog.strpos(source, 'user_id = stale.user_id') > 0
      and pg_catalog.strpos(source, 'capture_id = stale.capture_id') > 0
      and pg_catalog.strpos(source, 'created_at = stale.created_at') > 0
      and pg_catalog.strpos(
        source, 'lease_expires_at = stale.lease_expires_at'
      ) > 0
    from (
      select pg_catalog.lower(pg_catalog.pg_get_functiondef(
        'private.recover_stale_encrypted_organizer_jobs_impl(integer)'::regprocedure
      )) as source
    ) as recovery
  ),
  'multi-owner recovery prelocks distinct owners in UUID order before any job row lock'
);
select lives_ok(
  $$select private.lock_encrypted_organizer_job_rollout(
    'job_00000000000000000000000001'
  )$$,
  'the advisory-first helper dynamically locks and revalidates a committed job'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_locks as held
    cross join lateral (
      select pg_catalog.hashtextextended(
        '11111111-1111-4111-8111-111111111111:content-encryption-rollout', 0
      ) as lock_key
    ) as expected
    where held.pid = pg_catalog.pg_backend_pid()
      and held.locktype = 'advisory'
      and held.granted
      and held.objsubid = 1
      and held.classid::bigint = ((expected.lock_key >> 32) & 4294967295)
      and held.objid::bigint = (expected.lock_key & 4294967295)
  ),
  'the helper dynamically retains the exact canonical owner rollout xact lock'
);

-- Isolate the second synthetic owner from seed data.
delete from public.captures
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.notes
where user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c3.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/77000000-0000-4000-8000-000000000001',
  decode(repeat('71', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c3.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/77000000-0000-4000-8000-000000000002',
  decode(repeat('72', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'c5c3.private.object.v1', 'private_manual', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/77000000-0000-4000-8000-000000000003',
  decode(repeat('73', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'c5c3.ai.object.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'c5c3.ai.mac.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'c5c3.private.object.v1'
);
reset role;
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '22222222-2222-4222-8222-222222222222';

-- Fresh AI capture is now an atomic encrypted enqueue rather than the C.5b
-- fail-closed placeholder. The caller reserves exactly one capture wrap.
set local role service_role;
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '77000000-0000-4000-8000-000000000010',
  'ai_assisted', 'c5c3.ai.object.v1', 1, 1
);
insert into organizer_values(key, value)
select 'capture-command', jsonb_build_object(
  'clientCaptureId', 'cap_77000000000000000000000001',
  'jobId', 'job_77000000000000000000000001',
  'occurredAt', timestamp_value,
  'contentCipher', pg_temp.cipher(
    'cap_77000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1, 'capture',
    'c5c3.ai.object.v1', '77000000-0000-4000-8000-000000000010'
  ),
  'contentMac', pg_temp.mac('capture-one', 'c5c3.ai.mac.v1'),
  'contentLength', 24,
  'source', 'web',
  'deviceId', 'c5c3-web',
  'clientCreatedAt', timestamp_value,
  'clientTimezone', 'UTC',
  'privacy', 'ai_assisted',
  'explicitDestinationNoteId', null,
  'expansionDisabled', false,
  'routingRuleMatch', null,
  'privateReceiptCipher', null,
  'privateReceiptVerificationMac', null
)
from (
  select to_char(
    clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) as timestamp_value
) as now_value;
insert into organizer_values(key, value)
select 'capture-result', public.create_encrypted_capture_with_job(
  '22222222-2222-4222-8222-222222222222', value
)
from organizer_values where key = 'capture-command';
reset role;
select ok(
  (select value ->> 'replayed' from organizer_values
    where key = 'capture-result') = 'false'
    and (
      select job.state = 'created' and capture.status = 'queued'
      from public.organization_jobs as job
      join public.captures as capture on capture.id = job.capture_id
      where job.id = 'job_77000000000000000000000001'
    ),
  'fresh encrypted AI capture and its organizer job commit atomically'
);
set local role service_role;
select is(
  (
    select public.create_encrypted_capture_with_job(
      '22222222-2222-4222-8222-222222222222', value
    ) ->> 'replayed'
    from organizer_values where key = 'capture-command'
  ),
  'true',
  'encrypted AI capture replay does not duplicate its job or reservation'
);
reset role;

-- One current encrypted aggregate is eligible as a candidate. A different
-- owner's seeded note must never appear in the job-scoped projection.
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values (
  'note_77000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'generic', '[encrypted]', '[encrypted]', '{"schemaVersion":1}'::jsonb,
  1, 'ai_assisted',
  pg_temp.content_envelope(
    'note_77000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1, 'note_content',
    'c5c3.ai.object.v1'
  ),
  'c5c3.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

insert into organizer_values(key, value) values (
  'claim', private.claim_encrypted_organizer_jobs_impl('c5c3-worker', 1, 60)
);
select ok(
  (select value #>> '{jobs,0,jobId}' from organizer_values
    where key = 'claim') = 'job_77000000000000000000000001'
    and (select value #>> '{jobs,0,ownerId}' from organizer_values
      where key = 'claim') = '22222222-2222-4222-8222-222222222222'
    and (select value #>> '{jobs,0,source,keyRecord,keyClass}'
      from organizer_values where key = 'claim') = 'ai_assisted',
  'claim derives the owner and returns only the exact encrypted source/key record'
);
insert into organizer_values(key, value)
select 'candidates', private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}', 8
)
from organizer_values where key = 'claim';
select ok(
  (select value #>> '{candidates,0,noteId}' from organizer_values
    where key = 'candidates') = 'note_77000000000000000000000001'
    and (select value #>> '{candidates,0,aggregate,keyRecord,ownerId}'
      from organizer_values where key = 'candidates')
      = '22222222-2222-4222-8222-222222222222'
    and not ((select value from organizer_values where key = 'candidates')::text
      like '%11111111-1111-4111-8111-111111111111%'),
  'candidate read is current, encrypted, job-owner scoped, and cross-tenant safe'
);
select ok(
  (
    select private.heartbeat_encrypted_organizer_job_impl(
      claim.value #>> '{jobs,0,jobId}',
      claim.value #>> '{jobs,0,leaseToken}', 60,
      pg_temp.disclosure_manifest(page.value)
    ) ->> 'disclosureAuthorized'
    from organizer_values as claim
    cross join organizer_values as page
    where claim.key = 'claim' and page.key = 'candidates'
  ) = 'true',
  'heartbeat is the explicit disclosure authorization linearization point'
);
select is(
  (pg_temp.caught_error(format(
    'select private.list_encrypted_organizer_candidates_impl(%L,%L,8)',
    'job_77000000000000000000000001',
    '77000000-0000-4000-8000-000000000099'
  )) ->> 'message'),
  'invalid_or_expired_lease',
  'a different lease cannot read any candidate ciphertext'
);

-- Prepare create binds stable IDs and four purpose-separated reservations.
insert into organizer_values(key, value)
select 'create-preparation', private.prepare_encrypted_organizer_create_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'note_77000000000000000000000002',
  '77000000-0000-4000-8000-000000000020'
)
from organizer_values where key = 'claim';
select ok(
  (select value ->> 'mode' from organizer_values
    where key = 'create-preparation') = 'create'
    and (select value #>> '{reservations,noteWrite,operationCount}'
      from organizer_values where key = 'create-preparation') = '4'
    and (select value #>> '{keys,contentMac,keyClass}'
      from organizer_values where key = 'create-preparation') = 'ai_assisted',
  'create prepare returns stable IDs plus exact wrap/MAC key projections'
);
select is(
  (
    select private.prepare_encrypted_organizer_create_impl(
      claim.value #>> '{jobs,0,jobId}',
      claim.value #>> '{jobs,0,leaseToken}',
      'note_77000000000000000000000002',
      '77000000-0000-4000-8000-000000000020'
    ) ->> 'replayed'
    from organizer_values as claim where claim.key = 'claim'
  ),
  'true',
  'a response-lost prepare returns the same IDs without reserving twice'
);

-- Materialize one complete create command with the existing encrypted
-- aggregate contract nested under noteWrite.
insert into organizer_values(key, value)
select 'create-command', jsonb_build_object(
  'outcome', 'created',
  'reviewReason', null,
  'noteWrite', jsonb_build_object(
    'occurredAt', timestamp_value,
    'noteState', pg_temp.note_state('Organized title', 'source preserved'),
    'noteCipher', pg_temp.cipher(
      prep.value ->> 'noteId', owner_id, 1, 'note_content', object_key,
      prep.value #>> '{reservations,noteWrite,reservationId}', 'E'
    ),
    'revision', jsonb_build_object(
      'id', prep.value #>> '{ids,revisionId}',
      'source', 'organization',
      'actor', 'organization:c5c3-worker',
      'cipher', pg_temp.cipher(
        prep.value #>> '{ids,revisionId}', owner_id, 1, 'note_revision',
        object_key, prep.value #>> '{reservations,noteWrite,reservationId}', 'F'
      ),
      'mac', pg_temp.mac('create-revision', mac_key)
    ),
    'mutation', jsonb_build_object(
      'id', prep.value #>> '{ids,mutationId}',
      'decisionId', null,
      'undoTargetMutationId', null,
      'operations', jsonb_build_array(jsonb_build_object('type', 'create_note')),
      'inverse', jsonb_build_array(),
      'cipher', pg_temp.cipher(
        prep.value #>> '{ids,mutationId}', owner_id, 1, 'note_mutation',
        object_key, prep.value #>> '{reservations,noteWrite,reservationId}', 'G'
      )
    ),
    'requestMac', pg_temp.mac('create-logical-request', mac_key),
    'responseCipher', pg_temp.cipher(
      'idempotency:organizer:' || (prep.value ->> 'jobId'),
      owner_id, 1, 'idempotency_response', object_key,
      prep.value #>> '{reservations,noteWrite,reservationId}', 'H'
    ),
    'verification', jsonb_build_object(
      'noteContent', pg_temp.mac('create-note-proof', mac_key),
      'noteMutation', pg_temp.mac('create-mutation-proof', mac_key),
      'idempotencyResponse', pg_temp.mac('create-response-proof', mac_key)
    )
  ),
  'decision', jsonb_build_object(
    'cipher', pg_temp.cipher(
      prep.value #>> '{ids,decisionId}', owner_id, 1,
      'organization_decision', object_key,
      prep.value #>> '{reservations,decision,reservationId}', 'J'
    ),
    'verificationMac', pg_temp.mac('create-decision-proof', mac_key),
    'band', 'auto',
    'reasonCodes', jsonb_build_array('strong_match')
  ),
  'review', null,
  'receipt', jsonb_build_object(
    'cipher', pg_temp.cipher(
      'cap_77000000000000000000000001', owner_id, 1,
      'capture_receipt', object_key,
      prep.value #>> '{reservations,receipt,reservationId}', 'K'
    ),
    'verificationMac', pg_temp.mac('create-receipt-proof', mac_key)
  )
)
from organizer_values as prep
cross join lateral (
  select
    '22222222-2222-4222-8222-222222222222'::uuid as owner_id,
    'c5c3.ai.object.v1'::text as object_key,
    'c5c3.ai.mac.v1'::text as mac_key,
    to_char(
      clock_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) as timestamp_value
) as fixture
where prep.key = 'create-preparation';
insert into organizer_values(key, value)
select 'create-commit', private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}', command.value
)
from organizer_values as claim
cross join organizer_values as command
where claim.key = 'claim' and command.key = 'create-command';
select ok(
  (select value ->> 'outcome' from organizer_values
    where key = 'create-commit') = 'created'
    and exists (
      select 1 from public.notes
      where id = 'note_77000000000000000000000002'
        and current_revision = 1
        and content_envelope is not null
    )
    and exists (
      select 1 from public.organization_decisions
      where id = (select value #>> '{ids,decisionId}' from organizer_values
        where key = 'create-preparation')
        and destination_note_id = 'note_77000000000000000000000002'
        and decision_envelope is not null
    )
    and exists (
      select 1
      from public.capture_receipts as receipt
      join public.captures as capture
        on capture.id = receipt.capture_id
        and capture.user_id = receipt.user_id
      where receipt.capture_id = 'cap_77000000000000000000000001'
        and receipt.outcome = 'created_note'
        and receipt.receipt_envelope is not null
        and receipt.created_at = capture.client_created_at
    ),
  'create commit publishes an encrypted receipt at its capture occurrence time'
);
select is(
  (
    select private.commit_encrypted_organizer_job_impl(
      claim.value #>> '{jobs,0,jobId}',
      claim.value #>> '{jobs,0,leaseToken}', command.value
    ) ->> 'replayed'
    from organizer_values as claim
    cross join organizer_values as command
    where claim.key = 'claim' and command.key = 'create-command'
  ),
  'true',
  'terminal create replay returns the original result without duplicate effects'
);

-- A second job exercises append conflict fencing: exactly one replan, then an
-- encrypted Review result without overwriting the manually advanced note.
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_77000000000000000000000002',
  '22222222-2222-4222-8222-222222222222', 'web', '[encrypted]',
  pg_temp.content_envelope(
    'cap_77000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1, 'capture',
    'c5c3.ai.object.v1'
  ),
  encode(extensions.digest('capture-two', 'sha256'), 'hex'), 20,
  'ai_assisted', clock_timestamp(), 'UTC', clock_timestamp(), 'queued',
  'c5c3.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'c5c3.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_77000000000000000000000002',
  'cap_77000000000000000000000002',
  '22222222-2222-4222-8222-222222222222',
  'created', 'routing-v1', 1
);
insert into organizer_values(key, value) values (
  'append-claim', private.claim_encrypted_organizer_jobs_impl(
    'c5c3-worker', 1, 60
  )
);
insert into organizer_values(key, value)
select 'append-candidates', private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}', 8
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'append-heartbeat', private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}', 60,
  pg_temp.disclosure_manifest(page.value)
)
from organizer_values as claim
cross join organizer_values as page
where claim.key = 'append-claim' and page.key = 'append-candidates';
insert into organizer_values(key, value)
select 'append-prepare-result', private.prepare_encrypted_organizer_append_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'note_77000000000000000000000001', 1,
  '77000000-0000-4000-8000-000000000030'
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'append-preparation', value -> 'preparation'
from organizer_values where key = 'append-prepare-result';

update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 2, 'note_content', 'c5c3.ai.object.v1', 'L'
  )
where id = 'note_77000000000000000000000001';
insert into organizer_values(key, value)
select 'first-replan', private.commit_encrypted_organizer_job_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  '{"outcome":"appended","reviewReason":null,"noteWrite":{},"decision":{},"review":{},"receipt":{}}'::jsonb
)
from organizer_values where key = 'append-claim';
select ok(
  (select value ->> 'outcome' from organizer_values
    where key = 'first-replan') = 'replan'
    and (select replan_count = 1 from public.organization_jobs
      where id = 'job_77000000000000000000000002'),
  'the first append conflict advances exactly one durable replan fence'
);

insert into organizer_values(key, value)
select 'append-candidates-2', private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}', 8
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'append-heartbeat-2', private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}', 60,
  pg_temp.disclosure_manifest(page.value)
)
from organizer_values as claim
cross join organizer_values as page
where claim.key = 'append-claim' and page.key = 'append-candidates-2';
insert into organizer_values(key, value)
select 'append-prepare-result-2', private.prepare_encrypted_organizer_append_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'note_77000000000000000000000001', 2,
  '77000000-0000-4000-8000-000000000031'
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'append-preparation-2', value -> 'preparation'
from organizer_values where key = 'append-prepare-result-2';

update public.notes
set
  current_revision = 3,
  content_envelope = pg_temp.content_envelope(
    id, user_id, 3, 'note_content', 'c5c3.ai.object.v1', 'M'
  )
where id = 'note_77000000000000000000000001';
insert into organizer_values(key, value)
select 'review-required', private.commit_encrypted_organizer_job_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  '{"outcome":"appended","reviewReason":null,"noteWrite":{},"decision":{},"review":{},"receipt":{}}'::jsonb
)
from organizer_values where key = 'append-claim';
select ok(
  (select value ->> 'outcome' from organizer_values
    where key = 'review-required') = 'review_required'
    and (select value ->> 'conflictReason' from organizer_values
      where key = 'review-required') = 'revision',
  'a second append conflict requires freshly sealed Review and publishes nothing'
);
insert into organizer_values(key, value)
select 'append-candidates-3', private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}', 8
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'append-heartbeat-3', private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}', 60,
  pg_temp.disclosure_manifest(page.value)
)
from organizer_values as claim
cross join organizer_values as page
where claim.key = 'append-claim' and page.key = 'append-candidates-3';
insert into organizer_values(key, value)
select 'review-preparation', private.prepare_encrypted_organizer_create_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'note_77000000000000000000000005',
  '77000000-0000-4000-8000-000000000032'
)
from organizer_values where key = 'append-claim';
insert into organizer_values(key, value)
select 'review-command', jsonb_build_object(
  'outcome', 'review',
  'reviewReason', 'revision_conflict',
  'noteWrite', null,
  'decision', jsonb_build_object(
    'cipher', pg_temp.cipher(
      prep.value #>> '{ids,decisionId}', owner_id, 1,
      'organization_decision', object_key,
      prep.value #>> '{reservations,decision,reservationId}', 'N'
    ),
    'verificationMac', pg_temp.mac('review-decision-proof', mac_key),
    'band', 'review',
    'reasonCodes', jsonb_build_array('revision_conflict')
  ),
  'review', jsonb_build_object(
    'cipher', pg_temp.cipher(
      prep.value #>> '{ids,reviewItemId}', owner_id, 1,
      'review_item', object_key,
      prep.value #>> '{reservations,review,reservationId}', 'P'
    ),
    'verificationMac', pg_temp.mac('review-item-proof', mac_key),
    'type', 'revision_conflict'
  ),
  'receipt', jsonb_build_object(
    'cipher', pg_temp.cipher(
      'cap_77000000000000000000000002', owner_id, 1,
      'capture_receipt', object_key,
      prep.value #>> '{reservations,receipt,reservationId}', 'Q'
    ),
    'verificationMac', pg_temp.mac('review-receipt-proof', mac_key)
  )
)
from organizer_values as prep
cross join lateral (
  select
    '22222222-2222-4222-8222-222222222222'::uuid as owner_id,
    'c5c3.ai.object.v1'::text as object_key,
    'c5c3.ai.mac.v1'::text as mac_key
) as fixture
where prep.key = 'review-preparation';
insert into organizer_values(key, value)
select 'review-commit', private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}', claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from organizer_values as claim
cross join organizer_values as command
where claim.key = 'append-claim' and command.key = 'review-command';
select ok(
  (select value ->> 'outcome' from organizer_values
    where key = 'review-commit') = 'review'
    and (select current_revision = 3 from public.notes
      where id = 'note_77000000000000000000000001')
    and exists (
      select 1 from public.review_items
      where id = (select value #>> '{ids,reviewItemId}'
        from organizer_values where key = 'append-preparation')
        and state = 'open' and review_envelope is not null
    )
    and (select status = 'needs_review' from public.captures
      where id = 'cap_77000000000000000000000002'),
  'a second conflict commits encrypted Review atomically and never overwrites manual state'
);

-- Failure and recovery remain content-free, lease fenced, and replay safe.
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_77000000000000000000000003',
  '22222222-2222-4222-8222-222222222222', 'web', '[encrypted]',
  pg_temp.content_envelope(
    'cap_77000000000000000000000003',
    '22222222-2222-4222-8222-222222222222', 1, 'capture',
    'c5c3.ai.object.v1'
  ), encode(extensions.digest('capture-three', 'sha256'), 'hex'), 20,
  'ai_assisted', clock_timestamp(), 'UTC', clock_timestamp(), 'queued',
  'c5c3.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'c5c3.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_77000000000000000000000003',
  'cap_77000000000000000000000003',
  '22222222-2222-4222-8222-222222222222', 'created', 'routing-v1', 1
);
insert into organizer_values(key, value) values (
  'failure-claim', private.claim_encrypted_organizer_jobs_impl(
    'c5c3-worker', 1, 60
  )
);
insert into organizer_values(key, value)
select 'failure-result', private.fail_encrypted_organizer_job_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  'provider_unavailable', true
)
from organizer_values where key = 'failure-claim';
select is(
  (select value ->> 'state' from organizer_values where key = 'failure-result'),
  'awaiting_retry',
  'retryable organizer failure returns the job to its bounded queue'
);
select is(
  (
    select private.fail_encrypted_organizer_job_impl(
      value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
      'provider_unavailable', true
    ) ->> 'replayed'
    from organizer_values where key = 'failure-claim'
  ),
  'true',
  'failure terminal replay is idempotent by exact lease and payload'
);

-- SET ROLE is not a production-login substitute: session_user remains
-- postgres, so the public wrapper rejects it even though the grant exists.
grant unfiled_organizer_worker to postgres;
set local role unfiled_organizer_worker;
insert into organizer_values(key, value)
values (
  'set-role-error', pg_temp.caught_error(
    $$select public.recover_stale_encrypted_organizer_jobs(1)$$
  )
);
reset role;
select is(
  (select value ->> 'message' from organizer_values where key = 'set-role-error'),
  'forbidden',
  'SET ROLE cannot impersonate the exact organizer login'
);

select * from finish();
rollback;
