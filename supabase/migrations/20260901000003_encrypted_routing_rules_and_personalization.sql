-- Milestone E2: encrypted routing rules and owner-private personalization.
--
-- Rule conditions (including normalized text and aliases) remain one
-- private_manual encrypted aggregate. PostgreSQL owns only content-free
-- lifecycle, destination, CAS, replay, and immutable organizer snapshots.

create type public.routing_rule_proposal_state as enum (
  'observing', 'offered', 'accepted', 'declined'
);

alter table public.routing_rules
  add column proposal_state public.routing_rule_proposal_state;

-- This is compatibility treatment for pre-E2 structural fixtures. No E1
-- production writer could create correction-suggested rules. New writes are
-- subject to the observation state machine below.
update public.routing_rules
set proposal_state = case when enabled
  then 'accepted'::public.routing_rule_proposal_state
  else 'observing'::public.routing_rule_proposal_state end
where source = 'correction_suggested';

alter table public.routing_rules
  add constraint routing_rules_proposal_lifecycle check (
    (source = 'explicit' and proposal_state is null)
    or (
      source = 'correction_suggested'
      and proposal_state is not null
      and (
        proposal_state = 'accepted'
        or not enabled
      )
    )
  );

create index routing_rules_owner_match_order
  on public.routing_rules (user_id, priority desc, id asc)
  where enabled;
create index routing_rules_owner_proposals
  on public.routing_rules (user_id, proposal_state, id)
  where source = 'correction_suggested';

-- current_revision is the public/CAS revision. The encrypted condition has
-- its own AAD revision and changes only when its ciphertext changes.
create or replace function private.enforce_routing_rule_current_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rule_changed boolean := row(
    new.enabled,
    new.rule_type,
    new.condition_revision,
    new.destination_note_id,
    new.destination_space_id,
    new.priority,
    new.source,
    new.proposal_state
  ) is distinct from row(
    old.enabled,
    old.rule_type,
    old.condition_revision,
    old.destination_note_id,
    old.destination_space_id,
    old.priority,
    old.source,
    old.proposal_state
  );
begin
  if rule_changed then
    if new.current_revision not in (
      old.current_revision,
      old.current_revision + 1
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_routing_rule_revision';
    end if;
    new.current_revision := old.current_revision + 1;
  elsif new.current_revision <> old.current_revision then
    raise exception using
      errcode = 'P0001', message = 'routing_rule_revision_without_change';
  end if;
  return new;
end;
$$;

create table public.routing_rule_proposal_observations (
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id text not null references public.routing_rules(id) on delete cascade,
  feedback_event_id text not null
    references public.feedback_events(id) on delete cascade,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (rule_id, feedback_event_id),
  unique (user_id, feedback_event_id),
  check (rule_id ~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (feedback_event_id ~ '^fbk_[0-9A-HJKMNP-TV-Z]{26}$')
);

-- This content-free owner epoch is the CAS for the decrypted observation set.
-- It closes the read/decrypt/prepare split without revealing condition
-- equality: stale writers must re-read and re-plan against the new set.
create table public.routing_rule_observation_epochs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  observation_epoch bigint not null default 0 check (observation_epoch >= 0),
  updated_at timestamptz not null default now()
);

insert into public.routing_rule_observation_epochs(user_id)
select id from auth.users on conflict (user_id) do nothing;

create table public.encrypted_routing_rule_write_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 80
    and btrim(idempotency_key) = idempotency_key
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  scope text not null check (scope in (
    'create_routing_rule', 'update_routing_rule',
    'observe_routing_rule_proposal', 'accept_routing_rule_proposal',
    'decline_routing_rule_proposal', 'delete_routing_rule'
  )),
  rule_id text not null check (rule_id ~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'),
  expected_revision integer not null check (expected_revision >= 0),
  target_revision integer not null check (target_revision >= 1),
  condition_revision integer not null check (condition_revision >= 0),
  target_condition_revision integer not null
    check (target_condition_revision >= 1),
  expected_observation_epoch bigint check (expected_observation_epoch >= 0),
  observation_reservation_id uuid,
  observation_reservation_operation_count integer check (
    observation_reservation_operation_count between 1 and 2
  ),
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
  result_current_revision integer check (result_current_revision >= 1),
  result_condition_revision integer check (result_condition_revision >= 1),
  result_proposal_state public.routing_rule_proposal_state,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, idempotency_key),
  check (
    (scope in ('create_routing_rule', 'observe_routing_rule_proposal')
      and expected_revision = 0)
    or expected_revision >= 1
  ),
  check (
    (scope = 'observe_routing_rule_proposal'
      and expected_observation_epoch is not null)
    or (scope <> 'observe_routing_rule_proposal'
      and expected_observation_epoch is null)
  ),
  check (
    (
      scope = 'observe_routing_rule_proposal'
      and observation_reservation_id is not null
      and observation_reservation_operation_count = case
        when expected_revision = 0 then 2 else 1 end
    ) or (
      scope <> 'observe_routing_rule_proposal'
      and observation_reservation_id is null
      and observation_reservation_operation_count is null
    )
  ),
  check (
    (completed_at is null
      and result_current_revision is null
      and result_condition_revision is null)
    or (completed_at is not null
      and result_current_revision is not null
      and result_condition_revision is not null)
  ),
  foreign key (
    user_id, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  foreign key (user_id, observation_reservation_id)
    references public.content_key_operation_reservations(
      user_id, reservation_id
    ) deferrable initially deferred
);

-- A deleted stale claim needs a content-free replay tombstone; otherwise an
-- exact abandon retry could not be distinguished from a substituted MAC.
create table private.encrypted_routing_rule_observation_abandonments (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    char_length(idempotency_key) between 1 and 80
    and btrim(idempotency_key) = idempotency_key
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  stale_observation_epoch bigint not null check (
    stale_observation_epoch >= 0
  ),
  abandoned_observation_epoch bigint not null check (
    abandoned_observation_epoch > stale_observation_epoch
  ),
  request_mac_key_id text not null,
  request_mac_key_class public.content_key_class not null
    check (request_mac_key_class = 'private_manual'),
  request_mac_key_purpose public.content_key_purpose not null
    check (request_mac_key_purpose = 'content_mac'),
  request_mac_key_version integer not null check (request_mac_key_version >= 1),
  request_mac text not null check (request_mac ~ '^[0-9a-f]{64}$'),
  abandoned_at timestamptz not null default date_trunc(
    'milliseconds',clock_timestamp()
  ),
  primary key (user_id,idempotency_key),
  foreign key (
    user_id,request_mac_key_id,request_mac_key_class,
    request_mac_key_purpose,request_mac_key_version
  ) references public.user_content_keys (
    user_id,key_id,key_class,key_purpose,key_version
  ) deferrable initially deferred
);

-- Observe preparation owns one exact grouped reservation. Deleting an
-- unfinished stale claim burns that plan in the same transaction, before a
-- replacement is admitted or an abandonment tombstone is published.
create or replace function private.cleanup_routing_rule_observation_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation_row public.content_key_operation_reservations%rowtype;
begin
  if tg_op <> 'DELETE' or tg_table_schema <> 'public'
    or tg_table_name <> 'encrypted_routing_rule_write_claims'
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_routing_rule_reservation_cleanup_target';
  end if;
  if old.observation_reservation_id is null then return old; end if;
  select * into reservation_row
  from public.content_key_operation_reservations
  where user_id = old.user_id
    and reservation_id = old.observation_reservation_id
  for update;
  -- A simultaneous auth.users cascade may have already removed the child.
  if not found then return old; end if;
  if reservation_row.operation_count
      <> old.observation_reservation_operation_count
    or reservation_row.key_class <> 'private_manual'
    or reservation_row.key_purpose <> 'object_wrap'
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
  end if;
  if reservation_row.consumed_at is null then
    update public.content_key_operation_reservations set
      consumed_by_type = 'encrypted_routing_rule_command',
      consumed_by_id = left('cancelled:' || old.idempotency_key,200),
      consumed_at = clock_timestamp()
    where user_id = old.user_id
      and reservation_id = old.observation_reservation_id
      and consumed_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
    end if;
  elsif old.completed_at is null
    and not (
      reservation_row.consumed_by_type = 'encrypted_routing_rule_command'
      and reservation_row.consumed_by_id = left(
        'cancelled:' || old.idempotency_key,200
      )
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
  end if;
  return old;
end;
$$;

create trigger encrypted_routing_rule_observation_reservation_cleanup
before delete on public.encrypted_routing_rule_write_claims
for each row execute function
private.cleanup_routing_rule_observation_reservations();

alter table public.routing_rule_proposal_observations enable row level security;
alter table public.routing_rule_proposal_observations force row level security;
alter table public.routing_rule_observation_epochs enable row level security;
alter table public.routing_rule_observation_epochs force row level security;
alter table public.encrypted_routing_rule_write_claims enable row level security;
alter table public.encrypted_routing_rule_write_claims force row level security;

revoke all on table public.routing_rule_proposal_observations,
  public.routing_rule_observation_epochs,
  public.encrypted_routing_rule_write_claims
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- Extend the shared reservation consumer without broadening any other
-- command family.
alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command',
      'encrypted_taxonomy_command', 'encrypted_note_retention',
      'encrypted_owner_interaction', 'encrypted_routing_rule_command'
    )
  );

do $reservation_consumer_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.consume_content_key_reservations(uuid,jsonb,text,text)'::regprocedure
  );
  old_fragment constant text := $old$'encrypted_capture_command', 'encrypted_taxonomy_command'
    )$old$;
  new_fragment constant text := $new$'encrypted_capture_command', 'encrypted_taxonomy_command',
      'encrypted_routing_rule_command'
    )$new$;
  old_state_fragment constant text := $old$if key_state_value is distinct from 'active'::public.content_key_state then
      raise exception using errcode = 'P0001', message = 'invalid_key_state';
    end if;$old$;
  new_state_fragment constant text := $new$if key_state_value is distinct from 'active'::public.content_key_state
      and not (
        consumer_type_value = 'encrypted_routing_rule_command'
        and key_state_value = 'retired'::public.content_key_state
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_key_state';
    end if;$new$;
begin
  if (pg_catalog.length(definition) - pg_catalog.length(
    pg_catalog.replace(definition, old_fragment, '')
  )) / pg_catalog.length(old_fragment) <> 1 then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_reservation_consumer_contract_drift';
  end if;
  definition := pg_catalog.replace(definition, old_fragment, new_fragment);
  if (pg_catalog.length(definition) - pg_catalog.length(
    pg_catalog.replace(definition, old_state_fragment, '')
  )) / pg_catalog.length(old_state_fragment) <> 1 then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_reservation_key_state_contract_drift';
  end if;
  -- Reservations can only be created while their object-wrap key is active.
  -- A prepared routing command may therefore finish with that exact budget
  -- after rotation retires the key, but a revoked key still fails closed.
  execute pg_catalog.replace(
    definition,old_state_fragment,new_state_fragment
  );
end;
$reservation_consumer_patch$;

-- All encrypted write families share one owner/idempotency namespace.
create or replace function private.enforce_encrypted_idempotency_namespace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conflicting_claims integer;
  matching_claims integer;
begin
  if tg_op <> 'INSERT' or tg_table_schema <> 'public'
    or tg_table_name not in (
      'api_idempotency_records', 'encrypted_note_write_claims',
      'encrypted_taxonomy_write_claims',
      'encrypted_owner_interaction_claims',
      'encrypted_routing_rule_write_claims'
    )
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_encrypted_idempotency_namespace_target';
  end if;

  if tg_table_name = 'api_idempotency_records' then
    select count(*), count(*) filter (where claim_scope = new.scope)
    into conflicting_claims, matching_claims
    from (
      select scope as claim_scope from public.encrypted_note_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_taxonomy_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_owner_interaction_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope from public.encrypted_routing_rule_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) as claims;
    if exists (
      select 1
      from private.encrypted_routing_rule_observation_abandonments
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) or conflicting_claims > 1
      or (conflicting_claims = 1 and matching_claims <> 1)
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
  elsif exists (
    select 1
    from private.encrypted_routing_rule_observation_abandonments
    where user_id = new.user_id and idempotency_key = new.idempotency_key
  ) or exists (
    select 1 from public.api_idempotency_records
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) or (tg_table_name <> 'encrypted_note_write_claims' and exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    )) or (tg_table_name <> 'encrypted_taxonomy_write_claims' and exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    )) or (tg_table_name <> 'encrypted_owner_interaction_claims' and exists (
      select 1 from public.encrypted_owner_interaction_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    )) or (tg_table_name <> 'encrypted_routing_rule_write_claims' and exists (
      select 1 from public.encrypted_routing_rule_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ))
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return new;
end;
$$;

