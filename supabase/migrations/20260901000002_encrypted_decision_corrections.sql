-- Milestone E1: encrypted owner corrections, Review resolution, and atomic
-- mutation-batch undo.
--
-- The authenticated web service is the only caller. PostgreSQL owns tenant
-- binding, CAS, stable identities, reservation binding, lock order, replay,
-- and atomic publication. User-authored content, operations, inverses, Review
-- proposals, and product responses remain exclusively inside authenticated
-- ciphertext.

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command',
      'encrypted_taxonomy_command', 'encrypted_note_retention',
      'encrypted_owner_interaction'
    )
  );

-- Managed-key records cross every encrypted service boundary. PostgreSQL's
-- native jsonb timestamptz encoding preserves session offsets and may expose
-- microseconds, while ManagedKeyRecordV1 requires JavaScript's canonical
-- millisecond UTC representation. Keep this normalization at the shared
-- projection so web, organizer, index, and verifier callers receive one wire.
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
    'createdAt', to_char(
      key_value.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'activatedAt', case when key_value.activated_at is null then null else
      to_char(
        key_value.activated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
    'retiredAt', case when key_value.retired_at is null then null else
      to_char(
        key_value.retired_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
    'revokedAt', case when key_value.revoked_at is null then null else
      to_char(
        key_value.revoked_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) end,
    'wrapOperations', key_value.wrap_operations,
    'wrapOperationLimit', key_value.wrap_operation_limit,
    'rotation', jsonb_build_object(
      'predecessorKeyId', key_value.predecessor_key_id,
      'previousRootKeyArn', key_value.previous_kms_key_id,
      'rootRewrapCount', key_value.root_rewrap_count,
      'lastRootRewrappedAt', case
        when key_value.last_root_rewrapped_at is null then null else to_char(
          key_value.last_root_rewrapped_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end
    )
  );
$$;

-- A resolved Review keeps the sticky private history class even when its
-- terminal route points at an AI-visible note. Patch both rollout guards now
-- so the invariant survives a later expanded-to-contracted transition. The
-- exact-source checks fail the migration closed if either shared guard drifts.
do $review_guard$
declare
  expanded_definition text;
  contracted_definition text;
  expanded_legacy_match constant text :=
    'if new.review_envelope is null or new.review_key_class <> authoritative_class then';
  expanded_prior_match constant text := $prior$
if new.review_envelope is null or (
      new.review_key_class <> authoritative_class
      and not (
        tg_op = 'UPDATE'
        and old.review_key_class = 'private_manual'
        and new.review_key_class = 'private_manual'
      )
    ) then
$prior$;
  expanded_replacement constant text := $replacement$
if new.review_envelope is null or (
      new.review_key_class <> authoritative_class
      and not (
        (
          tg_op = 'UPDATE'
          and old.review_key_class = 'private_manual'
          and new.review_key_class = 'private_manual'
        )
        or (
          tg_op = 'INSERT'
          and new.review_key_class = 'private_manual'
          and exists (
            select 1
            from public.encrypted_owner_interaction_claims as interaction
            where interaction.user_id = new.user_id
              and interaction.conflict_review_item_id = new.id
              and interaction.history_key_class = 'private_manual'
              and interaction.completed_at is null
          )
        )
      )
    ) then
$replacement$;
  contracted_legacy_match constant text :=
    'or new.review_key_class <> authoritative_class';
  contracted_prior_match constant text := $prior$
or (
        new.review_key_class <> authoritative_class
        and not (
          tg_op = 'UPDATE'
          and old.review_key_class = 'private_manual'
          and new.review_key_class = 'private_manual'
        )
      )
$prior$;
  contracted_replacement constant text := $replacement$
or (
        new.review_key_class <> authoritative_class
        and not (
          (
            tg_op = 'UPDATE'
            and old.review_key_class = 'private_manual'
            and new.review_key_class = 'private_manual'
          )
          or (
            tg_op = 'INSERT'
            and new.review_key_class = 'private_manual'
            and exists (
              select 1
              from public.encrypted_owner_interaction_claims as interaction
              where interaction.user_id = new.user_id
                and interaction.conflict_review_item_id = new.id
                and interaction.history_key_class = 'private_manual'
                and interaction.completed_at is null
            )
          )
        )
      )
$replacement$;
  expanded_match_count integer;
  contracted_match_count integer;
begin
  expanded_definition := pg_catalog.pg_get_functiondef(
    'private.enforce_encrypted_rollout_write()'::regprocedure
  );
  expanded_match_count := (pg_catalog.length(expanded_definition)
      - pg_catalog.length(pg_catalog.replace(
        expanded_definition, expanded_legacy_match, ''
      ))) / pg_catalog.length(expanded_legacy_match)
    + (pg_catalog.length(expanded_definition)
      - pg_catalog.length(pg_catalog.replace(
        expanded_definition, expanded_prior_match, ''
      ))) / pg_catalog.length(expanded_prior_match);
  if expanded_match_count <> 1
  then
    raise exception using errcode = 'P0001',
      message = 'encrypted_review_guard_contract_drift';
  end if;
  execute pg_catalog.replace(pg_catalog.replace(
    expanded_definition, expanded_legacy_match, expanded_replacement
  ), expanded_prior_match, expanded_replacement);

  contracted_definition := pg_catalog.pg_get_functiondef(
    'private.enforce_contracted_encrypted_write()'::regprocedure
  );
  contracted_match_count := (pg_catalog.length(contracted_definition)
      - pg_catalog.length(pg_catalog.replace(
        contracted_definition, contracted_legacy_match, ''
      ))) / pg_catalog.length(contracted_legacy_match)
    + (pg_catalog.length(contracted_definition)
      - pg_catalog.length(pg_catalog.replace(
        contracted_definition, contracted_prior_match, ''
      ))) / pg_catalog.length(contracted_prior_match);
  if contracted_match_count <> 1
  then
    raise exception using errcode = 'P0001',
      message = 'contracted_review_guard_contract_drift';
  end if;
  execute pg_catalog.replace(pg_catalog.replace(
    contracted_definition, contracted_legacy_match, contracted_replacement
  ), contracted_prior_match, contracted_replacement);
end;
$review_guard$;

create table public.encrypted_owner_interaction_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  ),
  scope text not null check (scope in (
    'encrypted_decision_correction',
    'encrypted_review_resolution',
    'encrypted_mutation_batch_undo'
  )),
  action text not null check (
    action in (
      'pending', 'route', 'create', 'keep_inbox',
      'dismiss', 'keep_both'
    )
  ),
  selected_outcome text check (
    selected_outcome is null or selected_outcome in ('applied', 'needs_review')
  ),
  decision_id text references public.organization_decisions(id) on delete cascade,
  review_item_id text references public.review_items(id) on delete cascade,
  anchor_mutation_id text references public.note_mutations(id) on delete cascade,
  source_note_id text references public.notes(id) on delete cascade,
  -- A new-note correction reserves its stable note id before that note exists.
  -- The deferred owner-binding trigger validates existing destinations while
  -- deliberately leaving a generated new-note id unbound until commit.
  destination_note_id text,
  destination_kind text check (
    destination_kind is null or destination_kind in ('existing_note', 'new_note')
  ),
  destination_note_type public.note_type,
  destination_space_id text references public.spaces(id) on delete set null,
  capture_id text references public.captures(id) on delete cascade,
  receipt_revision integer check (receipt_revision is null or receipt_revision >= 1),
  decision_content_revision integer check (
    decision_content_revision is null or decision_content_revision >= 1
  ),
  review_content_revision integer check (
    review_content_revision is null or review_content_revision >= 1
  ),
  expected_anchor_revision integer check (
    expected_anchor_revision is null or expected_anchor_revision >= 1
  ),
  feedback_event_id text check (
    feedback_event_id is null or feedback_event_id ~ '^fbk_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  conflict_review_item_id text check (
    conflict_review_item_id is null
    or conflict_review_item_id ~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'
  ),
  output_batch_id uuid,
  decision_envelope_digest text check (
    decision_envelope_digest is null
    or decision_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  review_envelope_digest text check (
    review_envelope_digest is null or review_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  receipt_envelope_digest text check (
    receipt_envelope_digest is null or receipt_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  history_key_class public.content_key_class not null,
  request_mac_key_id text not null,
  request_mac_key_class public.content_key_class not null,
  request_mac_key_purpose public.content_key_purpose not null
    check (request_mac_key_purpose = 'content_mac'),
  request_mac_key_version integer not null check (request_mac_key_version >= 1),
  request_mac text check (request_mac is null or request_mac ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default date_trunc(
    'milliseconds', clock_timestamp()
  ),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, idempotency_key),
  unique (user_id, feedback_event_id),
  unique (user_id, conflict_review_item_id),
  unique (user_id, output_batch_id),
  check (request_mac_key_class = history_key_class),
  check (
    (completed_at is null and request_mac is null and selected_outcome is null)
    or (
      completed_at = occurred_at and request_mac is not null
      and (
        (scope = 'encrypted_review_resolution' and selected_outcome is null)
        or (scope <> 'encrypted_review_resolution'
          and selected_outcome is not null)
      )
    )
  ),
  check (
    (scope = 'encrypted_decision_correction'
      and decision_id is not null and review_item_id is null
      and anchor_mutation_id is null and source_note_id is not null
      and destination_note_id is not null and destination_kind is not null
      and decision_content_revision is not null
      and expected_anchor_revision is null
      and action = 'pending'
      and feedback_event_id is not null
      and conflict_review_item_id is not null
      and output_batch_id is not null
      and (completed_at is null or selected_outcome is not null))
    or
    (scope = 'encrypted_review_resolution'
      and review_item_id is not null
      and anchor_mutation_id is null and source_note_id is null
      and review_content_revision is not null
      and expected_anchor_revision is null
      and conflict_review_item_id is null and output_batch_id is null
      and feedback_event_id is not null
      and action in ('route','create','keep_inbox','dismiss','keep_both')
      and (
        (action in ('route','create')
          and decision_id is not null
          and decision_content_revision is not null
          and decision_envelope_digest is not null)
        or
        (action not in ('route','create')
          and decision_id is null
          and decision_content_revision is null
          and decision_envelope_digest is null)
      )
      and selected_outcome is null)
    or
    (scope = 'encrypted_mutation_batch_undo'
      and decision_id is null and review_item_id is null
      and anchor_mutation_id is not null and source_note_id is null
      and destination_note_id is null and destination_kind is null
      and expected_anchor_revision is not null
      and action = 'pending'
      and conflict_review_item_id is not null
      and output_batch_id is not null
      and (completed_at is null or selected_outcome is not null))
  ),
  foreign key (
    user_id, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);

create table public.encrypted_owner_interaction_members (
  user_id uuid not null,
  idempotency_key text not null,
  ordinal integer not null check (ordinal between 0 and 15),
  role text not null check (role in (
    'source_removal', 'destination_write', 'undo'
  )),
  note_id text not null check (note_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'),
  target_mutation_id text references public.note_mutations(id) on delete set null,
  expected_revision integer not null check (expected_revision >= 0),
  source_privacy public.privacy_mode,
  target_privacy public.privacy_mode not null,
  revision_id text not null check (revision_id ~ '^rev_[0-9A-HJKMNP-TV-Z]{26}$'),
  mutation_id text not null check (mutation_id ~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'),
  expected_note_envelope_digest text check (
    expected_note_envelope_digest is null
    or expected_note_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  expected_mutation_envelope_digest text check (
    expected_mutation_envelope_digest is null
    or expected_mutation_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  history_key_class public.content_key_class not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, idempotency_key, ordinal),
  unique (user_id, idempotency_key, note_id),
  unique (user_id, revision_id),
  unique (user_id, mutation_id),
  foreign key (user_id, idempotency_key)
    references public.encrypted_owner_interaction_claims(user_id, idempotency_key)
    on delete cascade,
  check (
    (expected_revision = 0 and source_privacy is null
      and target_mutation_id is null
      and expected_note_envelope_digest is null
      and expected_mutation_envelope_digest is null
      and role = 'destination_write')
    or
    (expected_revision >= 1 and source_privacy is not null
      and expected_note_envelope_digest is not null
      and ((role = 'destination_write' and target_mutation_id is null
        and expected_mutation_envelope_digest is null)
       or (role in ('source_removal','undo') and target_mutation_id is not null
        and expected_mutation_envelope_digest is not null)))
  )
);

create table public.encrypted_owner_interaction_reservations (
  user_id uuid not null,
  idempotency_key text not null,
  branch text not null check (branch in ('common', 'applied', 'needs_review')),
  role text not null check (role ~ '^[a-z][a-z0-9_:]{0,79}$'),
  surface text not null check (surface in (
    'note_content', 'note_revision', 'note_mutation', 'review_item',
    'capture_receipt', 'idempotency_response'
  )),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  record_version integer not null check (record_version >= 1),
  key_class public.content_key_class not null,
  reservation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, idempotency_key, branch, role),
  unique (user_id, idempotency_key, branch, surface, resource_id),
  unique (user_id, reservation_id),
  foreign key (user_id, idempotency_key)
    references public.encrypted_owner_interaction_claims(user_id, idempotency_key)
    on delete cascade,
  foreign key (user_id, reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    on delete cascade
);

create table public.encrypted_mutation_batches (
  batch_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in (
    'organization', 'correction', 'undo', 'singleton'
  )),
  anchor_mutation_id text not null
    references public.note_mutations(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, batch_id),
  unique (user_id, anchor_mutation_id)
);

create table public.encrypted_mutation_batch_members (
  user_id uuid not null,
  batch_id uuid not null,
  ordinal integer not null check (ordinal between 0 and 15),
  role text not null check (role in (
    'source_removal', 'destination_write', 'undo', 'organization', 'singleton'
  )),
  note_id text not null references public.notes(id) on delete cascade,
  mutation_id text not null references public.note_mutations(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, batch_id, ordinal),
  unique (user_id, batch_id, note_id),
  unique (user_id, mutation_id),
  foreign key (user_id, batch_id)
    references public.encrypted_mutation_batches(user_id, batch_id)
    on delete cascade
);

create index encrypted_owner_interaction_claims_decision
  on public.encrypted_owner_interaction_claims(user_id, decision_id)
  where decision_id is not null;
create index encrypted_owner_interaction_claims_review
  on public.encrypted_owner_interaction_claims(user_id, review_item_id)
  where review_item_id is not null;
create index encrypted_owner_interaction_claims_anchor
  on public.encrypted_owner_interaction_claims(user_id, anchor_mutation_id)
  where anchor_mutation_id is not null;

alter table public.encrypted_owner_interaction_claims enable row level security;
alter table public.encrypted_owner_interaction_claims force row level security;
alter table public.encrypted_owner_interaction_members enable row level security;
alter table public.encrypted_owner_interaction_members force row level security;
alter table public.encrypted_owner_interaction_reservations enable row level security;
alter table public.encrypted_owner_interaction_reservations force row level security;
alter table public.encrypted_mutation_batches enable row level security;
alter table public.encrypted_mutation_batches force row level security;
alter table public.encrypted_mutation_batch_members enable row level security;
alter table public.encrypted_mutation_batch_members force row level security;

revoke all on table public.encrypted_owner_interaction_claims,
  public.encrypted_owner_interaction_members,
  public.encrypted_owner_interaction_reservations,
  public.encrypted_mutation_batches,
  public.encrypted_mutation_batch_members
from public, anon, authenticated, service_role;

do $$
declare capability_role text;
begin
  foreach capability_role in array array[
    'unfiled_organizer_worker', 'unfiled_index_worker', 'unfiled_rag_verifier'
  ] loop
    if exists (select 1 from pg_roles where rolname = capability_role) then
      execute format(
        'revoke all on table public.encrypted_owner_interaction_claims, '
        || 'public.encrypted_owner_interaction_members, '
        || 'public.encrypted_owner_interaction_reservations, '
        || 'public.encrypted_mutation_batches, '
        || 'public.encrypted_mutation_batch_members from %I',
        capability_role
      );
    end if;
  end loop;
end;
$$;

create or replace function private.reject_owner_interaction_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'immutable_owner_interaction';
end;
$$;

create or replace function private.enforce_owner_interaction_claim_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(
    new.user_id, new.idempotency_key, new.scope, new.action,
    new.decision_id, new.review_item_id, new.anchor_mutation_id,
    new.source_note_id, new.destination_note_id, new.destination_kind,
    new.destination_note_type, new.destination_space_id, new.capture_id,
    new.receipt_revision, new.decision_content_revision,
    new.review_content_revision, new.expected_anchor_revision,
    new.feedback_event_id, new.conflict_review_item_id, new.output_batch_id,
    new.decision_envelope_digest, new.review_envelope_digest,
    new.receipt_envelope_digest, new.history_key_class,
    new.request_mac_key_id, new.request_mac_key_class,
    new.request_mac_key_purpose, new.request_mac_key_version,
    new.occurred_at, new.created_at
  ) is distinct from row(
    old.user_id, old.idempotency_key, old.scope, old.action,
    old.decision_id, old.review_item_id, old.anchor_mutation_id,
    old.source_note_id, old.destination_note_id, old.destination_kind,
    old.destination_note_type, old.destination_space_id, old.capture_id,
    old.receipt_revision, old.decision_content_revision,
    old.review_content_revision, old.expected_anchor_revision,
    old.feedback_event_id, old.conflict_review_item_id, old.output_batch_id,
    old.decision_envelope_digest, old.review_envelope_digest,
    old.receipt_envelope_digest, old.history_key_class,
    old.request_mac_key_id, old.request_mac_key_class,
    old.request_mac_key_purpose, old.request_mac_key_version,
    old.occurred_at, old.created_at
  ) then
    raise exception using errcode = 'P0001', message = 'immutable_owner_interaction';
  end if;
  if old.request_mac is not null
    or old.completed_at is not null
    or new.request_mac is null
    or new.completed_at <> old.occurred_at
    or (
      old.scope in (
        'encrypted_decision_correction', 'encrypted_mutation_batch_undo'
      ) and new.selected_outcome not in ('applied', 'needs_review')
    )
    or (
      old.scope = 'encrypted_review_resolution'
      and new.selected_outcome is not null
    )
  then
    raise exception using errcode = 'P0001', message = 'immutable_owner_interaction';
  end if;
  return new;
end;
$$;

create trigger encrypted_owner_interaction_claim_transition
before update on public.encrypted_owner_interaction_claims
for each row execute function private.enforce_owner_interaction_claim_transition();

create trigger encrypted_owner_interaction_members_immutable
before update on public.encrypted_owner_interaction_members
for each row execute function private.reject_owner_interaction_update();
create trigger encrypted_owner_interaction_reservations_immutable
before update on public.encrypted_owner_interaction_reservations
for each row execute function private.reject_owner_interaction_update();
create trigger encrypted_mutation_batches_immutable
before update on public.encrypted_mutation_batches
for each row execute function private.reject_owner_interaction_update();
create trigger encrypted_mutation_batch_members_immutable
before update on public.encrypted_mutation_batch_members
for each row execute function private.reject_owner_interaction_update();

-- Every encrypted command family shares one owner/idempotency namespace.
-- The RPC advisory serializes competing commands; these insertion guards make
-- the invariant durable even as endpoint families use separate claim tables.
-- A completed API record may be inserted only by the one matching pending
-- claim (or by an atomic command family that has no durable prepare claim).
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
      'encrypted_owner_interaction_claims'
    )
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_encrypted_idempotency_namespace_target';
  end if;

  if tg_table_name = 'api_idempotency_records' then
    select count(*), count(*) filter (where claim_scope = new.scope)
    into conflicting_claims, matching_claims
    from (
      select scope as claim_scope
      from public.encrypted_note_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope
      from public.encrypted_taxonomy_write_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
      union all
      select scope
      from public.encrypted_owner_interaction_claims
      where user_id = new.user_id and idempotency_key = new.idempotency_key
    ) as claims;
    if conflicting_claims > 1
      or (conflicting_claims = 1 and matching_claims <> 1)
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
  elsif exists (
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
    ))
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return new;
end;
$$;

create trigger api_idempotency_records_namespace_guard
before insert on public.api_idempotency_records
for each row execute function private.enforce_encrypted_idempotency_namespace();
create trigger encrypted_note_write_claims_namespace_guard
before insert on public.encrypted_note_write_claims
for each row execute function private.enforce_encrypted_idempotency_namespace();
create trigger encrypted_taxonomy_write_claims_namespace_guard
before insert on public.encrypted_taxonomy_write_claims
for each row execute function private.enforce_encrypted_idempotency_namespace();
create trigger encrypted_owner_interaction_claims_namespace_guard
before insert on public.encrypted_owner_interaction_claims
for each row execute function private.enforce_encrypted_idempotency_namespace();

-- Binding rows are children of both a claim and a content-key reservation.
-- Completed claims also own one encrypted API replay snapshot and its
-- verification MAC. Claim deletion would otherwise strand both the open wrap
-- capability and a replayable ciphertext after its source was erased. Delete
-- only the exact owner/key/scope response; its existing AFTER DELETE trigger
-- removes the matching idempotency-response verification evidence.
create or replace function private.cleanup_owner_interaction_claim_reservations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' or tg_table_schema <> 'public'
    or tg_table_name <> 'encrypted_owner_interaction_claims'
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_owner_interaction_reservation_cleanup_target';
  end if;
  delete from public.api_idempotency_records as response
  where response.user_id = old.user_id
    and response.idempotency_key = old.idempotency_key
    and response.scope = old.scope;
  delete from public.content_key_operation_reservations as reservation
  using public.encrypted_owner_interaction_reservations as binding
  where binding.user_id = old.user_id
    and binding.idempotency_key = old.idempotency_key
    and reservation.user_id = binding.user_id
    and reservation.reservation_id = binding.reservation_id;
  return old;
end;
$$;

create trigger encrypted_owner_interaction_claim_reservation_cleanup
before delete on public.encrypted_owner_interaction_claims
for each row execute function
private.cleanup_owner_interaction_claim_reservations();

-- Parent lifecycle must remove an entire E1 claim before PostgreSQL applies
-- referential actions. In particular, SET NULL cannot pass either immutable
-- trigger, and retaining only the surviving members of a batch would make a
-- later replay or undo authorization incomplete. The trigger runs with the
-- migration owner, remains owner-scoped, and fails the parent delete if any
-- coordination cleanup cannot complete.
create or replace function private.cleanup_owner_interaction_references_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' or tg_table_schema <> 'public'
    or tg_table_name not in ('spaces', 'notes', 'note_mutations')
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_owner_interaction_cleanup_target';
  end if;

  if tg_table_name = 'spaces' then
    delete from public.encrypted_owner_interaction_claims as claim
    where claim.user_id = old.user_id
      and claim.destination_space_id = old.id;
  elsif tg_table_name = 'notes' then
    delete from public.encrypted_owner_interaction_claims as claim
    where claim.user_id = old.user_id
      and (
        claim.source_note_id = old.id
        or claim.destination_note_id = old.id
        or exists (
          select 1
          from public.encrypted_owner_interaction_members as member
          where member.user_id = claim.user_id
            and member.idempotency_key = claim.idempotency_key
            and member.note_id = old.id
        )
        or exists (
          select 1
          from public.note_mutations as anchor
          where anchor.user_id = claim.user_id
            and anchor.id = claim.anchor_mutation_id
            and anchor.note_id = old.id
        )
        or exists (
          select 1
          from public.encrypted_mutation_batch_members as batch_member
          where batch_member.user_id = claim.user_id
            and batch_member.batch_id = claim.output_batch_id
            and batch_member.note_id = old.id
        )
      );

    -- A committed batch is one atomic history unit. Remove its metadata before
    -- the member note FK can cascade only the matching row.
    delete from public.encrypted_mutation_batches as batch
    where batch.user_id = old.user_id
      and exists (
        select 1
        from public.encrypted_mutation_batch_members as batch_member
        where batch_member.user_id = batch.user_id
          and batch_member.batch_id = batch.batch_id
          and batch_member.note_id = old.id
      );
  else
    delete from public.encrypted_owner_interaction_claims as claim
    where claim.user_id = old.user_id
      and (
        claim.anchor_mutation_id = old.id
        or exists (
          select 1
          from public.encrypted_owner_interaction_members as member
          where member.user_id = claim.user_id
            and member.idempotency_key = claim.idempotency_key
            and member.target_mutation_id = old.id
        )
        or exists (
          select 1
          from public.encrypted_mutation_batch_members as batch_member
          where batch_member.user_id = claim.user_id
            and batch_member.batch_id = claim.output_batch_id
            and batch_member.mutation_id = old.id
        )
      );

    -- A non-anchor mutation is still a full batch dependency. Deleting the
    -- batch here prevents the member FK from leaving truncated history.
    delete from public.encrypted_mutation_batches as batch
    where batch.user_id = old.user_id
      and (
        batch.anchor_mutation_id = old.id
        or exists (
          select 1
          from public.encrypted_mutation_batch_members as batch_member
          where batch_member.user_id = batch.user_id
            and batch_member.batch_id = batch.batch_id
            and batch_member.mutation_id = old.id
        )
      );
  end if;
  return old;
end;
$$;

create trigger z_owner_interaction_references_cleanup
before delete on public.spaces
for each row execute function
private.cleanup_owner_interaction_references_before_delete();
create trigger z_owner_interaction_references_cleanup
before delete on public.notes
for each row execute function
private.cleanup_owner_interaction_references_before_delete();
create trigger z_owner_interaction_references_cleanup
before delete on public.note_mutations
for each row execute function
private.cleanup_owner_interaction_references_before_delete();

create or replace function private.enforce_owner_interaction_bindings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid := new.user_id;
begin
  if tg_table_name = 'encrypted_owner_interaction_claims' then
    if (new.decision_id is not null and not exists (
      select 1 from public.organization_decisions
      where id = new.decision_id and user_id = owner_id_value
    )) or (new.review_item_id is not null and not exists (
      select 1 from public.review_items
      where id = new.review_item_id and user_id = owner_id_value
    )) or (new.anchor_mutation_id is not null and not exists (
      select 1 from public.note_mutations
      where id = new.anchor_mutation_id and user_id = owner_id_value
    )) or (new.source_note_id is not null and not exists (
      select 1 from public.notes
      where id = new.source_note_id and user_id = owner_id_value
    )) or (new.destination_note_id is not null
      and new.destination_kind is distinct from 'new_note' and not exists (
      select 1 from public.notes
      where id = new.destination_note_id and user_id = owner_id_value
    )) or (new.destination_space_id is not null and not exists (
      select 1 from public.spaces
      where id = new.destination_space_id and user_id = owner_id_value
    )) or (new.capture_id is not null and not exists (
      select 1 from public.captures
      where id = new.capture_id and user_id = owner_id_value
    )) then
      raise exception using errcode = '23514',
        message = 'owner_interaction_binding_invalid';
    end if;
  elsif tg_table_name = 'encrypted_owner_interaction_members' then
    if not exists (
      select 1 from public.encrypted_owner_interaction_claims
      where user_id = owner_id_value and idempotency_key = new.idempotency_key
    ) or (new.expected_revision > 0 and not exists (
      select 1 from public.notes
      where id = new.note_id and user_id = owner_id_value
    )) or (new.target_mutation_id is not null and not exists (
      select 1 from public.note_mutations
      where id = new.target_mutation_id and user_id = owner_id_value
    )) then
      raise exception using errcode = '23514',
        message = 'owner_interaction_binding_invalid';
    end if;
  elsif tg_table_name = 'encrypted_mutation_batches' then
    if not exists (
      select 1 from public.note_mutations
      where id = new.anchor_mutation_id and user_id = owner_id_value
    ) then
      raise exception using errcode = '23514',
        message = 'mutation_batch_binding_invalid';
    end if;
  elsif tg_table_name = 'encrypted_mutation_batch_members' then
    if not exists (
      select 1 from public.encrypted_mutation_batches
      where user_id = owner_id_value and batch_id = new.batch_id
    ) or not exists (
      select 1 from public.notes
      where id = new.note_id and user_id = owner_id_value
    ) or not exists (
      select 1 from public.note_mutations
      where id = new.mutation_id and user_id = owner_id_value
        and note_id = new.note_id
    ) then
      raise exception using errcode = '23514',
        message = 'mutation_batch_binding_invalid';
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger encrypted_owner_interaction_claim_bindings
after insert or update on public.encrypted_owner_interaction_claims
deferrable initially deferred for each row
execute function private.enforce_owner_interaction_bindings();
create constraint trigger encrypted_owner_interaction_member_bindings
after insert or update on public.encrypted_owner_interaction_members
deferrable initially deferred for each row
execute function private.enforce_owner_interaction_bindings();
create constraint trigger encrypted_mutation_batch_bindings
after insert or update on public.encrypted_mutation_batches
deferrable initially deferred for each row
execute function private.enforce_owner_interaction_bindings();
create constraint trigger encrypted_mutation_batch_member_bindings
after insert or update on public.encrypted_mutation_batch_members
deferrable initially deferred for each row
execute function private.enforce_owner_interaction_bindings();

create or replace function private.owner_interaction_envelope_digest(
  p_envelope jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_envelope is null then null
    else encode(extensions.digest(p_envelope::text, 'sha256'), 'hex') end;
$$;

create or replace function private.owner_interaction_active_key(
  p_owner_id uuid,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose
)
returns public.user_content_keys
language plpgsql
stable
security definer
set search_path = ''
as $$
declare key_row public.user_content_keys%rowtype;
begin
  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id and key_class = p_key_class
    and key_purpose = p_key_purpose and state = 'active'
  order by key_version desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'active_key_unavailable';
  end if;
  return key_row;
end;
$$;

create or replace function private.reserve_owner_interaction_object(
  p_owner_id uuid,
  p_idempotency_key text,
  p_branch text,
  p_role text,
  p_surface text,
  p_resource_id text,
  p_record_version integer,
  p_key_class public.content_key_class
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_row public.user_content_keys%rowtype;
  reservation_id_value uuid;
begin
  if p_branch not in ('common', 'applied', 'needs_review')
    or p_role is null or p_role !~ '^[a-z][a-z0-9_:]{0,79}$'
    or p_surface not in (
      'note_content','note_revision','note_mutation','review_item',
      'capture_receipt','idempotency_response'
    ) or p_resource_id is null or char_length(p_resource_id) not between 1 and 200
    or p_record_version is null or p_record_version < 1
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  key_row := private.owner_interaction_active_key(
    p_owner_id, p_key_class, 'object_wrap'
  );
  reservation_id_value := extensions.gen_random_uuid();
  perform public.reserve_content_key_operations(
    p_owner_id, reservation_id_value, p_key_class,
    key_row.key_id, key_row.key_version, 1
  );
  insert into public.encrypted_owner_interaction_reservations(
    user_id, idempotency_key, branch, role, surface, resource_id, record_version,
    key_class, reservation_id
  ) values (
    p_owner_id, p_idempotency_key, p_branch, p_role, p_surface, p_resource_id,
    p_record_version, p_key_class, reservation_id_value
  );
  return jsonb_build_object(
    'role', p_role, 'surface', p_surface, 'resourceId', p_resource_id,
    'recordVersion', p_record_version, 'keyClass', p_key_class,
    'reservationId', reservation_id_value,
    'key', private.content_key_service_projection(key_row)
  );
end;
$$;

create or replace function private.owner_interaction_reservation_projection(
  p_owner_id uuid,
  p_idempotency_key text,
  p_branch text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'role', binding.role,
    'surface', binding.surface,
    'resourceId', binding.resource_id,
    'recordVersion', binding.record_version,
    'keyClass', binding.key_class,
    'reservationId', binding.reservation_id,
    'key', private.content_key_service_projection(content_key)
  ) order by binding.role), '[]'::jsonb)
  from public.encrypted_owner_interaction_reservations as binding
  join public.content_key_operation_reservations as reservation
    on reservation.user_id = binding.user_id
    and reservation.reservation_id = binding.reservation_id
  join public.user_content_keys as content_key
    on content_key.user_id = reservation.user_id
    and content_key.key_id = reservation.key_id
    and content_key.key_class = reservation.key_class
    and content_key.key_purpose = reservation.key_purpose
    and content_key.key_version = reservation.key_version
  where binding.user_id = p_owner_id
    and binding.idempotency_key = p_idempotency_key
    and binding.branch = p_branch;
$$;

-- MAC-protected display and revision aggregates must cross the read RPC as a
-- complete `{ encrypted, contentMac }` pair. The earlier read projection
-- exposed the cipher but omitted the MAC for nested taxonomy and mutation
-- snapshots, making a real aggregate open fail closed. Replace the RPCs in
-- this forward migration so already-deployed E0 databases receive the fix.
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
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
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
    'displayMac', private.encrypted_mac_projection(
      child.display_mac, child.display_mac_key_id, child.display_mac_key_class,
      child.display_mac_key_purpose, child.display_mac_key_version
    ),
    'parent', case when parent.id is null then null else jsonb_build_object(
      'spaceId', parent.id,
      'currentRevision', parent.current_revision,
      'displayCipher', private.encrypted_cipher_projection(
        parent.display_envelope, parent.display_key_id, parent.display_key_class,
        parent.display_key_purpose, parent.display_key_version
      ),
      'displayMac', private.encrypted_mac_projection(
        parent.display_mac, parent.display_mac_key_id, parent.display_mac_key_class,
        parent.display_mac_key_purpose, parent.display_mac_key_version
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
    ),
    'displayMac', private.encrypted_mac_projection(
      tag.display_mac, tag.display_mac_key_id, tag.display_mac_key_class,
      tag.display_mac_key_purpose, tag.display_mac_key_version
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
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if mutation_row.mutation_envelope is null then
    raise exception using errcode = 'P0001', message = 'encrypted_content_unavailable';
  end if;
  note_value := public.get_encrypted_note(p_owner_id, mutation_row.note_id);
  select jsonb_build_object(
    'revisionId', id,
    'revision', revision,
    'privacy', privacy,
    'snapshotCipher', private.encrypted_cipher_projection(
      snapshot_envelope, snapshot_key_id, snapshot_key_class,
      snapshot_key_purpose, snapshot_key_version
    ),
    'snapshotMac', private.encrypted_mac_projection(
      snapshot_mac, snapshot_mac_key_id, snapshot_mac_key_class,
      snapshot_mac_key_purpose, snapshot_mac_key_version
    )
  ) into before_value from public.note_revisions
  where user_id = p_owner_id and note_id = mutation_row.note_id
    and revision = mutation_row.before_revision;
  select jsonb_build_object(
    'revisionId', id,
    'revision', revision,
    'privacy', privacy,
    'snapshotCipher', private.encrypted_cipher_projection(
      snapshot_envelope, snapshot_key_id, snapshot_key_class,
      snapshot_key_purpose, snapshot_key_version
    ),
    'snapshotMac', private.encrypted_mac_projection(
      snapshot_mac, snapshot_mac_key_id, snapshot_mac_key_class,
      snapshot_mac_key_purpose, snapshot_mac_key_version
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

create or replace function private.owner_interaction_decision_projection(
  p_owner_id uuid,
  p_decision_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'decisionId', decision.id,
    'captureId', decision.capture_id,
    'recordVersion', decision.decision_content_revision,
    'destinationNoteId', decision.destination_note_id,
    'contentCipher', private.encrypted_cipher_projection(
      decision.decision_envelope, decision.decision_key_id,
      decision.decision_key_class, decision.decision_key_purpose,
      decision.decision_key_version
    )
  )
  from public.organization_decisions as decision
  where decision.user_id = p_owner_id and decision.id = p_decision_id
    and decision.decision_envelope is not null;
$$;

create or replace function private.owner_interaction_review_projection(
  p_owner_id uuid,
  p_review_item_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reviewItemId', review.id,
    'captureId', review.capture_id,
    'noteId', review.note_id,
    'type', review.type,
    'state', review.state,
    'recordVersion', review.review_content_revision,
    'contentCipher', private.encrypted_cipher_projection(
      review.review_envelope, review.review_key_id,
      review.review_key_class, review.review_key_purpose,
      review.review_key_version
    ),
    'createdAt', review.created_at,
    'resolvedAt', review.resolved_at
  )
  from public.review_items as review
  where review.user_id = p_owner_id and review.id = p_review_item_id
    and review.review_envelope is not null;
$$;

create or replace function private.owner_interaction_receipt_projection(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'captureId', receipt.capture_id,
    'jobId', receipt.job_id,
    'decisionId', receipt.decision_id,
    'reviewItemId', receipt.review_item_id,
    'mutationId', receipt.mutation_id,
    'outcome', receipt.outcome,
    'destinationNoteId', receipt.destination_note_id,
    'reasonCodes', to_jsonb(receipt.reason_codes),
    'recordVersion', receipt.receipt_revision,
    'sourcePrivacy', capture.privacy,
    'receiptCipher', private.encrypted_cipher_projection(
      receipt.receipt_envelope, receipt.receipt_key_id,
      receipt.receipt_key_class, receipt.receipt_key_purpose,
      receipt.receipt_key_version
    )
  )
  from public.capture_receipts as receipt
  join public.captures as capture
    on capture.user_id = receipt.user_id and capture.id = receipt.capture_id
  where receipt.user_id = p_owner_id and receipt.capture_id = p_capture_id
    and receipt.receipt_envelope is not null;
$$;

create or replace function private.owner_interaction_capture_projection(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'captureId', capture.id,
    'recordVersion', 1,
    'privacy', capture.privacy,
    'status', private.capture_processing_state(capture.status),
    'contentLength', capture.content_length,
    'contentCipher', private.encrypted_cipher_projection(
      capture.content_envelope, capture.content_key_id,
      capture.content_key_class, capture.content_key_purpose,
      capture.content_key_version
    ),
    'contentMac', private.encrypted_mac_projection(
      capture.content_fingerprint, capture.fingerprint_key_id,
      capture.fingerprint_key_class, capture.fingerprint_key_purpose,
      capture.fingerprint_key_version
    )
  )
  from public.captures as capture
  where capture.user_id = p_owner_id and capture.id = p_capture_id
    and capture.deleted_at is null and capture.status <> 'deleted'
    and capture.content_envelope is not null
    and capture.content_fingerprint is not null;
$$;

create or replace function private.owner_interaction_members_projection(
  p_owner_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  member_row public.encrypted_owner_interaction_members%rowtype;
  member_values jsonb := '[]'::jsonb;
  note_value jsonb;
  mutation_value jsonb;
begin
  for member_row in
    select * from public.encrypted_owner_interaction_members
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
    order by ordinal
  loop
    note_value := null;
    mutation_value := null;
    if member_row.expected_revision > 0 then
      note_value := public.get_encrypted_note(p_owner_id, member_row.note_id);
    end if;
    if member_row.target_mutation_id is not null then
      mutation_value := public.get_encrypted_note_mutation(
        p_owner_id, member_row.target_mutation_id
      );
    end if;
    member_values := member_values || jsonb_build_array(jsonb_build_object(
      'ordinal', member_row.ordinal,
      'role', member_row.role,
      'noteId', member_row.note_id,
      'targetMutationId', member_row.target_mutation_id,
      'expectedRevision', member_row.expected_revision,
      'sourcePrivacy', member_row.source_privacy,
      'targetPrivacy', member_row.target_privacy,
      'revisionId', member_row.revision_id,
      'mutationId', member_row.mutation_id,
      'currentNote', note_value,
      'currentMutation', mutation_value
    ));
  end loop;
  return member_values;
end;
$$;

create or replace function private.owner_interaction_response_cipher(
  p_owner_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.encrypted_cipher_projection(
    response.response_envelope, response.response_key_id,
    response.response_key_class, response.response_key_purpose,
    response.response_key_version
  )
  from public.api_idempotency_records as response
  where response.user_id = p_owner_id
    and response.idempotency_key = p_idempotency_key;
$$;

create or replace function private.owner_interaction_response_verification_mac(
  p_owner_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.encrypted_mac_projection(
    verification.verification_mac,
    verification.verification_mac_key_id,
    verification.verification_mac_key_class,
    verification.verification_mac_key_purpose,
    verification.verification_mac_key_version
  )
  from public.content_encryption_verifications as verification
  join public.api_idempotency_records as response
    on response.user_id = verification.user_id
    and response.idempotency_key = p_idempotency_key
  where verification.user_id = p_owner_id
    and verification.surface = 'idempotency_response'
    and verification.resource_id = 'idempotency:' || p_idempotency_key
    and verification.record_version = 1
    and verification.envelope_digest = encode(
      extensions.digest(response.response_envelope::text, 'sha256'), 'hex'
    );
$$;

create or replace function private.owner_interaction_source_projection(
  p_claim public.encrypted_owner_interaction_claims
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'decision', case when p_claim.decision_id is null
        or p_claim.scope = 'encrypted_review_resolution' then null else
      private.owner_interaction_decision_projection(
        p_claim.user_id, p_claim.decision_id
      ) end,
    'review', case when p_claim.review_item_id is null then null else
      private.owner_interaction_review_projection(
        p_claim.user_id, p_claim.review_item_id
      ) end,
    'receipt', case when p_claim.capture_id is null then null else
      private.owner_interaction_receipt_projection(
        p_claim.user_id, p_claim.capture_id
      ) end,
    'capture', case when p_claim.capture_id is null
      or p_claim.scope = 'encrypted_mutation_batch_undo' then null else
      private.owner_interaction_capture_projection(
        p_claim.user_id, p_claim.capture_id
      ) end
  );
$$;

create or replace function private.owner_interaction_prepare_projection(
  p_claim public.encrypted_owner_interaction_claims,
  p_replayed boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  request_key public.user_content_keys%rowtype;
  members_value jsonb;
  source_value jsonb;
  encrypted_response_value jsonb;
  encrypted_response_verification_value jsonb;
  common_reservations_value jsonb := '[]'::jsonb;
  applied_reservations_value jsonb := '[]'::jsonb;
  review_reservations_value jsonb := '[]'::jsonb;
  applied_available boolean := true;
  review_available boolean := true;
  source_batch_id_value uuid;
  source_batch_kind_value text := 'organization';
  source_batch_anchor_mutation_id_value text;
  restored_source_target_mutation_id_value text;
  restored_source_member_count integer;
begin
  select * into request_key from public.user_content_keys
  where user_id = p_claim.user_id
    and key_id = p_claim.request_mac_key_id
    and key_class = p_claim.request_mac_key_class
    and key_purpose = p_claim.request_mac_key_purpose
    and key_version = p_claim.request_mac_key_version
    and state in ('active', 'retired');
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  if p_claim.completed_at is not null then
    members_value := '[]'::jsonb;
    source_value := null;
    encrypted_response_value := private.owner_interaction_response_cipher(
      p_claim.user_id, p_claim.idempotency_key
    );
    encrypted_response_verification_value :=
      private.owner_interaction_response_verification_mac(
        p_claim.user_id, p_claim.idempotency_key
      );
    if encrypted_response_value is null
      or encrypted_response_verification_value is null
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    if p_claim.scope <> 'encrypted_review_resolution' then
      applied_available := p_claim.selected_outcome = 'applied';
      review_available := p_claim.selected_outcome = 'needs_review';
    end if;
  else
    members_value := private.owner_interaction_members_projection(
      p_claim.user_id, p_claim.idempotency_key
    );
    source_value := private.owner_interaction_source_projection(p_claim);
    common_reservations_value :=
      private.owner_interaction_reservation_projection(
        p_claim.user_id, p_claim.idempotency_key, 'common'
      );
    applied_reservations_value :=
      private.owner_interaction_reservation_projection(
        p_claim.user_id, p_claim.idempotency_key, 'applied'
      );
    review_reservations_value :=
      private.owner_interaction_reservation_projection(
        p_claim.user_id, p_claim.idempotency_key, 'needs_review'
      );
    if p_claim.scope <> 'encrypted_review_resolution' then
      applied_available := jsonb_array_length(applied_reservations_value) > 0;
    end if;
  end if;

  if p_claim.scope = 'encrypted_mutation_batch_undo' then
    select batch.batch_id, batch.kind, batch.anchor_mutation_id
    into source_batch_id_value, source_batch_kind_value,
      source_batch_anchor_mutation_id_value
    from public.encrypted_mutation_batch_members as anchor_member
    join public.encrypted_mutation_batches as batch
      on batch.user_id = anchor_member.user_id
      and batch.batch_id = anchor_member.batch_id
    where anchor_member.user_id = p_claim.user_id
      and anchor_member.mutation_id = p_claim.anchor_mutation_id;

    if source_batch_id_value is null then
      source_batch_kind_value := 'organization';
    elsif source_batch_anchor_mutation_id_value <> p_claim.anchor_mutation_id
      or source_batch_kind_value = 'undo'
      or source_batch_kind_value not in (
        'correction', 'organization', 'singleton'
      )
    then
      raise exception using errcode = 'P0001',
        message = 'conflict_requires_review';
    elsif source_batch_kind_value = 'correction' then
      select min(member.mutation_id), count(*)
      into restored_source_target_mutation_id_value,
        restored_source_member_count
      from public.encrypted_mutation_batch_members as member
      where member.user_id = p_claim.user_id
        and member.batch_id = source_batch_id_value
        and member.role = 'source_removal';
      if restored_source_member_count <> 1 then
        raise exception using errcode = 'P0001',
          message = 'conflict_requires_review';
      end if;
    else
      source_batch_kind_value := 'organization';
    end if;
  end if;

  if p_claim.scope = 'encrypted_review_resolution' then
    return jsonb_build_object(
      'scope', p_claim.scope,
      'action', p_claim.action,
      'occurredAt', p_claim.occurred_at,
      'completed', p_claim.completed_at is not null,
      'replayed', p_replayed,
      'requestMacKey', private.content_key_service_projection(request_key),
      'ids', jsonb_build_object(
        'reviewItemId', p_claim.review_item_id,
        'destinationNoteId', p_claim.destination_note_id,
        'destinationRevisionId', (
          select revision_id
          from public.encrypted_owner_interaction_members
          where user_id = p_claim.user_id
            and idempotency_key = p_claim.idempotency_key
          order by ordinal limit 1
        ),
        'destinationMutationId', (
          select mutation_id
          from public.encrypted_owner_interaction_members
          where user_id = p_claim.user_id
            and idempotency_key = p_claim.idempotency_key
          order by ordinal limit 1
        )
      ),
      'source', source_value,
      'members', members_value,
      'reservations', common_reservations_value,
      'encryptedResponse', encrypted_response_value,
      'encryptedResponseVerificationMac',
        encrypted_response_verification_value
    );
  end if;

  return jsonb_build_object(
    'scope', p_claim.scope,
    'occurredAt', p_claim.occurred_at,
    'completed', p_claim.completed_at is not null,
    'replayed', p_replayed,
    'selectedOutcome', p_claim.selected_outcome,
    'requestMacKey', private.content_key_service_projection(request_key),
    'ids', case when p_claim.scope = 'encrypted_decision_correction'
      then jsonb_build_object(
        'decisionId', p_claim.decision_id,
        'sourceNoteId', p_claim.source_note_id,
        'destinationNoteId', p_claim.destination_note_id,
        'captureId', p_claim.capture_id
      ) else jsonb_build_object(
        'anchorMutationId', p_claim.anchor_mutation_id,
        'sourceBatchKind', source_batch_kind_value,
        'restoredSourceTargetMutationId',
          restored_source_target_mutation_id_value
      ) end,
    'source', source_value,
    'members', members_value,
    'commonReservations', common_reservations_value,
    'branches', jsonb_build_object(
      'applied', case
        when p_claim.scope = 'encrypted_decision_correction' then
          jsonb_build_object(
            'available', applied_available,
            'feedbackEventId', p_claim.feedback_event_id,
            'batchId', p_claim.output_batch_id,
            'reservations', applied_reservations_value
          )
        else jsonb_build_object(
          'available', applied_available,
          'batchId', p_claim.output_batch_id,
          'reservations', applied_reservations_value
        )
      end,
      'needsReview', jsonb_build_object(
        'available', review_available,
        'reviewItemId', p_claim.conflict_review_item_id,
        'reservations', review_reservations_value
      )
    ),
    'encryptedResponse', encrypted_response_value,
    'encryptedResponseVerificationMac',
      encrypted_response_verification_value
  );
end;
$$;

create or replace function public.prepare_encrypted_decision_correction(
  p_owner_id uuid,
  p_decision_id text,
  p_idempotency_key text,
  p_request jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  decision_row public.organization_decisions%rowtype;
  capture_row public.captures%rowtype;
  receipt_row public.capture_receipts%rowtype;
  source_note public.notes%rowtype;
  destination_note public.notes%rowtype;
  target_mutation public.note_mutations%rowtype;
  restored_source_revision public.note_revisions%rowtype;
  request_key public.user_content_keys%rowtype;
  destination_value jsonb;
  destination_kind_value text;
  destination_note_id_value text;
  destination_note_type_value public.note_type;
  destination_space_id_value text;
  destination_expected_revision integer;
  source_expected_revision integer;
  destination_privacy public.privacy_mode;
  source_target_privacy public.privacy_mode;
  source_snapshot_key_class public.content_key_class;
  source_member_history_class public.content_key_class;
  destination_member_history_class public.content_key_class;
  history_class public.content_key_class;
  capture_available boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_decision_id is null
    or p_decision_id !~ '^dec_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_request) <> 'object'
    or p_request - array['source','destination'] <> '{}'::jsonb
    or not p_request ?& array['source','destination']
    or jsonb_typeof(p_request -> 'source') <> 'object'
    or (p_request -> 'source') - array['noteId','expectedRevision'] <> '{}'::jsonb
    or not (p_request -> 'source') ?& array['noteId','expectedRevision']
    or jsonb_typeof(p_request #> '{source,noteId}') <> 'string'
    or p_request #>> '{source,noteId}' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or jsonb_typeof(p_request #> '{source,expectedRevision}') <> 'number'
    or p_request #>> '{source,expectedRevision}' !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(p_request -> 'destination') <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  destination_value := p_request -> 'destination';
  destination_kind_value := destination_value ->> 'type';
  if destination_kind_value = 'existing_note' then
    if destination_value - array['type','noteId','expectedRevision'] <> '{}'::jsonb
      or not destination_value ?& array['type','noteId','expectedRevision']
      or jsonb_typeof(destination_value -> 'noteId') <> 'string'
      or destination_value ->> 'noteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or jsonb_typeof(destination_value -> 'expectedRevision') <> 'number'
      or destination_value ->> 'expectedRevision' !~ '^[1-9][0-9]{0,8}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    destination_note_id_value := destination_value ->> 'noteId';
    destination_expected_revision :=
      (destination_value ->> 'expectedRevision')::integer;
  elsif destination_kind_value = 'new_note' then
    if destination_value - array['type','noteType','spaceId'] <> '{}'::jsonb
      or not destination_value ?& array['type','noteType','spaceId']
      or jsonb_typeof(destination_value -> 'noteType') <> 'string'
      or jsonb_typeof(destination_value -> 'spaceId') not in ('string','null')
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    begin
      destination_note_type_value :=
        (destination_value ->> 'noteType')::public.note_type;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'validation_failed';
    end;
    destination_space_id_value := case
      when jsonb_typeof(destination_value -> 'spaceId') = 'null' then null
      else destination_value ->> 'spaceId' end;
    if destination_space_id_value is not null and (
      destination_space_id_value !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
      or not exists (
        select 1 from public.spaces
        where user_id = p_owner_id and id = destination_space_id_value
          and archived_at is null
      )
    ) then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    destination_note_id_value := public.new_entity_id('note');
    destination_expected_revision := 0;
  else
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  source_expected_revision :=
    (p_request #>> '{source,expectedRevision}')::integer;
  if destination_note_id_value = p_request #>> '{source,noteId}' then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('encrypted_only','contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;
  select * into claim_row
  from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if claim_row.scope <> 'encrypted_decision_correction'
      or claim_row.decision_id <> p_decision_id
      or claim_row.source_note_id <> p_request #>> '{source,noteId}'
      or claim_row.destination_kind <> destination_kind_value
      or (select expected_revision
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = 0) <> source_expected_revision
      or (select expected_revision
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = 1) <> destination_expected_revision
      or (destination_kind_value = 'existing_note'
        and claim_row.destination_note_id <> destination_note_id_value)
      or (destination_kind_value = 'new_note' and row(
          claim_row.destination_note_type, claim_row.destination_space_id
        ) is distinct from row(
          destination_note_type_value, destination_space_id_value
        ))
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return private.owner_interaction_prepare_projection(claim_row, true);
  end if;
  if exists (
      select 1 from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  select * into decision_row from public.organization_decisions
  where user_id = p_owner_id and id = p_decision_id for share;
  if not found or decision_row.decision_envelope is null then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if decision_row.destination_note_id is distinct from
      p_request #>> '{source,noteId}'
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into receipt_row from public.capture_receipts
  where user_id = p_owner_id and capture_id = decision_row.capture_id
    and decision_id = p_decision_id for share;
  if not found or receipt_row.receipt_envelope is null
    or receipt_row.destination_note_id is distinct from
      p_request #>> '{source,noteId}'
    or receipt_row.mutation_id is null
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into capture_row from public.captures
  where user_id = p_owner_id and id = decision_row.capture_id for share;
  if not found or receipt_row.receipt_key_class::text
      is distinct from capture_row.privacy::text
  then
    raise exception using errcode = 'P0001',
      message = 'encrypted_content_unavailable';
  end if;
  select * into source_note from public.notes
  where user_id = p_owner_id and id = p_request #>> '{source,noteId}'
  for share;
  if not found or source_note.current_revision <> source_expected_revision
    or source_note.deleted_at is not null
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into target_mutation from public.note_mutations
  where user_id = p_owner_id and id = receipt_row.mutation_id
    and note_id = source_note.id for share;
  if not found or target_mutation.undone_at is not null
    or target_mutation.mutation_envelope is null
    or target_mutation.mutation_key_id is null
    or target_mutation.mutation_key_class is null
    or target_mutation.mutation_key_purpose <> 'object_wrap'
    or target_mutation.mutation_key_version is null
    or target_mutation.decision_id is distinct from p_decision_id
    or 1 <> (
      select count(*) from public.capture_note_links as link
      where link.user_id = p_owner_id
        and link.capture_id = receipt_row.capture_id
        and link.note_id = source_note.id
        and link.mutation_id = target_mutation.id
        and link.relation = 'routed'
    )
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if target_mutation.before_revision = 0 then
    source_target_privacy := source_note.privacy;
    source_snapshot_key_class := null;
  else
    select * into restored_source_revision
    from public.note_revisions
    where user_id = p_owner_id and note_id = source_note.id
      and revision = target_mutation.before_revision
    for share;
    if not found or restored_source_revision.snapshot_envelope is null
      or restored_source_revision.snapshot_key_id is null
      or restored_source_revision.snapshot_key_class is null
      or restored_source_revision.snapshot_key_purpose <> 'object_wrap'
      or restored_source_revision.snapshot_key_version is null
      or restored_source_revision.snapshot_mac is null
      or restored_source_revision.snapshot_mac_key_id is null
      or restored_source_revision.snapshot_mac_key_class is null
      or restored_source_revision.snapshot_mac_key_purpose <> 'content_mac'
      or restored_source_revision.snapshot_mac_key_version is null
    then
      raise exception using errcode = 'P0001',
        message = 'encrypted_content_unavailable';
    end if;
    source_target_privacy := restored_source_revision.privacy;
    source_snapshot_key_class := restored_source_revision.snapshot_key_class;
  end if;
  if destination_kind_value = 'existing_note' then
    select * into destination_note from public.notes
    where user_id = p_owner_id and id = destination_note_id_value for share;
    if not found or destination_note.current_revision <>
        destination_expected_revision or destination_note.deleted_at is not null
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    destination_note_type_value := destination_note.type;
    destination_space_id_value := destination_note.space_id;
    destination_privacy := destination_note.privacy;
  else
    destination_privacy := source_note.privacy;
  end if;
  source_member_history_class := case
    when source_note.privacy = 'private_manual'
      or source_target_privacy = 'private_manual'
      or target_mutation.mutation_key_class = 'private_manual'
      or source_snapshot_key_class = 'private_manual'
    then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  destination_member_history_class := case
    when destination_privacy = 'private_manual'
    then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  history_class := case
    when source_member_history_class = 'private_manual'
      or destination_member_history_class = 'private_manual'
      or capture_row.privacy = 'private_manual'
      or receipt_row.receipt_key_class = 'private_manual'
    then 'private_manual'::public.content_key_class
    else 'ai_assisted'::public.content_key_class end;
  request_key := private.owner_interaction_active_key(
    p_owner_id, history_class, 'content_mac'
  );
  capture_available := private.owner_interaction_capture_projection(
    p_owner_id, decision_row.capture_id
  ) is not null;

  insert into public.encrypted_owner_interaction_claims (
    user_id, idempotency_key, scope, action, decision_id,
    source_note_id, destination_note_id, destination_kind,
    destination_note_type, destination_space_id, capture_id,
    receipt_revision, decision_content_revision, feedback_event_id,
    conflict_review_item_id, output_batch_id, decision_envelope_digest,
    receipt_envelope_digest, history_key_class, request_mac_key_id,
    request_mac_key_class, request_mac_key_purpose, request_mac_key_version
  ) values (
    p_owner_id, p_idempotency_key, 'encrypted_decision_correction',
    'pending', p_decision_id, source_note.id, destination_note_id_value,
    destination_kind_value, destination_note_type_value,
    destination_space_id_value, decision_row.capture_id,
    receipt_row.receipt_revision, decision_row.decision_content_revision,
    public.new_entity_id('fbk'), public.new_entity_id('rvw'),
    extensions.gen_random_uuid(),
    private.owner_interaction_envelope_digest(decision_row.decision_envelope),
    private.owner_interaction_envelope_digest(receipt_row.receipt_envelope),
    history_class, request_key.key_id, request_key.key_class,
    request_key.key_purpose, request_key.key_version
  ) returning * into claim_row;

  insert into public.encrypted_owner_interaction_members (
    user_id, idempotency_key, ordinal, role, note_id,
    target_mutation_id, expected_revision, source_privacy, target_privacy,
    revision_id, mutation_id, expected_note_envelope_digest,
    expected_mutation_envelope_digest, history_key_class
  ) values
  (
    p_owner_id, p_idempotency_key, 0, 'source_removal', source_note.id,
    target_mutation.id, source_note.current_revision, source_note.privacy,
    source_target_privacy, public.new_entity_id('rev'), public.new_entity_id('mut'),
    private.owner_interaction_envelope_digest(source_note.content_envelope),
    private.owner_interaction_envelope_digest(target_mutation.mutation_envelope),
    source_member_history_class
  ),
  (
    p_owner_id, p_idempotency_key, 1, 'destination_write',
    destination_note_id_value,
    null, destination_expected_revision,
    case when destination_expected_revision = 0 then null
      else destination_note.privacy end,
    destination_privacy, public.new_entity_id('rev'), public.new_entity_id('mut'),
    case when destination_expected_revision = 0 then null else
      private.owner_interaction_envelope_digest(destination_note.content_envelope)
      end,
    null, destination_member_history_class
  );

  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'common', 'response',
    'idempotency_response', 'idempotency:' || p_idempotency_key, 1,
    history_class
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'common', 'receipt',
    'capture_receipt', receipt_row.capture_id,
    receipt_row.receipt_revision + 1, receipt_row.receipt_key_class
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'needs_review', 'review',
    'review_item', claim_row.conflict_review_item_id, 1,
    history_class
  );
  if capture_available then
    for ordinal_value in 0..1 loop
      perform private.reserve_owner_interaction_object(
        p_owner_id, p_idempotency_key, 'applied',
        'note_content:' || ordinal_value, 'note_content',
        (select note_id from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select expected_revision + 1
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select target_privacy::text::public.content_key_class
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value)
      );
      perform private.reserve_owner_interaction_object(
        p_owner_id, p_idempotency_key, 'applied',
        'note_revision:' || ordinal_value, 'note_revision',
        (select revision_id from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select expected_revision + 1
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select history_key_class
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value)
      );
      perform private.reserve_owner_interaction_object(
        p_owner_id, p_idempotency_key, 'applied',
        'note_mutation:' || ordinal_value, 'note_mutation',
        (select mutation_id from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select expected_revision + 1
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value),
        (select history_key_class
          from public.encrypted_owner_interaction_members
          where user_id = p_owner_id and idempotency_key = p_idempotency_key
            and ordinal = ordinal_value)
      );
    end loop;
  end if;
  return private.owner_interaction_prepare_projection(claim_row, false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.prepare_encrypted_review_resolution(
  p_owner_id uuid,
  p_review_item_id text,
  p_idempotency_key text,
  p_resolution jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  review_row public.review_items%rowtype;
  capture_row public.captures%rowtype;
  receipt_row public.capture_receipts%rowtype;
  decision_row public.organization_decisions%rowtype;
  destination_note public.notes%rowtype;
  request_key public.user_content_keys%rowtype;
  action_value text;
  destination_kind_value text;
  destination_note_id_value text;
  destination_note_type_value public.note_type;
  destination_space_id_value text;
  destination_expected_revision integer;
  destination_privacy public.privacy_mode;
  destination_member_history_class public.content_key_class;
  history_class public.content_key_class;
  review_target_class public.content_key_class;
  member_revision_id text;
  member_mutation_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_review_item_id is null
    or p_review_item_id !~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_resolution) <> 'object'
    or jsonb_typeof(p_resolution -> 'type') <> 'string'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  action_value := p_resolution ->> 'type';
  if action_value = 'route' then
    if p_resolution - array['type','noteId','expectedRevision'] <> '{}'::jsonb
      or not p_resolution ?& array['type','noteId','expectedRevision']
      or jsonb_typeof(p_resolution -> 'noteId') <> 'string'
      or p_resolution ->> 'noteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or jsonb_typeof(p_resolution -> 'expectedRevision') <> 'number'
      or p_resolution ->> 'expectedRevision' !~ '^[1-9][0-9]{0,8}$'
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    destination_kind_value := 'existing_note';
    destination_note_id_value := p_resolution ->> 'noteId';
    destination_expected_revision :=
      (p_resolution ->> 'expectedRevision')::integer;
  elsif action_value = 'create' then
    if p_resolution - array['type','noteType','spaceId'] <> '{}'::jsonb
      or not p_resolution ?& array['type','noteType','spaceId']
      or jsonb_typeof(p_resolution -> 'noteType') <> 'string'
      or jsonb_typeof(p_resolution -> 'spaceId') not in ('string','null')
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    begin
      destination_note_type_value :=
        (p_resolution ->> 'noteType')::public.note_type;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'validation_failed';
    end;
    destination_space_id_value := case
      when jsonb_typeof(p_resolution -> 'spaceId') = 'null' then null
      else p_resolution ->> 'spaceId' end;
    if destination_space_id_value is not null and (
      destination_space_id_value !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
      or not exists (
        select 1 from public.spaces where user_id = p_owner_id
          and id = destination_space_id_value and archived_at is null
      )
    ) then raise exception using errcode = 'P0001', message = 'not_found'; end if;
    destination_kind_value := 'new_note';
    destination_note_id_value := public.new_entity_id('note');
    destination_expected_revision := 0;
  elsif action_value in ('keep_inbox','dismiss','keep_both') then
    if p_resolution - array['type'] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  else
    -- Generated-block accept/reject stays outside the E1 Review boundary.
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('encrypted_only','contracted')
  ) then raise exception using errcode = 'P0001', message = 'invalid_rollout_state'; end if;
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if claim_row.scope <> 'encrypted_review_resolution'
      or claim_row.review_item_id <> p_review_item_id
      or claim_row.action <> action_value
      or claim_row.destination_kind is distinct from destination_kind_value
      or (action_value = 'route'
        and claim_row.destination_note_id <> destination_note_id_value)
      or (action_value = 'create' and row(
        claim_row.destination_note_type, claim_row.destination_space_id
      ) is distinct from row(
        destination_note_type_value, destination_space_id_value
      ))
      or (action_value in ('route','create') and (
        select expected_revision from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = 0
      ) <> destination_expected_revision)
    then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
    return private.owner_interaction_prepare_projection(claim_row, true);
  end if;
  if exists (
      select 1 from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  select * into review_row from public.review_items
  where user_id = p_owner_id and id = p_review_item_id for share;
  if not found or review_row.state <> 'open'
    or review_row.review_envelope is null
  then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  if action_value = 'route' then
    select * into destination_note from public.notes
    where user_id = p_owner_id and id = destination_note_id_value for share;
    if not found or destination_note.current_revision <>
        destination_expected_revision or destination_note.deleted_at is not null
    then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
    destination_note_type_value := destination_note.type;
    destination_space_id_value := destination_note.space_id;
    destination_privacy := destination_note.privacy;
  end if;
  if review_row.capture_id is not null then
    select * into capture_row from public.captures
    where user_id = p_owner_id and id = review_row.capture_id for share;
    if not found or capture_row.content_envelope is null then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    select * into receipt_row from public.capture_receipts
    where user_id = p_owner_id and capture_id = review_row.capture_id
      and review_item_id = p_review_item_id for share;
    if not found or receipt_row.receipt_envelope is null then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if receipt_row.receipt_key_class::text
        is distinct from capture_row.privacy::text
    then
      raise exception using errcode = 'P0001',
        message = 'encrypted_content_unavailable';
    end if;
  end if;
  if action_value = 'keep_inbox'
    and (review_row.capture_id is null or receipt_row.capture_id is null)
  then
    -- Inbox restoration is a capture/receipt transition. A captureless Review
    -- can be dismissed or retained as metadata, but cannot manufacture Inbox
    -- provenance or reserve an unusable receipt write.
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if review_row.review_key_class = 'private_manual'
    or destination_privacy = 'private_manual'
    or capture_row.privacy = 'private_manual'
    or receipt_row.receipt_key_class = 'private_manual'
  then
    history_class := 'private_manual';
  else
    history_class := 'ai_assisted';
  end if;
  review_target_class := history_class;
  if action_value = 'create' then
    destination_privacy := history_class::text::public.privacy_mode;
  end if;
  if action_value in ('route','create') then
    destination_member_history_class :=
      destination_privacy::text::public.content_key_class;
  end if;
  if action_value in ('route','create') then
    if receipt_row.capture_id is null or receipt_row.decision_id is null then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    select * into decision_row from public.organization_decisions
    where user_id = p_owner_id and id = receipt_row.decision_id
      and capture_id = receipt_row.capture_id
    for share;
    if not found or decision_row.decision_envelope is null
      or decision_row.destination_note_id is not null
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;
  request_key := private.owner_interaction_active_key(
    p_owner_id, history_class, 'content_mac'
  );
  insert into public.encrypted_owner_interaction_claims (
    user_id, idempotency_key, scope, action, decision_id, review_item_id,
    destination_note_id, destination_kind, destination_note_type,
    destination_space_id, capture_id, receipt_revision,
    decision_content_revision, review_content_revision, feedback_event_id,
    decision_envelope_digest, review_envelope_digest, receipt_envelope_digest,
    history_key_class, request_mac_key_id,
    request_mac_key_class, request_mac_key_purpose, request_mac_key_version
  ) values (
    p_owner_id, p_idempotency_key, 'encrypted_review_resolution',
    action_value, decision_row.id, p_review_item_id, destination_note_id_value,
    destination_kind_value, destination_note_type_value,
    destination_space_id_value, review_row.capture_id,
    case when receipt_row.capture_id is null then null
      else receipt_row.receipt_revision end,
    decision_row.decision_content_revision,
    review_row.review_content_revision, public.new_entity_id('fbk'),
    case when decision_row.id is null then null else
      private.owner_interaction_envelope_digest(decision_row.decision_envelope)
      end,
    private.owner_interaction_envelope_digest(review_row.review_envelope),
    case when receipt_row.capture_id is null then null else
      private.owner_interaction_envelope_digest(receipt_row.receipt_envelope) end,
    history_class, request_key.key_id, request_key.key_class,
    request_key.key_purpose, request_key.key_version
  ) returning * into claim_row;

  if action_value in ('route','create') then
    member_revision_id := public.new_entity_id('rev');
    member_mutation_id := public.new_entity_id('mut');
    insert into public.encrypted_owner_interaction_members (
      user_id, idempotency_key, ordinal, role, note_id,
      expected_revision, source_privacy, target_privacy,
      revision_id, mutation_id, expected_note_envelope_digest,
      history_key_class
    ) values (
      p_owner_id, p_idempotency_key, 0, 'destination_write',
      destination_note_id_value, destination_expected_revision,
      case when destination_expected_revision = 0 then null
        else destination_note.privacy end,
      destination_privacy, member_revision_id, member_mutation_id,
      case when destination_expected_revision = 0 then null else
        private.owner_interaction_envelope_digest(destination_note.content_envelope)
        end, destination_member_history_class
    );
  end if;
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'common', 'response',
    'idempotency_response', 'idempotency:' || p_idempotency_key, 1,
    history_class
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'common', 'review',
    'review_item', p_review_item_id, review_row.review_content_revision + 1,
    review_target_class
  );
  if receipt_row.capture_id is not null
    and action_value in ('route','create','keep_inbox')
  then
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'common', 'receipt',
      'capture_receipt', receipt_row.capture_id,
      receipt_row.receipt_revision + 1, receipt_row.receipt_key_class
    );
  end if;
  if action_value in ('route','create') then
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'common', 'note_content:0',
      'note_content', destination_note_id_value,
      destination_expected_revision + 1,
      destination_privacy::text::public.content_key_class
    );
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'common', 'note_revision:0',
      'note_revision', member_revision_id, destination_expected_revision + 1,
      destination_member_history_class
    );
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'common', 'note_mutation:0',
      'note_mutation', member_mutation_id, destination_expected_revision + 1,
      destination_member_history_class
    );
  end if;
  return private.owner_interaction_prepare_projection(claim_row, false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.get_encrypted_mutation_batch(
  p_owner_id uuid,
  p_mutation_id text,
  p_expected_revision integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  anchor_mutation public.note_mutations%rowtype;
  anchor_note public.notes%rowtype;
  capture_row public.captures%rowtype;
  receipt_row public.capture_receipts%rowtype;
  request_key public.user_content_keys%rowtype;
  mutation_ids text[];
  batch_id_value uuid;
  batch_kind_value text;
  batch_anchor_mutation_id_value text;
  batch_selected_member_role_value text;
  batch_source_member_count integer := 0;
  batch_destination_member_count integer := 0;
  restored_source_note_id_value text;
  source_destination_note_id_value text;
  source_decision_id_value text;
  invalid_source_batch boolean := false;
  feedback_id_value text;
  capture_id_value text;
  history_class public.content_key_class :=
    'ai_assisted'::public.content_key_class;
  member_record record;
  ordinal_value integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_mutation_id is null
    or p_mutation_id !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision is null or p_expected_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('encrypted_only','contracted')
  ) then raise exception using errcode = 'P0001', message = 'invalid_rollout_state'; end if;

  -- E1 Undo batches are terminal history units. Their generated mutations do
  -- not retain capture/receipt/decision/link provenance, so treating any one
  -- of their members as a new undo source could change note content without
  -- atomically restoring that provenance. Lock and reject the immutable batch
  -- before replaying or creating a preparation claim.
  select batch.batch_id, batch.kind, batch.anchor_mutation_id, member.role
  into batch_id_value, batch_kind_value, batch_anchor_mutation_id_value,
    batch_selected_member_role_value
  from public.encrypted_mutation_batch_members as member
  join public.encrypted_mutation_batches as batch
    on batch.user_id = member.user_id
    and batch.batch_id = member.batch_id
  where member.user_id = p_owner_id
    and member.mutation_id = p_mutation_id
  for share of batch;
  if batch_id_value is not null then
    select count(*) filter (where member.role = 'source_removal'),
      count(*) filter (where member.role = 'destination_write')
    into batch_source_member_count, batch_destination_member_count
    from public.encrypted_mutation_batch_members as member
    where member.user_id = p_owner_id
      and member.batch_id = batch_id_value;
    invalid_source_batch := batch_kind_value = 'undo'
      or batch_anchor_mutation_id_value <> p_mutation_id
      or (batch_kind_value = 'correction' and (
        batch_selected_member_role_value <> 'destination_write'
        or batch_source_member_count <> 1
        or batch_destination_member_count <> 1
      ));
  end if;
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if claim_row.scope <> 'encrypted_mutation_batch_undo'
      or claim_row.anchor_mutation_id <> p_mutation_id
      or claim_row.expected_anchor_revision <> p_expected_revision
    then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
    if invalid_source_batch then
      raise exception using errcode = 'P0001',
        message = 'conflict_requires_review';
    end if;
    return private.owner_interaction_prepare_projection(claim_row, true);
  end if;
  if exists (
      select 1 from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  if invalid_source_batch then
    raise exception using errcode = 'P0001',
      message = 'conflict_requires_review';
  end if;

  select * into anchor_mutation from public.note_mutations
  where user_id = p_owner_id and id = p_mutation_id for share;
  if not found or anchor_mutation.mutation_envelope is null
    or anchor_mutation.undone_at is not null
  then raise exception using errcode = 'P0001', message = 'not_found'; end if;
  select * into anchor_note from public.notes
  where user_id = p_owner_id and id = anchor_mutation.note_id for share;
  if not found or anchor_note.current_revision <> p_expected_revision
    or anchor_note.deleted_at is not null
  then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;

  if batch_id_value is not null then
    select array_agg(member.mutation_id order by member.ordinal)
    into mutation_ids
    from public.encrypted_mutation_batch_members as member
    where member.user_id = p_owner_id and member.batch_id = batch_id_value;
  end if;
  if mutation_ids is null then
    select link.feedback_event_id into feedback_id_value
    from public.feedback_event_mutations as link
    where link.user_id = p_owner_id and link.mutation_id = p_mutation_id;
    if feedback_id_value is not null then
      select array_agg(link.mutation_id order by link.role, link.mutation_id)
      into mutation_ids
      from public.feedback_event_mutations as link
      where link.user_id = p_owner_id
        and link.feedback_event_id = feedback_id_value;
    end if;
  end if;
  if mutation_ids is null then
    select link.capture_id into capture_id_value
    from public.capture_note_links as link
    where link.user_id = p_owner_id and link.mutation_id = p_mutation_id
    order by link.created_at desc limit 1;
    if capture_id_value is not null then
      select array_agg(link.mutation_id order by link.note_id, link.mutation_id)
      into mutation_ids
      from public.capture_note_links as link
      where link.user_id = p_owner_id and link.capture_id = capture_id_value
        and link.relation = 'routed';
    end if;
  end if;
  mutation_ids := coalesce(mutation_ids, array[p_mutation_id]);
  if cardinality(mutation_ids) not between 1 and 16
    or cardinality(mutation_ids) <>
      (select count(distinct value) from unnest(mutation_ids) as ids(value))
    or not p_mutation_id = any(mutation_ids)
  then raise exception using errcode = 'P0001', message = 'conflict_requires_review'; end if;
  if exists (
    select 1
    from unnest(mutation_ids) as requested(mutation_id)
    left join public.note_mutations as mutation
      on mutation.user_id = p_owner_id and mutation.id = requested.mutation_id
    left join public.notes as note
      on note.user_id = mutation.user_id and note.id = mutation.note_id
    left join public.note_revisions as restored_revision
      on restored_revision.user_id = mutation.user_id
      and restored_revision.note_id = mutation.note_id
      and restored_revision.revision = mutation.before_revision
      and mutation.before_revision > 0
    where mutation.id is null or mutation.mutation_envelope is null
      or mutation.mutation_key_id is null
      or mutation.mutation_key_class is null
      or mutation.mutation_key_purpose <> 'object_wrap'
      or mutation.mutation_key_version is null
      or mutation.undone_at is not null or note.id is null
      or (
        note.deleted_at is not null
        and not (
          batch_kind_value = 'correction'
          and note.current_revision = mutation.after_revision
          and exists (
            select 1
            from public.encrypted_mutation_batch_members as source_member
            join public.note_revisions as head_revision
              on head_revision.user_id = source_member.user_id
              and head_revision.note_id = source_member.note_id
              and head_revision.revision = note.current_revision
              and head_revision.mutation_id = source_member.mutation_id
            join public.content_encryption_verifications as verification
              on verification.user_id = source_member.user_id
              and verification.surface = 'note_content'
              and verification.resource_id = source_member.note_id
              and verification.record_version = note.current_revision
              and verification.envelope_digest =
                private.owner_interaction_envelope_digest(
                  note.content_envelope
                )
            where source_member.user_id = p_owner_id
              and source_member.batch_id = batch_id_value
              and source_member.mutation_id = mutation.id
              and source_member.note_id = note.id
              and source_member.role = 'source_removal'
              and head_revision.deleted_at is not null
              and head_revision.deleted_at is not distinct from note.deleted_at
          )
        )
      )
      or note.content_envelope is null
      or (mutation.before_revision > 0 and (
        restored_revision.id is null
        or restored_revision.snapshot_envelope is null
        or restored_revision.snapshot_key_id is null
        or restored_revision.snapshot_key_class is null
        or restored_revision.snapshot_key_purpose <> 'object_wrap'
        or restored_revision.snapshot_key_version is null
        or restored_revision.snapshot_mac is null
        or restored_revision.snapshot_mac_key_id is null
        or restored_revision.snapshot_mac_key_class is null
        or restored_revision.snapshot_mac_key_purpose <> 'content_mac'
        or restored_revision.snapshot_mac_key_version is null
      ))
  ) or (
    select count(distinct mutation.note_id)
    from unnest(mutation_ids) as requested(mutation_id)
    join public.note_mutations as mutation
      on mutation.user_id = p_owner_id and mutation.id = requested.mutation_id
  ) <> cardinality(mutation_ids)
  then raise exception using errcode = 'P0001', message = 'conflict_requires_review'; end if;

  select coalesce(
    (select link.capture_id from public.capture_note_links as link
      where link.user_id = p_owner_id and link.mutation_id = p_mutation_id
      order by link.created_at desc limit 1),
    (select receipt.capture_id from public.capture_receipts as receipt
      where receipt.user_id = p_owner_id and receipt.mutation_id = p_mutation_id
      limit 1)
  ) into capture_id_value;
  if capture_id_value is not null then
    select * into capture_row from public.captures
    where user_id = p_owner_id and id = capture_id_value for share;
    if not found or capture_row.content_envelope is null then
      raise exception using errcode = 'P0001',
        message = 'encrypted_content_unavailable';
    end if;
    select * into receipt_row from public.capture_receipts
    where user_id = p_owner_id and capture_id = capture_id_value for share;
    if not found or receipt_row.receipt_envelope is null
      or receipt_row.receipt_key_class::text
        is distinct from capture_row.privacy::text
    then
      raise exception using errcode = 'P0001',
        message = 'encrypted_content_unavailable';
    end if;
  end if;
  if batch_kind_value = 'correction' then
    select source_member.note_id, destination_member.note_id,
      destination_mutation.decision_id
    into restored_source_note_id_value, source_destination_note_id_value,
      source_decision_id_value
    from public.encrypted_mutation_batch_members as source_member
    join public.encrypted_mutation_batch_members as destination_member
      on destination_member.user_id = source_member.user_id
      and destination_member.batch_id = source_member.batch_id
      and destination_member.role = 'destination_write'
    join public.note_mutations as destination_mutation
      on destination_mutation.user_id = destination_member.user_id
      and destination_mutation.id = destination_member.mutation_id
    where source_member.user_id = p_owner_id
      and source_member.batch_id = batch_id_value
      and source_member.role = 'source_removal';
    if capture_id_value is null
      or receipt_row.capture_id is null
      or receipt_row.decision_id is null
      or receipt_row.decision_id is distinct from source_decision_id_value
      or receipt_row.destination_note_id is distinct from
        source_destination_note_id_value
      or receipt_row.mutation_id is distinct from p_mutation_id
      or receipt_row.outcome not in ('added_to_note', 'created_note')
      or not exists (
        select 1 from public.organization_decisions as decision
        where decision.user_id = p_owner_id
          and decision.id = source_decision_id_value
          and decision.capture_id = capture_id_value
          and decision.destination_note_id = source_destination_note_id_value
          and decision.decision_envelope is not null
      )
      or 1 <> (
        select count(*) from public.capture_note_links as link
        where link.user_id = p_owner_id
          and link.capture_id = capture_id_value
          and link.note_id = restored_source_note_id_value
          and link.relation = 'source_removed'
      )
      or 1 <> (
        select count(*) from public.capture_note_links as link
        where link.user_id = p_owner_id
          and link.capture_id = capture_id_value
          and link.note_id = source_destination_note_id_value
          and link.mutation_id = p_mutation_id
          and link.relation = 'routed'
      )
    then
      raise exception using errcode = 'P0001',
        message = 'conflict_requires_review';
    end if;
  end if;
  if exists (
    select 1 from unnest(mutation_ids) as requested(mutation_id)
    join public.note_mutations as mutation
      on mutation.user_id = p_owner_id and mutation.id = requested.mutation_id
    join public.notes as note
      on note.user_id = mutation.user_id and note.id = mutation.note_id
    left join public.note_revisions as restored_revision
      on restored_revision.user_id = mutation.user_id
      and restored_revision.note_id = mutation.note_id
      and restored_revision.revision = mutation.before_revision
      and mutation.before_revision > 0
    where note.privacy = 'private_manual'
      or (case when mutation.before_revision = 0 then note.privacy
          else restored_revision.privacy end) = 'private_manual'
      or mutation.mutation_key_class = 'private_manual'
      or restored_revision.snapshot_key_class = 'private_manual'
  ) or receipt_row.receipt_key_class = 'private_manual'
    or capture_row.privacy = 'private_manual'
  then history_class := 'private_manual'; end if;
  request_key := private.owner_interaction_active_key(
    p_owner_id, history_class, 'content_mac'
  );
  insert into public.encrypted_owner_interaction_claims (
    user_id, idempotency_key, scope, action, anchor_mutation_id,
    capture_id, receipt_revision, expected_anchor_revision,
    conflict_review_item_id, output_batch_id, receipt_envelope_digest,
    history_key_class, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) values (
    p_owner_id, p_idempotency_key, 'encrypted_mutation_batch_undo',
    'pending', p_mutation_id, capture_id_value,
    case when receipt_row.capture_id is null then null
      else receipt_row.receipt_revision end,
    p_expected_revision, public.new_entity_id('rvw'),
    extensions.gen_random_uuid(),
    case when receipt_row.capture_id is null then null else
      private.owner_interaction_envelope_digest(receipt_row.receipt_envelope) end,
    history_class, request_key.key_id, request_key.key_class,
    request_key.key_purpose, request_key.key_version
  ) returning * into claim_row;

  for member_record in
    select mutation.*, note.current_revision, note.privacy,
      note.content_envelope,
      case when mutation.before_revision = 0 then note.privacy
        else restored_revision.privacy end as target_privacy,
      case when note.privacy = 'private_manual'
          or (case when mutation.before_revision = 0 then note.privacy
              else restored_revision.privacy end) = 'private_manual'
          or mutation.mutation_key_class = 'private_manual'
          or restored_revision.snapshot_key_class = 'private_manual'
        then 'private_manual'::public.content_key_class
        else 'ai_assisted'::public.content_key_class
      end as member_history_key_class
    from unnest(mutation_ids) as requested(mutation_id)
    join public.note_mutations as mutation
      on mutation.user_id = p_owner_id and mutation.id = requested.mutation_id
    join public.notes as note
      on note.user_id = mutation.user_id and note.id = mutation.note_id
    left join public.note_revisions as restored_revision
      on restored_revision.user_id = mutation.user_id
      and restored_revision.note_id = mutation.note_id
      and restored_revision.revision = mutation.before_revision
      and mutation.before_revision > 0
    order by note.id, mutation.id
  loop
    insert into public.encrypted_owner_interaction_members (
      user_id, idempotency_key, ordinal, role, note_id,
      target_mutation_id, expected_revision, source_privacy, target_privacy,
      revision_id, mutation_id, expected_note_envelope_digest,
      expected_mutation_envelope_digest, history_key_class
    ) values (
      p_owner_id, p_idempotency_key, ordinal_value, 'undo',
      member_record.note_id, member_record.id,
      member_record.current_revision, member_record.privacy,
      member_record.target_privacy, public.new_entity_id('rev'),
      public.new_entity_id('mut'),
      private.owner_interaction_envelope_digest(member_record.content_envelope),
      private.owner_interaction_envelope_digest(member_record.mutation_envelope),
      member_record.member_history_key_class
    );
    ordinal_value := ordinal_value + 1;
  end loop;
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'common', 'response',
    'idempotency_response', 'idempotency:' || p_idempotency_key, 1,
    history_class
  );
  if receipt_row.capture_id is not null then
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'common', 'receipt',
      'capture_receipt', receipt_row.capture_id,
      receipt_row.receipt_revision + 1, receipt_row.receipt_key_class
    );
  end if;
  perform private.reserve_owner_interaction_object(
    p_owner_id, p_idempotency_key, 'needs_review', 'review',
    'review_item', claim_row.conflict_review_item_id, 1,
    history_class
  );
  for reservation_ordinal in 0..cardinality(mutation_ids) - 1 loop
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'applied',
      'note_content:' || reservation_ordinal, 'note_content',
      (select note_id from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select expected_revision + 1
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select target_privacy::text::public.content_key_class
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal)
    );
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'applied',
      'note_revision:' || reservation_ordinal, 'note_revision',
      (select revision_id from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select expected_revision + 1
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select history_key_class
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal)
    );
    perform private.reserve_owner_interaction_object(
      p_owner_id, p_idempotency_key, 'applied',
      'note_mutation:' || reservation_ordinal, 'note_mutation',
      (select mutation_id from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select expected_revision + 1
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal),
      (select history_key_class
        from public.encrypted_owner_interaction_members
        where user_id = p_owner_id and idempotency_key = p_idempotency_key
          and ordinal = reservation_ordinal)
    );
  end loop;
  return private.owner_interaction_prepare_projection(claim_row, false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.valid_owner_interaction_note_state(
  p_state jsonb
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.jsonb_has_exact_keys(p_state, array[
      'spaceId','type','dailyDate','isOpen','privacy','pinnedAt',
      'archivedAt','deletedAt','tagIds','links'
    ])
    or jsonb_typeof(p_state -> 'spaceId') not in ('string','null')
    or jsonb_typeof(p_state -> 'type') <> 'string'
    or jsonb_typeof(p_state -> 'dailyDate') not in ('string','null')
    or jsonb_typeof(p_state -> 'isOpen') <> 'boolean'
    or jsonb_typeof(p_state -> 'privacy') <> 'string'
    or jsonb_typeof(p_state -> 'pinnedAt') not in ('string','null')
    or jsonb_typeof(p_state -> 'archivedAt') not in ('string','null')
    or jsonb_typeof(p_state -> 'deletedAt') not in ('string','null')
    or jsonb_typeof(p_state -> 'tagIds') <> 'array'
    or jsonb_array_length(p_state -> 'tagIds') > 100
    or jsonb_typeof(p_state -> 'links') <> 'array'
    or jsonb_array_length(p_state -> 'links') > 100
  then return false; end if;
  perform (p_state ->> 'type')::public.note_type;
  perform (p_state ->> 'privacy')::public.privacy_mode;
  perform (p_state ->> 'isOpen')::boolean;
  if jsonb_typeof(p_state -> 'dailyDate') = 'string' then
    perform (p_state ->> 'dailyDate')::date;
  end if;
  if jsonb_typeof(p_state -> 'pinnedAt') = 'string'
    and not private.valid_iso_offset_datetime(p_state ->> 'pinnedAt')
  then return false; end if;
  if jsonb_typeof(p_state -> 'archivedAt') = 'string'
    and not private.valid_iso_offset_datetime(p_state ->> 'archivedAt')
  then return false; end if;
  if jsonb_typeof(p_state -> 'deletedAt') = 'string'
    and not private.valid_iso_offset_datetime(p_state ->> 'deletedAt')
  then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(p_state -> 'tagIds') as item(value)
    where jsonb_typeof(item.value) <> 'string'
      or item.value #>> '{}' !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'
  ) or (
    select count(*) from jsonb_array_elements(p_state -> 'tagIds')
  ) <> (
    select count(distinct value) from jsonb_array_elements_text(p_state -> 'tagIds')
  ) or exists (
    select 1 from jsonb_array_elements(p_state -> 'links') as item(value)
    where not private.jsonb_has_exact_keys(item.value, array['toNoteId','linkType'])
      or jsonb_typeof(item.value -> 'toNoteId') <> 'string'
      or jsonb_typeof(item.value -> 'linkType') <> 'string'
  ) then return false; end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function private.owner_interaction_cipher_matches_binding(
  p_owner_id uuid,
  p_idempotency_key text,
  p_branch text,
  p_role text,
  p_cipher jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  binding public.encrypted_owner_interaction_reservations%rowtype;
  reservation public.content_key_operation_reservations%rowtype;
begin
  select * into binding
  from public.encrypted_owner_interaction_reservations
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
    and branch = p_branch and role = p_role;
  if not found then return false; end if;
  select * into reservation from public.content_key_operation_reservations
  where user_id = p_owner_id and reservation_id = binding.reservation_id;
  return found
    and reservation.consumed_at is null
    and p_cipher ->> 'reservationId' = binding.reservation_id::text
    and p_cipher ->> 'keyId' = reservation.key_id
    and p_cipher ->> 'keyClass' = reservation.key_class::text
    and p_cipher ->> 'keyPurpose' = reservation.key_purpose::text
    and (p_cipher ->> 'keyVersion')::integer = reservation.key_version
    and private.valid_encrypted_write_cipher(
      p_cipher, p_owner_id, binding.resource_id, binding.record_version,
      binding.surface, binding.key_class
    );
exception when others then
  return false;
end;
$$;

create or replace function private.insert_owner_interaction_note(
  p_owner_id uuid,
  p_note_id text,
  p_state jsonb,
  p_cipher jsonb,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notes (
    id,user_id,space_id,type,current_revision,daily_date,is_open,pinned_at,
    privacy,archived_at,deleted_at,created_at,updated_at,content_envelope,
    content_key_id,content_key_class,content_key_purpose,content_key_version
  ) values (
    p_note_id,p_owner_id,nullif(p_state ->> 'spaceId',''),
    (p_state ->> 'type')::public.note_type,1,
    case when jsonb_typeof(p_state -> 'dailyDate') = 'null' then null
      else (p_state ->> 'dailyDate')::date end,
    (p_state ->> 'isOpen')::boolean,
    case when jsonb_typeof(p_state -> 'pinnedAt') = 'null' then null
      else (p_state ->> 'pinnedAt')::timestamptz end,
    (p_state ->> 'privacy')::public.privacy_mode,
    case when jsonb_typeof(p_state -> 'archivedAt') = 'null' then null
      else (p_state ->> 'archivedAt')::timestamptz end,
    case when jsonb_typeof(p_state -> 'deletedAt') = 'null' then null
      else (p_state ->> 'deletedAt')::timestamptz end,
    p_occurred_at,p_occurred_at,p_cipher -> 'envelope',
    p_cipher ->> 'keyId',
    (p_cipher ->> 'keyClass')::public.content_key_class,
    (p_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (p_cipher ->> 'keyVersion')::integer
  );
end;
$$;

create or replace function private.insert_owner_interaction_revision(
  p_owner_id uuid,
  p_note_id text,
  p_revision integer,
  p_state jsonb,
  p_revision_value jsonb,
  p_mutation_id text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.note_revisions (
    id,note_id,user_id,revision,source,space_id,type,is_open,pinned_at,
    privacy,archived_at,deleted_at,actor,mutation_id,created_at,
    snapshot_envelope,snapshot_key_id,snapshot_key_class,
    snapshot_key_purpose,snapshot_key_version,snapshot_mac,
    snapshot_mac_key_id,snapshot_mac_key_class,snapshot_mac_key_purpose,
    snapshot_mac_key_version
  ) values (
    p_revision_value ->> 'id',p_note_id,p_owner_id,p_revision,
    (p_revision_value ->> 'source')::public.revision_source,
    nullif(p_state ->> 'spaceId',''),(p_state ->> 'type')::public.note_type,
    (p_state ->> 'isOpen')::boolean,
    case when jsonb_typeof(p_state -> 'pinnedAt')='null' then null
      else (p_state ->> 'pinnedAt')::timestamptz end,
    (p_state ->> 'privacy')::public.privacy_mode,
    case when jsonb_typeof(p_state -> 'archivedAt')='null' then null
      else (p_state ->> 'archivedAt')::timestamptz end,
    case when jsonb_typeof(p_state -> 'deletedAt')='null' then null
      else (p_state ->> 'deletedAt')::timestamptz end,
    p_revision_value ->> 'actor',p_mutation_id,p_occurred_at,
    p_revision_value #> '{cipher,envelope}',
    p_revision_value #>> '{cipher,keyId}',
    (p_revision_value #>> '{cipher,keyClass}')::public.content_key_class,
    (p_revision_value #>> '{cipher,keyPurpose}')::public.content_key_purpose,
    (p_revision_value #>> '{cipher,keyVersion}')::integer,
    p_revision_value #>> '{mac,mac}',p_revision_value #>> '{mac,keyId}',
    (p_revision_value #>> '{mac,keyClass}')::public.content_key_class,
    (p_revision_value #>> '{mac,keyPurpose}')::public.content_key_purpose,
    (p_revision_value #>> '{mac,keyVersion}')::integer
  );
end;
$$;

create or replace function private.insert_owner_interaction_mutation(
  p_claim public.encrypted_owner_interaction_claims,
  p_member public.encrypted_owner_interaction_members,
  p_mutation_value jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.note_mutations (
    id,user_id,decision_id,note_id,idempotency_key,before_revision,
    after_revision,created_at,mutation_envelope,mutation_key_id,
    mutation_key_class,mutation_key_purpose,mutation_key_version
  ) values (
    p_member.mutation_id,p_claim.user_id,
    case when p_claim.scope = 'encrypted_decision_correction'
        or (p_claim.scope = 'encrypted_review_resolution'
          and p_claim.action in ('route','create'))
      then p_claim.decision_id
      when p_claim.scope = 'encrypted_mutation_batch_undo' then (
        -- Only the restored-source member of a correction Undo becomes the
        -- new routed mutation. Preserve its authenticated decision lineage so
        -- a later Move can open it; the former-destination removal remains
        -- deliberately decisionless.
        select target_mutation.decision_id
        from public.encrypted_mutation_batch_members as source_member
        join public.encrypted_mutation_batches as source_batch
          on source_batch.user_id = source_member.user_id
          and source_batch.batch_id = source_member.batch_id
        join public.note_mutations as target_mutation
          on target_mutation.user_id = source_member.user_id
          and target_mutation.id = source_member.mutation_id
        where source_member.user_id = p_claim.user_id
          and source_member.mutation_id = p_member.target_mutation_id
          and source_member.role = 'source_removal'
          and source_batch.kind = 'correction'
          and source_batch.anchor_mutation_id = p_claim.anchor_mutation_id
      )
      else null end,
    p_member.note_id,p_claim.idempotency_key||':member:'||p_member.ordinal,
    p_member.expected_revision,p_member.expected_revision+1,
    p_claim.occurred_at,p_mutation_value #> '{cipher,envelope}',
    p_mutation_value #>> '{cipher,keyId}',
    (p_mutation_value #>> '{cipher,keyClass}')::public.content_key_class,
    (p_mutation_value #>> '{cipher,keyPurpose}')::public.content_key_purpose,
    (p_mutation_value #>> '{cipher,keyVersion}')::integer
  );
end;
$$;

create or replace function private.write_owner_interaction_review(
  p_claim public.encrypted_owner_interaction_claims,
  p_review jsonb,
  p_state public.review_state
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id text;
  note_id_value text;
begin
  existing_id := case when p_claim.scope = 'encrypted_review_resolution'
    then p_claim.review_item_id else null end;
  note_id_value := case
    when p_claim.scope = 'encrypted_decision_correction'
      then p_claim.source_note_id
    when p_claim.scope = 'encrypted_mutation_batch_undo' then (
      select note_id from public.encrypted_owner_interaction_members
      where user_id = p_claim.user_id
        and idempotency_key = p_claim.idempotency_key
        and target_mutation_id = p_claim.anchor_mutation_id
      limit 1
    ) else null end;
  if existing_id is null then
    insert into public.review_items (
      id,user_id,capture_id,note_id,type,state,created_at,resolved_at,
      review_envelope,review_key_id,review_key_class,review_key_purpose,
      review_key_version,review_content_revision
    ) values (
      p_review ->> 'reviewItemId',p_claim.user_id,p_claim.capture_id,
      note_id_value,(p_review ->> 'type')::public.review_type,p_state,
      p_claim.occurred_at,null,p_review #> '{cipher,envelope}',
      p_review #>> '{cipher,keyId}',
      (p_review #>> '{cipher,keyClass}')::public.content_key_class,
      (p_review #>> '{cipher,keyPurpose}')::public.content_key_purpose,
      (p_review #>> '{cipher,keyVersion}')::integer,1
    );
  else
    update public.review_items set
      note_id = case
        when p_claim.scope = 'encrypted_review_resolution'
          and p_claim.action in ('route','create')
        then p_claim.destination_note_id
        else note_id
      end,
      state = p_state,
      resolved_at = p_claim.occurred_at,
      review_content_revision = review_content_revision + 1,
      review_envelope = p_review #> '{cipher,envelope}',
      review_key_id = p_review #>> '{cipher,keyId}',
      review_key_class =
        (p_review #>> '{cipher,keyClass}')::public.content_key_class,
      review_key_purpose =
        (p_review #>> '{cipher,keyPurpose}')::public.content_key_purpose,
      review_key_version = (p_review #>> '{cipher,keyVersion}')::integer
    where user_id = p_claim.user_id and id = existing_id;
  end if;
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'review_item', p_review ->> 'reviewItemId',
    (p_review ->> 'recordVersion')::integer,
    p_review #> '{cipher,envelope}', p_review -> 'verificationMac'
  );
end;
$$;

create or replace function private.update_owner_interaction_receipt(
  p_claim public.encrypted_owner_interaction_claims,
  p_receipt jsonb,
  p_outcome text,
  p_destination_note_id text,
  p_mutation_id text,
  p_review_item_id text,
  p_reason_codes text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_claim.capture_id is null then return; end if;
  update public.capture_receipts set
    decision_id = case
      when p_claim.scope = 'encrypted_mutation_batch_undo'
        and p_outcome = 'needs_review'
      then null
      else decision_id end,
    review_item_id = p_review_item_id,
    mutation_id = p_mutation_id,
    outcome = p_outcome,
    destination_note_id = p_destination_note_id,
    reason_codes = p_reason_codes,
    receipt_revision = (p_receipt ->> 'recordVersion')::integer,
    receipt_envelope = p_receipt #> '{cipher,envelope}',
    receipt_key_id = p_receipt #>> '{cipher,keyId}',
    receipt_key_class =
      (p_receipt #>> '{cipher,keyClass}')::public.content_key_class,
    receipt_key_purpose =
      (p_receipt #>> '{cipher,keyPurpose}')::public.content_key_purpose,
    receipt_key_version = (p_receipt #>> '{cipher,keyVersion}')::integer
  where user_id = p_claim.user_id and capture_id = p_claim.capture_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'capture_receipt', p_claim.capture_id,
    (p_receipt ->> 'recordVersion')::integer,
    p_receipt #> '{cipher,envelope}', p_receipt -> 'verificationMac'
  );
end;
$$;

create or replace function private.consume_owner_interaction_reservations(
  p_claim public.encrypted_owner_interaction_claims,
  p_selected_branch text,
  p_ciphers jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_ids uuid[];
  supplied_ids uuid[];
  binding record;
  key_state public.content_key_state;
  consumer_id text := left(p_claim.scope || ':' || p_claim.idempotency_key, 200);
begin
  if jsonb_typeof(p_ciphers) <> 'array'
    or jsonb_array_length(p_ciphers) < 1
    or (p_selected_branch is not null
      and p_selected_branch not in ('applied','needs_review'))
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  select array_agg(reservation_id order by reservation_id)
  into expected_ids
  from public.encrypted_owner_interaction_reservations
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key
    and (branch = 'common' or branch = p_selected_branch);
  begin
    select array_agg((item ->> 'reservationId')::uuid order by
      (item ->> 'reservationId')::uuid)
    into supplied_ids
    from jsonb_array_elements(p_ciphers) as supplied(item);
  exception when others then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  if expected_ids is distinct from supplied_ids
    or cardinality(supplied_ids) <>
      (select count(distinct value) from unnest(supplied_ids) as supplied(value))
  then raise exception using errcode = 'P0001', message = 'invalid_key_reservation'; end if;

  for binding in
    select reservation.*, relation.branch
    from public.encrypted_owner_interaction_reservations as relation
    join public.content_key_operation_reservations as reservation
      on reservation.user_id = relation.user_id
      and reservation.reservation_id = relation.reservation_id
    where relation.user_id = p_claim.user_id
      and relation.idempotency_key = p_claim.idempotency_key
    order by reservation.reservation_id
    for update of reservation
  loop
    if binding.consumed_at is not null then
      raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
    end if;
    select state into key_state from public.user_content_keys
    where user_id = p_claim.user_id and key_id = binding.key_id
      and key_class = binding.key_class and key_purpose = binding.key_purpose
      and key_version = binding.key_version for share;
    if key_state is distinct from 'active'::public.content_key_state then
      raise exception using errcode = 'P0001', message = 'invalid_key_state';
    end if;
    update public.content_key_operation_reservations set
      consumed_by_type = 'encrypted_owner_interaction',
      consumed_by_id = case when binding.branch = 'common'
          or binding.branch = p_selected_branch then consumer_id
        else left('cancelled:' || consumer_id, 200) end,
      consumed_at = clock_timestamp()
    where user_id = p_claim.user_id
      and reservation_id = binding.reservation_id;
  end loop;
end;
$$;

create or replace function private.apply_owner_interaction_write(
  p_claim public.encrypted_owner_interaction_claims,
  p_member public.encrypted_owner_interaction_members,
  p_write jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  state_value jsonb := p_write -> 'noteState';
  cipher_value jsonb := p_write -> 'noteCipher';
  revision_value jsonb := p_write -> 'revision';
  mutation_value jsonb := p_write -> 'mutation';
  revision_number integer := p_member.expected_revision + 1;
  is_new boolean := p_member.expected_revision = 0;
begin
  if is_new then
    perform private.insert_owner_interaction_note(
      p_claim.user_id, p_member.note_id, state_value, cipher_value,
      p_claim.occurred_at
    );
  else
    update public.notes set
      space_id = nullif(state_value ->> 'spaceId',''),
      type = (state_value ->> 'type')::public.note_type,
      current_revision = revision_number,
      daily_date = case when jsonb_typeof(state_value -> 'dailyDate') = 'null'
        then null else (state_value ->> 'dailyDate')::date end,
      is_open = (state_value ->> 'isOpen')::boolean,
      pinned_at = case when jsonb_typeof(state_value -> 'pinnedAt') = 'null'
        then null else (state_value ->> 'pinnedAt')::timestamptz end,
      privacy = (state_value ->> 'privacy')::public.privacy_mode,
      archived_at = case when jsonb_typeof(state_value -> 'archivedAt') = 'null'
        then null else (state_value ->> 'archivedAt')::timestamptz end,
      deleted_at = case when jsonb_typeof(state_value -> 'deletedAt') = 'null'
        then null else (state_value ->> 'deletedAt')::timestamptz end,
      updated_at = p_claim.occurred_at,
      content_envelope = cipher_value -> 'envelope',
      content_key_id = cipher_value ->> 'keyId',
      content_key_class =
        (cipher_value ->> 'keyClass')::public.content_key_class,
      content_key_purpose =
        (cipher_value ->> 'keyPurpose')::public.content_key_purpose,
      content_key_version = (cipher_value ->> 'keyVersion')::integer
    where user_id = p_claim.user_id and id = p_member.note_id
      and current_revision = p_member.expected_revision;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;
  perform private.insert_owner_interaction_mutation(
    p_claim, p_member, mutation_value
  );
  perform private.insert_owner_interaction_revision(
    p_claim.user_id, p_member.note_id, revision_number, state_value,
    revision_value, p_member.mutation_id, p_claim.occurred_at
  );
  perform private.restore_note_relations(
    p_claim.user_id, p_member.note_id, state_value, p_member.mutation_id
  );
  if p_member.target_mutation_id is not null then
    update public.note_mutations set undone_at = p_claim.occurred_at
    where user_id = p_claim.user_id and id = p_member.target_mutation_id
      and undone_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
  end if;
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'note_content', p_member.note_id, revision_number,
    cipher_value -> 'envelope', p_write #> '{verification,noteContent}'
  );
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'note_revision', p_member.revision_id, revision_number,
    revision_value #> '{cipher,envelope}', revision_value -> 'mac'
  );
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'note_mutation', p_member.mutation_id, revision_number,
    mutation_value #> '{cipher,envelope}',
    p_write #> '{verification,noteMutation}'
  );
  perform private.enqueue_encrypted_note_index_jobs(
    p_claim.user_id, p_member.note_id, revision_number,
    p_member.target_privacy, is_new
  );
  perform private.emit_user_event(p_claim.user_id, 'note', p_member.note_id);
  perform private.emit_user_event(
    p_claim.user_id, 'note_revision', p_member.revision_id
  );
  perform private.emit_user_event(
    p_claim.user_id, 'note_mutation', p_member.mutation_id
  );
end;
$$;

create or replace function private.validate_owner_interaction_command(
  p_claim public.encrypted_owner_interaction_claims,
  p_selected_outcome text,
  p_command jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  expected_write_count integer;
  write_value jsonb;
  member_row public.encrypted_owner_interaction_members%rowtype;
  branch_value text;
  receipt_value jsonb := p_command -> 'receipt';
  review_value jsonb := p_command -> 'review';
  response_value jsonb := p_command -> 'responseCipher';
  request_mac_value jsonb := p_command -> 'requestMac';
  ciphers_value jsonb := '[]'::jsonb;
  receipt_write_required boolean;
begin
  receipt_write_required := p_claim.receipt_revision is not null
    and (p_claim.scope <> 'encrypted_review_resolution'
      or p_claim.action in ('route','create','keep_inbox'));
  if p_claim.scope in (
      'encrypted_decision_correction','encrypted_mutation_batch_undo'
    ) then
    if not private.jsonb_has_exact_keys(p_command, array[
        'selectedOutcome','requestMac','responseCipher',
        'responseVerificationMac','writes','receipt','review'
      ]) or p_selected_outcome not in ('applied','needs_review')
      or p_command ->> 'selectedOutcome' <> p_selected_outcome
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    branch_value := p_selected_outcome;
  else
    if not private.jsonb_has_exact_keys(p_command, array[
        'requestMac','responseCipher','responseVerificationMac',
        'writes','receipt','review'
      ]) or p_selected_outcome is not null
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    branch_value := 'common';
  end if;
  if jsonb_typeof(request_mac_value) <> 'object'
    or not private.valid_encrypted_write_mac(
      request_mac_value, p_claim.user_id, p_claim.history_key_class, true
    )
    or request_mac_value ->> 'keyId' <> p_claim.request_mac_key_id
    or request_mac_value ->> 'keyClass' <> p_claim.request_mac_key_class::text
    or request_mac_value ->> 'keyPurpose' <>
      p_claim.request_mac_key_purpose::text
    or (request_mac_value ->> 'keyVersion')::integer <>
      p_claim.request_mac_key_version
    or jsonb_typeof(response_value) <> 'object'
    or not private.owner_interaction_cipher_matches_binding(
      p_claim.user_id, p_claim.idempotency_key, 'common', 'response',
      response_value
    )
    or jsonb_typeof(p_command -> 'responseVerificationMac') <> 'object'
    or not private.valid_encrypted_write_mac(
      p_command -> 'responseVerificationMac', p_claim.user_id,
      p_claim.history_key_class, false
    )
    or jsonb_typeof(p_command -> 'writes') <> 'array'
    or jsonb_typeof(receipt_value) not in ('object','null')
    or jsonb_typeof(review_value) not in ('object','null')
  then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;
  ciphers_value := ciphers_value || jsonb_build_array(response_value);

  expected_write_count := case
    when p_claim.scope <> 'encrypted_review_resolution'
      and p_selected_outcome = 'needs_review' then 0
    when p_claim.scope = 'encrypted_review_resolution'
      and p_claim.action not in ('route','create') then 0
    else (select count(*) from public.encrypted_owner_interaction_members
      where user_id = p_claim.user_id
        and idempotency_key = p_claim.idempotency_key) end;
  if jsonb_array_length(p_command -> 'writes') <> expected_write_count
    or (select count(distinct item ->> 'ordinal')
        from jsonb_array_elements(p_command -> 'writes') as supplied(item))
      <> expected_write_count
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;

  for write_value in
    select item from jsonb_array_elements(p_command -> 'writes') as supplied(item)
    order by (item ->> 'ordinal')::integer
  loop
    if not private.jsonb_has_exact_keys(write_value, array[
        'ordinal','noteId','targetMutationId','expectedRevision','noteState',
        'noteCipher','revision','mutation','verification'
      ])
      or jsonb_typeof(write_value -> 'ordinal') <> 'number'
      or write_value ->> 'ordinal' !~ '^(0|[1-9][0-9]?)$'
      or jsonb_typeof(write_value -> 'noteId') <> 'string'
      or jsonb_typeof(write_value -> 'targetMutationId') not in ('string','null')
      or jsonb_typeof(write_value -> 'expectedRevision') <> 'number'
      or write_value ->> 'expectedRevision' !~ '^(0|[1-9][0-9]{0,8})$'
      or not private.valid_owner_interaction_note_state(
        write_value -> 'noteState'
      )
      or not private.jsonb_has_exact_keys(write_value -> 'revision', array[
        'id','source','actor','cipher','mac'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'mutation', array[
        'id','undoTargetMutationId','cipher'
      ])
      or not private.jsonb_has_exact_keys(write_value -> 'verification', array[
        'noteContent','noteMutation'
      ])
    then raise exception using errcode = '22023', message = 'validation_failed'; end if;
    select * into member_row from public.encrypted_owner_interaction_members
    where user_id = p_claim.user_id
      and idempotency_key = p_claim.idempotency_key
      and ordinal = (write_value ->> 'ordinal')::integer;
    if not found
      or write_value ->> 'noteId' <> member_row.note_id
      or (write_value ->> 'expectedRevision')::integer <>
        member_row.expected_revision
      or nullif(write_value ->> 'targetMutationId','') is distinct from
        member_row.target_mutation_id
      or write_value #>> '{revision,id}' <> member_row.revision_id
      or write_value #>> '{mutation,id}' <> member_row.mutation_id
      or nullif(write_value #>> '{mutation,undoTargetMutationId}','')
        is distinct from member_row.target_mutation_id
      or write_value #>> '{noteState,privacy}' <>
        member_row.target_privacy::text
      or write_value #>> '{revision,source}' not in ('interactive','undo')
      or write_value #>> '{revision,actor}'
        !~ '^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      or (p_claim.scope = 'encrypted_mutation_batch_undo'
        and write_value #>> '{revision,source}' <> 'undo')
      or (p_claim.scope <> 'encrypted_mutation_batch_undo'
        and write_value #>> '{revision,source}' <> 'interactive')
      or not private.owner_interaction_cipher_matches_binding(
        p_claim.user_id, p_claim.idempotency_key, branch_value,
        'note_content:' || member_row.ordinal, write_value -> 'noteCipher'
      )
      or not private.owner_interaction_cipher_matches_binding(
        p_claim.user_id, p_claim.idempotency_key, branch_value,
        'note_revision:' || member_row.ordinal,
        write_value #> '{revision,cipher}'
      )
      or not private.owner_interaction_cipher_matches_binding(
        p_claim.user_id, p_claim.idempotency_key, branch_value,
        'note_mutation:' || member_row.ordinal,
        write_value #> '{mutation,cipher}'
      )
      or not private.valid_encrypted_write_mac(
        write_value #> '{revision,mac}', p_claim.user_id,
        member_row.history_key_class, false
      )
      or not private.valid_encrypted_write_mac(
        write_value #> '{verification,noteContent}', p_claim.user_id,
        member_row.target_privacy::text::public.content_key_class, false
      )
      or not private.valid_encrypted_write_mac(
        write_value #> '{verification,noteMutation}', p_claim.user_id,
        member_row.history_key_class, false
      )
    then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;
    perform private.assert_encrypted_note_relationships(
      p_claim.user_id, member_row.note_id, write_value -> 'noteState'
    );
    ciphers_value := ciphers_value || jsonb_build_array(
      write_value -> 'noteCipher', write_value #> '{revision,cipher}',
      write_value #> '{mutation,cipher}'
    );
  end loop;

  if not receipt_write_required then
    if receipt_value <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
  else
    if not private.jsonb_has_exact_keys(receipt_value, array[
        'recordVersion','cipher','verificationMac'
      ])
      or jsonb_typeof(receipt_value -> 'recordVersion') <> 'number'
      or (receipt_value ->> 'recordVersion')::integer <>
        p_claim.receipt_revision + 1
      or not private.owner_interaction_cipher_matches_binding(
        p_claim.user_id, p_claim.idempotency_key, 'common', 'receipt',
        receipt_value -> 'cipher'
      )
      or not private.valid_encrypted_write_mac(
        receipt_value -> 'verificationMac', p_claim.user_id,
        (receipt_value #>> '{cipher,keyClass}')::public.content_key_class,
        false
      )
    then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;
    ciphers_value := ciphers_value || jsonb_build_array(receipt_value -> 'cipher');
  end if;

  if (p_claim.scope <> 'encrypted_review_resolution'
      and p_selected_outcome = 'needs_review')
    or p_claim.scope = 'encrypted_review_resolution'
  then
    if not private.jsonb_has_exact_keys(review_value, array[
        'reviewItemId','recordVersion','type','cipher','verificationMac'
      ])
      or jsonb_typeof(review_value -> 'reviewItemId') <> 'string'
      or jsonb_typeof(review_value -> 'recordVersion') <> 'number'
      or jsonb_typeof(review_value -> 'type') <> 'string'
      or review_value ->> 'reviewItemId' <> (case
        when p_claim.scope = 'encrypted_review_resolution'
          then p_claim.review_item_id else p_claim.conflict_review_item_id end)
      or (review_value ->> 'recordVersion')::integer <> (case
        when p_claim.scope = 'encrypted_review_resolution'
          then p_claim.review_content_revision + 1 else 1 end)
      or (p_claim.scope <> 'encrypted_review_resolution'
        and review_value ->> 'type' <> 'revision_conflict')
      or (p_claim.scope = 'encrypted_review_resolution' and
        review_value ->> 'type' <> (
          select type::text from public.review_items
          where user_id = p_claim.user_id and id = p_claim.review_item_id
        ))
      or not private.owner_interaction_cipher_matches_binding(
        p_claim.user_id, p_claim.idempotency_key,
        case when p_claim.scope = 'encrypted_review_resolution'
          then 'common' else 'needs_review' end,
        'review', review_value -> 'cipher'
      )
      or not private.valid_encrypted_write_mac(
        review_value -> 'verificationMac', p_claim.user_id,
        (review_value #>> '{cipher,keyClass}')::public.content_key_class,
        false
      )
    then raise exception using errcode = '22023', message = 'invalid_encrypted_field'; end if;
    ciphers_value := ciphers_value || jsonb_build_array(review_value -> 'cipher');
  elsif review_value <> 'null'::jsonb then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  return ciphers_value;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function private.finish_owner_interaction(
  p_claim public.encrypted_owner_interaction_claims,
  p_selected_outcome text,
  p_request_mac jsonb,
  p_response_cipher jsonb,
  p_response_verification_mac jsonb,
  p_encrypted_object_count integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_resource_id_value text;
  response_resource_id_value text;
begin
  request_resource_id_value := case p_claim.scope
    when 'encrypted_decision_correction' then p_claim.decision_id
    when 'encrypted_review_resolution' then p_claim.review_item_id
    else p_claim.anchor_mutation_id end;
  response_resource_id_value := case
    when p_claim.scope = 'encrypted_review_resolution'
      then p_claim.review_item_id
    when p_selected_outcome = 'needs_review'
      then p_claim.conflict_review_item_id
    else p_claim.output_batch_id::text end;
  insert into public.api_idempotency_records (
    user_id,idempotency_key,scope,created_at,completed_at,request_mac,
    request_mac_key_id,request_mac_key_class,request_mac_key_purpose,
    request_mac_key_version,response_envelope,response_key_id,
    response_key_class,response_key_purpose,response_key_version,
    replay_policy,request_resource_type,request_resource_id,
    response_resource_type,response_resource_id,response_record_version
  ) values (
    p_claim.user_id,p_claim.idempotency_key,p_claim.scope,
    p_claim.occurred_at,p_claim.occurred_at,p_request_mac ->> 'mac',
    p_request_mac ->> 'keyId',
    (p_request_mac ->> 'keyClass')::public.content_key_class,
    (p_request_mac ->> 'keyPurpose')::public.content_key_purpose,
    (p_request_mac ->> 'keyVersion')::integer,
    p_response_cipher -> 'envelope',p_response_cipher ->> 'keyId',
    (p_response_cipher ->> 'keyClass')::public.content_key_class,
    (p_response_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (p_response_cipher ->> 'keyVersion')::integer,'logical_mac',
    'owner_interaction',request_resource_id_value,'owner_interaction',
    response_resource_id_value,1
  );
  perform private.record_content_encryption_verification(
    p_claim.user_id, 'idempotency_response',
    'idempotency:' || p_claim.idempotency_key, 1,
    p_response_cipher -> 'envelope', p_response_verification_mac
  );
  update public.encrypted_owner_interaction_claims set
    selected_outcome = p_selected_outcome,
    request_mac = p_request_mac ->> 'mac',
    completed_at = occurred_at
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key
    and completed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  update public.content_encryption_rollouts set
    encrypted_object_count = encrypted_object_count + p_encrypted_object_count,
    verified_object_count = verified_object_count + p_encrypted_object_count
  where user_id = p_claim.user_id;
end;
$$;

create or replace function private.owner_interaction_result(
  p_claim public.encrypted_owner_interaction_claims,
  p_replayed boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  outcome_value text;
  review_id_value text;
  feedback_id_value text;
  batch_id_value uuid;
  members_value jsonb;
  encrypted_response_value jsonb;
  response_verification_value jsonb;
begin
  if p_claim.completed_at is null then
    raise exception using errcode = 'P0001', message = 'write_not_committed';
  end if;
  outcome_value := case
    when p_claim.scope <> 'encrypted_review_resolution'
      then p_claim.selected_outcome
    when p_claim.action = 'dismiss' then 'dismissed'
    else 'resolved' end;
  review_id_value := case
    when p_claim.scope = 'encrypted_review_resolution'
      then p_claim.review_item_id
    when p_claim.selected_outcome = 'needs_review'
      then p_claim.conflict_review_item_id else null end;
  feedback_id_value := case
    when p_claim.scope = 'encrypted_decision_correction'
      and p_claim.selected_outcome = 'applied'
    then p_claim.feedback_event_id else null end;
  batch_id_value := case
    when p_claim.scope <> 'encrypted_review_resolution'
      and p_claim.selected_outcome = 'applied'
    then p_claim.output_batch_id else null end;
  select coalesce(jsonb_agg(jsonb_build_object(
    'role', member.role,
    'noteId', member.note_id,
    'currentRevision', member.expected_revision + 1,
    'revisionId', member.revision_id,
    'mutationId', member.mutation_id
  ) order by member.ordinal), '[]'::jsonb) into members_value
  from public.encrypted_owner_interaction_members as member
  where member.user_id = p_claim.user_id
    and member.idempotency_key = p_claim.idempotency_key
    and (
      p_claim.scope = 'encrypted_review_resolution'
      or p_claim.selected_outcome = 'applied'
    );
  encrypted_response_value := private.owner_interaction_response_cipher(
    p_claim.user_id, p_claim.idempotency_key
  );
  response_verification_value :=
    private.owner_interaction_response_verification_mac(
      p_claim.user_id, p_claim.idempotency_key
    );
  if encrypted_response_value is null or response_verification_value is null then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  return jsonb_build_object(
    'scope', p_claim.scope,
    'outcome', outcome_value,
    'decisionId', case when p_claim.scope = 'encrypted_decision_correction'
      then p_claim.decision_id else null end,
    'reviewItemId', review_id_value,
    'feedbackEventId', feedback_id_value,
    'batchId', batch_id_value,
    'members', members_value,
    'encryptedResponse', encrypted_response_value,
    'responseVerificationMac', response_verification_value,
    'replayed', p_replayed
  );
end;
$$;

create or replace function private.owner_interaction_replay_result(
  p_claim public.encrypted_owner_interaction_claims,
  p_command jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare request_mac_value jsonb;
begin
  if p_claim.completed_at is null then return null; end if;
  if p_claim.scope in (
      'encrypted_decision_correction','encrypted_mutation_batch_undo'
    ) then
    if not private.jsonb_has_exact_keys(
      p_command, array['selectedOutcome','requestMac']
    ) or p_command ->> 'selectedOutcome' <> p_claim.selected_outcome
    then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
  elsif not private.jsonb_has_exact_keys(p_command, array['requestMac']) then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  request_mac_value := p_command -> 'requestMac';
  if not private.valid_encrypted_write_mac(
      request_mac_value, p_claim.user_id, p_claim.history_key_class, true
    )
    or request_mac_value ->> 'mac' <> p_claim.request_mac
    or request_mac_value ->> 'keyId' <> p_claim.request_mac_key_id
    or request_mac_value ->> 'keyClass' <> p_claim.request_mac_key_class::text
    or request_mac_value ->> 'keyPurpose' <>
      p_claim.request_mac_key_purpose::text
    or (request_mac_value ->> 'keyVersion')::integer <>
      p_claim.request_mac_key_version
  then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
  return private.owner_interaction_result(p_claim, true);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
end;
$$;

create or replace function public.commit_encrypted_decision_correction(
  p_owner_id uuid,
  p_decision_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  decision_row public.organization_decisions%rowtype;
  receipt_row public.capture_receipts%rowtype;
  member_row public.encrypted_owner_interaction_members%rowtype;
  write_value jsonb;
  replay_value jsonb;
  ciphers_value jsonb;
  selected_outcome_value text;
  destination_mutation_id text;
  batch_anchor_id text;
  link_note_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_decision_id is null
    or p_decision_id !~ '^dec_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_command) <> 'object'
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then raise exception using errcode = 'P0001', message = 'write_not_prepared'; end if;
  if claim_row.scope <> 'encrypted_decision_correction'
    or claim_row.decision_id <> p_decision_id
  then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
  replay_value := private.owner_interaction_replay_result(claim_row, p_command);
  if replay_value is not null then return replay_value; end if;
  selected_outcome_value := p_command ->> 'selectedOutcome';

  -- Canonical lock order: owner advisories, notes, target mutations,
  -- decision, receipt, claim, then reservation/idempotency rows.
  perform 1 from public.notes as note
  join public.encrypted_owner_interaction_members as member
    on member.user_id = note.user_id and member.note_id = note.id
  where member.user_id = p_owner_id
    and member.idempotency_key = p_idempotency_key
    and member.expected_revision > 0
  order by note.id for update of note;
  perform 1 from public.note_mutations as mutation
  join public.encrypted_owner_interaction_members as member
    on member.user_id = mutation.user_id
    and member.target_mutation_id = mutation.id
  where member.user_id = p_owner_id
    and member.idempotency_key = p_idempotency_key
  order by mutation.id for update of mutation;
  select * into decision_row from public.organization_decisions
  where user_id = p_owner_id and id = p_decision_id for update;
  select * into receipt_row from public.capture_receipts
  where user_id = p_owner_id and capture_id = claim_row.capture_id for update;
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  replay_value := private.owner_interaction_replay_result(claim_row, p_command);
  if replay_value is not null then return replay_value; end if;
  if decision_row.id is null or receipt_row.capture_id is null
    or decision_row.decision_content_revision <>
      claim_row.decision_content_revision
    or private.owner_interaction_envelope_digest(decision_row.decision_envelope)
      is distinct from claim_row.decision_envelope_digest
    or receipt_row.receipt_revision <> claim_row.receipt_revision
    or private.owner_interaction_envelope_digest(receipt_row.receipt_envelope)
      is distinct from claim_row.receipt_envelope_digest
    or (selected_outcome_value = 'applied' and
      private.owner_interaction_capture_projection(
        p_owner_id, claim_row.capture_id
      ) is null)
    or exists (
      select 1 from public.encrypted_owner_interaction_members as member
      left join public.notes as note on note.user_id = member.user_id
        and note.id = member.note_id and member.expected_revision > 0
      left join public.note_mutations as mutation on
        mutation.user_id = member.user_id
        and mutation.id = member.target_mutation_id
      where member.user_id = p_owner_id
        and member.idempotency_key = p_idempotency_key
        and ((member.expected_revision > 0 and (
          note.id is null or note.current_revision <> member.expected_revision
          or private.owner_interaction_envelope_digest(note.content_envelope)
            is distinct from member.expected_note_envelope_digest
        )) or (member.target_mutation_id is not null and (
          mutation.id is null or mutation.undone_at is not null
          or private.owner_interaction_envelope_digest(
            mutation.mutation_envelope
          ) is distinct from member.expected_mutation_envelope_digest
        )))
    )
  then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
  ciphers_value := private.validate_owner_interaction_command(
    claim_row, selected_outcome_value, p_command
  );

  perform private.consume_owner_interaction_reservations(
    claim_row, selected_outcome_value, ciphers_value
  );
  if selected_outcome_value = 'applied' then
    for member_row in
      select * from public.encrypted_owner_interaction_members
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
      order by note_id
    loop
      select item into write_value
      from jsonb_array_elements(p_command -> 'writes') as supplied(item)
      where (item ->> 'ordinal')::integer = member_row.ordinal;
      perform private.apply_owner_interaction_write(
        claim_row, member_row, write_value
      );
    end loop;
    select mutation_id into destination_mutation_id
    from public.encrypted_owner_interaction_members
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
      and role = 'destination_write';
    insert into public.feedback_events (
      id,user_id,decision_id,action,old_destination_note_id,
      new_destination_note_id,reason_code,idempotency_key
    ) values (
      claim_row.feedback_event_id,p_owner_id,p_decision_id,'moved',
      claim_row.source_note_id,claim_row.destination_note_id,
      'user_correction',p_idempotency_key
    );
    insert into public.feedback_event_mutations (
      feedback_event_id,user_id,mutation_id,role
    )
    select claim_row.feedback_event_id,p_owner_id,member.mutation_id,
      member.role::public.feedback_mutation_role
    from public.encrypted_owner_interaction_members as member
    where member.user_id = p_owner_id
      and member.idempotency_key = p_idempotency_key;
    update public.organization_decisions set
      destination_note_id = claim_row.destination_note_id
    where user_id = p_owner_id and id = p_decision_id;
    perform private.emit_user_event(
      p_owner_id, 'organization_decision', p_decision_id
    );
    for link_note_id in
      update public.capture_note_links set relation = 'source_removed'
      where user_id = p_owner_id and capture_id = claim_row.capture_id
        and note_id = claim_row.source_note_id and relation = 'routed'
      returning note_id
    loop
      perform private.emit_user_event(
        p_owner_id, 'capture_note_link', link_note_id
      );
    end loop;
    insert into public.capture_note_links (
      capture_id,note_id,user_id,mutation_id,relation,inserted_item_ids,
      created_at
    ) values (
      claim_row.capture_id,claim_row.destination_note_id,p_owner_id,
      destination_mutation_id,'routed','{}'::text[],claim_row.occurred_at
    );
    perform private.emit_user_event(
      p_owner_id, 'capture_note_link', claim_row.destination_note_id
    );
    perform private.update_owner_interaction_receipt(
      claim_row,p_command -> 'receipt',
      case when claim_row.destination_kind = 'new_note'
        then 'created_note' else 'added_to_note' end,
      claim_row.destination_note_id,destination_mutation_id,null,
      array['user_correction']::text[]
    );
    update public.captures set status = 'organized', last_error_code = null
    where user_id = p_owner_id and id = claim_row.capture_id;
    batch_anchor_id := destination_mutation_id;
    insert into public.encrypted_mutation_batches (
      batch_id,user_id,kind,anchor_mutation_id,created_at
    ) values (
      claim_row.output_batch_id,p_owner_id,'correction',batch_anchor_id,
      claim_row.occurred_at
    );
    insert into public.encrypted_mutation_batch_members (
      user_id,batch_id,ordinal,role,note_id,mutation_id,created_at
    ) select p_owner_id,claim_row.output_batch_id,member.ordinal,member.role,
      member.note_id,member.mutation_id,claim_row.occurred_at
    from public.encrypted_owner_interaction_members as member
    where member.user_id = p_owner_id
      and member.idempotency_key = p_idempotency_key
    order by member.ordinal;
  else
    perform private.write_owner_interaction_review(
      claim_row,p_command -> 'review','open'
    );
    for link_note_id in
      update public.capture_note_links set relation = 'source_removed'
      where user_id = p_owner_id and capture_id = claim_row.capture_id
        and relation = 'routed'
      returning note_id
    loop
      perform private.emit_user_event(
        p_owner_id, 'capture_note_link', link_note_id
      );
    end loop;
    update public.organization_decisions set destination_note_id = null
    where user_id = p_owner_id and id = p_decision_id;
    perform private.emit_user_event(
      p_owner_id, 'organization_decision', p_decision_id
    );
    perform private.update_owner_interaction_receipt(
      claim_row,p_command -> 'receipt','needs_review',null,null,
      claim_row.conflict_review_item_id,
      array['exact_inverse_unavailable']::text[]
    );
    update public.captures set status = 'needs_review',
      last_error_code = 'conflict_requires_review'
    where user_id = p_owner_id and id = claim_row.capture_id;
    perform private.emit_user_event(
      p_owner_id,'review_item',claim_row.conflict_review_item_id
    );
  end if;
  perform private.emit_user_event(
    p_owner_id, 'capture_receipt', claim_row.capture_id
  );
  perform private.emit_user_event(p_owner_id, 'capture', claim_row.capture_id);
  perform private.finish_owner_interaction(
    claim_row,selected_outcome_value,p_command -> 'requestMac',
    p_command -> 'responseCipher',p_command -> 'responseVerificationMac',
    jsonb_array_length(ciphers_value)
  );
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  return private.owner_interaction_result(claim_row,false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.commit_encrypted_review_resolution(
  p_owner_id uuid,
  p_review_item_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  review_row public.review_items%rowtype;
  receipt_row public.capture_receipts%rowtype;
  decision_row public.organization_decisions%rowtype;
  member_row public.encrypted_owner_interaction_members%rowtype;
  write_value jsonb;
  replay_value jsonb;
  ciphers_value jsonb;
  destination_mutation_id text;
  link_note_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_review_item_id is null
    or p_review_item_id !~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_command) <> 'object'
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if not found then raise exception using errcode = 'P0001', message = 'write_not_prepared'; end if;
  if claim_row.scope <> 'encrypted_review_resolution'
    or claim_row.review_item_id <> p_review_item_id
  then raise exception using errcode = 'P0001', message = 'invalid_idempotency_key'; end if;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;

  perform 1 from public.notes as note
  join public.encrypted_owner_interaction_members as member
    on member.user_id = note.user_id and member.note_id = note.id
  where member.user_id = p_owner_id
    and member.idempotency_key = p_idempotency_key
    and member.expected_revision > 0
  order by note.id for update of note;
  if claim_row.action in ('route','create') then
    select * into decision_row from public.organization_decisions
    where user_id = p_owner_id and id = claim_row.decision_id for update;
  end if;
  select * into review_row from public.review_items
  where user_id = p_owner_id and id = p_review_item_id for update;
  if claim_row.capture_id is not null then
    select * into receipt_row from public.capture_receipts
    where user_id = p_owner_id and capture_id = claim_row.capture_id for update;
  end if;
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;
  if review_row.id is null or review_row.state <> 'open'
    or review_row.review_content_revision <> claim_row.review_content_revision
    or private.owner_interaction_envelope_digest(review_row.review_envelope)
      is distinct from claim_row.review_envelope_digest
    or (claim_row.action in ('route','create') and (
      decision_row.id is null
      or decision_row.capture_id is distinct from claim_row.capture_id
      or decision_row.destination_note_id is not null
      or decision_row.decision_content_revision
        <> claim_row.decision_content_revision
      or private.owner_interaction_envelope_digest(
        decision_row.decision_envelope
      ) is distinct from claim_row.decision_envelope_digest
    ))
    or (claim_row.receipt_revision is not null and (
      receipt_row.capture_id is null
      or receipt_row.receipt_revision <> claim_row.receipt_revision
      or private.owner_interaction_envelope_digest(receipt_row.receipt_envelope)
        is distinct from claim_row.receipt_envelope_digest
    ))
    or exists (
      select 1 from public.encrypted_owner_interaction_members as member
      left join public.notes as note on note.user_id = member.user_id
        and note.id = member.note_id and member.expected_revision > 0
      where member.user_id = p_owner_id
        and member.idempotency_key = p_idempotency_key
        and member.expected_revision > 0 and (
          note.id is null or note.current_revision <> member.expected_revision
          or private.owner_interaction_envelope_digest(note.content_envelope)
            is distinct from member.expected_note_envelope_digest
        )
    )
  then raise exception using errcode = 'P0001', message = 'stale_revision'; end if;
  ciphers_value := private.validate_owner_interaction_command(
    claim_row,null,p_command
  );
  perform private.consume_owner_interaction_reservations(
    claim_row,null,ciphers_value
  );
  if claim_row.action in ('route','create') then
    select * into member_row from public.encrypted_owner_interaction_members
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
      and ordinal = 0;
    select item into write_value
    from jsonb_array_elements(p_command -> 'writes') as supplied(item)
    where (item ->> 'ordinal')::integer = 0;
    perform private.apply_owner_interaction_write(
      claim_row,member_row,write_value
    );
    destination_mutation_id := member_row.mutation_id;
    update public.organization_decisions set
      destination_note_id = claim_row.destination_note_id
    where user_id = p_owner_id and id = claim_row.decision_id
      and destination_note_id is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    perform private.emit_user_event(
      p_owner_id, 'organization_decision', claim_row.decision_id
    );
  end if;
  perform private.write_owner_interaction_review(
    claim_row,p_command -> 'review',
    case when claim_row.action = 'dismiss'
      then 'dismissed'::public.review_state
      else 'resolved'::public.review_state end
  );
  insert into public.feedback_events (
    id,user_id,action,old_destination_note_id,new_destination_note_id,
    reason_code,review_item_id,idempotency_key
  ) values (
    claim_row.feedback_event_id,p_owner_id,'review_resolved',
    review_row.note_id,
    case when claim_row.action in ('route','create')
      then claim_row.destination_note_id else null end,
    claim_row.action,p_review_item_id,p_idempotency_key
  );
  if claim_row.capture_id is not null then
    if claim_row.action in ('route','create') then
      for link_note_id in
        update public.capture_note_links set relation = 'source_removed'
        where user_id = p_owner_id and capture_id = claim_row.capture_id
          and relation = 'routed'
        returning note_id
      loop
        perform private.emit_user_event(
          p_owner_id, 'capture_note_link', link_note_id
        );
      end loop;
      insert into public.capture_note_links (
        capture_id,note_id,user_id,mutation_id,relation,inserted_item_ids,
        created_at
      ) values (
        claim_row.capture_id,claim_row.destination_note_id,p_owner_id,
        destination_mutation_id,'routed','{}'::text[],claim_row.occurred_at
      );
      perform private.emit_user_event(
        p_owner_id, 'capture_note_link', claim_row.destination_note_id
      );
      perform private.update_owner_interaction_receipt(
        claim_row,p_command -> 'receipt',
        case when claim_row.action = 'create'
          then 'created_note' else 'added_to_note' end,
        claim_row.destination_note_id,destination_mutation_id,null,
        array['review_resolved']::text[]
      );
      update public.captures set status='organized',last_error_code=null
      where user_id=p_owner_id and id=claim_row.capture_id;
    elsif claim_row.action = 'keep_inbox' then
      perform private.update_owner_interaction_receipt(
        claim_row,p_command -> 'receipt','kept_in_inbox',null,null,
        p_review_item_id,array['review_resolved']::text[]
      );
      update public.captures set status='inbox',last_error_code=null
      where user_id=p_owner_id and id=claim_row.capture_id;
    end if;
    if claim_row.action in ('route','create','keep_inbox') then
      perform private.emit_user_event(
        p_owner_id, 'capture_receipt', claim_row.capture_id
      );
      perform private.emit_user_event(
        p_owner_id, 'capture', claim_row.capture_id
      );
    end if;
  end if;
  perform private.emit_user_event(p_owner_id,'review_item',p_review_item_id);
  perform private.finish_owner_interaction(
    claim_row,null,p_command -> 'requestMac',p_command -> 'responseCipher',
    p_command -> 'responseVerificationMac',jsonb_array_length(ciphers_value)
  );
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id=p_owner_id and idempotency_key=p_idempotency_key;
  return private.owner_interaction_result(claim_row,false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.undo_encrypted_mutation_batch(
  p_owner_id uuid,
  p_mutation_id text,
  p_expected_revision integer,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  receipt_row public.capture_receipts%rowtype;
  member_row public.encrypted_owner_interaction_members%rowtype;
  write_value jsonb;
  replay_value jsonb;
  ciphers_value jsonb;
  selected_outcome_value text;
  output_anchor_id text;
  decision_id_value text;
  link_note_id text;
  source_batch_id_value uuid;
  source_batch_kind_value text := 'organization';
  source_batch_anchor_mutation_id_value text;
  source_member_count integer := 0;
  destination_member_count integer := 0;
  restored_source_target_mutation_id_value text;
  restored_source_note_id_value text;
  former_destination_note_id_value text;
  restored_source_mutation_id_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_mutation_id is null
    or p_mutation_id !~ '^mut_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision is null or p_expected_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_command) <> 'object'
  then raise exception using errcode = '22023', message = 'validation_failed'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id=p_owner_id and idempotency_key=p_idempotency_key;
  if not found then raise exception using errcode='P0001',message='write_not_prepared'; end if;
  if claim_row.scope <> 'encrypted_mutation_batch_undo'
    or claim_row.anchor_mutation_id <> p_mutation_id
    or claim_row.expected_anchor_revision <> p_expected_revision
  then raise exception using errcode='P0001',message='invalid_idempotency_key'; end if;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;
  selected_outcome_value := p_command ->> 'selectedOutcome';

  select batch.batch_id, batch.kind, batch.anchor_mutation_id
  into source_batch_id_value, source_batch_kind_value,
    source_batch_anchor_mutation_id_value
  from public.encrypted_mutation_batch_members as anchor_member
  join public.encrypted_mutation_batches as batch
    on batch.user_id = anchor_member.user_id
    and batch.batch_id = anchor_member.batch_id
  where anchor_member.user_id = p_owner_id
    and anchor_member.mutation_id = p_mutation_id;
  if source_batch_id_value is null then
    source_batch_kind_value := 'organization';
  elsif source_batch_anchor_mutation_id_value <> p_mutation_id
    or source_batch_kind_value = 'undo'
    or source_batch_kind_value not in (
      'correction', 'organization', 'singleton'
    )
  then
    raise exception using errcode = 'P0001',
      message = 'conflict_requires_review';
  elsif source_batch_kind_value = 'correction' then
    select count(*) filter (where member.role = 'source_removal'),
      count(*) filter (where member.role = 'destination_write'),
      min(member.mutation_id) filter (where member.role = 'source_removal'),
      min(member.note_id) filter (where member.role = 'source_removal'),
      min(member.note_id) filter (where member.role = 'destination_write')
    into source_member_count, destination_member_count,
      restored_source_target_mutation_id_value,
      restored_source_note_id_value, former_destination_note_id_value
    from public.encrypted_mutation_batch_members as member
    where member.user_id = p_owner_id
      and member.batch_id = source_batch_id_value;
    if source_member_count <> 1 or destination_member_count <> 1 then
      raise exception using errcode = 'P0001',
        message = 'conflict_requires_review';
    end if;
  else
    source_batch_kind_value := 'organization';
  end if;

  perform 1 from public.notes as note
  join public.encrypted_owner_interaction_members as member
    on member.user_id=note.user_id and member.note_id=note.id
  where member.user_id=p_owner_id
    and member.idempotency_key=p_idempotency_key
  order by note.id for update of note;
  perform 1 from public.note_mutations as mutation
  join public.encrypted_owner_interaction_members as member
    on member.user_id=mutation.user_id
    and member.target_mutation_id=mutation.id
  where member.user_id=p_owner_id
    and member.idempotency_key=p_idempotency_key
  order by mutation.id for update of mutation;
  perform 1 from public.organization_decisions as decision
  join public.note_mutations as mutation
    on mutation.user_id=decision.user_id and mutation.decision_id=decision.id
  join public.encrypted_owner_interaction_members as member
    on member.user_id=mutation.user_id
    and member.target_mutation_id=mutation.id
  where member.user_id=p_owner_id
    and member.idempotency_key=p_idempotency_key
  order by decision.id for update of decision;
  if claim_row.capture_id is not null then
    select * into receipt_row from public.capture_receipts
    where user_id=p_owner_id and capture_id=claim_row.capture_id for update;
  end if;
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id=p_owner_id and idempotency_key=p_idempotency_key for update;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;
  if (claim_row.receipt_revision is not null and (
      receipt_row.capture_id is null
      or receipt_row.receipt_revision <> claim_row.receipt_revision
      or private.owner_interaction_envelope_digest(receipt_row.receipt_envelope)
        is distinct from claim_row.receipt_envelope_digest
    )) or exists (
      select 1 from public.encrypted_owner_interaction_members as member
      left join public.notes as note on note.user_id=member.user_id
        and note.id=member.note_id
      left join public.note_mutations as mutation on
        mutation.user_id=member.user_id
        and mutation.id=member.target_mutation_id
      where member.user_id=p_owner_id
        and member.idempotency_key=p_idempotency_key
        and (note.id is null or note.current_revision<>member.expected_revision
          or private.owner_interaction_envelope_digest(note.content_envelope)
            is distinct from member.expected_note_envelope_digest
          or mutation.id is null or mutation.undone_at is not null
          or private.owner_interaction_envelope_digest(mutation.mutation_envelope)
            is distinct from member.expected_mutation_envelope_digest)
    ) or not exists (
      select 1 from public.encrypted_owner_interaction_members as anchor
      join public.notes as note on note.user_id=anchor.user_id
        and note.id=anchor.note_id
      where anchor.user_id=p_owner_id
        and anchor.idempotency_key=p_idempotency_key
        and anchor.target_mutation_id=p_mutation_id
        and note.current_revision=p_expected_revision
    ) or (source_batch_kind_value = 'correction' and (
      claim_row.capture_id is null
      or receipt_row.capture_id is null
      or receipt_row.decision_id is null
      or receipt_row.destination_note_id is distinct from
        former_destination_note_id_value
      or receipt_row.mutation_id is distinct from p_mutation_id
      or receipt_row.outcome::text not in ('added_to_note', 'created_note')
      or not exists (
        select 1 from public.organization_decisions as decision
        where decision.user_id = p_owner_id
          and decision.id = receipt_row.decision_id
          and decision.capture_id = claim_row.capture_id
          and decision.destination_note_id = former_destination_note_id_value
          and decision.decision_envelope is not null
      )
      or 2 <> (
        select count(*)
        from public.encrypted_owner_interaction_members as member
        where member.user_id = p_owner_id
          and member.idempotency_key = p_idempotency_key
      )
      or not exists (
        select 1
        from public.encrypted_owner_interaction_members as member
        join public.note_mutations as target_mutation
          on target_mutation.user_id = member.user_id
          and target_mutation.id = member.target_mutation_id
        where member.user_id = p_owner_id
          and member.idempotency_key = p_idempotency_key
          and member.target_mutation_id =
            restored_source_target_mutation_id_value
          and member.note_id = restored_source_note_id_value
          and target_mutation.decision_id = receipt_row.decision_id
      )
      or not exists (
        select 1
        from public.encrypted_owner_interaction_members as member
        join public.note_mutations as target_mutation
          on target_mutation.user_id = member.user_id
          and target_mutation.id = member.target_mutation_id
        where member.user_id = p_owner_id
          and member.idempotency_key = p_idempotency_key
          and member.target_mutation_id = p_mutation_id
          and member.note_id = former_destination_note_id_value
          and target_mutation.decision_id = receipt_row.decision_id
      )
      or 1 <> (
        select count(*) from public.capture_note_links as link
        where link.user_id = p_owner_id
          and link.capture_id = claim_row.capture_id
          and link.note_id = restored_source_note_id_value
          and link.relation = 'source_removed'
      )
      or 1 <> (
        select count(*) from public.capture_note_links as link
        where link.user_id = p_owner_id
          and link.capture_id = claim_row.capture_id
          and link.note_id = former_destination_note_id_value
          and link.mutation_id = p_mutation_id
          and link.relation = 'routed'
      )
    ))
  then raise exception using errcode='P0001',message='stale_revision'; end if;
  ciphers_value := private.validate_owner_interaction_command(
    claim_row,selected_outcome_value,p_command
  );
  perform private.consume_owner_interaction_reservations(
    claim_row,selected_outcome_value,ciphers_value
  );
  if selected_outcome_value='applied' then
    for member_row in
      select * from public.encrypted_owner_interaction_members
      where user_id=p_owner_id and idempotency_key=p_idempotency_key
      order by note_id
    loop
      select item into write_value
      from jsonb_array_elements(p_command -> 'writes') as supplied(item)
      where (item ->> 'ordinal')::integer=member_row.ordinal;
      perform private.apply_owner_interaction_write(
        claim_row,member_row,write_value
      );
      if member_row.target_mutation_id=p_mutation_id then
        output_anchor_id := member_row.mutation_id;
      end if;
      if member_row.target_mutation_id =
        restored_source_target_mutation_id_value
      then
        restored_source_mutation_id_value := member_row.mutation_id;
      end if;
    end loop;
    if output_anchor_id is null
      or (source_batch_kind_value = 'correction'
        and restored_source_mutation_id_value is null)
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    insert into public.encrypted_mutation_batches (
      batch_id,user_id,kind,anchor_mutation_id,created_at
    ) values (
      claim_row.output_batch_id,p_owner_id,'undo',output_anchor_id,
      claim_row.occurred_at
    );
    insert into public.encrypted_mutation_batch_members (
      user_id,batch_id,ordinal,role,note_id,mutation_id,created_at
    ) select p_owner_id,claim_row.output_batch_id,member.ordinal,'undo',
      member.note_id,member.mutation_id,claim_row.occurred_at
    from public.encrypted_owner_interaction_members as member
    where member.user_id=p_owner_id
      and member.idempotency_key=p_idempotency_key
    order by member.ordinal;
    if source_batch_kind_value = 'correction' then
      update public.organization_decisions as decision set
        destination_note_id = restored_source_note_id_value
      where decision.user_id = p_owner_id
        and decision.id = receipt_row.decision_id
        and decision.destination_note_id = former_destination_note_id_value
      returning decision.id into decision_id_value;
      if not found then
        raise exception using errcode = 'P0001', message = 'stale_revision';
      end if;
      perform private.emit_user_event(
        p_owner_id, 'organization_decision', decision_id_value
      );
    else
      for decision_id_value in
        update public.organization_decisions as decision set
          destination_note_id = null
        where decision.user_id = p_owner_id
          and decision.destination_note_id is not null
          and exists (
            select 1
            from public.encrypted_owner_interaction_members as member
            join public.note_mutations as target_mutation
              on target_mutation.user_id = member.user_id
              and target_mutation.id = member.target_mutation_id
            where member.user_id = p_owner_id
              and member.idempotency_key = p_idempotency_key
              and target_mutation.decision_id = decision.id
          )
        returning decision.id
      loop
        perform private.emit_user_event(
          p_owner_id, 'organization_decision', decision_id_value
        );
      end loop;
    end if;
    if claim_row.capture_id is not null then
      if source_batch_kind_value = 'correction' then
        update public.capture_note_links set
          mutation_id = restored_source_mutation_id_value,
          relation = 'routed'
        where user_id = p_owner_id
          and capture_id = claim_row.capture_id
          and note_id = restored_source_note_id_value
          and relation = 'source_removed'
        returning note_id into link_note_id;
        if not found then
          raise exception using errcode = 'P0001', message = 'stale_revision';
        end if;
        perform private.emit_user_event(
          p_owner_id, 'capture_note_link', link_note_id
        );
        update public.capture_note_links set relation = 'source_removed'
        where user_id = p_owner_id
          and capture_id = claim_row.capture_id
          and note_id = former_destination_note_id_value
          and mutation_id = p_mutation_id
          and relation = 'routed'
        returning note_id into link_note_id;
        if not found then
          raise exception using errcode = 'P0001', message = 'stale_revision';
        end if;
        perform private.emit_user_event(
          p_owner_id, 'capture_note_link', link_note_id
        );
        perform private.update_owner_interaction_receipt(
          claim_row,p_command -> 'receipt','added_to_note',
          restored_source_note_id_value,restored_source_mutation_id_value,null,
          array['user_undo']::text[]
        );
        update public.captures set status='organized',last_error_code=null
        where user_id=p_owner_id and id=claim_row.capture_id;
      else
        for link_note_id in
          update public.capture_note_links set relation='source_removed'
          where user_id=p_owner_id and capture_id=claim_row.capture_id
            and relation='routed'
          returning note_id
        loop
          perform private.emit_user_event(
            p_owner_id, 'capture_note_link', link_note_id
          );
        end loop;
        perform private.update_owner_interaction_receipt(
          claim_row,p_command -> 'receipt','kept_in_inbox',null,null,null,
          array['user_undo']::text[]
        );
        update public.captures set status='inbox',last_error_code=null
        where user_id=p_owner_id and id=claim_row.capture_id;
      end if;
      perform private.emit_user_event(
        p_owner_id, 'capture_receipt', claim_row.capture_id
      );
      perform private.emit_user_event(
        p_owner_id, 'capture', claim_row.capture_id
      );
    end if;
  else
    perform private.write_owner_interaction_review(
      claim_row,p_command -> 'review','open'
    );
    if claim_row.capture_id is not null then
      -- The failed Undo changed no note or routing provenance. The replacement
      -- receipt is deliberately detached from the historical decision in the
      -- same encrypted-revision write below, so clients expose only
      -- keep-in-Inbox/dismiss rather than an impossible second route/create.
      perform private.update_owner_interaction_receipt(
        claim_row,p_command -> 'receipt','needs_review',null,null,
        claim_row.conflict_review_item_id,
        array['conflict_requires_review']::text[]
      );
      update public.captures set status='needs_review',
        last_error_code='conflict_requires_review'
      where user_id=p_owner_id and id=claim_row.capture_id;
      perform private.emit_user_event(
        p_owner_id, 'capture_receipt', claim_row.capture_id
      );
      perform private.emit_user_event(
        p_owner_id, 'capture', claim_row.capture_id
      );
    end if;
    perform private.emit_user_event(
      p_owner_id,'review_item',claim_row.conflict_review_item_id
    );
  end if;
  perform private.finish_owner_interaction(
    claim_row,selected_outcome_value,p_command -> 'requestMac',
    p_command -> 'responseCipher',p_command -> 'responseVerificationMac',
    jsonb_array_length(ciphers_value)
  );
  select * into claim_row from public.encrypted_owner_interaction_claims
  where user_id=p_owner_id and idempotency_key=p_idempotency_key;
  return private.owner_interaction_result(claim_row,false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode='22023',message='validation_failed';
end;
$$;

-- Organizer receipt ciphertext authenticates the capture occurrence time
-- exposed by the claim projection. Persist that same authoritative timestamp on the
-- relational receipt so a later correction can reseal and exactly re-read the
-- receipt without manufacturing a second creation time.
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
    receipt_key_purpose, receipt_key_version, created_at
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
    (cipher ->> 'keyVersion')::integer,
    (
      select capture.client_created_at
      from public.captures as capture
      where capture.id = p_preparation.capture_id
        and capture.user_id = p_preparation.user_id
    )
  );
  perform private.record_content_encryption_verification(
    p_preparation.user_id, 'capture_receipt', p_preparation.capture_id,
    1, cipher -> 'envelope', verification_mac
  );
end;
$$;

-- A globally contracted installation has already removed the optional
-- plaintext receipt mirrors. Keep this replacement valid on both sides of
-- that irreversible boundary using the same exact contraction anchors.
do $e1_organizer_receipt_contract$
begin
  if private.encrypted_storage_contract_applied() then
    perform private.contract_replace_function(
      'private.insert_encrypted_organizer_receipt(public.encrypted_organizer_preparations,jsonb,text,text,boolean,text)',
      $old$    outcome, headline, destination_note_id, inserted_content, actions,
    reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,$old$,
      $new$    outcome, destination_note_id,
    reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,$new$
    );
    perform private.contract_replace_function(
      'private.insert_encrypted_organizer_receipt(public.encrypted_organizer_preparations,jsonb,text,text,boolean,text)',
      $old$    end,
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
    case$old$,
      $new$    end,
    case when p_review then null else p_note_id end,
    case$new$
    );
  end if;
end;
$e1_organizer_receipt_contract$;

-- Existing organizer receipt ciphertext already authenticates the capture
-- occurrence time. Repair only that relational projection: changing the
-- envelope or revision would manufacture new authenticated content that this
-- migration cannot legitimately reseal. The encrypted-write guard therefore
-- has to be suspended narrowly while the table is access-exclusively locked.
-- Every candidate must first prove a completed organizer lifecycle, its
-- consumed receipt reservation, and a current verification for the unchanged
-- envelope. Any partially attested candidate fails the migration closed.
create or replace function private.repair_encrypted_organizer_receipt_timestamps()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  repaired_count integer := 0;
  unattested_count bigint;
begin
  -- ACL is the primary boundary. As with the irreversible storage-contract
  -- entry point, reject delegated or SET ROLE execution by another login.
  if session_user <> current_user then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- Freeze every attestation input before taking the receipt DDL lock. This
  -- order lets an in-flight organizer finish before the repair, while a new
  -- organizer waits without holding a conflicting receipt lock.
  lock table public.captures, public.organization_jobs,
    public.encrypted_organizer_preparations,
    public.content_key_operation_reservations,
    public.content_encryption_verifications in share mode;
  lock table public.capture_receipts in access exclusive mode;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.capture_receipts'::pg_catalog.regclass
      and trigger.tgname = 'capture_receipts_encrypted_rollout_guard'
      and not trigger.tgisinternal
      and trigger.tgenabled = 'O'
  ) then
    raise exception using errcode = 'P0001',
      message = 'organizer_receipt_timestamp_guard_unavailable';
  end if;

  select count(*) into unattested_count
  from public.capture_receipts as receipt
  join public.organization_jobs as job
    on job.id = receipt.job_id
    and job.user_id = receipt.user_id
    and job.capture_id = receipt.capture_id
  join public.encrypted_organizer_preparations as preparation
    on preparation.job_id = job.id
    and preparation.user_id = job.user_id
    and preparation.capture_id = job.capture_id
  join public.captures as capture
    on capture.id = job.capture_id
    and capture.user_id = job.user_id
  where receipt.created_at is distinct from capture.client_created_at
    and not coalesce((
      capture.deleted_at is null
      and capture.status <> 'deleted'
      and job.state = 'succeeded'
      and job.completed_at is not null
      and job.last_transition_action = 'completed'
      and job.last_transition_lease_token = preparation.lease_token
      and job.last_transition_request_hash = preparation.command_hash
      and preparation.completed_at is not null
      and preparation.command_hash is not null
      and preparation.result is not null
      and preparation.result ->> 'jobId' = job.id
      and preparation.receipt_reservation_id is not null
      and exists (
        select 1
        from public.content_key_operation_reservations as reservation
        where reservation.user_id = preparation.user_id
          and reservation.reservation_id = preparation.receipt_reservation_id
          and reservation.key_id = preparation.object_key_id
          and reservation.key_class = 'ai_assisted'
          and reservation.key_purpose = 'object_wrap'
          and reservation.key_version = preparation.object_key_version
          and reservation.operation_count = 1
          and reservation.consumed_at is not null
          and reservation.consumed_by_type = 'encrypted_organizer'
          and reservation.consumed_by_id = preparation.capture_id
      )
      and receipt.receipt_envelope is not null
      and receipt.receipt_key_class::text = capture.privacy::text
      and private.valid_encrypted_field(
        receipt.receipt_envelope, receipt.user_id, receipt.capture_id,
        receipt.receipt_revision, 'capture_receipt', receipt.receipt_key_id,
        receipt.receipt_key_class, receipt.receipt_key_purpose,
        receipt.receipt_key_version
      )
      and exists (
        select 1
        from public.content_encryption_verifications as verification
        where verification.user_id = receipt.user_id
          and verification.surface = 'capture_receipt'
          and verification.resource_id = receipt.capture_id
          and verification.record_version = receipt.receipt_revision
          and verification.envelope_digest =
            private.owner_interaction_envelope_digest(
              receipt.receipt_envelope
            )
          and verification.verification_mac_key_class =
            receipt.receipt_key_class
          and verification.verification_mac_key_purpose = 'content_mac'
      )
    ), false);
  if unattested_count <> 0 then
    raise exception using errcode = 'P0001',
      message = 'organizer_receipt_timestamp_repair_unattested';
  end if;

  execute 'alter table public.capture_receipts disable trigger '
    || 'capture_receipts_encrypted_rollout_guard';
  begin
    update public.capture_receipts as receipt
    set created_at = capture.client_created_at
    from public.organization_jobs as job
    join public.encrypted_organizer_preparations as preparation
      on preparation.job_id = job.id
      and preparation.user_id = job.user_id
      and preparation.capture_id = job.capture_id
    join public.captures as capture
      on capture.id = job.capture_id
      and capture.user_id = job.user_id
    where receipt.job_id = job.id
      and receipt.user_id = job.user_id
      and receipt.capture_id = job.capture_id
      and receipt.created_at is distinct from capture.client_created_at;
    get diagnostics repaired_count = row_count;
  exception when others then
    execute 'alter table public.capture_receipts enable trigger '
      || 'capture_receipts_encrypted_rollout_guard';
    raise;
  end;
  execute 'alter table public.capture_receipts enable trigger '
    || 'capture_receipts_encrypted_rollout_guard';

  if exists (
    select 1
    from public.capture_receipts as receipt
    join public.organization_jobs as job
      on job.id = receipt.job_id
      and job.user_id = receipt.user_id
      and job.capture_id = receipt.capture_id
    join public.encrypted_organizer_preparations as preparation
      on preparation.job_id = job.id
      and preparation.user_id = job.user_id
      and preparation.capture_id = job.capture_id
    join public.captures as capture
      on capture.id = job.capture_id
      and capture.user_id = job.user_id
    where receipt.created_at is distinct from capture.client_created_at
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.capture_receipts'::pg_catalog.regclass
      and trigger.tgname = 'capture_receipts_encrypted_rollout_guard'
      and not trigger.tgisinternal
      and trigger.tgenabled = 'O'
  ) then
    raise exception using errcode = 'P0001',
      message = 'organizer_receipt_timestamp_repair_incomplete';
  end if;

  return repaired_count;
end;
$$;

revoke execute on function
  private.repair_encrypted_organizer_receipt_timestamps()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

do $e1_organizer_receipt_timestamp_repair$
begin
  perform private.repair_encrypted_organizer_receipt_timestamps();
end;
$e1_organizer_receipt_timestamp_repair$;

revoke execute on function private.insert_encrypted_organizer_receipt(
  public.encrypted_organizer_preparations, jsonb, text, text, boolean, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- Preserve the demo low-confidence Review as an authenticated V2 routing
-- proposal during the existing dual-write backfill. This is deliberately an
-- exact source-anchor rewrite of the two legacy migration functions: both are
-- removed by the encrypted-storage contract before plaintext columns are
-- physically dropped, so no plaintext dependency survives into production.
do $e1_review_backfill$
begin
  -- The legacy single-note undo accepts its target inside the encrypted write
  -- command. Reject a committed E1 batch member immediately after validating
  -- that command identity and before any note/mutation write or reservation
  -- consumption. The public signature and ordinary single-note behavior stay
  -- unchanged; grouped history must use undo_encrypted_mutation_batch.
  perform private.contract_replace_function(
    'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)',
    $old$  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  select * into note_row$old$,
    $new$  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;

  undo_target_id_value := nullif(
    mutation_value ->> 'undoTargetMutationId', ''
  );
  if undo_target_id_value is not null and exists (
    select 1 from public.encrypted_mutation_batch_members as batch_member
    where batch_member.user_id = p_owner_id
      and batch_member.mutation_id = undo_target_id_value
  ) then
    raise exception using errcode = 'P0001',
      message = 'conflict_requires_review';
  end if;

  select * into note_row$new$
  );

  if pg_catalog.to_regprocedure(
    'public.list_content_encryption_backfill_candidates(uuid,text,text,integer)'
  ) is not null then
    perform private.contract_replace_function(
      'public.list_content_encryption_backfill_candidates(uuid,text,text,integer)',
      $old$      jsonb_build_object(
        'schemaVersion', 1,
        'choices', review.choices, 'state', review.state,
        'resolution', review.resolution
      ),$old$,
      $new$      case when review.type = 'low_confidence'
        and review.capture_id is not null
        and review.state = 'open' and review.resolution is null
        and exists (
          select 1 from public.organization_decisions as proposal_decision
          where proposal_decision.user_id = review.user_id
            and proposal_decision.capture_id = review.capture_id
            and jsonb_typeof(proposal_decision.validated_plan) = 'object'
            and proposal_decision.validated_plan ?& array[
              'schemaVersion','captureKind','decision','destination',
              'operations','generatedExpansion','alternatives','reasonCodes'
            ]
        )
      then jsonb_build_object(
        'schemaVersion', 2,
        'proposal', jsonb_build_object(
          'type', 'route_capture',
          'plan', (
            select proposal_decision.validated_plan
            from public.organization_decisions as proposal_decision
            where proposal_decision.user_id = review.user_id
              and proposal_decision.capture_id = review.capture_id
            order by proposal_decision.created_at desc,
              proposal_decision.id desc limit 1
          )
        ),
        'state', review.state, 'resolution', review.resolution
      ) else jsonb_build_object(
        'schemaVersion', 1,
        'choices', review.choices, 'state', review.state,
        'resolution', review.resolution
      ) end,$new$
    );
  end if;
  if pg_catalog.to_regprocedure(
    'public.commit_content_encryption_backfill(uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,text,text,text,boolean)'
  ) is not null then
    perform private.contract_replace_function(
      'public.commit_content_encryption_backfill(uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,text,text,text,boolean)',
      $old$    actual_content := jsonb_build_object(
      'schemaVersion', 1,
      'choices', review_row.choices, 'state', review_row.state,
      'resolution', review_row.resolution
    );$old$,
      $new$    actual_content := case when review_row.type = 'low_confidence'
      and review_row.capture_id is not null
      and review_row.state = 'open' and review_row.resolution is null
      and exists (
        select 1 from public.organization_decisions as proposal_decision
        where proposal_decision.user_id = review_row.user_id
          and proposal_decision.capture_id = review_row.capture_id
          and jsonb_typeof(proposal_decision.validated_plan) = 'object'
          and proposal_decision.validated_plan ?& array[
            'schemaVersion','captureKind','decision','destination',
            'operations','generatedExpansion','alternatives','reasonCodes'
          ]
      )
    then jsonb_build_object(
      'schemaVersion', 2,
      'proposal', jsonb_build_object(
        'type', 'route_capture',
        'plan', (
          select proposal_decision.validated_plan
          from public.organization_decisions as proposal_decision
          where proposal_decision.user_id = review_row.user_id
            and proposal_decision.capture_id = review_row.capture_id
          order by proposal_decision.created_at desc,
            proposal_decision.id desc limit 1
        )
      ),
      'state', review_row.state, 'resolution', review_row.resolution
    ) else jsonb_build_object(
      'schemaVersion', 1,
      'choices', review_row.choices, 'state', review_row.state,
      'resolution', review_row.resolution
    ) end;$new$
    );
  end if;
end;
$e1_review_backfill$;

do $$
declare helper record;
begin
  for helper in
    select procedure.oid::regprocedure as signature
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = any(array[
        'reject_owner_interaction_update',
        'enforce_owner_interaction_claim_transition',
        'enforce_encrypted_idempotency_namespace',
        'cleanup_owner_interaction_claim_reservations',
        'cleanup_owner_interaction_references_before_delete',
        'enforce_owner_interaction_bindings',
        'owner_interaction_envelope_digest',
        'owner_interaction_active_key',
        'reserve_owner_interaction_object',
        'owner_interaction_reservation_projection',
        'owner_interaction_decision_projection',
        'owner_interaction_review_projection',
        'owner_interaction_receipt_projection',
        'owner_interaction_capture_projection',
        'owner_interaction_members_projection',
        'owner_interaction_response_cipher',
        'owner_interaction_response_verification_mac',
        'owner_interaction_source_projection',
        'owner_interaction_prepare_projection',
        'valid_owner_interaction_note_state',
        'owner_interaction_cipher_matches_binding',
        'insert_owner_interaction_note',
        'insert_owner_interaction_revision',
        'insert_owner_interaction_mutation',
        'write_owner_interaction_review',
        'update_owner_interaction_receipt',
        'consume_owner_interaction_reservations',
        'apply_owner_interaction_write',
        'validate_owner_interaction_command',
        'finish_owner_interaction',
        'owner_interaction_result',
        'owner_interaction_replay_result'
      ])
  loop
    execute 'revoke execute on function ' || helper.signature
      || ' from public, anon, authenticated, service_role, '
      || 'unfiled_organizer_worker, unfiled_index_worker, unfiled_rag_verifier';
  end loop;
end;
$$;

revoke execute on function public.prepare_encrypted_decision_correction(
  uuid,text,text,jsonb
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function public.commit_encrypted_decision_correction(
  uuid,text,text,jsonb
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function public.prepare_encrypted_review_resolution(
  uuid,text,text,jsonb
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function public.commit_encrypted_review_resolution(
  uuid,text,text,jsonb
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function public.get_encrypted_mutation_batch(
  uuid,text,integer,text
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function public.undo_encrypted_mutation_batch(
  uuid,text,integer,text,jsonb
) from public,anon,authenticated,unfiled_organizer_worker,
  unfiled_index_worker,unfiled_rag_verifier;

grant execute on function public.prepare_encrypted_decision_correction(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.commit_encrypted_decision_correction(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.prepare_encrypted_review_resolution(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.commit_encrypted_review_resolution(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.get_encrypted_mutation_batch(
  uuid,text,integer,text
) to service_role;
grant execute on function public.undo_encrypted_mutation_batch(
  uuid,text,integer,text,jsonb
) to service_role;
