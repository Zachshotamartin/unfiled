create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.search_filter(
  p_archive text default 'exclude',
  p_type text default null,
  p_space_mode text default 'any',
  p_space_id text default null,
  p_tag_ids jsonb default '[]'::jsonb,
  p_updated_from text default null,
  p_updated_to text default null,
  p_privacy text default 'ai_assisted'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'archive', p_archive,
    'privacy', p_privacy,
    'type', p_type,
    'space', jsonb_build_object('mode', p_space_mode, 'id', p_space_id),
    'tagIds', p_tag_ids,
    'updatedFrom', p_updated_from,
    'updatedTo', p_updated_to
  );
$$;

create function pg_temp.search_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_seed text default 'F'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', p_key_id,
    'context', jsonb_build_object(
      'tenantId', p_owner_id::text,
      'resourceId', p_resource_id,
      'recordVersion', p_record_version,
      'kind', p_kind
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16),
      'ciphertext', repeat(left(p_seed, 1), 80)
    )
  );
$$;

create function pg_temp.caught_error(p_statement text)
returns jsonb
language plpgsql
as $$
begin
  execute p_statement;
  return null;
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

create temporary table f_search_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on f_search_values to service_role;

-- Schema, exact capability vocabulary, and role isolation.
select has_table(
  'public', 'encrypted_user_search_capabilities',
  'user search has a digest-only capability ledger'
);
select has_function(
  'public', 'begin_encrypted_user_search',
  array['uuid', 'text', 'jsonb', 'text'],
  'the web service can begin one bound search capability'
);
select has_function(
  'public', 'claim_encrypted_user_search',
  array['uuid', 'text', 'text'],
  'the isolated worker can claim once with the raw secret'
);
select has_function(
  'public', 'list_encrypted_user_search_rag_page',
  array['uuid', 'text', 'text', 'jsonb', 'jsonb', 'integer', 'integer'],
  'the isolated worker has a lease-bound encrypted page RPC'
);
select has_function(
  'public', 'verify_encrypted_user_search_snapshot',
  array['uuid', 'text', 'text', 'jsonb', 'jsonb'],
  'the isolated worker can revalidate the virtual snapshot'
);
select has_function(
  'public', 'complete_encrypted_user_search',
  array['uuid', 'text', 'text'],
  'the isolated worker can terminalize a verified search'
);
select has_function(
  'public', 'fail_encrypted_user_search',
  array['uuid', 'text', 'text', 'safe_error_code'],
  'the isolated worker can terminalize a failed search'
);

select ok(
  (
    select not rolsuper
      and not rolcreaterole
      and not rolcreatedb
      and not rolcanlogin
      and not rolinherit
      and not rolreplication
      and not rolbypassrls
    from pg_roles where rolname = 'unfiled_search_worker'
  )
    and not exists (
      select 1
      from pg_auth_members as membership
      join pg_roles as granted on granted.oid = membership.roleid
      join pg_roles as member on member.oid = membership.member
      join pg_roles as grantor on grantor.oid = membership.grantor
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
    ),
  'the search worker is NOLOGIN, non-bypass, non-inheriting, and membership-free'
);

select ok(
  (
    select count(*) = 5
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_search_worker', procedure.oid, 'EXECUTE'
      )
  )
    and has_function_privilege(
      'unfiled_search_worker',
      'public.claim_encrypted_user_search(uuid,text,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_search_worker',
      'public.list_encrypted_user_search_rag_page(uuid,text,text,jsonb,jsonb,integer,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_search_worker',
      'public.verify_encrypted_user_search_snapshot(uuid,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_search_worker',
      'public.complete_encrypted_user_search(uuid,text,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'unfiled_search_worker',
      'public.fail_encrypted_user_search(uuid,text,text,public.safe_error_code)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_search_worker',
      'public.begin_encrypted_user_search(uuid,text,jsonb,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_search_worker',
      'public.list_active_note_rag_index(uuid,jsonb,integer,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_search_worker',
      'public.claim_encrypted_organizer_jobs(text,integer,integer)', 'EXECUTE'
    ),
  'the search worker has exactly five search RPCs and no generic index or organizer capability'
);

select ok(
  not has_schema_privilege('unfiled_search_worker', 'private', 'USAGE')
    and not exists (
      select 1
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'private')
        and relation.relkind in ('r', 'p', 'v', 'm', 'f')
        and (
          has_table_privilege('unfiled_search_worker', relation.oid, 'SELECT')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'INSERT')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'UPDATE')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'DELETE')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'TRUNCATE')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'REFERENCES')
          or has_table_privilege('unfiled_search_worker', relation.oid, 'TRIGGER')
        )
    )
    and not exists (
      select 1
      from pg_class as sequence
      join pg_namespace as namespace on namespace.oid = sequence.relnamespace
      where namespace.nspname in ('public', 'private')
        and sequence.relkind = 'S'
        and (
          has_sequence_privilege('unfiled_search_worker', sequence.oid, 'USAGE')
          or has_sequence_privilege('unfiled_search_worker', sequence.oid, 'SELECT')
          or has_sequence_privilege('unfiled_search_worker', sequence.oid, 'UPDATE')
        )
    ),
  'the search worker has no direct relation, sequence, or private-schema privilege'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_encrypted_user_search(uuid,text,jsonb,text)', 'EXECUTE'
  )
    and not has_function_privilege(
      'service_role',
      'public.claim_encrypted_user_search(uuid,text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.list_encrypted_user_search_rag_page(uuid,text,text,jsonb,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_table_privilege(
      'service_role', 'public.encrypted_user_search_capabilities', 'SELECT'
    ),
  'service_role can only begin and cannot inspect or exercise worker capabilities'
);

