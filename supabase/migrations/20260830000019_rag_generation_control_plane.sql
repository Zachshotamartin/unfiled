-- Milestone C.5c: executable shadow-generation control plane and verifier read.
--
-- The interactive service may discover, create, seed, and fail bounded shadow
-- generations. The independent verifier keeps exactly two capabilities: read
-- one exact building generation through a bounded ciphertext projection, then
-- publish the canonical database attestation after strict decryption succeeds.

do $one_building_generation$
begin
  if exists (
    select 1
    from public.rag_index_generations
    where state = 'building'
    group by user_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'duplicate_building_generations_require_reconciliation';
  end if;
end;
$one_building_generation$;

create unique index rag_index_generations_one_building
  on public.rag_index_generations (user_id)
  where state = 'building';

alter table public.rag_index_generations
  add column failure_code public.safe_error_code;

update public.rag_index_generations
set failure_code = 'validation_failed'
where state = 'failed' and failure_code is null;

alter table public.rag_index_generations
  add constraint rag_index_generations_failure_code_shape check (
    (state = 'failed' and failure_code is not null)
    or (state <> 'failed' and failure_code is null)
  );

-- Attestation must remain bounded by row count rather than encrypted payload
-- size. These stored generated values are derived only by the database from
-- the canonical row; no caller can submit or update a digest independently of
-- the ciphertext, key reference, identity, revision, or byte length it binds.
create function private.rag_index_attestation_envelope_digest(
  envelope_value jsonb
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select private.request_hash(envelope_value);
$$;

create function private.rag_index_attestation_key_reference_digest(
  owner_id uuid,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select private.request_hash(jsonb_build_object(
    'domain', 'unfiled.rag-generation-key-reference.v1',
    'ownerId', owner_id,
    'keyId', key_id_value,
    'keyClass', key_class_value,
    'keyPurpose', key_purpose_value,
    'keyVersion', key_version_value
  ));
$$;

create function private.rag_index_attestation_row_digest(
  owner_id uuid,
  generation_id_value text,
  index_id_value text,
  note_id_value text,
  indexed_revision_value integer,
  envelope_value jsonb,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer,
  encrypted_byte_length_value integer
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select private.request_hash(jsonb_build_object(
    'domain', 'unfiled.rag-generation-row.v1',
    'ownerId', owner_id,
    'generationId', generation_id_value,
    'indexId', index_id_value,
    'noteId', note_id_value,
    'indexedRevision', indexed_revision_value,
    'envelopeDigest', private.rag_index_attestation_envelope_digest(
      envelope_value
    ),
    'keyReferenceDigest', private.rag_index_attestation_key_reference_digest(
      owner_id, key_id_value, key_class_value,
      key_purpose_value, key_version_value
    ),
    'encryptedByteLength', encrypted_byte_length_value
  ));
$$;

alter table public.note_rag_index
  add column attestation_envelope_digest text generated always as (
    private.rag_index_attestation_envelope_digest(index_envelope)
  ) stored,
  add column attestation_key_reference_digest text generated always as (
    private.rag_index_attestation_key_reference_digest(
      user_id, index_key_id, index_key_class,
      index_key_purpose, index_key_version
    )
  ) stored,
  add column attestation_row_digest text generated always as (
    private.rag_index_attestation_row_digest(
      user_id, generation_id, id, note_id, indexed_revision,
      index_envelope, index_key_id, index_key_class,
      index_key_purpose, index_key_version, encrypted_byte_length
    )
  ) stored,
  add constraint note_rag_index_attestation_envelope_digest_shape check (
    attestation_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  add constraint note_rag_index_attestation_key_reference_digest_shape check (
    attestation_key_reference_digest ~ '^[0-9a-f]{64}$'
  ),
  add constraint note_rag_index_attestation_row_digest_shape check (
    attestation_row_digest ~ '^[0-9a-f]{64}$'
  );

-- Replace the expand-era manifest scan. Only fixed-size, database-generated
-- digests are read here, so the terminal page and final verification RPC stay
-- inside their statement budget even when every ciphertext is at its limit.
create or replace function private.rag_generation_attestation(
  owner_id uuid,
  generation_id_value text,
  attested_revision_token bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  index_digest_row record;
  row_digest_chain bytea;
  envelope_digest_chain bytea;
  key_reference_digest_chain bytea;
  entry_count integer := 0;
begin
  if owner_id is null
    or generation_id_value !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or attested_revision_token is null
    or attested_revision_token < 0
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where user_id = owner_id and id = generation_id_value;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  row_digest_chain := extensions.digest(
    'unfiled.rag-generation-row-chain.v1'::text, 'sha256'
  );
  envelope_digest_chain := extensions.digest(
    'unfiled.rag-generation-envelope-chain.v1'::text, 'sha256'
  );
  key_reference_digest_chain := extensions.digest(
    'unfiled.rag-generation-key-reference-chain.v1'::text, 'sha256'
  );

  for index_digest_row in
    select
      index_value.id,
      index_value.attestation_envelope_digest,
      index_value.attestation_key_reference_digest,
      index_value.attestation_row_digest
    from public.note_rag_index as index_value
    where index_value.user_id = owner_id
      and index_value.generation_id = generation_id_value
    order by index_value.id
  loop
    row_digest_chain := extensions.digest(
      row_digest_chain
        || decode(index_digest_row.attestation_row_digest, 'hex'),
      'sha256'
    );
    envelope_digest_chain := extensions.digest(
      envelope_digest_chain || extensions.digest(jsonb_build_object(
        'domain', 'unfiled.rag-generation-envelope-entry.v1',
        'indexId', index_digest_row.id,
        'envelopeDigest', index_digest_row.attestation_envelope_digest
      )::text, 'sha256'),
      'sha256'
    );
    key_reference_digest_chain := extensions.digest(
      key_reference_digest_chain || extensions.digest(jsonb_build_object(
        'domain', 'unfiled.rag-generation-key-reference-entry.v1',
        'indexId', index_digest_row.id,
        'keyReferenceDigest',
          index_digest_row.attestation_key_reference_digest
      )::text, 'sha256'),
      'sha256'
    );
    entry_count := entry_count + 1;
  end loop;

  return jsonb_build_object(
    'domain', 'unfiled.rag-generation-attestation.v1',
    'schemaVersion', 1,
    'ownerId', owner_id,
    'generationId', generation_row.id,
    'revisionToken', attested_revision_token,
    'embeddingModelId', generation_row.embedding_model_id,
    'embeddingDimensions', generation_row.embedding_dimensions,
    'envelopeSchemaVersion', generation_row.envelope_schema_version,
    'expectedNoteCount', generation_row.expected_note_count,
    'indexedNoteCount', generation_row.indexed_note_count,
    'entryCount', entry_count,
    'orderedDigestEntries', jsonb_build_object(
      'rowDigestChain', encode(row_digest_chain, 'hex'),
      'envelopeDigestChain', encode(envelope_digest_chain, 'hex'),
      'keyReferenceDigestChain', encode(key_reference_digest_chain, 'hex')
    )
  );
end;
$$;

-- One opaque UUID names one exact seed request. Persisting its content-free
-- response makes a response-lost retry distinguishable from a competing batch.
create table public.rag_index_generation_seed_batches (
  user_id uuid not null,
  generation_id text not null,
  batch_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, generation_id, batch_id),
  foreign key (user_id, generation_id)
    references public.rag_index_generations (user_id, id) on delete cascade,
  check (generation_id ~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (jsonb_typeof(response) = 'object')
);
alter table public.rag_index_generation_seed_batches enable row level security;
alter table public.rag_index_generation_seed_batches force row level security;
revoke all on table public.rag_index_generation_seed_batches
  from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;

-- Each phase has an independent durable scan checkpoint. A page request UUID
-- makes advancing that checkpoint response-loss safe; a bounded replay ledger
-- returns the exact content-free page when the caller retries the same request.
create table public.rag_index_maintenance_checkpoints (
  embedding_model_id text not null check (
    char_length(embedding_model_id) between 1 and 200
  ),
  embedding_dimensions integer not null check (
    embedding_dimensions between 1 and 4096
  ),
  phase text not null check (phase in ('seed', 'verify')),
  after_owner_id uuid,
  revision_token bigint not null default 0 check (revision_token >= 0),
  updated_at timestamptz not null default now(),
  primary key (embedding_model_id, embedding_dimensions, phase)
);
alter table public.rag_index_maintenance_checkpoints enable row level security;
alter table public.rag_index_maintenance_checkpoints force row level security;
revoke all on table public.rag_index_maintenance_checkpoints
  from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;

create table public.rag_index_maintenance_page_requests (
  embedding_model_id text not null,
  embedding_dimensions integer not null,
  phase text not null,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (
    embedding_model_id, embedding_dimensions, phase, request_id
  ),
  foreign key (embedding_model_id, embedding_dimensions, phase)
    references public.rag_index_maintenance_checkpoints (
      embedding_model_id, embedding_dimensions, phase
    ) on delete cascade
);
create index rag_index_maintenance_page_requests_created
  on public.rag_index_maintenance_page_requests (created_at);
alter table public.rag_index_maintenance_page_requests enable row level security;
alter table public.rag_index_maintenance_page_requests force row level security;
revoke all on table public.rag_index_maintenance_page_requests
  from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;

-- Keep the actionable-owner predicate in one implementation so pagination,
-- wrap, and has-more calculations cannot drift. An existing building row is
-- always returned once for reconciliation. Without one, durable blockers do
-- not occupy the fair queue until their readiness changes.
create function private.rag_index_maintenance_candidate_rows(
  p_embedding_model_id text,
  p_embedding_dimensions integer,
  p_after_owner_id uuid,
  p_limit integer
)
returns table (
  user_id uuid,
  rollout_state public.encryption_rollout_state,
  building_id text,
  building_model_id text,
  building_dimensions integer,
  building_revision_token bigint,
  building_expected_note_count integer,
  building_indexed_note_count integer,
  active_id text,
  active_model_id text,
  active_dimensions integer,
  active_revision_token bigint,
  eligible_note_count integer,
  key_ready boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    rollout.user_id,
    rollout.state,
    building.id,
    building.embedding_model_id,
    building.embedding_dimensions,
    building.revision_token,
    building.expected_note_count,
    building.indexed_note_count,
    active.id,
    active.embedding_model_id,
    active.embedding_dimensions,
    active.revision_token,
    eligible.eligible_note_count,
    key_state.key_ready
  from public.content_encryption_rollouts as rollout
  left join public.rag_index_generations as building
    on building.user_id = rollout.user_id and building.state = 'building'
  left join public.rag_index_generations as active
    on active.user_id = rollout.user_id and active.state = 'active'
  cross join lateral (
    select count(*)::integer as eligible_note_count
    from public.notes as note
    where note.user_id = rollout.user_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
  ) as eligible
  cross join lateral (
    select exists (
      select 1
      from public.user_content_keys as content_key
      where content_key.user_id = rollout.user_id
        and content_key.key_class = 'ai_assisted'
        and content_key.key_purpose = 'object_wrap'
        and content_key.state = 'active'
    ) as key_ready
  ) as key_state
  where (p_after_owner_id is null or rollout.user_id > p_after_owner_id)
    and (
      building.id is not null
      or (
        -- Admit 1,000 below 33 pages × 31 maximum-size rows = 1,023 slots.
        rollout.state <> 'expanded'
        and key_state.key_ready
        and eligible.eligible_note_count <= 1000
        and (
          active.id is null
          or active.embedding_model_id <> p_embedding_model_id
          or active.embedding_dimensions <> p_embedding_dimensions
          or active.envelope_schema_version <> 1
        )
      )
    )
  order by rollout.user_id
  limit p_limit;
$$;

create or replace function public.list_rag_index_maintenance_candidates(
  p_embedding_model_id text,
  p_embedding_dimensions integer,
  p_phase text,
  p_page_request_id uuid,
  p_cursor jsonb default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  checkpoint_row public.rag_index_maintenance_checkpoints%rowtype;
  request_row public.rag_index_maintenance_page_requests%rowtype;
  after_owner_id uuid;
  requested_checkpoint_revision bigint;
  next_checkpoint_revision bigint;
  request_hash_value text;
  candidates_value jsonb := '[]'::jsonb;
  returned_count integer := 0;
  last_owner_id uuid;
  has_more boolean := false;
  next_cursor_value jsonb;
  response_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_embedding_model_id is null
    or char_length(p_embedding_model_id) not between 1 and 200
    or p_embedding_dimensions is null
    or p_embedding_dimensions not between 1 and 4096
    or p_phase is null
    or p_phase not in ('seed', 'verify')
    or p_page_request_id is null
    or p_limit is null
    or p_limit not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or not private.jsonb_has_exact_keys(
        p_cursor,
        array[
          'embeddingModelId', 'embeddingDimensions', 'phase',
          'checkpointRevision', 'afterOwnerId'
        ]
      )
      or jsonb_typeof(p_cursor -> 'embeddingModelId') <> 'string'
      or jsonb_typeof(p_cursor -> 'embeddingDimensions') <> 'number'
      or jsonb_typeof(p_cursor -> 'phase') <> 'string'
      or jsonb_typeof(p_cursor -> 'checkpointRevision') <> 'string'
      or jsonb_typeof(p_cursor -> 'afterOwnerId') <> 'string'
      or p_cursor ->> 'embeddingModelId' <> p_embedding_model_id
      or p_cursor ->> 'embeddingDimensions' !~ '^[0-9]{1,4}$'
      or (p_cursor ->> 'embeddingDimensions')::integer
        <> p_embedding_dimensions
      or p_cursor ->> 'phase' <> p_phase
      or p_cursor ->> 'checkpointRevision' !~ '^(0|[1-9][0-9]{0,18})$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    requested_checkpoint_revision :=
      (p_cursor ->> 'checkpointRevision')::bigint;
    after_owner_id := (p_cursor ->> 'afterOwnerId')::uuid;
  end if;

  request_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.rag-maintenance-page-request.v1',
    'embeddingModelId', p_embedding_model_id,
    'embeddingDimensions', p_embedding_dimensions,
    'phase', p_phase,
    'requestId', p_page_request_id,
    'cursor', p_cursor,
    'limit', p_limit
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'unfiled.rag-maintenance-checkpoint.v1:' || p_embedding_model_id || ':'
      || p_embedding_dimensions::text || ':' || p_phase,
    0
  ));

  select * into request_row
  from public.rag_index_maintenance_page_requests
  where embedding_model_id = p_embedding_model_id
    and embedding_dimensions = p_embedding_dimensions
    and phase = p_phase
    and request_id = p_page_request_id;
  if found then
    if request_row.request_hash <> request_hash_value then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_set(
      request_row.response, '{page,replayed}', 'true'::jsonb, false
    );
  end if;

  insert into public.rag_index_maintenance_checkpoints (
    embedding_model_id, embedding_dimensions, phase
  ) values (
    p_embedding_model_id, p_embedding_dimensions, p_phase
  ) on conflict (embedding_model_id, embedding_dimensions, phase) do nothing;

  select * into checkpoint_row
  from public.rag_index_maintenance_checkpoints
  where embedding_model_id = p_embedding_model_id
    and embedding_dimensions = p_embedding_dimensions
    and phase = p_phase
  for update;

  if p_cursor is null then
    after_owner_id := checkpoint_row.after_owner_id;
  elsif checkpoint_row.revision_token <> requested_checkpoint_revision
    or checkpoint_row.after_owner_id is distinct from after_owner_id
  then
    raise exception using
      errcode = 'P0001', message = 'stale_maintenance_cursor';
  end if;

  -- A null-start request wraps only when the tail is empty. Explicit cursors
  -- never wrap within a traversal, so an owner cannot be returned twice.
  loop
    with maintenance as materialized (
      select *
      from private.rag_index_maintenance_candidate_rows(
        p_embedding_model_id, p_embedding_dimensions,
        after_owner_id, p_limit + 1
      )
    ), page as materialized (
      select * from maintenance order by user_id limit p_limit
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'ownerId', page.user_id,
        'rolloutState', page.rollout_state,
        'eligibleNoteCount', page.eligible_note_count,
        'aiObjectWrapKeyReady', page.key_ready,
        'action', case
          when page.building_id is null then 'create_build'
          when page.building_model_id = p_embedding_model_id
            and page.building_dimensions = p_embedding_dimensions
            then 'resume_build'
          else 'replace_build'
        end,
        'activeGeneration', case when page.active_id is null then null
          else jsonb_build_object(
            'generationId', page.active_id,
            'embeddingModelId', page.active_model_id,
            'embeddingDimensions', page.active_dimensions,
            'revisionToken', page.active_revision_token::text
          ) end,
        'buildingGeneration', case when page.building_id is null then null
          else jsonb_build_object(
            'generationId', page.building_id,
            'embeddingModelId', page.building_model_id,
            'embeddingDimensions', page.building_dimensions,
            'expectedNoteCount', page.building_expected_note_count,
            'indexedNoteCount', page.building_indexed_note_count,
            'revisionToken', page.building_revision_token::text
          ) end
      ) order by page.user_id), '[]'::jsonb),
      count(*)::integer,
      (array_agg(page.user_id order by page.user_id))[count(*)::integer],
      (select count(*) > p_limit from maintenance)
    into candidates_value, returned_count, last_owner_id, has_more
    from page;

    exit when returned_count > 0
      or p_cursor is not null
      or after_owner_id is null;
    after_owner_id := null;
  end loop;

  if checkpoint_row.revision_token = 9223372036854775807 then
    raise exception using errcode = 'P0001', message = 'revision_exhausted';
  end if;
  next_checkpoint_revision := checkpoint_row.revision_token + 1;

  update public.rag_index_maintenance_checkpoints
  set
    after_owner_id = case when returned_count = 0 then null
      else last_owner_id end,
    revision_token = next_checkpoint_revision,
    updated_at = clock_timestamp()
  where embedding_model_id = p_embedding_model_id
    and embedding_dimensions = p_embedding_dimensions
    and phase = p_phase;

  next_cursor_value := case when has_more then jsonb_build_object(
    'embeddingModelId', p_embedding_model_id,
    'embeddingDimensions', p_embedding_dimensions,
    'phase', p_phase,
    'checkpointRevision', next_checkpoint_revision::text,
    'afterOwnerId', last_owner_id
  ) else null end;

  response_value := jsonb_build_object(
    'target', jsonb_build_object(
      'embeddingModelId', p_embedding_model_id,
      'embeddingDimensions', p_embedding_dimensions,
      'envelopeSchemaVersion', 1,
      'phase', p_phase
    ),
    'candidates', candidates_value,
    'page', jsonb_build_object(
      'requestId', p_page_request_id,
      'checkpointRevision', next_checkpoint_revision::text,
      'limit', p_limit,
      'returnedCount', returned_count,
      'hasMore', has_more,
      'nextCursor', next_cursor_value,
      'replayed', false
    )
  );

  insert into public.rag_index_maintenance_page_requests (
    embedding_model_id, embedding_dimensions, phase,
    request_id, request_hash, response
  ) values (
    p_embedding_model_id, p_embedding_dimensions, p_phase,
    p_page_request_id, request_hash_value, response_value
  );

  -- Replay evidence is operational, content-free, and deliberately finite:
  -- retain at most 64 recent pages per target/phase and never beyond 24 hours.
  delete from public.rag_index_maintenance_page_requests
  where created_at < clock_timestamp() - interval '24 hours';
  delete from public.rag_index_maintenance_page_requests as old_request
  where old_request.embedding_model_id = p_embedding_model_id
    and old_request.embedding_dimensions = p_embedding_dimensions
    and old_request.phase = p_phase
    and old_request.request_id in (
      select retained.request_id
      from public.rag_index_maintenance_page_requests as retained
      where retained.embedding_model_id = p_embedding_model_id
        and retained.embedding_dimensions = p_embedding_dimensions
        and retained.phase = p_phase
      order by retained.created_at desc, retained.request_id desc
      offset 64
    );

  return response_value;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.ensure_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_embedding_model_id text,
  p_embedding_dimensions integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  eligible_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_embedding_model_id is null
    or char_length(p_embedding_model_id) not between 1 and 200
    or p_embedding_dimensions is null
    or p_embedding_dimensions not between 1 and 4096
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'unfiled.rag-generation-control.v1:' || p_owner_id::text, 0
  ));

  perform 1
  from public.content_encryption_rollouts
  where user_id = p_owner_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if not exists (
    select 1
    from public.user_content_keys
    where user_id = p_owner_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and state = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'active_ai_key_required';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where id = p_generation_id
  for update;

  if found then
    if generation_row.user_id <> p_owner_id
      or generation_row.embedding_model_id <> p_embedding_model_id
      or generation_row.embedding_dimensions <> p_embedding_dimensions
      or generation_row.envelope_schema_version <> 1
      or generation_row.state not in ('building', 'active')
    then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'generationId', generation_row.id,
      'state', generation_row.state,
      'embeddingModelId', generation_row.embedding_model_id,
      'embeddingDimensions', generation_row.embedding_dimensions,
      'envelopeSchemaVersion', generation_row.envelope_schema_version,
      'expectedNoteCount', generation_row.expected_note_count,
      'indexedNoteCount', generation_row.indexed_note_count,
      'revisionToken', generation_row.revision_token::text,
      'replayed', true
    );
  end if;

  perform 1
  from public.rag_index_generations
  where user_id = p_owner_id and state = 'building'
  for update;
  if found then
    raise exception using errcode = 'P0001', message = 'building_generation_exists';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  insert into public.rag_index_generations (
    id, user_id, embedding_model_id, embedding_dimensions,
    envelope_schema_version, state, expected_note_count
  ) values (
    p_generation_id, p_owner_id, p_embedding_model_id,
    p_embedding_dimensions, 1, 'building', eligible_count
  )
  returning * into generation_row;

  return jsonb_build_object(
    'generationId', generation_row.id,
    'state', generation_row.state,
    'embeddingModelId', generation_row.embedding_model_id,
    'embeddingDimensions', generation_row.embedding_dimensions,
    'envelopeSchemaVersion', generation_row.envelope_schema_version,
    'expectedNoteCount', generation_row.expected_note_count,
    'indexedNoteCount', generation_row.indexed_note_count,
    'revisionToken', generation_row.revision_token::text,
    'replayed', false
  );
end;
$$;

create or replace function public.seed_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_batch_id uuid,
  p_cursor jsonb default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  batch_row public.rag_index_generation_seed_batches%rowtype;
  after_note_id text;
  request_hash_value text;
  eligible_count integer := 0;
  examined_count integer := 0;
  enqueued_count integer := 0;
  last_note_id text;
  has_more boolean := false;
  next_revision_token bigint;
  next_cursor_value jsonb;
  response_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
    or p_batch_id is null
    or p_limit is null
    or p_limit not between 1 and 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or not private.jsonb_has_exact_keys(
        p_cursor, array['generationId', 'revisionToken', 'afterNoteId']
      )
      or jsonb_typeof(p_cursor -> 'generationId') <> 'string'
      or jsonb_typeof(p_cursor -> 'revisionToken') <> 'string'
      or jsonb_typeof(p_cursor -> 'afterNoteId') <> 'string'
      or p_cursor ->> 'generationId' <> p_generation_id
      or p_cursor ->> 'revisionToken' !~ '^[0-9]{1,19}$'
      or (p_cursor ->> 'revisionToken')::bigint
        <> p_expected_revision_token
      or p_cursor ->> 'afterNoteId' !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    after_note_id := p_cursor ->> 'afterNoteId';
  end if;

  request_hash_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.rag-generation-seed-batch.v1',
    'ownerId', p_owner_id,
    'generationId', p_generation_id,
    'expectedRevisionToken', p_expected_revision_token::text,
    'batchId', p_batch_id,
    'cursor', p_cursor,
    'limit', p_limit
  ));

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'unfiled.rag-generation-control.v1:' || p_owner_id::text, 0
  ));

  select * into batch_row
  from public.rag_index_generation_seed_batches
  where user_id = p_owner_id
    and generation_id = p_generation_id
    and batch_id = p_batch_id
  for update;

  if found then
    if batch_row.request_hash <> request_hash_value then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_set(batch_row.response, '{replayed}', 'true'::jsonb, false);
  end if;

  select * into generation_row
  from public.rag_index_generations
  where user_id = p_owner_id and id = p_generation_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if generation_row.state <> 'building'
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  if after_note_id is not null and not exists (
    select 1 from public.notes
    where user_id = p_owner_id and id = after_note_id
  ) then
    raise exception using errcode = 'P0001', message = 'stale_seed_cursor';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  -- A terminal job for the current revision cannot be re-enqueued because its
  -- uniqueness key is already consumed. Return a typed, replayable blocker so
  -- the controller can fail this shadow generation without confusing a data
  -- invariant with transient database/provider unavailability.
  if exists (
    select 1
    from public.notes as note
    join public.note_index_jobs as job
      on job.user_id = note.user_id
      and job.note_id = note.id
      and job.generation_id = p_generation_id
      and job.target_revision = note.current_revision
      and job.state in ('failed', 'succeeded')
    where note.user_id = p_owner_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and not exists (
        select 1
        from public.note_rag_index as index_row
        join public.user_content_keys as content_key
          on content_key.user_id = index_row.user_id
          and content_key.key_id = index_row.index_key_id
          and content_key.key_class = index_row.index_key_class
          and content_key.key_purpose = index_row.index_key_purpose
          and content_key.key_version = index_row.index_key_version
          and content_key.state in ('active', 'retired')
        where index_row.user_id = note.user_id
          and index_row.note_id = note.id
          and index_row.generation_id = p_generation_id
          and index_row.indexed_revision = note.current_revision
      )
  ) then
    response_value := jsonb_build_object(
      'batchId', p_batch_id,
      'generationId', p_generation_id,
      'revisionToken', generation_row.revision_token::text,
      'eligibleNoteCount', eligible_count,
      'examinedCount', 0,
      'enqueuedCount', 0,
      'hasMore', false,
      'complete', false,
      'nextCursor', null,
      'blocked', true,
      'failureCode', 'validation_failed',
      'replayed', false
    );
    insert into public.rag_index_generation_seed_batches (
      user_id, generation_id, batch_id, request_hash, response
    ) values (
      p_owner_id, p_generation_id, p_batch_id,
      request_hash_value, response_value
    );
    return response_value;
  end if;

  with candidates as materialized (
    select note.id, note.current_revision
    from public.notes as note
    where note.user_id = p_owner_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and (after_note_id is null or note.id > after_note_id)
      and not exists (
        select 1
        from public.note_rag_index as index_row
        join public.user_content_keys as content_key
          on content_key.user_id = index_row.user_id
          and content_key.key_id = index_row.index_key_id
          and content_key.key_class = index_row.index_key_class
          and content_key.key_purpose = index_row.index_key_purpose
          and content_key.key_version = index_row.index_key_version
          and content_key.state in ('active', 'retired')
        where index_row.user_id = note.user_id
          and index_row.note_id = note.id
          and index_row.generation_id = p_generation_id
          and index_row.indexed_revision = note.current_revision
      )
      and not exists (
        select 1
        from public.note_index_jobs as job
        where job.user_id = note.user_id
          and job.note_id = note.id
          and job.generation_id = p_generation_id
          and job.target_revision = note.current_revision
      )
    order by note.id
    limit p_limit + 1
  ), page as materialized (
    select * from candidates order by id limit p_limit
  ), inserted as (
    insert into public.note_index_jobs (
      user_id, note_id, generation_id, target_revision, index_resource_id
    )
    select
      p_owner_id, page.id, p_generation_id, page.current_revision,
      private.stable_note_rag_resource_id(
        p_owner_id, page.id, p_generation_id
      )
    from page
    on conflict (note_id, generation_id, target_revision) do nothing
    returning id
  )
  select
    (select count(*)::integer from page),
    (select count(*)::integer from inserted),
    (select id from page order by id desc limit 1),
    (select count(*) > p_limit from candidates)
  into examined_count, enqueued_count, last_note_id, has_more;

  if enqueued_count > 0
    or generation_row.expected_note_count <> eligible_count
  then
    update public.rag_index_generations
    set
      expected_note_count = eligible_count,
      revision_token = revision_token + 1
    where user_id = p_owner_id and id = p_generation_id
    returning revision_token into next_revision_token;
  else
    next_revision_token := generation_row.revision_token;
  end if;

  next_cursor_value := case when has_more then jsonb_build_object(
    'generationId', p_generation_id,
    'revisionToken', next_revision_token::text,
    'afterNoteId', last_note_id
  ) else null end;

  response_value := jsonb_build_object(
    'batchId', p_batch_id,
    'generationId', p_generation_id,
    'revisionToken', next_revision_token::text,
    'eligibleNoteCount', eligible_count,
    'examinedCount', examined_count,
    'enqueuedCount', enqueued_count,
    'hasMore', has_more,
    'complete', not has_more,
    'nextCursor', next_cursor_value,
    'blocked', false,
    'failureCode', null,
    'replayed', false
  );

  insert into public.rag_index_generation_seed_batches (
    user_id, generation_id, batch_id, request_hash, response
  ) values (
    p_owner_id, p_generation_id, p_batch_id,
    request_hash_value, response_value
  );

  return response_value;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.fail_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_failure_code public.safe_error_code
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
    or p_failure_code is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'unfiled.rag-generation-control.v1:' || p_owner_id::text, 0
  ));

  select * into generation_row
  from public.rag_index_generations
  where user_id = p_owner_id and id = p_generation_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if generation_row.state = 'failed'
    and generation_row.revision_token = p_expected_revision_token + 1
  then
    if generation_row.failure_code <> p_failure_code then
      raise exception using
        errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'generationId', generation_row.id,
      'state', generation_row.state,
      'revisionToken', generation_row.revision_token::text,
      'failureCode', generation_row.failure_code,
      'replayed', true
    );
  end if;

  if generation_row.state <> 'building'
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  update public.rag_index_generations
  set
    state = 'failed',
    failed_at = clock_timestamp(),
    failure_code = p_failure_code,
    revision_token = revision_token + 1
  where user_id = p_owner_id and id = p_generation_id
  returning * into generation_row;

  delete from public.rag_index_generation_verifications
  where user_id = p_owner_id and generation_id = p_generation_id;

  return jsonb_build_object(
    'generationId', generation_row.id,
    'state', generation_row.state,
    'revisionToken', generation_row.revision_token::text,
    'failureCode', generation_row.failure_code,
    'replayed', false
  );
