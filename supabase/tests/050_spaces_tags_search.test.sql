create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(86);

-- Spaces are shallow, owner-scoped, revisioned, and replay-safe.
select is(public.create_space('b-space-root', 'B Root') ->> 'replayed', 'false', 'root space is created');
select is((select current_revision from public.spaces where name = 'B Root'), 1, 'new space starts at revision 1');
select is(public.create_space('b-space-sorted', 'B Sorted', null, null, 'c0') -> 'space' ->> 'sortKey', 'c0', 'space creation persists the contract sort key');
select throws_ok($$select public.create_space('b-space-bad-sort', 'B Bad Sort', null, null, '')$$, '22023', 'validation_failed', 'space creation rejects an empty sort key');
select is(public.create_space('b-space-root', 'B Root') ->> 'replayed', 'true', 'space create replays');
select is((select count(*) from public.spaces where name = 'B Root'), 1::bigint, 'space replay creates no duplicate');
select throws_ok($$select public.create_space('b-space-root', 'Aliased Root')$$, 'P0001', 'invalid_idempotency_key', 'space create key cannot alias another request');
select is(public.create_space('b-space-child', 'B Child', (select id from public.spaces where name = 'B Root')) ->> 'replayed', 'false', 'one child nesting level is accepted');
select throws_ok(
  $$select public.create_space('b-space-grandchild', 'B Grandchild', (select id from public.spaces where name = 'B Child'))$$,
  'P0001',
  'not_found',
  'grandchild nesting is rejected'
);
select throws_ok($$select public.create_space('b-space-cross-parent', 'B Cross Parent', 'spc_00000000000000000000000009')$$, 'P0001', 'not_found', 'cross-user parent is rejected');
select is(
  public.update_space(
    (select id from public.spaces where name = 'B Root'),
    1,
    '{"name":"B Root Renamed","sortKey":"b0"}'::jsonb,
    'b-space-update'
  ) -> 'space' ->> 'currentRevision',
  '2',
  'space update increments the revision'
);
select is((select sort_key from public.spaces where name = 'B Root Renamed'), 'b0', 'space patch persists allowed fields');
select is(
  public.update_space(
    (select id from public.spaces where name = 'B Root Renamed'),
    1,
    '{"name":"B Root Renamed","sortKey":"b0"}'::jsonb,
    'b-space-update'
  ) ->> 'replayed',
  'true',
  'space update replays without exposing an internal revision'
);
select is(
  public.update_space((select id from public.spaces where name = 'B Root Renamed'), 2, '{"name":"B Root Final"}'::jsonb, 'b-space-second-update') -> 'space' ->> 'currentRevision',
  '3',
  'a distinct idempotent space update locks and advances the internal revision'
);
select throws_ok(
  $$select public.update_space((select id from public.spaces where name = 'B Root Final'), 2, '{"name":"Must Not Apply"}'::jsonb, 'b-space-stale-update')$$,
  'P0001',
  'stale_revision',
  'space update rejects a stale expected revision'
);
select throws_ok(
  $$select public.update_space((select id from public.spaces where name = 'B Child'), 1, '{"parentId":"spc_00000000000000000000000009"}'::jsonb, 'b-space-cross-move')$$,
  'P0001',
  'not_found',
  'space update rejects a cross-user parent'
);
select is(public.archive_space((select id from public.spaces where name = 'B Child'), 1, true, 'b-space-archive') -> 'space' ->> 'currentRevision', '2', 'space archive increments its internal revision');
select ok((select archived_at is not null from public.spaces where name = 'B Child'), 'space archive sets archived_at');
select is(public.archive_space((select id from public.spaces where name = 'B Child'), 1, true, 'b-space-archive') ->> 'replayed', 'true', 'space archive is replayable');
select throws_ok($$select public.archive_space((select id from public.spaces where name = 'B Child'), 1, false, 'b-space-stale-archive')$$, 'P0001', 'stale_revision', 'space archive rejects a stale expected revision');
select throws_ok($$select public.archive_space('spc_00000000000000000000000009', 1, true, 'b-space-cross-archive')$$, 'P0001', 'not_found', 'space archive hides cross-user rows');

