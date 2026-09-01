-- Milestone D: lease-bound encrypted RAG retrieval for the organizer.
--
-- The index worker already owns the reviewed exact-scan implementation.  The
-- organizer receives two narrower entry points around it:
--
--   1. page the active encrypted index only while an organization lease is
--      live; and
--   2. exchange at most eight exact active-generation matches for the full
--      encrypted note aggregates required by the planner/cipher.
--
-- Neither function accepts an owner identifier from the caller.  The owner is
-- derived from the locked job lease, so the organizer cannot use this surface
-- to enumerate another tenant by guessing a UUID.

do $$
declare
  function_definition text;
  occurrence_count integer;
  old_guard constant text := $old$if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then$old$;
  new_guard constant text := $new$if auth.role() is distinct from 'service_role'
    and session_user not in ('unfiled_index_worker', 'unfiled_organizer_worker')
  then$new$;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'list_active_note_rag_index'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      = 'p_owner_id uuid, p_cursor jsonb, p_limit integer, p_ciphertext_byte_budget integer';

  occurrence_count := case
    when function_definition is null then 0
    else (
      pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(
        pg_catalog.replace(function_definition, old_guard, '')
      )
    ) / pg_catalog.char_length(old_guard)
  end;
  if occurrence_count <> 1
  then
    raise exception using errcode = 'P0001',
      message = 'organizer_rag_guard_definition_mismatch';
  end if;

  execute pg_catalog.replace(function_definition, old_guard, new_guard);
end;
$$;

-- The cipher must use a database-owned timestamp on every replay and must know
-- whether the relational projection still carries compatibility plaintext or
-- requires the encrypted-only sentinel. Add those content-free facts to the
-- existing claim without widening its arguments or owner scope.
do $$
declare
  function_definition text;
  old_projection constant text := $old$'leaseExpiresAt', job_row.lease_expires_at,
      'promptVersion', job_row.prompt_version,$old$;
  new_projection constant text := $new$'leaseExpiresAt', job_row.lease_expires_at,
      'occurredAt', capture_row.client_created_at,
      'clientTimezone', capture_row.client_timezone,
      'accountCaptureOrdinal', (
        select count(*)::integer
        from public.captures as ordinal_capture
        where ordinal_capture.user_id = job_row.user_id
          and row(ordinal_capture.received_at, ordinal_capture.id)
            <= row(capture_row.received_at, capture_row.id)
      ),
      'routingMode', coalesce((
        select profile.org_mode
        from public.profiles as profile
        where profile.id = job_row.user_id
      ), 'balanced'::public.org_mode),
      'commandProjection', coalesce((
        select case
          when rollout.plaintext_scrub_id is not null
            or rollout.state in ('encrypted_only', 'contracted')
          then 'encrypted_only'
          else 'legacy'
        end
        from public.content_encryption_rollouts as rollout
        where rollout.user_id = job_row.user_id
      ), 'legacy'),
      'promptVersion', job_row.prompt_version,$new$;
  occurrence_count integer;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'private'
    and procedure.proname = 'claim_encrypted_organizer_jobs_impl'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      = 'p_worker_id text, p_claim_limit integer, p_lease_seconds integer';

  occurrence_count := case
    when function_definition is null then 0
    else (
      pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(
        pg_catalog.replace(function_definition, old_projection, '')
      )
    ) / pg_catalog.char_length(old_projection)
  end;
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_projection_definition_mismatch';
  end if;
  execute pg_catalog.replace(
    function_definition, old_projection, new_projection
  );
end;
$$;

