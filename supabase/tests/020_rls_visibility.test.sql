create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

-- Complete the synthetic second-user graph inside this transaction so every
-- user-owned table has an owned row and a cross-user row to probe.
insert into public.user_provider_keys (
  id, user_id, provider, key_ciphertext, key_last4, created_at, updated_at
)
values
  (
    'key_70000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'openai',
    'synthetic-ciphertext-a',
    '0001',
    '2026-08-30 22:00:00+00',
    '2026-08-30 22:00:00+00'
  ),
  (
    'key_70000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'openai',
    'synthetic-ciphertext-b',
    '0009',
    '2026-08-30 22:00:00+00',
    '2026-08-30 22:00:00+00'
  );

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at
)
values (
  'note_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic',
  'Other user link target',
  'Synthetic cross-user target.',
  '{}'::jsonb,
  1,
  'private_manual',
  '2026-08-30 22:01:00+00',
  '2026-08-30 22:01:00+00'
);

insert into public.captures (
  id, user_id, source, raw_text, client_created_at, client_timezone,
  received_at, status, deleted_at
)
values (
  'cap_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'web',
  '[deleted]',
  '2026-08-30 22:02:00+00',
  'UTC',
  '2026-08-30 22:02:01+00',
  'deleted',
  '2026-08-30 22:03:00+00'
);

insert into public.organization_jobs (
  id, capture_id, user_id, state, attempt, prompt_version, schema_version,
  model_id, created_at
)
values (
  'job_70000000000000000000000009',
  'cap_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'succeeded',
  1,
  'routing-v1',
  1,
  'fake-model-v1',
  '2026-08-30 22:02:01+00'
);

insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan, band,
  score, margin, destination_note_id, reason_codes, created_at
)
values (
  'dec_70000000000000000000000009',
  'cap_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  '{"candidateIds":["note_00000000000000000000000009"]}'::jsonb,
  '{}'::jsonb,
  '{"schemaVersion":1,"decision":"append_to_note"}'::jsonb,
  'auto',
  0.900,
  0.800,
  'note_00000000000000000000000009',
  array['semantic_match'],
  '2026-08-30 22:02:02+00'
);

insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key, before_revision,
  after_revision, operations, inverse, created_at
)
values (
  'mut_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'dec_70000000000000000000000009',
  'note_00000000000000000000000009',
  'visibility-other-user-mutation',
  1,
  2,
  '[]'::jsonb,
  '[]'::jsonb,
  '2026-08-30 22:02:03+00'
);

insert into public.generated_blocks (
  id, user_id, note_id, decision_id, kind, content, state, model_id,
  prompt_version, created_at
)
values
  (
    'blk_70000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'note_00000000000000000000000003',
    'dec_00000000000000000000000002',
    'suggestion',
    'Synthetic owned generated block.',
    'proposed',
    'fake-model-v1',
    'routing-v1',
    '2026-08-30 22:03:00+00'
  ),
  (
    'blk_70000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'note_00000000000000000000000009',
    'dec_70000000000000000000000009',
    'suggestion',
    'Synthetic cross-user generated block.',
    'proposed',
    'fake-model-v1',
    'routing-v1',
    '2026-08-30 22:03:00+00'
  );

insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation, created_at
)
values (
  'cap_70000000000000000000000009',
  'note_00000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'mut_70000000000000000000000009',
  'routed',
  '2026-08-30 22:03:00+00'
);

insert into public.routing_rules (
  id, user_id, rule_type, condition_normalized, destination_note_id, priority,
  source, created_at, updated_at
)
values (
  'rule_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'alias',
  'other-fixture',
  'note_00000000000000000000000009',
  10,
  'explicit',
  '2026-08-30 22:04:00+00',
  '2026-08-30 22:04:00+00'
);

insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices, state, created_at
)
values (
  'rvw_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'cap_70000000000000000000000009',
  'note_00000000000000000000000009',
  'low_confidence',
  '[]'::jsonb,
  'open',
  '2026-08-30 22:04:00+00'
);

insert into public.note_chunks (
  id, note_id, user_id, revision, ordinal, text_hash, content, created_at
)
values
  (
    'chk_70000000000000000000000001',
    'note_00000000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    1,
    0,
    repeat('a', 64),
    'Synthetic owned search chunk.',
    '2026-08-30 22:05:00+00'
  ),
  (
    'chk_70000000000000000000000009',
    'note_00000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    1,
    0,
    repeat('b', 64),
    'Synthetic cross-user search chunk.',
    '2026-08-30 22:05:00+00'
  );

insert into public.tags (id, user_id, name, created_at)
values (
  'tag_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'other-fixture',
  '2026-08-30 22:06:00+00'
);

insert into public.note_tags (note_id, tag_id, user_id, created_at)
values (
  'note_00000000000000000000000009',
  'tag_70000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  '2026-08-30 22:06:00+00'
);

insert into public.note_links (
  id, user_id, from_note_id, to_note_id, link_type, source, created_at
)
values
  (
    'lnk_70000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'note_00000000000000000000000003',
    'note_00000000000000000000000004',
    'related',
    'manual',
    '2026-08-30 22:07:00+00'
  ),
  (
    'lnk_70000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'note_00000000000000000000000009',
    'note_70000000000000000000000009',
    'related',
    'manual',
    '2026-08-30 22:07:00+00'
  );

