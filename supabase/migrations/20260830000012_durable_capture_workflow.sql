-- Milestone C durable capture workflow.
--
-- Captures are accepted exactly once, jobs are leased rather than merely
-- marked "running", and every externally visible state transition emits a
-- user event. Authenticated clients can only use the owner-scoped RPCs below;
-- workflow mutation remains service-role-only.

create or replace function private.valid_capture_content_envelope(
  envelope_value jsonb,
  owner_id uuid,
  capture_id_value text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((envelope_value is not null
    and jsonb_typeof(envelope_value) = 'object'
    and octet_length(envelope_value::text) <= 1500000
    and (envelope_value - array[
      'version', 'suite', 'keyId', 'context', 'wrappedDataKey', 'payload'
    ]) = '{}'::jsonb
    and envelope_value ?& array[
      'version', 'suite', 'keyId', 'context', 'wrappedDataKey', 'payload'
    ]
    and jsonb_typeof(envelope_value -> 'version') = 'number'
    and envelope_value -> 'version' = '1'::jsonb
    and jsonb_typeof(envelope_value -> 'suite') = 'string'
    and envelope_value ->> 'suite' = 'A256GCM'
    and jsonb_typeof(envelope_value -> 'keyId') = 'string'
    and envelope_value ->> 'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and jsonb_typeof(envelope_value -> 'context') = 'object'
    and ((envelope_value -> 'context') - array[
      'tenantId', 'resourceId', 'recordVersion', 'kind'
    ]) = '{}'::jsonb
    and (envelope_value -> 'context') ?& array[
      'tenantId', 'resourceId', 'recordVersion', 'kind'
    ]
    and jsonb_typeof(envelope_value -> 'context' -> 'tenantId') = 'string'
    and envelope_value -> 'context' ->> 'tenantId' = owner_id::text
    and jsonb_typeof(envelope_value -> 'context' -> 'resourceId') = 'string'
    and envelope_value -> 'context' ->> 'resourceId' = capture_id_value
    and jsonb_typeof(envelope_value -> 'context' -> 'recordVersion') = 'number'
    and envelope_value -> 'context' -> 'recordVersion' = '1'::jsonb
    and jsonb_typeof(envelope_value -> 'context' -> 'kind') = 'string'
    and envelope_value -> 'context' ->> 'kind' = 'capture'
    and jsonb_typeof(envelope_value -> 'wrappedDataKey') = 'object'
    and ((envelope_value -> 'wrappedDataKey') - array['nonce', 'ciphertext']) = '{}'::jsonb
    and (envelope_value -> 'wrappedDataKey') ?& array['nonce', 'ciphertext']
    and jsonb_typeof(envelope_value -> 'wrappedDataKey' -> 'nonce') = 'string'
    and envelope_value -> 'wrappedDataKey' ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and jsonb_typeof(envelope_value -> 'wrappedDataKey' -> 'ciphertext') = 'string'
    and envelope_value -> 'wrappedDataKey' ->> 'ciphertext' ~ '^[A-Za-z0-9_-]{64}$'
    and jsonb_typeof(envelope_value -> 'payload') = 'object'
    and ((envelope_value -> 'payload') - array['nonce', 'ciphertext']) = '{}'::jsonb
    and (envelope_value -> 'payload') ?& array['nonce', 'ciphertext']
    and jsonb_typeof(envelope_value -> 'payload' -> 'nonce') = 'string'
    and envelope_value -> 'payload' ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and jsonb_typeof(envelope_value -> 'payload' -> 'ciphertext') = 'string'
    and envelope_value -> 'payload' ->> 'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    and char_length(envelope_value -> 'payload' ->> 'ciphertext')
      between 22 and 1499000), false);
$$;

-- A wrapping key intentionally never enters Postgres, so this migration cannot
-- truthfully or safely encrypt an already-populated plaintext deployment. Stop
-- before schema mutation and require the external, decrypt-and-verify backfill.
do $$
begin
  if exists (select 1 from public.captures limit 1) then
    raise exception using
      errcode = 'P0001',
      message = 'legacy_capture_encryption_backfill_required';
  end if;
end;
$$;

alter table public.captures
  add column content_envelope jsonb,
  add column content_fingerprint text,
  add column content_length integer,
  add constraint captures_encrypted_content_shape check (coalesce((
    (
      deleted_at is null
      and status <> 'deleted'
      and raw_text = '[encrypted]'
      and private.valid_capture_content_envelope(content_envelope, user_id, id)
      and content_fingerprint ~ '^[0-9a-f]{64}$'
      and content_length between 1 and 10000
    )
    or (
      deleted_at is not null
      and status = 'deleted'
      and raw_text = '[deleted]'
      and content_envelope is null
      and content_fingerprint is null
      and content_length is null
    )
  ), false));

-- The legacy column remains temporarily for forward compatibility with older
-- migrations and retention code, but it is no longer a content-bearing path.
create or replace function private.scrub_capture_plaintext()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.raw_text := case
    when new.deleted_at is not null then '[deleted]'
    when new.content_envelope is null then '[legacy encrypted content unavailable]'
    else '[encrypted]'
  end;
  return new;
end;
$$;

create trigger captures_scrub_plaintext
before insert or update of raw_text, content_envelope on public.captures
for each row execute function private.scrub_capture_plaintext();

alter table public.organization_jobs
  add column available_at timestamptz not null default now(),
  add column lease_owner text,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column last_heartbeat_at timestamptz,
  add column last_transition_lease_token uuid,
  add column last_transition_action text
    check (last_transition_action in ('completed', 'failed', 'recovered')),
  add column last_transition_request_hash text
    check (last_transition_request_hash ~ '^[0-9a-f]{64}$'),
  add column updated_at timestamptz not null default now(),
  add constraint organization_jobs_transition_shape check (
    (
      last_transition_lease_token is null
      and last_transition_action is null
      and last_transition_request_hash is null
    )
    or (
      last_transition_lease_token is not null
      and last_transition_action is not null
      and last_transition_request_hash is not null
    )
  ),
  add constraint organization_jobs_lease_shape check (
    (
      state = 'running'
      and lease_owner is not null
      and char_length(lease_owner) between 1 and 120
      and lease_token is not null
      and lease_expires_at is not null
      and last_heartbeat_at is not null
    )
    or (
      state <> 'running'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and last_heartbeat_at is null
    )
  );

create trigger organization_jobs_set_updated_at
before update on public.organization_jobs
for each row execute function public.set_updated_at();

create index organization_jobs_claimable
  on public.organization_jobs (available_at, created_at, id)
  where state in ('created', 'awaiting_retry');

create index organization_jobs_expired_lease
  on public.organization_jobs (lease_expires_at, id)
  where state = 'running';

create table public.capture_receipts (
  capture_id text primary key references public.captures(id) on delete cascade,
  job_id text not null unique references public.organization_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  decision_id text references public.organization_decisions(id),
  review_item_id text references public.review_items(id),
  mutation_id text references public.note_mutations(id),
  outcome text not null check (outcome in (
    'created_note', 'added_to_note', 'kept_in_inbox', 'needs_review', 'failed'
  )),
  headline text not null check (char_length(headline) between 1 and 240),
  destination_note_id text references public.notes(id),
  inserted_content jsonb not null default '[]'::jsonb
    check (jsonb_typeof(inserted_content) = 'array' and jsonb_array_length(inserted_content) <= 500),
  actions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 3),
  reason_codes text[] not null default '{}'
    check (cardinality(reason_codes) <= 20),
  created_at timestamptz not null default now(),
  check (
    (
      outcome in ('created_note', 'added_to_note')
      and destination_note_id is not null
      and decision_id is not null
      and mutation_id is not null
      and jsonb_array_length(inserted_content) > 0
    )
    or (
      outcome not in ('created_note', 'added_to_note')
      and destination_note_id is null
      and mutation_id is null
      and jsonb_array_length(inserted_content) = 0
      and jsonb_array_length(actions) = 0
    )
  ),
  check (outcome <> 'needs_review' or review_item_id is not null)
);

