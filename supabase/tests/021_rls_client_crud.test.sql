create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

create function pg_temp.affected(statement text)
returns bigint
language plpgsql
as $$
declare
  affected_rows bigint;
begin
  execute statement;
  get diagnostics affected_rows = row_count;
  return affected_rows;
end;
$$;

-- A third Auth row provides a valid, profile-less UUID for a cross-user profile
-- INSERT check. The trigger-created profile is removed before client tests.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '33333333-3333-4333-8333-333333333333',
  'authenticated',
  'authenticated',
  'third-user@unfiled.local',
  extensions.crypt('unfiled-local-third', '$2a$10$2345678901234567890123'),
  '2026-08-30 23:00:00+00',
  '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Synthetic Third User"}'::jsonb,
  '2026-08-30 23:00:00+00',
  '2026-08-30 23:00:00+00'
);
delete from public.profiles
where id in (
  '11111111-1111-4111-8111-111111111111',
  '33333333-3333-4333-8333-333333333333'
);

-- Cross-user rows for UPDATE/DELETE and join-ownership checks.
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at
)
values (
  'note_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009',
  'generic',
  'Other user CRUD target',
  'Synthetic target.',
  '{}'::jsonb,
  1,
  'private_manual',
  '2026-08-30 23:01:00+00',
  '2026-08-30 23:01:00+00'
);
insert into public.captures (
  id, user_id, source, raw_text, client_created_at, client_timezone,
  received_at, status
)
values (
  'cap_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'web',
  'synthetic CRUD cross-user capture',
  '2026-08-30 23:02:00+00',
  'UTC',
  '2026-08-30 23:02:01+00',
  'organized'
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan, band,
  destination_note_id, created_at
)
values (
  'dec_71000000000000000000000009',
  'cap_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  'auto',
  'note_00000000000000000000000009',
  '2026-08-30 23:02:02+00'
);
insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key, before_revision,
  after_revision, operations, inverse, created_at
)
values (
  'mut_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'dec_71000000000000000000000009',
  'note_00000000000000000000000009',
  'crud-other-user-mutation',
  1,
  2,
  '[]'::jsonb,
  '[]'::jsonb,
  '2026-08-30 23:02:03+00'
);
insert into public.generated_blocks (
  id, user_id, note_id, decision_id, kind, content, model_id, prompt_version
)
values (
  'blk_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'note_00000000000000000000000009',
  'dec_71000000000000000000000009',
  'suggestion',
  'Other user CRUD block.',
  'fake-model-v1',
  'routing-v1'
);
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation
)
values (
  'cap_71000000000000000000000009',
  'note_00000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'mut_71000000000000000000000009',
  'routed'
);
insert into public.routing_rules (
  id, user_id, rule_type, condition_normalized, destination_note_id, source
)
values (
  'rule_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'alias',
  'crud-other',
  'note_00000000000000000000000009',
  'explicit'
);
insert into public.review_items (
  id, user_id, capture_id, note_id, type
)
values (
  'rvw_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'cap_71000000000000000000000009',
  'note_00000000000000000000000009',
  'low_confidence'
);
insert into public.tags (id, user_id, name)
values (
  'tag_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'crud-other'
);
insert into public.note_tags (note_id, tag_id, user_id)
values (
  'note_00000000000000000000000009',
  'tag_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222'
);
insert into public.note_links (
  id, user_id, from_note_id, to_note_id, link_type, source
)
values (
  'lnk_71000000000000000000000009',
  '22222222-2222-4222-8222-222222222222',
  'note_00000000000000000000000009',
  'note_71000000000000000000000009',
  'related',
  'manual'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(73);

-- profiles: INSERT, UPDATE, and DELETE are owner-scoped.
select is(pg_temp.affected($$insert into public.profiles (id, display_name) values ('11111111-1111-4111-8111-111111111111', 'CRUD owner')$$), 1::bigint, 'profiles INSERT allows the owner');
select throws_ok($$select pg_temp.affected('insert into public.profiles (id) values (''33333333-3333-4333-8333-333333333333'')')$$, '42501', 'new row violates row-level security policy for table "profiles"', 'profiles INSERT denies another user ID');
select is(pg_temp.affected($$update public.profiles set display_name = 'CRUD updated' where id = '11111111-1111-4111-8111-111111111111'$$), 1::bigint, 'profiles UPDATE allows the owner');
select is(pg_temp.affected($$update public.profiles set display_name = 'forbidden' where id = '22222222-2222-4222-8222-222222222222'$$), 0::bigint, 'profiles UPDATE hides another user');
select is(pg_temp.affected($$delete from public.profiles where id = '22222222-2222-4222-8222-222222222222'$$), 0::bigint, 'profiles DELETE hides another user');
select is(pg_temp.affected($$delete from public.profiles where id = '11111111-1111-4111-8111-111111111111'$$), 1::bigint, 'profiles DELETE allows the owner');

-- spaces: ownership and the one-level parent rule are enforced.
select is(pg_temp.affected($$insert into public.spaces (id, user_id, name, slug) values ('spc_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'CRUD space', 'crud-space')$$), 1::bigint, 'spaces INSERT allows owned root space');
select throws_ok($$select pg_temp.affected('insert into public.spaces (id, user_id, name, slug) values (''spc_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''Forbidden'', ''forbidden-space'')')$$, '42501', 'new row violates row-level security policy for table "spaces"', 'spaces INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.spaces (id, user_id, parent_id, name, slug) values (''spc_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''spc_00000000000000000000000009'', ''Forbidden parent'', ''forbidden-parent'')')$$, '42501', 'new row violates row-level security policy for table "spaces"', 'spaces INSERT denies a cross-user parent');
select is(pg_temp.affected($$update public.spaces set name = 'CRUD space updated' where id = 'spc_71000000000000000000000001'$$), 1::bigint, 'spaces UPDATE allows owned row');
select is(pg_temp.affected($$update public.spaces set name = 'forbidden' where id = 'spc_00000000000000000000000009'$$), 0::bigint, 'spaces UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.spaces where id = 'spc_00000000000000000000000009'$$), 0::bigint, 'spaces DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.spaces where id = 'spc_71000000000000000000000001'$$), 1::bigint, 'spaces DELETE allows owned row');

-- notes: ownership and referenced-space ownership are both required.
select is(pg_temp.affected($$insert into public.notes (id, user_id, space_id, type, title) values ('note_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'spc_00000000000000000000000001', 'generic', 'CRUD note')$$), 1::bigint, 'notes INSERT allows owned row and space');
select throws_ok($$select pg_temp.affected('insert into public.notes (id, user_id, type, title) values (''note_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''generic'', ''Forbidden'')')$$, '42501', 'new row violates row-level security policy for table "notes"', 'notes INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.notes (id, user_id, space_id, type, title) values (''note_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''spc_00000000000000000000000009'', ''generic'', ''Forbidden ref'')')$$, '42501', 'new row violates row-level security policy for table "notes"', 'notes INSERT denies a cross-user space');
select is(pg_temp.affected($$update public.notes set title = 'CRUD note updated' where id = 'note_71000000000000000000000001'$$), 1::bigint, 'notes UPDATE allows owned row');
select is(pg_temp.affected($$update public.notes set title = 'forbidden' where id = 'note_00000000000000000000000009'$$), 0::bigint, 'notes UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.notes where id = 'note_00000000000000000000000009'$$), 0::bigint, 'notes DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.notes where id = 'note_71000000000000000000000001'$$), 1::bigint, 'notes DELETE allows owned row');

-- note_revisions: append-only INSERT still validates note ownership.
select is(pg_temp.affected($$insert into public.note_revisions (id, note_id, user_id, revision, source, title, body_markdown, structured_data, content_hash, actor) values ('rev_71000000000000000000000001', 'note_00000000000000000000000003', '11111111-1111-4111-8111-111111111111', 2, 'manual', 'Mindset', 'revision fixture', '{}', repeat('a', 64), 'user:sql-test')$$), 1::bigint, 'note_revisions INSERT allows owned note');
select throws_ok($$select pg_temp.affected('insert into public.note_revisions (id, note_id, user_id, revision, source, title, body_markdown, structured_data, content_hash, actor) values (''rev_71000000000000000000000002'', ''note_00000000000000000000000009'', ''22222222-2222-4222-8222-222222222222'', 2, ''manual'', ''Forbidden'', '''', ''{}'', repeat(''b'', 64), ''user:sql-test'')')$$, '42501', 'new row violates row-level security policy for table "note_revisions"', 'note_revisions INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.note_revisions (id, note_id, user_id, revision, source, title, body_markdown, structured_data, content_hash, actor) values (''rev_71000000000000000000000003'', ''note_00000000000000000000000009'', ''11111111-1111-4111-8111-111111111111'', 3, ''manual'', ''Forbidden ref'', '''', ''{}'', repeat(''c'', 64), ''user:sql-test'')')$$, '42501', 'new row violates row-level security policy for table "note_revisions"', 'note_revisions INSERT denies cross-user note reference');

-- generated_blocks: all referenced rows must also be owned.
select is(pg_temp.affected($$insert into public.generated_blocks (id, user_id, note_id, decision_id, kind, content, model_id, prompt_version) values ('blk_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'note_00000000000000000000000003', 'dec_00000000000000000000000002', 'suggestion', 'CRUD owned block', 'fake-model-v1', 'routing-v1')$$), 1::bigint, 'generated_blocks INSERT allows owned references');
select throws_ok($$select pg_temp.affected('insert into public.generated_blocks (id, user_id, note_id, decision_id, kind, content, model_id, prompt_version) values (''blk_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''note_00000000000000000000000009'', ''dec_71000000000000000000000009'', ''suggestion'', ''Forbidden'', ''fake-model-v1'', ''routing-v1'')')$$, '42501', 'new row violates row-level security policy for table "generated_blocks"', 'generated_blocks INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.generated_blocks (id, user_id, note_id, decision_id, kind, content, model_id, prompt_version) values (''blk_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''note_00000000000000000000000009'', ''dec_00000000000000000000000002'', ''suggestion'', ''Forbidden ref'', ''fake-model-v1'', ''routing-v1'')')$$, '42501', 'new row violates row-level security policy for table "generated_blocks"', 'generated_blocks INSERT denies cross-user references');
select is(pg_temp.affected($$update public.generated_blocks set state = 'accepted' where id = 'blk_71000000000000000000000001'$$), 1::bigint, 'generated_blocks UPDATE allows owned row');
select is(pg_temp.affected($$update public.generated_blocks set state = 'accepted' where id = 'blk_71000000000000000000000009'$$), 0::bigint, 'generated_blocks UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.generated_blocks where id = 'blk_71000000000000000000000009'$$), 0::bigint, 'generated_blocks DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.generated_blocks where id = 'blk_71000000000000000000000001'$$), 1::bigint, 'generated_blocks DELETE allows owned row');

-- capture_note_links: capture, note, and mutation ownership are all checked.
select is(pg_temp.affected($$insert into public.capture_note_links (capture_id, note_id, user_id, mutation_id) values ('cap_00000000000000000000000002', 'note_00000000000000000000000003', '11111111-1111-4111-8111-111111111111', 'mut_00000000000000000000000001')$$), 1::bigint, 'capture_note_links INSERT allows owned references');
select throws_ok($$select pg_temp.affected('insert into public.capture_note_links (capture_id, note_id, user_id, mutation_id) values (''cap_00000000000000000000000002'', ''note_00000000000000000000000004'', ''22222222-2222-4222-8222-222222222222'', ''mut_00000000000000000000000001'')')$$, '42501', 'new row violates row-level security policy for table "capture_note_links"', 'capture_note_links INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.capture_note_links (capture_id, note_id, user_id, mutation_id) values (''cap_71000000000000000000000009'', ''note_00000000000000000000000009'', ''11111111-1111-4111-8111-111111111111'', ''mut_71000000000000000000000009'')')$$, '42501', 'new row violates row-level security policy for table "capture_note_links"', 'capture_note_links INSERT denies cross-user references');
select is(pg_temp.affected($$update public.capture_note_links set relation = 'source_removed' where capture_id = 'cap_00000000000000000000000002'$$), 1::bigint, 'capture_note_links UPDATE allows owned row');
select is(pg_temp.affected($$update public.capture_note_links set relation = 'source_removed' where capture_id = 'cap_71000000000000000000000009'$$), 0::bigint, 'capture_note_links UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.capture_note_links where capture_id = 'cap_71000000000000000000000009'$$), 0::bigint, 'capture_note_links DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.capture_note_links where capture_id = 'cap_00000000000000000000000002'$$), 1::bigint, 'capture_note_links DELETE allows owned row');

-- routing_rules: destination ownership is checked for every write.
select is(pg_temp.affected($$insert into public.routing_rules (id, user_id, rule_type, condition_normalized, destination_note_id, source) values ('rule_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'alias', 'crud-owned', 'note_00000000000000000000000003', 'explicit')$$), 1::bigint, 'routing_rules INSERT allows owned destination');
select throws_ok($$select pg_temp.affected('insert into public.routing_rules (id, user_id, rule_type, condition_normalized, destination_note_id, source) values (''rule_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''alias'', ''forbidden'', ''note_00000000000000000000000009'', ''explicit'')')$$, '42501', 'new row violates row-level security policy for table "routing_rules"', 'routing_rules INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.routing_rules (id, user_id, rule_type, condition_normalized, destination_note_id, source) values (''rule_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''alias'', ''forbidden-ref'', ''note_00000000000000000000000009'', ''explicit'')')$$, '42501', 'new row violates row-level security policy for table "routing_rules"', 'routing_rules INSERT denies cross-user destination');
select is(pg_temp.affected($$update public.routing_rules set enabled = false where id = 'rule_71000000000000000000000001'$$), 1::bigint, 'routing_rules UPDATE allows owned row');
select is(pg_temp.affected($$update public.routing_rules set enabled = false where id = 'rule_71000000000000000000000009'$$), 0::bigint, 'routing_rules UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.routing_rules where id = 'rule_71000000000000000000000009'$$), 0::bigint, 'routing_rules DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.routing_rules where id = 'rule_71000000000000000000000001'$$), 1::bigint, 'routing_rules DELETE allows owned row');

-- review_items: capture and note ownership are both validated.
select is(pg_temp.affected($$insert into public.review_items (id, user_id, capture_id, note_id, type) values ('rvw_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'cap_00000000000000000000000002', 'note_00000000000000000000000003', 'low_confidence')$$), 1::bigint, 'review_items INSERT allows owned references');
select throws_ok($$select pg_temp.affected('insert into public.review_items (id, user_id, type) values (''rvw_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''low_confidence'')')$$, '42501', 'new row violates row-level security policy for table "review_items"', 'review_items INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.review_items (id, user_id, capture_id, note_id, type) values (''rvw_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''cap_71000000000000000000000009'', ''note_00000000000000000000000009'', ''low_confidence'')')$$, '42501', 'new row violates row-level security policy for table "review_items"', 'review_items INSERT denies cross-user references');
select is(pg_temp.affected($$update public.review_items set state = 'dismissed' where id = 'rvw_71000000000000000000000001'$$), 1::bigint, 'review_items UPDATE allows owned row');
select is(pg_temp.affected($$update public.review_items set state = 'dismissed' where id = 'rvw_71000000000000000000000009'$$), 0::bigint, 'review_items UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.review_items where id = 'rvw_71000000000000000000000009'$$), 0::bigint, 'review_items DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.review_items where id = 'rvw_71000000000000000000000001'$$), 1::bigint, 'review_items DELETE allows owned row');

-- tags and note_tags: both the row owner and joined records are checked.
select is(pg_temp.affected($$insert into public.tags (id, user_id, name) values ('tag_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'crud-owned')$$), 1::bigint, 'tags INSERT allows owner');
select throws_ok($$select pg_temp.affected('insert into public.tags (id, user_id, name) values (''tag_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''forbidden-tag'')')$$, '42501', 'new row violates row-level security policy for table "tags"', 'tags INSERT denies another user ID');
select is(pg_temp.affected($$update public.tags set name = 'crud-owned-updated' where id = 'tag_71000000000000000000000001'$$), 1::bigint, 'tags UPDATE allows owned row');
select is(pg_temp.affected($$update public.tags set name = 'forbidden-update' where id = 'tag_71000000000000000000000009'$$), 0::bigint, 'tags UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.tags where id = 'tag_71000000000000000000000009'$$), 0::bigint, 'tags DELETE hides cross-user row');
select is(pg_temp.affected($$insert into public.note_tags (note_id, tag_id, user_id) values ('note_00000000000000000000000003', 'tag_71000000000000000000000001', '11111111-1111-4111-8111-111111111111')$$), 1::bigint, 'note_tags INSERT allows owned references');
select throws_ok($$select pg_temp.affected('insert into public.note_tags (note_id, tag_id, user_id) values (''note_00000000000000000000000004'', ''tag_00000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'')')$$, '42501', 'new row violates row-level security policy for table "note_tags"', 'note_tags INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.note_tags (note_id, tag_id, user_id) values (''note_00000000000000000000000004'', ''tag_71000000000000000000000009'', ''11111111-1111-4111-8111-111111111111'')')$$, '42501', 'new row violates row-level security policy for table "note_tags"', 'note_tags INSERT denies cross-user tag reference');
select is(pg_temp.affected($$update public.note_tags set source = 'organization' where tag_id = 'tag_71000000000000000000000001'$$), 1::bigint, 'note_tags UPDATE allows owned row');
select is(pg_temp.affected($$update public.note_tags set source = 'organization' where tag_id = 'tag_71000000000000000000000009'$$), 0::bigint, 'note_tags UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.note_tags where tag_id = 'tag_71000000000000000000000009'$$), 0::bigint, 'note_tags DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.note_tags where tag_id = 'tag_71000000000000000000000001'$$), 1::bigint, 'note_tags DELETE allows owned row');
select is(pg_temp.affected($$delete from public.tags where id = 'tag_71000000000000000000000001'$$), 1::bigint, 'tags DELETE allows owned row');

-- note_links: both endpoint notes must be owned.
select is(pg_temp.affected($$insert into public.note_links (id, user_id, from_note_id, to_note_id, link_type) values ('lnk_71000000000000000000000001', '11111111-1111-4111-8111-111111111111', 'note_00000000000000000000000003', 'note_00000000000000000000000004', 'related')$$), 1::bigint, 'note_links INSERT allows owned endpoints');
select throws_ok($$select pg_temp.affected('insert into public.note_links (id, user_id, from_note_id, to_note_id) values (''lnk_71000000000000000000000002'', ''22222222-2222-4222-8222-222222222222'', ''note_00000000000000000000000009'', ''note_71000000000000000000000009'')')$$, '42501', 'new row violates row-level security policy for table "note_links"', 'note_links INSERT denies another user ID');
select throws_ok($$select pg_temp.affected('insert into public.note_links (id, user_id, from_note_id, to_note_id) values (''lnk_71000000000000000000000003'', ''11111111-1111-4111-8111-111111111111'', ''note_00000000000000000000000003'', ''note_00000000000000000000000009'')')$$, '42501', 'new row violates row-level security policy for table "note_links"', 'note_links INSERT denies cross-user endpoint');
select is(pg_temp.affected($$update public.note_links set link_type = 'reference' where id = 'lnk_71000000000000000000000001'$$), 1::bigint, 'note_links UPDATE allows owned row');
select is(pg_temp.affected($$update public.note_links set link_type = 'reference' where id = 'lnk_71000000000000000000000009'$$), 0::bigint, 'note_links UPDATE hides cross-user row');
select is(pg_temp.affected($$delete from public.note_links where id = 'lnk_71000000000000000000000009'$$), 0::bigint, 'note_links DELETE hides cross-user row');
select is(pg_temp.affected($$delete from public.note_links where id = 'lnk_71000000000000000000000001'$$), 1::bigint, 'note_links DELETE allows owned row');

-- captures expose only owner-scoped DELETE; creation remains RPC-only.
select is(pg_temp.affected($$delete from public.captures where id = 'cap_00000000000000000000000002'$$), 1::bigint, 'captures DELETE allows owned row');
select is(pg_temp.affected($$delete from public.captures where id = 'cap_71000000000000000000000009'$$), 0::bigint, 'captures DELETE hides cross-user row');

select * from finish();
rollback;