insert into public.feedback_events (
  id, user_id, decision_id, action, old_destination_note_id,
  new_destination_note_id, reason_code, created_at
)
values
  (
    'fbk_70000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'dec_00000000000000000000000001',
    'accepted',
    null,
    'note_00000000000000000000000001',
    'visibility_fixture',
    '2026-08-30 22:08:00+00'
  ),
  (
    'fbk_70000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'dec_70000000000000000000000009',
    'accepted',
    null,
    'note_00000000000000000000000009',
    'visibility_fixture',
    '2026-08-30 22:08:00+00'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(37);

select ok(exists(select 1 from public.profiles where id = auth.uid()), 'profiles: owned row visible');
select ok(not exists(select 1 from public.profiles where id = '22222222-2222-4222-8222-222222222222'), 'profiles: cross-user row hidden');
select throws_ok('select * from public.user_provider_keys', '42501', 'permission denied for table user_provider_keys', 'user_provider_keys: all client reads denied');

select ok(exists(select 1 from public.spaces where id = 'spc_00000000000000000000000001'), 'spaces: owned row visible');
select ok(not exists(select 1 from public.spaces where id = 'spc_00000000000000000000000009'), 'spaces: cross-user row hidden');
select ok(exists(select 1 from public.notes where id = 'note_00000000000000000000000001'), 'notes: owned row visible');
select ok(not exists(select 1 from public.notes where id = 'note_00000000000000000000000009'), 'notes: cross-user row hidden');
select ok(exists(select 1 from public.note_revisions where id = 'rev_00000000000000000000000001'), 'note_revisions: owned row visible');
select ok(not exists(select 1 from public.note_revisions where id = 'rev_00000000000000000000000009'), 'note_revisions: cross-user row hidden');
select ok(
  not has_table_privilege('authenticated', 'public.captures', 'SELECT'),
  'captures: clients have no direct read privilege'
);
select throws_ok(
  'select * from public.captures',
  '42501',
  'permission denied for table captures',
  'captures: even an owned ciphertext row is available only through the server boundary'
);
select ok(
  not has_table_privilege('authenticated', 'public.organization_jobs', 'SELECT'),
  'organization_jobs: clients cannot read worker lease capabilities'
);
select throws_ok(
  'select * from public.organization_jobs',
  '42501',
  'permission denied for table organization_jobs',
  'organization_jobs: even an owned queue row is available only through reviewed server projections'
);
select ok(exists(select 1 from public.organization_decisions where id = 'dec_00000000000000000000000001'), 'organization_decisions: owned row visible');
select ok(not exists(select 1 from public.organization_decisions where id = 'dec_70000000000000000000000009'), 'organization_decisions: cross-user row hidden');
select ok(exists(select 1 from public.note_mutations where id = 'mut_00000000000000000000000001'), 'note_mutations: owned row visible');
select ok(not exists(select 1 from public.note_mutations where id = 'mut_70000000000000000000000009'), 'note_mutations: cross-user row hidden');
select ok(exists(select 1 from public.generated_blocks where id = 'blk_70000000000000000000000001'), 'generated_blocks: owned row visible');
select ok(not exists(select 1 from public.generated_blocks where id = 'blk_70000000000000000000000009'), 'generated_blocks: cross-user row hidden');
select ok(exists(select 1 from public.capture_note_links where capture_id = 'cap_00000000000000000000000001'), 'capture_note_links: owned row visible');
select ok(not exists(select 1 from public.capture_note_links where capture_id = 'cap_70000000000000000000000009'), 'capture_note_links: cross-user row hidden');
select ok(exists(select 1 from public.routing_rules where id = 'rule_00000000000000000000000001'), 'routing_rules: owned row visible');
select ok(not exists(select 1 from public.routing_rules where id = 'rule_70000000000000000000000009'), 'routing_rules: cross-user row hidden');
select ok(exists(select 1 from public.review_items where id = 'rvw_00000000000000000000000001'), 'review_items: owned row visible');
select ok(not exists(select 1 from public.review_items where id = 'rvw_70000000000000000000000009'), 'review_items: cross-user row hidden');
select ok(exists(select 1 from public.note_chunks where id = 'chk_70000000000000000000000001'), 'note_chunks: owned row visible');
select ok(not exists(select 1 from public.note_chunks where id = 'chk_70000000000000000000000009'), 'note_chunks: cross-user row hidden');
select ok(exists(select 1 from public.tags where id = 'tag_00000000000000000000000001'), 'tags: owned row visible');
select ok(not exists(select 1 from public.tags where id = 'tag_70000000000000000000000009'), 'tags: cross-user row hidden');
select ok(exists(select 1 from public.note_tags where tag_id = 'tag_00000000000000000000000001'), 'note_tags: owned row visible');
select ok(not exists(select 1 from public.note_tags where tag_id = 'tag_70000000000000000000000009'), 'note_tags: cross-user row hidden');
select ok(exists(select 1 from public.note_links where id = 'lnk_70000000000000000000000001'), 'note_links: owned row visible');
select ok(not exists(select 1 from public.note_links where id = 'lnk_70000000000000000000000009'), 'note_links: cross-user row hidden');
select ok(exists(select 1 from public.feedback_events where id = 'fbk_70000000000000000000000001'), 'feedback_events: owned row visible');
select ok(not exists(select 1 from public.feedback_events where id = 'fbk_70000000000000000000000009'), 'feedback_events: cross-user row hidden');
select ok(exists(select 1 from public.user_events where seq = 1001), 'user_events: owned row visible');
select ok(not exists(select 1 from public.user_events where seq = 1004), 'user_events: cross-user row hidden');

select * from finish();
rollback;
