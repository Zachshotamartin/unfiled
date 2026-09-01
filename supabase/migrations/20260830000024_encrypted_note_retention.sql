-- Milestone C.5d-4: encrypted note-retention parity.
--
-- Retention never decrypts in PostgreSQL. Candidate claims contain only
-- operational coordinates and a digest of the exact encrypted snapshot. The
-- web worker opens each receipt with the owner's KMS capability, constructs a
-- non-actionable Inbox receipt, reseals it at N + 1, and submits only
-- ciphertext plus verification evidence. The commit owns the canonical
-- rollout advisory before the workflow-wide job -> capture -> note row order.

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command',
      'encrypted_taxonomy_command', 'encrypted_note_retention'
    )
  );

create table public.encrypted_note_retention_runs (
  run_id uuid primary key,
  requested_owner_id uuid references auth.users(id) on delete cascade,
  lease_token uuid not null,
  run_at timestamptz not null,
  cutoff_at timestamptz not null,
  lease_expires_at timestamptz not null,
  batch_size integer not null check (batch_size between 1 and 25),
  state text not null default 'active'
    check (state in ('active', 'complete', 'cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check (cutoff_at = run_at - interval '30 days'),
  check (lease_expires_at > created_at),
  check ((state = 'active') = (completed_at is null))
);

create table public.encrypted_note_retention_claims (
  claim_id uuid primary key,
  run_id uuid not null references public.encrypted_note_retention_runs(run_id)
    on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null check (note_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'),
  note_deleted_at timestamptz not null,
  context_digest text not null check (context_digest ~ '^[0-9a-f]{64}$'),
  capture_ids text[] not null default '{}',
  job_ids text[] not null default '{}',
  receipt_capture_ids text[] not null default '{}',
  state text not null default 'prepared'
    check (state in ('prepared', 'committed', 'cancelled')),
  command_digest text check (command_digest ~ '^[0-9a-f]{64}$'),
  purged_capture_count integer check (purged_capture_count >= 0),
  purged_receipt_count integer check (purged_receipt_count >= 0),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (run_id, note_id),
  check (cardinality(capture_ids) <= 100),
  check (cardinality(job_ids) <= 100),
  check (cardinality(receipt_capture_ids) <= 100),
  check (
    (state = 'prepared' and command_digest is null
      and completed_at is null and cancelled_at is null)
    or (state = 'committed' and command_digest is not null
      and completed_at is not null and cancelled_at is null
      and purged_capture_count is not null and purged_receipt_count is not null)
    or (state = 'cancelled' and command_digest is null
      and completed_at is null and cancelled_at is not null)
  )
);

create unique index encrypted_note_retention_one_prepared_note
  on public.encrypted_note_retention_claims (user_id, note_id)
  where state = 'prepared';
create index encrypted_note_retention_run_claims
  on public.encrypted_note_retention_claims (run_id, state, note_id);

alter table public.encrypted_note_retention_runs enable row level security;
alter table public.encrypted_note_retention_runs force row level security;
alter table public.encrypted_note_retention_claims enable row level security;
alter table public.encrypted_note_retention_claims force row level security;
revoke all on table public.encrypted_note_retention_runs
  from public, anon, authenticated, service_role;
revoke all on table public.encrypted_note_retention_claims
  from public, anon, authenticated, service_role;

-- This projection contains no legacy plaintext. Including envelope digests,
-- row identities, revisions, operational references, and timestamps makes a
-- claim an exact CAS boundary without retaining a second ciphertext copy.
create or replace function private.encrypted_note_retention_snapshot(
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
  note_value jsonb;
  captures_value jsonb;
  jobs_value jsonb;
  receipts_value jsonb;
  decisions_value jsonb;
  capture_ids_value text[];
begin
  select jsonb_build_object(
    'noteId', note_record.id,
    'ownerId', note_record.user_id,
    'currentRevision', note_record.current_revision,
    'privacy', note_record.privacy,
    'deletedAt', note_record.deleted_at,
    'updatedAt', note_record.updated_at,
    'createdAt', note_record.created_at
  ) into note_value
  from public.notes as note_record
  where note_record.user_id = p_owner_id and note_record.id = p_note_id;
  if note_value is null then return null; end if;

  select coalesce(
    array_agg(related.capture_id order by related.capture_id),
    array[]::text[]
  ) into capture_ids_value
  from private.note_retention_capture_ids(p_note_id) as related;

  select coalesce(jsonb_agg(jsonb_build_object(
    'captureId', capture_record.id,
    'ownerId', capture_record.user_id,
    'privacy', capture_record.privacy,
    'status', capture_record.status,
    'deletedAt', capture_record.deleted_at,
    'explicitDestinationNoteId', capture_record.explicit_destination_note_id,
    'receivedAt', capture_record.received_at
  ) order by capture_record.id), '[]'::jsonb)
  into captures_value
  from public.captures as capture_record
  where capture_record.id = any(capture_ids_value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', job_record.id,
    'captureId', job_record.capture_id,
    'ownerId', job_record.user_id,
    'state', job_record.state,
    'createdAt', job_record.created_at,
    'updatedAt', job_record.updated_at
  ) order by job_record.id), '[]'::jsonb)
  into jobs_value
  from public.organization_jobs as job_record
  where job_record.capture_id = any(capture_ids_value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'captureId', receipt_record.capture_id,
    'jobId', receipt_record.job_id,
    'ownerId', receipt_record.user_id,
    'decisionId', receipt_record.decision_id,
    'reviewItemId', receipt_record.review_item_id,
    'mutationId', receipt_record.mutation_id,
    'outcome', receipt_record.outcome,
    'destinationNoteId', receipt_record.destination_note_id,
    'reasonCodes', to_jsonb(receipt_record.reason_codes),
    'createdAt', receipt_record.created_at,
    'recordVersion', receipt_record.receipt_revision,
    'keyId', receipt_record.receipt_key_id,
    'keyClass', receipt_record.receipt_key_class,
    'keyPurpose', receipt_record.receipt_key_purpose,
    'keyVersion', receipt_record.receipt_key_version,
    'envelopeDigest', case when receipt_record.receipt_envelope is null
      then null else encode(extensions.digest(
        receipt_record.receipt_envelope::text, 'sha256'
      ), 'hex') end
  ) order by receipt_record.capture_id), '[]'::jsonb)
  into receipts_value
  from public.capture_receipts as receipt_record
  where receipt_record.capture_id = any(capture_ids_value);

  select coalesce(jsonb_agg(jsonb_build_object(
    'decisionId', decision_record.id,
    'captureId', decision_record.capture_id,
    'ownerId', decision_record.user_id,
    'destinationNoteId', decision_record.destination_note_id,
    'recordVersion', decision_record.decision_content_revision,
    'keyId', decision_record.decision_key_id,
    'keyClass', decision_record.decision_key_class,
    'keyPurpose', decision_record.decision_key_purpose,
    'keyVersion', decision_record.decision_key_version,
    'envelopeDigest', case when decision_record.decision_envelope is null
      then null else encode(extensions.digest(
        decision_record.decision_envelope::text, 'sha256'
      ), 'hex') end
  ) order by decision_record.id), '[]'::jsonb)
  into decisions_value
  from public.organization_decisions as decision_record
  where decision_record.capture_id = any(capture_ids_value);

  return jsonb_build_object(
    'note', note_value,
    'captures', captures_value,
    'jobs', jobs_value,
    'receipts', receipts_value,
    'decisions', decisions_value
  );
