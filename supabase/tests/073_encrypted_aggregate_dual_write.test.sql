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
  p_ciphertext_seed text default 'D'
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
      'ciphertext', repeat(left(p_ciphertext_seed, 1), 64)
    )
  );
$$;

create function pg_temp.cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_key_class text,
  p_reservation_id uuid,
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
    'keyClass', p_key_class,
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id::text
  );
$$;

create function pg_temp.mac(
  p_seed text,
  p_key_id text,
  p_key_class text,
  p_key_version integer default 1
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', 'content_mac',
    'keyVersion', p_key_version
  );
$$;

create function pg_temp.note_state(p_title text, p_privacy text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'spaceId', null,
    'type', 'generic',
    'title', p_title,
    'bodyMarkdown', 'ciphertext-backed body',
    'structuredData', jsonb_build_object('schemaVersion', 1),
    'dailyDate', null,
    'isOpen', true,
    'privacy', p_privacy,
    'pinnedAt', null,
    'archivedAt', null,
    'deletedAt', null,
    'tagIds', jsonb_build_array(),
    'links', jsonb_build_array()
  );
$$;

create function pg_temp.rebind_undo_command(
  p_command jsonb,
  p_claim jsonb,
  p_request_mac jsonb,
  p_target_mutation_id text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          p_command,
          '{occurredAt}', to_jsonb(p_claim ->> 'occurredAt')
        ),
        '{revision,id}', to_jsonb(p_claim ->> 'revisionId')
      ),
      '{mutation,id}', to_jsonb(p_claim ->> 'mutationId')
    ),
    '{mutation,undoTargetMutationId}', to_jsonb(p_target_mutation_id)
  ) || jsonb_build_object('requestMac', p_request_mac);
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

create temporary table c5b_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on c5b_values to service_role, authenticated;

-- Owner two is a clean rollout fixture. Owner one retains the seeded legacy
-- library so candidate/backfill completeness can be exercised.
delete from public.notes
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.spaces
where user_id = '22222222-2222-4222-8222-222222222222';

insert into public.captures (
  id, user_id, source, device_id, raw_text, content_envelope,
  content_fingerprint, content_length, privacy, client_created_at,
  client_timezone, status
) values (
  'cap_73000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'mobile', 'c5b-device-1', '[encrypted]',
  pg_temp.content_envelope(
    'cap_73000000000000000000000001',
    '11111111-1111-4111-8111-111111111111', 1, 'capture',
    'legacy.preview.v1'
  ),
  repeat('a', 64), 20, 'ai_assisted',
  '2026-08-30 20:00:00+00', 'America/Los_Angeles', 'queued'
);
insert into public.api_idempotency_records (
  user_id, idempotency_key, scope, request_hash, response_json, completed_at
) values (
  '11111111-1111-4111-8111-111111111111', 'c5b-legacy-idempotency',
  'create_note', repeat('b', 64),
  '{"noteId":"note_00000000000000000000000001","currentRevision":2}'::jsonb,
  '2026-08-30 20:00:00+00'
);
insert into public.generated_blocks (
  id, user_id, note_id, decision_id, kind, content, state,
  model_id, prompt_version
) values (
  'blk_73000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_00000000000000000000000001',
  'dec_00000000000000000000000001',
  'summary', 'Legacy block to encrypt', 'proposed', 'fixture-model', 'fixture-v1'
);
insert into public.captures (
  id, user_id, source, device_id, raw_text, content_envelope,
  content_fingerprint, content_length, privacy,
  client_created_at, client_timezone, status
) values (
  'cap_73000000000000000000000003',
  '22222222-2222-4222-8222-222222222222',
  'web', 'rollout-fixture', '[encrypted]',
  pg_temp.content_envelope(
    'cap_73000000000000000000000003',
    '22222222-2222-4222-8222-222222222222', 1, 'capture',
    'legacy.preview.v1'
  ),
  repeat('c', 64), 27, 'ai_assisted',
  '2026-08-30 20:00:00+00', 'UTC', 'queued'
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_73000000000000000000000003',
  'cap_73000000000000000000000003',
  '22222222-2222-4222-8222-222222222222',
  'created', 'routing-v1', 1
);

select has_table(
  'public', 'content_key_operation_reservations',
  'object-wrap reservations are durable'
);
select has_table(
  'public', 'encrypted_note_write_claims',
  'logical note write claims are durable'
);
select has_table(
  'public', 'content_encryption_verifications',
  'exact per-resource verification evidence is durable'
);
select ok(
  (
    select bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'content_key_operation_reservations',
        'encrypted_note_write_claims',
        'content_encryption_verifications'
      ])
  ),
  'all C.5b custody/proof relations have enabled and forced RLS'
);
select ok(
  not has_table_privilege(
    'service_role', 'public.content_encryption_verifications', 'SELECT'
  )
    and not has_table_privilege('service_role', 'public.notes', 'SELECT')
    and not has_table_privilege('service_role', 'public.notes', 'UPDATE')
    and not has_table_privilege('service_role', 'public.note_chunks', 'SELECT'),
  'service role has no direct content or verification table capability'
);
select ok(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relname = 'note_chunks'
  ),
  'legacy plaintext note chunks have enabled and forced RLS'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.reserve_content_key_operations(uuid,uuid,public.content_key_class,text,integer,integer)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.create_encrypted_note(uuid,text,text,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.list_content_encryption_backfill_candidates(uuid,text,text,integer)',
      'EXECUTE'
    ),
  'all new custody/write/backfill capabilities are service-only'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = any(array[
        'valid_encrypted_write_cipher',
        'consume_content_key_reservations',
        'record_content_encryption_verification',
        'content_encryption_readiness'
      ])
      and (
        has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege(
          'unfiled_index_worker', procedure.oid, 'EXECUTE'
        )
      )
  ),
  'private helpers are absent from every client/worker EXECUTE surface'
);
select is(
  (
    select count(*)
    from pg_proc as procedure
    where has_function_privilege(
      'unfiled_index_worker', procedure.oid, 'EXECUTE'
    )
      and procedure.oid = any(array[
        'public.claim_note_index_jobs(text,integer,integer)'::regprocedure,
        'public.heartbeat_note_index_job(text,uuid,integer)'::regprocedure,
        'public.commit_note_rag_index(text,uuid,text,jsonb,text,public.content_key_class,public.content_key_purpose,integer,integer)'::regprocedure,
        'public.fail_note_index_job(text,uuid,public.safe_error_code,boolean,integer)'::regprocedure,
        'public.recover_stale_note_index_jobs(integer)'::regprocedure,
        'public.list_active_note_rag_index(uuid,jsonb,integer,integer)'::regprocedure
      ])
  ),
  6::bigint,
  'the index worker retains exactly its six intended capabilities'
);

