create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create temporary table workflow_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on table workflow_values to authenticated, service_role;

create function pg_temp.capture_envelope(p_capture_id text, p_tenant_id text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'test-kek-v1',
    'context', jsonb_build_object(
      'tenantId', p_tenant_id,
      'resourceId', p_capture_id,
      'recordVersion', 1,
      'kind', 'capture'
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('A', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('B', 16),
      'ciphertext', repeat('C', 22)
    )
  );
$$;

create function pg_temp.capture_payload(
  p_capture_id text,
  p_fingerprint_character text,
  p_content_length integer,
  p_source text,
  p_created_at text,
  p_timezone text,
  p_device_id text default null,
  p_destination_note_id text default null
)
returns jsonb language plpgsql immutable as $$
declare
  payload jsonb;
begin
  payload := jsonb_build_object(
    'clientCaptureId', p_capture_id,
    'contentEnvelope', pg_temp.capture_envelope(
      p_capture_id, '11111111-1111-4111-8111-111111111111'
    ),
    'contentFingerprint', repeat(p_fingerprint_character, 64),
    'contentLength', p_content_length,
    'source', p_source,
    'clientCreatedAt', p_created_at,
    'clientTimezone', p_timezone
  );
  if p_device_id is not null then
    payload := payload || jsonb_build_object('deviceId', p_device_id);
  end if;
  if p_destination_note_id is not null then
    payload := payload || jsonb_build_object(
      'explicitDestinationNoteId', p_destination_note_id
    );
  end if;
  return payload;
end;
$$;

select has_table('public', 'capture_receipts', 'durable capture receipts exist');
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.capture_receipts'::regclass),
  'capture receipts use forced row-level security'
);
select ok(
  not has_table_privilege('authenticated', 'public.capture_receipts', 'SELECT'),
  'receipt rows have no direct authenticated read grant'
);
select ok(
  not has_table_privilege('authenticated', 'public.captures', 'SELECT')
    and not has_table_privilege('authenticated', 'public.captures', 'DELETE'),
  'authenticated callers have no direct capture read or delete grant'
);
select is(
  (
    select array_agg(
      policyname || ':' || cmd || ':' || roles::text
      order by policyname
    )::text
    from pg_policies
    where schemaname = 'public'
      and tablename = 'captures'
  ),
  '{"captures_select:SELECT:{authenticated}"}',
  'captures expose only the rollout-gated owner-select policy identity'
);
select ok(
  (
    select qual = '((user_id = auth.uid()) AND legacy_plaintext_reads_allowed(user_id))'
    from pg_policies
    where schemaname = 'public'
      and tablename = 'captures'
      and policyname = 'captures_select'
  ),
  'the capture owner-select policy is fenced by owner identity and plaintext rollout state'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.create_capture_with_job(uuid,jsonb)', 'EXECUTE'
  ),
  'authenticated callers cannot call the capture entry point directly'
);
select ok(
  has_function_privilege(
    'service_role', 'public.create_capture_with_job(uuid,jsonb)', 'EXECUTE'
  ),
  'the server service role can use the reviewed capture entry point'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_capture_jobs(text,integer,integer)', 'EXECUTE'),
  'authenticated callers cannot claim workflow jobs'
);
select ok(
  has_function_privilege('service_role', 'public.claim_capture_jobs(text,integer,integer)', 'EXECUTE'),
  'the service role can claim workflow jobs'
);
select ok(
  not has_function_privilege(
    'anon', 'public.get_capture_detail(uuid,text)', 'EXECUTE'
  ),
  'anonymous callers cannot read capture detail'
);