create trigger encrypted_routing_rule_write_claims_namespace_guard
before insert on public.encrypted_routing_rule_write_claims
for each row execute function private.enforce_encrypted_idempotency_namespace();

create or replace function private.routing_rule_destination_status(
  p_owner_id uuid,
  p_destination_kind text,
  p_destination_id text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  archived_value timestamptz;
  deleted_value timestamptz;
  is_open_value boolean;
  privacy_value public.privacy_mode;
begin
  if p_destination_kind = 'note' then
    select archived_at, deleted_at, is_open, privacy
    into archived_value, deleted_value, is_open_value, privacy_value
    from public.notes
    where user_id = p_owner_id and id = p_destination_id;
    if not found then return 'missing'; end if;
    if deleted_value is not null then return 'deleted'; end if;
    if archived_value is not null then return 'archived'; end if;
    if not is_open_value or privacy_value <> 'ai_assisted' then return 'missing'; end if;
    return 'active';
  elsif p_destination_kind = 'space' then
    select archived_at into archived_value
    from public.spaces
    where user_id = p_owner_id and id = p_destination_id;
    if not found then return 'missing'; end if;
    if archived_value is not null then return 'archived'; end if;
    return 'active';
  end if;
  return 'missing';
end;
$$;

create or replace function private.valid_routing_rule_destination(
  p_owner_id uuid,
  p_destination_kind text,
  p_destination_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.routing_rule_destination_status(
    p_owner_id, p_destination_kind, p_destination_id
  ) = 'active';
$$;

create or replace function private.lock_routing_rule_destination(
  p_owner_id uuid,
  p_destination_kind text,
  p_destination_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_destination_kind = 'note' then
    perform id from public.notes
    where user_id = p_owner_id and id = p_destination_id
      and deleted_at is null and archived_at is null
      and is_open and privacy = 'ai_assisted'
    for share;
  elsif p_destination_kind = 'space' then
    perform id from public.spaces
    where user_id = p_owner_id and id = p_destination_id
      and archived_at is null
    for share;
  else
    return false;
  end if;
  return found;
end;
$$;

create or replace function private.routing_rule_observation_epoch(
  p_owner_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select epoch.observation_epoch
    from public.routing_rule_observation_epochs as epoch
    where epoch.user_id = p_owner_id
  ),0::bigint);
$$;

create or replace function private.lock_routing_rule_observation_epoch(
  p_owner_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  epoch_value bigint;
begin
  insert into public.routing_rule_observation_epochs(user_id)
  values (p_owner_id) on conflict (user_id) do nothing;
  select observation_epoch into epoch_value
  from public.routing_rule_observation_epochs
  where user_id = p_owner_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return epoch_value;
end;
$$;

create or replace function private.encrypted_routing_rule_claim_projection(
  p_claim public.encrypted_routing_rule_write_claims
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'scope', p_claim.scope,
    'ruleId', p_claim.rule_id,
    'expectedRevision', p_claim.expected_revision,
    'targetRevision', p_claim.target_revision,
    'conditionRevision', p_claim.condition_revision,
    'targetConditionRevision', p_claim.target_condition_revision,
    'expectedObservationEpoch', p_claim.expected_observation_epoch,
    'occurredAt', p_claim.occurred_at,
    'requestMacKey', jsonb_build_object(
      'keyId', p_claim.request_mac_key_id,
      'keyClass', p_claim.request_mac_key_class,
      'keyPurpose', p_claim.request_mac_key_purpose,
      'keyVersion', p_claim.request_mac_key_version
    ),
    'reservation', case
      when p_claim.scope = 'observe_routing_rule_proposal'
        and p_claim.completed_at is null
      then (
        select jsonb_build_object(
          'reservationId', reservation.reservation_id,
          'operationCount', reservation.operation_count,
          'key', private.content_key_service_projection(key_row)
        )
        from public.content_key_operation_reservations as reservation
        join public.user_content_keys as key_row
          on key_row.user_id = reservation.user_id
          and key_row.key_id = reservation.key_id
          and key_row.key_class = reservation.key_class
          and key_row.key_purpose = reservation.key_purpose
          and key_row.key_version = reservation.key_version
        where reservation.user_id = p_claim.user_id
          and reservation.reservation_id
            = p_claim.observation_reservation_id
          and reservation.operation_count
            = p_claim.observation_reservation_operation_count
      )
      else null
    end,
    'completed', p_claim.completed_at is not null
  );
$$;

create or replace function private.encrypted_routing_rule_result(
  p_claim public.encrypted_routing_rule_write_claims,
  p_replayed boolean
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
  if p_claim.completed_at is null
    or p_claim.result_current_revision is null
    or p_claim.result_condition_revision is null
  then
    raise exception using errcode = 'P0001', message = 'write_not_completed';
  end if;
  select * into record_row
  from public.api_idempotency_records
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key;
  if not found
    or record_row.scope <> p_claim.scope
    or record_row.replay_policy <> 'logical_mac'
    or record_row.request_resource_type <> 'routing_rule'
    or record_row.request_resource_id <> p_claim.rule_id
    or record_row.response_resource_id <> p_claim.rule_id
    or record_row.response_record_version <> p_claim.result_current_revision
    or record_row.response_envelope is null
    or record_row.response_key_class <> 'private_manual'
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return jsonb_build_object(
    'ruleId', p_claim.rule_id,
    'currentRevision', p_claim.result_current_revision,
    'conditionRevision', p_claim.result_condition_revision,
    'proposalState', p_claim.result_proposal_state,
    'encryptedResponse', private.encrypted_cipher_projection(
      record_row.response_envelope, record_row.response_key_id,
      record_row.response_key_class, record_row.response_key_purpose,
      record_row.response_key_version
    ),
    'replayed', p_replayed
  );
end;
$$;

create or replace function private.finish_encrypted_routing_rule_write(
  p_claim public.encrypted_routing_rule_write_claims,
  p_request_mac jsonb,
  p_response_cipher jsonb,
  p_response_verification_mac jsonb,
  p_result_current_revision integer,
  p_result_condition_revision integer,
  p_result_proposal_state public.routing_rule_proposal_state,
  p_response_resource_type text
)
returns public.encrypted_routing_rule_write_claims
language plpgsql
security definer
set search_path = ''
as $$
declare
  finished_claim public.encrypted_routing_rule_write_claims%rowtype;
  legacy_response jsonb := private.encrypted_only_idempotency_response(
    p_claim.scope, p_claim.rule_id, p_response_resource_type,
    p_claim.rule_id, p_result_current_revision
  );
begin
  -- request_hash/response_json are intentionally referenced only by dynamic
  -- SQL. Physical encrypted-storage contraction removes those columns.
  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.api_idempotency_records'::regclass
      and attname = 'request_hash' and not attisdropped
  ) then
    execute $sql$
      insert into public.api_idempotency_records (
        user_id, idempotency_key, scope, request_hash, response_json,
        completed_at, request_mac, request_mac_key_id,
        request_mac_key_class, request_mac_key_purpose,
        request_mac_key_version, response_envelope, response_key_id,
        response_key_class, response_key_purpose, response_key_version,
        request_resource_type, request_resource_id,
        response_resource_type, response_resource_id,
        response_record_version, created_at, replay_policy
      ) values (
        $1,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        'routing_rule',$16,$17,$16,$18,$6,'logical_mac'
      )
    $sql$ using
      p_claim.user_id, p_claim.idempotency_key, p_claim.scope,
      p_request_mac ->> 'mac', legacy_response, p_claim.occurred_at,
      p_claim.request_mac_key_id, p_claim.request_mac_key_class,
      p_claim.request_mac_key_purpose, p_claim.request_mac_key_version,
      p_response_cipher -> 'envelope', p_response_cipher ->> 'keyId',
      (p_response_cipher ->> 'keyClass')::public.content_key_class,
      (p_response_cipher ->> 'keyPurpose')::public.content_key_purpose,
      (p_response_cipher ->> 'keyVersion')::integer, p_claim.rule_id,
      p_response_resource_type, p_result_current_revision;
  else
    execute $sql$
      insert into public.api_idempotency_records (
        user_id, idempotency_key, scope, completed_at, request_mac,
        request_mac_key_id, request_mac_key_class,
        request_mac_key_purpose, request_mac_key_version,
        response_envelope, response_key_id, response_key_class,
        response_key_purpose, response_key_version,
        request_resource_type, request_resource_id,
        response_resource_type, response_resource_id,
        response_record_version, created_at, replay_policy
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        'routing_rule',$15,$16,$15,$17,$4,'logical_mac'
      )
    $sql$ using
      p_claim.user_id, p_claim.idempotency_key, p_claim.scope,
      p_claim.occurred_at, p_request_mac ->> 'mac',
      p_claim.request_mac_key_id, p_claim.request_mac_key_class,
      p_claim.request_mac_key_purpose, p_claim.request_mac_key_version,
      p_response_cipher -> 'envelope', p_response_cipher ->> 'keyId',
      (p_response_cipher ->> 'keyClass')::public.content_key_class,
      (p_response_cipher ->> 'keyPurpose')::public.content_key_purpose,
      (p_response_cipher ->> 'keyVersion')::integer, p_claim.rule_id,
      p_response_resource_type, p_result_current_revision;
  end if;

  perform private.record_content_encryption_verification(
    p_claim.user_id, 'idempotency_response',
    'idempotency:' || p_claim.idempotency_key, 1,
    p_response_cipher -> 'envelope', p_response_verification_mac
  );
  update public.encrypted_routing_rule_write_claims
  set
    result_current_revision = p_result_current_revision,
    result_condition_revision = p_result_condition_revision,
    result_proposal_state = p_result_proposal_state,
    completed_at = p_claim.occurred_at
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key
    and completed_at is null
  returning * into finished_claim;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return finished_claim;
end;
$$;

create or replace function private.assert_routing_rule_feedback_observation(
  p_owner_id uuid,
  p_feedback_event_id text,
  p_destination_kind text,
  p_destination_id text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  feedback_row public.feedback_events%rowtype;
begin
  select * into feedback_row
  from public.feedback_events
  where user_id = p_owner_id and id = p_feedback_event_id;
  if not found
    or feedback_row.action <> 'moved'
    or feedback_row.reason_code <> 'user_correction'
    or feedback_row.new_destination_note_id is null
    or (
      p_destination_kind = 'note'
      and feedback_row.new_destination_note_id <> p_destination_id
    )
    or (
      p_destination_kind = 'space'
      and not exists (
        select 1 from public.notes
        where user_id = p_owner_id
          and id = feedback_row.new_destination_note_id
          and space_id = p_destination_id
      )
    )
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_proposal_observation';
  end if;
end;
$$;

create or replace function public.get_encrypted_routing_rule_observation_epoch(
  p_owner_id uuid
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
  if p_owner_id is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if not exists (select 1 from auth.users where id = p_owner_id) then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  return jsonb_build_object(
    'observationEpoch',private.routing_rule_observation_epoch(p_owner_id)
  );
end;
$$;

create or replace function public.get_encrypted_routing_rule_write_claim(
  p_owner_id uuid,
  p_idempotency_key text,
  p_request_mac jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_routing_rule_write_claims%rowtype;
  encrypted_response jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if p_request_mac is not null and not private.valid_encrypted_write_mac(
    p_request_mac,p_owner_id,'private_manual',true
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  select * into claim_row
  from public.encrypted_routing_rule_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then return jsonb_build_object('found',false); end if;
  if p_request_mac is not null and (
    p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
    or p_request_mac ->> 'keyClass'
      <> claim_row.request_mac_key_class::text
    or p_request_mac ->> 'keyPurpose'
      <> claim_row.request_mac_key_purpose::text
    or (p_request_mac ->> 'keyVersion')::integer
      <> claim_row.request_mac_key_version
    or p_request_mac ->> 'mac' <> claim_row.request_mac
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if not exists (
    select 1 from public.user_content_keys
    where user_id = claim_row.user_id
      and key_id = claim_row.request_mac_key_id
      and key_class = claim_row.request_mac_key_class
      and key_purpose = claim_row.request_mac_key_purpose
      and key_version = claim_row.request_mac_key_version
      and state in ('active','retired')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  if claim_row.completed_at is not null then
    select private.encrypted_cipher_projection(
      response_envelope,response_key_id,response_key_class,
      response_key_purpose,response_key_version
    ) into encrypted_response
    from public.api_idempotency_records
    where user_id = p_owner_id and idempotency_key = p_idempotency_key;
    if encrypted_response is null then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
  end if;
  return jsonb_build_object('found',true)
    || private.encrypted_routing_rule_claim_projection(claim_row)
    || jsonb_build_object(
      'encryptedResponse',encrypted_response,'replayed',true
    );
end;
$$;

create or replace function public.prepare_encrypted_routing_rule_write(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text,
  p_rule_id text,
  p_expected_revision integer,
  p_expected_observation_epoch bigint,
  p_request_mac jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_routing_rule_write_claims%rowtype;
  abandonment_row private.encrypted_routing_rule_observation_abandonments%rowtype;
  rule_row public.routing_rules%rowtype;
  encrypted_response jsonb;
  creating boolean;
  abandoning boolean;
  claim_found boolean := false;
  owner_locks_held boolean := false;
  replacing_stale_observe boolean := false;
  current_observation_epoch bigint;
  observation_key public.user_content_keys%rowtype;
  observation_reservation_id uuid;
  observation_reservation_operation_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  abandoning := p_scope = 'abandon_stale_routing_rule_observation';
  creating := p_scope = 'create_routing_rule'
    or (p_scope = 'observe_routing_rule_proposal' and p_rule_id is null);
  if p_owner_id is null
    or p_scope is null
    or p_scope not in (
      'create_routing_rule', 'update_routing_rule',
      'observe_routing_rule_proposal', 'accept_routing_rule_proposal',
      'decline_routing_rule_proposal',
      'abandon_stale_routing_rule_observation'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_expected_revision is null
    or jsonb_typeof(p_request_mac) <> 'object'
    or (p_scope in (
      'observe_routing_rule_proposal',
      'abandon_stale_routing_rule_observation'
    ) and (
      p_expected_observation_epoch is null
      or p_expected_observation_epoch < 0
    ))
    or (p_scope not in (
      'observe_routing_rule_proposal',
      'abandon_stale_routing_rule_observation'
    )
      and p_expected_observation_epoch is not null)
    or (abandoning and (p_rule_id is not null or p_expected_revision <> 0))
    or (not abandoning and creating
      and (p_rule_id is not null or p_expected_revision <> 0))
    or (not abandoning and not creating and (
      p_rule_id is null
      or p_rule_id !~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'
      or p_expected_revision < 1
    ))
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  if abandoning then
    select * into abandonment_row
    from private.encrypted_routing_rule_observation_abandonments
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
    for update;
    if found then
      if abandonment_row.abandoned_observation_epoch
          <> p_expected_observation_epoch
        or not private.valid_encrypted_write_mac(
          p_request_mac,p_owner_id,'private_manual',true
        )
        or p_request_mac ->> 'keyId'
          <> abandonment_row.request_mac_key_id
        or p_request_mac ->> 'keyClass'
          <> abandonment_row.request_mac_key_class::text
        or p_request_mac ->> 'keyPurpose'
          <> abandonment_row.request_mac_key_purpose::text
        or (p_request_mac ->> 'keyVersion')::integer
          <> abandonment_row.request_mac_key_version
        or p_request_mac ->> 'mac' <> abandonment_row.request_mac
      then
        raise exception using errcode = 'P0001',
          message = 'invalid_idempotency_key';
      end if;
      return jsonb_build_object('abandoned',true);
    end if;
  end if;
  select * into claim_row
  from public.encrypted_routing_rule_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  claim_found := found;

  if abandoning then
    if not claim_found
      or claim_row.scope <> 'observe_routing_rule_proposal'
      or claim_row.completed_at is not null
      or not private.valid_encrypted_write_mac(
        p_request_mac,p_owner_id,'private_manual',true
      )
      or p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
      or p_request_mac ->> 'keyClass'
        <> claim_row.request_mac_key_class::text
      or p_request_mac ->> 'keyPurpose'
        <> claim_row.request_mac_key_purpose::text
      or (p_request_mac ->> 'keyVersion')::integer
        <> claim_row.request_mac_key_version
      or p_request_mac ->> 'mac' <> claim_row.request_mac
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':content-encryption-rollout',0
    ));
    if not exists (
      select 1 from public.content_encryption_rollouts
      where user_id = p_owner_id
        and state in (
          'dual_write','encrypted_read','encrypted_only','contracted'
        )
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-routing-rules',0
    ));
    current_observation_epoch :=
      private.lock_routing_rule_observation_epoch(p_owner_id);
    if p_expected_observation_epoch <> current_observation_epoch then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_observation_stale';
    end if;
    if claim_row.expected_observation_epoch >= current_observation_epoch then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    delete from public.encrypted_routing_rule_write_claims
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
      and completed_at is null;
    if not found then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    insert into private.encrypted_routing_rule_observation_abandonments(
      user_id,idempotency_key,stale_observation_epoch,
      abandoned_observation_epoch,request_mac_key_id,
      request_mac_key_class,request_mac_key_purpose,
      request_mac_key_version,request_mac
    ) values (
      p_owner_id,p_idempotency_key,claim_row.expected_observation_epoch,
      current_observation_epoch,claim_row.request_mac_key_id,
      claim_row.request_mac_key_class,claim_row.request_mac_key_purpose,
      claim_row.request_mac_key_version,claim_row.request_mac
    );
    return jsonb_build_object('abandoned',true);
  end if;

  -- An unfinished observe plan may be replaced only after another successful
  -- observation made its bound set epoch stale. This is the response-loss-safe
  -- re-read/re-plan path; completed claims never enter it.
  if claim_found
    and claim_row.scope = 'observe_routing_rule_proposal'
    and p_scope = 'observe_routing_rule_proposal'
    and claim_row.completed_at is null
    and claim_row.expected_observation_epoch
      is distinct from p_expected_observation_epoch
  then
    if not private.valid_encrypted_write_mac(
        p_request_mac,p_owner_id,'private_manual',true
      )
      or p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
      or p_request_mac ->> 'keyClass'
        <> claim_row.request_mac_key_class::text
      or p_request_mac ->> 'keyPurpose'
        <> claim_row.request_mac_key_purpose::text
      or (p_request_mac ->> 'keyVersion')::integer
        <> claim_row.request_mac_key_version
      or p_request_mac ->> 'mac' <> claim_row.request_mac
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':content-encryption-rollout',0
    ));
    if not exists (
      select 1 from public.content_encryption_rollouts
      where user_id = p_owner_id
        and state in (
          'dual_write','encrypted_read','encrypted_only','contracted'
        )
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-routing-rules',0
    ));
    owner_locks_held := true;
    current_observation_epoch :=
      private.lock_routing_rule_observation_epoch(p_owner_id);
    if claim_row.expected_observation_epoch < current_observation_epoch
      and p_expected_observation_epoch = current_observation_epoch
    then
      delete from public.encrypted_routing_rule_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
        and completed_at is null;
      if not found then
        raise exception using errcode = 'P0001',
          message = 'invalid_idempotency_key';
      end if;
      claim_found := false;
      replacing_stale_observe := true;
    end if;
  end if;

  if claim_found then
    if claim_row.scope <> p_scope
      or claim_row.expected_revision <> p_expected_revision
      or claim_row.expected_observation_epoch
        is distinct from p_expected_observation_epoch
      or (p_rule_id is not null and claim_row.rule_id <> p_rule_id)
      or not private.valid_encrypted_write_mac(
        p_request_mac, p_owner_id, 'private_manual', true
      )
      or p_request_mac ->> 'keyId' <> claim_row.request_mac_key_id
      or p_request_mac ->> 'keyClass'
        <> claim_row.request_mac_key_class::text
      or p_request_mac ->> 'keyPurpose'
        <> claim_row.request_mac_key_purpose::text
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
    return private.encrypted_routing_rule_claim_projection(claim_row)
      || jsonb_build_object(
        'encryptedResponse', encrypted_response, 'replayed', true
      );
  end if;

  if not private.valid_encrypted_write_mac(
    p_request_mac,p_owner_id,'private_manual',replacing_stale_observe
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_request_mac_key';
  end if;
  if not owner_locks_held then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':content-encryption-rollout',0
    ));
    if not exists (
      select 1 from public.content_encryption_rollouts
      where user_id = p_owner_id
        and state in (
          'dual_write','encrypted_read','encrypted_only','contracted'
        )
    ) then
      raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-routing-rules',0
    ));
    owner_locks_held := true;
  end if;
  if p_scope = 'observe_routing_rule_proposal' then
    current_observation_epoch :=
      private.lock_routing_rule_observation_epoch(p_owner_id);
    if current_observation_epoch <> p_expected_observation_epoch then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_observation_stale';
    end if;
  end if;

  if creating then
    if (select count(*) from public.routing_rules where user_id = p_owner_id)
      >= 1000
    then
      raise exception using errcode = 'P0001', message = 'routing_rule_limit';
    end if;
    claim_row.rule_id := public.new_entity_id('rule');
    claim_row.condition_revision := 0;
    claim_row.target_condition_revision := 1;
    claim_row.target_revision := 1;
  else
    select * into rule_row
    from public.routing_rules
    where user_id = p_owner_id and id = p_rule_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if rule_row.current_revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    if p_scope = 'observe_routing_rule_proposal'
      and (rule_row.source <> 'correction_suggested'
        or rule_row.proposal_state <> 'observing' or rule_row.enabled)
    then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    elsif p_scope = 'accept_routing_rule_proposal'
      and (rule_row.source <> 'correction_suggested'
        or rule_row.proposal_state <> 'offered' or rule_row.enabled)
    then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    elsif p_scope = 'decline_routing_rule_proposal'
      and (rule_row.source <> 'correction_suggested'
        or rule_row.proposal_state <> 'offered' or rule_row.enabled)
    then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    elsif p_scope = 'update_routing_rule'
      and not (
        rule_row.source = 'explicit'
        or rule_row.proposal_state = 'accepted'
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    end if;
    claim_row.rule_id := p_rule_id;
    claim_row.condition_revision := rule_row.condition_revision;
    claim_row.target_condition_revision := case
      when p_scope = 'update_routing_rule'
        then rule_row.condition_revision + 1
      else rule_row.condition_revision
    end;
    claim_row.target_revision := rule_row.current_revision + 1;
  end if;

  if p_scope = 'observe_routing_rule_proposal' then
    observation_key := private.owner_interaction_active_key(
      p_owner_id,'private_manual','object_wrap'
    );
    observation_reservation_id := extensions.gen_random_uuid();
    observation_reservation_operation_count := case
      when p_expected_revision = 0 then 2 else 1 end;
    perform public.reserve_content_key_operations(
      p_owner_id,observation_reservation_id,'private_manual',
      observation_key.key_id,observation_key.key_version,
      observation_reservation_operation_count
    );
  end if;

  insert into public.encrypted_routing_rule_write_claims (
    user_id, idempotency_key, scope, rule_id, expected_revision,
    target_revision, condition_revision, target_condition_revision,
    expected_observation_epoch,observation_reservation_id,
    observation_reservation_operation_count,
    request_mac_key_id, request_mac_key_class, request_mac_key_purpose,
    request_mac_key_version, request_mac
  ) values (
    p_owner_id, p_idempotency_key, p_scope, claim_row.rule_id,
    p_expected_revision, claim_row.target_revision,
    claim_row.condition_revision, claim_row.target_condition_revision,
    p_expected_observation_epoch,observation_reservation_id,
    observation_reservation_operation_count,
    p_request_mac ->> 'keyId',
    (p_request_mac ->> 'keyClass')::public.content_key_class,
    (p_request_mac ->> 'keyPurpose')::public.content_key_purpose,
    (p_request_mac ->> 'keyVersion')::integer, p_request_mac ->> 'mac'
  ) returning * into claim_row;
  return private.encrypted_routing_rule_claim_projection(claim_row)
    || jsonb_build_object('encryptedResponse', null, 'replayed', false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.insert_encrypted_routing_rule(
  p_rule_id text,
  p_owner_id uuid,
  p_enabled boolean,
  p_rule_type public.rule_type,
  p_destination_kind text,
  p_destination_id text,
  p_priority integer,
  p_source public.rule_source,
  p_proposal_state public.routing_rule_proposal_state,
  p_condition_cipher jsonb,
  p_occurred_at timestamptz
)
returns public.routing_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_rule public.routing_rules%rowtype;
begin
  if exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.routing_rules'::regclass
      and attname = 'condition_normalized' and not attisdropped
  ) then
    execute $sql$
      insert into public.routing_rules (
        id,user_id,enabled,rule_type,condition_normalized,
        destination_note_id,destination_space_id,priority,source,
        proposal_state,condition_revision,current_revision,
        condition_envelope,condition_key_id,condition_key_class,
        condition_key_purpose,condition_key_version,created_at,updated_at
      ) values (
        $1,$2,$3,$4,'[encrypted]',
        case when $5 = 'note' then $6 else null end,
        case when $5 = 'space' then $6 else null end,
        $7,$8,$9,1,1,$10 -> 'envelope',$10 ->> 'keyId',
        ($10 ->> 'keyClass')::public.content_key_class,
        ($10 ->> 'keyPurpose')::public.content_key_purpose,
        ($10 ->> 'keyVersion')::integer,$11,$11
      ) returning *
    $sql$ into inserted_rule using
      p_rule_id,p_owner_id,p_enabled,p_rule_type,p_destination_kind,
      p_destination_id,p_priority,p_source,p_proposal_state,
      p_condition_cipher,p_occurred_at;
  else
    execute $sql$
      insert into public.routing_rules (
        id,user_id,enabled,rule_type,destination_note_id,
        destination_space_id,priority,source,proposal_state,
        condition_revision,current_revision,condition_envelope,
        condition_key_id,condition_key_class,condition_key_purpose,
        condition_key_version,created_at,updated_at
      ) values (
        $1,$2,$3,$4,
        case when $5 = 'note' then $6 else null end,
        case when $5 = 'space' then $6 else null end,
        $7,$8,$9,1,1,$10 -> 'envelope',$10 ->> 'keyId',
        ($10 ->> 'keyClass')::public.content_key_class,
        ($10 ->> 'keyPurpose')::public.content_key_purpose,
        ($10 ->> 'keyVersion')::integer,$11,$11
      ) returning *
    $sql$ into inserted_rule using
      p_rule_id,p_owner_id,p_enabled,p_rule_type,p_destination_kind,
      p_destination_id,p_priority,p_source,p_proposal_state,
      p_condition_cipher,p_occurred_at;
  end if;
  return inserted_rule;
end;
$$;

create or replace function public.commit_encrypted_routing_rule_write(
  p_owner_id uuid,
  p_scope text,
  p_idempotency_key text,
  p_rule_id text,
  p_expected_revision integer,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_routing_rule_write_claims%rowtype;
  rule_row public.routing_rules%rowtype;
  condition_value jsonb;
  condition_cipher jsonb;
  condition_verification jsonb;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_value jsonb;
  reservation_values jsonb;
  occurred_value timestamptz;
  enabled_value boolean;
  rule_type_value public.rule_type;
  destination_kind_value text;
  destination_id_value text;
  priority_value integer;
  feedback_event_id_value text;
  result_condition_revision integer;
  result_proposal_state public.routing_rule_proposal_state;
  condition_changed boolean := false;
  encrypted_delta integer := 1;
  observation_count integer;
  current_observation_epoch bigint;
  existing_destination_kind text;
  existing_destination_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_scope not in (
      'create_routing_rule', 'update_routing_rule',
      'observe_routing_rule_proposal', 'accept_routing_rule_proposal',
      'decline_routing_rule_proposal'
    )
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_rule_id is null
    or p_rule_id !~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision is null or p_expected_revision < 0
    or p_command is null or jsonb_typeof(p_command) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  select * into claim_row
  from public.encrypted_routing_rule_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;
  if claim_row.scope <> p_scope
    or claim_row.rule_id <> p_rule_id
    or claim_row.expected_revision <> p_expected_revision
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if p_scope in ('create_routing_rule', 'update_routing_rule') then
    if p_command - array[
      'scope','occurredAt','enabled','ruleType','destinationKind',
      'destinationId','priority','condition','requestMac','responseCipher',
      'responseVerificationMac'
    ] <> '{}'::jsonb or not p_command ?& array[
      'scope','occurredAt','enabled','ruleType','destinationKind',
      'destinationId','priority','condition','requestMac','responseCipher',
      'responseVerificationMac'
    ] then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  elsif p_scope = 'observe_routing_rule_proposal' then
    if p_command - array[
      'scope','occurredAt','ruleType','destinationKind','destinationId',
      'priority','feedbackEventId','condition','requestMac','responseCipher',
      'responseVerificationMac'
    ] <> '{}'::jsonb or not p_command ?& array[
      'scope','occurredAt','ruleType','destinationKind','destinationId',
      'priority','feedbackEventId','condition','requestMac','responseCipher',
      'responseVerificationMac'
    ] then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  else
    if p_command - array[
      'scope','occurredAt','requestMac','responseCipher',
      'responseVerificationMac'
    ] <> '{}'::jsonb or not p_command ?& array[
      'scope','occurredAt','requestMac','responseCipher',
      'responseVerificationMac'
    ] then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  end if;

  if p_command ->> 'scope' <> p_scope
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
    or jsonb_typeof(p_command -> 'responseCipher') <> 'object'
    or jsonb_typeof(p_command -> 'responseVerificationMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_mac_value := p_command -> 'requestMac';
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_value := p_command -> 'responseVerificationMac';
  occurred_value := (p_command ->> 'occurredAt')::timestamptz;
  if occurred_value <> claim_row.occurred_at
    or occurred_value <> date_trunc('milliseconds', occurred_value)
    or not private.valid_encrypted_write_mac(
      request_mac_value, p_owner_id, 'private_manual', true
    )
    or request_mac_value ->> 'mac' <> claim_row.request_mac
    or request_mac_value ->> 'keyId' <> claim_row.request_mac_key_id
    or request_mac_value ->> 'keyClass'
      <> claim_row.request_mac_key_class::text
    or request_mac_value ->> 'keyPurpose'
      <> claim_row.request_mac_key_purpose::text
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
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  if p_scope in (
    'create_routing_rule','update_routing_rule','observe_routing_rule_proposal'
  ) then
    if jsonb_typeof(p_command -> 'ruleType') <> 'string'
      or jsonb_typeof(p_command -> 'destinationKind') <> 'string'
      or p_command ->> 'destinationKind' not in ('note','space')
      or jsonb_typeof(p_command -> 'destinationId') <> 'string'
      or jsonb_typeof(p_command -> 'priority') <> 'number'
      or p_command ->> 'priority' !~ '^[0-9]{1,5}$'
      or (p_command ->> 'priority')::integer not between 0 and 10000
      or (
        p_command ->> 'destinationKind' = 'note'
        and p_command ->> 'destinationId'
          !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      ) or (
        p_command ->> 'destinationKind' = 'space'
        and p_command ->> 'destinationId'
          !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
      )
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    rule_type_value := (p_command ->> 'ruleType')::public.rule_type;
    destination_kind_value := p_command ->> 'destinationKind';
    destination_id_value := p_command ->> 'destinationId';
    priority_value := (p_command ->> 'priority')::integer;
    condition_value := p_command -> 'condition';
    if p_scope in ('create_routing_rule','update_routing_rule') then
      if jsonb_typeof(p_command -> 'enabled') <> 'boolean' then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      enabled_value := (p_command ->> 'enabled')::boolean;
    else
      enabled_value := false;
      if jsonb_typeof(p_command -> 'feedbackEventId') <> 'string'
        or p_command ->> 'feedbackEventId'
          !~ '^fbk_[0-9A-HJKMNP-TV-Z]{26}$'
      then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      feedback_event_id_value := p_command ->> 'feedbackEventId';
    end if;
  end if;

  if condition_value is not null and jsonb_typeof(condition_value) = 'object' then
    if condition_value - array['cipher','verificationMac'] <> '{}'::jsonb
      or not condition_value ?& array['cipher','verificationMac']
      or jsonb_typeof(condition_value -> 'cipher') <> 'object'
      or jsonb_typeof(condition_value -> 'verificationMac') <> 'object'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    condition_cipher := condition_value -> 'cipher';
    condition_verification := condition_value -> 'verificationMac';
    if not private.valid_encrypted_write_cipher(
        condition_cipher, p_owner_id, p_rule_id,
        claim_row.target_condition_revision, 'routing_rule', 'private_manual'
      ) or not private.valid_encrypted_write_mac(
        condition_verification, p_owner_id, 'private_manual', false
      )
    then
      raise exception using errcode = '22023', message = 'invalid_encrypted_field';
    end if;
    condition_changed := true;
  elsif condition_value is not null and jsonb_typeof(condition_value) <> 'null' then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if (claim_row.expected_revision = 0 and not condition_changed)
    or (p_scope = 'observe_routing_rule_proposal'
      and claim_row.expected_revision > 0 and condition_changed)
    or (p_scope in (
      'accept_routing_rule_proposal','decline_routing_rule_proposal'
    ) and condition_value is not null)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  reservation_values := case when condition_changed
    then jsonb_build_array(condition_cipher, response_cipher_value)
    else jsonb_build_array(response_cipher_value)
  end;

  if p_scope = 'observe_routing_rule_proposal' and (
    claim_row.observation_reservation_id is null
    or claim_row.observation_reservation_operation_count is null
    or jsonb_array_length(reservation_values)
      <> claim_row.observation_reservation_operation_count
    or exists (
      select 1
      from jsonb_array_elements(reservation_values) as cipher(value)
      where cipher.value ->> 'reservationId'
        is distinct from claim_row.observation_reservation_id::text
    )
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
  end if;

  if claim_row.completed_at is not null then
    perform private.consume_content_key_reservations(
      p_owner_id, reservation_values, 'encrypted_routing_rule_command',
      p_idempotency_key
    );
    return private.encrypted_routing_rule_result(claim_row, true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in ('dual_write','encrypted_read','encrypted_only','contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-routing-rules', 0
  ));

  if p_scope = 'observe_routing_rule_proposal' then
    current_observation_epoch :=
      private.lock_routing_rule_observation_epoch(p_owner_id);
    if claim_row.expected_observation_epoch <> current_observation_epoch then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_observation_stale';
    end if;
  end if;

  if p_scope = 'accept_routing_rule_proposal' then
    select
      case when destination_note_id is not null then 'note' else 'space' end,
      coalesce(destination_note_id,destination_space_id)
    into existing_destination_kind,existing_destination_id
    from public.routing_rules
    where user_id = p_owner_id and id = p_rule_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if not private.lock_routing_rule_destination(
      p_owner_id,existing_destination_kind,existing_destination_id
    ) then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_destination_invalid';
    end if;
  end if;

  if destination_id_value is not null and not private.lock_routing_rule_destination(
    p_owner_id, destination_kind_value, destination_id_value
  ) then
    -- A destination can become ineligible after an enabled rule was created.
    -- Permit exactly one recovery transition in that state: disable the rule
    -- without changing its destination. Enabling it or moving it to any other
    -- ineligible destination still fails closed. The owner-scoped advisory lock
    -- above serializes this read with all supported routing-rule writers; the
    -- row is subsequently locked and checked with the normal revision CAS.
    if p_scope = 'update_routing_rule' and not enabled_value then
      select
        case when destination_note_id is not null then 'note' else 'space' end,
        coalesce(destination_note_id,destination_space_id)
      into existing_destination_kind,existing_destination_id
      from public.routing_rules
      where user_id = p_owner_id and id = p_rule_id;
      if not found then
        raise exception using errcode = 'P0001', message = 'not_found';
      end if;
    end if;
    if p_scope <> 'update_routing_rule'
      or enabled_value
      or destination_kind_value is distinct from existing_destination_kind
      or destination_id_value is distinct from existing_destination_id
    then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_destination_invalid';
    end if;
  end if;

  if claim_row.expected_revision > 0 then
    select * into rule_row from public.routing_rules
    where user_id = p_owner_id and id = p_rule_id
    for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if rule_row.current_revision <> p_expected_revision
      or claim_row.condition_revision <> rule_row.condition_revision
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  else
    if exists (select 1 from public.routing_rules where id = p_rule_id) then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if (select count(*) from public.routing_rules where user_id = p_owner_id)
      >= 1000
    then
      raise exception using errcode = 'P0001', message = 'routing_rule_limit';
    end if;
  end if;

  if p_scope = 'create_routing_rule' then
    if enabled_value and (
      select count(*) from public.routing_rules
      where user_id = p_owner_id and enabled
    ) >= 256 then
      raise exception using errcode = 'P0001', message = 'routing_rule_enabled_limit';
    end if;
    rule_row := private.insert_encrypted_routing_rule(
      p_rule_id,p_owner_id,enabled_value,rule_type_value,
      destination_kind_value,destination_id_value,priority_value,
      'explicit',null,condition_cipher,claim_row.occurred_at
    );
  elsif p_scope = 'update_routing_rule' then
    if not (rule_row.source = 'explicit'
      or rule_row.proposal_state = 'accepted')
    then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    end if;
    if enabled_value and not rule_row.enabled and (
      select count(*) from public.routing_rules
      where user_id = p_owner_id and enabled and id <> p_rule_id
    ) >= 256 then
      raise exception using errcode = 'P0001', message = 'routing_rule_enabled_limit';
    end if;
    update public.routing_rules set
      enabled = enabled_value,
      rule_type = rule_type_value,
      destination_note_id = case when destination_kind_value = 'note'
        then destination_id_value else null end,
      destination_space_id = case when destination_kind_value = 'space'
        then destination_id_value else null end,
      priority = priority_value,
      condition_revision = case when condition_changed
        then claim_row.target_condition_revision else condition_revision end,
      condition_envelope = case when condition_changed
        then condition_cipher -> 'envelope' else condition_envelope end,
      condition_key_id = case when condition_changed
        then condition_cipher ->> 'keyId' else condition_key_id end,
      condition_key_class = case when condition_changed
        then (condition_cipher ->> 'keyClass')::public.content_key_class
        else condition_key_class end,
      condition_key_purpose = case when condition_changed
        then (condition_cipher ->> 'keyPurpose')::public.content_key_purpose
        else condition_key_purpose end,
      condition_key_version = case when condition_changed
        then (condition_cipher ->> 'keyVersion')::integer
        else condition_key_version end,
      current_revision = claim_row.target_revision,
      updated_at = claim_row.occurred_at
    where user_id = p_owner_id and id = p_rule_id
    returning * into rule_row;
  elsif p_scope = 'observe_routing_rule_proposal' then
    perform private.assert_routing_rule_feedback_observation(
      p_owner_id, feedback_event_id_value,
      destination_kind_value, destination_id_value
    );
    if claim_row.expected_revision = 0 then
      rule_row := private.insert_encrypted_routing_rule(
        p_rule_id,p_owner_id,false,rule_type_value,
        destination_kind_value,destination_id_value,priority_value,
        'correction_suggested','observing',condition_cipher,
        claim_row.occurred_at
      );
    else
      if rule_row.source <> 'correction_suggested'
        or rule_row.proposal_state <> 'observing' or rule_row.enabled
        or rule_row.rule_type <> rule_type_value
        or rule_row.priority <> priority_value
        or (destination_kind_value = 'note' and (
          rule_row.destination_note_id <> destination_id_value
          or rule_row.destination_space_id is not null
        )) or (destination_kind_value = 'space' and (
          rule_row.destination_space_id <> destination_id_value
          or rule_row.destination_note_id is not null
        ))
      then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
    end if;
    begin
      insert into public.routing_rule_proposal_observations (
        user_id,rule_id,feedback_event_id,observed_at
      ) values (
        p_owner_id,p_rule_id,feedback_event_id_value,claim_row.occurred_at
      );
    exception when unique_violation then
      raise exception using errcode = 'P0001',
        message = 'proposal_observation_replayed';
    end;
    update public.feedback_events
    set routing_rule_id = p_rule_id
    where user_id = p_owner_id and id = feedback_event_id_value
      and (routing_rule_id is null or routing_rule_id = p_rule_id);
    if not found then
      raise exception using errcode = 'P0001',
        message = 'invalid_proposal_observation';
    end if;
    select count(*) into observation_count
    from public.routing_rule_proposal_observations
    where user_id = p_owner_id and rule_id = p_rule_id;
    if claim_row.expected_revision = 0 and observation_count <> 1 then
      raise exception using errcode = 'P0001',
        message = 'invalid_proposal_observation_count';
    elsif claim_row.expected_revision > 0 then
      if observation_count <> 2 then
        raise exception using errcode = 'P0001',
          message = 'invalid_proposal_observation_count';
      end if;
      update public.routing_rules set
        proposal_state = 'offered',
        current_revision = claim_row.target_revision,
        updated_at = claim_row.occurred_at
      where user_id = p_owner_id and id = p_rule_id
      returning * into rule_row;
    end if;
    update public.routing_rule_observation_epochs
    set observation_epoch = observation_epoch + 1,
      updated_at = claim_row.occurred_at
    where user_id = p_owner_id
      and observation_epoch = current_observation_epoch
    returning observation_epoch into current_observation_epoch;
    if not found then
      raise exception using errcode = 'P0001',
        message = 'routing_rule_observation_stale';
    end if;
  elsif p_scope = 'accept_routing_rule_proposal' then
    if rule_row.proposal_state <> 'offered' or rule_row.enabled then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    end if;
    if (select count(*) from public.routing_rules
      where user_id = p_owner_id and enabled and id <> p_rule_id) >= 256
    then
      raise exception using errcode = 'P0001', message = 'routing_rule_enabled_limit';
    end if;
    update public.routing_rules set
      proposal_state = 'accepted', enabled = true,
      current_revision = claim_row.target_revision,
      updated_at = claim_row.occurred_at
    where user_id = p_owner_id and id = p_rule_id
    returning * into rule_row;
  else
    if rule_row.proposal_state <> 'offered' or rule_row.enabled then
      raise exception using errcode = 'P0001', message = 'invalid_proposal_state';
    end if;
    update public.routing_rules set
      proposal_state = 'declined', enabled = false,
      current_revision = claim_row.target_revision,
      updated_at = claim_row.occurred_at
    where user_id = p_owner_id and id = p_rule_id
    returning * into rule_row;
  end if;

  result_condition_revision := rule_row.condition_revision;
  result_proposal_state := rule_row.proposal_state;
  perform private.consume_content_key_reservations(
    p_owner_id, reservation_values, 'encrypted_routing_rule_command',
    p_idempotency_key
  );
  if condition_changed then
    perform private.record_content_encryption_verification(
      p_owner_id,'routing_rule',p_rule_id,rule_row.condition_revision,
      condition_cipher -> 'envelope',condition_verification
    );
    encrypted_delta := 2;
  end if;
  claim_row := private.finish_encrypted_routing_rule_write(
    claim_row,request_mac_value,response_cipher_value,
    response_verification_value,rule_row.current_revision,
    result_condition_revision,result_proposal_state,'routing_rule'
  );
  update public.content_encryption_rollouts set
    encrypted_object_count = encrypted_object_count + encrypted_delta,
    verified_object_count = verified_object_count + encrypted_delta
  where user_id = p_owner_id;
  perform private.emit_user_event(p_owner_id,'routing_rule',p_rule_id);
  return private.encrypted_routing_rule_result(claim_row,false);
exception when invalid_text_representation or datetime_field_overflow
  or numeric_value_out_of_range
then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.delete_encrypted_routing_rule(
  p_owner_id uuid,
  p_rule_id text,
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
  claim_row public.encrypted_routing_rule_write_claims%rowtype;
  rule_row public.routing_rules%rowtype;
  request_mac_value jsonb;
  response_cipher_value jsonb;
  response_verification_value jsonb;
  occurred_value timestamptz;
  destination_kind_value text;
  destination_id_value text;
  result_revision integer;
  result_state public.routing_rule_proposal_state;
  response_type text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_rule_id is null
    or p_rule_id !~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision is null or p_expected_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or p_command is null or jsonb_typeof(p_command) <> 'object'
    or p_command - array[
      'occurredAt','requestMac','responseCipher','responseVerificationMac'
    ] <> '{}'::jsonb
    or not p_command ?& array[
      'occurredAt','requestMac','responseCipher','responseVerificationMac'
    ]
    or jsonb_typeof(p_command -> 'occurredAt') <> 'string'
    or not private.valid_iso_offset_datetime(p_command ->> 'occurredAt')
    or jsonb_typeof(p_command -> 'requestMac') <> 'object'
    or jsonb_typeof(p_command -> 'responseCipher') <> 'object'
    or jsonb_typeof(p_command -> 'responseVerificationMac') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_mac_value := p_command -> 'requestMac';
  response_cipher_value := p_command -> 'responseCipher';
  response_verification_value := p_command -> 'responseVerificationMac';
  occurred_value := (p_command ->> 'occurredAt')::timestamptz;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key,0
  ));
  select * into claim_row
  from public.encrypted_routing_rule_write_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if claim_row.scope <> 'delete_routing_rule'
      or claim_row.rule_id <> p_rule_id
      or claim_row.expected_revision <> p_expected_revision
      or claim_row.occurred_at <> occurred_value
      or not private.valid_encrypted_write_mac(
        request_mac_value,p_owner_id,'private_manual',true
      )
      or request_mac_value ->> 'mac' <> claim_row.request_mac
      or request_mac_value ->> 'keyId' <> claim_row.request_mac_key_id
      or request_mac_value ->> 'keyClass'
        <> claim_row.request_mac_key_class::text
      or request_mac_value ->> 'keyPurpose'
        <> claim_row.request_mac_key_purpose::text
      or (request_mac_value ->> 'keyVersion')::integer
        <> claim_row.request_mac_key_version
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    if claim_row.completed_at is null then
      raise exception using errcode = 'P0001', message = 'write_not_completed';
    end if;
    return private.encrypted_routing_rule_result(claim_row,true);
  end if;
  if not private.valid_encrypted_write_mac(
    request_mac_value,p_owner_id,'private_manual',false
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_request_mac_key';
  end if;
  if occurred_value <> date_trunc('milliseconds',occurred_value)
    or occurred_value < clock_timestamp() - interval '5 minutes'
    or occurred_value > clock_timestamp() + interval '5 minutes'
    or not private.valid_encrypted_write_cipher(
      response_cipher_value,p_owner_id,
      'idempotency:' || p_idempotency_key,1,
      'idempotency_response','private_manual'
    )
    or not private.valid_encrypted_write_mac(
      response_verification_value,p_owner_id,'private_manual',false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout',0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
      and state in ('dual_write','encrypted_read','encrypted_only','contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-routing-rules',0
  ));

  select
    case when destination_note_id is not null then 'note' else 'space' end,
    coalesce(destination_note_id,destination_space_id)
  into destination_kind_value,destination_id_value
  from public.routing_rules
  where user_id = p_owner_id and id = p_rule_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if destination_kind_value = 'note' then
    perform id from public.notes
    where user_id = p_owner_id and id = destination_id_value for share;
  else
    perform id from public.spaces
    where user_id = p_owner_id and id = destination_id_value for share;
  end if;
  select * into rule_row from public.routing_rules
  where user_id = p_owner_id and id = p_rule_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rule_row.current_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  result_revision := case when rule_row.proposal_state = 'offered'
    then p_expected_revision + 1 else p_expected_revision end;
  result_state := case when rule_row.proposal_state = 'offered'
    then 'declined'::public.routing_rule_proposal_state
    else rule_row.proposal_state end;
  insert into public.encrypted_routing_rule_write_claims (
    user_id,idempotency_key,scope,rule_id,expected_revision,target_revision,
    condition_revision,target_condition_revision,occurred_at,
    request_mac_key_id,request_mac_key_class,request_mac_key_purpose,
    request_mac_key_version,request_mac
  ) values (
    p_owner_id,p_idempotency_key,'delete_routing_rule',p_rule_id,
    p_expected_revision,result_revision,rule_row.condition_revision,
    rule_row.condition_revision,occurred_value,request_mac_value ->> 'keyId',
    (request_mac_value ->> 'keyClass')::public.content_key_class,
    (request_mac_value ->> 'keyPurpose')::public.content_key_purpose,
    (request_mac_value ->> 'keyVersion')::integer,
    request_mac_value ->> 'mac'
  ) returning * into claim_row;

  if rule_row.proposal_state = 'offered' then
    update public.routing_rules set
      proposal_state = 'declined',enabled = false,
      current_revision = result_revision,updated_at = occurred_value
    where user_id = p_owner_id and id = p_rule_id;
    response_type := 'routing_rule';
  elsif rule_row.proposal_state = 'declined' then
    response_type := 'routing_rule';
  else
    delete from public.routing_rules
    where user_id = p_owner_id and id = p_rule_id;
    delete from public.content_encryption_verifications
    where user_id = p_owner_id and surface = 'routing_rule'
      and resource_id = p_rule_id;
    response_type := 'routing_rule_tombstone';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id,jsonb_build_array(response_cipher_value),
    'encrypted_routing_rule_command',p_idempotency_key
  );
  claim_row := private.finish_encrypted_routing_rule_write(
    claim_row,request_mac_value,response_cipher_value,
    response_verification_value,result_revision,
    rule_row.condition_revision,result_state,response_type
  );
  update public.content_encryption_rollouts set
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1
  where user_id = p_owner_id;
  perform private.emit_user_event(p_owner_id,'routing_rule',p_rule_id);
  return private.encrypted_routing_rule_result(claim_row,false);
exception when invalid_text_representation or datetime_field_overflow
  or numeric_value_out_of_range
then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.preserve_routing_rule_command_timestamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (
    to_jsonb(new) - array['last_fired_at','updated_at']
  ) = (
    to_jsonb(old) - array['last_fired_at','updated_at']
  ) then
    new.updated_at := old.updated_at;
  elsif new.updated_at is not distinct from old.updated_at then
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists routing_rules_set_updated_at on public.routing_rules;
create trigger routing_rules_set_updated_at
before update on public.routing_rules
for each row execute function private.preserve_routing_rule_command_timestamp();

create or replace function private.valid_capture_routing_rule_match(
  p_match jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_match is not null
    and jsonb_typeof(p_match) = 'object'
    and p_match ?& array[
      'ruleId','ruleRevision','destinationKind','destinationId',
      'priority','matched'
    ]
    and p_match - array[
      'ruleId','ruleRevision','destinationKind','destinationId',
      'priority','matched'
    ] = '{}'::jsonb
    and jsonb_typeof(p_match -> 'ruleId') = 'string'
    and p_match ->> 'ruleId' ~ '^rule_[0-9A-HJKMNP-TV-Z]{26}$'
    and jsonb_typeof(p_match -> 'ruleRevision') = 'number'
    and p_match ->> 'ruleRevision' ~ '^[1-9][0-9]{0,9}$'
    and (p_match ->> 'ruleRevision')::numeric <= 2147483647
    and jsonb_typeof(p_match -> 'destinationKind') = 'string'
    and p_match ->> 'destinationKind' in ('note','space')
    and jsonb_typeof(p_match -> 'destinationId') = 'string'
    and (
      (p_match ->> 'destinationKind' = 'note'
        and p_match ->> 'destinationId'
          ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$')
      or (p_match ->> 'destinationKind' = 'space'
        and p_match ->> 'destinationId'
          ~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$')
    )
    and jsonb_typeof(p_match -> 'priority') = 'number'
    and p_match ->> 'priority' ~ '^[0-9]{1,5}$'
    and (p_match ->> 'priority')::numeric between 0 and 10000
    and p_match -> 'matched' = 'true'::jsonb;
$$;

create or replace function private.enforce_organization_job_rule_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule_row public.routing_rules%rowtype;
begin
  -- The submitted snapshot carries the destination, allowing destination ->
  -- rule lock order without decrypting or first locking the rule.
  if not private.lock_routing_rule_destination(
    new.user_id,new.destination_kind,new.destination_id
  ) then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_match_stale';
  end if;
  select * into rule_row
  from public.routing_rules
  where id = new.rule_id and user_id = new.user_id
  for share;
  if not found
    or not rule_row.enabled
    or not (
      rule_row.source = 'explicit'
      or rule_row.proposal_state = 'accepted'
    )
    or rule_row.current_revision <> new.rule_revision
    or rule_row.priority <> new.priority
    or not new.matched
    or (new.destination_kind = 'note' and (
      rule_row.destination_note_id is distinct from new.destination_id
      or rule_row.destination_space_id is not null
    ))
    or (new.destination_kind = 'space' and (
      rule_row.destination_space_id is distinct from new.destination_id
      or rule_row.destination_note_id is not null
    ))
  then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_match_stale';
  end if;
  return new;
end;
$$;

alter function public.create_encrypted_capture_with_job(uuid,jsonb)
  set schema private;
alter function private.create_encrypted_capture_with_job(uuid,jsonb)
  rename to create_encrypted_capture_with_job_e1;

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
  result_value jsonb;
  match_value jsonb;
  stored_match jsonb;
  job_id_value text;
  replayed_value boolean;
  explicit_destination_value text;
  occurred_value timestamptz;
  snapshot_found boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_capture is null or jsonb_typeof(p_capture) <> 'object'
    or not p_capture ? 'routingRuleMatch'
    or p_capture - array[
      'clientCaptureId','jobId','occurredAt','contentCipher','contentMac',
      'contentLength','source','deviceId','clientCreatedAt','clientTimezone',
      'privacy','explicitDestinationNoteId','expansionDisabled',
      'privateReceiptCipher','privateReceiptVerificationMac','routingRuleMatch'
    ] <> '{}'::jsonb
    or jsonb_typeof(p_capture -> 'routingRuleMatch') not in ('null','object')
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  match_value := p_capture -> 'routingRuleMatch';
  explicit_destination_value := nullif(
    p_capture ->> 'explicitDestinationNoteId',''
  );
  if (jsonb_typeof(match_value) = 'object' and (
      not private.valid_capture_routing_rule_match(match_value)
      or p_capture ->> 'privacy' <> 'ai_assisted'
      or explicit_destination_value is not null
    )) or (
      explicit_destination_value is not null
      and jsonb_typeof(match_value) <> 'null'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;

  -- The E1 implementation retains its reviewed crypto, replay, and capture ->
  -- job atomicity. Removing only the new control key preserves its exact wire.
  result_value := private.create_encrypted_capture_with_job_e1(
    p_owner_id,p_capture - 'routingRuleMatch'
  );
  job_id_value := result_value ->> 'jobId';
  replayed_value := (result_value ->> 'replayed')::boolean;

  if replayed_value then
    select jsonb_build_object(
      'ruleId',rule_id,'ruleRevision',rule_revision,
      'destinationKind',destination_kind,'destinationId',destination_id,
      'priority',priority,'matched',matched
    ) into stored_match
    from public.organization_job_rule_matches
    where job_id = job_id_value and user_id = p_owner_id;
    snapshot_found := found;
    if (jsonb_typeof(match_value) = 'null' and snapshot_found)
      or (jsonb_typeof(match_value) = 'object' and (
        not snapshot_found or stored_match is distinct from match_value
      ))
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    return result_value;
  end if;

  if explicit_destination_value is not null and not exists (
    select 1 from public.notes
    where user_id = p_owner_id and id = explicit_destination_value
      and deleted_at is null and archived_at is null
  ) then
    raise exception using errcode = '42501',
      message = 'explicit_destination_not_owned';
  end if;
  if jsonb_typeof(match_value) = 'object' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-routing-rules',0
    ));
    insert into public.organization_job_rule_matches (
      job_id,user_id,rule_id,rule_revision,destination_kind,
      destination_id,priority,matched
    ) values (
      job_id_value,p_owner_id,match_value ->> 'ruleId',
      (match_value ->> 'ruleRevision')::integer,
      match_value ->> 'destinationKind',match_value ->> 'destinationId',
      (match_value ->> 'priority')::integer,true
    );
    occurred_value := (p_capture ->> 'occurredAt')::timestamptz;
    update public.routing_rules
    set last_fired_at = greatest(
      coalesce(last_fired_at,occurred_value),occurred_value
    )
    where user_id = p_owner_id and id = match_value ->> 'ruleId';
  end if;
  return result_value;
exception when invalid_text_representation or datetime_field_overflow
  or numeric_value_out_of_range
then
  raise exception using errcode = '22023', message = 'invalid_capture';
end;
$$;

-- The physical encrypted-storage contraction is an operator-invoked runtime
-- migration. E2 interposes the public capture RPC, so its four reviewed
-- capture rewrites must follow the preserved E1 implementation now living in
-- private; the E2 wrapper itself contains none of the removed plaintext
-- columns and remains in place after contraction.
do $contract_capture_target_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.apply_encrypted_storage_contract(text,text)'::regprocedure
  );
  old_target constant text :=
    '''public.create_encrypted_capture_with_job(uuid,jsonb)''';
  new_target constant text :=
    '''private.create_encrypted_capture_with_job_e1(uuid,jsonb)''';
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_target,''))
  ) / pg_catalog.length(old_target);
  if occurrence_count <> 4 then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_storage_contract_capture_target_drift';
  end if;
  execute pg_catalog.replace(definition,old_target,new_target);
end;
$contract_capture_target_patch$;

create or replace function private.organization_job_routing_rule_control(
  p_job_id text,
  p_owner_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when snapshot.job_id is null then null else jsonb_build_object(
    'ruleId',snapshot.rule_id,
    'ruleRevision',snapshot.rule_revision,
    'destinationKind',snapshot.destination_kind,
    'destinationId',snapshot.destination_id,
    'priority',snapshot.priority,
    'matched',snapshot.matched
  ) end
  from (select p_job_id as requested_job) as requested
  left join public.organization_job_rule_matches as snapshot
    on snapshot.job_id = requested.requested_job
    and snapshot.user_id = p_owner_id;
$$;

create or replace function private.organization_job_routing_destination_status(
  p_job_id text,
  p_owner_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.routing_rule_destination_status(
    snapshot.user_id,snapshot.destination_kind,snapshot.destination_id
  )
  from public.organization_job_rule_matches as snapshot
  where snapshot.job_id = p_job_id and snapshot.user_id = p_owner_id;
$$;

create or replace function private.safe_capture_local_date(
  p_created_at timestamptz,
  p_timezone text
)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1 from pg_catalog.pg_timezone_names()
    where name = p_timezone
  ) then (p_created_at at time zone p_timezone)::date else null end;
$$;

create or replace function private.valid_organizer_routing_rule_control(
  p_controls jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_controls is not null
    and jsonb_typeof(p_controls) = 'object'
    and p_controls ?& array[
      'explicitDestinationNoteId','expansionDisabled','ruleMatch'
    ]
    and p_controls - array[
      'explicitDestinationNoteId','expansionDisabled','ruleMatch'
    ] = '{}'::jsonb
    and jsonb_typeof(p_controls -> 'explicitDestinationNoteId')
      in ('null','string')
    and jsonb_typeof(p_controls -> 'expansionDisabled') = 'boolean'
    and jsonb_typeof(p_controls -> 'ruleMatch') in ('null','object')
    and not (
      jsonb_typeof(p_controls -> 'explicitDestinationNoteId') = 'string'
      and jsonb_typeof(p_controls -> 'ruleMatch') = 'object'
    )
    and (
      jsonb_typeof(p_controls -> 'ruleMatch') = 'null'
      or (
        (p_controls -> 'ruleMatch') ?& array[
          'ruleId','ruleRevision','destinationKind','destinationId',
          'priority','matched'
        ]
        and (p_controls -> 'ruleMatch') - array[
          'ruleId','ruleRevision','destinationKind','destinationId',
          'priority','matched'
        ] = '{}'::jsonb
        and private.valid_capture_routing_rule_match(
          p_controls -> 'ruleMatch'
        )
      )
  );
$$;

alter table public.encrypted_organizer_preparations
  drop constraint if exists encrypted_organizer_preparations_controls_check;
alter table public.encrypted_organizer_candidate_pages
  drop constraint if exists encrypted_organizer_candidate_pages_controls_check;

update public.encrypted_organizer_preparations
set controls = controls || jsonb_build_object('ruleMatch',null)
where controls is not null and not controls ? 'ruleMatch';
update public.encrypted_organizer_candidate_pages
set controls = controls || jsonb_build_object('ruleMatch',null)
where not controls ? 'ruleMatch';

alter table public.encrypted_organizer_preparations
  add constraint encrypted_organizer_preparations_controls_check check (
    controls is null
    or private.valid_organizer_routing_rule_control(controls)
  );
alter table public.encrypted_organizer_candidate_pages
  add constraint encrypted_organizer_candidate_pages_controls_check check (
    private.valid_organizer_routing_rule_control(controls)
  );

-- Add the immutable, content-free snapshot to every organizer projection.
do $organizer_control_projection_patch$
declare
  target record;
  definition text;
  old_fragment text;
  new_fragment text;
  occurrence_count integer;
begin
  for target in
    select * from (values
      ('claim_encrypted_organizer_jobs_impl',
       'p_worker_id text, p_claim_limit integer, p_lease_seconds integer',
       $old$'expansionDisabled', capture_row.expansion_disabled$old$,
       $new$'expansionDisabled', capture_row.expansion_disabled,
        'ruleMatch', private.organization_job_routing_rule_control(
          job_row.id, job_row.user_id
        )$new$),
      ('list_encrypted_organizer_candidates_impl',
       'p_job_id text, p_lease_token text, p_candidate_limit integer',
       $old$'expansionDisabled', capture.expansion_disabled$old$,
       $new$'expansionDisabled', capture.expansion_disabled,
      'ruleMatch', private.organization_job_routing_rule_control(
        job_row.id, job_row.user_id
      )$new$),
      ('heartbeat_encrypted_organizer_job_impl',
       'p_job_id text, p_lease_token text, p_lease_seconds integer, p_candidate_manifest jsonb',
       $old$'expansionDisabled', capture.expansion_disabled$old$,
       $new$'expansionDisabled', capture.expansion_disabled,
    'ruleMatch', private.organization_job_routing_rule_control(
      job_row.id, job_row.user_id
    )$new$),
      ('select_encrypted_organizer_candidates_impl',
       'p_job_id text, p_lease_token text, p_selection jsonb',
       $old$'expansionDisabled', capture.expansion_disabled$old$,
       $new$'expansionDisabled', capture.expansion_disabled,
    'ruleMatch', private.organization_job_routing_rule_control(
      job_row.id, job_row.user_id
    )$new$)
    ) as patch(function_name,identity_args,old_value,new_value)
  loop
    select pg_catalog.pg_get_functiondef(procedure.oid)
    into definition
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = target.function_name
      and pg_catalog.pg_get_function_identity_arguments(procedure.oid)
        = target.identity_args;
    old_fragment := target.old_value;
    new_fragment := target.new_value;
    occurrence_count := case when definition is null then 0 else (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
    ) / pg_catalog.length(old_fragment) end;
    if occurrence_count <> 1 then
      raise exception using errcode = 'P0001',
        message = 'organizer_routing_control_projection_contract_drift';
    end if;
    execute pg_catalog.replace(definition,old_fragment,new_fragment);
  end loop;
end;
$organizer_control_projection_patch$;

-- The heartbeat wire validator accepts exactly the three controls. Stored
-- equality plus the table constraint validates the nested snapshot shape.
do $organizer_heartbeat_shape_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.heartbeat_encrypted_organizer_job_impl(text,text,integer,jsonb)'::regprocedure
  );
  old_fragment constant text := $old$array[
      'explicitDestinationNoteId', 'expansionDisabled'
    ]$old$;
  new_fragment constant text := $new$array[
      'explicitDestinationNoteId', 'expansionDisabled', 'ruleMatch'
    ]$new$;
  count_value integer;
begin
  count_value := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if count_value <> 2 then
    raise exception using errcode = 'P0001',
      message = 'organizer_routing_heartbeat_shape_contract_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$organizer_heartbeat_shape_patch$;

-- Base candidates are deterministically fenced to an active rule destination.
do $organizer_base_candidate_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.list_encrypted_organizer_candidates_impl(text,text,integer)'::regprocedure
  );
  old_before constant text := $old$  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;

  with eligible as ($old$;
  new_before constant text := $new$  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;
  explicit_destination_value := coalesce(
    explicit_destination_value,
    case when private.organization_job_routing_destination_status(
        job_row.id,job_row.user_id
      ) = 'active'
      and controls_value #>> '{ruleMatch,destinationKind}' = 'note'
      then controls_value #>> '{ruleMatch,destinationId}'
      else null end
  );

  with eligible as ($new$;
  old_filter constant text := $old$      and note.content_key_purpose = 'object_wrap'
      and ($old$;
  new_filter constant text := $new$      and note.content_key_purpose = 'object_wrap'
      and (
        jsonb_typeof(controls_value -> 'ruleMatch') = 'null'
        or (
          private.organization_job_routing_destination_status(
            job_row.id,job_row.user_id
          ) = 'active'
          and note.is_open
          and (
            (controls_value #>> '{ruleMatch,destinationKind}' = 'note'
              and note.id = controls_value #>> '{ruleMatch,destinationId}')
            or (controls_value #>> '{ruleMatch,destinationKind}' = 'space'
              and note.space_id = controls_value #>> '{ruleMatch,destinationId}'
              and note.type in ('list','log')
              and note.daily_date = (
                select private.safe_capture_local_date(
                  capture.client_created_at,capture.client_timezone
                )
                from public.captures as capture
                where capture.id = job_row.capture_id
                  and capture.user_id = job_row.user_id
              ))
          )
        )
      )
      and ($new$;
begin
  if pg_catalog.strpos(definition,old_before) = 0
    or pg_catalog.strpos(definition,old_filter) = 0
  then
    raise exception using errcode = 'P0001',
      message = 'organizer_routing_base_candidate_contract_drift';
  end if;
  definition := pg_catalog.replace(definition,old_before,new_before);
  execute pg_catalog.replace(definition,old_filter,new_filter);
end;
$organizer_base_candidate_patch$;

-- RAG-selected candidates use the same destination fence before disclosure.
do $organizer_rag_candidate_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)'::regprocedure
  );
  old_before constant text := $old$  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select * into generation_row$old$;
  new_before constant text := $new$  job_row := private.assert_encrypted_organizer_lease(
    p_job_id, p_lease_token, true
  );
  select jsonb_build_object(
    'explicitDestinationNoteId', capture.explicit_destination_note_id,
    'expansionDisabled', capture.expansion_disabled,
    'ruleMatch', private.organization_job_routing_rule_control(
      job_row.id, job_row.user_id
    )
  ) into controls_value
  from public.captures as capture
  where capture.id = job_row.capture_id
    and capture.user_id = job_row.user_id;
  select * into generation_row$new$;
  old_filter constant text := $old$      and note.content_key_purpose = 'object_wrap'
    join public.user_content_keys$old$;
  new_filter constant text := $new$      and note.content_key_purpose = 'object_wrap'
      and (
        jsonb_typeof(controls_value -> 'ruleMatch') = 'null'
        or (
          private.organization_job_routing_destination_status(
            job_row.id,job_row.user_id
          ) = 'active'
          and note.is_open
          and (
            (controls_value #>> '{ruleMatch,destinationKind}' = 'note'
              and note.id = controls_value #>> '{ruleMatch,destinationId}')
            or (controls_value #>> '{ruleMatch,destinationKind}' = 'space'
              and note.space_id = controls_value #>> '{ruleMatch,destinationId}'
              and note.type in ('list','log')
              and note.daily_date = (
                select private.safe_capture_local_date(
                  capture.client_created_at,capture.client_timezone
                )
                from public.captures as capture
                where capture.id = job_row.capture_id
                  and capture.user_id = job_row.user_id
              ))
          )
        )
      )
    join public.user_content_keys$new$;
begin
  if pg_catalog.strpos(definition,old_before) = 0
    or pg_catalog.strpos(definition,old_filter) = 0
  then
    raise exception using errcode = 'P0001',
      message = 'organizer_routing_rag_candidate_contract_drift';
  end if;
  definition := pg_catalog.replace(definition,old_before,new_before);
  execute pg_catalog.replace(definition,old_filter,new_filter);
end;
$organizer_rag_candidate_patch$;

create or replace function private.routing_rule_organizer_review_required(
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
  command_hash_value text;
  result_value jsonb;
  lease_value uuid;
begin
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_lease_token is null
    or p_command is null
    or jsonb_typeof(p_command) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    lease_value := p_lease_token::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  command_hash_value := private.request_hash(jsonb_build_object(
    'domain','unfiled.encrypted-organizer-commit.v1',
    'jobId',p_job_id,'command',p_command
  ));
  job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = job_row.id for update;
  if not found
    or preparation.user_id <> job_row.user_id
    or preparation.capture_id <> job_row.capture_id
    or preparation.attempt <> job_row.attempt
    or preparation.lease_token <> lease_value
  then
    raise exception using errcode = '42501',
      message = 'invalid_or_expired_lease';
  end if;
  if preparation.commit_replan_result is not null then
    if preparation.commit_replan_command_hash is distinct from command_hash_value then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    return jsonb_set(preparation.commit_replan_result,
      '{replayed}','true'::jsonb,true);
  end if;
  job_row := private.assert_encrypted_organizer_lease(
    p_job_id,p_lease_token,true
  );
  if preparation.completed_at is not null
    or preparation.write_reservation_id is null
  then
    raise exception using errcode = '42501',
      message = 'invalid_or_expired_lease';
  end if;
  if job_row.replan_count = 0 then
    update public.organization_jobs set replan_count = 1
    where id = job_row.id and state = 'running'
      and lease_token = job_row.lease_token
    returning * into job_row;
  end if;
  perform private.burn_encrypted_organizer_reservations(
    preparation.job_id,preparation.lease_token
  );
  result_value := jsonb_build_object(
    'jobId',job_row.id,
    'outcome','review_required',
    'noteId',null,
    'revision',null,
    'conflictReason','candidate_eligibility',
    'replanCount',job_row.replan_count,
    'replayed',false
  );
  update public.encrypted_organizer_preparations set
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
end;
$$;

alter function private.commit_encrypted_organizer_job_impl(text,text,jsonb)
  rename to commit_encrypted_organizer_job_impl_e1;

create function private.commit_encrypted_organizer_job_impl(
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
  preparation public.encrypted_organizer_preparations%rowtype;
  controls_value jsonb;
  match_value jsonb;
  status_value text;
  destination_kind_value text;
  destination_id_value text;
  local_date_value date;
  daily_candidate_count integer;
  daily_candidate_id text;
  expected_note_type text;
  invalid_target boolean := false;
begin
  -- Preserve the E1 advisory-first organizer lock order before inspecting
  -- replay/preparation state. The delegated implementation re-enters the same
  -- transaction locks safely.
  if p_job_id is null
    or p_job_id !~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'
  then
    return private.commit_encrypted_organizer_job_impl_e1(
      p_job_id,p_lease_token,p_command
    );
  end if;
  perform private.lock_encrypted_organizer_job_rollout(p_job_id);
  select prep.* into preparation
  from public.encrypted_organizer_preparations as prep
  where prep.job_id = p_job_id;
  if not found then
    return private.commit_encrypted_organizer_job_impl_e1(
      p_job_id,p_lease_token,p_command
    );
  end if;
  if preparation.commit_replan_result is not null then
    return private.routing_rule_organizer_review_required(
      p_job_id,p_lease_token,p_command
    );
  end if;
  if found and preparation.completed_at is not null then
    return private.commit_encrypted_organizer_job_impl_e1(
      p_job_id,p_lease_token,p_command
    );
  end if;
  select coalesce(preparation.controls,page.controls) into controls_value
  from public.encrypted_organizer_candidate_pages as page
  where page.job_id = p_job_id;
  match_value := controls_value -> 'ruleMatch';
  if match_value is null or jsonb_typeof(match_value) = 'null'
    or p_command ->> 'outcome' = 'review'
  then
    return private.commit_encrypted_organizer_job_impl_e1(
      p_job_id,p_lease_token,p_command
    );
  end if;

  destination_kind_value := match_value ->> 'destinationKind';
  destination_id_value := match_value ->> 'destinationId';
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    preparation.user_id::text || ':encrypted-routing-rules',0
  ));
  if private.lock_routing_rule_destination(
    preparation.user_id,destination_kind_value,destination_id_value
  ) then
    status_value := 'active';
  else
    status_value := private.organization_job_routing_destination_status(
      p_job_id,preparation.user_id
    );
  end if;
  if status_value <> 'active' then
    invalid_target := true;
  elsif destination_kind_value = 'note' then
    invalid_target := preparation.mode <> 'append'
      or preparation.note_id <> destination_id_value
      or not exists (
        select 1 from public.notes as note
        where note.user_id = preparation.user_id
          and note.id = destination_id_value
          and note.is_open
          and note.privacy = 'ai_assisted'
          and note.archived_at is null
          and note.deleted_at is null
      );
  else
    select private.safe_capture_local_date(
      capture.client_created_at,capture.client_timezone
    )
    into local_date_value
    from public.captures as capture
    where capture.id = preparation.capture_id
      and capture.user_id = preparation.user_id;
    expected_note_type := p_command #>> '{noteWrite,noteState,type}';
    if expected_note_type in ('list','log') then
      select count(*)::integer,min(note.id)
      into daily_candidate_count,daily_candidate_id
      from public.notes as note
      where note.user_id = preparation.user_id
        and note.space_id = destination_id_value
        and note.type::text = expected_note_type
        and note.daily_date = local_date_value;
      if preparation.mode = 'create' then
        invalid_target := daily_candidate_count <> 0
          or p_command #>> '{noteWrite,noteState,spaceId}'
            is distinct from destination_id_value
          or p_command #>> '{noteWrite,noteState,dailyDate}'
            is distinct from local_date_value::text;
      else
        invalid_target := daily_candidate_count <> 1
          or daily_candidate_id <> preparation.note_id
          or p_command #>> '{noteWrite,noteState,spaceId}'
            is distinct from destination_id_value
          or p_command #>> '{noteWrite,noteState,dailyDate}'
            is distinct from local_date_value::text
          or not exists (
            select 1 from public.notes as note
            where note.user_id = preparation.user_id
              and note.id = preparation.note_id
              and note.space_id = destination_id_value
              and note.type::text = expected_note_type
              and note.daily_date = local_date_value
              and note.is_open
              and note.privacy = 'ai_assisted'
              and note.archived_at is null
              and note.deleted_at is null
          );
      end if;
    elsif expected_note_type in ('generic','principle','project') then
      invalid_target := preparation.mode <> 'create'
        or p_command #>> '{noteWrite,noteState,spaceId}'
          is distinct from destination_id_value
        or p_command #> '{noteWrite,noteState,dailyDate}'
          is distinct from 'null'::jsonb;
    else
      invalid_target := true;
    end if;
  end if;
  if invalid_target then
    return private.routing_rule_organizer_review_required(
      p_job_id,p_lease_token,p_command
    );
  end if;
  return private.commit_encrypted_organizer_job_impl_e1(
    p_job_id,p_lease_token,p_command
  );
end;
$$;

-- Add the public/CAS revision, proposal lifecycle, and owner-only derived
-- destination status without changing the condition recordVersion.
do $routing_rule_library_projection_patch$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.list_encrypted_library_objects(uuid,text,text,integer)'::regprocedure
  );
  old_fragment constant text := $old$'enabled', rule.enabled, 'ruleType', rule.rule_type,
        'destinationNoteId', rule.destination_note_id,$old$;
  new_fragment constant text := $new$'enabled', rule.enabled, 'ruleType', rule.rule_type,
        'currentRevision', rule.current_revision,
        'proposalState', rule.proposal_state,
        'destinationStatus', private.routing_rule_destination_status(
          rule.user_id,
          case when rule.destination_note_id is not null then 'note' else 'space' end,
          coalesce(rule.destination_note_id,rule.destination_space_id)
        ),
        'destinationNoteId', rule.destination_note_id,$new$;
begin
  if (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment) <> 1 then
    raise exception using errcode = 'P0001',
      message = 'routing_rule_library_projection_contract_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$routing_rule_library_projection_patch$;

alter table public.routing_rules force row level security;
alter table public.organization_job_rule_matches force row level security;
revoke all on table public.routing_rules,
  public.organization_job_rule_matches,
  public.routing_rule_proposal_observations,
  public.routing_rule_observation_epochs,
  public.encrypted_routing_rule_write_claims
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
-- Preserve the pre-contraction owner-visible RLS read used by legacy clients;
-- E2 removes every direct mutation capability, not the existing SELECT grant.
grant select on table public.routing_rules to authenticated;
revoke all on table private.encrypted_routing_rule_observation_abandonments
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;

revoke execute on function public.prepare_encrypted_routing_rule_write(
  uuid,text,text,text,integer,bigint,jsonb
) from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function public.commit_encrypted_routing_rule_write(
  uuid,text,text,text,integer,jsonb
) from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function public.delete_encrypted_routing_rule(
  uuid,text,integer,text,jsonb
) from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
grant execute on function public.prepare_encrypted_routing_rule_write(
  uuid,text,text,text,integer,bigint,jsonb
) to service_role;
grant execute on function public.commit_encrypted_routing_rule_write(
  uuid,text,text,text,integer,jsonb
) to service_role;
grant execute on function public.delete_encrypted_routing_rule(
  uuid,text,integer,text,jsonb
) to service_role;
revoke execute on function public.get_encrypted_routing_rule_observation_epoch(
  uuid
) from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function public.get_encrypted_routing_rule_write_claim(
  uuid,text,jsonb
) from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
grant execute on function public.get_encrypted_routing_rule_observation_epoch(
  uuid
) to service_role;
grant execute on function public.get_encrypted_routing_rule_write_claim(
  uuid,text,jsonb
) to service_role;

revoke execute on function public.create_encrypted_capture_with_job(uuid,jsonb)
from public,anon,authenticated,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
grant execute on function public.create_encrypted_capture_with_job(uuid,jsonb)
to service_role;

revoke execute on function private.create_encrypted_capture_with_job_e1(
  uuid,jsonb
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.commit_encrypted_organizer_job_impl_e1(
  text,text,jsonb
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;

revoke execute on function private.encrypted_routing_rule_claim_projection(
  public.encrypted_routing_rule_write_claims
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.encrypted_routing_rule_result(
  public.encrypted_routing_rule_write_claims,boolean
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.finish_encrypted_routing_rule_write(
  public.encrypted_routing_rule_write_claims,jsonb,jsonb,jsonb,
  integer,integer,public.routing_rule_proposal_state,text
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.insert_encrypted_routing_rule(
  text,uuid,boolean,public.rule_type,text,text,integer,public.rule_source,
  public.routing_rule_proposal_state,jsonb,timestamptz
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.routing_rule_destination_status(
  uuid,text,text
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.valid_routing_rule_destination(
  uuid,text,text
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.lock_routing_rule_destination(
  uuid,text,text
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.assert_routing_rule_feedback_observation(
  uuid,text,text,text
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.routing_rule_observation_epoch(uuid)
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.lock_routing_rule_observation_epoch(uuid)
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function
  private.cleanup_routing_rule_observation_reservations()
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.valid_capture_routing_rule_match(jsonb)
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.organization_job_routing_rule_control(
  text,uuid
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.organization_job_routing_destination_status(
  text,uuid
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.safe_capture_local_date(timestamptz,text)
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.valid_organizer_routing_rule_control(jsonb)
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.routing_rule_organizer_review_required(
  text,text,jsonb
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.commit_encrypted_organizer_job_impl(
  text,text,jsonb
) from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
revoke execute on function private.preserve_routing_rule_command_timestamp()
from public,anon,authenticated,service_role,unfiled_index_worker,
  unfiled_rag_verifier,unfiled_organizer_worker;