end;
$$;

create or replace function private.encrypted_note_retention_claim_projection(
  p_claim public.encrypted_note_retention_claims,
  p_replayed boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'claimId', p_claim.claim_id,
    'ownerId', p_claim.user_id,
    'noteId', p_claim.note_id,
    'deletedAt', p_claim.note_deleted_at,
    'contextDigest', p_claim.context_digest,
    'receiptContexts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'captureId', receipt.capture_id,
        'recordVersion', receipt.receipt_revision,
        'privacy', capture.privacy
      ) order by receipt.capture_id)
      from public.capture_receipts as receipt
      join public.captures as capture
        on capture.id = receipt.capture_id
        and capture.user_id = receipt.user_id
      where receipt.user_id = p_claim.user_id
        and receipt.capture_id = any(p_claim.receipt_capture_ids)
    ), '[]'::jsonb),
    'replayed', p_replayed
  );
$$;

-- Reservation consumption is specialized so future consumers cannot inherit
-- retention's exact claim binding accidentally.
create or replace function private.consume_encrypted_note_retention_reservations(
  p_owner_id uuid,
  p_claim_id uuid,
  p_cipher_values jsonb
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
  if p_owner_id is null or p_claim_id is null
    or jsonb_typeof(p_cipher_values) <> 'array'
    or jsonb_array_length(p_cipher_values) not between 1 and 100
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
    from jsonb_array_elements(p_cipher_values) as entry(item)
    group by 1, 2, 3, 4, 5
    order by 1
  loop
    select * into reservation_row
    from public.content_key_operation_reservations as reservation
    where reservation.user_id = p_owner_id
      and reservation.reservation_id = reservation_group.reservation_id
    for update of reservation;
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
      if reservation_row.consumed_by_type = 'encrypted_note_retention'
        and reservation_row.consumed_by_id = p_claim_id::text
      then continue; end if;
      raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
    end if;
    select content_key.state into key_state_value
    from public.user_content_keys as content_key
    where content_key.user_id = p_owner_id
      and content_key.key_id = reservation_row.key_id
      and content_key.key_class = reservation_row.key_class
      and content_key.key_purpose = reservation_row.key_purpose
      and content_key.key_version = reservation_row.key_version
    for share of content_key;
    if key_state_value is distinct from 'active'::public.content_key_state then
      raise exception using errcode = 'P0001', message = 'invalid_key_state';
    end if;
    update public.content_key_operation_reservations
    set consumed_by_type = 'encrypted_note_retention',
      consumed_by_id = p_claim_id::text,
      consumed_at = clock_timestamp()
    where user_id = p_owner_id
      and reservation_id = reservation_group.reservation_id;
  end loop;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.claim_encrypted_note_retention(
  p_run_id uuid,
  p_lease_token uuid,
  p_owner_id uuid default null,
  p_now timestamptz default now(),
  p_batch_size integer default 25,
  p_execute boolean default false,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  run_row public.encrypted_note_retention_runs%rowtype;
  candidate record;
  claim_row public.encrypted_note_retention_claims%rowtype;
  cutoff_value timestamptz;
  eligible_count integer;
  claimed_count integer := 0;
  claims_value jsonb := '[]'::jsonb;
  snapshot_value jsonb;
  digest_value text;
  capture_ids_value text[];
  job_ids_value text[];
  receipt_ids_value text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_run_id is null or p_lease_token is null or p_now is null
    or p_now <> date_trunc('milliseconds', p_now)
    or p_batch_size is null or p_batch_size not between 1 and 25
    or p_execute is null
    or p_lease_seconds is null or p_lease_seconds not between 30 and 600
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  cutoff_value := p_now - interval '30 days';

  select count(*)::integer into eligible_count
  from (
    select 1
    from public.notes as note_record
    join public.content_encryption_rollouts as rollout
      on rollout.user_id = note_record.user_id
      and rollout.state in (
        'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
      )
    where note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_value
      and (p_owner_id is null or note_record.user_id = p_owner_id)
    order by note_record.deleted_at, note_record.id
    limit p_batch_size
  ) as eligible;

  if not p_execute then
    return jsonb_build_object(
      'runAt', p_now, 'cutoff', cutoff_value,
      'eligibleCount', eligible_count, 'executed', false,
      'claimedCount', 0, 'claims', '[]'::jsonb, 'replayed', false
    );
  end if;

  insert into public.encrypted_note_retention_runs (
    run_id, requested_owner_id, lease_token, run_at, cutoff_at,
    lease_expires_at, batch_size
  ) values (
    p_run_id, p_owner_id, p_lease_token, p_now, cutoff_value,
    clock_timestamp() + make_interval(secs => p_lease_seconds), p_batch_size
  ) on conflict (run_id) do nothing;
  if not found then
    select * into run_row from public.encrypted_note_retention_runs
    where run_id = p_run_id;
    if run_row.lease_token <> p_lease_token
      or run_row.requested_owner_id is distinct from p_owner_id
      or run_row.run_at <> p_now
      or run_row.cutoff_at <> cutoff_value
      or run_row.batch_size <> p_batch_size
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    select coalesce(jsonb_agg(
      private.encrypted_note_retention_claim_projection(existing_claim, true)
      order by existing_claim.note_deleted_at, existing_claim.note_id
    ), '[]'::jsonb) into claims_value
    from public.encrypted_note_retention_claims as existing_claim
    where existing_claim.run_id = p_run_id
      and existing_claim.state = 'prepared';
    return jsonb_build_object(
      'runAt', p_now, 'cutoff', cutoff_value,
      'eligibleCount', eligible_count, 'executed', true,
      'claimedCount', jsonb_array_length(claims_value),
      'claims', claims_value, 'replayed', true
    );
  end if;

  -- Expired capabilities are made non-actionable before selecting new work.
  update public.encrypted_note_retention_claims as expired_claim
  set state = 'cancelled', cancelled_at = clock_timestamp()
  from public.encrypted_note_retention_runs as expired_run
  where expired_run.run_id = expired_claim.run_id
    and expired_run.state = 'active'
    and expired_run.lease_expires_at <= clock_timestamp()
    and expired_claim.state = 'prepared';
  update public.encrypted_note_retention_runs as expired_run
  set state = 'cancelled', completed_at = clock_timestamp()
  where expired_run.state = 'active'
    and expired_run.lease_expires_at <= clock_timestamp()
    and not exists (
      select 1 from public.encrypted_note_retention_claims as remaining
      where remaining.run_id = expired_run.run_id
        and remaining.state = 'prepared'
    );

  -- Discovery is intentionally optimistic and takes no content row locks.
  -- The durable digest is rechecked only after commit owns the canonical
  -- advisory and sorted workflow locks, avoiding multi-owner lock inversion.
  for candidate in
    select note_record.id, note_record.user_id, note_record.deleted_at
    from public.notes as note_record
    join public.content_encryption_rollouts as rollout
      on rollout.user_id = note_record.user_id
      and rollout.state in (
        'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
      )
    where note_record.deleted_at is not null
      and note_record.deleted_at <= cutoff_value
      and (p_owner_id is null or note_record.user_id = p_owner_id)
      and not exists (
        select 1 from public.encrypted_note_retention_claims as active_claim
        where active_claim.user_id = note_record.user_id
          and active_claim.note_id = note_record.id
          and active_claim.state = 'prepared'
      )
    order by note_record.deleted_at, note_record.id
    limit least(p_batch_size * 10, 250)
  loop
    exit when claimed_count >= p_batch_size;
    select coalesce(array_agg(related.capture_id order by related.capture_id),
      array[]::text[]) into capture_ids_value
    from private.note_retention_capture_ids(candidate.id) as related;
    if cardinality(capture_ids_value) > 100 then continue; end if;
    select coalesce(array_agg(job.id order by job.id), array[]::text[])
      into job_ids_value
    from public.organization_jobs as job
    where job.capture_id = any(capture_ids_value);
    if cardinality(job_ids_value) > 100 then continue; end if;
    select coalesce(array_agg(receipt.capture_id order by receipt.capture_id),
      array[]::text[]) into receipt_ids_value
    from public.capture_receipts as receipt
    where receipt.capture_id = any(capture_ids_value);
    if cardinality(receipt_ids_value) > 100 then continue; end if;
    if exists (
      select 1 from public.captures as capture
      where capture.id = any(capture_ids_value)
        and capture.user_id <> candidate.user_id
      union all
      select 1 from public.organization_jobs as job
      where job.id = any(job_ids_value) and job.user_id <> candidate.user_id
      union all
      select 1 from public.capture_receipts as receipt
      where receipt.capture_id = any(receipt_ids_value)
        and receipt.user_id <> candidate.user_id
      union all
      select 1 from public.organization_decisions as decision
      where decision.capture_id = any(capture_ids_value)
        and decision.user_id <> candidate.user_id
    ) then
      raise exception using errcode = '23514', message = 'owner_scope_violation';
    end if;
    if exists (
      select 1 from public.organization_jobs as job
      where job.id = any(job_ids_value)
        and job.state in ('created', 'running', 'awaiting_retry')
    ) or exists (
      select 1 from public.capture_receipts as receipt
      where receipt.capture_id = any(receipt_ids_value)
        and (receipt.receipt_envelope is null
          or receipt.receipt_key_id is null
          or receipt.receipt_key_class is null
          or receipt.receipt_key_purpose <> 'object_wrap'
          or receipt.receipt_key_version is null)
    ) or exists (
      select 1 from public.captures as capture
      where capture.id = any(capture_ids_value)
        and (capture.content_envelope is null
          or capture.content_key_id is null
          or capture.content_key_class is null
          or capture.content_key_purpose <> 'object_wrap'
          or capture.content_key_version is null)
    ) or exists (
      select 1 from public.organization_decisions as decision
      where decision.capture_id = any(capture_ids_value)
        and (decision.decision_envelope is null
          or decision.decision_key_id is null
          or decision.decision_key_class <> 'ai_assisted'
          or decision.decision_key_purpose <> 'object_wrap'
          or decision.decision_key_version is null)
    ) or 100 < (
      select count(*) from public.organization_decisions as decision
      where decision.capture_id = any(capture_ids_value)
    ) then
      continue;
    end if;
    snapshot_value := private.encrypted_note_retention_snapshot(
      candidate.user_id, candidate.id
    );
    if snapshot_value is null then continue; end if;
    digest_value := encode(extensions.digest(snapshot_value::text, 'sha256'), 'hex');
    insert into public.encrypted_note_retention_claims (
      claim_id, run_id, user_id, note_id, note_deleted_at,
      context_digest, capture_ids, job_ids, receipt_capture_ids
    ) values (
      extensions.gen_random_uuid(), p_run_id, candidate.user_id, candidate.id,
      candidate.deleted_at, digest_value, capture_ids_value, job_ids_value,
      receipt_ids_value
    ) on conflict do nothing returning * into claim_row;
    if not found then continue; end if;
    claims_value := claims_value || jsonb_build_array(
      private.encrypted_note_retention_claim_projection(claim_row, false)
    );
    claimed_count := claimed_count + 1;
  end loop;

  if claimed_count = 0 then
    update public.encrypted_note_retention_runs
    set state = 'complete', completed_at = clock_timestamp()
    where run_id = p_run_id and state = 'active';
  end if;
  return jsonb_build_object(
    'runAt', p_now, 'cutoff', cutoff_value,
    'eligibleCount', eligible_count, 'executed', true,
    'claimedCount', claimed_count, 'claims', claims_value, 'replayed', false
  );
end;
$$;

create or replace function public.cancel_encrypted_note_retention_claim(
  p_owner_id uuid,
  p_run_id uuid,
  p_claim_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  run_row public.encrypted_note_retention_runs%rowtype;
  claim_row public.encrypted_note_retention_claims%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_run_id is null
    or p_claim_id is null or p_lease_token is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into run_row from public.encrypted_note_retention_runs
  where run_id = p_run_id for update;
  if not found or run_row.lease_token <> p_lease_token then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  select * into claim_row from public.encrypted_note_retention_claims
  where claim_id = p_claim_id and run_id = p_run_id
    and user_id = p_owner_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if claim_row.state = 'committed' then
    return jsonb_build_object(
      'claimId', p_claim_id, 'state', 'committed',
      'cancelled', false, 'replayed', true
    );
  end if;
  if claim_row.state = 'cancelled' then
    return jsonb_build_object(
      'claimId', p_claim_id, 'state', 'cancelled',
      'cancelled', true, 'replayed', true
    );
  end if;
  update public.encrypted_note_retention_claims
  set state = 'cancelled', cancelled_at = clock_timestamp()
  where claim_id = p_claim_id and state = 'prepared';
  update public.encrypted_note_retention_runs
  set state = 'complete', completed_at = clock_timestamp()
  where run_id = p_run_id and state = 'active'
    and not exists (
      select 1 from public.encrypted_note_retention_claims
      where run_id = p_run_id and state = 'prepared'
    );
  return jsonb_build_object(
    'claimId', p_claim_id, 'state', 'cancelled',
    'cancelled', true, 'replayed', false
  );
end;
$$;

create or replace function public.commit_encrypted_note_retention(
  p_owner_id uuid,
  p_run_id uuid,
  p_claim_id uuid,
  p_lease_token uuid,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  run_row public.encrypted_note_retention_runs%rowtype;
  claim_row public.encrypted_note_retention_claims%rowtype;
  receipt_row public.capture_receipts%rowtype;
  command_receipt jsonb;
  command_digest_value text;
  snapshot_value jsonb;
  current_digest_value text;
  live_capture_ids text[];
  live_job_ids text[];
  cipher_values jsonb := '[]'::jsonb;
  receipt_count integer;
  changed_capture_ids text[] := array[]::text[];
  affected_generation_ids text[] := array[]::text[];
  target_note_ids text[] := array[]::text[];
  target_mutation_ids text[] := array[]::text[];
  event_capture_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_run_id is null or p_claim_id is null
    or p_lease_token is null or p_command is null
    or jsonb_typeof(p_command) <> 'object'
    or p_command - array['contextDigest', 'receipts'] <> '{}'::jsonb
    or not p_command ?& array['contextDigest', 'receipts']
    or jsonb_typeof(p_command -> 'contextDigest') <> 'string'
    or p_command ->> 'contextDigest' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_command -> 'receipts') <> 'array'
    or jsonb_array_length(p_command -> 'receipts') > 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
    where jsonb_typeof(supplied.item) <> 'object'
      or supplied.item - array[
        'captureId', 'recordVersion', 'receiptCipher', 'verificationMac',
        'projection'
      ] <> '{}'::jsonb
      or not supplied.item ?& array[
        'captureId', 'recordVersion', 'receiptCipher', 'verificationMac',
        'projection'
      ]
      or jsonb_typeof(supplied.item -> 'captureId') <> 'string'
      or supplied.item ->> 'captureId' !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
      or jsonb_typeof(supplied.item -> 'recordVersion') <> 'number'
      or supplied.item ->> 'recordVersion' !~ '^[1-9][0-9]{0,8}$'
      or jsonb_typeof(supplied.item -> 'receiptCipher') <> 'object'
      or jsonb_typeof(supplied.item -> 'verificationMac') <> 'object'
      or jsonb_typeof(supplied.item -> 'projection') <> 'object'
      or (supplied.item -> 'projection')
        - array['mode', 'primary'] <> '{}'::jsonb
      or not ((supplied.item -> 'projection') ?& array['mode', 'primary'])
      or jsonb_typeof(supplied.item #> '{projection,mode}') <> 'string'
      or supplied.item #>> '{projection,mode}'
        not in ('preserve', 'inbox', 'routed')
      or (
        supplied.item #>> '{projection,mode}' = 'routed'
        and (
          jsonb_typeof(supplied.item #> '{projection,primary}') <> 'object'
          or (supplied.item #> '{projection,primary}') - array[
            'noteId', 'mutationId', 'expectedRevision', 'noteRecordVersion'
          ] <> '{}'::jsonb
          or not ((supplied.item #> '{projection,primary}') ?& array[
            'noteId', 'mutationId', 'expectedRevision', 'noteRecordVersion'
          ])
          or supplied.item #>> '{projection,primary,noteId}'
            !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
          or supplied.item #>> '{projection,primary,mutationId}'
            !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
          or jsonb_typeof(supplied.item #> '{projection,primary,expectedRevision}')
            <> 'number'
          or supplied.item #>> '{projection,primary,expectedRevision}'
            !~ '^[1-9][0-9]{0,8}$'
          or jsonb_typeof(supplied.item #> '{projection,primary,noteRecordVersion}')
            <> 'number'
          or supplied.item #>> '{projection,primary,noteRecordVersion}'
            !~ '^[1-9][0-9]{0,8}$'
        )
      )
      or (
        supplied.item #>> '{projection,mode}' <> 'routed'
        and supplied.item #> '{projection,primary}' <> 'null'::jsonb
      )
  ) or (
    select count(*) <> count(distinct supplied.item ->> 'captureId')
    from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
  ) then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  command_digest_value := encode(
    extensions.digest(p_command::text, 'sha256'), 'hex'
  );

  -- Global content order: owner rollout advisory -> sorted jobs -> sorted
  -- captures/receipts/decisions -> idempotency -> target note.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  -- Generation seeding owns this advisory before it owns a generation row.
  -- Taking it before any retention row lock prevents generation -> job-insert
  -- from crossing retention's note -> index-job -> generation worker order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'unfiled.rag-generation-control.v1:' || p_owner_id::text, 0
  ));
  select * into run_row from public.encrypted_note_retention_runs
  where run_id = p_run_id for update;
  if not found or run_row.lease_token <> p_lease_token
    or (run_row.requested_owner_id is not null
      and run_row.requested_owner_id <> p_owner_id)
  then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  select * into claim_row from public.encrypted_note_retention_claims
  where claim_id = p_claim_id and run_id = p_run_id
    and user_id = p_owner_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if claim_row.state = 'committed' then
    if claim_row.command_digest <> command_digest_value then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'claimId', p_claim_id, 'noteId', claim_row.note_id,
      'purged', true, 'purgedCaptureCount', claim_row.purged_capture_count,
      'purgedReceiptCount', claim_row.purged_receipt_count, 'replayed', true
    );
  end if;
  if claim_row.state <> 'prepared'
    or run_row.state <> 'active'
    or run_row.lease_expires_at <= clock_timestamp()
  then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  if p_command ->> 'contextDigest' <> claim_row.context_digest
    or jsonb_array_length(p_command -> 'receipts')
      <> cardinality(claim_row.receipt_capture_ids)
    or exists (
      select 1 from unnest(claim_row.receipt_capture_ids) as expected(capture_id)
      where not exists (
        select 1 from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
        where supplied.item ->> 'captureId' = expected.capture_id
      )
    )
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  for event_capture_id in
    select job_id from unnest(claim_row.job_ids) as planned(job_id)
    order by job_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'encrypted-organizer-claim:' || event_capture_id, 0
    ));
  end loop;
  perform 1 from public.organization_jobs as job
  where job.id = any(claim_row.job_ids) and job.user_id = p_owner_id
  order by job.id for update of job;
  if cardinality(claim_row.job_ids) <> (
    select count(*) from public.organization_jobs as job
    where job.id = any(claim_row.job_ids) and job.user_id = p_owner_id
  ) then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform 1 from public.captures as capture
  where capture.id = any(claim_row.capture_ids) and capture.user_id = p_owner_id
  order by capture.id for update of capture;
  if cardinality(claim_row.capture_ids) <> (
    select count(*) from public.captures as capture
    where capture.id = any(claim_row.capture_ids) and capture.user_id = p_owner_id
  ) then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform 1 from public.capture_receipts as receipt
  where receipt.capture_id = any(claim_row.receipt_capture_ids)
    and receipt.user_id = p_owner_id
  order by receipt.capture_id for update of receipt;
  perform 1 from public.organization_decisions as decision
  where decision.capture_id = any(claim_row.capture_ids)
    and decision.user_id = p_owner_id
  order by decision.id for update of decision;
  if 100 < (
    select count(*) from public.organization_decisions as decision
    where decision.capture_id = any(claim_row.capture_ids)
      and decision.user_id = p_owner_id
  ) or exists (
    select 1 from public.organization_decisions as decision
    where decision.capture_id = any(claim_row.capture_ids)
      and decision.user_id = p_owner_id
      and (decision.decision_envelope is null
        or decision.decision_key_id is null
        or decision.decision_key_class <> 'ai_assisted'
        or decision.decision_key_purpose <> 'object_wrap'
        or decision.decision_key_version is null)
  ) then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform 1 from public.api_idempotency_records as idempotency
  where idempotency.user_id = p_owner_id
    and (
      (idempotency.request_resource_type = 'note'
        and idempotency.request_resource_id = claim_row.note_id)
      or idempotency.response_json #>> '{note,id}' = claim_row.note_id
      or idempotency.response_json #>> '{revision,noteId}' = claim_row.note_id
    )
  order by idempotency.idempotency_key for update of idempotency;
  select array_agg(planned.note_id order by planned.note_id)
  into target_note_ids
  from (
    select claim_row.note_id
    union
    select supplied.item #>> '{projection,primary,noteId}'
    from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
    where supplied.item #>> '{projection,mode}' = 'routed'
  ) as planned(note_id);
  perform 1 from public.notes as note
  where note.id = any(target_note_ids) and note.user_id = p_owner_id
  order by note.id for update of note;
  if cardinality(target_note_ids) <> (
    select count(*) from public.notes as note
    where note.id = any(target_note_ids) and note.user_id = p_owner_id
  ) or not exists (
    select 1 from public.notes as note
    where note.id = claim_row.note_id and note.user_id = p_owner_id
      and note.deleted_at = claim_row.note_deleted_at
      and note.deleted_at <= run_row.cutoff_at
  ) then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select coalesce(array_agg(planned.mutation_id order by planned.mutation_id),
    array[]::text[])
  into target_mutation_ids
  from (
    select distinct supplied.item #>> '{projection,primary,mutationId}'
      as mutation_id
    from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
    where supplied.item #>> '{projection,mode}' = 'routed'
  ) as planned;
  perform 1 from public.note_mutations as mutation
  where mutation.id = any(target_mutation_ids) and mutation.user_id = p_owner_id
  order by mutation.id for update of mutation;

  -- RAG publication uses note -> index job -> generation. Once the target
  -- note is locked, retention can safely fence every queued/leased index job,
  -- burn an abandoned reservation through the existing transition trigger,
  -- and lock affected generations without introducing a reverse edge.
  perform 1 from public.note_index_jobs as index_job
  where index_job.user_id = p_owner_id
    and index_job.note_id = claim_row.note_id
  order by index_job.id for update of index_job;
  select coalesce(array_agg(distinct affected.generation_id
    order by affected.generation_id), array[]::text[])
  into affected_generation_ids
  from (
    select index_job.generation_id
    from public.note_index_jobs as index_job
    where index_job.user_id = p_owner_id
      and index_job.note_id = claim_row.note_id
    union
    select index_row.generation_id
    from public.note_rag_index as index_row
    where index_row.user_id = p_owner_id
      and index_row.note_id = claim_row.note_id
  ) as affected;
  perform 1 from public.rag_index_generations as generation
  where generation.user_id = p_owner_id
    and generation.id = any(affected_generation_ids)
  order by generation.id for update of generation;
  update public.note_index_jobs as index_job
  set state = 'failed',
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_error_code = 'not_found'
  where index_job.user_id = p_owner_id
    and index_job.note_id = claim_row.note_id
    and index_job.state in ('queued', 'leased');

  select coalesce(array_agg(related.capture_id order by related.capture_id),
    array[]::text[]) into live_capture_ids
  from private.note_retention_capture_ids(claim_row.note_id) as related;
  select coalesce(array_agg(job.id order by job.id), array[]::text[])
    into live_job_ids
  from public.organization_jobs as job
  where job.capture_id = any(live_capture_ids);
  if live_capture_ids <> claim_row.capture_ids
    or live_job_ids <> claim_row.job_ids
    or exists (
      select 1 from public.organization_jobs as active_job
      where active_job.id = any(live_job_ids)
        and active_job.state in ('created', 'running', 'awaiting_retry')
    ) or exists (
      select 1 from public.encrypted_note_write_claims as pending_write
      where pending_write.user_id = p_owner_id
        and pending_write.note_id = claim_row.note_id
        and pending_write.completed_at is null
    )
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  if exists (
    select 1 from public.note_revisions as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.captures as linked
    where linked.id = any(live_capture_ids) and linked.user_id <> p_owner_id
    union all select 1 from public.organization_jobs as linked
    where linked.id = any(live_job_ids) and linked.user_id <> p_owner_id
    union all select 1 from public.organization_decisions as linked
    where linked.destination_note_id = claim_row.note_id
      and linked.user_id <> p_owner_id
    union all select 1 from public.note_mutations as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.generated_blocks as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.capture_note_links as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.routing_rules as linked
    where linked.destination_note_id = claim_row.note_id
      and linked.user_id <> p_owner_id
    union all select 1 from public.review_items as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.note_tags as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.note_links as linked
    where (linked.from_note_id = claim_row.note_id
      or linked.to_note_id = claim_row.note_id) and linked.user_id <> p_owner_id
    union all select 1 from public.feedback_events as linked
    where (linked.old_destination_note_id = claim_row.note_id
      or linked.new_destination_note_id = claim_row.note_id)
      and linked.user_id <> p_owner_id
    union all select 1 from public.organization_mutation_attempts as linked
    where linked.note_id = claim_row.note_id and linked.user_id <> p_owner_id
    union all select 1 from public.capture_receipts as linked
    where linked.capture_id = any(live_capture_ids) and linked.user_id <> p_owner_id
  ) then
    raise exception using errcode = '23514', message = 'owner_scope_violation';
  end if;

  snapshot_value := private.encrypted_note_retention_snapshot(
    p_owner_id, claim_row.note_id
  );
  current_digest_value := encode(
    extensions.digest(snapshot_value::text, 'sha256'), 'hex'
  );
  if current_digest_value <> claim_row.context_digest then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  for command_receipt in
    select supplied.item
    from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
    order by supplied.item ->> 'captureId'
  loop
    select * into receipt_row from public.capture_receipts as receipt
    where receipt.capture_id = command_receipt ->> 'captureId'
      and receipt.user_id = p_owner_id;
    if not found
      or (command_receipt ->> 'recordVersion')::integer
        <> receipt_row.receipt_revision + 1
      or not private.valid_encrypted_write_cipher(
        command_receipt -> 'receiptCipher', p_owner_id,
        receipt_row.capture_id, receipt_row.receipt_revision + 1,
        'capture_receipt', receipt_row.receipt_key_class
      )
      or not private.valid_encrypted_write_mac(
        command_receipt -> 'verificationMac', p_owner_id,
        receipt_row.receipt_key_class, false
      )
    then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    if command_receipt #>> '{projection,mode}' = 'preserve' then
      if receipt_row.destination_note_id = claim_row.note_id
        or exists (
          select 1 from public.captures as expired_capture
          where expired_capture.user_id = p_owner_id
            and expired_capture.id = receipt_row.capture_id
            and expired_capture.explicit_destination_note_id = claim_row.note_id
        )
        or exists (
          select 1 from public.organization_decisions as expired_decision
          where expired_decision.user_id = p_owner_id
            and expired_decision.id = receipt_row.decision_id
            and expired_decision.destination_note_id = claim_row.note_id
        )
        or exists (
          select 1 from public.note_mutations as expired_mutation
          where expired_mutation.user_id = p_owner_id
            and expired_mutation.id = receipt_row.mutation_id
            and expired_mutation.note_id = claim_row.note_id
        )
        or exists (
          select 1 from public.review_items as expired_review
          where expired_review.user_id = p_owner_id
            and expired_review.id = receipt_row.review_item_id
            and expired_review.note_id = claim_row.note_id
        )
        or exists (
          select 1 from public.capture_note_links as expired_link
          where expired_link.user_id = p_owner_id
            and expired_link.capture_id = receipt_row.capture_id
            and expired_link.note_id = claim_row.note_id
        )
      then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    elsif not (
      exists (
        select 1 from public.captures as related_capture
        where related_capture.user_id = p_owner_id
          and related_capture.id = receipt_row.capture_id
          and related_capture.explicit_destination_note_id = claim_row.note_id
      )
      or receipt_row.destination_note_id = claim_row.note_id
      or exists (
        select 1 from public.note_mutations as expired_mutation
        where expired_mutation.user_id = p_owner_id
          and expired_mutation.id = receipt_row.mutation_id
          and expired_mutation.note_id = claim_row.note_id
      )
      or exists (
        select 1 from public.capture_note_links as expired_link
        where expired_link.user_id = p_owner_id
          and expired_link.capture_id = receipt_row.capture_id
          and expired_link.note_id = claim_row.note_id
      )
    ) then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    if command_receipt #>> '{projection,mode}' = 'routed' then
      if
        receipt_row.outcome not in ('created_note', 'added_to_note')
        or receipt_row.decision_id is null
        or command_receipt #>> '{projection,primary,noteId}' = claim_row.note_id
        or not exists (
          select 1 from public.notes as primary_note
          where primary_note.user_id = p_owner_id
            and primary_note.id = command_receipt
              #>> '{projection,primary,noteId}'
            and primary_note.current_revision = (
              command_receipt #>> '{projection,primary,noteRecordVersion}'
            )::integer
        )
        or not exists (
          select 1
          from public.note_mutations as primary_mutation
          join public.organization_decisions as primary_decision
            on primary_decision.id = primary_mutation.decision_id
            and primary_decision.user_id = primary_mutation.user_id
          join public.capture_note_links as primary_link
            on primary_link.user_id = primary_mutation.user_id
            and primary_link.capture_id = primary_decision.capture_id
            and primary_link.note_id = primary_mutation.note_id
            and primary_link.mutation_id = primary_mutation.id
          where primary_mutation.user_id = p_owner_id
            and primary_mutation.id = command_receipt
              #>> '{projection,primary,mutationId}'
            and primary_mutation.note_id = command_receipt
              #>> '{projection,primary,noteId}'
            and primary_mutation.after_revision = (
              command_receipt #>> '{projection,primary,expectedRevision}'
            )::integer
            and primary_decision.id = receipt_row.decision_id
            and primary_decision.capture_id = receipt_row.capture_id
        )
      then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    end if;
    cipher_values := cipher_values
      || jsonb_build_array(command_receipt -> 'receiptCipher');
  end loop;
  if jsonb_array_length(cipher_values) > 0 then
    perform private.consume_encrypted_note_retention_reservations(
      p_owner_id, p_claim_id, cipher_values
    );
  end if;

  for command_receipt in
    select supplied.item
    from jsonb_array_elements(p_command -> 'receipts') as supplied(item)
    order by supplied.item ->> 'captureId'
  loop
    select * into receipt_row from public.capture_receipts as receipt
    where receipt.capture_id = command_receipt ->> 'captureId'
      and receipt.user_id = p_owner_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    update public.capture_receipts as receipt
    set review_item_id = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.review_item_id
        else null
      end,
      mutation_id = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.mutation_id
        when command_receipt #>> '{projection,mode}' = 'routed'
          then command_receipt #>> '{projection,primary,mutationId}'
        else null
      end,
      outcome = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.outcome
        when command_receipt #>> '{projection,mode}' = 'routed'
          then 'added_to_note'
        else 'kept_in_inbox'
      end,
      headline = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.headline
        when command_receipt #>> '{projection,mode}' = 'routed'
          then 'Updated note after retention'
        else 'Kept in Inbox after note expired'
      end,
      destination_note_id = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.destination_note_id
        when command_receipt #>> '{projection,mode}' = 'routed'
          then command_receipt #>> '{projection,primary,noteId}'
        else null
      end,
      inserted_content = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.inserted_content
        when command_receipt #>> '{projection,mode}' = 'routed'
          then jsonb_build_array(jsonb_build_object(
            'mutationId', command_receipt
              #>> '{projection,primary,mutationId}'
          ))
        else '[]'::jsonb
      end,
      actions = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.actions
        else '[]'::jsonb
      end,
      reason_codes = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.reason_codes
        when 'destination_expired' = any(receipt.reason_codes)
          then receipt.reason_codes
        when cardinality(receipt.reason_codes) < 20
          then array_append(receipt.reason_codes, 'destination_expired')
        else receipt.reason_codes[1:19]
          || array['destination_expired']::text[]
      end,
      receipt_revision = (command_receipt ->> 'recordVersion')::integer,
      receipt_envelope = command_receipt -> 'receiptCipher' -> 'envelope',
      receipt_key_id = command_receipt -> 'receiptCipher' ->> 'keyId',
      receipt_key_class = (command_receipt -> 'receiptCipher' ->> 'keyClass')
        ::public.content_key_class,
      receipt_key_purpose = (command_receipt -> 'receiptCipher' ->> 'keyPurpose')
        ::public.content_key_purpose,
      receipt_key_version = (command_receipt -> 'receiptCipher' ->> 'keyVersion')
        ::integer
    where receipt.capture_id = command_receipt ->> 'captureId'
      and receipt.user_id = p_owner_id;
    if command_receipt #>> '{projection,mode}' = 'routed' then
      update public.organization_decisions as decision
      set destination_note_id = command_receipt
        #>> '{projection,primary,noteId}'
      where decision.id = receipt_row.decision_id
        and decision.user_id = p_owner_id
        and decision.capture_id = receipt_row.capture_id;
      if not found then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    end if;
    perform private.record_content_encryption_verification(
      p_owner_id, 'capture_receipt', command_receipt ->> 'captureId',
      (command_receipt ->> 'recordVersion')::integer,
      command_receipt -> 'receiptCipher' -> 'envelope',
      command_receipt -> 'verificationMac'
    );
  end loop;

  with changed as (
    update public.captures as capture
    set status = case when exists (
          select 1 from public.capture_receipts as routed_receipt
          where routed_receipt.capture_id = capture.id
            and routed_receipt.user_id = capture.user_id
            and routed_receipt.outcome in ('created_note', 'added_to_note')
        ) then 'organized'::public.capture_status
        else 'inbox'::public.capture_status end,
      last_error_code = null,
      explicit_destination_note_id = case
        when capture.explicit_destination_note_id = claim_row.note_id
          then null else capture.explicit_destination_note_id end
    where capture.id = any(live_capture_ids)
      and capture.user_id = p_owner_id
      and capture.deleted_at is null and capture.status <> 'deleted'
    returning capture.id
  ) select coalesce(array_agg(changed.id order by changed.id), array[]::text[])
    into changed_capture_ids from changed;
  update public.organization_decisions as decision
  set destination_note_id = null
  where decision.destination_note_id = claim_row.note_id
    and decision.user_id = p_owner_id;
  delete from public.api_idempotency_records as idempotency
  where idempotency.user_id = p_owner_id
    and (
      (idempotency.request_resource_type = 'note'
        and idempotency.request_resource_id = claim_row.note_id)
      or idempotency.response_json #>> '{note,id}' = claim_row.note_id
      or idempotency.response_json #>> '{revision,noteId}' = claim_row.note_id
    );
  delete from public.user_events as event
  where event.user_id = p_owner_id and (
    event.entity_id = claim_row.note_id
    or event.entity_id in (
      select revision.id from public.note_revisions as revision
      where revision.note_id = claim_row.note_id
    )
    or event.entity_id in (
      select mutation.id from public.note_mutations as mutation
      where mutation.note_id = claim_row.note_id
    )
  );
  delete from public.notes as note
  where note.id = claim_row.note_id and note.user_id = p_owner_id
    and note.deleted_at = claim_row.note_deleted_at
    and note.deleted_at <= run_row.cutoff_at;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  -- Cascades remove the expired note's rows. Recompute generation counters
  -- from surviving encrypted notes/indexes and invalidate prior attestations
  -- with one revision-token increment per affected generation.
  update public.rag_index_generations as generation
  set expected_note_count = (
        select count(*)::integer from public.notes as remaining_note
        where remaining_note.user_id = p_owner_id
          and remaining_note.privacy = 'ai_assisted'
          and remaining_note.deleted_at is null
      ),
      indexed_note_count = (
        select count(*)::integer
        from public.note_rag_index as remaining_index
        join public.notes as indexed_note
          on indexed_note.user_id = remaining_index.user_id
          and indexed_note.id = remaining_index.note_id
        where remaining_index.user_id = p_owner_id
          and remaining_index.generation_id = generation.id
          and indexed_note.deleted_at is null
          and indexed_note.privacy = 'ai_assisted'
          and indexed_note.current_revision = remaining_index.indexed_revision
      ),
      revision_token = generation.revision_token + 1
  where generation.user_id = p_owner_id
    and generation.id = any(affected_generation_ids);

  receipt_count := jsonb_array_length(p_command -> 'receipts');
  update public.encrypted_note_retention_claims
  set state = 'committed', command_digest = command_digest_value,
    purged_capture_count = cardinality(changed_capture_ids),
    purged_receipt_count = receipt_count,
    completed_at = clock_timestamp()
  where claim_id = p_claim_id and state = 'prepared';
  update public.encrypted_note_retention_runs
  set state = 'complete', completed_at = clock_timestamp()
  where run_id = p_run_id and state = 'active'
    and not exists (
      select 1 from public.encrypted_note_retention_claims
      where run_id = p_run_id and state = 'prepared'
    );
  for event_capture_id in
    select distinct changed.capture_id from unnest(
      claim_row.receipt_capture_ids || changed_capture_ids
    ) as changed(capture_id) order by changed.capture_id
  loop
    perform private.emit_user_event(p_owner_id, 'capture_receipt', event_capture_id);
    perform private.emit_user_event(p_owner_id, 'capture', event_capture_id);
  end loop;
  perform private.emit_user_event(p_owner_id, 'note_purged', claim_row.note_id);
  return jsonb_build_object(
    'claimId', p_claim_id, 'noteId', claim_row.note_id,
    'purged', true, 'purgedCaptureCount', cardinality(changed_capture_ids),
    'purgedReceiptCount', receipt_count, 'replayed', false
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

-- The legacy worker remains available for expanded owners only. An explicit
-- encrypted owner fails closed; global mixed-owner batches skip encrypted
-- candidates so plaintext SQL can never rewrite an encrypted receipt.
do $$
declare
  definition_value text;
  predicate_anchor text :=
    '(p_owner_id is null or note_record.user_id = p_owner_id)';
  predicate_replacement text := predicate_anchor || E'\n      and not exists (\n        select 1 from public.content_encryption_rollouts as retention_rollout\n        where retention_rollout.user_id = note_record.user_id\n          and retention_rollout.state in (\n            ''dual_write'', ''encrypted_read'', ''encrypted_only'', ''contracted''\n          )\n      )';
  cutoff_anchor text := E'  cutoff_at := p_now - interval ''30 days'';';
  cutoff_replacement text := E'  if p_owner_id is not null and exists (\n    select 1 from public.content_encryption_rollouts as retention_rollout\n    where retention_rollout.user_id = p_owner_id\n      and retention_rollout.state in (\n        ''dual_write'', ''encrypted_read'', ''encrypted_only'', ''contracted''\n      )\n  ) then\n    raise exception using errcode = ''P0001'', message = ''encrypted_retention_required'';\n  end if;\n\n' || cutoff_anchor;
begin
  select pg_catalog.pg_get_functiondef(
    'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'
      ::regprocedure
  ) into definition_value;
  if (length(definition_value)
      - length(replace(definition_value, predicate_anchor, '')))
      / length(predicate_anchor) <> 2
    or pg_catalog.strpos(definition_value, cutoff_anchor) = 0
  then
    raise exception 'legacy retention source anchors changed';
  end if;
  definition_value := replace(
    definition_value, predicate_anchor, predicate_replacement
  );
  definition_value := replace(
    definition_value, cutoff_anchor, cutoff_replacement
  );
  execute definition_value;
end;
$$;

revoke execute on function private.encrypted_note_retention_snapshot(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function private.encrypted_note_retention_claim_projection(
  public.encrypted_note_retention_claims, boolean
) from public, anon, authenticated, service_role;
revoke execute on function private.consume_encrypted_note_retention_reservations(
  uuid, uuid, jsonb
) from public, anon, authenticated, service_role;
revoke execute on function public.claim_encrypted_note_retention(
  uuid, uuid, uuid, timestamptz, integer, boolean, integer
) from public, anon, authenticated;
revoke execute on function public.cancel_encrypted_note_retention_claim(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
revoke execute on function public.commit_encrypted_note_retention(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.claim_encrypted_note_retention(
  uuid, uuid, uuid, timestamptz, integer, boolean, integer
) to service_role;
grant execute on function public.cancel_encrypted_note_retention_claim(
  uuid, uuid, uuid, uuid
) to service_role;
grant execute on function public.commit_encrypted_note_retention(
  uuid, uuid, uuid, uuid, jsonb
) to service_role;