select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'public.encrypted_user_search_capabilities'::regclass
  )
    and not exists (
      select 1
      from pg_attribute
      where attrelid = 'public.encrypted_user_search_capabilities'::regclass
        and attnum > 0 and not attisdropped
        and (
          attname in ('query', 'filter_manifest', 'claim_secret', 'lease_token')
          or atttypid in ('json'::regtype, 'jsonb'::regtype)
        )
    ),
  'forced-RLS capability rows contain only digests and content-free scalar metadata'
);

select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    join pg_roles as owner_role on owner_role.oid = procedure.proowner
    where procedure.proname like '%encrypted_user_search%'
      and (
        owner_role.rolname <> 'postgres'
        or not (procedure.proconfig @> array['search_path=""'])
        or (
          namespace.nspname = 'public'
          and not procedure.prosecdef
        )
      )
  ),
  'all search functions are postgres-owned with an empty path and every public RPC is SECURITY DEFINER'
);

select ok(
  private.valid_encrypted_user_search_filter(pg_temp.search_filter(
    'exclude', 'log', 'exact', 'spc_00000000000000000000000009',
    '["tag_93000000000000000000000001","tag_93000000000000000000000002"]',
    '2026-08-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
  ))
    and private.valid_encrypted_user_search_filter(pg_temp.search_filter(
      'only', null, 'root', null, '[]', null, null
    ))
    and not private.valid_encrypted_user_search_filter(pg_temp.search_filter(
      'exclude', null, 'any', null, '[]', null, null, 'private_manual'
    ))
    and not private.valid_encrypted_user_search_filter(pg_temp.search_filter(
      'exclude', null, 'any', null,
      '["tag_93000000000000000000000002","tag_93000000000000000000000001"]'
    ))
    and not private.valid_encrypted_user_search_filter(pg_temp.search_filter(
      'exclude', null, 'any', null, '[]',
      '2026-09-02T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    )),
  'canonical filters bind archive, type, space, sorted conjunctive tags, dates, and AI-only privacy'
);

-- Create two independently keyed owners and deterministic encrypted indexes.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/93000000-0000-4000-8000-000000000001',
  decode(repeat('93', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'f.search.ai.v1'
);
select public.register_user_content_key(
  '11111111-1111-4111-8111-111111111111',
  'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/93000000-0000-4000-8000-000000000002',
  decode(repeat('94', 32), 'hex')
);
select public.activate_user_content_key(
  '11111111-1111-4111-8111-111111111111', 'f.search.ai.v1'
);
reset role;

insert into public.tags(id, user_id, name) values
  (
    'tag_93000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 'search-one'
  ),
  (
    'tag_93000000000000000000000002',
    '22222222-2222-4222-8222-222222222222', 'search-two'
  );

insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, privacy, archived_at, deleted_at, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values
  (
    'note_93000000000000000000000001',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'log',
    'matching one', '[encrypted]', '{"schemaVersion":1}', 1,
    'ai_assisted', null, null,
    '2026-08-31 10:00:00+00', '2026-08-31 10:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000001',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'A'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_93000000000000000000000002',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'log',
    'only one tag', '[encrypted]', '{"schemaVersion":1}', 1,
    'ai_assisted', null, null,
    '2026-08-31 11:00:00+00', '2026-08-31 11:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000002',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'B'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_93000000000000000000000003',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'log',
    'archived match', '[encrypted]', '{"schemaVersion":1}', 1,
    'ai_assisted', '2026-08-31 12:00:00+00', null,
    '2026-08-31 12:00:00+00', '2026-08-31 12:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000003',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'C'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_93000000000000000000000004',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'generic',
    'stale generic', '[encrypted]', '{}', 1,
    'ai_assisted', null, null,
    '2026-08-31 13:00:00+00', '2026-08-31 13:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000004',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'D'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_93000000000000000000000005',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'log',
    'deleted match', '[encrypted]', '{"schemaVersion":1}', 1,
    'ai_assisted', null, null,
    '2026-08-31 14:00:00+00', '2026-08-31 14:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000005',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'E'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_93000000000000000000000006',
    '22222222-2222-4222-8222-222222222222',
    'spc_00000000000000000000000009', 'log',
    'matching two', '[encrypted]', '{"schemaVersion":1}', 1,
    'ai_assisted', null, null,
    '2026-09-01 10:00:00+00', '2026-09-01 10:00:00+00',
    pg_temp.search_envelope(
      'note_93000000000000000000000006',
      '22222222-2222-4222-8222-222222222222', 1,
      'note_content', 'f.search.ai.v1', 'F'
    ), 'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.note_tags(note_id, tag_id, user_id) values
  ('note_93000000000000000000000001', 'tag_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000001', 'tag_93000000000000000000000002', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000002', 'tag_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000003', 'tag_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000003', 'tag_93000000000000000000000002', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000005', 'tag_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000005', 'tag_93000000000000000000000002', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000006', 'tag_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'),
  ('note_93000000000000000000000006', 'tag_93000000000000000000000002', '22222222-2222-4222-8222-222222222222');

insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  envelope_schema_version, state, expected_note_count, indexed_note_count,
  revision_token, activated_at
) values
  (
    'igen_93000000000000000000000001',
    '22222222-2222-4222-8222-222222222222',
    'text-embedding-3-small', 1536, 1, 'active', 6, 6, 7,
    '2026-09-01 11:00:00+00'
  ),
  (
    'igen_93000000000000000000000002',
    '11111111-1111-4111-8111-111111111111',
    'text-embedding-3-small', 1536, 1, 'active', 3, 1, 9,
    '2026-09-01 11:00:00+00'
  );

insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision,
  index_envelope, index_key_id, index_key_class, index_key_purpose,
  index_key_version, encrypted_byte_length
)
select
  fixture.index_id,
  fixture.owner_id,
  fixture.note_id,
  fixture.generation_id,
  fixture.indexed_revision,
  pg_temp.search_envelope(
    fixture.index_id, fixture.owner_id, fixture.indexed_revision,
    'note_rag_index', 'f.search.ai.v1', fixture.seed
  ),
  'f.search.ai.v1', 'ai_assisted', 'object_wrap', 1, 60
from (values
  ('irw_93000000000000000000000001', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000001', 'igen_93000000000000000000000001', 1, 'A'),
  ('irw_93000000000000000000000002', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000002', 'igen_93000000000000000000000001', 1, 'B'),
  ('irw_93000000000000000000000003', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000003', 'igen_93000000000000000000000001', 1, 'C'),
  ('irw_93000000000000000000000004', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000004', 'igen_93000000000000000000000001', 1, 'D'),
  ('irw_93000000000000000000000005', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000005', 'igen_93000000000000000000000001', 1, 'E'),
  ('irw_93000000000000000000000006', '22222222-2222-4222-8222-222222222222'::uuid, 'note_93000000000000000000000006', 'igen_93000000000000000000000001', 1, 'F'),
  ('irw_93000000000000000000000011', '11111111-1111-4111-8111-111111111111'::uuid, 'note_00000000000000000000000001', 'igen_93000000000000000000000002', 2, 'X')
) as fixture(
  index_id, owner_id, note_id, generation_id, indexed_revision, seed
);

-- These transitions model real lifecycle races: the source trigger deletes
-- private/deleted indexes and leaves revision-stale rows unavailable while it
-- advances the generation token.
update public.notes
set
  current_revision = 2,
  content_envelope = pg_temp.search_envelope(
    id, user_id, 2, 'note_content', 'f.search.ai.v1', 'D'
  )
where id = 'note_93000000000000000000000004';
update public.notes
set deleted_at = '2026-08-31 14:00:00+00'
where id = 'note_93000000000000000000000005';

-- Model the verifier's immutable, content-free publication. Direct fixture
-- writes deliberately preserve one stale row so the search page can prove its
-- stricter current-note coverage check independently of generation admission.
update public.rag_index_generations as generation
set
  expected_note_count = fixture.index_count,
  indexed_note_count = fixture.index_count
from (
  select generation_id, count(*)::integer as index_count
  from public.note_rag_index
  group by generation_id
) as fixture
where generation.id = fixture.generation_id;

insert into public.rag_index_generation_verifications (
  user_id, generation_id, revision_token, verified_note_count,
  attestation, attestation_digest, attestation_domain,
  embedding_model_id, embedding_dimensions, envelope_schema_version
)
select
  generation.user_id,
  generation.id,
  generation.revision_token,
  generation.indexed_note_count,
  attestation.value,
  private.request_hash(attestation.value),
  'unfiled.rag-generation-attestation.v1',
  generation.embedding_model_id,
  generation.embedding_dimensions,
  generation.envelope_schema_version
from public.rag_index_generations as generation
cross join lateral (
  select private.rag_generation_attestation(
    generation.user_id, generation.id, generation.revision_token
  ) as value
) as attestation
where generation.id in (
  'igen_93000000000000000000000001',
  'igen_93000000000000000000000002'
);

create temporary table f_generation_verification_backup
on commit drop
as
select *
from public.rag_index_generation_verifications
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_93000000000000000000000001';

-- Admission fails closed before a capability exists unless the active
-- generation is complete, independently verified, internally attested, and
-- pinned to the one supported embedding profile.
delete from public.rag_index_generation_verifications
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_93000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.begin_encrypted_user_search(
      '22222222-2222-4222-8222-222222222222', repeat('1', 64),
      pg_temp.search_filter('exclude', null, 'any', null, '[]', null, null),
      repeat('2', 64)
    )
  $statement$) ->> 'message',
  'search_generation_unavailable',
  'begin rejects an active generation with no verifier publication'
);
reset role;
insert into public.rag_index_generation_verifications
select * from f_generation_verification_backup;

update public.rag_index_generations
set indexed_note_count = expected_note_count - 1
where id = 'igen_93000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.begin_encrypted_user_search(
      '22222222-2222-4222-8222-222222222222', repeat('3', 64),
      pg_temp.search_filter('exclude', null, 'any', null, '[]', null, null),
      repeat('4', 64)
    )
  $statement$) ->> 'message',
  'search_generation_unavailable',
  'begin rejects a verified generation whose indexed count is incomplete'
);
reset role;
update public.rag_index_generations
set indexed_note_count = expected_note_count
where id = 'igen_93000000000000000000000001';

update public.rag_index_generation_verifications
set attestation = jsonb_set(
  attestation, '{entryCount}', to_jsonb(999), false
)
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_93000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.begin_encrypted_user_search(
      '22222222-2222-4222-8222-222222222222', repeat('5', 64),
      pg_temp.search_filter('exclude', null, 'any', null, '[]', null, null),
      repeat('6', 64)
    )
  $statement$) ->> 'message',
  'search_generation_unavailable',
  'begin rejects verifier attestation whose body drifted from its digest'
);
reset role;
delete from public.rag_index_generation_verifications
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_93000000000000000000000001';
insert into public.rag_index_generation_verifications
select * from f_generation_verification_backup;

update public.rag_index_generations
set embedding_model_id = 'unsupported-search-model'
where id = 'igen_93000000000000000000000001';
with current_attestation as (
  select private.rag_generation_attestation(
    user_id, id, revision_token
  ) as value
  from public.rag_index_generations
  where id = 'igen_93000000000000000000000001'
)
update public.rag_index_generation_verifications as verification
set
  embedding_model_id = 'unsupported-search-model',
  attestation = current_attestation.value,
  attestation_digest = private.request_hash(current_attestation.value)
from current_attestation
where verification.user_id = '22222222-2222-4222-8222-222222222222'
  and verification.generation_id = 'igen_93000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.begin_encrypted_user_search(
      '22222222-2222-4222-8222-222222222222', repeat('7', 64),
      pg_temp.search_filter('exclude', null, 'any', null, '[]', null, null),
      repeat('8', 64)
    )
  $statement$) ->> 'message',
  'search_generation_unavailable',
  'begin rejects a self-consistent attestation for an unsupported embedding profile'
);
reset role;
update public.rag_index_generations
set embedding_model_id = 'text-embedding-3-small'
where id = 'igen_93000000000000000000000001';
delete from public.rag_index_generation_verifications
where user_id = '22222222-2222-4222-8222-222222222222'
  and generation_id = 'igen_93000000000000000000000001';