select ok(
  (
    select bool_and(not has_function_privilege('authenticated', signature, 'EXECUTE'))
    from unnest(array[
      'public.list_captures(uuid,text,integer,text,timestamp with time zone,timestamp with time zone)',
      'public.get_capture_detail(uuid,text)',
      'public.get_capture_receipt(uuid,text)',
      'public.retry_capture(uuid,text,text)',
      'public.delete_capture(uuid,text,text,boolean,jsonb)'
    ]) as denied(signature)
  ),
  'authenticated callers cannot invoke capture read, retry, or delete RPCs'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  'select * from public.captures',
  '42501',
  'permission denied for table captures',
  'the authenticated role cannot read capture envelopes directly'
);
select throws_ok(
  $$delete from public.captures where id = 'cap_77000000000000000000000001'$$,
  '42501',
  'permission denied for table captures',
  'the authenticated role cannot delete captures directly'
);
select throws_ok(
  $$select public.list_captures(
    '11111111-1111-4111-8111-111111111111'::uuid,
    null, 30, null, null, null
  )$$,
  '42501',
  'permission denied for function list_captures',
  'an authenticated caller cannot forge the server-derived owner parameter'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.claim_capture_jobs('null-limit-worker', null, 60)$$,
  '22023',
  'validation_failed',
  'claim rejects an explicit null batch limit'
);
select throws_ok(
  $$select public.claim_capture_jobs('null-lease-worker', 10, null)$$,
  '22023',
  'validation_failed',
  'claim rejects an explicit null lease duration'
);
select throws_ok(
  $$select public.heartbeat_capture_job(
    'job_77000000000000000000000001',
    '77777777-7777-4777-8777-777777777777'::uuid,
    null
  )$$,
  '22023',
  'validation_failed',
  'heartbeat rejects an explicit null lease duration'
);
select throws_ok(
  $$select public.complete_capture_job(
    'job_77000000000000000000000001',
    '77777777-7777-4777-8777-777777777777'::uuid,
    null
  )$$,
  '22023',
  'validation_failed',
  'completion rejects an explicit null terminal state'
);
select throws_ok(
  $$select public.recover_stale_capture_jobs(null)$$,
  '22023',
  'validation_failed',
  'stale recovery rejects an explicit null batch limit'
);
select throws_ok(
  $$select public.list_captures(
    '11111111-1111-4111-8111-111111111111'::uuid,
    null, null, null, null, null
  )$$,
  '22023',
  'validation_failed',
  'capture listing rejects an explicit null limit instead of becoming unbounded'
);
select throws_ok(
  $$select public.delete_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000001',
    'null-expected-revisions',
    false,
    null
  )$$,
  '22023',
  'validation_failed',
  'capture deletion rejects explicit null expected revisions'
);

