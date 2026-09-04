create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(52);

select ok(
  not has_function_privilege('service_role', 'private.apply_user_note_mutation_core(text,integer,jsonb,text)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.apply_user_note_mutation_core_unchecked(text,integer,jsonb,text)', 'EXECUTE'),
  'service role cannot bypass the public manual-mutation RPC through either private core'
);

-- Empty lists are valid, and replacing a populated list with blank Markdown is lossless.
select is(public.create_note('b-empty-list-create', 'list', 'B Empty List', '') ->> 'replayed', 'false', 'blank list creation succeeds');
select is((select body_markdown || ':' || jsonb_array_length(structured_data -> 'items')::text || ':' || is_open::text from public.notes where title = 'B Empty List'), ':0:true', 'blank list has canonical empty structure and remains open');
select is(public.create_note('b-clear-list-create', 'list', 'B Clear List', '- [ ] remove me') ->> 'replayed', 'false', 'populated list fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Clear List'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":""}]'::jsonb, 'b-clear-list') -> 'note' ->> 'currentRevision', '2', 'blank replacement clears a list in one revision');
select is((select body_markdown || ':' || jsonb_array_length(structured_data -> 'items')::text || ':' || is_open::text from public.notes where title = 'B Clear List'), ':0:true', 'cleared list stores the canonical empty projection');

-- Authenticated callers cannot forge structured state that disagrees with source Markdown.
select throws_ok(
  $$select public.create_note('b-list-shape-mismatch', 'list', 'B List Shape Mismatch', '- [ ] visible', null, 'ai_assisted', '{"schemaVersion":1,"items":[{"id":"itm_0000000000000000000000000D","text":"hidden","checked":false,"ordinal":0,"section":null}]}'::jsonb)$$,
  'P0001', 'structure_conflict', 'list create rejects body and structured-data disagreement'
);
select is((select count(*) from public.notes where title = 'B List Shape Mismatch'), 0::bigint, 'list mismatch rolls back note creation');
select throws_ok(
  $$select public.create_note('b-project-shape-mismatch', 'project', 'B Project Shape Mismatch', '- [ ] visible', null, 'ai_assisted', '{"schemaVersion":1,"checklistItems":[{"id":"itm_0000000000000000000000000E","text":"hidden","checked":false,"ordinal":0,"lineIndex":0}]}'::jsonb)$$,
  'P0001', 'structure_conflict', 'project create rejects body and checklist disagreement'
);
select is((select count(*) from public.notes where title = 'B Project Shape Mismatch'), 0::bigint, 'project mismatch rolls back note creation');

-- Every public UserOperation variant validates JSON value kinds, IDs, and timestamps.
select is(public.create_note('b-strict-op-create', 'generic', 'B Strict Operations', 'unchanged') ->> 'replayed', 'false', 'strict operation fixture is created');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"set_title","title":42}]'::jsonb, 'b-strict-title')$$, '22023', 'validation_failed', 'set_title rejects a JSON number');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":42}]'::jsonb, 'b-strict-body')$$, '22023', 'validation_failed', 'body replacement rejects a JSON number');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"set_archived","archivedAt":"2026-08-30 12:00:00"}]'::jsonb, 'b-strict-archive')$$, '22023', 'validation_failed', 'archive operation rejects a loose timestamp');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"move_to_space","spaceId":42}]'::jsonb, 'b-strict-space')$$, '22023', 'validation_failed', 'space move rejects a non-string ID');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"set_tags","tagIds":[42]}]'::jsonb, 'b-strict-tags')$$, '22023', 'validation_failed', 'tag replacement rejects non-string IDs');
select throws_ok($$select public.apply_user_note_mutation((select id from public.notes where title = 'B Strict Operations'), 1, '[{"type":"set_note_links","links":[{"toNoteId":42,"linkType":"reference"}]}]'::jsonb, 'b-strict-links')$$, '22023', 'validation_failed', 'link replacement rejects a non-string target ID');
select is((select current_revision::text || ':' || body_markdown from public.notes where title = 'B Strict Operations'), '1:unchanged', 'malicious operation shapes leave the note unchanged');
select is(
  (select public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Strict Operations'), 1,
    '[{"type":"restore_snapshot","spaceId":null,"noteType":"project","title":"B Forged Project","bodyMarkdown":"- [ ] visible","structuredData":{"schemaVersion":1,"checklistItems":[{"id":"itm_0000000000000000000000000F","text":"hidden","checked":false,"ordinal":0,"lineIndex":0}]},"privacy":"ai_assisted","isOpen":true,"pinnedAt":null,"archivedAt":null,"deletedAt":null,"tagIds":[],"links":[]}]'::jsonb,
    'b-strict-restore-project') ->> 'errorCode'),
  'structure_conflict', 'restore_snapshot rejects a project body/checklist mismatch'
);
select is((select current_revision from public.notes where title = 'B Strict Operations'), 1, 'forged snapshot appends no revision');