insert into public.rag_index_generation_verifications
select * from f_generation_verification_backup;

insert into f_search_values(key, value) values (
  'complete-filter', pg_temp.search_filter(
    'exclude', 'log', 'exact', 'spc_00000000000000000000000009',
    '["tag_93000000000000000000000001","tag_93000000000000000000000002"]',
    '2026-08-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'
  )
), (
  'incomplete-filter', pg_temp.search_filter(
    'exclude', 'generic', 'exact', 'spc_00000000000000000000000009',
    '[]', null, null
  )
), (
  'owner-one-filter', pg_temp.search_filter(
    'include', null, 'any', null, '[]', null, null
  )
);

-- A service-created capability persists only hashes and a frozen generation.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'main-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222',
  repeat('a', 64),
  (select value from f_search_values where key = 'complete-filter'),
  encode(extensions.digest(
    convert_to('main-search-claim-secret-0000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
);
reset role;

select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'main-begin'),
    array[
      'searchId', 'claimExpiresAt', 'requestDigest',
      'filterDigest', 'generation'
    ]
  )
    and private.jsonb_has_exact_keys(
      (select value -> 'generation' from f_search_values
       where key = 'main-begin'),
      array[
        'generationId', 'revisionToken', 'attestationDigest', 'embeddingModelId',
        'embeddingDimensions', 'envelopeSchemaVersion'
      ]
    )
    and (select value #>> '{generation,generationId}'
      from f_search_values where key = 'main-begin')
        = 'igen_93000000000000000000000001'
    and (select value ->> 'requestDigest'
      from f_search_values where key = 'main-begin') = repeat('a', 64),
  'begin returns an exact content-free active-generation snapshot'
);

