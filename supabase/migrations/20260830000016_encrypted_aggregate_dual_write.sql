-- Milestone C.5b: encrypted aggregate dual-write and encrypted-read boundary.
--
-- This remains an expand migration. Legacy plaintext columns and RPCs are kept
-- for a bounded rollback window, but owners may advance only as far as
-- encrypted_read. encrypted_only and contracted remain C.5d work.

create table public.content_key_operation_reservations (
  user_id uuid not null references auth.users(id) on delete cascade,
  reservation_id uuid not null,
  key_id text not null,
  key_class public.content_key_class not null,
  key_purpose public.content_key_purpose not null
    check (key_purpose = 'object_wrap'),
  key_version integer not null check (key_version >= 1),
  operation_count integer not null check (operation_count between 1 and 100),
  consumed_by_type text check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill'
    )
  ),
  consumed_by_id text check (
    consumed_by_id is null or char_length(consumed_by_id) between 1 and 200
  ),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  primary key (user_id, reservation_id),
  check (
    (consumed_at is null and consumed_by_type is null and consumed_by_id is null)
    or (
      consumed_at is not null
      and consumed_by_type is not null
      and consumed_by_id is not null
    )
  ),
  foreign key (user_id, key_id, key_class, key_purpose, key_version)
    references public.user_content_keys (
      user_id, key_id, key_class, key_purpose, key_version
    )
);
create index content_key_operation_reservations_key
  on public.content_key_operation_reservations (
    user_id, key_id, key_class, key_version, created_at
  );

