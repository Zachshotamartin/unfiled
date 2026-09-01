create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
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
      'recordVersion', 1,
      'kind', p_kind
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16),
      'ciphertext', repeat(left(p_seed, 1), 64)
    )
  );
$$;

create function pg_temp.cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_kind text,
  p_key_id text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_kind, p_key_id, p_seed
    ),
    'keyId', p_key_id,
    'keyClass', 'private_manual',
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id::text
  );
$$;

create function pg_temp.mac(p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', 'c5d8.private.mac.v1',
    'keyClass', 'private_manual',
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.event_time()
returns text
language sql
volatile
as $$
  select to_char(
    date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
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

create temporary table c5d8_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on c5d8_values to service_role;

-- Keep the irreversible migration test deterministic: the outer rollback
-- restores the canonical seed owners and every contracted schema mutation.
truncate table auth.users cascade;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '66666666-6666-4666-8666-666666666666',
  'authenticated', 'authenticated', 'c5d8-owner@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.register_user_content_key(
  '66666666-6666-4666-8666-666666666666', key_id,
  key_class::public.content_key_class,
  key_purpose::public.content_key_purpose, 1,
  'arn:aws:kms:us-west-2:123456789012:key/' || root_id,
  decode(repeat(material, 32), 'hex')
)
from (values
  ('c5d8.ai.object.v1', 'ai_assisted', 'object_wrap',
    '85000000-0000-4000-8000-000000000001', '11'),
  ('c5d8.ai.mac.v1', 'ai_assisted', 'content_mac',
    '85000000-0000-4000-8000-000000000002', '12'),
  ('c5d8.private.object.v1', 'private_manual', 'object_wrap',
    '85000000-0000-4000-8000-000000000003', '13'),
  ('c5d8.private.mac.v1', 'private_manual', 'content_mac',
    '85000000-0000-4000-8000-000000000004', '14')
) as key_fixture(key_id, key_class, key_purpose, root_id, material);

select public.activate_user_content_key(
  '66666666-6666-4666-8666-666666666666', key_id
)
from (values
  ('c5d8.ai.object.v1'), ('c5d8.ai.mac.v1'),
  ('c5d8.private.object.v1'), ('c5d8.private.mac.v1')
) as key_fixture(key_id);

select is(
  (
    select count(*)
    from public.user_content_keys
    where user_id = '66666666-6666-4666-8666-666666666666'
      and state = 'active'
  ),
  4::bigint,
  'the synthetic owner has all four active encryption key slots'
);

select is(
  public.advance_content_encryption_rollout(
    '66666666-6666-4666-8666-666666666666', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the empty owner enters dual-write through the official transition'
);
select is(
  public.complete_content_encryption_backfill(
    '66666666-6666-4666-8666-666666666666',
    'c5d8-empty-library-complete', null
  ) ->> 'complete',
  'true',
  'exact zero-object evidence completes the empty-library backfill'
);
select is(
  public.advance_content_encryption_rollout(
    '66666666-6666-4666-8666-666666666666',
    'dual_write', 'encrypted_read'
  ) ->> 'state',
  'encrypted_read',
  'the completed empty library enters encrypted-read'
);

insert into c5d8_values(key, value) values (
  'prepare', public.prepare_content_plaintext_scrub(
    '66666666-6666-4666-8666-666666666666',
    '85000000-0000-4000-8000-000000000010', 'encrypted_read'
  )
);
insert into c5d8_values(key, value) values (
  'scrub', public.scrub_content_plaintext_batch(
    '66666666-6666-4666-8666-666666666666',
    '85000000-0000-4000-8000-000000000010', null, 25
  )
);
select ok(
  (select (value ->> 'complete')::boolean
    from c5d8_values where key = 'scrub')
    and (select (value ->> 'processedCount')::integer
      from c5d8_values where key = 'scrub') = 0,
  'the official scrub proves the empty library has no plaintext rows'
);
select is(
  public.complete_content_plaintext_scrub(
    '66666666-6666-4666-8666-666666666666',
    '85000000-0000-4000-8000-000000000010',
    (select value ->> 'cursor' from c5d8_values where key = 'scrub')
  ) ->> 'complete',
  'true',
  'the exact empty-library scrub attestation is persisted'
);
select is(
  public.advance_content_encryption_rollout(
    '66666666-6666-4666-8666-666666666666',
    'encrypted_read', 'encrypted_only'
  ) ->> 'state',
  'encrypted_only',
  'the attested owner enters encrypted-only through the official transition'
);
reset role;

insert into c5d8_values(key, value)
select 'rollout-evidence', jsonb_build_object(
  'encryptedObjectCount', encrypted_object_count,
  'verifiedObjectCount', verified_object_count,
  'scrubId', plaintext_scrub_id,
  'scrubVersion', plaintext_scrub_version,
  'scrubStartedAt', plaintext_scrub_started_at,
  'scrubCompletedAt', plaintext_scrub_completed_at,
  'scrubbedRowCount', plaintext_scrubbed_row_count,
  'deletedChunkCount', plaintext_scrubbed_chunk_count,
  'deletedIdempotencyCount', plaintext_scrubbed_idempotency_count,
  'attestationDigest', plaintext_scrub_attestation_digest,
  'lastRequestDigest', last_plaintext_scrub_request_digest,
  'lastResultDigest', last_plaintext_scrub_result_digest
)
from public.content_encryption_rollouts
where user_id = '66666666-6666-4666-8666-666666666666';

insert into c5d8_values(key, value)
values ('readiness', private.encrypted_storage_contract_readiness());

select ok(
  (select (value ->> 'ready')::boolean
    from c5d8_values where key = 'readiness')
    and (select (value ->> 'ownerCount')::bigint
      from c5d8_values where key = 'readiness') = 1
    and (select (value ->> 'encryptedObjectCount')::bigint
      from c5d8_values where key = 'readiness') = 0
    and (select value ->> 'readinessDigest'
      from c5d8_values where key = 'readiness') ~ '^[0-9a-f]{64}$',
  'one encrypted-only owner produces a fresh ready contract snapshot'
);

insert into c5d8_values(key, value)
select 'apply', private.apply_encrypted_storage_contract(
  'CONTRACT UNFILED ENCRYPTED STORAGE V1',
  (select value ->> 'readinessDigest'
    from c5d8_values where key = 'readiness')
);

select ok(
  (select value ->> 'state' from c5d8_values where key = 'apply')
      = 'contracted'
    and (select (value ->> 'ownerCount')::bigint
      from c5d8_values where key = 'apply') = 1
    and (select (value ->> 'encryptedObjectCount')::bigint
      from c5d8_values where key = 'apply') = 0,
  'the saved one-owner readiness digest contracts successfully'
);
select is(
  (
    select count(*)
    from unnest(array[
      'public.prepare_encrypted_decision_correction(uuid,text,text,jsonb)',
      'public.commit_encrypted_decision_correction(uuid,text,text,jsonb)',
      'public.prepare_encrypted_review_resolution(uuid,text,text,jsonb)',
      'public.commit_encrypted_review_resolution(uuid,text,text,jsonb)',
      'public.get_encrypted_mutation_batch(uuid,text,integer,text)',
      'public.undo_encrypted_mutation_batch(uuid,text,integer,text,jsonb)'
    ]) as expected(signature)
    where to_regprocedure(expected.signature) is not null
  ),
  6::bigint,
  'all six E1 interaction RPCs remain compiled after one-owner contraction'
);
select is(
  (
    select state::text
    from public.content_encryption_rollouts
    where user_id = '66666666-6666-4666-8666-666666666666'
  ),
  'contracted',
  'the same precontract owner is flipped to contracted'
);
select is(
  (
    select jsonb_build_object(
      'encryptedObjectCount', encrypted_object_count,
      'verifiedObjectCount', verified_object_count,
      'scrubId', plaintext_scrub_id,
      'scrubVersion', plaintext_scrub_version,
      'scrubStartedAt', plaintext_scrub_started_at,
      'scrubCompletedAt', plaintext_scrub_completed_at,
      'scrubbedRowCount', plaintext_scrubbed_row_count,
      'deletedChunkCount', plaintext_scrubbed_chunk_count,
      'deletedIdempotencyCount', plaintext_scrubbed_idempotency_count,
      'attestationDigest', plaintext_scrub_attestation_digest,
      'lastRequestDigest', last_plaintext_scrub_request_digest,
      'lastResultDigest', last_plaintext_scrub_result_digest
    )
    from public.content_encryption_rollouts
    where user_id = '66666666-6666-4666-8666-666666666666'
  ),
  (select value from c5d8_values where key = 'rollout-evidence'),
  'contraction preserves the owner counters and exact scrub attestation'
);

select is(
  pg_temp.caught_error($statement$
    update public.content_encryption_rollouts
    set state = 'encrypted_only'
    where user_id = '66666666-6666-4666-8666-666666666666'
  $statement$) ->> 'sqlstate',
  '23514',
  'the contracted-state constraint rejects a rollout regression'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.reserve_content_key_operations(
  '66666666-6666-4666-8666-666666666666',
  '85000000-0000-4000-8000-000000000020',
  'private_manual', 'c5d8.private.object.v1', 1, 2
);

insert into c5d8_values(key, value)
select 'capture-command', jsonb_build_object(
  'clientCaptureId', 'cap_85000000000000000000000001',
  'jobId', 'job_85000000000000000000000001',
  'occurredAt', event.occurred_at,
  'contentCipher', pg_temp.cipher(
    'cap_85000000000000000000000001',
    '66666666-6666-4666-8666-666666666666', 'capture',
    'c5d8.private.object.v1',
    '85000000-0000-4000-8000-000000000020', 'C'
  ),
  'contentMac', pg_temp.mac('c5d8-capture'),
  'contentLength', 21,
  'source', 'ios_lock_screen_widget',
  'deviceId', 'c5d8-widget',
  'clientCreatedAt', event.occurred_at,
  'clientTimezone', 'UTC',
  'privacy', 'private_manual',
  'explicitDestinationNoteId', null,
  'expansionDisabled', true,
  'routingRuleMatch', null,
  'privateReceiptCipher', pg_temp.cipher(
    'cap_85000000000000000000000001',
    '66666666-6666-4666-8666-666666666666', 'capture_receipt',
    'c5d8.private.object.v1',
    '85000000-0000-4000-8000-000000000020', 'R'
  ),
  'privateReceiptVerificationMac', pg_temp.mac('c5d8-receipt')
)
from (select pg_temp.event_time() as occurred_at) as event;

insert into c5d8_values(key, value)
select 'capture-result', public.create_encrypted_capture_with_job(
  '66666666-6666-4666-8666-666666666666', value
)
from c5d8_values where key = 'capture-command';

select ok(
  (select value ->> 'captureId'
    from c5d8_values where key = 'capture-result')
      = 'cap_85000000000000000000000001'
    and public.list_encrypted_captures(
      '66666666-6666-4666-8666-666666666666', null, null, 10
    ) #>> '{captures,0,captureId}' = 'cap_85000000000000000000000001'
    and public.get_encrypted_capture_detail(
      '66666666-6666-4666-8666-666666666666',
      'cap_85000000000000000000000001'
    ) #>> '{capture,contentCipher,keyId}' = 'c5d8.private.object.v1'
    and not (
      public.get_encrypted_capture_detail(
        '66666666-6666-4666-8666-666666666666',
        'cap_85000000000000000000000001'
      ) #> '{capture}' ? 'rawText'
    ),
  'retained encrypted capture create, list, and detail stay live after contraction'
);
reset role;

select * from finish();
rollback;