select ok(
  (
    select claim_expires_at - created_at = interval '30 seconds'
      and state = 'pending'
      and claim_secret_digest = encode(extensions.digest(
        convert_to('main-search-claim-secret-0000000000000001', 'UTF8'),
        'sha256'
      ), 'hex')
      and to_jsonb(capability)::text
        not like '%main-search-claim-secret-0000000000000001%'
      and to_jsonb(capability)::text
        not like '%tag_93000000000000000000000001%'
      and to_jsonb(capability)::text not like '%2026-08-01T00:00:00.000Z%'
    from public.encrypted_user_search_capabilities as capability
    where id = (
      select (value ->> 'searchId')::uuid
      from f_search_values where key = 'main-begin'
    )
  ),
  'begin stores a 30-second SHA-256 capability without secret or filter plaintext'
);

select is(
  (
    select pg_temp.caught_error(format(
      'select private.claim_encrypted_user_search_impl(%L::uuid,%L,%L)',
      value ->> 'searchId',
      'wrong-search-claim-secret-0000000000000000', repeat('a', 64)
    )) ->> 'message'
    from f_search_values where key = 'main-begin'
  ),
  'invalid_or_expired_search_capability',
  'a wrong claim secret is denied without consuming the capability'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.claim_encrypted_user_search_impl(%L::uuid,%L,%L)',
      value ->> 'searchId',
      'main-search-claim-secret-0000000000000001', repeat('b', 64)
    )) ->> 'message'
    from f_search_values where key = 'main-begin'
  ),
  'invalid_or_expired_search_capability',
  'a wrong full-request digest is denied without consuming the capability'
);

