-- Milestone C.5c-3: isolated encrypted organizer runtime.
--
-- The organizer owns one deliberately small capability vocabulary. Every
-- owner identifier is derived from an exact live organization-job lease; no
-- public organizer function accepts an owner UUID. Ciphertext projections are
-- AI-assisted-only, byte bounded, and joined back to current authoritative
-- rows. Preparation reserves every wrap before model output is materialized,
-- and completion publishes the note, decision, receipt, and terminal lease
-- transition in one database transaction.

do $dedicated_organizer_worker$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'unfiled_organizer_worker'
  ) then
    execute 'create role unfiled_organizer_worker '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  else
    execute 'alter role unfiled_organizer_worker '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'unfiled_organizer_worker'
      and (
        rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
        or rolreplication or rolbypassrls
      )
  ) then
    raise exception using
      errcode = '42501', message = 'organizer_role_attributes_not_reconciled';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted
      on granted.oid = membership.roleid
    join pg_catalog.pg_roles as member
      on member.oid = membership.member
    join pg_catalog.pg_roles as grantor
      on grantor.oid = membership.grantor
    where (
      member.rolname = 'unfiled_organizer_worker'
      or granted.rolname = 'unfiled_organizer_worker'
    )
      and not (
        granted.rolname = 'unfiled_organizer_worker'
        and member.rolname = 'postgres'
        and grantor.rolname = 'supabase_admin'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
  ) then
    raise exception using
      errcode = '42501', message = 'organizer_role_membership_not_reconciled';
  end if;
end;
$dedicated_organizer_worker$;

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer'
    )
  );

alter table public.organization_jobs
  add column replan_count integer not null default 0
    check (replan_count between 0 and 1);