select is(
  pg_temp.caught_sqlstate($sql$
    update public.captures set device_id = 'shopping list milk and eggs'
    where id = 'cap_73000000000000000000000001'
  $sql$),
  '23514',
  'device metadata cannot be used as arbitrary plaintext storage'
);
select is(
  pg_temp.caught_sqlstate($sql$
    update public.captures set client_timezone = 'remember to buy milk'
    where id = 'cap_73000000000000000000000001'
  $sql$),
  '23514',
  'timezone metadata is constrained to an IANA-like identifier'
);
select is(
  pg_temp.caught_sqlstate($sql$
    update public.organization_decisions
    set reason_codes = array['free form content is forbidden']
    where id = 'dec_00000000000000000000000001'
  $sql$),
  '23514',
  'decision reasons accept only bounded safe codes'
);
select ok(
  col_description('public.profiles'::regclass, 2)
    like 'Account-profile metadata outside%',
  'the account display-name exclusion from content encryption is explicit'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000001',
    'ai_assisted', 'c5b.ai.object.v1', 1, 1
  )$$,
  '42501',
  'permission denied for function reserve_content_key_operations',
  'authenticated callers cannot reserve key operations for any owner'
);
select ok(
  exists (
    select 1 from public.notes
    where id = 'note_00000000000000000000000001'
  ),
  'expanded owners retain their legacy authenticated read path'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.register_user_content_key(
  owner_id, key_id, key_class, key_purpose, 1, root_arn,
  decode(repeat(material, 32), 'hex')
)
from (values
  ('11111111-1111-4111-8111-111111111111'::uuid,
    'c5b.ai.object.v1', 'ai_assisted'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000001', '11'),
  ('11111111-1111-4111-8111-111111111111'::uuid,
    'c5b.ai.mac.v1', 'ai_assisted'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000002', '12'),
  ('11111111-1111-4111-8111-111111111111'::uuid,
    'c5b.private.object.v1', 'private_manual'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000003', '13'),
  ('11111111-1111-4111-8111-111111111111'::uuid,
    'c5b.private.mac.v1', 'private_manual'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000004', '14'),
  ('22222222-2222-4222-8222-222222222222'::uuid,
    'c5b.other.ai.object.v1', 'ai_assisted'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000005', '15'),
  ('22222222-2222-4222-8222-222222222222'::uuid,
    'c5b.other.ai.mac.v1', 'ai_assisted'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000006', '16'),
  ('22222222-2222-4222-8222-222222222222'::uuid,
    'c5b.other.private.object.v1', 'private_manual'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000007', '17'),
  ('22222222-2222-4222-8222-222222222222'::uuid,
    'c5b.other.private.mac.v1', 'private_manual'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000008', '18')
) as key_fixture(
  owner_id, key_id, key_class, key_purpose, root_arn, material
);

select public.activate_user_content_key(owner_id, key_id)
from (values
  ('11111111-1111-4111-8111-111111111111'::uuid, 'c5b.ai.object.v1'),
  ('11111111-1111-4111-8111-111111111111'::uuid, 'c5b.ai.mac.v1'),
  ('11111111-1111-4111-8111-111111111111'::uuid, 'c5b.private.object.v1'),
  ('11111111-1111-4111-8111-111111111111'::uuid, 'c5b.private.mac.v1'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'c5b.other.ai.object.v1'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'c5b.other.ai.mac.v1'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'c5b.other.private.object.v1'),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'c5b.other.private.mac.v1')
) as key_fixture(owner_id, key_id);

insert into c5b_values(key, value) values (
  'active-key', public.get_active_user_content_key(
    '11111111-1111-4111-8111-111111111111',
    'ai_assisted', 'object_wrap'
  )
);
select ok(
  (select value ->> 'found' from c5b_values where key = 'active-key') = 'true'
    and (select value #>> '{record,ownerId}' from c5b_values
      where key = 'active-key') = '11111111-1111-4111-8111-111111111111'
    and (select value #>> '{record,purpose}' from c5b_values
      where key = 'active-key') = 'object_wrap'
    and (select value #>> '{record,encryptedKeyMaterial}' from c5b_values
      where key = 'active-key') !~ '[+/=]',
  'active key lookup returns the exact base64url ManagedKeyRecordV1 projection'
);
select is(
  public.get_user_content_key_by_id(
    '11111111-1111-4111-8111-111111111111', 'c5b.ai.object.v1',
    'ai_assisted', 'object_wrap'
  ) ->> 'keyVersion',
  '1',
  'key-id resolution needs no separately supplied key version'
);

insert into c5b_values(key, value) values (
  'reservation-create', public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000010',
    'ai_assisted', 'c5b.ai.object.v1', 1, 4
  )
);
select is(
  public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000010',
    'ai_assisted', 'c5b.ai.object.v1', 1, 4
  ) ->> 'replayed',
  'true',
  'an exact operation reservation replay never burns capacity twice'
);
select throws_ok(
  $$select public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000010',
    'ai_assisted', 'c5b.ai.object.v1', 1, 3
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a reservation identifier cannot be rebound to a different operation count'
);

select is(
  public.advance_content_encryption_rollout(
    '11111111-1111-4111-8111-111111111111', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'owner one enters encrypted dual-write atomically'
);
select throws_ok(
  $$select public.advance_content_encryption_rollout(
    '22222222-2222-4222-8222-222222222222', 'expanded', 'dual_write'
  )$$,
  'P0001', 'organizer_jobs_in_flight',
  'dual-write refuses to strand an in-flight legacy organizer job'
);
-- Fixture-only cleanup remains postgres-owned because C.5b intentionally
-- removes service direct-table capabilities.
reset role;
delete from public.captures
where id = 'cap_73000000000000000000000003';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.advance_content_encryption_rollout(
    '22222222-2222-4222-8222-222222222222', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'a clean second owner enters encrypted dual-write independently'
);

select is(
  (
    select expected_content ->> 'name'
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'space_display', null, 1
    )
  ),
  'Life',
  'bounded backfill candidates expose only exact owner/surface legacy content'
);
select ok(
  (
    select expected_content #>> '{snapshot,title}' = 'Shopping'
      and expected_content #>> '{snapshot,privacy}' = 'ai_assisted'
      and expected_content #> '{snapshot,tagIds}' is not null
      and operational ? 'legacyContentHash'
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'note_revision', null, 1
    )
  ),
  'revision candidates contain the full sealable snapshot and legacy CAS hash'
);
select ok(
  (
    select expected_content ->> 'action' = 'update'
      and expected_content #>> '{beforeSnapshot,privacy}' = 'ai_assisted'
      and expected_content #>> '{afterSnapshot,privacy}' = 'ai_assisted'
      and expected_content ?& array[
        'schemaVersion', 'beforeRevision', 'afterRevision', 'operations',
        'inverse', 'beforeSnapshot', 'afterSnapshot'
      ]
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'note_mutation', null, 1
    )
  ),
  'mutation candidates include full before/after snapshots for encrypted undo'
);
select ok(
  (
    select expected_content ->> 'condition'
        = expected_content ->> 'normalizedCondition'
      and expected_content -> 'aliases' = '[]'::jsonb
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'routing_rule', null, 1
    )
  ),
  'legacy routing rules use the explicit normalized-condition/empty-alias mapping'
);
select ok(
  (
    select expected_content ?& array['schemaVersion', 'title', 'bodyMarkdown',
        'structuredData']
      and not (expected_content ? 'updatedAt')
      and operational ? 'updatedAt'
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'note_content', null, 1
    )
  ),
  'note candidates seal the exact codec payload and keep CAS time operational'
);
select ok(
  (
    select expected_content ?& array[
        'schemaVersion', 'candidateManifest', 'signals', 'validatedPlan', 'band'
      ]
      and not (expected_content ? 'destinationNoteId')
      and operational ? 'destinationNoteId'
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'organization_decision', null, 1
    )
  ),
  'decision candidates separate exact protected payload from routing metadata'
);
select ok(
  (
    select expected_content ? 'schemaVersion'
      and expected_content ? 'content'
      and expected_content - array['schemaVersion', 'content'] = '{}'::jsonb
    from public.list_content_encryption_backfill_candidates(
      '11111111-1111-4111-8111-111111111111',
      'generated_block', null, 1
    )
  ),
  'generated-block candidates match the exact storage codec'
);

insert into c5b_values(key, value)
select 'space-candidate', jsonb_build_object(
  'cursor', cursor, 'resourceId', resource_id,
  'recordVersion', record_version, 'expectedContent', expected_content
)
from public.list_content_encryption_backfill_candidates(
  '11111111-1111-4111-8111-111111111111', 'space_display', null, 1
);
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000012',
  'private_manual', 'c5b.private.object.v1', 1, 1
);
select public.commit_content_encryption_backfill(
  '11111111-1111-4111-8111-111111111111', 'space_display',
  (select value ->> 'resourceId' from c5b_values where key = 'space-candidate'),
  (select (value ->> 'recordVersion')::integer
    from c5b_values where key = 'space-candidate'),
  (select value -> 'expectedContent' from c5b_values where key = 'space-candidate'),
  pg_temp.cipher(
    (select value ->> 'resourceId' from c5b_values where key = 'space-candidate'),
    '11111111-1111-4111-8111-111111111111',
    (select (value ->> 'recordVersion')::integer
      from c5b_values where key = 'space-candidate'),
    'space_display', 'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000012'
  ),
  pg_temp.mac('space-semantic', 'c5b.private.mac.v1', 'private_manual'),
  pg_temp.mac('space-verification', 'c5b.private.mac.v1', 'private_manual'),
  'c5b-space-backfill', null,
  (select value ->> 'cursor' from c5b_values where key = 'space-candidate'),
  false
);
insert into c5b_values(key, value)
select 'tag-candidate', jsonb_build_object(
  'cursor', cursor, 'resourceId', resource_id,
  'recordVersion', record_version, 'expectedContent', expected_content
)
from public.list_content_encryption_backfill_candidates(
  '11111111-1111-4111-8111-111111111111', 'tag_display', null, 1
);
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000013',
  'private_manual', 'c5b.private.object.v1', 1, 1
);
select public.commit_content_encryption_backfill(
  '11111111-1111-4111-8111-111111111111', 'tag_display',
  (select value ->> 'resourceId' from c5b_values where key = 'tag-candidate'),
  (select (value ->> 'recordVersion')::integer
    from c5b_values where key = 'tag-candidate'),
  (select value -> 'expectedContent' from c5b_values where key = 'tag-candidate'),
  pg_temp.cipher(
    (select value ->> 'resourceId' from c5b_values where key = 'tag-candidate'),
    '11111111-1111-4111-8111-111111111111',
    (select (value ->> 'recordVersion')::integer
      from c5b_values where key = 'tag-candidate'),
    'tag_display', 'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000013'
  ),
  pg_temp.mac('tag-semantic', 'c5b.private.mac.v1', 'private_manual'),
  pg_temp.mac('tag-verification', 'c5b.private.mac.v1', 'private_manual'),
  'c5b-tag-backfill',
  (select value ->> 'cursor' from c5b_values where key = 'space-candidate'),
  (select value ->> 'cursor' from c5b_values where key = 'tag-candidate'),
  false
);
select ok(
  (
    select projected.content_mac ->> 'mac'
        = pg_temp.mac(
          'space-semantic', 'c5b.private.mac.v1', 'private_manual'
        ) ->> 'mac'
      and projected.content_mac ->> 'mac'
        <> pg_temp.mac(
          'space-verification', 'c5b.private.mac.v1', 'private_manual'
        ) ->> 'mac'
    from public.list_encrypted_library_objects(
      '11111111-1111-4111-8111-111111111111', 'space_display', null, 1
    ) as projected
  ),
  'semantic and verification MACs use independent contract inputs'
);

