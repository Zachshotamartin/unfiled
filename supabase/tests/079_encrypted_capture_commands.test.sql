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
    'keyClass', 'ai_assisted',
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
    'keyId', 'c5d.capture.ai.mac.v1',
    'keyClass', 'ai_assisted',
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

create temporary table capture_command_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on capture_command_values to service_role;

select has_function(
  'public', 'get_encrypted_capture_command_claim',
  array['uuid', 'text', 'text'],
  'capture command replay lookup has one exact signature'
);
select has_function(
  'public', 'get_encrypted_capture_delete_context',
  array['uuid', 'text'],
  'capture deletion context has one exact signature'
);
select has_function(
  'public', 'retry_encrypted_capture',
  array['uuid', 'text', 'text', 'jsonb'],
  'encrypted retry has one exact signature'
);
select has_function(
  'public', 'delete_encrypted_capture',
  array['uuid', 'text', 'text', 'jsonb'],
  'encrypted deletion has one exact signature'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.retry_encrypted_capture(uuid,text,text,jsonb)', 'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.delete_encrypted_capture(uuid,text,text,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.retry_encrypted_capture(uuid,text,text,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.delete_encrypted_capture(uuid,text,text,jsonb)', 'EXECUTE'
    ),
  'only the service role receives encrypted capture command capabilities'
);
select ok(
  not exists (
    select 1
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name in (
        'encrypted_capture_command_result',
        'lock_encrypted_capture_command_replay',
        'finish_encrypted_capture_command',
        'consume_replayed_capture_command_reservation'
      )
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_index_worker', 'unfiled_rag_verifier',
        'unfiled_organizer_worker'
      )
  ),
  'all capture command helpers remain private implementation details'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '44444444-4444-4444-8444-444444444444',
  'authenticated', 'authenticated', 'capture-commands@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id)
values ('44444444-4444-4444-8444-444444444444');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '44444444-4444-4444-8444-444444444444',
    'c5d.capture.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/79000000-0000-4000-8000-000000000001',
    decode(repeat('11', 32), 'hex'), 'active', now()
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'c5d.capture.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/79000000-0000-4000-8000-000000000002',
    decode(repeat('12', 32), 'hex'), 'active', now()
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'c5d.capture.private.object.v1', 'private_manual', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/79000000-0000-4000-8000-000000000003',
    decode(repeat('13', 32), 'hex'), 'active', now()
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'c5d.capture.private.mac.v1', 'private_manual', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/79000000-0000-4000-8000-000000000004',
    decode(repeat('14', 32), 'hex'), 'active', now()
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.advance_content_encryption_rollout(
    '44444444-4444-4444-8444-444444444444', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the isolated command owner enters encrypted dual-write'
);

select public.reserve_content_key_operations(
  '44444444-4444-4444-8444-444444444444',
  reservation_id, 'ai_assisted', 'c5d.capture.ai.object.v1', 1, 1
)
from (values
  ('79000000-0000-4000-8000-000000000010'::uuid),
  ('79000000-0000-4000-8000-000000000011'::uuid)
) as reservations(reservation_id);
insert into capture_command_values(key, value)
select label, jsonb_build_object(
  'clientCaptureId', capture_id,
  'jobId', job_id,
  'occurredAt', pg_temp.event_time(),
  'contentCipher', pg_temp.cipher(
    capture_id, '44444444-4444-4444-8444-444444444444', 'capture',
    'c5d.capture.ai.object.v1', reservation_id, label
  ),
  'contentMac', pg_temp.mac(label || '-content'),
  'contentLength', 12,
  'source', 'web',
  'deviceId', 'capture-command-test',
  'clientCreatedAt', pg_temp.event_time(),
  'clientTimezone', 'UTC',
  'privacy', 'ai_assisted',
  'explicitDestinationNoteId', null,
  'expansionDisabled', false,
  'privateReceiptCipher', null,
  'privateReceiptVerificationMac', null
)
from (values
  (
    'retry-capture', 'cap_79000000000000000000000001',
    'job_79000000000000000000000001',
    '79000000-0000-4000-8000-000000000010'::uuid
  ),
  (
    'delete-capture', 'cap_79000000000000000000000002',
    'job_79000000000000000000000002',
    '79000000-0000-4000-8000-000000000011'::uuid
  )
) as fixtures(label, capture_id, job_id, reservation_id);
select public.create_encrypted_capture_with_job(
  '44444444-4444-4444-8444-444444444444', value
)
from capture_command_values
where key in ('retry-capture', 'delete-capture')
order by key;

reset role;
update public.organization_jobs
set state = 'failed', completed_at = now(), error_code = 'provider_unavailable'
where id = 'job_79000000000000000000000001';
update public.captures
set status = 'failed', last_error_code = 'provider_unavailable'
where id = 'cap_79000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.reserve_content_key_operations(
  '44444444-4444-4444-8444-444444444444',
  reservation_id, 'ai_assisted', 'c5d.capture.ai.object.v1', 1, 1
)
from (values
  ('79000000-0000-4000-8000-000000000020'::uuid),
  ('79000000-0000-4000-8000-000000000021'::uuid),
  ('79000000-0000-4000-8000-000000000022'::uuid)
) as reservations(reservation_id);

