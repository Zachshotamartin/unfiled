-- Deterministic local fixtures only. Every person, note, and capture below is
-- synthetic and reserved for local development and automated tests.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'demo@unfiled.local',
    extensions.crypt('unfiled-local-demo', '$2a$10$0123456789012345678901'),
    '2026-08-30 16:00:00+00',
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Synthetic Demo"}'::jsonb,
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'other-user@unfiled.local',
    extensions.crypt('unfiled-local-other', '$2a$10$1234567890123456789012'),
    '2026-08-30 16:00:00+00',
    '',
    '',
    '',
    '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Synthetic Other User"}'::jsonb,
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  )
on conflict (id) do update
set
  email = excluded.email,
  encrypted_password = excluded.encrypted_password,
  raw_app_meta_data = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at = excluded.updated_at;

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'demo@unfiled.local',
    '{"sub":"11111111-1111-4111-8111-111111111111","email":"demo@unfiled.local"}'::jsonb,
    'email',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '22222222-2222-4222-8222-222222222222',
    'other-user@unfiled.local',
    '{"sub":"22222222-2222-4222-8222-222222222222","email":"other-user@unfiled.local"}'::jsonb,
    'email',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  )
on conflict do nothing;

insert into public.profiles (
  id,
  display_name,
  timezone,
  locale,
  org_mode,
  expansion_enabled,
  routing_effort,
  expansion_style,
  created_at,
  updated_at
)
values
  (
    '11111111-1111-4111-8111-111111111111',
    'Synthetic Demo',
    'America/Los_Angeles',
    'en-US',
    'balanced',
    true,
    'standard',
    'brief',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'Synthetic Other User',
    'UTC',
    'en-US',
    'cautious',
    false,
    'economical',
    'off',
    '2026-08-30 16:00:00+00',
    '2026-08-30 16:00:00+00'
  )
on conflict (id) do update
set
  display_name = excluded.display_name,
  timezone = excluded.timezone,
  locale = excluded.locale,
  org_mode = excluded.org_mode,
  expansion_enabled = excluded.expansion_enabled,
  routing_effort = excluded.routing_effort,
  expansion_style = excluded.expansion_style,
  updated_at = excluded.updated_at;

insert into public.spaces (id, user_id, name, slug, sort_key, created_at, updated_at)
values
  (
    'spc_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Life',
    'life',
    'a0',
    '2026-08-30 16:01:00+00',
    '2026-08-30 16:01:00+00'
  ),
  (
    'spc_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'Projects',
    'projects',
    'b0',
    '2026-08-30 16:02:00+00',
    '2026-08-30 16:02:00+00'
  ),
  (
    'spc_00000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'Private fixture',
    'private-fixture',
    'a0',
    '2026-08-30 16:03:00+00',
    '2026-08-30 16:03:00+00'
  )
on conflict (id) do nothing;

