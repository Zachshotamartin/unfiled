-- Milestone F: isolated encrypted user-search trust domain.
--
-- The interactive service creates a 30-second, one-use capability after it
-- authenticates the owner. The capability stores only canonical SHA-256
-- digests plus content-free generation metadata. The dedicated search worker
-- can exchange the raw claim secret once, then page only current encrypted
-- AI-assisted index rows through a short, digest-bound lease. Query text never
-- crosses this SQL boundary; normalized filter plaintext is transient and only
-- its canonical digest is persisted.

do $dedicated_search_worker$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'unfiled_search_worker'
  ) then
    execute 'create role unfiled_search_worker '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  elsif exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'unfiled_search_worker'
      and not rolsuper
      and (
        rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
        or rolreplication or rolbypassrls
      )
  ) then
    execute 'alter role unfiled_search_worker '
      || 'nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'unfiled_search_worker'
      and (
        rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolcanlogin
        or rolreplication or rolbypassrls
      )
  ) then
    raise exception using
      errcode = '42501', message = 'search_role_attributes_not_reconciled';
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
      member.rolname = 'unfiled_search_worker'
      or granted.rolname = 'unfiled_search_worker'
    )
      and not (
        granted.rolname = 'unfiled_search_worker'
        and member.rolname = 'postgres'
        and grantor.rolname = 'supabase_admin'
        and membership.admin_option
        and not membership.inherit_option
        and not membership.set_option
      )
  ) then
    raise exception using
      errcode = '42501', message = 'search_role_membership_not_reconciled';
  end if;
end;
$dedicated_search_worker$;

