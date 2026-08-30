create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(48);

select is(public.create_tag('b-snapshot-tag', 'snapshot-tag') ->> 'replayed', 'false', 'snapshot tag fixture is created');
select is(public.create_note('b-snapshot-target', 'generic', 'B Snapshot Target', '') ->> 'replayed', 'false', 'snapshot link target is created');
create temporary table b_snapshot_create_result as
select public.create_note(
  'b-snapshot-source',
  'list',
  'B Snapshot Source',
  '- [ ] preserve me',
  'spc_00000000000000000000000001',
  'ai_assisted',
  null,
  jsonb_build_array((select id from public.tags where name = 'snapshot-tag')),
  jsonb_build_array(jsonb_build_object(
    'toNoteId', (select id from public.notes where title = 'B Snapshot Target'),
    'linkType', 'related'
  ))
) as result;
select is((select result ->> 'replayed' from b_snapshot_create_result), 'false', 'canonical create_note accepts tag and link arrays');
select is((select count(*) from public.notes where title = 'B Snapshot Source'), 1::bigint, 'relation-bearing create writes one note');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'relation-bearing create writes one revision');
select is((select count(*) from public.note_mutations where note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'relation-bearing create writes one mutation receipt');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'create persists the owned tag relation atomically');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'create persists the owned note link atomically');
select is((select jsonb_array_length(tag_ids) from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source')), 1, 'revision 1 snapshots the created tag set');
select is((select links -> 0 ->> 'linkType' from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source')), 'related', 'revision 1 snapshots the created link set');
select is((select jsonb_array_length(result -> 'note' -> 'tagIds') from b_snapshot_create_result), 1, 'create result exposes canonical tag IDs');
select is((select result -> 'note' -> 'links' -> 0 ->> 'toNoteId' from b_snapshot_create_result), (select id from public.notes where title = 'B Snapshot Target'), 'create result exposes canonical link values');

reset role;
update public.notes
set pinned_at = '2026-08-30T20:00:00.000Z'
where title = 'B Snapshot Source';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

create temporary table b_snapshot_revision_two_result as
select public.apply_user_note_mutation(
  (select id from public.notes where title = 'B Snapshot Source'),
  1,
  jsonb_build_array(
    jsonb_build_object('type', 'move_to_space', 'spaceId', 'spc_00000000000000000000000002'),
    jsonb_build_object('type', 'set_privacy', 'privacy', 'private_manual'),
    jsonb_build_object('type', 'set_archived', 'archivedAt', '2026-08-30T20:01:00.000Z'),
    jsonb_build_object('type', 'set_deleted', 'deletedAt', '2026-08-30T20:02:00.000Z'),
    jsonb_build_object(
      'type', 'toggle_item_checked',
      'itemId', (select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B Snapshot Source'),
      'checked', true
    )
  ),
  'b-snapshot-revision-two'
) as result;
select is((select result -> 'note' ->> 'currentRevision' from b_snapshot_revision_two_result), '2', 'full-state mutation appends revision 2');
select is((select result -> 'note' ->> 'isOpen' from b_snapshot_revision_two_result), 'false', 'fully checked list derives isOpen false');
select is((select source::text from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2), 'manual', 'mixed manual operations are attributed to a manual revision');
select ok((
  select space_id = 'spc_00000000000000000000000002'
    and type = 'list'
    and title = 'B Snapshot Source'
    and is_open = false
    and pinned_at = '2026-08-30T20:00:00.000Z'::timestamptz
    and privacy = 'private_manual'
    and archived_at = '2026-08-30T20:01:00.000Z'::timestamptz
    and deleted_at = '2026-08-30T20:02:00.000Z'::timestamptz
  from public.note_revisions
  where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2
), 'revision 2 stores every scalar snapshot field');
select is((select jsonb_array_length(tag_ids)::text || ':' || jsonb_array_length(links)::text from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2), '1:1', 'revision 2 stores complete relation snapshots');
select ok((select content_hash ~ '^[0-9a-f]{64}$' from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2), 'full snapshot has a canonical SHA-256 content hash');
select is(
  (select array_agg(key order by key) from b_snapshot_revision_two_result, lateral jsonb_object_keys(result -> 'revision') as key),
  array['actor','archivedAt','bodyMarkdown','contentHash','createdAt','deletedAt','id','isOpen','links','noteId','pinnedAt','privacy','revision','source','spaceId','structuredData','tagIds','title','type']::text[],
  'revision JSON has exactly the frozen NoteRevisionDto keys'
);
select is(
  (select array_agg(key order by key) from b_snapshot_revision_two_result, lateral jsonb_object_keys(result -> 'note') as key),
  array['archivedAt','bodyMarkdown','createdAt','currentRevision','deletedAt','id','isOpen','links','pinnedAt','privacy','spaceId','structuredData','tagIds','title','type','updatedAt']::text[],
  'note JSON has exactly the frozen NoteDto keys'
);
select is(
  (select array_agg(key order by key) from b_snapshot_revision_two_result, lateral jsonb_object_keys(result) as key),
  array['mutationId','note','replayed','revision','undo']::text[],
  'write result has exactly the frozen MutationResult keys'
);
select is((select result -> 'revision' ->> 'isOpen' from b_snapshot_revision_two_result), 'false', 'revision JSON carries the derived closed state');

create temporary table b_revision_two_snapshot as
select id, jsonb_build_object(
  'spaceId', space_id, 'type', type, 'title', title, 'bodyMarkdown', body_markdown,
  'structuredData', structured_data, 'isOpen', is_open, 'pinnedAt', pinned_at,
  'privacy', privacy, 'archivedAt', archived_at, 'deletedAt', deleted_at,
  'tagIds', tag_ids, 'links', links
) as snapshot
from public.note_revisions
where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2;

create temporary table b_snapshot_revision_three_result as
select public.apply_user_note_mutation(
  (select id from public.notes where title = 'B Snapshot Source'),
  2,
  jsonb_build_array(
    jsonb_build_object('type', 'set_title', 'title', 'B Snapshot Drifted'),
    jsonb_build_object('type', 'move_to_space', 'spaceId', null),
    jsonb_build_object('type', 'set_privacy', 'privacy', 'ai_assisted'),
    jsonb_build_object('type', 'set_archived', 'archivedAt', null),
    jsonb_build_object('type', 'set_deleted', 'deletedAt', null),
    jsonb_build_object(
      'type', 'toggle_item_checked',
      'itemId', (select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B Snapshot Source'),
      'checked', false
    ),
    jsonb_build_object('type', 'set_tags', 'tagIds', '[]'::jsonb),
    jsonb_build_object('type', 'set_note_links', 'links', '[]'::jsonb)
  ),
  'b-snapshot-revision-three'
) as result;
select is((select current_revision::text || ':' || is_open::text from public.notes where title = 'B Snapshot Drifted'), '3:true', 'unchecking the list reopens it at revision 3');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Snapshot Drifted')), 0::bigint, 'revision 3 removes tag relations');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Snapshot Drifted')), 0::bigint, 'revision 3 removes note links');

reset role;
update public.notes set pinned_at = null where title = 'B Snapshot Drifted';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
create temporary table b_snapshot_restore_result as
select public.restore_note_revision(
  (select id from public.notes where title = 'B Snapshot Drifted'),
  (select id from b_revision_two_snapshot),
  3,
  'b-snapshot-restore'
) as result;
select is((select result -> 'note' ->> 'currentRevision' from b_snapshot_restore_result), '4', 'revision-ID restore appends revision 4');
select ok((
  select space_id = 'spc_00000000000000000000000002'
    and type = 'list'
    and title = 'B Snapshot Source'
    and is_open = false
    and pinned_at = '2026-08-30T20:00:00.000Z'::timestamptz
    and privacy = 'private_manual'
    and archived_at = '2026-08-30T20:01:00.000Z'::timestamptz
    and deleted_at = '2026-08-30T20:02:00.000Z'::timestamptz
  from public.notes where title = 'B Snapshot Source'
), 'restore recovers the full scalar snapshot, including pin/privacy/lifecycle fields');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'restore recovers the historical tag set');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Snapshot Source')), 1::bigint, 'restore recovers the historical link set');
select is(
  (select jsonb_build_object(
    'spaceId', space_id, 'type', type, 'title', title, 'bodyMarkdown', body_markdown,
    'structuredData', structured_data, 'isOpen', is_open, 'pinnedAt', pinned_at,
    'privacy', privacy, 'archivedAt', archived_at, 'deletedAt', deleted_at,
    'tagIds', tag_ids, 'links', links
  ) from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 4),
  (select snapshot from b_revision_two_snapshot),
  'restored revision is a complete immutable copy of the historical snapshot'
);
select is((select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 4), (select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source') and revision = 2), 'full-state restore reproduces the historical content hash');
select is((select jsonb_build_object('id', id, 'snapshot', jsonb_build_object('spaceId', space_id, 'type', type, 'title', title, 'bodyMarkdown', body_markdown, 'structuredData', structured_data, 'isOpen', is_open, 'pinnedAt', pinned_at, 'privacy', privacy, 'archivedAt', archived_at, 'deletedAt', deleted_at, 'tagIds', tag_ids, 'links', links)) from public.note_revisions where id = (select id from b_revision_two_snapshot)), (select jsonb_build_object('id', id, 'snapshot', snapshot) from b_revision_two_snapshot), 'restoring never mutates the source revision');
select is((select result -> 'revision' -> 'tagIds' ->> 0 from b_snapshot_restore_result), (select id from public.tags where name = 'snapshot-tag'), 'restore response revision exposes historical relations');
select is(public.restore_note_revision((select id from public.notes where title = 'B Snapshot Source'), (select id from b_revision_two_snapshot), 3, 'b-snapshot-restore') ->> 'replayed', 'true', 'full-state restore is replay-safe before stale validation');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Snapshot Source')), 4::bigint, 'restore replay creates no duplicate revision');

select is(public.create_note('b-archive-replay-create', 'generic', 'B Archive Replay', '') ->> 'replayed', 'false', 'archive replay fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Archive Replay'), 1, '[{"type":"set_archived","archivedAt":"2026-08-30T21:00:00.000Z"}]'::jsonb, 'b-archive-replay') -> 'note' ->> 'currentRevision', '2', 'first archive timestamp creates revision 2');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Archive Replay'), 1, '[{"type":"set_archived","archivedAt":"2026-08-30T21:00:01.000Z"}]'::jsonb, 'b-archive-replay') ->> 'replayed', 'true', 'archive retry normalizes its regenerated non-null timestamp');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Archive Replay')), 2::bigint, 'normalized archive replay creates no extra revision');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Archive Replay'), 1, '[{"type":"set_deleted","deletedAt":"2026-08-30T21:00:01.000Z"}]'::jsonb, 'b-archive-replay')$$, 'P0001', 'invalid_idempotency_key', 'idempotency normalization still rejects a different semantic operation');

