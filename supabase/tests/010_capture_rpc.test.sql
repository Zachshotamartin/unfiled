create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(10);

select is(
  (
    select id
    from public.create_capture_with_job(
      '{
        "clientCaptureId":"cap_70000000000000000000000001",
        "rawContent":"remember oat milk",
        "source":"ios_lock_screen_widget",
        "deviceId":"sql-test-device",
        "clientCreatedAt":"2026-08-30T18:30:00Z",
        "clientTimezone":"America/Los_Angeles",
        "privacy":"ai_assisted",
        "expansionDisabled":false
      }'::jsonb
    )
  ),
  'cap_70000000000000000000000001',
  'the RPC returns the inserted capture'
);
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
select is(
  (
    select raw_text
    from public.create_capture_with_job(
      '{
        "clientCaptureId":"cap_70000000000000000000000001",
        "rawContent":"this replay must not overwrite the original",
        "source":"web",
        "clientCreatedAt":"2026-08-30T19:30:00Z",
        "clientTimezone":"UTC",
        "privacy":"private_manual",
        "expansionDisabled":true
      }'::jsonb
    )
  ),
  'remember oat milk',
  'an idempotent replay returns the unchanged original capture'
);
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
select throws_ok(
  $$
    select public.create_capture_with_job(
      '{
        "clientCaptureId":"cap_70000000000000000000000002",
        "rawContent":"try to route into somebody else''s note",
        "source":"web",
        "clientCreatedAt":"2026-08-30T20:00:00Z",
        "clientTimezone":"UTC",
        "privacy":"ai_assisted",
        "explicitDestinationNoteId":"note_00000000000000000000000009",
        "expansionDisabled":false
      }'::jsonb
    )
  $$,
  '42501',
  'explicit_destination_not_owned',
  'an explicit destination must belong to the caller'
);
select is(
  (
    select count(*)
    from public.captures
    where id = 'cap_70000000000000000000000002'
  ),
  0::bigint,
  'a rejected capture leaves no partial capture row behind'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    select public.create_capture_with_job(
      '{
        "clientCaptureId":"cap_70000000000000000000000001",
        "rawContent":"collide with another user''s capture id",
        "source":"web",
        "clientCreatedAt":"2026-08-30T20:05:00Z",
        "clientTimezone":"UTC",
        "privacy":"ai_assisted",
        "expansionDisabled":false
      }'::jsonb
    )
  $$,
  '23505',
  'capture_id_conflict',
  'a cross-user capture ID collision fails without returning the existing row'
);
select is(
  (
    select count(*)
    from public.captures
    where id = 'cap_70000000000000000000000001'
  ),
  0::bigint,
  'RLS still hides the collided capture from the second user'
);

select * from finish();
rollback;
