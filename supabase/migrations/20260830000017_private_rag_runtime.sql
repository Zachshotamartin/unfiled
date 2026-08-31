-- Milestone C.5c: private encrypted RAG runtime.
--
-- The dedicated index worker retains exactly six reviewed RPC capabilities.
-- It never receives relation access, a generic key lookup, generation
-- administration, or a private-manual key. Index documents remain ciphertext;
-- every lease reserves one AI object-wrap operation before the worker seals it.

-- Generation activation is attested by a second, non-bypass capability role.
-- It begins NOLOGIN and with no workload-usable members. Production must
-- provision the verifier itself as the exact TLS-only controller login rather
-- than grant it to a parent workload identity. A service-role caller cannot
-- mint verification evidence merely by supplying a well-shaped digest.
do $dedicated_rag_verifier$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'unfiled_rag_verifier'
  ) then
    execute 'create role unfiled_rag_verifier '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  else
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'unfiled_rag_verifier'
        and not rolsuper
        and (
          rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
          or rolreplication or rolbypassrls
        )
    ) then
      execute 'alter role unfiled_rag_verifier '
        || 'nocreatedb nocreaterole noinherit nologin '
        || 'noreplication nobypassrls';
    end if;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'unfiled_rag_verifier'
      and (
        rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
        or rolreplication or rolbypassrls
      )
  ) then
    raise exception using
      errcode = '42501', message = 'verifier_role_attributes_not_reconciled';
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
      member.rolname = 'unfiled_rag_verifier'
      or granted.rolname = 'unfiled_rag_verifier'
    )
      and not (
        granted.rolname = 'unfiled_rag_verifier'
        and member.rolname = 'postgres'
        and grantor.rolname = 'supabase_admin'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
  ) then
    raise exception using
      errcode = '42501', message = 'verifier_role_membership_not_reconciled';
  end if;
end;
$dedicated_rag_verifier$;

alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index'
    )
  );

alter table public.note_index_jobs
  add column target_reservation_id uuid,
  add column target_key_id text,
  add column target_key_class public.content_key_class,
  add column target_key_purpose public.content_key_purpose,
  add column target_key_version integer,
  add column target_reservation_attempt integer,
  add column target_reservation_lease_token uuid,
  add constraint note_index_jobs_target_key_shape check (
    (
      target_reservation_id is null
      and target_key_id is null
      and target_key_class is null
      and target_key_purpose is null
      and target_key_version is null
      and target_reservation_attempt is null
      and target_reservation_lease_token is null
    )
    or (
      target_reservation_id is not null
      and target_key_id is not null
      and target_key_class = 'ai_assisted'
      and target_key_purpose = 'object_wrap'
      and target_key_version >= 1
      and target_reservation_attempt between 1 and 5
      and target_reservation_lease_token is not null
    )
  ),
  add constraint note_index_jobs_target_reservation_fkey foreign key (
    user_id, target_reservation_id
  ) references public.content_key_operation_reservations (
    user_id, reservation_id
  ) deferrable initially deferred,
  add constraint note_index_jobs_target_key_fkey foreign key (
    user_id, target_key_id, target_key_class,
    target_key_purpose, target_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;
create unique index note_index_jobs_target_reservation_unique
  on public.note_index_jobs (user_id, target_reservation_id)
  where target_reservation_id is not null;

-- A generation/note pair owns one stable envelope resource ID across every
-- revision. Reconcile expand-era jobs deterministically before enforcing it.
with canonical_resource as (
  select
    job.user_id,
    job.note_id,
    job.generation_id,
    coalesce(
      max(index_row.id),
      (array_agg(job.index_resource_id order by job.created_at, job.id))[1]
    ) as index_resource_id
  from public.note_index_jobs as job
  left join public.note_rag_index as index_row
    on index_row.user_id = job.user_id
    and index_row.note_id = job.note_id
    and index_row.generation_id = job.generation_id
  group by job.user_id, job.note_id, job.generation_id
)
update public.note_index_jobs as job
set index_resource_id = canonical_resource.index_resource_id
from canonical_resource
where job.user_id = canonical_resource.user_id
  and job.note_id = canonical_resource.note_id
  and job.generation_id = canonical_resource.generation_id
  and job.index_resource_id <> canonical_resource.index_resource_id;

create or replace function private.stable_note_rag_resource_id(
  owner_id uuid,
  note_id_value text,
  generation_id_value text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  resource_id_value text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    owner_id::text || ':' || note_id_value || ':' || generation_id_value
      || ':rag-resource',
    0
  ));

  select index_row.id into resource_id_value
  from public.note_rag_index as index_row
  where index_row.user_id = owner_id
    and index_row.note_id = note_id_value
    and index_row.generation_id = generation_id_value;

  if resource_id_value is null then
    select job.index_resource_id into resource_id_value
    from public.note_index_jobs as job
    where job.user_id = owner_id
      and job.note_id = note_id_value
      and job.generation_id = generation_id_value
    order by job.created_at, job.id
    limit 1;
  end if;

  return coalesce(resource_id_value, public.new_entity_id('irw'));
end;
$$;

create or replace function private.enforce_note_index_resource_stability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_resource_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.user_id::text || ':' || new.note_id || ':' || new.generation_id
      || ':rag-resource',
    0
  ));

  select index_row.id into canonical_resource_id
  from public.note_rag_index as index_row
  where index_row.user_id = new.user_id
    and index_row.note_id = new.note_id
    and index_row.generation_id = new.generation_id;

  if canonical_resource_id is null then
    select job.index_resource_id into canonical_resource_id
    from public.note_index_jobs as job
    where job.user_id = new.user_id
      and job.note_id = new.note_id
      and job.generation_id = new.generation_id
      and job.id <> new.id
    order by job.created_at, job.id
    limit 1;
  end if;

  if canonical_resource_id is not null
    and canonical_resource_id <> new.index_resource_id
  then
    raise exception using
      errcode = '23514', message = 'unstable_index_resource';
  end if;

  return new;
end;
$$;

create or replace function private.enforce_rag_index_resource_stability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_resource_id text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.user_id::text || ':' || new.note_id || ':' || new.generation_id
      || ':rag-resource',
    0
  ));

  select job.index_resource_id into canonical_resource_id
  from public.note_index_jobs as job
  where job.user_id = new.user_id
    and job.note_id = new.note_id
    and job.generation_id = new.generation_id
  order by job.created_at, job.id
  limit 1;

  if canonical_resource_id is not null
    and canonical_resource_id <> new.id
  then
    raise exception using
      errcode = '23514', message = 'unstable_index_resource';
  end if;

  return new;
end;
$$;

create trigger note_rag_index_enforce_resource_stability
before insert or update of id, user_id, note_id, generation_id
on public.note_rag_index
for each row execute function private.enforce_rag_index_resource_stability();