create index capture_receipts_user_created
  on public.capture_receipts (user_id, created_at desc, capture_id desc);

-- Retry acknowledgements are reconstructed from the live capture row. Keeping
-- its envelope out of the generic idempotency table prevents a deleted
-- capture from surviving as a replayable ciphertext snapshot.
alter table public.api_idempotency_records
  add constraint retry_capture_idempotency_content_free check (
    scope <> 'retry_capture'
    or response_json is null
    or not (coalesce(response_json -> 'capture', '{}'::jsonb) ? 'encryptedContent')
  );

alter table public.capture_receipts enable row level security;
alter table public.capture_receipts force row level security;
revoke all privileges on table public.capture_receipts from public, anon, authenticated;
grant all privileges on table public.capture_receipts to service_role;

create or replace function private.capture_processing_state(
  value public.capture_status
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case value
    when 'pending' then 'queued'
    when 'queued' then 'queued'
    when 'processing' then 'processing'
    when 'organized' then 'done'
    when 'inbox' then 'inbox'
    when 'needs_review' then 'needs_review'
    when 'failed' then 'failed'
    else null
  end;
$$;

create or replace function private.capture_contract_json(
  capture_value public.captures,
  status_override text default null,
  clear_error boolean default false
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', capture_value.id,
    'encryptedContent', case when capture_value.content_envelope is null then null else
      jsonb_build_object(
        'envelope', capture_value.content_envelope,
        'fingerprint', capture_value.content_fingerprint,
        'length', capture_value.content_length
      ) end,
    'source', capture_value.source,
    'deviceId', capture_value.device_id,
    'privacy', capture_value.privacy,
    'explicitDestinationNoteId', capture_value.explicit_destination_note_id,
    'expansionDisabled', capture_value.expansion_disabled,
    'clientCreatedAt', capture_value.client_created_at,
    'clientTimezone', capture_value.client_timezone,
    'receivedAt', capture_value.received_at,
    'status', coalesce(status_override, private.capture_processing_state(capture_value.status)),
    'lastErrorCode', case when clear_error then null else capture_value.last_error_code end
  );
$$;

create or replace function private.capture_request_fingerprint(
  capture_value public.captures
)
returns text
language sql
stable
set search_path = ''
as $$
  select private.request_hash(jsonb_build_object(
    'clientCaptureId', capture_value.id,
    'contentFingerprint', capture_value.content_fingerprint,
    'contentLength', capture_value.content_length,
    'source', capture_value.source,
    'deviceId', capture_value.device_id,
    'clientCreatedAt', capture_value.client_created_at,
    'clientTimezone', capture_value.client_timezone,
    'privacy', capture_value.privacy,
    'explicitDestinationNoteId', capture_value.explicit_destination_note_id,
    'expansionDisabled', capture_value.expansion_disabled
  ));
$$;

create or replace function private.capture_receipt_json(
  receipt_value public.capture_receipts
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'captureId', receipt_value.capture_id,
    'jobId', receipt_value.job_id,
    'decisionId', receipt_value.decision_id,
    'reviewItemId', receipt_value.review_item_id,
    'mutationId', receipt_value.mutation_id,
    'outcome', receipt_value.outcome,
    'headline', receipt_value.headline,
    'destination', case when receipt_value.destination_note_id is null then null else
      jsonb_build_object(
        'noteId', receipt_value.destination_note_id,
        'title', (
          select note.title from public.notes as note
          where note.id = receipt_value.destination_note_id
            and note.user_id = receipt_value.user_id
        )
      ) end,
    'insertedContentReferences', receipt_value.inserted_content,
    'encryptedContent', (
      select case when capture.content_envelope is null then null else
        jsonb_build_object(
          'envelope', capture.content_envelope,
          'fingerprint', capture.content_fingerprint,
          'length', capture.content_length
        ) end
      from public.captures as capture
      where capture.id = receipt_value.capture_id
        and capture.user_id = receipt_value.user_id
    ),
    'actions', receipt_value.actions,
    'reasonCodes', to_jsonb(receipt_value.reason_codes),
    'createdAt', receipt_value.created_at
  );
$$;

-- Older synthetic fixtures predate durable receipt rows. This read-only
-- projection truthfully derives their receipt from persisted decisions,
-- mutations, links, Review items, and generated blocks.
create or replace function private.derive_capture_receipt(
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
  receipt_row public.capture_receipts%rowtype;
  decision_row public.organization_decisions%rowtype;
  link_row public.capture_note_links%rowtype;
  mutation_row public.note_mutations%rowtype;
  review_row public.review_items%rowtype;
  note_title text;
  outcome_value text;
  headline_value text;
  inserted_value jsonb := '[]'::jsonb;
  actions_value jsonb := '[]'::jsonb;
  reason_values text[] := array[]::text[];
begin
  select * into receipt_row from public.capture_receipts
  where capture_id = p_capture_id;
  if found then
    return private.capture_receipt_json(receipt_row);
  end if;

  select * into capture_row from public.captures where id = p_capture_id;
  if not found or capture_row.status in ('pending', 'queued', 'processing', 'deleted') then
    return null;
  end if;
  select * into job_row from public.organization_jobs
  where capture_id = capture_row.id;
  if not found then return null; end if;

  select * into decision_row from public.organization_decisions
  where capture_id = capture_row.id and user_id = capture_row.user_id
  order by created_at desc, id desc limit 1;
  if found then reason_values := decision_row.reason_codes; end if;

  if capture_row.status = 'organized' then
    select * into link_row from public.capture_note_links
    where capture_id = capture_row.id
      and user_id = capture_row.user_id
      and relation = 'routed'
    order by created_at desc, note_id desc limit 1;
    if not found then return null; end if;
    select * into mutation_row from public.note_mutations
    where id = link_row.mutation_id and user_id = capture_row.user_id;
    if not found or decision_row.id is null then return null; end if;
    select title into note_title from public.notes
    where id = link_row.note_id and user_id = capture_row.user_id;
    if note_title is null then return null; end if;
    outcome_value := case when mutation_row.before_revision = 0
      then 'created_note' else 'added_to_note' end;
    headline_value := case when outcome_value = 'created_note'
      then 'Created note' else 'Added to note' end;
    if cardinality(link_row.inserted_item_ids) > 500
      or exists (
        select 1 from unnest(link_row.inserted_item_ids) as item_id
        where item_id !~ '^(itm|ent)_[0-9A-HJKMNP-TV-Z]{26}$'
      )
    then return null; end if;
    if cardinality(link_row.inserted_item_ids) = 0 then
      inserted_value := jsonb_build_array(jsonb_build_object(
        'type', 'captured', 'itemId', null
      ));
    else
      select jsonb_agg(jsonb_build_object(
        'type', 'captured', 'itemId', item_id
      ) order by ordinal)
      into inserted_value
      from unnest(link_row.inserted_item_ids) with ordinality as inserted(item_id, ordinal);
    end if;
    select inserted_value || coalesce(jsonb_agg(jsonb_build_object(
      'type', 'ai_generated', 'blockId', block.id
    ) order by block.created_at, block.id), '[]'::jsonb)
    into inserted_value
    from public.generated_blocks as block
    where block.user_id = capture_row.user_id
      and block.note_id = link_row.note_id
      and block.decision_id = decision_row.id;
    actions_value := jsonb_build_array(
      jsonb_build_object('type', 'open', 'noteId', link_row.note_id),
      jsonb_build_object(
        'type', 'undo', 'mutationId', mutation_row.id,
        'expectedRevision', mutation_row.after_revision
      )
    );
    return jsonb_build_object(
      'schemaVersion', 1,
      'captureId', capture_row.id,
      'jobId', job_row.id,
      'decisionId', decision_row.id,
      'reviewItemId', null,
      'mutationId', mutation_row.id,
      'outcome', outcome_value,
      'headline', headline_value,
      'destination', jsonb_build_object('noteId', link_row.note_id, 'title', note_title),
      'insertedContentReferences', inserted_value,
      'encryptedContent', case when capture_row.content_envelope is null then null else
        jsonb_build_object(
          'envelope', capture_row.content_envelope,
          'fingerprint', capture_row.content_fingerprint,
          'length', capture_row.content_length
        ) end,
      'actions', actions_value,
      'reasonCodes', to_jsonb(reason_values),
      'createdAt', coalesce(job_row.completed_at, capture_row.received_at)
    );
  end if;

  if capture_row.status = 'needs_review' then
    select * into review_row from public.review_items
    where capture_id = capture_row.id and user_id = capture_row.user_id
    order by created_at desc, id desc limit 1;
    if not found then return null; end if;
    outcome_value := 'needs_review';
    headline_value := 'Needs your review';
  elsif capture_row.status = 'inbox' then
    outcome_value := 'kept_in_inbox';
    headline_value := 'Kept in Inbox';
  else
    outcome_value := 'failed';
    headline_value := 'Could not organize this capture';
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'captureId', capture_row.id,
    'jobId', job_row.id,
    'decisionId', decision_row.id,
    'reviewItemId', review_row.id,
    'mutationId', null,
    'outcome', outcome_value,
    'headline', headline_value,
    'destination', null,
    'insertedContentReferences', '[]'::jsonb,
    'encryptedContent', case when capture_row.content_envelope is null then null else
      jsonb_build_object(
        'envelope', capture_row.content_envelope,
        'fingerprint', capture_row.content_fingerprint,
        'length', capture_row.content_length
      ) end,
    'actions', '[]'::jsonb,
    'reasonCodes', to_jsonb(reason_values),
    'createdAt', coalesce(job_row.completed_at, capture_row.received_at)
  );
end;
$$;

create or replace function public.claim_capture_jobs(
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
  job_row public.organization_jobs%rowtype;
  capture_row public.captures%rowtype;
  jobs_value jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_worker_id is null
    or char_length(btrim(p_worker_id)) not between 1 and 120
    or p_limit is null
    or p_limit not between 1 and 100
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for candidate in
    select job.id
    from public.organization_jobs as job
    join public.captures as capture on capture.id = job.capture_id
    where job.state in ('created', 'awaiting_retry')
      and job.available_at <= clock_timestamp()
      and job.attempt < 5
      and capture.deleted_at is null
      and capture.status in ('pending', 'queued')
      and capture.privacy = 'ai_assisted'
    order by job.available_at, job.created_at, job.id
    for update of job skip locked
    limit p_limit
  loop
    update public.organization_jobs
    set
      state = 'running',
      attempt = attempt + 1,
      lease_owner = btrim(p_worker_id),
      lease_token = extensions.gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp(),
      started_at = clock_timestamp(),
      completed_at = null,
      error_code = null,
      last_transition_lease_token = null,
      last_transition_action = null,
      last_transition_request_hash = null
    where id = candidate.id
    returning * into job_row;

    update public.captures
    set status = 'processing', last_error_code = null
    where id = job_row.capture_id and deleted_at is null
    returning * into capture_row;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;

    jobs_value := jobs_value || jsonb_build_array(jsonb_build_object(
      'jobId', job_row.id,
      'captureId', capture_row.id,
      'userId', job_row.user_id,
      'attempt', job_row.attempt,
      'leaseToken', job_row.lease_token,
      'leaseExpiresAt', job_row.lease_expires_at,
      'promptVersion', job_row.prompt_version,
      'schemaVersion', job_row.schema_version,
      'capture', private.capture_contract_json(capture_row)
    ));
    perform private.emit_user_event(job_row.user_id, 'organization_job', job_row.id);
    perform private.emit_user_event(job_row.user_id, 'capture', capture_row.id);
  end loop;

  return jsonb_build_object('jobs', jobs_value);
end;
$$;

create or replace function public.heartbeat_capture_job(
  p_job_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into job_row from public.organization_jobs
  where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from p_lease_token
    or job_row.lease_expires_at <= clock_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  update public.organization_jobs
  set
    last_heartbeat_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where id = job_row.id
  returning * into job_row;
  return jsonb_build_object(
    'jobId', job_row.id,
    'leaseExpiresAt', job_row.lease_expires_at
  );
end;
$$;

create or replace function public.complete_capture_job(
  p_job_id text,
  p_lease_token uuid,
  p_terminal_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  capture_row public.captures%rowtype;
  decision_row public.organization_decisions%rowtype;
  link_row public.capture_note_links%rowtype;
  mutation_row public.note_mutations%rowtype;
  review_row public.review_items%rowtype;
  receipt_row public.capture_receipts%rowtype;
  note_title text;
  outcome_value text;
  headline_value text;
  capture_status_value public.capture_status;
  inserted_value jsonb := '[]'::jsonb;
  actions_value jsonb := '[]'::jsonb;
  reason_values text[] := array[]::text[];
  completed_value timestamptz;
  transition_request_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_terminal_status is null
    or p_terminal_status not in ('done', 'inbox', 'needs_review')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into job_row from public.organization_jobs
  where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  completed_value := clock_timestamp();
  transition_request_hash := private.request_hash(jsonb_build_object(
    'action', 'complete', 'terminalStatus', p_terminal_status
  ));
  if job_row.last_transition_lease_token = p_lease_token
    and job_row.last_transition_action = 'completed'
  then
    if job_row.last_transition_request_hash is distinct from transition_request_hash then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    select * into receipt_row from public.capture_receipts
    where job_id = job_row.id;
    if not found then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    return jsonb_build_object(
      'jobId', job_row.id,
      'state', job_row.state,
      'receipt', private.capture_receipt_json(receipt_row),
      'replayed', true
    );
  end if;
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from p_lease_token
    or job_row.lease_expires_at <= completed_value
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into capture_row from public.captures
  where id = job_row.capture_id and user_id = job_row.user_id
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into decision_row from public.organization_decisions
  where capture_id = capture_row.id and user_id = capture_row.user_id
  order by created_at desc, id desc limit 1;
  if found then reason_values := decision_row.reason_codes; end if;

  if p_terminal_status = 'done' then
    if decision_row.id is null then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    select * into link_row from public.capture_note_links
    where capture_id = capture_row.id and user_id = capture_row.user_id
      and relation = 'routed'
    order by created_at desc, note_id desc limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    select * into mutation_row from public.note_mutations
    where id = link_row.mutation_id and user_id = capture_row.user_id;
    if not found or mutation_row.note_id <> link_row.note_id
      or decision_row.destination_note_id is distinct from link_row.note_id
    then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    select title into note_title from public.notes
    where id = link_row.note_id and user_id = capture_row.user_id
      and deleted_at is null;
    if note_title is null then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    outcome_value := case when mutation_row.before_revision = 0
      then 'created_note' else 'added_to_note' end;
    headline_value := case when outcome_value = 'created_note'
      then 'Created note' else 'Added to note' end;
    if cardinality(link_row.inserted_item_ids) > 500
      or exists (
        select 1 from unnest(link_row.inserted_item_ids) as item_id
        where item_id !~ '^(itm|ent)_[0-9A-HJKMNP-TV-Z]{26}$'
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    if cardinality(link_row.inserted_item_ids) = 0 then
      inserted_value := jsonb_build_array(jsonb_build_object(
        'type', 'captured', 'itemId', null
      ));
    else
      select jsonb_agg(jsonb_build_object(
        'type', 'captured', 'itemId', item_id
      ) order by ordinal)
      into inserted_value
      from unnest(link_row.inserted_item_ids) with ordinality as inserted(item_id, ordinal);
    end if;
    select inserted_value || coalesce(jsonb_agg(jsonb_build_object(
      'type', 'ai_generated', 'blockId', block.id
    ) order by block.created_at, block.id), '[]'::jsonb)
    into inserted_value
    from public.generated_blocks as block
    where block.user_id = capture_row.user_id
      and block.note_id = link_row.note_id
      and block.decision_id = decision_row.id;
    actions_value := jsonb_build_array(
      jsonb_build_object('type', 'open', 'noteId', link_row.note_id),
      jsonb_build_object(
        'type', 'undo', 'mutationId', mutation_row.id,
        'expectedRevision', mutation_row.after_revision
      )
    );
    capture_status_value := 'organized';
  elsif p_terminal_status = 'needs_review' then
    select * into review_row from public.review_items
    where capture_id = capture_row.id and user_id = capture_row.user_id
      and state = 'open'
    order by created_at desc, id desc limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
    outcome_value := 'needs_review';
    headline_value := 'Needs your review';
    capture_status_value := 'needs_review';
  else
    outcome_value := 'kept_in_inbox';
    headline_value := 'Kept in Inbox';
    capture_status_value := 'inbox';
  end if;

  insert into public.capture_receipts (
    capture_id, job_id, user_id, decision_id, review_item_id, mutation_id,
    outcome, headline, destination_note_id, inserted_content, actions,
    reason_codes, created_at
  ) values (
    capture_row.id, job_row.id, capture_row.user_id, decision_row.id,
    review_row.id, mutation_row.id, outcome_value, headline_value,
    link_row.note_id, inserted_value, actions_value, reason_values, completed_value
  )
  returning * into receipt_row;

  update public.organization_jobs
  set
    state = 'succeeded',
    completed_at = completed_value,
    error_code = null,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = p_lease_token,
    last_transition_action = 'completed',
    last_transition_request_hash = transition_request_hash
  where id = job_row.id
  returning * into job_row;
  update public.captures
  set status = capture_status_value, last_error_code = null
  where id = capture_row.id
  returning * into capture_row;

  perform private.emit_user_event(capture_row.user_id, 'capture_receipt', capture_row.id);
  perform private.emit_user_event(capture_row.user_id, 'organization_job', job_row.id);
  perform private.emit_user_event(capture_row.user_id, 'capture', capture_row.id);
  return jsonb_build_object(
    'jobId', job_row.id,
    'state', job_row.state,
    'receipt', private.capture_receipt_json(receipt_row),
    'replayed', false
  );
end;
$$;

create or replace function public.fail_capture_job(
  p_job_id text,
  p_lease_token uuid,
  p_error_code public.safe_error_code,
  p_retryable boolean,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  capture_row public.captures%rowtype;
  receipt_row public.capture_receipts%rowtype;
  decision_id_value text;
  reason_values text[] := array[]::text[];
  retry_at_value timestamptz;
  delay_seconds integer;
  transition_value timestamptz;
  terminal_value boolean;
  transition_request_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null or p_error_code is null or p_retryable is null
    or (p_retry_after_seconds is not null
      and p_retry_after_seconds not between 1 and 3600)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into job_row from public.organization_jobs
  where id = p_job_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  transition_value := clock_timestamp();
  transition_request_hash := private.request_hash(jsonb_build_object(
    'action', 'fail',
    'errorCode', p_error_code,
    'retryable', p_retryable,
    'retryAfterSeconds', p_retry_after_seconds
  ));
  if job_row.last_transition_lease_token = p_lease_token
    and job_row.last_transition_action = 'failed'
  then
    if job_row.last_transition_request_hash is distinct from transition_request_hash then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    select * into capture_row from public.captures where id = job_row.capture_id;
    select * into receipt_row from public.capture_receipts where job_id = job_row.id;
    return jsonb_build_object(
      'jobId', job_row.id,
      'state', job_row.state,
      'captureStatus', private.capture_processing_state(capture_row.status),
      'retryAt', case when job_row.state = 'awaiting_retry' then job_row.available_at else null end,
      'receipt', case when receipt_row.capture_id is null then null
        else private.capture_receipt_json(receipt_row) end,
      'replayed', true
    );
  end if;
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from p_lease_token
    or job_row.lease_expires_at <= transition_value
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into capture_row from public.captures
  where id = job_row.capture_id and user_id = job_row.user_id
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  terminal_value := not p_retryable or job_row.attempt >= 5;
  if not terminal_value then
    delay_seconds := coalesce(
      p_retry_after_seconds,
      least(300, 5 * (2 ^ greatest(job_row.attempt - 1, 0))::integer)
    );
    retry_at_value := transition_value + make_interval(secs => delay_seconds);
    update public.organization_jobs
    set
      state = 'awaiting_retry',
      available_at = retry_at_value,
      error_code = p_error_code,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = p_lease_token,
      last_transition_action = 'failed',
      last_transition_request_hash = transition_request_hash
    where id = job_row.id
    returning * into job_row;
    update public.captures
    set status = 'queued', last_error_code = p_error_code
    where id = capture_row.id
    returning * into capture_row;
  else
    select decision.id, decision.reason_codes
    into decision_id_value, reason_values
    from public.organization_decisions as decision
    where decision.capture_id = capture_row.id and decision.user_id = capture_row.user_id
    order by decision.created_at desc, decision.id desc limit 1;
    insert into public.capture_receipts (
      capture_id, job_id, user_id, decision_id, outcome, headline,
      inserted_content, actions, reason_codes, created_at
    ) values (
      capture_row.id, job_row.id, capture_row.user_id, decision_id_value,
      'failed', 'Could not organize this capture', '[]'::jsonb,
      '[]'::jsonb, coalesce(reason_values, '{}'), transition_value
    )
    returning * into receipt_row;
    update public.organization_jobs
    set
      state = case when attempt >= 5
        then 'dead_letter'::public.job_state
        else 'failed'::public.job_state
      end,
      completed_at = transition_value,
      error_code = p_error_code,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = p_lease_token,
      last_transition_action = 'failed',
      last_transition_request_hash = transition_request_hash
    where id = job_row.id
    returning * into job_row;
    update public.captures
    set status = 'failed', last_error_code = p_error_code
    where id = capture_row.id
    returning * into capture_row;
    perform private.emit_user_event(capture_row.user_id, 'capture_receipt', capture_row.id);
  end if;

  perform private.emit_user_event(capture_row.user_id, 'organization_job', job_row.id);
  perform private.emit_user_event(capture_row.user_id, 'capture', capture_row.id);
  return jsonb_build_object(
    'jobId', job_row.id,
    'state', job_row.state,
    'captureStatus', private.capture_processing_state(capture_row.status),
    'retryAt', retry_at_value,
    'receipt', case when receipt_row.capture_id is null then null
      else private.capture_receipt_json(receipt_row) end,
    'replayed', false
  );
end;
$$;

drop function public.create_capture_with_job(jsonb);

create function public.create_capture_with_job(
  p_owner_id uuid,
  p_capture jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := p_owner_id;
  capture_id_value text;
  source_value public.capture_source;
  envelope_value jsonb;
  content_fingerprint_value text;
  content_length_value integer;
  device_value text;
  created_value timestamptz;
  timezone_value text;
  privacy_value public.privacy_mode;
  destination_value text;
  expansion_value boolean;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  expected_fingerprint text;
  inserted_value boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_capture is null
    or jsonb_typeof(p_capture) <> 'object'
    or (p_capture - array[
      'clientCaptureId', 'contentEnvelope', 'contentFingerprint',
      'contentLength', 'source', 'deviceId',
      'clientCreatedAt', 'clientTimezone', 'privacy',
      'explicitDestinationNoteId', 'expansionDisabled'
    ]) <> '{}'::jsonb
    or not (p_capture ?& array[
      'clientCaptureId', 'contentEnvelope', 'contentFingerprint',
      'contentLength', 'source',
      'clientCreatedAt', 'clientTimezone'
    ])
    or jsonb_typeof(p_capture -> 'clientCaptureId') <> 'string'
    or jsonb_typeof(p_capture -> 'contentEnvelope') <> 'object'
    or jsonb_typeof(p_capture -> 'contentFingerprint') <> 'string'
    or jsonb_typeof(p_capture -> 'contentLength') <> 'number'
    or jsonb_typeof(p_capture -> 'source') <> 'string'
    or jsonb_typeof(p_capture -> 'clientCreatedAt') <> 'string'
    or jsonb_typeof(p_capture -> 'clientTimezone') <> 'string'
    or (p_capture ? 'deviceId' and jsonb_typeof(p_capture -> 'deviceId') <> 'string')
    or (p_capture ? 'privacy' and jsonb_typeof(p_capture -> 'privacy') <> 'string')
    or (p_capture ? 'explicitDestinationNoteId'
      and jsonb_typeof(p_capture -> 'explicitDestinationNoteId') <> 'string')
    or (p_capture ? 'expansionDisabled'
      and jsonb_typeof(p_capture -> 'expansionDisabled') <> 'boolean')
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;

  capture_id_value := p_capture ->> 'clientCaptureId';
  envelope_value := p_capture -> 'contentEnvelope';
  content_fingerprint_value := p_capture ->> 'contentFingerprint';
  device_value := coalesce(p_capture ->> 'deviceId', '');
  timezone_value := p_capture ->> 'clientTimezone';
  destination_value := nullif(p_capture ->> 'explicitDestinationNoteId', '');
  expansion_value := coalesce((p_capture ->> 'expansionDisabled')::boolean, false);
  if capture_id_value !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or content_fingerprint_value !~ '^[0-9a-f]{64}$'
    or p_capture ->> 'contentLength' !~ '^[1-9][0-9]{0,4}$'
    or (p_capture ->> 'contentLength')::numeric > 10000
    or char_length(device_value) > 120
    or char_length(timezone_value) not between 1 and 100
    or not private.valid_iso_offset_datetime(p_capture ->> 'clientCreatedAt')
    or (destination_value is not null
      and destination_value !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$')
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  content_length_value := (p_capture ->> 'contentLength')::integer;
  if not private.valid_capture_content_envelope(
    envelope_value, owner_id, capture_id_value
  ) then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  begin
    source_value := (p_capture ->> 'source')::public.capture_source;
    privacy_value := coalesce(
      (p_capture ->> 'privacy')::public.privacy_mode,
      'ai_assisted'::public.privacy_mode
    );
    created_value := (p_capture ->> 'clientCreatedAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end;
  if destination_value is not null and not exists (
    select 1 from public.notes
    where id = destination_value and user_id = owner_id and deleted_at is null
  ) then
    raise exception using errcode = '42501', message = 'explicit_destination_not_owned';
  end if;

  expected_fingerprint := private.request_hash(jsonb_build_object(
    'clientCaptureId', capture_id_value,
    'contentFingerprint', content_fingerprint_value,
    'contentLength', content_length_value,
    'source', source_value,
    'deviceId', device_value,
    'clientCreatedAt', created_value,
    'clientTimezone', timezone_value,
    'privacy', privacy_value,
    'explicitDestinationNoteId', destination_value,
    'expansionDisabled', expansion_value
  ));

  insert into public.captures (
    id, user_id, source, device_id, raw_text,
    content_envelope, content_fingerprint, content_length, privacy,
    explicit_destination_note_id, expansion_disabled,
    client_created_at, client_timezone, status
  ) values (
    capture_id_value, owner_id, source_value, device_value, '[encrypted]',
    envelope_value, content_fingerprint_value, content_length_value,
    privacy_value, destination_value, expansion_value,
    created_value, timezone_value, 'queued'
  )
  on conflict (id) do nothing
  returning * into capture_row;
  inserted_value := found;

  if not inserted_value then
    select * into capture_row from public.captures
    where id = capture_id_value and user_id = owner_id;
    if not found then
      raise exception using errcode = '23505', message = 'capture_id_conflict';
    end if;
    if capture_row.deleted_at is not null
      or private.capture_request_fingerprint(capture_row) <> expected_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
  end if;

  insert into public.organization_jobs (
    capture_id, user_id, state, prompt_version, schema_version, available_at
  ) values (
    capture_id_value, owner_id, 'created', 'routing-v1', 1, now()
  )
  on conflict (capture_id) do nothing
  returning * into job_row;
  if not found then
    select * into job_row from public.organization_jobs
    where capture_id = capture_id_value and user_id = owner_id;
  end if;
  if job_row.id is null then
    raise exception using errcode = '23505', message = 'capture_job_conflict';
  end if;

  -- Private-manual content is never made claimable by the organization worker.
  -- It settles directly into Inbox with a no-effects receipt; future E2EE mode
  -- can replace the wrapping key without changing this workflow boundary.
  if inserted_value and privacy_value = 'private_manual' then
    update public.organization_jobs
    set state = 'succeeded', completed_at = clock_timestamp()
    where id = job_row.id
    returning * into job_row;
    update public.captures
    set status = 'inbox'
    where id = capture_row.id
    returning * into capture_row;
    insert into public.capture_receipts (
      capture_id, job_id, user_id, outcome, headline,
      inserted_content, actions, reason_codes
    ) values (
      capture_row.id, job_row.id, owner_id, 'kept_in_inbox',
      'Kept private in Inbox', '[]'::jsonb, '[]'::jsonb,
      array['private_manual']
    );
    perform private.emit_user_event(owner_id, 'capture_receipt', capture_row.id);
  end if;

  if inserted_value then
    perform private.emit_user_event(owner_id, 'capture', capture_row.id);
    perform private.emit_user_event(owner_id, 'organization_job', job_row.id);
  end if;

  -- The create response is the immutable acceptance snapshot. A replay can
  -- therefore acknowledge a locally queued item even if its durable job has
  -- already advanced while the first HTTP response was lost.
  return jsonb_build_object(
    'capture', private.capture_contract_json(capture_row, 'queued', true)
      - 'encryptedContent',
    'jobId', job_row.id,
    'replayed', not inserted_value
  );
end;
$$;

create or replace function public.recover_stale_capture_jobs(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  job_row public.organization_jobs%rowtype;
  capture_row public.captures%rowtype;
  decision_id_value text;
  reason_values text[];
  old_lease_token uuid;
  recovered_count integer := 0;
  requeued_count integer := 0;
  failed_count integer := 0;
  transition_value timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for candidate in
    select id from public.organization_jobs
    where state = 'running' and lease_expires_at <= transition_value
    order by lease_expires_at, id
    for update skip locked
    limit p_limit
  loop
    select * into job_row from public.organization_jobs
    where id = candidate.id for update;
    select * into capture_row from public.captures
    where id = job_row.capture_id for update;
    old_lease_token := job_row.lease_token;
    recovered_count := recovered_count + 1;

    if capture_row.deleted_at is null and job_row.attempt < 5 then
      update public.organization_jobs
      set
        state = 'awaiting_retry',
        available_at = transition_value + make_interval(
          secs => least(300, 5 * (2 ^ greatest(attempt - 1, 0))::integer)
        ),
        error_code = 'provider_unavailable',
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        last_transition_lease_token = old_lease_token,
        last_transition_action = 'recovered',
        last_transition_request_hash = private.request_hash(jsonb_build_object(
          'action', 'recover', 'jobId', job_row.id, 'leaseToken', old_lease_token
        ))
      where id = job_row.id
      returning * into job_row;
      update public.captures
      set status = 'queued', last_error_code = 'provider_unavailable'
      where id = capture_row.id
      returning * into capture_row;
      requeued_count := requeued_count + 1;
    elsif capture_row.deleted_at is null then
      select decision.id, decision.reason_codes
      into decision_id_value, reason_values
      from public.organization_decisions as decision
      where decision.capture_id = capture_row.id
        and decision.user_id = capture_row.user_id
      order by decision.created_at desc, decision.id desc limit 1;
      insert into public.capture_receipts (
        capture_id, job_id, user_id, decision_id, outcome, headline,
        inserted_content, actions, reason_codes, created_at
      ) values (
        capture_row.id, job_row.id, capture_row.user_id, decision_id_value,
        'failed', 'Could not organize this capture', '[]'::jsonb,
        '[]'::jsonb, coalesce(reason_values, '{}'), transition_value
      )
      on conflict (capture_id) do nothing;
      update public.organization_jobs
      set
        state = 'dead_letter',
        completed_at = transition_value,
        error_code = 'provider_unavailable',
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        last_transition_lease_token = old_lease_token,
        last_transition_action = 'recovered',
        last_transition_request_hash = private.request_hash(jsonb_build_object(
          'action', 'recover', 'jobId', job_row.id, 'leaseToken', old_lease_token
        ))
      where id = job_row.id
      returning * into job_row;
      update public.captures
      set status = 'failed', last_error_code = 'provider_unavailable'
      where id = capture_row.id
      returning * into capture_row;
      failed_count := failed_count + 1;
      perform private.emit_user_event(capture_row.user_id, 'capture_receipt', capture_row.id);
    else
      update public.organization_jobs
      set
        state = 'failed',
        completed_at = transition_value,
        error_code = 'not_found',
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        last_transition_lease_token = old_lease_token,
        last_transition_action = 'recovered',
        last_transition_request_hash = private.request_hash(jsonb_build_object(
          'action', 'recover', 'jobId', job_row.id, 'leaseToken', old_lease_token
        ))
      where id = job_row.id
      returning * into job_row;
    end if;

    perform private.emit_user_event(job_row.user_id, 'organization_job', job_row.id);
    perform private.emit_user_event(job_row.user_id, 'capture', capture_row.id);
  end loop;

  return jsonb_build_object(
    'recovered', recovered_count,
    'requeued', requeued_count,
    'failed', failed_count
  );
end;
$$;

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
declare
  owner_id uuid := p_owner_id;
  cursor_value jsonb;
  cursor_received timestamptz;
  cursor_id text;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  items_value jsonb := '[]'::jsonb;
  item_count integer := 0;
  has_more_value boolean := false;
  next_cursor_value text;
  last_received timestamptz;
  last_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_limit is null
    or p_limit not between 1 and 100
    or (p_status is not null and p_status not in (
      'queued', 'processing', 'done', 'needs_review', 'failed', 'inbox'
    ))
    or (p_from is not null and p_to is not null and p_from >= p_to)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_cursor is not null then
    begin
      if char_length(p_cursor) not between 1 and 512 then raise data_exception; end if;
      cursor_value := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
      if jsonb_typeof(cursor_value) <> 'object'
        or (cursor_value - array['receivedAt', 'id']) <> '{}'::jsonb
        or not (cursor_value ?& array['receivedAt', 'id'])
        or jsonb_typeof(cursor_value -> 'receivedAt') <> 'string'
        or jsonb_typeof(cursor_value -> 'id') <> 'string'
        or not private.valid_iso_offset_datetime(cursor_value ->> 'receivedAt')
        or cursor_value ->> 'id' !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
      then raise data_exception; end if;
      cursor_received := (cursor_value ->> 'receivedAt')::timestamptz;
      cursor_id := cursor_value ->> 'id';
    exception when others then
      raise exception using errcode = '22023', message = 'validation_failed';
    end;
  end if;

  for capture_row in
    select capture.*
    from public.captures as capture
    join public.organization_jobs as job on job.capture_id = capture.id
    where capture.user_id = owner_id
      and capture.deleted_at is null
      and capture.status <> 'deleted'
      and (p_status is null
        or private.capture_processing_state(capture.status) = p_status)
      and (p_from is null or capture.client_created_at >= p_from)
      and (p_to is null or capture.client_created_at < p_to)
      and (cursor_received is null
        or (capture.received_at, capture.id) < (cursor_received, cursor_id))
    order by capture.received_at desc, capture.id desc
    limit p_limit + 1
  loop
    select * into job_row from public.organization_jobs
    where capture_id = capture_row.id and user_id = owner_id;
    item_count := item_count + 1;
    if item_count > p_limit then
      has_more_value := true;
      exit;
    end if;
    items_value := items_value || jsonb_build_array(jsonb_build_object(
      'id', capture_row.id,
      'jobId', job_row.id,
      'encryptedContent', case when capture_row.content_envelope is null then null else
        jsonb_build_object(
          'envelope', capture_row.content_envelope,
          'fingerprint', capture_row.content_fingerprint,
          'length', capture_row.content_length
        ) end,
      'source', capture_row.source,
      'privacy', capture_row.privacy,
      'clientCreatedAt', capture_row.client_created_at,
      'receivedAt', capture_row.received_at,
      'status', private.capture_processing_state(capture_row.status),
      'lastErrorCode', capture_row.last_error_code,
      'receiptAvailable', capture_row.status not in ('pending', 'queued', 'processing')
    ));
    last_received := capture_row.received_at;
    last_id := capture_row.id;
  end loop;
  if has_more_value then
    next_cursor_value := replace(encode(convert_to(jsonb_build_object(
      'receivedAt', last_received, 'id', last_id
    )::text, 'utf8'), 'base64'), E'\n', '');
  end if;
  return jsonb_build_object(
    'items', items_value,
    'pageInfo', jsonb_build_object(
      'hasMore', has_more_value,
      'nextCursor', next_cursor_value
    )
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
declare
  owner_id uuid := p_owner_id;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  receipt_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  select * into capture_row from public.captures
  where id = p_capture_id and user_id = owner_id
    and deleted_at is null and status <> 'deleted';
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into job_row from public.organization_jobs
  where capture_id = capture_row.id and user_id = owner_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if capture_row.status not in ('pending', 'queued', 'processing') then
    receipt_value := private.derive_capture_receipt(capture_row.id);
    if receipt_value is null then
      raise exception using errcode = 'P0001', message = 'invalid_plan';
    end if;
  end if;
  return jsonb_build_object(
    'capture', private.capture_contract_json(capture_row)
      || jsonb_build_object('jobId', job_row.id, 'receipt', receipt_value)
  );
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
declare
  owner_id uuid := p_owner_id;
  receipt_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if not exists (
    select 1 from public.captures
    where id = p_capture_id and user_id = owner_id
      and deleted_at is null and status <> 'deleted'
  ) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  receipt_value := private.derive_capture_receipt(p_capture_id);
  if receipt_value is null then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return jsonb_build_object('receipt', receipt_value);
end;
$$;

create or replace function public.retry_capture(
  p_owner_id uuid,
  p_capture_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := p_owner_id;
  claim jsonb;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  response_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  claim := private.claim_idempotency(
    owner_id, p_idempotency_key, 'retry_capture',
    jsonb_build_object('captureId', p_capture_id)
  );
  if (claim ->> 'replayed')::boolean then
    select * into capture_row from public.captures
    where id = p_capture_id and user_id = owner_id
      and deleted_at is null and status <> 'deleted';
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    return jsonb_set(
      (claim -> 'response') || jsonb_build_object('replayed', true),
      '{capture}',
      (claim -> 'response' -> 'capture') || jsonb_build_object(
        'encryptedContent', private.capture_contract_json(capture_row) -> 'encryptedContent'
      )
    );
  end if;
  select * into job_row from public.organization_jobs
  where capture_id = p_capture_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into capture_row from public.captures
  where id = p_capture_id and user_id = owner_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if capture_row.status <> 'failed'
    or job_row.state not in ('failed', 'dead_letter')
  then
    raise exception using errcode = 'P0001', message = 'invalid_plan';
  end if;
  delete from public.capture_receipts where capture_id = capture_row.id;
  update public.organization_jobs
  set
    state = 'created',
    attempt = 0,
    available_at = clock_timestamp(),
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
  where id = job_row.id
  returning * into job_row;
  update public.captures
  set status = 'queued', last_error_code = null
  where id = capture_row.id
  returning * into capture_row;
  perform private.emit_user_event(owner_id, 'organization_job', job_row.id);
  perform private.emit_user_event(owner_id, 'capture', capture_row.id);
  response_value := jsonb_build_object(
    'capture', private.capture_contract_json(capture_row),
    'jobId', job_row.id,
    'replayed', false
  );
  perform private.finish_idempotency(
    owner_id,
    p_idempotency_key,
    jsonb_set(
      response_value,
      '{capture}',
      (response_value -> 'capture') - 'encryptedContent'
    )
  );
  return response_value;
end;
$$;

-- The public undo RPC keeps its authenticated-user contract while capture
-- deletion uses the same reviewed mutation core with a server-derived owner.
-- This avoids synthesizing user JWT claims inside a service-only function.
create or replace function private.undo_user_mutation_for_owner(
  p_owner_id uuid,
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
  owner_id uuid := p_owner_id;
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
    raise exception using errcode = '22023', message = 'validation_failed';
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
begin
  if owner_id is null then
    raise exception using errcode = '42501', message = 'unauthorized';
  end if;
  return private.undo_user_mutation_for_owner(
    owner_id,
    p_mutation_id,
    p_expected_revision,
    p_idempotency_key
  );
end;
$$;

create or replace function public.delete_capture(
  p_owner_id uuid,
  p_capture_id text,
  p_idempotency_key text,
  p_remove_inserted_content boolean default false,
  p_expected_note_revisions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := p_owner_id;
  claim jsonb;
  capture_row public.captures%rowtype;
  job_row public.organization_jobs%rowtype;
  note_row public.notes%rowtype;
  mutation_row public.note_mutations%rowtype;
  link_group record;
  expected_revision_value integer;
  undo_response jsonb;
  source_note_ids jsonb := '[]'::jsonb;
  removal_mutations jsonb := '[]'::jsonb;
  deleted_value timestamptz;
  response_value jsonb;
  linked_note_count integer;
  expected_note_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_capture_id is null
    or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_remove_inserted_content is null
    or p_expected_note_revisions is null
    or jsonb_typeof(p_expected_note_revisions) <> 'array'
    or jsonb_array_length(p_expected_note_revisions) > 100
    or exists (
      select 1 from jsonb_array_elements(p_expected_note_revisions) as expected
      where jsonb_typeof(expected) <> 'object'
        or (expected - array['noteId', 'expectedRevision']) <> '{}'::jsonb
        or not (expected ?& array['noteId', 'expectedRevision'])
        or jsonb_typeof(expected -> 'noteId') <> 'string'
        or expected ->> 'noteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
        or jsonb_typeof(expected -> 'expectedRevision') <> 'number'
        or expected ->> 'expectedRevision' !~ '^[1-9][0-9]*$'
        or (expected ->> 'expectedRevision')::numeric > 2147483647
    )
    or (
      select count(*) <> count(distinct expected ->> 'noteId')
      from jsonb_array_elements(p_expected_note_revisions) as expected
    )
    or (not p_remove_inserted_content
      and jsonb_array_length(p_expected_note_revisions) > 0)
    or (p_remove_inserted_content
      and jsonb_array_length(p_expected_note_revisions) = 0)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  claim := private.claim_idempotency(
    owner_id, p_idempotency_key, 'delete_capture',
    jsonb_build_object(
      'captureId', p_capture_id,
      'removeInsertedContent', p_remove_inserted_content,
      'expectedNoteRevisions', p_expected_note_revisions
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;
  select * into job_row from public.organization_jobs
  where capture_id = p_capture_id and user_id = owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into capture_row from public.captures
  where id = p_capture_id and user_id = owner_id and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select coalesce(jsonb_agg(note_id order by note_id), '[]'::jsonb), count(*)
  into source_note_ids, linked_note_count
  from (
    select distinct note_id from public.capture_note_links
    where capture_id = capture_row.id and user_id = owner_id
  ) as linked;
  expected_note_count := jsonb_array_length(p_expected_note_revisions);
  if p_remove_inserted_content and (
    expected_note_count <> linked_note_count
    or exists (
      select 1 from jsonb_array_elements(p_expected_note_revisions) as expected
      where not exists (
        select 1 from public.capture_note_links as linked
        where linked.capture_id = capture_row.id
          and linked.user_id = owner_id
          and linked.note_id = expected ->> 'noteId'
      )
    )
  ) then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  deleted_value := clock_timestamp();

  if p_remove_inserted_content then
    for link_group in
      select note_id, min(mutation_id) as mutation_id,
        count(distinct mutation_id) as mutation_count
      from public.capture_note_links
      where capture_id = capture_row.id and user_id = owner_id
      group by note_id
      order by note_id
    loop
      if link_group.mutation_count <> 1 then
        raise exception using errcode = 'P0001', message = 'conflict_requires_review';
      end if;
      select (expected ->> 'expectedRevision')::integer
      into expected_revision_value
      from jsonb_array_elements(p_expected_note_revisions) as expected
      where expected ->> 'noteId' = link_group.note_id;
      select * into note_row from public.notes
      where id = link_group.note_id and user_id = owner_id
      for update;
      select * into mutation_row from public.note_mutations
      where id = link_group.mutation_id and user_id = owner_id;
      if note_row.id is null or mutation_row.id is null
        or note_row.current_revision <> expected_revision_value
        or mutation_row.note_id <> note_row.id
        or mutation_row.after_revision <> expected_revision_value
        or mutation_row.undone_at is not null
      then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
      undo_response := private.undo_user_mutation_for_owner(
        owner_id,
        mutation_row.id,
        expected_revision_value,
        'capdel_' || left(private.request_hash(jsonb_build_object(
          'captureId', capture_row.id,
          'noteId', note_row.id,
          'mutationId', mutation_row.id
        )), 64)
      );
      removal_mutations := removal_mutations || jsonb_build_array(jsonb_build_object(
        'mutationId', undo_response ->> 'mutationId',
        'noteId', note_row.id,
        'expectedRevision', (undo_response -> 'note' ->> 'currentRevision')::integer
      ));
    end loop;
  end if;

  update public.capture_note_links
  set relation = 'source_removed'
  where capture_id = capture_row.id and user_id = owner_id;
  update public.captures
  set
    status = 'deleted',
    deleted_at = deleted_value,
    content_envelope = null,
    content_fingerprint = null,
    content_length = null
  where id = capture_row.id
  returning * into capture_row;
  for link_group in
    update public.review_items
    set
      state = 'dismissed',
      resolution = jsonb_build_object('reason', 'capture_deleted'),
      resolved_at = deleted_value
    where capture_id = capture_row.id
      and user_id = owner_id
      and state = 'open'
    returning id
  loop
    perform private.emit_user_event(owner_id, 'review_item', link_group.id);
  end loop;
  delete from public.api_idempotency_records
  where user_id = owner_id
    and scope = 'retry_capture'
    and response_json #>> '{capture,id}' = capture_row.id;
  if job_row.state in ('created', 'running', 'awaiting_retry') then
    update public.organization_jobs
    set
      state = 'failed',
      completed_at = deleted_value,
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
          'action', 'delete', 'captureId', capture_row.id,
          'leaseToken', job_row.lease_token
        )) else null end
    where id = job_row.id
    returning * into job_row;
    perform private.emit_user_event(owner_id, 'organization_job', job_row.id);
  end if;
  perform private.emit_user_event(owner_id, 'capture', capture_row.id);
  for link_group in
    select distinct note_id from public.capture_note_links
    where capture_id = capture_row.id and user_id = owner_id
  loop
    perform private.emit_user_event(owner_id, 'capture_note_link', link_group.note_id);
  end loop;

  response_value := jsonb_build_object(
    'captureId', capture_row.id,
    'deletedAt', deleted_value,
    'sourceRemovedFromNoteIds', source_note_ids,
    'removedInsertedContent', jsonb_array_length(removal_mutations) > 0,
    'contentRemovalMutations', removal_mutations,
    'replayed', false
  );
  perform private.finish_idempotency(owner_id, p_idempotency_key, response_value);
  return response_value;
end;
$$;

-- Migration 8 predates durable job leases. Keep its reviewed conflict/replan
-- implementation as an owner-internal core, but remove the callable public
-- signature so no worker can apply a delayed plan without proving that it
-- still owns the exact live lease.
alter function public.apply_delayed_organization_mutation(
  text, text, integer, jsonb, text
) rename to apply_delayed_organization_mutation_core;
alter function public.apply_delayed_organization_mutation_core(
  text, text, integer, jsonb, text
) set schema private;
revoke execute on function private.apply_delayed_organization_mutation_core(
  text, text, integer, jsonb, text
) from public, anon, authenticated, service_role;

-- Migration 3 claimed idempotency before validating the operations array. In
-- SQL three-valued logic, a SQL NULL operations value therefore bypassed the
-- old `jsonb_typeof(...) <> 'array'` predicate. Keep the reviewed legacy body
-- intact, but interpose a same-signature guard so every caller (the public
-- manual RPC and owner-scoped internal workflows) rejects SQL NULL before the
-- legacy core can write an idempotency claim, revision, mutation, or event.
alter function private.apply_user_note_mutation_core(
  text, integer, jsonb, text
) rename to apply_user_note_mutation_core_unchecked;

revoke execute on function private.apply_user_note_mutation_core_unchecked(
  text, integer, jsonb, text
) from public, anon, authenticated, service_role;

create function private.apply_user_note_mutation_core(
  p_note_id text,
  p_expected_revision integer,
  p_operations jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'authenticated'
    and auth.role() is distinct from 'service_role'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_operations is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  return private.apply_user_note_mutation_core_unchecked(
    p_note_id,
    p_expected_revision,
    p_operations,
    p_idempotency_key
  );
end;
$$;

-- Neither private layer is a service-role escape hatch. Security-definer
-- public wrappers execute these as their owner after enforcing their own
-- authenticated-user or lease-fenced service contracts.
revoke execute on function private.apply_user_note_mutation_core(
  text, integer, jsonb, text
) from public, anon, authenticated, service_role;
revoke execute on function private.apply_user_note_mutation_core_unchecked(
  text, integer, jsonb, text
) from public, anon, authenticated, service_role;

-- Reassert the migration-8 public contract after replacing the private core.
revoke execute on function public.apply_user_note_mutation(
  text, integer, jsonb, text
) from public, anon;
grant execute on function public.apply_user_note_mutation(
  text, integer, jsonb, text
) to authenticated, service_role;

create function public.apply_delayed_organization_mutation(
  p_job_id text,
  p_lease_token uuid,
  p_note_id text,
  p_expected_revision integer,
  p_operations jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.organization_jobs%rowtype;
  claim jsonb;
  response_value jsonb;
  internal_key text;
  lease_checked_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision is null
    or p_expected_revision < 1
    or p_operations is null
    or jsonb_typeof(p_operations) <> 'array'
    or jsonb_array_length(p_operations) not between 1 and 20
    or p_idempotency_key is null
    or char_length(p_idempotency_key) not between 1 and 80
    or btrim(p_idempotency_key) = ''
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- Global workflow lock order is job -> active capture -> note. Holding the
  -- job lock prevents heartbeat, recovery, completion, failure, or deletion
  -- from changing lease ownership after this check and before note mutation.
  select * into job_row
  from public.organization_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  lease_checked_at := clock_timestamp();
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from p_lease_token
    or job_row.lease_expires_at <= lease_checked_at
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  perform 1
  from public.captures
  where id = job_row.capture_id
    and user_id = job_row.user_id
    and deleted_at is null
    and status = 'processing'
    and privacy = 'ai_assisted'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  perform 1
  from public.notes
  where id = p_note_id
    and user_id = job_row.user_id
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  -- Lease ownership authorizes this attempt but is deliberately not part of
  -- the logical effect identity. After a committed effect and lost response,
  -- a newly leased retry of the same request must replay rather than append a
  -- second revision.
  claim := private.claim_idempotency(
    job_row.user_id,
    p_idempotency_key,
    'apply_delayed_organization_mutation_lease_v1',
    jsonb_build_object(
      'jobId', p_job_id,
      'noteId', p_note_id,
      'expectedRevision', p_expected_revision,
      'operations', p_operations
    )
  );
  if (claim ->> 'replayed')::boolean then
    return (claim -> 'response') || jsonb_build_object('replayed', true);
  end if;

  -- Isolate the migration-8 core's legacy idempotency record from the public
  -- lease-bound key while keeping the generated key within the 80-char limit.
  internal_key := 'orglease_' || left(private.request_hash(jsonb_build_object(
    'jobId', p_job_id,
    'idempotencyKey', p_idempotency_key
  )), 64);
  response_value := private.apply_delayed_organization_mutation_core(
    p_job_id,
    p_note_id,
    p_expected_revision,
    p_operations,
    internal_key
  );
  -- A lease can expire while the transactional note mutation is executing.
  -- Re-check immediately before committing the outer idempotency result; an
  -- exception here rolls the entire statement (including the core effect)
  -- back atomically.
  select * into job_row
  from public.organization_jobs
  where id = p_job_id
  for update;
  if job_row.state <> 'running'
    or job_row.lease_token is distinct from p_lease_token
    or job_row.lease_expires_at <= clock_timestamp()
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform private.finish_idempotency(
    job_row.user_id,
    p_idempotency_key,
    response_value
  );
  return response_value;
end;
$$;

drop policy if exists captures_select on public.captures;
drop policy if exists captures_delete on public.captures;
revoke all privileges on table public.captures from public, anon, authenticated;

revoke execute on function public.create_capture_with_job(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.claim_capture_jobs(text, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.heartbeat_capture_job(text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_capture_job(text, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.fail_capture_job(
  text, uuid, public.safe_error_code, boolean, integer
) from public, anon, authenticated;
revoke execute on function public.recover_stale_capture_jobs(integer)
  from public, anon, authenticated;
revoke execute on function public.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke execute on function public.get_capture_detail(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.get_capture_receipt(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.retry_capture(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.delete_capture(uuid, text, text, boolean, jsonb)
  from public, anon, authenticated;
revoke execute on function public.apply_delayed_organization_mutation(
  text, uuid, text, integer, jsonb, text
) from public, anon, authenticated;

grant execute on function public.create_capture_with_job(uuid, jsonb)
  to service_role;
grant execute on function public.claim_capture_jobs(text, integer, integer)
  to service_role;
grant execute on function public.heartbeat_capture_job(text, uuid, integer)
  to service_role;
grant execute on function public.complete_capture_job(text, uuid, text)
  to service_role;
grant execute on function public.fail_capture_job(
  text, uuid, public.safe_error_code, boolean, integer
) to service_role;
grant execute on function public.recover_stale_capture_jobs(integer)
  to service_role;
grant execute on function public.list_captures(
  uuid, text, integer, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.get_capture_detail(uuid, text)
  to service_role;
grant execute on function public.get_capture_receipt(uuid, text)
  to service_role;
grant execute on function public.retry_capture(uuid, text, text)
  to service_role;
grant execute on function public.delete_capture(uuid, text, text, boolean, jsonb)
  to service_role;
grant execute on function public.apply_delayed_organization_mutation(
  text, uuid, text, integer, jsonb, text
) to service_role;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
-- The service role must enter through the fenced public wrapper. Postgres
-- function owners retain the internal call path used by the wrapper.
revoke execute on function private.apply_delayed_organization_mutation_core(
  text, text, integer, jsonb, text
) from public, anon, authenticated, service_role;
revoke execute on function private.apply_user_note_mutation_core(
  text, integer, jsonb, text
) from public, anon, authenticated, service_role;
revoke execute on function private.apply_user_note_mutation_core_unchecked(
  text, integer, jsonb, text
) from public, anon, authenticated, service_role;