insert into c5b_values(key, value)
select 'block-candidate', jsonb_build_object(
  'cursor', cursor, 'resourceId', resource_id,
  'recordVersion', record_version, 'expectedContent', expected_content
)
from public.list_content_encryption_backfill_candidates(
  '11111111-1111-4111-8111-111111111111', 'generated_block', null, 1
);
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000011',
  'ai_assisted', 'c5b.ai.object.v1', 1, 1
);
select is(
  public.commit_content_encryption_backfill(
    '11111111-1111-4111-8111-111111111111', 'generated_block',
    (select value ->> 'resourceId' from c5b_values where key = 'block-candidate'),
    1,
    (select value -> 'expectedContent' from c5b_values where key = 'block-candidate'),
    pg_temp.cipher(
      (select value ->> 'resourceId' from c5b_values where key = 'block-candidate'),
      '11111111-1111-4111-8111-111111111111', 1, 'generated_block',
      'c5b.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000011'
    ),
    null,
    pg_temp.mac('block-verification', 'c5b.ai.mac.v1', 'ai_assisted'),
    'c5b-block-backfill',
    (select value ->> 'cursor' from c5b_values where key = 'tag-candidate'),
    (select value ->> 'cursor' from c5b_values where key = 'block-candidate'),
    false
  ) ->> 'replayed',
  'false',
  'backfill stores a domain verification MAC separately from semantic MACs'
);
select throws_ok(
  $$select public.commit_content_encryption_backfill(
    '11111111-1111-4111-8111-111111111111', 'generated_block',
    (select value ->> 'resourceId' from c5b_values where key = 'block-candidate'),
    1,
    jsonb_set(
      (select value -> 'expectedContent' from c5b_values
        where key = 'block-candidate'),
      '{content}', '"tampered replay"'::jsonb
    ),
    pg_temp.cipher(
      (select value ->> 'resourceId' from c5b_values where key = 'block-candidate'),
      '11111111-1111-4111-8111-111111111111', 1, 'generated_block',
      'c5b.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000011'
    ),
    null,
    pg_temp.mac('block-verification', 'c5b.ai.mac.v1', 'ai_assisted'),
    'c5b-block-backfill',
    (select value ->> 'cursor' from c5b_values where key = 'tag-candidate'),
    (select value ->> 'cursor' from c5b_values where key = 'block-candidate'),
    false
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a backfill batch reference is bound to the complete canonical request'
);
select ok(
  public.get_encrypted_generated_blocks(
    '11111111-1111-4111-8111-111111111111', array[
      (select value ->> 'resourceId' from c5b_values where key = 'block-candidate')
    ]
  ) #>> '{blocks,0,contentCipher,keyClass}' = 'ai_assisted'
  and not (
    public.get_encrypted_generated_blocks(
      '11111111-1111-4111-8111-111111111111', array[
        (select value ->> 'resourceId' from c5b_values where key = 'block-candidate')
      ]
    ) #> '{blocks,0}' ? 'content'
  ),
  'receipt hydration returns exact owner-bound generated-block ciphertext only'
);
select throws_ok(
  $$select public.get_encrypted_generated_blocks(
    '22222222-2222-4222-8222-222222222222', array[
      (select value ->> 'resourceId' from c5b_values where key = 'block-candidate')
    ]
  )$$,
  'P0001', 'not_found',
  'generated-block hydration is all-or-nothing and owner scoped'
);
select throws_ok(
  $$select * from public.list_content_encryption_backfill_candidates(
    '11111111-1111-4111-8111-111111111111', 'not_a_surface', null, 1
  )$$,
  '22023', 'validation_failed',
  'backfill candidates reject arbitrary surfaces'
);
select throws_ok(
  $$select * from public.list_content_encryption_backfill_candidates(
    '11111111-1111-4111-8111-111111111111', 'space_display', 'bad', 1
  )$$,
  '22023', 'validation_failed',
  'backfill candidates reject malformed cursors'
);
select throws_ok(
  $$select * from public.list_content_encryption_backfill_candidates(
    '11111111-1111-4111-8111-111111111111', 'space_display', null, 51
  )$$,
  '22023', 'validation_failed',
  'backfill candidates are bounded to fifty records'
);
select throws_ok(
  $$select public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'create_encrypted_note', 'c5b-legacy-idempotency', null, 0,
    'ai_assisted',
    pg_temp.mac('legacy-retry', 'c5b.ai.mac.v1', 'ai_assisted')
  )$$,
  'P0001', 'legacy_idempotency_nonreplayable',
  'pre-cutover unkeyed idempotency records are permanently fail-closed'
);
select throws_ok(
  $$select public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'create_encrypted_note', 'shopping list milk and eggs', null, 0,
    'ai_assisted',
    pg_temp.mac('unsafe-metadata', 'c5b.ai.mac.v1', 'ai_assisted')
  )$$,
  '22023', 'validation_failed',
  'encrypted note idempotency metadata cannot carry arbitrary plaintext'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.create_note(
    'c5b-legacy-bypass', 'generic', 'plaintext title', 'plaintext body',
    null, 'ai_assisted', '{"schemaVersion":1}'::jsonb, '[]', '[]'
  )$$,
  'P0001', 'encrypted_write_required',
  'legacy authenticated note creation cannot race or bypass dual-write'
);
select throws_ok(
  $$select public.create_space(
    'c5b-legacy-space-bypass', 'plaintext space', null, null, 'a0'
  )$$,
  'P0001', 'encrypted_write_required',
  'legacy taxonomy creation fails closed instead of creating a plaintext-only row'
);
select throws_ok(
  $$select public.create_tag('c5b-legacy-tag-bypass', 'plaintext tag')$$,
  'P0001', 'encrypted_write_required',
  'legacy tag creation cannot bypass dual-write through SECURITY DEFINER'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5b_values(key, value) values (
  'create-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'create_encrypted_note', 'c5b-create', null, 0, 'ai_assisted',
    pg_temp.mac('logical-create', 'c5b.ai.mac.v1', 'ai_assisted')
  )
);
select ok(
  (select value ->> 'replayed' from c5b_values where key = 'create-claim')
      = 'false'
    and (select value ->> 'completed' from c5b_values
      where key = 'create-claim') = 'false'
    and (select value ->> 'noteId' from c5b_values
      where key = 'create-claim') ~ '^note_',
  'prepare atomically binds logical MAC and stable server-generated IDs'
);
select is(
  public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'create_encrypted_note', 'c5b-create', null, 0, 'ai_assisted',
    pg_temp.mac('logical-create', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'true',
  'a response-lost prepare resumes the same bound logical request'
);
select throws_ok(
  $$select public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'create_encrypted_note', 'c5b-create', null, 0, 'ai_assisted',
    pg_temp.mac('different-logical-create', 'c5b.ai.mac.v1', 'ai_assisted')
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a concurrent different request cannot hijack an incomplete claim'
);

insert into c5b_values(key, value)
select 'create-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', pg_temp.note_state(
    'C.5b encrypted note', 'ai_assisted'
  ) || jsonb_build_object(
    'spaceId', (
      select value ->> 'resourceId' from c5b_values where key = 'space-candidate'
    ),
    'tagIds', jsonb_build_array(
      (select value ->> 'resourceId' from c5b_values where key = 'tag-candidate')
    )
  ),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '11111111-1111-4111-8111-111111111111', 1, 'note_content',
    'c5b.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000010'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'manual',
    'actor', 'user:c5b',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '11111111-1111-4111-8111-111111111111', 1, 'note_revision',
      'c5b.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000010'
    ),
    'mac', pg_temp.mac('create-snapshot', 'c5b.ai.mac.v1', 'ai_assisted')
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', null,
    'operations', jsonb_build_array(jsonb_build_object('type', 'create_note')),
    'inverse', jsonb_build_array(),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '11111111-1111-4111-8111-111111111111', 1, 'note_mutation',
      'c5b.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000010'
    )
  ),
  'requestMac', pg_temp.mac(
    'logical-create', 'c5b.ai.mac.v1', 'ai_assisted'
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5b-create',
    '11111111-1111-4111-8111-111111111111', 1,
    'idempotency_response', 'c5b.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000010'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'create-note-payload', 'c5b.ai.mac.v1', 'ai_assisted'
    ),
    'noteMutation', pg_temp.mac(
      'create-mutation-payload', 'c5b.ai.mac.v1', 'ai_assisted'
    ),
    'idempotencyResponse', pg_temp.mac(
      'create-response-payload', 'c5b.ai.mac.v1', 'ai_assisted'
    )
  )
)
from c5b_values as claim where claim.key = 'create-claim';