insert into workflow_values (key, value)
values (
  'create-one',
  public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    pg_temp.capture_payload(
      'cap_77000000000000000000000001', 'a', 17,
      'ios_lock_screen_widget', '2026-08-30T18:30:00Z',
      'America/Los_Angeles', 'durable-test-device'
    )
  )
);
select is(
  (select value -> 'capture' ->> 'id' from workflow_values where key = 'create-one'),
  'cap_77000000000000000000000001',
  'create returns the accepted capture envelope'
);
select is(
  (select value -> 'capture' ->> 'status' from workflow_values where key = 'create-one'),
  'queued',
  'the durable acknowledgement starts queued'
);
select is(
  (select value ->> 'replayed' from workflow_values where key = 'create-one'),
  'false',
  'the first create is not a replay'
);
reset role;
select is(
  (select raw_text from public.captures
   where id = 'cap_77000000000000000000000001'),
  '[encrypted]',
  'the compatibility column persists only a non-secret placeholder'
);
select is(
  (select content_fingerprint from public.captures
   where id = 'cap_77000000000000000000000001'),
  repeat('a', 64),
  'the durable row stores the server-keyed content fingerprint'
);
select is(
  (select content_envelope -> 'context' ->> 'resourceId'
   from public.captures where id = 'cap_77000000000000000000000001'),
  'cap_77000000000000000000000001',
  'the encrypted envelope is bound to the persisted capture identifier'
);
select throws_ok(
  $$update public.captures
    set content_envelope = null,
        content_fingerprint = null,
        content_length = null
    where id = 'cap_77000000000000000000000001'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'an active capture cannot drop its required encrypted content fields'
);
select throws_ok(
  $$update public.captures
    set content_fingerprint = null
    where id = 'cap_77000000000000000000000001'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'an active capture cannot null only its keyed fingerprint'
);
select throws_ok(
  $$update public.captures
    set content_length = null
    where id = 'cap_77000000000000000000000001'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'an active capture cannot null only its authenticated content length'
);
select throws_ok(
  $$update public.captures
    set status = 'deleted', deleted_at = clock_timestamp()
    where id = 'cap_77000000000000000000000001'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'a deleted capture cannot retain an active encrypted payload'
);
select is(
  (select count(*) from public.captures
   where raw_text not in ('[encrypted]', '[deleted]')),
  0::bigint,
  'active and deleted capture rows contain only their non-secret compatibility placeholders'
);
select ok(
  not ((select value -> 'capture' from workflow_values where key = 'create-one')
    ? 'encryptedContent'),
  'create acknowledgement does not echo ciphertext back to the caller'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    jsonb_set(
      pg_temp.capture_payload(
        'cap_77000000000000000000000001', 'a', 17,
        'ios_lock_screen_widget', '2026-08-30T18:30:00+00:00',
        'America/Los_Angeles', 'durable-test-device'
      ),
      '{contentEnvelope,payload,nonce}',
      to_jsonb(repeat('D', 16))
    )
  ) ->> 'replayed',
  'true',
  'a semantically identical normalized replay returns the original acceptance'
);
select throws_ok(
  $$select public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    pg_temp.capture_payload(
      'cap_77000000000000000000000001', 'b', 15,
      'ios_lock_screen_widget', '2026-08-30T18:30:00Z',
      'America/Los_Angeles', 'durable-test-device'
    )
  )$$,
  'P0001',
  'invalid_idempotency_key',
  'reusing a capture ID with a different request fingerprint is rejected'
);
reset role;
select is(
  (select count(*) from public.organization_jobs
   where capture_id = 'cap_77000000000000000000000001'),
  1::bigint,
  'create and replay persist exactly one durable job'
);
select is(
  (select count(*) from public.user_events
   where entity_id in (
     'cap_77000000000000000000000001',
     (select id from public.organization_jobs
      where capture_id = 'cap_77000000000000000000000001')
   )),
  2::bigint,
  'only first acceptance emits capture and job events'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    jsonb_set(
      pg_temp.capture_payload(
        'cap_77000000000000000000000006', 'f', 10,
        'web', '2026-08-30T18:29:00Z', 'UTC'
      ),
      '{contentEnvelope,context,tenantId}',
      to_jsonb('22222222-2222-4222-8222-222222222222'::text)
    )
  )$$,
  '22023',
  'invalid_capture',
  'the database rejects an envelope bound to another tenant'
);
select throws_ok(
  $$select public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    jsonb_set(
      pg_temp.capture_payload(
        'cap_77000000000000000000000009', 'f', 10,
        'web', '2026-08-30T18:29:00Z', 'UTC'
      ),
      '{contentEnvelope,context,tenantId}',
      'null'::jsonb
    )
  )$$,
  '22023',
  'invalid_capture',
  'a nested JSON null cannot pass the envelope validator through SQL null semantics'
);
select throws_ok(
  $$select public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    jsonb_set(
      pg_temp.capture_payload(
        'cap_77000000000000000000000010', 'f', 10,
        'web', '2026-08-30T18:29:00Z', 'UTC'
      ),
      '{contentEnvelope,wrappedDataKey,nonce}',
      to_jsonb(1234567890123456::numeric)
    )
  )$$,
  '22023',
  'invalid_capture',
  'a numeric JSON scalar cannot masquerade as base64url envelope text'
);
reset role;
select throws_ok(
  $$update public.captures
    set content_envelope = jsonb_set(
      content_envelope,
      '{context,resourceId}',
      'null'::jsonb
    )
    where id = 'cap_77000000000000000000000001'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'the active-row constraint also fails closed for nested JSON nulls'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.create_capture_with_job(
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_temp.capture_payload(
    'cap_77000000000000000000000005', 'f', 15,
    'web', '2026-08-30T18:31:00Z', 'UTC'
  ) || jsonb_build_object('privacy', 'private_manual')
);
reset role;
select is(
  (select capture.status::text || ':' || job.state::text
   from public.captures as capture
   join public.organization_jobs as job on job.capture_id = capture.id
   where capture.id = 'cap_77000000000000000000000005'),
  'inbox:succeeded',
  'private-manual capture settles without entering the organization queue'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.get_capture_receipt(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000005'
  )
    -> 'receipt' ->> 'outcome',
  'kept_in_inbox',
  'private-manual capture receives a no-effects Inbox receipt'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.get_capture_detail(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000005'
  )$$,
  '42501',
  'permission denied for function get_capture_detail',
  'the client cannot enter a service-only capture read path'
);
select throws_ok(
  'select * from public.capture_receipts',
  '42501',
  'permission denied for table capture_receipts',
  'the client cannot bypass receipt RPC filtering'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('claim-one', public.claim_capture_jobs('worker-a', 1, 60));
select is(
  (select value -> 'jobs' -> 0 ->> 'captureId'
   from workflow_values where key = 'claim-one'),
  'cap_77000000000000000000000001',
  'claim atomically returns the oldest ready capture'
);
select is(
  (select value -> 'jobs' -> 0 ->> 'userId'
   from workflow_values where key = 'claim-one'),
  '11111111-1111-4111-8111-111111111111',
  'service claims include the authoritative owner for envelope context validation'
);
select is(
  (select value -> 'jobs' -> 0 -> 'capture' -> 'encryptedContent'
      -> 'envelope' ->> 'suite'
   from workflow_values where key = 'claim-one'),
  'A256GCM',
  'only the service claim receives the encrypted capture envelope'
);
reset role;
select is(
  (select job.state::text || ':' || capture.status::text
   from public.organization_jobs as job
   join public.captures as capture on capture.id = job.capture_id
   where capture.id = 'cap_77000000000000000000000001'),
  'running:processing',
  'claim advances the job and capture together'
);
select is(
  (select attempt from public.organization_jobs
   where capture_id = 'cap_77000000000000000000000001'),
  1,
  'the claim increments the bounded attempt counter once'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  jsonb_array_length(public.claim_capture_jobs('worker-competing', 1, 60) -> 'jobs'),
  0,
  'a competing claimant cannot receive a job that already has an active lease'
);
select is(
  public.heartbeat_capture_job(
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-one'),
    (select (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid from workflow_values where key = 'claim-one'),
    90
  ) ->> 'jobId',
  (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-one'),
  'the active worker can extend its lease'
);
select throws_ok(
  format(
    'select public.complete_capture_job(%L, %L::uuid, %L)',
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-one'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'inbox'
  ),
  'P0001',
  'stale_revision',
  'a worker cannot commit with another lease token'
);
insert into workflow_values (key, value)
select 'fail-one', public.fail_capture_job(
  value -> 'jobs' -> 0 ->> 'jobId',
  (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid,
  'provider_unavailable',
  true,
  1
)
from workflow_values where key = 'claim-one';
select is(
  (select value ->> 'state' from workflow_values where key = 'fail-one'),
  'awaiting_retry',
  'a retryable provider outage is durably scheduled'
);
reset role;
select is(
  (select capture.status::text || ':' || capture.last_error_code::text
   from public.captures as capture
   where id = 'cap_77000000000000000000000001'),
  'queued:provider_unavailable',
  'a retryable failure returns the capture to a visible queued state'
);
select is(
  (select value ->> 'replayed' from workflow_values where key = 'fail-one'),
  'false',
  'the first failure transition is not a replay'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.fail_capture_job(
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-one'),
    (select (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid from workflow_values where key = 'claim-one'),
    'provider_unavailable',
    true,
    1
  ) ->> 'replayed',
  'true',
  'the same failed lease transition replays idempotently'
);
select throws_ok(
  format(
    'select public.fail_capture_job(%L, %L::uuid, %L, true, 2)',
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-one'),
    (select value -> 'jobs' -> 0 ->> 'leaseToken' from workflow_values where key = 'claim-one'),
    'provider_unavailable'
  ),
  'P0001',
  'invalid_idempotency_key',
  'a replayed lease transition rejects a different retry envelope'
);
reset role;
update public.organization_jobs
set available_at = clock_timestamp() - interval '1 second'
where capture_id = 'cap_77000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('claim-two', public.claim_capture_jobs('worker-b', 1, 60));
reset role;
select is(
  (select attempt from public.organization_jobs
   where capture_id = 'cap_77000000000000000000000001'),
  2,
  'the due retry is claimed as a second bounded attempt'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
select 'complete-inbox', public.complete_capture_job(
  value -> 'jobs' -> 0 ->> 'jobId',
  (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid,
  'inbox'
)
from workflow_values where key = 'claim-two';
select is(
  (select value -> 'receipt' ->> 'outcome'
   from workflow_values where key = 'complete-inbox'),
  'kept_in_inbox',
  'terminal Inbox completion creates a truthful receipt'
);
select is(
  public.complete_capture_job(
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-two'),
    (select (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid from workflow_values where key = 'claim-two'),
    'inbox'
  ) ->> 'replayed',
  'true',
  'terminal completion replays by lease token without duplicate effects'
);
select throws_ok(
  format(
    'select public.complete_capture_job(%L, %L::uuid, %L)',
    (select value -> 'jobs' -> 0 ->> 'jobId' from workflow_values where key = 'claim-two'),
    (select value -> 'jobs' -> 0 ->> 'leaseToken' from workflow_values where key = 'claim-two'),
    'done'
  ),
  'P0001',
  'invalid_idempotency_key',
  'a completed lease rejects a different terminal replay payload'
);
reset role;
select is(
  (select count(*) from public.capture_receipts
   where capture_id = 'cap_77000000000000000000000001'),
  1::bigint,
  'terminal completion persists exactly one receipt'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.create_capture_with_job(
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_temp.capture_payload(
    'cap_77000000000000000000000008', '8', 21,
    'web', '2026-08-30T18:45:00Z', 'UTC'
  )
);

reset role;
update public.organization_jobs
set attempt = 4
where capture_id = 'cap_77000000000000000000000008';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('claim-exhaustion', public.claim_capture_jobs('worker-exhaustion', 1, 60));
select is(
  (select value -> 'jobs' -> 0 ->> 'attempt'
   from workflow_values where key = 'claim-exhaustion'),
  '5',
  'the final bounded claim enters attempt five'
);
insert into workflow_values (key, value)
select 'retry-exhausted', public.fail_capture_job(
  value -> 'jobs' -> 0 ->> 'jobId',
  (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid,
  'provider_unavailable',
  true,
  1
)
from workflow_values where key = 'claim-exhaustion';
select is(
  (select value ->> 'state' from workflow_values where key = 'retry-exhausted'),
  'dead_letter',
  'a retryable failure on attempt five exhausts into the dead letter state'
);
select is(
  (select value ->> 'captureStatus' from workflow_values where key = 'retry-exhausted'),
  'failed',
  'retry exhaustion exposes an honest terminal capture failure'
);
select is(
  (select value -> 'receipt' ->> 'outcome'
   from workflow_values where key = 'retry-exhausted'),
  'failed',
  'retry exhaustion persists a safe failure receipt'
);
select is(
  public.fail_capture_job(
    (select value -> 'jobs' -> 0 ->> 'jobId'
     from workflow_values where key = 'claim-exhaustion'),
    (select (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid
     from workflow_values where key = 'claim-exhaustion'),
    'provider_unavailable',
    true,
    1
  ) ->> 'replayed',
  'true',
  'the exhausted failure transition replays without duplicate effects'
);
reset role;
select is(
  (select count(*) from public.capture_receipts
   where capture_id = 'cap_77000000000000000000000008'),
  1::bigint,
  'retry exhaustion persists exactly one receipt across replay'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.get_capture_receipt(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000001'
  )
    -> 'receipt' ->> 'outcome',
  'kept_in_inbox',
  'the owner can read the persisted receipt through the reviewed RPC'
);
select is(
  public.get_capture_detail(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000001'
  )
    -> 'capture' ->> 'status',
  'inbox',
  'owner detail maps durable database state to the public processing state'
);
select is(
  jsonb_array_length(public.list_captures(
    '11111111-1111-4111-8111-111111111111'::uuid,
    null, 100, 'inbox', null, null
  ) -> 'items'),
  2,
  'owner list filtering returns both processed and private Inbox captures'
);
select ok(
  (
    select bool_and(item ? 'encryptedContent' and not (item ? 'rawContentPreview'))
    from jsonb_array_elements(
      public.list_captures(
        '11111111-1111-4111-8111-111111111111'::uuid,
        null, 100, 'inbox', null, null
      ) -> 'items'
    ) as item
  ),
  'owner list exposes ciphertext envelopes for server decryption and no fake plaintext preview'
);

select public.create_capture_with_job(
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_temp.capture_payload(
    'cap_77000000000000000000000007', '7', 12,
    'web', '2001-01-01T00:30:00Z', 'UTC'
  ) || jsonb_build_object('privacy', 'private_manual')
);
select is(
  public.list_captures(
    '11111111-1111-4111-8111-111111111111'::uuid,
    null,
    100,
    'inbox',
    '2001-01-01T00:00:00Z'::timestamptz,
    '2001-01-02T00:00:00Z'::timestamptz
  ) -> 'items' -> 0 ->> 'id',
  'cap_77000000000000000000000007',
  'owner list date filtering uses client creation time even when receipt time differs'
);
select is(
  jsonb_array_length(
    public.list_captures(
      '11111111-1111-4111-8111-111111111111'::uuid,
      null,
      100,
      'inbox',
      null,
      '2001-01-01T00:30:00Z'::timestamptz
    ) -> 'items'
  ),
  0,
  'owner list date filtering keeps the client-created upper bound half open'
);

select public.create_capture_with_job(
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_temp.capture_payload(
    'cap_77000000000000000000000002', 'c', 24,
    'web', '2026-08-30T19:00:00Z', 'UTC'
  )
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('claim-failure', public.claim_capture_jobs('worker-failure', 1, 60));
insert into workflow_values (key, value)
select 'terminal-failure', public.fail_capture_job(
  value -> 'jobs' -> 0 ->> 'jobId',
  (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid,
  'provider_unavailable',
  false,
  null
)
from workflow_values where key = 'claim-failure';
select is(
  (select value ->> 'captureStatus'
   from workflow_values where key = 'terminal-failure'),
  'failed',
  'a permanent provider failure reaches the public failed state'
);
select is(
  (select value -> 'receipt' ->> 'outcome'
   from workflow_values where key = 'terminal-failure'),
  'failed',
  'a permanent failure persists a safe receipt without provider internals'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('manual-retry', public.retry_capture(
  '11111111-1111-4111-8111-111111111111'::uuid,
  'cap_77000000000000000000000002', 'retry-capture-two'
));
select is(
  (select value -> 'capture' ->> 'status'
   from workflow_values where key = 'manual-retry'),
  'queued',
  'manual retry safely returns a terminal failure to the queue'
);
select is(
  (select value -> 'capture' -> 'encryptedContent' -> 'envelope' ->> 'suite'
   from workflow_values where key = 'manual-retry'),
  'A256GCM',
  'manual retry still returns the live envelope needed by the authenticated server DTO'
);
select is(
  public.retry_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000002', 'retry-capture-two'
  ) ->> 'replayed',
  'true',
  'manual retry replays by its strict idempotency envelope'
);
reset role;
select ok(
  (
    select not (response_json -> 'capture' ? 'encryptedContent')
      and position('contentFingerprint' in response_json::text) = 0
      and position('keyId' in response_json::text) = 0
    from public.api_idempotency_records
    where user_id = '11111111-1111-4111-8111-111111111111'
      and idempotency_key = 'retry-capture-two'
  ),
  'retry idempotency persists metadata only and never a replayable content envelope'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.get_capture_receipt(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000002'
  )$$,
  'P0001',
  'not_found',
  'retry removes the obsolete terminal receipt before reprocessing'
);

select public.create_capture_with_job(
  '11111111-1111-4111-8111-111111111111'::uuid,
  pg_temp.capture_payload(
    'cap_77000000000000000000000003', 'd', 19,
    'mobile', '2026-08-30T19:05:00Z', 'UTC'
  )
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.claim_capture_jobs('worker-stale', 10, 60);
reset role;
update public.organization_jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where capture_id = 'cap_77000000000000000000000003';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.recover_stale_capture_jobs(100) ->> 'recovered',
  '1',
  'stale lease recovery claims each expired running job once'
);
reset role;
select is(
  (select state::text from public.organization_jobs
   where capture_id = 'cap_77000000000000000000000003'),
  'awaiting_retry',
  'an expired lease is durably requeued while attempts remain'
);
select is(
  (select status::text from public.captures
   where id = 'cap_77000000000000000000000003'),
  'queued',
  'stale lease recovery returns the capture to queued visibility'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
insert into workflow_values (key, value)
values (
  'created-note',
  public.create_note(
    'capture-removal-note', 'generic', 'Removal target',
    'capture-owned body', null, 'ai_assisted', null, '[]'::jsonb, '[]'::jsonb
  )
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values (
  'create-routed',
  public.create_capture_with_job(
    '11111111-1111-4111-8111-111111111111'::uuid,
    pg_temp.capture_payload(
      'cap_77000000000000000000000004', 'e', 18,
      'web', '2026-08-30T19:10:00Z', 'UTC', null,
      'note_00000000000000000000000001'
    )
  )
);

reset role;
insert into public.organization_decisions (
  capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, score, margin, destination_note_id, reason_codes
)
select
  'cap_77000000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  jsonb_build_object('candidateIds', jsonb_build_array(value -> 'note' ->> 'id')),
  '{}'::jsonb,
  '{"schemaVersion":1,"decision":"append_to_note"}'::jsonb,
  'auto', 1.000, 1.000, value -> 'note' ->> 'id',
  array['explicit_destination']
from workflow_values where key = 'created-note';
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation
)
select
  'cap_77000000000000000000000004',
  value -> 'note' ->> 'id',
  '11111111-1111-4111-8111-111111111111',
  value ->> 'mutationId',
  'routed'
from workflow_values where key = 'created-note';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
values ('claim-routed', public.claim_capture_jobs('worker-routed', 10, 60));
insert into workflow_values (key, value)
select
  'complete-routed',
  public.complete_capture_job(
    value -> 'jobs' -> 0 ->> 'jobId',
    (value -> 'jobs' -> 0 ->> 'leaseToken')::uuid,
    'done'
  )
from workflow_values
where key = 'claim-routed';
select is(
  (select value -> 'receipt' ->> 'outcome'
   from workflow_values where key = 'complete-routed'),
  'created_note',
  'a persisted create mutation produces a created-note receipt'
);
select is(
  (select jsonb_array_length(value -> 'receipt' -> 'actions')
   from workflow_values where key = 'complete-routed'),
  2,
  'receipt actions only expose the persisted open and undo mutations'
);
reset role;
select ok(
  (
    select position('Removal target' in row_to_json(receipt)::text) = 0
      and position('capture-owned body' in row_to_json(receipt)::text) = 0
    from public.capture_receipts as receipt
    where capture_id = 'cap_77000000000000000000000004'
  ),
  'durable receipt rows persist references and generic headlines, never copied content'
);

insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices
)
select
  'rvw_77000000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  'cap_77000000000000000000000004',
  value -> 'note' ->> 'id',
  'low_confidence',
  '[]'::jsonb
from workflow_values where key = 'created-note';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into workflow_values (key, value)
select
  'delete-routed',
  public.delete_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000004',
    'delete-routed-capture',
    true,
    jsonb_build_array(jsonb_build_object(
      'noteId', value -> 'note' ->> 'id',
      'expectedRevision', (value -> 'note' ->> 'currentRevision')::integer
    ))
  )
from workflow_values where key = 'created-note';
select is(
  (select value ->> 'removedInsertedContent'
   from workflow_values where key = 'delete-routed'),
  'true',
  'optional content removal is backed by a persisted inverse mutation'
);
reset role;
select is(
  (select relation from public.capture_note_links
   where capture_id = 'cap_77000000000000000000000004'),
  'source_removed',
  'soft deletion preserves provenance with an explicit source-removed relation'
);
select ok(
  (select deleted_at is not null and status = 'deleted'
   from public.captures where id = 'cap_77000000000000000000000004'),
  'capture deletion is soft and retains the source row'
);
select ok(
  (
    select state = 'dismissed'
      and resolution = '{"reason":"capture_deleted"}'::jsonb
      and resolved_at is not null
    from public.review_items
    where id = 'rvw_77000000000000000000000004'
  ),
  'capture deletion dismisses its open review work instead of leaving a dead action'
);
select is(
  (select count(*) from public.user_events
   where entity = 'review_item'
     and entity_id = 'rvw_77000000000000000000000004'),
  1::bigint,
  'capture deletion emits the dismissed review item for cross-device reconciliation'
);
select ok(
  (
    select content_envelope is null
      and content_fingerprint is null
      and content_length is null
      and raw_text = '[deleted]'
    from public.captures
    where id = 'cap_77000000000000000000000004'
  ),
  'capture deletion atomically destroys durable source ciphertext and its fingerprint'
);
select throws_ok(
  $$update public.captures
    set content_envelope = pg_temp.capture_envelope(
          'cap_77000000000000000000000004',
          '11111111-1111-4111-8111-111111111111'
        ),
        content_fingerprint = repeat('e', 64),
        content_length = 18
    where id = 'cap_77000000000000000000000004'$$,
  '23514',
  'new row for relation "captures" violates check constraint "captures_encrypted_content_shape"',
  'a deleted capture cannot regain an encrypted payload'
);
select ok(
  (select deleted_at is not null and current_revision = 2
   from public.notes
   where id = (select value -> 'note' ->> 'id'
               from workflow_values where key = 'created-note')),
  'removing a capture-created note applies its exact inverse at N plus one'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select is(
  (
    select public.undo_user_mutation(
      removal ->> 'mutationId',
      (removal ->> 'expectedRevision')::integer,
      'undo-capture-content-removal'
    ) -> 'note' ->> 'deletedAt'
    from workflow_values,
      lateral jsonb_array_elements(value -> 'contentRemovalMutations') as removal
    where key = 'delete-routed'
  ),
  null,
  'the content-removal mutation is itself immediately undoable'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.delete_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000004',
    'delete-routed-capture',
    true,
    jsonb_build_array(jsonb_build_object(
      'noteId', (select value -> 'note' ->> 'id'
                 from workflow_values where key = 'created-note'),
      'expectedRevision', 1
    ))
  ) ->> 'replayed',
  'true',
  'soft deletion replays its original atomic response by idempotency key'
);

select public.delete_capture(
  '11111111-1111-4111-8111-111111111111'::uuid,
  'cap_77000000000000000000000002',
  'delete-retried-capture',
  false,
  '[]'::jsonb
);
reset role;
select is(
  (
    select count(*)
    from public.api_idempotency_records
    where user_id = '11111111-1111-4111-8111-111111111111'
      and scope = 'retry_capture'
      and response_json #>> '{capture,id}' = 'cap_77000000000000000000000002'
  ),
  0::bigint,
  'deleting a capture atomically purges its prior retry replay snapshots'
);
select ok(
  not exists (
    select 1 from public.api_idempotency_records
    where user_id = '11111111-1111-4111-8111-111111111111'
      and scope in ('retry_capture', 'delete_capture')
      and (
        response_json::text like '%"encryptedContent"%'
        or response_json::text like '%"contentFingerprint"%'
        or response_json::text like '%"keyId"%'
      )
  ),
  'capture retry and delete idempotency records remain content-free after deletion'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.retry_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    'cap_77000000000000000000000002',
    'retry-capture-two'
  )$$,
  'P0001',
  'not_found',
  'an old retry key cannot resurrect or reveal a deleted capture'
);

select is(
  jsonb_array_length(public.list_captures(
    '22222222-2222-4222-8222-222222222222'::uuid,
    null, 100, null, null, null
  ) -> 'items'),
  0,
  'a service request scoped to another owner receives no capture rows'
);

select throws_ok(
  $$select public.get_capture_detail(
    '22222222-2222-4222-8222-222222222222'::uuid,
    'cap_77000000000000000000000001'
  )$$,
  'P0001',
  'not_found',
  'owner detail never reveals another user capture'
);

select * from finish();
rollback;
