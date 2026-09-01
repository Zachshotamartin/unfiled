-- Milestone C.5d-1: reversible encrypted-only code boundary.
--
-- The legacy columns and RPCs intentionally remain present for the rollback
-- window.  An owner can enter encrypted_only only after every legacy content
-- projection has been replaced by a deterministic, content-free value (or,
-- for derived chunks and non-replayable legacy receipts, deleted), and a
-- fresh exact rescan proves that result while holding the canonical owner
-- rollout advisory lock.

alter table public.content_encryption_rollouts
  add column plaintext_scrub_id uuid,
  add column plaintext_scrub_version integer,
  add column plaintext_scrub_started_at timestamptz,
  add column plaintext_scrub_cursor text,
  add column plaintext_scrub_completed_at timestamptz,
  add column plaintext_scrubbed_row_count bigint not null default 0,
  add column plaintext_scrubbed_chunk_count bigint not null default 0,
  add column plaintext_scrubbed_idempotency_count bigint not null default 0,
  add column plaintext_scrub_attestation_digest text,
  add column last_plaintext_scrub_expected_cursor text,
  add column last_plaintext_scrub_limit integer,
  add column last_plaintext_scrub_request_digest text,
  add column last_plaintext_scrub_result_digest text,
  add column last_plaintext_scrub_result jsonb,
  add constraint content_encryption_rollouts_plaintext_scrub_shape check (
    (
      plaintext_scrub_id is null
      and plaintext_scrub_version is null
      and plaintext_scrub_started_at is null
      and plaintext_scrub_cursor is null
      and plaintext_scrub_completed_at is null
      and plaintext_scrub_attestation_digest is null
      and last_plaintext_scrub_expected_cursor is null
      and last_plaintext_scrub_limit is null
      and last_plaintext_scrub_request_digest is null
      and last_plaintext_scrub_result_digest is null
      and last_plaintext_scrub_result is null
      and plaintext_scrubbed_row_count = 0
      and plaintext_scrubbed_chunk_count = 0
      and plaintext_scrubbed_idempotency_count = 0
    )
    or (
      plaintext_scrub_id is not null
      and plaintext_scrub_version = 1
      and plaintext_scrub_started_at is not null
      and plaintext_scrubbed_row_count >= 0
      and plaintext_scrubbed_chunk_count >= 0
      and plaintext_scrubbed_idempotency_count >= 0
      and (
        plaintext_scrub_completed_at is null
        or plaintext_scrub_attestation_digest ~ '^[0-9a-f]{64}$'
      )
      and (
        last_plaintext_scrub_request_digest is null
        or (
          last_plaintext_scrub_limit between 1 and 250
          and last_plaintext_scrub_request_digest ~ '^[0-9a-f]{64}$'
          and last_plaintext_scrub_result_digest ~ '^[0-9a-f]{64}$'
          and jsonb_typeof(last_plaintext_scrub_result) = 'object'
        )
      )
    )
  );