-- Captures are context-MAC protected, unlike ordinary note-content and RAG
-- records.  The claim must therefore project both the MAC and its independently
-- scoped content-MAC key record; ciphertext alone can never authenticate the
-- source capture.  Extend the existing function in place so its reviewed
-- owner/lease/locking behavior remains unchanged.
do $$
declare
  function_definition text;
  old_declaration constant text := $old$source_key public.user_content_keys%rowtype;
  jobs_value jsonb := '[]'::jsonb;$old$;
  new_declaration constant text := $new$source_key public.user_content_keys%rowtype;
  source_mac_key public.user_content_keys%rowtype;
  jobs_value jsonb := '[]'::jsonb;$new$;
  old_key_lookup constant text := $old$for share of content_key;
    if not found then continue; end if;

    update public.organization_jobs$old$;
  new_key_lookup constant text := $new$for share of content_key;
    if not found then continue; end if;

    select * into source_mac_key
    from public.user_content_keys as content_key
    where content_key.user_id = capture_row.user_id
      and content_key.key_id = capture_row.fingerprint_key_id
      and content_key.key_class = 'ai_assisted'
      and content_key.key_purpose = 'content_mac'
      and content_key.key_version = capture_row.fingerprint_key_version
      and content_key.state in ('active', 'retired')
    for share of content_key;
    if not found then continue; end if;

    update public.organization_jobs$new$;
  old_source constant text := $old$'keyRecord', private.organizer_key_projection(source_key),
        'encryptedByteLength', payload_bytes$old$;
  new_source constant text := $new$'keyRecord', private.organizer_key_projection(source_key),
        'contentMac', private.encrypted_mac_projection(
          capture_row.content_fingerprint, capture_row.fingerprint_key_id,
          capture_row.fingerprint_key_class, capture_row.fingerprint_key_purpose,
          capture_row.fingerprint_key_version
        ),
        'contentMacKeyRecord', private.organizer_key_projection(source_mac_key),
        'encryptedByteLength', payload_bytes$new$;
  occurrence_count integer;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'private'
    and procedure.proname = 'claim_encrypted_organizer_jobs_impl'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      = 'p_worker_id text, p_claim_limit integer, p_lease_seconds integer';

  occurrence_count := case when function_definition is null then 0 else (
    pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(pg_catalog.replace(function_definition, old_declaration, ''))
  ) / pg_catalog.char_length(old_declaration) end;
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_mac_declaration_mismatch';
  end if;
  function_definition := pg_catalog.replace(
    function_definition, old_declaration, new_declaration
  );

  occurrence_count := (
    pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(pg_catalog.replace(function_definition, old_key_lookup, ''))
  ) / pg_catalog.char_length(old_key_lookup);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_mac_key_lookup_mismatch';
  end if;
  function_definition := pg_catalog.replace(
    function_definition, old_key_lookup, new_key_lookup
  );

  occurrence_count := (
    pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(pg_catalog.replace(function_definition, old_source, ''))
  ) / pg_catalog.char_length(old_source);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_mac_projection_mismatch';
  end if;
  execute pg_catalog.replace(function_definition, old_source, new_source);
end;
$$;

-- The explicit-destination/degraded fallback uses the original bounded
-- candidate RPC.  It can never drop relational note state when the cipher
-- later builds an append snapshot, so widen only that encrypted projection to
-- the same complete metadata shape as the exact RAG exchange.
do $$
declare
  function_definition text;
  old_columns constant text := $old$note.space_id,
      note.is_open,
      note.updated_at,
      note.content_envelope,$old$;
  new_columns constant text := $new$note.space_id,
      note.daily_date,
      note.is_open,
      note.pinned_at,
      note.archived_at,
      note.deleted_at,
      note.updated_at,
      coalesce((
        select jsonb_agg(note_tag.tag_id order by note_tag.tag_id)
        from public.note_tags as note_tag
        where note_tag.user_id = note.user_id
          and note_tag.note_id = note.id
      ), '[]'::jsonb) as tag_ids,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'toNoteId', note_link.to_note_id,
          'linkType', note_link.link_type
        ) order by note_link.to_note_id, note_link.link_type)
        from public.note_links as note_link
        where note_link.user_id = note.user_id
          and note_link.from_note_id = note.id
      ), '[]'::jsonb) as links,
      note.content_envelope,$new$;
  old_metadata constant text := $old$'metadata', jsonb_build_object(
        'spaceId', bounded.space_id,
        'updatedAt', bounded.updated_at,
        'isOpen', bounded.is_open
      ),$old$;
  new_metadata constant text := $new$'metadata', jsonb_build_object(
        'spaceId', bounded.space_id,
        'dailyDate', bounded.daily_date,
        'updatedAt', bounded.updated_at,
        'isOpen', bounded.is_open,
        'pinnedAt', bounded.pinned_at,
        'archivedAt', bounded.archived_at,
        'deletedAt', bounded.deleted_at,
        'tagIds', bounded.tag_ids,
        'links', bounded.links
      ),$new$;
  occurrence_count integer;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'private'
    and procedure.proname = 'list_encrypted_organizer_candidates_impl'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
      = 'p_job_id text, p_lease_token text, p_candidate_limit integer';

  occurrence_count := case when function_definition is null then 0 else (
    pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(pg_catalog.replace(function_definition, old_columns, ''))
  ) / pg_catalog.char_length(old_columns) end;
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_candidate_columns_definition_mismatch';
  end if;
  function_definition := pg_catalog.replace(
    function_definition, old_columns, new_columns
  );

  occurrence_count := (
    pg_catalog.char_length(function_definition)
      - pg_catalog.char_length(pg_catalog.replace(function_definition, old_metadata, ''))
  ) / pg_catalog.char_length(old_metadata);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_candidate_metadata_definition_mismatch';
  end if;
  execute pg_catalog.replace(
    function_definition, old_metadata, new_metadata
  );
