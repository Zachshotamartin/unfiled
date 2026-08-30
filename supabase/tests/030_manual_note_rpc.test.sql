create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(58);

-- Atomic creation writes the note, immutable revision 1, cursor events, and a
-- replayable response in one transaction.
select is(
  public.create_note(
    'b-create-generic', 'generic', 'B RPC Generic', 'first body'
  ) ->> 'replayed',
  'false',
  'create_note reports a first execution'
);
select is((select count(*) from public.notes where title = 'B RPC Generic'), 1::bigint, 'create_note writes exactly one note');
select is((select current_revision from public.notes where title = 'B RPC Generic'), 1, 'created note starts at revision 1');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), 1::bigint, 'create_note writes one immutable snapshot');
select is((select body_markdown from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), 'first body', 'initial snapshot preserves body content');
select is((select count(*) from public.user_events where entity_id = (select id from public.notes where title = 'B RPC Generic') or entity_id in (select id from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')) or entity_id in (select id from public.note_mutations where note_id = (select id from public.notes where title = 'B RPC Generic'))), 3::bigint, 'create_note emits note, revision, and mutation cursor events');
select is((select count(*) from public.note_mutations where idempotency_key = 'b-create-generic'), 1::bigint, 'create_note stores exactly one mutation receipt');
select is((select before_revision::text || '->' || after_revision::text from public.note_mutations where idempotency_key = 'b-create-generic'), '0->1', 'create receipt truthfully spans no note to revision 1');
select ok(public.create_note('b-create-generic', 'generic', 'B RPC Generic', 'first body') ->> 'mutationId' ~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$', 'create result returns a real typed mutation ID');
select is((select mutation_id from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), (select id from public.note_mutations where idempotency_key = 'b-create-generic'), 'initial revision links to the truthful create receipt');
select is(public.create_note('b-create-generic', 'generic', 'B RPC Generic', 'first body') -> 'undo' ->> 'eligible', 'true', 'create result exposes its real soft-delete inverse');
select is(public.create_note('b-create-generic', 'generic', 'B RPC Generic', 'first body') ->> 'replayed', 'true', 'same-key create returns replayed response');
select is((select count(*) from public.notes where title = 'B RPC Generic'), 1::bigint, 'create replay does not duplicate note');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), 1::bigint, 'create replay does not duplicate revision');
select is((select count(*) from public.user_events where entity_id = (select id from public.notes where title = 'B RPC Generic') or entity_id in (select id from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')) or entity_id in (select id from public.note_mutations where note_id = (select id from public.notes where title = 'B RPC Generic'))), 3::bigint, 'create replay does not duplicate events');
select throws_ok($$select public.create_note('b-create-generic', 'generic', 'B RPC Generic changed', 'different body')$$, 'P0001', 'invalid_idempotency_key', 'same create key cannot alias different input');

create temporary table b_create_undo_started as
select clock_timestamp() as started_at;
create temporary table b_create_undo_result as
select public.undo_user_mutation(
  (select id from public.note_mutations where idempotency_key = 'b-create-generic'),
  1,
  'b-create-undo'
) as result;
select is((select result -> 'note' ->> 'currentRevision' from b_create_undo_result), '2', 'undoing creation appends soft-delete revision 2');
select ok((select deleted_at is not null from public.notes where title = 'B RPC Generic'), 'creation undo soft-deletes rather than erasing history');
select ok((select deleted_at >= (select started_at from b_create_undo_started) from public.notes where title = 'B RPC Generic'), 'creation undo stamps deletion at undo time rather than creation time');
select is(public.undo_user_mutation((select id from public.note_mutations where idempotency_key = 'b-create-generic'), 1, 'b-create-undo') ->> 'replayed', 'true', 'creation undo replay is idempotent before stale validation');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), 2::bigint, 'creation undo replay adds no snapshot');
select is(public.undo_user_mutation((select result ->> 'mutationId' from b_create_undo_result), 2, 'b-create-undo-of-undo') -> 'note' ->> 'currentRevision', '3', 'undoing the creation undo appends revision 3');
select ok((select deleted_at is null from public.notes where title = 'B RPC Generic'), 'undo-of-undo restores the active revision-1 snapshot');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC Generic')), 3::bigint, 'create undo and undo-of-undo preserve all snapshots');

select throws_ok($$select public.create_note('b-create-cross-space', 'generic', 'Forbidden space note', '', 'spc_00000000000000000000000009')$$, 'P0001', 'not_found', 'create_note rejects cross-user space reference');
select is((select count(*) from public.notes where title = 'Forbidden space note'), 0::bigint, 'rejected cross-user create leaves no note');

-- List Markdown becomes canonical structured data and a byte-stable projection.
select is(
  public.create_note(
    'b-create-list',
    'list',
    'B RPC List',
    E'- [ ] milk\n- [x] bread'
  ) ->> 'replayed',
  'false',
  'list creation succeeds'
);
select is((select jsonb_array_length(structured_data -> 'items') from public.notes where title = 'B RPC List'), 2, 'list parser creates two structured items');
select is((select body_markdown from public.notes where title = 'B RPC List'), E'- [ ] milk\n\n## Completed\n\n- [x] bread', 'list projection groups completed items deterministically');
select ok((select bool_and((item ->> 'id') ~ '^itm_[0-9A-HJKMNP-TV-Z]{26}$') from public.notes, lateral jsonb_array_elements(structured_data -> 'items') as item where title = 'B RPC List'), 'list items receive stable typed IDs');

select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B RPC List'),
    1,
    jsonb_build_array(
      jsonb_build_object(
        'type', 'toggle_item_checked',
        'itemId', (select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B RPC List'),
        'checked', true
      )
    ),
    'b-toggle-list'
  ) ->> 'replayed',
  'false',
  'typed checklist toggle succeeds'
);
select is((select current_revision from public.notes where title = 'B RPC List'), 2, 'toggle increments expected revision');
select is((select (structured_data -> 'items' -> 0 ->> 'checked')::boolean from public.notes where title = 'B RPC List'), true, 'toggle changes canonical checked state');
select is((select body_markdown from public.notes where title = 'B RPC List'), E'## Completed\n\n- [x] milk\n- [x] bread', 'toggle regenerates deterministic list projection');
select ok((select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B RPC List') is not null, 'toggle preserves item identity');
select is((select count(*) from public.note_mutations where note_id = (select id from public.notes where title = 'B RPC List')), 2::bigint, 'creation and toggle each write a truthful mutation receipt');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC List')), 2::bigint, 'toggle writes revision 2 snapshot');
select is((select count(*) from public.user_events where entity_id = (select id from public.notes where title = 'B RPC List') or entity_id in (select id from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC List')) or entity_id in (select id from public.note_mutations where note_id = (select id from public.notes where title = 'B RPC List'))), 6::bigint, 'create plus toggle emit the complete cursor sequence');

select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B RPC List'),
    1,
    jsonb_build_array(
      jsonb_build_object(
        'type', 'toggle_item_checked',
        'itemId', (select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B RPC List'),
        'checked', true
      )
    ),
    'b-toggle-list'
  ) ->> 'replayed',
  'true',
  'mutation replay is checked before stale revision'
);
select is((select count(*) from public.note_mutations where note_id = (select id from public.notes where title = 'B RPC List')), 2::bigint, 'mutation replay does not duplicate receipt');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC List')), 2::bigint, 'mutation replay does not duplicate revision');
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B RPC List'),
      2,
      jsonb_build_array(jsonb_build_object('type', 'set_title', 'title', 'Aliased key')),
      'b-toggle-list'
    )
  $$,
  'P0001',
  'invalid_idempotency_key',
  'mutation key cannot alias different operations'
);
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B RPC List'),
      1,
      jsonb_build_array(jsonb_build_object('type', 'set_title', 'title', 'Stale title')),
      'b-stale-list'
    )
  $$,
  'P0001',
  'stale_revision',
  'stale expected revision is rejected'
);
select is((select current_revision from public.notes where title = 'B RPC List'), 2, 'stale write leaves revision unchanged');
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B RPC List'),
      2,
      jsonb_build_array(
        jsonb_build_object('type', 'set_title', 'title', 'Must roll back'),
        jsonb_build_object('type', 'forged_operation')
      ),
      'b-atomic-invalid-operation'
    )
  $$,
  '22023',
  'validation_failed',
  'invalid later operation aborts the whole mutation'
);
select is((select title from public.notes where title = 'B RPC List'), 'B RPC List', 'failed multi-operation mutation rolls back earlier operation');
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      'note_00000000000000000000000009',
      1,
      jsonb_build_array(jsonb_build_object('type', 'set_title', 'title', 'Forbidden')),
      'b-cross-user-note'
    )
  $$,
  'P0001',
  'not_found',
  'cross-user note mutation is indistinguishable from missing note'
);
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B RPC List'),
      2,
      jsonb_build_array(jsonb_build_object('type', 'move_to_space', 'spaceId', 'spc_00000000000000000000000009')),
      'b-cross-user-move'
    )
  $$,
  'P0001',
  'not_found',
  'move operation rejects cross-user space'
);
select is((select current_revision from public.notes where title = 'B RPC List'), 2, 'failed move leaves note revision unchanged');

