create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

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

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select plan(10);

select is(
  (
    select public.create_capture_with_job(
      '11111111-1111-4111-8111-111111111111'::uuid,
      jsonb_build_object(
        'clientCaptureId', 'cap_70000000000000000000000001',
        'contentEnvelope', pg_temp.capture_envelope(
          'cap_70000000000000000000000001',
          '11111111-1111-4111-8111-111111111111'
        ),
        'contentFingerprint', repeat('a', 64),
        'contentLength', 17,
        'source', 'ios_lock_screen_widget',
        'deviceId', 'sql-test-device',
        'clientCreatedAt', '2026-08-30T18:30:00Z',
        'clientTimezone', 'America/Los_Angeles',
        'privacy', 'ai_assisted',
        'expansionDisabled', false
      )
    ) -> 'capture' ->> 'id'
  ),
  'cap_70000000000000000000000001',
  'the RPC returns the inserted capture'
);
reset role;
select is(
  (
    select source::text
    from public.captures
    where id = 'cap_70000000000000000000000001'
  ),
  'ios_lock_screen_widget',
  'the widget source survives database validation'
);
select is(
  (
    select count(*)
    from public.organization_jobs
    where capture_id = 'cap_70000000000000000000000001'
  ),
  1::bigint,
  'capture and organization job are created together'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$
    select public.create_capture_with_job(
      '11111111-1111-4111-8111-111111111111'::uuid,
      jsonb_build_object(
        'clientCaptureId', 'cap_70000000000000000000000001',
        'contentEnvelope', pg_temp.capture_envelope(
          'cap_70000000000000000000000001',
          '11111111-1111-4111-8111-111111111111'
        ),
        'contentFingerprint', repeat('b', 64),
        'contentLength', 43,
        'source', 'web',
        'clientCreatedAt', '2026-08-30T19:30:00Z',
        'clientTimezone', 'UTC',
        'privacy', 'private_manual',
        'expansionDisabled', true
      )
    )
  $$,
  'P0001',
  'invalid_idempotency_key',
  'a reused capture ID must have the exact same normalized request fingerprint'
);
reset role;
select is(
  (
    select count(*)
    from public.organization_jobs
    where capture_id = 'cap_70000000000000000000000001'
  ),
  1::bigint,
  'an idempotent replay does not duplicate the job'
);
select is(
  (
    select count(*)
    from public.user_events
    where entity_id in (
      'cap_70000000000000000000000001',
      (
        select id
        from public.organization_jobs
        where capture_id = 'cap_70000000000000000000000001'
      )
    )
  ),
  2::bigint,
  'the first call emits one capture event and one job event only'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$
    select public.create_capture_with_job(
      '11111111-1111-4111-8111-111111111111'::uuid,
      jsonb_build_object(
        'clientCaptureId', 'cap_70000000000000000000000002',
        'contentEnvelope', pg_temp.capture_envelope(
          'cap_70000000000000000000000002',
          '11111111-1111-4111-8111-111111111111'
        ),
        'contentFingerprint', repeat('c', 64),
        'contentLength', 38,
        'source', 'web',
        'clientCreatedAt', '2026-08-30T20:00:00Z',
        'clientTimezone', 'UTC',
        'privacy', 'ai_assisted',
        'explicitDestinationNoteId', 'note_00000000000000000000000009',
        'expansionDisabled', false
      )
    )
  $$,
  '42501',
  'explicit_destination_not_owned',
  'an explicit destination must belong to the caller'
);
reset role;
select is(
  (
    select count(*)
    from public.captures
    where id = 'cap_70000000000000000000000002'
  ),
  0::bigint,
  'a rejected capture leaves no partial capture row behind'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$
    select public.create_capture_with_job(
      '22222222-2222-4222-8222-222222222222'::uuid,
      jsonb_build_object(
        'clientCaptureId', 'cap_70000000000000000000000001',
        'contentEnvelope', pg_temp.capture_envelope(
          'cap_70000000000000000000000001',
          '22222222-2222-4222-8222-222222222222'
        ),
        'contentFingerprint', repeat('d', 64),
        'contentLength', 37,
        'source', 'web',
        'clientCreatedAt', '2026-08-30T20:05:00Z',
        'clientTimezone', 'UTC',
        'privacy', 'ai_assisted',
        'expansionDisabled', false
      )
    )
  $$,
  '23505',
  'capture_id_conflict',
  'a cross-user capture ID collision fails without returning the existing row'
);
select is(
  (
    select jsonb_array_length(public.list_captures(
      '22222222-2222-4222-8222-222222222222'::uuid,
      null, 100, null, null, null
    ) -> 'items')
  ),
  0,
  'the server owner scope hides the collided capture from the second user'
);

select * from finish();
rollback;
