-- Milestone C.5d-5: atomic encrypted multi-note capture undo.
--
-- Plaintext is opened and validated by the short-lived managed web custody
-- scope. PostgreSQL receives the exact next encrypted aggregates, validates
-- their operational coordinates, locks every affected note in one global
-- order, and commits all inverse writes plus the capture tombstone as one
-- transaction. This capability is intentionally unavailable before the
-- encrypted-only cutover because only that state guarantees legacy columns
-- are scrubbed by the write triggers.

create or replace function private.encrypted_capture_undo_cipher_values(
  owner_id uuid,
  idempotency_key_value text,
  expected_response_class public.content_key_class,
  command_value jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  write_value jsonb;
  note_id_value text;
  target_mutation_id_value text;
  revision_id_value text;
  mutation_id_value text;
  expected_revision_value integer;
  source_privacy_value public.privacy_mode;
  target_privacy_value public.privacy_mode;
  history_class_value public.content_key_class;
  cipher_values jsonb;
  reservation_ids text[] := array[]::text[];
  reservation_id_value text;
begin
  if owner_id is null
    or idempotency_key_value is null
    or expected_response_class is null
    or jsonb_typeof(command_value) <> 'object'
    or jsonb_typeof(command_value -> 'responseCipher') <> 'object'
    or jsonb_typeof(command_value -> 'undoWrites') <> 'array'
    or jsonb_array_length(command_value -> 'undoWrites') not between 1 and 16
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if not private.valid_encrypted_write_cipher(
    command_value -> 'responseCipher', owner_id,
    'idempotency:' || idempotency_key_value, 1,
    'idempotency_response', expected_response_class
  ) then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  cipher_values := jsonb_build_array(command_value -> 'responseCipher');
  reservation_ids := array_append(
    reservation_ids, command_value #>> '{responseCipher,reservationId}'
  );

  for write_value in
    select value
    from jsonb_array_elements(command_value -> 'undoWrites')
    order by value ->> 'noteId'
  loop
    if not private.jsonb_has_exact_keys(write_value, array[
      'noteId', 'targetMutationId', 'expectedRevision', 'sourcePrivacy',
      'expectedCurrentCipher', 'expectedMutationCipher', 'noteState',
      'noteCipher', 'revision', 'mutation', 'verification'
    ])
      or jsonb_typeof(write_value -> 'noteId') <> 'string'
      or jsonb_typeof(write_value -> 'targetMutationId') <> 'string'
      or jsonb_typeof(write_value -> 'expectedRevision') <> 'number'
      or jsonb_typeof(write_value -> 'sourcePrivacy') <> 'string'
      or jsonb_typeof(write_value -> 'noteState') <> 'object'
      or jsonb_typeof(write_value -> 'noteCipher') <> 'object'
      or jsonb_typeof(write_value -> 'revision') <> 'object'
      or jsonb_typeof(write_value -> 'mutation') <> 'object'
      or jsonb_typeof(write_value -> 'verification') <> 'object'
      or write_value ->> 'noteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or write_value ->> 'targetMutationId' !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
      or write_value ->> 'expectedRevision' !~ '^[1-9][0-9]{0,9}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    note_id_value := write_value ->> 'noteId';
    target_mutation_id_value := write_value ->> 'targetMutationId';
    expected_revision_value := (write_value ->> 'expectedRevision')::integer;
    source_privacy_value :=
      (write_value ->> 'sourcePrivacy')::public.privacy_mode;
    target_privacy_value :=
      (write_value #>> '{noteState,privacy}')::public.privacy_mode;
    history_class_value := case
      when source_privacy_value = 'private_manual'
        or target_privacy_value = 'private_manual'
      then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class
    end;
    revision_id_value := write_value #>> '{revision,id}';
    mutation_id_value := write_value #>> '{mutation,id}';
    if revision_id_value !~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'
      or mutation_id_value !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
      or mutation_id_value = target_mutation_id_value
      or not private.valid_encrypted_write_cipher(
        write_value -> 'noteCipher', owner_id, note_id_value,
        expected_revision_value + 1, 'note_content',
        target_privacy_value::text::public.content_key_class
      )
      or not private.valid_encrypted_write_cipher(
        write_value #> '{revision,cipher}', owner_id, revision_id_value,
        expected_revision_value + 1, 'note_revision', history_class_value
      )
      or not private.valid_encrypted_write_cipher(
        write_value #> '{mutation,cipher}', owner_id, mutation_id_value,
        expected_revision_value + 1, 'note_mutation', history_class_value
      )
    then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    foreach reservation_id_value in array array[
      write_value #>> '{noteCipher,reservationId}',
      write_value #>> '{revision,cipher,reservationId}',
      write_value #>> '{mutation,cipher,reservationId}'
    ] loop
      if reservation_id_value is null
        or reservation_id_value = any(reservation_ids)
      then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      reservation_ids := array_append(reservation_ids, reservation_id_value);
    end loop;
    cipher_values := cipher_values || jsonb_build_array(
      write_value -> 'noteCipher',
      write_value #> '{revision,cipher}',
      write_value #> '{mutation,cipher}'
    );
  end loop;
  return cipher_values;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.delete_encrypted_capture_with_undo(
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
  receipt_row public.capture_receipts%rowtype;
  note_row public.notes%rowtype;
  target_mutation_row public.note_mutations%rowtype;
  write_value jsonb;
  operation_value jsonb;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_mac_value jsonb;
  cipher_values jsonb;
  occurred_at_value timestamptz;
  expected_class public.content_key_class;
  source_privacy_value public.privacy_mode;
  target_privacy_value public.privacy_mode;
  history_class_value public.content_key_class;
  note_type_value public.note_type;
  source_value public.revision_source;
  expected_revision_value integer;
  new_revision_value integer;
  note_id_value text;
  target_mutation_id_value text;
  revision_id_value text;
  mutation_id_value text;
  note_mutation_idempotency_value text;
  supplied_note_ids jsonb;
  live_note_ids jsonb;
  linked_note_count integer;
  write_count integer;
  locked_note_count integer := 0;
  locked_mutation_count integer := 0;
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
    or pg_column_size(p_command) > 8388608
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_mac_value := p_command -> 'requestMac';

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  -- The owner rollout advisory must precede even a replay-row lock. Scrub and
  -- retention hold this advisory before touching idempotency rows, so taking
  -- the replay row first would recreate a row/advisory deadlock cycle.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
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

  if not private.jsonb_has_exact_keys(p_command, array[
      'occurredAt', 'removeInsertedContent', 'requestMac', 'responseCipher',
      'responseVerificationMac', 'sourceNoteIds', 'receipt', 'undoWrites'
    ])
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or p_command -> 'removeInsertedContent' <> 'true'::jsonb
    or jsonb_typeof(p_command -> 'sourceNoteIds') <> 'array'
    or jsonb_array_length(p_command -> 'sourceNoteIds') not between 1 and 16
    or jsonb_typeof(p_command -> 'undoWrites') <> 'array'
    or jsonb_array_length(p_command -> 'undoWrites')
      <> jsonb_array_length(p_command -> 'sourceNoteIds')
    or not private.jsonb_has_exact_keys(
      p_command -> 'receipt', array['recordVersion', 'cipher']
    )
    or jsonb_typeof(p_command #> '{receipt,recordVersion}') <> 'number'
    or p_command #>> '{receipt,recordVersion}' !~ '^[1-9][0-9]{0,9}$'
    or jsonb_typeof(p_command #> '{receipt,cipher}') <> 'object'
    or exists (
      select 1
      from public.encrypted_note_write_claims
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

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb), count(*)
  into supplied_note_ids, write_count
  from jsonb_array_elements_text(p_command -> 'sourceNoteIds') as listed(value);
  if supplied_note_ids <> p_command -> 'sourceNoteIds'
    or exists (
      select 1
      from jsonb_array_elements(p_command -> 'sourceNoteIds') as item
      where jsonb_typeof(item) <> 'string'
        or item #>> '{}' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    )
    or (
      select count(*) <> count(distinct item #>> '{}')
      from jsonb_array_elements(p_command -> 'sourceNoteIds') as item
    )
    or supplied_note_ids <> (
      select jsonb_agg(value -> 'noteId' order by value ->> 'noteId')
      from jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
    )
    or (
      select count(*) <> count(distinct value ->> 'targetMutationId')
      from jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
    )
    or (
      select count(*) <> count(distinct value #>> '{revision,id}')
      from jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
    )
    or (
      select count(*) <> count(distinct value #>> '{mutation,id}')
      from jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- Validate the entire command shape and every new envelope before taking
  -- mutable content locks. This helper also proves every reservation ID is
  -- unique across the response and all 3N note aggregates.
  expected_class := (request_mac_value ->> 'keyClass')::public.content_key_class;
  cipher_values := private.encrypted_capture_undo_cipher_values(
    p_owner_id, p_idempotency_key, expected_class, p_command
  );
  for write_value in
    select value
    from jsonb_array_elements(p_command -> 'undoWrites')
    order by value ->> 'noteId'
  loop
    if not private.valid_encrypted_note_state(write_value -> 'noteState')
      -- PostgREST and database statement logs can retain function arguments.
      -- Only deterministic, type-valid operational projections may leave the
      -- service; all user-authored note and mutation content stays encrypted.
      or write_value #>> '{noteState,title}'
        <> 'e-' || lower(write_value ->> 'noteId')
      or write_value #>> '{noteState,bodyMarkdown}' <> ''
      or write_value #> '{noteState,structuredData}'
        <> private.encrypted_only_note_sentinel(
          (write_value #>> '{noteState,type}')::public.note_type
        )
      or not private.jsonb_has_exact_keys(write_value -> 'expectedCurrentCipher', array[
        'envelope', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'expectedMutationCipher', array[
        'envelope', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'revision', array[
        'id', 'source', 'actor', 'cipher', 'mac'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'mutation', array[
        'id', 'decisionId', 'undoTargetMutationId', 'operations', 'inverse',
        'cipher'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'verification', array[
        'noteContent', 'noteMutation'
      ])
      or write_value #>> '{revision,source}' <> 'undo'
      or jsonb_typeof(write_value #> '{revision,actor}') <> 'string'
      or write_value #>> '{revision,actor}'
        !~ '^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      or jsonb_typeof(write_value #> '{mutation,decisionId}') <> 'null'
      or write_value #>> '{mutation,undoTargetMutationId}'
        <> write_value ->> 'targetMutationId'
      or jsonb_typeof(write_value #> '{mutation,operations}') <> 'array'
      or jsonb_array_length(write_value #> '{mutation,operations}')
        not between 1 and 20
      or write_value #> '{mutation,operations}' <> jsonb_build_array(
        jsonb_build_object(
          'type', 'set_privacy',
          'privacy', write_value #>> '{noteState,privacy}'
        )
      )
      or jsonb_typeof(write_value #> '{mutation,inverse}') <> 'array'
      or jsonb_array_length(write_value #> '{mutation,inverse}')
        not between 1 and 20
      or write_value #> '{mutation,inverse}' <> jsonb_build_array(
        jsonb_build_object(
          'type', 'set_privacy',
          'privacy', write_value #>> '{noteState,privacy}'
        )
      )
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    for operation_value in
      select value
      from jsonb_array_elements(write_value #> '{mutation,operations}')
      union all
      select value
      from jsonb_array_elements(write_value #> '{mutation,inverse}')
    loop
      if not private.valid_user_operation_shape(operation_value) then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
    end loop;
  end loop;

  if not exists (
    select 1
    from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('encrypted_only', 'contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  -- Match the established workflow lock order before the sorted note set.
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
  expected_class := capture_row.privacy::text::public.content_key_class;
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_mac_value := p_command -> 'responseVerificationMac';
  if not private.valid_encrypted_write_mac(
      request_mac_value, p_owner_id, expected_class, false
    )
    or not private.valid_encrypted_write_mac(
      response_verification_mac_value, p_owner_id, expected_class, false
    )
    or response_cipher_value <> cipher_values -> 0
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  select * into receipt_row
  from public.capture_receipts
  where user_id = p_owner_id and capture_id = p_capture_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if receipt_row.receipt_revision
      <> (p_command #>> '{receipt,recordVersion}')::integer
    or receipt_row.job_id <> job_row.id
    or receipt_row.outcome not in ('created_note', 'added_to_note')
    or receipt_row.decision_id is null
    or receipt_row.destination_note_id is null
    or receipt_row.mutation_id is null
    or receipt_row.receipt_key_class <> expected_class
    or private.encrypted_cipher_projection(
      receipt_row.receipt_envelope, receipt_row.receipt_key_id,
      receipt_row.receipt_key_class, receipt_row.receipt_key_purpose,
      receipt_row.receipt_key_version
    ) <> p_command #> '{receipt,cipher}'
    or not exists (
      select 1
      from jsonb_array_elements(p_command -> 'undoWrites') as primary_write(value)
      where primary_write.value ->> 'noteId' = receipt_row.destination_note_id
        and primary_write.value ->> 'targetMutationId' = receipt_row.mutation_id
    )
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  select coalesce(jsonb_agg(note_id order by note_id), '[]'::jsonb), count(*)
  into live_note_ids, linked_note_count
  from public.capture_note_links
  where user_id = p_owner_id and capture_id = p_capture_id;
  if linked_note_count <> write_count or live_note_ids <> supplied_note_ids
    or exists (
      select 1
      from jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
      where not exists (
        select 1 from public.capture_note_links as link
        where link.user_id = p_owner_id
          and link.capture_id = p_capture_id
          and link.note_id = writes.value ->> 'noteId'
          and link.mutation_id = writes.value ->> 'targetMutationId'
      )
    )
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  -- Lock all notes before any mutation, with a deterministic order shared by
  -- every multi-note caller. Only after that set is complete are target
  -- mutation rows locked in the same note order.
  for note_row in
    select note.*
    from public.notes as note
    join jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
      on writes.value ->> 'noteId' = note.id
    where note.user_id = p_owner_id
    order by note.id
    for update of note
  loop
    locked_note_count := locked_note_count + 1;
  end loop;
  if locked_note_count <> write_count then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  for target_mutation_row in
    select mutation.*
    from public.note_mutations as mutation
    join jsonb_array_elements(p_command -> 'undoWrites') as writes(value)
      on writes.value ->> 'targetMutationId' = mutation.id
    where mutation.user_id = p_owner_id
    order by writes.value ->> 'noteId'
    for update of mutation
  loop
    locked_mutation_count := locked_mutation_count + 1;
  end loop;
  if locked_mutation_count <> write_count then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  -- CAS every target and validate all relation/key/MAC coordinates before the
  -- first write. A stale one-of-many target therefore changes nothing.
  for write_value in
    select value
    from jsonb_array_elements(p_command -> 'undoWrites')
    order by value ->> 'noteId'
  loop
    note_id_value := write_value ->> 'noteId';
    target_mutation_id_value := write_value ->> 'targetMutationId';
    expected_revision_value := (write_value ->> 'expectedRevision')::integer;
    new_revision_value := expected_revision_value + 1;
    revision_id_value := write_value #>> '{revision,id}';
    mutation_id_value := write_value #>> '{mutation,id}';
    source_privacy_value :=
      (write_value ->> 'sourcePrivacy')::public.privacy_mode;
    target_privacy_value :=
      (write_value #>> '{noteState,privacy}')::public.privacy_mode;
    history_class_value := case
      when source_privacy_value = 'private_manual'
        or target_privacy_value = 'private_manual'
      then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class
    end;
    note_type_value :=
      (write_value #>> '{noteState,type}')::public.note_type;
    source_value :=
      (write_value #>> '{revision,source}')::public.revision_source;

    select * into note_row
    from public.notes
    where user_id = p_owner_id and id = note_id_value;
    select * into target_mutation_row
    from public.note_mutations
    where user_id = p_owner_id and id = target_mutation_id_value;
    if note_row.current_revision <> expected_revision_value
      or note_row.privacy <> source_privacy_value
      or target_mutation_row.note_id <> note_id_value
      or target_mutation_row.after_revision <> expected_revision_value
      or target_mutation_row.undone_at is not null
      or private.encrypted_cipher_projection(
        note_row.content_envelope, note_row.content_key_id,
        note_row.content_key_class, note_row.content_key_purpose,
        note_row.content_key_version
      ) <> write_value -> 'expectedCurrentCipher'
      or private.encrypted_cipher_projection(
        target_mutation_row.mutation_envelope,
        target_mutation_row.mutation_key_id,
        target_mutation_row.mutation_key_class,
        target_mutation_row.mutation_key_purpose,
        target_mutation_row.mutation_key_version
      ) <> write_value -> 'expectedMutationCipher'
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    if exists (
        select 1 from public.notes
        where id in (revision_id_value, mutation_id_value)
      )
      or exists (select 1 from public.note_revisions where id = revision_id_value)
      or exists (select 1 from public.note_mutations where id = mutation_id_value)
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    note_mutation_idempotency_value :=
      'internal.encrypted_capture_undo.v1:' || p_idempotency_key || ':' || note_id_value;
    if exists (
      select 1 from public.note_mutations
      where user_id = p_owner_id
        and idempotency_key = note_mutation_idempotency_value
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if not private.valid_encrypted_write_mac(
        write_value #> '{revision,mac}', p_owner_id,
        history_class_value, false
      )
      or not private.valid_encrypted_write_mac(
        write_value #> '{verification,noteContent}', p_owner_id,
        target_privacy_value::text::public.content_key_class, false
      )
      or not private.valid_encrypted_write_mac(
        write_value #> '{verification,noteMutation}', p_owner_id,
        history_class_value, false
      )
    then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    perform private.assert_encrypted_note_relationships(
      p_owner_id, note_id_value, write_value -> 'noteState'
    );
  end loop;

  perform private.consume_content_key_reservations(
    p_owner_id, cipher_values,
    'encrypted_capture_command', p_idempotency_key
  );

  for write_value in
    select value
    from jsonb_array_elements(p_command -> 'undoWrites')
    order by value ->> 'noteId'
  loop
    note_id_value := write_value ->> 'noteId';
    target_mutation_id_value := write_value ->> 'targetMutationId';
    expected_revision_value := (write_value ->> 'expectedRevision')::integer;
    new_revision_value := expected_revision_value + 1;
    revision_id_value := write_value #>> '{revision,id}';
    mutation_id_value := write_value #>> '{mutation,id}';
    source_privacy_value :=
      (write_value ->> 'sourcePrivacy')::public.privacy_mode;
    target_privacy_value :=
      (write_value #>> '{noteState,privacy}')::public.privacy_mode;
    history_class_value := case
      when source_privacy_value = 'private_manual'
        or target_privacy_value = 'private_manual'
      then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class
    end;
    note_type_value :=
      (write_value #>> '{noteState,type}')::public.note_type;
    source_value :=
      (write_value #>> '{revision,source}')::public.revision_source;
    note_mutation_idempotency_value :=
      'internal.encrypted_capture_undo.v1:' || p_idempotency_key || ':' || note_id_value;

    update public.notes
    set
      space_id = nullif(write_value #>> '{noteState,spaceId}', ''),
      type = note_type_value,
      title = write_value #>> '{noteState,title}',
      body_markdown = write_value #>> '{noteState,bodyMarkdown}',
      structured_data = write_value #> '{noteState,structuredData}',
      current_revision = new_revision_value,
      daily_date = nullif(write_value #>> '{noteState,dailyDate}', '')::date,
      is_open = (write_value #>> '{noteState,isOpen}')::boolean,
      pinned_at = nullif(write_value #>> '{noteState,pinnedAt}', '')::timestamptz,
      privacy = target_privacy_value,
      archived_at = nullif(write_value #>> '{noteState,archivedAt}', '')::timestamptz,
      deleted_at = nullif(write_value #>> '{noteState,deletedAt}', '')::timestamptz,
      content_envelope = write_value #> '{noteCipher,envelope}',
      content_key_id = write_value #>> '{noteCipher,keyId}',
      content_key_class =
        (write_value #>> '{noteCipher,keyClass}')::public.content_key_class,
      content_key_purpose =
        (write_value #>> '{noteCipher,keyPurpose}')::public.content_key_purpose,
      content_key_version =
        (write_value #>> '{noteCipher,keyVersion}')::integer,
      updated_at = occurred_at_value
    where user_id = p_owner_id and id = note_id_value
      and current_revision = expected_revision_value;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;

    update public.note_mutations
    set undone_at = occurred_at_value
    where user_id = p_owner_id
      and id = target_mutation_id_value
      and note_id = note_id_value
      and after_revision = expected_revision_value
      and undone_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;

    insert into public.note_mutations (
      id, user_id, decision_id, note_id, idempotency_key, before_revision,
      after_revision, operations, inverse, mutation_envelope, mutation_key_id,
      mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
    ) values (
      mutation_id_value, p_owner_id, null, note_id_value,
      note_mutation_idempotency_value, expected_revision_value,
      new_revision_value, write_value #> '{mutation,operations}',
      write_value #> '{mutation,inverse}',
      write_value #> '{mutation,cipher,envelope}',
      write_value #>> '{mutation,cipher,keyId}',
      (write_value #>> '{mutation,cipher,keyClass}')::public.content_key_class,
      (write_value #>> '{mutation,cipher,keyPurpose}')::public.content_key_purpose,
      (write_value #>> '{mutation,cipher,keyVersion}')::integer,
      occurred_at_value
    );

    perform private.restore_note_relations(
      p_owner_id, note_id_value,
      jsonb_build_object(
        'tagIds', write_value #> '{noteState,tagIds}',
        'links', write_value #> '{noteState,links}'
      ),
      mutation_id_value
    );

    insert into public.note_revisions (
      id, note_id, user_id, revision, source, space_id, type, title,
      body_markdown, structured_data, is_open, pinned_at, privacy, archived_at,
      deleted_at, tag_ids, links, content_hash, actor, mutation_id,
      snapshot_envelope, snapshot_key_id, snapshot_key_class,
      snapshot_key_purpose, snapshot_key_version, snapshot_mac,
      snapshot_mac_key_id, snapshot_mac_key_class, snapshot_mac_key_purpose,
      snapshot_mac_key_version, created_at
    ) values (
      revision_id_value, note_id_value, p_owner_id, new_revision_value,
      source_value, nullif(write_value #>> '{noteState,spaceId}', ''),
      note_type_value, write_value #>> '{noteState,title}',
      write_value #>> '{noteState,bodyMarkdown}',
      write_value #> '{noteState,structuredData}',
      (write_value #>> '{noteState,isOpen}')::boolean,
      nullif(write_value #>> '{noteState,pinnedAt}', '')::timestamptz,
      target_privacy_value,
      nullif(write_value #>> '{noteState,archivedAt}', '')::timestamptz,
      nullif(write_value #>> '{noteState,deletedAt}', '')::timestamptz,
      write_value #> '{noteState,tagIds}',
      write_value #> '{noteState,links}',
      write_value #>> '{revision,mac,mac}',
      write_value #>> '{revision,actor}', mutation_id_value,
      write_value #> '{revision,cipher,envelope}',
      write_value #>> '{revision,cipher,keyId}',
      (write_value #>> '{revision,cipher,keyClass}')::public.content_key_class,
      (write_value #>> '{revision,cipher,keyPurpose}')::public.content_key_purpose,
      (write_value #>> '{revision,cipher,keyVersion}')::integer,
      write_value #>> '{revision,mac,mac}',
      write_value #>> '{revision,mac,keyId}',
      (write_value #>> '{revision,mac,keyClass}')::public.content_key_class,
      (write_value #>> '{revision,mac,keyPurpose}')::public.content_key_purpose,
      (write_value #>> '{revision,mac,keyVersion}')::integer,
      occurred_at_value
    );

    perform private.record_content_encryption_verification(
      p_owner_id, 'note_revision', revision_id_value, new_revision_value,
      write_value #> '{revision,cipher,envelope}',
      write_value #> '{revision,mac}'
    );
    perform private.record_content_encryption_verification(
      p_owner_id, 'note_content', note_id_value, new_revision_value,
      write_value #> '{noteCipher,envelope}',
      write_value #> '{verification,noteContent}'
    );
    perform private.record_content_encryption_verification(
      p_owner_id, 'note_mutation', mutation_id_value, new_revision_value,
      write_value #> '{mutation,cipher,envelope}',
      write_value #> '{verification,noteMutation}'
    );
    perform private.emit_user_event(p_owner_id, 'note', note_id_value);
    perform private.emit_user_event(
      p_owner_id, 'note_revision', revision_id_value
    );
    perform private.emit_user_event(
      p_owner_id, 'note_mutation', mutation_id_value
    );
    perform private.enqueue_encrypted_note_index_jobs(
      p_owner_id, note_id_value, new_revision_value,
      target_privacy_value, false
    );
  end loop;

  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + (write_count * 3),
    verified_object_count = verified_object_count + (write_count * 3)
  where user_id = p_owner_id;

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
    raw_text = '[deleted]', status = 'deleted',
    deleted_at = occurred_at_value, content_envelope = null,
    content_fingerprint = null, content_length = null,
    content_key_id = null, content_key_class = null,
    content_key_purpose = null, content_key_version = null,
    fingerprint_key_id = null, fingerprint_key_class = null,
    fingerprint_key_purpose = null, fingerprint_key_version = null
  where id = p_capture_id and user_id = p_owner_id;

  delete from public.api_idempotency_records
  where user_id = p_owner_id and scope = 'retry_capture'
    and (
      (request_resource_type = 'capture'
        and request_resource_id = p_capture_id)
      or response_json #>> '{capture,id}' = p_capture_id
    );
  if job_row.state in ('created', 'running', 'awaiting_retry') then
    update public.organization_jobs
    set
      state = 'failed', completed_at = occurred_at_value,
      error_code = 'not_found', lease_owner = null, lease_token = null,
      lease_expires_at = null, last_heartbeat_at = null,
      last_transition_lease_token = case when job_row.state = 'running'
        then job_row.lease_token else null end,
      last_transition_action = case when job_row.state = 'running'
        then 'failed' else null end,
      last_transition_request_hash = case when job_row.state = 'running'
        then private.request_hash(jsonb_build_object(
          'domain', 'unfiled.encrypted-capture-delete.v1',
          'captureId', p_capture_id, 'leaseToken', job_row.lease_token
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

revoke execute on function private.encrypted_capture_undo_cipher_values(
  uuid, text, public.content_key_class, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.consume_replayed_capture_command_reservation(
  uuid, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.delete_encrypted_capture_with_undo(
  uuid, text, text, jsonb
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.delete_encrypted_capture_with_undo(
  uuid, text, text, jsonb
) to service_role;

-- A losing concurrent first caller already reserved and sealed every object.
-- Once its request MAC matches the stored winner, consume all of those
-- otherwise-abandoned reservations without replacing winner ciphertext.
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
  cipher_values jsonb;
begin
  if jsonb_typeof(command_value -> 'responseCipher') <> 'object' then
    return;
  end if;
  select response_key_class into expected_class
  from public.api_idempotency_records
  where user_id = owner_id and idempotency_key = idempotency_key_value;
  if not found then return; end if;

  if jsonb_typeof(command_value -> 'undoWrites') = 'array' then
    begin
      cipher_values := private.encrypted_capture_undo_cipher_values(
        owner_id, idempotency_key_value, expected_class, command_value
      );
    exception when others then
      return;
    end;
  else
    if not private.valid_encrypted_write_cipher(
      command_value -> 'responseCipher', owner_id,
      'idempotency:' || idempotency_key_value, 1,
      'idempotency_response', expected_class
    ) then return; end if;
    cipher_values := jsonb_build_array(command_value -> 'responseCipher');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    owner_id::text || ':content-encryption-rollout', 0
  ));
  perform private.consume_content_key_reservations(
    owner_id, cipher_values,
    'encrypted_capture_command', idempotency_key_value
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return;
end;
$$;