-- Tags use the same idempotent expected-revision contract.
select is(public.create_tag('b-tag-create', '  B-TAG  ') -> 'tag' ->> 'name', 'b-tag', 'tag creation normalizes its name');
select is(public.create_tag('b-tag-create', 'b-tag') -> 'tag' ->> 'currentRevision', '1', 'new tag starts at revision 1');
select is(public.create_tag('b-tag-create', 'b-tag') ->> 'replayed', 'true', 'normalized equivalent tag create replays');
select is((select count(*) from public.tags where name = 'b-tag'), 1::bigint, 'tag replay creates no duplicate');
select throws_ok($$select public.create_tag('b-tag-create', 'different-tag')$$, 'P0001', 'invalid_idempotency_key', 'tag create key cannot alias another request');
select is(public.create_tag('b-tag-update-create', 'b-update-tag') -> 'tag' ->> 'currentRevision', '1', 'tag update fixture starts at revision 1');
select is(
  public.update_tag(
    (select id from public.tags where name = 'b-update-tag'),
    1,
    '  B-UPDATED-TAG  ',
    'b-tag-update'
  ) -> 'tag' ->> 'name',
  'b-updated-tag',
  'authenticated owner can update and normalize a tag'
);
select is((select current_revision from public.tags where name = 'b-updated-tag'), 2, 'tag update increments the expected revision');
select is(
  public.update_tag(
    (select id from public.tags where name = 'b-updated-tag'),
    1,
    'b-updated-tag',
    'b-tag-update'
  ) ->> 'replayed',
  'true',
  'tag update replay is returned before stale validation'
);
select throws_ok(
  $$select public.update_tag((select id from public.tags where name = 'b-updated-tag'), 1, 'must-not-apply', 'b-tag-update-stale')$$,
  'P0001', 'stale_revision',
  'tag update rejects a stale expected revision'
);
select throws_ok(
  $$select public.update_tag('tag_00000000000000000000000009', 1, 'forged-cross-user', 'b-tag-update-cross-user')$$,
  'P0001', 'not_found',
  'tag update hides cross-user rows'
);
select throws_ok(
  $$select public.update_tag((select id from public.tags where name = 'b-updated-tag'), 1, 'different-name', 'b-tag-update')$$,
  'P0001', 'invalid_idempotency_key',
  'tag update key cannot alias different input'
);

-- Relation operations cannot forge ownership and roll back the whole mutation.
select is(public.create_note('b-rel-source', 'generic', 'B Relation Source', '') ->> 'replayed', 'false', 'relation source note is created');
select is(public.create_note('b-rel-target', 'generic', 'B Relation Target', '') ->> 'replayed', 'false', 'relation target note is created');
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Relation Source'),
    1,
    jsonb_build_array(
      jsonb_build_object('type', 'set_tags', 'tagIds', jsonb_build_array((select id from public.tags where name = 'b-tag'))),
      jsonb_build_object('type', 'set_note_links', 'links', jsonb_build_array(jsonb_build_object('toNoteId', (select id from public.notes where title = 'B Relation Target'), 'linkType', 'reference')))
    ),
    'b-relations-valid'
  ) -> 'note' ->> 'currentRevision',
  '2',
  'tag and note-link sets commit in one revision'
);
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Relation Source')), 1::bigint, 'owned tag relation is visible');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Relation Source')), 1::bigint, 'owned note link is visible');
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B Relation Source'),
      2,
      jsonb_build_array(
        jsonb_build_object('type', 'set_title', 'title', 'Must Roll Back'),
        jsonb_build_object('type', 'set_note_links', 'links', jsonb_build_array(jsonb_build_object('toNoteId', 'note_00000000000000000000000009', 'linkType', 'reference')))
      ),
      'b-relations-cross-link'
    )
  $$,
  'P0001',
  'not_found',
  'cross-user link target rejects the complete mutation'
);
select is((select title from public.notes where title = 'B Relation Source'), 'B Relation Source', 'cross-user link failure rolls back earlier operations');
select is((select current_revision from public.notes where title = 'B Relation Source'), 2, 'cross-user link failure consumes no revision');
select throws_ok(
  $$
    select public.apply_user_note_mutation(
      (select id from public.notes where title = 'B Relation Source'),
      2,
      jsonb_build_array(jsonb_build_object('type', 'set_tags', 'tagIds', '["tag_00000000000000000000000009"]'::jsonb)),
      'b-relations-cross-tag'
    )
  $$,
  'P0001',
  'not_found',
  'cross-user tag target is rejected'
);
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Relation Source')), 1::bigint, 'cross-user tag failure preserves the prior tag set');