insert into public.notes (
  id,
  user_id,
  space_id,
  type,
  title,
  body_markdown,
  structured_data,
  current_revision,
  daily_date,
  privacy,
  created_at,
  updated_at
)
values
  (
    'note_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'spc_00000000000000000000000001',
    'list',
    'Shopping',
    E'- [ ] milk\n- [ ] spinach',
    '{"schemaVersion":1,"items":[{"id":"itm_00000000000000000000000001","text":"milk","checked":false,"checkedAt":null,"ordinal":"a0","sourceCaptureId":null,"createdAt":"2026-08-30T16:05:00Z"},{"id":"itm_00000000000000000000000002","text":"spinach","checked":false,"checkedAt":null,"ordinal":"b0","sourceCaptureId":"cap_00000000000000000000000001","createdAt":"2026-08-30T16:20:00Z"}]}'::jsonb,
    2,
    '2026-08-30',
    'ai_assisted',
    '2026-08-30 16:05:00+00',
    '2026-08-30 16:20:05+00'
  ),
  (
    'note_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'spc_00000000000000000000000001',
    'log',
    'Push Workout',
    E'### 2026-08-30\n\nbench 135 x 8, 145 x 6',
    '{"schemaVersion":1,"entries":[{"id":"ent_00000000000000000000000001","occurredOn":"2026-08-30","kind":"workout","raw":"bench 135 x 8, 145 x 6","exercises":[{"name":"bench","sets":[{"weight":135,"unit":"lb","reps":8},{"weight":145,"unit":"lb","reps":6}]}],"unparsed":[],"sourceCaptureId":null}]}'::jsonb,
    1,
    null,
    'ai_assisted',
    '2026-08-30 16:06:00+00',
    '2026-08-30 16:06:00+00'
  ),
  (
    'note_00000000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    'spc_00000000000000000000000001',
    'principle',
    'Mindset',
    'Commit publicly, then learn what the commitment requires.',
    '{}'::jsonb,
    1,
    null,
    'ai_assisted',
    '2026-08-30 16:07:00+00',
    '2026-08-30 16:07:00+00'
  ),
  (
    'note_00000000000000000000000004',
    '11111111-1111-4111-8111-111111111111',
    'spc_00000000000000000000000002',
    'project',
    'Unfiled app',
    E'## Next\n\n- Build the durable capture loop.\n- Test the Lock Screen entry path.',
    '{}'::jsonb,
    1,
    null,
    'private_manual',
    '2026-08-30 16:08:00+00',
    '2026-08-30 16:08:00+00'
  ),
  (
    'note_00000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009',
    'generic',
    'Other user private fixture',
    'This synthetic row exists only to prove cross-user isolation.',
    '{}'::jsonb,
    1,
    null,
    'private_manual',
    '2026-08-30 16:09:00+00',
    '2026-08-30 16:09:00+00'
  )
on conflict (id) do nothing;

insert into public.note_revisions (
  id,
  note_id,
  user_id,
  revision,
  source,
  title,
  body_markdown,
  structured_data,
  content_hash,
  actor,
  mutation_id,
  created_at
)
values
  (
    'rev_00000000000000000000000001',
    'note_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    1,
    'manual',
    'Shopping',
    '- [ ] milk',
    '{"schemaVersion":1,"items":[{"id":"itm_00000000000000000000000001","text":"milk","checked":false,"checkedAt":null,"ordinal":"a0","sourceCaptureId":null,"createdAt":"2026-08-30T16:05:00Z"}]}'::jsonb,
    encode(extensions.digest('shopping-revision-1', 'sha256'), 'hex'),
    'user:seed',
    null,
    '2026-08-30 16:05:00+00'
  ),
  (
    'rev_00000000000000000000000003',
    'note_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    1,
    'manual',
    'Push Workout',
    E'### 2026-08-30\n\nbench 135 x 8, 145 x 6',
    '{"schemaVersion":1,"entries":[{"id":"ent_00000000000000000000000001","occurredOn":"2026-08-30","kind":"workout","raw":"bench 135 x 8, 145 x 6","exercises":[{"name":"bench","sets":[{"weight":135,"unit":"lb","reps":8},{"weight":145,"unit":"lb","reps":6}]}],"unparsed":[],"sourceCaptureId":null}]}'::jsonb,
    encode(extensions.digest('workout-revision-1', 'sha256'), 'hex'),
    'user:seed',
    null,
    '2026-08-30 16:06:00+00'
  ),
  (
    'rev_00000000000000000000000004',
    'note_00000000000000000000000003',
    '11111111-1111-4111-8111-111111111111',
    1,
    'manual',
    'Mindset',
    'Commit publicly, then learn what the commitment requires.',
    '{}'::jsonb,
    encode(extensions.digest('mindset-revision-1', 'sha256'), 'hex'),
    'user:seed',
    null,
    '2026-08-30 16:07:00+00'
  ),
  (
    'rev_00000000000000000000000005',
    'note_00000000000000000000000004',
    '11111111-1111-4111-8111-111111111111',
    1,
    'manual',
    'Unfiled app',
    E'## Next\n\n- Build the durable capture loop.\n- Test the Lock Screen entry path.',
    '{}'::jsonb,
    encode(extensions.digest('project-revision-1', 'sha256'), 'hex'),
    'user:seed',
    null,
    '2026-08-30 16:08:00+00'
  ),
  (
    'rev_00000000000000000000000009',
    'note_00000000000000000000000009',
    '22222222-2222-4222-8222-222222222222',
    1,
    'manual',
    'Other user private fixture',
    'This synthetic row exists only to prove cross-user isolation.',
    '{}'::jsonb,
    encode(extensions.digest('other-user-revision-1', 'sha256'), 'hex'),
    'user:seed',
    null,
    '2026-08-30 16:09:00+00'
  )
