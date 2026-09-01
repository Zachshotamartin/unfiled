-- Milestone C.5d-2: encrypted capture retry and deletion commands.
--
-- These commands never call the legacy capture RPCs. API intent is bound by
-- a logical request MAC, the replayable response is an encrypted aggregate,
-- and every mutable path takes the canonical owner rollout advisory before
-- the job -> capture row-lock order.

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command'
    )
  );

-- Preserve the RAG job/reservation lock order added in migration 17 while
-- admitting the one-response reservation used by these capture commands.
create or replace function private.consume_content_key_reservations(
  owner_id uuid,
  cipher_values jsonb,
  consumer_type_value text,
  consumer_id_value text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_group record;
  reservation_row public.content_key_operation_reservations%rowtype;
  bound_job public.note_index_jobs%rowtype;
  reservation_is_rag_bound boolean;
  key_state_value public.content_key_state;
begin
  if jsonb_typeof(cipher_values) <> 'array'
    or jsonb_array_length(cipher_values) not between 1 and 100
    or consumer_type_value not in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_capture_command'
    )
    or char_length(consumer_id_value) not between 1 and 200
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for reservation_group in
    select
      (item ->> 'reservationId')::uuid as reservation_id,
      item ->> 'keyId' as key_id,
      (item ->> 'keyClass')::public.content_key_class as key_class,
      (item ->> 'keyPurpose')::public.content_key_purpose as key_purpose,
      (item ->> 'keyVersion')::integer as key_version,
      count(*)::integer as operation_count
    from jsonb_array_elements(cipher_values) as entry(item)
    group by 1, 2, 3, 4, 5
    order by 1
  loop
    select * into bound_job
    from public.note_index_jobs as job
    where job.user_id = owner_id
      and job.target_reservation_id = reservation_group.reservation_id
    for share of job;
    reservation_is_rag_bound := found;

    select * into reservation_row
    from public.content_key_operation_reservations
    where user_id = owner_id
      and reservation_id = reservation_group.reservation_id
    for update;
    if not found
      or reservation_row.key_id <> reservation_group.key_id
      or reservation_row.key_class <> reservation_group.key_class
      or reservation_row.key_purpose <> reservation_group.key_purpose
      or reservation_row.key_version <> reservation_group.key_version
      or reservation_row.operation_count <> reservation_group.operation_count
    then
      raise exception using
        errcode = 'P0001', message = 'invalid_key_reservation';
    end if;

    if reservation_row.consumed_at is not null then
      if reservation_row.consumed_by_type = consumer_type_value
        and reservation_row.consumed_by_id = consumer_id_value
      then continue; end if;
      raise exception using
        errcode = 'P0001', message = 'key_reservation_consumed';
    end if;
    if (
      reservation_is_rag_bound
      and (
        consumer_type_value <> 'note_rag_index'
        or consumer_id_value <> bound_job.index_resource_id
        or bound_job.state <> 'leased'
        or bound_job.target_reservation_attempt <> bound_job.attempt
        or bound_job.target_reservation_lease_token <> bound_job.lease_token
      )
    ) or (
      consumer_type_value = 'note_rag_index'
      and not reservation_is_rag_bound
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_key_reservation_binding';
    end if;

    select state into key_state_value
    from public.user_content_keys
    where user_id = owner_id
      and key_id = reservation_row.key_id
      and key_class = reservation_row.key_class
      and key_purpose = reservation_row.key_purpose
      and key_version = reservation_row.key_version
    for share;
    if key_state_value is distinct from 'active'::public.content_key_state then
      raise exception using errcode = 'P0001', message = 'invalid_key_state';
    end if;

    update public.content_key_operation_reservations
    set
      consumed_by_type = consumer_type_value,
      consumed_by_id = consumer_id_value,
      consumed_at = clock_timestamp()
    where user_id = owner_id
      and reservation_id = reservation_group.reservation_id;
  end loop;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.encrypted_capture_command_result(
  record_value public.api_idempotency_records,
  replayed_value boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if record_value.user_id is null
    or record_value.scope not in ('retry_capture', 'delete_capture')
    or record_value.replay_policy <> 'logical_mac'
    or record_value.request_resource_type <> 'capture'
    or record_value.request_resource_id is null
    or record_value.response_envelope is null
    or record_value.response_record_version <> 1
  then
    raise exception using
      errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if record_value.scope = 'retry_capture' then
    if record_value.response_resource_type <> 'organization_job'
      or record_value.response_resource_id
        !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'captureId', record_value.request_resource_id,
      'jobId', record_value.response_resource_id,
      'encryptedResponse', private.encrypted_cipher_projection(
        record_value.response_envelope, record_value.response_key_id,
        record_value.response_key_class, record_value.response_key_purpose,
        record_value.response_key_version
      ),
      'replayed', replayed_value
    );
  end if;

  if record_value.response_resource_type <> 'capture_tombstone'
    or record_value.response_resource_id <> record_value.request_resource_id
  then
    raise exception using
      errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return jsonb_build_object(
    'captureId', record_value.request_resource_id,
    'encryptedResponse', private.encrypted_cipher_projection(
      record_value.response_envelope, record_value.response_key_id,
      record_value.response_key_class, record_value.response_key_purpose,
      record_value.response_key_version
    ),
    'replayed', replayed_value
  );
end;
$$;

create or replace function private.lock_encrypted_capture_command_replay(
  owner_id uuid,
  scope_value text,
  idempotency_key_value text,
  capture_id_value text,
  request_mac_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_row public.api_idempotency_records%rowtype;
begin
  select * into record_row
  from public.api_idempotency_records
  where user_id = owner_id and idempotency_key = idempotency_key_value
  for update;
  if not found then return null; end if;

  if record_row.scope <> scope_value
    or record_row.replay_policy <> 'logical_mac'
    or record_row.request_resource_type <> 'capture'
    or record_row.request_resource_id <> capture_id_value
    or record_row.request_mac is null
    or record_row.request_mac <> request_mac_value ->> 'mac'
    or record_row.request_mac_key_id <> request_mac_value ->> 'keyId'
    or record_row.request_mac_key_class::text
      <> request_mac_value ->> 'keyClass'
    or record_row.request_mac_key_purpose::text
      <> request_mac_value ->> 'keyPurpose'
    or record_row.request_mac_key_version::text
      <> request_mac_value ->> 'keyVersion'
    or record_row.response_key_class <> record_row.request_mac_key_class
    or not private.valid_encrypted_write_mac(
      request_mac_value, owner_id, record_row.request_mac_key_class, true
    )
    or not exists (
      select 1 from public.user_content_keys as response_key
      where response_key.user_id = owner_id
        and response_key.key_id = record_row.response_key_id
        and response_key.key_class = record_row.response_key_class
        and response_key.key_purpose = record_row.response_key_purpose
        and response_key.key_version = record_row.response_key_version
        and response_key.state in ('active', 'retired')
    )
  then
    raise exception using
      errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return private.encrypted_capture_command_result(record_row, true);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.finish_encrypted_capture_command(
  owner_id uuid,
  scope_value text,
  idempotency_key_value text,
  capture_id_value text,
  response_resource_type_value text,
  response_resource_id_value text,
  occurred_at_value timestamptz,
  request_mac_value jsonb,
  response_cipher_value jsonb,
  response_verification_mac_value jsonb
)
returns public.api_idempotency_records
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_row public.api_idempotency_records%rowtype;
begin
  insert into public.api_idempotency_records (
    user_id, idempotency_key, scope, request_hash, response_json,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version, response_envelope,
    response_key_id, response_key_class, response_key_purpose,
    response_key_version, request_resource_type, request_resource_id,
    response_resource_type, response_resource_id, response_record_version,
    created_at, replay_policy
  ) values (
    owner_id, idempotency_key_value, scope_value,
    request_mac_value ->> 'mac',
    jsonb_build_object(
      'resourceType', response_resource_type_value,
      'resourceId', response_resource_id_value,
      'recordVersion', 1
    ),
    occurred_at_value, request_mac_value ->> 'mac',
    request_mac_value ->> 'keyId',
    (request_mac_value ->> 'keyClass')::public.content_key_class,
    (request_mac_value ->> 'keyPurpose')::public.content_key_purpose,
    (request_mac_value ->> 'keyVersion')::integer,
    response_cipher_value -> 'envelope', response_cipher_value ->> 'keyId',
    (response_cipher_value ->> 'keyClass')::public.content_key_class,
    (response_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
    (response_cipher_value ->> 'keyVersion')::integer,
    'capture', capture_id_value, response_resource_type_value,
    response_resource_id_value, 1, occurred_at_value, 'logical_mac'
  ) returning * into record_row;

  perform private.record_content_encryption_verification(
    owner_id, 'idempotency_response',
    'idempotency:' || idempotency_key_value, 1,
    response_cipher_value -> 'envelope', response_verification_mac_value
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1
  where user_id = owner_id;
  return record_row;
end;
$$;

-- A concurrent first caller can reserve and seal before it loses the
-- idempotency advisory race. Mark that otherwise-abandoned reservation as
-- consumed without inspecting or replacing the winner's stored ciphertext.
create or replace function private.consume_replayed_capture_command_reservation(
  owner_id uuid,
  idempotency_key_value text,
  command_value jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_class public.content_key_class;
  response_cipher_value jsonb;
begin
  if jsonb_typeof(command_value -> 'responseCipher') <> 'object' then
    return;
  end if;
  select response_key_class into expected_class
  from public.api_idempotency_records
  where user_id = owner_id and idempotency_key = idempotency_key_value;
  if not found then return; end if;

  response_cipher_value := command_value -> 'responseCipher';
  if not private.valid_encrypted_write_cipher(
      response_cipher_value, owner_id,
      'idempotency:' || idempotency_key_value, 1,
      'idempotency_response', expected_class
    )
    or not exists (
      select 1 from public.user_content_keys
      where user_id = owner_id
        and key_id = response_cipher_value ->> 'keyId'
        and key_class = expected_class
        and key_purpose = 'object_wrap'
        and key_version = (response_cipher_value ->> 'keyVersion')::integer
        and state = 'active'
    )
  then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    owner_id::text || ':content-encryption-rollout', 0
  ));
  perform private.consume_content_key_reservations(
    owner_id, jsonb_build_array(response_cipher_value),
    'encrypted_capture_command', idempotency_key_value
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return;
end;
$$;

create or replace function public.get_encrypted_capture_command_claim(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  record_row public.api_idempotency_records%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in ('retry_capture', 'delete_capture')
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into record_row
  from public.api_idempotency_records
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then
    if exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object('found', false, 'claim', null);
  end if;
  if record_row.scope <> p_scope
    or record_row.replay_policy <> 'logical_mac'
    or record_row.request_resource_type <> 'capture'
    or record_row.request_resource_id
      !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or record_row.request_mac is null
    or record_row.response_envelope is null
  then
    raise exception using
      errcode = 'P0001', message = case
        when record_row.replay_policy = 'legacy_nonreplayable'
          then 'legacy_idempotency_nonreplayable'
        else 'invalid_idempotency_key' end;
  end if;

  return jsonb_build_object(
    'found', true,
    'claim', jsonb_build_object(
      'scope', record_row.scope,
      'captureId', record_row.request_resource_id,
      'keyClass', record_row.request_mac_key_class,
      'requestMacKey', jsonb_build_object(
        'keyId', record_row.request_mac_key_id,
        'keyClass', record_row.request_mac_key_class,
        'keyPurpose', record_row.request_mac_key_purpose,
        'keyVersion', record_row.request_mac_key_version
      )
    )
  );
end;
$$;

create or replace function public.get_encrypted_capture_delete_context(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  source_note_ids jsonb;
  linked_note_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if not exists (
    select 1 from public.captures
    where user_id = p_owner_id and id = p_capture_id
      and deleted_at is null and status <> 'deleted'
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select coalesce(jsonb_agg(note_id order by note_id), '[]'::jsonb), count(*)
  into source_note_ids, linked_note_count
  from (
    select distinct note_id
    from public.capture_note_links
    where user_id = p_owner_id and capture_id = p_capture_id
  ) as linked;
  if linked_note_count > 100 then
    raise exception using
      errcode = 'P0001', message = 'conflict_requires_review';
  end if;
  return jsonb_build_object(
    'captureId', p_capture_id,
    'sourceNoteIds', source_note_ids
  );
end;
$$;

create or replace function public.retry_encrypted_capture(
  p_owner_id uuid,
  p_capture_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  replay_result jsonb;
  record_row public.api_idempotency_records%rowtype;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_mac_value jsonb;
  occurred_at_value timestamptz;
  expected_class public.content_key_class;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_mac_value := p_command -> 'requestMac';

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_result := private.lock_encrypted_capture_command_replay(
    p_owner_id, 'retry_capture', p_idempotency_key, p_capture_id,
    request_mac_value
  );
  if replay_result is not null then
    perform private.consume_replayed_capture_command_reservation(
      p_owner_id, p_idempotency_key, p_command
    );
    return replay_result;
  end if;
  if p_command - array[
      'occurredAt', 'requestMac', 'responseCipher',
      'responseVerificationMac'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'occurredAt', 'requestMac', 'responseCipher',
      'responseVerificationMac'
    ]
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    occurred_at_value := (p_command ->> 'occurredAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if occurred_at_value <> date_trunc('milliseconds', occurred_at_value)
    or occurred_at_value < clock_timestamp() - interval '5 minutes'
    or occurred_at_value > clock_timestamp() + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in (
        'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
      )
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into job_row
  from public.organization_jobs
  where user_id = p_owner_id and capture_id = p_capture_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into capture_row
  from public.captures
  where user_id = p_owner_id and id = p_capture_id
    and deleted_at is null and status <> 'deleted'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if capture_row.status <> 'failed'
    or job_row.state not in ('failed', 'dead_letter')
  then
    raise exception using errcode = 'P0001', message = 'invalid_plan';
  end if;

  expected_class := capture_row.privacy::text::public.content_key_class;
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_mac_value := p_command -> 'responseVerificationMac';
  if not private.valid_encrypted_write_mac(
      request_mac_value, p_owner_id, expected_class, false
    )
    or not private.valid_encrypted_write_cipher(
      response_cipher_value, p_owner_id,
      'idempotency:' || p_idempotency_key, 1,
      'idempotency_response', expected_class
    )
    or not private.valid_encrypted_write_mac(
      response_verification_mac_value, p_owner_id, expected_class, false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(response_cipher_value),
    'encrypted_capture_command', p_idempotency_key
  );

  delete from public.capture_receipts
  where user_id = p_owner_id and capture_id = p_capture_id;
  delete from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id;
  update public.encrypted_organizer_preparations
  set
    write_reservation_id = null,
    decision_reservation_id = null,
    review_reservation_id = null,
    receipt_reservation_id = null,
    object_key_id = null,
    object_key_version = null,
    controls = null,
    updated_at = clock_timestamp()
  where job_id = job_row.id and completed_at is null;
  update public.organization_jobs
  set
    state = 'created',
    attempt = 0,
    replan_count = 0,
    available_at = occurred_at_value,
    workflow_provider_id = null,
    model_id = null,
    started_at = null,
    completed_at = null,
    error_code = null,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = null,
    last_transition_action = null,
    last_transition_request_hash = null
  where id = job_row.id;
  update public.captures
  set status = 'queued', last_error_code = null
  where id = capture_row.id and user_id = p_owner_id;

  record_row := private.finish_encrypted_capture_command(
    p_owner_id, 'retry_capture', p_idempotency_key, p_capture_id,
    'organization_job', job_row.id, occurred_at_value,
    request_mac_value, response_cipher_value,
    response_verification_mac_value
  );
  perform private.emit_user_event(p_owner_id, 'organization_job', job_row.id);
  perform private.emit_user_event(p_owner_id, 'capture', p_capture_id);
  return private.encrypted_capture_command_result(record_row, false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.delete_encrypted_capture(
  p_owner_id uuid,
  p_capture_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  replay_result jsonb;
  record_row public.api_idempotency_records%rowtype;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_mac_value jsonb;
  occurred_at_value timestamptz;
  expected_class public.content_key_class;
  supplied_note_ids jsonb;
  live_note_ids jsonb;
  linked_note_count integer;
  deleted_review record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_mac_value := p_command -> 'requestMac';

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  replay_result := private.lock_encrypted_capture_command_replay(
    p_owner_id, 'delete_capture', p_idempotency_key, p_capture_id,
    request_mac_value
  );
  if replay_result is not null then
    perform private.consume_replayed_capture_command_reservation(
      p_owner_id, p_idempotency_key, p_command
    );
    return replay_result;
  end if;
  if p_command - array[
      'occurredAt', 'removeInsertedContent', 'requestMac', 'responseCipher',
      'responseVerificationMac', 'sourceNoteIds'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'occurredAt', 'removeInsertedContent', 'requestMac', 'responseCipher',
      'responseVerificationMac', 'sourceNoteIds'
    ]
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or p_command -> 'removeInsertedContent' <> 'false'::jsonb
    or jsonb_typeof(p_command -> 'sourceNoteIds') <> 'array'
    or jsonb_array_length(p_command -> 'sourceNoteIds') > 100
    or exists (
      select 1 from jsonb_array_elements(p_command -> 'sourceNoteIds') as item
      where jsonb_typeof(item) <> 'string'
        or item #>> '{}' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    )
    or (
      select count(*) <> count(distinct item #>> '{}')
      from jsonb_array_elements(p_command -> 'sourceNoteIds') as item
    )
    or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    occurred_at_value := (p_command ->> 'occurredAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if occurred_at_value <> date_trunc('milliseconds', occurred_at_value)
    or occurred_at_value < clock_timestamp() - interval '5 minutes'
    or occurred_at_value > clock_timestamp() + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in (
        'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
      )
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into job_row
  from public.organization_jobs
  where user_id = p_owner_id and capture_id = p_capture_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into capture_row
  from public.captures
  where user_id = p_owner_id and id = p_capture_id
    and deleted_at is null and status <> 'deleted'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select coalesce(jsonb_agg(note_id order by note_id), '[]'::jsonb), count(*)
  into live_note_ids, linked_note_count
  from (
    select distinct note_id
    from public.capture_note_links
    where user_id = p_owner_id and capture_id = p_capture_id
  ) as linked;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into supplied_note_ids
  from jsonb_array_elements_text(p_command -> 'sourceNoteIds') as listed(value);
  if linked_note_count > 100 or supplied_note_ids <> live_note_ids then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  expected_class := capture_row.privacy::text::public.content_key_class;
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_mac_value := p_command -> 'responseVerificationMac';
  if not private.valid_encrypted_write_mac(
      request_mac_value, p_owner_id, expected_class, false
    )
    or not private.valid_encrypted_write_cipher(
      response_cipher_value, p_owner_id,
      'idempotency:' || p_idempotency_key, 1,
      'idempotency_response', expected_class
    )
    or not private.valid_encrypted_write_mac(
      response_verification_mac_value, p_owner_id, expected_class, false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(response_cipher_value),
    'encrypted_capture_command', p_idempotency_key
  );

  if job_row.state = 'running' then
    perform private.burn_encrypted_organizer_reservations(
      job_row.id, job_row.lease_token
    );
  end if;
  delete from public.capture_receipts
  where user_id = p_owner_id and capture_id = p_capture_id;
  for deleted_review in
    delete from public.review_items
    where user_id = p_owner_id and capture_id = p_capture_id
    returning id
  loop
    perform private.emit_user_event(
      p_owner_id, 'review_item', deleted_review.id
    );
  end loop;
  delete from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id;
  update public.encrypted_organizer_preparations
  set
    write_reservation_id = null,
    decision_reservation_id = null,
    review_reservation_id = null,
    receipt_reservation_id = null,
    object_key_id = null,
    object_key_version = null,
    controls = null,
    updated_at = clock_timestamp()
  where job_id = job_row.id and completed_at is null;
  update public.capture_note_links
  set relation = 'source_removed'
  where user_id = p_owner_id and capture_id = p_capture_id;
  update public.captures
  set
    raw_text = '[deleted]',
    status = 'deleted',
    deleted_at = occurred_at_value,
    content_envelope = null,
    content_fingerprint = null,
    content_length = null,
    content_key_id = null,
    content_key_class = null,
    content_key_purpose = null,
    content_key_version = null,
    fingerprint_key_id = null,
    fingerprint_key_class = null,
    fingerprint_key_purpose = null,
    fingerprint_key_version = null
  where id = p_capture_id and user_id = p_owner_id;

  delete from public.api_idempotency_records
  where user_id = p_owner_id
    and scope = 'retry_capture'
    and (
      (request_resource_type = 'capture'
        and request_resource_id = p_capture_id)
      or response_json #>> '{capture,id}' = p_capture_id
    );
  if job_row.state in ('created', 'running', 'awaiting_retry') then
    update public.organization_jobs
    set
      state = 'failed',
      completed_at = occurred_at_value,
      error_code = 'not_found',
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = case when job_row.state = 'running'
        then job_row.lease_token else null end,
      last_transition_action = case when job_row.state = 'running'
        then 'failed' else null end,
      last_transition_request_hash = case when job_row.state = 'running'
        then private.request_hash(jsonb_build_object(
          'domain', 'unfiled.encrypted-capture-delete.v1',
          'captureId', p_capture_id,
          'leaseToken', job_row.lease_token
        )) else null end
    where id = job_row.id;
    perform private.emit_user_event(
      p_owner_id, 'organization_job', job_row.id
    );
  end if;

  record_row := private.finish_encrypted_capture_command(
    p_owner_id, 'delete_capture', p_idempotency_key, p_capture_id,
    'capture_tombstone', p_capture_id, occurred_at_value,
    request_mac_value, response_cipher_value,
    response_verification_mac_value
  );
  perform private.emit_user_event(p_owner_id, 'capture', p_capture_id);
  for deleted_review in
    select distinct note_id
    from public.capture_note_links
    where user_id = p_owner_id and capture_id = p_capture_id
  loop
    perform private.emit_user_event(
      p_owner_id, 'capture_note_link', deleted_review.note_id
    );
  end loop;
  return private.encrypted_capture_command_result(record_row, false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

revoke execute on function private.encrypted_capture_command_result(
  public.api_idempotency_records, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.lock_encrypted_capture_command_replay(
  uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.finish_encrypted_capture_command(
  uuid, text, text, text, text, text, timestamptz, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.consume_replayed_capture_command_reservation(
  uuid, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

revoke execute on function public.get_encrypted_capture_command_claim(
  uuid, text, text
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.get_encrypted_capture_delete_context(
  uuid, text
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.retry_encrypted_capture(
  uuid, text, text, jsonb
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.delete_encrypted_capture(
  uuid, text, text, jsonb
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

grant execute on function public.get_encrypted_capture_command_claim(
  uuid, text, text
) to service_role;
grant execute on function public.get_encrypted_capture_delete_context(
  uuid, text
) to service_role;
grant execute on function public.retry_encrypted_capture(
  uuid, text, text, jsonb
) to service_role;
grant execute on function public.delete_encrypted_capture(
  uuid, text, text, jsonb
) to service_role;
