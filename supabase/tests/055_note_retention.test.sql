create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select plan(41);

select has_index('public', 'notes', 'notes_deleted_retention', 'deleted-note sweep has a partial retention index');
select ok(
  to_regprocedure('public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)') is not null,
  'bounded note-retention RPC exists'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure),
  'note-retention RPC is SECURITY DEFINER'
);
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure),
  'note-retention RPC pins an empty search path'
);
select ok(
  not has_function_privilege('authenticated', 'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)', 'EXECUTE'),
  'authenticated clients cannot execute hard deletion'
);
select ok(
  not has_function_privilege('anon', 'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)', 'EXECUTE'),
  'anonymous clients cannot execute hard deletion'
);
select ok(
  has_function_privilege('service_role', 'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)', 'EXECUTE'),
  'only the service path can execute retention'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select public.purge_expired_deleted_notes(null, '2026-08-30T12:00:00Z', 100, true)$$,
  '42501',
  'permission denied for function purge_expired_deleted_notes',
  'an anonymous caller cannot execute the retention RPC'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.purge_expired_deleted_notes(null, '2026-08-30T12:00:00Z', 100, true)$$,
  '42501',
  'permission denied for function purge_expired_deleted_notes',
  'an authenticated user cannot bypass the recovery window through the RPC'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.purge_expired_deleted_notes(null, '2026-08-30T12:00:00Z', 0, false)$$,
  '22023',
  'validation_failed',
  'retention rejects an unbounded zero-sized batch'
);
select throws_ok(
  $$select public.purge_expired_deleted_notes(null, '2026-08-30T12:00:00Z', 100, null)$$,
  '22023',
  'validation_failed',
  'retention requires an explicit dry-run or execution decision'
);
reset role;

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data, deleted_at
)
values
  (
    'note_75000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Retention exact cutoff',
    'Content that must disappear with every derived copy.',
    '{"schemaVersion":1}'::jsonb,
    '2026-07-31T12:00:00Z'
  ),
  (
    'note_75000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Retention still recoverable',
    'One second remains inside the recovery window.',
    '{"schemaVersion":1}'::jsonb,
    '2026-07-31T12:00:01Z'
  ),
  (
    'note_75000000000000000000000003',
    '22222222-2222-4222-8222-222222222222',
    'generic',
    'Other owner expired note',
    'Owner-scoped runs must not touch this row.',
    '{"schemaVersion":1}'::jsonb,
    '2026-07-30T12:00:00Z'
  ),
  (
    'note_75000000000000000000000004',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Retention live link target',
    'This active note remains.',
    '{"schemaVersion":1}'::jsonb,
    null
  );

insert into public.note_revisions (
  id, note_id, user_id, revision, source, type, title, body_markdown,
  structured_data, is_open, privacy, tag_ids, links, content_hash, actor,
  deleted_at
)
values (
  'rev_75000000000000000000000001',
  'note_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  1,
  'manual',
  'generic',
  'Retention exact cutoff',
  'Content that must disappear with every derived copy.',
  '{"schemaVersion":1}'::jsonb,
  true,
  'ai_assisted',
  '[]'::jsonb,
  '[]'::jsonb,
  encode(digest('retention-revision', 'sha256'), 'hex'),
  'user:test',
  '2026-07-31T12:00:00Z'
);

insert into public.note_chunks (
  id, note_id, user_id, revision, ordinal, text_hash, content
)
values (
  'chk_75000000000000000000000001',
  'note_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  1,
  0,
  encode(digest('retention chunk', 'sha256'), 'hex'),
  'retention chunk'
);

insert into public.captures (
  id, user_id, source, raw_text, explicit_destination_note_id,
  client_created_at, client_timezone, status, deleted_at
)
values (
  'cap_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'web',
  '[deleted]',
  'note_75000000000000000000000001',
  '2026-07-01T12:00:00Z',
  'UTC',
  'deleted',
  '2026-07-01T12:01:00Z'
);

insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
)
values (
  'job_75000000000000000000000001',
  'cap_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'succeeded',
  'retention-test',
  1
);

insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, band,
  destination_note_id
)
values (
  'dec_75000000000000000000000001',
  'cap_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  '{}'::jsonb,
  '{}'::jsonb,
  'auto',
  'note_75000000000000000000000001'
);

insert into public.generated_blocks (
  id, user_id, note_id, decision_id, kind, content, model_id, prompt_version
)
values (
  'blk_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_75000000000000000000000001',
  'dec_75000000000000000000000001',
  'summary',
  'derived retention content',
  'fixture-model',
  'retention-test'
);