create or replace function private.invalidate_rag_generation_for_revoked_key()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'revoked' and old.state <> 'revoked' then
    update public.rag_index_generations as generation
    set revision_token = generation.revision_token + 1
    where generation.user_id = new.user_id
      and generation.state in ('building', 'active')
      and (
        exists (
          select 1
          from public.note_rag_index as index_row
          where index_row.user_id = new.user_id
            and index_row.generation_id = generation.id
            and index_row.index_key_id = new.key_id
            and index_row.index_key_class = new.key_class
            and index_row.index_key_purpose = new.key_purpose
            and index_row.index_key_version = new.key_version
        )
      );
  end if;
  return new;
end;
$$;

create trigger user_content_keys_invalidate_rag_generation
after update of state on public.user_content_keys
for each row
when (old.state is distinct from new.state)
execute function private.invalidate_rag_generation_for_revoked_key();

create table public.rag_index_generation_verifications (
  user_id uuid not null references auth.users(id) on delete cascade,
  generation_id text not null,
  revision_token bigint not null check (revision_token >= 0),
  verified_note_count integer not null check (verified_note_count >= 0),
  attestation jsonb not null,
  attestation_digest text not null check (attestation_digest ~ '^[0-9a-f]{64}$'),
  attestation_domain text not null check (
    attestation_domain = 'unfiled.rag-generation-attestation.v1'
  ),
  embedding_model_id text not null check (
    char_length(embedding_model_id) between 1 and 200
  ),
  embedding_dimensions integer not null check (
    embedding_dimensions between 1 and 4096
  ),
  envelope_schema_version integer not null check (
    envelope_schema_version = 1
  ),
  verified_at timestamptz not null default now(),
  primary key (user_id, generation_id),
  foreign key (user_id, generation_id)
    references public.rag_index_generations (user_id, id) on delete cascade
);
alter table public.rag_index_generation_verifications enable row level security;
alter table public.rag_index_generation_verifications force row level security;
revoke all on table public.rag_index_generation_verifications
  from public, anon, authenticated, service_role, unfiled_index_worker;

