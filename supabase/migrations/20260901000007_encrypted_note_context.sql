-- Milestone F: owner-authorized source inspection and backlink hydration.
--
-- These projections intentionally return encrypted aggregate fields plus the
-- minimum relationship metadata needed by the web trust boundary. Plaintext
-- is opened only inside the request-scoped web key-custody callback.

create or replace function public.list_encrypted_note_sources(
  p_owner_id uuid,
  p_note_id text,
  p_expected_note_revision integer default null,
  p_after_created_at timestamptz default null,
  p_after_capture_id text default null,
  p_after_mutation_id text default null,
  p_limit integer default 31
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  note_row public.notes%rowtype;
  items_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_limit not between 1 and 101
    or (p_expected_note_revision is not null and p_expected_note_revision < 1)
    or num_nonnulls(
      p_after_created_at, p_after_capture_id, p_after_mutation_id
    ) not in (0, 3)
    or (
      p_after_created_at is not null
      and (
        p_after_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
        or p_after_mutation_id !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
      )
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into note_row
  from public.notes as note
  where note.user_id = p_owner_id
    and note.id = p_note_id
    and note.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if p_expected_note_revision is not null
    and note_row.current_revision <> p_expected_note_revision
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'captureId', bounded.capture_id,
    'mutationId', bounded.mutation_id,
    'relation', bounded.relation,
    'insertedItemIds', to_jsonb(bounded.inserted_item_ids),
    'createdAt', bounded.created_at,
    'source', bounded.source,
    'clientCreatedAt', bounded.client_created_at,
    'contentLength', bounded.content_length,
    'privacy', bounded.privacy,
    'contentCipher', private.encrypted_cipher_projection(
      bounded.content_envelope, bounded.content_key_id,
      bounded.content_key_class, bounded.content_key_purpose,
      bounded.content_key_version
    ),
    'contentMac', private.encrypted_mac_projection(
      bounded.content_fingerprint, bounded.fingerprint_key_id,
      bounded.fingerprint_key_class, bounded.fingerprint_key_purpose,
      bounded.fingerprint_key_version
    )
  ) order by bounded.created_at desc, bounded.capture_id desc,
      bounded.mutation_id desc), '[]'::jsonb)
  into items_value
  from (
    select
      relation.capture_id,
      relation.mutation_id,
      relation.relation,
      relation.inserted_item_ids,
      relation.created_at,
      capture.source,
      capture.client_created_at,
      capture.content_length,
      capture.privacy,
      capture.content_envelope,
      capture.content_key_id,
      capture.content_key_class,
      capture.content_key_purpose,
      capture.content_key_version,
      capture.content_fingerprint,
      capture.fingerprint_key_id,
      capture.fingerprint_key_class,
      capture.fingerprint_key_purpose,
      capture.fingerprint_key_version
    from public.capture_note_links as relation
    join public.captures as capture
      on capture.user_id = relation.user_id
      and capture.id = relation.capture_id
    where relation.user_id = p_owner_id
      and relation.note_id = p_note_id
      and capture.deleted_at is null
      and capture.status <> 'deleted'
      and capture.content_envelope is not null
      and capture.content_fingerprint is not null
      and (
        p_after_created_at is null
        or (relation.created_at, relation.capture_id, relation.mutation_id)
          < (p_after_created_at, p_after_capture_id, p_after_mutation_id)
      )
    order by relation.created_at desc, relation.capture_id desc,
      relation.mutation_id desc
    limit p_limit
  ) as bounded;

  return jsonb_build_object(
    'noteId', note_row.id,
    'currentRevision', note_row.current_revision,
    'items', items_value
  );
end;
$$;

create or replace function public.list_encrypted_note_backlinks(
  p_owner_id uuid,
  p_note_id text,
  p_expected_note_revision integer default null,
  p_after_created_at timestamptz default null,
  p_after_link_id text default null,
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  note_row public.notes%rowtype;
  items_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_limit not between 1 and 5
    or (p_expected_note_revision is not null and p_expected_note_revision < 1)
    or num_nonnulls(p_after_created_at, p_after_link_id) not in (0, 2)
    or (
      p_after_created_at is not null
      and p_after_link_id !~ '^lnk_[0-9A-HJKMNP-TV-Z]{26}$'
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into note_row
  from public.notes as note
  where note.user_id = p_owner_id
    and note.id = p_note_id
    and note.deleted_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if p_expected_note_revision is not null
    and note_row.current_revision <> p_expected_note_revision
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'linkId', bounded.link_id,
    'fromNoteId', bounded.from_note_id,
    'fromNoteRevision', bounded.current_revision,
    'linkType', bounded.link_type,
    'createdAt', bounded.created_at,
    'fromPrivacy', bounded.privacy,
    'fromContentCipher', private.encrypted_cipher_projection(
      bounded.content_envelope, bounded.content_key_id,
      bounded.content_key_class, bounded.content_key_purpose,
      bounded.content_key_version
    )
  ) order by bounded.created_at desc, bounded.link_id desc), '[]'::jsonb)
  into items_value
  from (
    select
      relation.id as link_id,
      relation.from_note_id,
      relation.link_type,
      relation.created_at,
      source_note.current_revision,
      source_note.privacy,
      source_note.content_envelope,
      source_note.content_key_id,
      source_note.content_key_class,
      source_note.content_key_purpose,
      source_note.content_key_version
    from public.note_links as relation
    join public.notes as source_note
      on source_note.user_id = relation.user_id
      and source_note.id = relation.from_note_id
    where relation.user_id = p_owner_id
      and relation.to_note_id = p_note_id
      and source_note.deleted_at is null
      and source_note.content_envelope is not null
      and (
        p_after_created_at is null
        or (relation.created_at, relation.id)
          < (p_after_created_at, p_after_link_id)
      )
    order by relation.created_at desc, relation.id desc
    limit p_limit
  ) as bounded;

  return jsonb_build_object(
    'noteId', note_row.id,
    'currentRevision', note_row.current_revision,
    'items', items_value
  );
end;
$$;

-- An owner can legitimately route, remove, and later reroute one capture to
-- the same note. The export manifest describes source captures, not the
-- relationship-event history, so emit each capture ID exactly once while
-- retaining canonical ordering. The application adapter keeps independently
-- rejecting duplicates as a fail-closed projection check.
do $deduplicate_export_note_sources$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.list_encrypted_export_note_sources(uuid,jsonb)'::regprocedure
  );
  old_fragment constant text :=
    'select jsonb_agg(link.capture_id order by link.capture_id)';
  new_fragment constant text :=
    'select jsonb_agg(distinct link.capture_id order by link.capture_id)';
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, old_fragment, ''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'encrypted_export_note_sources_projection_drift';
  end if;
  execute pg_catalog.replace(definition, old_fragment, new_fragment);
end;
$deduplicate_export_note_sources$;

revoke execute on function public.list_encrypted_note_sources(
  uuid, text, integer, timestamptz, text, text, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
grant execute on function public.list_encrypted_note_sources(
  uuid, text, integer, timestamptz, text, text, integer
) to service_role;

revoke execute on function public.list_encrypted_note_backlinks(
  uuid, text, integer, timestamptz, text, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
grant execute on function public.list_encrypted_note_backlinks(
  uuid, text, integer, timestamptz, text, integer
) to service_role;