select throws_ok(
  $$select public.create_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    'c5b-create',
    (select value from c5b_values where key = 'create-command')
      || jsonb_build_object('occurredAt', '2000-01-01T00:00:00.000Z')
  )$$,
  '22023', 'validation_failed',
  'write timestamps are stable claim data and cannot be caller-rebound'
);

insert into c5b_values(key, value)
select 'create-result', public.create_encrypted_note(
  '11111111-1111-4111-8111-111111111111',
  claim.value ->> 'noteId', 'c5b-create', command.value
)
from c5b_values as claim
cross join c5b_values as command
where claim.key = 'create-claim' and command.key = 'create-command';
select ok(
  (select value ->> 'currentRevision' from c5b_values
    where key = 'create-result') = '1'
    and (select value ->> 'replayed' from c5b_values
      where key = 'create-result') = 'false'
    and (select value #>> '{encryptedResponse,keyId}' from c5b_values
      where key = 'create-result') = 'c5b.ai.object.v1',
  'encrypted create atomically returns its stored encrypted response'
);
select ok(
  (
    public.get_encrypted_note(
      '11111111-1111-4111-8111-111111111111',
      (select value ->> 'noteId' from c5b_values where key = 'create-claim')
    ) ->> 'updatedAt'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'create-claim'
  )
  and (
    public.get_encrypted_note_mutation(
      '11111111-1111-4111-8111-111111111111',
      (select value ->> 'mutationId' from c5b_values where key = 'create-claim')
    ) ->> 'createdAt'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'create-claim'
  )
  and (
    public.list_encrypted_note_revisions(
      '11111111-1111-4111-8111-111111111111',
      (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
      null, 1
    ) #>> '{revisions,0,createdAt}'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'create-claim'
  ),
  'claim occurredAt is the exact note, revision, and mutation timestamp'
);
select ok(
  public.get_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim')
  ) #>> '{space,currentRevision}' = (
    select value ->> 'recordVersion' from c5b_values where key = 'space-candidate'
  )
  and public.get_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim')
  ) #>> '{tags,0,currentRevision}' = (
    select value ->> 'recordVersion' from c5b_values where key = 'tag-candidate'
  )
  and public.get_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim')
  ) #>> '{tags,0,createdAt}' is not null,
  'note detail binds nested taxonomy ciphers to authoritative versions and tag creation time'
);
select ok(
  jsonb_typeof(
    public.get_encrypted_note_mutation(
      '11111111-1111-4111-8111-111111111111',
      (select value ->> 'mutationId' from c5b_values where key = 'create-claim')
    ) -> 'beforeSnapshot'
  ) = 'null'
  and public.get_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'mutationId' from c5b_values where key = 'create-claim')
  ) #>> '{afterSnapshot,privacy}' = 'ai_assisted',
  'mutation reads expose transition privacy and null create-before snapshots'
);
select is(
  (
    select count(*)
    from public.list_encrypted_library_objects(
      '11111111-1111-4111-8111-111111111111',
      'note_mutation', null, 50
    )
    where resource_id = (
      select value ->> 'mutationId' from c5b_values where key = 'create-claim'
    )
  ),
  1::bigint,
  'current note, immutable mutation, revision, and response commit together'
);
select is(
  public.create_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    'c5b-create',
    jsonb_build_object(
      'requestMac', pg_temp.mac(
        'logical-create', 'c5b.ai.mac.v1', 'ai_assisted'
      ),
      'freshRandomizedOutputThatMustBeIgnored', true
    )
  ) ->> 'replayed',
  'true',
  'completed create replay precedes fresh randomized output validation'
);
select throws_ok(
  $$select public.create_encrypted_note(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    'c5b-create', jsonb_build_object(
      'requestMac', pg_temp.mac(
        'tampered-logical-create', 'c5b.ai.mac.v1', 'ai_assisted'
      )
    )
  )$$,
  'P0001', 'invalid_idempotency_key',
  'completed replay still compares the original keyed logical request MAC'
);
select is(
  public.get_encrypted_note_write_claim(
    '22222222-2222-4222-8222-222222222222',
    'create_encrypted_note', 'c5b-create'
  ) ->> 'found',
  'false',
  'claim lookup is owner-scoped without cross-user leakage'
);

