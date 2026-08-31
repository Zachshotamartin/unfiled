create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.retention_capture_envelope(
  p_capture_id text,
  p_owner_id text,
  p_nonce_character text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'retention-test-kek-v1',
    'context', jsonb_build_object(
      'tenantId', p_owner_id,
      'resourceId', p_capture_id,
      'recordVersion', 1,
      'kind', 'capture'
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat(p_nonce_character, 16),
      'ciphertext', repeat(p_nonce_character, 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat(p_nonce_character, 16),
      'ciphertext', repeat(p_nonce_character, 22)
    )
  );
$$;

select is(
  (
    select confdeltype::text
    from pg_constraint
    where conname = 'capture_receipts_destination_note_id_fkey'
  ),
  'n',
  'receipt destinations become null if a reviewed purge misses a historical row'
);
select is(
  (
    select confdeltype::text
    from pg_constraint
    where conname = 'capture_receipts_mutation_id_fkey'
  ),
  'n',
  'receipt mutation references use ON DELETE SET NULL as a final safety net'
);
select is(
  (
    select confdeltype::text
    from pg_constraint
    where conname = 'capture_receipts_review_item_id_fkey'
  ),
  'n',
  'receipt review references use ON DELETE SET NULL as a final safety net'
);
select ok(
  to_regprocedure('private.note_retention_capture_ids(text)') is not null,
  'retention has a complete capture-discovery helper'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.note_retention_capture_ids(text)',
    'EXECUTE'
  ),
  'service workers cannot bypass the reviewed retention entry point'
);
select ok(
  position(
    'order by job_record.id' in pg_get_functiondef(
      'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure
    )
  ) > 0
    and position(
      'order by capture_record.id' in pg_get_functiondef(
        'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure
      )
    ) > 0,
  'retention acquires multi-workflow job and capture locks deterministically'
);

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, deleted_at
)
values
  (
    'note_75600000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Expired routed receipt',
    'Routed content due for hard deletion.',
    '{"schemaVersion":1}'::jsonb,
    2,
    '2026-07-01T12:00:00Z'
  ),
  (
    'note_75600000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Expired review receipt',
    'Review content due for hard deletion.',
    '{"schemaVersion":1}'::jsonb,
    1,
    '2026-07-01T12:00:00Z'
  ),
  (
    'note_75600000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Expired note with active workflow',
    'Must remain until its workflow reaches a terminal state.',
    '{"schemaVersion":1}'::jsonb,
    1,
    '2026-07-01T12:00:00Z'
  );

insert into public.captures (
  id, user_id, source, raw_text, explicit_destination_note_id,
  client_created_at, client_timezone, status, content_envelope,
  content_fingerprint, content_length
)
values
  (
    'cap_75600000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'web',
    '[encrypted]',
    'note_75600000000000000000000001',
    '2026-07-01T11:00:00Z',
    'UTC',
    'organized',
    pg_temp.retention_capture_envelope(
      'cap_75600000000000000000000001',
      '11111111-1111-4111-8111-111111111111',
      'A'
    ),
    repeat('a', 64),
    24
  ),
  (
    'cap_75600000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'web',
    '[encrypted]',
    null,
    '2026-07-01T11:01:00Z',
    'UTC',
    'needs_review',
    pg_temp.retention_capture_envelope(
      'cap_75600000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      'B'
    ),
    repeat('b', 64),
    25
  ),
  (
    'cap_75600000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    'web',
    '[encrypted]',
    'note_75600000000000000000000003',
    '2026-07-01T11:02:00Z',
    'UTC',
    'processing',
    pg_temp.retention_capture_envelope(
      'cap_75600000000000000000000003',
      '11111111-1111-4111-8111-111111111111',
      'C'
    ),
    repeat('c', 64),
    26
  );