select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Snapshot Source'), 4, '[{"type":"set_open","isOpen":true}]'::jsonb, 'b-untyped-set-open')$$, '22023', 'validation_failed', 'uncontracted set_open operation is rejected');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Snapshot Source'), 4, '[{"type":"set_title","title":"forged","extra":true}]'::jsonb, 'b-extra-operation-key')$$, '22023', 'validation_failed', 'strict operation validation rejects extra keys');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Snapshot Source'), 4, '[{"type":"set_archived","archivedAt":true}]'::jsonb, 'b-boolean-archive')$$, '22023', 'validation_failed', 'boolean archived payload is rejected in favor of archivedAt ISO-or-null');
select is((select current_revision from public.notes where title = 'B Snapshot Source'), 4, 'rejected operations leave current note and revision unchanged');

select throws_ok(
  $$select public.create_note('b-cross-link-create', 'generic', 'B Cross Link Create', '', null, 'ai_assisted', null, '[]'::jsonb, '[{"toNoteId":"note_00000000000000000000000009","linkType":"related"}]'::jsonb)$$,
  'P0001',
  'not_found',
  'create_note rejects a cross-user link target'
);
select is((select count(*) from public.notes where title = 'B Cross Link Create'), 0::bigint, 'cross-user create failure rolls back note, receipt, revision, and relations');
select throws_ok(
  $$select public.create_note('b-duplicate-link-create', 'generic', 'B Duplicate Link Create', '', null, 'ai_assisted', null, '[]'::jsonb, jsonb_build_array(jsonb_build_object('toNoteId', (select id from public.notes where title = 'B Snapshot Target'), 'linkType', 'related'), jsonb_build_object('toNoteId', (select id from public.notes where title = 'B Snapshot Target'), 'linkType', 'related')))$$,
  'P0001',
  'structure_conflict',
  'create_note rejects duplicate links atomically'
);
select is((select count(*) from public.notes where title = 'B Duplicate Link Create'), 0::bigint, 'duplicate-link create leaves no partial note');

select * from finish();
rollback;
