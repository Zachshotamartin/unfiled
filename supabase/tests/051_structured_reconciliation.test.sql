create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(56);

-- Lists reject lossy prose and preserve stable item identities across reparses.
select is(public.create_note('b-reconcile-list-create', 'list', 'B Reconcile List', E'## Produce\n- [ ] milk\n- [ ] eggs') ->> 'replayed', 'false', 'list reconciliation fixture is created');
create temporary table b_list_ids as
select
  structured_data -> 'items' -> 0 ->> 'id' as first_id,
  structured_data -> 'items' -> 1 ->> 'id' as second_id
from public.notes where title = 'B Reconcile List';
select ok((select first_id ~ '^itm_' and second_id ~ '^itm_' from b_list_ids), 'initial list items have typed stable IDs');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile List'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"## Produce\n- [ ] oat milk\n- [ ] eggs"}]'::jsonb, 'b-reconcile-list-edit') -> 'note' ->> 'currentRevision', '2', 'unambiguous list body edit reparses');
select is((select structured_data -> 'items' -> 0 ->> 'id' from public.notes where title = 'B Reconcile List'), (select first_id from b_list_ids), 'list edit preserves identity by unused ordinal fallback');
select is((select structured_data -> 'items' -> 1 ->> 'id' from public.notes where title = 'B Reconcile List'), (select second_id from b_list_ids), 'unchanged list text preserves identity by normalized text');
select is((select body_markdown from public.notes where title = 'B Reconcile List'), E'## Produce\n\n- [ ] oat milk\n- [ ] eggs', 'list projection renders canonical section bytes');
select is((select source::text from public.note_revisions where note_id = (select id from public.notes where title = 'B Reconcile List') and revision = 2), 'manual', 'list body save is attributed to a manual revision');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile List'), 2, '[{"type":"replace_body_markdown","bodyMarkdown":"- [ ] oat milk\nremember organic"}]'::jsonb, 'b-reconcile-list-prose') ->> 'errorCode', 'structure_conflict', 'mixed checklist and prose returns the durable conflict envelope');
select is((select current_revision from public.notes where title = 'B Reconcile List'), 2, 'lossy list edit leaves the note revision unchanged');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Reconcile List')), 2::bigint, 'lossy list edit appends no immutable revision');
select is((select count(*) from public.review_items where note_id = (select id from public.notes where title = 'B Reconcile List') and type = 'structure_conflict' and state = 'open'), 1::bigint, 'structure conflict commits one open review item');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile List'), 2, '[{"type":"replace_body_markdown","bodyMarkdown":"- [ ] oat milk\nremember organic"}]'::jsonb, 'b-reconcile-list-prose') ->> 'replayed', 'true', 'structure-conflict envelope replays idempotently');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile List'), 2, '[{"type":"replace_body_markdown","bodyMarkdown":"- [ ] Milk\n- [ ]   milk"}]'::jsonb, 'b-reconcile-list-duplicate') ->> 'errorCode', 'structure_conflict', 'duplicate normalized list text is ambiguous');
select is((select count(*) from public.review_items where note_id = (select id from public.notes where title = 'B Reconcile List') and type = 'structure_conflict' and state = 'open'), 1::bigint, 'multiple conflicts dedupe to the same open review');
select is((select body_markdown from public.notes where title = 'B Reconcile List'), E'## Produce\n\n- [ ] oat milk\n- [ ] eggs', 'ambiguous list edit rolls back its body');
select is((select current_revision from public.notes where title = 'B Reconcile List'), 2, 'ambiguous list edit consumes no revision');
select throws_ok($$select public.create_note('b-duplicate-list-create', 'list', 'B Duplicate List', E'- [ ] Milk\n- [ ]  milk')$$, 'P0001', 'structure_conflict', 'duplicate normalized text is rejected at list creation');

-- Projects preserve arbitrary prose while reconciling only explicit checklist lines.
select is(public.create_note('b-reconcile-project-create', 'project', 'B Reconcile Project', E'# Launch\nKeep this prose.\n* [ ] Alpha\n+ [ ] Beta') ->> 'replayed', 'false', 'project reconciliation fixture is created');
create temporary table b_project_ids as
select
  structured_data -> 'checklistItems' -> 0 ->> 'id' as alpha_id,
  structured_data -> 'checklistItems' -> 1 ->> 'id' as beta_id