insert into public.routing_rules (
  id, user_id, rule_type, condition_normalized, destination_note_id, source
)
values (
  'rule_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'phrase',
  'retention exact cutoff',
  'note_75000000000000000000000001',
  'explicit'
);

insert into public.review_items (id, user_id, note_id, type)
values (
  'rvw_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_75000000000000000000000001',
  'low_confidence'
);

insert into public.note_links (
  id, user_id, from_note_id, to_note_id, link_type, source
)
values (
  'lnk_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'note_75000000000000000000000001',
  'note_75000000000000000000000004',
  'reference',
  'manual'
);

insert into public.feedback_events (
  id, user_id, decision_id, action, old_destination_note_id, new_destination_note_id
)
values (
  'fbk_75000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'dec_75000000000000000000000001',
  'accepted',
  'note_75000000000000000000000001',
  'note_75000000000000000000000001'
);

insert into public.api_idempotency_records (
  user_id, idempotency_key, scope, request_hash, response_json, completed_at
)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'retention-note-response',
    'create_note',
    encode(digest('retention note request', 'sha256'), 'hex'),
    '{"note":{"id":"note_75000000000000000000000001","bodyMarkdown":"must disappear"}}'::jsonb,
    '2026-07-31T12:00:00Z'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    'retention-unrelated-response',
    'create_space',
    encode(digest('retention unrelated request', 'sha256'), 'hex'),
    '{"space":{"id":"spc_00000000000000000000000001"}}'::jsonb,
    '2026-07-31T12:00:00Z'
  );

insert into public.user_events (user_id, entity, entity_id, occurred_at)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'note',
    'note_75000000000000000000000001',
    '2026-07-31T12:00:00Z'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    'note_revision',
    'rev_75000000000000000000000001',
    '2026-07-31T12:00:00Z'
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    100
  ) ->> 'eligibleCount',
  '1',
  'dry run counts the exact-cutoff owner note'
);
select is(
  public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    100
  ) ->> 'executed',
  'false',
  'omitting the execution flag is safely non-destructive'
);
reset role;
select ok(
  exists (select 1 from public.notes where id = 'note_75000000000000000000000001'),
  'dry run preserves an eligible note'
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
  '1',
  'execution permanently removes one exact-cutoff note'
);
select is(
  public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    100,
    true
  ) ->> 'executed',
  'true',
  'execution result states that the destructive path ran'
);
reset role;