create or replace function private.encrypted_only_note_sentinel(
  p_note_type public.note_type
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_note_type
    when 'list' then jsonb_build_object(
      'schemaVersion', 1, 'items', jsonb_build_array()
    )
    when 'log' then jsonb_build_object(
      'schemaVersion', 1, 'entries', jsonb_build_array()
    )
    when 'project' then jsonb_build_object(
      'schemaVersion', 1, 'checklistItems', jsonb_build_array()
    )
    else jsonb_build_object('schemaVersion', 1)
  end;
$$;

create or replace function private.encrypted_only_idempotency_response(
  p_scope text,
  p_request_resource_id text,
  p_response_resource_type text,
  p_response_resource_id text,
  p_response_record_version integer
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_scope in (
      'create_encrypted_note', 'apply_encrypted_note_mutation'
    ) then jsonb_build_object(
      'resourceType', 'note_mutation',
      'resourceId', p_response_resource_id,
      'noteId', p_request_resource_id,
      'recordVersion', p_response_record_version
    )
    else jsonb_build_object(
      'resourceType', p_response_resource_type,
      'resourceId', p_response_resource_id,
      'recordVersion', p_response_record_version
    )
  end;
$$;

-- This predicate is deliberately exact.  It is the only exception to the
-- encrypted-content immutability guards, and can succeed only after the owner
-- has entered the scrub protocol and only when all non-legacy columns remain
-- byte-for-byte unchanged.
create or replace function private.valid_plaintext_scrub_transition(
  p_table_name text,
  p_old jsonb,
  p_new jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid;
begin
  if p_old is null or p_new is null or p_table_name is null then
    return false;
  end if;
  begin
    owner_id_value := (p_new ->> 'user_id')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if owner_id_value is null
    or p_old ->> 'user_id' is distinct from p_new ->> 'user_id'
    or not exists (
      select 1
      from public.content_encryption_rollouts as rollout
      where rollout.user_id = owner_id_value
        and rollout.plaintext_scrub_id is not null
    )
  then
    return false;
  end if;

  if p_table_name = 'spaces' then
    return p_new - array['name', 'slug'] = p_old - array['name', 'slug']
      and p_new ->> 'name' = 'e-' || lower(p_new ->> 'id')
      and p_new ->> 'slug' = 'e-' || lower(p_new ->> 'id');
  elsif p_table_name = 'tags' then
    return p_new - 'name' = p_old - 'name'
      and p_new ->> 'name' = 'e-' || lower(p_new ->> 'id');
  elsif p_table_name = 'notes' then
    return p_new - array['title', 'body_markdown', 'structured_data']
        = p_old - array['title', 'body_markdown', 'structured_data']
      and p_new ->> 'title' = 'e-' || lower(p_new ->> 'id')
      and p_new ->> 'body_markdown' = ''
      and p_new -> 'structured_data' = private.encrypted_only_note_sentinel(
        (p_new ->> 'type')::public.note_type
      );
  elsif p_table_name = 'note_revisions' then
    return p_new - array[
        'title', 'body_markdown', 'structured_data', 'tag_ids', 'links',
        'content_hash'
      ] = p_old - array[
        'title', 'body_markdown', 'structured_data', 'tag_ids', 'links',
        'content_hash'
      ]
      and p_new ->> 'title' = 'e-' || lower(p_new ->> 'id')
      and p_new ->> 'body_markdown' = ''
      and p_new -> 'structured_data' = private.encrypted_only_note_sentinel(
        (p_new ->> 'type')::public.note_type
      )
      and p_new -> 'tag_ids' = '[]'::jsonb
      and p_new -> 'links' = '[]'::jsonb
      and p_new ->> 'content_hash' = p_new ->> 'snapshot_mac';
  elsif p_table_name = 'organization_decisions' then
    return p_new - array['candidate_manifest', 'signals', 'validated_plan']
        = p_old - array['candidate_manifest', 'signals', 'validated_plan']
      and p_new -> 'candidate_manifest' = '{}'::jsonb
      and p_new -> 'signals' = '{}'::jsonb
      and p_new -> 'validated_plan' = 'null'::jsonb;
  elsif p_table_name = 'note_mutations' then
    return p_new - array['operations', 'inverse']
        = p_old - array['operations', 'inverse']
      and p_new -> 'operations' = '[]'::jsonb
      and p_new -> 'inverse' = '{}'::jsonb;
  elsif p_table_name = 'generated_blocks' then
    return p_new - 'content' = p_old - 'content'
      and p_new ->> 'content' = '[encrypted]';
  elsif p_table_name = 'review_items' then
    return p_new - array['choices', 'resolution']
        = p_old - array['choices', 'resolution']
      and p_new -> 'choices' = '[]'::jsonb
      and p_new -> 'resolution' = 'null'::jsonb;
  elsif p_table_name = 'routing_rules' then
    return p_new - 'condition_normalized' = p_old - 'condition_normalized'
      and p_new ->> 'condition_normalized' = '[encrypted]';
  elsif p_table_name = 'organization_mutation_attempts' then
    return p_new - 'operations' = p_old - 'operations'
      and p_new -> 'operations' = '[]'::jsonb;
  elsif p_table_name = 'api_idempotency_records' then
    return p_new - array['request_hash', 'response_json']
        = p_old - array['request_hash', 'response_json']
      and p_new ->> 'replay_policy' = 'logical_mac'
      and p_new ->> 'request_hash' = p_new ->> 'request_mac'
      and p_new -> 'response_json' = private.encrypted_only_idempotency_response(
        p_new ->> 'scope', p_new ->> 'request_resource_id',
        p_new ->> 'response_resource_type', p_new ->> 'response_resource_id',
        (p_new ->> 'response_record_version')::integer
      );
  elsif p_table_name = 'capture_receipts' then
    return p_new - array['headline', 'inserted_content', 'actions']
        = p_old - array['headline', 'inserted_content', 'actions']
      and p_new ->> 'headline' = '[encrypted]'
      and p_new -> 'actions' = '[]'::jsonb
      and p_new -> 'inserted_content' = case
        when p_new ->> 'outcome' in ('created_note', 'added_to_note')
          then jsonb_build_array(jsonb_build_object(
            'mutationId', p_new ->> 'mutation_id'
          ))
        else '[]'::jsonb
      end;
  elsif p_table_name = 'captures' then
    return p_new - 'raw_text' = p_old - 'raw_text'
      and p_new ->> 'raw_text' = case
        when nullif(p_new ->> 'deleted_at', '') is null
          then '[encrypted]' else '[deleted]' end;
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function private.scrub_legacy_content_on_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id_value uuid := case
    when tg_op = 'DELETE' then old.user_id else new.user_id
  end;
  scrub_active boolean;
begin
  select rollout.plaintext_scrub_id is not null
    or rollout.state >= 'encrypted_only'
  into scrub_active
  from public.content_encryption_rollouts as rollout
  where rollout.user_id = owner_id_value;
  if not coalesce(scrub_active, false) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'note_chunks' then
    if tg_op = 'DELETE' then return old; end if;
    raise exception using
      errcode = 'P0001', message = 'encrypted_index_required';
  elsif tg_table_name = 'spaces' then
    new.name := 'e-' || lower(new.id);
    new.slug := 'e-' || lower(new.id);
  elsif tg_table_name = 'tags' then
    new.name := 'e-' || lower(new.id);
  elsif tg_table_name = 'notes' then
    new.title := 'e-' || lower(new.id);
    new.body_markdown := '';
    new.structured_data := private.encrypted_only_note_sentinel(new.type);
  elsif tg_table_name = 'note_revisions' then
    new.title := 'e-' || lower(new.id);
    new.body_markdown := '';
    new.structured_data := private.encrypted_only_note_sentinel(new.type);
    new.tag_ids := '[]'::jsonb;
    new.links := '[]'::jsonb;
    new.content_hash := new.snapshot_mac;
  elsif tg_table_name = 'organization_decisions' then
    new.candidate_manifest := '{}'::jsonb;
    new.signals := '{}'::jsonb;
    new.validated_plan := null;
  elsif tg_table_name = 'note_mutations' then
    new.operations := '[]'::jsonb;
    new.inverse := '{}'::jsonb;
  elsif tg_table_name = 'generated_blocks' then
    new.content := '[encrypted]';
  elsif tg_table_name = 'review_items' then
    new.choices := '[]'::jsonb;
    new.resolution := null;
  elsif tg_table_name = 'routing_rules' then
    new.condition_normalized := '[encrypted]';
  elsif tg_table_name = 'organization_mutation_attempts' then
    new.operations := '[]'::jsonb;
  elsif tg_table_name = 'api_idempotency_records' then
    if new.replay_policy = 'legacy_nonreplayable' then
      raise exception using
        errcode = 'P0001', message = 'encrypted_idempotency_required';
    end if;
    new.request_hash := new.request_mac;
    new.response_json := private.encrypted_only_idempotency_response(
      new.scope, new.request_resource_id, new.response_resource_type,
      new.response_resource_id, new.response_record_version
    );
  elsif tg_table_name = 'capture_receipts' then
    new.headline := '[encrypted]';
    new.inserted_content := case
      when new.outcome in ('created_note', 'added_to_note')
        then jsonb_build_array(jsonb_build_object(
          'mutationId', new.mutation_id
        ))
      else '[]'::jsonb
    end;
    new.actions := '[]'::jsonb;
  elsif tg_table_name = 'captures' then
    new.raw_text := case when new.deleted_at is null
      then '[encrypted]' else '[deleted]' end;
  end if;
  return new;
end;
$$;

-- The advisory prelock remains alphabetically first; the scrub trigger is
-- second, before every encrypted rollout guard and timestamp trigger.
do $$
declare
  table_name_value text;
begin
  foreach table_name_value in array array[
    'spaces', 'tags', 'notes', 'note_revisions',
    'organization_decisions', 'note_mutations', 'generated_blocks',
    'review_items', 'routing_rules', 'organization_mutation_attempts',
    'api_idempotency_records', 'capture_receipts', 'captures'
  ] loop
    execute format(
      'drop trigger if exists aa_encrypted_only_scrub on public.%I',
      table_name_value
    );
    execute format(
      'create trigger aa_encrypted_only_scrub before insert or update on public.%I for each row execute function private.scrub_legacy_content_on_write()',
      table_name_value
    );
  end loop;
end;
$$;

drop trigger if exists a_content_rollout_advisory_prelock
  on public.note_chunks;
create trigger a_content_rollout_advisory_prelock
before insert or update or delete on public.note_chunks
for each row execute function private.try_prelock_content_encryption_rollout();
drop trigger if exists aa_encrypted_only_scrub on public.note_chunks;
create trigger aa_encrypted_only_scrub
before insert or update or delete on public.note_chunks
for each row execute function private.scrub_legacy_content_on_write();

-- Patch the existing comprehensive guard rather than duplicating it.  The
-- source anchor is asserted so a future change cannot silently widen this
-- exception.  Only the exact transition predicate above can bypass it.
do $$
declare
  definition_value text;
  anchor_value text := E'begin\n  perform pg_advisory_xact_lock(';
  replacement_value text := E'begin\n  if tg_op = ''UPDATE'' and private.valid_plaintext_scrub_transition(\n      tg_table_name, to_jsonb(old), to_jsonb(new)\n    )\n  then\n    return new;\n  end if;\n  perform pg_advisory_xact_lock(';
begin
  select pg_get_functiondef(
    'private.enforce_encrypted_rollout_write()'::regprocedure
  ) into definition_value;
  if length(definition_value) - length(replace(definition_value, anchor_value, ''))
      <> length(anchor_value)
  then
    raise exception 'encrypted rollout guard source anchor changed';
  end if;
  execute replace(definition_value, anchor_value, replacement_value);
end;
$$;

create or replace function private.reject_revision_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.valid_plaintext_scrub_transition(
      tg_table_name, to_jsonb(old), to_jsonb(new)
    )
  then
    return new;
  end if;
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

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.valid_plaintext_scrub_transition(
      tg_table_name, to_jsonb(old), to_jsonb(new)
    )
  then return new; end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.set_note_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.valid_plaintext_scrub_transition(
      tg_table_name, to_jsonb(old), to_jsonb(new)
    )
  then return new; end if;
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
$$;

create or replace function private.content_plaintext_scrub_readiness(
  p_owner_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  encryption_readiness jsonb;
  remaining_count bigint;
  surface_row_count bigint;
  chunk_count bigint;
  legacy_idempotency_count bigint;
  active_work_count bigint;
  open_write_claim_count bigint;
  eligible_note_count bigint;
  active_generation_count bigint;
  active_generation_id text;
  covered_note_count bigint := 0;
  active_generation_row_count bigint := 0;
  rag_safe boolean;
  attestation_digest_value text;
begin
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id
  ) then
    return jsonb_build_object(
      'ready', false, 'remainingLegacyRowCount', 0,
      'legacyChunkCount', 0, 'legacyIdempotencyCount', 0,
      'activeWorkCount', 0, 'openWriteClaimCount', 0,
      'ragCoverageSafe', false, 'attestationDigest', null
    );
  end if;

  select count(*)::bigint into remaining_count
  from (
    select '01:space:' || space.id as cursor_value
    from public.spaces as space
    where space.user_id = p_owner_id and (
      space.name <> 'e-' || lower(space.id)
      or space.slug <> 'e-' || lower(space.id)
    )
    union all
    select '02:tag:' || tag.id
    from public.tags as tag
    where tag.user_id = p_owner_id
      and tag.name <> 'e-' || lower(tag.id)
    union all
    select '03:note:' || note.id
    from public.notes as note
    where note.user_id = p_owner_id and (
      note.title <> 'e-' || lower(note.id)
      or note.body_markdown <> ''
      or note.structured_data <> private.encrypted_only_note_sentinel(note.type)
    )
    union all
    select '04:note_revision:' || revision.id
    from public.note_revisions as revision
    where revision.user_id = p_owner_id and (
      revision.title <> 'e-' || lower(revision.id)
      or revision.body_markdown <> ''
      or revision.structured_data
        <> private.encrypted_only_note_sentinel(revision.type)
      or revision.tag_ids <> '[]'::jsonb
      or revision.links <> '[]'::jsonb
      or revision.content_hash is distinct from revision.snapshot_mac
    )
    union all
    select '05:organization_decision:' || decision.id
    from public.organization_decisions as decision
    where decision.user_id = p_owner_id and (
      decision.candidate_manifest <> '{}'::jsonb
      or decision.signals <> '{}'::jsonb
      or decision.validated_plan is not null
    )
    union all
    select '06:note_mutation:' || mutation.id
    from public.note_mutations as mutation
    where mutation.user_id = p_owner_id and (
      mutation.operations <> '[]'::jsonb
      or mutation.inverse <> '{}'::jsonb
    )
    union all
    select '07:generated_block:' || block.id
    from public.generated_blocks as block
    where block.user_id = p_owner_id and block.content <> '[encrypted]'
    union all
    select '08:review_item:' || review.id
    from public.review_items as review
    where review.user_id = p_owner_id and (
      review.choices <> '[]'::jsonb or review.resolution is not null
    )
    union all
    select '09:routing_rule:' || rule.id
    from public.routing_rules as rule
    where rule.user_id = p_owner_id
      and rule.condition_normalized <> '[encrypted]'
    union all
    select '10:organization_mutation_attempt:' || attempt.job_id || ':'
      || attempt.note_id
    from public.organization_mutation_attempts as attempt
    where attempt.user_id = p_owner_id
      and attempt.operations <> '[]'::jsonb
    union all
    select '11:idempotency_response:' || record.idempotency_key
    from public.api_idempotency_records as record
    where record.user_id = p_owner_id and (
      record.replay_policy = 'legacy_nonreplayable'
      or record.request_hash is distinct from record.request_mac
      or record.response_json is distinct from
        private.encrypted_only_idempotency_response(
          record.scope, record.request_resource_id,
          record.response_resource_type, record.response_resource_id,
          record.response_record_version
        )
    )
    union all
    select '12:capture_receipt:' || receipt.capture_id
    from public.capture_receipts as receipt
    where receipt.user_id = p_owner_id and (
      receipt.headline <> '[encrypted]'
      or receipt.actions <> '[]'::jsonb
      or receipt.inserted_content <> case
        when receipt.outcome in ('created_note', 'added_to_note')
          then jsonb_build_array(jsonb_build_object(
            'mutationId', receipt.mutation_id
          ))
        else '[]'::jsonb
      end
    )
    union all
    select '13:capture:' || capture.id
    from public.captures as capture
    where capture.user_id = p_owner_id
      and capture.raw_text <> case when capture.deleted_at is null
        then '[encrypted]' else '[deleted]' end
  ) as dirty;

  select (
      (select count(*) from public.spaces where user_id = p_owner_id)
      + (select count(*) from public.tags where user_id = p_owner_id)
      + (select count(*) from public.notes where user_id = p_owner_id)
      + (select count(*) from public.note_revisions where user_id = p_owner_id)
      + (select count(*) from public.organization_decisions
          where user_id = p_owner_id)
      + (select count(*) from public.note_mutations where user_id = p_owner_id)
      + (select count(*) from public.generated_blocks where user_id = p_owner_id)
      + (select count(*) from public.review_items where user_id = p_owner_id)
      + (select count(*) from public.routing_rules where user_id = p_owner_id)
      + (select count(*) from public.organization_mutation_attempts
          where user_id = p_owner_id)
      + (select count(*) from public.api_idempotency_records
          where user_id = p_owner_id)
      + (select count(*) from public.capture_receipts where user_id = p_owner_id)
      + (select count(*) from public.captures where user_id = p_owner_id)
    )::bigint
  into surface_row_count;

  select count(*)::bigint into chunk_count
  from public.note_chunks where user_id = p_owner_id;
  select count(*)::bigint into legacy_idempotency_count
  from public.api_idempotency_records
  where user_id = p_owner_id and replay_policy = 'legacy_nonreplayable';
  select (
    (select count(*) from public.organization_jobs
      where user_id = p_owner_id
        and state in ('created', 'running', 'awaiting_retry'))
    + (select count(*) from public.note_index_jobs
      where user_id = p_owner_id and state in ('queued', 'leased'))
    + (select count(*) from public.rag_index_generations
      where user_id = p_owner_id and state = 'building')
    + (select count(*) from public.captures
      where user_id = p_owner_id and deleted_at is null
        and status in ('pending', 'queued', 'processing'))
    + (select count(*) from public.api_idempotency_records
      where user_id = p_owner_id and completed_at is null)
  )::bigint into active_work_count;
  select count(*)::bigint into open_write_claim_count
  from public.encrypted_note_write_claims
  where user_id = p_owner_id and completed_at is null;

  select count(*)::bigint into eligible_note_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;
  select count(*)::bigint, min(id)
  into active_generation_count, active_generation_id
  from public.rag_index_generations
  where user_id = p_owner_id and state = 'active';

  if eligible_note_count = 0 then
    rag_safe := active_generation_count = 0 or (
      active_generation_count = 1
      and exists (
        select 1 from public.rag_index_generations as generation
        where generation.user_id = p_owner_id
          and generation.id = active_generation_id
          and generation.expected_note_count = 0
          and generation.indexed_note_count = 0
      )
      and not exists (
        select 1 from public.note_rag_index as index_row
        where index_row.user_id = p_owner_id
          and index_row.generation_id = active_generation_id
      )
    );
  elsif active_generation_count = 1 then
    select
      count(*) filter (
        where note.id is not null
          and note.privacy = 'ai_assisted'
          and note.deleted_at is null
          and note.current_revision = index_row.indexed_revision
          and content_key.state in ('active', 'retired')
      )::bigint,
      count(*)::bigint
    into covered_note_count, active_generation_row_count
    from public.note_rag_index as index_row
    left join public.notes as note
      on note.user_id = index_row.user_id and note.id = index_row.note_id
    left join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
    where index_row.user_id = p_owner_id
      and index_row.generation_id = active_generation_id;
    rag_safe := covered_note_count = eligible_note_count
      and active_generation_row_count = eligible_note_count
      and exists (
        select 1 from public.rag_index_generations as generation
        where generation.user_id = p_owner_id
          and generation.id = active_generation_id
          and generation.expected_note_count = eligible_note_count
          and generation.indexed_note_count = eligible_note_count
      );
  else
    rag_safe := false;
  end if;

  encryption_readiness := private.content_encryption_readiness(p_owner_id);
  attestation_digest_value := private.request_hash(jsonb_build_object(
    'ownerId', p_owner_id,
    'sentinelVersion', 1,
    'surfaceRowCount', surface_row_count,
    'remainingLegacyRowCount', remaining_count,
    'legacyChunkCount', chunk_count,
    'legacyIdempotencyCount', legacy_idempotency_count,
    'requiredObjectCount', encryption_readiness -> 'requiredObjectCount',
    'exactVerifiedObjectCount',
      encryption_readiness -> 'exactVerifiedObjectCount',
    'activeKeySlots', encryption_readiness -> 'activeKeySlots',
    'eligibleRagNoteCount', eligible_note_count,
    'activeRagGenerationId', active_generation_id,
    'ragCoverageSafe', rag_safe
  ));

  return jsonb_build_object(
    'ready',
      remaining_count = 0
      and chunk_count = 0
      and legacy_idempotency_count = 0
      and active_work_count = 0
      and open_write_claim_count = 0
      and rag_safe
      and (encryption_readiness ->> 'readyForEncryptedRead')::boolean,
    'remainingLegacyRowCount', remaining_count,
    'surfaceRowCount', surface_row_count,
    'legacyChunkCount', chunk_count,
    'legacyIdempotencyCount', legacy_idempotency_count,
    'activeWorkCount', active_work_count,
    'openWriteClaimCount', open_write_claim_count,
    'ragCoverageSafe', rag_safe,
    'eligibleRagNoteCount', eligible_note_count,
    'activeRagGenerationId', active_generation_id,
    'encryptionReadiness', encryption_readiness,
    'attestationDigest', attestation_digest_value
  );
end;
$$;

create or replace function public.prepare_content_plaintext_scrub(
  p_owner_id uuid,
  p_scrub_id uuid,
  p_expected_state public.encryption_rollout_state
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  readiness_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_scrub_id is null
    or p_expected_state is distinct from 'encrypted_read'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rollout_row.plaintext_scrub_id is not null then
    if rollout_row.plaintext_scrub_id <> p_scrub_id
      or rollout_row.state <> 'encrypted_read'
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'scrubId', rollout_row.plaintext_scrub_id,
      'cursor', rollout_row.plaintext_scrub_cursor,
      'complete', rollout_row.plaintext_scrub_completed_at is not null,
      'replayed', true
    );
  end if;
  if rollout_row.state <> p_expected_state then
    raise exception using errcode = 'P0001', message = 'stale_rollout_state';
  end if;

  readiness_value := private.content_plaintext_scrub_readiness(p_owner_id);
  if not (
      readiness_value -> 'encryptionReadiness' ->> 'readyForEncryptedRead'
    )::boolean
  then
    raise exception using errcode = 'P0001', message = 'incomplete_encryption_backfill';
  end if;
  if (readiness_value ->> 'activeWorkCount')::bigint <> 0
    or (readiness_value ->> 'openWriteClaimCount')::bigint <> 0
  then
    raise exception using errcode = 'P0001', message = 'cutover_work_in_flight';
  end if;
  if not (readiness_value ->> 'ragCoverageSafe')::boolean then
    raise exception using errcode = 'P0001', message = 'incomplete_index_coverage';
  end if;

  update public.content_encryption_rollouts set
    plaintext_scrub_id = p_scrub_id,
    plaintext_scrub_version = 1,
    plaintext_scrub_started_at = clock_timestamp(),
    plaintext_scrub_cursor = null,
    plaintext_scrub_completed_at = null,
    plaintext_scrubbed_row_count = 0,
    plaintext_scrubbed_chunk_count = 0,
    plaintext_scrubbed_idempotency_count = 0,
    plaintext_scrub_attestation_digest = null,
    last_plaintext_scrub_expected_cursor = null,
    last_plaintext_scrub_limit = null,
    last_plaintext_scrub_request_digest = null,
    last_plaintext_scrub_result_digest = null,
    last_plaintext_scrub_result = null
  where user_id = p_owner_id;

  return jsonb_build_object(
    'scrubId', p_scrub_id, 'cursor', null,
    'complete', false, 'replayed', false
  );
end;
$$;

create or replace function public.scrub_content_plaintext_batch(
  p_owner_id uuid,
  p_scrub_id uuid,
  p_expected_cursor text,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rollout_row public.content_encryption_rollouts%rowtype;
  candidate record;
  next_cursor_value text := p_expected_cursor;
  processed_delta bigint := 0;
  chunk_delta bigint := 0;
  idempotency_delta bigint := 0;
  affected_count integer;
  request_digest_value text;
  result_digest_value text;
  result_value jsonb;
  readiness_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_scrub_id is null
    or p_limit is null or p_limit not between 1 and 250
    or (p_expected_cursor is not null
      and char_length(p_expected_cursor) not between 1 and 260)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  request_digest_value := private.request_hash(jsonb_build_object(
    'operation', 'scrub_content_plaintext_batch',
    'ownerId', p_owner_id, 'scrubId', p_scrub_id,
    'expectedCursor', p_expected_cursor, 'limit', p_limit
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rollout_row.state <> 'encrypted_read'
    or rollout_row.plaintext_scrub_id is distinct from p_scrub_id
    or rollout_row.plaintext_scrub_started_at is null
  then
    raise exception using errcode = 'P0001', message = 'invalid_scrub_state';
  end if;
  if rollout_row.last_plaintext_scrub_request_digest = request_digest_value then
    return rollout_row.last_plaintext_scrub_result
      || jsonb_build_object('replayed', true);
  end if;
  if rollout_row.plaintext_scrub_completed_at is not null then
    raise exception using errcode = 'P0001', message = 'plaintext_scrub_complete';
  end if;
  if rollout_row.plaintext_scrub_cursor is distinct from p_expected_cursor then
    raise exception using errcode = 'P0001', message = 'stale_scrub_cursor';
  end if;

  for candidate in
    select dirty.cursor_value, dirty.surface_name, dirty.resource_id
    from (
      select '01:space:' || space.id, 'space', space.id
      from public.spaces as space
      where space.user_id = p_owner_id and (
        space.name <> 'e-' || lower(space.id)
        or space.slug <> 'e-' || lower(space.id)
      )
      union all
      select '02:tag:' || tag.id, 'tag', tag.id
      from public.tags as tag
      where tag.user_id = p_owner_id
        and tag.name <> 'e-' || lower(tag.id)
      union all
      select '03:note:' || note.id, 'note', note.id
      from public.notes as note
      where note.user_id = p_owner_id and (
        note.title <> 'e-' || lower(note.id)
        or note.body_markdown <> ''
        or note.structured_data <> private.encrypted_only_note_sentinel(note.type)
      )
      union all
      select '04:note_revision:' || revision.id, 'note_revision', revision.id
      from public.note_revisions as revision
      where revision.user_id = p_owner_id and (
        revision.title <> 'e-' || lower(revision.id)
        or revision.body_markdown <> ''
        or revision.structured_data
          <> private.encrypted_only_note_sentinel(revision.type)
        or revision.tag_ids <> '[]'::jsonb
        or revision.links <> '[]'::jsonb
        or revision.content_hash is distinct from revision.snapshot_mac
      )
      union all
      select '05:organization_decision:' || decision.id,
        'organization_decision', decision.id
      from public.organization_decisions as decision
      where decision.user_id = p_owner_id and (
        decision.candidate_manifest <> '{}'::jsonb
        or decision.signals <> '{}'::jsonb
        or decision.validated_plan is not null
      )
      union all
      select '06:note_mutation:' || mutation.id, 'note_mutation', mutation.id
      from public.note_mutations as mutation
      where mutation.user_id = p_owner_id and (
        mutation.operations <> '[]'::jsonb
        or mutation.inverse <> '{}'::jsonb
      )
      union all
      select '07:generated_block:' || block.id, 'generated_block', block.id
      from public.generated_blocks as block
      where block.user_id = p_owner_id and block.content <> '[encrypted]'
      union all
      select '08:review_item:' || review.id, 'review_item', review.id
      from public.review_items as review
      where review.user_id = p_owner_id and (
        review.choices <> '[]'::jsonb or review.resolution is not null
      )
      union all
      select '09:routing_rule:' || rule.id, 'routing_rule', rule.id
      from public.routing_rules as rule
      where rule.user_id = p_owner_id
        and rule.condition_normalized <> '[encrypted]'
      union all
      select '10:organization_mutation_attempt:' || attempt.job_id || ':'
          || attempt.note_id,
        'organization_mutation_attempt', attempt.job_id || ':' || attempt.note_id
      from public.organization_mutation_attempts as attempt
      where attempt.user_id = p_owner_id
        and attempt.operations <> '[]'::jsonb
      union all
      select '11:idempotency_response:' || record.idempotency_key,
        'idempotency_response', record.idempotency_key
      from public.api_idempotency_records as record
      where record.user_id = p_owner_id and (
        record.replay_policy = 'legacy_nonreplayable'
        or record.request_hash is distinct from record.request_mac
        or record.response_json is distinct from
          private.encrypted_only_idempotency_response(
            record.scope, record.request_resource_id,
            record.response_resource_type, record.response_resource_id,
            record.response_record_version
          )
      )
      union all
      select '12:capture_receipt:' || receipt.capture_id,
        'capture_receipt', receipt.capture_id
      from public.capture_receipts as receipt
      where receipt.user_id = p_owner_id and (
        receipt.headline <> '[encrypted]'
        or receipt.actions <> '[]'::jsonb
        or receipt.inserted_content <> case
          when receipt.outcome in ('created_note', 'added_to_note')
            then jsonb_build_array(jsonb_build_object(
              'mutationId', receipt.mutation_id
            ))
          else '[]'::jsonb
        end
      )
      union all
      select '13:capture:' || capture.id, 'capture', capture.id
      from public.captures as capture
      where capture.user_id = p_owner_id
        and capture.raw_text <> case when capture.deleted_at is null
          then '[encrypted]' else '[deleted]' end
      union all
      select '14:note_chunk:' || chunk.id, 'note_chunk', chunk.id
      from public.note_chunks as chunk
      where chunk.user_id = p_owner_id
    ) as dirty(cursor_value, surface_name, resource_id)
    order by dirty.cursor_value
    limit p_limit
  loop
    affected_count := 0;
    if candidate.surface_name = 'space' then
      update public.spaces set
        name = 'e-' || lower(id), slug = 'e-' || lower(id)
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'tag' then
      update public.tags set name = 'e-' || lower(id)
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'note' then
      update public.notes set
        title = 'e-' || lower(id), body_markdown = '',
        structured_data = private.encrypted_only_note_sentinel(type)
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'note_revision' then
      update public.note_revisions set
        title = 'e-' || lower(id), body_markdown = '',
        structured_data = private.encrypted_only_note_sentinel(type),
        tag_ids = '[]'::jsonb, links = '[]'::jsonb,
        content_hash = snapshot_mac
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'organization_decision' then
      update public.organization_decisions set
        candidate_manifest = '{}'::jsonb, signals = '{}'::jsonb,
        validated_plan = null
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'note_mutation' then
      update public.note_mutations set
        operations = '[]'::jsonb, inverse = '{}'::jsonb
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'generated_block' then
      update public.generated_blocks set content = '[encrypted]'
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'review_item' then
      update public.review_items set choices = '[]'::jsonb, resolution = null
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'routing_rule' then
      update public.routing_rules set condition_normalized = '[encrypted]'
      where user_id = p_owner_id and id = candidate.resource_id;
    elsif candidate.surface_name = 'organization_mutation_attempt' then
      update public.organization_mutation_attempts set operations = '[]'::jsonb
      where user_id = p_owner_id
        and job_id || ':' || note_id = candidate.resource_id;
    elsif candidate.surface_name = 'idempotency_response' then
      if exists (
        select 1 from public.api_idempotency_records
        where user_id = p_owner_id
          and idempotency_key = candidate.resource_id
          and replay_policy = 'legacy_nonreplayable'
      ) then
        delete from public.api_idempotency_records
        where user_id = p_owner_id and idempotency_key = candidate.resource_id
          and replay_policy = 'legacy_nonreplayable';
        get diagnostics affected_count = row_count;
        idempotency_delta := idempotency_delta + affected_count;
      else
        update public.api_idempotency_records set
          request_hash = request_mac,
          response_json = private.encrypted_only_idempotency_response(
            scope, request_resource_id, response_resource_type,
            response_resource_id, response_record_version
          )
        where user_id = p_owner_id
          and idempotency_key = candidate.resource_id
          and replay_policy = 'logical_mac';
      end if;
    elsif candidate.surface_name = 'capture_receipt' then
      update public.capture_receipts set
        headline = '[encrypted]',
        inserted_content = case
          when outcome in ('created_note', 'added_to_note')
            then jsonb_build_array(jsonb_build_object(
              'mutationId', mutation_id
            ))
          else '[]'::jsonb
        end,
        actions = '[]'::jsonb
      where user_id = p_owner_id and capture_id = candidate.resource_id;
    elsif candidate.surface_name = 'capture' then
      update public.captures set raw_text = case when deleted_at is null
        then '[encrypted]' else '[deleted]' end
      where user_id = p_owner_id and id = candidate.resource_id;
    else
      delete from public.note_chunks
      where user_id = p_owner_id and id = candidate.resource_id;
      get diagnostics affected_count = row_count;
      chunk_delta := chunk_delta + affected_count;
    end if;
    if affected_count = 0 then get diagnostics affected_count = row_count; end if;
    if affected_count <> 1 then
      raise exception using errcode = 'P0001', message = 'stale_scrub_candidate';
    end if;
    processed_delta := processed_delta + 1;
    next_cursor_value := candidate.cursor_value;
  end loop;

  readiness_value := private.content_plaintext_scrub_readiness(p_owner_id);
  result_value := jsonb_build_object(
    'scrubId', p_scrub_id,
    'expectedCursor', p_expected_cursor,
    'cursor', next_cursor_value,
    'processedCount', processed_delta,
    'deletedChunkCount', chunk_delta,
    'deletedIdempotencyCount', idempotency_delta,
    'complete',
      (readiness_value ->> 'remainingLegacyRowCount')::bigint = 0
      and (readiness_value ->> 'legacyChunkCount')::bigint = 0,
    'replayed', false
  );
  result_digest_value := private.request_hash(result_value);
  update public.content_encryption_rollouts set
    plaintext_scrub_cursor = next_cursor_value,
    plaintext_scrubbed_row_count = plaintext_scrubbed_row_count
      + processed_delta - chunk_delta - idempotency_delta,
    plaintext_scrubbed_chunk_count = plaintext_scrubbed_chunk_count
      + chunk_delta,
    plaintext_scrubbed_idempotency_count =
      plaintext_scrubbed_idempotency_count + idempotency_delta,
    last_plaintext_scrub_expected_cursor = p_expected_cursor,
    last_plaintext_scrub_limit = p_limit,
    last_plaintext_scrub_request_digest = request_digest_value,
    last_plaintext_scrub_result_digest = result_digest_value,
    last_plaintext_scrub_result = result_value
  where user_id = p_owner_id;
  return result_value;
end;
$$;

create or replace function public.complete_content_plaintext_scrub(
  p_owner_id uuid,
  p_scrub_id uuid,
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
  digest_value text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_scrub_id is null
    or (p_expected_cursor is not null
      and char_length(p_expected_cursor) not between 1 and 260)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rollout_row.state <> 'encrypted_read'
    or rollout_row.plaintext_scrub_id is distinct from p_scrub_id
  then
    raise exception using errcode = 'P0001', message = 'invalid_scrub_state';
  end if;
  if rollout_row.plaintext_scrub_cursor is distinct from p_expected_cursor then
    raise exception using errcode = 'P0001', message = 'stale_scrub_cursor';
  end if;
  readiness_value := private.content_plaintext_scrub_readiness(p_owner_id);
  digest_value := readiness_value ->> 'attestationDigest';
  if rollout_row.plaintext_scrub_completed_at is not null then
    if rollout_row.plaintext_scrub_attestation_digest <> digest_value
      or not (readiness_value ->> 'ready')::boolean
    then
      raise exception using errcode = 'P0001', message = 'scrub_attestation_stale';
    end if;
    return jsonb_build_object(
      'scrubId', p_scrub_id, 'complete', true,
      'attestationDigest', digest_value, 'replayed', true
    );
  end if;
  if not (readiness_value ->> 'ready')::boolean then
    raise exception using errcode = 'P0001', message = 'plaintext_scrub_incomplete';
  end if;

  update public.content_encryption_rollouts set
    plaintext_scrub_completed_at = clock_timestamp(),
    plaintext_scrub_attestation_digest = digest_value
  where user_id = p_owner_id;
  return jsonb_build_object(
    'scrubId', p_scrub_id, 'complete', true,
    'attestationDigest', digest_value, 'replayed', false
  );
end;
$$;

-- Bind every note write claim to the projection that is safe for the current
-- rollout phase. An open legacy-projection claim prevents the scrub protocol
-- from starting, so this value cannot switch underneath a command submission.
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
    'commandProjection', coalesce((
      select case
        when rollout.plaintext_scrub_id is not null
          or rollout.state in ('encrypted_only', 'contracted')
        then 'encrypted_only'
        else 'legacy'
      end
      from public.content_encryption_rollouts as rollout
      where rollout.user_id = claim_value.user_id
    ), 'legacy'),
    'requestMacKey', jsonb_build_object(
      'keyId', claim_value.request_mac_key_id,
      'keyClass', claim_value.request_mac_key_class,
      'keyPurpose', claim_value.request_mac_key_purpose,
      'keyVersion', claim_value.request_mac_key_version
    ),
    'completed', claim_value.completed_at is not null
  );
$$;

-- This shape is deliberately content-free. The true state transition and
-- inverse remain authenticated inside the note/revision/mutation envelopes.
create or replace function private.valid_encrypted_only_note_command(
  p_scope text,
  p_note_id text,
  p_state jsonb,
  p_mutation jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  note_type_value public.note_type;
  privacy_value public.privacy_mode;
  mutation_sentinel jsonb;
begin
  if p_scope not in ('create_encrypted_note', 'apply_encrypted_note_mutation')
    or p_note_id is null
    or p_state is null
    or p_mutation is null
  then
    return false;
  end if;
  note_type_value := (p_state ->> 'type')::public.note_type;
  privacy_value := (p_state ->> 'privacy')::public.privacy_mode;
  if p_state ->> 'title' <> 'e-' || lower(p_note_id)
    or p_state ->> 'bodyMarkdown' <> ''
    or p_state -> 'structuredData'
      <> private.encrypted_only_note_sentinel(note_type_value)
  then
    return false;
  end if;

  if p_scope = 'create_encrypted_note' then
    return p_mutation -> 'operations'
        = jsonb_build_array(jsonb_build_object('type', 'create_note'))
      and p_mutation -> 'inverse'
        = jsonb_build_object('type', 'soft_delete_created_note');
  end if;
  mutation_sentinel := jsonb_build_array(jsonb_build_object(
    'type', 'set_privacy', 'privacy', privacy_value
  ));
  return p_mutation -> 'operations' = mutation_sentinel
    and p_mutation -> 'inverse' = mutation_sentinel;
exception when invalid_text_representation then
  return false;
end;
$$;

-- C.5b intentionally enumerated the two write-capable states.  Keep those
-- reviewed implementations and capability grants intact, changing only the
-- exact state predicate in the five current encrypted writer/worker bodies.
-- Every anchor is asserted so catalog drift fails this migration closed.
do $$
declare
  target record;
  definition_value text;
  old_value text := 'state in (''dual_write'', ''encrypted_read'')';
  new_value text :=
    'state in (''dual_write'', ''encrypted_read'', ''encrypted_only'')';
begin
  for target in
    select procedure.oid
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (namespace.nspname, procedure.proname) in (
      ('public', 'prepare_encrypted_note_write'),
      ('public', 'verify_encrypted_content_object'),
      ('public', 'create_encrypted_capture_with_job'),
      ('private', 'create_encrypted_capture_with_job_legacy'),
      ('private', 'claim_encrypted_organizer_jobs_impl')
    )
  loop
    definition_value := pg_catalog.pg_get_functiondef(target.oid);
    if pg_catalog.strpos(definition_value, old_value) = 0 then
      raise exception 'encrypted-only state anchor missing for function %',
        target.oid::regprocedure;
    end if;
    execute pg_catalog.replace(definition_value, old_value, new_value);
  end loop;
  if not found then
    raise exception 'encrypted-only writer function set missing';
  end if;
end;
$$;

-- Reject a plaintext-bearing command at the SQL trust boundary as well. This
-- is defense in depth for service callers; the web coordinator uses the claim
-- projection above to ensure plaintext never enters the HTTP request body.
do $$
declare
  target record;
  definition_value text;
  anchor_value text := E'  response_verification_mac := verification_value -> ''idempotencyResponse'';\n\n  if not private.valid_encrypted_note_state(state_value)';
  replacement_value text;
begin
  for target in
    select * from (values
      ('public.create_encrypted_note(uuid,text,text,jsonb)'::regprocedure,
        'create_encrypted_note'::text),
      ('public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)'::regprocedure,
        'apply_encrypted_note_mutation'::text)
    ) as targets(procedure_oid, scope_value)
  loop
    definition_value := pg_catalog.pg_get_functiondef(target.procedure_oid);
    if length(definition_value)
        - length(pg_catalog.replace(definition_value, anchor_value, ''))
        <> length(anchor_value)
    then
      raise exception 'encrypted-only command anchor mismatch for function %',
        target.procedure_oid::regprocedure;
    end if;
    replacement_value := E'  response_verification_mac := verification_value -> ''idempotencyResponse'';\n\n  if exists (\n    select 1\n    from public.content_encryption_rollouts as command_rollout\n    where command_rollout.user_id = p_owner_id\n      and (command_rollout.plaintext_scrub_id is not null\n        or command_rollout.state in (''encrypted_only'', ''contracted''))\n  ) and not private.valid_encrypted_only_note_command(\n    '
      || pg_catalog.quote_literal(target.scope_value)
      || E', p_note_id, state_value, mutation_value\n  )\n  then\n    raise exception using errcode = ''22023'',\n      message = ''plaintext_command_forbidden'';\n  end if;\n\n  if not private.valid_encrypted_note_state(state_value)';
    execute pg_catalog.replace(
      definition_value, anchor_value, replacement_value
    );
  end loop;
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
  scrub_readiness_value jsonb;
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
      or (
        p_expected_state = 'encrypted_read'
        and p_next_state = 'encrypted_only'
      )
    )
  then
    raise exception using
      errcode = '22023', message = 'invalid_rollout_transition';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  foreach key_class_value in array array[
    'ai_assisted'::public.content_key_class,
    'private_manual'::public.content_key_class
  ] loop
    foreach key_purpose_value in array array[
      'content_mac'::public.content_key_purpose,
      'object_wrap'::public.content_key_purpose
    ] loop
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_owner_id::text || ':' || key_class_value::text || ':'
          || key_purpose_value::text, 0
      ));
    end loop;
  end loop;

  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if rollout_row.state = p_next_state then
    return jsonb_build_object(
      'state', rollout_row.state,
      'readMode', case when rollout_row.state >= 'encrypted_read'
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
  if p_next_state = 'encrypted_only' then
    if rollout_row.plaintext_scrub_id is null
      or rollout_row.plaintext_scrub_completed_at is null
      or rollout_row.plaintext_scrub_attestation_digest is null
    then
      raise exception using errcode = 'P0001', message = 'plaintext_scrub_incomplete';
    end if;
    scrub_readiness_value :=
      private.content_plaintext_scrub_readiness(p_owner_id);
    if not (scrub_readiness_value ->> 'ready')::boolean
      or rollout_row.plaintext_scrub_attestation_digest
        <> scrub_readiness_value ->> 'attestationDigest'
    then
      raise exception using errcode = 'P0001', message = 'scrub_attestation_stale';
    end if;
  end if;

  update public.content_encryption_rollouts
  set state = p_next_state
  where user_id = p_owner_id
  returning * into rollout_row;
  return jsonb_build_object(
    'state', rollout_row.state,
    'readMode', case when rollout_row.state >= 'encrypted_read'
      then 'encrypted' else 'legacy' end,
    'replayed', false
  );
end;
$$;

create or replace function public.get_content_encryption_rollout(
  p_owner_id uuid
)
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
  select * into rollout_row
  from public.content_encryption_rollouts
  where user_id = p_owner_id;
  if not found then
    return jsonb_build_object(
      'found', false, 'state', 'expanded',
      'writeMode', 'legacy', 'readMode', 'legacy',
      'backfill', null, 'plaintextScrub', null,
      'readiness', private.content_encryption_readiness(p_owner_id)
    );
  end if;
  return jsonb_build_object(
    'found', true,
    'state', rollout_row.state,
    'writeMode', case when rollout_row.state = 'expanded'
      then 'legacy' else 'encrypted' end,
    'readMode', case when rollout_row.state < 'encrypted_read'
      then 'legacy' else 'encrypted' end,
    'backfill', jsonb_build_object(
      'cursor', rollout_row.backfill_cursor,
      'complete', rollout_row.backfill_completed_at is not null,
      'encryptedObjectCount', rollout_row.encrypted_object_count,
      'verifiedObjectCount', rollout_row.verified_object_count
    ),
    'plaintextScrub', case when rollout_row.plaintext_scrub_id is null
      then null else jsonb_build_object(
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
      ) end,
    'readiness', private.content_encryption_readiness(p_owner_id)
  );
end;
$$;

-- New helpers are implementation details; only the three bounded protocol
-- RPCs join the existing service-only rollout surface.
revoke execute on function private.encrypted_only_note_sentinel(public.note_type)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.valid_encrypted_only_note_command(
  text, text, jsonb, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.encrypted_only_idempotency_response(
  text, text, text, text, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.valid_plaintext_scrub_transition(
  text, jsonb, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.scrub_legacy_content_on_write()
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.content_plaintext_scrub_readiness(uuid)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

revoke execute on function public.prepare_content_plaintext_scrub(
  uuid, uuid, public.encryption_rollout_state
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.scrub_content_plaintext_batch(
  uuid, uuid, text, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.complete_content_plaintext_scrub(
  uuid, uuid, text
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.prepare_content_plaintext_scrub(
  uuid, uuid, public.encryption_rollout_state
) to service_role;
grant execute on function public.scrub_content_plaintext_batch(
  uuid, uuid, text, integer
) to service_role;
grant execute on function public.complete_content_plaintext_scrub(
  uuid, uuid, text
) to service_role;

-- CREATE OR REPLACE preserves the prior service-only ACLs of the transition
-- and encrypted writer functions.  Explicitly keep the rollout RPC closed to
-- every non-service capability role at this new transition boundary.
revoke execute on function public.advance_content_encryption_rollout(
  uuid, public.encryption_rollout_state, public.encryption_rollout_state
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.advance_content_encryption_rollout(
  uuid, public.encryption_rollout_state, public.encryption_rollout_state
) to service_role;