create table public.encrypted_organizer_preparations (
  job_id text primary key references public.organization_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_id text not null references public.captures(id) on delete cascade,
  attempt integer not null check (attempt between 1 and 5),
  generation integer not null default 0 check (generation between 0 and 1),
  lease_token uuid not null,
  mode text not null check (mode in ('create', 'append')),
  note_id text not null check (note_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'),
  expected_revision integer check (expected_revision is null or expected_revision >= 1),
  target_revision integer not null check (target_revision >= 1),
  decision_id text not null unique check (decision_id ~ '^dec_[0-9A-HJKMNP-TV-Z]{26}$'),
  revision_id text not null unique check (revision_id ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
  mutation_id text not null unique check (mutation_id ~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'),
  review_item_id text not null unique check (review_item_id ~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'),
  write_reservation_id uuid,
  decision_reservation_id uuid,
  review_reservation_id uuid,
  receipt_reservation_id uuid,
  object_key_id text,
  object_key_version integer,
  controls jsonb check (
    controls is null
    or (
      jsonb_typeof(controls) = 'object'
      and controls ?& array[
        'explicitDestinationNoteId', 'expansionDisabled'
      ]
      and controls - array[
        'explicitDestinationNoteId', 'expansionDisabled'
      ] = '{}'::jsonb
    )
  ),
  prepare_replan_request_hash text check (
    prepare_replan_request_hash is null
    or prepare_replan_request_hash ~ '^[0-9a-f]{64}$'
  ),
  prepare_replan_result jsonb check (
    prepare_replan_result is null
    or jsonb_typeof(prepare_replan_result) = 'object'
  ),
  commit_replan_command_hash text check (
    commit_replan_command_hash is null
    or commit_replan_command_hash ~ '^[0-9a-f]{64}$'
  ),
  commit_replan_result jsonb check (
    commit_replan_result is null
    or jsonb_typeof(commit_replan_result) = 'object'
  ),
  command_hash text check (command_hash is null or command_hash ~ '^[0-9a-f]{64}$'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, capture_id),
  check (
    (mode = 'create' and expected_revision is null and target_revision = 1)
    or (
      mode = 'append' and expected_revision is not null
      and target_revision = expected_revision + 1
    )
  ),
  check (
    (
      write_reservation_id is null
      and decision_reservation_id is null
      and review_reservation_id is null
      and receipt_reservation_id is null
      and object_key_id is null
      and object_key_version is null
      and controls is null
    )
    or (
      write_reservation_id is not null
      and decision_reservation_id is not null
      and review_reservation_id is not null
      and receipt_reservation_id is not null
      and object_key_id is not null
      and object_key_version >= 1
      and controls is not null
    )
  ),
  check (
    (completed_at is null and command_hash is null and result is null)
    or (completed_at is not null and command_hash is not null and result is not null)
  ),
  check (
    (prepare_replan_request_hash is null and prepare_replan_result is null)
    or (
      prepare_replan_request_hash is not null
      and prepare_replan_result is not null
    )
  ),
  check (
    (commit_replan_command_hash is null and commit_replan_result is null)
    or (
      commit_replan_command_hash is not null
      and commit_replan_result is not null
    )
  ),
  foreign key (user_id, write_reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    deferrable initially deferred,
  foreign key (user_id, decision_reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    deferrable initially deferred,
  foreign key (user_id, review_reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    deferrable initially deferred,
  foreign key (user_id, receipt_reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    deferrable initially deferred,
  check (object_key_id is null or object_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);

-- Candidate ciphertext is disclosed in two phases: list produces this
-- content-free lease snapshot, then heartbeat locks and revalidates every
-- authoritative row immediately before the worker may call a model. Keeping
-- the exact ordered manifest server-side prevents a caller from authorizing a
-- convenient subset after a listed candidate changes privacy or revision.
create table public.encrypted_organizer_candidate_pages (
  job_id text primary key references public.organization_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt integer not null check (attempt between 1 and 5),
  lease_token uuid not null,
  controls jsonb not null check (
    jsonb_typeof(controls) = 'object'
    and controls ?& array['explicitDestinationNoteId', 'expansionDisabled']
    and controls - array[
      'explicitDestinationNoteId', 'expansionDisabled'
    ] = '{}'::jsonb
  ),
  candidate_manifest jsonb not null check (
    jsonb_typeof(candidate_manifest) = 'array'
    and jsonb_array_length(candidate_manifest) between 0 and 8
  ),
  conflict_result jsonb check (
    conflict_result is null or jsonb_typeof(conflict_result) = 'object'
  ),
  listed_at timestamptz not null default now(),
  authorized_at timestamptz,
  conflict_recorded_at timestamptz,
  check (
    (conflict_result is null and conflict_recorded_at is null)
    or (conflict_result is not null and conflict_recorded_at is not null)
  )
);

alter table public.encrypted_organizer_preparations enable row level security;
alter table public.encrypted_organizer_preparations force row level security;
revoke all on table public.encrypted_organizer_preparations
  from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
alter table public.encrypted_organizer_candidate_pages enable row level security;
alter table public.encrypted_organizer_candidate_pages force row level security;
revoke all on table public.encrypted_organizer_candidate_pages
  from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- Row-level BEFORE triggers run after PostgreSQL has identified and locked an
-- UPDATE/DELETE target. Keep migration 16's complete encrypted-write
-- validation intact, but put a nonblocking advisory acquisition first in the
-- alphabetical trigger order. A row-first legacy writer therefore either
-- acquires the uncontended owner rollout lock or aborts with retryable 40001;
-- it can never wait on that advisory while a rollout holder waits on its row.
create or replace function private.try_prelock_content_encryption_rollout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid := case
    when tg_op = 'DELETE' then old.user_id else new.user_id
  end;
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception using
      errcode = '42501', message = 'content_owner_immutable';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      owner_id_value::text || ':content-encryption-rollout', 0
    )
  ) then
    raise exception using
      errcode = '40001', message = 'content_encryption_rollout_busy';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists a_content_rollout_advisory_prelock
  on public.spaces;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.spaces
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.tags;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.tags
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.notes;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.notes
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.note_revisions;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.note_revisions
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.note_mutations;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.note_mutations
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.organization_decisions;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.organization_decisions
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.generated_blocks;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.generated_blocks
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.review_items;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.review_items
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.routing_rules;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.routing_rules
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.organization_mutation_attempts;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.organization_mutation_attempts
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.api_idempotency_records;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.api_idempotency_records
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.capture_receipts;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.capture_receipts
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.captures;
create trigger a_content_rollout_advisory_prelock
before insert or update on public.captures
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists a_content_rollout_advisory_prelock
  on public.organization_jobs;
create trigger a_content_rollout_advisory_prelock
before insert or update or delete on public.organization_jobs
for each row execute function private.try_prelock_content_encryption_rollout();

create or replace function private.serialize_content_rollout_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      old.user_id::text || ':content-encryption-rollout', 0
    )
  ) then
    raise exception using
      errcode = '40001', message = 'content_encryption_rollout_busy';
  end if;
  return old;
end;
$$;

create or replace function private.enforce_encrypted_organizer_rollout_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_state public.encryption_rollout_state;
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception using
      errcode = '42501', message = 'organization_job_owner_immutable';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      new.user_id::text || ':content-encryption-rollout', 0
    )
  ) then
    raise exception using
      errcode = '40001', message = 'content_encryption_rollout_busy';
  end if;
  select state into rollout_state
  from public.content_encryption_rollouts
  where user_id = new.user_id
  for share;
  rollout_state := coalesce(
    rollout_state, 'expanded'::public.encryption_rollout_state
  );
  if rollout_state < 'dual_write' then
    return new;
  end if;

  -- The interactive service may enqueue a content-complete encrypted job, but
  -- the dedicated organizer is the only workload allowed to hold its running
  -- capability. service_role remains accepted for migration-owned recovery
  -- and old local fixtures; production routing retires that caller in C.5c-3.
  if new.state = 'running'
    and session_user <> 'unfiled_organizer_worker'
    and auth.role() is distinct from 'service_role'
  then
    raise exception using
      errcode = '42501', message = 'encrypted_organizer_identity_required';
  end if;
  return new;
end;
$$;

-- Lease and projection helpers are declared before the runtime operations that
-- call them. Their execute privileges are removed explicitly in the final ACL
-- rebuild below.
create or replace function private.lock_encrypted_organizer_job_rollout(
  p_job_id text
)
returns public.organization_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid;
  job_row public.organization_jobs%rowtype;
begin
  -- The owner lookup deliberately takes no row lock. All organizer mutations
  -- acquire the canonical rollout advisory before their first job/content row
  -- lock, matching the migration and verifier lock order. The guard above
  -- makes this owner identity immutable before the row is revalidated.
  select job.user_id into owner_id_value
  from public.organization_jobs as job
  where job.id = p_job_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    owner_id_value::text || ':content-encryption-rollout', 0
  ));

  select * into job_row
  from public.organization_jobs as job
  where job.id = p_job_id
  for update of job;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if job_row.user_id <> owner_id_value then
    raise exception using
      errcode = '40001', message = 'organization_job_owner_changed';
  end if;
  return job_row;
end;
$$;

create or replace function private.assert_encrypted_organizer_lease(
  p_job_id text,
  p_lease_token text,
  p_lock boolean default true
)
returns public.organization_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  lease_value uuid;
begin
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    lease_value := p_lease_token::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if p_lock then
    job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  else
    select * into job_row from public.organization_jobs
    where id = p_job_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
  end if;
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from lease_value
    or job_row.lease_expires_at <= clock_timestamp()
  then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  -- Global workflow publication order is job -> source capture -> target note.
  -- The row lock is retained for the whole prepare/commit statement, so a
  -- privacy or retention transition cannot win after authorization but before
  -- encrypted state is published.
  perform 1
  from public.captures as capture
  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id
    and capture.deleted_at is null
    and capture.status = 'processing'
    and capture.privacy = 'ai_assisted'
    and capture.content_envelope is not null
    and capture.content_key_class = 'ai_assisted'
    and capture.content_key_purpose = 'object_wrap'
  for share of capture;
  if not found then
    raise exception using errcode = '42501', message = 'source_not_disclosable';
  end if;
  return job_row;
end;
$$;

create or replace function private.organizer_key_projection(
  key_value public.user_content_keys
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.content_key_service_projection(key_value);
$$;

create or replace function private.encrypted_organizer_preparation_projection(
  preparation public.encrypted_organizer_preparations,
  object_key public.user_content_keys,
  mac_key public.user_content_keys,
  replayed_value boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobId', preparation.job_id,
    'mode', preparation.mode,
    'noteId', preparation.note_id,
    'expectedRevision', preparation.expected_revision,
    'targetRevision', preparation.target_revision,
    'replanCount', (
      select job.replan_count from public.organization_jobs as job
      where job.id = preparation.job_id
    ),
    'ids', jsonb_build_object(
      'decisionId', preparation.decision_id,
      'revisionId', preparation.revision_id,
      'mutationId', preparation.mutation_id,
      'reviewItemId', preparation.review_item_id
    ),
    'reservations', jsonb_build_object(
      'noteWrite', jsonb_build_object(
        'reservationId', preparation.write_reservation_id,
        'operationCount', 4
      ),
      'decision', jsonb_build_object(
        'reservationId', preparation.decision_reservation_id,
        'operationCount', 1
      ),
      'review', jsonb_build_object(
        'reservationId', preparation.review_reservation_id,
        'operationCount', 1
      ),
      'receipt', jsonb_build_object(
        'reservationId', preparation.receipt_reservation_id,
        'operationCount', 1
      )
    ),
    'keys', jsonb_build_object(
      'objectWrap', private.organizer_key_projection(object_key),
      'contentMac', private.organizer_key_projection(mac_key)
    ),
    'replayed', replayed_value
  );
$$;

-- Keep the already-reviewed private-manual path intact and replace only the
-- fresh AI-assisted branch that C.5b deliberately left fail-closed.
alter function public.create_encrypted_capture_with_job(uuid, jsonb)
  set schema private;
alter function private.create_encrypted_capture_with_job(uuid, jsonb)
  rename to create_encrypted_capture_with_job_legacy;

create function public.create_encrypted_capture_with_job(
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
  device_value text;
  timezone_value text;
  destination_value text;
  expansion_value boolean;
  created_value timestamptz;
  occurred_value timestamptz;
  content_length_value integer;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_capture is null
    or jsonb_typeof(p_capture) <> 'object'
    or p_capture - array[
      'clientCaptureId', 'jobId', 'occurredAt', 'contentCipher',
      'contentMac', 'contentLength', 'source', 'deviceId',
      'clientCreatedAt', 'clientTimezone', 'privacy',
      'explicitDestinationNoteId', 'expansionDisabled',
      'privateReceiptCipher', 'privateReceiptVerificationMac'
    ] <> '{}'::jsonb
    or not p_capture ?& array[
      'clientCaptureId', 'jobId', 'occurredAt', 'contentCipher',
      'contentMac', 'contentLength', 'source', 'clientCreatedAt',
      'clientTimezone', 'privacy', 'privateReceiptCipher',
      'privateReceiptVerificationMac'
    ]
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  begin
    privacy_value := (p_capture ->> 'privacy')::public.privacy_mode;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end;
  if privacy_value = 'private_manual' then
    return private.create_encrypted_capture_with_job_legacy(
      p_owner_id, p_capture
    );
  end if;

  capture_id_value := p_capture ->> 'clientCaptureId';
  job_id_value := p_capture ->> 'jobId';
  content_cipher := p_capture -> 'contentCipher';
  content_mac := p_capture -> 'contentMac';
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
    or jsonb_typeof(p_capture -> 'privateReceiptCipher') <> 'null'
    or jsonb_typeof(p_capture -> 'privateReceiptVerificationMac') <> 'null'
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  begin
    source_value := (p_capture ->> 'source')::public.capture_source;
    created_value := (p_capture ->> 'clientCreatedAt')::timestamptz;
    occurred_value := (p_capture ->> 'occurredAt')::timestamptz;
    content_length_value := (p_capture ->> 'contentLength')::integer;
  exception when invalid_text_representation or datetime_field_overflow
    or numeric_value_out_of_range
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
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
    if capture_row.user_id <> p_owner_id
      or capture_row.deleted_at is not null
      or capture_row.content_fingerprint <> content_mac ->> 'mac'
      or capture_row.fingerprint_key_id <> content_mac ->> 'keyId'
      or capture_row.source <> source_value
      or capture_row.device_id <> device_value
      or capture_row.content_length <> content_length_value
      or capture_row.client_created_at <> created_value
      or capture_row.received_at <> occurred_value
      or capture_row.client_timezone <> timezone_value
      or capture_row.privacy <> 'ai_assisted'
      or capture_row.explicit_destination_note_id is distinct from destination_value
      or capture_row.expansion_disabled <> expansion_value
      or not private.valid_encrypted_write_mac(
        content_mac, p_owner_id, 'ai_assisted', true
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    select * into job_row
    from public.organization_jobs
    where user_id = p_owner_id and capture_id = capture_id_value;
    if not found or job_row.id <> job_id_value then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'captureId', capture_id_value,
      'jobId', job_row.id,
      'replayed', true
    );
  end if;

  if occurred_value <> date_trunc('milliseconds', occurred_value)
    or occurred_value < clock_timestamp() - interval '30 days'
    or occurred_value > clock_timestamp() + interval '5 minutes'
    or created_value < occurred_value - interval '30 days'
    or created_value > occurred_value + interval '5 minutes'
    or exists (select 1 from public.organization_jobs where id = job_id_value)
  then
    raise exception using errcode = '22023', message = 'invalid_capture_time';
  end if;
  if destination_value is not null and not exists (
    select 1 from public.notes
    where user_id = p_owner_id
      and id = destination_value
      and deleted_at is null
  ) then
    raise exception using
      errcode = '42501', message = 'explicit_destination_not_owned';
  end if;
  if not private.valid_encrypted_write_cipher(
      content_cipher, p_owner_id, capture_id_value, 1, 'capture',
      'ai_assisted'
    )
    or not private.valid_encrypted_write_mac(
      content_mac, p_owner_id, 'ai_assisted', false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(content_cipher), 'capture', capture_id_value
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
    'ai_assisted', destination_value, expansion_value, created_value,
    timezone_value, occurred_value, 'queued', content_cipher ->> 'keyId',
    (content_cipher ->> 'keyClass')::public.content_key_class,
    (content_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (content_cipher ->> 'keyVersion')::integer, content_mac ->> 'keyId',
    (content_mac ->> 'keyClass')::public.content_key_class,
    (content_mac ->> 'keyPurpose')::public.content_key_purpose,
    (content_mac ->> 'keyVersion')::integer
  ) returning * into capture_row;

  insert into public.organization_jobs (
    id, capture_id, user_id, state, prompt_version, schema_version,
    available_at, created_at, updated_at
  ) values (
    job_id_value, capture_id_value, p_owner_id, 'created',
    'routing-v1', 1, occurred_value, occurred_value, occurred_value
  ) returning * into job_row;
  perform private.record_content_encryption_verification(
    p_owner_id, 'capture', capture_id_value, 1,
    content_cipher -> 'envelope', content_mac
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1
  where user_id = p_owner_id;
  perform private.emit_user_event(p_owner_id, 'capture', capture_id_value);
  perform private.emit_user_event(p_owner_id, 'organization_job', job_row.id);
  return jsonb_build_object(
    'captureId', capture_id_value,
    'jobId', job_row.id,
    'replayed', false
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'invalid_capture';
end;
$$;

revoke execute on function private.create_encrypted_capture_with_job_legacy(
  uuid, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.create_encrypted_capture_with_job(uuid, jsonb)
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.create_encrypted_capture_with_job(uuid, jsonb)
to service_role;

create or replace function private.claim_encrypted_organizer_jobs_impl(
  p_worker_id text,
  p_claim_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  candidate_ids text[];
  candidate_owner_ids uuid[];
  candidate_capture_ids text[];
  candidate_created_ats timestamptz[];
  owner_id_value uuid;
  job_row public.organization_jobs%rowtype;
  capture_row public.captures%rowtype;
  source_key public.user_content_keys%rowtype;
  jobs_value jsonb := '[]'::jsonb;
  source_bytes integer := 0;
  next_bytes integer;
  payload_bytes integer;
  source_byte_budget constant integer := 8388608;
begin
  if p_worker_id is null
    or char_length(btrim(p_worker_id)) not between 1 and 120
    or p_claim_limit is null
    or p_claim_limit not between 1 and 4
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- Bound the candidate set without taking row locks, then acquire every
  -- distinct owner rollout advisory in canonical UUID order. No per-job
  -- advisory or row lock is taken until the whole owner set is held, so two
  -- multi-owner claimers cannot accumulate owner locks in opposite orders.
  select
    coalesce(
      pg_catalog.array_agg(frozen_candidate.id order by
        frozen_candidate.available_at, frozen_candidate.created_at,
        frozen_candidate.id),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(frozen_candidate.user_id order by
        frozen_candidate.available_at, frozen_candidate.created_at,
        frozen_candidate.id),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.array_agg(frozen_candidate.capture_id order by
        frozen_candidate.available_at, frozen_candidate.created_at,
        frozen_candidate.id),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(frozen_candidate.created_at order by
        frozen_candidate.available_at, frozen_candidate.created_at,
        frozen_candidate.id),
      array[]::timestamptz[]
    )
  into
    candidate_ids, candidate_owner_ids, candidate_capture_ids,
    candidate_created_ats
  from (
    select
      job.id, job.user_id, job.capture_id, job.available_at, job.created_at
    from public.organization_jobs as job
    join public.captures as capture
      on capture.id = job.capture_id and capture.user_id = job.user_id
    join public.content_encryption_rollouts as rollout
      on rollout.user_id = job.user_id
      and rollout.state in ('dual_write', 'encrypted_read')
    where job.state in ('created', 'awaiting_retry')
      and job.available_at <= clock_timestamp()
      and job.attempt < 5
      and capture.deleted_at is null
      and capture.status in ('pending', 'queued')
      and capture.privacy = 'ai_assisted'
      and capture.content_envelope is not null
      and capture.content_key_class = 'ai_assisted'
      and capture.content_key_purpose = 'object_wrap'
    order by job.available_at, job.created_at, job.id
    limit least(p_claim_limit * 10, 250)
  ) as frozen_candidate;

  for owner_id_value in
    select distinct locked_owner.user_id
    from pg_catalog.unnest(candidate_owner_ids) as locked_owner(user_id)
    order by locked_owner.user_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      owner_id_value::text || ':content-encryption-rollout', 0
    ));
  end loop;

  for candidate in
    select job.id, job.user_id, job.capture_id, job.created_at
    from rows from (
      pg_catalog.unnest(candidate_ids),
      pg_catalog.unnest(candidate_owner_ids),
      pg_catalog.unnest(candidate_capture_ids),
      pg_catalog.unnest(candidate_created_ats)
    ) as target(id, user_id, capture_id, created_at)
    join public.organization_jobs as job
      on job.id = target.id
      and job.user_id = target.user_id
      and job.capture_id = target.capture_id
      and job.created_at = target.created_at
    join public.captures as capture
      on capture.id = job.capture_id and capture.user_id = job.user_id
    join public.content_encryption_rollouts as rollout
      on rollout.user_id = job.user_id
      and rollout.state in ('dual_write', 'encrypted_read')
    where job.state in ('created', 'awaiting_retry')
      and job.available_at <= clock_timestamp()
      and job.attempt < 5
      and capture.deleted_at is null
      and capture.status in ('pending', 'queued')
      and capture.privacy = 'ai_assisted'
      and capture.content_envelope is not null
      and capture.content_key_class = 'ai_assisted'
      and capture.content_key_purpose = 'object_wrap'
    order by job.available_at, job.created_at, job.id
  loop
    exit when jsonb_array_length(jobs_value) >= p_claim_limit;
    if not pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('encrypted-organizer-claim:' || candidate.id, 0)
    ) then
      continue;
    end if;

    -- Global workflow publication order is job -> capture -> note.
    select * into job_row
    from public.organization_jobs as job
    where job.id = candidate.id
      and job.user_id = candidate.user_id
      and job.capture_id = candidate.capture_id
      and job.created_at = candidate.created_at
      and job.state in ('created', 'awaiting_retry')
      and job.available_at <= clock_timestamp()
      and job.attempt < 5
    for update of job;
    if not found then continue; end if;

    select * into capture_row
    from public.captures as capture
    where capture.id = candidate.capture_id
      and capture.user_id = candidate.user_id
      and capture.deleted_at is null
      and capture.status in ('pending', 'queued')
      and capture.privacy = 'ai_assisted'
      and capture.content_envelope is not null
      and capture.content_key_class = 'ai_assisted'
      and capture.content_key_purpose = 'object_wrap'
    for update of capture;
    if not found then continue; end if;

    next_bytes := pg_catalog.octet_length(capture_row.content_envelope::text);
    payload_bytes := (
      pg_catalog.char_length(
        capture_row.content_envelope -> 'payload' ->> 'ciphertext'
      ) * 3 / 4
    )::integer;
    if next_bytes > source_byte_budget
      or source_bytes > source_byte_budget - next_bytes
      or payload_bytes not between 16 and 1048592
    then
      continue;
    end if;

    select * into source_key
    from public.user_content_keys as content_key
    where content_key.user_id = capture_row.user_id
      and content_key.key_id = capture_row.content_key_id
      and content_key.key_class = 'ai_assisted'
      and content_key.key_purpose = 'object_wrap'
      and content_key.key_version = capture_row.content_key_version
      and content_key.state in ('active', 'retired')
    for share of content_key;
    if not found then continue; end if;

    update public.organization_jobs
    set
      state = 'running',
      attempt = attempt + 1,
      lease_owner = btrim(p_worker_id),
      lease_token = extensions.gen_random_uuid(),
      lease_expires_at = clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp(),
      started_at = coalesce(started_at, clock_timestamp()),
      completed_at = null,
      error_code = null,
      last_transition_lease_token = null,
      last_transition_action = null,
      last_transition_request_hash = null
    where id = job_row.id
    returning * into job_row;

    update public.captures
    set status = 'processing', last_error_code = null
    where id = capture_row.id and user_id = capture_row.user_id;

    update public.encrypted_organizer_preparations
    set
      attempt = job_row.attempt,
      generation = job_row.replan_count,
      lease_token = job_row.lease_token,
      prepare_replan_request_hash = null,
      prepare_replan_result = null,
      commit_replan_command_hash = null,
      commit_replan_result = null,
      updated_at = clock_timestamp()
    where job_id = job_row.id and completed_at is null;
    delete from public.encrypted_organizer_candidate_pages
    where job_id = job_row.id;

    source_bytes := source_bytes + next_bytes;
    jobs_value := jobs_value || jsonb_build_array(jsonb_build_object(
      'jobId', job_row.id,
      'captureId', capture_row.id,
      'ownerId', job_row.user_id,
      'leaseToken', job_row.lease_token,
      'attempt', job_row.attempt,
      'replanCount', job_row.replan_count,
      'leaseExpiresAt', job_row.lease_expires_at,
      'promptVersion', job_row.prompt_version,
      'schemaVersion', job_row.schema_version,
      'controls', jsonb_build_object(
        'explicitDestinationNoteId', capture_row.explicit_destination_note_id,
        'expansionDisabled', capture_row.expansion_disabled
      ),
      'source', jsonb_build_object(
        'resourceId', capture_row.id,
        'recordVersion', 1,
        'envelope', capture_row.content_envelope,
        'keyRecord', private.organizer_key_projection(source_key),
        'encryptedByteLength', payload_bytes
      )
    ));
    perform private.emit_user_event(job_row.user_id, 'organization_job', job_row.id);
    perform private.emit_user_event(job_row.user_id, 'capture', capture_row.id);
  end loop;

  return jsonb_build_object(
    'jobs', jobs_value,
    'sourceEnvelopeBytes', source_bytes,
    'sourceEnvelopeByteBudget', source_byte_budget
  );
end;
$$;

create or replace function private.heartbeat_encrypted_organizer_job_impl(
  p_job_id text,
  p_lease_token text,
  p_lease_seconds integer,
  p_candidate_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  page_row public.encrypted_organizer_candidate_pages%rowtype;
  preparation public.encrypted_organizer_preparations%rowtype;
  note_row public.notes%rowtype;
  binding jsonb;
  candidate_ids text[] := array[]::text[];
  controls_value jsonb;
  controls_conflicted boolean := false;
  conflict_result_value jsonb;
  conflict_note_id text;
  conflict_revision integer;
  conflict_outcome text;
  conflict_reason text;
  candidate_found boolean;
  candidate_count integer;
  current_revision_value integer;
  preparation_found boolean := false;
begin
  if p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
    or p_candidate_manifest is null
    or jsonb_typeof(p_candidate_manifest) <> 'object'
    or p_candidate_manifest - array['controls', 'candidates'] <> '{}'::jsonb
    or not p_candidate_manifest ?& array['controls', 'candidates']
    or jsonb_typeof(p_candidate_manifest -> 'controls') <> 'object'
    or (p_candidate_manifest -> 'controls') - array[
      'explicitDestinationNoteId', 'expansionDisabled'
    ] <> '{}'::jsonb
    or not (p_candidate_manifest -> 'controls') ?& array[
      'explicitDestinationNoteId', 'expansionDisabled'
    ]
    or jsonb_typeof(
      p_candidate_manifest -> 'controls' -> 'expansionDisabled'
    ) <> 'boolean'
    or jsonb_typeof(
      p_candidate_manifest -> 'controls' -> 'explicitDestinationNoteId'
    ) not in ('null', 'string')
    or (
      jsonb_typeof(
        p_candidate_manifest -> 'controls' -> 'explicitDestinationNoteId'
      ) = 'string'
      and p_candidate_manifest -> 'controls' ->> 'explicitDestinationNoteId'
        !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    )
    or jsonb_typeof(p_candidate_manifest -> 'candidates') <> 'array'
    or jsonb_array_length(p_candidate_manifest -> 'candidates') > 8
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );

  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = job_row.id
  for update;
  preparation_found := found;

  select * into page_row
  from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id
    and user_id = job_row.user_id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'candidate_page_required';
  end if;
  if page_row.controls is distinct from p_candidate_manifest -> 'controls'
    or page_row.candidate_manifest
      is distinct from p_candidate_manifest -> 'candidates'
  then
    raise exception using errcode = '42501', message = 'candidate_manifest_mismatch';
  end if;
  if page_row.conflict_result is not null then
    return jsonb_set(
      page_row.conflict_result, '{replayed}', 'true'::jsonb, true
    );
  end if;

  select jsonb_build_object(
    'explicitDestinationNoteId', capture.explicit_destination_note_id,
    'expansionDisabled', capture.expansion_disabled
  ) into controls_value
  from public.captures as capture
  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;
  if controls_value is distinct from page_row.controls then
    controls_conflicted := true;
    conflict_reason := 'consent_controls';
    conflict_note_id := coalesce(
      page_row.controls ->> 'explicitDestinationNoteId',
      controls_value ->> 'explicitDestinationNoteId'
    );
  end if;

  candidate_count := jsonb_array_length(page_row.candidate_manifest);
  for binding in
    select value from jsonb_array_elements(page_row.candidate_manifest)
  loop
    if jsonb_typeof(binding) <> 'object'
      or binding - array[
        'candidateId', 'noteId', 'revision', 'isOpen'
      ] <> '{}'::jsonb
      or not binding ?& array[
        'candidateId', 'noteId', 'revision', 'isOpen'
      ]
      or jsonb_typeof(binding -> 'candidateId') <> 'string'
      or jsonb_typeof(binding -> 'noteId') <> 'string'
      or binding ->> 'candidateId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or binding ->> 'noteId' <> binding ->> 'candidateId'
      or jsonb_typeof(binding -> 'revision') <> 'number'
      or (binding ->> 'revision')::numeric <> trunc(
        (binding ->> 'revision')::numeric
      )
      or (binding ->> 'revision')::numeric not between 1 and 2147483647
      or jsonb_typeof(binding -> 'isOpen') <> 'boolean'
      or binding ->> 'candidateId' = any(candidate_ids)
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    candidate_ids := candidate_ids || (binding ->> 'candidateId');
  end loop;

  -- Explicit destinations are ordered first in the wire manifest, but locks
  -- always use immutable note/key order. Crossed destination pages therefore
  -- cannot acquire overlapping note locks in opposite orders.
  perform note.id
  from public.notes as note
  where note.user_id = job_row.user_id
    and note.id = any(candidate_ids)
  order by note.id
  for share of note;
  perform content_key.key_id
  from public.user_content_keys as content_key
  where content_key.user_id = job_row.user_id
    and exists (
      select 1
      from public.notes as note
      where note.user_id = job_row.user_id
        and note.id = any(candidate_ids)
        and note.content_key_id = content_key.key_id
        and note.content_key_class = content_key.key_class
        and note.content_key_purpose = content_key.key_purpose
        and note.content_key_version = content_key.key_version
    )
  order by
    content_key.key_id,
    content_key.key_class,
    content_key.key_purpose,
    content_key.key_version
  for share of content_key;

  for binding in
    select value from jsonb_array_elements(page_row.candidate_manifest)
  loop
    select note.* into note_row
    from public.notes as note
    join public.user_content_keys as content_key
      on content_key.user_id = note.user_id
      and content_key.key_id = note.content_key_id
      and content_key.key_class = note.content_key_class
      and content_key.key_purpose = note.content_key_purpose
      and content_key.key_version = note.content_key_version
      and content_key.state in ('active', 'retired')
    where note.user_id = job_row.user_id
      and note.id = binding ->> 'noteId'
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and note.archived_at is null
      and note.content_envelope is not null
      and note.content_key_class = 'ai_assisted'
      and note.content_key_purpose = 'object_wrap';
    candidate_found := found;
    if not candidate_found
      or note_row.current_revision <> (binding ->> 'revision')::integer
      or note_row.is_open <> (binding ->> 'isOpen')::boolean
    then
      conflict_note_id := binding ->> 'noteId';
      if not controls_conflicted then
        conflict_reason := case
          when candidate_found
            and note_row.current_revision
              <> (binding ->> 'revision')::integer
          then 'revision'
          else 'candidate_eligibility'
        end;
      end if;
      select note.current_revision into conflict_revision
      from public.notes as note
      where note.user_id = job_row.user_id
        and note.id = binding ->> 'noteId';
      exit;
    end if;
  end loop;

  if controls_conflicted or conflict_note_id is not null then
    if job_row.replan_count = 0 then
      update public.organization_jobs
      set replan_count = 1
      where id = job_row.id
        and state = 'running'
        and lease_token = job_row.lease_token
      returning * into job_row;
      conflict_outcome := 'replan';
    else
      conflict_outcome := 'review';
    end if;
    update public.organization_jobs
    set
      last_heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds)
    where id = job_row.id
      and state = 'running'
      and lease_token = job_row.lease_token
    returning * into job_row;
    if preparation_found and preparation.completed_at is null then
      perform private.burn_encrypted_organizer_reservations(
        preparation.job_id, preparation.lease_token
      );
      update public.encrypted_organizer_preparations
      set
        generation = job_row.replan_count,
        expected_revision = case
          when mode = 'append'
            and note_id = conflict_note_id
            and conflict_revision is not null
          then conflict_revision
          else expected_revision
        end,
        target_revision = case
          when mode = 'append'
            and note_id = conflict_note_id
            and conflict_revision is not null
          then conflict_revision + 1
          else target_revision
        end,
        write_reservation_id = null,
        decision_reservation_id = null,
        review_reservation_id = null,
        receipt_reservation_id = null,
        object_key_id = null,
        object_key_version = null,
        controls = null,
        prepare_replan_request_hash = null,
        prepare_replan_result = null,
        commit_replan_command_hash = null,
        commit_replan_result = null,
        updated_at = clock_timestamp()
      where job_id = preparation.job_id;
    end if;
    conflict_result_value := jsonb_build_object(
      'jobId', job_row.id,
      'outcome', conflict_outcome,
      'noteId', conflict_note_id,
      'revision', conflict_revision,
      'conflictReason', conflict_reason,
      'replanCount', job_row.replan_count,
      'replayed', false
    );
    update public.encrypted_organizer_candidate_pages
    set
      conflict_result = conflict_result_value,
      authorized_at = null,
      conflict_recorded_at = clock_timestamp()
    where job_id = job_row.id;
    return conflict_result_value;
  end if;

  if preparation_found and preparation.mode = 'append' then
    select current_revision into current_revision_value
    from public.notes
    where user_id = job_row.user_id
      and id = preparation.note_id
      and privacy = 'ai_assisted'
      and deleted_at is null;
    if current_revision_value is null then
      raise exception using errcode = '42501', message = 'target_not_disclosable';
    end if;
  end if;

  update public.organization_jobs
  set
    last_heartbeat_at = clock_timestamp(),
    lease_expires_at = clock_timestamp()
      + pg_catalog.make_interval(secs => p_lease_seconds)
  where id = job_row.id
    and lease_token = p_lease_token::uuid
    and state = 'running'
  returning * into job_row;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  update public.encrypted_organizer_candidate_pages
  set authorized_at = clock_timestamp()
  where job_id = job_row.id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
    and conflict_result is null;
  if not found then
    raise exception using errcode = '42501', message = 'candidate_page_required';
  end if;
  return jsonb_build_object(
    'jobId', job_row.id,
    'outcome', 'authorized',
    'leaseExpiresAt', job_row.lease_expires_at,
    'disclosureAuthorized', true,
    'currentRevision', current_revision_value,
    'candidateCount', candidate_count,
    'replanCount', job_row.replan_count
  );
end;
$$;

create or replace function private.list_encrypted_organizer_candidates_impl(
  p_job_id text,
  p_lease_token text,
  p_candidate_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  candidates_value jsonb := '[]'::jsonb;
  candidate_manifest_value jsonb := '[]'::jsonb;
  controls_value jsonb;
  explicit_destination_value text;
  returned_count integer := 0;
  returned_bytes integer := 0;
  byte_budget constant integer := 8388608;
begin
  if p_candidate_limit is null or p_candidate_limit not between 1 and 8 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select
    capture.explicit_destination_note_id,
    jsonb_build_object(
      'explicitDestinationNoteId', capture.explicit_destination_note_id,
      'expansionDisabled', capture.expansion_disabled
    )
  into explicit_destination_value, controls_value
  from public.captures as capture
  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;

  with eligible as (
    select
      note.id,
      note.current_revision,
      note.type,
      note.space_id,
      note.is_open,
      note.updated_at,
      note.content_envelope,
      pg_catalog.octet_length(note.content_envelope::text) as envelope_bytes,
      (
        pg_catalog.char_length(
          note.content_envelope -> 'payload' ->> 'ciphertext'
        ) * 3 / 4
      )::integer as payload_bytes,
      private.organizer_key_projection(content_key) as key_record
    from public.notes as note
    join public.user_content_keys as content_key
      on content_key.user_id = note.user_id
      and content_key.key_id = note.content_key_id
      and content_key.key_class = note.content_key_class
      and content_key.key_purpose = note.content_key_purpose
      and content_key.key_version = note.content_key_version
      and content_key.state in ('active', 'retired')
    where note.user_id = job_row.user_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and note.archived_at is null
      and note.content_envelope is not null
      and note.content_key_class = 'ai_assisted'
      and note.content_key_purpose = 'object_wrap'
      and (
        pg_catalog.char_length(
          note.content_envelope -> 'payload' ->> 'ciphertext'
        ) * 3 / 4
      )::integer between 16 and 1048592
    order by
      case when note.id = explicit_destination_value then 0 else 1 end,
      note.updated_at desc,
      note.id
    limit p_candidate_limit
  ), bounded as (
    select *, sum(envelope_bytes) over (
      order by
        case when id = explicit_destination_value then 0 else 1 end,
        updated_at desc,
        id rows unbounded preceding
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
        'updatedAt', bounded.updated_at,
        'isOpen', bounded.is_open
      ),
      'aggregate', jsonb_build_object(
        'resourceId', bounded.id,
        'recordVersion', bounded.current_revision,
        'envelope', bounded.content_envelope,
        'keyRecord', bounded.key_record,
        'encryptedByteLength', bounded.payload_bytes
      )
    ) order by
      case when bounded.id = explicit_destination_value then 0 else 1 end,
      bounded.updated_at desc,
      bounded.id), '[]'::jsonb),
    count(*)::integer,
    coalesce(sum(bounded.envelope_bytes), 0)::integer
  into candidates_value, returned_count, returned_bytes
  from bounded
  where bounded.running_bytes <= byte_budget;

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
    'controls', controls_value,
    'candidates', candidates_value,
    'returnedCount', returned_count,
    'encryptedBytes', returned_bytes,
    'encryptedByteBudget', byte_budget
  );
end;
$$;

create or replace function private.prepare_encrypted_organizer_write_impl(
  p_job_id text,
  p_lease_token text,
  p_mode text,
  p_note_id text,
  p_expected_revision bigint,
  p_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  page_row public.encrypted_organizer_candidate_pages%rowtype;
  note_row public.notes%rowtype;
  preparation public.encrypted_organizer_preparations%rowtype;
  object_key public.user_content_keys%rowtype;
  mac_key public.user_content_keys%rowtype;
  primary_reservation uuid;
  decision_reservation uuid;
  review_reservation uuid;
  receipt_reservation uuid;
  expected_value integer;
  target_value integer;
  replayed_value boolean := false;
  preparation_found boolean := false;
begin
  if p_mode not in ('create', 'append')
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_reservation_id is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    primary_reservation := p_reservation_id::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );

  -- Every prepare variant follows job -> source capture -> preparation/page ->
  -- target note -> content keys. The per-job advisory serializes the absent
  -- preparation-row case without inverting the row order used by commit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    job_row.id || ':encrypted-organizer-prepare', 0
  ));
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = job_row.id
  for update;
  preparation_found := found;

  select * into page_row
  from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id
    and user_id = job_row.user_id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
    and authorized_at is not null
    and conflict_result is null
  for share;
  if not found then
    raise exception using
      errcode = '42501', message = 'candidate_disclosure_not_authorized';
  end if;
  if p_mode = 'append' and (
    not exists (
      select 1
      from jsonb_array_elements(page_row.candidate_manifest) as item(value)
      where item.value ->> 'candidateId' = p_note_id
        and item.value ->> 'noteId' = p_note_id
        and (item.value ->> 'revision')::bigint = p_expected_revision
        and (item.value ->> 'isOpen')::boolean
    )
    or (
      page_row.controls ->> 'explicitDestinationNoteId' is not null
      and page_row.controls ->> 'explicitDestinationNoteId' <> p_note_id
    )
  ) then
    raise exception using errcode = '42501', message = 'candidate_not_authorized';
  end if;

  if p_mode = 'create' then
    if p_expected_revision is not null
      or exists (select 1 from public.notes where id = p_note_id)
    then
      raise exception using errcode = 'P0001', message = 'invalid_create_target';
    end if;
    expected_value := null;
    target_value := 1;
  else
    if p_expected_revision is null
      or p_expected_revision < 1
      or p_expected_revision > 2147483646
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    expected_value := p_expected_revision::integer;
    target_value := expected_value + 1;
    select * into note_row
    from public.notes
    where user_id = job_row.user_id
      and id = p_note_id
      and privacy = 'ai_assisted'
      and deleted_at is null
      and archived_at is null
      and is_open
      and content_envelope is not null
      and content_key_class = 'ai_assisted'
      and content_key_purpose = 'object_wrap'
    for share;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if note_row.current_revision <> expected_value then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;

  if preparation_found then
    if preparation.completed_at is not null
      or preparation.user_id <> job_row.user_id
      or preparation.capture_id <> job_row.capture_id
      or preparation.lease_token <> p_lease_token::uuid
      or preparation.attempt <> job_row.attempt
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if preparation.mode <> p_mode
      or preparation.note_id <> p_note_id
      or preparation.expected_revision is distinct from expected_value
      or preparation.target_revision <> target_value
      or preparation.generation <> job_row.replan_count
    then
      if preparation.write_reservation_id is not null
        or preparation.decision_reservation_id is not null
        or preparation.review_reservation_id is not null
        or preparation.receipt_reservation_id is not null
      then
        raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
      end if;
      update public.encrypted_organizer_preparations
      set
        generation = job_row.replan_count,
        mode = p_mode,
        note_id = p_note_id,
        expected_revision = expected_value,
        target_revision = target_value,
        prepare_replan_request_hash = null,
        prepare_replan_result = null,
        commit_replan_command_hash = null,
        commit_replan_result = null,
        updated_at = clock_timestamp()
      where job_id = preparation.job_id
      returning * into preparation;
    end if;
    if preparation.write_reservation_id is null then
      replayed_value := false;
    elsif preparation.write_reservation_id is distinct from primary_reservation then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    elsif preparation.controls is distinct from page_row.controls then
      raise exception using errcode = '42501', message = 'consent_controls_changed';
    else
      replayed_value := true;
    end if;
  else
    insert into public.encrypted_organizer_preparations (
      job_id, user_id, capture_id, attempt, generation, lease_token, mode, note_id,
      expected_revision, target_revision, decision_id, revision_id,
      mutation_id, review_item_id
    ) values (
      job_row.id, job_row.user_id, job_row.capture_id, job_row.attempt,
      job_row.replan_count, p_lease_token::uuid, p_mode, p_note_id,
      expected_value, target_value,
      public.new_entity_id('dec'), public.new_entity_id('rev'),
      public.new_entity_id('mut'), public.new_entity_id('rvw')
    )
    returning * into preparation;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    job_row.user_id::text || ':ai_assisted:object_wrap', 0
  ));
  select * into object_key
  from public.user_content_keys as content_key
  where content_key.user_id = job_row.user_id
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'object_wrap'
    and content_key.state = 'active'
  for update of content_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'active_ai_key_required';
  end if;

  select * into mac_key
  from public.user_content_keys as content_key
  where content_key.user_id = job_row.user_id
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'content_mac'
    and content_key.state = 'active'
  for share of content_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'active_ai_key_required';
  end if;

  if not replayed_value then
    if object_key.wrap_operations > object_key.wrap_operation_limit - 7 then
      raise exception using errcode = 'P0001', message = 'key_operation_limit';
    end if;
    if exists (
      select 1
      from public.content_key_operation_reservations
      where user_id = job_row.user_id
        and reservation_id = primary_reservation
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    decision_reservation := extensions.gen_random_uuid();
    review_reservation := extensions.gen_random_uuid();
    receipt_reservation := extensions.gen_random_uuid();
    update public.user_content_keys
    set wrap_operations = wrap_operations + 7
    where user_id = object_key.user_id
      and key_id = object_key.key_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and key_version = object_key.key_version
      and state = 'active'
      and wrap_operations <= wrap_operation_limit - 7
    returning * into object_key;
    if not found then
      raise exception using errcode = 'P0001', message = 'key_operation_limit';
    end if;

    insert into public.content_key_operation_reservations (
      user_id, reservation_id, key_id, key_class, key_purpose,
      key_version, operation_count
    ) values
      (
        job_row.user_id, primary_reservation, object_key.key_id,
        'ai_assisted', 'object_wrap', object_key.key_version, 4
      ),
      (
        job_row.user_id, decision_reservation, object_key.key_id,
        'ai_assisted', 'object_wrap', object_key.key_version, 1
      ),
      (
        job_row.user_id, review_reservation, object_key.key_id,
        'ai_assisted', 'object_wrap', object_key.key_version, 1
      ),
      (
        job_row.user_id, receipt_reservation, object_key.key_id,
        'ai_assisted', 'object_wrap', object_key.key_version, 1
      );

    update public.encrypted_organizer_preparations
    set
      write_reservation_id = primary_reservation,
      decision_reservation_id = decision_reservation,
      review_reservation_id = review_reservation,
      receipt_reservation_id = receipt_reservation,
      object_key_id = object_key.key_id,
      object_key_version = object_key.key_version,
      controls = page_row.controls,
      prepare_replan_request_hash = null,
      prepare_replan_result = null,
      commit_replan_command_hash = null,
      commit_replan_result = null,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id
    returning * into preparation;
  end if;

  if preparation.object_key_id <> object_key.key_id
    or preparation.object_key_version <> object_key.key_version
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  return private.encrypted_organizer_preparation_projection(
    preparation, object_key, mac_key, replayed_value
  );
end;
$$;

create or replace function private.prepare_encrypted_organizer_create_impl(
  p_job_id text,
  p_lease_token text,
  p_stable_note_id text,
  p_reservation_id text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.prepare_encrypted_organizer_write_impl(
    p_job_id, p_lease_token, 'create', p_stable_note_id, null,
    p_reservation_id
  );
$$;

create or replace function private.prepare_encrypted_organizer_append_impl(
  p_job_id text,
  p_lease_token text,
  p_note_id text,
  p_expected_revision bigint,
  p_reservation_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  page_row public.encrypted_organizer_candidate_pages%rowtype;
  note_row public.notes%rowtype;
  preparation public.encrypted_organizer_preparations%rowtype;
  prepared_value jsonb;
  result_value jsonb;
  request_hash_value text;
  stable_review_note_id text;
  conflict_reason_value text;
  eligible_target boolean;
  current_revision_value integer;
  preparation_found boolean := false;
begin
  if p_expected_revision is null
    or p_expected_revision not between 1 and 2147483646
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_reservation_id is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    perform p_reservation_id::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = job_row.id
  for update;
  preparation_found := found;

  select * into page_row
  from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id
    and user_id = job_row.user_id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
    and authorized_at is not null
    and conflict_result is null
  for share;
  if not found
    or not exists (
      select 1
      from jsonb_array_elements(page_row.candidate_manifest) as item(value)
      where item.value ->> 'candidateId' = p_note_id
        and item.value ->> 'noteId' = p_note_id
        and (item.value ->> 'revision')::bigint = p_expected_revision
        and (item.value ->> 'isOpen')::boolean
    )
    or (
      page_row.controls ->> 'explicitDestinationNoteId' is not null
      and page_row.controls ->> 'explicitDestinationNoteId' <> p_note_id
    )
  then
    raise exception using errcode = '42501', message = 'candidate_not_authorized';
  end if;
  request_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-organizer-prepare-append.v1',
    'jobId', job_row.id,
    'attempt', job_row.attempt,
    'noteId', p_note_id,
    'expectedRevision', p_expected_revision,
    'reservationId', p_reservation_id
  ));

  -- Job, source capture, preparation, and candidate page are already locked;
  -- the target note follows them in the shared publication order.
  select note.* into note_row
  from public.notes as note
  where note.user_id = job_row.user_id
    and note.id = p_note_id
    and note.privacy = 'ai_assisted'
    and note.deleted_at is null
    and note.archived_at is null
    and note.is_open
    and note.content_envelope is not null
    and note.content_key_class = 'ai_assisted'
    and note.content_key_purpose = 'object_wrap'
  for share of note;
  eligible_target := found;
  current_revision_value := case when eligible_target
    then note_row.current_revision else null end;
  conflict_reason_value := case
    when eligible_target then 'revision'
    else 'candidate_eligibility'
  end;

  if preparation_found then
    if preparation.completed_at is not null
      or preparation.user_id <> job_row.user_id
      or preparation.capture_id <> job_row.capture_id
      or preparation.attempt <> job_row.attempt
      or preparation.lease_token <> job_row.lease_token
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if preparation.prepare_replan_request_hash = request_hash_value
      and preparation.prepare_replan_result is not null
    then
      if preparation.prepare_replan_result ->> 'outcome' = 'replan' then
        return jsonb_set(
          preparation.prepare_replan_result,
          '{replayed}', 'true'::jsonb, true
        );
      end if;
      return jsonb_set(
        preparation.prepare_replan_result,
        '{preparation,replayed}', 'true'::jsonb, true
      );
    end if;
  end if;

  if eligible_target and current_revision_value = p_expected_revision then
    prepared_value := private.prepare_encrypted_organizer_write_impl(
      p_job_id, p_lease_token, 'append', p_note_id, p_expected_revision,
      p_reservation_id
    );
    return jsonb_build_object(
      'outcome', 'prepared',
      'preparation', prepared_value
    );
  end if;

  if preparation.job_id is not null then
    perform private.burn_encrypted_organizer_reservations(
      preparation.job_id, preparation.lease_token
    );
    update public.encrypted_organizer_preparations
    set
      write_reservation_id = null,
      decision_reservation_id = null,
      review_reservation_id = null,
      receipt_reservation_id = null,
      object_key_id = null,
      object_key_version = null,
      controls = null,
      commit_replan_command_hash = null,
      commit_replan_result = null,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id;
  end if;

  if job_row.replan_count = 0 then
    update public.organization_jobs
    set replan_count = 1
    where id = job_row.id
      and state = 'running'
      and lease_token = job_row.lease_token
    returning * into job_row;
    if preparation.job_id is null then
      insert into public.encrypted_organizer_preparations (
        job_id, user_id, capture_id, attempt, generation, lease_token,
        mode, note_id, expected_revision, target_revision, decision_id,
        revision_id, mutation_id, review_item_id
      ) values (
        job_row.id, job_row.user_id, job_row.capture_id, job_row.attempt,
        1, job_row.lease_token, 'append', p_note_id,
        coalesce(current_revision_value, p_expected_revision::integer),
        coalesce(current_revision_value, p_expected_revision::integer) + 1,
        public.new_entity_id('dec'), public.new_entity_id('rev'),
        public.new_entity_id('mut'), public.new_entity_id('rvw')
      ) returning * into preparation;
    else
      update public.encrypted_organizer_preparations
      set
        generation = 1,
        mode = 'append',
        note_id = p_note_id,
        expected_revision = coalesce(
          current_revision_value, p_expected_revision::integer
        ),
        target_revision = coalesce(
          current_revision_value, p_expected_revision::integer
        ) + 1,
        prepare_replan_request_hash = null,
        prepare_replan_result = null,
        updated_at = clock_timestamp()
      where job_id = preparation.job_id
      returning * into preparation;
    end if;
    result_value := jsonb_build_object(
      'outcome', 'replan',
      'jobId', job_row.id,
      'noteId', p_note_id,
      'revision', current_revision_value,
      'conflictReason', conflict_reason_value,
      'replanCount', 1,
      'replayed', false
    );
    update public.encrypted_organizer_preparations
    set
      prepare_replan_request_hash = request_hash_value,
      prepare_replan_result = result_value,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id;
    return result_value;
  end if;

  stable_review_note_id := 'note_' || substring(job_row.id from 5);
  prepared_value := private.prepare_encrypted_organizer_write_impl(
    p_job_id, p_lease_token, 'create', stable_review_note_id,
    null, p_reservation_id
  );
  result_value := jsonb_build_object(
    'outcome', 'review',
    'conflictReason', conflict_reason_value,
    'preparation', prepared_value
  );
  update public.encrypted_organizer_preparations
  set
    prepare_replan_request_hash = request_hash_value,
    prepare_replan_result = result_value,
    updated_at = clock_timestamp()
  where job_id = job_row.id;
  return result_value;
end;
$$;

create or replace function private.consume_encrypted_organizer_reservation(
  p_preparation public.encrypted_organizer_preparations,
  p_cipher jsonb,
  p_expected_reservation uuid,
  p_consumer_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.content_key_operation_reservations%rowtype;
begin
  if p_expected_reservation is null
    or p_consumer_id is null
    or char_length(p_consumer_id) not between 1 and 200
    or not private.valid_encrypted_write_cipher(
      p_cipher,
      p_preparation.user_id,
      p_consumer_id,
      1,
      case
        when p_consumer_id = p_preparation.decision_id
          then 'organization_decision'
        when p_consumer_id = p_preparation.review_item_id
          then 'review_item'
        when p_consumer_id = p_preparation.capture_id
          then 'capture_receipt'
      end,
      'ai_assisted'
    )
    or (p_cipher ->> 'reservationId')::uuid <> p_expected_reservation
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  select * into reservation
  from public.content_key_operation_reservations
  where user_id = p_preparation.user_id
    and reservation_id = p_expected_reservation
  for update;
  if not found
    or reservation.operation_count <> 1
    or reservation.key_id <> p_preparation.object_key_id
    or reservation.key_class <> 'ai_assisted'
    or reservation.key_purpose <> 'object_wrap'
    or reservation.key_version <> p_preparation.object_key_version
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
  end if;
  if reservation.consumed_at is not null then
    if reservation.consumed_by_type = 'encrypted_organizer'
      and reservation.consumed_by_id = p_consumer_id
    then return;
    end if;
    raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
  end if;
  if not exists (
    select 1 from public.user_content_keys
    where user_id = reservation.user_id
      and key_id = reservation.key_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and key_version = reservation.key_version
      and state = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  update public.content_key_operation_reservations
  set
    consumed_by_type = 'encrypted_organizer',
    consumed_by_id = p_consumer_id,
    consumed_at = clock_timestamp()
  where user_id = p_preparation.user_id
    and reservation_id = p_expected_reservation;
end;
$$;

create or replace function private.burn_encrypted_organizer_reservations(
  p_job_id text,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  preparation public.encrypted_organizer_preparations%rowtype;
  reservation_id_value uuid;
begin
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = p_job_id and completed_at is null
  for update;
  if not found then return; end if;
  if preparation.lease_token <> p_lease_token then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  for reservation_id_value in
    select value from unnest(array[
      preparation.write_reservation_id,
      preparation.decision_reservation_id,
      preparation.review_reservation_id,
      preparation.receipt_reservation_id
    ]) as reservation(value)
    where value is not null
  loop
    update public.content_key_operation_reservations
    set
      consumed_by_type = 'encrypted_organizer',
      consumed_by_id = preparation.job_id,
      consumed_at = clock_timestamp()
    where user_id = preparation.user_id
      and reservation_id = reservation_id_value
      and consumed_at is null;
  end loop;
end;
$$;

create or replace function private.encrypted_organizer_reason_codes(
  p_value jsonb
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  result text[];
begin
  if p_value is null
    or jsonb_typeof(p_value) <> 'array'
    or jsonb_array_length(p_value) > 20
    or exists (
      select 1
      from jsonb_array_elements(p_value) as item(value)
      where jsonb_typeof(item.value) <> 'string'
        or item.value #>> '{}' !~ '^[a-z][a-z0-9_]{0,63}$'
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select coalesce(array_agg(value), array[]::text[]) into result
  from jsonb_array_elements_text(p_value) as item(value);
  return result;
end;
$$;

create or replace function private.insert_encrypted_organizer_decision(
  p_preparation public.encrypted_organizer_preparations,
  p_decision jsonb,
  p_destination_note_id text,
  p_force_review boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cipher jsonb;
  verification_mac jsonb;
  band_value public.behavior_band;
  reason_values text[];
begin
  if p_decision is null
    or jsonb_typeof(p_decision) <> 'object'
    or p_decision - array['cipher', 'verificationMac', 'band', 'reasonCodes']
      <> '{}'::jsonb
    or not p_decision ?& array[
      'cipher', 'verificationMac', 'band', 'reasonCodes'
    ]
    or jsonb_typeof(p_decision -> 'band') <> 'string'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    band_value := (p_decision ->> 'band')::public.behavior_band;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if p_force_review and band_value <> 'review' then
    raise exception using errcode = '22023', message = 'invalid_plan';
  end if;
  reason_values := private.encrypted_organizer_reason_codes(
    p_decision -> 'reasonCodes'
  );
  cipher := p_decision -> 'cipher';
  verification_mac := p_decision -> 'verificationMac';
  if not private.valid_encrypted_write_mac(
      verification_mac, p_preparation.user_id, 'ai_assisted', false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_encrypted_organizer_reservation(
    p_preparation, cipher, p_preparation.decision_reservation_id,
    p_preparation.decision_id
  );

  insert into public.organization_decisions (
    id, capture_id, user_id, candidate_manifest, signals, validated_plan,
    band, score, margin, destination_note_id, reason_codes,
    decision_envelope, decision_key_id, decision_key_class,
    decision_key_purpose, decision_key_version
  ) values (
    p_preparation.decision_id, p_preparation.capture_id,
    p_preparation.user_id, '{}'::jsonb, '{}'::jsonb, null,
    band_value, null, null, p_destination_note_id, reason_values,
    cipher -> 'envelope', cipher ->> 'keyId',
    (cipher ->> 'keyClass')::public.content_key_class,
    (cipher ->> 'keyPurpose')::public.content_key_purpose,
    (cipher ->> 'keyVersion')::integer
  );
  perform private.record_content_encryption_verification(
    p_preparation.user_id, 'organization_decision',
    p_preparation.decision_id, 1, cipher -> 'envelope', verification_mac
  );
end;
$$;

create or replace function private.insert_encrypted_organizer_review(
  p_preparation public.encrypted_organizer_preparations,
  p_review jsonb,
  p_note_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cipher jsonb;
  verification_mac jsonb;
  review_type_value public.review_type;
begin
  if p_review is null
    or jsonb_typeof(p_review) <> 'object'
    or p_review - array['cipher', 'verificationMac', 'type'] <> '{}'::jsonb
    or not p_review ?& array['cipher', 'verificationMac', 'type']
    or jsonb_typeof(p_review -> 'type') <> 'string'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    review_type_value := (p_review ->> 'type')::public.review_type;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  cipher := p_review -> 'cipher';
  verification_mac := p_review -> 'verificationMac';
  if not private.valid_encrypted_write_mac(
      verification_mac, p_preparation.user_id, 'ai_assisted', false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_encrypted_organizer_reservation(
    p_preparation, cipher, p_preparation.review_reservation_id,
    p_preparation.review_item_id
  );
  insert into public.review_items (
    id, user_id, capture_id, note_id, type, choices, state, resolution,
    review_envelope, review_key_id, review_key_class,
    review_key_purpose, review_key_version
  ) values (
    p_preparation.review_item_id, p_preparation.user_id,
    p_preparation.capture_id, p_note_id, review_type_value,
    '[]'::jsonb, 'open', null,
    cipher -> 'envelope', cipher ->> 'keyId',
    (cipher ->> 'keyClass')::public.content_key_class,
    (cipher ->> 'keyPurpose')::public.content_key_purpose,
    (cipher ->> 'keyVersion')::integer
  );
  perform private.record_content_encryption_verification(
    p_preparation.user_id, 'review_item', p_preparation.review_item_id,
    1, cipher -> 'envelope', verification_mac
  );
end;
$$;

create or replace function private.insert_encrypted_organizer_receipt(
  p_preparation public.encrypted_organizer_preparations,
  p_receipt jsonb,
  p_outcome text,
  p_note_id text,
  p_review boolean,
  p_review_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cipher jsonb;
  verification_mac jsonb;
begin
  if p_receipt is null
    or jsonb_typeof(p_receipt) <> 'object'
    or p_receipt - array['cipher', 'verificationMac'] <> '{}'::jsonb
    or not p_receipt ?& array['cipher', 'verificationMac']
    or (
      p_review and p_review_reason not in (
        'planner_ambiguity', 'revision_conflict',
        'explicit_destination_unavailable', 'expansion_pending'
      )
    )
    or (not p_review and p_review_reason is not null)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  cipher := p_receipt -> 'cipher';
  verification_mac := p_receipt -> 'verificationMac';
  if not private.valid_encrypted_write_mac(
      verification_mac, p_preparation.user_id, 'ai_assisted', false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_encrypted_organizer_reservation(
    p_preparation, cipher, p_preparation.receipt_reservation_id,
    p_preparation.capture_id
  );

  insert into public.capture_receipts (
    capture_id, job_id, user_id, decision_id, review_item_id, mutation_id,
    outcome, headline, destination_note_id, inserted_content, actions,
    reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,
    receipt_key_purpose, receipt_key_version
  ) values (
    p_preparation.capture_id, p_preparation.job_id, p_preparation.user_id,
    p_preparation.decision_id,
    case when p_review then p_preparation.review_item_id else null end,
    case when p_review then null else p_preparation.mutation_id end,
    case
      when p_review then 'needs_review'
      when p_outcome = 'created' then 'created_note'
      else 'added_to_note'
    end,
    case
      when p_review then 'Needs your review'
      when p_outcome = 'created' then 'Created a note'
      else 'Added to a note'
    end,
    case when p_review then null else p_note_id end,
    case when p_review then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('mutationId', p_preparation.mutation_id)
    ) end,
    '[]'::jsonb,
    case
      when p_review and p_review_reason = 'planner_ambiguity'
        then array['ambiguous_intent']::text[]
      when p_review and p_review_reason = 'revision_conflict'
        then array['revision_conflict']::text[]
      when p_review and p_review_reason = 'explicit_destination_unavailable'
        then array['explicit_destination']::text[]
      when p_review and p_review_reason = 'expansion_pending'
        then array['parser_override']::text[]
      else array['encrypted_organizer']::text[]
    end,
    cipher -> 'envelope', cipher ->> 'keyId',
    (cipher ->> 'keyClass')::public.content_key_class,
    (cipher ->> 'keyPurpose')::public.content_key_purpose,
    (cipher ->> 'keyVersion')::integer
  );
  perform private.record_content_encryption_verification(
    p_preparation.user_id, 'capture_receipt', p_preparation.capture_id,
    1, cipher -> 'envelope', verification_mac
  );
end;
$$;

create or replace function private.commit_encrypted_organizer_job_impl(
  p_job_id text,
  p_lease_token text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  preparation public.encrypted_organizer_preparations%rowtype;
  page_row public.encrypted_organizer_candidate_pages%rowtype;
  note_row public.notes%rowtype;
  outcome_value text;
  effective_outcome text;
  command_hash_value text;
  lease_value uuid;
  note_write jsonb;
  request_mac jsonb;
  note_result jsonb;
  result_value jsonb;
  disclosure_result jsonb;
  disclosure_manifest jsonb;
  idempotency_key_value text;
  previous_auth_role text;
  occurred_value timestamptz;
  force_review boolean := false;
  target_eligible boolean := false;
  conflict_outcome_value text;
  review_reason_value text;
  expected_review_type text;
  review_note_id text;
  final_revision integer;
begin
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or p_command - array[
      'outcome', 'noteWrite', 'decision', 'review', 'receipt', 'reviewReason'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'outcome', 'noteWrite', 'decision', 'review', 'receipt', 'reviewReason'
    ]
    or jsonb_typeof(p_command -> 'outcome') <> 'string'
    or p_command ->> 'outcome' not in ('created', 'appended', 'review')
    or jsonb_typeof(p_command -> 'reviewReason') not in ('null', 'string')
    or (
      p_command ->> 'outcome' = 'review'
      and p_command ->> 'reviewReason' not in (
        'planner_ambiguity', 'revision_conflict',
        'explicit_destination_unavailable', 'expansion_pending'
      )
    )
    or (
      p_command ->> 'outcome' <> 'review'
      and jsonb_typeof(p_command -> 'reviewReason') <> 'null'
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    lease_value := p_lease_token::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  outcome_value := p_command ->> 'outcome';
  review_reason_value := p_command ->> 'reviewReason';
  command_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-organizer-commit.v1',
    'jobId', p_job_id,
    'command', p_command
  ));

  job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  if job_row.last_transition_lease_token = lease_value
    and job_row.last_transition_action = 'completed'
  then
    select * into preparation
    from public.encrypted_organizer_preparations
    where job_id = p_job_id
    for update;
    if not found or preparation.completed_at is null then
      raise exception using errcode = 'P0001', message = 'write_not_prepared';
    end if;
    if preparation.command_hash <> command_hash_value then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_set(preparation.result, '{replayed}', 'true'::jsonb, true);
  end if;

  -- Active publication lock order is job -> source capture -> preparation ->
  -- target notes. Terminal replay above publishes nothing and needs no source
  -- lock.
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = p_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;
  if preparation.commit_replan_command_hash = command_hash_value
    and preparation.commit_replan_result is not null
  then
    return jsonb_set(
      preparation.commit_replan_result, '{replayed}', 'true'::jsonb, true
    );
  end if;
  if preparation.completed_at is not null
    or preparation.user_id <> job_row.user_id
    or preparation.capture_id <> job_row.capture_id
    or preparation.attempt <> job_row.attempt
    or preparation.lease_token <> lease_value
    or preparation.write_reservation_id is null
  then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  select * into page_row
  from public.encrypted_organizer_candidate_pages
  where job_id = job_row.id
    and user_id = job_row.user_id
    and attempt = job_row.attempt
    and lease_token = job_row.lease_token
    and authorized_at is not null
    and conflict_result is null
  for update;
  if not found then
    raise exception using
      errcode = '42501', message = 'candidate_disclosure_not_authorized';
  end if;
  disclosure_manifest := jsonb_build_object(
    'controls', page_row.controls,
    'candidates', page_row.candidate_manifest
  );
  disclosure_result := private.heartbeat_encrypted_organizer_job_impl(
    job_row.id, job_row.lease_token::text, 60, disclosure_manifest
  );
  if disclosure_result ->> 'outcome' <> 'authorized' then
    result_value := disclosure_result || jsonb_build_object(
      'outcome', case when disclosure_result ->> 'outcome' = 'review'
        then 'review_required' else 'replan' end,
      'replayed', false
    );
    update public.encrypted_organizer_preparations
    set
      commit_replan_command_hash = command_hash_value,
      commit_replan_result = result_value,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id;
    return result_value;
  end if;

  if preparation.controls is distinct from page_row.controls then
    if job_row.replan_count = 0 then
      update public.organization_jobs
      set replan_count = 1
      where id = job_row.id
      returning * into job_row;
    end if;
    perform private.burn_encrypted_organizer_reservations(
      preparation.job_id, preparation.lease_token
    );
    result_value := jsonb_build_object(
      'jobId', job_row.id,
      'outcome', case when job_row.replan_count = 1
        and preparation.generation = 1 then 'review_required'
        else 'replan' end,
      'noteId', null,
      'revision', null,
      'conflictReason', 'consent_controls',
      'replanCount', job_row.replan_count,
      'replayed', false
    );
    update public.encrypted_organizer_preparations
    set
      generation = job_row.replan_count,
      write_reservation_id = null,
      decision_reservation_id = null,
      review_reservation_id = null,
      receipt_reservation_id = null,
      object_key_id = null,
      object_key_version = null,
      controls = null,
      commit_replan_command_hash = command_hash_value,
      commit_replan_result = result_value,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id;
    return result_value;
  end if;

  effective_outcome := outcome_value;
  if preparation.mode = 'create' then
    if outcome_value not in ('created', 'review')
      or (
        outcome_value = 'created'
        and exists (select 1 from public.notes where id = preparation.note_id)
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
  else
    select * into note_row
    from public.notes as note
    where note.user_id = preparation.user_id
      and note.id = preparation.note_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and note.archived_at is null
      and note.is_open
      and note.content_envelope is not null
      and note.content_key_class = 'ai_assisted'
      and note.content_key_purpose = 'object_wrap'
    for update of note;
    target_eligible := found;
    if (
      not target_eligible
      or note_row.current_revision <> preparation.expected_revision
    ) and outcome_value <> 'review' then
      conflict_outcome_value := case
        when job_row.replan_count = 0 then 'replan'
        else 'review_required'
      end;
      if job_row.replan_count = 0 then
        update public.organization_jobs
        set replan_count = 1
        where id = job_row.id
        returning * into job_row;
      end if;
      perform private.burn_encrypted_organizer_reservations(
        preparation.job_id, preparation.lease_token
      );
      result_value := jsonb_build_object(
        'jobId', job_row.id,
        'outcome', conflict_outcome_value,
        'noteId', preparation.note_id,
        'revision', case when target_eligible
          then note_row.current_revision else null end,
        'conflictReason', case when target_eligible
          then 'revision' else 'candidate_eligibility' end,
        'replanCount', job_row.replan_count,
        'replayed', false
      );
      update public.encrypted_organizer_preparations
      set
        generation = job_row.replan_count,
        expected_revision = case when target_eligible
          then note_row.current_revision else expected_revision end,
        target_revision = case when target_eligible
          then note_row.current_revision + 1 else target_revision end,
        write_reservation_id = null,
        decision_reservation_id = null,
        review_reservation_id = null,
        receipt_reservation_id = null,
        object_key_id = null,
        object_key_version = null,
        controls = null,
        commit_replan_command_hash = command_hash_value,
        commit_replan_result = result_value,
        updated_at = clock_timestamp()
      where job_id = preparation.job_id
      returning * into preparation;
      return result_value;
    elsif outcome_value not in ('appended', 'review') then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
  end if;
  force_review := effective_outcome = 'review';
  if not force_review
    and preparation.controls ->> 'explicitDestinationNoteId' is not null
    and (
      preparation.mode <> 'append'
      or preparation.note_id
        <> preparation.controls ->> 'explicitDestinationNoteId'
    )
  then
    raise exception using errcode = '42501', message = 'explicit_destination_required';
  end if;

  if force_review then
    expected_review_type := case review_reason_value
      when 'planner_ambiguity' then 'low_confidence'
      when 'revision_conflict' then 'revision_conflict'
      when 'explicit_destination_unavailable' then 'structure_conflict'
      when 'expansion_pending' then 'pending_expansion'
    end;
    if jsonb_typeof(p_command -> 'noteWrite') <> 'null'
      or p_command #>> '{review,type}' <> expected_review_type
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    review_note_id := case
      when preparation.mode = 'append' and target_eligible
        then preparation.note_id
      else null
    end;
    perform private.insert_encrypted_organizer_decision(
      preparation, p_command -> 'decision', null, true
    );
    perform private.insert_encrypted_organizer_review(
      preparation, p_command -> 'review', review_note_id
    );
    perform private.insert_encrypted_organizer_receipt(
      preparation, p_command -> 'receipt', 'review', null, true,
      review_reason_value
    );
    perform private.burn_encrypted_organizer_reservations(
      preparation.job_id, preparation.lease_token
    );
    final_revision := null;
  else
    note_write := p_command -> 'noteWrite';
    if note_write is null
      or jsonb_typeof(note_write) <> 'object'
      or jsonb_typeof(note_write -> 'requestMac') <> 'object'
      or (note_write #>> '{noteCipher,reservationId}')
        <> preparation.write_reservation_id::text
      or (note_write #>> '{revision,cipher,reservationId}')
        <> preparation.write_reservation_id::text
      or (note_write #>> '{mutation,cipher,reservationId}')
        <> preparation.write_reservation_id::text
      or (note_write #>> '{responseCipher,reservationId}')
        <> preparation.write_reservation_id::text
      or (note_write #>> '{noteCipher,keyId}') <> preparation.object_key_id
      or (note_write #>> '{noteCipher,keyVersion}')
        <> preparation.object_key_version::text
    then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    request_mac := note_write -> 'requestMac';
    if not private.valid_encrypted_write_mac(
      request_mac, preparation.user_id, 'ai_assisted', false
    ) then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    if jsonb_typeof(note_write -> 'occurredAt') <> 'string'
      or not private.valid_iso_offset_datetime(note_write ->> 'occurredAt')
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    occurred_value := (note_write ->> 'occurredAt')::timestamptz;
    idempotency_key_value := 'organizer:' || preparation.job_id;

    insert into public.encrypted_note_write_claims (
      user_id, idempotency_key, scope, note_id, expected_revision,
      source_privacy, target_privacy, history_key_class, revision_id,
      mutation_id, occurred_at, request_mac_key_id, request_mac_key_class,
      request_mac_key_purpose, request_mac_key_version, request_mac
    ) values (
      preparation.user_id, idempotency_key_value,
      case when preparation.mode = 'create' then 'create_encrypted_note'
        else 'apply_encrypted_note_mutation' end,
      preparation.note_id, coalesce(preparation.expected_revision, 0),
      case when preparation.mode = 'append' then 'ai_assisted'::public.privacy_mode
        else null end,
      'ai_assisted', 'ai_assisted', preparation.revision_id,
      preparation.mutation_id, occurred_value,
      request_mac ->> 'keyId',
      (request_mac ->> 'keyClass')::public.content_key_class,
      (request_mac ->> 'keyPurpose')::public.content_key_purpose,
      (request_mac ->> 'keyVersion')::integer,
      request_mac ->> 'mac'
    );

    if preparation.mode = 'append' then
      perform private.insert_encrypted_organizer_decision(
        preparation, p_command -> 'decision', preparation.note_id, false
      );
    end if;

    previous_auth_role := current_setting('request.jwt.claim.role', true);
    perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
    begin
      if preparation.mode = 'create' then
        note_result := public.create_encrypted_note(
          preparation.user_id, preparation.note_id,
          idempotency_key_value, note_write
        );
      else
        note_result := public.apply_encrypted_note_mutation(
          preparation.user_id, preparation.note_id,
          preparation.expected_revision, idempotency_key_value, note_write
        );
      end if;
    exception when others then
      perform pg_catalog.set_config(
        'request.jwt.claim.role', coalesce(previous_auth_role, ''), true
      );
      raise;
    end;
    perform pg_catalog.set_config(
      'request.jwt.claim.role', coalesce(previous_auth_role, ''), true
    );

    final_revision := (note_result ->> 'currentRevision')::integer;
    if preparation.mode = 'create' then
      perform private.insert_encrypted_organizer_decision(
        preparation, p_command -> 'decision', preparation.note_id, false
      );
      update public.note_mutations
      set decision_id = preparation.decision_id
      where user_id = preparation.user_id
        and id = preparation.mutation_id
        and note_id = preparation.note_id;
      if not found then
        raise exception using errcode = 'P0001', message = 'invalid_plan';
      end if;
    end if;

    insert into public.capture_note_links (
      capture_id, note_id, user_id, mutation_id, relation, inserted_item_ids
    ) values (
      preparation.capture_id, preparation.note_id, preparation.user_id,
      preparation.mutation_id, 'routed', array[]::text[]
    );
    perform private.insert_encrypted_organizer_receipt(
      preparation, p_command -> 'receipt', effective_outcome,
      preparation.note_id, false, null
    );
    perform private.burn_encrypted_organizer_reservations(
      preparation.job_id, preparation.lease_token
    );
  end if;

  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count
      + case when force_review then 3 else 2 end,
    verified_object_count = verified_object_count
      + case when force_review then 3 else 2 end
  where user_id = preparation.user_id;

  update public.captures
  set
    status = case when force_review then 'needs_review'::public.capture_status
      else 'organized'::public.capture_status end,
    last_error_code = null
  where id = preparation.capture_id and user_id = preparation.user_id;

  update public.organization_jobs
  set
    state = 'succeeded',
    completed_at = clock_timestamp(),
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    error_code = null,
    last_transition_lease_token = lease_value,
    last_transition_action = 'completed',
    last_transition_request_hash = command_hash_value
  where id = preparation.job_id
    and state = 'running'
    and lease_token = lease_value;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  result_value := jsonb_build_object(
    'jobId', preparation.job_id,
    'outcome', case when force_review then 'review' else effective_outcome end,
    'noteId', case when force_review then null else preparation.note_id end,
    'revision', case when force_review then null else final_revision end,
    'replanCount', job_row.replan_count,
    'replayed', false
  );
  update public.encrypted_organizer_preparations
  set
    command_hash = command_hash_value,
    result = result_value,
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where job_id = preparation.job_id and completed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  perform private.emit_user_event(preparation.user_id, 'organization_job', preparation.job_id);
  perform private.emit_user_event(preparation.user_id, 'capture', preparation.capture_id);
  if not force_review then
    perform private.emit_user_event(preparation.user_id, 'note', preparation.note_id);
  end if;
  return result_value;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.fail_encrypted_organizer_job_impl(
  p_job_id text,
  p_lease_token text,
  p_error_code text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  error_value public.safe_error_code;
  lease_value uuid;
  request_hash_value text;
  next_state public.job_state;
  retry_at timestamptz;
begin
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_error_code is null
    or p_retryable is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    lease_value := p_lease_token::uuid;
    error_value := p_error_code::public.safe_error_code;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  request_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-organizer-fail.v1',
    'errorCode', error_value,
    'retryable', p_retryable
  ));

  job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  if job_row.last_transition_lease_token = lease_value
    and job_row.last_transition_action = 'failed'
  then
    if job_row.last_transition_request_hash <> request_hash_value then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'jobId', job_row.id,
      'state', job_row.state,
      'replayed', true
    );
  end if;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  perform private.burn_encrypted_organizer_reservations(
    job_row.id, lease_value
  );

  next_state := case
    when p_retryable and job_row.attempt < 5 then 'awaiting_retry'::public.job_state
    when p_retryable then 'dead_letter'::public.job_state
    else 'failed'::public.job_state
  end;
  retry_at := case when next_state = 'awaiting_retry' then
    clock_timestamp() + pg_catalog.make_interval(
      secs => least(300, (2 ^ greatest(job_row.attempt - 1, 0))::integer)
    ) else job_row.available_at end;

  update public.organization_jobs
  set
    state = next_state,
    available_at = retry_at,
    completed_at = case when next_state = 'awaiting_retry' then null
      else clock_timestamp() end,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    error_code = error_value,
    last_transition_lease_token = lease_value,
    last_transition_action = 'failed',
    last_transition_request_hash = request_hash_value
  where id = job_row.id
    and state = 'running'
    and lease_token = lease_value
  returning * into job_row;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

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
  update public.captures
  set
    status = case when next_state = 'awaiting_retry'
      then 'queued'::public.capture_status else 'failed'::public.capture_status end,
    last_error_code = error_value
  where id = job_row.capture_id and user_id = job_row.user_id;
  perform private.emit_user_event(job_row.user_id, 'organization_job', job_row.id);
  perform private.emit_user_event(job_row.user_id, 'capture', job_row.capture_id);
  return jsonb_build_object(
    'jobId', job_row.id,
    'state', job_row.state,
    'replayed', false
  );
end;
$$;

create or replace function private.recover_stale_encrypted_organizer_jobs_impl(
  p_recovery_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stale record;
  stale_ids text[];
  stale_owner_ids uuid[];
  stale_capture_ids text[];
  stale_created_ats timestamptz[];
  stale_lease_tokens uuid[];
  stale_lease_expires_ats timestamptz[];
  owner_id_value uuid;
  job_row public.organization_jobs%rowtype;
  next_state public.job_state;
  recovered_count integer := 0;
  requeued_count integer := 0;
  dead_lettered_count integer := 0;
begin
  if p_recovery_limit is null or p_recovery_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  -- Like claim, recovery may span owners. Freeze a bounded target set without
  -- row locks, acquire its distinct owner rollout advisories in UUID order,
  -- and only then begin the established job -> capture publication order.
  select
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.id order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.user_id
        order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.capture_id
        order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.created_at
        order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::timestamptz[]
    ),
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.lease_token
        order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.array_agg(
        frozen_stale.lease_expires_at
        order by frozen_stale.lease_expires_at, frozen_stale.id
      ),
      array[]::timestamptz[]
    )
  into
    stale_ids, stale_owner_ids, stale_capture_ids, stale_created_ats,
    stale_lease_tokens,
    stale_lease_expires_ats
  from (
    select
      job.id, job.user_id, job.capture_id, job.created_at,
      job.lease_token, job.lease_expires_at
    from public.organization_jobs as job
    where job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
    order by job.lease_expires_at, job.id
    limit p_recovery_limit
  ) as frozen_stale;

  for owner_id_value in
    select distinct locked_owner.user_id
    from pg_catalog.unnest(stale_owner_ids) as locked_owner(user_id)
    order by locked_owner.user_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      owner_id_value::text || ':content-encryption-rollout', 0
    ));
  end loop;

  for stale in
    select
      job.id, job.user_id, job.capture_id, job.created_at,
      job.lease_token, job.lease_expires_at
    from rows from (
      pg_catalog.unnest(stale_ids),
      pg_catalog.unnest(stale_owner_ids),
      pg_catalog.unnest(stale_capture_ids),
      pg_catalog.unnest(stale_created_ats),
      pg_catalog.unnest(stale_lease_tokens),
      pg_catalog.unnest(stale_lease_expires_ats)
    ) as target(
      id, user_id, capture_id, created_at, lease_token, lease_expires_at
    )
    join public.organization_jobs as job
      on job.id = target.id
      and job.user_id = target.user_id
      and job.capture_id = target.capture_id
      and job.created_at = target.created_at
      and job.lease_token = target.lease_token
      and job.lease_expires_at = target.lease_expires_at
    where job.state = 'running'
      and job.lease_expires_at <= clock_timestamp()
    order by job.lease_expires_at, job.id
  loop
    select * into job_row
    from public.organization_jobs
    where id = stale.id
      and user_id = stale.user_id
      and capture_id = stale.capture_id
      and created_at = stale.created_at
      and state = 'running'
      and lease_token = stale.lease_token
      and lease_expires_at = stale.lease_expires_at
      and lease_expires_at <= clock_timestamp()
    for update;
    if not found then continue; end if;

    perform 1
    from public.captures as capture
    where capture.id = job_row.capture_id
      and capture.user_id = job_row.user_id
    for update of capture;
    if not found then continue; end if;

    perform private.burn_encrypted_organizer_reservations(
      job_row.id, job_row.lease_token
    );
    next_state := case when job_row.attempt < 5
      then 'awaiting_retry'::public.job_state
      else 'dead_letter'::public.job_state end;
    update public.organization_jobs
    set
      state = next_state,
      available_at = case when next_state = 'awaiting_retry'
        then clock_timestamp() else available_at end,
      completed_at = case when next_state = 'dead_letter'
        then clock_timestamp() else null end,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      error_code = 'provider_unavailable',
      last_transition_lease_token = job_row.lease_token,
      last_transition_action = 'recovered',
      last_transition_request_hash = private.request_hash(jsonb_build_object(
        'domain', 'unfiled.encrypted-organizer-recover.v1',
        'leaseToken', job_row.lease_token,
        'state', next_state
      ))
    where id = job_row.id;
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
    update public.captures
    set
      status = case when next_state = 'awaiting_retry'
        then 'queued'::public.capture_status else 'failed'::public.capture_status end,
      last_error_code = 'provider_unavailable'
    where id = job_row.capture_id and user_id = job_row.user_id;
    recovered_count := recovered_count + 1;
    if next_state = 'awaiting_retry' then
      requeued_count := requeued_count + 1;
    else
      dead_lettered_count := dead_lettered_count + 1;
    end if;
    perform private.emit_user_event(job_row.user_id, 'organization_job', job_row.id);
    perform private.emit_user_event(job_row.user_id, 'capture', job_row.capture_id);
  end loop;
  return jsonb_build_object(
    'recoveredCount', recovered_count,
    'requeuedCount', requeued_count,
    'deadLetteredCount', dead_lettered_count
  );
end;
$$;

-- Public wrappers bind the credential itself, not a forgeable JWT role claim.
-- The current-role check also rejects SET ROLE from a broader login. Managed
-- setup may later enable LOGIN on this exact role; membership remains empty.
create function public.claim_encrypted_organizer_jobs(
  p_worker_id text,
  p_claim_limit integer default 2,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.claim_encrypted_organizer_jobs_impl(
    p_worker_id, p_claim_limit, p_lease_seconds
  );
end;
$$;

create function public.heartbeat_encrypted_organizer_job(
  p_job_id text,
  p_lease_token text,
  p_lease_seconds integer,
  p_candidate_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.heartbeat_encrypted_organizer_job_impl(
    p_job_id, p_lease_token, p_lease_seconds, p_candidate_manifest
  );
end;
$$;

create function public.list_encrypted_organizer_candidates(
  p_job_id text,
  p_lease_token text,
  p_candidate_limit integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.list_encrypted_organizer_candidates_impl(
    p_job_id, p_lease_token, p_candidate_limit
  );
end;
$$;

create function public.prepare_encrypted_organizer_create(
  p_job_id text,
  p_lease_token text,
  p_stable_note_id text,
  p_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.prepare_encrypted_organizer_create_impl(
    p_job_id, p_lease_token, p_stable_note_id, p_reservation_id
  );
end;
$$;

create function public.prepare_encrypted_organizer_append(
  p_job_id text,
  p_lease_token text,
  p_note_id text,
  p_expected_revision bigint,
  p_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.prepare_encrypted_organizer_append_impl(
    p_job_id, p_lease_token, p_note_id, p_expected_revision, p_reservation_id
  );
end;
$$;

create function public.commit_encrypted_organizer_job(
  p_job_id text,
  p_lease_token text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.commit_encrypted_organizer_job_impl(
    p_job_id, p_lease_token, p_command
  );
end;
$$;

create function public.fail_encrypted_organizer_job(
  p_job_id text,
  p_lease_token text,
  p_error_code text,
  p_retryable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.fail_encrypted_organizer_job_impl(
    p_job_id, p_lease_token, p_error_code, p_retryable
  );
end;
$$;

create function public.recover_stale_encrypted_organizer_jobs(
  p_recovery_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_organizer_worker'
    or current_setting('role', true) not in ('none', 'unfiled_organizer_worker')
  then raise exception using errcode = '42501', message = 'forbidden'; end if;
  return private.recover_stale_encrypted_organizer_jobs_impl(p_recovery_limit);
end;
$$;

revoke execute on function public.claim_encrypted_organizer_jobs(
  text, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.heartbeat_encrypted_organizer_job(
  text, text, integer, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.list_encrypted_organizer_candidates(
  text, text, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.prepare_encrypted_organizer_create(
  text, text, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.prepare_encrypted_organizer_append(
  text, text, text, bigint, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.commit_encrypted_organizer_job(
  text, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.fail_encrypted_organizer_job(
  text, text, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.recover_stale_encrypted_organizer_jobs(integer)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;

revoke all privileges on all tables in schema public
from unfiled_organizer_worker;
revoke all privileges on all sequences in schema public
from unfiled_organizer_worker;
revoke all privileges on all tables in schema private
from unfiled_organizer_worker;
revoke all privileges on all sequences in schema private
from unfiled_organizer_worker;
revoke execute on all functions in schema public
from unfiled_organizer_worker;
revoke execute on all functions in schema private
from unfiled_organizer_worker;
revoke all privileges on schema private
from unfiled_organizer_worker;
revoke create on schema public
from unfiled_organizer_worker;
grant usage on schema public
to unfiled_organizer_worker;

grant execute on function public.claim_encrypted_organizer_jobs(
  text, integer, integer
) to unfiled_organizer_worker;
grant execute on function public.heartbeat_encrypted_organizer_job(
  text, text, integer, jsonb
) to unfiled_organizer_worker;
grant execute on function public.list_encrypted_organizer_candidates(
  text, text, integer
) to unfiled_organizer_worker;
grant execute on function public.prepare_encrypted_organizer_create(
  text, text, text, text
) to unfiled_organizer_worker;
grant execute on function public.prepare_encrypted_organizer_append(
  text, text, text, bigint, text
) to unfiled_organizer_worker;
grant execute on function public.commit_encrypted_organizer_job(
  text, text, jsonb
) to unfiled_organizer_worker;
grant execute on function public.fail_encrypted_organizer_job(
  text, text, text, boolean
) to unfiled_organizer_worker;
grant execute on function public.recover_stale_encrypted_organizer_jobs(integer)
to unfiled_organizer_worker;

-- Implementation helpers are not alternate API surfaces.
revoke execute on all functions in schema private
from unfiled_organizer_worker;
revoke execute on function private.try_prelock_content_encryption_rollout()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.serialize_content_rollout_delete()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.organizer_key_projection(
  public.user_content_keys
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.encrypted_organizer_preparation_projection(
  public.encrypted_organizer_preparations, public.user_content_keys,
  public.user_content_keys, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.enforce_encrypted_organizer_rollout_write()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.lock_encrypted_organizer_job_rollout(text)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.assert_encrypted_organizer_lease(
  text, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.claim_encrypted_organizer_jobs_impl(
  text, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.heartbeat_encrypted_organizer_job_impl(
  text, text, integer, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.list_encrypted_organizer_candidates_impl(
  text, text, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.prepare_encrypted_organizer_write_impl(
  text, text, text, text, bigint, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.prepare_encrypted_organizer_create_impl(
  text, text, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.prepare_encrypted_organizer_append_impl(
  text, text, text, bigint, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.consume_encrypted_organizer_reservation(
  public.encrypted_organizer_preparations, jsonb, uuid, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.burn_encrypted_organizer_reservations(
  text, uuid
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.encrypted_organizer_reason_codes(jsonb)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.insert_encrypted_organizer_decision(
  public.encrypted_organizer_preparations, jsonb, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.insert_encrypted_organizer_review(
  public.encrypted_organizer_preparations, jsonb, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.insert_encrypted_organizer_receipt(
  public.encrypted_organizer_preparations, jsonb, text, text, boolean, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.commit_encrypted_organizer_job_impl(
  text, text, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.fail_encrypted_organizer_job_impl(
  text, text, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.recover_stale_encrypted_organizer_jobs_impl(
  integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

comment on table public.encrypted_organizer_preparations is
  'Content-free stable IDs and wrap reservations bound to one exact organizer lease.';

drop trigger organization_jobs_encrypted_rollout_guard
  on public.organization_jobs;
create trigger organization_jobs_encrypted_rollout_guard
before insert or update on public.organization_jobs
for each row execute function private.enforce_encrypted_organizer_rollout_write();
