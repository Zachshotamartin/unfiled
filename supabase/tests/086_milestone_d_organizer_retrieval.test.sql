create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_seed text default 'D'
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

create temporary table d_retrieval_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on d_retrieval_values to unfiled_organizer_worker;

select has_function(
  'public', 'list_encrypted_organizer_rag_page',
  array['text', 'text', 'jsonb', 'integer', 'integer'],
  'the organizer has a lease-bound encrypted RAG page RPC'
);
select has_function(
  'public', 'select_encrypted_organizer_candidates',
  array['text', 'text', 'jsonb'],
  'the organizer has a lease-bound exact candidate exchange RPC'
);
select ok(
  has_function_privilege(
    'unfiled_organizer_worker',
    'public.list_encrypted_organizer_rag_page(text,text,jsonb,integer,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'unfiled_organizer_worker',
      'public.select_encrypted_organizer_candidates(text,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'public.list_active_note_rag_index(uuid,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.list_encrypted_organizer_rag_page(text,text,jsonb,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.select_encrypted_organizer_candidates(text,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'private.select_encrypted_organizer_candidates_impl(text,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'private.list_encrypted_organizer_rag_page_impl(text,text,jsonb,integer,integer)',
      'EXECUTE'
    ),
  'only the exact organizer login receives the two public lease-bound capabilities'
);
select ok(
  (
    select count(*) = 11
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )
  ),
  'the organizer capability is the reviewed eleven-function surface after E4'
);
select ok(
  (
    select
      strpos(source, 'private.assert_encrypted_organizer_lease') > 0
      and strpos(source, 'public.list_active_note_rag_index') > 0
      and strpos(source, 'job_row.user_id') > 0
      and strpos(source, 'p_owner_id') = 0
    from (
      select lower(pg_get_functiondef(
        'private.list_encrypted_organizer_rag_page_impl(text,text,jsonb,integer,integer)'::regprocedure
      )) as source
    ) as definition
  ),
  'the RAG page wrapper derives its owner only from the active lease'
);
select ok(
  (
    select
      strpos(source, '''occurredat'', capture_row.client_created_at') > 0
      and strpos(source, '''commandprojection''') > 0
      and strpos(source, 'rollout.plaintext_scrub_id is not null') > 0
      and strpos(source, 'private.encrypted_mac_projection') > 0
      and strpos(source, 'source_mac_key') > 0
    from (
      select lower(pg_get_functiondef(
        'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
      )) as source
    ) as definition
  ),
  'the claim projects replay-stable time, scrub-safe command shape, and authenticated capture material'
);

-- Isolate one owner and create an authenticated active RAG generation plus a
-- live organizer job. The envelopes contain deterministic test bytes only.
delete from public.captures
where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.notes
where user_id = '22222222-2222-4222-8222-222222222222';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'd.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/86000000-0000-4000-8000-000000000001',
  decode(repeat('86', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'd.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/86000000-0000-4000-8000-000000000002',
  decode(repeat('87', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'd.private.object.v1', 'private_manual', 'object_wrap', 1,
  'arn:aws:kms:us-west-2:123456789012:key/86000000-0000-4000-8000-000000000003',
  decode(repeat('88', 32), 'hex')
);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  'd.private.mac.v1', 'private_manual', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/86000000-0000-4000-8000-000000000004',
  decode(repeat('89', 32), 'hex')
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'd.ai.object.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'd.ai.mac.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'd.private.object.v1'
);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', 'd.private.mac.v1'
);
reset role;
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '22222222-2222-4222-8222-222222222222';

insert into public.tags(
  id, user_id, name, display_envelope, display_key_id, display_key_class,
  display_key_purpose, display_key_version, display_mac, display_mac_key_id,
  display_mac_key_class, display_mac_key_purpose, display_mac_key_version
)
values (
  'tag_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'routing',
  pg_temp.content_envelope(
    'tag_86000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'tag_display', 'd.private.object.v1', 'T'
  ),
  'd.private.object.v1', 'private_manual', 'object_wrap', 1,
  repeat('9', 64), 'd.private.mac.v1', 'private_manual', 'content_mac', 1
);
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  current_revision, daily_date, is_open, pinned_at, privacy, created_at,
  updated_at, content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'spc_00000000000000000000000009', 'generic',
  'Encrypted routing fixture', 'lease-scoped candidate',
  '{"schemaVersion":1}', 1, null, true,
  '2026-09-01 12:00:00+00', 'ai_assisted',
  '2026-09-01 12:00:00+00', '2026-09-01 12:00:00+00',
  pg_temp.content_envelope(
    'note_86000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_content', 'd.ai.object.v1', 'N'
  ),
  'd.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_tags(note_id, tag_id, user_id)
values (
  'note_86000000000000000000000001',
  'tag_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222'
);

insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  envelope_schema_version, state, expected_note_count, indexed_note_count,
  revision_token, activated_at
) values (
  'igen_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'text-embedding-3-small', 1536, 1, 'active', 1, 1, 1,
  '2026-09-01 12:01:00+00'
);
insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision,
  index_envelope, index_key_id, index_key_class, index_key_purpose,
  index_key_version, encrypted_byte_length
) values (
  'irw_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'note_86000000000000000000000001',
  'igen_86000000000000000000000001', 1,
  pg_temp.content_envelope(
    'irw_86000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'note_rag_index', 'd.ai.object.v1', 'R'
  ),
  'd.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 60
);
insert into public.rag_index_generation_verifications (
  user_id, generation_id, revision_token, verified_note_count,
  attestation, attestation_digest, attestation_domain,
  embedding_model_id, embedding_dimensions, envelope_schema_version
)
select
  '22222222-2222-4222-8222-222222222222',
  'igen_86000000000000000000000001', 1, 1,
  attestation.value,
  private.request_hash(attestation.value),
  'unfiled.rag-generation-attestation.v1',
  'text-embedding-3-small', 1536, 1
from lateral (
  select private.rag_generation_attestation(
    '22222222-2222-4222-8222-222222222222',
    'igen_86000000000000000000000001', 1
  ) as value
) as attestation;

insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, received_at,
  status, content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222', 'web', '[encrypted]',
  pg_temp.content_envelope(
    'cap_86000000000000000000000001',
    '22222222-2222-4222-8222-222222222222', 1,
    'capture', 'd.ai.object.v1', 'C'
  ), encode(extensions.digest('capture-d', 'sha256'), 'hex'), 12,
  'ai_assisted', '2026-09-01 12:02:03+00', 'UTC',
  '2026-09-01 12:02:04+00', 'queued',
  'd.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'd.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version
) values (
  'job_86000000000000000000000001',
  'cap_86000000000000000000000001',
  '22222222-2222-4222-8222-222222222222',
  'created', 'routing-v1', 1
);
insert into d_retrieval_values(key, value)
values (
  'claim', private.claim_encrypted_organizer_jobs_impl(
    'milestone-d-test', 1, 60
  )
);

select is(
  (select value #>> '{jobs,0,occurredAt}'
   from d_retrieval_values where key = 'claim'),
  '2026-09-01T12:02:03+00:00',
  'claim returns the exact database-owned capture timestamp'
);
select is(
  (select value #>> '{jobs,0,commandProjection}'
   from d_retrieval_values where key = 'claim'),
  'legacy',
  'claim binds the rollback-compatible command projection before scrubbing'
);
select ok(
  (select count(*) = 7
   from d_retrieval_values as claimed
   cross join lateral jsonb_object_keys(
     claimed.value #> '{jobs,0,source}'
   ) as source_key
   where claimed.key = 'claim')
    and (select value #>> '{jobs,0,source,contentMac,mac}'
      from d_retrieval_values where key = 'claim')
        = encode(extensions.digest('capture-d', 'sha256'), 'hex')
    and (select value #>> '{jobs,0,source,contentMac,keyId}'
      from d_retrieval_values where key = 'claim') = 'd.ai.mac.v1'
    and (select value #>> '{jobs,0,source,contentMac,keyPurpose}'
      from d_retrieval_values where key = 'claim') = 'content_mac'
    and (select value #>> '{jobs,0,source,contentMacKeyRecord,keyId}'
      from d_retrieval_values where key = 'claim') = 'd.ai.mac.v1'
    and (select value #>> '{jobs,0,source,contentMacKeyRecord,purpose}'
      from d_retrieval_values where key = 'claim') = 'content_mac',
  'claim returns the exact MAC and independently scoped MAC key needed to authenticate the capture'
);

insert into d_retrieval_values(key, value)
select 'rag-page', private.list_encrypted_organizer_rag_page_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}',
  null, 50, 2097152
)
from d_retrieval_values where key = 'claim';
insert into d_retrieval_values(key, value)
select 'selection', private.select_encrypted_organizer_candidates_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}',
  jsonb_build_object(
    'generationId', page.value #>> '{result,generation,generationId}',
    'revisionToken', (page.value #>> '{result,generation,revisionToken}')::bigint,
    'candidates', jsonb_build_array(jsonb_build_object(
      'noteId', page.value #>> '{result,items,0,noteId}',
      'indexedRevision', (page.value #>> '{result,items,0,indexedRevision}')::integer
    ))
  )
)
from d_retrieval_values as claim
cross join d_retrieval_values as page
where claim.key = 'claim' and page.key = 'rag-page';

select ok(
  (select value #>> '{result,ownerId}'
   from d_retrieval_values where key = 'rag-page')
      = '22222222-2222-4222-8222-222222222222'
    and (select value #>> '{result,coverage,complete}'
      from d_retrieval_values where key = 'rag-page') = 'true'
    and (select value #>> '{result,page,returnedCount}'
      from d_retrieval_values where key = 'rag-page') = '1'
    and (select value #>> '{result,items,0,noteId}'
      from d_retrieval_values where key = 'rag-page')
        = 'note_86000000000000000000000001',
  'lease-bound RAG paging exposes only the claimed owner active generation'
);
select ok(
  (select value ->> 'generationId'
   from d_retrieval_values where key = 'selection')
      = 'igen_86000000000000000000000001'
    and (select value ->> 'returnedCount'
      from d_retrieval_values where key = 'selection') = '1'
    and (select value #>> '{candidates,0,noteId}'
      from d_retrieval_values where key = 'selection')
        = 'note_86000000000000000000000001'
    and (select value #>> '{candidates,0,metadata,pinnedAt}'
      from d_retrieval_values where key = 'selection')
        = '2026-09-01T12:00:00+00:00'
    and (select value #>> '{candidates,0,metadata,tagIds,0}'
      from d_retrieval_values where key = 'selection')
        = 'tag_86000000000000000000000001'
    and (select value #>> '{candidates,0,aggregate,envelope,context,kind}'
      from d_retrieval_values where key = 'selection') = 'note_content',
  'exact match exchange preserves encrypted note binding and relational snapshot metadata'
);
select ok(
  exists (
    select 1
    from public.encrypted_organizer_candidate_pages as page
    where page.job_id = 'job_86000000000000000000000001'
      and page.user_id = '22222222-2222-4222-8222-222222222222'
      and page.candidate_manifest #>> '{0,noteId}'
        = 'note_86000000000000000000000001'
  ),
  'candidate exchange installs the same server-side disclosure fence used by heartbeat and commit'
);

select * from finish();
rollback;