insert into f_search_values(key, value)
select 'main-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'main-search-claim-secret-0000000000000001', repeat('a', 64)
)
from f_search_values where key = 'main-begin';

select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'main-claim'),
    array[
      'searchId', 'ownerId', 'leaseToken', 'leaseExpiresAt',
      'requestDigest', 'filterDigest', 'generation'
    ]
  )
    and (select value ->> 'ownerId'
      from f_search_values where key = 'main-claim')
        = '22222222-2222-4222-8222-222222222222'
    and (select value ->> 'leaseToken'
      from f_search_values where key = 'main-claim')
        ~ '^[0-9a-f-]{36}$'
    and (
      select state = 'leased'
        and claim_secret_digest is null
        and lease_expires_at - claimed_at = interval '30 seconds'
        and lease_secret_digest = encode(extensions.digest(
          convert_to((select value ->> 'leaseToken' from f_search_values
            where key = 'main-claim'), 'UTF8'), 'sha256'
        ), 'hex')
        and to_jsonb(capability)::text not like '%"leaseToken"%'
      from public.encrypted_user_search_capabilities as capability
      where id = (
        select (value ->> 'searchId')::uuid
        from f_search_values where key = 'main-claim'
      )
    ),
  'claim atomically burns the claim digest and returns one 30-second hash-stored lease'
);

select is(
  (
    select pg_temp.caught_error(format(
      'select private.claim_encrypted_user_search_impl(%L::uuid,%L,%L)',
      begin_value.value ->> 'searchId',
      'main-search-claim-secret-0000000000000001', repeat('a', 64)
    )) ->> 'message'
    from f_search_values as begin_value where begin_value.key = 'main-begin'
  ),
  'invalid_or_expired_search_capability',
  'a claimed capability cannot be replayed'
);

select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,1,262160)',
      claim.value ->> 'searchId',
      '00000000-0000-4000-8000-000000000000', repeat('a', 64),
      filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'main-claim' and filter_value.key = 'complete-filter'
  ),
  'invalid_or_expired_search_lease',
  'a wrong lease token cannot page encrypted rows'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,1,262160)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('b', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'main-claim' and filter_value.key = 'complete-filter'
  ),
  'invalid_or_expired_search_lease',
  'a lease cannot be replayed with another full-request digest'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,1,262160)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('a', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'main-claim' and filter_value.key = 'incomplete-filter'
  ),
  'invalid_search_binding',
  'the stored filter digest rejects a different valid filter manifest'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,1,262160)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('a', 64), pg_temp.search_filter(
        'exclude', 'log', 'exact', 'spc_00000000000000000000000009',
        '[]', null, null, 'private_manual'
      )::text
    )) ->> 'message'
    from f_search_values as claim where claim.key = 'main-claim'
  ),
  'validation_failed',
  'private_manual is impossible through the worker page implementation'
);

insert into f_search_values(key, value)
select 'main-page-one', private.list_encrypted_user_search_rag_page_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('a', 64),
  filter_value.value, null, 1, 262160
)
from f_search_values as claim
cross join f_search_values as filter_value
where claim.key = 'main-claim' and filter_value.key = 'complete-filter';

insert into f_search_values(key, value)
select 'main-page-two', private.list_encrypted_user_search_rag_page_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('a', 64),
  filter_value.value,
  page_one.value #> '{page,nextCursor}', 1, 262160
)
from f_search_values as claim
cross join f_search_values as filter_value
cross join f_search_values as page_one
where claim.key = 'main-claim'
  and filter_value.key = 'complete-filter'
  and page_one.key = 'main-page-one';

select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'main-page-one'),
    array['searchId', 'ownerId', 'generation', 'coverage', 'items', 'keys', 'page']
  )
    and private.jsonb_has_exact_keys(
      (select value -> 'generation' from f_search_values
       where key = 'main-page-one'),
      array[
        'generationId', 'revisionToken', 'attestationDigest', 'embeddingModelId',
        'embeddingDimensions', 'envelopeSchemaVersion',
        'expectedNoteCount', 'indexedNoteCount'
      ]
    )
    and private.jsonb_has_exact_keys(
      (select value -> 'coverage' from f_search_values
       where key = 'main-page-one'),
      array[
        'status', 'missingOrStaleCount',
        'repairCandidates', 'repairOverflow'
      ]
    )
    and private.jsonb_has_exact_keys(
      (select value #> '{items,0}' from f_search_values
       where key = 'main-page-one'),
      array[
        'indexId', 'noteId', 'indexedRevision', 'cipher',
        'encryptedByteLength', 'metadata'
      ]
    )
    and private.jsonb_has_exact_keys(
      (select value #> '{items,0,metadata}' from f_search_values
       where key = 'main-page-one'),
      array['type', 'spaceId', 'updatedAt', 'pinnedAt', 'archivedAt', 'tagIds']
    ),
  'encrypted list pages use exact strict-parser keys for generation, coverage, items, and metadata'
);