insert into capture_command_values(key, value)
select 'retry-command-winner', jsonb_build_object(
  'occurredAt', pg_temp.event_time(),
  'requestMac', pg_temp.mac('retry-request'),
  'responseCipher', pg_temp.cipher(
    'idempotency:retry-capture-1',
    '44444444-4444-4444-8444-444444444444', 'idempotency_response',
    'c5d.capture.ai.object.v1',
    '79000000-0000-4000-8000-000000000020', 'R'
  ),
  'responseVerificationMac', pg_temp.mac('retry-response-proof')
);
insert into capture_command_values(key, value)
select 'retry-command-loser', jsonb_set(
  (select value from capture_command_values where key = 'retry-command-winner'),
  '{responseCipher}',
  pg_temp.cipher(
    'idempotency:retry-capture-1',
    '44444444-4444-4444-8444-444444444444', 'idempotency_response',
    'c5d.capture.ai.object.v1',
    '79000000-0000-4000-8000-000000000021', 'S'
  )
);
insert into capture_command_values(key, value)
select 'retry-result', public.retry_encrypted_capture(
  '44444444-4444-4444-8444-444444444444',
  'cap_79000000000000000000000001', 'retry-capture-1',
  (select value from capture_command_values where key = 'retry-command-winner')
);
reset role;
select ok(
  (select value ->> 'replayed' from capture_command_values
    where key = 'retry-result') = 'false'
    and (select value ->> 'jobId' from capture_command_values
      where key = 'retry-result') = 'job_79000000000000000000000001'
    and (select state from public.organization_jobs
      where id = 'job_79000000000000000000000001') = 'created'
    and (select status from public.captures
      where id = 'cap_79000000000000000000000001') = 'queued',
  'encrypted retry atomically resets the failed job and capture'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.get_encrypted_capture_command_claim(
    '44444444-4444-4444-8444-444444444444',
    'retry_capture', 'retry-capture-1'
  ) #>> '{claim,requestMacKey,keyId}',
  'c5d.capture.ai.mac.v1',
  'replay lookup returns only the original MAC key reference'
);

insert into capture_command_values(key, value)
select 'retry-replay', public.retry_encrypted_capture(
  '44444444-4444-4444-8444-444444444444',
  'cap_79000000000000000000000001', 'retry-capture-1',
  (select value from capture_command_values where key = 'retry-command-loser')
);
reset role;
select ok(
  (select value ->> 'replayed' from capture_command_values
    where key = 'retry-replay') = 'true'
    and (select value #> '{encryptedResponse,envelope}'
      from capture_command_values where key = 'retry-replay') =
      (select value #> '{encryptedResponse,envelope}'
        from capture_command_values where key = 'retry-result')
    and (
      select count(*) = 2
        and bool_and(consumed_by_type = 'encrypted_capture_command')
        and bool_and(consumed_by_id = 'retry-capture-1')
      from public.content_key_operation_reservations
      where reservation_id in (
        '79000000-0000-4000-8000-000000000020',
        '79000000-0000-4000-8000-000000000021'
      )
    ),
  'a losing full command replays the winner and consumes its abandoned reservation'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.retry_encrypted_capture(
    '44444444-4444-4444-8444-444444444444',
    'cap_79000000000000000000000001', 'retry-capture-1',
    jsonb_build_object('requestMac', pg_temp.mac('different-request'))
  )$$,
  'P0001', 'invalid_idempotency_key',
  'retry replay rejects a different logical request MAC before live-state checks'
);