-- List, log, and project projections stay deterministic while IDs remain stable.
select is(
  public.create_note(
    'b-log-create',
    'log',
    'B Deterministic Log',
    E'## 2026-09-01T12:00:00.000Z\n\n- note: earlier\n\n## 2026-09-02T12:00:00.000Z\n\n- note: later',
    null,
    'ai_assisted',
    '{"schemaVersion":1,"entries":[{"id":"ent_0000000000000000000000000Z","occurredAt":"2026-09-02T12:00:00.000Z","fields":{"note":"later"}},{"id":"ent_0000000000000000000000000A","occurredAt":"2026-09-01T12:00:00.000Z","fields":{"note":"earlier"}}]}'::jsonb
  ) ->> 'replayed',
  'false',
  'structured log is created'
);
select is((select body_markdown from public.notes where title = 'B Deterministic Log'), E'## 2026-09-01T12:00:00.000Z\n\n- note: earlier\n\n## 2026-09-02T12:00:00.000Z\n\n- note: later', 'log projection sorts entries deterministically');
select is(public.create_note('b-project-create', 'project', 'B Project Checklist', E'## Next\n- [ ] ship it') ->> 'replayed', 'false', 'project checklist is parsed');
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Project Checklist'),
    1,
    jsonb_build_array(jsonb_build_object('type', 'toggle_item_checked', 'itemId', (select structured_data -> 'checklistItems' -> 0 ->> 'id' from public.notes where title = 'B Project Checklist'), 'checked', true)),
    'b-project-toggle'
  ) -> 'note' ->> 'bodyMarkdown',
  E'## Next\n- [x] ship it',
  'typed project toggle updates only the source checklist line'
);
select ok((select structured_data -> 'checklistItems' -> 0 ->> 'id' from public.notes where title = 'B Project Checklist') ~ '^itm_', 'project toggle preserves stable item identity');
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Project Checklist'),
    2,
    jsonb_build_array(jsonb_build_object('type', 'edit_item_text', 'itemId', (select structured_data -> 'checklistItems' -> 0 ->> 'id' from public.notes where title = 'B Project Checklist'), 'text', 'ship safely')),
    'b-project-edit'
  ) -> 'note' ->> 'bodyMarkdown',
  E'## Next\n- [x] ship safely',
  'typed project edit updates only the selected checklist line'
);
select is((select structured_data -> 'checklistItems' -> 0 ->> 'text' from public.notes where title = 'B Project Checklist'), 'ship safely', 'project edit updates canonical structured text');

