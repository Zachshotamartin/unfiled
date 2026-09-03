-- Soft-deleting an AI-assisted note that already had a search-index generation failed outright:
-- apply_encrypted_note_mutation updates the note row (deleted_at set) and then enqueues an index
-- job for the new revision, and note_index_jobs_enforce_target refuses a job whose note is
-- deleted, which rolled the whole mutation back as validation_failed. The worker already retires
-- jobs for deleted notes, so the enqueue helper now skips them. Restoring the note (deleted_at
-- back to null) enqueues again as before.
create or replace function private.enqueue_encrypted_note_index_jobs(
  owner_id uuid,
  note_id_value text,
  revision_value integer,
  privacy_value public.privacy_mode,
  is_new_note boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if privacy_value <> 'ai_assisted' then
    return 0;
  end if;
  if exists (
    select 1
    from public.notes as note
    where note.id = note_id_value
      and note.user_id = owner_id
      and note.deleted_at is not null
  ) then
    return 0;
  end if;
  if is_new_note then
    update public.rag_index_generations
    set
      expected_note_count = expected_note_count + 1,
      revision_token = revision_token + 1
    where user_id = owner_id and state in ('building', 'active');
  end if;
  insert into public.note_index_jobs (
    user_id, note_id, generation_id, target_revision, index_resource_id
  )
  select
    owner_id,
    note_id_value,
    generation.id,
    revision_value,
    private.stable_note_rag_resource_id(
      owner_id, note_id_value, generation.id
    )
  from public.rag_index_generations as generation
  where generation.user_id = owner_id
    and generation.state in ('building', 'active')
  on conflict (note_id, generation_id, target_revision) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke execute on function private.enqueue_encrypted_note_index_jobs(
  uuid, text, integer, public.privacy_mode, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker;