-- SQL NULL must be rejected before the legacy mutation core can claim
-- idempotency or append any durable state. Reusing the rejected key with a
-- valid operation proves the guard leaves no partial claim behind.
select is(public.create_note('b-null-op-create', 'generic', 'B Null Operations', 'unchanged') ->> 'replayed', 'false', 'SQL NULL mutation fixture is created');
select throws_ok(
  $$select public.apply_user_note_mutation((select id from public.notes where title = 'B Null Operations'), 1, null::jsonb, 'b-null-operations')$$,
  '22023', 'validation_failed', 'public manual mutation rejects SQL NULL operations'
);
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Null Operations')), 1::bigint, 'SQL NULL operations append no revision');
select is((select count(*) from public.note_mutations where idempotency_key = 'b-null-operations'), 0::bigint, 'SQL NULL operations append no mutation');
reset role;
select is((select count(*) from public.api_idempotency_records where idempotency_key = 'b-null-operations'), 0::bigint, 'SQL NULL operations leave no idempotency claim');
set local role authenticated;
select is((select count(*) from public.user_events where entity_id = (select id from public.notes where title = 'B Null Operations') or entity_id in (select id from public.note_revisions where note_id = (select id from public.notes where title = 'B Null Operations')) or entity_id in (select id from public.note_mutations where note_id = (select id from public.notes where title = 'B Null Operations'))), 3::bigint, 'SQL NULL operations emit no event');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Null Operations'), 1, '[{"type":"set_title","title":"B Null Operations Valid"}]'::jsonb, 'b-null-operations') -> 'note' ->> 'currentRevision', '2', 'the rejected key remains usable for a valid manual mutation');

-- Log headings use the same strict ISO-offset grammar as the frozen contract.
select is(public.create_note('b-strict-log-create', 'log', 'B Strict ISO Log', '') ->> 'replayed', 'false', 'strict log fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Strict ISO Log'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"## 2026-08-30T12:00:00\n\n- note: no offset"}]'::jsonb, 'b-log-no-offset') ->> 'errorCode', 'structure_conflict', 'log timestamp without offset is rejected');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Strict ISO Log'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"## 2026-1-1T12:00:00Z\n\n- note: loose date"}]'::jsonb, 'b-log-loose-date') ->> 'errorCode', 'structure_conflict', 'log timestamp with a loose date is rejected');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Strict ISO Log'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"## 2026-08-30 12:00:00Z\n\n- note: space"}]'::jsonb, 'b-log-space-time') ->> 'errorCode', 'structure_conflict', 'log timestamp with a space separator is rejected');
select is((select current_revision from public.notes where title = 'B Strict ISO Log'), 1, 'invalid log headings leave revision unchanged');

-- Canonically encoded strings are bounded after JSON decoding, not before it.
select is(
  public.create_note(
    'b-log-boundary-string', 'log', 'B Log Boundary String',
    E'## 2026-08-30T12:00:00.000Z\n\n- payload: ' || to_jsonb(repeat(E'\n"', 250))::text,
    null, 'ai_assisted',
    jsonb_build_object('schemaVersion', 1, 'entries', jsonb_build_array(jsonb_build_object(
      'id', 'ent_0000000000000000000000000D', 'occurredAt', '2026-08-30T12:00:00.000Z',
      'fields', jsonb_build_object('payload', repeat(E'\n"', 250))
    )))
  ) ->> 'replayed',
  'false', 'a 500-character string with escaped newlines and quotes is created'
);
select ok((select char_length(body_markdown) > 500 from public.notes where title = 'B Log Boundary String'), 'encoded canonical log text may exceed the decoded 500-character bound');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Log Boundary String'), 1, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', (select body_markdown from public.notes where title = 'B Log Boundary String'))), 'b-log-boundary-roundtrip') -> 'note' ->> 'currentRevision', '2', 'encoded boundary string round-trips through Markdown');
select is((select char_length(structured_data -> 'entries' -> 0 -> 'fields' ->> 'payload') from public.notes where title = 'B Log Boundary String'), 500, 'round-trip preserves the decoded 500-character value');

-- A whole capture filed as one entry: the field bound is 10,000 characters (20260904000001).
select is(
  public.create_note(
    'b-log-long-field', 'log', 'B Log Long Field',
    E'## 2026-08-30T12:00:00.000Z\n\n- raw: ' || repeat('x', 10000),
    null, 'ai_assisted',
    jsonb_build_object('schemaVersion', 1, 'entries', jsonb_build_array(jsonb_build_object(
      'id', 'ent_0000000000000000000000000E', 'occurredAt', '2026-08-30T12:00:00.000Z',
      'fields', jsonb_build_object('raw', repeat('x', 10000))
    )))
  ) ->> 'replayed',
  'false', 'a 10,000-character log field value is created'
);
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Log Long Field'), 1, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', E'## 2026-08-30T12:00:00.000Z\n\n- raw: ' || repeat('x', 10001))), 'b-log-too-long-field') ->> 'errorCode', 'structure_conflict', 'a 10,001-character log field value is refused');