insert into capture_command_values(key, value)
select 'delete-command', jsonb_build_object(
  'occurredAt', pg_temp.event_time(),
  'removeInsertedContent', false,
  'sourceNoteIds', jsonb_build_array(),
  'requestMac', pg_temp.mac('delete-request'),
  'responseCipher', pg_temp.cipher(
    'idempotency:delete-capture-1',
    '44444444-4444-4444-8444-444444444444', 'idempotency_response',
    'c5d.capture.ai.object.v1',
    '79000000-0000-4000-8000-000000000022', 'T'
  ),
  'responseVerificationMac', pg_temp.mac('delete-response-proof')
);
select throws_ok(
  $$select public.delete_encrypted_capture(
    '44444444-4444-4444-8444-444444444444',
    'cap_79000000000000000000000002', 'delete-capture-1',
    jsonb_set(
      (select value from capture_command_values where key = 'delete-command'),
      '{removeInsertedContent}', 'true'::jsonb
    )
  )$$,
  '22023', 'validation_failed',
  'the database refuses unimplemented multi-note encrypted content reversal'
);
insert into capture_command_values(key, value)
select 'delete-result', public.delete_encrypted_capture(
  '44444444-4444-4444-8444-444444444444',
  'cap_79000000000000000000000002', 'delete-capture-1',
  (select value from capture_command_values where key = 'delete-command')
);
reset role;
select ok(
  (select value ->> 'replayed' from capture_command_values
    where key = 'delete-result') = 'false'
    and (
      select status = 'deleted'
        and deleted_at is not null
        and raw_text = '[deleted]'
        and content_envelope is null
        and content_fingerprint is null
        and content_key_id is null
        and fingerprint_key_id is null
      from public.captures
      where id = 'cap_79000000000000000000000002'
    )
    and (
      select state = 'failed' and error_code = 'not_found'
      from public.organization_jobs
      where id = 'job_79000000000000000000000002'
    ),
  'encrypted deletion produces a complete ciphertext-free capture tombstone'
);
select ok(
  (
    select replay_policy = 'logical_mac'
      and request_resource_type = 'capture'
      and request_resource_id = 'cap_79000000000000000000000002'
      and response_resource_type = 'capture_tombstone'
      and response_envelope is not null
      and request_hash = request_mac
      and response_json::text not like '%rawContent%'
    from public.api_idempotency_records
    where user_id = '44444444-4444-4444-8444-444444444444'
      and idempotency_key = 'delete-capture-1'
  )
    and exists (
      select 1 from public.content_encryption_verifications
      where user_id = '44444444-4444-4444-8444-444444444444'
        and surface = 'idempotency_response'
        and resource_id = 'idempotency:delete-capture-1'
    )
    and (
      select consumed_by_type = 'encrypted_capture_command'
        and consumed_by_id = 'delete-capture-1'
      from public.content_key_operation_reservations
      where reservation_id = '79000000-0000-4000-8000-000000000022'
    ),
  'delete idempotency stores only a verified encrypted response and content-free pointers'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.delete_encrypted_capture(
    '44444444-4444-4444-8444-444444444444',
    'cap_79000000000000000000000002', 'delete-capture-1',
    jsonb_build_object('requestMac', pg_temp.mac('delete-request'))
  ) ->> 'replayed',
  'true',
  'delete replays from the encrypted response after the capture is tombstoned'
);
select throws_ok(
  $$select public.get_encrypted_capture_delete_context(
    '44444444-4444-4444-8444-444444444444',
    'cap_79000000000000000000000002'
  )$$,
  'P0001', 'not_found',
  'deleted capture content and deletion context are no longer readable'
);
reset role;
select is(
  (
    select count(*)
    from public.api_idempotency_records
    where user_id = '44444444-4444-4444-8444-444444444444'
      and scope = 'retry_capture'
      and request_resource_id = 'cap_79000000000000000000000002'
  ),
  0::bigint,
  'capture deletion leaves no replayable retry snapshot for the tombstone'
);

select * from finish();
rollback;