on conflict (id) do nothing;

insert into public.captures (
  id,
  user_id,
  source,
  device_id,
  raw_text,
  privacy,
  client_created_at,
  client_timezone,
  received_at,
  status
)
values
  (
    'cap_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'mobile',
    'synthetic-ios-device',
    'add spinach to the shopping list',
    'ai_assisted',
    '2026-08-30 16:20:00+00',
    'America/Los_Angeles',
    '2026-08-30 16:20:01+00',
    'organized'
  ),
  (
    'cap_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'ios_lock_screen_widget',
    'synthetic-ios-device',
    'Roosevelt method: tell people you can do it, then figure out how.',
    'ai_assisted',
    '2026-08-30 16:25:00+00',
    'America/Los_Angeles',
    '2026-08-30 16:25:01+00',
    'needs_review'
  )
on conflict (id) do nothing;

insert into public.organization_jobs (
  id,
  capture_id,
  user_id,
  state,
  attempt,
  prompt_version,
  schema_version,
  model_id,
  started_at,
  completed_at,
  created_at
)
values
  (
    'job_00000000000000000000000001',
    'cap_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'succeeded',
    1,
    'routing-v1',
    1,
    'fake-model-v1',
    '2026-08-30 16:20:01+00',
    '2026-08-30 16:20:05+00',
    '2026-08-30 16:20:01+00'
  ),
  (
    'job_00000000000000000000000002',
    'cap_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'succeeded',
    1,
    'routing-v1',
    1,
    'fake-model-v1',
    '2026-08-30 16:25:01+00',
    '2026-08-30 16:25:05+00',
    '2026-08-30 16:25:01+00'
  )
on conflict (id) do nothing;

insert into public.organization_decisions (
  id,
  capture_id,
  user_id,
  candidate_manifest,
  signals,
  validated_plan,
  band,
  score,
  margin,
  destination_note_id,
  reason_codes,
  created_at
)
values
  (
    'dec_00000000000000000000000001',
    'cap_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    '{"candidateIds":["note_00000000000000000000000001"]}'::jsonb,
    '{"explicitShoppingIntent":true}'::jsonb,
    '{"schemaVersion":1,"decision":"append_to_note"}'::jsonb,
    'auto',
    0.990,
    0.950,
    'note_00000000000000000000000001',
    array['explicit_shopping_intent'],
    '2026-08-30 16:20:04+00'
  ),
  (
    'dec_00000000000000000000000002',
    'cap_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    '{"candidateIds":["note_00000000000000000000000003","note_00000000000000000000000004"]}'::jsonb,
    '{"topCandidatesClose":true}'::jsonb,
    '{"schemaVersion":1,"decision":"needs_review"}'::jsonb,
    'review',
    0.720,
    0.080,
    'note_00000000000000000000000003',
    array['ambiguous_intent'],
    '2026-08-30 16:25:04+00'
  )
on conflict (id) do nothing;

insert into public.note_mutations (
  id,
  user_id,
  decision_id,
  note_id,
  idempotency_key,
  before_revision,
  after_revision,
  operations,
  inverse,
  created_at
)
values (
  'mut_00000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'dec_00000000000000000000000001',
  'note_00000000000000000000000001',
  'seed-shopping-spinach',
  1,
  2,
  '[{"type":"append_list_items","items":[{"id":"itm_00000000000000000000000002","text":"spinach"}]}]'::jsonb,
  '[{"type":"remove_list_item","itemId":"itm_00000000000000000000000002"}]'::jsonb,
  '2026-08-30 16:20:05+00'
)
on conflict (id) do nothing;