select ok(
  (select value #>> '{generation,expectedNoteCount}'
    from f_search_values where key = 'main-page-one') = '2'
    and (select value #>> '{generation,indexedNoteCount}'
      from f_search_values where key = 'main-page-one') = '2'
    and (select value #>> '{coverage,status}'
      from f_search_values where key = 'main-page-one') = 'complete'
    and (select value #>> '{coverage,missingOrStaleCount}'
      from f_search_values where key = 'main-page-one') = '0'
    and (select value #>> '{coverage,repairOverflow}'
      from f_search_values where key = 'main-page-one') = 'false'
    and (select value #>> '{page,returnedCount}'
      from f_search_values where key = 'main-page-one') = '1'
    and (select value #>> '{page,hasMore}'
      from f_search_values where key = 'main-page-one') = 'true'
    and (select value #>> '{page,returnedCount}'
      from f_search_values where key = 'main-page-two') = '1'
    and (select value #>> '{page,hasMore}'
      from f_search_values where key = 'main-page-two') = 'false'
    and (
      select array_agg(item.value ->> 'noteId' order by item.value ->> 'noteId')
      from (
        select jsonb_array_elements(value -> 'items') as value
        from f_search_values where key in ('main-page-one', 'main-page-two')
      ) as item
    ) = array[
      'note_93000000000000000000000001',
      'note_93000000000000000000000006'
    ]::text[],
  'exact filters use tag AND semantics and exclude archived, deleted, stale, private, and cross-owner rows'
);

select ok(
  (
    select filtered_expected_note_count = 2
      and filtered_indexed_note_count = 2
      and virtual_snapshot_digest ~ '^[0-9a-f]{64}$'
      and coverage_checked_at is not null
      and to_jsonb(capability)::text
        not like '%tag_93000000000000000000000001%'
    from public.encrypted_user_search_capabilities as capability
    where id = (
      select (value ->> 'searchId')::uuid
      from f_search_values where key = 'main-claim'
    )
  )
    and (select value #>> '{items,0,cipher,keyClass}'
      from f_search_values where key = 'main-page-one') = 'ai_assisted'
    and (select value #>> '{keys,0,keyClass}'
      from f_search_values where key = 'main-page-one') = 'ai_assisted',
  'filter-specific coverage persists only a digest and discloses only AI-assisted ciphers and keys'
);

insert into f_search_values(key, value)
select 'main-candidates', jsonb_agg(jsonb_build_object(
  'indexId', item.value ->> 'indexId',
  'noteId', item.value ->> 'noteId',
  'indexedRevision', (item.value ->> 'indexedRevision')::integer
) order by item.value ->> 'indexId')
from (
  select jsonb_array_elements(value -> 'items') as value
  from f_search_values where key in ('main-page-one', 'main-page-two')
) as item;

select is(
  (
    select pg_temp.caught_error(format(
      'select private.verify_encrypted_user_search_snapshot_impl(%L::uuid,%L,%L,%L::jsonb,%L::jsonb)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('a', 64), filter_value.value::text,
      '[{"indexId":"irw_93000000000000000000000011","noteId":"note_00000000000000000000000001","indexedRevision":2}]'
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'main-claim' and filter_value.key = 'complete-filter'
  ),
  'stale_search_snapshot',
  'snapshot verification denies a cross-owner candidate'
);

insert into f_search_values(key, value)
select 'main-verification', private.verify_encrypted_user_search_snapshot_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('a', 64),
  filter_value.value, candidates.value
)
from f_search_values as claim
cross join f_search_values as filter_value
cross join f_search_values as candidates
where claim.key = 'main-claim'
  and filter_value.key = 'complete-filter'
  and candidates.key = 'main-candidates';

select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'main-verification'),
    array[
      'searchId', 'snapshotVerified', 'verifiedCandidateCount',
      'candidateDigest', 'generationRevisionToken'
    ]
  )
    and (select value ->> 'snapshotVerified'
      from f_search_values where key = 'main-verification') = 'true'
    and (select value ->> 'verifiedCandidateCount'
      from f_search_values where key = 'main-verification') = '2',
  'verification re-reads complete virtual coverage and binds every selected current revision'
);

insert into f_search_values(key, value)
select 'main-complete', private.complete_encrypted_user_search_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('a', 64)
)
from f_search_values as claim where claim.key = 'main-claim';

select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'main-complete'),
    array['searchId', 'state', 'completedAt', 'candidateDigest']
  )
    and (select value ->> 'state'
      from f_search_values where key = 'main-complete') = 'completed'
    and (
      select state = 'completed'
        and lease_secret_digest is null
        and lease_expires_at is null
        and completed_at is not null
      from public.encrypted_user_search_capabilities
      where id = (
        select (value ->> 'searchId')::uuid
        from f_search_values where key = 'main-claim'
      )
    ),
  'complete terminalizes a verified lease and destroys its lease digest'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.complete_encrypted_user_search_impl(%L::uuid,%L,%L)',
      value ->> 'searchId', value ->> 'leaseToken', repeat('a', 64)
    )) ->> 'message'
    from f_search_values where key = 'main-claim'
  ),
  'invalid_or_expired_search_lease',
  'a completed lease cannot be replayed'
);