select ok(
  (public.get_content_encryption_rollout(
    '11111111-1111-4111-8111-111111111111'
  ) #>> '{readiness,missingBySurface,note_content}')::integer >= 1,
  'logical request MAC is not mislabeled as note payload verification evidence'
);

select is(
  public.verify_encrypted_content_object(
    '11111111-1111-4111-8111-111111111111', 'note_content',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'), 1,
    (select value #> '{noteCipher,envelope}' from c5b_values
      where key = 'create-command'),
    pg_temp.mac('verified-note-content', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'false',
  'content verification binds an exact stored envelope under row lock'
);
select is(
  public.verify_encrypted_content_object(
    '11111111-1111-4111-8111-111111111111', 'note_mutation',
    (select value ->> 'mutationId' from c5b_values where key = 'create-claim'), 1,
    (select value #> '{mutation,cipher,envelope}' from c5b_values
      where key = 'create-command'),
    pg_temp.mac('verified-create-mutation', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'false',
  'mutation payload receives separate canonical verification evidence'
);
select is(
  public.verify_encrypted_content_object(
    '11111111-1111-4111-8111-111111111111', 'idempotency_response',
    'idempotency:c5b-create', 1,
    (select value #> '{responseCipher,envelope}' from c5b_values
      where key = 'create-command'),
    pg_temp.mac('verified-create-response', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'false',
  'encrypted replay response receives its own payload verification evidence'
);
select is(
  public.verify_encrypted_content_object(
    '11111111-1111-4111-8111-111111111111', 'note_content',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'), 1,
    (select value #> '{noteCipher,envelope}' from c5b_values
      where key = 'create-command'),
    pg_temp.mac('verified-note-content', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'true',
  'exact verification replay does not advance proof counters twice'
);
select throws_ok(
  $$select public.verify_encrypted_content_object(
    '11111111-1111-4111-8111-111111111111', 'note_content',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'), 1,
    pg_temp.content_envelope(
      (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
      '11111111-1111-4111-8111-111111111111', 1, 'note_content',
      'c5b.ai.object.v1', 'Z'
    ),
    pg_temp.mac('verified-note-content', 'c5b.ai.mac.v1', 'ai_assisted')
  )$$,
  'P0001', 'stale_envelope',
  'verification rejects a same-version but different randomized envelope'
);

-- A legacy capture can be resealed only against the exact global envelope and
-- fingerprint observed by the service.
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000020',
  'ai_assisted', 'c5b.ai.object.v1', 1, 1
);
insert into c5b_values(key, value) values (
  'reseal-cipher', pg_temp.cipher(
    'cap_73000000000000000000000001',
    '11111111-1111-4111-8111-111111111111', 1, 'capture',
    'c5b.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000020', 'R'
  )
);
select is(
  public.reseal_capture_content(
    '11111111-1111-4111-8111-111111111111',
    'cap_73000000000000000000000001',
    pg_temp.content_envelope(
      'cap_73000000000000000000000001',
      '11111111-1111-4111-8111-111111111111', 1, 'capture',
      'legacy.preview.v1'
    ),
    repeat('a', 64),
    (select value from c5b_values where key = 'reseal-cipher'),
    pg_temp.mac('resealed-capture-content', 'c5b.ai.mac.v1', 'ai_assisted'),
    pg_temp.mac('resealed-capture-proof', 'c5b.ai.mac.v1', 'ai_assisted')
  ) ->> 'replayed',
  'false',
  'capture reseal atomically replaces legacy global-key material with owner keys'
);
select throws_ok(
  $$select public.reseal_capture_content(
    '22222222-2222-4222-8222-222222222222',
    'cap_73000000000000000000000001', '{}'::jsonb, repeat('a',64),
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
  )$$,
  'P0001', 'not_found',
  'capture reseal never exposes or updates another owner record'
);

-- Privacy transition provenance is claim-bound. Both directions retain the
-- sticky private history class, including replay after MAC-key rotation.
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000021',
  'private_manual', 'c5b.private.object.v1', 1, 4
);
insert into c5b_values(key, value) values (
  'ai-private-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-ai-private',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    1, 'private_manual',
    pg_temp.mac(
      'logical-ai-private', 'c5b.private.mac.v1', 'private_manual'
    )
  )
);
select ok(
  (select value ->> 'sourcePrivacy' from c5b_values
    where key = 'ai-private-claim') = 'ai_assisted'
  and (select value ->> 'targetPrivacy' from c5b_values
    where key = 'ai-private-claim') = 'private_manual'
  and (select value ->> 'historyKeyClass' from c5b_values
    where key = 'ai-private-claim') = 'private_manual',
  'AI-to-private prepare binds exact source privacy and sticky history class'
);
insert into c5b_values(key, value)
select 'ai-private-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', pg_temp.note_state('Now private', 'private_manual'),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '11111111-1111-4111-8111-111111111111', 2, 'note_content',
    'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000021'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'manual',
    'actor', 'user:c5b',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '11111111-1111-4111-8111-111111111111', 2, 'note_revision',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000021'
    ),
    'mac', pg_temp.mac(
      'ai-private-snapshot', 'c5b.private.mac.v1', 'private_manual'
    )
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', null,
    'operations', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'private_manual'
    )),
    'inverse', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'ai_assisted'
    )),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '11111111-1111-4111-8111-111111111111', 2, 'note_mutation',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000021'
    )
  ),
  'requestMac', pg_temp.mac(
    'logical-ai-private', 'c5b.private.mac.v1', 'private_manual'
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5b-ai-private',
    '11111111-1111-4111-8111-111111111111', 1,
    'idempotency_response', 'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000021'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'ai-private-note-proof', 'c5b.private.mac.v1', 'private_manual'
    ),
    'noteMutation', pg_temp.mac(
      'ai-private-mutation-proof', 'c5b.private.mac.v1', 'private_manual'
    ),
    'idempotencyResponse', pg_temp.mac(
      'ai-private-response-proof', 'c5b.private.mac.v1', 'private_manual'
    )
  )
)
from c5b_values as claim where claim.key = 'ai-private-claim';
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    1, 'c5b-ai-private',
    (select value from c5b_values where key = 'ai-private-command')
  ) ->> 'currentRevision',
  '2',
  'AI-to-private mutation commits all encrypted aggregate surfaces atomically'
);

