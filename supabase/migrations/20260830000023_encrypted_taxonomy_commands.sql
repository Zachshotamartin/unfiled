-- Milestone C.5d-3: ciphertext-only space and tag command path.

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command',
      'encrypted_taxonomy_command'
    )
  );

-- Preserve migration 17's RAG binding and migration 22's capture consumer.
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
      'encrypted_capture_command', 'encrypted_taxonomy_command'
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
      raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
    end if;

    if reservation_row.consumed_at is not null then
      if reservation_row.consumed_by_type = consumer_type_value
        and reservation_row.consumed_by_id = consumer_id_value
      then continue; end if;
      raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
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

create table public.encrypted_taxonomy_write_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 80
    and btrim(idempotency_key) = idempotency_key
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  scope text not null check (scope in (
    'create_space', 'update_space', 'archive_space',
    'create_tag', 'update_tag', 'delete_tag'
  )),
  resource_id text not null,
  expected_revision integer not null check (expected_revision >= 0),
  occurred_at timestamptz not null default date_trunc(
    'milliseconds', clock_timestamp()
  ),
  request_mac_key_id text not null,
  request_mac_key_class public.content_key_class not null
    check (request_mac_key_class = 'private_manual'),
  request_mac_key_purpose public.content_key_purpose not null
    check (request_mac_key_purpose = 'content_mac'),
  request_mac_key_version integer not null check (request_mac_key_version >= 1),
  request_mac text not null check (request_mac ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  check (
    (scope in ('create_space', 'update_space', 'archive_space')
      and resource_id ~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$')
    or
    (scope in ('create_tag', 'update_tag', 'delete_tag')
      and resource_id ~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$')
  ),
  check (
    (scope in ('create_space', 'create_tag') and expected_revision = 0)
    or
    (scope not in ('create_space', 'create_tag') and expected_revision >= 1)
  ),
  foreign key (
    user_id, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);

alter table public.encrypted_taxonomy_write_claims enable row level security;
alter table public.encrypted_taxonomy_write_claims force row level security;
revoke all on table public.encrypted_taxonomy_write_claims
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant all on table public.encrypted_taxonomy_write_claims to service_role;

create or replace function private.encrypted_taxonomy_claim_projection(
  claim_value public.encrypted_taxonomy_write_claims
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'scope', claim_value.scope,
    'resourceId', claim_value.resource_id,
    'expectedRevision', claim_value.expected_revision,
    'occurredAt', claim_value.occurred_at,
    'requestMacKey', jsonb_build_object(
      'keyId', claim_value.request_mac_key_id,
      'keyClass', claim_value.request_mac_key_class,
      'keyPurpose', claim_value.request_mac_key_purpose,
      'keyVersion', claim_value.request_mac_key_version
    ),
    'completed', claim_value.completed_at is not null
  );
$$;

create or replace function private.encrypted_taxonomy_response(
  claim_value public.encrypted_taxonomy_write_claims,
  replayed_value boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  record_row public.api_idempotency_records%rowtype;
  result_revision integer;
begin
  select * into record_row
  from public.api_idempotency_records
  where user_id = claim_value.user_id
    and idempotency_key = claim_value.idempotency_key;
  if not found
    or record_row.scope <> claim_value.scope
    or record_row.replay_policy <> 'logical_mac'
    or record_row.request_resource_id <> claim_value.resource_id
    or record_row.response_envelope is null
    or record_row.response_key_class <> 'private_manual'
    or record_row.response_record_version is null
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  result_revision := case when claim_value.scope = 'delete_tag'
    then claim_value.expected_revision else claim_value.expected_revision + 1 end;
  if record_row.response_record_version <> result_revision then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return jsonb_build_object(
    'resourceId', claim_value.resource_id,
    'currentRevision', result_revision,
    'encryptedResponse', private.encrypted_cipher_projection(
      record_row.response_envelope, record_row.response_key_id,
      record_row.response_key_class, record_row.response_key_purpose,
      record_row.response_key_version
    ),
    'replayed', replayed_value
  );
end;
$$;

create or replace function private.preserve_taxonomy_command_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
drop trigger if exists spaces_set_updated_at on public.spaces;
create trigger spaces_set_updated_at
before update on public.spaces
for each row execute function private.preserve_taxonomy_command_timestamp();
drop trigger if exists tags_set_updated_at on public.tags;
create trigger tags_set_updated_at
before update on public.tags
for each row execute function private.preserve_taxonomy_command_timestamp();

create or replace function private.finish_encrypted_taxonomy_write(
  claim_value public.encrypted_taxonomy_write_claims,
  request_mac_value jsonb,
  response_cipher_value jsonb,
  response_verification_mac_value jsonb,
  result_revision_value integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  resource_type_value text;
  response_type_value text;
begin
  resource_type_value := case when claim_value.scope like '%_space'
    then 'space' else 'tag' end;
  response_type_value := case when claim_value.scope = 'delete_tag'
    then 'tag_tombstone' else resource_type_value end;
  insert into public.api_idempotency_records (
    user_id, idempotency_key, scope, request_hash, response_json,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version, response_envelope,
    response_key_id, response_key_class, response_key_purpose,
    response_key_version, request_resource_type, request_resource_id,
    response_resource_type, response_resource_id, response_record_version,
    created_at, replay_policy
  ) values (
    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    request_mac_value ->> 'mac',
    private.encrypted_only_idempotency_response(
      claim_value.scope, claim_value.resource_id, response_type_value,
      claim_value.resource_id, result_revision_value
    ),
    claim_value.occurred_at, request_mac_value ->> 'mac',
    claim_value.request_mac_key_id, claim_value.request_mac_key_class,
    claim_value.request_mac_key_purpose, claim_value.request_mac_key_version,
    response_cipher_value -> 'envelope', response_cipher_value ->> 'keyId',
    (response_cipher_value ->> 'keyClass')::public.content_key_class,
    (response_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
    (response_cipher_value ->> 'keyVersion')::integer,
    resource_type_value, claim_value.resource_id, response_type_value,
    claim_value.resource_id, result_revision_value,
    claim_value.occurred_at, 'logical_mac'
  );
  perform private.record_content_encryption_verification(
    claim_value.user_id, 'idempotency_response',
    'idempotency:' || claim_value.idempotency_key, 1,
    response_cipher_value -> 'envelope', response_verification_mac_value
  );
  update public.encrypted_taxonomy_write_claims
  set completed_at = claim_value.occurred_at
  where user_id = claim_value.user_id
    and idempotency_key = claim_value.idempotency_key
    and completed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
end;
$$;

create or replace function public.commit_encrypted_taxonomy_write(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text,
  p_resource_id text,
  p_expected_revision integer,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_taxonomy_write_claims%rowtype;
  space_row public.spaces%rowtype;
  tag_row public.tags%rowtype;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_value jsonb;
  display_value jsonb;
  display_cipher_value jsonb;
  display_mac_value jsonb;
  display_verification_value jsonb;
  occurred_at_value timestamptz;
  result_revision_value integer;
  parent_id_value text;
  sort_key_value text;
  archived_at_value timestamptz;
  reservation_values jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in (
      'create_space', 'update_space', 'archive_space',
      'create_tag', 'update_tag', 'delete_tag'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_resource_id is null
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_command) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  select * into claim_row
  from public.encrypted_taxonomy_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if not found then raise exception using errcode = 'P0001', message = 'write_not_prepared'; end if;
  if claim_row.scope <> p_scope
    or claim_row.resource_id <> p_resource_id
    or claim_row.expected_revision <> p_expected_revision
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if p_scope in ('create_space', 'update_space', 'archive_space') then
    if p_command - array[
        'scope', 'occurredAt', 'parentId', 'sortKey', 'archivedAt',
        'display', 'requestMac', 'responseCipher', 'responseVerificationMac'
      ] <> '{}'::jsonb
      or not p_command ?& array[
        'scope', 'occurredAt', 'parentId', 'sortKey', 'archivedAt',
        'display', 'requestMac', 'responseCipher', 'responseVerificationMac'
      ]
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  elsif p_scope in ('create_tag', 'update_tag') then
    if p_command - array[
        'scope', 'occurredAt', 'display', 'requestMac',
        'responseCipher', 'responseVerificationMac'
      ] <> '{}'::jsonb
      or not p_command ?& array[
        'scope', 'occurredAt', 'display', 'requestMac',
        'responseCipher', 'responseVerificationMac'
      ]
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  else
    if p_command - array[
        'scope', 'occurredAt', 'requestMac',
        'responseCipher', 'responseVerificationMac'
      ] <> '{}'::jsonb
      or not p_command ?& array[
        'scope', 'occurredAt', 'requestMac',
        'responseCipher', 'responseVerificationMac'
      ]
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  end if;
  if p_command ->> 'scope' <> p_scope
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
    or jsonb_typeof(p_command -> 'responseCipher') <> 'object'
    or jsonb_typeof(p_command -> 'responseVerificationMac') <> 'object'
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;

  request_mac_value := p_command -> 'requestMac';
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_value := p_command -> 'responseVerificationMac';
  occurred_at_value := (p_command ->> 'occurredAt')::timestamptz;
  result_revision_value := case when p_scope = 'delete_tag'
    then p_expected_revision else p_expected_revision + 1 end;
  if occurred_at_value <> claim_row.occurred_at
    or occurred_at_value <> date_trunc('milliseconds', occurred_at_value)
    or not private.valid_encrypted_write_mac(
      request_mac_value, p_owner_id, 'private_manual', true
    )
    or request_mac_value ->> 'mac' <> claim_row.request_mac
    or request_mac_value ->> 'keyId' <> claim_row.request_mac_key_id
    or request_mac_value ->> 'keyClass' <> claim_row.request_mac_key_class::text
    or request_mac_value ->> 'keyPurpose' <> claim_row.request_mac_key_purpose::text
    or (request_mac_value ->> 'keyVersion')::integer
      <> claim_row.request_mac_key_version
    or not private.valid_encrypted_write_cipher(
      response_cipher_value, p_owner_id,
      'idempotency:' || p_idempotency_key, 1,
      'idempotency_response', 'private_manual'
    )
    or not private.valid_encrypted_write_mac(
      response_verification_value, p_owner_id, 'private_manual', false
    )
  then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;

  if p_scope <> 'delete_tag' then
    display_value := p_command -> 'display';
    if jsonb_typeof(display_value) <> 'object'
      or display_value - array['cipher', 'semanticMac', 'verificationMac'] <> '{}'::jsonb
      or not display_value ?& array['cipher', 'semanticMac', 'verificationMac']
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    display_cipher_value := display_value -> 'cipher';
    display_mac_value := display_value -> 'semanticMac';
    display_verification_value := display_value -> 'verificationMac';
    if not private.valid_encrypted_write_cipher(
        display_cipher_value, p_owner_id, p_resource_id,
        result_revision_value,
        case when p_scope like '%_space' then 'space_display' else 'tag_display' end,
        'private_manual'
      )
      or not private.valid_encrypted_write_mac(
        display_mac_value, p_owner_id, 'private_manual', false
      )
      or not private.valid_encrypted_write_mac(
        display_verification_value, p_owner_id, 'private_manual', false
      )
    then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;
    reservation_values := jsonb_build_array(
      display_cipher_value, response_cipher_value
    );
  else
    reservation_values := jsonb_build_array(response_cipher_value);
  end if;

  -- A second first caller may have sealed while waiting on this idempotency
  -- advisory. Consume its otherwise-abandoned reservations under the same
  -- claim before returning the winner's exact encrypted response.
  if claim_row.completed_at is not null then
    perform private.consume_content_key_reservations(
      p_owner_id, reservation_values, 'encrypted_taxonomy_command',
      p_idempotency_key
    );
    return private.encrypted_taxonomy_response(claim_row, true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in ('dual_write', 'encrypted_read', 'encrypted_only', 'contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-taxonomy', 0
  ));

  if p_scope in ('create_space', 'update_space', 'archive_space') then
    if jsonb_typeof(p_command -> 'parentId') not in ('string', 'null')
      or jsonb_typeof(p_command -> 'sortKey') <> 'string'
      or char_length(p_command ->> 'sortKey') not between 1 and 100
      or btrim(p_command ->> 'sortKey') <> p_command ->> 'sortKey'
      or jsonb_typeof(p_command -> 'archivedAt') not in ('string', 'null')
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    parent_id_value := nullif(p_command ->> 'parentId', '');
    sort_key_value := p_command ->> 'sortKey';
    archived_at_value := case when jsonb_typeof(p_command -> 'archivedAt') = 'null'
      then null else (p_command ->> 'archivedAt')::timestamptz end;
    if parent_id_value is not null and (
      parent_id_value !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
      or parent_id_value = p_resource_id
      or not exists (
        select 1 from public.spaces
        where user_id = p_owner_id and id = parent_id_value
          and parent_id is null and archived_at is null
      )
    ) then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    if exists (
      select 1 from public.spaces
      where user_id = p_owner_id and (
        display_mac is null
        or display_mac_key_id <> display_mac_value ->> 'keyId'
        or display_mac_key_class <> 'private_manual'
        or display_mac_key_purpose <> 'content_mac'
        or display_mac_key_version <> (display_mac_value ->> 'keyVersion')::integer
      )
    ) then raise exception using errcode = 'P0001', message = 'invalid_key_state'; end if;

    if p_scope = 'create_space' then
      if archived_at_value is not null or p_expected_revision <> 0 then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
    else
      select * into space_row from public.spaces
      where user_id = p_owner_id and id = p_resource_id for update;
      if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
      if space_row.current_revision <> p_expected_revision then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    end if;
  else
    if exists (
      select 1 from public.tags
      where user_id = p_owner_id and (
        display_mac is null
        or display_mac_key_id <> coalesce(display_mac_value ->> 'keyId', display_mac_key_id)
        or display_mac_key_class <> 'private_manual'
        or display_mac_key_purpose <> 'content_mac'
        or display_mac_key_version <> coalesce(
          (display_mac_value ->> 'keyVersion')::integer, display_mac_key_version
        )
      )
    ) then raise exception using errcode = 'P0001', message = 'invalid_key_state'; end if;
    if p_scope <> 'create_tag' then
      select * into tag_row from public.tags
      where user_id = p_owner_id and id = p_resource_id for update;
      if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
      if tag_row.current_revision <> p_expected_revision then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    elsif p_expected_revision <> 0 then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  end if;

  perform private.consume_content_key_reservations(
    p_owner_id, reservation_values, 'encrypted_taxonomy_command',
    p_idempotency_key
  );
  begin
    if p_scope = 'create_space' then
      insert into public.spaces (
        id, user_id, parent_id, name, slug, sort_key, archived_at,
        current_revision, created_at, updated_at,
        display_envelope, display_key_id, display_key_class,
        display_key_purpose, display_key_version,
        display_mac, display_mac_key_id, display_mac_key_class,
        display_mac_key_purpose, display_mac_key_version
      ) values (
        p_resource_id, p_owner_id, parent_id_value,
        'e-' || lower(p_resource_id), 'e-' || lower(p_resource_id),
        sort_key_value, null, 1, claim_row.occurred_at, claim_row.occurred_at,
        display_cipher_value -> 'envelope', display_cipher_value ->> 'keyId',
        (display_cipher_value ->> 'keyClass')::public.content_key_class,
        (display_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
        (display_cipher_value ->> 'keyVersion')::integer,
        display_mac_value ->> 'mac', display_mac_value ->> 'keyId',
        (display_mac_value ->> 'keyClass')::public.content_key_class,
        (display_mac_value ->> 'keyPurpose')::public.content_key_purpose,
        (display_mac_value ->> 'keyVersion')::integer
      );
    elsif p_scope in ('update_space', 'archive_space') then
      update public.spaces set
        parent_id = parent_id_value,
        sort_key = sort_key_value,
        archived_at = archived_at_value,
        current_revision = result_revision_value,
        updated_at = claim_row.occurred_at,
        display_envelope = display_cipher_value -> 'envelope',
        display_key_id = display_cipher_value ->> 'keyId',
        display_key_class = (display_cipher_value ->> 'keyClass')::public.content_key_class,
        display_key_purpose = (display_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
        display_key_version = (display_cipher_value ->> 'keyVersion')::integer,
        display_mac = display_mac_value ->> 'mac',
        display_mac_key_id = display_mac_value ->> 'keyId',
        display_mac_key_class = (display_mac_value ->> 'keyClass')::public.content_key_class,
        display_mac_key_purpose = (display_mac_value ->> 'keyPurpose')::public.content_key_purpose,
        display_mac_key_version = (display_mac_value ->> 'keyVersion')::integer
      where user_id = p_owner_id and id = p_resource_id;
    elsif p_scope = 'create_tag' then
      insert into public.tags (
        id, user_id, name, current_revision, created_at, updated_at,
        display_envelope, display_key_id, display_key_class,
        display_key_purpose, display_key_version,
        display_mac, display_mac_key_id, display_mac_key_class,
        display_mac_key_purpose, display_mac_key_version
      ) values (
        p_resource_id, p_owner_id, 'e-' || lower(p_resource_id), 1,
        claim_row.occurred_at, claim_row.occurred_at,
        display_cipher_value -> 'envelope', display_cipher_value ->> 'keyId',
        (display_cipher_value ->> 'keyClass')::public.content_key_class,
        (display_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
        (display_cipher_value ->> 'keyVersion')::integer,
        display_mac_value ->> 'mac', display_mac_value ->> 'keyId',
        (display_mac_value ->> 'keyClass')::public.content_key_class,
        (display_mac_value ->> 'keyPurpose')::public.content_key_purpose,
        (display_mac_value ->> 'keyVersion')::integer
      );
    elsif p_scope = 'update_tag' then
      update public.tags set
        current_revision = result_revision_value,
        updated_at = claim_row.occurred_at,
        display_envelope = display_cipher_value -> 'envelope',
        display_key_id = display_cipher_value ->> 'keyId',
        display_key_class = (display_cipher_value ->> 'keyClass')::public.content_key_class,
        display_key_purpose = (display_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
        display_key_version = (display_cipher_value ->> 'keyVersion')::integer,
        display_mac = display_mac_value ->> 'mac',
        display_mac_key_id = display_mac_value ->> 'keyId',
        display_mac_key_class = (display_mac_value ->> 'keyClass')::public.content_key_class,
        display_mac_key_purpose = (display_mac_value ->> 'keyPurpose')::public.content_key_purpose,
        display_mac_key_version = (display_mac_value ->> 'keyVersion')::integer
      where user_id = p_owner_id and id = p_resource_id;
    else
      delete from public.tags
      where user_id = p_owner_id and id = p_resource_id;
      delete from public.content_encryption_verifications
      where user_id = p_owner_id and surface = 'tag_display'
        and resource_id = p_resource_id;
    end if;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'conflict_requires_review';
  end;

  if p_scope <> 'delete_tag' then
    perform private.record_content_encryption_verification(
      p_owner_id,
      case when p_scope like '%_space' then 'space_display' else 'tag_display' end,
      p_resource_id, result_revision_value,
      display_cipher_value -> 'envelope', display_verification_value
    );
  end if;
  perform private.finish_encrypted_taxonomy_write(
    claim_row, request_mac_value, response_cipher_value,
    response_verification_value, result_revision_value
  );
  update public.content_encryption_rollouts set
    encrypted_object_count = encrypted_object_count
      + case when p_scope = 'delete_tag' then 1 else 2 end,
    verified_object_count = verified_object_count
      + case when p_scope = 'delete_tag' then 1 else 2 end
  where user_id = p_owner_id;
  perform private.emit_user_event(
    p_owner_id, case when p_scope like '%_space' then 'space' else 'tag' end,
    p_resource_id
  );
  return private.encrypted_taxonomy_response(claim_row, false);
exception when invalid_text_representation or datetime_field_overflow
  or numeric_value_out_of_range
then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

revoke execute on function private.consume_content_key_reservations(
  uuid, jsonb, text, text
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.encrypted_taxonomy_claim_projection(
  public.encrypted_taxonomy_write_claims
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.encrypted_taxonomy_response(
  public.encrypted_taxonomy_write_claims, boolean
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.finish_encrypted_taxonomy_write(
  public.encrypted_taxonomy_write_claims, jsonb, jsonb, jsonb, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.preserve_taxonomy_command_timestamp()
from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;

revoke execute on function public.commit_encrypted_taxonomy_write(
  uuid, text, text, text, integer, jsonb
) from public, anon, authenticated,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.commit_encrypted_taxonomy_write(
  uuid, text, text, text, integer, jsonb
) to service_role;

create or replace function public.get_encrypted_taxonomy_write_claim(
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
  claim_row public.encrypted_taxonomy_write_claims%rowtype;
  encrypted_response jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in (
      'create_space', 'update_space', 'archive_space',
      'create_tag', 'update_tag', 'delete_tag'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into claim_row
  from public.encrypted_taxonomy_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then return jsonb_build_object('found', false); end if;
  if claim_row.scope <> p_scope then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if not exists (
    select 1 from public.user_content_keys
    where user_id = claim_row.user_id
      and key_id = claim_row.request_mac_key_id
      and key_class = claim_row.request_mac_key_class
      and key_purpose = claim_row.request_mac_key_purpose
      and key_version = claim_row.request_mac_key_version
      and state in ('active', 'retired')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  if claim_row.completed_at is not null then
    select private.encrypted_cipher_projection(
      response_envelope, response_key_id, response_key_class,
      response_key_purpose, response_key_version
    ) into encrypted_response
    from public.api_idempotency_records
    where user_id = p_owner_id and idempotency_key = p_idempotency_key;
    if encrypted_response is null then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
  end if;
  return jsonb_build_object('found', true)
    || private.encrypted_taxonomy_claim_projection(claim_row)
    || jsonb_build_object('encryptedResponse', encrypted_response);
end;
$$;

create or replace function public.prepare_encrypted_taxonomy_write(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text,
  p_resource_id text,
  p_expected_revision integer,
  p_request_mac jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_taxonomy_write_claims%rowtype;
  encrypted_response jsonb;
  current_revision_value integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in (
      'create_space', 'update_space', 'archive_space',
      'create_tag', 'update_tag', 'delete_tag'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_request_mac) <> 'object'
    or (
      p_scope in ('create_space', 'create_tag')
      and (p_resource_id is not null or p_expected_revision <> 0)
    )
    or (
      p_scope not in ('create_space', 'create_tag')
      and (p_resource_id is null or p_expected_revision < 1)
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  select * into claim_row
  from public.encrypted_taxonomy_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if claim_row.scope <> p_scope
      or claim_row.expected_revision <> p_expected_revision
      or (p_resource_id is not null and claim_row.resource_id <> p_resource_id)
      or not private.valid_encrypted_write_mac(
        p_request_mac, p_owner_id, 'private_manual', true
      )
      or p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
      or p_request_mac ->> 'keyClass' <> claim_row.request_mac_key_class::text
      or p_request_mac ->> 'keyPurpose' <> claim_row.request_mac_key_purpose::text
      or (p_request_mac ->> 'keyVersion')::integer
        <> claim_row.request_mac_key_version
      or p_request_mac ->> 'mac' <> claim_row.request_mac
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if claim_row.completed_at is not null then
      select private.encrypted_cipher_projection(
        response_envelope, response_key_id, response_key_class,
        response_key_purpose, response_key_version
      ) into encrypted_response
      from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key;
    end if;
    return private.encrypted_taxonomy_claim_projection(claim_row)
      || jsonb_build_object(
        'encryptedResponse', encrypted_response, 'replayed', true
      );
  end if;

  if exists (
      select 1 from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in ('dual_write', 'encrypted_read', 'encrypted_only', 'contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  if p_scope in ('create_space', 'create_tag') then
    claim_row.resource_id := public.new_entity_id(
      case when p_scope = 'create_space' then 'spc' else 'tag' end
    );
  elsif p_scope in ('update_space', 'archive_space') then
    if p_resource_id !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$' then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    select current_revision into current_revision_value
    from public.spaces
    where user_id = p_owner_id and id = p_resource_id
    for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    if current_revision_value <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    claim_row.resource_id := p_resource_id;
  else
    if p_resource_id !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$' then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    select current_revision into current_revision_value
    from public.tags
    where user_id = p_owner_id and id = p_resource_id
    for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    if current_revision_value <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    claim_row.resource_id := p_resource_id;
  end if;
  if not private.valid_encrypted_write_mac(
    p_request_mac, p_owner_id, 'private_manual', false
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_request_mac_key';
  end if;

  insert into public.encrypted_taxonomy_write_claims (
    user_id, idempotency_key, scope, resource_id, expected_revision,
    request_mac_key_id, request_mac_key_class, request_mac_key_purpose,
    request_mac_key_version, request_mac
  ) values (
    p_owner_id, p_idempotency_key, p_scope, claim_row.resource_id,
    p_expected_revision, p_request_mac ->> 'keyId',
    (p_request_mac ->> 'keyClass')::public.content_key_class,
    (p_request_mac ->> 'keyPurpose')::public.content_key_purpose,
    (p_request_mac ->> 'keyVersion')::integer, p_request_mac ->> 'mac'
  ) returning * into claim_row;
  return private.encrypted_taxonomy_claim_projection(claim_row)
    || jsonb_build_object('encryptedResponse', null, 'replayed', false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

revoke execute on function public.get_encrypted_taxonomy_write_claim(
  uuid, text, text
) from public, anon, authenticated,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.prepare_encrypted_taxonomy_write(
  uuid, text, text, text, integer, jsonb
) from public, anon, authenticated,
  unfiled_index_worker, unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.get_encrypted_taxonomy_write_claim(
  uuid, text, text
) to service_role;
grant execute on function public.prepare_encrypted_taxonomy_write(
  uuid, text, text, text, integer, jsonb
) to service_role;