insert into public.note_revisions (
  id,
  note_id,
  user_id,
  revision,
  source,
  title,
  body_markdown,
  structured_data,
  content_hash,
  actor,
  mutation_id,
  created_at
)
values (
  'rev_00000000000000000000000002',
  'note_00000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  2,
  'organization',
  'Shopping',
  E'- [ ] milk\n- [ ] spinach',
  '{"schemaVersion":1,"items":[{"id":"itm_00000000000000000000000001","text":"milk","checked":false,"checkedAt":null,"ordinal":"a0","sourceCaptureId":null,"createdAt":"2026-08-30T16:05:00Z"},{"id":"itm_00000000000000000000000002","text":"spinach","checked":false,"checkedAt":null,"ordinal":"b0","sourceCaptureId":"cap_00000000000000000000000001","createdAt":"2026-08-30T16:20:00Z"}]}'::jsonb,
  encode(extensions.digest('shopping-revision-2', 'sha256'), 'hex'),
  'organization:job_00000000000000000000000001',
  'mut_00000000000000000000000001',
  '2026-08-30 16:20:05+00'
)
on conflict (id) do nothing;

insert into public.capture_note_links (
  capture_id,
  note_id,
  user_id,
  mutation_id,
  inserted_item_ids,
  created_at
)
values (
  'cap_00000000000000000000000001',
  'note_00000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'mut_00000000000000000000000001',
  array['itm_00000000000000000000000002'],
  '2026-08-30 16:20:05+00'
)
on conflict (capture_id, note_id, mutation_id) do nothing;

insert into public.review_items (
  id,
  user_id,
  capture_id,
  type,
  choices,
  state,
  created_at
)
values (
  'rvw_00000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'cap_00000000000000000000000002',
  'low_confidence',
  '[{"noteId":"note_00000000000000000000000003","label":"Mindset"},{"noteId":"note_00000000000000000000000004","label":"Unfiled app"}]'::jsonb,
  'open',
  '2026-08-30 16:25:05+00'
)
on conflict (id) do nothing;

insert into public.tags (id, user_id, name, created_at)
values
  (
    'tag_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    'errands',
    '2026-08-30 16:10:00+00'
  ),
  (
    'tag_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'fitness',
    '2026-08-30 16:11:00+00'
  )
on conflict (id) do nothing;

insert into public.note_tags (note_id, tag_id, user_id, created_at)
values
  (
    'note_00000000000000000000000001',
    'tag_00000000000000000000000001',
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30 16:10:00+00'
  ),
  (
    'note_00000000000000000000000002',
    'tag_00000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    '2026-08-30 16:11:00+00'
  )
on conflict (note_id, tag_id) do nothing;

insert into public.routing_rules (
  id,
  user_id,
  rule_type,
  condition_normalized,
  destination_note_id,
  priority,
  source,
  created_at,
  updated_at
)
values (
  'rule_00000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'alias',
  'groceries',
  'note_00000000000000000000000001',
  10,
  'explicit',
  '2026-08-30 16:12:00+00',
  '2026-08-30 16:12:00+00'
)
on conflict (id) do nothing;

insert into public.user_events (seq, user_id, entity, entity_id, occurred_at)
values
  (
    1001,
    '11111111-1111-4111-8111-111111111111',
    'note',
    'note_00000000000000000000000001',
    '2026-08-30 16:20:05+00'
  ),
  (
    1002,
    '11111111-1111-4111-8111-111111111111',
    'capture',
    'cap_00000000000000000000000001',
    '2026-08-30 16:20:01+00'
  ),
  (
    1003,
    '11111111-1111-4111-8111-111111111111',
    'review_item',
    'rvw_00000000000000000000000001',
    '2026-08-30 16:25:05+00'
  ),
  (
    1004,
    '22222222-2222-4222-8222-222222222222',
    'note',
    'note_00000000000000000000000009',
    '2026-08-30 16:09:00+00'
  )
on conflict (seq) do nothing;

select setval(
  pg_get_serial_sequence('public.user_events', 'seq'),
  greatest((select max(seq) from public.user_events), 1),
  true
);