select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000022',
  'ai_assisted', 'c5b.ai.object.v1', 1, 1
);
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000023',
  'private_manual', 'c5b.private.object.v1', 1, 3
);
insert into c5b_values(key, value) values (
  'private-ai-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-private-ai',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    2, 'ai_assisted',
    pg_temp.mac(
      'logical-private-ai', 'c5b.private.mac.v1', 'private_manual'
    )
  )
);
select ok(
  (select value ->> 'sourcePrivacy' from c5b_values
    where key = 'private-ai-claim') = 'private_manual'
  and (select value ->> 'targetPrivacy' from c5b_values
    where key = 'private-ai-claim') = 'ai_assisted'
  and (select value ->> 'historyKeyClass' from c5b_values
    where key = 'private-ai-claim') = 'private_manual',
  'private-to-AI prepare retains private history and exact source privacy'
);
insert into c5b_values(key, value)
select 'private-ai-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', pg_temp.note_state('AI again', 'ai_assisted'),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '11111111-1111-4111-8111-111111111111', 3, 'note_content',
    'c5b.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000022'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'manual',
    'actor', 'user:c5b',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '11111111-1111-4111-8111-111111111111', 3, 'note_revision',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000023'
    ),
    'mac', pg_temp.mac(
      'private-ai-snapshot', 'c5b.private.mac.v1', 'private_manual'
    )
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', null,
    'operations', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'ai_assisted'
    )),
    'inverse', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'private_manual'
    )),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '11111111-1111-4111-8111-111111111111', 3, 'note_mutation',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000023'
    )
  ),
  'requestMac', pg_temp.mac(
    'logical-private-ai', 'c5b.private.mac.v1', 'private_manual'
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5b-private-ai',
    '11111111-1111-4111-8111-111111111111', 1,
    'idempotency_response', 'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000023'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'private-ai-note-proof', 'c5b.ai.mac.v1', 'ai_assisted'
    ),
    'noteMutation', pg_temp.mac(
      'private-ai-mutation-proof', 'c5b.private.mac.v1', 'private_manual'
    ),
    'idempotencyResponse', pg_temp.mac(
      'private-ai-response-proof', 'c5b.private.mac.v1', 'private_manual'
    )
  )
)
from c5b_values as claim where claim.key = 'private-ai-claim';
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    2, 'c5b-private-ai',
    (select value from c5b_values where key = 'private-ai-command')
  ) ->> 'currentRevision',
  '3',
  'private-to-AI current content uses AI key while history remains private'
);
select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'c5b.private.mac.v2', 'private_manual', 'content_mac', 2,
  'arn:aws:kms:us-west-2:123456789012:key/73000000-0000-4000-8000-000000000024',
  decode(repeat('24', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'c5b.private.mac.v2'
);
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    1, 'c5b-ai-private', jsonb_build_object(
      'requestMac', pg_temp.mac(
        'logical-ai-private', 'c5b.private.mac.v1', 'private_manual'
      )
    )
  ) ->> 'replayed',
  'true',
  'AI-to-private replay authenticates with its stored retired MAC key'
);
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    2, 'c5b-private-ai', jsonb_build_object(
      'requestMac', pg_temp.mac(
        'logical-private-ai', 'c5b.private.mac.v1', 'private_manual'
      )
    )
  ) ->> 'replayed',
  'true',
  'private-to-AI replay survives revision advance and MAC-key rotation'
);
select public.reserve_content_key_operations(
  '11111111-1111-4111-8111-111111111111',
  '73000000-0000-4000-8000-000000000025',
  'private_manual', 'c5b.private.object.v1', 1, 4
);
insert into c5b_values(key, value) values (
  'undo-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-undo-private-ai',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    3, 'private_manual',
    pg_temp.mac(
      'logical-undo-private-ai', 'c5b.private.mac.v2', 'private_manual', 2
    )
  )
);
insert into c5b_values(key, value)
select 'undo-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', pg_temp.note_state('Undo to private', 'private_manual'),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '11111111-1111-4111-8111-111111111111', 4, 'note_content',
    'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000025'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'undo',
    'actor', 'user:c5b',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '11111111-1111-4111-8111-111111111111', 4, 'note_revision',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000025'
    ),
    'mac', pg_temp.mac(
      'undo-snapshot', 'c5b.private.mac.v2', 'private_manual', 2
    )
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', (
      select value ->> 'mutationId' from c5b_values
      where key = 'private-ai-claim'
    ),
    'operations', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'private_manual'
    )),
    'inverse', jsonb_build_array(jsonb_build_object(
      'type', 'set_privacy', 'privacy', 'ai_assisted'
    )),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '11111111-1111-4111-8111-111111111111', 4, 'note_mutation',
      'c5b.private.object.v1', 'private_manual',
      '73000000-0000-4000-8000-000000000025'
    )
  ),
  'requestMac', pg_temp.mac(
    'logical-undo-private-ai', 'c5b.private.mac.v2', 'private_manual', 2
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5b-undo-private-ai',
    '11111111-1111-4111-8111-111111111111', 1,
    'idempotency_response', 'c5b.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000025'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'undo-note-proof', 'c5b.private.mac.v2', 'private_manual', 2
    ),
    'noteMutation', pg_temp.mac(
      'undo-mutation-proof', 'c5b.private.mac.v2', 'private_manual', 2
    ),
    'idempotencyResponse', pg_temp.mac(
      'undo-response-proof', 'c5b.private.mac.v2', 'private_manual', 2
    )
  )
)
from c5b_values as claim where claim.key = 'undo-claim';
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    3, 'c5b-undo-private-ai',
    (select value from c5b_values where key = 'undo-command')
  ) ->> 'currentRevision',
  '4',
  'undo atomically creates a new encrypted revision and advances the note'
);
select ok(
  (
    public.get_encrypted_note_mutation(
      '11111111-1111-4111-8111-111111111111',
      (select value ->> 'mutationId' from c5b_values
        where key = 'private-ai-claim')
    ) ->> 'undoneAt'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'undo-claim'
  ),
  'undo stamps the exact target mutation at the claim timestamp'
);
select is(
  public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    3, 'c5b-undo-private-ai', jsonb_build_object(
      'requestMac', pg_temp.mac(
        'logical-undo-private-ai', 'c5b.private.mac.v2', 'private_manual', 2
      )
    )
  ) ->> 'replayed',
  'true',
  'completed undo replays before the one-time target check'
);
insert into c5b_values(key, value) values (
  'undo-already-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-undo-already',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'private_manual',
    pg_temp.mac(
      'logical-undo-already', 'c5b.private.mac.v2', 'private_manual', 2
    )
  )
);
select throws_ok(
  $$select public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'c5b-undo-already', pg_temp.rebind_undo_command(
      (select value from c5b_values where key = 'undo-command'),
      (select value from c5b_values where key = 'undo-already-claim'),
      pg_temp.mac(
        'logical-undo-already', 'c5b.private.mac.v2', 'private_manual', 2
      ),
      (select value ->> 'mutationId' from c5b_values
        where key = 'private-ai-claim')
    )
  )$$,
  'P0001', 'already_undone',
  'a different command cannot undo an already-undone mutation'
);
insert into c5b_values(key, value) values (
  'undo-stale-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-undo-stale',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'private_manual',
    pg_temp.mac(
      'logical-undo-stale', 'c5b.private.mac.v2', 'private_manual', 2
    )
  )
);
select throws_ok(
  $$select public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'c5b-undo-stale', pg_temp.rebind_undo_command(
      (select value from c5b_values where key = 'undo-command'),
      (select value from c5b_values where key = 'undo-stale-claim'),
      pg_temp.mac(
        'logical-undo-stale', 'c5b.private.mac.v2', 'private_manual', 2
      ),
      (select value ->> 'mutationId' from c5b_values
        where key = 'ai-private-claim')
    )
  )$$,
  'P0001', 'stale_revision',
  'undo target must be the mutation that produced the current revision'
);
insert into c5b_values(key, value)
select 'wrong-note-target', jsonb_build_object('mutationId', resource_id)
from public.list_content_encryption_backfill_candidates(
  '11111111-1111-4111-8111-111111111111', 'note_mutation', null, 50
)
where operational ->> 'noteId' <> (
  select value ->> 'noteId' from c5b_values where key = 'create-claim'
)
limit 1;
insert into c5b_values(key, value) values (
  'undo-wrong-note-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-undo-wrong-note',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'private_manual',
    pg_temp.mac(
      'logical-undo-wrong-note', 'c5b.private.mac.v2', 'private_manual', 2
    )
  )
);
select throws_ok(
  $$select public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'c5b-undo-wrong-note', pg_temp.rebind_undo_command(
      (select value from c5b_values where key = 'undo-command'),
      (select value from c5b_values where key = 'undo-wrong-note-claim'),
      pg_temp.mac(
        'logical-undo-wrong-note', 'c5b.private.mac.v2', 'private_manual', 2
      ),
      (select value ->> 'mutationId' from c5b_values
        where key = 'wrong-note-target')
    )
  )$$,
  'P0001', 'invalid_undo_target',
  'an owned mutation from another note cannot be used as an undo target'
);