insert into public.organization_jobs (
  id, capture_id, user_id, state, attempt, prompt_version, schema_version,
  started_at, completed_at, lease_owner, lease_token, lease_expires_at,
  last_heartbeat_at
)
values
  (
    'job_75600000000000000000000001',
    'cap_75600000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'succeeded', 1, 'retention-receipt-test', 1,
    '2026-07-01T11:00:01Z', '2026-07-01T11:00:02Z',
    null, null, null, null
  ),
  (
    'job_75600000000000000000000002',
    'cap_75600000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'succeeded', 1, 'retention-receipt-test', 1,
    '2026-07-01T11:01:01Z', '2026-07-01T11:01:02Z',
    null, null, null, null
  ),
  (
    'job_75600000000000000000000003',
    'cap_75600000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    'running', 1, 'retention-receipt-test', 1,
    '2026-07-01T11:02:01Z', null,
    'retention-test-worker',
    '75600000-0000-4000-8000-000000000003',
    '2099-01-01T00:00:00Z',
    '2026-07-01T11:02:02Z'
  );

insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes
)
values
  (
    'dec_75600000000000000000000001',
    'cap_75600000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    '{"candidateIds":["note_75600000000000000000000001"]}'::jsonb,
    '{}'::jsonb,
    '{"decision":"append_to_note"}'::jsonb,
    'auto',
    'note_75600000000000000000000001',
    array['exact_destination']
  ),
  (
    'dec_75600000000000000000000002',
    'cap_75600000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    '{"candidateIds":["note_75600000000000000000000002"]}'::jsonb,
    '{}'::jsonb,
    '{"decision":"needs_review"}'::jsonb,
    'review',
    'note_75600000000000000000000002',
    array['low_confidence']
  );

insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key, before_revision,
  after_revision, operations, inverse
)
values (
  'mut_75600000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'dec_75600000000000000000000001',
  'note_75600000000000000000000001',
  'retention-routed-mutation',
  1,
  2,
  '[{"type":"append_markdown","markdown":"Added content"}]'::jsonb,
  '[]'::jsonb
);

insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices
)
values (
  'rvw_75600000000000000000000002',
  '11111111-1111-4111-8111-111111111111',
  'cap_75600000000000000000000002',
  'note_75600000000000000000000002',
  'low_confidence',
  '[{"noteId":"note_75600000000000000000000002"}]'::jsonb
);

insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, review_item_id, mutation_id,
  outcome, headline, destination_note_id, inserted_content, actions,
  reason_codes
)
values
  (
    'cap_75600000000000000000000001',
    'job_75600000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'dec_75600000000000000000000001',
    null,
    'mut_75600000000000000000000001',
    'added_to_note',
    'Added to expired routed note',
    'note_75600000000000000000000001',
    '[{"kind":"markdown","value":"Added content"}]'::jsonb,
    '[{"type":"open_note","noteId":"note_75600000000000000000000001"}]'::jsonb,
    array[
      'r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08', 'r09', 'r10',
      'r11', 'r12', 'r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20'
    ]
  ),
  (
    'cap_75600000000000000000000002',
    'job_75600000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'dec_75600000000000000000000002',
    'rvw_75600000000000000000000002',
    null,
    'needs_review',
    'Review expired destination',
    null,
    '[]'::jsonb,
    '[]'::jsonb,
    array['low_confidence']
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    100,
    true
  ) ->> 'purgedCount',
  '2',
  'retention purges routed and Review notes while deferring an active workflow'
);
reset role;

