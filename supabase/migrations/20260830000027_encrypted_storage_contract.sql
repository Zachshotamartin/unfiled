-- Milestone C.5d-7: irreversible encrypted storage contract.
--
-- Applying this migration is expand-compatible: it installs the exact,
-- auditable contract boundary but does not remove the rollback schema by
-- itself.  The destructive phase is an explicit migration-owner operation:
--
--   select private.apply_encrypted_storage_contract(
--     'CONTRACT UNFILED ENCRYPTED STORAGE V1', '<fresh readiness digest>'
--   );
--
-- The apply function is deliberately unavailable to service_role and every
-- runtime identity. It locks signup and all owner rollouts, recomputes the
-- exact readiness digest, rewrites the active encrypted SQL surface, removes
-- the plaintext rollback contract, records one content-free receipt, and
-- commits atomically. A failed check or DDL statement rolls the whole change
-- back. Pre-contract backups remain governed by the published backup window.

create table private.encrypted_storage_contract_receipts (
  contract_version integer primary key check (contract_version = 1),
  readiness_digest text not null check (readiness_digest ~ '^[0-9a-f]{64}$'),
  owner_count bigint not null check (owner_count >= 0),
  encrypted_object_count bigint not null check (encrypted_object_count >= 0),
  applied_at timestamptz not null,
  applied_by name not null,
  confirmation_digest text not null check (
    confirmation_digest ~ '^[0-9a-f]{64}$'
  )
);

revoke all on table private.encrypted_storage_contract_receipts
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.encrypted_storage_contract_applied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.encrypted_storage_contract_receipts
    where contract_version = 1
  );
$$;

revoke execute on function private.encrypted_storage_contract_applied()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.initialize_contracted_rollout(
  p_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  initialized_at timestamptz := statement_timestamp();
  attestation_digest_value text;
begin
  if p_owner_id is null
    or not private.encrypted_storage_contract_applied()
  then
    raise exception using errcode = 'P0001',
      message = 'encrypted_storage_contract_not_applied';
  end if;
  attestation_digest_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.empty-contracted-owner.v1',
    'ownerId', p_owner_id,
    'surfaceRowCount', 0,
    'encryptedObjectCount', 0
  ));
  insert into public.content_encryption_rollouts (
    user_id, state, backfill_completed_at, plaintext_scrub_id,
    plaintext_scrub_version, plaintext_scrub_started_at,
    plaintext_scrub_completed_at, plaintext_scrub_attestation_digest
  ) values (
    p_owner_id, 'contracted', initialized_at, gen_random_uuid(),
    1, initialized_at, initialized_at, attestation_digest_value
  )
  on conflict (user_id) do update set
    state = 'contracted',
    backfill_completed_at = coalesce(
      public.content_encryption_rollouts.backfill_completed_at,
      excluded.backfill_completed_at
    ),
    plaintext_scrub_id = coalesce(
      public.content_encryption_rollouts.plaintext_scrub_id,
      excluded.plaintext_scrub_id
    ),
    plaintext_scrub_version = coalesce(
      public.content_encryption_rollouts.plaintext_scrub_version, 1
    ),
    plaintext_scrub_started_at = coalesce(
      public.content_encryption_rollouts.plaintext_scrub_started_at,
      excluded.plaintext_scrub_started_at
    ),
    plaintext_scrub_completed_at = coalesce(
      public.content_encryption_rollouts.plaintext_scrub_completed_at,
      excluded.plaintext_scrub_completed_at
    ),
    plaintext_scrub_attestation_digest = coalesce(
      public.content_encryption_rollouts.plaintext_scrub_attestation_digest,
      excluded.plaintext_scrub_attestation_digest
    );
end;
$$;

revoke execute on function private.initialize_contracted_rollout(uuid)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- Before contraction signup behaves exactly as before. Afterwards the auth
-- trigger creates the content-free rollout row in contracted mode so a fresh
-- account can never be routed to a removed legacy repository.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80)
  )
  on conflict (id) do nothing;

  if private.encrypted_storage_contract_applied() then
    perform private.initialize_contracted_rollout(new.id);
  end if;
  return new;
end;
$$;

-- Key bootstrap retains the expansion workflow before global contraction and
-- initializes directly into the only valid storage mode afterwards.
do $patch_register_key$
declare
  definition_value text;
  old_value text := E'  insert into public.content_encryption_rollouts (user_id)\n  values (p_owner_id)\n  on conflict (user_id) do nothing;';
  new_value text := E'  if private.encrypted_storage_contract_applied() then\n    perform private.initialize_contracted_rollout(p_owner_id);\n  else\n    insert into public.content_encryption_rollouts (user_id, state)\n    values (p_owner_id, ''expanded'')\n    on conflict (user_id) do nothing;\n  end if;';
begin
  definition_value := pg_catalog.pg_get_functiondef(
    'public.register_user_content_key(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,bytea)'::regprocedure
  );
  if length(definition_value)
      - length(pg_catalog.replace(definition_value, old_value, ''))
      <> length(old_value)
  then
    raise exception 'register_user_content_key contract anchor mismatch';
  end if;
  execute pg_catalog.replace(definition_value, old_value, new_value);
end;
$patch_register_key$;

create or replace function private.encrypted_storage_contract_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  receipt private.encrypted_storage_contract_receipts%rowtype;
  owner_record record;
  owner_rows jsonb := '[]'::jsonb;
  owner_count_value bigint;
  encrypted_object_count_value bigint;
  uncovered_owner_count bigint;
  open_note_claim_count bigint;
  open_taxonomy_claim_count bigint;
  open_retention_count bigint;
  open_preparation_count bigint;
  open_reservation_count bigint;
  readiness_value jsonb;
  ready_value boolean := true;
  digest_value text;
begin
  select * into receipt
  from private.encrypted_storage_contract_receipts
  where contract_version = 1;
  if found then
    return jsonb_build_object(
      'ready', true,
      'applied', true,
      'contractVersion', receipt.contract_version,
      'readinessDigest', receipt.readiness_digest,
      'ownerCount', receipt.owner_count,
      'encryptedObjectCount', receipt.encrypted_object_count,
      'appliedAt', receipt.applied_at
    );
  end if;

  select count(*)::bigint into owner_count_value from auth.users;
  select count(*)::bigint into uncovered_owner_count
  from auth.users as owner
  left join public.profiles as profile on profile.id = owner.id
  left join public.content_encryption_rollouts as rollout
    on rollout.user_id = owner.id
  where profile.id is null
    or rollout.user_id is null
    or rollout.state <> 'encrypted_only';

  for owner_record in
    select owner.id, rollout.plaintext_scrub_attestation_digest
    from auth.users as owner
    join public.profiles as profile on profile.id = owner.id
    join public.content_encryption_rollouts as rollout
      on rollout.user_id = owner.id
    order by owner.id
  loop
    readiness_value := private.content_plaintext_scrub_readiness(
      owner_record.id
    );
    ready_value := coalesce(ready_value, false)
      and coalesce((readiness_value ->> 'ready')::boolean, false)
      and owner_record.plaintext_scrub_attestation_digest is not null
      and owner_record.plaintext_scrub_attestation_digest
        is not distinct from readiness_value ->> 'attestationDigest';
    owner_rows := owner_rows || jsonb_build_array(jsonb_build_object(
      'ownerId', owner_record.id,
      'attestationDigest', readiness_value ->> 'attestationDigest',
      'surfaceRowCount', readiness_value -> 'surfaceRowCount',
      'encryptedObjectCount',
        readiness_value #> '{encryptionReadiness,requiredObjectCount}',
      'exactVerifiedObjectCount',
        readiness_value #> '{encryptionReadiness,exactVerifiedObjectCount}',
      'activeKeySlots',
        readiness_value #> '{encryptionReadiness,activeKeySlots}',
      'ragCoverageSafe', readiness_value -> 'ragCoverageSafe'
    ));
  end loop;

  select coalesce(sum(encrypted_object_count), 0)::bigint
  into encrypted_object_count_value
  from public.content_encryption_rollouts;
  select count(*)::bigint into open_note_claim_count
  from public.encrypted_note_write_claims where completed_at is null;
  select count(*)::bigint into open_taxonomy_claim_count
  from public.encrypted_taxonomy_write_claims where completed_at is null;
  select count(*)::bigint into open_retention_count
  from public.encrypted_note_retention_runs where state = 'active';
  select count(*)::bigint into open_preparation_count
  from public.encrypted_organizer_preparations where completed_at is null;
  select count(*)::bigint into open_reservation_count
  from public.content_key_operation_reservations where consumed_at is null;

  ready_value := coalesce(ready_value, false)
    and uncovered_owner_count = 0
    and open_note_claim_count = 0
    and open_taxonomy_claim_count = 0
    and open_retention_count = 0
    and open_preparation_count = 0
    and open_reservation_count = 0;
  digest_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-storage-contract.v1',
    'ownerCount', owner_count_value,
    'encryptedObjectCount', encrypted_object_count_value,
    'uncoveredOwnerCount', uncovered_owner_count,
    'openNoteClaimCount', open_note_claim_count,
    'openTaxonomyClaimCount', open_taxonomy_claim_count,
    'openRetentionCount', open_retention_count,
    'openPreparationCount', open_preparation_count,
    'openReservationCount', open_reservation_count,
    'owners', owner_rows
  ));

  return jsonb_build_object(
    'ready', ready_value,
    'applied', false,
    'contractVersion', 1,
    'readinessDigest', digest_value,
    'ownerCount', owner_count_value,
    'encryptedObjectCount', encrypted_object_count_value,
    'uncoveredOwnerCount', uncovered_owner_count,
    'openNoteClaimCount', open_note_claim_count,
    'openTaxonomyClaimCount', open_taxonomy_claim_count,
    'openRetentionCount', open_retention_count,
    'openPreparationCount', open_preparation_count,
    'openReservationCount', open_reservation_count,
    'owners', owner_rows
  );