-- Incomplete filter coverage is explicit and cannot be verified as semantic
-- search output. The failure transition remains available for cleanup.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'incomplete-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222', repeat('b', 64), value,
  encode(extensions.digest(
    convert_to('incomplete-claim-secret-0000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'incomplete-filter';
reset role;
insert into f_search_values(key, value)
select 'incomplete-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'incomplete-claim-secret-0000000000000001', repeat('b', 64)
)
from f_search_values where key = 'incomplete-begin';
insert into f_search_values(key, value)
select 'incomplete-page', private.list_encrypted_user_search_rag_page_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('b', 64),
  filter_value.value, null, 50, 8388608
)
from f_search_values as claim
cross join f_search_values as filter_value
where claim.key = 'incomplete-claim'
  and filter_value.key = 'incomplete-filter';

select ok(
  (select value #>> '{generation,expectedNoteCount}'
    from f_search_values where key = 'incomplete-page') = '1'
    and (select value #>> '{generation,indexedNoteCount}'
      from f_search_values where key = 'incomplete-page') = '0'
    and (select value #>> '{coverage,status}'
      from f_search_values where key = 'incomplete-page') = 'incomplete'
    and (select value #>> '{coverage,missingOrStaleCount}'
      from f_search_values where key = 'incomplete-page') = '1'
    and (select value #>> '{coverage,repairCandidates,0,noteId}'
      from f_search_values where key = 'incomplete-page')
        = 'note_93000000000000000000000004'
    and (select value #>> '{coverage,repairCandidates,0,currentRevision}'
      from f_search_values where key = 'incomplete-page') = '2'
    and (select value #>> '{coverage,repairOverflow}'
      from f_search_values where key = 'incomplete-page') = 'false'
    and jsonb_array_length((select value -> 'items'
      from f_search_values where key = 'incomplete-page')) = 0,
  'filter-specific coverage identifies missing/stale current revisions without returning stale envelopes'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.verify_encrypted_user_search_snapshot_impl(%L::uuid,%L,%L,%L::jsonb,%L::jsonb)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('b', 64), filter_value.value::text, '[]'
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'incomplete-claim'
      and filter_value.key = 'incomplete-filter'
  ),
  'incomplete_search_coverage',
  'verification fails closed when exact filtered coverage is incomplete'
);
insert into f_search_values(key, value)
select 'incomplete-fail', private.fail_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid, value ->> 'leaseToken', repeat('b', 64),
  'provider_unavailable'
)
from f_search_values where key = 'incomplete-claim';
select ok(
  private.jsonb_has_exact_keys(
    (select value from f_search_values where key = 'incomplete-fail'),
    array['searchId', 'state', 'failedAt', 'failureCode']
  )
    and (select value ->> 'state'
      from f_search_values where key = 'incomplete-fail') = 'failed'
    and (select value ->> 'failureCode'
      from f_search_values where key = 'incomplete-fail') = 'provider_unavailable'
    and (
      select state = 'failed'
        and lease_secret_digest is null
        and lease_expires_at is null
        and failed_at is not null
      from public.encrypted_user_search_capabilities
      where id = (
        select (value ->> 'searchId')::uuid
        from f_search_values where key = 'incomplete-claim'
      )
    ),
  'fail terminalizes an incomplete search and destroys its lease digest'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,50,8388608)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('b', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'incomplete-claim'
      and filter_value.key = 'incomplete-filter'
  ),
  'invalid_or_expired_search_lease',
  'a failed lease cannot be replayed'
);

-- Another owner receives an independent capability; IDs and a lease from one
-- owner can never be combined into a cross-owner read.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'owner-one-begin', public.begin_encrypted_user_search(
  '11111111-1111-4111-8111-111111111111', repeat('c', 64), value,
  encode(extensions.digest(
    convert_to('owner-one-claim-secret-00000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'owner-one-filter';
reset role;
insert into f_search_values(key, value)
select 'owner-one-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'owner-one-claim-secret-00000000000000001', repeat('c', 64)
)
from f_search_values where key = 'owner-one-begin';

select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,50,8388608)',
      owner_claim.value ->> 'searchId', stale_claim.value ->> 'leaseToken',
      repeat('c', 64), owner_filter.value::text
    )) ->> 'message'
    from f_search_values as owner_claim
    cross join f_search_values as stale_claim
    cross join f_search_values as owner_filter
    where owner_claim.key = 'owner-one-claim'
      and stale_claim.key = 'incomplete-claim'
      and owner_filter.key = 'owner-one-filter'
  ),
  'invalid_or_expired_search_lease',
  'a capability ID and lease token from different owners cannot be combined'
);
insert into f_search_values(key, value)
select 'owner-one-fail', private.fail_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid, value ->> 'leaseToken', repeat('c', 64),
  'provider_unavailable'
)
from f_search_values where key = 'owner-one-claim';