select ok(not exists (select 1 from public.notes where id = 'note_75000000000000000000000001'), 'expired note is hard deleted');
select ok(not exists (select 1 from public.note_revisions where note_id = 'note_75000000000000000000000001'), 'revision history is hard deleted');
select ok(not exists (select 1 from public.note_chunks where note_id = 'note_75000000000000000000000001'), 'search text and embedding row are hard deleted');
select ok(not exists (select 1 from public.generated_blocks where note_id = 'note_75000000000000000000000001'), 'generated content is hard deleted');
select is(
  (
    (select count(*) from public.note_links where from_note_id = 'note_75000000000000000000000001' or to_note_id = 'note_75000000000000000000000001')
    + (select count(*) from public.routing_rules where destination_note_id = 'note_75000000000000000000000001')
    + (select count(*) from public.review_items where note_id = 'note_75000000000000000000000001')
  ),
  0::bigint,
  'links, routing rules, and pending review artifacts are removed'
);
select is(
  (select explicit_destination_note_id from public.captures where id = 'cap_75000000000000000000000001'),
  null,
  'capture provenance remains without a deleted explicit destination'
);
select is(
  (select destination_note_id from public.organization_decisions where id = 'dec_75000000000000000000000001'),
  null,
  'organization telemetry remains without a deleted destination'
);
select ok(
  (select old_destination_note_id is null and new_destination_note_id is null from public.feedback_events where id = 'fbk_75000000000000000000000001'),
  'feedback telemetry remains without deleted destinations'
);
select ok(
  not exists (
    select 1 from public.api_idempotency_records
    where idempotency_key = 'retention-note-response'
  ),
  'note snapshot is removed from the idempotency ledger'
);
select ok(
  exists (
    select 1 from public.api_idempotency_records
    where idempotency_key = 'retention-unrelated-response'
  ),
  'unrelated owner idempotency state is preserved'
);
select is(
  (
    select count(*) from public.user_events
    where entity_id in (
      'note_75000000000000000000000001',
      'rev_75000000000000000000000001'
    ) and entity <> 'note_purged'
  ),
  0::bigint,
  'stale note and revision cursor events are pruned'
);
select ok(
  exists (
    select 1 from public.user_events
    where user_id = '11111111-1111-4111-8111-111111111111'
      and entity = 'note_purged'
      and entity_id = 'note_75000000000000000000000001'
  ),
  'owner receives a durable purge tombstone'
);
select ok(
  exists (select 1 from public.notes where id = 'note_75000000000000000000000002'),
  'a note one second inside the 30-day window remains recoverable'
);
select ok(
  exists (select 1 from public.notes where id = 'note_75000000000000000000000003'),
  'an owner-scoped run leaves another owner untouched'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.purge_expired_deleted_notes(
    '22222222-2222-4222-8222-222222222222',
    '2026-08-30T12:00:00Z',
    100,
    true
  ) ->> 'purgedCount',
  '1',
  'the other owner can be swept in its own scope'
);
reset role;
select ok(
  not exists (select 1 from public.notes where id = 'note_75000000000000000000000003'),
  'the separately scoped owner note is deleted'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select is(
  public.create_note(
    'retention-real-create',
    'generic',
    'Retention real mutation graph',
    'Created through the production mutation path.'
  ) ->> 'replayed',
  'false',
  'retention fixture is created through the real mutation path'
);
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'Retention real mutation graph'),
    1,
    '[{"type":"set_deleted","deletedAt":"2026-07-01T12:00:00.000Z"}]'::jsonb,
    'retention-real-delete'
  ) -> 'note' ->> 'currentRevision',
  '2',
  'retention fixture is soft-deleted through the typed mutation pipeline'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.purge_expired_deleted_notes(
    '22222222-2222-4222-8222-222222222222',
    '2026-08-30T12:00:00Z',
    100,
    true
  ) ->> 'purgedCount',
  '1',
  'hard deletion accepts the production revision and mutation graph'
);
reset role;
select is(
  (
    (select count(*) from public.notes where title = 'Retention real mutation graph')
    + (select count(*) from public.note_revisions where title = 'Retention real mutation graph')
    + (select count(*) from public.note_mutations where idempotency_key in (
      'retention-real-create',
      'retention-real-delete'
    ))
  ),
  0::bigint,
  'real note, linked revisions, and mutation receipts are all removed'
);

insert into public.notes (id, user_id, type, title, structured_data, deleted_at)
values
  (
    'note_75000000000000000000000006',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Retention bounded one',
    '{"schemaVersion":1}'::jsonb,
    '2026-07-01T12:00:00Z'
  ),
  (
    'note_75000000000000000000000007',
    '11111111-1111-4111-8111-111111111111',
    'generic',
    'Retention bounded two',
    '{"schemaVersion":1}'::jsonb,
    '2026-07-02T12:00:00Z'
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.purge_expired_deleted_notes(
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30T12:00:00Z',
    1,
    true
  ) ->> 'purgedCount',
  '1',
  'execution never exceeds the requested batch bound'
);
reset role;
select is(
  (select count(*) from public.notes where id in (
    'note_75000000000000000000000006',
    'note_75000000000000000000000007'
  )),
  1::bigint,
  'a bounded batch leaves the next eligible note for a later run'
);

insert into public.notes (id, user_id, type, title, structured_data, deleted_at)
values (
  'note_75000000000000000000000005',
  '11111111-1111-4111-8111-111111111111',
  'generic',
  'Retention corrupt ownership guard',
  '{"schemaVersion":1}'::jsonb,
  '2026-07-01T12:00:00Z'
);
insert into public.captures (
  id, user_id, source, raw_text, explicit_destination_note_id,
  client_created_at, client_timezone, status, deleted_at
)
values (
  'cap_75000000000000000000000005',
  '22222222-2222-4222-8222-222222222222',
  'web',
  '[deleted]',
  'note_75000000000000000000000005',
  '2026-07-01T12:00:00Z',
  'UTC',
  'deleted',
  '2026-07-01T12:01:00Z'
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
  'retention fails closed on a privileged cross-owner relation'
);
reset role;
select ok(
  exists (select 1 from public.notes where id = 'note_75000000000000000000000005'),
  'owner-scope failure preserves the candidate note'
);
select is(
  (select explicit_destination_note_id from public.captures where id = 'cap_75000000000000000000000005'),
  'note_75000000000000000000000005',
  'owner-scope failure preserves the other account relation'
);

select * from finish();
rollback;