end;
$$;

create function private.list_encrypted_organizer_rag_page_impl(
  p_job_id text,
  p_lease_token text,
  p_cursor jsonb default null,
  p_limit integer default 50,
  p_ciphertext_byte_budget integer default 2097152
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  page_value jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50
    or p_ciphertext_byte_budget is null
    or p_ciphertext_byte_budget not between 262160 and 8388608
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  page_value := public.list_active_note_rag_index(
    job_row.user_id, p_cursor, p_limit, p_ciphertext_byte_budget
  );
  if page_value ->> 'ownerId' is distinct from job_row.user_id::text then
    raise exception using errcode = 'P0001', message = 'invalid_projection';
  end if;
  return jsonb_build_object(
    'jobId', job_row.id,
    'result', page_value
  );
end;
$$;

create function public.list_encrypted_organizer_rag_page(
  p_job_id text,
  p_lease_token text,
  p_cursor jsonb default null,
  p_limit integer default 50,
  p_ciphertext_byte_budget integer default 2097152
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_organizer_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.list_encrypted_organizer_rag_page_impl(
    p_job_id, p_lease_token, p_cursor, p_limit, p_ciphertext_byte_budget
  );
end;
$$;

create function private.select_encrypted_organizer_candidates_impl(
  p_job_id text,
  p_lease_token text,
  p_selection jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  generation_row public.rag_index_generations%rowtype;
  controls_value jsonb;
  candidates_value jsonb := '[]'::jsonb;
  candidate_manifest_value jsonb := '[]'::jsonb;
  returned_count integer := 0;
  returned_bytes integer := 0;
  byte_budget constant integer := 8388608;
  eligible_count integer;
begin
  if p_selection is null
    or jsonb_typeof(p_selection) <> 'object'
    or not private.jsonb_has_exact_keys(
      p_selection, array['generationId', 'revisionToken', 'candidates']
    )
    or jsonb_typeof(p_selection -> 'generationId') <> 'string'
    or p_selection ->> 'generationId'
      !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or jsonb_typeof(p_selection -> 'revisionToken') <> 'number'
    or p_selection ->> 'revisionToken' !~ '^[0-9]{1,19}$'
    or jsonb_typeof(p_selection -> 'candidates') <> 'array'
    or jsonb_array_length(p_selection -> 'candidates') not between 1 and 8
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_selection -> 'candidates') as selected(value)
    where jsonb_typeof(selected.value) <> 'object'
      or not private.jsonb_has_exact_keys(
        selected.value, array['noteId', 'indexedRevision']
      )
      or jsonb_typeof(selected.value -> 'noteId') <> 'string'
      or selected.value ->> 'noteId'
        !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or jsonb_typeof(selected.value -> 'indexedRevision') <> 'number'
      or selected.value ->> 'indexedRevision' !~ '^[1-9][0-9]{0,18}$'
  ) or exists (
    select 1
    from jsonb_array_elements(p_selection -> 'candidates') as selected(value)
    group by selected.value ->> 'noteId'
    having count(*) <> 1
  ) then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into generation_row
  from public.rag_index_generations as generation
  where generation.user_id = job_row.user_id
    and generation.id = p_selection ->> 'generationId'
    and generation.state = 'active'
    and generation.revision_token
      = (p_selection ->> 'revisionToken')::bigint
  for share of generation;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_rag_snapshot';
  end if;

  select count(*)::integer into eligible_count
  from public.notes as note
  where note.user_id = job_row.user_id
    and note.privacy = 'ai_assisted'
    and note.deleted_at is null;

  if generation_row.expected_note_count <> eligible_count
    or generation_row.indexed_note_count <> eligible_count
    or exists (
      select 1
      from public.note_index_jobs as index_job
      where index_job.user_id = job_row.user_id
        and index_job.generation_id = generation_row.id
        and index_job.state in ('queued', 'leased')
    )
    or not exists (
      select 1
      from public.rag_index_generation_verifications as verification
      where verification.user_id = job_row.user_id
        and verification.generation_id = generation_row.id
        and verification.revision_token = generation_row.revision_token
        and verification.verified_note_count = eligible_count
        and verification.attestation_domain
          = 'unfiled.rag-generation-attestation.v1'
        and verification.attestation_digest
          = private.request_hash(verification.attestation)
        and verification.attestation ->> 'ownerId' = job_row.user_id::text
        and verification.attestation ->> 'generationId' = generation_row.id
        and verification.attestation ->> 'embeddingModelId'
          = generation_row.embedding_model_id
        and (verification.attestation ->> 'embeddingDimensions')::integer
          = generation_row.embedding_dimensions
        and (verification.attestation ->> 'envelopeSchemaVersion')::integer
          = generation_row.envelope_schema_version
        and (verification.attestation ->> 'expectedNoteCount')::integer
          = eligible_count
        and (verification.attestation ->> 'indexedNoteCount')::integer
          = eligible_count
        and (verification.attestation ->> 'entryCount')::integer
          = eligible_count
    )
  then
    raise exception using errcode = 'P0001',
      message = 'incomplete_index_coverage';
  end if;

  with selected as (
    select
      selected.value ->> 'noteId' as note_id,
      (selected.value ->> 'indexedRevision')::integer as indexed_revision,
      selected.ordinality
    from jsonb_array_elements(p_selection -> 'candidates')
      with ordinality as selected(value, ordinality)
  ), eligible as (
    select
      note.id,
      note.current_revision,
      note.type,
      note.space_id,
      note.daily_date,
      note.is_open,
      note.pinned_at,
      note.archived_at,
      note.deleted_at,
      note.updated_at,
      note.content_envelope,
      pg_catalog.octet_length(note.content_envelope::text) as envelope_bytes,
      (
        pg_catalog.char_length(
          note.content_envelope -> 'payload' ->> 'ciphertext'
        ) * 3 / 4
      )::integer as payload_bytes,
      private.organizer_key_projection(content_key) as key_record,
      selected.ordinality,
      coalesce((
        select jsonb_agg(note_tag.tag_id order by note_tag.tag_id)
        from public.note_tags as note_tag
        where note_tag.user_id = note.user_id
          and note_tag.note_id = note.id
      ), '[]'::jsonb) as tag_ids,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'toNoteId', note_link.to_note_id,
          'linkType', note_link.link_type
        ) order by note_link.to_note_id, note_link.link_type)
        from public.note_links as note_link
        where note_link.user_id = note.user_id
          and note_link.from_note_id = note.id
      ), '[]'::jsonb) as links
    from selected
    join public.note_rag_index as index_row
      on index_row.user_id = job_row.user_id
      and index_row.generation_id = generation_row.id
      and index_row.note_id = selected.note_id
      and index_row.indexed_revision = selected.indexed_revision
    join public.notes as note
      on note.user_id = index_row.user_id
      and note.id = index_row.note_id
      and note.current_revision = index_row.indexed_revision
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and note.archived_at is null
      and note.content_envelope is not null
      and note.content_key_class = 'ai_assisted'
      and note.content_key_purpose = 'object_wrap'
    join public.user_content_keys as content_key
      on content_key.user_id = note.user_id
      and content_key.key_id = note.content_key_id
      and content_key.key_class = note.content_key_class
      and content_key.key_purpose = note.content_key_purpose
      and content_key.key_version = note.content_key_version
      and content_key.state in ('active', 'retired')
  ), bounded as (
    select *, sum(envelope_bytes) over (
      order by ordinality rows unbounded preceding
    ) as running_bytes
    from eligible
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'candidateId', bounded.id,
      'noteId', bounded.id,
      'revision', bounded.current_revision,
      'type', bounded.type,
      'metadata', jsonb_build_object(
        'spaceId', bounded.space_id,
        'dailyDate', bounded.daily_date,
        'updatedAt', bounded.updated_at,
        'isOpen', bounded.is_open,
        'pinnedAt', bounded.pinned_at,
        'archivedAt', bounded.archived_at,
        'deletedAt', bounded.deleted_at,
        'tagIds', bounded.tag_ids,
        'links', bounded.links
      ),
      'aggregate', jsonb_build_object(
        'resourceId', bounded.id,
        'recordVersion', bounded.current_revision,
        'envelope', bounded.content_envelope,
        'keyRecord', bounded.key_record,
        'encryptedByteLength', bounded.payload_bytes
      )
    ) order by bounded.ordinality), '[]'::jsonb),
    count(*)::integer,
    coalesce(sum(bounded.envelope_bytes), 0)::integer
  into candidates_value, returned_count, returned_bytes
  from bounded
  where bounded.running_bytes <= byte_budget;

  select jsonb_build_object(
    'explicitDestinationNoteId', capture.explicit_destination_note_id,
    'expansionDisabled', capture.expansion_disabled
  ) into controls_value
  from public.captures as capture
  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'candidateId', candidate ->> 'candidateId',
    'noteId', candidate ->> 'noteId',
    'revision', candidate -> 'revision',
    'isOpen', candidate -> 'metadata' -> 'isOpen'
  ) order by ordinal), '[]'::jsonb)
  into candidate_manifest_value
  from jsonb_array_elements(candidates_value)
    with ordinality as listed(candidate, ordinal);

  insert into public.encrypted_organizer_candidate_pages (
    job_id, user_id, attempt, lease_token, controls, candidate_manifest,
    conflict_result, listed_at, authorized_at, conflict_recorded_at
  ) values (
    job_row.id, job_row.user_id, job_row.attempt, job_row.lease_token,
    controls_value, candidate_manifest_value, null, clock_timestamp(), null, null
  )
  on conflict (job_id) do update set
    user_id = excluded.user_id,
    attempt = excluded.attempt,
    lease_token = excluded.lease_token,
    controls = excluded.controls,
    candidate_manifest = excluded.candidate_manifest,
    conflict_result = null,
    listed_at = excluded.listed_at,
    authorized_at = null,
    conflict_recorded_at = null;

  return jsonb_build_object(
    'jobId', job_row.id,
    'generationId', generation_row.id,
    'revisionToken', generation_row.revision_token,
    'controls', controls_value,
    'candidates', candidates_value,
    'returnedCount', returned_count,
    'encryptedBytes', returned_bytes,
    'encryptedByteBudget', byte_budget
  );
end;
$$;

create function public.select_encrypted_organizer_candidates(
  p_job_id text,
  p_lease_token text,
  p_selection jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_organizer_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.select_encrypted_organizer_candidates_impl(
    p_job_id, p_lease_token, p_selection
  );
end;
$$;

revoke execute on function public.list_encrypted_organizer_rag_page(
  text, text, jsonb, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.select_encrypted_organizer_candidates(
  text, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function private.select_encrypted_organizer_candidates_impl(
  text, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.list_encrypted_organizer_rag_page_impl(
  text, text, jsonb, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

grant execute on function public.list_encrypted_organizer_rag_page(
  text, text, jsonb, integer, integer
) to unfiled_organizer_worker;
grant execute on function public.select_encrypted_organizer_candidates(
  text, text, jsonb
) to unfiled_organizer_worker;
