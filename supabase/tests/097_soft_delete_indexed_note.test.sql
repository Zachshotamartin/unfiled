create extension if not exists pgtap with schema extensions;
begin;
set local search_path = public, extensions;
select no_plan();

-- A soft-deleted AI-assisted note must not enqueue a search-index job: the job target trigger
-- refuses deleted notes, and before this fix the refusal rolled the whole mutation back, so the
-- owner saw "The note could not be deleted" for any note the index already held.

insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  envelope_schema_version, state, expected_note_count, indexed_note_count,
  revision_token, activated_at
) values (
  'igen_97000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'text-embedding-3-small', 1536, 1, 'active', 1, 0, 1,
  '2026-09-03 07:00:00+00'
);

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, created_at, updated_at
) values (
  'note_97000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'spc_00000000000000000000000001', 'generic',
  'indexed note fixture', 'encrypted body fixture', '{}',
  1, 'ai_assisted', now(), now()
);

select is(
  private.enqueue_encrypted_note_index_jobs(
    '11111111-1111-4111-8111-111111111111',
    'note_97000000000000000000000001', 1, 'ai_assisted', true
  ),
  1,
  'a live AI-assisted note enqueues one index job per active generation'
);

update public.notes
set deleted_at = now(), current_revision = 2, updated_at = now()
where id = 'note_97000000000000000000000001';

select lives_ok(
  $$select private.enqueue_encrypted_note_index_jobs(
    '11111111-1111-4111-8111-111111111111',
    'note_97000000000000000000000001', 2, 'ai_assisted', false
  )$$,
  'enqueueing for a soft-deleted note never raises, so the delete mutation commits'
);

select is(
  private.enqueue_encrypted_note_index_jobs(
    '11111111-1111-4111-8111-111111111111',
    'note_97000000000000000000000001', 2, 'ai_assisted', false
  ),
  0,
  'a soft-deleted note enqueues no index job'
);

select is(
  (select count(*)::integer from public.note_index_jobs
   where note_id = 'note_97000000000000000000000001' and target_revision = 2),
  0,
  'no job row exists for the deleted revision'
);

update public.notes
set deleted_at = null, current_revision = 3, updated_at = now()
where id = 'note_97000000000000000000000001';

select is(
  private.enqueue_encrypted_note_index_jobs(
    '11111111-1111-4111-8111-111111111111',
    'note_97000000000000000000000001', 3, 'ai_assisted', false
  ),
  1,
  'restoring the note enqueues its index job again'
);

select * from finish();
rollback;