end;
$$;

-- Preserve the reviewed activation implementation behind a precision-safe
-- wrapper. PostgreSQL bigint tokens cross the HTTP boundary only as canonical
-- decimal strings.
alter function public.activate_rag_index_generation(uuid, text, bigint)
  set schema private;
alter function private.activate_rag_index_generation(uuid, text, bigint)
  rename to activate_rag_index_generation_impl;

create function public.activate_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  result_value := private.activate_rag_index_generation_impl(
    p_owner_id, p_generation_id, p_expected_revision_token
  );
  return jsonb_set(
    result_value,
    '{revisionToken}',
    to_jsonb(result_value ->> 'revisionToken'),
    false
  );
end;
$$;

-- Preserve the reviewed verification implementation behind an exact-session
-- wrapper. SECURITY DEFINER changes current_user to the function owner, so the
-- wrapper authenticates the original login through session_user and rejects
-- any SET ROLE state. The verifier process separately checks both identity
-- values on connection before it invokes either capability.
alter function public.verify_rag_index_generation(uuid, text, bigint, jsonb)
  set schema private;
alter function private.verify_rag_index_generation(uuid, text, bigint, jsonb)
  rename to verify_rag_index_generation_impl;

create function public.verify_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_attestation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
begin
  if session_user <> 'unfiled_rag_verifier'
    or current_setting('role', true) not in ('none', 'unfiled_rag_verifier')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  result_value := private.verify_rag_index_generation_impl(
    p_owner_id, p_generation_id, p_expected_revision_token, p_attestation
  );
  return jsonb_set(
    result_value,
    '{revisionToken}',
    to_jsonb(result_value ->> 'revisionToken'),
    false
  );