create table public.encrypted_note_write_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 80
    and btrim(idempotency_key) = idempotency_key
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  scope text not null check (
    scope in ('create_encrypted_note', 'apply_encrypted_note_mutation')
  ),
  note_id text not null check (note_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'),
  expected_revision integer not null check (expected_revision >= 0),
  source_privacy public.privacy_mode,
  target_privacy public.privacy_mode not null,
  history_key_class public.content_key_class not null,
  revision_id text not null check (revision_id ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
  mutation_id text not null check (mutation_id ~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'),
  occurred_at timestamptz not null default date_trunc(
    'milliseconds', clock_timestamp()
  ),
  request_mac_key_id text not null,
  request_mac_key_class public.content_key_class not null,
  request_mac_key_purpose public.content_key_purpose not null
    check (request_mac_key_purpose = 'content_mac'),
  request_mac_key_version integer not null check (request_mac_key_version >= 1),
  request_mac text not null check (request_mac ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  unique (user_id, revision_id),
  unique (user_id, mutation_id),
  check (
    (
      scope = 'create_encrypted_note'
      and expected_revision = 0
      and source_privacy is null
    )
    or (
      scope = 'apply_encrypted_note_mutation'
      and expected_revision >= 1
      and source_privacy is not null
    )
  ),
  check (request_mac_key_class = history_key_class),
  foreign key (
    user_id, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);

create table public.content_encryption_verifications (
  user_id uuid not null references auth.users(id) on delete cascade,
  surface text not null check (surface in (
    'space_display', 'tag_display', 'note_content', 'note_revision',
    'organization_decision', 'note_mutation', 'generated_block',
    'review_item', 'routing_rule', 'organization_mutation_attempt',
    'idempotency_response', 'capture_receipt', 'capture'
  )),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  record_version integer not null check (record_version >= 1),
  envelope_digest text not null check (envelope_digest ~ '^[0-9a-f]{64}$'),
  verification_mac text not null check (verification_mac ~ '^[0-9a-f]{64}$'),
  verification_mac_key_id text not null,
  verification_mac_key_class public.content_key_class not null,
  verification_mac_key_purpose public.content_key_purpose not null
    check (verification_mac_key_purpose = 'content_mac'),
  verification_mac_key_version integer not null check (
    verification_mac_key_version >= 1
  ),
  verified_at timestamptz not null default now(),
  primary key (user_id, surface, resource_id),
  foreign key (
    user_id, verification_mac_key_id, verification_mac_key_class,
    verification_mac_key_purpose, verification_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);
create index content_encryption_verifications_owner_surface
  on public.content_encryption_verifications (user_id, surface, resource_id);

alter table public.content_encryption_rollouts
  add column backfill_completed_at timestamptz,
  add column last_backfill_batch_reference text,
  add column last_backfill_surface text,
  add column last_backfill_resource_id text,
  add column last_backfill_expected_cursor text,
  add column last_backfill_next_cursor text,
  add column last_backfill_encrypted_delta bigint,
  add column last_backfill_verified_delta bigint,
  add column last_backfill_complete boolean,
  add column last_backfill_envelope_digest text,
  add column last_backfill_request_digest text,
  add constraint content_encryption_rollouts_backfill_audit_shape check (
    (
      last_backfill_batch_reference is null
      and last_backfill_surface is null
      and last_backfill_resource_id is null
      and last_backfill_expected_cursor is null
      and last_backfill_next_cursor is null
      and last_backfill_encrypted_delta is null
      and last_backfill_verified_delta is null
      and last_backfill_complete is null
      and last_backfill_envelope_digest is null
      and last_backfill_request_digest is null
    )
    or (
      char_length(last_backfill_batch_reference) between 1 and 120
      and char_length(last_backfill_surface) between 1 and 80
      and char_length(last_backfill_resource_id) between 1 and 200
      and last_backfill_encrypted_delta >= 0
      and last_backfill_verified_delta >= 0
      and last_backfill_verified_delta <= last_backfill_encrypted_delta
      and last_backfill_complete is not null
      and last_backfill_envelope_digest ~ '^[0-9a-f]{64}$'
      and last_backfill_request_digest ~ '^[0-9a-f]{64}$'
    )
  );

alter table public.api_idempotency_records
  add column replay_policy text not null default 'legacy_nonreplayable'
    check (replay_policy in ('legacy_nonreplayable', 'logical_mac')),
  add column request_resource_type text,
  add column request_resource_id text,
  add column response_resource_type text,
  add column response_resource_id text,
  add column response_record_version integer,
  add constraint api_idempotency_encrypted_resource_shape check (
    (
      request_resource_type is null
      and request_resource_id is null
      and response_resource_type is null
      and response_resource_id is null
      and response_record_version is null
    )
    or (
      request_resource_type ~ '^[a-z][a-z0-9_]{0,79}$'
      and char_length(request_resource_id) between 1 and 200
      and response_resource_type ~ '^[a-z][a-z0-9_]{0,79}$'
      and char_length(response_resource_id) between 1 and 200
      and response_record_version >= 1
      and response_envelope is not null
      and (
        (replay_policy = 'logical_mac' and request_mac is not null)
        or (replay_policy = 'legacy_nonreplayable' and request_mac is null)
      )
    )
  );

-- Mutable content surfaces need a monotonic AAD record version. C.5a used a
-- fixed version because it was expansion-only; fixed version 1 cannot safely
-- authenticate a later resolution, replan, retention rewrite, or rule edit.
alter table public.review_items
  add column review_content_revision integer not null default 1
    check (review_content_revision >= 1),
  drop constraint review_items_envelope_shape,
  add constraint review_items_envelope_shape check (
    private.valid_encrypted_field(
      review_envelope, user_id, id, review_content_revision, 'review_item',
      review_key_id, review_key_class, review_key_purpose, review_key_version
    )
  );

alter table public.routing_rules
  add column condition_revision integer not null default 1
    check (condition_revision >= 1),
  drop constraint routing_rules_envelope_shape,
  add constraint routing_rules_envelope_shape check (
    private.valid_encrypted_field(
      condition_envelope, user_id, id, condition_revision, 'routing_rule',
      condition_key_id, condition_key_class, condition_key_purpose,
      condition_key_version
    )
  );

alter table public.organization_mutation_attempts
  add column attempt_content_revision integer not null default 1
    check (attempt_content_revision >= 1),
  drop constraint organization_mutation_attempts_envelope_shape,
  add constraint organization_mutation_attempts_envelope_shape check (
    private.valid_encrypted_field(
      attempt_envelope, user_id, job_id || ':' || note_id,
      attempt_content_revision, 'organization_mutation_attempt',
      attempt_key_id, attempt_key_class, attempt_key_purpose,
      attempt_key_version
    )
  );

alter table public.capture_receipts
  add column receipt_revision integer not null default 1
    check (receipt_revision >= 1),
  drop constraint capture_receipts_envelope_shape,
  add constraint capture_receipts_envelope_shape check (
    private.valid_encrypted_field(
      receipt_envelope, user_id, capture_id, receipt_revision,
      'capture_receipt', receipt_key_id, receipt_key_class,
      receipt_key_purpose, receipt_key_version
    )
  );

alter table public.organization_decisions
  add column decision_content_revision integer not null default 1
    check (decision_content_revision >= 1),
  drop constraint organization_decisions_envelope_shape,
  add constraint organization_decisions_envelope_shape check (
    private.valid_encrypted_field(
      decision_envelope, user_id, id, decision_content_revision,
      'organization_decision', decision_key_id, decision_key_class,
      decision_key_purpose, decision_key_version
    )
  );

-- Values left outside ciphertext are operational metadata, never free-form
-- content. Keep those channels narrow enough that neither a caller nor an
-- organizer can smuggle note text through them.
create or replace function private.valid_safe_reason_codes(codes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select codes is not null
    and cardinality(codes) <= 20
    and not exists (
      select 1 from unnest(codes) as code(value)
      where value is null or value !~ '^[a-z][a-z0-9_]{0,63}$'
    );
$$;

alter table public.captures
  drop constraint captures_device_id_check,
  add constraint captures_device_id_check check (
    device_id = '' or device_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  drop constraint captures_client_timezone_check,
  add constraint captures_client_timezone_check check (
    char_length(client_timezone) between 1 and 64
    and (
      client_timezone = 'UTC'
      or client_timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,3}$'
    )
  );

alter table public.organization_decisions
  add constraint organization_decisions_safe_reason_codes check (
    private.valid_safe_reason_codes(reason_codes)
  );
alter table public.capture_receipts
  add constraint capture_receipts_safe_reason_codes check (
    private.valid_safe_reason_codes(reason_codes)
  );
alter table public.feedback_events
  add constraint feedback_events_safe_reason_code check (
    reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
  );
alter table public.note_revisions
  add constraint note_revisions_safe_actor check (
    actor ~ '^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
  );

comment on column public.profiles.display_name is
  'Account-profile metadata outside the encrypted notes/captures promise; never indexed or supplied to the organizer.';

create or replace function private.set_note_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.role() = 'service_role' then
    -- Encrypted aggregate writes supply the claim timestamp explicitly.
    if new.updated_at is distinct from old.updated_at then
      return new;
    end if;
    -- Envelope-only backfill must not silently change the plaintext snapshot
    -- timestamp that was authenticated by the new envelope.
    if (
      to_jsonb(new) - array[
        'updated_at', 'content_envelope', 'content_key_id',
        'content_key_class', 'content_key_purpose', 'content_key_version'
      ]
    ) = (
      to_jsonb(old) - array[
        'updated_at', 'content_envelope', 'content_key_id',
        'content_key_class', 'content_key_purpose', 'content_key_version'
      ]
    ) then
      return new;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger notes_set_updated_at on public.notes;
create trigger notes_set_updated_at before update on public.notes
for each row execute function private.set_note_updated_at();

alter table public.content_key_operation_reservations enable row level security;
alter table public.content_key_operation_reservations force row level security;
alter table public.encrypted_note_write_claims enable row level security;
alter table public.encrypted_note_write_claims force row level security;
alter table public.content_encryption_verifications enable row level security;
alter table public.content_encryption_verifications force row level security;

revoke all on table public.content_key_operation_reservations
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke all on table public.encrypted_note_write_claims
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke all on table public.content_encryption_verifications
  from public, anon, authenticated, service_role, unfiled_index_worker;

-- All content relations are reached by reviewed owner-scoped capabilities.
-- SECURITY DEFINER functions remain usable for rollback, but service_role can
-- no longer bypass an owner predicate with a direct table query.
alter table public.spaces force row level security;
alter table public.tags force row level security;
alter table public.notes force row level security;
alter table public.note_revisions force row level security;
alter table public.note_mutations force row level security;
alter table public.note_chunks force row level security;
alter table public.organization_decisions force row level security;
alter table public.generated_blocks force row level security;
alter table public.review_items force row level security;
alter table public.routing_rules force row level security;
alter table public.organization_mutation_attempts force row level security;
alter table public.api_idempotency_records force row level security;
alter table public.capture_receipts force row level security;
alter table public.captures force row level security;

revoke all on table public.spaces from service_role;
revoke all on table public.tags from service_role;
revoke all on table public.notes from service_role;
revoke all on table public.note_revisions from service_role;
revoke all on table public.note_mutations from service_role;
revoke all on table public.note_chunks from service_role;
revoke all on table public.organization_decisions from service_role;
revoke all on table public.generated_blocks from service_role;
revoke all on table public.review_items from service_role;
revoke all on table public.routing_rules from service_role;
revoke all on table public.organization_mutation_attempts from service_role;
revoke all on table public.api_idempotency_records from service_role;
revoke all on table public.capture_receipts from service_role;
revoke all on table public.captures from service_role;

create unique index spaces_display_mac_unique_epoch
  on public.spaces (user_id, display_mac_key_id, display_mac)
  where display_mac is not null;
create unique index tags_display_mac_unique_epoch
  on public.tags (user_id, display_mac_key_id, display_mac)
  where display_mac is not null;

create or replace function private.valid_encrypted_write_cipher(
  cipher_value jsonb,
  owner_id uuid,
  resource_id_value text,
  record_version_value integer,
  content_kind_value text,
  expected_class public.content_key_class
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_class_value public.content_key_class;
  key_purpose_value public.content_key_purpose;
  key_version_value integer;
  reservation_value uuid;
begin
  if cipher_value is null
    or jsonb_typeof(cipher_value) <> 'object'
    or cipher_value - array[
      'envelope', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion',
      'reservationId'
    ] <> '{}'::jsonb
    or not cipher_value ?& array[
      'envelope', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion',
      'reservationId'
    ]
    or jsonb_typeof(cipher_value -> 'envelope') <> 'object'
    or jsonb_typeof(cipher_value -> 'keyId') <> 'string'
    or jsonb_typeof(cipher_value -> 'keyClass') <> 'string'
    or jsonb_typeof(cipher_value -> 'keyPurpose') <> 'string'
    or jsonb_typeof(cipher_value -> 'keyVersion') <> 'number'
    or jsonb_typeof(cipher_value -> 'reservationId') <> 'string'
    or cipher_value ->> 'keyVersion' !~ '^[1-9][0-9]{0,8}$'
  then
    return false;
  end if;

  key_class_value := (cipher_value ->> 'keyClass')::public.content_key_class;
  key_purpose_value := (cipher_value ->> 'keyPurpose')::public.content_key_purpose;
  key_version_value := (cipher_value ->> 'keyVersion')::integer;
  reservation_value := (cipher_value ->> 'reservationId')::uuid;

  return key_class_value = expected_class
    and key_purpose_value = 'object_wrap'
    and private.valid_encrypted_field(
      cipher_value -> 'envelope', owner_id, resource_id_value,
      record_version_value, content_kind_value, cipher_value ->> 'keyId',
      key_class_value, key_purpose_value, key_version_value
    )
    and exists (
      select 1
      from public.content_key_operation_reservations as reservation
      where reservation.user_id = owner_id
        and reservation.reservation_id = reservation_value
        and reservation.key_id = cipher_value ->> 'keyId'
        and reservation.key_class = key_class_value
        and reservation.key_purpose = key_purpose_value
        and reservation.key_version = key_version_value
    );
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function private.valid_encrypted_write_mac(
  mac_value jsonb,
  owner_id uuid,
  expected_class public.content_key_class,
  allow_retired boolean default false
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_class_value public.content_key_class;
  key_purpose_value public.content_key_purpose;
  key_version_value integer;
  key_state_value public.content_key_state;
begin
  if mac_value is null
    or jsonb_typeof(mac_value) <> 'object'
    or mac_value - array['mac', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion']
      <> '{}'::jsonb
    or not mac_value ?& array[
      'mac', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion'
    ]
    or jsonb_typeof(mac_value -> 'mac') <> 'string'
    or jsonb_typeof(mac_value -> 'keyId') <> 'string'
    or jsonb_typeof(mac_value -> 'keyClass') <> 'string'
    or jsonb_typeof(mac_value -> 'keyPurpose') <> 'string'
    or jsonb_typeof(mac_value -> 'keyVersion') <> 'number'
    or mac_value ->> 'keyVersion' !~ '^[1-9][0-9]{0,8}$'
  then
    return false;
  end if;

  key_class_value := (mac_value ->> 'keyClass')::public.content_key_class;
  key_purpose_value := (mac_value ->> 'keyPurpose')::public.content_key_purpose;
  key_version_value := (mac_value ->> 'keyVersion')::integer;

  select state into key_state_value
  from public.user_content_keys
  where user_id = owner_id
    and key_id = mac_value ->> 'keyId'
    and key_class = key_class_value
    and key_purpose = key_purpose_value
    and key_version = key_version_value;

  return private.valid_keyed_mac_field(
      mac_value ->> 'mac', mac_value ->> 'keyId', key_class_value,
      key_purpose_value, key_version_value
    )
    and key_class_value = expected_class
    and key_purpose_value = 'content_mac'
    and (
      key_state_value = 'active'
      or (allow_retired and key_state_value = 'retired')
    );
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

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
  key_state_value public.content_key_state;
begin
  if jsonb_typeof(cipher_values) <> 'array'
    or jsonb_array_length(cipher_values) not between 1 and 100
    or consumer_type_value not in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill'
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
      then
        continue;
      end if;
      raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
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

create or replace function private.encrypted_cipher_projection(
  envelope_value jsonb,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'envelope', envelope_value,
    'keyId', key_id_value,
    'keyClass', key_class_value,
    'keyPurpose', key_purpose_value,
    'keyVersion', key_version_value
  );
$$;

create or replace function private.encrypted_mac_projection(
  mac_value text,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'mac', mac_value,
    'keyId', key_id_value,
    'keyClass', key_class_value,
    'keyPurpose', key_purpose_value,
    'keyVersion', key_version_value
  );
$$;

create or replace function private.note_revision_snapshot_projection(
  revision_value public.note_revisions
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'spaceId', revision_value.space_id,
    'type', revision_value.type,
    'title', revision_value.title,
    'bodyMarkdown', revision_value.body_markdown,
    'structuredData', revision_value.structured_data,
    'isOpen', revision_value.is_open,
    'pinnedAt', revision_value.pinned_at,
    'privacy', revision_value.privacy,
    'archivedAt', revision_value.archived_at,
    'deletedAt', revision_value.deleted_at,
    'tagIds', revision_value.tag_ids,
    'links', revision_value.links
  );
$$;

create or replace function private.record_content_encryption_verification(
  owner_id uuid,
  surface_value text,
  resource_id_value text,
  record_version_value integer,
  envelope_value jsonb,
  verification_mac_value jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if surface_value not in (
      'space_display', 'tag_display', 'note_content', 'note_revision',
      'organization_decision', 'note_mutation', 'generated_block',
      'review_item', 'routing_rule', 'organization_mutation_attempt',
      'idempotency_response', 'capture_receipt', 'capture'
    )
    or owner_id is null
    or resource_id_value is null
    or record_version_value is null
    or record_version_value < 1
    or envelope_value is null
    or not private.valid_encrypted_write_mac(
      verification_mac_value,
      owner_id,
      (verification_mac_value ->> 'keyClass')::public.content_key_class,
      true
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  insert into public.content_encryption_verifications (
    user_id, surface, resource_id, record_version, envelope_digest,
    verification_mac, verification_mac_key_id, verification_mac_key_class,
    verification_mac_key_purpose, verification_mac_key_version
  ) values (
    owner_id, surface_value, resource_id_value, record_version_value,
    encode(extensions.digest(envelope_value::text, 'sha256'), 'hex'),
    verification_mac_value ->> 'mac', verification_mac_value ->> 'keyId',
    (verification_mac_value ->> 'keyClass')::public.content_key_class,
    (verification_mac_value ->> 'keyPurpose')::public.content_key_purpose,
    (verification_mac_value ->> 'keyVersion')::integer
  )
  on conflict (user_id, surface, resource_id) do update set
    record_version = excluded.record_version,
    envelope_digest = excluded.envelope_digest,
    verification_mac = excluded.verification_mac,
    verification_mac_key_id = excluded.verification_mac_key_id,
    verification_mac_key_class = excluded.verification_mac_key_class,
    verification_mac_key_purpose = excluded.verification_mac_key_purpose,
    verification_mac_key_version = excluded.verification_mac_key_version,
    verified_at = clock_timestamp();
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.reject_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.snapshot_envelope is null
    and old.snapshot_mac is null
    and new.snapshot_envelope is not null
    and new.snapshot_mac is not null
    and (
      to_jsonb(new) - array[
        'snapshot_envelope', 'snapshot_key_id', 'snapshot_key_class',
        'snapshot_key_purpose', 'snapshot_key_version', 'snapshot_mac',
        'snapshot_mac_key_id', 'snapshot_mac_key_class',
        'snapshot_mac_key_purpose', 'snapshot_mac_key_version', 'content_hash'
      ]
    ) = (
      to_jsonb(old) - array[
        'snapshot_envelope', 'snapshot_key_id', 'snapshot_key_class',
        'snapshot_key_purpose', 'snapshot_key_version', 'snapshot_mac',
        'snapshot_mac_key_id', 'snapshot_mac_key_class',
        'snapshot_mac_key_purpose', 'snapshot_mac_key_version', 'content_hash'
      ]
    )
    and new.content_hash = new.snapshot_mac
  then
    return new;
  end if;
  raise exception using errcode = 'P0001', message = 'immutable_revision';
end;
$$;

create or replace function public.reserve_content_key_operations(
  p_owner_id uuid,
  p_reservation_id uuid,
  p_key_class public.content_key_class,
  p_key_id text,
  p_key_version integer,
  p_operation_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_reservation public.content_key_operation_reservations%rowtype;
  key_row public.user_content_keys%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_reservation_id is null
    or p_key_class is null
    or p_key_id is null
    or p_key_version is null
    or p_key_version < 1
    or p_operation_count is null
    or p_operation_count not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- A reservation ID and the active class/purpose domain are independently
  -- serialized. The second lock is shared with activation/retirement, so a
  -- rotation cannot cross the active-state check and capacity burn.
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':reservation:' || p_reservation_id::text, 0)
  );

  select * into existing_reservation
  from public.content_key_operation_reservations
  where user_id = p_owner_id and reservation_id = p_reservation_id
  for update;

  if found then
    if existing_reservation.key_id <> p_key_id
      or existing_reservation.key_class <> p_key_class
      or existing_reservation.key_purpose <> 'object_wrap'
      or existing_reservation.key_version <> p_key_version
      or existing_reservation.operation_count <> p_operation_count
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'reservationId', existing_reservation.reservation_id,
      'keyId', existing_reservation.key_id,
      'keyClass', existing_reservation.key_class,
      'keyPurpose', existing_reservation.key_purpose,
      'keyVersion', existing_reservation.key_version,
      'operationCount', existing_reservation.operation_count,
      'consumed', existing_reservation.consumed_at is not null,
      'replayed', true
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_owner_id::text || ':' || p_key_class::text || ':object_wrap', 0
    )
  );

  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id
    and key_id = p_key_id
    and key_class = p_key_class
    and key_purpose = 'object_wrap'
    and key_version = p_key_version
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if key_row.state <> 'active' then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  if key_row.wrap_operations > key_row.wrap_operation_limit - p_operation_count then
    raise exception using errcode = 'P0001', message = 'key_operation_limit';
  end if;

  update public.user_content_keys
  set wrap_operations = wrap_operations + p_operation_count
  where user_id = p_owner_id
    and key_id = p_key_id
    and key_class = p_key_class
    and key_purpose = 'object_wrap'
    and key_version = p_key_version
    and state = 'active'
    and wrap_operations <= wrap_operation_limit - p_operation_count;

  if not found then
    raise exception using errcode = 'P0001', message = 'key_operation_limit';
  end if;

  insert into public.content_key_operation_reservations (
    user_id, reservation_id, key_id, key_class, key_purpose, key_version,
    operation_count
  ) values (
    p_owner_id, p_reservation_id, p_key_id, p_key_class, 'object_wrap',
    p_key_version, p_operation_count
  );

  return jsonb_build_object(
    'reservationId', p_reservation_id,
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', 'object_wrap',
    'keyVersion', p_key_version,
    'operationCount', p_operation_count,
    'consumed', false,
    'replayed', false
  );
end;
$$;

create or replace function private.content_key_service_projection(
  key_value public.user_content_keys
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ownerId', key_value.user_id,
    'keyId', key_value.key_id,
    'keyClass', key_value.key_class,
    'purpose', key_value.key_purpose,
    'keyVersion', key_value.key_version,
    'schemaVersion', key_value.schema_version,
    'status', key_value.state,
    'encryptedKeyMaterial', translate(
      replace(encode(key_value.wrapped_intermediate_key, 'base64'), E'\n', ''),
      '+/=', '-_'
    ),
    'rootKeyArn', key_value.kms_key_id,
    'createdAt', key_value.created_at,
    'activatedAt', key_value.activated_at,
    'retiredAt', key_value.retired_at,
    'revokedAt', key_value.revoked_at,
    'wrapOperations', key_value.wrap_operations,
    'wrapOperationLimit', key_value.wrap_operation_limit,
    'rotation', jsonb_build_object(
      'predecessorKeyId', key_value.predecessor_key_id,
      'previousRootKeyArn', key_value.previous_kms_key_id,
      'rootRewrapCount', key_value.root_rewrap_count,
      'lastRootRewrappedAt', key_value.last_root_rewrapped_at
    )
  );
$$;

create or replace function public.get_active_user_content_key(
  p_owner_id uuid,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_row public.user_content_keys%rowtype;
  next_version_value integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_key_class is null or p_key_purpose is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select coalesce(max(key_version), 0) + 1 into next_version_value
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose;

  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose
    and state = 'active';
  if not found then
    return jsonb_build_object(
      'found', false, 'nextVersion', next_version_value
    );
  end if;
  return jsonb_build_object(
    'found', true,
    'nextVersion', next_version_value,
    'record', private.content_key_service_projection(key_row)
  );
end;
$$;

create or replace function public.get_user_content_key_by_id(
  p_owner_id uuid,
  p_key_id text,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  key_row public.user_content_keys%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_key_id is null
    or p_key_class is null
    or p_key_purpose is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id
    and key_id = p_key_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if key_row.state = 'revoked' then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  return private.content_key_service_projection(key_row);
end;
$$;

create or replace function public.get_user_content_key_status(
  p_owner_id uuid,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  next_version_value integer;
  active_value jsonb;
  pending_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_key_class is null or p_key_purpose is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select coalesce(max(key_version), 0) + 1 into next_version_value
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose;
  select jsonb_build_object('keyId', key_id, 'keyVersion', key_version)
  into active_value
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose
    and state = 'active';
  select jsonb_build_object('keyId', key_id, 'keyVersion', key_version)
  into pending_value
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose
    and state = 'pending';

  return jsonb_build_object(
    'keyClass', p_key_class,
    'keyPurpose', p_key_purpose,
    'active', active_value,
    'pending', pending_value,
    'nextVersion', next_version_value
  );
end;
$$;

create or replace function private.encrypted_note_claim_projection(
  claim_value public.encrypted_note_write_claims
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'scope', claim_value.scope,
    'noteId', claim_value.note_id,
    'expectedRevision', claim_value.expected_revision,
    'sourcePrivacy', claim_value.source_privacy,
    'targetPrivacy', claim_value.target_privacy,
    'historyKeyClass', claim_value.history_key_class,
    'revisionId', claim_value.revision_id,
    'mutationId', claim_value.mutation_id,
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

create or replace function public.prepare_encrypted_note_write(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text,
  p_note_id text,
  p_expected_revision integer,
  p_target_privacy public.privacy_mode,
  p_request_mac jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_note_write_claims%rowtype;
  note_row public.notes%rowtype;
  history_class_value public.content_key_class;
  encrypted_response jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in ('create_encrypted_note', 'apply_encrypted_note_mutation')
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 80
    or btrim(p_idempotency_key) <> p_idempotency_key
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_request_mac is null
    or jsonb_typeof(p_request_mac) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
    )
  );

  select * into claim_row
  from public.encrypted_note_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;

  if found then
    if claim_row.scope <> p_scope then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if not private.valid_encrypted_write_mac(
        p_request_mac, p_owner_id, claim_row.history_key_class, true
      )
      or p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
      or (p_request_mac ->> 'keyClass')::public.content_key_class
        <> claim_row.request_mac_key_class
      or (p_request_mac ->> 'keyPurpose')::public.content_key_purpose
        <> claim_row.request_mac_key_purpose
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

    return private.encrypted_note_claim_projection(claim_row)
      || jsonb_build_object(
        'encryptedResponse', encrypted_response,
        'replayed', true
      );
  end if;

  if exists (
    select 1 from public.api_idempotency_records
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
      and replay_policy = 'legacy_nonreplayable'
  ) then
    raise exception using
      errcode = 'P0001', message = 'legacy_idempotency_nonreplayable';
  elsif exists (
    select 1 from public.api_idempotency_records
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  -- Serialize every new write claim with rollout transitions. A write that
  -- starts before a transition either commits first and is included in the
  -- transition's completeness scan, or observes the new state.
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );

  if not exists (
    select 1
    from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  if p_scope = 'create_encrypted_note' then
    if p_note_id is not null
      or p_expected_revision is distinct from 0
      or p_target_privacy is null
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    claim_row.note_id := public.new_entity_id('note');
    claim_row.expected_revision := 0;
    claim_row.source_privacy := null;
    history_class_value := p_target_privacy::text::public.content_key_class;
  else
    if p_note_id is null
      or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or p_expected_revision is null
      or p_expected_revision < 1
      or p_target_privacy is null
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;

    select * into note_row
    from public.notes
    where user_id = p_owner_id and id = p_note_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if note_row.current_revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;

    claim_row.note_id := p_note_id;
    claim_row.expected_revision := p_expected_revision;
    claim_row.source_privacy := note_row.privacy;
    history_class_value := case
      when note_row.privacy = 'private_manual'
        or p_target_privacy = 'private_manual'
      then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class
    end;
  end if;

  if not private.valid_encrypted_write_mac(
    p_request_mac, p_owner_id, history_class_value, false
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_request_mac_key';
  end if;

  insert into public.encrypted_note_write_claims (
    user_id, idempotency_key, scope, note_id, expected_revision, source_privacy,
    target_privacy, history_key_class, revision_id, mutation_id,
    request_mac_key_id, request_mac_key_class, request_mac_key_purpose,
    request_mac_key_version, request_mac
  ) values (
    p_owner_id, p_idempotency_key, p_scope, claim_row.note_id,
    claim_row.expected_revision, claim_row.source_privacy,
    p_target_privacy, history_class_value,
    public.new_entity_id('rev'), public.new_entity_id('mut'),
    p_request_mac ->> 'keyId',
    (p_request_mac ->> 'keyClass')::public.content_key_class,
    (p_request_mac ->> 'keyPurpose')::public.content_key_purpose,
    (p_request_mac ->> 'keyVersion')::integer,
    p_request_mac ->> 'mac'
  )
  returning * into claim_row;

  return private.encrypted_note_claim_projection(claim_row)
    || jsonb_build_object(
      'encryptedResponse', null,
      'replayed', false
    );
end;
$$;

create or replace function public.get_encrypted_note_write_claim(
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
  claim_row public.encrypted_note_write_claims%rowtype;
  encrypted_response jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in ('create_encrypted_note', 'apply_encrypted_note_mutation')
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 80
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into claim_row
  from public.encrypted_note_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then
    return jsonb_build_object('found', false);
  end if;
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
  end if;

  return private.encrypted_note_claim_projection(claim_row)
    || jsonb_build_object(
      'found', true,
      'encryptedResponse', encrypted_response
    );
end;
$$;

create or replace function private.valid_encrypted_note_state(state_value jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  note_type_value public.note_type;
  privacy_value public.privacy_mode;
begin
  if state_value is null
    or jsonb_typeof(state_value) <> 'object'
    or state_value - array[
      'spaceId', 'type', 'title', 'bodyMarkdown', 'structuredData',
      'dailyDate', 'isOpen', 'privacy', 'pinnedAt', 'archivedAt',
      'deletedAt', 'tagIds', 'links'
    ] <> '{}'::jsonb
    or not state_value ?& array[
      'spaceId', 'type', 'title', 'bodyMarkdown', 'structuredData',
      'dailyDate', 'isOpen', 'privacy', 'pinnedAt', 'archivedAt',
      'deletedAt', 'tagIds', 'links'
    ]
    or jsonb_typeof(state_value -> 'spaceId') not in ('string', 'null')
    or jsonb_typeof(state_value -> 'type') <> 'string'
    or jsonb_typeof(state_value -> 'title') <> 'string'
    or char_length(btrim(state_value ->> 'title')) not between 1 and 200
    or jsonb_typeof(state_value -> 'bodyMarkdown') <> 'string'
    or char_length(state_value ->> 'bodyMarkdown') > 200000
    or jsonb_typeof(state_value -> 'structuredData') <> 'object'
    or jsonb_typeof(state_value -> 'dailyDate') not in ('string', 'null')
    or jsonb_typeof(state_value -> 'isOpen') <> 'boolean'
    or jsonb_typeof(state_value -> 'privacy') <> 'string'
    or jsonb_typeof(state_value -> 'pinnedAt') not in ('string', 'null')
    or jsonb_typeof(state_value -> 'archivedAt') not in ('string', 'null')
    or jsonb_typeof(state_value -> 'deletedAt') not in ('string', 'null')
    or jsonb_typeof(state_value -> 'tagIds') <> 'array'
    or jsonb_array_length(state_value -> 'tagIds') > 100
    or jsonb_typeof(state_value -> 'links') <> 'array'
    or jsonb_array_length(state_value -> 'links') > 100
  then
    return false;
  end if;

  note_type_value := (state_value ->> 'type')::public.note_type;
  privacy_value := (state_value ->> 'privacy')::public.privacy_mode;
  perform (state_value ->> 'isOpen')::boolean;

  if not private.valid_note_structured_data(
    note_type_value, state_value -> 'structuredData'
  ) then
    return false;
  end if;
  if jsonb_typeof(state_value -> 'dailyDate') = 'string' then
    perform (state_value ->> 'dailyDate')::date;
  end if;
  if jsonb_typeof(state_value -> 'pinnedAt') = 'string'
    and not private.valid_iso_offset_datetime(state_value ->> 'pinnedAt')
  then return false;
  end if;
  if jsonb_typeof(state_value -> 'archivedAt') = 'string'
    and not private.valid_iso_offset_datetime(state_value ->> 'archivedAt')
  then return false;
  end if;
  if jsonb_typeof(state_value -> 'deletedAt') = 'string'
    and not private.valid_iso_offset_datetime(state_value ->> 'deletedAt')
  then return false;
  end if;
  return privacy_value is not null;
exception when others then
  return false;
end;
$$;

create or replace function private.assert_encrypted_note_relationships(
  owner_id uuid,
  note_id_value text,
  state_value jsonb
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tag_id_value text;
  relation jsonb;
  link_key text;
  seen_tags text[] := array[]::text[];
  seen_links text[] := array[]::text[];
begin
  if jsonb_typeof(state_value -> 'spaceId') = 'string'
    and not exists (
      select 1 from public.spaces
      where user_id = owner_id
        and id = state_value ->> 'spaceId'
        and archived_at is null
    )
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  for tag_id_value in select jsonb_array_elements_text(state_value -> 'tagIds')
  loop
    if tag_id_value !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'
      or tag_id_value = any(seen_tags)
      or not exists (
        select 1 from public.tags
        where user_id = owner_id and id = tag_id_value
      )
    then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    seen_tags := array_append(seen_tags, tag_id_value);
  end loop;

  for relation in select value from jsonb_array_elements(state_value -> 'links')
  loop
    if not private.jsonb_has_exact_keys(relation, array['toNoteId', 'linkType'])
      or jsonb_typeof(relation -> 'toNoteId') <> 'string'
      or jsonb_typeof(relation -> 'linkType') <> 'string'
      or relation ->> 'toNoteId' = note_id_value
      or not exists (
        select 1 from public.notes
        where user_id = owner_id
          and id = relation ->> 'toNoteId'
          and deleted_at is null
      )
    then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    perform (relation ->> 'linkType')::public.link_type;
    link_key := (relation ->> 'toNoteId') || ':'
      || (relation ->> 'linkType');
    if link_key = any(seen_links) then
      raise exception using errcode = 'P0001', message = 'structure_conflict';
    end if;
    seen_links := array_append(seen_links, link_key);
  end loop;
exception when invalid_text_representation then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

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

  if is_new_note then
    update public.rag_index_generations
    set
      expected_note_count = expected_note_count + 1,
      revision_token = revision_token + 1
    where user_id = owner_id and state in ('building', 'active');
  end if;

  insert into public.note_index_jobs (
    user_id, note_id, generation_id, target_revision
  )
  select owner_id, note_id_value, generation.id, revision_value
  from public.rag_index_generations as generation
  where generation.user_id = owner_id
    and generation.state in ('building', 'active')
  on conflict (note_id, generation_id, target_revision) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function private.encrypted_note_write_result(
  owner_id uuid,
  idempotency_key_value text,
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
begin
  select * into record_row
  from public.api_idempotency_records
  where user_id = owner_id and idempotency_key = idempotency_key_value;
  if not found or record_row.response_envelope is null then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  return jsonb_build_object(
    'noteId', record_row.request_resource_id,
    'mutationId', record_row.response_resource_id,
    'currentRevision', record_row.response_record_version,
    'encryptedResponse', private.encrypted_cipher_projection(
      record_row.response_envelope, record_row.response_key_id,
      record_row.response_key_class, record_row.response_key_purpose,
      record_row.response_key_version
    ),
    'replayed', replayed_value
  );
end;
$$;

create or replace function private.lock_encrypted_note_write_claim(
  owner_id uuid,
  idempotency_key_value text,
  scope_value text,
  note_id_value text,
  expected_revision_value integer,
  request_mac_value jsonb
)
returns public.encrypted_note_write_claims
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_note_write_claims%rowtype;
begin
  select * into claim_row
  from public.encrypted_note_write_claims
  where user_id = owner_id and idempotency_key = idempotency_key_value
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;
  if claim_row.scope <> scope_value
    or claim_row.note_id <> note_id_value
    or claim_row.expected_revision <> expected_revision_value
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if not private.valid_encrypted_write_mac(
    request_mac_value, owner_id, claim_row.history_key_class, true
  )
    or request_mac_value ->> 'keyId' <> claim_row.request_mac_key_id
    or (request_mac_value ->> 'keyClass')::public.content_key_class
      <> claim_row.request_mac_key_class
    or (request_mac_value ->> 'keyPurpose')::public.content_key_purpose
      <> claim_row.request_mac_key_purpose
    or (request_mac_value ->> 'keyVersion')::integer
      <> claim_row.request_mac_key_version
  then
    raise exception using errcode = 'P0001', message = 'invalid_request_mac_key';
  end if;
  if claim_row.request_mac is not null
    and claim_row.request_mac <> request_mac_value ->> 'mac'
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return claim_row;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.finish_encrypted_note_write(
  claim_value public.encrypted_note_write_claims,
  request_mac_value jsonb,
  response_cipher_value jsonb,
  record_version_value integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    request_mac_value ->> 'mac',
    jsonb_build_object(
      'resourceType', 'note_mutation',
      'resourceId', claim_value.mutation_id,
      'noteId', claim_value.note_id,
      'recordVersion', record_version_value
    ),
    claim_value.occurred_at, request_mac_value ->> 'mac',
    claim_value.request_mac_key_id, claim_value.request_mac_key_class,
    claim_value.request_mac_key_purpose, claim_value.request_mac_key_version,
    response_cipher_value -> 'envelope', response_cipher_value ->> 'keyId',
    (response_cipher_value ->> 'keyClass')::public.content_key_class,
    (response_cipher_value ->> 'keyPurpose')::public.content_key_purpose,
    (response_cipher_value ->> 'keyVersion')::integer,
    'note', claim_value.note_id, 'note_mutation', claim_value.mutation_id,
    record_version_value, claim_value.occurred_at, 'logical_mac'
  );

  update public.encrypted_note_write_claims
  set completed_at = claim_value.occurred_at
  where user_id = claim_value.user_id
    and idempotency_key = claim_value.idempotency_key
    and request_mac = request_mac_value ->> 'mac'
    and completed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
end;
$$;

create or replace function private.enforce_encrypted_rollout_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  rollout_state public.encryption_rollout_state;
  authoritative_class public.content_key_class;
  content_changed boolean := false;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(owner_id::text || ':content-encryption-rollout', 0)
  );
  select state into rollout_state
  from public.content_encryption_rollouts
  where user_id = owner_id
  for share;
  rollout_state := coalesce(
    rollout_state, 'expanded'::public.encryption_rollout_state
  );
  if rollout_state < 'dual_write' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'organization_jobs' then
    if new.state in ('created', 'running', 'awaiting_retry') then
      raise exception using
        errcode = 'P0001', message = 'encrypted_organizer_write_unavailable';
    end if;
  elsif tg_table_name = 'spaces' then
    if new.display_envelope is null or new.display_mac is null
      or new.display_key_class <> 'private_manual'
      or new.display_mac_key_class <> 'private_manual'
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(new.name, new.slug)
        is distinct from row(old.name, old.slug);
      if content_changed and (
        new.current_revision <> old.current_revision + 1
        or new.display_envelope is not distinct from old.display_envelope
        or new.display_mac is not distinct from old.display_mac
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'tags' then
    if new.display_envelope is null or new.display_mac is null
      or new.display_key_class <> 'private_manual'
      or new.display_mac_key_class <> 'private_manual'
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := new.name is distinct from old.name;
      if content_changed and (
        new.current_revision <> old.current_revision + 1
        or new.display_envelope is not distinct from old.display_envelope
        or new.display_mac is not distinct from old.display_mac
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'notes' then
    if new.content_envelope is null
      or new.content_key_class::text <> new.privacy::text
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(new.title, new.body_markdown, new.structured_data)
        is distinct from row(old.title, old.body_markdown, old.structured_data);
      if content_changed and (
        new.current_revision <> old.current_revision + 1
        or new.content_envelope is not distinct from old.content_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'note_revisions' then
    if new.snapshot_envelope is null or new.snapshot_mac is null
      or (new.privacy = 'private_manual'
        and new.snapshot_key_class <> 'private_manual')
      or new.snapshot_key_class <> new.snapshot_mac_key_class
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
  elsif tg_table_name = 'note_mutations' then
    if new.mutation_envelope is null then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and row(
      new.operations, new.inverse, new.before_revision, new.after_revision
    ) is distinct from row(
      old.operations, old.inverse, old.before_revision, old.after_revision
    ) then
      raise exception using errcode = 'P0001', message = 'immutable_encrypted_content';
    end if;
  elsif tg_table_name = 'organization_decisions' then
    if new.decision_envelope is null or new.decision_key_class <> 'ai_assisted' then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(
        new.candidate_manifest, new.signals, new.validated_plan, new.band
      ) is distinct from row(
        old.candidate_manifest, old.signals, old.validated_plan, old.band
      );
      if content_changed and (
        new.decision_content_revision <> old.decision_content_revision + 1
        or new.decision_envelope is not distinct from old.decision_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'generated_blocks' then
    if new.content_envelope is null or new.content_key_class <> 'ai_assisted' then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and new.content is distinct from old.content then
      raise exception using errcode = 'P0001', message = 'immutable_encrypted_content';
    end if;
  elsif tg_table_name = 'review_items' then
    authoritative_class := 'ai_assisted';
    if new.note_id is not null and exists (
      select 1 from public.notes
      where user_id = owner_id and id = new.note_id and privacy = 'private_manual'
    ) then authoritative_class := 'private_manual';
    elsif new.capture_id is not null and exists (
      select 1 from public.captures
      where user_id = owner_id and id = new.capture_id and privacy = 'private_manual'
    ) then authoritative_class := 'private_manual';
    end if;
    if new.review_envelope is null or new.review_key_class <> authoritative_class then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(new.choices, new.state, new.resolution)
        is distinct from row(old.choices, old.state, old.resolution);
      if content_changed and (
        new.review_content_revision <> old.review_content_revision + 1
        or new.review_envelope is not distinct from old.review_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'routing_rules' then
    if new.condition_envelope is null or new.condition_key_class <> 'private_manual' then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := new.condition_normalized is distinct from old.condition_normalized;
      if content_changed and (
        new.condition_revision <> old.condition_revision + 1
        or new.condition_envelope is not distinct from old.condition_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'organization_mutation_attempts' then
    if new.attempt_envelope is null or new.attempt_key_class <> 'ai_assisted' then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := new.operations is distinct from old.operations;
      if content_changed and (
        new.attempt_content_revision <> old.attempt_content_revision + 1
        or new.attempt_envelope is not distinct from old.attempt_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'api_idempotency_records' then
    if new.response_envelope is null
      or new.request_resource_id is null or new.response_resource_id is null
      or (new.replay_policy = 'logical_mac' and new.request_mac is null)
      or (new.replay_policy = 'legacy_nonreplayable' and new.request_mac is not null)
      or (tg_op = 'UPDATE' and new.replay_policy = 'legacy_nonreplayable'
        and new.request_hash is distinct from old.request_hash)
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
  elsif tg_table_name = 'capture_receipts' then
    select privacy::text::public.content_key_class into authoritative_class
    from public.captures
    where user_id = owner_id and id = new.capture_id;
    if new.receipt_envelope is null or new.receipt_key_class <> authoritative_class then
      raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(
        new.job_id, new.decision_id, new.review_item_id, new.mutation_id,
        new.outcome, new.headline, new.destination_note_id,
        new.inserted_content, new.actions, new.reason_codes, new.created_at
      ) is distinct from row(
        old.job_id, old.decision_id, old.review_item_id, old.mutation_id,
        old.outcome, old.headline, old.destination_note_id,
        old.inserted_content, old.actions, old.reason_codes, old.created_at
      );
      if content_changed and (
        new.receipt_revision <> old.receipt_revision + 1
        or new.receipt_envelope is not distinct from old.receipt_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'captures' then
    if new.deleted_at is null and (
      new.content_envelope is null
      or new.content_fingerprint is null
      or new.content_key_id is null
      or new.fingerprint_key_id is null
      or new.content_key_class::text <> new.privacy::text
      or new.fingerprint_key_class::text <> new.privacy::text
    ) then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.invalidate_content_encryption_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_value jsonb := to_jsonb(old);
  new_value jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  resource_id_value text;
  changed_value boolean;
begin
  resource_id_value := case
    when tg_argv[0] = 'organization_mutation_attempt'
      then (old_value ->> 'job_id') || ':' || (old_value ->> 'note_id')
    when tg_argv[0] = 'capture_receipt'
      then old_value ->> 'capture_id'
    when tg_argv[0] = 'idempotency_response'
      then 'idempotency:' || (old_value ->> 'idempotency_key')
    else old_value ->> coalesce(tg_argv[3], 'id')
  end;
  changed_value := tg_op = 'DELETE'
    or new_value -> tg_argv[1] is distinct from old_value -> tg_argv[1]
    or (
      tg_argv[2] <> '1'
      and new_value -> tg_argv[2] is distinct from old_value -> tg_argv[2]
    );
  if changed_value then
    delete from public.content_encryption_verifications
    where user_id = old.user_id
      and surface = tg_argv[0]
      and resource_id = resource_id_value;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.serialize_content_rollout_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(old.user_id::text || ':content-encryption-rollout', 0)
  );
  return old;
end;
$$;

create trigger spaces_encrypted_rollout_guard
before insert or update on public.spaces
for each row execute function private.enforce_encrypted_rollout_write();
create trigger tags_encrypted_rollout_guard
before insert or update on public.tags
for each row execute function private.enforce_encrypted_rollout_write();
create trigger notes_encrypted_rollout_guard
before insert or update on public.notes
for each row execute function private.enforce_encrypted_rollout_write();
create trigger note_revisions_encrypted_rollout_guard
before insert on public.note_revisions
for each row execute function private.enforce_encrypted_rollout_write();
create trigger note_mutations_encrypted_rollout_guard
before insert or update on public.note_mutations
for each row execute function private.enforce_encrypted_rollout_write();
create trigger organization_decisions_encrypted_rollout_guard
before insert or update on public.organization_decisions
for each row execute function private.enforce_encrypted_rollout_write();
create trigger generated_blocks_encrypted_rollout_guard
before insert or update on public.generated_blocks
for each row execute function private.enforce_encrypted_rollout_write();
create trigger review_items_encrypted_rollout_guard
before insert or update on public.review_items
for each row execute function private.enforce_encrypted_rollout_write();
create trigger routing_rules_encrypted_rollout_guard
before insert or update on public.routing_rules
for each row execute function private.enforce_encrypted_rollout_write();
create trigger organization_mutation_attempts_encrypted_rollout_guard
before insert or update on public.organization_mutation_attempts
for each row execute function private.enforce_encrypted_rollout_write();
create trigger api_idempotency_records_encrypted_rollout_guard
before insert or update on public.api_idempotency_records
for each row execute function private.enforce_encrypted_rollout_write();
create trigger capture_receipts_encrypted_rollout_guard
before insert or update on public.capture_receipts
for each row execute function private.enforce_encrypted_rollout_write();
create trigger captures_encrypted_rollout_guard
before insert or update on public.captures
for each row execute function private.enforce_encrypted_rollout_write();
create trigger organization_jobs_encrypted_rollout_guard
before insert or update on public.organization_jobs
for each row execute function private.enforce_encrypted_rollout_write();

create trigger spaces_invalidate_encryption_verification
after update or delete on public.spaces for each row execute function
private.invalidate_content_encryption_verification(
  'space_display', 'display_envelope', 'current_revision', 'id'
);
create trigger tags_invalidate_encryption_verification
after update or delete on public.tags for each row execute function
private.invalidate_content_encryption_verification(
  'tag_display', 'display_envelope', 'current_revision', 'id'
);
create trigger notes_invalidate_encryption_verification
after update or delete on public.notes for each row execute function
private.invalidate_content_encryption_verification(
  'note_content', 'content_envelope', 'current_revision', 'id'
);
create trigger note_revisions_invalidate_encryption_verification
after update or delete on public.note_revisions for each row execute function
private.invalidate_content_encryption_verification(
  'note_revision', 'snapshot_envelope', 'revision', 'id'
);
create trigger note_mutations_invalidate_encryption_verification
after update or delete on public.note_mutations for each row execute function
private.invalidate_content_encryption_verification(
  'note_mutation', 'mutation_envelope', 'after_revision', 'id'
);
create trigger organization_decisions_invalidate_encryption_verification
after update or delete on public.organization_decisions for each row execute function
private.invalidate_content_encryption_verification(
  'organization_decision', 'decision_envelope', 'decision_content_revision', 'id'
);
create trigger generated_blocks_invalidate_encryption_verification
after update or delete on public.generated_blocks for each row execute function
private.invalidate_content_encryption_verification(
  'generated_block', 'content_envelope', '1', 'id'
);
create trigger review_items_invalidate_encryption_verification
after update or delete on public.review_items for each row execute function
private.invalidate_content_encryption_verification(
  'review_item', 'review_envelope', 'review_content_revision', 'id'
);
create trigger routing_rules_invalidate_encryption_verification
after update or delete on public.routing_rules for each row execute function
private.invalidate_content_encryption_verification(
  'routing_rule', 'condition_envelope', 'condition_revision', 'id'
);
create trigger organization_attempts_invalidate_encryption_verification
after update or delete on public.organization_mutation_attempts
for each row execute function private.invalidate_content_encryption_verification(
  'organization_mutation_attempt', 'attempt_envelope',
  'attempt_content_revision', 'job_id'
);
create trigger idempotency_invalidate_encryption_verification
after update or delete on public.api_idempotency_records
for each row execute function private.invalidate_content_encryption_verification(
  'idempotency_response', 'response_envelope', '1', 'idempotency_key'
);
create trigger capture_receipts_invalidate_encryption_verification
after update or delete on public.capture_receipts for each row execute function
private.invalidate_content_encryption_verification(
  'capture_receipt', 'receipt_envelope', 'receipt_revision', 'capture_id'
);
create trigger captures_invalidate_encryption_verification
after update or delete on public.captures for each row execute function
private.invalidate_content_encryption_verification(
  'capture', 'content_envelope', '1', 'id'
);

create trigger spaces_serialize_rollout_delete before delete on public.spaces
for each row execute function private.serialize_content_rollout_delete();
create trigger tags_serialize_rollout_delete before delete on public.tags
for each row execute function private.serialize_content_rollout_delete();
create trigger notes_serialize_rollout_delete before delete on public.notes
for each row execute function private.serialize_content_rollout_delete();
create trigger note_revisions_serialize_rollout_delete
before delete on public.note_revisions for each row execute function
private.serialize_content_rollout_delete();
create trigger note_mutations_serialize_rollout_delete
before delete on public.note_mutations for each row execute function
private.serialize_content_rollout_delete();
create trigger decisions_serialize_rollout_delete
before delete on public.organization_decisions for each row execute function
private.serialize_content_rollout_delete();
create trigger blocks_serialize_rollout_delete before delete on public.generated_blocks
for each row execute function private.serialize_content_rollout_delete();
create trigger reviews_serialize_rollout_delete before delete on public.review_items
for each row execute function private.serialize_content_rollout_delete();
create trigger rules_serialize_rollout_delete before delete on public.routing_rules
for each row execute function private.serialize_content_rollout_delete();
create trigger attempts_serialize_rollout_delete
before delete on public.organization_mutation_attempts for each row execute function
private.serialize_content_rollout_delete();
create trigger idempotency_serialize_rollout_delete
before delete on public.api_idempotency_records for each row execute function
private.serialize_content_rollout_delete();
create trigger receipts_serialize_rollout_delete before delete on public.capture_receipts
for each row execute function private.serialize_content_rollout_delete();
create trigger captures_serialize_rollout_delete before delete on public.captures
for each row execute function private.serialize_content_rollout_delete();

create or replace function public.legacy_plaintext_reads_allowed(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_owner_id is not null
    and (
      auth.role() = 'service_role'
      or (auth.role() = 'authenticated' and auth.uid() = p_owner_id)
    )
    and coalesce(
    (
      select rollout.state in ('expanded', 'dual_write')
      from public.content_encryption_rollouts as rollout
      where rollout.user_id = p_owner_id
    ),
    true
  );
$$;

drop policy if exists spaces_select on public.spaces;
create policy spaces_select on public.spaces for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists note_revisions_select on public.note_revisions;
create policy note_revisions_select on public.note_revisions for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists note_mutations_select on public.note_mutations;
create policy note_mutations_select on public.note_mutations for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists note_chunks_select on public.note_chunks;
create policy note_chunks_select on public.note_chunks for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists organization_decisions_select on public.organization_decisions;
create policy organization_decisions_select
on public.organization_decisions for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists generated_blocks_select on public.generated_blocks;
create policy generated_blocks_select on public.generated_blocks
for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists review_items_select on public.review_items;
create policy review_items_select on public.review_items for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists routing_rules_select on public.routing_rules;
create policy routing_rules_select on public.routing_rules for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists organization_mutation_attempts_select_own
  on public.organization_mutation_attempts;
create policy organization_mutation_attempts_select_own
on public.organization_mutation_attempts for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);
drop policy if exists captures_select on public.captures;
create policy captures_select on public.captures for select to authenticated
using (
  user_id = auth.uid() and public.legacy_plaintext_reads_allowed(user_id)
);

create or replace function public.create_encrypted_note(
  p_owner_id uuid,
  p_note_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_note_write_claims%rowtype;
  state_value jsonb;
  note_cipher jsonb;
  revision_value jsonb;
  mutation_value jsonb;
  response_cipher jsonb;
  request_mac_value jsonb;
  revision_cipher jsonb;
  revision_mac jsonb;
  mutation_cipher jsonb;
  verification_value jsonb;
  note_verification_mac jsonb;
  mutation_verification_mac jsonb;
  response_verification_mac jsonb;
  note_type_value public.note_type;
  privacy_value public.privacy_mode;
  source_value public.revision_source;
  occurred_value timestamptz;
  index_job_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- This lookup and logical-MAC comparison intentionally precede every CAS,
  -- generated-ID, timestamp, and randomized-cipher check. A response-lost
  -- retry may submit fresh ciphertext, but it receives the original result.
  claim_row := private.lock_encrypted_note_write_claim(
    p_owner_id, p_idempotency_key, 'create_encrypted_note', p_note_id, 0,
    p_command -> 'requestMac'
  );
  if claim_row.completed_at is not null then
    return private.encrypted_note_write_result(
      p_owner_id, p_idempotency_key, true
    );
  end if;

  if p_command - array[
      'noteState', 'noteCipher', 'revision', 'mutation', 'requestMac',
      'responseCipher', 'occurredAt', 'verification'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'noteState', 'noteCipher', 'revision', 'mutation', 'requestMac',
      'responseCipher', 'occurredAt', 'verification'
    ]
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or jsonb_typeof(p_command -> 'verification') <> 'object'
    or jsonb_typeof(p_command -> 'revision') <> 'object'
    or jsonb_typeof(p_command -> 'mutation') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  state_value := p_command -> 'noteState';
  note_cipher := p_command -> 'noteCipher';
  revision_value := p_command -> 'revision';
  mutation_value := p_command -> 'mutation';
  request_mac_value := p_command -> 'requestMac';
  response_cipher := p_command -> 'responseCipher';
  occurred_value := (p_command ->> 'occurredAt')::timestamptz;
  verification_value := p_command -> 'verification';
  note_verification_mac := verification_value -> 'noteContent';
  mutation_verification_mac := verification_value -> 'noteMutation';
  response_verification_mac := verification_value -> 'idempotencyResponse';

  if not private.valid_encrypted_note_state(state_value)
    or revision_value - array['id', 'source', 'actor', 'cipher', 'mac']
      <> '{}'::jsonb
    or not revision_value ?& array['id', 'source', 'actor', 'cipher', 'mac']
    or mutation_value - array[
      'id', 'decisionId', 'undoTargetMutationId',
      'operations', 'inverse', 'cipher'
    ] <> '{}'::jsonb
    or not mutation_value ?& array[
      'id', 'decisionId', 'undoTargetMutationId',
      'operations', 'inverse', 'cipher'
    ]
    or revision_value ->> 'id' <> claim_row.revision_id
    or mutation_value ->> 'id' <> claim_row.mutation_id
    or jsonb_typeof(revision_value -> 'source') <> 'string'
    or jsonb_typeof(revision_value -> 'actor') <> 'string'
    or revision_value ->> 'actor'
      !~ '^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or jsonb_typeof(mutation_value -> 'decisionId') <> 'null'
    or jsonb_typeof(mutation_value -> 'undoTargetMutationId') <> 'null'
    or mutation_value -> 'operations'
      <> jsonb_build_array(jsonb_build_object('type', 'create_note'))
    or jsonb_typeof(mutation_value -> 'inverse') not in ('array', 'object')
    or occurred_value <> claim_row.occurred_at
    or verification_value - array[
      'noteContent', 'noteMutation', 'idempotencyResponse'
    ] <> '{}'::jsonb
    or not verification_value ?& array[
      'noteContent', 'noteMutation', 'idempotencyResponse'
    ]
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  begin
    note_type_value := (state_value ->> 'type')::public.note_type;
    privacy_value := (state_value ->> 'privacy')::public.privacy_mode;
    source_value := (revision_value ->> 'source')::public.revision_source;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  if privacy_value::text::public.content_key_class <> claim_row.history_key_class
    or privacy_value <> claim_row.target_privacy
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_class';
  end if;

  revision_cipher := revision_value -> 'cipher';
  revision_mac := revision_value -> 'mac';
  mutation_cipher := mutation_value -> 'cipher';
  if not private.valid_encrypted_write_cipher(
      note_cipher, p_owner_id, p_note_id, 1, 'note_content',
      privacy_value::text::public.content_key_class
    )
    or not private.valid_encrypted_write_cipher(
      revision_cipher, p_owner_id, claim_row.revision_id, 1,
      'note_revision', claim_row.history_key_class
    )
    or not private.valid_encrypted_write_mac(
      revision_mac, p_owner_id, claim_row.history_key_class, false
    )
    or not private.valid_encrypted_write_cipher(
      mutation_cipher, p_owner_id, claim_row.mutation_id, 1,
      'note_mutation', claim_row.history_key_class
    )
    or not private.valid_encrypted_write_cipher(
      response_cipher, p_owner_id, 'idempotency:' || p_idempotency_key, 1,
      'idempotency_response', claim_row.history_key_class
    )
    or not private.valid_encrypted_write_mac(
      note_verification_mac, p_owner_id,
      privacy_value::text::public.content_key_class, false
    )
    or not private.valid_encrypted_write_mac(
      mutation_verification_mac, p_owner_id, claim_row.history_key_class, false
    )
    or not private.valid_encrypted_write_mac(
      response_verification_mac, p_owner_id, claim_row.history_key_class, false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  perform private.assert_encrypted_note_relationships(
    p_owner_id, p_note_id, state_value
  );
  perform private.consume_content_key_reservations(
    p_owner_id,
    jsonb_build_array(
      note_cipher, revision_cipher, mutation_cipher, response_cipher
    ),
    'encrypted_note_create', claim_row.mutation_id
  );

  insert into public.notes (
    id, user_id, space_id, type, title, body_markdown, structured_data,
    current_revision, daily_date, is_open, pinned_at, privacy, archived_at,
    deleted_at, content_envelope, content_key_id, content_key_class,
    content_key_purpose, content_key_version, created_at, updated_at
  ) values (
    p_note_id, p_owner_id, nullif(state_value ->> 'spaceId', ''),
    note_type_value, state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', 1,
    nullif(state_value ->> 'dailyDate', '')::date,
    (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz,
    privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    note_cipher -> 'envelope', note_cipher ->> 'keyId',
    (note_cipher ->> 'keyClass')::public.content_key_class,
    (note_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (note_cipher ->> 'keyVersion')::integer,
    claim_row.occurred_at, claim_row.occurred_at
  );

  insert into public.note_mutations (
    id, user_id, decision_id, note_id, idempotency_key, before_revision,
    after_revision, operations, inverse, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, null, p_note_id, p_idempotency_key,
    0, 1, mutation_value -> 'operations', mutation_value -> 'inverse',
    mutation_cipher -> 'envelope', mutation_cipher ->> 'keyId',
    (mutation_cipher ->> 'keyClass')::public.content_key_class,
    (mutation_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (mutation_cipher ->> 'keyVersion')::integer, claim_row.occurred_at
  );

  perform private.restore_note_relations(
    p_owner_id, p_note_id,
    jsonb_build_object(
      'tagIds', state_value -> 'tagIds', 'links', state_value -> 'links'
    ),
    claim_row.mutation_id
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
    claim_row.revision_id, p_note_id, p_owner_id, 1, source_value,
    nullif(state_value ->> 'spaceId', ''), note_type_value,
    state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    state_value -> 'tagIds', state_value -> 'links',
    revision_mac ->> 'mac', revision_value ->> 'actor', claim_row.mutation_id,
    revision_cipher -> 'envelope', revision_cipher ->> 'keyId',
    (revision_cipher ->> 'keyClass')::public.content_key_class,
    (revision_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (revision_cipher ->> 'keyVersion')::integer,
    revision_mac ->> 'mac', revision_mac ->> 'keyId',
    (revision_mac ->> 'keyClass')::public.content_key_class,
    (revision_mac ->> 'keyPurpose')::public.content_key_purpose,
    (revision_mac ->> 'keyVersion')::integer, claim_row.occurred_at
  );

  perform private.emit_user_event(p_owner_id, 'note', p_note_id);
  perform private.emit_user_event(
    p_owner_id, 'note_revision', claim_row.revision_id
  );
  perform private.emit_user_event(
    p_owner_id, 'note_mutation', claim_row.mutation_id
  );
  index_job_count := private.enqueue_encrypted_note_index_jobs(
    p_owner_id, p_note_id, 1, privacy_value, true
  );

  perform private.finish_encrypted_note_write(
    claim_row, request_mac_value, response_cipher, 1
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_revision', claim_row.revision_id, 1,
    revision_cipher -> 'envelope', revision_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_content', p_note_id, 1,
    note_cipher -> 'envelope', note_verification_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_mutation', claim_row.mutation_id, 1,
    mutation_cipher -> 'envelope', mutation_verification_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'idempotency_response',
    'idempotency:' || p_idempotency_key, 1,
    response_cipher -> 'envelope', response_verification_mac
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 4,
    verified_object_count = verified_object_count + 4
  where user_id = p_owner_id;
  return private.encrypted_note_write_result(
    p_owner_id, p_idempotency_key, false
  ) || jsonb_build_object('indexJobCount', index_job_count);
end;
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC unless explicitly
-- revoked.  C.5b intentionally exposes a small owner-explicit service RPC
-- surface; the implementation helpers and trigger functions are never an API.
revoke execute on function private.valid_encrypted_write_cipher(
  jsonb, uuid, text, integer, text, public.content_key_class
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.valid_safe_reason_codes(text[])
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.set_note_updated_at()
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.valid_encrypted_write_mac(
  jsonb, uuid, public.content_key_class, boolean
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.consume_content_key_reservations(
  uuid, jsonb, text, text
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.encrypted_cipher_projection(
  jsonb, text, public.content_key_class, public.content_key_purpose, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.encrypted_mac_projection(
  text, text, public.content_key_class, public.content_key_purpose, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.note_revision_snapshot_projection(
  public.note_revisions
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.record_content_encryption_verification(
  uuid, text, text, integer, jsonb, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.reject_revision_update()
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.content_key_service_projection(
  public.user_content_keys
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.encrypted_note_claim_projection(
  public.encrypted_note_write_claims
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.valid_encrypted_note_state(jsonb)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.assert_encrypted_note_relationships(
  uuid, text, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.enqueue_encrypted_note_index_jobs(
  uuid, text, integer, public.privacy_mode, boolean
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.encrypted_note_write_result(
  uuid, text, boolean
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.lock_encrypted_note_write_claim(
  uuid, text, text, text, integer, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.finish_encrypted_note_write(
  public.encrypted_note_write_claims, jsonb, jsonb, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.enforce_encrypted_rollout_write()
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.invalidate_content_encryption_verification()
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function private.serialize_content_rollout_delete()
from public, anon, authenticated, unfiled_index_worker;

revoke execute on function public.reserve_content_key_operations(
  uuid, uuid, public.content_key_class, text, integer, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_active_user_content_key(
  uuid, public.content_key_class, public.content_key_purpose
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_user_content_key_by_id(
  uuid, text, public.content_key_class, public.content_key_purpose
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_user_content_key_status(
  uuid, public.content_key_class, public.content_key_purpose
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.prepare_encrypted_note_write(
  uuid, text, text, text, integer, public.privacy_mode, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_note_write_claim(
  uuid, text, text
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.create_encrypted_note(
  uuid, text, text, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.legacy_plaintext_reads_allowed(uuid)
from public, anon, authenticated, unfiled_index_worker;

grant execute on function public.reserve_content_key_operations(
  uuid, uuid, public.content_key_class, text, integer, integer
) to service_role;
grant execute on function public.get_active_user_content_key(
  uuid, public.content_key_class, public.content_key_purpose
) to service_role;
grant execute on function public.get_user_content_key_by_id(
  uuid, text, public.content_key_class, public.content_key_purpose
) to service_role;
grant execute on function public.get_user_content_key_status(
  uuid, public.content_key_class, public.content_key_purpose
) to service_role;
grant execute on function public.prepare_encrypted_note_write(
  uuid, text, text, text, integer, public.privacy_mode, jsonb
) to service_role;
grant execute on function public.get_encrypted_note_write_claim(
  uuid, text, text
) to service_role;
grant execute on function public.create_encrypted_note(uuid, text, text, jsonb)
to service_role;

-- Authenticated clients need only this boolean policy helper; it is owner
-- checked internally and exposes no content.  Service reads it during audits.
grant execute on function public.legacy_plaintext_reads_allowed(uuid)
to authenticated, service_role;

-- Reassert the dedicated index worker capability after creating C.5b RPCs.
-- Its allowlist remains exactly the six content-free/index-cipher functions
-- established in C.5a.
revoke execute on all functions in schema public from unfiled_index_worker;
grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to unfiled_index_worker;
grant execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) to unfiled_index_worker;
grant execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) to unfiled_index_worker;
grant execute on function public.fail_note_index_job(
  text, uuid, public.safe_error_code, boolean, integer
) to unfiled_index_worker;
grant execute on function public.recover_stale_note_index_jobs(integer)
to unfiled_index_worker;
grant execute on function public.list_active_note_rag_index(
  uuid, text, integer
) to unfiled_index_worker;

create or replace function public.apply_encrypted_note_mutation(
  p_owner_id uuid,
  p_note_id text,
  p_expected_revision integer,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_note_write_claims%rowtype;
  note_row public.notes%rowtype;
  state_value jsonb;
  note_cipher jsonb;
  revision_value jsonb;
  mutation_value jsonb;
  response_cipher jsonb;
  request_mac_value jsonb;
  revision_cipher jsonb;
  revision_mac jsonb;
  mutation_cipher jsonb;
  operation jsonb;
  verification_value jsonb;
  note_verification_mac jsonb;
  mutation_verification_mac jsonb;
  response_verification_mac jsonb;
  note_type_value public.note_type;
  privacy_value public.privacy_mode;
  expected_history_class public.content_key_class;
  source_value public.revision_source;
  decision_id_value text;
  undo_target_id_value text;
  undo_target_row public.note_mutations%rowtype;
  occurred_value timestamptz;
  new_revision integer := p_expected_revision + 1;
  index_job_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_expected_revision is null
    or p_expected_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  claim_row := private.lock_encrypted_note_write_claim(
    p_owner_id, p_idempotency_key, 'apply_encrypted_note_mutation',
    p_note_id, p_expected_revision, p_command -> 'requestMac'
  );
  if claim_row.completed_at is not null then
    return private.encrypted_note_write_result(
      p_owner_id, p_idempotency_key, true
    );
  end if;

  if p_command - array[
      'noteState', 'noteCipher', 'revision', 'mutation', 'requestMac',
      'responseCipher', 'occurredAt', 'verification'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'noteState', 'noteCipher', 'revision', 'mutation', 'requestMac',
      'responseCipher', 'occurredAt', 'verification'
    ]
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or jsonb_typeof(p_command -> 'verification') <> 'object'
    or jsonb_typeof(p_command -> 'revision') <> 'object'
    or jsonb_typeof(p_command -> 'mutation') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  state_value := p_command -> 'noteState';
  note_cipher := p_command -> 'noteCipher';
  revision_value := p_command -> 'revision';
  mutation_value := p_command -> 'mutation';
  request_mac_value := p_command -> 'requestMac';
  response_cipher := p_command -> 'responseCipher';
  occurred_value := (p_command ->> 'occurredAt')::timestamptz;
  verification_value := p_command -> 'verification';
  note_verification_mac := verification_value -> 'noteContent';
  mutation_verification_mac := verification_value -> 'noteMutation';
  response_verification_mac := verification_value -> 'idempotencyResponse';

  if not private.valid_encrypted_note_state(state_value)
    or revision_value - array['id', 'source', 'actor', 'cipher', 'mac']
      <> '{}'::jsonb
    or not revision_value ?& array['id', 'source', 'actor', 'cipher', 'mac']
    or mutation_value - array[
      'id', 'decisionId', 'undoTargetMutationId',
      'operations', 'inverse', 'cipher'
    ] <> '{}'::jsonb
    or not mutation_value ?& array[
      'id', 'decisionId', 'undoTargetMutationId',
      'operations', 'inverse', 'cipher'
    ]
    or revision_value ->> 'id' <> claim_row.revision_id
    or mutation_value ->> 'id' <> claim_row.mutation_id
    or jsonb_typeof(revision_value -> 'source') <> 'string'
    or jsonb_typeof(revision_value -> 'actor') <> 'string'
    or revision_value ->> 'actor'
      !~ '^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or jsonb_typeof(mutation_value -> 'decisionId') not in ('string', 'null')
    or jsonb_typeof(mutation_value -> 'undoTargetMutationId')
      not in ('string', 'null')
    or (jsonb_typeof(mutation_value -> 'undoTargetMutationId') = 'string'
      and mutation_value ->> 'undoTargetMutationId'
        !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$')
    or jsonb_typeof(mutation_value -> 'operations') <> 'array'
    or jsonb_array_length(mutation_value -> 'operations') not between 1 and 20
    or jsonb_typeof(mutation_value -> 'inverse') not in ('array', 'object')
    or occurred_value <> claim_row.occurred_at
    or verification_value - array[
      'noteContent', 'noteMutation', 'idempotencyResponse'
    ] <> '{}'::jsonb
    or not verification_value ?& array[
      'noteContent', 'noteMutation', 'idempotencyResponse'
    ]
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for operation in select value
    from jsonb_array_elements(mutation_value -> 'operations')
  loop
    if not private.valid_user_operation_shape(operation) then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  end loop;

  begin
    note_type_value := (state_value ->> 'type')::public.note_type;
    privacy_value := (state_value ->> 'privacy')::public.privacy_mode;
    source_value := (revision_value ->> 'source')::public.revision_source;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  select * into note_row
  from public.notes
  where user_id = p_owner_id and id = p_note_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if note_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  if note_row.privacy is distinct from claim_row.source_privacy then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  expected_history_class := case
    when claim_row.source_privacy = 'private_manual'
      or privacy_value = 'private_manual'
    then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class
  end;
  if expected_history_class <> claim_row.history_key_class
    or privacy_value <> claim_row.target_privacy
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_class';
  end if;

  decision_id_value := nullif(mutation_value ->> 'decisionId', '');
  if decision_id_value is not null and not exists (
    select 1 from public.organization_decisions
    where user_id = p_owner_id and id = decision_id_value
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  undo_target_id_value := nullif(
    mutation_value ->> 'undoTargetMutationId', ''
  );
  if (source_value = 'undo') is distinct from
      (undo_target_id_value is not null)
    or undo_target_id_value = claim_row.mutation_id
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if undo_target_id_value is not null then
    select * into undo_target_row
    from public.note_mutations
    where user_id = p_owner_id and id = undo_target_id_value
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if undo_target_row.note_id <> p_note_id then
      raise exception using errcode = 'P0001', message = 'invalid_undo_target';
    end if;
    if undo_target_row.undone_at is not null then
      raise exception using errcode = 'P0001', message = 'already_undone';
    end if;
    if undo_target_row.after_revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;

  revision_cipher := revision_value -> 'cipher';
  revision_mac := revision_value -> 'mac';
  mutation_cipher := mutation_value -> 'cipher';
  if not private.valid_encrypted_write_cipher(
      note_cipher, p_owner_id, p_note_id, new_revision, 'note_content',
      privacy_value::text::public.content_key_class
    )
    or not private.valid_encrypted_write_cipher(
      revision_cipher, p_owner_id, claim_row.revision_id, new_revision,
      'note_revision', expected_history_class
    )
    or not private.valid_encrypted_write_mac(
      revision_mac, p_owner_id, expected_history_class, false
    )
    or not private.valid_encrypted_write_cipher(
      mutation_cipher, p_owner_id, claim_row.mutation_id, new_revision,
      'note_mutation', expected_history_class
    )
    or not private.valid_encrypted_write_cipher(
      response_cipher, p_owner_id, 'idempotency:' || p_idempotency_key, 1,
      'idempotency_response', expected_history_class
    )
    or not private.valid_encrypted_write_mac(
      note_verification_mac, p_owner_id,
      privacy_value::text::public.content_key_class, false
    )
    or not private.valid_encrypted_write_mac(
      mutation_verification_mac, p_owner_id, expected_history_class, false
    )
    or not private.valid_encrypted_write_mac(
      response_verification_mac, p_owner_id, expected_history_class, false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  perform private.assert_encrypted_note_relationships(
    p_owner_id, p_note_id, state_value
  );
  perform private.consume_content_key_reservations(
    p_owner_id,
    jsonb_build_array(
      note_cipher, revision_cipher, mutation_cipher, response_cipher
    ),
    'encrypted_note_mutation', claim_row.mutation_id
  );

  update public.notes
  set
    space_id = nullif(state_value ->> 'spaceId', ''),
    type = note_type_value,
    title = state_value ->> 'title',
    body_markdown = state_value ->> 'bodyMarkdown',
    structured_data = state_value -> 'structuredData',
    current_revision = new_revision,
    daily_date = nullif(state_value ->> 'dailyDate', '')::date,
    is_open = (state_value ->> 'isOpen')::boolean,
    pinned_at = nullif(state_value ->> 'pinnedAt', '')::timestamptz,
    privacy = privacy_value,
    archived_at = nullif(state_value ->> 'archivedAt', '')::timestamptz,
    deleted_at = nullif(state_value ->> 'deletedAt', '')::timestamptz,
    content_envelope = note_cipher -> 'envelope',
    content_key_id = note_cipher ->> 'keyId',
    content_key_class =
      (note_cipher ->> 'keyClass')::public.content_key_class,
    content_key_purpose =
      (note_cipher ->> 'keyPurpose')::public.content_key_purpose,
    content_key_version = (note_cipher ->> 'keyVersion')::integer,
    updated_at = claim_row.occurred_at
  where user_id = p_owner_id
    and id = p_note_id
    and current_revision = p_expected_revision;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  if undo_target_id_value is not null then
    update public.note_mutations
    set undone_at = claim_row.occurred_at
    where user_id = p_owner_id
      and id = undo_target_id_value
      and note_id = p_note_id
      and after_revision = p_expected_revision
      and undone_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;

  insert into public.note_mutations (
    id, user_id, decision_id, note_id, idempotency_key, before_revision,
    after_revision, operations, inverse, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, decision_id_value, p_note_id,
    p_idempotency_key, p_expected_revision, new_revision,
    mutation_value -> 'operations', mutation_value -> 'inverse',
    mutation_cipher -> 'envelope', mutation_cipher ->> 'keyId',
    (mutation_cipher ->> 'keyClass')::public.content_key_class,
    (mutation_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (mutation_cipher ->> 'keyVersion')::integer, claim_row.occurred_at
  );

  perform private.restore_note_relations(
    p_owner_id, p_note_id,
    jsonb_build_object(
      'tagIds', state_value -> 'tagIds', 'links', state_value -> 'links'
    ),
    claim_row.mutation_id
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
    claim_row.revision_id, p_note_id, p_owner_id, new_revision, source_value,
    nullif(state_value ->> 'spaceId', ''), note_type_value,
    state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    state_value -> 'tagIds', state_value -> 'links',
    revision_mac ->> 'mac', revision_value ->> 'actor', claim_row.mutation_id,
    revision_cipher -> 'envelope', revision_cipher ->> 'keyId',
    (revision_cipher ->> 'keyClass')::public.content_key_class,
    (revision_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (revision_cipher ->> 'keyVersion')::integer,
    revision_mac ->> 'mac', revision_mac ->> 'keyId',
    (revision_mac ->> 'keyClass')::public.content_key_class,
    (revision_mac ->> 'keyPurpose')::public.content_key_purpose,
    (revision_mac ->> 'keyVersion')::integer, claim_row.occurred_at
  );

  perform private.emit_user_event(p_owner_id, 'note', p_note_id);
  perform private.emit_user_event(
    p_owner_id, 'note_revision', claim_row.revision_id
  );
  perform private.emit_user_event(
    p_owner_id, 'note_mutation', claim_row.mutation_id
  );
  index_job_count := private.enqueue_encrypted_note_index_jobs(
    p_owner_id, p_note_id, new_revision, privacy_value, false
  );

  perform private.finish_encrypted_note_write(
    claim_row, request_mac_value, response_cipher, new_revision
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_revision', claim_row.revision_id, new_revision,
    revision_cipher -> 'envelope', revision_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_content', p_note_id, new_revision,
    note_cipher -> 'envelope', note_verification_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'note_mutation', claim_row.mutation_id, new_revision,
    mutation_cipher -> 'envelope', mutation_verification_mac
  );
  perform private.record_content_encryption_verification(
    p_owner_id, 'idempotency_response',
    'idempotency:' || p_idempotency_key, 1,
    response_cipher -> 'envelope', response_verification_mac
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 4,
    verified_object_count = verified_object_count + 4
  where user_id = p_owner_id;
  return private.encrypted_note_write_result(
    p_owner_id, p_idempotency_key, false
  ) || jsonb_build_object('indexJobCount', index_job_count);
end;
$$;

-- Bounded plaintext capability used only while an owner is in dual_write.
-- Each cursor is globally ordered by a fixed surface rank plus resource ID;
-- commit_content_encryption_backfill rechecks the exact content and version.
create or replace function public.list_content_encryption_backfill_candidates(
  p_owner_id uuid,
  p_surface text,
  p_after_cursor text default null,
  p_limit integer default 25
)
returns table (
  cursor text,
  resource_id text,
  record_version integer,
  key_class public.content_key_class,
  expected_content jsonb,
  operational jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_surface not in (
      'space_display', 'tag_display', 'note_content', 'note_revision',
      'organization_decision', 'note_mutation', 'generated_block',
      'review_item', 'routing_rule', 'organization_mutation_attempt',
      'idempotency_response', 'capture_receipt', 'capture'
    )
    or p_limit is null or p_limit not between 1 and 50
    or (
      p_after_cursor is not null
      and (
        char_length(p_after_cursor) > 300
        or p_after_cursor !~ '^[0-9]{2}:[a-z_]+:.{1,200}$'
      )
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state = 'dual_write'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  if p_surface = 'space_display' then
    return query select
      '01:space_display:' || space.id, space.id, space.current_revision,
      'private_manual'::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1, 'name', space.name, 'slug', space.slug
      ),
      jsonb_build_object(
        'parentId', space.parent_id, 'sortKey', space.sort_key,
        'archivedAt', space.archived_at, 'updatedAt', space.updated_at
      )
    from public.spaces as space
    where space.user_id = p_owner_id and space.display_envelope is null
      and '01:space_display:' || space.id > coalesce(p_after_cursor, '')
    order by space.id limit p_limit;
  elsif p_surface = 'tag_display' then
    return query select
      '02:tag_display:' || tag.id, tag.id, tag.current_revision,
      'private_manual'::public.content_key_class,
      jsonb_build_object('schemaVersion', 1, 'name', tag.name),
      jsonb_build_object('updatedAt', tag.updated_at)
    from public.tags as tag
    where tag.user_id = p_owner_id and tag.display_envelope is null
      and '02:tag_display:' || tag.id > coalesce(p_after_cursor, '')
    order by tag.id limit p_limit;
  elsif p_surface = 'note_content' then
    return query select
      '03:note_content:' || note.id, note.id, note.current_revision,
      note.privacy::text::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1, 'title', note.title,
        'bodyMarkdown', note.body_markdown,
        'structuredData', note.structured_data
      ),
      jsonb_build_object(
        'spaceId', note.space_id, 'type', note.type,
        'dailyDate', note.daily_date, 'isOpen', note.is_open,
        'privacy', note.privacy, 'archivedAt', note.archived_at,
        'deletedAt', note.deleted_at, 'updatedAt', note.updated_at
      )
    from public.notes as note
    where note.user_id = p_owner_id and note.content_envelope is null
      and '03:note_content:' || note.id > coalesce(p_after_cursor, '')
    order by note.id limit p_limit;
  elsif p_surface = 'note_revision' then
    return query select
      '04:note_revision:' || revision_record.id, revision_record.id,
      revision_record.revision,
      case when revision_record.privacy = 'private_manual' or exists (
        select 1 from public.note_revisions as adjacent
        where adjacent.user_id = p_owner_id
          and adjacent.note_id = revision_record.note_id
          and adjacent.revision in (
            revision_record.revision - 1, revision_record.revision + 1
          )
          and adjacent.privacy = 'private_manual'
      ) then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class end,
      jsonb_build_object(
        'schemaVersion', 1,
        'snapshot', private.note_revision_snapshot_projection(revision_record)
      ),
      jsonb_build_object(
        'noteId', revision_record.note_id, 'source', revision_record.source,
        'privacy', revision_record.privacy, 'actor', revision_record.actor,
        'mutationId', revision_record.mutation_id,
        'createdAt', revision_record.created_at,
        'legacyContentHash', revision_record.content_hash
      )
    from public.note_revisions as revision_record
    where revision_record.user_id = p_owner_id
      and revision_record.snapshot_envelope is null
      and '04:note_revision:' || revision_record.id
        > coalesce(p_after_cursor, '')
    order by revision_record.id limit p_limit;
  elsif p_surface = 'organization_decision' then
    return query select
      '05:organization_decision:' || decision.id, decision.id,
      decision.decision_content_revision,
      'ai_assisted'::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1,
        'candidateManifest', decision.candidate_manifest,
        'signals', decision.signals, 'validatedPlan', decision.validated_plan,
        'band', decision.band
      ),
      jsonb_build_object(
        'captureId', decision.capture_id,
        'destinationNoteId', decision.destination_note_id,
        'score', decision.score, 'margin', decision.margin,
        'reasonCodes', decision.reason_codes, 'createdAt', decision.created_at
      )
    from public.organization_decisions as decision
    where decision.user_id = p_owner_id and decision.decision_envelope is null
      and '05:organization_decision:' || decision.id
        > coalesce(p_after_cursor, '')
    order by decision.id limit p_limit;
  elsif p_surface = 'note_mutation' then
    return query select
      '06:note_mutation:' || mutation.id, mutation.id,
      mutation.after_revision,
      case when exists (
        select 1 from public.note_revisions
        where user_id = p_owner_id and note_id = mutation.note_id
          and revision in (mutation.before_revision, mutation.after_revision)
          and privacy = 'private_manual'
      ) then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class end,
      jsonb_build_object(
        'schemaVersion', 1,
        'action', case when mutation.before_revision = 0
          then 'create' else 'update' end,
        'beforeRevision', mutation.before_revision,
        'afterRevision', mutation.after_revision,
        'operations', mutation.operations,
        'inverse', mutation.inverse,
        'beforeSnapshot', case when mutation.before_revision = 0 then null
          else (
            select private.note_revision_snapshot_projection(before_record)
            from public.note_revisions as before_record
            where before_record.user_id = mutation.user_id
              and before_record.note_id = mutation.note_id
              and before_record.revision = mutation.before_revision
          ) end,
        'afterSnapshot', (
          select private.note_revision_snapshot_projection(after_record)
          from public.note_revisions as after_record
          where after_record.user_id = mutation.user_id
            and after_record.note_id = mutation.note_id
            and after_record.revision = mutation.after_revision
        )
      ),
      jsonb_build_object(
        'noteId', mutation.note_id, 'decisionId', mutation.decision_id,
        'beforeRevision', mutation.before_revision,
        'afterRevision', mutation.after_revision,
        'idempotencyKey', mutation.idempotency_key,
        'undoneAt', mutation.undone_at, 'createdAt', mutation.created_at
      )
    from public.note_mutations as mutation
    where mutation.user_id = p_owner_id and mutation.mutation_envelope is null
      and '06:note_mutation:' || mutation.id > coalesce(p_after_cursor, '')
    order by mutation.id limit p_limit;
  elsif p_surface = 'generated_block' then
    return query select
      '07:generated_block:' || block.id, block.id, 1::integer,
      'ai_assisted'::public.content_key_class,
      jsonb_build_object('schemaVersion', 1, 'content', block.content),
      jsonb_build_object(
        'noteId', block.note_id, 'decisionId', block.decision_id,
        'kind', block.kind, 'state', block.state,
        'modelId', block.model_id, 'promptVersion', block.prompt_version,
        'resolvedAt', block.resolved_at, 'createdAt', block.created_at
      )
    from public.generated_blocks as block
    where block.user_id = p_owner_id and block.content_envelope is null
      and '07:generated_block:' || block.id > coalesce(p_after_cursor, '')
    order by block.id limit p_limit;
  elsif p_surface = 'review_item' then
    return query select
      '08:review_item:' || review.id, review.id,
      review.review_content_revision,
      case when (
        (review.note_id is not null and exists (
          select 1 from public.notes where user_id = p_owner_id
            and id = review.note_id and privacy = 'private_manual'
        )) or (review.capture_id is not null and exists (
          select 1 from public.captures where user_id = p_owner_id
            and id = review.capture_id and privacy = 'private_manual'
        ))
      ) then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class end,
      jsonb_build_object(
        'schemaVersion', 1,
        'choices', review.choices, 'state', review.state,
        'resolution', review.resolution
      ),
      jsonb_build_object(
        'captureId', review.capture_id, 'noteId', review.note_id,
        'type', review.type, 'createdAt', review.created_at,
        'resolvedAt', review.resolved_at
      )
    from public.review_items as review
    where review.user_id = p_owner_id and review.review_envelope is null
      and '08:review_item:' || review.id > coalesce(p_after_cursor, '')
    order by review.id limit p_limit;
  elsif p_surface = 'routing_rule' then
    return query select
      '09:routing_rule:' || rule.id, rule.id, rule.condition_revision,
      'private_manual'::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1,
        'condition', rule.condition_normalized,
        'normalizedCondition', rule.condition_normalized,
        'aliases', jsonb_build_array()
      ),
      jsonb_build_object(
        'enabled', rule.enabled, 'ruleType', rule.rule_type,
        'destinationNoteId', rule.destination_note_id,
        'destinationSpaceId', rule.destination_space_id,
        'priority', rule.priority, 'source', rule.source,
        'lastFiredAt', rule.last_fired_at, 'updatedAt', rule.updated_at
      )
    from public.routing_rules as rule
    where rule.user_id = p_owner_id and rule.condition_envelope is null
      and '09:routing_rule:' || rule.id > coalesce(p_after_cursor, '')
    order by rule.id limit p_limit;
  elsif p_surface = 'organization_mutation_attempt' then
    return query select
      '10:organization_mutation_attempt:' || attempt.job_id || ':'
        || attempt.note_id,
      attempt.job_id || ':' || attempt.note_id,
      attempt.attempt_content_revision,
      'ai_assisted'::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1, 'operations', attempt.operations
      ),
      jsonb_build_object(
        'jobId', attempt.job_id, 'noteId', attempt.note_id,
        'plannedRevision', attempt.planned_revision,
        'replanCount', attempt.replan_count, 'state', attempt.state,
        'reviewItemId', attempt.review_item_id, 'updatedAt', attempt.updated_at
      )
    from public.organization_mutation_attempts as attempt
    where attempt.user_id = p_owner_id and attempt.attempt_envelope is null
      and '10:organization_mutation_attempt:' || attempt.job_id || ':'
        || attempt.note_id > coalesce(p_after_cursor, '')
    order by attempt.job_id, attempt.note_id limit p_limit;
  elsif p_surface = 'idempotency_response' then
    return query select
      '11:idempotency_response:idempotency:' || record.idempotency_key,
      'idempotency:' || record.idempotency_key, 1::integer,
      'private_manual'::public.content_key_class,
      jsonb_build_object(
        'requestHash', record.request_hash,
        'responseJson', record.response_json,
        'requestResourceType', 'legacy_idempotency',
        'requestResourceId', 'idempotency:' || record.idempotency_key,
        'responseResourceType', 'legacy_response',
        'responseResourceId', 'idempotency:' || record.idempotency_key,
        'responseRecordVersion', 1
      ),
      jsonb_build_object(
        'scope', record.scope, 'createdAt', record.created_at,
        'completedAt', record.completed_at,
        'replayPolicy', record.replay_policy
      )
    from public.api_idempotency_records as record
    where record.user_id = p_owner_id and record.response_envelope is null
      and '11:idempotency_response:idempotency:' || record.idempotency_key
        > coalesce(p_after_cursor, '')
    order by record.idempotency_key limit p_limit;
  elsif p_surface = 'capture_receipt' then
    return query select
      '12:capture_receipt:' || receipt.capture_id, receipt.capture_id,
      receipt.receipt_revision,
      capture.privacy::text::public.content_key_class,
      jsonb_build_object(
        'schemaVersion', 1,
        'captureId', receipt.capture_id,
        'jobId', receipt.job_id,
        'decisionId', receipt.decision_id,
        'reviewItemId', receipt.review_item_id,
        'mutationId', receipt.mutation_id,
        'outcome', receipt.outcome,
        'headline', receipt.headline,
        'destination', case when receipt.destination_note_id is null then null
          else jsonb_build_object(
            'noteId', receipt.destination_note_id,
            'title', destination.title
          ) end,
        'insertedContentReferences', receipt.inserted_content,
        'actions', receipt.actions,
        'reasonCodes', to_jsonb(receipt.reason_codes),
        'createdAt', receipt.created_at
      ),
      jsonb_build_object(
        'jobId', receipt.job_id, 'decisionId', receipt.decision_id,
        'reviewItemId', receipt.review_item_id,
        'mutationId', receipt.mutation_id, 'outcome', receipt.outcome,
        'destinationNoteId', receipt.destination_note_id,
        'reasonCodes', receipt.reason_codes, 'createdAt', receipt.created_at
      )
    from public.capture_receipts as receipt
    join public.captures as capture on capture.user_id = receipt.user_id
      and capture.id = receipt.capture_id
    left join public.notes as destination
      on destination.user_id = receipt.user_id
      and destination.id = receipt.destination_note_id
    where receipt.user_id = p_owner_id and receipt.receipt_envelope is null
      and '12:capture_receipt:' || receipt.capture_id
        > coalesce(p_after_cursor, '')
    order by receipt.capture_id limit p_limit;
  else
    return query select
      '13:capture:' || capture.id, capture.id, 1::integer,
      capture.privacy::text::public.content_key_class,
      jsonb_build_object(
        'contentEnvelope', capture.content_envelope,
        'contentFingerprint', capture.content_fingerprint
      ),
      jsonb_build_object(
        'source', capture.source, 'deviceId', capture.device_id,
        'contentLength', capture.content_length,
        'clientCreatedAt', capture.client_created_at,
        'clientTimezone', capture.client_timezone,
        'privacy', capture.privacy, 'status', capture.status
      )
    from public.captures as capture
    where capture.user_id = p_owner_id and capture.content_key_id is null
      and capture.deleted_at is null and capture.status <> 'deleted'
      and '13:capture:' || capture.id > coalesce(p_after_cursor, '')
    order by capture.id limit p_limit;
  end if;
end;
$$;

create or replace function public.commit_content_encryption_backfill(
  p_owner_id uuid,
  p_surface text,
  p_resource_id text,
  p_expected_record_version integer,
  p_expected_content jsonb,
  p_cipher jsonb,
  p_content_mac jsonb,
  p_verification_mac jsonb,
  p_batch_reference text,
  p_expected_cursor text,
  p_next_cursor text,
  p_complete boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  expected_class public.content_key_class;
  actual_content jsonb;
  envelope_digest_value text;
  space_row public.spaces%rowtype;
  tag_row public.tags%rowtype;
  note_row public.notes%rowtype;
  revision_row public.note_revisions%rowtype;
  decision_row public.organization_decisions%rowtype;
  mutation_row public.note_mutations%rowtype;
  block_row public.generated_blocks%rowtype;
  review_row public.review_items%rowtype;
  rule_row public.routing_rules%rowtype;
  attempt_row public.organization_mutation_attempts%rowtype;
  idempotency_row public.api_idempotency_records%rowtype;
  receipt_row public.capture_receipts%rowtype;
  destination_title_value text;
  updated_count integer;
  request_digest_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_surface not in (
      'space_display', 'tag_display', 'note_content', 'note_revision',
      'organization_decision', 'note_mutation', 'generated_block',
      'review_item', 'routing_rule', 'organization_mutation_attempt',
      'idempotency_response', 'capture_receipt'
    )
    or p_resource_id is null
    or char_length(p_resource_id) not between 1 and 200
    or p_expected_record_version is null
    or p_expected_record_version < 1
    or p_expected_content is null
    or jsonb_typeof(p_expected_content) <> 'object'
    or p_batch_reference is null
    or char_length(p_batch_reference) not between 1 and 120
    or p_complete is null
    or (p_complete and p_next_cursor is not null)
    or (not p_complete and (
      p_next_cursor is null
      or p_next_cursor <= coalesce(p_expected_cursor, '')
    ))
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  envelope_digest_value := encode(
    extensions.digest((p_cipher -> 'envelope')::text, 'sha256'), 'hex'
  );
  request_digest_value := encode(extensions.digest(jsonb_build_object(
    'ownerId', p_owner_id,
    'surface', p_surface,
    'resourceId', p_resource_id,
    'expectedRecordVersion', p_expected_record_version,
    'expectedContent', p_expected_content,
    'cipher', p_cipher,
    'contentMac', p_content_mac,
    'verificationMac', p_verification_mac,
    'batchReference', p_batch_reference,
    'expectedCursor', p_expected_cursor,
    'nextCursor', p_next_cursor,
    'complete', p_complete
  )::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rollout_row.state <> 'dual_write' then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  if rollout_row.last_backfill_batch_reference = p_batch_reference then
    if rollout_row.last_backfill_surface <> p_surface
      or rollout_row.last_backfill_resource_id <> p_resource_id
      or rollout_row.last_backfill_expected_cursor is distinct from p_expected_cursor
      or rollout_row.last_backfill_next_cursor is distinct from p_next_cursor
      or rollout_row.last_backfill_encrypted_delta <> 1
      or rollout_row.last_backfill_verified_delta <> 1
      or rollout_row.last_backfill_complete <> p_complete
      or rollout_row.last_backfill_envelope_digest <> envelope_digest_value
      or rollout_row.last_backfill_request_digest <> request_digest_value
      or jsonb_typeof(p_verification_mac) <> 'object'
      or p_verification_mac - array[
        'mac', 'keyId', 'keyClass', 'keyPurpose', 'keyVersion'
      ] <> '{}'::jsonb
      or not exists (
        select 1
        from public.content_encryption_verifications as verification
        join public.user_content_keys as mac_key
          on mac_key.user_id = verification.user_id
          and mac_key.key_id = verification.verification_mac_key_id
          and mac_key.key_class = verification.verification_mac_key_class
          and mac_key.key_purpose = verification.verification_mac_key_purpose
          and mac_key.key_version = verification.verification_mac_key_version
          and mac_key.state in ('active', 'retired')
        where verification.user_id = p_owner_id
          and verification.surface = p_surface
          and verification.resource_id = p_resource_id
          and verification.record_version = p_expected_record_version
          and verification.envelope_digest = envelope_digest_value
          and verification.verification_mac = p_verification_mac ->> 'mac'
          and verification.verification_mac_key_id = p_verification_mac ->> 'keyId'
          and verification.verification_mac_key_class::text =
            p_verification_mac ->> 'keyClass'
          and verification.verification_mac_key_purpose::text =
            p_verification_mac ->> 'keyPurpose'
          and to_jsonb(verification.verification_mac_key_version) =
            p_verification_mac -> 'keyVersion'
      )
      or (
        p_surface = 'space_display' and not exists (
          select 1 from public.spaces as space
          where space.user_id = p_owner_id and space.id = p_resource_id
            and space.display_mac = p_content_mac ->> 'mac'
            and space.display_mac_key_id = p_content_mac ->> 'keyId'
            and space.display_mac_key_class::text = p_content_mac ->> 'keyClass'
            and space.display_mac_key_purpose::text = p_content_mac ->> 'keyPurpose'
            and to_jsonb(space.display_mac_key_version) = p_content_mac -> 'keyVersion'
        )
      )
      or (
        p_surface = 'tag_display' and not exists (
          select 1 from public.tags as tag
          where tag.user_id = p_owner_id and tag.id = p_resource_id
            and tag.display_mac = p_content_mac ->> 'mac'
            and tag.display_mac_key_id = p_content_mac ->> 'keyId'
            and tag.display_mac_key_class::text = p_content_mac ->> 'keyClass'
            and tag.display_mac_key_purpose::text = p_content_mac ->> 'keyPurpose'
            and to_jsonb(tag.display_mac_key_version) = p_content_mac -> 'keyVersion'
        )
      )
      or (
        p_surface = 'note_revision' and not exists (
          select 1 from public.note_revisions as revision
          where revision.user_id = p_owner_id and revision.id = p_resource_id
            and revision.snapshot_mac = p_content_mac ->> 'mac'
            and revision.snapshot_mac_key_id = p_content_mac ->> 'keyId'
            and revision.snapshot_mac_key_class::text = p_content_mac ->> 'keyClass'
            and revision.snapshot_mac_key_purpose::text = p_content_mac ->> 'keyPurpose'
            and to_jsonb(revision.snapshot_mac_key_version) = p_content_mac -> 'keyVersion'
        )
      )
      or (
        p_surface not in ('space_display', 'tag_display', 'note_revision')
        and p_content_mac is not null
        and jsonb_typeof(p_content_mac) <> 'null'
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'surface', p_surface,
      'resourceId', p_resource_id,
      'recordVersion', p_expected_record_version,
      'cursor', rollout_row.backfill_cursor,
      'complete', rollout_row.backfill_completed_at is not null,
      'replayed', true
    );
  end if;
  if rollout_row.backfill_completed_at is not null
    or rollout_row.backfill_cursor is distinct from p_expected_cursor
  then
    raise exception using errcode = 'P0001', message = 'stale_backfill_cursor';
  end if;

  if p_surface = 'space_display' then
    select * into space_row from public.spaces
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1, 'name', space_row.name, 'slug', space_row.slug
    );
    if space_row.current_revision <> p_expected_record_version
      or actual_content <> p_expected_content or space_row.display_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'private_manual';
  elsif p_surface = 'tag_display' then
    select * into tag_row from public.tags
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1, 'name', tag_row.name
    );
    if tag_row.current_revision <> p_expected_record_version
      or actual_content <> p_expected_content or tag_row.display_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'private_manual';
  elsif p_surface = 'note_content' then
    select * into note_row from public.notes
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1, 'title', note_row.title,
      'bodyMarkdown', note_row.body_markdown,
      'structuredData', note_row.structured_data
    );
    if note_row.current_revision <> p_expected_record_version
      or actual_content <> p_expected_content or note_row.content_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := note_row.privacy::text::public.content_key_class;
  elsif p_surface = 'note_revision' then
    select * into revision_row from public.note_revisions
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'snapshot', private.note_revision_snapshot_projection(revision_row)
    );
    if revision_row.revision <> p_expected_record_version
      or actual_content <> p_expected_content
      or revision_row.snapshot_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := case
      when revision_row.privacy = 'private_manual'
        or exists (
          select 1 from public.note_revisions as adjacent
          where adjacent.user_id = p_owner_id
            and adjacent.note_id = revision_row.note_id
            and adjacent.revision in (
              revision_row.revision - 1, revision_row.revision + 1
            )
            and adjacent.privacy = 'private_manual'
        )
      then 'private_manual'::public.content_key_class
      else 'ai_assisted'::public.content_key_class end;
  elsif p_surface = 'organization_decision' then
    select * into decision_row from public.organization_decisions
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'candidateManifest', decision_row.candidate_manifest,
      'signals', decision_row.signals,
      'validatedPlan', decision_row.validated_plan,
      'band', decision_row.band
    );
    if decision_row.decision_content_revision <> p_expected_record_version
      or actual_content <> p_expected_content or decision_row.decision_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'ai_assisted';
  elsif p_surface = 'note_mutation' then
    select * into mutation_row from public.note_mutations
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'action', case when mutation_row.before_revision = 0
        then 'create' else 'update' end,
      'beforeRevision', mutation_row.before_revision,
      'afterRevision', mutation_row.after_revision,
      'operations', mutation_row.operations,
      'inverse', mutation_row.inverse,
      'beforeSnapshot', case when mutation_row.before_revision = 0 then null
        else (
          select private.note_revision_snapshot_projection(before_revision)
          from public.note_revisions as before_revision
          where before_revision.user_id = mutation_row.user_id
            and before_revision.note_id = mutation_row.note_id
            and before_revision.revision = mutation_row.before_revision
        ) end,
      'afterSnapshot', (
        select private.note_revision_snapshot_projection(after_revision)
        from public.note_revisions as after_revision
        where after_revision.user_id = mutation_row.user_id
          and after_revision.note_id = mutation_row.note_id
          and after_revision.revision = mutation_row.after_revision
      )
    );
    if mutation_row.after_revision <> p_expected_record_version
      or actual_content <> p_expected_content or mutation_row.mutation_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := case when exists (
      select 1 from public.note_revisions
      where user_id = p_owner_id and note_id = mutation_row.note_id
        and revision in (mutation_row.before_revision, mutation_row.after_revision)
        and privacy = 'private_manual'
    ) then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  elsif p_surface = 'generated_block' then
    select * into block_row from public.generated_blocks
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1, 'content', block_row.content
    );
    if p_expected_record_version <> 1 or actual_content <> p_expected_content
      or block_row.content_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'ai_assisted';
  elsif p_surface = 'review_item' then
    select * into review_row from public.review_items
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'choices', review_row.choices, 'state', review_row.state,
      'resolution', review_row.resolution
    );
    if review_row.review_content_revision <> p_expected_record_version
      or actual_content <> p_expected_content or review_row.review_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := case when (
      (review_row.note_id is not null and exists (
        select 1 from public.notes where user_id = p_owner_id
          and id = review_row.note_id and privacy = 'private_manual'
      )) or (review_row.capture_id is not null and exists (
        select 1 from public.captures where user_id = p_owner_id
          and id = review_row.capture_id and privacy = 'private_manual'
      ))
    ) then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  elsif p_surface = 'routing_rule' then
    select * into rule_row from public.routing_rules
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'condition', rule_row.condition_normalized,
      'normalizedCondition', rule_row.condition_normalized,
      'aliases', jsonb_build_array()
    );
    if rule_row.condition_revision <> p_expected_record_version
      or actual_content <> p_expected_content or rule_row.condition_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'private_manual';
  elsif p_surface = 'organization_mutation_attempt' then
    select * into attempt_row from public.organization_mutation_attempts
    where user_id = p_owner_id
      and job_id || ':' || note_id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'schemaVersion', 1, 'operations', attempt_row.operations
    );
    if attempt_row.attempt_content_revision <> p_expected_record_version
      or actual_content <> p_expected_content or attempt_row.attempt_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'ai_assisted';
  elsif p_surface = 'idempotency_response' then
    select * into idempotency_row from public.api_idempotency_records
    where user_id = p_owner_id
      and 'idempotency:' || idempotency_key = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    actual_content := jsonb_build_object(
      'requestHash', idempotency_row.request_hash,
      'responseJson', idempotency_row.response_json,
      'requestResourceType', 'legacy_idempotency',
      'requestResourceId', 'idempotency:' || idempotency_row.idempotency_key,
      'responseResourceType', 'legacy_response',
      'responseResourceId', 'idempotency:' || idempotency_row.idempotency_key,
      'responseRecordVersion', 1
    );
    if p_expected_record_version <> 1
      or actual_content <> p_expected_content
      or idempotency_row.response_envelope is not null
      or idempotency_row.replay_policy <> 'legacy_nonreplayable'
      or jsonb_typeof(p_expected_content -> 'requestResourceType') <> 'string'
      or jsonb_typeof(p_expected_content -> 'requestResourceId') <> 'string'
      or jsonb_typeof(p_expected_content -> 'responseResourceType') <> 'string'
      or jsonb_typeof(p_expected_content -> 'responseResourceId') <> 'string'
      or jsonb_typeof(p_expected_content -> 'responseRecordVersion') <> 'number'
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    expected_class := 'private_manual';
  else
    select * into receipt_row from public.capture_receipts
    where user_id = p_owner_id and capture_id = p_resource_id for update;
    if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    select title into destination_title_value from public.notes
    where user_id = p_owner_id and id = receipt_row.destination_note_id;
    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'captureId', receipt_row.capture_id,
      'jobId', receipt_row.job_id,
      'decisionId', receipt_row.decision_id,
      'reviewItemId', receipt_row.review_item_id,
      'mutationId', receipt_row.mutation_id,
      'outcome', receipt_row.outcome,
      'headline', receipt_row.headline,
      'destination', case when receipt_row.destination_note_id is null
        then null else jsonb_build_object(
          'noteId', receipt_row.destination_note_id,
          'title', destination_title_value
        ) end,
      'insertedContentReferences', receipt_row.inserted_content,
      'actions', receipt_row.actions,
      'reasonCodes', to_jsonb(receipt_row.reason_codes),
      'createdAt', receipt_row.created_at
    );
    if receipt_row.receipt_revision <> p_expected_record_version
      or actual_content <> p_expected_content or receipt_row.receipt_envelope is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    select privacy::text::public.content_key_class into expected_class
    from public.captures where user_id = p_owner_id and id = p_resource_id;
  end if;

  if not private.valid_encrypted_write_cipher(
      p_cipher, p_owner_id, p_resource_id, p_expected_record_version,
      p_surface, expected_class
    )
    or not private.valid_encrypted_write_mac(
      p_verification_mac, p_owner_id, expected_class, false
    )
    or (
      p_surface in ('space_display', 'tag_display', 'note_revision')
      and not private.valid_encrypted_write_mac(
        p_content_mac, p_owner_id, expected_class, false
      )
    )
    or (
      p_surface not in ('space_display', 'tag_display', 'note_revision')
      and p_content_mac is not null
      and jsonb_typeof(p_content_mac) <> 'null'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(p_cipher), 'library_backfill',
    p_surface || ':' || p_resource_id
  );

  if p_surface = 'space_display' then
    update public.spaces set
      display_envelope = p_cipher -> 'envelope',
      display_key_id = p_cipher ->> 'keyId',
      display_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      display_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      display_key_version = (p_cipher ->> 'keyVersion')::integer,
      display_mac = p_content_mac ->> 'mac',
      display_mac_key_id = p_content_mac ->> 'keyId',
      display_mac_key_class = (p_content_mac ->> 'keyClass')::public.content_key_class,
      display_mac_key_purpose = (p_content_mac ->> 'keyPurpose')::public.content_key_purpose,
      display_mac_key_version = (p_content_mac ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'tag_display' then
    update public.tags set
      display_envelope = p_cipher -> 'envelope',
      display_key_id = p_cipher ->> 'keyId',
      display_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      display_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      display_key_version = (p_cipher ->> 'keyVersion')::integer,
      display_mac = p_content_mac ->> 'mac',
      display_mac_key_id = p_content_mac ->> 'keyId',
      display_mac_key_class = (p_content_mac ->> 'keyClass')::public.content_key_class,
      display_mac_key_purpose = (p_content_mac ->> 'keyPurpose')::public.content_key_purpose,
      display_mac_key_version = (p_content_mac ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'note_content' then
    update public.notes set
      content_envelope = p_cipher -> 'envelope', content_key_id = p_cipher ->> 'keyId',
      content_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      content_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      content_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'note_revision' then
    update public.note_revisions set
      snapshot_envelope = p_cipher -> 'envelope', snapshot_key_id = p_cipher ->> 'keyId',
      snapshot_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      snapshot_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      snapshot_key_version = (p_cipher ->> 'keyVersion')::integer,
      snapshot_mac = p_content_mac ->> 'mac',
      snapshot_mac_key_id = p_content_mac ->> 'keyId',
      snapshot_mac_key_class = (p_content_mac ->> 'keyClass')::public.content_key_class,
      snapshot_mac_key_purpose = (p_content_mac ->> 'keyPurpose')::public.content_key_purpose,
      snapshot_mac_key_version = (p_content_mac ->> 'keyVersion')::integer,
      content_hash = p_content_mac ->> 'mac'
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'organization_decision' then
    update public.organization_decisions set
      decision_envelope = p_cipher -> 'envelope', decision_key_id = p_cipher ->> 'keyId',
      decision_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      decision_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      decision_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'note_mutation' then
    update public.note_mutations set
      mutation_envelope = p_cipher -> 'envelope', mutation_key_id = p_cipher ->> 'keyId',
      mutation_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      mutation_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      mutation_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'generated_block' then
    update public.generated_blocks set
      content_envelope = p_cipher -> 'envelope', content_key_id = p_cipher ->> 'keyId',
      content_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      content_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      content_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'review_item' then
    update public.review_items set
      review_envelope = p_cipher -> 'envelope', review_key_id = p_cipher ->> 'keyId',
      review_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      review_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      review_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'routing_rule' then
    update public.routing_rules set
      condition_envelope = p_cipher -> 'envelope', condition_key_id = p_cipher ->> 'keyId',
      condition_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      condition_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      condition_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and id = p_resource_id;
  elsif p_surface = 'organization_mutation_attempt' then
    update public.organization_mutation_attempts set
      attempt_envelope = p_cipher -> 'envelope', attempt_key_id = p_cipher ->> 'keyId',
      attempt_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      attempt_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      attempt_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and job_id || ':' || note_id = p_resource_id;
  elsif p_surface = 'idempotency_response' then
    update public.api_idempotency_records set
      response_envelope = p_cipher -> 'envelope', response_key_id = p_cipher ->> 'keyId',
      response_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      response_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      response_key_version = (p_cipher ->> 'keyVersion')::integer,
      request_resource_type = p_expected_content ->> 'requestResourceType',
      request_resource_id = p_expected_content ->> 'requestResourceId',
      response_resource_type = p_expected_content ->> 'responseResourceType',
      response_resource_id = p_expected_content ->> 'responseResourceId',
      response_record_version = (p_expected_content ->> 'responseRecordVersion')::integer,
      response_json = jsonb_build_object(
        'resourceType', p_expected_content ->> 'responseResourceType',
        'resourceId', p_expected_content ->> 'responseResourceId',
        'recordVersion', (p_expected_content ->> 'responseRecordVersion')::integer
      )
    where user_id = p_owner_id and 'idempotency:' || idempotency_key = p_resource_id;
  else
    update public.capture_receipts set
      receipt_envelope = p_cipher -> 'envelope', receipt_key_id = p_cipher ->> 'keyId',
      receipt_key_class = (p_cipher ->> 'keyClass')::public.content_key_class,
      receipt_key_purpose = (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
      receipt_key_version = (p_cipher ->> 'keyVersion')::integer
    where user_id = p_owner_id and capture_id = p_resource_id;
  end if;
  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  perform private.record_content_encryption_verification(
    p_owner_id, p_surface, p_resource_id, p_expected_record_version,
    p_cipher -> 'envelope', p_verification_mac
  );
  update public.content_encryption_rollouts set
    backfill_cursor = p_next_cursor,
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1,
    backfill_completed_at = case when p_complete then clock_timestamp()
      else backfill_completed_at end,
    last_backfill_batch_reference = p_batch_reference,
    last_backfill_surface = p_surface,
    last_backfill_resource_id = p_resource_id,
    last_backfill_expected_cursor = p_expected_cursor,
    last_backfill_next_cursor = p_next_cursor,
    last_backfill_encrypted_delta = 1,
    last_backfill_verified_delta = 1,
    last_backfill_complete = p_complete,
    last_backfill_envelope_digest = envelope_digest_value,
    last_backfill_request_digest = request_digest_value
  where user_id = p_owner_id;

  return jsonb_build_object(
    'surface', p_surface,
    'resourceId', p_resource_id,
    'recordVersion', p_expected_record_version,
    'cursor', p_next_cursor,
    'complete', p_complete,
    'replayed', false
  );
end;
$$;

create or replace function public.reseal_capture_content(
  p_owner_id uuid,
  p_capture_id text,
  p_expected_envelope jsonb,
  p_expected_fingerprint text,
  p_content_cipher jsonb,
  p_content_mac jsonb,
  p_verification_mac jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  capture_row public.captures%rowtype;
  expected_class public.content_key_class;
  envelope_digest_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_envelope is null
    or p_expected_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state = 'dual_write'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into capture_row
  from public.captures
  where user_id = p_owner_id and id = p_capture_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if capture_row.deleted_at is not null or capture_row.status = 'deleted' then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  expected_class := capture_row.privacy::text::public.content_key_class;
  envelope_digest_value := encode(
    extensions.digest((p_content_cipher -> 'envelope')::text, 'sha256'), 'hex'
  );

  if capture_row.content_envelope = p_content_cipher -> 'envelope'
    and capture_row.content_fingerprint = p_content_mac ->> 'mac'
    and capture_row.content_key_id = p_content_cipher ->> 'keyId'
    and capture_row.content_key_class =
      (p_content_cipher ->> 'keyClass')::public.content_key_class
    and capture_row.content_key_purpose =
      (p_content_cipher ->> 'keyPurpose')::public.content_key_purpose
    and capture_row.content_key_version =
      (p_content_cipher ->> 'keyVersion')::integer
    and capture_row.fingerprint_key_id = p_content_mac ->> 'keyId'
    and capture_row.fingerprint_key_class =
      (p_content_mac ->> 'keyClass')::public.content_key_class
    and capture_row.fingerprint_key_purpose =
      (p_content_mac ->> 'keyPurpose')::public.content_key_purpose
    and capture_row.fingerprint_key_version =
      (p_content_mac ->> 'keyVersion')::integer
  then
    if not private.valid_encrypted_write_mac(
        p_content_mac, p_owner_id, expected_class, true
      )
      or not private.valid_encrypted_write_mac(
        p_verification_mac, p_owner_id, expected_class, true
      )
      or not exists (
      select 1 from public.content_encryption_verifications as verification
      where verification.user_id = p_owner_id
        and verification.surface = 'capture'
        and verification.resource_id = p_capture_id
        and verification.record_version = 1
        and verification.verification_mac = p_verification_mac ->> 'mac'
        and verification.verification_mac_key_id = p_verification_mac ->> 'keyId'
        and verification.verification_mac_key_class::text =
          p_verification_mac ->> 'keyClass'
        and verification.verification_mac_key_purpose::text =
          p_verification_mac ->> 'keyPurpose'
        and verification.verification_mac_key_version =
          (p_verification_mac ->> 'keyVersion')::integer
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'captureId', p_capture_id, 'envelopeDigest', envelope_digest_value,
      'replayed', true
    );
  end if;

  if capture_row.content_envelope <> p_expected_envelope
    or capture_row.content_fingerprint <> p_expected_fingerprint
    or capture_row.content_key_id is not null
    or capture_row.fingerprint_key_id is not null
  then
    raise exception using errcode = 'P0001', message = 'stale_capture_content';
  end if;
  if not private.valid_encrypted_write_cipher(
      p_content_cipher, p_owner_id, p_capture_id, 1, 'capture', expected_class
    )
    or not private.valid_encrypted_write_mac(
      p_content_mac, p_owner_id, expected_class, false
    )
    or not private.valid_encrypted_write_mac(
      p_verification_mac, p_owner_id, expected_class, false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(p_content_cipher), 'capture_reseal',
    p_capture_id
  );
  update public.captures set
    content_envelope = p_content_cipher -> 'envelope',
    content_key_id = p_content_cipher ->> 'keyId',
    content_key_class =
      (p_content_cipher ->> 'keyClass')::public.content_key_class,
    content_key_purpose =
      (p_content_cipher ->> 'keyPurpose')::public.content_key_purpose,
    content_key_version = (p_content_cipher ->> 'keyVersion')::integer,
    content_fingerprint = p_content_mac ->> 'mac',
    fingerprint_key_id = p_content_mac ->> 'keyId',
    fingerprint_key_class =
      (p_content_mac ->> 'keyClass')::public.content_key_class,
    fingerprint_key_purpose =
      (p_content_mac ->> 'keyPurpose')::public.content_key_purpose,
    fingerprint_key_version = (p_content_mac ->> 'keyVersion')::integer
  where user_id = p_owner_id and id = p_capture_id;

  perform private.record_content_encryption_verification(
    p_owner_id, 'capture', p_capture_id, 1,
    p_content_cipher -> 'envelope', p_verification_mac
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1
  where user_id = p_owner_id;
  return jsonb_build_object(
    'captureId', p_capture_id,
    'envelopeDigest', envelope_digest_value,
    'replayed', false
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.create_encrypted_capture_with_job(
  p_owner_id uuid,
  p_capture jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  capture_id_value text;
  job_id_value text;
  source_value public.capture_source;
  privacy_value public.privacy_mode;
  content_cipher jsonb;
  content_mac jsonb;
  receipt_cipher jsonb;
  receipt_mac jsonb;
  device_value text;
  created_value timestamptz;
  occurred_value timestamptz;
  timezone_value text;
  destination_value text;
  expansion_value boolean;
  content_length_value integer;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  inserted_value boolean := false;
  reservation_values jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture is null
    or jsonb_typeof(p_capture) <> 'object'
    or p_capture - array[
      'clientCaptureId', 'jobId', 'occurredAt',
      'contentCipher', 'contentMac', 'contentLength',
      'source', 'deviceId', 'clientCreatedAt', 'clientTimezone', 'privacy',
      'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac'
    ] <> '{}'::jsonb
    or not p_capture ?& array[
      'clientCaptureId', 'jobId', 'occurredAt',
      'contentCipher', 'contentMac', 'contentLength',
      'source', 'clientCreatedAt', 'clientTimezone', 'privacy',
      'privateReceiptCipher', 'privateReceiptVerificationMac'
    ]
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;

  capture_id_value := p_capture ->> 'clientCaptureId';
  job_id_value := p_capture ->> 'jobId';
  content_cipher := p_capture -> 'contentCipher';
  content_mac := p_capture -> 'contentMac';
  receipt_cipher := p_capture -> 'privateReceiptCipher';
  receipt_mac := p_capture -> 'privateReceiptVerificationMac';
  device_value := coalesce(p_capture ->> 'deviceId', '');
  timezone_value := p_capture ->> 'clientTimezone';
  destination_value := nullif(p_capture ->> 'explicitDestinationNoteId', '');
  expansion_value := coalesce(
    (p_capture ->> 'expansionDisabled')::boolean, false
  );
  if capture_id_value !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or job_id_value !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_capture ->> 'contentLength' !~ '^[1-9][0-9]{0,4}$'
    or (p_capture ->> 'contentLength')::numeric > 10000
    or not (
      device_value = ''
      or device_value ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
    )
    or char_length(timezone_value) not between 1 and 64
    or not (
      timezone_value = 'UTC'
      or timezone_value
        ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,3}$'
    )
    or not private.valid_iso_offset_datetime(p_capture ->> 'clientCreatedAt')
    or not private.valid_iso_offset_datetime(p_capture ->> 'occurredAt')
    or p_capture ->> 'occurredAt'
      !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or (destination_value is not null
      and destination_value !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$')
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  begin
    source_value := (p_capture ->> 'source')::public.capture_source;
    privacy_value := (p_capture ->> 'privacy')::public.privacy_mode;
    created_value := (p_capture ->> 'clientCreatedAt')::timestamptz;
    occurred_value := (p_capture ->> 'occurredAt')::timestamptz;
    content_length_value := (p_capture ->> 'contentLength')::integer;
  exception when invalid_text_representation or datetime_field_overflow
    or numeric_value_out_of_range
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into capture_row
  from public.captures
  where id = capture_id_value
  for update;
  if found then
    if capture_row.user_id <> p_owner_id then
      raise exception using errcode = '23505', message = 'capture_id_conflict';
    end if;
    if capture_row.deleted_at is not null
      or capture_row.content_fingerprint <> content_mac ->> 'mac'
      or capture_row.fingerprint_key_id <> content_mac ->> 'keyId'
      or capture_row.fingerprint_key_class::text <> content_mac ->> 'keyClass'
      or capture_row.fingerprint_key_purpose::text <> content_mac ->> 'keyPurpose'
      or capture_row.fingerprint_key_version
        <> (content_mac ->> 'keyVersion')::integer
      or capture_row.source <> source_value
      or capture_row.device_id <> device_value
      or capture_row.content_length <> content_length_value
      or capture_row.client_created_at <> created_value
      or capture_row.received_at <> occurred_value
      or capture_row.client_timezone <> timezone_value
      or capture_row.privacy <> privacy_value
      or capture_row.explicit_destination_note_id is distinct from destination_value
      or capture_row.expansion_disabled <> expansion_value
      or not private.valid_encrypted_write_mac(
        content_mac, p_owner_id,
        privacy_value::text::public.content_key_class, true
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    select * into job_row from public.organization_jobs
    where user_id = p_owner_id and capture_id = capture_id_value;
    if job_row.id is null or job_row.id <> job_id_value then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'captureId', capture_id_value,
      'jobId', job_row.id,
      'replayed', true
    );
  end if;

  -- C.5b has an atomic encrypted private-capture receipt path, but the
  -- organizer's multi-surface encrypted completion command lands later.
  -- Refuse fresh AI work instead of creating a job that can never safely
  -- complete. An already-created exact replay was returned above.
  if privacy_value = 'ai_assisted' then
    raise exception using
      errcode = 'P0001', message = 'encrypted_organizer_write_unavailable';
  end if;

  -- Fresh commands must carry a plausible millisecond event time. Replays are
  -- checked against the already-persisted value above and therefore remain
  -- valid after this bounded admission window closes.
  if occurred_value <> date_trunc('milliseconds', occurred_value)
    or occurred_value < clock_timestamp() - interval '30 days'
    or occurred_value > clock_timestamp() + interval '5 minutes'
    or created_value < occurred_value - interval '30 days'
    or created_value > occurred_value + interval '5 minutes'
  then
    raise exception using errcode = '22023', message = 'invalid_capture_time';
  end if;
  if exists (
    select 1 from public.organization_jobs where id = job_id_value
  ) then
    raise exception using errcode = '23505', message = 'capture_job_conflict';
  end if;

  if destination_value is not null and not exists (
    select 1 from public.notes
    where user_id = p_owner_id and id = destination_value and deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'explicit_destination_not_owned';
  end if;
  if not private.valid_encrypted_write_cipher(
      content_cipher, p_owner_id, capture_id_value, 1, 'capture',
      privacy_value::text::public.content_key_class
    )
    or not private.valid_encrypted_write_mac(
      content_mac, p_owner_id,
      privacy_value::text::public.content_key_class, false
    )
    or (
      privacy_value = 'private_manual' and (
        not private.valid_encrypted_write_cipher(
          receipt_cipher, p_owner_id, capture_id_value, 1,
          'capture_receipt', 'private_manual'
        )
        or not private.valid_encrypted_write_mac(
          receipt_mac, p_owner_id, 'private_manual', false
        )
      )
    )
    or (
      privacy_value = 'ai_assisted'
      and (jsonb_typeof(receipt_cipher) <> 'null'
        or jsonb_typeof(receipt_mac) <> 'null')
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  reservation_values := case when privacy_value = 'private_manual'
    then jsonb_build_array(content_cipher, receipt_cipher)
    else jsonb_build_array(content_cipher) end;
  perform private.consume_content_key_reservations(
    p_owner_id, reservation_values, 'capture', capture_id_value
  );

  insert into public.captures (
    id, user_id, source, device_id, raw_text, content_envelope,
    content_fingerprint, content_length, privacy,
    explicit_destination_note_id, expansion_disabled, client_created_at,
    client_timezone, received_at, status, content_key_id, content_key_class,
    content_key_purpose, content_key_version, fingerprint_key_id,
    fingerprint_key_class, fingerprint_key_purpose, fingerprint_key_version
  ) values (
    capture_id_value, p_owner_id, source_value, device_value, '[encrypted]',
    content_cipher -> 'envelope', content_mac ->> 'mac', content_length_value,
    privacy_value, destination_value, expansion_value, created_value,
    timezone_value, occurred_value, 'queued', content_cipher ->> 'keyId',
    (content_cipher ->> 'keyClass')::public.content_key_class,
    (content_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (content_cipher ->> 'keyVersion')::integer, content_mac ->> 'keyId',
    (content_mac ->> 'keyClass')::public.content_key_class,
    (content_mac ->> 'keyPurpose')::public.content_key_purpose,
    (content_mac ->> 'keyVersion')::integer
  ) returning * into capture_row;
  inserted_value := true;

  insert into public.organization_jobs (
    id, capture_id, user_id, state, prompt_version, schema_version,
    available_at, completed_at, created_at, updated_at
  ) values (
    job_id_value, capture_id_value, p_owner_id, 'succeeded', 'routing-v1', 1,
    occurred_value, occurred_value, occurred_value, occurred_value
  ) returning * into job_row;

  if privacy_value = 'private_manual' then
    update public.captures set status = 'inbox'
    where id = capture_id_value returning * into capture_row;
    insert into public.capture_receipts (
      capture_id, job_id, user_id, outcome, headline, inserted_content,
      actions, reason_codes, receipt_envelope, receipt_key_id,
      receipt_key_class, receipt_key_purpose, receipt_key_version, created_at
    ) values (
      capture_id_value, job_row.id, p_owner_id, 'kept_in_inbox',
      'Kept private in Inbox', '[]'::jsonb, '[]'::jsonb,
      array['private_manual'], receipt_cipher -> 'envelope',
      receipt_cipher ->> 'keyId',
      (receipt_cipher ->> 'keyClass')::public.content_key_class,
      (receipt_cipher ->> 'keyPurpose')::public.content_key_purpose,
      (receipt_cipher ->> 'keyVersion')::integer, occurred_value
    );
    perform private.record_content_encryption_verification(
      p_owner_id, 'capture_receipt', capture_id_value, 1,
      receipt_cipher -> 'envelope', receipt_mac
    );
    perform private.emit_user_event(
      p_owner_id, 'capture_receipt', capture_id_value
    );
  end if;

  perform private.record_content_encryption_verification(
    p_owner_id, 'capture', capture_id_value, 1,
    content_cipher -> 'envelope', content_mac
  );
  update public.content_encryption_rollouts set
    encrypted_object_count = encrypted_object_count
      + case when privacy_value = 'private_manual' then 2 else 1 end,
    verified_object_count = verified_object_count
      + case when privacy_value = 'private_manual' then 2 else 1 end
  where user_id = p_owner_id;
  perform private.emit_user_event(p_owner_id, 'capture', capture_id_value);
  perform private.emit_user_event(p_owner_id, 'organization_job', job_row.id);

  return jsonb_build_object(
    'captureId', capture_id_value,
    'jobId', job_row.id,
    'replayed', not inserted_value
  );
end;
$$;

-- Request MACs authenticate API intent and are deliberately not reused as
-- content evidence. After opening a fresh-write envelope, the service records
-- a canonical per-surface MAC through this exact-target verification pass.
create or replace function public.verify_encrypted_content_object(
  p_owner_id uuid,
  p_surface text,
  p_resource_id text,
  p_expected_record_version integer,
  p_expected_envelope jsonb,
  p_verification_mac jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  envelope_value jsonb;
  expected_class public.content_key_class;
  actual_version integer;
  actual_digest text;
  existing_verification public.content_encryption_verifications%rowtype;
  note_row public.notes%rowtype;
  mutation_row public.note_mutations%rowtype;
  idempotency_row public.api_idempotency_records%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_surface not in (
      'note_content', 'note_mutation', 'idempotency_response'
    )
    or p_resource_id is null
    or char_length(p_resource_id) not between 1 and 200
    or p_expected_record_version is null
    or p_expected_record_version < 1
    or p_expected_envelope is null
    or jsonb_typeof(p_expected_envelope) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  if p_surface = 'note_content' then
    select * into note_row from public.notes
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    envelope_value := note_row.content_envelope;
    actual_version := note_row.current_revision;
    expected_class := note_row.privacy::text::public.content_key_class;
  elsif p_surface = 'note_mutation' then
    select * into mutation_row from public.note_mutations
    where user_id = p_owner_id and id = p_resource_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    envelope_value := mutation_row.mutation_envelope;
    actual_version := mutation_row.after_revision;
    expected_class := case when exists (
      select 1 from public.note_revisions
      where user_id = p_owner_id and note_id = mutation_row.note_id
        and revision in (
          mutation_row.before_revision, mutation_row.after_revision
        )
        and privacy = 'private_manual'
    ) then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  else
    select * into idempotency_row from public.api_idempotency_records
    where user_id = p_owner_id
      and 'idempotency:' || idempotency_key = p_resource_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    envelope_value := idempotency_row.response_envelope;
    actual_version := 1;
    expected_class := idempotency_row.request_mac_key_class;
    if idempotency_row.response_key_class is distinct from expected_class then
      raise exception using errcode = 'P0001', message = 'invalid_key_class';
    end if;
  end if;

  if envelope_value is null or actual_version <> p_expected_record_version then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  if envelope_value <> p_expected_envelope then
    raise exception using errcode = 'P0001', message = 'stale_envelope';
  end if;
  actual_digest := encode(
    extensions.digest(envelope_value::text, 'sha256'), 'hex'
  );
  if not private.valid_encrypted_write_mac(
    p_verification_mac, p_owner_id, expected_class, true
  ) then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  select * into existing_verification
  from public.content_encryption_verifications
  where user_id = p_owner_id and surface = p_surface
    and resource_id = p_resource_id
  for update;
  if found
    and existing_verification.record_version = actual_version
    and existing_verification.envelope_digest = actual_digest
    and existing_verification.verification_mac = p_verification_mac ->> 'mac'
    and existing_verification.verification_mac_key_id =
      p_verification_mac ->> 'keyId'
    and existing_verification.verification_mac_key_class =
      (p_verification_mac ->> 'keyClass')::public.content_key_class
    and existing_verification.verification_mac_key_purpose =
      (p_verification_mac ->> 'keyPurpose')::public.content_key_purpose
    and existing_verification.verification_mac_key_version =
      (p_verification_mac ->> 'keyVersion')::integer
  then
    return jsonb_build_object(
      'surface', p_surface, 'resourceId', p_resource_id,
      'recordVersion', actual_version, 'envelopeDigest', actual_digest,
      'replayed', true
    );
  end if;

  perform private.record_content_encryption_verification(
    p_owner_id, p_surface, p_resource_id, actual_version,
    envelope_value, p_verification_mac
  );
  if existing_verification.user_id is null then
    update public.content_encryption_rollouts
    set verified_object_count = verified_object_count + 1
    where user_id = p_owner_id;
  end if;
  return jsonb_build_object(
    'surface', p_surface, 'resourceId', p_resource_id,
    'recordVersion', actual_version, 'envelopeDigest', actual_digest,
    'replayed', false
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.list_encrypted_notes(
  p_owner_id uuid,
  p_after_updated_at timestamptz default null,
  p_after_note_id text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  items_value jsonb;
  next_updated_at timestamptz;
  next_note_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_limit is null or p_limit not between 1 and 50
    or ((p_after_updated_at is null) <> (p_after_note_id is null))
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  with page as (
    select note.*
    from public.notes as note
    where note.user_id = p_owner_id
      and note.content_envelope is not null
      and (
        p_after_updated_at is null
        or (note.updated_at, note.id) < (p_after_updated_at, p_after_note_id)
      )
    order by note.updated_at desc, note.id desc
    limit p_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'noteId', page.id,
      'currentRevision', page.current_revision,
      'spaceId', page.space_id,
      'type', page.type,
      'dailyDate', page.daily_date,
      'isOpen', page.is_open,
      'pinnedAt', page.pinned_at,
      'privacy', page.privacy,
      'archivedAt', page.archived_at,
      'deletedAt', page.deleted_at,
      'createdAt', page.created_at,
      'updatedAt', page.updated_at,
      'contentCipher', private.encrypted_cipher_projection(
        page.content_envelope, page.content_key_id, page.content_key_class,
        page.content_key_purpose, page.content_key_version
      )
    ) order by page.updated_at desc, page.id desc), '[]'::jsonb),
    (array_agg(page.updated_at order by page.updated_at desc, page.id desc))
      [count(*)::integer],
    (array_agg(page.id order by page.updated_at desc, page.id desc))
      [count(*)::integer]
  into items_value, next_updated_at, next_note_id
  from page;

  return jsonb_build_object(
    'notes', items_value,
    'nextCursor', case when next_note_id is null then null else
      jsonb_build_object('updatedAt', next_updated_at, 'noteId', next_note_id)
    end
  );
end;
$$;

create or replace function public.get_encrypted_note(
  p_owner_id uuid,
  p_note_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  note_row public.notes%rowtype;
  space_value jsonb;
  tags_value jsonb;
  links_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_note_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into note_row from public.notes
  where user_id = p_owner_id and id = p_note_id;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  if note_row.content_envelope is null then
    raise exception using errcode = 'P0001', message = 'encrypted_content_unavailable';
  end if;

  select jsonb_build_object(
    'spaceId', child.id,
    'currentRevision', child.current_revision,
    'parentId', child.parent_id,
    'displayCipher', private.encrypted_cipher_projection(
      child.display_envelope, child.display_key_id, child.display_key_class,
      child.display_key_purpose, child.display_key_version
    ),
    'parent', case when parent.id is null then null else jsonb_build_object(
      'spaceId', parent.id,
      'currentRevision', parent.current_revision,
      'displayCipher', private.encrypted_cipher_projection(
        parent.display_envelope, parent.display_key_id, parent.display_key_class,
        parent.display_key_purpose, parent.display_key_version
      )
    ) end
  ) into space_value
  from public.spaces as child
  left join public.spaces as parent
    on parent.user_id = child.user_id and parent.id = child.parent_id
  where child.user_id = p_owner_id and child.id = note_row.space_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'tagId', tag.id,
    'currentRevision', tag.current_revision,
    'createdAt', tag.created_at,
    'displayCipher', private.encrypted_cipher_projection(
      tag.display_envelope, tag.display_key_id, tag.display_key_class,
      tag.display_key_purpose, tag.display_key_version
    )
  ) order by tag.id), '[]'::jsonb) into tags_value
  from public.note_tags as relation
  join public.tags as tag on tag.user_id = relation.user_id
    and tag.id = relation.tag_id
  where relation.user_id = p_owner_id and relation.note_id = p_note_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'linkId', link.id,
    'toNoteId', link.to_note_id,
    'linkType', link.link_type,
    'source', link.source,
    'targetType', target.type,
    'targetPrivacy', target.privacy,
    'targetRevision', target.current_revision,
    'targetContentCipher', private.encrypted_cipher_projection(
      target.content_envelope, target.content_key_id, target.content_key_class,
      target.content_key_purpose, target.content_key_version
    )
  ) order by link.id), '[]'::jsonb) into links_value
  from public.note_links as link
  join public.notes as target on target.user_id = link.user_id
    and target.id = link.to_note_id
  where link.user_id = p_owner_id and link.from_note_id = p_note_id;

  return jsonb_build_object(
    'noteId', note_row.id,
    'currentRevision', note_row.current_revision,
    'spaceId', note_row.space_id,
    'type', note_row.type,
    'dailyDate', note_row.daily_date,
    'isOpen', note_row.is_open,
    'pinnedAt', note_row.pinned_at,
    'privacy', note_row.privacy,
    'archivedAt', note_row.archived_at,
    'deletedAt', note_row.deleted_at,
    'createdAt', note_row.created_at,
    'updatedAt', note_row.updated_at,
    'contentCipher', private.encrypted_cipher_projection(
      note_row.content_envelope, note_row.content_key_id,
      note_row.content_key_class, note_row.content_key_purpose,
      note_row.content_key_version
    ),
    'space', space_value,
    'tags', tags_value,
    'links', links_value
  );
end;
$$;

create or replace function public.list_encrypted_note_revisions(
  p_owner_id uuid,
  p_note_id text,
  p_after_revision integer default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  revisions_value jsonb;
  next_revision integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_note_id is null
    or p_limit is null or p_limit not between 1 and 50
    or (p_after_revision is not null and p_after_revision < 1)
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if not exists (
    select 1 from public.notes where user_id = p_owner_id and id = p_note_id
  ) then raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  with page as (
    select revision.* from public.note_revisions as revision
    where revision.user_id = p_owner_id and revision.note_id = p_note_id
      and (p_after_revision is null or revision.revision < p_after_revision)
      and revision.snapshot_envelope is not null
    order by revision.revision desc limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'revisionId', page.id,
    'noteId', page.note_id,
    'revision', page.revision,
    'source', page.source,
    'spaceId', page.space_id,
    'type', page.type,
    'isOpen', page.is_open,
    'pinnedAt', page.pinned_at,
    'privacy', page.privacy,
    'archivedAt', page.archived_at,
    'deletedAt', page.deleted_at,
    'actor', page.actor,
    'mutationId', page.mutation_id,
    'createdAt', page.created_at,
    'snapshotCipher', private.encrypted_cipher_projection(
      page.snapshot_envelope, page.snapshot_key_id, page.snapshot_key_class,
      page.snapshot_key_purpose, page.snapshot_key_version
    ),
    'snapshotMac', private.encrypted_mac_projection(
      page.snapshot_mac, page.snapshot_mac_key_id, page.snapshot_mac_key_class,
      page.snapshot_mac_key_purpose, page.snapshot_mac_key_version
    )
  ) order by page.revision desc), '[]'::jsonb), min(page.revision)
  into revisions_value, next_revision from page;
  return jsonb_build_object(
    'revisions', revisions_value,
    'nextRevision', next_revision
  );
end;
$$;

create or replace function public.get_encrypted_note_mutation(
  p_owner_id uuid,
  p_mutation_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  mutation_row public.note_mutations%rowtype;
  note_value jsonb;
  before_value jsonb;
  after_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_mutation_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into mutation_row from public.note_mutations
  where user_id = p_owner_id and id = p_mutation_id;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  if mutation_row.mutation_envelope is null then
    raise exception using errcode = 'P0001', message = 'encrypted_content_unavailable';
  end if;
  note_value := public.get_encrypted_note(p_owner_id, mutation_row.note_id);
  select jsonb_build_object(
    'revisionId', id, 'revision', revision, 'privacy', privacy,
    'snapshotCipher', private.encrypted_cipher_projection(
      snapshot_envelope, snapshot_key_id, snapshot_key_class,
      snapshot_key_purpose, snapshot_key_version
    )
  ) into before_value from public.note_revisions
  where user_id = p_owner_id and note_id = mutation_row.note_id
    and revision = mutation_row.before_revision;
  select jsonb_build_object(
    'revisionId', id, 'revision', revision, 'privacy', privacy,
    'snapshotCipher', private.encrypted_cipher_projection(
      snapshot_envelope, snapshot_key_id, snapshot_key_class,
      snapshot_key_purpose, snapshot_key_version
    )
  ) into after_value from public.note_revisions
  where user_id = p_owner_id and note_id = mutation_row.note_id
    and revision = mutation_row.after_revision;
  return jsonb_build_object(
    'mutationId', mutation_row.id,
    'noteId', mutation_row.note_id,
    'decisionId', mutation_row.decision_id,
    'idempotencyKey', mutation_row.idempotency_key,
    'beforeRevision', mutation_row.before_revision,
    'afterRevision', mutation_row.after_revision,
    'undoneAt', mutation_row.undone_at,
    'createdAt', mutation_row.created_at,
    'mutationCipher', private.encrypted_cipher_projection(
      mutation_row.mutation_envelope, mutation_row.mutation_key_id,
      mutation_row.mutation_key_class, mutation_row.mutation_key_purpose,
      mutation_row.mutation_key_version
    ),
    'currentNote', note_value,
    'beforeSnapshot', before_value,
    'afterSnapshot', after_value
  );
end;
$$;

create or replace function public.list_encrypted_library_objects(
  p_owner_id uuid,
  p_surface text,
  p_after_resource_id text default null,
  p_limit integer default 25
)
returns table (
  resource_id text,
  record_version integer,
  operational jsonb,
  content_cipher jsonb,
  content_mac jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_surface not in (
      'space_display', 'tag_display', 'note_content', 'note_revision',
      'organization_decision', 'note_mutation', 'generated_block',
      'review_item', 'routing_rule', 'organization_mutation_attempt',
      'idempotency_response', 'capture_receipt', 'capture'
    )
    or p_limit is null or p_limit not between 1 and 50
  then raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if p_surface = 'space_display' then
    return query select space.id, space.current_revision,
      jsonb_build_object(
        'parentId', space.parent_id, 'sortKey', space.sort_key,
        'archivedAt', space.archived_at, 'createdAt', space.created_at,
        'updatedAt', space.updated_at
      ),
      private.encrypted_cipher_projection(
        space.display_envelope, space.display_key_id, space.display_key_class,
        space.display_key_purpose, space.display_key_version
      ),
      private.encrypted_mac_projection(
        space.display_mac, space.display_mac_key_id, space.display_mac_key_class,
        space.display_mac_key_purpose, space.display_mac_key_version
      )
    from public.spaces as space where space.user_id = p_owner_id
      and space.display_envelope is not null
      and (p_after_resource_id is null or space.id > p_after_resource_id)
    order by space.id limit p_limit;
  elsif p_surface = 'tag_display' then
    return query select tag.id, tag.current_revision,
      jsonb_build_object('createdAt', tag.created_at, 'updatedAt', tag.updated_at),
      private.encrypted_cipher_projection(
        tag.display_envelope, tag.display_key_id, tag.display_key_class,
        tag.display_key_purpose, tag.display_key_version
      ),
      private.encrypted_mac_projection(
        tag.display_mac, tag.display_mac_key_id, tag.display_mac_key_class,
        tag.display_mac_key_purpose, tag.display_mac_key_version
      )
    from public.tags as tag where tag.user_id = p_owner_id
      and tag.display_envelope is not null
      and (p_after_resource_id is null or tag.id > p_after_resource_id)
    order by tag.id limit p_limit;
  elsif p_surface = 'note_content' then
    return query select note.id, note.current_revision,
      jsonb_build_object(
        'spaceId', note.space_id, 'type', note.type, 'dailyDate', note.daily_date,
        'isOpen', note.is_open, 'pinnedAt', note.pinned_at,
        'privacy', note.privacy, 'archivedAt', note.archived_at,
        'deletedAt', note.deleted_at, 'createdAt', note.created_at,
        'updatedAt', note.updated_at
      ),
      private.encrypted_cipher_projection(
        note.content_envelope, note.content_key_id, note.content_key_class,
        note.content_key_purpose, note.content_key_version
      ), null::jsonb
    from public.notes as note where note.user_id = p_owner_id
      and note.content_envelope is not null
      and (p_after_resource_id is null or note.id > p_after_resource_id)
    order by note.id limit p_limit;
  elsif p_surface = 'note_revision' then
    return query select revision.id, revision.revision,
      jsonb_build_object(
        'noteId', revision.note_id, 'source', revision.source,
        'privacy', revision.privacy, 'actor', revision.actor,
        'mutationId', revision.mutation_id, 'createdAt', revision.created_at
      ),
      private.encrypted_cipher_projection(
        revision.snapshot_envelope, revision.snapshot_key_id,
        revision.snapshot_key_class, revision.snapshot_key_purpose,
        revision.snapshot_key_version
      ),
      private.encrypted_mac_projection(
        revision.snapshot_mac, revision.snapshot_mac_key_id,
        revision.snapshot_mac_key_class, revision.snapshot_mac_key_purpose,
        revision.snapshot_mac_key_version
      )
    from public.note_revisions as revision where revision.user_id = p_owner_id
      and revision.snapshot_envelope is not null
      and (p_after_resource_id is null or revision.id > p_after_resource_id)
    order by revision.id limit p_limit;
  elsif p_surface = 'organization_decision' then
    return query select decision.id, decision.decision_content_revision,
      jsonb_build_object(
        'captureId', decision.capture_id, 'band', decision.band,
        'score', decision.score, 'margin', decision.margin,
        'destinationNoteId', decision.destination_note_id,
        'reasonCodes', decision.reason_codes, 'createdAt', decision.created_at
      ),
      private.encrypted_cipher_projection(
        decision.decision_envelope, decision.decision_key_id,
        decision.decision_key_class, decision.decision_key_purpose,
        decision.decision_key_version
      ), null::jsonb
    from public.organization_decisions as decision
    where decision.user_id = p_owner_id and decision.decision_envelope is not null
      and (p_after_resource_id is null or decision.id > p_after_resource_id)
    order by decision.id limit p_limit;
  elsif p_surface = 'note_mutation' then
    return query select mutation.id, mutation.after_revision,
      jsonb_build_object(
        'decisionId', mutation.decision_id, 'noteId', mutation.note_id,
        'beforeRevision', mutation.before_revision,
        'afterRevision', mutation.after_revision, 'undoneAt', mutation.undone_at,
        'createdAt', mutation.created_at
      ),
      private.encrypted_cipher_projection(
        mutation.mutation_envelope, mutation.mutation_key_id,
        mutation.mutation_key_class, mutation.mutation_key_purpose,
        mutation.mutation_key_version
      ), null::jsonb
    from public.note_mutations as mutation where mutation.user_id = p_owner_id
      and mutation.mutation_envelope is not null
      and (p_after_resource_id is null or mutation.id > p_after_resource_id)
    order by mutation.id limit p_limit;
  elsif p_surface = 'generated_block' then
    return query select block.id, 1,
      jsonb_build_object(
        'noteId', block.note_id, 'decisionId', block.decision_id,
        'kind', block.kind, 'state', block.state, 'modelId', block.model_id,
        'promptVersion', block.prompt_version, 'resolvedAt', block.resolved_at,
        'createdAt', block.created_at
      ),
      private.encrypted_cipher_projection(
        block.content_envelope, block.content_key_id, block.content_key_class,
        block.content_key_purpose, block.content_key_version
      ), null::jsonb
    from public.generated_blocks as block where block.user_id = p_owner_id
      and block.content_envelope is not null
      and (p_after_resource_id is null or block.id > p_after_resource_id)
    order by block.id limit p_limit;
  elsif p_surface = 'review_item' then
    return query select review.id, review.review_content_revision,
      jsonb_build_object(
        'captureId', review.capture_id, 'noteId', review.note_id,
        'type', review.type, 'state', review.state, 'createdAt', review.created_at,
        'resolvedAt', review.resolved_at
      ),
      private.encrypted_cipher_projection(
        review.review_envelope, review.review_key_id, review.review_key_class,
        review.review_key_purpose, review.review_key_version
      ), null::jsonb
    from public.review_items as review where review.user_id = p_owner_id
      and review.review_envelope is not null
      and (p_after_resource_id is null or review.id > p_after_resource_id)
    order by review.id limit p_limit;
  elsif p_surface = 'routing_rule' then
    return query select rule.id, rule.condition_revision,
      jsonb_build_object(
        'enabled', rule.enabled, 'ruleType', rule.rule_type,
        'destinationNoteId', rule.destination_note_id,
        'destinationSpaceId', rule.destination_space_id,
        'priority', rule.priority, 'source', rule.source,
        'lastFiredAt', rule.last_fired_at, 'createdAt', rule.created_at,
        'updatedAt', rule.updated_at
      ),
      private.encrypted_cipher_projection(
        rule.condition_envelope, rule.condition_key_id, rule.condition_key_class,
        rule.condition_key_purpose, rule.condition_key_version
      ), null::jsonb
    from public.routing_rules as rule where rule.user_id = p_owner_id
      and rule.condition_envelope is not null
      and (p_after_resource_id is null or rule.id > p_after_resource_id)
    order by rule.id limit p_limit;
  elsif p_surface = 'organization_mutation_attempt' then
    return query select attempt.job_id || ':' || attempt.note_id,
      attempt.attempt_content_revision,
      jsonb_build_object(
        'jobId', attempt.job_id, 'noteId', attempt.note_id,
        'plannedRevision', attempt.planned_revision,
        'replanCount', attempt.replan_count, 'state', attempt.state,
        'reviewItemId', attempt.review_item_id, 'createdAt', attempt.created_at,
        'updatedAt', attempt.updated_at
      ),
      private.encrypted_cipher_projection(
        attempt.attempt_envelope, attempt.attempt_key_id,
        attempt.attempt_key_class, attempt.attempt_key_purpose,
        attempt.attempt_key_version
      ), null::jsonb
    from public.organization_mutation_attempts as attempt
    where attempt.user_id = p_owner_id and attempt.attempt_envelope is not null
      and (p_after_resource_id is null
        or attempt.job_id || ':' || attempt.note_id > p_after_resource_id)
    order by attempt.job_id, attempt.note_id limit p_limit;
  elsif p_surface = 'idempotency_response' then
    return query select 'idempotency:' || record.idempotency_key, 1,
      jsonb_build_object(
        'scope', record.scope,
        'requestResourceType', record.request_resource_type,
        'requestResourceId', record.request_resource_id,
        'responseResourceType', record.response_resource_type,
        'responseResourceId', record.response_resource_id,
        'responseRecordVersion', record.response_record_version,
        'createdAt', record.created_at, 'completedAt', record.completed_at,
        'replayPolicy', record.replay_policy,
        'requestMac', private.encrypted_mac_projection(
          record.request_mac, record.request_mac_key_id,
          record.request_mac_key_class, record.request_mac_key_purpose,
          record.request_mac_key_version
        )
      ),
      private.encrypted_cipher_projection(
        record.response_envelope, record.response_key_id,
        record.response_key_class, record.response_key_purpose,
        record.response_key_version
      ), null::jsonb
    from public.api_idempotency_records as record
    where record.user_id = p_owner_id and record.response_envelope is not null
      and (p_after_resource_id is null
        or 'idempotency:' || record.idempotency_key > p_after_resource_id)
    order by record.idempotency_key limit p_limit;
  elsif p_surface = 'capture_receipt' then
    return query select receipt.capture_id, receipt.receipt_revision,
      jsonb_build_object(
        'jobId', receipt.job_id, 'decisionId', receipt.decision_id,
        'reviewItemId', receipt.review_item_id,
        'mutationId', receipt.mutation_id, 'outcome', receipt.outcome,
        'destinationNoteId', receipt.destination_note_id,
        'reasonCodes', receipt.reason_codes, 'createdAt', receipt.created_at
      ),
      private.encrypted_cipher_projection(
        receipt.receipt_envelope, receipt.receipt_key_id,
        receipt.receipt_key_class, receipt.receipt_key_purpose,
        receipt.receipt_key_version
      ), null::jsonb
    from public.capture_receipts as receipt where receipt.user_id = p_owner_id
      and receipt.receipt_envelope is not null
      and (p_after_resource_id is null or receipt.capture_id > p_after_resource_id)
    order by receipt.capture_id limit p_limit;
  else
    return query select capture.id, 1,
      jsonb_build_object(
        'source', capture.source, 'deviceId', capture.device_id,
        'contentLength', capture.content_length, 'privacy', capture.privacy,
        'explicitDestinationNoteId', capture.explicit_destination_note_id,
        'expansionDisabled', capture.expansion_disabled,
        'clientCreatedAt', capture.client_created_at,
        'clientTimezone', capture.client_timezone,
        'receivedAt', capture.received_at, 'status', capture.status,
        'lastErrorCode', capture.last_error_code, 'deletedAt', capture.deleted_at
      ),
      private.encrypted_cipher_projection(
        capture.content_envelope, capture.content_key_id,
        capture.content_key_class, capture.content_key_purpose,
        capture.content_key_version
      ),
      private.encrypted_mac_projection(
        capture.content_fingerprint, capture.fingerprint_key_id,
        capture.fingerprint_key_class, capture.fingerprint_key_purpose,
        capture.fingerprint_key_version
      )
    from public.captures as capture where capture.user_id = p_owner_id
      and capture.content_envelope is not null
      and capture.content_key_id is not null
      and (p_after_resource_id is null or capture.id > p_after_resource_id)
    order by capture.id limit p_limit;
  end if;
end;
$$;

create or replace function public.list_encrypted_captures(
  p_owner_id uuid,
  p_after_received_at timestamptz default null,
  p_after_capture_id text default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  items_value jsonb;
  next_received_at timestamptz;
  next_capture_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_limit is null or p_limit not between 1 and 100
    or (p_after_received_at is null) <> (p_after_capture_id is null)
    or (p_after_capture_id is not null
      and p_after_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  with page as (
    select capture.*, job.id as job_id
    from public.captures as capture
    join public.organization_jobs as job
      on job.user_id = capture.user_id and job.capture_id = capture.id
    where capture.user_id = p_owner_id
      and capture.deleted_at is null and capture.status <> 'deleted'
      and capture.content_envelope is not null
      and capture.content_key_id is not null
      and (p_after_received_at is null
        or (capture.received_at, capture.id)
          < (p_after_received_at, p_after_capture_id))
    order by capture.received_at desc, capture.id desc
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'captureId', page.id,
    'recordVersion', 1,
    'jobId', page.job_id,
    'source', page.source,
    'deviceId', page.device_id,
    'contentLength', page.content_length,
    'privacy', page.privacy,
    'explicitDestinationNoteId', page.explicit_destination_note_id,
    'expansionDisabled', page.expansion_disabled,
    'clientCreatedAt', page.client_created_at,
    'clientTimezone', page.client_timezone,
    'receivedAt', page.received_at,
    'status', private.capture_processing_state(page.status),
    'lastErrorCode', page.last_error_code,
    'contentCipher', private.encrypted_cipher_projection(
      page.content_envelope, page.content_key_id, page.content_key_class,
      page.content_key_purpose, page.content_key_version
    ),
    'contentMac', private.encrypted_mac_projection(
      page.content_fingerprint, page.fingerprint_key_id,
      page.fingerprint_key_class, page.fingerprint_key_purpose,
      page.fingerprint_key_version
    ),
    'receiptAvailable', exists (
      select 1 from public.capture_receipts as receipt
      where receipt.user_id = p_owner_id and receipt.capture_id = page.id
        and receipt.receipt_envelope is not null
    )
  ) order by page.received_at desc, page.id desc), '[]'::jsonb),
  (array_agg(page.received_at order by page.received_at desc, page.id desc))
    [count(*)::integer],
  (array_agg(page.id order by page.received_at desc, page.id desc))
    [count(*)::integer]
  into items_value, next_received_at, next_capture_id
  from page;

  return jsonb_build_object(
    'captures', items_value,
    'nextCursor', case when next_capture_id is null then null else
      jsonb_build_object(
        'receivedAt', next_received_at, 'captureId', next_capture_id
      )
    end
  );
end;
$$;

create or replace function public.get_encrypted_capture_receipt(
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
  receipt_value jsonb;
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
  select jsonb_build_object(
    'captureId', receipt.capture_id,
    'recordVersion', receipt.receipt_revision,
    'privacy', capture.privacy,
    'jobId', receipt.job_id,
    'decisionId', receipt.decision_id,
    'reviewItemId', receipt.review_item_id,
    'mutationId', receipt.mutation_id,
    'outcome', receipt.outcome,
    'destinationNoteId', receipt.destination_note_id,
    'reasonCodes', to_jsonb(receipt.reason_codes),
    'createdAt', receipt.created_at,
    'receiptCipher', private.encrypted_cipher_projection(
      receipt.receipt_envelope, receipt.receipt_key_id,
      receipt.receipt_key_class, receipt.receipt_key_purpose,
      receipt.receipt_key_version
    )
  ) into receipt_value
  from public.capture_receipts as receipt
  join public.captures as capture
    on capture.user_id = receipt.user_id and capture.id = receipt.capture_id
  where receipt.user_id = p_owner_id and receipt.capture_id = p_capture_id
    and receipt.receipt_envelope is not null
    and capture.deleted_at is null and capture.status <> 'deleted';
  if receipt_value is null then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return jsonb_build_object('receipt', receipt_value);
end;
$$;

create or replace function public.get_encrypted_generated_blocks(
  p_owner_id uuid,
  p_block_ids text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  blocks_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_block_ids is null
    or cardinality(p_block_ids) not between 1 and 100
    or exists (
      select 1 from unnest(p_block_ids) as requested(block_id)
      where requested.block_id is null
        or requested.block_id !~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'
    )
    or (select count(*) from unnest(p_block_ids))
      <> (select count(distinct block_id) from unnest(p_block_ids) as ids(block_id))
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if exists (
    select 1
    from unnest(p_block_ids) as requested(block_id)
    left join public.generated_blocks as block
      on block.user_id = p_owner_id and block.id = requested.block_id
      and block.content_envelope is not null
    where block.id is null
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select jsonb_agg(jsonb_build_object(
    'blockId', block.id,
    'recordVersion', 1,
    'noteId', block.note_id,
    'decisionId', block.decision_id,
    'kind', block.kind,
    'state', block.state,
    'modelId', block.model_id,
    'promptVersion', block.prompt_version,
    'resolvedAt', block.resolved_at,
    'createdAt', block.created_at,
    'contentCipher', private.encrypted_cipher_projection(
      block.content_envelope, block.content_key_id, block.content_key_class,
      block.content_key_purpose, block.content_key_version
    )
  ) order by requested.ordinality) into blocks_value
  from unnest(p_block_ids) with ordinality as requested(block_id, ordinality)
  join public.generated_blocks as block
    on block.user_id = p_owner_id and block.id = requested.block_id;
  return jsonb_build_object('blocks', blocks_value);
end;
$$;

create or replace function public.get_encrypted_capture_detail(
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
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  receipt_value jsonb;
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
  select * into capture_row from public.captures
  where user_id = p_owner_id and id = p_capture_id
    and deleted_at is null and status <> 'deleted';
  if not found or capture_row.content_envelope is null
    or capture_row.content_key_id is null
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into job_row from public.organization_jobs
  where user_id = p_owner_id and capture_id = p_capture_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select result -> 'receipt' into receipt_value
  from (select public.get_encrypted_capture_receipt(
    p_owner_id, p_capture_id
  ) as result) as projected
  where exists (
    select 1 from public.capture_receipts as receipt
    where receipt.user_id = p_owner_id and receipt.capture_id = p_capture_id
      and receipt.receipt_envelope is not null
  );

  return jsonb_build_object('capture', jsonb_build_object(
    'captureId', capture_row.id,
    'recordVersion', 1,
    'jobId', job_row.id,
    'source', capture_row.source,
    'deviceId', capture_row.device_id,
    'contentLength', capture_row.content_length,
    'privacy', capture_row.privacy,
    'explicitDestinationNoteId', capture_row.explicit_destination_note_id,
    'expansionDisabled', capture_row.expansion_disabled,
    'clientCreatedAt', capture_row.client_created_at,
    'clientTimezone', capture_row.client_timezone,
    'receivedAt', capture_row.received_at,
    'status', private.capture_processing_state(capture_row.status),
    'lastErrorCode', capture_row.last_error_code,
    'contentCipher', private.encrypted_cipher_projection(
      capture_row.content_envelope, capture_row.content_key_id,
      capture_row.content_key_class, capture_row.content_key_purpose,
      capture_row.content_key_version
    ),
    'contentMac', private.encrypted_mac_projection(
      capture_row.content_fingerprint, capture_row.fingerprint_key_id,
      capture_row.fingerprint_key_class, capture_row.fingerprint_key_purpose,
      capture_row.fingerprint_key_version
    ),
    'job', jsonb_build_object(
      'jobId', job_row.id, 'state', job_row.state,
      'attempt', job_row.attempt, 'startedAt', job_row.started_at,
      'completedAt', job_row.completed_at, 'errorCode', job_row.error_code,
      'createdAt', job_row.created_at, 'updatedAt', job_row.updated_at
    ),
    'receipt', receipt_value
  ));
end;
$$;

-- Content-free operational evidence for local/production canaries. This keeps
-- direct table access revoked while allowing an authorized service to prove
-- that the legacy capture column is tombstoned and the encrypted-at-rest
-- artifacts have the required structural shape. No envelope or MAC value is
-- returned by this capability.
create or replace function public.get_capture_storage_attestation(
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
  capture_row public.captures%rowtype;
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

  select * into capture_row
  from public.captures
  where user_id = p_owner_id and id = p_capture_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  return jsonb_build_object(
    'captureId', capture_row.id,
    'rawTextTombstoned', capture_row.raw_text = '[encrypted]',
    'envelopeV1', coalesce(capture_row.content_envelope ->> 'version' = '1', false),
    'suiteA256Gcm', coalesce(
      capture_row.content_envelope ->> 'suite' = 'A256GCM', false
    ),
    'fingerprintShapeValid', coalesce(
      capture_row.content_fingerprint ~ '^[0-9a-f]{64}$', false
    )
  );
end;
$$;

-- Keep the expanded capture projections available during dual-write rollback,
-- but never let their legacy plaintext/old-key shape cross encrypted-read.
alter function public.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) set schema private;
alter function private.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) rename to expanded_list_captures;
alter function public.get_capture_detail(uuid, text) set schema private;
alter function private.get_capture_detail(uuid, text)
rename to expanded_get_capture_detail;
alter function public.get_capture_receipt(uuid, text) set schema private;
alter function private.get_capture_receipt(uuid, text)
rename to expanded_get_capture_receipt;

revoke execute on function private.expanded_list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.expanded_get_capture_detail(uuid, text)
from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.expanded_get_capture_receipt(uuid, text)
from public, anon, authenticated, service_role, unfiled_index_worker;

create or replace function public.list_captures(
  p_owner_id uuid,
  p_cursor text default null,
  p_limit integer default 30,
  p_status text default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.legacy_plaintext_reads_allowed(p_owner_id) then
    raise exception using errcode = 'P0001', message = 'encrypted_content_required';
  end if;
  return private.expanded_list_captures(
    p_owner_id, p_cursor, p_limit, p_status, p_from, p_to
  );
end;
$$;

create or replace function public.get_capture_detail(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.legacy_plaintext_reads_allowed(p_owner_id) then
    raise exception using errcode = 'P0001', message = 'encrypted_content_required';
  end if;
  return private.expanded_get_capture_detail(p_owner_id, p_capture_id);
end;
$$;

create or replace function public.get_capture_receipt(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if not public.legacy_plaintext_reads_allowed(p_owner_id) then
    raise exception using errcode = 'P0001', message = 'encrypted_content_required';
  end if;
  return private.expanded_get_capture_receipt(p_owner_id, p_capture_id);
end;
$$;

create or replace function private.content_encryption_readiness(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  required_count bigint;
  exact_verified_count bigint;
  missing_count bigint;
  missing_by_surface jsonb;
  active_key_slots integer;
  taxonomy_epoch_ready boolean;
begin
  select * into rollout_row from public.content_encryption_rollouts
  where user_id = p_owner_id;
  if not found then
    return jsonb_build_object(
      'readyForEncryptedRead', false,
      'requiredObjectCount', 0,
      'exactVerifiedObjectCount', 0,
      'missingObjectCount', 0,
      'missingBySurface', '{}'::jsonb,
      'activeKeySlots', 0,
      'taxonomyEpochReady', false,
      'backfillComplete', false
    );
  end if;

  with required(surface, resource_id, record_version, envelope_value) as (
    select 'space_display', id, current_revision, display_envelope from public.spaces
      where user_id = p_owner_id
    union all select 'tag_display', id, current_revision, display_envelope from public.tags
      where user_id = p_owner_id
    union all select 'note_content', id, current_revision, content_envelope from public.notes
      where user_id = p_owner_id
    union all select 'note_revision', id, revision, snapshot_envelope
      from public.note_revisions where user_id = p_owner_id
    union all select 'organization_decision', id, decision_content_revision,
      decision_envelope from public.organization_decisions where user_id = p_owner_id
    union all select 'note_mutation', id, after_revision, mutation_envelope
      from public.note_mutations where user_id = p_owner_id
    union all select 'generated_block', id, 1, content_envelope
      from public.generated_blocks where user_id = p_owner_id
    union all select 'review_item', id, review_content_revision, review_envelope
      from public.review_items where user_id = p_owner_id
    union all select 'routing_rule', id, condition_revision, condition_envelope
      from public.routing_rules where user_id = p_owner_id
    union all select 'organization_mutation_attempt', job_id || ':' || note_id,
      attempt_content_revision, attempt_envelope
      from public.organization_mutation_attempts where user_id = p_owner_id
    union all select 'idempotency_response', 'idempotency:' || idempotency_key,
      1, response_envelope from public.api_idempotency_records
      where user_id = p_owner_id
    union all select 'capture_receipt', capture_id, receipt_revision,
      receipt_envelope from public.capture_receipts where user_id = p_owner_id
    union all select 'capture', id, 1, content_envelope from public.captures
      where user_id = p_owner_id and deleted_at is null and status <> 'deleted'
  ), checked as (
    select required.*,
      verification.resource_id is not null
        and required.envelope_value is not null
        and verification.record_version = required.record_version
        and verification.envelope_digest = encode(
          extensions.digest(required.envelope_value::text, 'sha256'), 'hex'
        )
        and exists (
          select 1 from public.user_content_keys as mac_key
          where mac_key.user_id = p_owner_id
            and mac_key.key_id = verification.verification_mac_key_id
            and mac_key.key_class = verification.verification_mac_key_class
            and mac_key.key_purpose = verification.verification_mac_key_purpose
            and mac_key.key_version = verification.verification_mac_key_version
            and mac_key.state in ('active', 'retired')
        ) as exact_verified
    from required
    left join public.content_encryption_verifications as verification
      on verification.user_id = p_owner_id
      and verification.surface = required.surface
      and verification.resource_id = required.resource_id
  ), surface_missing as (
    select surface, count(*) filter (where not exact_verified)::bigint as missing
    from checked group by surface
  )
  select
    (select count(*) from checked),
    (select count(*) from checked where exact_verified),
    (select count(*) from checked where not exact_verified),
    coalesce((
      select jsonb_object_agg(surface, missing order by surface)
      from surface_missing where missing > 0
    ), '{}'::jsonb)
  into required_count, exact_verified_count, missing_count, missing_by_surface;

  select count(*)::integer into active_key_slots
  from public.user_content_keys
  where user_id = p_owner_id and state = 'active'
    and (key_class, key_purpose) in (
      ('ai_assisted'::public.content_key_class,
        'object_wrap'::public.content_key_purpose),
      ('ai_assisted'::public.content_key_class,
        'content_mac'::public.content_key_purpose),
      ('private_manual'::public.content_key_class,
        'object_wrap'::public.content_key_purpose),
      ('private_manual'::public.content_key_class,
        'content_mac'::public.content_key_purpose)
    );

  taxonomy_epoch_ready := (
    (not exists (select 1 from public.spaces where user_id = p_owner_id)
      or (
        (select count(distinct display_mac_key_id) = 1 from public.spaces
          where user_id = p_owner_id)
        and not exists (select 1 from public.spaces where user_id = p_owner_id
          and (display_mac is null or display_mac_key_class <> 'private_manual'))
      ))
    and
    (not exists (select 1 from public.tags where user_id = p_owner_id)
      or (
        (select count(distinct display_mac_key_id) = 1 from public.tags
          where user_id = p_owner_id)
        and not exists (select 1 from public.tags where user_id = p_owner_id
          and (display_mac is null or display_mac_key_class <> 'private_manual'))
      ))
  );

  return jsonb_build_object(
    'readyForEncryptedRead',
      missing_count = 0
      and active_key_slots = 4
      and taxonomy_epoch_ready
      and rollout_row.encrypted_object_count = rollout_row.verified_object_count
      and (rollout_row.backfill_completed_at is not null or required_count = 0),
    'requiredObjectCount', required_count,
    'exactVerifiedObjectCount', exact_verified_count,
    'missingObjectCount', missing_count,
    'missingBySurface', missing_by_surface,
    'activeKeySlots', active_key_slots,
    'taxonomyEpochReady', taxonomy_epoch_ready,
    'backfillComplete', rollout_row.backfill_completed_at is not null
  );
end;
$$;

create or replace function public.get_content_encryption_rollout(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into rollout_row from public.content_encryption_rollouts
  where user_id = p_owner_id;
  if not found then
    return jsonb_build_object(
      'found', false,
      'state', 'expanded',
      'writeMode', 'legacy',
      'readMode', 'legacy',
      'readiness', private.content_encryption_readiness(p_owner_id)
    );
  end if;
  return jsonb_build_object(
    'found', true,
    'state', rollout_row.state,
    'writeMode', case when rollout_row.state = 'expanded' then 'legacy'
      else 'encrypted' end,
    'readMode', case when rollout_row.state < 'encrypted_read' then 'legacy'
      else 'encrypted' end,
    'backfill', jsonb_build_object(
      'cursor', rollout_row.backfill_cursor,
      'complete', rollout_row.backfill_completed_at is not null,
      'encryptedObjectCount', rollout_row.encrypted_object_count,
      'verifiedObjectCount', rollout_row.verified_object_count
    ),
    'readiness', private.content_encryption_readiness(p_owner_id)
  );
end;
$$;

create or replace function public.complete_content_encryption_backfill(
  p_owner_id uuid,
  p_batch_reference text,
  p_expected_cursor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  readiness_value jsonb;
  request_digest_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or char_length(p_batch_reference) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_digest_value := encode(extensions.digest(jsonb_build_object(
    'ownerId', p_owner_id,
    'operation', 'complete_content_encryption_backfill',
    'batchReference', p_batch_reference,
    'expectedCursor', p_expected_cursor
  )::text, 'sha256'), 'hex');
  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  select * into rollout_row from public.content_encryption_rollouts
  where user_id = p_owner_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  if rollout_row.state <> 'dual_write' then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;
  if rollout_row.backfill_completed_at is not null then
    if rollout_row.last_backfill_surface <> 'completion'
      or rollout_row.last_backfill_request_digest <> request_digest_value
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object('complete', true, 'replayed', true);
  end if;
  if rollout_row.backfill_cursor is distinct from p_expected_cursor then
    raise exception using errcode = 'P0001', message = 'stale_backfill_cursor';
  end if;
  readiness_value := private.content_encryption_readiness(p_owner_id);
  if (readiness_value ->> 'missingObjectCount')::bigint <> 0
    or (readiness_value ->> 'activeKeySlots')::integer <> 4
    or not (readiness_value ->> 'taxonomyEpochReady')::boolean
    or rollout_row.encrypted_object_count <> rollout_row.verified_object_count
  then
    raise exception using errcode = 'P0001', message = 'incomplete_encryption_backfill';
  end if;
  update public.content_encryption_rollouts set
    backfill_cursor = null,
    backfill_completed_at = clock_timestamp(),
    last_backfill_batch_reference = p_batch_reference,
    last_backfill_surface = 'completion',
    last_backfill_resource_id = '-',
    last_backfill_expected_cursor = p_expected_cursor,
    last_backfill_next_cursor = null,
    last_backfill_encrypted_delta = 0,
    last_backfill_verified_delta = 0,
    last_backfill_complete = true,
    last_backfill_envelope_digest = repeat('0', 64),
    last_backfill_request_digest = request_digest_value
  where user_id = p_owner_id;
  return jsonb_build_object('complete', true, 'replayed', false);
end;
$$;

create or replace function public.advance_content_encryption_rollout(
  p_owner_id uuid,
  p_expected_state public.encryption_rollout_state,
  p_next_state public.encryption_rollout_state
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  readiness_value jsonb;
  key_class_value public.content_key_class;
  key_purpose_value public.content_key_purpose;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_expected_state is null or p_next_state is null
    or not (
      (p_expected_state = 'expanded' and p_next_state = 'dual_write')
      or (p_expected_state = 'dual_write' and p_next_state = 'encrypted_read')
    )
  then raise exception using errcode = '22023', message = 'invalid_rollout_transition';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_owner_id::text || ':content-encryption-rollout', 0)
  );
  foreach key_class_value in array array[
    'ai_assisted'::public.content_key_class,
    'private_manual'::public.content_key_class
  ] loop
    foreach key_purpose_value in array array[
      'content_mac'::public.content_key_purpose,
      'object_wrap'::public.content_key_purpose
    ] loop
      perform pg_advisory_xact_lock(hashtextextended(
        p_owner_id::text || ':' || key_class_value::text || ':'
          || key_purpose_value::text, 0
      ));
    end loop;
  end loop;

  select * into rollout_row from public.content_encryption_rollouts
  where user_id = p_owner_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  if rollout_row.state = p_next_state then
    return jsonb_build_object(
      'state', rollout_row.state,
      'readMode', case when rollout_row.state = 'encrypted_read'
        then 'encrypted' else 'legacy' end,
      'replayed', true
    );
  end if;
  if rollout_row.state <> p_expected_state then
    raise exception using errcode = 'P0001', message = 'stale_rollout_state';
  end if;
  if p_next_state = 'dual_write' and exists (
    select 1 from public.organization_jobs as job
    where job.user_id = p_owner_id
      and job.state in ('created', 'running', 'awaiting_retry')
  ) then
    raise exception using
      errcode = 'P0001', message = 'organizer_jobs_in_flight';
  end if;
  readiness_value := private.content_encryption_readiness(p_owner_id);
  if (readiness_value ->> 'activeKeySlots')::integer <> 4 then
    raise exception using errcode = 'P0001', message = 'active_content_keys_missing';
  end if;
  if p_next_state = 'encrypted_read'
    and not (readiness_value ->> 'readyForEncryptedRead')::boolean
  then
    raise exception using errcode = 'P0001', message = 'incomplete_encryption_backfill';
  end if;
  update public.content_encryption_rollouts set state = p_next_state
  where user_id = p_owner_id returning * into rollout_row;
  return jsonb_build_object(
    'state', rollout_row.state,
    'readMode', case when rollout_row.state = 'encrypted_read'
      then 'encrypted' else 'legacy' end,
    'replayed', false
  );
end;
$$;

-- Preserve the expanded search implementation for rollback, but put an
-- explicit per-owner rollout gate in front of the SECURITY DEFINER surface.
-- RLS is defense in depth here, not the encrypted-read boundary.
alter function public.search_notes(text, text, integer, integer)
set schema private;
alter function private.search_notes(text, text, integer, integer)
rename to expanded_search_notes;
revoke execute on function private.expanded_search_notes(
  text, text, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker;

create or replace function public.search_notes(
  p_query text,
  p_archive_filter text default 'exclude',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  note_id text,
  title text,
  snippet text,
  space_path text,
  updated_at timestamptz,
  rank double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  if not public.legacy_plaintext_reads_allowed(owner_id) then
    raise exception using errcode = 'P0001', message = 'encrypted_content_required';
  end if;
  return query select * from private.expanded_search_notes(
    p_query, p_archive_filter, p_limit, p_offset
  );
end;
$$;
revoke execute on function public.search_notes(text, text, integer, integer)
from public, anon, unfiled_index_worker;
grant execute on function public.search_notes(text, text, integer, integer)
to authenticated, service_role;

revoke execute on function private.content_encryption_readiness(uuid)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.apply_encrypted_note_mutation(
  uuid, text, integer, text, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_content_encryption_backfill_candidates(
  uuid, text, text, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.commit_content_encryption_backfill(
  uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb,
  text, text, text, boolean
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.reseal_capture_content(
  uuid, text, jsonb, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.create_encrypted_capture_with_job(uuid, jsonb)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.verify_encrypted_content_object(
  uuid, text, text, integer, jsonb, jsonb
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_encrypted_notes(
  uuid, timestamptz, text, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_note(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_encrypted_note_revisions(
  uuid, text, integer, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_note_mutation(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_encrypted_captures(
  uuid, timestamptz, text, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_capture_detail(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_capture_receipt(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_capture_storage_attestation(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_encrypted_generated_blocks(uuid, text[])
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_capture_detail(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_capture_receipt(uuid, text)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_encrypted_library_objects(
  uuid, text, text, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.get_content_encryption_rollout(uuid)
from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.complete_content_encryption_backfill(
  uuid, text, text
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.advance_content_encryption_rollout(
  uuid, public.encryption_rollout_state, public.encryption_rollout_state
) from public, anon, authenticated, unfiled_index_worker;

grant execute on function public.apply_encrypted_note_mutation(
  uuid, text, integer, text, jsonb
) to service_role;
grant execute on function public.list_content_encryption_backfill_candidates(
  uuid, text, text, integer
) to service_role;
grant execute on function public.commit_content_encryption_backfill(
  uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb,
  text, text, text, boolean
) to service_role;
grant execute on function public.reseal_capture_content(
  uuid, text, jsonb, text, jsonb, jsonb, jsonb
) to service_role;
grant execute on function public.create_encrypted_capture_with_job(uuid, jsonb)
to service_role;
grant execute on function public.verify_encrypted_content_object(
  uuid, text, text, integer, jsonb, jsonb
) to service_role;
grant execute on function public.list_encrypted_notes(
  uuid, timestamptz, text, integer
) to service_role;
grant execute on function public.get_encrypted_note(uuid, text)
to service_role;
grant execute on function public.list_encrypted_note_revisions(
  uuid, text, integer, integer
) to service_role;
grant execute on function public.get_encrypted_note_mutation(uuid, text)
to service_role;
grant execute on function public.list_encrypted_captures(
  uuid, timestamptz, text, integer
) to service_role;
grant execute on function public.get_encrypted_capture_detail(uuid, text)
to service_role;
grant execute on function public.get_encrypted_capture_receipt(uuid, text)
to service_role;
grant execute on function public.get_capture_storage_attestation(uuid, text)
to service_role;
grant execute on function public.get_encrypted_generated_blocks(uuid, text[])
to service_role;
grant execute on function public.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.get_capture_detail(uuid, text)
to service_role;
grant execute on function public.get_capture_receipt(uuid, text)
to service_role;
grant execute on function public.list_encrypted_library_objects(
  uuid, text, text, integer
) to service_role;
grant execute on function public.get_content_encryption_rollout(uuid)
to service_role;
grant execute on function public.complete_content_encryption_backfill(
  uuid, text, text
) to service_role;
grant execute on function public.advance_content_encryption_rollout(
  uuid, public.encryption_rollout_state, public.encryption_rollout_state
) to service_role;

-- Functions created after the earlier worker allowlist receive PUBLIC execute
-- by default, so finish by reapplying the exact C.5a worker capability set.
revoke execute on all functions in schema public from unfiled_index_worker;
grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to unfiled_index_worker;
grant execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) to unfiled_index_worker;
grant execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) to unfiled_index_worker;
grant execute on function public.fail_note_index_job(
  text, uuid, public.safe_error_code, boolean, integer
) to unfiled_index_worker;
grant execute on function public.recover_stale_note_index_jobs(integer)
to unfiled_index_worker;
grant execute on function public.list_active_note_rag_index(
  uuid, text, integer
) to unfiled_index_worker;