-- Build one fully verified encrypted aggregate for the clean owner so the
-- encrypted-read transition and direct-read denial can be proven end to end.
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '73000000-0000-4000-8000-000000000030',
  'ai_assisted', 'c5b.other.ai.object.v1', 1, 4
);
insert into c5b_values(key, value) values (
  'other-claim', public.prepare_encrypted_note_write(
    '22222222-2222-4222-8222-222222222222',
    'create_encrypted_note', 'c5b-other-create', null, 0, 'ai_assisted',
    pg_temp.mac(
      'other-logical-create', 'c5b.other.ai.mac.v1', 'ai_assisted'
    )
  )
);
insert into c5b_values(key, value)
select 'other-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', pg_temp.note_state('Other encrypted note', 'ai_assisted'),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '22222222-2222-4222-8222-222222222222', 1, 'note_content',
    'c5b.other.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000030'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'manual',
    'actor', 'user:c5b-other',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '22222222-2222-4222-8222-222222222222', 1, 'note_revision',
      'c5b.other.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000030'
    ),
    'mac', pg_temp.mac(
      'other-snapshot', 'c5b.other.ai.mac.v1', 'ai_assisted'
    )
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', null,
    'operations', jsonb_build_array(jsonb_build_object('type', 'create_note')),
    'inverse', jsonb_build_array(),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '22222222-2222-4222-8222-222222222222', 1, 'note_mutation',
      'c5b.other.ai.object.v1', 'ai_assisted',
      '73000000-0000-4000-8000-000000000030'
    )
  ),
  'requestMac', pg_temp.mac(
    'other-logical-create', 'c5b.other.ai.mac.v1', 'ai_assisted'
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5b-other-create',
    '22222222-2222-4222-8222-222222222222', 1,
    'idempotency_response', 'c5b.other.ai.object.v1', 'ai_assisted',
    '73000000-0000-4000-8000-000000000030'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'other-note-payload', 'c5b.other.ai.mac.v1', 'ai_assisted'
    ),
    'noteMutation', pg_temp.mac(
      'other-mutation-payload', 'c5b.other.ai.mac.v1', 'ai_assisted'
    ),
    'idempotencyResponse', pg_temp.mac(
      'other-response-payload', 'c5b.other.ai.mac.v1', 'ai_assisted'
    )
  )
)
from c5b_values as claim where claim.key = 'other-claim';
select public.create_encrypted_note(
  '22222222-2222-4222-8222-222222222222',
  (select value ->> 'noteId' from c5b_values where key = 'other-claim'),
  'c5b-other-create',
  (select value from c5b_values where key = 'other-command')
);
-- Simulate a pre-cutover search artifact that remains for the bounded rollback
-- window. encrypted_read must fence this duplicate plaintext just as strictly
-- as the legacy title/body columns on notes.
reset role;
insert into public.note_chunks (
  id, note_id, user_id, revision, ordinal, text_hash, content
) values (
  'chk_73000000000000000000000002',
  (select value ->> 'noteId' from c5b_values where key = 'other-claim'),
  '22222222-2222-4222-8222-222222222222', 1, 0, repeat('f', 64),
  'plaintext chunk must be fenced after encrypted read'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5b_values(key, value) values (
  'undo-cross-owner-claim', public.prepare_encrypted_note_write(
    '11111111-1111-4111-8111-111111111111',
    'apply_encrypted_note_mutation', 'c5b-undo-cross-owner',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'private_manual',
    pg_temp.mac(
      'logical-undo-cross-owner',
      'c5b.private.mac.v2', 'private_manual', 2
    )
  )
);
select throws_ok(
  $$select public.apply_encrypted_note_mutation(
    '11111111-1111-4111-8111-111111111111',
    (select value ->> 'noteId' from c5b_values where key = 'create-claim'),
    4, 'c5b-undo-cross-owner', pg_temp.rebind_undo_command(
      (select value from c5b_values where key = 'undo-command'),
      (select value from c5b_values where key = 'undo-cross-owner-claim'),
      pg_temp.mac(
        'logical-undo-cross-owner',
        'c5b.private.mac.v2', 'private_manual', 2
      ),
      (select value ->> 'mutationId' from c5b_values where key = 'other-claim')
    )
  )$$,
  'P0001', 'not_found',
  'cross-owner mutation IDs are indistinguishable from missing undo targets'
);
select public.verify_encrypted_content_object(
  '22222222-2222-4222-8222-222222222222', 'note_content',
  (select value ->> 'noteId' from c5b_values where key = 'other-claim'), 1,
  (select value #> '{noteCipher,envelope}' from c5b_values
    where key = 'other-command'),
  pg_temp.mac(
    'other-verified-note', 'c5b.other.ai.mac.v1', 'ai_assisted'
  )
);
select public.verify_encrypted_content_object(
  '22222222-2222-4222-8222-222222222222', 'note_mutation',
  (select value ->> 'mutationId' from c5b_values where key = 'other-claim'), 1,
  (select value #> '{mutation,cipher,envelope}' from c5b_values
    where key = 'other-command'),
  pg_temp.mac(
    'other-verified-mutation', 'c5b.other.ai.mac.v1', 'ai_assisted'
  )
);
select public.verify_encrypted_content_object(
  '22222222-2222-4222-8222-222222222222', 'idempotency_response',
  'idempotency:c5b-other-create', 1,
  (select value #> '{responseCipher,envelope}' from c5b_values
    where key = 'other-command'),
  pg_temp.mac(
    'other-verified-response', 'c5b.other.ai.mac.v1', 'ai_assisted'
  )
);

select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '73000000-0000-4000-8000-000000000031',
  'private_manual', 'c5b.other.private.object.v1', 1, 2
);
insert into c5b_values(key, value)
with event as (
  select to_char(
    date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) as occurred_at
)
select 'private-capture-command', jsonb_build_object(
  'clientCaptureId', 'cap_73000000000000000000000002',
  'jobId', 'job_73000000000000000000000002',
  'occurredAt', event.occurred_at,
  'contentCipher', pg_temp.cipher(
    'cap_73000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1, 'capture',
    'c5b.other.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000031'
  ),
  'contentMac', pg_temp.mac(
    'private-capture-content', 'c5b.other.private.mac.v1', 'private_manual'
  ),
  'contentLength', 18,
  'source', 'ios_lock_screen_widget',
  'deviceId', 'lockscreen-widget',
  'clientCreatedAt', event.occurred_at,
  'clientTimezone', 'UTC',
  'privacy', 'private_manual',
  'explicitDestinationNoteId', null,
  'expansionDisabled', true,
  'privateReceiptCipher', pg_temp.cipher(
    'cap_73000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 1, 'capture_receipt',
    'c5b.other.private.object.v1', 'private_manual',
    '73000000-0000-4000-8000-000000000031'
  ),
  'privateReceiptVerificationMac', pg_temp.mac(
    'private-receipt-proof', 'c5b.other.private.mac.v1', 'private_manual'
  )
)
from event;
select ok(
  public.create_encrypted_capture_with_job(
    '22222222-2222-4222-8222-222222222222',
    (select value from c5b_values where key = 'private-capture-command')
  ) = jsonb_build_object(
    'captureId', 'cap_73000000000000000000000002',
    'jobId', 'job_73000000000000000000000002', 'replayed', false
  ),
  'private capture persists caller-frozen job ID and preseal event time'
);
select ok(
  (
    public.get_encrypted_capture_detail(
      '22222222-2222-4222-8222-222222222222',
      'cap_73000000000000000000000002'
    ) #>> '{capture,receivedAt}'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'private-capture-command'
  )
  and public.get_encrypted_capture_detail(
    '22222222-2222-4222-8222-222222222222',
    'cap_73000000000000000000000002'
  ) #>> '{capture,receipt,createdAt}' is not null
  and (
    public.get_encrypted_capture_detail(
      '22222222-2222-4222-8222-222222222222',
      'cap_73000000000000000000000002'
    ) #>> '{capture,receipt,createdAt}'
  )::timestamptz = (
    select (value ->> 'occurredAt')::timestamptz
    from c5b_values where key = 'private-capture-command'
  )
  and not (
    public.get_encrypted_capture_detail(
      '22222222-2222-4222-8222-222222222222',
      'cap_73000000000000000000000002'
    ) #> '{capture,receipt}' ? 'headline'
  ),
  'encrypted capture detail returns managed ciphers and no receipt plaintext'
);
select is(
  public.create_encrypted_capture_with_job(
    '22222222-2222-4222-8222-222222222222',
    (select value from c5b_values where key = 'private-capture-command')
  ) ->> 'replayed',
  'true',
  'capture replay returns the same deterministic job without consuming again'
);
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '22222222-2222-4222-8222-222222222222',
    jsonb_set(
      (select value from c5b_values where key = 'private-capture-command'),
      '{jobId}', '"job_73000000000000000000000003"'::jsonb
    )
  )$$,
  'P0001', 'invalid_idempotency_key',
  'capture replay cannot rebind the receipt job identifier'
);
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '22222222-2222-4222-8222-222222222222',
    (select value from c5b_values where key = 'private-capture-command')
      || jsonb_build_object(
        'clientCaptureId', 'cap_73000000000000000000000004',
        'jobId', 'job_73000000000000000000000004',
        'privacy', 'ai_assisted',
        'privateReceiptCipher', null,
        'privateReceiptVerificationMac', null
      )
  )$$,
  '22023', 'invalid_encrypted_field',
  'fresh AI capture rejects private-manual cipher and MAC material'
);
select ok(
  public.list_encrypted_captures(
    '22222222-2222-4222-8222-222222222222', null, null, 10
  ) #>> '{captures,0,contentCipher,keyClass}' is not null
  and public.get_encrypted_capture_receipt(
    '22222222-2222-4222-8222-222222222222',
    'cap_73000000000000000000000002'
  ) #>> '{receipt,privacy}' = 'private_manual',
  'encrypted capture list and receipt projections expose exact key metadata'
);
select is(
  public.complete_content_encryption_backfill(
    '22222222-2222-4222-8222-222222222222',
    'c5b-other-complete', null
  ) ->> 'complete',
  'true',
  'authoritative exact evidence completes a clean owner backfill'
);
select is(
  public.complete_content_encryption_backfill(
    '22222222-2222-4222-8222-222222222222',
    'c5b-other-complete', null
  ) ->> 'replayed',
  'true',
  'an exact backfill-completion retry is replay safe'
);
select throws_ok(
  $$select public.complete_content_encryption_backfill(
    '22222222-2222-4222-8222-222222222222',
    'c5b-other-complete-rebound', null
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a completed backfill cannot accept a rebound batch reference'
);
select is(
  public.advance_content_encryption_rollout(
    '22222222-2222-4222-8222-222222222222',
    'dual_write', 'encrypted_read'
  ) ->> 'readMode',
  'encrypted',
  'encrypted-read advances only after all required surfaces are verified'
);
select is(
  public.advance_content_encryption_rollout(
    '22222222-2222-4222-8222-222222222222',
    'dual_write', 'encrypted_read'
  ) ->> 'readMode',
  'encrypted',
  'rollout replay returns the same normalized read mode'
);
select is(
  public.get_encrypted_note(
    '22222222-2222-4222-8222-222222222222',
    (select value ->> 'noteId' from c5b_values where key = 'other-claim')
  ) ->> 'currentRevision',
  '1',
  'service encrypted read returns ciphertext and operational metadata'
);
select throws_ok(
  $$select public.list_captures(
    '22222222-2222-4222-8222-222222222222', null, 10, null, null, null
  )$$,
  'P0001', 'encrypted_content_required',
  'legacy capture list cannot expose old envelope or receipt projections after cutover'
);
select is(
  public.get_encrypted_capture_detail(
    '22222222-2222-4222-8222-222222222222',
    'cap_73000000000000000000000002'
  ) #>> '{capture,receipt,receiptCipher,keyClass}',
  'private_manual',
  'managed encrypted capture detail remains readable after cutover'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select is(
  (
    select count(*) from public.notes
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  0::bigint,
  'authenticated raw SELECT cannot read an encrypted-read owner plaintext row'
);
select is(
  (
    select count(*) from public.note_chunks
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  0::bigint,
  'authenticated raw SELECT cannot read legacy plaintext note chunks after cutover'
);
select throws_ok(
  $$select count(*) from public.captures
    where user_id = '22222222-2222-4222-8222-222222222222'$$,
  '42501',
  'permission denied for table captures',
  'authenticated raw SELECT cannot read encrypted capture metadata or legacy envelopes'
);
select throws_ok(
  $$select * from public.search_notes('encrypted')$$,
  'P0001', 'encrypted_content_required',
  'legacy SECURITY DEFINER search explicitly rejects encrypted-read owners'
);
select throws_ok(
  $$select public.get_encrypted_note(
    '22222222-2222-4222-8222-222222222222',
    (select value ->> 'noteId' from c5b_values where key = 'other-claim')
  )$$,
  '42501',
  'permission denied for function get_encrypted_note',
  'encrypted read projection remains a reviewed server capability, not client SQL'
);

reset role;
select is(
  (
    select wrap_operations
    from public.user_content_keys
    where user_id = '11111111-1111-4111-8111-111111111111'
      and key_id = 'c5b.ai.object.v1'
  ),
  7::bigint,
  'reservation replay and consumption burn exactly the intended wrap count'
);
update public.user_content_keys
set wrap_operations = wrap_operation_limit - 1
where user_id = '11111111-1111-4111-8111-111111111111'
  and key_id = 'c5b.ai.object.v1';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000040',
    'ai_assisted', 'c5b.ai.object.v1', 1, 1
  ) ->> 'operationCount',
  '1',
  'the final object-wrap slot is atomically reservable once'
);
select throws_ok(
  $$select public.reserve_content_key_operations(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4000-8000-000000000041',
    'ai_assisted', 'c5b.ai.object.v1', 1, 1
  )$$,
  'P0001', 'key_operation_limit',
  'the operation limit rejects every reservation after the final slot'
);
select ok(
  strpos(
    lower(pg_get_functiondef(
      'public.reserve_content_key_operations(uuid,uuid,public.content_key_class,text,integer,integer)'::regprocedure
    )),
    'for update'
  ) > 0
    and strpos(
      lower(pg_get_functiondef(
        'public.reserve_content_key_operations(uuid,uuid,public.content_key_class,text,integer,integer)'::regprocedure
      )),
      'pg_advisory_xact_lock'
    ) > 0,
  'reservation capacity and key rotation share row/advisory serialization'
);

reset role;
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_capture_storage_attestation(uuid,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.get_capture_storage_attestation(uuid,text)',
    'execute'
  ),
  'capture storage attestation is a service-only content-free capability'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.get_capture_storage_attestation(
    '11111111-1111-4111-8111-111111111111',
    'cap_73000000000000000000000001'
  ),
  jsonb_build_object(
    'captureId', 'cap_73000000000000000000000001',
    'rawTextTombstoned', true,
    'envelopeV1', true,
    'suiteA256Gcm', true,
    'fingerprintShapeValid', true
  ),
  'storage attestation proves the tombstone and encryption shape without returning content'
);
select throws_ok(
  $$select public.get_capture_storage_attestation(
    '22222222-2222-4222-8222-222222222222',
    'cap_73000000000000000000000001'
  )$$,
  'P0001', 'not_found',
  'capture storage attestation remains owner bound'
);
reset role;
select * from finish();
rollback;