-- Expiration is deterministic and does not rely on sleeps.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'expired-claim-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222', repeat('d', 64), value,
  encode(extensions.digest(
    convert_to('expired-claim-secret-00000000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'complete-filter';
reset role;
update public.encrypted_user_search_capabilities
set
  created_at = statement_timestamp() - interval '60 seconds',
  claim_expires_at = statement_timestamp() - interval '30 seconds'
where id = (
  select (value ->> 'searchId')::uuid
  from f_search_values where key = 'expired-claim-begin'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.claim_encrypted_user_search_impl(%L::uuid,%L,%L)',
      value ->> 'searchId',
      'expired-claim-secret-00000000000000000001', repeat('d', 64)
    )) ->> 'message'
    from f_search_values where key = 'expired-claim-begin'
  ),
  'invalid_or_expired_search_capability',
  'an expired one-use capability cannot be claimed'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'expired-lease-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222', repeat('e', 64), value,
  encode(extensions.digest(
    convert_to('expired-lease-secret-00000000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'complete-filter';
reset role;
insert into f_search_values(key, value)
select 'expired-lease-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'expired-lease-secret-00000000000000000001', repeat('e', 64)
)
from f_search_values where key = 'expired-lease-begin';
update public.encrypted_user_search_capabilities
set
  claimed_at = statement_timestamp() - interval '60 seconds',
  lease_expires_at = statement_timestamp() - interval '30 seconds'
where id = (
  select (value ->> 'searchId')::uuid
  from f_search_values where key = 'expired-lease-claim'
);
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,50,8388608)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('e', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'expired-lease-claim'
      and filter_value.key = 'complete-filter'
  ),
  'invalid_or_expired_search_lease',
  'an expired worker lease cannot page encrypted rows'
);

-- Equal-count metadata changes still invalidate the content-free virtual
-- snapshot digest. Failure can terminalize the stale lease without reopening
-- it for reads.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'virtual-stale-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222', repeat('f', 64), value,
  encode(extensions.digest(
    convert_to('virtual-stale-secret-00000000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'complete-filter';
reset role;
insert into f_search_values(key, value)
select 'virtual-stale-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'virtual-stale-secret-00000000000000000001', repeat('f', 64)
)
from f_search_values where key = 'virtual-stale-begin';
insert into f_search_values(key, value)
select 'virtual-stale-page', private.list_encrypted_user_search_rag_page_impl(
  (claim.value ->> 'searchId')::uuid,
  claim.value ->> 'leaseToken', repeat('f', 64),
  filter_value.value, null, 50, 8388608
)
from f_search_values as claim
cross join f_search_values as filter_value
where claim.key = 'virtual-stale-claim'
  and filter_value.key = 'complete-filter';
update public.notes
set pinned_at = '2026-09-01 12:00:00+00'
where id = 'note_93000000000000000000000001';
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,50,8388608)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('f', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'virtual-stale-claim'
      and filter_value.key = 'complete-filter'
  ),
  'stale_search_snapshot',
  'an equal-count ranking-metadata race invalidates the virtual snapshot'
);
insert into f_search_values(key, value)
select 'virtual-stale-fail', private.fail_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid, value ->> 'leaseToken', repeat('f', 64),
  'stale_revision'
)
from f_search_values where key = 'virtual-stale-claim';

-- The generation revision itself is independently pinned by begin/claim.
insert into public.rag_index_generation_verifications (
  user_id, generation_id, revision_token, verified_note_count,
  attestation, attestation_digest, attestation_domain,
  embedding_model_id, embedding_dimensions, envelope_schema_version
)
select
  generation.user_id,
  generation.id,
  generation.revision_token,
  generation.indexed_note_count,
  attestation.value,
  private.request_hash(attestation.value),
  'unfiled.rag-generation-attestation.v1',
  generation.embedding_model_id,
  generation.embedding_dimensions,
  generation.envelope_schema_version
from public.rag_index_generations as generation
cross join lateral (
  select private.rag_generation_attestation(
    generation.user_id, generation.id, generation.revision_token
  ) as value
) as attestation
where generation.id = 'igen_93000000000000000000000001'
on conflict (user_id, generation_id) do update
set
  revision_token = excluded.revision_token,
  verified_note_count = excluded.verified_note_count,
  attestation = excluded.attestation,
  attestation_digest = excluded.attestation_digest,
  attestation_domain = excluded.attestation_domain,
  embedding_model_id = excluded.embedding_model_id,
  embedding_dimensions = excluded.embedding_dimensions,
  envelope_schema_version = excluded.envelope_schema_version;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into f_search_values(key, value)
select 'generation-stale-begin', public.begin_encrypted_user_search(
  '22222222-2222-4222-8222-222222222222', repeat('9', 64), value,
  encode(extensions.digest(
    convert_to('generation-stale-secret-000000000000000001', 'UTF8'),
    'sha256'
  ), 'hex')
)
from f_search_values where key = 'complete-filter';
reset role;
insert into f_search_values(key, value)
select 'generation-stale-claim', private.claim_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid,
  'generation-stale-secret-000000000000000001', repeat('9', 64)
)
from f_search_values where key = 'generation-stale-begin';
update public.rag_index_generations
set revision_token = revision_token + 1
where id = 'igen_93000000000000000000000001';
select is(
  (
    select pg_temp.caught_error(format(
      'select private.list_encrypted_user_search_rag_page_impl(%L::uuid,%L,%L,%L::jsonb,null,50,8388608)',
      claim.value ->> 'searchId', claim.value ->> 'leaseToken',
      repeat('9', 64), filter_value.value::text
    )) ->> 'message'
    from f_search_values as claim
    cross join f_search_values as filter_value
    where claim.key = 'generation-stale-claim'
      and filter_value.key = 'complete-filter'
  ),
  'stale_search_snapshot',
  'an active-generation revision change invalidates the bound lease snapshot'
);
insert into f_search_values(key, value)
select 'generation-stale-fail', private.fail_encrypted_user_search_impl(
  (value ->> 'searchId')::uuid, value ->> 'leaseToken', repeat('9', 64),
  'stale_revision'
)
from f_search_values where key = 'generation-stale-claim';

select ok(
  (select value ->> 'state' from f_search_values
    where key = 'virtual-stale-fail') = 'failed'
    and (select value ->> 'state' from f_search_values
      where key = 'generation-stale-fail') = 'failed',
  'failure terminalization remains available after virtual or generation snapshot invalidation'
);

select * from finish();
rollback;