from public.notes where title = 'B Reconcile Project';
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Project'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"# Launch\nKeep this prose.\n+ [ ] Beta\n* [ ] Alpha"}]'::jsonb, 'b-reconcile-project-move') -> 'note' ->> 'currentRevision', '2', 'project body reparses after checklist lines move');
select is((select body_markdown from public.notes where title = 'B Reconcile Project'), E'# Launch\nKeep this prose.\n+ [ ] Beta\n* [ ] Alpha', 'project reparse preserves arbitrary Markdown bytes');
select ok((
  select structured_data -> 'checklistItems' -> 0 ->> 'id' = (select beta_id from b_project_ids)
    and structured_data -> 'checklistItems' -> 1 ->> 'id' = (select alpha_id from b_project_ids)
  from public.notes where title = 'B Reconcile Project'
), 'project items retain IDs by normalized text after reordering');
select is(public.apply_user_note_mutation(
  (select id from public.notes where title = 'B Reconcile Project'),
  2,
  jsonb_build_array(
    jsonb_build_object('type', 'toggle_item_checked', 'itemId', (select alpha_id from b_project_ids), 'checked', true),
    jsonb_build_object('type', 'toggle_item_checked', 'itemId', (select beta_id from b_project_ids), 'checked', true)
  ),
  'b-reconcile-project-close'
) -> 'note' ->> 'isOpen', 'false', 'fully checked project derives isOpen false without set_open');
select is((select is_open from public.notes where title = 'B Reconcile Project'), false, 'closed project state persists');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Project'), 3, jsonb_build_array(jsonb_build_object('type', 'toggle_item_checked', 'itemId', (select alpha_id from b_project_ids), 'checked', false)), 'b-reconcile-project-reopen') -> 'note' ->> 'isOpen', 'true', 'unchecking one project item derives isOpen true');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Project'), 4, jsonb_build_array(jsonb_build_object('type', 'remove_item', 'itemId', (select beta_id from b_project_ids))), 'b-reconcile-project-remove') -> 'note' ->> 'currentRevision', '5', 'typed remove_item removes a project checklist line');
select is((select body_markdown from public.notes where title = 'B Reconcile Project'), E'# Launch\nKeep this prose.\n* [ ] Alpha', 'project removal deletes exactly one source line and preserves prose');
select is((select (structured_data -> 'checklistItems' -> 0 ->> 'ordinal')::text || ':' || (structured_data -> 'checklistItems' -> 0 ->> 'lineIndex')::text from public.notes where title = 'B Reconcile Project'), '0:2', 'project removal recomputes ordinal and source line index');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Project'), 5, '[{"type":"replace_body_markdown","bodyMarkdown":"* [ ] Alpha\n+ [ ] alpha"}]'::jsonb, 'b-reconcile-project-duplicate') ->> 'errorCode', 'structure_conflict', 'duplicate normalized project checklist text is rejected');
select is((select current_revision from public.notes where title = 'B Reconcile Project'), 5, 'ambiguous project edit leaves revision unchanged');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Reconcile Project')), 5::bigint, 'ambiguous project edit appends no immutable revision');

-- Logs round-trip duplicate timestamps, stable IDs, typed values, and canonical bytes.
select is(public.create_note(
  'b-reconcile-log-create',
  'log',
  'B Reconcile Log',
  E'## 2026-08-30T22:00:00.000Z\n\n- nullString: "null"\n- numericString: "10"\n- quoted: "\\"hello\\""\n- reps: 10\n- spaced: " x "\n\n## 2026-08-30T22:00:00.000Z\n\n- note: second',
  null,
  'ai_assisted',
  '{"schemaVersion":1,"entries":[{"id":"ent_0000000000000000000000000A","occurredAt":"2026-08-30T22:00:00.000Z","fields":{"numericString":"10","nullString":"null","quoted":"\"hello\"","reps":10,"spaced":" x "}},{"id":"ent_0000000000000000000000000B","occurredAt":"2026-08-30T22:00:00.000Z","fields":{"note":"second"}}]}'::jsonb
) ->> 'replayed', 'false', 'duplicate-timestamp log fixture is created');
create temporary table b_log_initial as
select structured_data, body_markdown from public.notes where title = 'B Reconcile Log';
select ok((select body_markdown like '%- numericString: "10"%' from b_log_initial), 'numeric-looking strings are quoted in the log projection');
select ok((select body_markdown like '%- nullString: "null"%' from b_log_initial), 'null-looking strings are quoted in the log projection');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Log'), 1, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', (select body_markdown from b_log_initial))), 'b-reconcile-log-roundtrip') -> 'note' ->> 'currentRevision', '2', 'unchanged canonical log body round-trips');
select is((select structured_data from public.notes where title = 'B Reconcile Log'), (select structured_data from b_log_initial), 'log round-trip preserves all typed values');
select is((select string_agg(entry ->> 'id', ',' order by ordinal) from public.notes, lateral jsonb_array_elements(structured_data -> 'entries') with ordinality as item(entry, ordinal) where title = 'B Reconcile Log'), 'ent_0000000000000000000000000A,ent_0000000000000000000000000B', 'same-time log entries preserve IDs by timestamp occurrence');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Log'), 2, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', replace((select body_markdown from public.notes where title = 'B Reconcile Log'), '- reps: 10', '- reps: 12'))), 'b-reconcile-log-edit') -> 'note' ->> 'currentRevision', '3', 'unambiguous log field body edit reparses');
select is((select structured_data -> 'entries' -> 0 -> 'fields' ->> 'reps' from public.notes where title = 'B Reconcile Log'), '12', 'log reparse preserves numeric field type and value');
select is((select structured_data -> 'entries' -> 0 ->> 'id' from public.notes where title = 'B Reconcile Log'), 'ent_0000000000000000000000000A', 'log field edit preserves entry identity');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Log'), 3, '[{"type":"update_log_field","entryId":"ent_0000000000000000000000000A","fieldPath":["reps"],"value":13}]'::jsonb, 'b-reconcile-log-field') -> 'note' ->> 'currentRevision', '4', 'typed update_log_field appends a revision');
select ok((select body_markdown like '%- reps: 13%' from public.notes where title = 'B Reconcile Log'), 'typed log field update regenerates canonical Markdown');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Log'), 4, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', (select body_markdown || E'\nprose' from public.notes where title = 'B Reconcile Log'))), 'b-reconcile-log-prose') ->> 'errorCode', 'structure_conflict', 'arbitrary nonblank log prose is rejected');
select is((select current_revision from public.notes where title = 'B Reconcile Log'), 4, 'rejected log prose leaves revision unchanged');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Reconcile Log'), 4, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', replace((select body_markdown from public.notes where title = 'B Reconcile Log'), '- reps: 13', E'- reps: 13\n- reps: 14'))), 'b-reconcile-log-duplicate-field') ->> 'errorCode', 'structure_conflict', 'duplicate log field keys are ambiguous');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Reconcile Log')), 4::bigint, 'failed log reparses append no revisions');
select is((select current_revision from public.notes where title = 'B Reconcile Log'), 4, 'duplicate log keys leave current revision unchanged');