create table public.encrypted_user_search_capabilities (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  filter_digest text not null check (filter_digest ~ '^[0-9a-f]{64}$'),
  claim_secret_digest text check (
    claim_secret_digest is null
    or claim_secret_digest ~ '^[0-9a-f]{64}$'
  ),
  generation_id text not null,
  generation_revision_token bigint not null check (
    generation_revision_token >= 0
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
  generation_attestation_digest text not null check (
    generation_attestation_digest ~ '^[0-9a-f]{64}$'
  ),
  state text not null default 'pending' check (
    state in ('pending', 'leased', 'completed', 'failed')
  ),
  lease_secret_digest text check (
    lease_secret_digest is null
    or lease_secret_digest ~ '^[0-9a-f]{64}$'
  ),
  verified_candidate_digest text check (
    verified_candidate_digest is null
    or verified_candidate_digest ~ '^[0-9a-f]{64}$'
  ),
  filtered_expected_note_count integer check (
    filtered_expected_note_count is null
    or filtered_expected_note_count >= 0
  ),
  filtered_indexed_note_count integer check (
    filtered_indexed_note_count is null
    or filtered_indexed_note_count between 0 and filtered_expected_note_count
  ),
  virtual_snapshot_digest text check (
    virtual_snapshot_digest is null
    or virtual_snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null,
  claim_expires_at timestamptz not null,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  coverage_checked_at timestamptz,
  verified_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code public.safe_error_code,
  foreign key (user_id, generation_id)
    references public.rag_index_generations(user_id, id) on delete cascade,
  check (
    claim_expires_at > created_at
    and claim_expires_at <= created_at + interval '30 seconds'
  ),
  check (
    (verified_at is null and verified_candidate_digest is null)
    or (verified_at is not null and verified_candidate_digest is not null)
  ),
  check (
    (
      filtered_expected_note_count is null
      and filtered_indexed_note_count is null
      and virtual_snapshot_digest is null
      and coverage_checked_at is null
    )
    or (
      filtered_expected_note_count is not null
      and filtered_indexed_note_count is not null
      and virtual_snapshot_digest is not null
      and coverage_checked_at is not null
    )
  ),
  check (verified_at is null or virtual_snapshot_digest is not null),
  check (
    (
      state = 'pending'
      and claim_secret_digest is not null
      and lease_secret_digest is null
      and claimed_at is null
      and lease_expires_at is null
      and coverage_checked_at is null
      and verified_at is null
      and completed_at is null
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'leased'
      and claim_secret_digest is null
      and lease_secret_digest is not null
      and claimed_at is not null
      and lease_expires_at > claimed_at
      and lease_expires_at <= claimed_at + interval '30 seconds'
      and completed_at is null
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'completed'
      and claim_secret_digest is null
      and lease_secret_digest is null
      and claimed_at is not null
      and lease_expires_at is null
      and verified_at is not null
      and completed_at is not null
      and failed_at is null
      and failure_code is null
    )
    or (
      state = 'failed'
      and claim_secret_digest is null
      and lease_secret_digest is null
      and claimed_at is not null
      and lease_expires_at is null
      and completed_at is null
      and failed_at is not null
      and failure_code is not null
    )
  )
);

create unique index encrypted_user_search_pending_secret_unique
  on public.encrypted_user_search_capabilities(claim_secret_digest)
  where claim_secret_digest is not null;
create unique index encrypted_user_search_live_lease_unique
  on public.encrypted_user_search_capabilities(lease_secret_digest)
  where lease_secret_digest is not null;
create index encrypted_user_search_owner_created
  on public.encrypted_user_search_capabilities(user_id, created_at desc, id);
create index encrypted_user_search_expiry
  on public.encrypted_user_search_capabilities(state, claim_expires_at, lease_expires_at);

alter table public.encrypted_user_search_capabilities enable row level security;
alter table public.encrypted_user_search_capabilities force row level security;

create function private.valid_encrypted_user_search_filter(
  p_filter_manifest jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  space_filter jsonb;
  tag_count integer;
  unique_tag_count integer;
  sorted_tags jsonb;
  updated_from_value timestamptz;
  updated_to_value timestamptz;
begin
  if p_filter_manifest is null
    or jsonb_typeof(p_filter_manifest) <> 'object'
    or p_filter_manifest - array[
      'archive', 'privacy', 'type', 'space', 'tagIds',
      'updatedFrom', 'updatedTo'
    ] <> '{}'::jsonb
    or not p_filter_manifest ?& array[
      'archive', 'privacy', 'type', 'space', 'tagIds',
      'updatedFrom', 'updatedTo'
    ]
    or jsonb_typeof(p_filter_manifest -> 'archive') <> 'string'
    or p_filter_manifest ->> 'archive' not in ('exclude', 'include', 'only')
    or jsonb_typeof(p_filter_manifest -> 'privacy') <> 'string'
    or p_filter_manifest ->> 'privacy' <> 'ai_assisted'
  then
    return false;
  end if;

  if jsonb_typeof(p_filter_manifest -> 'type') not in ('null', 'string')
    or (
      jsonb_typeof(p_filter_manifest -> 'type') = 'string'
      and p_filter_manifest ->> 'type'
        not in ('generic', 'list', 'log', 'principle', 'project')
    )
  then
    return false;
  end if;

  space_filter := p_filter_manifest -> 'space';
  if jsonb_typeof(space_filter) <> 'object'
    or space_filter - array['mode', 'id'] <> '{}'::jsonb
    or not space_filter ?& array['mode', 'id']
    or jsonb_typeof(space_filter -> 'mode') <> 'string'
    or space_filter ->> 'mode' not in ('any', 'root', 'exact')
    or (
      space_filter ->> 'mode' in ('any', 'root')
      and jsonb_typeof(space_filter -> 'id') <> 'null'
    )
    or (
      space_filter ->> 'mode' = 'exact'
      and (
        jsonb_typeof(space_filter -> 'id') <> 'string'
        or space_filter ->> 'id' !~ '^spc_[0-9A-HJKMNP-TV-Z]{26}$'
      )
    )
  then
    return false;
  end if;

  if jsonb_typeof(p_filter_manifest -> 'tagIds') <> 'array'
    or jsonb_array_length(p_filter_manifest -> 'tagIds') > 20
  then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_filter_manifest -> 'tagIds') as tag(value)
    where jsonb_typeof(tag.value) <> 'string'
      or tag.value #>> '{}' !~ '^tag_[0-9A-HJKMNP-TV-Z]{26}$'
  ) then
    return false;
  end if;
  select
    count(*)::integer,
    count(distinct tag.value)::integer,
    coalesce(jsonb_agg(tag.value order by tag.value), '[]'::jsonb)
  into tag_count, unique_tag_count, sorted_tags
  from jsonb_array_elements_text(
    p_filter_manifest -> 'tagIds'
  ) as tag(value);
  if tag_count <> unique_tag_count
    or sorted_tags <> p_filter_manifest -> 'tagIds'
  then
    return false;
  end if;

  if jsonb_typeof(p_filter_manifest -> 'updatedFrom') not in ('null', 'string')
    or jsonb_typeof(p_filter_manifest -> 'updatedTo') not in ('null', 'string')
    or (
      jsonb_typeof(p_filter_manifest -> 'updatedFrom') = 'string'
      and char_length(p_filter_manifest ->> 'updatedFrom') not between 20 and 40
    )
    or (
      jsonb_typeof(p_filter_manifest -> 'updatedTo') = 'string'
      and char_length(p_filter_manifest ->> 'updatedTo') not between 20 and 40
    )
  then
    return false;
  end if;
  if jsonb_typeof(p_filter_manifest -> 'updatedFrom') = 'string' then
    updated_from_value := (p_filter_manifest ->> 'updatedFrom')::timestamptz;
  end if;
  if jsonb_typeof(p_filter_manifest -> 'updatedTo') = 'string' then
    updated_to_value := (p_filter_manifest ->> 'updatedTo')::timestamptz;
  end if;
  if updated_from_value is not null
    and updated_to_value is not null
    and updated_from_value >= updated_to_value
  then
    return false;
  end if;
  return true;
exception when invalid_text_representation or invalid_datetime_format
  or datetime_field_overflow or numeric_value_out_of_range
then
  return false;
end;
$$;

create function private.list_encrypted_user_search_rag_page_impl(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_filter_manifest jsonb,
  p_cursor jsonb default null,
  p_limit integer default 50,
  p_ciphertext_byte_budget integer default 2097152
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  after_index_id text;
  returned_count integer := 0;
  returned_bytes integer := 0;
  expected_note_count integer := 0;
  indexed_note_count integer := 0;
  missing_or_stale_count integer := 0;
  page_index_ids text[] := array[]::text[];
  last_index_id text;
  has_more boolean := false;
  items_value jsonb := '[]'::jsonb;
  keys_value jsonb := '[]'::jsonb;
  snapshot_rows_value jsonb := '[]'::jsonb;
  virtual_snapshot_digest_value text;
  repair_candidates_value jsonb := '[]'::jsonb;
  coverage_checked_at_value timestamptz;
  next_cursor_value jsonb;
begin
  if p_limit is null or p_limit not between 1 and 50
    or p_ciphertext_byte_budget is null
    or p_ciphertext_byte_budget not between 262160 and 8388608
    or not private.valid_encrypted_user_search_filter(p_filter_manifest)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  capability_row := private.assert_encrypted_user_search_lease(
    p_search_id, p_lease_token, p_request_digest, true
  );
  if private.request_hash(p_filter_manifest)
    <> capability_row.filter_digest
  then
    raise exception using errcode = '42501', message = 'invalid_search_binding';
  end if;

  -- Freeze a filter-specific virtual snapshot without persisting any filter
  -- values. The digest binds every eligible note revision and every usable
  -- encrypted index/key reference, so equal counts cannot hide replacement,
  -- privacy, tag, archive, or revision races between pages.
  with filtered_notes as (
    select
      note.id as note_id,
      note.current_revision,
      note.type,
      note.space_id,
      note.updated_at,
      note.pinned_at,
      note.archived_at,
      coalesce((
        select jsonb_agg(note_tag.tag_id order by note_tag.tag_id)
        from public.note_tags as note_tag
        where note_tag.user_id = capability_row.user_id
          and note_tag.note_id = note.id
      ), '[]'::jsonb) as tag_ids,
      index_row.id as index_id,
      index_row.indexed_revision,
      index_row.index_key_id,
      index_row.index_key_class,
      index_row.index_key_purpose,
      index_row.index_key_version,
      content_key.state as index_key_state,
      (
        index_row.id is not null
        and index_row.indexed_revision = note.current_revision
        and index_row.index_key_class = 'ai_assisted'
        and index_row.index_key_purpose = 'object_wrap'
        and content_key.state in ('active', 'retired')
      ) as index_eligible
    from public.notes as note
    left join public.note_rag_index as index_row
      on index_row.user_id = note.user_id
      and index_row.note_id = note.id
      and index_row.generation_id = capability_row.generation_id
    left join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
    where note.user_id = capability_row.user_id
      and private.encrypted_user_search_note_is_eligible(
        capability_row.user_id, note.id, note.current_revision,
        p_filter_manifest
      )
  )
  select
    count(*)::integer,
    count(*) filter (where filtered.index_eligible)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'noteId', filtered.note_id,
      'currentRevision', filtered.current_revision,
      'type', filtered.type,
      'spaceId', filtered.space_id,
      'updatedAt', private.encrypted_user_search_timestamp(
        filtered.updated_at
      ),
      'pinnedAt', private.encrypted_user_search_timestamp(
        filtered.pinned_at
      ),
      'archivedAt', private.encrypted_user_search_timestamp(
        filtered.archived_at
      ),
      'tagIds', filtered.tag_ids,
      'indexId', filtered.index_id,
      'indexedRevision', filtered.indexed_revision,
      'indexKeyId', filtered.index_key_id,
      'indexKeyClass', filtered.index_key_class,
      'indexKeyPurpose', filtered.index_key_purpose,
      'indexKeyVersion', filtered.index_key_version,
      'indexKeyState', filtered.index_key_state,
      'indexEligible', filtered.index_eligible
    ) order by filtered.note_id), '[]'::jsonb)
  into expected_note_count, indexed_note_count, snapshot_rows_value
  from filtered_notes as filtered;

  missing_or_stale_count := expected_note_count - indexed_note_count;
  virtual_snapshot_digest_value := private.request_hash(jsonb_build_object(
    'domain', 'unfiled.encrypted-user-search-snapshot.v1',
    'ownerId', capability_row.user_id,
    'requestDigest', capability_row.request_digest,
    'filterDigest', capability_row.filter_digest,
    'generation', private.encrypted_user_search_generation_projection(
      capability_row
    ),
    'rows', snapshot_rows_value
  ));
  select coalesce(jsonb_agg(jsonb_build_object(
    'noteId', repair.note_id,
    'currentRevision', repair.current_revision
  ) order by repair.note_id), '[]'::jsonb)
  into repair_candidates_value
  from (
    select
      snapshot.value ->> 'noteId' as note_id,
      (snapshot.value ->> 'currentRevision')::integer as current_revision
    from jsonb_array_elements(snapshot_rows_value) as snapshot(value)
    where (snapshot.value ->> 'indexEligible')::boolean is false
    order by snapshot.value ->> 'noteId'
    limit 50
  ) as repair;

  if capability_row.virtual_snapshot_digest is null then
    coverage_checked_at_value := clock_timestamp();
    update public.encrypted_user_search_capabilities
    set
      filtered_expected_note_count = expected_note_count,
      filtered_indexed_note_count = indexed_note_count,
      virtual_snapshot_digest = virtual_snapshot_digest_value,
      coverage_checked_at = coverage_checked_at_value
    where id = capability_row.id
      and state = 'leased'
      and virtual_snapshot_digest is null
    returning * into capability_row;
    if not found then
      raise exception using
        errcode = '42501', message = 'invalid_or_expired_search_lease';
    end if;
  elsif capability_row.virtual_snapshot_digest
      <> virtual_snapshot_digest_value
    or capability_row.filtered_expected_note_count <> expected_note_count
    or capability_row.filtered_indexed_note_count <> indexed_note_count
  then
    raise exception using errcode = 'P0001', message = 'stale_search_snapshot';
  end if;

  if p_cursor is not null then
    if jsonb_typeof(p_cursor) <> 'object'
      or p_cursor - array[
        'searchId', 'requestDigest', 'generationId',
        'generationRevisionToken', 'afterIndexId'
      ] <> '{}'::jsonb
      or not p_cursor ?& array[
        'searchId', 'requestDigest', 'generationId',
        'generationRevisionToken', 'afterIndexId'
      ]
      or jsonb_typeof(p_cursor -> 'searchId') <> 'string'
      or jsonb_typeof(p_cursor -> 'requestDigest') <> 'string'
      or jsonb_typeof(p_cursor -> 'generationId') <> 'string'
      or jsonb_typeof(p_cursor -> 'generationRevisionToken') <> 'number'
      or jsonb_typeof(p_cursor -> 'afterIndexId') <> 'string'
      or p_cursor ->> 'searchId' <> capability_row.id::text
      or p_cursor ->> 'requestDigest' <> capability_row.request_digest
      or p_cursor ->> 'generationId' <> capability_row.generation_id
      or p_cursor ->> 'generationRevisionToken' !~ '^[0-9]{1,19}$'
      or (p_cursor ->> 'generationRevisionToken')::bigint
        <> capability_row.generation_revision_token
      or p_cursor ->> 'afterIndexId'
        !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
    then
      raise exception using errcode = '22023', message = 'validation_failed';
    end if;
    after_index_id := p_cursor ->> 'afterIndexId';
    if not exists (
      select 1
      from public.note_rag_index as index_row
      join public.user_content_keys as content_key
        on content_key.user_id = index_row.user_id
        and content_key.key_id = index_row.index_key_id
        and content_key.key_class = index_row.index_key_class
        and content_key.key_purpose = index_row.index_key_purpose
        and content_key.key_version = index_row.index_key_version
        and content_key.key_class = 'ai_assisted'
        and content_key.key_purpose = 'object_wrap'
        and content_key.state in ('active', 'retired')
      where index_row.user_id = capability_row.user_id
        and index_row.generation_id = capability_row.generation_id
        and index_row.id = after_index_id
        and private.encrypted_user_search_note_is_eligible(
          capability_row.user_id, index_row.note_id,
          index_row.indexed_revision, p_filter_manifest
        )
    ) then
      raise exception using errcode = 'P0001', message = 'stale_search_cursor';
    end if;
  end if;

  with eligible_rows as (
    select
      index_row.id,
      index_row.note_id,
      index_row.indexed_revision,
      index_row.index_envelope,
      index_row.index_key_id,
      index_row.index_key_class,
      index_row.index_key_purpose,
      index_row.index_key_version,
      index_row.encrypted_byte_length,
      note.type,
      note.space_id,
      note.updated_at,
      note.pinned_at,
      note.archived_at,
      coalesce((
        select jsonb_agg(note_tag.tag_id order by note_tag.tag_id)
        from public.note_tags as note_tag
        where note_tag.user_id = capability_row.user_id
          and note_tag.note_id = note.id
      ), '[]'::jsonb) as tag_ids
    from public.note_rag_index as index_row
    join public.notes as note
      on note.user_id = index_row.user_id
      and note.id = index_row.note_id
    join public.user_content_keys as content_key
      on content_key.user_id = index_row.user_id
      and content_key.key_id = index_row.index_key_id
      and content_key.key_class = index_row.index_key_class
      and content_key.key_purpose = index_row.index_key_purpose
      and content_key.key_version = index_row.index_key_version
      and content_key.key_class = 'ai_assisted'
      and content_key.key_purpose = 'object_wrap'
      and content_key.state in ('active', 'retired')
    where index_row.user_id = capability_row.user_id
      and index_row.generation_id = capability_row.generation_id
      and index_row.index_key_class = 'ai_assisted'
      and index_row.index_key_purpose = 'object_wrap'
      and (after_index_id is null or index_row.id > after_index_id)
      and private.encrypted_user_search_note_is_eligible(
        capability_row.user_id, index_row.note_id,
        index_row.indexed_revision, p_filter_manifest
      )
  ), ordered_rows as (
    select
      eligible.*,
      sum(eligible.encrypted_byte_length) over (
        order by eligible.id rows unbounded preceding
      ) as running_bytes
    from eligible_rows as eligible
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
      'encryptedByteLength', page.encrypted_byte_length,
      'metadata', jsonb_build_object(
        'type', page.type,
        'spaceId', page.space_id,
        'updatedAt', private.encrypted_user_search_timestamp(page.updated_at),
        'pinnedAt', private.encrypted_user_search_timestamp(page.pinned_at),
        'archivedAt', private.encrypted_user_search_timestamp(page.archived_at),
        'tagIds', page.tag_ids
      )
    ) order by page.id), '[]'::jsonb),
    coalesce(array_agg(page.id order by page.id), array[]::text[]),
    count(*)::integer,
    coalesce(sum(page.encrypted_byte_length), 0)::integer
  into items_value, page_index_ids, returned_count, returned_bytes
  from page_rows as page;

  if returned_count > 0 then
    last_index_id := page_index_ids[returned_count];
    select coalesce(jsonb_agg(
      private.content_key_service_projection(key_row)
      order by key_row.key_id, key_row.key_version
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
      where index_row.user_id = capability_row.user_id
        and index_row.generation_id = capability_row.generation_id
        and index_row.id = any(page_index_ids)
    ) as page_key
      on page_key.user_id = key_row.user_id
      and page_key.index_key_id = key_row.key_id
      and page_key.index_key_class = key_row.key_class
      and page_key.index_key_purpose = key_row.key_purpose
      and page_key.index_key_version = key_row.key_version
    where key_row.user_id = capability_row.user_id
      and key_row.key_class = 'ai_assisted'
      and key_row.key_purpose = 'object_wrap'
      and key_row.state in ('active', 'retired');

    select exists (
      select 1
      from public.note_rag_index as index_row
      join public.user_content_keys as content_key
        on content_key.user_id = index_row.user_id
        and content_key.key_id = index_row.index_key_id
        and content_key.key_class = index_row.index_key_class
        and content_key.key_purpose = index_row.index_key_purpose
        and content_key.key_version = index_row.index_key_version
        and content_key.key_class = 'ai_assisted'
        and content_key.key_purpose = 'object_wrap'
        and content_key.state in ('active', 'retired')
      where index_row.user_id = capability_row.user_id
        and index_row.generation_id = capability_row.generation_id
        and index_row.id > last_index_id
        and private.encrypted_user_search_note_is_eligible(
          capability_row.user_id, index_row.note_id,
          index_row.indexed_revision, p_filter_manifest
        )
    ) into has_more;
  end if;

  next_cursor_value := case when has_more then jsonb_build_object(
    'searchId', capability_row.id,
    'requestDigest', capability_row.request_digest,
    'generationId', capability_row.generation_id,
    'generationRevisionToken', capability_row.generation_revision_token,
    'afterIndexId', last_index_id
  ) else null end;

  return jsonb_build_object(
    'searchId', capability_row.id,
    'ownerId', capability_row.user_id,
    'generation',
      private.encrypted_user_search_generation_projection(capability_row)
      || jsonb_build_object(
        'expectedNoteCount', expected_note_count,
        'indexedNoteCount', indexed_note_count
      ),
    'coverage', jsonb_build_object(
      'status', case when missing_or_stale_count = 0
        then 'complete' else 'incomplete' end,
      'missingOrStaleCount', missing_or_stale_count,
      'repairCandidates', repair_candidates_value,
      'repairOverflow', missing_or_stale_count > 50
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

create function public.list_encrypted_user_search_rag_page(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_filter_manifest jsonb,
  p_cursor jsonb default null,
  p_limit integer default 50,
  p_ciphertext_byte_budget integer default 2097152
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_search_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_search_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.list_encrypted_user_search_rag_page_impl(
    p_search_id, p_lease_token, p_request_digest, p_filter_manifest,
    p_cursor, p_limit, p_ciphertext_byte_budget
  );
end;
$$;

create function private.encrypted_user_search_note_is_eligible(
  p_owner_id uuid,
  p_note_id text,
  p_indexed_revision integer,
  p_filter_manifest jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.notes as note
    where note.user_id = p_owner_id
      and note.id = p_note_id
      and note.privacy = 'ai_assisted'
      and note.deleted_at is null
      and note.current_revision = p_indexed_revision
      and case p_filter_manifest ->> 'archive'
        when 'exclude' then note.archived_at is null
        when 'only' then note.archived_at is not null
        else true
      end
      and (
        jsonb_typeof(p_filter_manifest -> 'type') = 'null'
        or note.type::text = p_filter_manifest ->> 'type'
      )
      and case p_filter_manifest #>> '{space,mode}'
        when 'root' then note.space_id is null
        when 'exact' then note.space_id = p_filter_manifest #>> '{space,id}'
        else true
      end
      and (
        jsonb_typeof(p_filter_manifest -> 'updatedFrom') = 'null'
        or note.updated_at >= (p_filter_manifest ->> 'updatedFrom')::timestamptz
      )
      and (
        jsonb_typeof(p_filter_manifest -> 'updatedTo') = 'null'
        or note.updated_at < (p_filter_manifest ->> 'updatedTo')::timestamptz
      )
      and not exists (
        select 1
        from jsonb_array_elements_text(
          p_filter_manifest -> 'tagIds'
        ) as requested(tag_id)
        where not exists (
          select 1
          from public.note_tags as note_tag
          where note_tag.user_id = p_owner_id
            and note_tag.note_id = note.id
            and note_tag.tag_id = requested.tag_id
        )
      )
  );
$$;

create function private.encrypted_user_search_generation_projection(
  p_capability public.encrypted_user_search_capabilities
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'generationId', p_capability.generation_id,
    'revisionToken', p_capability.generation_revision_token,
    'attestationDigest', p_capability.generation_attestation_digest,
    'embeddingModelId', p_capability.embedding_model_id,
    'embeddingDimensions', p_capability.embedding_dimensions,
    'envelopeSchemaVersion', p_capability.envelope_schema_version
  );
$$;

create function private.encrypted_user_search_timestamp(
  p_timestamp timestamptz
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select to_char(
    p_timestamp at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
$$;

create function public.begin_encrypted_user_search(
  p_owner_id uuid,
  p_request_digest text,
  p_filter_manifest jsonb,
  p_claim_secret_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  generation_attestation_digest_value text;
  selected_generation record;
  capability_row public.encrypted_user_search_capabilities%rowtype;
  created_at_value timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_request_digest is null
    or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_claim_secret_digest is null
    or p_claim_secret_digest !~ '^[0-9a-f]{64}$'
    or not private.valid_encrypted_user_search_filter(p_filter_manifest)
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  select
    generation as generation_row,
    verification.attestation_digest as attestation_digest
  into selected_generation
  from public.rag_index_generations as generation
  join public.rag_index_generation_verifications as verification
    on verification.user_id = generation.user_id
    and verification.generation_id = generation.id
    and verification.revision_token = generation.revision_token
    and verification.verified_note_count = generation.expected_note_count
    and verification.embedding_model_id = generation.embedding_model_id
    and verification.embedding_dimensions = generation.embedding_dimensions
    and verification.envelope_schema_version = generation.envelope_schema_version
    and verification.attestation_domain
      = 'unfiled.rag-generation-attestation.v1'
    and verification.attestation_digest
      = private.request_hash(verification.attestation)
    and verification.attestation ->> 'ownerId' = generation.user_id::text
    and verification.attestation ->> 'generationId' = generation.id
    and verification.attestation ->> 'embeddingModelId'
      = generation.embedding_model_id
    and (verification.attestation ->> 'embeddingDimensions')::integer
      = generation.embedding_dimensions
    and (verification.attestation ->> 'envelopeSchemaVersion')::integer
      = generation.envelope_schema_version
    and (verification.attestation ->> 'expectedNoteCount')::integer
      = generation.expected_note_count
    and (verification.attestation ->> 'indexedNoteCount')::integer
      = generation.indexed_note_count
    and (verification.attestation ->> 'entryCount')::integer
      = generation.indexed_note_count
  where generation.user_id = p_owner_id
    and generation.state = 'active'
    and generation.expected_note_count = generation.indexed_note_count
    and generation.embedding_model_id = 'text-embedding-3-small'
    and generation.embedding_dimensions = 1536
    and generation.envelope_schema_version = 1
  for share of generation, verification;
  if not found then
    raise exception using
      errcode = 'P0001', message = 'search_generation_unavailable';
  end if;
  generation_row := selected_generation.generation_row;
  generation_attestation_digest_value := selected_generation.attestation_digest;

  created_at_value := clock_timestamp();
  insert into public.encrypted_user_search_capabilities (
    user_id, request_digest, filter_digest, claim_secret_digest,
    generation_id, generation_revision_token, embedding_model_id,
    embedding_dimensions, envelope_schema_version,
    generation_attestation_digest,
    created_at, claim_expires_at
  ) values (
    p_owner_id, p_request_digest, private.request_hash(p_filter_manifest),
    p_claim_secret_digest, generation_row.id, generation_row.revision_token,
    generation_row.embedding_model_id, generation_row.embedding_dimensions,
    generation_row.envelope_schema_version,
    generation_attestation_digest_value,
    created_at_value, created_at_value + interval '30 seconds'
  ) returning * into capability_row;

  return jsonb_build_object(
    'searchId', capability_row.id,
    'claimExpiresAt', private.encrypted_user_search_timestamp(
      capability_row.claim_expires_at
    ),
    'requestDigest', capability_row.request_digest,
    'filterDigest', capability_row.filter_digest,
    'generation', private.encrypted_user_search_generation_projection(
      capability_row
    )
  );
end;
$$;

create function private.claim_encrypted_user_search_impl(
  p_search_id uuid,
  p_claim_secret text,
  p_request_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  claim_secret_digest_value text;
  lease_secret text;
  lease_secret_digest_value text;
  claimed_at_value timestamptz;
begin
  if p_search_id is null
    or p_claim_secret is null
    or char_length(p_claim_secret) not between 32 and 256
    or p_request_digest is null
    or p_request_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  claim_secret_digest_value := encode(
    extensions.digest(convert_to(p_claim_secret, 'UTF8'), 'sha256'), 'hex'
  );
  lease_secret := extensions.gen_random_uuid()::text;
  lease_secret_digest_value := encode(
    extensions.digest(convert_to(lease_secret, 'UTF8'), 'sha256'), 'hex'
  );
  claimed_at_value := clock_timestamp();

  update public.encrypted_user_search_capabilities
  set
    state = 'leased',
    claim_secret_digest = null,
    lease_secret_digest = lease_secret_digest_value,
    claimed_at = claimed_at_value,
    lease_expires_at = claimed_at_value + interval '30 seconds'
  where id = p_search_id
    and state = 'pending'
    and claim_expires_at > claimed_at_value
    and request_digest = p_request_digest
    and claim_secret_digest = claim_secret_digest_value
  returning * into capability_row;
  if not found then
    raise exception using
      errcode = '42501', message = 'invalid_or_expired_search_capability';
  end if;

  return jsonb_build_object(
    'searchId', capability_row.id,
    'ownerId', capability_row.user_id,
    'leaseToken', lease_secret,
    'leaseExpiresAt', private.encrypted_user_search_timestamp(
      capability_row.lease_expires_at
    ),
    'requestDigest', capability_row.request_digest,
    'filterDigest', capability_row.filter_digest,
    'generation', private.encrypted_user_search_generation_projection(
      capability_row
    )
  );
end;
$$;

create function public.claim_encrypted_user_search(
  p_search_id uuid,
  p_claim_secret text,
  p_request_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_search_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_search_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.claim_encrypted_user_search_impl(
    p_search_id, p_claim_secret, p_request_digest
  );
end;
$$;

create function private.assert_encrypted_user_search_lease(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_require_current_snapshot boolean default true
)
returns public.encrypted_user_search_capabilities
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  lease_digest_value text;
begin
  if p_search_id is null
    or p_lease_token is null
    or p_lease_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_request_digest is null
    or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_require_current_snapshot is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  lease_digest_value := encode(
    extensions.digest(convert_to(p_lease_token, 'UTF8'), 'sha256'), 'hex'
  );
  select * into capability_row
  from public.encrypted_user_search_capabilities as capability
  where capability.id = p_search_id
  for update of capability;
  if not found
    or capability_row.state <> 'leased'
    or capability_row.lease_expires_at <= clock_timestamp()
    or capability_row.lease_secret_digest <> lease_digest_value
    or capability_row.request_digest <> p_request_digest
  then
    raise exception using
      errcode = '42501', message = 'invalid_or_expired_search_lease';
  end if;
  if p_require_current_snapshot and not exists (
    select 1
    from public.rag_index_generations as generation
    join public.rag_index_generation_verifications as verification
      on verification.user_id = generation.user_id
      and verification.generation_id = generation.id
      and verification.revision_token = generation.revision_token
      and verification.attestation_digest
        = capability_row.generation_attestation_digest
      and verification.attestation_domain
        = 'unfiled.rag-generation-attestation.v1'
      and verification.attestation_digest
        = private.request_hash(verification.attestation)
    where generation.user_id = capability_row.user_id
      and generation.id = capability_row.generation_id
      and generation.state = 'active'
      and generation.revision_token
        = capability_row.generation_revision_token
      and generation.embedding_model_id = capability_row.embedding_model_id
      and generation.embedding_dimensions = capability_row.embedding_dimensions
      and generation.envelope_schema_version
        = capability_row.envelope_schema_version
      and generation.embedding_model_id = 'text-embedding-3-small'
      and generation.embedding_dimensions = 1536
      and generation.expected_note_count = generation.indexed_note_count
      and verification.verified_note_count = generation.expected_note_count
      and verification.embedding_model_id = generation.embedding_model_id
      and verification.embedding_dimensions = generation.embedding_dimensions
      and verification.envelope_schema_version = generation.envelope_schema_version
      and verification.attestation ->> 'ownerId' = generation.user_id::text
      and verification.attestation ->> 'generationId' = generation.id
      and verification.attestation ->> 'embeddingModelId'
        = generation.embedding_model_id
      and (verification.attestation ->> 'embeddingDimensions')::integer
        = generation.embedding_dimensions
      and (verification.attestation ->> 'envelopeSchemaVersion')::integer
        = generation.envelope_schema_version
      and (verification.attestation ->> 'expectedNoteCount')::integer
        = generation.expected_note_count
      and (verification.attestation ->> 'indexedNoteCount')::integer
        = generation.indexed_note_count
      and (verification.attestation ->> 'entryCount')::integer
        = generation.indexed_note_count
  ) then
    raise exception using errcode = 'P0001', message = 'stale_search_snapshot';
  end if;
  return capability_row;
end;
$$;

create function private.verify_encrypted_user_search_snapshot_impl(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_filter_manifest jsonb,
  p_candidates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  requested_count integer;
  unique_index_count integer;
  unique_note_count integer;
  verified_count integer;
  candidate_digest_value text;
  verified_at_value timestamptz;
  snapshot_page jsonb;
begin
  if not private.valid_encrypted_user_search_filter(p_filter_manifest)
    or p_candidates is null
    or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 100
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_candidates) as candidate(value)
    where jsonb_typeof(candidate.value) <> 'object'
      or candidate.value - array['indexId', 'noteId', 'indexedRevision']
        <> '{}'::jsonb
      or not candidate.value ?& array[
        'indexId', 'noteId', 'indexedRevision'
      ]
      or jsonb_typeof(candidate.value -> 'indexId') <> 'string'
      or jsonb_typeof(candidate.value -> 'noteId') <> 'string'
      or jsonb_typeof(candidate.value -> 'indexedRevision') <> 'number'
      or candidate.value ->> 'indexId'
        !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
      or candidate.value ->> 'noteId'
        !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
      or candidate.value ->> 'indexedRevision' !~ '^[1-9][0-9]{0,8}$'
  ) then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select
    count(*)::integer,
    count(distinct candidate.value ->> 'indexId')::integer,
    count(distinct candidate.value ->> 'noteId')::integer
  into requested_count, unique_index_count, unique_note_count
  from jsonb_array_elements(p_candidates) as candidate(value);
  if requested_count <> unique_index_count
    or requested_count <> unique_note_count
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  capability_row := private.assert_encrypted_user_search_lease(
    p_search_id, p_lease_token, p_request_digest, true
  );
  if private.request_hash(p_filter_manifest)
    <> capability_row.filter_digest
  then
    raise exception using errcode = '42501', message = 'invalid_search_binding';
  end if;
  snapshot_page := private.list_encrypted_user_search_rag_page_impl(
    p_search_id, p_lease_token, p_request_digest,
    p_filter_manifest, null, 50, 8388608
  );
  capability_row := private.assert_encrypted_user_search_lease(
    p_search_id, p_lease_token, p_request_digest, true
  );
  if snapshot_page #>> '{coverage,status}' <> 'complete'
    or (snapshot_page #>> '{generation,expectedNoteCount}')::integer
      <> capability_row.filtered_expected_note_count
    or (snapshot_page #>> '{generation,indexedNoteCount}')::integer
      <> capability_row.filtered_indexed_note_count
  then
    raise exception using
      errcode = 'P0001', message = 'incomplete_search_coverage';
  end if;

  select count(*)::integer into verified_count
  from jsonb_array_elements(p_candidates) as candidate(value)
  join public.note_rag_index as index_row
    on index_row.user_id = capability_row.user_id
    and index_row.generation_id = capability_row.generation_id
    and index_row.id = candidate.value ->> 'indexId'
    and index_row.note_id = candidate.value ->> 'noteId'
    and index_row.indexed_revision
      = (candidate.value ->> 'indexedRevision')::integer
  join public.user_content_keys as content_key
    on content_key.user_id = index_row.user_id
    and content_key.key_id = index_row.index_key_id
    and content_key.key_class = index_row.index_key_class
    and content_key.key_purpose = index_row.index_key_purpose
    and content_key.key_version = index_row.index_key_version
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'object_wrap'
    and content_key.state in ('active', 'retired')
  where index_row.index_key_class = 'ai_assisted'
    and index_row.index_key_purpose = 'object_wrap'
    and private.encrypted_user_search_note_is_eligible(
      capability_row.user_id, index_row.note_id,
      index_row.indexed_revision, p_filter_manifest
    );
  if verified_count <> requested_count then
    raise exception using errcode = 'P0001', message = 'stale_search_snapshot';
  end if;

  candidate_digest_value := private.request_hash(p_candidates);
  verified_at_value := clock_timestamp();
  update public.encrypted_user_search_capabilities
  set
    verified_candidate_digest = candidate_digest_value,
    verified_at = verified_at_value
  where id = capability_row.id
    and state = 'leased'
    and lease_secret_digest = capability_row.lease_secret_digest;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_search_lease';
  end if;

  return jsonb_build_object(
    'searchId', capability_row.id,
    'snapshotVerified', true,
    'verifiedCandidateCount', verified_count,
    'candidateDigest', candidate_digest_value,
    'generationRevisionToken', capability_row.generation_revision_token
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

create function public.verify_encrypted_user_search_snapshot(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_filter_manifest jsonb,
  p_candidates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_search_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_search_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.verify_encrypted_user_search_snapshot_impl(
    p_search_id, p_lease_token, p_request_digest,
    p_filter_manifest, p_candidates
  );
end;
$$;

create function private.complete_encrypted_user_search_impl(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  completed_at_value timestamptz;
begin
  capability_row := private.assert_encrypted_user_search_lease(
    p_search_id, p_lease_token, p_request_digest, true
  );
  if capability_row.verified_at is null
    or capability_row.verified_candidate_digest is null
  then
    raise exception using errcode = 'P0001', message = 'search_snapshot_not_verified';
  end if;
  completed_at_value := clock_timestamp();
  update public.encrypted_user_search_capabilities
  set
    state = 'completed',
    lease_secret_digest = null,
    lease_expires_at = null,
    completed_at = completed_at_value
  where id = capability_row.id
    and state = 'leased'
    and lease_secret_digest = capability_row.lease_secret_digest;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_search_lease';
  end if;
  return jsonb_build_object(
    'searchId', capability_row.id,
    'state', 'completed',
    'completedAt', private.encrypted_user_search_timestamp(completed_at_value),
    'candidateDigest', capability_row.verified_candidate_digest
  );
end;
$$;

create function public.complete_encrypted_user_search(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_search_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_search_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.complete_encrypted_user_search_impl(
    p_search_id, p_lease_token, p_request_digest
  );
end;
$$;

create function private.fail_encrypted_user_search_impl(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_failure_code public.safe_error_code
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  capability_row public.encrypted_user_search_capabilities%rowtype;
  failed_at_value timestamptz;
begin
  if p_failure_code is null then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  capability_row := private.assert_encrypted_user_search_lease(
    p_search_id, p_lease_token, p_request_digest, false
  );
  failed_at_value := clock_timestamp();
  update public.encrypted_user_search_capabilities
  set
    state = 'failed',
    lease_secret_digest = null,
    lease_expires_at = null,
    failed_at = failed_at_value,
    failure_code = p_failure_code
  where id = capability_row.id
    and state = 'leased'
    and lease_secret_digest = capability_row.lease_secret_digest;
  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_search_lease';
  end if;
  return jsonb_build_object(
    'searchId', capability_row.id,
    'state', 'failed',
    'failedAt', private.encrypted_user_search_timestamp(failed_at_value),
    'failureCode', p_failure_code
  );
end;
$$;

create function public.fail_encrypted_user_search(
  p_search_id uuid,
  p_lease_token text,
  p_request_digest text,
  p_failure_code public.safe_error_code
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if session_user <> 'unfiled_search_worker'
    or current_setting('role', true)
      not in ('none', 'unfiled_search_worker')
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  return private.fail_encrypted_user_search_impl(
    p_search_id, p_lease_token, p_request_digest, p_failure_code
  );
end;
$$;

alter table public.encrypted_user_search_capabilities owner to postgres;
alter function private.valid_encrypted_user_search_filter(jsonb)
  owner to postgres;
alter function private.encrypted_user_search_note_is_eligible(
  uuid, text, integer, jsonb
) owner to postgres;
alter function private.encrypted_user_search_generation_projection(
  public.encrypted_user_search_capabilities
) owner to postgres;
alter function private.encrypted_user_search_timestamp(timestamptz)
  owner to postgres;
alter function private.claim_encrypted_user_search_impl(uuid, text, text)
  owner to postgres;
alter function private.assert_encrypted_user_search_lease(
  uuid, text, text, boolean
) owner to postgres;
alter function private.list_encrypted_user_search_rag_page_impl(
  uuid, text, text, jsonb, jsonb, integer, integer
) owner to postgres;
alter function private.verify_encrypted_user_search_snapshot_impl(
  uuid, text, text, jsonb, jsonb
) owner to postgres;
alter function private.complete_encrypted_user_search_impl(uuid, text, text)
  owner to postgres;
alter function private.fail_encrypted_user_search_impl(
  uuid, text, text, public.safe_error_code
) owner to postgres;
alter function public.begin_encrypted_user_search(uuid, text, jsonb, text)
  owner to postgres;
alter function public.claim_encrypted_user_search(uuid, text, text)
  owner to postgres;
alter function public.list_encrypted_user_search_rag_page(
  uuid, text, text, jsonb, jsonb, integer, integer
) owner to postgres;
alter function public.verify_encrypted_user_search_snapshot(
  uuid, text, text, jsonb, jsonb
) owner to postgres;
alter function public.complete_encrypted_user_search(uuid, text, text)
  owner to postgres;
alter function public.fail_encrypted_user_search(
  uuid, text, text, public.safe_error_code
) owner to postgres;

-- Rebuild a closed capability allowlist. The search worker receives no
-- relation, sequence, private-schema, service-role, generic key, organizer,
-- index-worker, or verifier capability.
revoke all privileges on all tables in schema public
from unfiled_search_worker;
revoke all privileges on all sequences in schema public
from unfiled_search_worker;
revoke all privileges on all tables in schema private
from unfiled_search_worker;
revoke all privileges on all sequences in schema private
from unfiled_search_worker;
revoke execute on all functions in schema public
from unfiled_search_worker;
revoke execute on all functions in schema private
from unfiled_search_worker;
revoke all privileges on schema private
from unfiled_search_worker;
revoke create on schema public
from unfiled_search_worker;
grant usage on schema public
to unfiled_search_worker;

revoke all on table public.encrypted_user_search_capabilities
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;

revoke execute on function public.begin_encrypted_user_search(
  uuid, text, jsonb, text
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
grant execute on function public.begin_encrypted_user_search(
  uuid, text, jsonb, text
) to service_role;

revoke execute on function public.claim_encrypted_user_search(
  uuid, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.list_encrypted_user_search_rag_page(
  uuid, text, text, jsonb, jsonb, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.verify_encrypted_user_search_snapshot(
  uuid, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.complete_encrypted_user_search(
  uuid, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.fail_encrypted_user_search(
  uuid, text, text, public.safe_error_code
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

grant execute on function public.claim_encrypted_user_search(
  uuid, text, text
) to unfiled_search_worker;
grant execute on function public.list_encrypted_user_search_rag_page(
  uuid, text, text, jsonb, jsonb, integer, integer
) to unfiled_search_worker;
grant execute on function public.verify_encrypted_user_search_snapshot(
  uuid, text, text, jsonb, jsonb
) to unfiled_search_worker;
grant execute on function public.complete_encrypted_user_search(
  uuid, text, text
) to unfiled_search_worker;
grant execute on function public.fail_encrypted_user_search(
  uuid, text, text, public.safe_error_code
) to unfiled_search_worker;

revoke execute on function private.valid_encrypted_user_search_filter(jsonb)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.encrypted_user_search_note_is_eligible(
  uuid, text, integer, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.encrypted_user_search_generation_projection(
  public.encrypted_user_search_capabilities
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.encrypted_user_search_timestamp(timestamptz)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.claim_encrypted_user_search_impl(
  uuid, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.assert_encrypted_user_search_lease(
  uuid, text, text, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.list_encrypted_user_search_rag_page_impl(
  uuid, text, text, jsonb, jsonb, integer, integer
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.verify_encrypted_user_search_snapshot_impl(
  uuid, text, text, jsonb, jsonb
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.complete_encrypted_user_search_impl(
  uuid, text, text
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
revoke execute on function private.fail_encrypted_user_search_impl(
  uuid, text, text, public.safe_error_code
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;