-- Search includes private manual notes for their owner, respects archive/deletion,
-- ranks exact titles first, and never leaks another user's data.
select is(public.create_space('b-search-root', 'B Search Root') ->> 'replayed', 'false', 'search root space is created');
select is(public.create_space('b-search-child', 'B Search Child', (select id from public.spaces where name = 'B Search Root')) ->> 'replayed', 'false', 'search child space is created');
select is(public.create_note('b-search-exact', 'generic', 'Quartz Needle', 'owner body', (select id from public.spaces where name = 'B Search Child'), 'private_manual') ->> 'replayed', 'false', 'private search fixture is created');
select is(public.create_note('b-search-prefix', 'generic', 'Quartz Needlebox', 'secondary body') ->> 'replayed', 'false', 'prefix search fixture is created');
select is(public.create_note('b-search-body', 'generic', 'Body Match', 'contains quartzbodytoken here') ->> 'replayed', 'false', 'body search fixture is created');
select is(public.create_note('b-search-context', 'generic', 'Context Match', repeat('prefix ', 60) || 'quartzcontexttoken' || repeat(' suffix', 20)) ->> 'replayed', 'false', 'long-body snippet fixture is created');
select is(public.create_note('b-search-literal-symbols', 'generic', 'Literal % and _ markers', '') ->> 'replayed', 'false', 'literal-symbol search fixture is created');
select is(public.create_note('b-search-archived', 'generic', 'Archived Quartzmarker', '') ->> 'replayed', 'false', 'archived search fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'Archived Quartzmarker'), 1, '[{"type":"set_archived","archivedAt":"2026-08-30T23:46:00.000Z"}]'::jsonb, 'b-search-archive-note') -> 'note' ->> 'currentRevision', '2', 'search fixture is archived through schema-shaped mutation RPC');
select is(public.create_note('b-search-deleted', 'generic', 'Deleted Quartzgrave', '') ->> 'replayed', 'false', 'deleted search fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'Deleted Quartzgrave'), 1, '[{"type":"set_deleted","deletedAt":"2026-08-30T23:47:00.000Z"}]'::jsonb, 'b-search-delete-note') -> 'note' ->> 'currentRevision', '2', 'search fixture is deleted through schema-shaped mutation RPC');
select is((select title from public.search_notes('Quartz Needle') limit 1), 'Quartz Needle', 'exact title ranks ahead of prefix matches');
select is((select title from public.search_notes('Quartz Needle', 'exclude', 1, 1)), 'Quartz Needlebox', 'search offset returns the next deterministic ranked row');
select is((select count(*) from public.search_notes('quartzbodytoken')), 1::bigint, 'full-text body terms are searchable');
select is((select count(*) from public.search_notes('quartzbody')), 1::bigint, 'body prefixes are searchable');
select ok((select snippet like '%quartzcontexttoken%' and char_length(snippet) <= 240 from public.search_notes('quartzcontexttoken') where title = 'Context Match'), 'snippet is centered around a late body match and remains bounded');
select is((select space_path from public.search_notes('Quartz Needle') where title = 'Quartz Needle'), 'B Search Root / B Search Child', 'search returns the nested space path');
select is((select count(*) from public.search_notes('B Search Child') where title = 'Quartz Needle'), 1::bigint, 'space path is an explicit search surface');
select ok((select count(*) > 0 from public.search_notes(current_date::text)), 'updated date is an explicit search surface');
select ok((select updated_at is not null from public.search_notes('Quartz Needle') where title = 'Quartz Needle'), 'search result includes updated_at for deterministic API mapping');
select is((select count(*) from public.search_notes('b-tag')), 0::bigint, 'search does not claim tag metadata outside title, body, date, and path');
select is((select count(*) from public.search_notes('Quartz Needle') where title = 'Quartz Needle'), 1::bigint, 'owner can search private_manual content');
select is((select count(*) from public.search_notes('Quartzmarker')), 0::bigint, 'default search excludes archived notes');
select is((select count(*) from public.search_notes('Quartzmarker', 'include')), 1::bigint, 'include filter returns archived notes');
select is((select count(*) from public.search_notes('Quartzmarker', 'only')), 1::bigint, 'only filter returns archived notes');
select is((select count(*) from public.search_notes('Quartzgrave', 'include')), 0::bigint, 'search always excludes deleted notes');
select is((select count(*) from public.search_notes('isolation', 'include')), 0::bigint, 'search never returns another user''s note');
select is((select count(*) from public.search_notes('%')), 1::bigint, 'percent is treated as a literal search character');
select is((select count(*) from public.search_notes('_')), 1::bigint, 'underscore is treated as a literal search character');
select throws_ok($$select * from public.search_notes('', 'exclude')$$, '22023', 'validation_failed', 'blank search query is rejected');
select throws_ok($$select * from public.search_notes('needle', 'everything')$$, '22023', 'validation_failed', 'invalid archive filter is rejected');

-- The sync cursor is the sole realtime publication surface for these writes.
select is(
  (
    select count(*)
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'user_events'
  ),
  1::bigint,
  'user_events is in the Supabase realtime publication'
);

-- Deletion is idempotent even though its row no longer exists afterward.
create temporary table b_deleted_tag_fixture as
select id, current_revision from public.tags where name = 'b-tag';
select throws_ok($$select public.delete_tag((select id from b_deleted_tag_fixture), 2, 'b-tag-stale-delete')$$, 'P0001', 'stale_revision', 'tag delete rejects a stale expected revision');
select is(public.delete_tag((select id from b_deleted_tag_fixture), (select current_revision from b_deleted_tag_fixture), 'b-tag-delete') ->> 'deletedId', (select id from b_deleted_tag_fixture), 'tag delete returns the exact deleted ID');
select is(public.delete_tag((select id from b_deleted_tag_fixture), (select current_revision from b_deleted_tag_fixture), 'b-tag-delete') ->> 'replayed', 'true', 'tag delete response replays after row deletion');
select is((select count(*) from public.tags where name = 'b-tag'), 0::bigint, 'tag delete removes the owned row');

select * from finish();
rollback;