-- The frozen restore_snapshot UserOperation restores all state and remains undoable.
select is(public.create_note('b-restore-operation-create', 'generic', 'B Restore Operation', 'before') ->> 'replayed', 'false', 'restore_snapshot operation fixture is created');
create temporary table b_restore_operation_result as
select public.apply_user_note_mutation(
  (select id from public.notes where title = 'B Restore Operation'),
  1,
  jsonb_build_array(jsonb_build_object(
    'type', 'restore_snapshot',
    'spaceId', 'spc_00000000000000000000000001',
    'noteType', 'project',
    'title', 'B Restored Operation',
    'bodyMarkdown', E'# Restored\n- [x] done',
    'structuredData', '{"schemaVersion":1,"checklistItems":[{"id":"itm_0000000000000000000000000C","text":"done","checked":true,"ordinal":0,"lineIndex":1}]}'::jsonb,
    'privacy', 'private_manual',
    'isOpen', true,
    'pinnedAt', '2026-08-30T23:00:00.000Z',
    'archivedAt', null,
    'deletedAt', null,
    'tagIds', '["tag_00000000000000000000000001"]'::jsonb,
    'links', '[{"toNoteId":"note_00000000000000000000000003","linkType":"reference"}]'::jsonb
  )),
  'b-restore-operation-apply'
) as result;
select is((select result -> 'note' ->> 'currentRevision' from b_restore_operation_result), '2', 'restore_snapshot operation appends revision 2');
select is((select type::text || ':' || body_markdown from public.notes where title = 'B Restored Operation'), E'project:# Restored\n- [x] done', 'restore_snapshot operation changes type and canonical content');
select is((select is_open from public.notes where title = 'B Restored Operation'), false, 'restored checked project derives isOpen false');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Restored Operation')), 1::bigint, 'restore_snapshot operation restores tag relations');
select is((select count(*) from public.note_links where from_note_id = (select id from public.notes where title = 'B Restored Operation')), 1::bigint, 'restore_snapshot operation restores note links');
select is((select jsonb_array_length(tag_ids)::text || ':' || jsonb_array_length(links)::text from public.note_revisions where note_id = (select id from public.notes where title = 'B Restored Operation') and revision = 2), '1:1', 'restore_snapshot revision stores complete relation state');
select is(public.undo_user_mutation((select result ->> 'mutationId' from b_restore_operation_result), 2, 'b-restore-operation-undo') -> 'note' ->> 'currentRevision', '3', 'restore_snapshot operation has a valid inverse undo');
select is((select count(*) from public.note_tags where note_id = (select id from public.notes where title = 'B Restore Operation')), 0::bigint, 'restore_snapshot undo restores the prior empty relations');
select is((select type::text from public.notes where title = 'B Restore Operation'), 'generic', 'restore_snapshot undo restores the prior note type');

select * from finish();
rollback;