end;
$$;

create or replace function public.list_building_note_rag_index(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_cursor jsonb default null,
  p_limit integer default 25,
  p_ciphertext_byte_budget integer default 1048576
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  after_index_id text;
  returned_count integer := 0;
  returned_bytes integer := 0;
  page_index_ids text[];
  last_index_id text;
  has_more boolean := false;
  items_value jsonb := '[]'::jsonb;
  keys_value jsonb := '[]'::jsonb;
  next_cursor_value jsonb;
  attestation_value jsonb;
  verification_value jsonb;
begin
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
    or p_limit is null
    or p_limit not between 1 and 50
    or p_ciphertext_byte_budget is null
    or p_ciphertext_byte_budget not between 262160 and 8388608
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or not private.jsonb_has_exact_keys(
        p_cursor, array['generationId', 'revisionToken', 'afterIndexId']
      )
      or jsonb_typeof(p_cursor -> 'generationId') <> 'string'
      or jsonb_typeof(p_cursor -> 'revisionToken') <> 'string'
      or jsonb_typeof(p_cursor -> 'afterIndexId') <> 'string'
      or p_cursor ->> 'generationId' <> p_generation_id
      or p_cursor ->> 'revisionToken' !~ '^[0-9]{1,19}$'
      or (p_cursor ->> 'revisionToken')::bigint
        <> p_expected_revision_token
      or p_cursor ->> 'afterIndexId' !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    after_index_id := p_cursor ->> 'afterIndexId';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where user_id = p_owner_id and id = p_generation_id
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if generation_row.state <> 'building'
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  if after_index_id is not null and not exists (
    select 1
    from public.note_rag_index
    where user_id = p_owner_id
      and generation_id = p_generation_id
      and id = after_index_id
  ) then
    raise exception using errcode = 'P0001', message = 'stale_rag_cursor';
  end if;

  with ordered_rows as (
    select
      index_row.*,
      sum(index_row.encrypted_byte_length) over (
        order by index_row.id rows unbounded preceding
      ) as running_bytes
    from public.note_rag_index as index_row
    where index_row.user_id = p_owner_id
      and index_row.generation_id = p_generation_id
      and (after_index_id is null or index_row.id > after_index_id)
  ), page_rows as (
    select *
    from ordered_rows
    where running_bytes <= p_ciphertext_byte_budget
    order by id
    limit p_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'indexId', page.id,
      'noteId', page.note_id,
      'indexedRevision', page.indexed_revision,
      'cipher', private.encrypted_cipher_projection(
        page.index_envelope, page.index_key_id, page.index_key_class,
        page.index_key_purpose, page.index_key_version
      ),
      'encryptedByteLength', page.encrypted_byte_length
    ) order by page.id), '[]'::jsonb),
    coalesce(array_agg(page.id order by page.id), array[]::text[]),
    count(*)::integer,
    coalesce(sum(page.encrypted_byte_length), 0)::integer
  into items_value, page_index_ids, returned_count, returned_bytes
  from page_rows as page;

  if returned_count > 0 then
    last_index_id := page_index_ids[returned_count];

    select coalesce(jsonb_agg(
      private.content_key_service_projection(key_row) order by key_row.key_id
    ), '[]'::jsonb)
    into keys_value
    from public.user_content_keys as key_row
    join (
      select distinct
        index_row.user_id,
        index_row.index_key_id,
        index_row.index_key_class,
        index_row.index_key_purpose,
        index_row.index_key_version
      from public.note_rag_index as index_row
      where index_row.user_id = p_owner_id
        and index_row.generation_id = p_generation_id
        and index_row.id = any(page_index_ids)
    ) as page_key
      on page_key.user_id = key_row.user_id
      and page_key.index_key_id = key_row.key_id
      and page_key.index_key_class = key_row.key_class
      and page_key.index_key_purpose = key_row.key_purpose
      and page_key.index_key_version = key_row.key_version
    where key_row.user_id = p_owner_id
      and key_row.key_class = 'ai_assisted'
      and key_row.key_purpose = 'object_wrap'
      and key_row.state in ('active', 'retired');

    has_more := exists (
      select 1
      from public.note_rag_index
      where user_id = p_owner_id
        and generation_id = p_generation_id
        and id > last_index_id
    );
  end if;

  next_cursor_value := case when has_more then jsonb_build_object(
    'generationId', generation_row.id,
    'revisionToken', generation_row.revision_token::text,
    'afterIndexId', last_index_id
  ) else null end;

  -- Every page is pinned to the same generation revision. The full manifest
  -- is needed only once, on the terminal page; final verification recomputes
  -- it under the same revision CAS before publishing evidence.
  if not has_more then
    attestation_value := private.rag_generation_attestation(
      p_owner_id, p_generation_id, p_expected_revision_token
    );
    verification_value := jsonb_build_object(
      'domain', 'unfiled.rag-generation-verification.v1',
      'attestationDigest', private.request_hash(attestation_value)
    );
  else
    verification_value := null;
  end if;

  return jsonb_build_object(
    'ownerId', p_owner_id,
    'generation', jsonb_build_object(
      'generationId', generation_row.id,
      'state', generation_row.state,
      'embeddingModelId', generation_row.embedding_model_id,
      'embeddingDimensions', generation_row.embedding_dimensions,
      'envelopeSchemaVersion', generation_row.envelope_schema_version,
      'expectedNoteCount', generation_row.expected_note_count,
      'indexedNoteCount', generation_row.indexed_note_count,
      'revisionToken', generation_row.revision_token::text
    ),
    'items', items_value,
    'keys', keys_value,
    'page', jsonb_build_object(
      'limit', p_limit,
      'ciphertextByteBudget', p_ciphertext_byte_budget,
      'returnedCount', returned_count,
      'ciphertextBytes', returned_bytes,
      'hasMore', has_more,
      'nextCursor', next_cursor_value
    ),
    'verification', verification_value
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

alter function public.list_building_note_rag_index(
  uuid, text, bigint, jsonb, integer, integer
) set schema private;
alter function private.list_building_note_rag_index(
  uuid, text, bigint, jsonb, integer, integer
) rename to list_building_note_rag_index_impl;

create function public.list_building_note_rag_index(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint,
  p_cursor jsonb default null,
  p_limit integer default 25,
  p_ciphertext_byte_budget integer default 1048576
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_rag_verifier'
    or current_setting('role', true) not in ('none', 'unfiled_rag_verifier')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.list_building_note_rag_index_impl(
    p_owner_id, p_generation_id, p_expected_revision_token,
    p_cursor, p_limit, p_ciphertext_byte_budget
  );
end;
$$;

-- Rebuild explicit allowlists after PostgreSQL's default function grant.
revoke execute on function public.list_rag_index_maintenance_candidates(
  text, integer, text, uuid, jsonb, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.ensure_rag_index_generation(
  uuid, text, text, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.seed_rag_index_generation(
  uuid, text, bigint, uuid, jsonb, integer
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.fail_rag_index_generation(
  uuid, text, bigint, public.safe_error_code
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function public.list_building_note_rag_index(
  uuid, text, bigint, jsonb, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function public.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier;
revoke execute on function private.activate_rag_index_generation_impl(
  uuid, text, bigint
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.list_building_note_rag_index_impl(
  uuid, text, bigint, jsonb, integer, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.verify_rag_index_generation_impl(
  uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.rag_index_attestation_envelope_digest(jsonb)
  from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.rag_index_attestation_key_reference_digest(
  uuid, text, public.content_key_class, public.content_key_purpose, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.rag_index_attestation_row_digest(
  uuid, text, text, text, integer, jsonb, text,
  public.content_key_class, public.content_key_purpose, integer, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;
revoke execute on function private.rag_index_maintenance_candidate_rows(
  text, integer, uuid, integer
) from public, anon, authenticated, service_role,
  unfiled_index_worker, unfiled_rag_verifier;

grant execute on function public.list_rag_index_maintenance_candidates(
  text, integer, text, uuid, jsonb, integer
) to service_role;
grant execute on function public.ensure_rag_index_generation(
  uuid, text, text, integer
) to service_role;
grant execute on function public.seed_rag_index_generation(
  uuid, text, bigint, uuid, jsonb, integer
) to service_role;
grant execute on function public.fail_rag_index_generation(
  uuid, text, bigint, public.safe_error_code
) to service_role;
grant execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) to service_role;

revoke all privileges on all tables in schema public
from unfiled_rag_verifier;
revoke all privileges on all sequences in schema public
from unfiled_rag_verifier;
revoke all privileges on all tables in schema private
from unfiled_rag_verifier;
revoke all privileges on all sequences in schema private
from unfiled_rag_verifier;
revoke execute on all functions in schema public
from unfiled_rag_verifier;
revoke execute on all functions in schema private
from unfiled_rag_verifier;
revoke all privileges on schema private
from unfiled_rag_verifier;
revoke create on schema public
from unfiled_rag_verifier;
grant usage on schema public
to unfiled_rag_verifier;
grant execute on function public.list_building_note_rag_index(
  uuid, text, bigint, jsonb, integer, integer
) to unfiled_rag_verifier;
grant execute on function public.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) to unfiled_rag_verifier;
