create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(39);

select is(public.create_note('b-undo-list-create', 'list', 'B Undo List', '- [ ] milk') ->> 'replayed', 'false', 'undo list fixture is created');
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Undo List'),
    1,
    jsonb_build_array(jsonb_build_object(
      'type', 'toggle_item_checked',
      'itemId', (select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B Undo List'),
      'checked', true
    )),
    'b-undo-list-toggle'
  ) ->> 'replayed',
  'false',
  'toggle mutation creates undoable change'
);
select is((select current_revision from public.notes where title = 'B Undo List'), 2, 'toggle reaches revision 2');
select isnt(
  (select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List') and revision = 2),
  (select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List') and revision = 1),
  'toggle changes canonical content hash'
);
select is(
  public.undo_user_mutation(
    (select id from public.note_mutations where idempotency_key = 'b-undo-list-toggle'),
    2,
    'b-undo-list-toggle-undo'
  ) -> 'note' ->> 'currentRevision',
  '3',
  'undo appends revision 3'
);
select is((select (structured_data -> 'items' -> 0 ->> 'checked')::boolean from public.notes where title = 'B Undo List'), false, 'undo restores prior checked state');
select is((select body_markdown from public.notes where title = 'B Undo List'), '- [ ] milk', 'undo restores deterministic projection');
select is(
  (select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List') and revision = 3),
  (select content_hash from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List') and revision = 1),
  'undo restores the original content hash'
);
select ok((select undone_at is not null from public.note_mutations where idempotency_key = 'b-undo-list-toggle'), 'undo marks original mutation resolved');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List')), 3::bigint, 'undo preserves all three snapshots');
select is((select count(*) from public.note_mutations where note_id = (select id from public.notes where title = 'B Undo List')), 3::bigint, 'create, toggle, and undo retain their mutation receipts');
select is(
  public.undo_user_mutation(
    (select id from public.note_mutations where idempotency_key = 'b-undo-list-toggle'),
    2,
    'b-undo-list-toggle-undo'
  ) ->> 'replayed',
  'true',
  'undo replay returns original result before stale check'
);
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Undo List')), 3::bigint, 'undo replay creates no revision');
select throws_ok(
  $$select public.undo_user_mutation((select id from public.note_mutations where idempotency_key = 'b-undo-list-toggle'), 3, 'b-undo-list-second')$$,
  'P0001',
  'stale_revision',
  'same mutation cannot be undone twice'
);

select is(public.create_note('b-history-create', 'generic', 'B History Note', 'version one') ->> 'replayed', 'false', 'history fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B History Note'), 1, '[{"type":"set_title","title":"B History Note v2"}]'::jsonb, 'b-history-v2') -> 'note' ->> 'currentRevision', '2', 'first history mutation reaches revision 2');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B History Note v2'), 2, '[{"type":"replace_body_markdown","bodyMarkdown":"version three"}]'::jsonb, 'b-history-v3') -> 'note' ->> 'currentRevision', '3', 'later history mutation reaches revision 3');
select throws_ok(
  $$select public.undo_user_mutation((select id from public.note_mutations where idempotency_key = 'b-history-v2'), 3, 'b-history-incompatible-undo')$$,
  'P0001',
  'stale_revision',
  'undo rejects an incompatible later edit'
);
select is((select body_markdown from public.notes where title = 'B History Note v2'), 'version three', 'failed incompatible undo leaves latest content');

select is(
  public.restore_note_revision(
    (select id from public.notes where title = 'B History Note v2'),
    (select id from public.note_revisions where note_id = (select id from public.notes where title = 'B History Note v2') and revision = 1),
    3,
    'b-history-restore-v1'
  ) -> 'note' ->> 'currentRevision',
  '4',
  'revision restore appends revision 4'
);
select is((select title from public.notes where id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1)), 'B History Note', 'revision restore recovers old title');
select is((select body_markdown from public.notes where id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1)), 'version one', 'revision restore recovers old body');
select is(
  (select content_hash from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1) and revision = 4),
  (select content_hash from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1) and revision = 1),
  'restored snapshot matches original content hash'
);
select is((select count(*) from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1)), 4::bigint, 'restore never mutates earlier snapshots');
select is(public.restore_note_revision((select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1), (select id from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1) and revision = 1), 3, 'b-history-restore-v1') ->> 'replayed', 'true', 'restore replay returns original response');
select is((select count(*) from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1)), 4::bigint, 'restore replay creates no snapshot');
select throws_ok(
  $$select public.restore_note_revision((select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1), (select id from public.note_revisions where note_id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1) and revision = 2), 3, 'b-history-stale-restore')$$,
  'P0001',
  'stale_revision',
  'restore enforces current expected revision'
);
select throws_ok(
  $$select public.restore_note_revision((select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1), 'rev_00000000000000000000000009', 4, 'b-history-cross-user-revision')$$,
  'P0001',
  'not_found',
  'restore rejects a revision that does not belong to the owned note'
);
select is((select current_revision from public.notes where id = (select note_id from public.note_revisions where actor = 'user:restore-revision' limit 1)), 4, 'rejected cross-user revision restore leaves current revision unchanged');

reset role;
select throws_ok(
  $$update public.note_revisions set body_markdown = 'mutated history' where actor = 'user:restore-revision'$$,
  'P0001',
  'immutable_revision',
  'database trigger prevents even privileged revision updates'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select is(public.create_tag('b-undo-tag-create', 'undo-tag') ->> 'replayed', 'false', 'tag fixture is created through RPC');
select is(public.create_note('b-link-target-create', 'generic', 'B Link Target', '') ->> 'replayed', 'false', 'link target note is created');
select is(public.create_note('b-link-source-create', 'generic', 'B Link Source', '') ->> 'replayed', 'false', 'link source note is created');
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Link Source'),
    1,
    jsonb_build_array(
      jsonb_build_object('type', 'set_tags', 'tagIds', jsonb_build_array((select id from public.tags where name = 'undo-tag'))),
      jsonb_build_object('type', 'set_note_links', 'links', jsonb_build_array(jsonb_build_object('toNoteId', (select id from public.notes where title = 'B Link Target'), 'linkType', 'related')))
    ),
    'b-tags-links-set'
  ) -> 'note' ->> 'currentRevision',
  '2',
  'tag/link mutation is revisioned atomically'
);
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Link Source')), 1::bigint, 'tag relation exists after mutation');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Link Source')), 1::bigint, 'note link exists after mutation');
select is(public.undo_user_mutation((select id from public.note_mutations where idempotency_key = 'b-tags-links-set'), 2, 'b-tags-links-undo') -> 'note' ->> 'currentRevision', '3', 'tag/link mutation can be undone');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Link Source')), 0::bigint, 'undo restores prior tag set');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Link Source')), 0::bigint, 'undo restores prior link set');

select * from finish();
rollback;