select is(public.apply_user_note_mutation((select id from public.notes where title = 'B RPC List'), 2, '[{"type":"set_deleted","deletedAt":"2026-08-30T23:45:00.000Z"}]'::jsonb, 'b-delete-list') -> 'note' ->> 'currentRevision', '3', 'schema-shaped soft delete is a revisioned mutation');
select ok((select deleted_at is not null from public.notes where title = 'B RPC List'), 'soft delete records deleted timestamp');
select is(public.restore_note((select id from public.notes where title = 'B RPC List'), 3, 'b-restore-list') -> 'note' ->> 'currentRevision', '4', 'restore is a revisioned mutation');
select ok((select deleted_at is null from public.notes where title = 'B RPC List'), 'restore clears deleted timestamp');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B RPC List')), 4::bigint, 'delete and restore each append immutable snapshots');

-- Failed structure parsing rolls back its idempotency claim, so the same key
-- can be retried with corrected content.
select throws_ok($$select public.create_note('b-structure-retry', 'list', 'Broken list', 'not a checklist')$$, 'P0001', 'structure_conflict', 'ambiguous list Markdown is rejected');
select is((select count(*) from public.notes where title = 'Broken list'), 0::bigint, 'structure conflict leaves no partial note');
select is(public.create_note('b-structure-retry', 'list', 'Recovered list', '- [ ] valid') ->> 'replayed', 'false', 'rolled-back idempotency claim can be retried safely');
select is((select count(*) from public.notes where title = 'Recovered list'), 1::bigint, 'corrected retry creates exactly one note');

select * from finish();
rollback;