-- SQL parses through double precision and renders the shared plain-decimal grammar.
select is(public.create_note('b-log-number-create', 'log', 'B Log Numbers', '') ->> 'replayed', 'false', 'numeric log fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Log Numbers'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"## 2026-08-30T12:00:00.000Z\n\n- value: 9007199254740993"}]'::jsonb, 'b-log-number-normalize') -> 'note' ->> 'currentRevision', '2', 'unsafe decimal text is normalized through the shared double parser');
select is((select structured_data -> 'entries' -> 0 -> 'fields' ->> 'value' || ':' || body_markdown from public.notes where title = 'B Log Numbers'), E'9007199254740992:## 2026-08-30T12:00:00.000Z\n\n- value: 9007199254740992', 'numeric normalization matches JavaScript Number and canonical Markdown');
select throws_ok(
  $$select public.create_note('b-log-unsafe-structured', 'log', 'B Unsafe Structured Number', E'## 2026-08-30T12:00:00.000Z\n\n- value: 9007199254740993', null, 'ai_assisted', '{"schemaVersion":1,"entries":[{"id":"ent_0000000000000000000000000E","occurredAt":"2026-08-30T12:00:00.000Z","fields":{"value":9007199254740993}}]}'::jsonb)$$,
  'P0001', 'structure_conflict', 'direct structured input rejects a number that is not JSON-double round-trippable'
);
select is(
  public.create_note(
    'b-log-number-extrema', 'log', 'B Log Number Extrema',
    E'## 2026-08-30T13:00:00.000Z\n\n- large: 1000000000000000000000\n- min: ' || ('0.' || repeat('0', 323) || '5') || E'\n- small: 0.0000001',
    null, 'ai_assisted',
    jsonb_build_object('schemaVersion', 1, 'entries', jsonb_build_array(jsonb_build_object(
      'id', 'ent_0000000000000000000000000F', 'occurredAt', '2026-08-30T13:00:00.000Z',
      'fields', jsonb_build_object(
        'large', '1000000000000000000000'::jsonb,
        'min', (('0.' || repeat('0', 323) || '5')::jsonb),
        'small', '0.0000001'::jsonb
      )
    )))
  ) ->> 'replayed',
  'false', 'large, small, and minimum-double decimal fixtures are created'
);
create temporary table b_log_number_extrema_before as
select structured_data, body_markdown from public.notes where title = 'B Log Number Extrema';
select ok((select body_markdown !~ '[0-9][eE][+-]?[0-9]' and body_markdown like '%1000000000000000000000%' and body_markdown like '%0.0000001%' from b_log_number_extrema_before), 'canonical log renderer emits plain decimal without exponent notation');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Log Number Extrema'), 1, jsonb_build_array(jsonb_build_object('type', 'replace_body_markdown', 'bodyMarkdown', (select body_markdown from b_log_number_extrema_before))), 'b-log-extrema-roundtrip') -> 'note' ->> 'currentRevision', '2', 'plain-decimal extrema round-trip');
select is((select structured_data from public.notes where title = 'B Log Number Extrema'), (select structured_data from b_log_number_extrema_before), 'numeric extrema retain canonical structured values');

-- A completed receipt replays before stale validation after unrelated revisions advance.
select is(public.create_note('b-old-key-create', 'generic', 'B Old Key Replay', 'one') ->> 'replayed', 'false', 'old-key replay fixture is created');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Old Key Replay'), 1, '[{"type":"set_title","title":"B Replay First"}]'::jsonb, 'b-old-key-first') -> 'note' ->> 'currentRevision', '2', 'first mutation creates revision 2');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Replay First'), 2, '[{"type":"set_title","title":"B Replay Second"}]'::jsonb, 'b-old-key-second') -> 'note' ->> 'currentRevision', '3', 'intervening mutation creates revision 3');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Replay Second'), 1, '[{"type":"set_title","title":"B Replay First"}]'::jsonb, 'b-old-key-first') ->> 'replayed', 'true', 'old key returns its stored receipt before stale validation');
select is((select current_revision::text || ':' || title from public.notes where title = 'B Replay Second'), '3:B Replay Second', 'old-key replay does not overwrite newer content');
select is((select count(*) from public.note_revisions where note_id = (select id from public.notes where title = 'B Replay Second')), 3::bigint, 'old-key replay appends no revision');

select * from finish();
rollback;
