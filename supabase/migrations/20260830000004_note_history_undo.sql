-- Milestone B immutable history restore and immediate interactive undo.
-- Depends on the manual note functions in migration 20260830000003.

create or replace function public.undo_user_mutation(
  p_mutation_id text,
  p_expected_revision integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  original_mutation public.note_mutations%rowtype;
  note_row public.notes%rowtype;
  current_snapshot jsonb;
  inverse_snapshot jsonb;
  undo_mutation_id text := public.new_entity_id('mut');
  revision_id text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'undo_user_mutation',
    jsonb_build_object(
      'mutationId', p_mutation_id,
      'expectedRevision', p_expected_revision
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;

  select * into original_mutation
  from public.note_mutations
  where id = p_mutation_id and user_id = owner_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into note_row
  from public.notes
  where id = original_mutation.note_id and user_id = owner_id
  for update;
  if note_row.current_revision <> p_expected_revision
    or note_row.current_revision <> original_mutation.after_revision
    or original_mutation.undone_at is not null
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  current_snapshot := private.note_snapshot_with_relations(note_row);
  inverse_snapshot := original_mutation.inverse;
  if original_mutation.before_revision = 0 then
    inverse_snapshot := jsonb_set(
      inverse_snapshot,
      '{deletedAt}',
      to_jsonb(clock_timestamp()),
      true
    );
  end if;
  update public.notes
  set
    space_id = nullif(inverse_snapshot ->> 'spaceId', ''),
    type = (inverse_snapshot ->> 'type')::public.note_type,
    title = inverse_snapshot ->> 'title',
    body_markdown = inverse_snapshot ->> 'bodyMarkdown',
    structured_data = inverse_snapshot -> 'structuredData',
    daily_date = (inverse_snapshot ->> 'dailyDate')::date,
    is_open = (inverse_snapshot ->> 'isOpen')::boolean,
    pinned_at = (inverse_snapshot ->> 'pinnedAt')::timestamptz,
    privacy = (inverse_snapshot ->> 'privacy')::public.privacy_mode,
    archived_at = (inverse_snapshot ->> 'archivedAt')::timestamptz,
    deleted_at = (inverse_snapshot ->> 'deletedAt')::timestamptz,
    current_revision = current_revision + 1
  where id = note_row.id
  returning * into note_row;

  insert into public.note_mutations (
    id, user_id, note_id, idempotency_key, before_revision, after_revision,
    operations, inverse
  )
  values (
    undo_mutation_id,
    owner_id,
    note_row.id,
    p_idempotency_key,
    p_expected_revision,
    note_row.current_revision,
    jsonb_build_array(jsonb_build_object('type', 'undo', 'mutationId', p_mutation_id)),
    current_snapshot
  );
  perform private.restore_note_relations(
    owner_id,
    note_row.id,
    inverse_snapshot,
    undo_mutation_id
  );
  update public.note_mutations set undone_at = now()
  where id = original_mutation.id;

  revision_id := private.insert_note_revision(
    note_row,
    'undo',
    'undo:' || original_mutation.id,
    undo_mutation_id
  );
  perform private.emit_user_event(owner_id, 'note', note_row.id);
  perform private.emit_user_event(owner_id, 'note_revision', revision_id);
  perform private.emit_user_event(owner_id, 'note_mutation', undo_mutation_id);

  response_value := jsonb_build_object(
    'note', private.note_contract_json(note_row),
    'revision', (
      select private.revision_json(revision_row)
      from public.note_revisions as revision_row
      where revision_row.id = revision_id
    ),
    'mutationId', undo_mutation_id,
    'undo', jsonb_build_object('eligible', true, 'expiresAt', null),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.restore_note_revision(
  p_note_id text,
  p_revision_id text,
  p_expected_revision integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  claim jsonb;
  note_row public.notes%rowtype;
  source_revision public.note_revisions%rowtype;
  before_snapshot jsonb;
  mutation_id text := public.new_entity_id('mut');
  revision_id text;
  response_value jsonb;
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  claim := private.claim_idempotency(
    owner_id,
    p_idempotency_key,
    'restore_note_revision',
    jsonb_build_object(
      'noteId', p_note_id,
      'revisionId', p_revision_id,
      'expectedRevision', p_expected_revision
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;

  select * into note_row from public.notes
  where id = p_note_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if note_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into source_revision from public.note_revisions
  where id = p_revision_id
    and note_id = p_note_id
    and user_id = owner_id
  ;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  before_snapshot := private.note_snapshot_with_relations(note_row);
  update public.notes
  set
    space_id = source_revision.space_id,
    type = source_revision.type,
    title = source_revision.title,
    body_markdown = source_revision.body_markdown,
    structured_data = source_revision.structured_data,
    is_open = source_revision.is_open,
    pinned_at = source_revision.pinned_at,
    privacy = source_revision.privacy,
    archived_at = source_revision.archived_at,
    deleted_at = source_revision.deleted_at,
    current_revision = current_revision + 1
  where id = note_row.id
  returning * into note_row;

  insert into public.note_mutations (
    id, user_id, note_id, idempotency_key, before_revision, after_revision,
    operations, inverse
  )
  values (
    mutation_id,
    owner_id,
    note_row.id,
    p_idempotency_key,
    p_expected_revision,
    note_row.current_revision,
    jsonb_build_array(jsonb_build_object('type', 'restore_snapshot', 'revisionId', p_revision_id)),
    before_snapshot
  );
  perform private.restore_note_relations(
    owner_id,
    note_row.id,
    jsonb_build_object(
      'tagIds', source_revision.tag_ids,
      'links', source_revision.links
    ),
    mutation_id
  );
  revision_id := private.insert_note_revision(
    note_row,
    'manual',
    'user:restore-revision',
    mutation_id
  );
  perform private.emit_user_event(owner_id, 'note', note_row.id);
  perform private.emit_user_event(owner_id, 'note_revision', revision_id);
  perform private.emit_user_event(owner_id, 'note_mutation', mutation_id);

  response_value := jsonb_build_object(
    'note', private.note_contract_json(note_row),
    'revision', (
      select private.revision_json(revision_row)
      from public.note_revisions as revision_row
      where revision_row.id = revision_id
    ),
    'mutationId', mutation_id,
    'undo', jsonb_build_object('eligible', true, 'expiresAt', null),
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

create or replace function public.restore_note(
  p_note_id text,
  p_expected_revision integer,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.apply_user_note_mutation(
    p_note_id,
    p_expected_revision,
    jsonb_build_array(jsonb_build_object('type', 'set_deleted', 'deletedAt', null)),
    p_idempotency_key
  );
$$;

revoke execute on function public.create_note(
  text, public.note_type, text, text, text, public.privacy_mode, jsonb, jsonb, jsonb
) from public, anon;
revoke execute on function public.apply_user_note_mutation(
  text, integer, jsonb, text
) from public, anon;
revoke execute on function public.undo_user_mutation(text, integer, text)
  from public, anon;
revoke execute on function public.restore_note_revision(text, text, integer, text)
  from public, anon;
revoke execute on function public.restore_note(text, integer, text)
  from public, anon;

grant execute on function public.create_note(
  text, public.note_type, text, text, text, public.privacy_mode, jsonb, jsonb, jsonb
) to authenticated, service_role;
grant execute on function public.apply_user_note_mutation(
  text, integer, jsonb, text
) to authenticated, service_role;
grant execute on function public.undo_user_mutation(text, integer, text)
  to authenticated, service_role;
grant execute on function public.restore_note_revision(text, text, integer, text)
  to authenticated, service_role;
grant execute on function public.restore_note(text, integer, text)
  to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
