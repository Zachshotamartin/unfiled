-- Keep the encrypted note-index queue live when its oldest rows can no longer
-- be processed. Each claim examines a fixed, bounded page, terminalizes
-- permanent eligibility failures, and rotates transient resource pressure to
-- the back of the due queue. Repeated drains therefore advance past arbitrarily
-- deep poisoned prefixes without making any one database transaction unbounded.

create or replace function public.claim_note_index_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  note_row public.notes%rowtype;
  job_row public.note_index_jobs%rowtype;
  generation_row public.rag_index_generations%rowtype;
  source_key_row public.user_content_keys%rowtype;
  target_key_row public.user_content_keys%rowtype;
  source_key_state_value public.content_key_state;
  source_key_exists boolean;
  generation_is_eligible boolean;
  terminal_error public.safe_error_code;
  reservation_value uuid;
  lease_token_value uuid;
  source_envelope_bytes integer;
  claimed_count integer := 0;
  claimed_source_bytes integer := 0;
  source_byte_budget constant integer := 8388608;
  candidate_scan_limit constant integer := 500;
  jobs_value jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_worker_id is null
    or char_length(p_worker_id) not between 1 and 120
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for candidate in
    select job.id, job.user_id, job.note_id
    from public.note_index_jobs as job
    where job.state = 'queued'
      and job.available_at <= now()
      and job.attempt < 5
    order by job.available_at, job.created_at, job.id
    limit candidate_scan_limit
  loop
    exit when claimed_count >= p_limit;

    if not pg_try_advisory_xact_lock(
      hashtextextended('note-index-claim:' || candidate.id, 0)
    ) then
      continue;
    end if;

    -- Preserve the global publication lock order: note -> job -> generation ->
    -- owner/class/purpose key domain. A privacy or revision mutation therefore
    -- either wins before this encrypted source snapshot or waits until after it.
    select * into note_row
    from public.notes as note
    where note.id = candidate.note_id
      and note.user_id = candidate.user_id
    for share of note;

    if not found then
      -- The note/job foreign key normally makes this impossible. A concurrent
      -- cascading delete owns the note lock and will remove the job itself.
      continue;
    end if;

    select * into job_row
    from public.note_index_jobs as job
    where job.id = candidate.id
      and job.user_id = candidate.user_id
      and job.note_id = candidate.note_id
      and job.state = 'queued'
      and job.available_at <= now()
      and job.attempt < 5
    for update of job;

    if not found then
      continue;
    end if;

    select * into generation_row
    from public.rag_index_generations as generation
    where generation.id = job_row.generation_id
      and generation.user_id = job_row.user_id
    for share of generation;
    generation_is_eligible := found
      and generation_row.state in ('building', 'active');

    source_key_state_value := null;
    select content_key.state into source_key_state_value
    from public.user_content_keys as content_key
    where content_key.user_id = note_row.user_id
      and content_key.key_id = note_row.content_key_id
      and content_key.key_class = note_row.content_key_class
      and content_key.key_purpose = note_row.content_key_purpose
      and content_key.key_version = note_row.content_key_version;
    source_key_exists := found;

    terminal_error := null;
    if note_row.current_revision <> job_row.target_revision then
      terminal_error := 'stale_revision'::public.safe_error_code;
    elsif note_row.deleted_at is not null
      or note_row.privacy <> 'ai_assisted'
      or note_row.content_envelope is null
      or note_row.content_key_id is null
      or note_row.content_key_class <> 'ai_assisted'
      or note_row.content_key_purpose <> 'object_wrap'
      or note_row.content_key_version is null
      or not generation_is_eligible
      or not source_key_exists
      or source_key_state_value = 'revoked'
    then
      terminal_error := 'validation_failed'::public.safe_error_code;
    end if;

    if terminal_error is not null then
      update public.note_index_jobs
      set
        state = 'failed',
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        last_error_code = terminal_error
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    -- A pending source key, an oversized source envelope, or a full aggregate
    -- disclosure budget can become processable later. Keep the job queued, but
    -- persist fair progress by moving this inspected row behind the current due
    -- backlog. This is not a retry attempt and records no error or reservation.
    if source_key_state_value not in ('active', 'retired') then
      update public.note_index_jobs
      set available_at = clock_timestamp()
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    source_envelope_bytes := octet_length(note_row.content_envelope::text);
    if source_envelope_bytes > source_byte_budget
      or claimed_source_bytes > source_byte_budget - source_envelope_bytes
    then
      update public.note_index_jobs
      set available_at = clock_timestamp()
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        job_row.user_id::text || ':ai_assisted:object_wrap', 0
      )
    );

    select * into target_key_row
    from public.user_content_keys as content_key
    where content_key.user_id = job_row.user_id
      and content_key.key_class = 'ai_assisted'
      and content_key.key_purpose = 'object_wrap'
      and content_key.state = 'active'
    for update of content_key;

    -- Missing target capacity is operational pressure, not a terminal source
    -- failure. Rotate it behind the due backlog for capacity recovery.
    if not found
      or target_key_row.wrap_operations >= target_key_row.wrap_operation_limit
    then
      update public.note_index_jobs
      set available_at = clock_timestamp()
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    if note_row.content_key_id = target_key_row.key_id
      and note_row.content_key_version = target_key_row.key_version
    then
      source_key_row := target_key_row;
    else
      select * into source_key_row
      from public.user_content_keys as content_key
      where content_key.user_id = job_row.user_id
        and content_key.key_id = note_row.content_key_id
        and content_key.key_class = note_row.content_key_class
        and content_key.key_purpose = note_row.content_key_purpose
        and content_key.key_version = note_row.content_key_version
      for share of content_key;

      if found and source_key_row.state not in ('active', 'retired') then
        if source_key_row.state = 'revoked' then
          update public.note_index_jobs
          set state = 'failed',
              last_error_code = 'validation_failed'
          where id = job_row.id
            and state = 'queued';
        else
          update public.note_index_jobs
          set available_at = clock_timestamp()
          where id = job_row.id
            and state = 'queued';
        end if;
        continue;
      end if;
    end if;

    if source_key_row.key_id is null
      or source_key_row.key_class <> 'ai_assisted'
      or source_key_row.key_purpose <> 'object_wrap'
    then
      update public.note_index_jobs
      set state = 'failed',
          last_error_code = 'validation_failed'
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    reservation_value := extensions.gen_random_uuid();
    lease_token_value := extensions.gen_random_uuid();

    update public.user_content_keys
    set wrap_operations = wrap_operations + 1
    where user_id = target_key_row.user_id
      and key_id = target_key_row.key_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and key_version = target_key_row.key_version
      and state = 'active'
      and wrap_operations < wrap_operation_limit
    returning * into target_key_row;

    if not found then
      update public.note_index_jobs
      set available_at = clock_timestamp()
      where id = job_row.id
        and state = 'queued';
      continue;
    end if;

    insert into public.content_key_operation_reservations (
      user_id, reservation_id, key_id, key_class, key_purpose,
      key_version, operation_count
    ) values (
      job_row.user_id, reservation_value, target_key_row.key_id,
      'ai_assisted', 'object_wrap', target_key_row.key_version, 1
    );

    update public.note_index_jobs
    set
      state = 'leased',
      attempt = attempt + 1,
      lease_owner = p_worker_id,
      lease_token = lease_token_value,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = now(),
      last_error_code = null,
      target_reservation_id = reservation_value,
      target_key_id = target_key_row.key_id,
      target_key_class = 'ai_assisted',
      target_key_purpose = 'object_wrap',
      target_key_version = target_key_row.key_version,
      target_reservation_attempt = attempt + 1,
      target_reservation_lease_token = lease_token_value
    where id = job_row.id
    returning * into job_row;

    claimed_count := claimed_count + 1;
    claimed_source_bytes := claimed_source_bytes + source_envelope_bytes;
    jobs_value := jobs_value || jsonb_build_array(jsonb_build_object(
      'jobId', job_row.id,
      'userId', job_row.user_id,
      'noteId', job_row.note_id,
      'generationId', job_row.generation_id,
      'targetRevision', job_row.target_revision,
      'indexResourceId', job_row.index_resource_id,
      'noteType', note_row.type,
      'spaceId', note_row.space_id,
      'isOpen', note_row.is_open,
      'pinnedAt', note_row.pinned_at,
      'updatedAt', note_row.updated_at,
      'attempt', job_row.attempt,
      'leaseToken', job_row.lease_token,
      'leaseExpiresAt', job_row.lease_expires_at,
      'sourceNoteCipher', private.encrypted_cipher_projection(
        note_row.content_envelope, note_row.content_key_id,
        note_row.content_key_class, note_row.content_key_purpose,
        note_row.content_key_version
      ),
      'sourceEnvelopeBytes', source_envelope_bytes,
      'sourceKey', private.content_key_service_projection(source_key_row),
      'targetKey', private.content_key_service_projection(target_key_row),
      'embeddingModelId', generation_row.embedding_model_id,
      'embeddingDimensions', generation_row.embedding_dimensions,
      'generationRevisionToken', generation_row.revision_token,
      'reservation', jsonb_build_object(
        'reservationId', reservation_value,
        'keyId', target_key_row.key_id,
        'keyClass', target_key_row.key_class,
        'keyPurpose', target_key_row.key_purpose,
        'keyVersion', target_key_row.key_version,
        'operationCount', 1,
        'consumed', false
      )
    ));
  end loop;

  return jsonb_build_object(
    'jobs', jobs_value,
    'sourceEnvelopeBytes', claimed_source_bytes,
    'sourceEnvelopeByteBudget', source_byte_budget
  );
end;
$$;

-- CREATE OR REPLACE retains the existing ACL. Reassert the complete intended
-- caller set explicitly so this forward migration cannot widen the worker.
revoke all on function public.claim_note_index_jobs(
  text, integer, integer
) from public, anon, authenticated, unfiled_rag_verifier;
grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to service_role, unfiled_index_worker;