end;
$$;

revoke execute on function private.encrypted_storage_contract_readiness()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function public.get_encrypted_storage_contract_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  readiness_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  readiness_value := private.encrypted_storage_contract_readiness();
  -- The operator-only projection binds the digest to exact owner rows. A
  -- runtime service needs global state/counts, never owner UUIDs or per-owner
  -- attestation values.
  return readiness_value - 'owners';
end;
$$;

revoke execute on function public.get_encrypted_storage_contract_readiness()
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.get_encrypted_storage_contract_readiness()
to service_role;

create or replace function public.get_encrypted_storage_contract_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  receipt private.encrypted_storage_contract_receipts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  select * into receipt
  from private.encrypted_storage_contract_receipts
  where contract_version = 1;
  if not found then
    return jsonb_build_object(
      'schemaVersion', 1,
      'state', 'expand_compatible',
      'appliedAt', null
    );
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'state', 'contracted',
    'appliedAt', receipt.applied_at
  );
end;
$$;

revoke execute on function public.get_encrypted_storage_contract_state()
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.get_encrypted_storage_contract_state()
to service_role;

-- Exact source anchors make the destructive rewrite fail closed if any active
-- function changed after this migration was reviewed. This helper is itself
-- migration-owner-only and disappears with the rollback machinery.
create or replace function private.contract_replace_function(
  p_signature text,
  p_old text,
  p_new text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  procedure_oid regprocedure;
  definition_value text;
begin
  procedure_oid := pg_catalog.to_regprocedure(p_signature);
  if procedure_oid is null or p_old is null or p_old = '' or p_new is null then
    raise exception 'encrypted storage contract function target missing: %',
      p_signature;
  end if;
  definition_value := pg_catalog.pg_get_functiondef(procedure_oid);
  if length(definition_value)
      - length(pg_catalog.replace(definition_value, p_old, ''))
      <> length(p_old)
  then
    raise exception 'encrypted storage contract anchor mismatch: % [%]',
      p_signature, left(p_old, 80);
  end if;
  execute pg_catalog.replace(definition_value, p_old, p_new);
end;
$$;

revoke execute on function private.contract_replace_function(text,text,text)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.contract_replace_function(
  p_signature text,
  p_old text,
  p_new text,
  p_expected_occurrences integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  procedure_oid regprocedure;
  definition_value text;
  occurrence_count integer;
begin
  procedure_oid := pg_catalog.to_regprocedure(p_signature);
  if procedure_oid is null or p_old is null or p_old = '' or p_new is null
    or p_expected_occurrences is null or p_expected_occurrences < 1
  then
    raise exception 'encrypted storage contract function target missing: %',
      p_signature;
  end if;
  definition_value := pg_catalog.pg_get_functiondef(procedure_oid);
  occurrence_count := (
    length(definition_value)
      - length(pg_catalog.replace(definition_value, p_old, ''))
  ) / length(p_old);
  if occurrence_count <> p_expected_occurrences then
    raise exception 'encrypted storage contract anchor mismatch: % [%]',
      p_signature, left(p_old, 80);
  end if;
  execute pg_catalog.replace(definition_value, p_old, p_new);
end;
$$;

revoke execute on function private.contract_replace_function(
  text,text,text,integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.valid_contracted_inserted_item_ids(
  p_item_ids text[]
)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  item_id_value text;
begin
  if cardinality(p_item_ids) > 500 then return false; end if;
  if cardinality(p_item_ids) <> (
    select count(distinct item_id)::integer
    from unnest(p_item_ids) as item(item_id)
  ) then return false; end if;
  foreach item_id_value in array p_item_ids loop
    if item_id_value !~ '^(itm|ent)_[0-9A-HJKMNP-TV-Z]{26}$' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke execute on function private.valid_contracted_inserted_item_ids(text[])
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- Installed ahead of time and attached only by the atomic contract. Its body
-- references exclusively retained operational/encrypted columns, so no stale
-- plaintext field can survive in a trigger plan after physical contraction.
create or replace function private.enforce_contracted_encrypted_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid := new.user_id;
  authoritative_class public.content_key_class;
  content_changed boolean;
begin
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = owner_id_value and state = 'contracted'
  ) then
    raise exception using errcode = 'P0001',
      message = 'invalid_rollout_state';
  end if;

  if tg_table_name = 'spaces' then
    if new.display_envelope is null or new.display_key_id is null
      or new.display_key_class <> 'private_manual'
      or new.display_key_purpose <> 'object_wrap'
      or new.display_key_version is null
      or new.display_mac is null or new.display_mac_key_id is null
      or new.display_mac_key_class <> 'private_manual'
      or new.display_mac_key_purpose <> 'content_mac'
      or new.display_mac_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and (
      new.current_revision <> old.current_revision + 1
      or new.display_envelope is not distinct from old.display_envelope
      or new.display_mac is not distinct from old.display_mac
    ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
    end if;
  elsif tg_table_name = 'tags' then
    if new.display_envelope is null or new.display_key_id is null
      or new.display_key_class <> 'private_manual'
      or new.display_key_purpose <> 'object_wrap'
      or new.display_key_version is null
      or new.display_mac is null or new.display_mac_key_id is null
      or new.display_mac_key_class <> 'private_manual'
      or new.display_mac_key_purpose <> 'content_mac'
      or new.display_mac_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and (
      new.current_revision <> old.current_revision + 1
      or new.display_envelope is not distinct from old.display_envelope
      or new.display_mac is not distinct from old.display_mac
    ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
    end if;
  elsif tg_table_name = 'notes' then
    if new.content_envelope is null or new.content_key_id is null
      or new.content_key_class::text <> new.privacy::text
      or new.content_key_purpose <> 'object_wrap'
      or new.content_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and (
      new.current_revision <> old.current_revision + 1
      or new.content_envelope is not distinct from old.content_envelope
    ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
    end if;
  elsif tg_table_name = 'note_revisions' then
    if new.snapshot_envelope is null or new.snapshot_key_id is null
      or new.snapshot_key_purpose <> 'object_wrap'
      or new.snapshot_key_version is null
      or new.snapshot_mac is null or new.snapshot_mac_key_id is null
      or new.snapshot_mac_key_purpose <> 'content_mac'
      or new.snapshot_mac_key_version is null
      or new.snapshot_key_class <> new.snapshot_mac_key_class
      or (new.privacy = 'private_manual'
        and new.snapshot_key_class <> 'private_manual')
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
  elsif tg_table_name = 'note_mutations' then
    if new.mutation_envelope is null or new.mutation_key_id is null
      or new.mutation_key_purpose <> 'object_wrap'
      or new.mutation_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and row(
      new.mutation_envelope, new.mutation_key_id, new.mutation_key_class,
      new.mutation_key_purpose, new.mutation_key_version,
      new.before_revision, new.after_revision
    ) is distinct from row(
      old.mutation_envelope, old.mutation_key_id, old.mutation_key_class,
      old.mutation_key_purpose, old.mutation_key_version,
      old.before_revision, old.after_revision
    ) then raise exception using errcode = 'P0001', message = 'immutable_encrypted_content';
    end if;
  elsif tg_table_name = 'organization_decisions' then
    if new.decision_envelope is null or new.decision_key_id is null
      or new.decision_key_class <> 'ai_assisted'
      or new.decision_key_purpose <> 'object_wrap'
      or new.decision_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := new.band is distinct from old.band
        or new.decision_envelope is distinct from old.decision_envelope;
      if content_changed and (
        new.decision_content_revision <> old.decision_content_revision + 1
        or new.decision_envelope is not distinct from old.decision_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'generated_blocks' then
    if new.content_envelope is null or new.content_key_id is null
      or new.content_key_class <> 'ai_assisted'
      or new.content_key_purpose <> 'object_wrap'
      or new.content_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' and row(
      new.content_envelope, new.content_key_id, new.content_key_class,
      new.content_key_purpose, new.content_key_version
    ) is distinct from row(
      old.content_envelope, old.content_key_id, old.content_key_class,
      old.content_key_purpose, old.content_key_version
    ) then raise exception using errcode = 'P0001', message = 'immutable_encrypted_content';
    end if;
  elsif tg_table_name = 'review_items' then
    authoritative_class := 'ai_assisted';
    if new.note_id is not null and exists (
      select 1 from public.notes
      where user_id = owner_id_value and id = new.note_id
        and privacy = 'private_manual'
    ) then authoritative_class := 'private_manual';
    elsif new.capture_id is not null and exists (
      select 1 from public.captures
      where user_id = owner_id_value and id = new.capture_id
        and privacy = 'private_manual'
    ) then authoritative_class := 'private_manual';
    end if;
    if new.review_envelope is null or new.review_key_id is null
      or new.review_key_class <> authoritative_class
      or new.review_key_purpose <> 'object_wrap'
      or new.review_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := new.state is distinct from old.state
        or new.review_envelope is distinct from old.review_envelope;
      if content_changed and (
        new.review_content_revision <> old.review_content_revision + 1
        or new.review_envelope is not distinct from old.review_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'routing_rules' then
    if new.condition_envelope is null or new.condition_key_id is null
      or new.condition_key_class <> 'private_manual'
      or new.condition_key_purpose <> 'object_wrap'
      or new.condition_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE'
      and new.condition_envelope is distinct from old.condition_envelope
      and new.condition_revision <> old.condition_revision + 1
    then raise exception using errcode = 'P0001', message = 'stale_content_revision';
    end if;
  elsif tg_table_name = 'organization_mutation_attempts' then
    if new.attempt_envelope is null or new.attempt_key_id is null
      or new.attempt_key_class <> 'ai_assisted'
      or new.attempt_key_purpose <> 'object_wrap'
      or new.attempt_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE'
      and new.attempt_envelope is distinct from old.attempt_envelope
      and new.attempt_content_revision <> old.attempt_content_revision + 1
    then raise exception using errcode = 'P0001', message = 'stale_content_revision';
    end if;
  elsif tg_table_name = 'api_idempotency_records' then
    if new.replay_policy <> 'logical_mac'
      or new.request_mac is null or new.request_mac_key_id is null
      or new.request_mac_key_purpose <> 'content_mac'
      or new.request_mac_key_version is null
      or new.response_envelope is null or new.response_key_id is null
      or new.response_key_purpose <> 'object_wrap'
      or new.response_key_version is null
      or new.request_resource_type is null or new.request_resource_id is null
      or new.response_resource_type is null or new.response_resource_id is null
      or new.response_record_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      raise exception using errcode = 'P0001', message = 'immutable_encrypted_content';
    end if;
  elsif tg_table_name = 'capture_receipts' then
    select privacy::text::public.content_key_class into authoritative_class
    from public.captures
    where user_id = owner_id_value and id = new.capture_id;
    if new.receipt_envelope is null or new.receipt_key_id is null
      or new.receipt_key_class <> authoritative_class
      or new.receipt_key_purpose <> 'object_wrap'
      or new.receipt_key_version is null
    then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if tg_op = 'UPDATE' then
      content_changed := row(
        new.job_id, new.decision_id, new.review_item_id, new.mutation_id,
        new.outcome, new.destination_note_id, new.reason_codes, new.created_at,
        new.receipt_envelope
      ) is distinct from row(
        old.job_id, old.decision_id, old.review_item_id, old.mutation_id,
        old.outcome, old.destination_note_id, old.reason_codes, old.created_at,
        old.receipt_envelope
      );
      if content_changed and (
        new.receipt_revision <> old.receipt_revision + 1
        or new.receipt_envelope is not distinct from old.receipt_envelope
      ) then raise exception using errcode = 'P0001', message = 'stale_content_revision';
      end if;
    end if;
  elsif tg_table_name = 'captures' then
    if new.deleted_at is null and (
      new.status = 'deleted'
      or new.content_envelope is null or new.content_fingerprint is null
      or new.content_key_id is null or new.fingerprint_key_id is null
      or new.content_key_class::text <> new.privacy::text
      or new.fingerprint_key_class::text <> new.privacy::text
      or new.content_key_purpose <> 'object_wrap'
      or new.fingerprint_key_purpose <> 'content_mac'
      or new.content_key_version is null
      or new.fingerprint_key_version is null
    ) then raise exception using errcode = 'P0001', message = 'encrypted_write_required';
    end if;
    if new.deleted_at is not null or new.status = 'deleted' then
      if new.deleted_at is null or new.status <> 'deleted'
        or num_nonnulls(
          new.content_envelope, new.content_fingerprint, new.content_length,
          new.content_key_id, new.content_key_class, new.content_key_purpose,
          new.content_key_version, new.fingerprint_key_id,
          new.fingerprint_key_class, new.fingerprint_key_purpose,
          new.fingerprint_key_version
        ) <> 0
      then
        raise exception using errcode = 'P0001',
          message = 'deleted_capture_not_erased';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function private.enforce_contracted_encrypted_write()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

create or replace function private.apply_encrypted_storage_contract(
  p_confirmation text,
  p_expected_readiness_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmation_constant constant text :=
    'CONTRACT UNFILED ENCRYPTED STORAGE V1';
  readiness_value jsonb;
  receipt private.encrypted_storage_contract_receipts%rowtype;
  owner_id_value uuid;
  owner_ids_before uuid[];
  owner_ids_after uuid[];
  surface_record record;
  procedure_record record;
  applied_at_value timestamptz;
  confirmation_digest_value text;
  postcondition_count bigint;
begin
  -- ACL is the primary boundary. This exact-owner check additionally rejects
  -- SET ROLE and delegated/membership execution by a broader login.
  if session_user <> current_user then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_confirmation is distinct from confirmation_constant
    or p_expected_readiness_digest is null
    or p_expected_readiness_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023',
      message = 'contract_confirmation_required';
  end if;

  -- Admit exactly one first application. Failing a concurrent caller instead
  -- of waiting also remains safe under a transaction snapshot that cannot see
  -- a receipt committed while the outer SELECT was blocked.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'unfiled:encrypted-storage-contract:v1', 0
    ))
  then
    raise exception using errcode = 'P0001',
      message = 'contract_application_in_progress';
  end if;
  select * into receipt
  from private.encrypted_storage_contract_receipts
  where contract_version = 1
  for update;
  if found then
    if receipt.readiness_digest <> p_expected_readiness_digest then
      raise exception using errcode = 'P0001',
        message = 'invalid_contract_replay';
    end if;
    if receipt.confirmation_digest is distinct from private.request_hash(
      jsonb_build_object(
        'domain', 'unfiled.encrypted-storage-contract-confirmation.v1',
        'confirmation', confirmation_constant,
        'readinessDigest', receipt.readiness_digest
      )
    ) then
      raise exception using errcode = 'P0001',
        message = 'invalid_contract_receipt';
    end if;
    return jsonb_build_object(
      'contractVersion', 1,
      'state', 'contracted',
      'readinessDigest', receipt.readiness_digest,
      'ownerCount', receipt.owner_count,
      'encryptedObjectCount', receipt.encrypted_object_count,
      'appliedAt', receipt.applied_at,
      'replayed', true
    );
  end if;

  -- Match the established owner-mutation lock order: global contract advisory,
  -- every canonical owner advisory in UUID order, then auth/profile/rollout
  -- table locks. Account deletion already takes owner advisory before its auth
  -- row lock, so reversing those here would deadlock. A signup that lands
  -- between the snapshots changes the exact set and forces a clean retry.
  select coalesce(array_agg(id order by id), array[]::uuid[])
  into owner_ids_before
  from auth.users;
  foreach owner_id_value in array owner_ids_before loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      owner_id_value::text || ':content-encryption-rollout', 0
    ));
  end loop;
  lock table auth.users in share mode;
  select coalesce(array_agg(id order by id), array[]::uuid[])
  into owner_ids_after
  from auth.users;
  if owner_ids_after is distinct from owner_ids_before then
    raise exception using errcode = 'P0001', message = 'owner_set_changed';
  end if;
  lock table public.profiles in share mode;
  lock table public.content_encryption_rollouts in share row exclusive mode;

  readiness_value := private.encrypted_storage_contract_readiness();
  if (readiness_value ->> 'ready')::boolean is distinct from true then
    raise exception using errcode = 'P0001',
      message = 'encrypted_storage_contract_not_ready';
  end if;
  if readiness_value ->> 'readinessDigest'
      is distinct from p_expected_readiness_digest
  then
    raise exception using errcode = 'P0001',
      message = 'stale_contract_readiness';
  end if;

  -- Every retained encrypted write/verification/worker entry point must
  -- continue after the owner state moves past encrypted_only. These exact
  -- replacements cover the five definitions patched by migration 21; the
  -- organizer claim implementation contains the predicate twice.
  perform private.contract_replace_function(
    'public.prepare_encrypted_note_write(uuid,text,text,text,integer,public.privacy_mode,jsonb)',
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read', 'encrypted_only')$old$,
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$
  );
  perform private.contract_replace_function(
    'public.verify_encrypted_content_object(uuid,text,text,integer,jsonb,jsonb)',
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read', 'encrypted_only')$old$,
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$
  );
  perform private.contract_replace_function(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)',
    $old$state in ('dual_write', 'encrypted_read', 'encrypted_only')$old$,
    $new$state in (
          'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
        )$new$,
    2
  );

  -- Idempotency ledgers retain only a keyed logical request MAC and an
  -- encrypted response. The content-free resource columns remain the replay
  -- projection; the rollback JSON/hash columns disappear below.
  perform private.contract_replace_function(
    'private.finish_encrypted_note_write(public.encrypted_note_write_claims,jsonb,jsonb,integer)',
    $old$    user_id, idempotency_key, scope, request_hash, response_json,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$old$,
    $new$    user_id, idempotency_key, scope,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$new$
  );
  perform private.contract_replace_function(
    'private.finish_encrypted_note_write(public.encrypted_note_write_claims,jsonb,jsonb,integer)',
    $old$    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    request_mac_value ->> 'mac',
    jsonb_build_object(
      'resourceType', 'note_mutation',
      'resourceId', claim_value.mutation_id,
      'noteId', claim_value.note_id,
      'recordVersion', record_version_value
    ),
    claim_value.occurred_at, request_mac_value ->> 'mac',$old$,
    $new$    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    claim_value.occurred_at, request_mac_value ->> 'mac',$new$
  );

  -- Encrypted note create: current state, immutable revision, mutation and
  -- response are represented only by their authenticated envelopes/MACs.
  perform private.contract_replace_function(
    'public.create_encrypted_note(uuid,text,text,jsonb)',
    $old$    id, user_id, space_id, type, title, body_markdown, structured_data,
    current_revision, daily_date, is_open, pinned_at, privacy, archived_at,$old$,
    $new$    id, user_id, space_id, type,
    current_revision, daily_date, is_open, pinned_at, privacy, archived_at,$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_note(uuid,text,text,jsonb)',
    $old$    p_note_id, p_owner_id, nullif(state_value ->> 'spaceId', ''),
    note_type_value, state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', 1,
    nullif(state_value ->> 'dailyDate', '')::date,$old$,
    $new$    p_note_id, p_owner_id, nullif(state_value ->> 'spaceId', ''),
    note_type_value, 1, nullif(state_value ->> 'dailyDate', '')::date,$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_note(uuid,text,text,jsonb)',
    $old$    after_revision, operations, inverse, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, null, p_note_id, p_idempotency_key,
    0, 1, mutation_value -> 'operations', mutation_value -> 'inverse',
    mutation_cipher -> 'envelope',$old$,
    $new$    after_revision, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, null, p_note_id, p_idempotency_key,
    0, 1, mutation_cipher -> 'envelope',$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_note(uuid,text,text,jsonb)',
    $old$    id, note_id, user_id, revision, source, space_id, type, title,
    body_markdown, structured_data, is_open, pinned_at, privacy, archived_at,
    deleted_at, tag_ids, links, content_hash, actor, mutation_id,$old$,
    $new$    id, note_id, user_id, revision, source, space_id, type,
    is_open, pinned_at, privacy, archived_at,
    deleted_at, actor, mutation_id,$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_note(uuid,text,text,jsonb)',
    $old$    nullif(state_value ->> 'spaceId', ''), note_type_value,
    state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    state_value -> 'tagIds', state_value -> 'links',
    revision_mac ->> 'mac', revision_value ->> 'actor', claim_row.mutation_id,$old$,
    $new$    nullif(state_value ->> 'spaceId', ''), note_type_value,
    (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    revision_value ->> 'actor', claim_row.mutation_id,$new$
  );

  -- Encrypted note mutation uses normalized relationship tables for the live
  -- graph and envelope snapshots for history; no duplicate plaintext remains.
  perform private.contract_replace_function(
    'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)',
    $old$    type = note_type_value,
    title = state_value ->> 'title',
    body_markdown = state_value ->> 'bodyMarkdown',
    structured_data = state_value -> 'structuredData',
    current_revision = new_revision,$old$,
    $new$    type = note_type_value,
    current_revision = new_revision,$new$
  );
  perform private.contract_replace_function(
    'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)',
    $old$    after_revision, operations, inverse, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, decision_id_value, p_note_id,
    p_idempotency_key, p_expected_revision, new_revision,
    mutation_value -> 'operations', mutation_value -> 'inverse',
    mutation_cipher -> 'envelope',$old$,
    $new$    after_revision, mutation_envelope, mutation_key_id,
    mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
  ) values (
    claim_row.mutation_id, p_owner_id, decision_id_value, p_note_id,
    p_idempotency_key, p_expected_revision, new_revision,
    mutation_cipher -> 'envelope',$new$
  );
  perform private.contract_replace_function(
    'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)',
    $old$    id, note_id, user_id, revision, source, space_id, type, title,
    body_markdown, structured_data, is_open, pinned_at, privacy, archived_at,
    deleted_at, tag_ids, links, content_hash, actor, mutation_id,$old$,
    $new$    id, note_id, user_id, revision, source, space_id, type,
    is_open, pinned_at, privacy, archived_at,
    deleted_at, actor, mutation_id,$new$
  );
  perform private.contract_replace_function(
    'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)',
    $old$    nullif(state_value ->> 'spaceId', ''), note_type_value,
    state_value ->> 'title', state_value ->> 'bodyMarkdown',
    state_value -> 'structuredData', (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    state_value -> 'tagIds', state_value -> 'links',
    revision_mac ->> 'mac', revision_value ->> 'actor', claim_row.mutation_id,$old$,
    $new$    nullif(state_value ->> 'spaceId', ''), note_type_value,
    (state_value ->> 'isOpen')::boolean,
    nullif(state_value ->> 'pinnedAt', '')::timestamptz, privacy_value,
    nullif(state_value ->> 'archivedAt', '')::timestamptz,
    nullif(state_value ->> 'deletedAt', '')::timestamptz,
    revision_value ->> 'actor', claim_row.mutation_id,$new$
  );

  -- Taxonomy uniqueness survives through owner/epoch-bound keyed MACs.
  perform private.contract_replace_function(
    'private.finish_encrypted_taxonomy_write(public.encrypted_taxonomy_write_claims,jsonb,jsonb,jsonb,integer)',
    $old$    user_id, idempotency_key, scope, request_hash, response_json,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$old$,
    $new$    user_id, idempotency_key, scope,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$new$
  );
  perform private.contract_replace_function(
    'private.finish_encrypted_taxonomy_write(public.encrypted_taxonomy_write_claims,jsonb,jsonb,jsonb,integer)',
    $old$    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    request_mac_value ->> 'mac',
    private.encrypted_only_idempotency_response(
      claim_value.scope, claim_value.resource_id, response_type_value,
      claim_value.resource_id, result_revision_value
    ),
    claim_value.occurred_at, request_mac_value ->> 'mac',$old$,
    $new$    claim_value.user_id, claim_value.idempotency_key, claim_value.scope,
    claim_value.occurred_at, request_mac_value ->> 'mac',$new$
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    $old$        id, user_id, parent_id, name, slug, sort_key, archived_at,
        current_revision, created_at, updated_at,$old$,
    $new$        id, user_id, parent_id, sort_key, archived_at,
        current_revision, created_at, updated_at,$new$
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    $old$        p_resource_id, p_owner_id, parent_id_value,
        'e-' || lower(p_resource_id), 'e-' || lower(p_resource_id),
        sort_key_value, null, 1, claim_row.occurred_at, claim_row.occurred_at,$old$,
    $new$        p_resource_id, p_owner_id, parent_id_value,
        sort_key_value, null, 1, claim_row.occurred_at, claim_row.occurred_at,$new$
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    $old$        id, user_id, name, current_revision, created_at, updated_at,
        display_envelope, display_key_id, display_key_class,$old$,
    $new$        id, user_id, current_revision, created_at, updated_at,
        display_envelope, display_key_id, display_key_class,$new$
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    $old$        p_resource_id, p_owner_id, 'e-' || lower(p_resource_id), 1,
        claim_row.occurred_at, claim_row.occurred_at,$old$,
    $new$        p_resource_id, p_owner_id, 1,
        claim_row.occurred_at, claim_row.occurred_at,$new$
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    $old$      or char_length(p_command ->> 'sortKey') not between 1 and 100
      or btrim(p_command ->> 'sortKey') <> p_command ->> 'sortKey'$old$,
    $new$      or p_command ->> 'sortKey' !~ '^[0-9a-z]{1,32}$'$new$
  );

  perform private.contract_replace_function(
    'private.finish_encrypted_capture_command(uuid,text,text,text,text,text,timestamp with time zone,jsonb,jsonb,jsonb)',
    $old$    user_id, idempotency_key, scope, request_hash, response_json,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$old$,
    $new$    user_id, idempotency_key, scope,
    completed_at, request_mac, request_mac_key_id, request_mac_key_class,$new$
  );
  perform private.contract_replace_function(
    'private.finish_encrypted_capture_command(uuid,text,text,text,text,text,timestamp with time zone,jsonb,jsonb,jsonb)',
    $old$    owner_id, idempotency_key_value, scope_value,
    request_mac_value ->> 'mac',
    jsonb_build_object(
      'resourceType', response_resource_type_value,
      'resourceId', response_resource_id_value,
      'recordVersion', 1
    ),
    occurred_at_value, request_mac_value ->> 'mac',$old$,
    $new$    owner_id, idempotency_key_value, scope_value,
    occurred_at_value, request_mac_value ->> 'mac',$new$
  );

  -- The private-manual encrypted capture implementation remains the first
  -- branch of the production wrapper, but loses its rollback-only columns.
  perform private.contract_replace_function(
    'private.create_encrypted_capture_with_job_legacy(uuid,jsonb)',
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read', 'encrypted_only')$old$,
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$
  );
  perform private.contract_replace_function(
    'private.create_encrypted_capture_with_job_legacy(uuid,jsonb)',
    $old$    id, user_id, source, device_id, raw_text, content_envelope,
    content_fingerprint, content_length, privacy,$old$,
    $new$    id, user_id, source, device_id, content_envelope,
    content_fingerprint, content_length, privacy,$new$
  );
  perform private.contract_replace_function(
    'private.create_encrypted_capture_with_job_legacy(uuid,jsonb)',
    $old$    capture_id_value, p_owner_id, source_value, device_value, '[encrypted]',
    content_cipher -> 'envelope',$old$,
    $new$    capture_id_value, p_owner_id, source_value, device_value,
    content_cipher -> 'envelope',$new$
  );
  perform private.contract_replace_function(
    'private.create_encrypted_capture_with_job_legacy(uuid,jsonb)',
    $old$      capture_id, job_id, user_id, outcome, headline, inserted_content,
      actions, reason_codes, receipt_envelope, receipt_key_id,$old$,
    $new$      capture_id, job_id, user_id, outcome,
      reason_codes, receipt_envelope, receipt_key_id,$new$
  );
  perform private.contract_replace_function(
    'private.create_encrypted_capture_with_job_legacy(uuid,jsonb)',
    $old$      capture_id_value, job_row.id, p_owner_id, 'kept_in_inbox',
      'Kept private in Inbox', '[]'::jsonb, '[]'::jsonb,
      array['private_manual'], receipt_cipher -> 'envelope',$old$,
    $new$      capture_id_value, job_row.id, p_owner_id, 'kept_in_inbox',
      array['private_manual'], receipt_cipher -> 'envelope',$new$
  );

  -- The AI-assisted branch introduced by the isolated organizer has the same
  -- capture-row contraction.
  perform private.contract_replace_function(
    'public.create_encrypted_capture_with_job(uuid,jsonb)',
    $old$where user_id = p_owner_id and state in ('dual_write', 'encrypted_read', 'encrypted_only')$old$,
    $new$where user_id = p_owner_id and state in (
      'dual_write', 'encrypted_read', 'encrypted_only', 'contracted'
    )$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_capture_with_job(uuid,jsonb)',
    $old$    id, user_id, source, device_id, raw_text, content_envelope,
    content_fingerprint, content_length, privacy,$old$,
    $new$    id, user_id, source, device_id, content_envelope,
    content_fingerprint, content_length, privacy,$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_capture_with_job(uuid,jsonb)',
    $old$    capture_id_value, p_owner_id, source_value, device_value, '[encrypted]',
    content_cipher -> 'envelope',$old$,
    $new$    capture_id_value, p_owner_id, source_value, device_value,
    content_cipher -> 'envelope',$new$
  );
  perform private.contract_replace_function(
    'public.create_encrypted_capture_with_job(uuid,jsonb)',
    'return private.create_encrypted_capture_with_job_legacy(',
    'return private.create_encrypted_private_capture_with_job_impl('
  );
  alter function private.create_encrypted_capture_with_job_legacy(uuid,jsonb)
    rename to create_encrypted_private_capture_with_job_impl;

  -- Retention discovers capture dependencies exclusively through normalized
  -- relationships and content-free foreign keys after receipt.actions goes.
  perform private.contract_replace_function(
    'private.note_retention_capture_ids(text)',
    $old$    select receipt_record.capture_id
    from public.capture_receipts as receipt_record
    where receipt_record.destination_note_id = p_note_id
      or exists (
        select 1
        from jsonb_array_elements(receipt_record.actions) as action_record
        where action_record ->> 'noteId' = p_note_id
      )$old$,
    $new$    select receipt_record.capture_id
    from public.capture_receipts as receipt_record
    where receipt_record.destination_note_id = p_note_id$new$
  );

  -- Capture deletion preserves the encrypted tombstone and relationship
  -- cleanup semantics without writing or consulting rollback plaintext.
  perform private.contract_replace_function(
    'public.delete_encrypted_capture(uuid,text,text,jsonb)',
    E'    raw_text = ''[deleted]'',\n',
    ''
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture(uuid,text,text,jsonb)',
    $old$    and (
      (request_resource_type = 'capture'
        and request_resource_id = p_capture_id)
      or response_json #>> '{capture,id}' = p_capture_id
    );$old$,
    $new$    and request_resource_type = 'capture'
    and request_resource_id = p_capture_id;$new$
  );

  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    $old$      type = note_type_value,
      title = write_value #>> '{noteState,title}',
      body_markdown = write_value #>> '{noteState,bodyMarkdown}',
      structured_data = write_value #> '{noteState,structuredData}',
      current_revision = new_revision_value,$old$,
    $new$      type = note_type_value,
      current_revision = new_revision_value,$new$
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    $old$      after_revision, operations, inverse, mutation_envelope, mutation_key_id,
      mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
    ) values (
      mutation_id_value, p_owner_id, null, note_id_value,
      note_mutation_idempotency_value, expected_revision_value,
      new_revision_value, write_value #> '{mutation,operations}',
      write_value #> '{mutation,inverse}',
      write_value #> '{mutation,cipher,envelope}',$old$,
    $new$      after_revision, mutation_envelope, mutation_key_id,
      mutation_key_class, mutation_key_purpose, mutation_key_version, created_at
    ) values (
      mutation_id_value, p_owner_id, null, note_id_value,
      note_mutation_idempotency_value, expected_revision_value,
      new_revision_value, write_value #> '{mutation,cipher,envelope}',$new$
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    $old$      id, note_id, user_id, revision, source, space_id, type, title,
      body_markdown, structured_data, is_open, pinned_at, privacy, archived_at,
      deleted_at, tag_ids, links, content_hash, actor, mutation_id,$old$,
    $new$      id, note_id, user_id, revision, source, space_id, type,
      is_open, pinned_at, privacy, archived_at,
      deleted_at, actor, mutation_id,$new$
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    $old$      source_value, nullif(write_value #>> '{noteState,spaceId}', ''),
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
      write_value #>> '{revision,actor}', mutation_id_value,$old$,
    $new$      source_value, nullif(write_value #>> '{noteState,spaceId}', ''),
      note_type_value, (write_value #>> '{noteState,isOpen}')::boolean,
      nullif(write_value #>> '{noteState,pinnedAt}', '')::timestamptz,
      target_privacy_value,
      nullif(write_value #>> '{noteState,archivedAt}', '')::timestamptz,
      nullif(write_value #>> '{noteState,deletedAt}', '')::timestamptz,
      write_value #>> '{revision,actor}', mutation_id_value,$new$
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    E'    raw_text = ''[deleted]'', status = ''deleted'',\n',
    E'    status = ''deleted'',\n'
  );
  perform private.contract_replace_function(
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    $old$    and (
      (request_resource_type = 'capture'
        and request_resource_id = p_capture_id)
      or response_json #>> '{capture,id}' = p_capture_id
    );$old$,
    $new$    and request_resource_type = 'capture'
    and request_resource_id = p_capture_id;$new$
  );

  -- Organizer decision/review/receipt plaintext mirrors were scrubbed before
  -- this gate. Retained helpers now insert only routing metadata and sealed
  -- content.
  perform private.contract_replace_function(
    'private.insert_encrypted_organizer_decision(public.encrypted_organizer_preparations,jsonb,text,boolean)',
    $old$    id, capture_id, user_id, candidate_manifest, signals, validated_plan,
    band, score, margin, destination_note_id, reason_codes,$old$,
    $new$    id, capture_id, user_id,
    band, score, margin, destination_note_id, reason_codes,$new$
  );
  perform private.contract_replace_function(
    'private.insert_encrypted_organizer_decision(public.encrypted_organizer_preparations,jsonb,text,boolean)',
    $old$    p_preparation.user_id, '{}'::jsonb, '{}'::jsonb, null,
    band_value, null, null, p_destination_note_id, reason_values,$old$,
    $new$    p_preparation.user_id,
    band_value, null, null, p_destination_note_id, reason_values,$new$
  );
  perform private.contract_replace_function(
    'private.insert_encrypted_organizer_review(public.encrypted_organizer_preparations,jsonb,text)',
    $old$    id, user_id, capture_id, note_id, type, choices, state, resolution,
    review_envelope, review_key_id, review_key_class,$old$,
    $new$    id, user_id, capture_id, note_id, type, state,
    review_envelope, review_key_id, review_key_class,$new$
  );
  perform private.contract_replace_function(
    'private.insert_encrypted_organizer_review(public.encrypted_organizer_preparations,jsonb,text)',
    $old$    p_preparation.capture_id, p_note_id, review_type_value,
    '[]'::jsonb, 'open', null,
    cipher -> 'envelope', cipher ->> 'keyId',$old$,
    $new$    p_preparation.capture_id, p_note_id, review_type_value,
    'open', cipher -> 'envelope', cipher ->> 'keyId',$new$
  );
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

  -- Retention locks and deletes idempotency rows by their content-free note
  -- resource coordinates and updates only the encrypted receipt projection.
  perform private.contract_replace_function(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)',
    $old$    and (
      (idempotency.request_resource_type = 'note'
        and idempotency.request_resource_id = claim_row.note_id)
      or idempotency.response_json #>> '{note,id}' = claim_row.note_id
      or idempotency.response_json #>> '{revision,noteId}' = claim_row.note_id
    )$old$,
    $new$    and idempotency.request_resource_type = 'note'
    and idempotency.request_resource_id = claim_row.note_id$new$,
    2
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)',
    $old$      headline = case
        when command_receipt #>> '{projection,mode}' = 'preserve'
          then receipt.headline
        when command_receipt #>> '{projection,mode}' = 'routed'
          then 'Updated note after retention'
        else 'Kept in Inbox after note expired'
      end,
$old$,
    ''
  );
  perform private.contract_replace_function(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)',
    $old$      inserted_content = case
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
$old$,
    ''
  );

  -- Preserve the attestation response contract while proving the plaintext
  -- storage surface has been physically removed.
  perform private.contract_replace_function(
    'public.get_capture_storage_attestation(uuid,text)',
    $old$    'rawTextTombstoned', capture_row.raw_text = '[encrypted]',$old$,
    $new$    'rawTextTombstoned', true,
    'plaintextColumnAbsent', true,$new$
  );

  -- Operational metadata is deliberately bounded to non-content grammars.
  -- These preflight checks run under the table locks held above, so a value
  -- cannot change between validation and the matching constraints.
  if exists (
      select 1 from public.spaces
      where sort_key !~ '^[0-9a-z]{1,32}$'
    ) or exists (
      select 1 from public.captures
      where device_id !~ '^(|[A-Za-z0-9][A-Za-z0-9._:-]{0,119})$'
        or char_length(client_timezone) > 64
        or client_timezone
          !~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,3})$'
    ) or exists (
      select 1 from public.api_idempotency_records
      where idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    ) or exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    ) or exists (
      select 1 from public.note_mutations
      where idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    ) or exists (
      select 1 from public.capture_note_links
      where not private.valid_contracted_inserted_item_ids(inserted_item_ids)
    )
  then
    raise exception using errcode = 'P0001',
      message = 'contract_metadata_not_ready';
  end if;

  -- Authenticated clients no longer receive raw table rows. Encrypted reads
  -- remain service-role SECURITY DEFINER RPCs with owner checks.
  drop policy if exists spaces_select on public.spaces;
  drop policy if exists tags_select on public.tags;
  drop policy if exists notes_select on public.notes;
  drop policy if exists note_revisions_select on public.note_revisions;
  drop policy if exists note_mutations_select on public.note_mutations;
  drop policy if exists generated_blocks_select on public.generated_blocks;
  drop policy if exists organization_decisions_select
    on public.organization_decisions;
  drop policy if exists review_items_select on public.review_items;
  drop policy if exists routing_rules_select on public.routing_rules;
  drop policy if exists organization_mutation_attempts_select_own
    on public.organization_mutation_attempts;
  drop policy if exists captures_select on public.captures;
  drop policy if exists note_chunks_select on public.note_chunks;

  -- Swap all content-surface guards before removing the columns referenced by
  -- the expand-era guard. Advisory prelocks, delete serialization, verification
  -- invalidation, and RAG invalidation triggers remain in place.
  for surface_record in
    select * from (values
      ('spaces', 'spaces_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('tags', 'tags_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('notes', 'notes_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('note_revisions', 'note_revisions_encrypted_rollout_guard', 'INSERT'),
      ('note_mutations', 'note_mutations_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('organization_decisions', 'organization_decisions_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('generated_blocks', 'generated_blocks_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('review_items', 'review_items_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('routing_rules', 'routing_rules_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('organization_mutation_attempts', 'organization_mutation_attempts_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('api_idempotency_records', 'api_idempotency_records_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('capture_receipts', 'capture_receipts_encrypted_rollout_guard', 'INSERT OR UPDATE'),
      ('captures', 'captures_encrypted_rollout_guard', 'INSERT OR UPDATE')
    ) as surface(table_name, trigger_name, trigger_events)
  loop
    execute pg_catalog.format(
      'drop trigger if exists aa_encrypted_only_scrub on public.%I',
      surface_record.table_name
    );
    execute pg_catalog.format(
      'drop trigger if exists %I on public.%I',
      surface_record.trigger_name, surface_record.table_name
    );
    execute pg_catalog.format(
      'create trigger %I before %s on public.%I for each row execute function private.enforce_contracted_encrypted_write()',
      surface_record.trigger_name, surface_record.trigger_events,
      surface_record.table_name
    );
  end loop;
  drop trigger if exists captures_scrub_plaintext on public.captures;
  drop trigger if exists aa_encrypted_only_scrub on public.note_chunks;

  -- Contracted revisions are immutable. The expand-era exception for the
  -- one-time scrub is retired with the scrub worker.
  execute $contract_revision_guard$
    create or replace function private.reject_revision_update()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    begin
      raise exception using errcode = '42501',
        message = 'immutable_note_revision';
    end;
    $body$
  $contract_revision_guard$;

  -- The expand-era timestamp triggers admitted the one exact scrub mutation.
  -- Remove that branch before dropping its helper; these triggers remain on
  -- rollout and note rows and must be executable after physical contraction.
  execute $contract_updated_at$
    create or replace function public.set_updated_at()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    begin
      new.updated_at := now();
      return new;
    end;
    $body$
  $contract_updated_at$;
  execute $contract_note_updated_at$
    create or replace function private.set_note_updated_at()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    begin
      if auth.role() = 'service_role' then
        if new.updated_at is distinct from old.updated_at then return new; end if;
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
        ) then return new; end if;
      end if;
      new.updated_at := now();
      return new;
    end;
    $body$
  $contract_note_updated_at$;

  -- Delete the callable rollback/migration surface before physical DDL. The
  -- loop is exact-name scoped; retained encrypted RPCs have distinct names.
  for procedure_record in
    select procedure.oid
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any(array[
        'create_note', 'apply_user_note_mutation', 'undo_user_mutation',
        'restore_note_revision', 'restore_note', 'create_space',
        'update_space', 'archive_space', 'create_tag', 'update_tag',
        'delete_tag', 'search_notes', 'create_capture_with_job',
        'retry_capture', 'delete_capture', 'purge_expired_deleted_notes',
        'apply_delayed_organization_mutation', 'list_captures',
        'get_capture_detail', 'get_capture_receipt', 'claim_capture_jobs',
        'heartbeat_capture_job', 'complete_capture_job', 'fail_capture_job',
        'recover_stale_capture_jobs', 'legacy_plaintext_reads_allowed',
        'prepare_content_plaintext_scrub', 'scrub_content_plaintext_batch',
        'complete_content_plaintext_scrub',
        'list_content_encryption_backfill_candidates',
        'commit_content_encryption_backfill',
        'complete_content_encryption_backfill', 'reseal_capture_content',
        'advance_content_encryption_rollout'
      ])
  loop
    execute 'drop function ' || procedure_record.oid::regprocedure;
  end loop;
  for procedure_record in
    select procedure.oid
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = any(array[
        'expanded_search_notes', 'expanded_list_captures',
        'expanded_get_capture_detail', 'expanded_get_capture_receipt',
        'apply_user_note_mutation_core',
        'apply_user_note_mutation_core_unchecked',
        'undo_user_mutation_for_owner',
        'apply_delayed_organization_mutation_core', 'note_json',
        'revision_json', 'note_snapshot', 'note_snapshot_with_relations',
        'note_contract_json', 'insert_note_revision',
        'note_revision_snapshot_projection', 'capture_receipt_json',
        'capture_request_fingerprint', 'derive_capture_receipt',
        'claim_idempotency', 'finish_idempotency',
        'content_plaintext_scrub_readiness',
        'valid_plaintext_scrub_transition', 'scrub_capture_plaintext',
        'scrub_legacy_content_on_write', 'enforce_encrypted_rollout_write'
      ])
  loop
    execute 'drop function ' || procedure_record.oid::regprocedure;
  end loop;

  -- Physical contraction uses the default RESTRICT boundary. Expected
  -- plaintext search/index objects are removed explicitly below; any unknown
  -- dependency aborts the transaction instead of disappearing implicitly.
  drop index public.notes_fts;
  drop index public.notes_title_trgm;
  alter table public.spaces drop constraint spaces_user_id_slug_key;
  alter table public.tags drop constraint tags_user_id_name_key;
  drop table public.note_chunks;
  alter table public.spaces
    drop column name,
    drop column slug;
  alter table public.tags drop column name;
  alter table public.notes
    drop column title,
    drop column body_markdown,
    drop column structured_data;
  alter table public.note_revisions
    drop column title,
    drop column body_markdown,
    drop column structured_data,
    drop column tag_ids,
    drop column links,
    drop column content_hash;
  alter table public.note_mutations
    drop column operations,
    drop column inverse;
  alter table public.organization_decisions
    drop column candidate_manifest,
    drop column signals,
    drop column validated_plan;
  alter table public.generated_blocks drop column content;
  alter table public.review_items
    drop column choices,
    drop column resolution;
  alter table public.routing_rules drop column condition_normalized;
  alter table public.organization_mutation_attempts
    drop column operations;
  alter table public.api_idempotency_records
    drop column request_hash,
    drop column response_json;
  alter table public.capture_receipts
    drop column headline,
    drop column inserted_content,
    drop column actions;
  alter table public.captures drop column raw_text;

  -- Required live encrypted surfaces cannot regress to operational-only rows.
  alter table public.spaces
    alter column display_envelope set not null,
    alter column display_key_id set not null,
    alter column display_key_class set not null,
    alter column display_key_purpose set not null,
    alter column display_key_version set not null,
    alter column display_mac set not null,
    alter column display_mac_key_id set not null,
    alter column display_mac_key_class set not null,
    alter column display_mac_key_purpose set not null,
    alter column display_mac_key_version set not null,
    drop constraint spaces_sort_key_check,
    add constraint spaces_contracted_sort_key
      check (sort_key ~ '^[0-9a-z]{1,32}$'),
    add constraint spaces_contracted_key_classes check (
      display_key_class = 'private_manual'
      and display_mac_key_class = 'private_manual'
    );
  alter table public.tags
    alter column display_envelope set not null,
    alter column display_key_id set not null,
    alter column display_key_class set not null,
    alter column display_key_purpose set not null,
    alter column display_key_version set not null,
    alter column display_mac set not null,
    alter column display_mac_key_id set not null,
    alter column display_mac_key_class set not null,
    alter column display_mac_key_purpose set not null,
    alter column display_mac_key_version set not null,
    add constraint tags_contracted_key_classes check (
      display_key_class = 'private_manual'
      and display_mac_key_class = 'private_manual'
    );
  alter table public.notes
    alter column content_envelope set not null,
    alter column content_key_id set not null,
    alter column content_key_class set not null,
    alter column content_key_purpose set not null,
    alter column content_key_version set not null,
    add constraint notes_contracted_key_class
      check (content_key_class::text = privacy::text);
  alter table public.note_revisions
    alter column snapshot_envelope set not null,
    alter column snapshot_key_id set not null,
    alter column snapshot_key_class set not null,
    alter column snapshot_key_purpose set not null,
    alter column snapshot_key_version set not null,
    alter column snapshot_mac set not null,
    alter column snapshot_mac_key_id set not null,
    alter column snapshot_mac_key_class set not null,
    alter column snapshot_mac_key_purpose set not null,
    alter column snapshot_mac_key_version set not null,
    add constraint note_revisions_contracted_key_classes check (
      snapshot_key_class = snapshot_mac_key_class
      and (privacy = 'ai_assisted' or snapshot_key_class = 'private_manual')
    );
  alter table public.note_mutations
    alter column mutation_envelope set not null,
    alter column mutation_key_id set not null,
    alter column mutation_key_class set not null,
    alter column mutation_key_purpose set not null,
    alter column mutation_key_version set not null,
    drop constraint note_mutations_idempotency_key_check,
    add constraint note_mutations_contracted_idempotency_key check (
      idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    );
  alter table public.organization_decisions
    alter column decision_envelope set not null,
    alter column decision_key_id set not null,
    alter column decision_key_class set not null,
    alter column decision_key_purpose set not null,
    alter column decision_key_version set not null,
    add constraint organization_decisions_contracted_key_class
      check (decision_key_class = 'ai_assisted');
  alter table public.generated_blocks
    alter column content_envelope set not null,
    alter column content_key_id set not null,
    alter column content_key_class set not null,
    alter column content_key_purpose set not null,
    alter column content_key_version set not null,
    add constraint generated_blocks_contracted_key_class
      check (content_key_class = 'ai_assisted');
  alter table public.review_items
    alter column review_envelope set not null,
    alter column review_key_id set not null,
    alter column review_key_class set not null,
    alter column review_key_purpose set not null,
    alter column review_key_version set not null;
  alter table public.routing_rules
    alter column condition_envelope set not null,
    alter column condition_key_id set not null,
    alter column condition_key_class set not null,
    alter column condition_key_purpose set not null,
    alter column condition_key_version set not null,
    add constraint routing_rules_contracted_key_class
      check (condition_key_class = 'private_manual');
  alter table public.organization_mutation_attempts
    alter column attempt_envelope set not null,
    alter column attempt_key_id set not null,
    alter column attempt_key_class set not null,
    alter column attempt_key_purpose set not null,
    alter column attempt_key_version set not null,
    add constraint organization_attempts_contracted_key_class
      check (attempt_key_class = 'ai_assisted');
  alter table public.api_idempotency_records
    alter column completed_at set not null,
    alter column request_mac set not null,
    alter column request_mac_key_id set not null,
    alter column request_mac_key_class set not null,
    alter column request_mac_key_purpose set not null,
    alter column request_mac_key_version set not null,
    alter column response_envelope set not null,
    alter column response_key_id set not null,
    alter column response_key_class set not null,
    alter column response_key_purpose set not null,
    alter column response_key_version set not null,
    alter column request_resource_type set not null,
    alter column request_resource_id set not null,
    alter column response_resource_type set not null,
    alter column response_resource_id set not null,
    alter column response_record_version set not null,
    alter column replay_policy set default 'logical_mac',
    drop constraint api_idempotency_records_idempotency_key_check,
    add constraint api_idempotency_contracted_key check (
      idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    ),
    add constraint api_idempotency_contracted_key_classes check (
      request_mac_key_class = response_key_class
      and replay_policy = 'logical_mac'
    );
  alter table public.capture_receipts
    alter column receipt_envelope set not null,
    alter column receipt_key_id set not null,
    alter column receipt_key_class set not null,
    alter column receipt_key_purpose set not null,
    alter column receipt_key_version set not null,
    add constraint capture_receipts_contracted_routing check (
      (outcome in ('created_note', 'added_to_note')
        and destination_note_id is not null
        and decision_id is not null and mutation_id is not null)
      or (outcome not in ('created_note', 'added_to_note')
        and destination_note_id is null and mutation_id is null)
    );
  alter table public.captures
    add constraint captures_contracted_encrypted_content check (
      (
        deleted_at is null and status <> 'deleted'
        and private.valid_encrypted_field(
          content_envelope, user_id, id, 1, 'capture', content_key_id,
          content_key_class, content_key_purpose, content_key_version
        )
        and content_key_class::text = privacy::text
        and content_length between 1 and 10000
        and private.valid_keyed_mac_field(
          content_fingerprint, fingerprint_key_id, fingerprint_key_class,
          fingerprint_key_purpose, fingerprint_key_version
        )
        and fingerprint_key_class::text = privacy::text
      ) or (
        deleted_at is not null and status = 'deleted'
        and num_nonnulls(
          content_envelope, content_fingerprint, content_length,
          content_key_id, content_key_class, content_key_purpose,
          content_key_version, fingerprint_key_id, fingerprint_key_class,
          fingerprint_key_purpose, fingerprint_key_version
        ) = 0
      )
    );
  alter table public.capture_note_links
    add constraint capture_note_links_contracted_item_ids check (
      private.valid_contracted_inserted_item_ids(inserted_item_ids)
    );
  alter table public.encrypted_note_write_claims
    add constraint encrypted_note_claims_contracted_idempotency_key check (
      idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    );
  alter table public.encrypted_taxonomy_write_claims
    add constraint encrypted_taxonomy_claims_contracted_idempotency_key check (
      idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    );

  -- Every owner crossed the exact readiness gate while its canonical advisory
  -- lock was held. Make contracted the only representable global state before
  -- publishing the receipt that changes fresh-account bootstrap behavior.
  update public.content_encryption_rollouts
  set state = 'contracted',
      backfill_cursor = null,
      plaintext_scrub_cursor = null;
  if not found and cardinality(owner_ids_before) <> 0 then
    raise exception using errcode = 'P0001',
      message = 'contract_rollout_state_flip_failed';
  end if;
  alter table public.content_encryption_rollouts
    alter column state set default 'contracted',
    add constraint content_encryption_rollouts_contracted_state check (
      state = 'contracted'
      and backfill_completed_at is not null
      and plaintext_scrub_id is not null
      and plaintext_scrub_version = 1
      and plaintext_scrub_started_at is not null
      and plaintext_scrub_completed_at is not null
      and plaintext_scrub_attestation_digest ~ '^[0-9a-f]{64}$'
      and verified_object_count = encrypted_object_count
    );

  -- Remove direct runtime table capabilities as well as the select policies
  -- dropped above. All retained access is through exact SECURITY DEFINER RPCs.
  revoke all privileges on table
    public.spaces, public.tags, public.notes, public.note_revisions,
    public.note_mutations, public.organization_decisions,
    public.generated_blocks, public.review_items, public.routing_rules,
    public.organization_mutation_attempts, public.api_idempotency_records,
    public.capture_receipts, public.captures, public.capture_note_links
  from public, anon, authenticated, service_role, unfiled_index_worker,
    unfiled_rag_verifier, unfiled_organizer_worker;

  applied_at_value := statement_timestamp();
  confirmation_digest_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-storage-contract-confirmation.v1',
    'confirmation', confirmation_constant,
    'readinessDigest', p_expected_readiness_digest
  ));
  insert into private.encrypted_storage_contract_receipts (
    contract_version, readiness_digest, owner_count,
    encrypted_object_count, applied_at, applied_by, confirmation_digest
  ) values (
    1, p_expected_readiness_digest,
    (readiness_value ->> 'ownerCount')::bigint,
    (readiness_value ->> 'encryptedObjectCount')::bigint,
    applied_at_value, session_user, confirmation_digest_value
  ) returning * into receipt;

  -- The expand-era readiness implementation intentionally called the scrub
  -- scanner. Replace it in the same transaction with the immutable receipt
  -- projection so no post-contract execution plan can reach removed code.
  execute $contract_readiness$
    create or replace function private.encrypted_storage_contract_readiness()
    returns jsonb
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $body$
    declare
      receipt_row private.encrypted_storage_contract_receipts%rowtype;
    begin
      select * into receipt_row
      from private.encrypted_storage_contract_receipts
      where contract_version = 1;
      if not found then
        raise exception using errcode = 'P0001',
          message = 'encrypted_storage_contract_receipt_missing';
      end if;
      return jsonb_build_object(
        'ready', true,
        'applied', true,
        'contractVersion', receipt_row.contract_version,
        'readinessDigest', receipt_row.readiness_digest,
        'ownerCount', receipt_row.owner_count,
        'encryptedObjectCount', receipt_row.encrypted_object_count,
        'appliedAt', receipt_row.applied_at
      );
    end;
    $body$
  $contract_readiness$;

  -- A missing rollout can no longer mean "use legacy": the legacy repository
  -- has been physically removed. Preserve the exact parser-compatible shape
  -- for valid owners and fail closed for every absent or regressed row.
  execute $contract_rollout_projection$
    create or replace function public.get_content_encryption_rollout(
      p_owner_id uuid
    )
    returns jsonb
    language plpgsql
    stable
    security definer
    set search_path = ''
    as $body$
    declare
      rollout_row public.content_encryption_rollouts%rowtype;
    begin
      if auth.role() is distinct from 'service_role' then
        raise exception using errcode = '42501', message = 'forbidden';
      end if;
      if p_owner_id is null then
        raise exception using errcode = '22023', message = 'validation_failed';
      end if;
      select * into rollout_row
      from public.content_encryption_rollouts
      where user_id = p_owner_id;
      if not found then
        raise exception using errcode = 'P0001', message = 'not_found';
      end if;
      if rollout_row.state <> 'contracted' then
        raise exception using errcode = 'P0001',
          message = 'invalid_rollout_state';
      end if;
      return jsonb_build_object(
        'found', true,
        'state', 'contracted',
        'writeMode', 'encrypted',
        'readMode', 'encrypted',
        'backfill', jsonb_build_object(
          'cursor', rollout_row.backfill_cursor,
          'complete', rollout_row.backfill_completed_at is not null,
          'encryptedObjectCount', rollout_row.encrypted_object_count,
          'verifiedObjectCount', rollout_row.verified_object_count
        ),
        'plaintextScrub', jsonb_build_object(
          'scrubId', rollout_row.plaintext_scrub_id,
          'version', rollout_row.plaintext_scrub_version,
          'startedAt', rollout_row.plaintext_scrub_started_at,
          'cursor', rollout_row.plaintext_scrub_cursor,
          'completedAt', rollout_row.plaintext_scrub_completed_at,
          'scrubbedRowCount', rollout_row.plaintext_scrubbed_row_count,
          'deletedChunkCount', rollout_row.plaintext_scrubbed_chunk_count,
          'deletedIdempotencyCount',
            rollout_row.plaintext_scrubbed_idempotency_count,
          'attestationDigest', rollout_row.plaintext_scrub_attestation_digest,
          'lastRequestDigest', rollout_row.last_plaintext_scrub_request_digest,
          'lastResultDigest', rollout_row.last_plaintext_scrub_result_digest
        ),
        'readiness', private.content_encryption_readiness(p_owner_id)
      );
    end;
    $body$
  $contract_rollout_projection$;
  revoke execute on function public.get_content_encryption_rollout(uuid)
  from public, anon, authenticated, unfiled_index_worker,
    unfiled_rag_verifier, unfiled_organizer_worker;
  grant execute on function public.get_content_encryption_rollout(uuid)
  to service_role;

  -- Prove physical absence, exact owner coverage, trigger replacement, and
  -- runtime denial before making the operator function replay-only.
  if pg_catalog.to_regclass('public.note_chunks') is not null or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and (table_name, column_name) in (
        ('spaces', 'name'), ('spaces', 'slug'), ('tags', 'name'),
        ('notes', 'title'), ('notes', 'body_markdown'),
        ('notes', 'structured_data'), ('note_revisions', 'title'),
        ('note_revisions', 'body_markdown'),
        ('note_revisions', 'structured_data'),
        ('note_revisions', 'tag_ids'), ('note_revisions', 'links'),
        ('note_revisions', 'content_hash'),
        ('note_mutations', 'operations'), ('note_mutations', 'inverse'),
        ('organization_decisions', 'candidate_manifest'),
        ('organization_decisions', 'signals'),
        ('organization_decisions', 'validated_plan'),
        ('generated_blocks', 'content'), ('review_items', 'choices'),
        ('review_items', 'resolution'),
        ('routing_rules', 'condition_normalized'),
        ('organization_mutation_attempts', 'operations'),
        ('api_idempotency_records', 'request_hash'),
        ('api_idempotency_records', 'response_json'),
        ('capture_receipts', 'headline'),
        ('capture_receipts', 'inserted_content'),
        ('capture_receipts', 'actions'), ('captures', 'raw_text')
      )
  ) then
    raise exception using errcode = 'P0001',
      message = 'contract_plaintext_catalog_survived';
  end if;

  select count(*)::bigint into postcondition_count
  from auth.users as owner
  join public.profiles as profile on profile.id = owner.id
  join public.content_encryption_rollouts as rollout
    on rollout.user_id = owner.id
  where rollout.state = 'contracted';
  if postcondition_count <> receipt.owner_count
    or (select count(*)::bigint from auth.users) <> receipt.owner_count
    or (select count(*)::bigint from public.profiles) <> receipt.owner_count
    or (select count(*)::bigint from public.content_encryption_rollouts)
      <> receipt.owner_count
  then
    raise exception using errcode = 'P0001',
      message = 'contract_owner_coverage_failed';
  end if;

  select count(*)::bigint into postcondition_count
  from pg_catalog.pg_trigger as trigger_record
  join pg_catalog.pg_class as relation
    on relation.oid = trigger_record.tgrelid
  join pg_catalog.pg_namespace as namespace
    on namespace.oid = relation.relnamespace
  join pg_catalog.pg_proc as procedure
    on procedure.oid = trigger_record.tgfoid
  join pg_catalog.pg_namespace as procedure_namespace
    on procedure_namespace.oid = procedure.pronamespace
  where not trigger_record.tgisinternal
    and namespace.nspname = 'public'
    and relation.relname = any(array[
      'spaces', 'tags', 'notes', 'note_revisions', 'note_mutations',
      'organization_decisions', 'generated_blocks', 'review_items',
      'routing_rules', 'organization_mutation_attempts',
      'api_idempotency_records', 'capture_receipts', 'captures'
    ])
    and procedure_namespace.nspname = 'private'
    and procedure.proname = 'enforce_contracted_encrypted_write';
  if postcondition_count <> 13 then
    raise exception using errcode = 'P0001',
      message = 'contract_trigger_swap_failed';
  end if;

  if pg_catalog.has_function_privilege(
      'service_role',
      'private.apply_encrypted_storage_contract(text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
      'authenticated',
      'private.apply_encrypted_storage_contract(text,text)', 'EXECUTE'
    ) or exists (
      select 1
      from unnest(array[
        'anon', 'authenticated', 'service_role', 'unfiled_index_worker',
        'unfiled_rag_verifier', 'unfiled_organizer_worker'
      ]) as runtime_role(role_name)
      cross join unnest(array[
        'spaces', 'tags', 'notes', 'note_revisions', 'note_mutations',
        'organization_decisions', 'generated_blocks', 'review_items',
        'routing_rules', 'organization_mutation_attempts',
        'api_idempotency_records', 'capture_receipts', 'captures',
        'capture_note_links'
      ]) as runtime_table(table_name)
      cross join unnest(array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
        'REFERENCES', 'TRIGGER'
      ]) as runtime_privilege(privilege_name)
      where pg_catalog.has_table_privilege(
        runtime_role.role_name,
        pg_catalog.format('public.%I', runtime_table.table_name),
        runtime_privilege.privilege_name
      )
    )
  then
    raise exception using errcode = 'P0001',
      message = 'contract_runtime_acl_failed';
  end if;

  -- A successful contraction can never execute the destructive body again.
  -- Replacing the currently-running function is supported by PostgreSQL: this
  -- invocation finishes on its compiled body and every later call sees this
  -- digest-bound replay implementation.
  execute $contract_apply_replay$
    create or replace function private.apply_encrypted_storage_contract(
      p_confirmation text,
      p_expected_readiness_digest text
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    declare
      confirmation_constant constant text :=
        'CONTRACT UNFILED ENCRYPTED STORAGE V1';
      receipt_row private.encrypted_storage_contract_receipts%rowtype;
    begin
      if session_user <> current_user then
        raise exception using errcode = '42501', message = 'forbidden';
      end if;
      if p_confirmation is distinct from confirmation_constant
        or p_expected_readiness_digest is null
        or p_expected_readiness_digest !~ '^[0-9a-f]{64}$'
      then
        raise exception using errcode = '22023',
          message = 'contract_confirmation_required';
      end if;
      select * into receipt_row
      from private.encrypted_storage_contract_receipts
      where contract_version = 1
      for update;
      if not found then
        raise exception using errcode = 'P0001',
          message = 'encrypted_storage_contract_receipt_missing';
      end if;
      if receipt_row.readiness_digest <> p_expected_readiness_digest then
        raise exception using errcode = 'P0001',
          message = 'invalid_contract_replay';
      end if;
      if receipt_row.confirmation_digest is distinct from private.request_hash(
        jsonb_build_object(
          'domain', 'unfiled.encrypted-storage-contract-confirmation.v1',
          'confirmation', confirmation_constant,
          'readinessDigest', receipt_row.readiness_digest
        )
      ) then
        raise exception using errcode = 'P0001',
          message = 'invalid_contract_receipt';
      end if;
      return jsonb_build_object(
        'contractVersion', 1,
        'state', 'contracted',
        'readinessDigest', receipt_row.readiness_digest,
        'ownerCount', receipt_row.owner_count,
        'encryptedObjectCount', receipt_row.encrypted_object_count,
        'appliedAt', receipt_row.applied_at,
        'replayed', true
      );
    end;
    $body$
  $contract_apply_replay$;

  drop function private.contract_replace_function(text,text,text);
  drop function private.contract_replace_function(text,text,text,integer);

  return jsonb_build_object(
    'contractVersion', 1,
    'state', 'contracted',
    'readinessDigest', receipt.readiness_digest,
    'ownerCount', receipt.owner_count,
    'encryptedObjectCount', receipt.encrypted_object_count,
    'appliedAt', receipt.applied_at,
    'replayed', false
  );
end;
$$;

revoke execute on function private.apply_encrypted_storage_contract(text,text)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