select is(
  (
    select count(*)
    from public.notes
    where id in (
      'note_75600000000000000000000001',
      'note_75600000000000000000000002'
    )
  ),
  0::bigint,
  'both terminal receipt destinations are hard deleted'
);
select ok(
  exists (
    select 1 from public.notes
    where id = 'note_75600000000000000000000003'
  ),
  'an expired note with a live workflow remains recoverable for a later sweep'
);
select ok(
  (
    select outcome = 'kept_in_inbox'
      and headline = 'Kept in Inbox after note expired'
      and destination_note_id is null
      and mutation_id is null
      and review_item_id is null
      and inserted_content = '[]'::jsonb
      and actions = '[]'::jsonb
      and cardinality(reason_codes) = 20
      and 'destination_expired' = any(reason_codes)
    from public.capture_receipts
    where capture_id = 'cap_75600000000000000000000001'
  ),
  'routed receipt becomes bounded non-actionable Inbox history'
);
select ok(
  (
    select outcome = 'kept_in_inbox'
      and headline = 'Kept in Inbox after note expired'
      and destination_note_id is null
      and mutation_id is null
      and review_item_id is null
      and inserted_content = '[]'::jsonb
      and actions = '[]'::jsonb
      and 'destination_expired' = any(reason_codes)
    from public.capture_receipts
    where capture_id = 'cap_75600000000000000000000002'
  ),
  'Review receipt loses every stale actionable target before cascade'
);
select is(
  (
    select string_agg(id || ':' || status::text, ',' order by id)
    from public.captures
    where id in (
      'cap_75600000000000000000000001',
      'cap_75600000000000000000000002'
    )
  ),
  'cap_75600000000000000000000001:inbox,cap_75600000000000000000000002:inbox',
  'terminal captures return to non-actionable Inbox state'
);
select is(
  (
    select string_agg(id || ':' || state::text, ',' order by id)
    from public.organization_jobs
    where id in (
      'job_75600000000000000000000001',
      'job_75600000000000000000000002'
    )
  ),
  'job_75600000000000000000000001:succeeded,job_75600000000000000000000002:succeeded',
  'terminal workflow audit state remains truthful'
);
select ok(
  not exists (
    select 1 from public.note_mutations
    where id = 'mut_75600000000000000000000001'
  )
    and not exists (
      select 1 from public.review_items
      where id = 'rvw_75600000000000000000000002'
    ),
  'cascaded mutation and Review rows are gone after receipt downgrade'
);
select is(
  (
    select count(*)
    from public.user_events
    where entity_id in (
      'cap_75600000000000000000000001',
      'cap_75600000000000000000000002'
    )
      and entity in ('capture', 'capture_receipt')
  ),
  4::bigint,
  'receipt and capture changes emit cross-device cursor events'
);
select is(
  (
    select count(*)
    from public.user_events
    where entity = 'note_purged'
      and entity_id in (
        'note_75600000000000000000000001',
        'note_75600000000000000000000002'
      )
  ),
  2::bigint,
  'each hard-deleted note emits one purge tombstone'
);
select ok(
  (
    select status = 'processing'
      and explicit_destination_note_id = 'note_75600000000000000000000003'
    from public.captures
    where id = 'cap_75600000000000000000000003'
  )
    and (
      select state = 'running'
      from public.organization_jobs
      where id = 'job_75600000000000000000000003'
    ),
  'retention does not rewrite a live capture or lease'
);

insert into public.notes (
  id, user_id, type, title, structured_data, deleted_at
)
values (
  'note_75600000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  'generic',
  'Cross-owner capture relation without job',
  '{"schemaVersion":1}'::jsonb,
  '2026-07-01T12:00:00Z'
);
insert into public.captures (
  id, user_id, source, raw_text, client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length
)
values (
  'cap_75600000000000000000000004',
  '22222222-2222-4222-8222-222222222222',
  'web',
  '[encrypted]',
  '2026-07-01T11:04:00Z',
  'UTC',
  'inbox',
  pg_temp.retention_capture_envelope(
    'cap_75600000000000000000000004',
    '22222222-2222-4222-8222-222222222222',
    'D'
  ),
  repeat('d', 64),
  28
);
insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices
)
values (
  'rvw_75600000000000000000000004',
  '11111111-1111-4111-8111-111111111111',
  'cap_75600000000000000000000004',
  'note_75600000000000000000000004',
  'low_confidence',
  '[]'::jsonb
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    100,
    true
  )$$,
  '23514',
  'owner_scope_violation',
  'a cross-owner related capture is rejected even when it has no job'
);
reset role;
select ok(
  exists (
    select 1 from public.notes
    where id = 'note_75600000000000000000000004'
  )
    and exists (
      select 1 from public.review_items
      where id = 'rvw_75600000000000000000000004'
    ),
  'cross-owner failure leaves the complete relation untouched'
);

select * from finish();
rollback;