-- Build bounded-memory ordered digest chains for every generation row. Each
-- logical entry separately hashes the canonical envelope and owner-scoped key
-- reference, then binds them (plus row identity/revision/length) into a row
-- digest. The outer JSON binds all three ordered chains, the generation contract,
-- and verifier-observed revision token. The separately authenticated verifier
-- role is the attestation authority: its exact capability call publishes only
-- the canonical manifest and digest recomputed by this database.
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
  index_row public.note_rag_index%rowtype;
  envelope_digest_value text;
  key_reference_digest_value text;
  row_digest_value text;
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
  for index_row in
    select index_value.*
    from public.note_rag_index as index_value
    where index_value.user_id = owner_id
      and index_value.generation_id = generation_id_value
    order by index_value.id
  loop
    envelope_digest_value := encode(
      extensions.digest(index_row.index_envelope::text, 'sha256'), 'hex'
    );
    key_reference_digest_value := encode(extensions.digest(jsonb_build_object(
      'domain', 'unfiled.rag-generation-key-reference.v1',
      'ownerId', owner_id,
      'keyId', index_row.index_key_id,
      'keyClass', index_row.index_key_class,
      'keyPurpose', index_row.index_key_purpose,
      'keyVersion', index_row.index_key_version
    )::text, 'sha256'), 'hex');
    row_digest_value := encode(extensions.digest(jsonb_build_object(
      'domain', 'unfiled.rag-generation-row.v1',
      'ownerId', owner_id,
      'generationId', generation_id_value,
      'indexId', index_row.id,
      'noteId', index_row.note_id,
      'indexedRevision', index_row.indexed_revision,
      'envelopeDigest', envelope_digest_value,
      'keyReferenceDigest', key_reference_digest_value,
      'encryptedByteLength', index_row.encrypted_byte_length
    )::text, 'sha256'), 'hex');
    row_digest_chain := extensions.digest(
      row_digest_chain || decode(row_digest_value, 'hex'), 'sha256'
    );
    envelope_digest_chain := extensions.digest(
      envelope_digest_chain || extensions.digest(jsonb_build_object(
        'domain', 'unfiled.rag-generation-envelope-entry.v1',
        'indexId', index_row.id,
        'envelopeDigest', envelope_digest_value
      )::text, 'sha256'),
      'sha256'
    );
    key_reference_digest_chain := extensions.digest(
      key_reference_digest_chain || extensions.digest(jsonb_build_object(
        'domain', 'unfiled.rag-generation-key-reference-entry.v1',
        'indexId', index_row.id,
        'keyReferenceDigest', key_reference_digest_value
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

create or replace function public.verify_rag_index_generation(
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
  generation_row public.rag_index_generations%rowtype;
  eligible_count integer;
  covered_count integer;
  total_index_count integer;
  pending_count integer;
  attestation_value jsonb;
  attestation_digest_value text;
begin
  if session_user <> 'unfiled_rag_verifier'
    and (
      current_setting('role', true) is distinct from 'unfiled_rag_verifier'
      or not pg_has_role(
        session_user, 'unfiled_rag_verifier', 'MEMBER'
      )
    )
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
    or p_attestation is null
    or jsonb_typeof(p_attestation) <> 'object'
    or not private.jsonb_has_exact_keys(
      p_attestation,
      array['domain', 'attestationDigest']
    )
    or p_attestation ->> 'domain'
      <> 'unfiled.rag-generation-verification.v1'
    or jsonb_typeof(p_attestation -> 'attestationDigest') <> 'string'
    or p_attestation ->> 'attestationDigest' !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where id = p_generation_id and user_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if generation_row.state not in ('building', 'active')
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  select
    count(*) filter (
      where note.deleted_at is null
        and note.privacy = 'ai_assisted'
        and note.current_revision = index_row.indexed_revision
        and content_key.state in ('active', 'retired')
    )::integer,
    count(*)::integer
  into covered_count, total_index_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id and note.user_id = index_row.user_id
  join public.user_content_keys as content_key
    on content_key.user_id = index_row.user_id
    and content_key.key_id = index_row.index_key_id
    and content_key.key_class = index_row.index_key_class
    and content_key.key_purpose = index_row.index_key_purpose
    and content_key.key_version = index_row.index_key_version
  where index_row.generation_id = p_generation_id
    and index_row.user_id = p_owner_id;

  select count(*)::integer into pending_count
  from public.note_index_jobs
  where generation_id = p_generation_id
    and user_id = p_owner_id
    and state in ('queued', 'leased');

  if generation_row.expected_note_count <> eligible_count
    or generation_row.indexed_note_count <> eligible_count
    or covered_count <> eligible_count
    or total_index_count <> eligible_count
    or pending_count <> 0
  then
    raise exception using
      errcode = 'P0001', message = 'incomplete_index_coverage';
  end if;

  attestation_value := private.rag_generation_attestation(
    p_owner_id, p_generation_id, p_expected_revision_token
  );
  attestation_digest_value := private.request_hash(attestation_value);
  if p_attestation ->> 'attestationDigest' <> attestation_digest_value then
    raise exception using
      errcode = 'P0001', message = 'invalid_generation_attestation';
  end if;

  insert into public.rag_index_generation_verifications (
    user_id, generation_id, revision_token, verified_note_count,
    attestation, attestation_digest, attestation_domain,
    embedding_model_id, embedding_dimensions,
    envelope_schema_version
  ) values (
    p_owner_id, p_generation_id, p_expected_revision_token, eligible_count,
    attestation_value, attestation_digest_value,
    'unfiled.rag-generation-attestation.v1',
    generation_row.embedding_model_id, generation_row.embedding_dimensions,
    generation_row.envelope_schema_version
  )
  on conflict (user_id, generation_id) do update set
    revision_token = excluded.revision_token,
    verified_note_count = excluded.verified_note_count,
    attestation = excluded.attestation,
    attestation_digest = excluded.attestation_digest,
    attestation_domain = excluded.attestation_domain,
    embedding_model_id = excluded.embedding_model_id,
    embedding_dimensions = excluded.embedding_dimensions,
    envelope_schema_version = excluded.envelope_schema_version,
    verified_at = clock_timestamp();

  return jsonb_build_object(
    'generationId', p_generation_id,
    'revisionToken', p_expected_revision_token,
    'verifiedNoteCount', eligible_count,
    'attestationDomain', 'unfiled.rag-generation-attestation.v1',
    'attestationDigest', attestation_digest_value,
    'embeddingModelId', generation_row.embedding_model_id,
    'embeddingDimensions', generation_row.embedding_dimensions,
    'envelopeSchemaVersion', generation_row.envelope_schema_version,
    'verified', true
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.activate_rag_index_generation(
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
  generation_row public.rag_index_generations%rowtype;
  verification_row public.rag_index_generation_verifications%rowtype;
  eligible_count integer;
  covered_count integer;
  total_index_count integer;
  current_attestation jsonb;
  current_attestation_digest text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id is null
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where id = p_generation_id and user_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into verification_row
  from public.rag_index_generation_verifications
  where user_id = p_owner_id and generation_id = p_generation_id
  for update;

  if verification_row.generation_id is not null then
    current_attestation := private.rag_generation_attestation(
      p_owner_id, p_generation_id, p_expected_revision_token
    );
    current_attestation_digest := private.request_hash(current_attestation);
  end if;

  if generation_row.state = 'active'
    and generation_row.revision_token = p_expected_revision_token + 1
    and verification_row.revision_token = generation_row.revision_token
    and verification_row.attestation = current_attestation
    and verification_row.attestation_digest = current_attestation_digest
  then
    return jsonb_build_object(
      'generationId', generation_row.id,
      'revisionToken', generation_row.revision_token,
      'coverageVerified', true,
      'replayed', true
    );
  end if;
  if generation_row.state <> 'building'
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  if verification_row.generation_id is null
    or verification_row.revision_token <> p_expected_revision_token
    or verification_row.attestation_domain
      <> 'unfiled.rag-generation-attestation.v1'
    or verification_row.attestation <> current_attestation
    or verification_row.attestation_digest <> current_attestation_digest
    or verification_row.embedding_model_id
      <> generation_row.embedding_model_id
    or verification_row.embedding_dimensions
      <> generation_row.embedding_dimensions
    or verification_row.envelope_schema_version
      <> generation_row.envelope_schema_version
  then
    raise exception using
      errcode = 'P0001', message = 'generation_not_verified';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  select
    count(*) filter (
      where note.deleted_at is null
        and note.privacy = 'ai_assisted'
        and note.current_revision = index_row.indexed_revision
        and content_key.state in ('active', 'retired')
    )::integer,
    count(*)::integer
  into covered_count, total_index_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id and note.user_id = index_row.user_id
  join public.user_content_keys as content_key
    on content_key.user_id = index_row.user_id
    and content_key.key_id = index_row.index_key_id
    and content_key.key_class = index_row.index_key_class
    and content_key.key_purpose = index_row.index_key_purpose
    and content_key.key_version = index_row.index_key_version
  where index_row.generation_id = p_generation_id
    and index_row.user_id = p_owner_id;

  if generation_row.expected_note_count <> eligible_count
    or generation_row.indexed_note_count <> eligible_count
    or verification_row.verified_note_count <> eligible_count
    or covered_count <> eligible_count
    or total_index_count <> eligible_count
    or exists (
      select 1 from public.note_index_jobs
      where generation_id = p_generation_id
        and user_id = p_owner_id
        and state in ('queued', 'leased')
    )
  then
    raise exception using
      errcode = 'P0001', message = 'incomplete_index_coverage';
  end if;

  update public.rag_index_generations
  set state = 'retired', retired_at = now(), revision_token = revision_token + 1
  where user_id = p_owner_id and state = 'active' and id <> p_generation_id;

  update public.rag_index_generations
  set
    state = 'active',
    indexed_note_count = covered_count,
    activated_at = now(),
    revision_token = revision_token + 1
  where id = p_generation_id and user_id = p_owner_id
  returning * into generation_row;

  update public.rag_index_generation_verifications
  set revision_token = generation_row.revision_token
  where user_id = p_owner_id and generation_id = p_generation_id;

  return jsonb_build_object(
    'generationId', generation_row.id,
    'revisionToken', generation_row.revision_token,
    'coverageVerified', true,
    'replayed', false
  );
end;
$$;

drop function public.list_active_note_rag_index(uuid, text, integer);

create function public.list_active_note_rag_index(
  p_owner_id uuid,
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
  cursor_generation_id text;
  cursor_revision_token bigint;
  after_index_id text;
  eligible_count integer;
  covered_count integer;
  repair_count integer;
  pending_job_count integer;
  returned_count integer := 0;
  returned_bytes integer := 0;
  page_index_ids text[];
  last_index_id text;
  has_more boolean := false;
  coverage_verified boolean := false;
  coverage_complete boolean := false;
  items_value jsonb := '[]'::jsonb;
  keys_value jsonb := '[]'::jsonb;
  repair_candidates_value jsonb := '[]'::jsonb;
  next_cursor_value jsonb;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
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
      or jsonb_typeof(p_cursor -> 'revisionToken') <> 'number'
      or jsonb_typeof(p_cursor -> 'afterIndexId') <> 'string'
      or p_cursor ->> 'generationId' !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
      or p_cursor ->> 'revisionToken' !~ '^[0-9]{1,19}$'
      or p_cursor ->> 'afterIndexId' !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    cursor_generation_id := p_cursor ->> 'generationId';
    cursor_revision_token := (p_cursor ->> 'revisionToken')::bigint;
    after_index_id := p_cursor ->> 'afterIndexId';

    select * into generation_row
    from public.rag_index_generations as generation
    where generation.user_id = p_owner_id
      and generation.id = cursor_generation_id
    for share of generation;

    if not found
      or generation_row.state <> 'active'
      or generation_row.revision_token <> cursor_revision_token
      or not exists (
        select 1 from public.note_rag_index as index_row
        where index_row.user_id = p_owner_id
          and index_row.generation_id = cursor_generation_id
          and index_row.id = after_index_id
      )
    then
      raise exception using errcode = 'P0001', message = 'stale_rag_cursor';
    end if;
  else
    select * into generation_row
    from public.rag_index_generations as generation
    where generation.user_id = p_owner_id and generation.state = 'active'
    for share of generation;
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  if generation_row.id is null then
    select count(*)::integer into repair_count
    from (
      select 1
      from public.notes
      where user_id = p_owner_id
        and privacy = 'ai_assisted'
        and deleted_at is null
      limit 51
    ) as repair;

    select coalesce(jsonb_agg(jsonb_build_object(
      'noteId', repair.note_id,
      'currentRevision', repair.current_revision,
      'updatedAt', repair.updated_at
    ) order by repair.updated_at desc, repair.note_id), '[]'::jsonb)
    into repair_candidates_value
    from (
      select note.id as note_id, note.current_revision, note.updated_at
      from public.notes as note
      where note.user_id = p_owner_id
        and note.privacy = 'ai_assisted'
        and note.deleted_at is null
      order by note.updated_at desc, note.id
      limit 50
    ) as repair;

    return jsonb_build_object(
      'ownerId', p_owner_id,
      'generation', null,
      'coverage', jsonb_build_object(
        'expectedNoteCount', 0,
        'indexedNoteCount', 0,
        'eligibleNoteCount', eligible_count,
        'coveredNoteCount', 0,
        'repairCount', repair_count,
        'repairLimitExceeded', repair_count = 51,
        'repairCandidates', repair_candidates_value,
        'pendingJobCount', 0,
        'verified', false,
        'complete', false
      ),
      'items', '[]'::jsonb,
      'keys', '[]'::jsonb,
      'page', jsonb_build_object(
        'limit', p_limit,
        'ciphertextByteBudget', p_ciphertext_byte_budget,
        'returnedCount', 0,
        'ciphertextBytes', 0,
        'hasMore', false,
        'nextCursor', null
      )
    );
  end if;

  select count(*)::integer into covered_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id
    and note.user_id = index_row.user_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = index_row.indexed_revision
  join public.user_content_keys as content_key
    on content_key.user_id = index_row.user_id
    and content_key.key_id = index_row.index_key_id
    and content_key.key_class = index_row.index_key_class
    and content_key.key_purpose = index_row.index_key_purpose
    and content_key.key_version = index_row.index_key_version
    and content_key.state in ('active', 'retired')
  where index_row.user_id = p_owner_id
    and index_row.generation_id = generation_row.id;

  select count(*)::integer into repair_count
  from (
    select 1
    from public.notes as note
    left join public.note_rag_index as index_row
      on index_row.user_id = note.user_id
      and index_row.note_id = note.id
      and index_row.generation_id = generation_row.id
      and index_row.indexed_revision = note.current_revision
    left join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
      and content_key.state in ('active', 'retired')
    where note.user_id = p_owner_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and (index_row.id is null or content_key.key_id is null)
    limit 51
  ) as repair;

  select coalesce(jsonb_agg(jsonb_build_object(
    'noteId', repair.note_id,
    'currentRevision', repair.current_revision,
    'updatedAt', repair.updated_at
  ) order by repair.updated_at desc, repair.note_id), '[]'::jsonb)
  into repair_candidates_value
  from (
    select note.id as note_id, note.current_revision, note.updated_at
    from public.notes as note
    left join public.note_rag_index as index_row
      on index_row.user_id = note.user_id
      and index_row.note_id = note.id
      and index_row.generation_id = generation_row.id
      and index_row.indexed_revision = note.current_revision
    left join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
      and content_key.state in ('active', 'retired')
    where note.user_id = p_owner_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and (index_row.id is null or content_key.key_id is null)
    order by note.updated_at desc, note.id
    limit 50
  ) as repair;

  select count(*)::integer into pending_job_count
  from public.note_index_jobs
  where user_id = p_owner_id
    and generation_id = generation_row.id
    and state in ('queued', 'leased');

  coverage_verified := exists (
    select 1
    from public.rag_index_generation_verifications as verification
    where verification.user_id = p_owner_id
      and verification.generation_id = generation_row.id
      and verification.revision_token = generation_row.revision_token
      and verification.verified_note_count = eligible_count
      and verification.attestation_domain
        = 'unfiled.rag-generation-attestation.v1'
      and verification.attestation_digest
        = private.request_hash(verification.attestation)
      and verification.attestation ->> 'ownerId' = p_owner_id::text
      and verification.attestation ->> 'generationId' = generation_row.id
      and verification.attestation ->> 'embeddingModelId'
        = generation_row.embedding_model_id
      and (verification.attestation ->> 'embeddingDimensions')::integer
        = generation_row.embedding_dimensions
      and (verification.attestation ->> 'envelopeSchemaVersion')::integer
        = generation_row.envelope_schema_version
      and (verification.attestation ->> 'expectedNoteCount')::integer
        = eligible_count
      and (verification.attestation ->> 'indexedNoteCount')::integer
        = eligible_count
      and (verification.attestation ->> 'entryCount')::integer = eligible_count
  );
  coverage_complete := coverage_verified
    and repair_count = 0
    and pending_job_count = 0
    and generation_row.expected_note_count = eligible_count
    and generation_row.indexed_note_count = eligible_count
    and covered_count = eligible_count;

  with ordered_rows as (
    select
      index_row.*,
      sum(index_row.encrypted_byte_length) over (
        order by index_row.id rows unbounded preceding
      ) as running_bytes
    from public.note_rag_index as index_row
    join public.notes as note
      on note.id = index_row.note_id
      and note.user_id = index_row.user_id
      and note.deleted_at is null
      and note.privacy = 'ai_assisted'
      and note.current_revision = index_row.indexed_revision
    join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
      and content_key.state in ('active', 'retired')
    where index_row.user_id = p_owner_id
      and index_row.generation_id = generation_row.id
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
      and key_row.state in ('active', 'retired')
    ;

    has_more := exists (
      select 1
      from public.note_rag_index as index_row
      join public.notes as note
        on note.id = index_row.note_id
        and note.user_id = index_row.user_id
        and note.deleted_at is null
        and note.privacy = 'ai_assisted'
        and note.current_revision = index_row.indexed_revision
      join public.user_content_keys as content_key
        on content_key.user_id = index_row.user_id
        and content_key.key_id = index_row.index_key_id
        and content_key.key_class = index_row.index_key_class
        and content_key.key_purpose = index_row.index_key_purpose
        and content_key.key_version = index_row.index_key_version
        and content_key.state in ('active', 'retired')
      where index_row.user_id = p_owner_id
        and index_row.generation_id = generation_row.id
        and index_row.id > last_index_id
    );
  end if;

  next_cursor_value := case when has_more then jsonb_build_object(
    'generationId', generation_row.id,
    'revisionToken', generation_row.revision_token,
    'afterIndexId', last_index_id
  ) else null end;

  return jsonb_build_object(
    'ownerId', p_owner_id,
    'generation', jsonb_build_object(
      'generationId', generation_row.id,
      'embeddingModelId', generation_row.embedding_model_id,
      'embeddingDimensions', generation_row.embedding_dimensions,
      'envelopeSchemaVersion', generation_row.envelope_schema_version,
      'revisionToken', generation_row.revision_token
    ),
    'coverage', jsonb_build_object(
      'expectedNoteCount', generation_row.expected_note_count,
      'indexedNoteCount', generation_row.indexed_note_count,
      'eligibleNoteCount', eligible_count,
      'coveredNoteCount', covered_count,
      'repairCount', repair_count,
      'repairLimitExceeded', repair_count = 51,
      'repairCandidates', repair_candidates_value,
      'pendingJobCount', pending_job_count,
      'verified', coverage_verified,
      'complete', coverage_complete
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
    )
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create or replace function public.heartbeat_note_index_job(
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
  preliminary_owner_id uuid;
  preliminary_note_id text;
  note_row public.notes%rowtype;
  job_row public.note_index_jobs%rowtype;
  reservation_row public.content_key_operation_reservations%rowtype;
  generation_is_eligible boolean := false;
  reservation_is_present boolean := false;
  source_key_is_usable boolean := false;
  target_key_is_active boolean := false;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_lease_token is null
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select user_id, note_id into preliminary_owner_id, preliminary_note_id
  from public.note_index_jobs
  where id = p_job_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into note_row
  from public.notes as note
  where note.user_id = preliminary_owner_id
    and note.id = preliminary_note_id
  for share of note;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into job_row
  from public.note_index_jobs as job
  where job.id = p_job_id
    and job.user_id = preliminary_owner_id
    and job.note_id = preliminary_note_id
  for update of job;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if job_row.state <> 'leased'
    or job_row.lease_token <> p_lease_token
    or job_row.lease_expires_at <= now()
  then
    raise exception using
      errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  select true into generation_is_eligible
  from public.rag_index_generations as generation
  where generation.id = job_row.generation_id
    and generation.user_id = job_row.user_id
    and generation.state in ('building', 'active')
  for share of generation;

  generation_is_eligible := found;

  select * into reservation_row
  from public.content_key_operation_reservations as reservation
  where reservation.user_id = job_row.user_id
    and reservation.reservation_id = job_row.target_reservation_id
  for share of reservation;

  reservation_is_present := found;

  select true into source_key_is_usable
  from public.user_content_keys as content_key
  where content_key.user_id = note_row.user_id
    and content_key.key_id = note_row.content_key_id
    and content_key.key_class = note_row.content_key_class
    and content_key.key_purpose = note_row.content_key_purpose
    and content_key.key_version = note_row.content_key_version
    and content_key.state in ('active', 'retired')
  for share of content_key;
  source_key_is_usable := found;

  select true into target_key_is_active
  from public.user_content_keys as content_key
  where content_key.user_id = job_row.user_id
    and content_key.key_id = job_row.target_key_id
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'object_wrap'
    and content_key.key_version = job_row.target_key_version
    and content_key.state = 'active'
  for share of content_key;
  target_key_is_active := found;

  if note_row.deleted_at is not null
    or note_row.privacy <> 'ai_assisted'
    or note_row.current_revision <> job_row.target_revision
    or note_row.content_envelope is null
    or note_row.content_key_id is null
    or note_row.content_key_class <> 'ai_assisted'
    or note_row.content_key_purpose <> 'object_wrap'
    or note_row.content_key_version is null
    or not source_key_is_usable
    or not target_key_is_active
    or not generation_is_eligible
    or not reservation_is_present
    or reservation_row.consumed_at is not null
    or reservation_row.key_id <> job_row.target_key_id
    or reservation_row.key_class <> job_row.target_key_class
    or reservation_row.key_purpose <> job_row.target_key_purpose
    or reservation_row.key_version <> job_row.target_key_version
    or reservation_row.operation_count <> 1
    or job_row.target_reservation_attempt <> job_row.attempt
    or job_row.target_reservation_lease_token <> p_lease_token
  then
    raise exception using
      errcode = '42501', message = 'ineligible_note_index_job';
  end if;

  update public.note_index_jobs
  set
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    last_heartbeat_at = now()
  where id = job_row.id
  returning * into job_row;

  return jsonb_build_object(
    'jobId', job_row.id,
    'leaseExpiresAt', job_row.lease_expires_at,
    'disclosureAuthorized', true
  );
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
  bound_job public.note_index_jobs%rowtype;
  reservation_is_rag_bound boolean;
  key_state_value public.content_key_state;
begin
  if jsonb_typeof(cipher_values) <> 'array'
    or jsonb_array_length(cipher_values) not between 1 and 100
    or consumer_type_value not in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index'
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
    -- A RAG commit locks its job before its reservation. Discover and lock any
    -- binding in the same order so another encrypted aggregate consumer cannot
    -- create a job/reservation lock inversion while probing this reservation.
    select * into bound_job
    from public.note_index_jobs as job
    where job.user_id = owner_id
      and job.target_reservation_id = reservation_group.reservation_id
    for share of job;
    reservation_is_rag_bound := found;

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

    if (
      reservation_is_rag_bound
      and (
        consumer_type_value <> 'note_rag_index'
        or consumer_id_value <> bound_job.index_resource_id
        or bound_job.state <> 'leased'
        or bound_job.target_reservation_attempt <> bound_job.attempt
        or bound_job.target_reservation_lease_token <> bound_job.lease_token
      )
    ) or (
      consumer_type_value = 'note_rag_index'
      and not reservation_is_rag_bound
    ) then
      raise exception using
        errcode = 'P0001', message = 'invalid_key_reservation_binding';
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

create or replace function public.claim_note_index_jobs(
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
  note_row public.notes%rowtype;
  job_row public.note_index_jobs%rowtype;
  generation_row public.rag_index_generations%rowtype;
  source_key_row public.user_content_keys%rowtype;
  target_key_row public.user_content_keys%rowtype;
  reservation_value uuid;
  lease_token_value uuid;
  source_envelope_bytes integer;
  claimed_count integer := 0;
  claimed_source_bytes integer := 0;
  source_byte_budget constant integer := 8388608;
  jobs_value jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_worker_id is null
    or char_length(p_worker_id) not between 1 and 120
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  for candidate in
    select job.id, job.user_id, job.note_id
    from public.note_index_jobs as job
    where job.state = 'queued'
      and job.available_at <= now()
      and job.attempt < 5
    order by job.available_at, job.created_at, job.id
    limit least(p_limit * 10, 500)
  loop
    exit when claimed_count >= p_limit;

    if not pg_try_advisory_xact_lock(
      hashtextextended('note-index-claim:' || candidate.id, 0)
    ) then
      continue;
    end if;

    -- Preserve the global publication lock order: note -> job -> generation ->
    -- owner/class/purpose key domain. A privacy or revision mutation therefore
    -- either wins before this encrypted source snapshot or waits until after it.
    select * into note_row
    from public.notes as note
    where note.id = candidate.note_id
      and note.user_id = candidate.user_id
    for share of note;

    if not found
      or note_row.deleted_at is not null
      or note_row.privacy <> 'ai_assisted'
      or note_row.content_envelope is null
      or note_row.content_key_id is null
      or note_row.content_key_class <> 'ai_assisted'
      or note_row.content_key_purpose <> 'object_wrap'
      or note_row.content_key_version is null
    then
      continue;
    end if;

    source_envelope_bytes := octet_length(note_row.content_envelope::text);
    if source_envelope_bytes > source_byte_budget
      or claimed_source_bytes > source_byte_budget - source_envelope_bytes
    then
      continue;
    end if;

    select * into job_row
    from public.note_index_jobs as job
    where job.id = candidate.id
      and job.user_id = candidate.user_id
      and job.note_id = candidate.note_id
      and job.state = 'queued'
      and job.available_at <= now()
      and job.attempt < 5
    for update of job;

    if not found or job_row.target_revision <> note_row.current_revision then
      continue;
    end if;

    select * into generation_row
    from public.rag_index_generations as generation
    where generation.id = job_row.generation_id
      and generation.user_id = job_row.user_id
      and generation.state in ('building', 'active')
    for share of generation;

    if not found then
      continue;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        job_row.user_id::text || ':ai_assisted:object_wrap', 0
      )
    );

    select * into target_key_row
    from public.user_content_keys as content_key
    where content_key.user_id = job_row.user_id
      and content_key.key_class = 'ai_assisted'
      and content_key.key_purpose = 'object_wrap'
      and content_key.state = 'active'
    for update of content_key;

    if not found
      or target_key_row.wrap_operations >= target_key_row.wrap_operation_limit
    then
      continue;
    end if;

    if note_row.content_key_id = target_key_row.key_id
      and note_row.content_key_version = target_key_row.key_version
    then
      source_key_row := target_key_row;
    else
      select * into source_key_row
      from public.user_content_keys as content_key
      where content_key.user_id = job_row.user_id
        and content_key.key_id = note_row.content_key_id
        and content_key.key_class = note_row.content_key_class
        and content_key.key_purpose = note_row.content_key_purpose
        and content_key.key_version = note_row.content_key_version
        and content_key.state in ('active', 'retired')
      for share of content_key;
    end if;

    if source_key_row.key_id is null
      or source_key_row.key_class <> 'ai_assisted'
      or source_key_row.key_purpose <> 'object_wrap'
      or source_key_row.state not in ('active', 'retired')
    then
      continue;
    end if;

    reservation_value := extensions.gen_random_uuid();
    lease_token_value := extensions.gen_random_uuid();

    update public.user_content_keys
    set wrap_operations = wrap_operations + 1
    where user_id = target_key_row.user_id
      and key_id = target_key_row.key_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and key_version = target_key_row.key_version
      and state = 'active'
      and wrap_operations < wrap_operation_limit
    returning * into target_key_row;

    if not found then
      continue;
    end if;

    insert into public.content_key_operation_reservations (
      user_id, reservation_id, key_id, key_class, key_purpose,
      key_version, operation_count
    ) values (
      job_row.user_id, reservation_value, target_key_row.key_id,
      'ai_assisted', 'object_wrap', target_key_row.key_version, 1
    );

    update public.note_index_jobs
    set
      state = 'leased',
      attempt = attempt + 1,
      lease_owner = p_worker_id,
      lease_token = lease_token_value,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = now(),
      last_error_code = null,
      target_reservation_id = reservation_value,
      target_key_id = target_key_row.key_id,
      target_key_class = 'ai_assisted',
      target_key_purpose = 'object_wrap',
      target_key_version = target_key_row.key_version,
      target_reservation_attempt = attempt + 1,
      target_reservation_lease_token = lease_token_value
    where id = job_row.id
    returning * into job_row;

    claimed_count := claimed_count + 1;
    claimed_source_bytes := claimed_source_bytes + source_envelope_bytes;
    jobs_value := jobs_value || jsonb_build_array(jsonb_build_object(
      'jobId', job_row.id,
      'userId', job_row.user_id,
      'noteId', job_row.note_id,
      'generationId', job_row.generation_id,
      'targetRevision', job_row.target_revision,
      'indexResourceId', job_row.index_resource_id,
      'noteType', note_row.type,
      'spaceId', note_row.space_id,
      'isOpen', note_row.is_open,
      'pinnedAt', note_row.pinned_at,
      'updatedAt', note_row.updated_at,
      'attempt', job_row.attempt,
      'leaseToken', job_row.lease_token,
      'leaseExpiresAt', job_row.lease_expires_at,
      'sourceNoteCipher', private.encrypted_cipher_projection(
        note_row.content_envelope, note_row.content_key_id,
        note_row.content_key_class, note_row.content_key_purpose,
        note_row.content_key_version
      ),
      'sourceEnvelopeBytes', source_envelope_bytes,
      'sourceKey', private.content_key_service_projection(source_key_row),
      'targetKey', private.content_key_service_projection(target_key_row),
      'embeddingModelId', generation_row.embedding_model_id,
      'embeddingDimensions', generation_row.embedding_dimensions,
      'generationRevisionToken', generation_row.revision_token,
      'reservation', jsonb_build_object(
        'reservationId', reservation_value,
        'keyId', target_key_row.key_id,
        'keyClass', target_key_row.key_class,
        'keyPurpose', target_key_row.key_purpose,
        'keyVersion', target_key_row.key_version,
        'operationCount', 1,
        'consumed', false
      )
    ));
  end loop;

  return jsonb_build_object(
    'jobs', jobs_value,
    'sourceEnvelopeBytes', claimed_source_bytes,
    'sourceEnvelopeByteBudget', source_byte_budget
  );
end;
$$;

create or replace function public.commit_note_rag_index(
  p_job_id text,
  p_lease_token uuid,
  p_index_id text,
  p_index_envelope jsonb,
  p_index_key_id text,
  p_index_key_class public.content_key_class,
  p_index_key_purpose public.content_key_purpose,
  p_index_key_version integer,
  p_encrypted_byte_length integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  preliminary_owner_id uuid;
  preliminary_note_id text;
  note_row public.notes%rowtype;
  job_row public.note_index_jobs%rowtype;
  generation_row public.rag_index_generations%rowtype;
  request_hash_value text;
  stored_index_id text;
  coverage_count integer;
  cipher_value jsonb;
  source_key_is_usable boolean := false;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_lease_token is null
    or p_index_id !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_index_envelope is null
    or p_index_key_id is null
    or p_index_key_class <> 'ai_assisted'
    or p_index_key_purpose <> 'object_wrap'
    or p_index_key_version is null
    or p_index_key_version < 1
    or p_encrypted_byte_length is null
    or p_encrypted_byte_length not between 16 and 262160
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select job.user_id, job.note_id
  into preliminary_owner_id, preliminary_note_id
  from public.note_index_jobs as job
  where job.id = p_job_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into note_row
  from public.notes as note
  where note.id = preliminary_note_id
    and note.user_id = preliminary_owner_id
  for update of note;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into job_row
  from public.note_index_jobs as job
  where job.id = p_job_id
    and job.user_id = preliminary_owner_id
    and job.note_id = preliminary_note_id
  for update of job;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into generation_row
  from public.rag_index_generations as generation
  where generation.id = job_row.generation_id
    and generation.user_id = job_row.user_id
  for update of generation;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select true into source_key_is_usable
  from public.user_content_keys as content_key
  where content_key.user_id = note_row.user_id
    and content_key.key_id = note_row.content_key_id
    and content_key.key_class = note_row.content_key_class
    and content_key.key_purpose = note_row.content_key_purpose
    and content_key.key_version = note_row.content_key_version
    and content_key.state in ('active', 'retired')
  for share of content_key;
  source_key_is_usable := found;

  request_hash_value := private.request_hash(jsonb_build_object(
    'indexId', p_index_id,
    'indexEnvelope', p_index_envelope,
    'indexKeyId', p_index_key_id,
    'indexKeyClass', p_index_key_class,
    'indexKeyPurpose', p_index_key_purpose,
    'indexKeyVersion', p_index_key_version,
    'encryptedByteLength', p_encrypted_byte_length
  ) || case
    when job_row.target_reservation_id is null then '{}'::jsonb
    else jsonb_build_object(
      'reservationId', job_row.target_reservation_id,
      'reservationAttempt', job_row.target_reservation_attempt,
      'reservationLeaseToken', job_row.target_reservation_lease_token
    )
  end);

  if job_row.state = 'succeeded' then
    if job_row.last_transition_lease_token = p_lease_token
      and job_row.last_transition_action = 'succeeded'
      and job_row.last_transition_request_hash = request_hash_value
    then
      return jsonb_build_object(
        'jobId', job_row.id,
        'indexId', job_row.result_index_id,
        'reservationId', job_row.target_reservation_id,
        'committed', true,
        'replayed', true
      );
    end if;
    raise exception using
      errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if job_row.state <> 'leased'
    or job_row.lease_token <> p_lease_token
    or job_row.lease_expires_at <= now()
  then
    raise exception using
      errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  if p_index_id <> job_row.index_resource_id then
    raise exception using errcode = '22023', message = 'invalid_index_resource';
  end if;

  if job_row.target_reservation_id is null
    or job_row.target_reservation_attempt <> job_row.attempt
    or job_row.target_reservation_lease_token <> p_lease_token
    or p_index_key_id <> job_row.target_key_id
    or p_index_key_class <> job_row.target_key_class
    or p_index_key_purpose <> job_row.target_key_purpose
    or p_index_key_version <> job_row.target_key_version
  then
    raise exception using
      errcode = '22023', message = 'invalid_index_reservation';
  end if;

  if note_row.id <> job_row.note_id
    or note_row.user_id <> job_row.user_id
    or note_row.deleted_at is not null
    or note_row.privacy <> 'ai_assisted'
    or note_row.current_revision <> job_row.target_revision
    or note_row.content_envelope is null
    or note_row.content_key_class <> 'ai_assisted'
    or note_row.content_key_purpose <> 'object_wrap'
    or not source_key_is_usable
    or generation_row.id <> job_row.generation_id
    or generation_row.user_id <> job_row.user_id
    or generation_row.state not in ('building', 'active')
  then
    update public.note_index_jobs
    set
      state = 'failed',
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = p_lease_token,
      last_transition_action = 'failed',
      last_transition_request_hash = request_hash_value,
      last_error_code = case
        when note_row.deleted_at is not null or note_row.privacy <> 'ai_assisted'
          then 'validation_failed'::public.safe_error_code
        else 'stale_revision'::public.safe_error_code
      end
    where id = job_row.id;

    return jsonb_build_object(
      'jobId', job_row.id,
      'committed', false,
      'errorCode', case
        when note_row.deleted_at is not null or note_row.privacy <> 'ai_assisted'
          then 'validation_failed'
        else 'stale_revision'
      end,
      'replayed', false
    );
  end if;

  cipher_value := jsonb_build_object(
    'envelope', p_index_envelope,
    'keyId', p_index_key_id,
    'keyClass', p_index_key_class,
    'keyPurpose', p_index_key_purpose,
    'keyVersion', p_index_key_version,
    'reservationId', job_row.target_reservation_id
  );

  if not private.valid_encrypted_write_cipher(
    cipher_value,
    job_row.user_id,
    p_index_id,
    job_row.target_revision,
    'note_rag_index',
    'ai_assisted'
  ) then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform private.consume_content_key_reservations(
    job_row.user_id,
    jsonb_build_array(cipher_value),
    'note_rag_index',
    p_index_id
  );

  insert into public.note_rag_index (
    id, user_id, note_id, generation_id, indexed_revision, index_envelope,
    index_key_id, index_key_class, index_key_purpose, index_key_version,
    encrypted_byte_length
  ) values (
    p_index_id, job_row.user_id, job_row.note_id, job_row.generation_id,
    job_row.target_revision, p_index_envelope, p_index_key_id,
    p_index_key_class, p_index_key_purpose, p_index_key_version,
    p_encrypted_byte_length
  )
  on conflict (note_id, generation_id) do update
  set
    indexed_revision = excluded.indexed_revision,
    index_envelope = excluded.index_envelope,
    index_key_id = excluded.index_key_id,
    index_key_class = excluded.index_key_class,
    index_key_purpose = excluded.index_key_purpose,
    index_key_version = excluded.index_key_version,
    encrypted_byte_length = excluded.encrypted_byte_length
  where public.note_rag_index.user_id = excluded.user_id
    and public.note_rag_index.id = excluded.id
    and public.note_rag_index.indexed_revision <= excluded.indexed_revision
  returning id into stored_index_id;

  if stored_index_id is null then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  update public.note_index_jobs
  set
    state = 'succeeded',
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = p_lease_token,
    last_transition_action = 'succeeded',
    last_transition_request_hash = request_hash_value,
    result_index_id = stored_index_id,
    last_error_code = null
  where id = job_row.id;

  select count(*)::integer into coverage_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id and note.user_id = index_row.user_id
  join public.user_content_keys as content_key
    on content_key.user_id = index_row.user_id
    and content_key.key_id = index_row.index_key_id
    and content_key.key_class = index_row.index_key_class
    and content_key.key_purpose = index_row.index_key_purpose
    and content_key.key_version = index_row.index_key_version
    and content_key.state in ('active', 'retired')
  where index_row.generation_id = job_row.generation_id
    and index_row.user_id = job_row.user_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = index_row.indexed_revision;

  update public.rag_index_generations
  set
    indexed_note_count = least(expected_note_count, coverage_count),
    revision_token = revision_token + 1
  where id = job_row.generation_id and user_id = job_row.user_id
  returning * into generation_row;

  return jsonb_build_object(
    'jobId', job_row.id,
    'indexId', stored_index_id,
    'reservationId', job_row.target_reservation_id,
    'generationRevisionToken', generation_row.revision_token,
    'committed', true,
    'replayed', false
  );
end;
$$;

create trigger note_index_jobs_enforce_resource_stability
before insert or update of
  user_id, note_id, generation_id, index_resource_id
on public.note_index_jobs
for each row execute function private.enforce_note_index_resource_stability();

create or replace function private.burn_abandoned_note_index_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state = 'leased'
    and new.state <> 'leased'
    and old.target_reservation_id is not null
  then
    update public.content_key_operation_reservations
    set
      consumed_by_type = 'note_rag_index',
      consumed_by_id = 'abandoned:' || old.id || ':' || old.attempt::text,
      consumed_at = clock_timestamp()
    where user_id = old.user_id
      and reservation_id = old.target_reservation_id
      and consumed_at is null;
  end if;
  return new;
end;
$$;

create trigger note_index_jobs_burn_abandoned_reservation
before update of state on public.note_index_jobs
for each row
when (old.state = 'leased' and new.state <> 'leased')
execute function private.burn_abandoned_note_index_reservation();

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
    user_id, note_id, generation_id, target_revision, index_resource_id
  )
  select
    owner_id,
    note_id_value,
    generation.id,
    revision_value,
    private.stable_note_rag_resource_id(
      owner_id, note_id_value, generation.id
    )
  from public.rag_index_generations as generation
  where generation.user_id = owner_id
    and generation.state in ('building', 'active')
  on conflict (note_id, generation_id, target_revision) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.enqueue_note_index_job(
  p_owner_id uuid,
  p_note_id text,
  p_generation_id text,
  p_target_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.note_index_jobs%rowtype;
  eligible_count integer;
  stable_resource_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_generation_id is null
    or p_target_revision is null
    or p_target_revision < 1
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform 1
  from public.notes as note
  where note.id = p_note_id
    and note.user_id = p_owner_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = p_target_revision
  for update of note;

  if not found then
    raise exception using
      errcode = '42501', message = 'ineligible_note_index_job';
  end if;

  select * into job_row
  from public.note_index_jobs
  where user_id = p_owner_id
    and note_id = p_note_id
    and generation_id = p_generation_id
    and target_revision = p_target_revision
  for update;

  perform 1
  from public.rag_index_generations as generation
  where generation.id = p_generation_id
    and generation.user_id = p_owner_id
    and generation.state in ('building', 'active')
  for update of generation;

  if not found then
    raise exception using
      errcode = '42501', message = 'ineligible_note_index_job';
  end if;

  if job_row.id is not null then
    return jsonb_build_object(
      'jobId', job_row.id,
      'indexResourceId', job_row.index_resource_id,
      'state', job_row.state,
      'replayed', true
    );
  end if;

  stable_resource_id := private.stable_note_rag_resource_id(
    p_owner_id, p_note_id, p_generation_id
  );

  insert into public.note_index_jobs (
    user_id, note_id, generation_id, target_revision, index_resource_id
  ) values (
    p_owner_id, p_note_id, p_generation_id, p_target_revision,
    stable_resource_id
  )
  on conflict (note_id, generation_id, target_revision) do nothing
  returning * into job_row;

  if not found then
    select * into job_row
    from public.note_index_jobs
    where user_id = p_owner_id
      and note_id = p_note_id
      and generation_id = p_generation_id
      and target_revision = p_target_revision;

    if not found then
      raise exception using
        errcode = '42501', message = 'ineligible_note_index_job';
    end if;

    return jsonb_build_object(
      'jobId', job_row.id,
      'indexResourceId', job_row.index_resource_id,
      'state', job_row.state,
      'replayed', true
    );
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  update public.rag_index_generations
  set
    expected_note_count = eligible_count,
    revision_token = revision_token + 1
  where id = p_generation_id and user_id = p_owner_id;

  return jsonb_build_object(
    'jobId', job_row.id,
    'indexResourceId', job_row.index_resource_id,
    'state', job_row.state,
    'replayed', false
  );
end;
$$;

-- Rebuild the dedicated worker allowlist after replacing the list signature.
-- The role retains exactly these six RPCs and no relation or private-schema
-- capability. Generation verification belongs only to the separately bound
-- verifier role;
-- activation remains service-only.
revoke execute on function private.enforce_note_index_resource_stability()
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.stable_note_rag_resource_id(
  uuid, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.enforce_rag_index_resource_stability()
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.burn_abandoned_note_index_reservation()
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.invalidate_rag_generation_for_revoked_key()
  from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.consume_content_key_reservations(
  uuid, jsonb, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.enqueue_encrypted_note_index_jobs(
  uuid, text, integer, public.privacy_mode, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function private.rag_generation_attestation(
  uuid, text, bigint
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier;

revoke execute on function public.enqueue_note_index_job(
  uuid, text, text, integer
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.claim_note_index_jobs(
  text, integer, integer
) from public, anon, authenticated;
revoke execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) from public, anon, authenticated;
revoke execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) from public, anon, authenticated;
revoke execute on function public.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker;
revoke execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.list_active_note_rag_index(
  uuid, jsonb, integer, integer
) from public, anon, authenticated;

grant execute on function public.enqueue_note_index_job(
  uuid, text, text, integer
) to service_role;
grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to service_role;
grant execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) to service_role;
grant execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) to service_role;
grant execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) to service_role;
grant execute on function public.list_active_note_rag_index(
  uuid, jsonb, integer, integer
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
grant execute on function public.verify_rag_index_generation(
  uuid, text, bigint, jsonb
) to unfiled_rag_verifier;

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
grant execute on function public.recover_stale_note_index_jobs(
  integer
) to unfiled_index_worker;
grant execute on function public.list_active_note_rag_index(
  uuid, jsonb, integer, integer
) to unfiled_index_worker;
