create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.context_envelope(
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

select has_function(
  'public', 'list_encrypted_note_sources',
  array['uuid', 'text', 'integer', 'timestamp with time zone', 'text', 'text', 'integer'],
  'web has one bounded encrypted note-source projection'
);
select has_function(
  'public', 'list_encrypted_note_backlinks',
  array['uuid', 'text', 'integer', 'timestamp with time zone', 'text', 'integer'],
  'web has one bounded encrypted backlink projection'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_encrypted_note_sources(uuid,text,integer,timestamptz,text,text,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.list_encrypted_note_backlinks(uuid,text,integer,timestamptz,text,integer)',
      'EXECUTE'
    )
    and not exists (
      select 1
      from unnest(array[
        'anon', 'authenticated', 'unfiled_index_worker',
        'unfiled_rag_verifier', 'unfiled_organizer_worker',
        'unfiled_search_worker'
      ]) as runtime(role_name)
      where has_function_privilege(
        runtime.role_name,
        'public.list_encrypted_note_sources(uuid,text,integer,timestamptz,text,text,integer)',
        'EXECUTE'
      ) or has_function_privilege(
        runtime.role_name,
        'public.list_encrypted_note_backlinks(uuid,text,integer,timestamptz,text,integer)',
        'EXECUTE'
      )
    ),
  'only the web service role can execute either note-context projection'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '94949494-9494-4494-8494-949494949494',
    'authenticated', 'authenticated', 'context-owner@unfiled.local', '', now(),
    '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '95959595-9595-4595-8595-959595959595',
    'authenticated', 'authenticated', 'context-other@unfiled.local', '', now(),
    '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now()
  );

insert into public.content_encryption_rollouts(user_id, state) values
  ('94949494-9494-4494-8494-949494949494', 'expanded'),
  ('95959595-9595-4595-8595-959595959595', 'expanded');

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '94949494-9494-4494-8494-949494949494', 'f.context.object.v1',
    'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/94000000-0000-4000-8000-000000000001',
    decode(repeat('94', 32), 'hex'), 'active', now()
  ),
  (
    '94949494-9494-4494-8494-949494949494', 'f.context.mac.v1',
    'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/94000000-0000-4000-8000-000000000002',
    decode(repeat('95', 32), 'hex'), 'active', now()
  );

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy, deleted_at, content_envelope,
  content_key_id, content_key_class, content_key_purpose, content_key_version
) values
  (
    'note_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494', 'generic',
    'target plaintext sentinel', '[encrypted]', '{}', 3, 'ai_assisted', null,
    pg_temp.context_envelope(
      'note_94000000000000000000000001',
      '94949494-9494-4494-8494-949494949494', 3,
      'note_content', 'f.context.object.v1', 'T'
    ), 'f.context.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_94000000000000000000000002',
    '94949494-9494-4494-8494-949494949494', 'generic',
    'backlink plaintext sentinel', '[encrypted]', '{}', 2, 'ai_assisted', null,
    pg_temp.context_envelope(
      'note_94000000000000000000000002',
      '94949494-9494-4494-8494-949494949494', 2,
      'note_content', 'f.context.object.v1', 'B'
    ), 'f.context.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_94000000000000000000000003',
    '94949494-9494-4494-8494-949494949494', 'generic',
    'deleted backlink sentinel', '[encrypted]', '{}', 1, 'ai_assisted', now(),
    pg_temp.context_envelope(
      'note_94000000000000000000000003',
      '94949494-9494-4494-8494-949494949494', 1,
      'note_content', 'f.context.object.v1', 'D'
    ), 'f.context.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status, deleted_at,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version, received_at
) values
  (
    'cap_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494', 'web', 'context-test',
    '[encrypted]', 'ai_assisted', '2026-09-01 20:00:00+00', 'UTC',
    'organized', null,
    pg_temp.context_envelope(
      'cap_94000000000000000000000001',
      '94949494-9494-4494-8494-949494949494', 1,
      'capture', 'f.context.object.v1', 'A'
    ), repeat('a', 64), 4,
    'f.context.object.v1', 'ai_assisted', 'object_wrap', 1,
    'f.context.mac.v1', 'ai_assisted', 'content_mac', 1,
    '2026-09-01 20:00:00+00'
  ),
  (
    'cap_94000000000000000000000002',
    '94949494-9494-4494-8494-949494949494', 'mobile', 'context-test',
    '[encrypted]', 'ai_assisted', '2026-09-01 19:00:00+00', 'UTC',
    'organized', null,
    pg_temp.context_envelope(
      'cap_94000000000000000000000002',
      '94949494-9494-4494-8494-949494949494', 1,
      'capture', 'f.context.object.v1', 'B'
    ), repeat('b', 64), 5,
    'f.context.object.v1', 'ai_assisted', 'object_wrap', 1,
    'f.context.mac.v1', 'ai_assisted', 'content_mac', 1,
    '2026-09-01 19:00:00+00'
  ),
  (
    'cap_94000000000000000000000003',
    '94949494-9494-4494-8494-949494949494', 'web', 'context-test',
    '[encrypted]', 'ai_assisted', '2026-09-01 18:00:00+00', 'UTC',
    'deleted', now(), null, null, null,
    null, null, null, null, null, null, null, null,
    '2026-09-01 18:00:00+00'
  );

insert into public.note_mutations (
  id, user_id, note_id, idempotency_key, before_revision, after_revision,
  operations, inverse, mutation_envelope, mutation_key_id,
  mutation_key_class, mutation_key_purpose, mutation_key_version
) select
  fixture.mutation_id,
  '94949494-9494-4494-8494-949494949494'::uuid,
  'note_94000000000000000000000001',
  fixture.idempotency_key, 2, 3, '[]'::jsonb, '[]'::jsonb,
  pg_temp.context_envelope(
    fixture.mutation_id,
    '94949494-9494-4494-8494-949494949494', 3,
    'note_mutation', 'f.context.object.v1', fixture.seed
  ), 'f.context.object.v1', 'ai_assisted', 'object_wrap', 1
from (values
  ('mut_94000000000000000000000001', 'context-source-1', '1'),
  ('mut_94000000000000000000000002', 'context-source-2', '2'),
  ('mut_94000000000000000000000003', 'context-source-3', '3')
) as fixture(mutation_id, idempotency_key, seed);

insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation,
  inserted_item_ids, created_at
) values
  (
    'cap_94000000000000000000000001',
    'note_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494',
    'mut_94000000000000000000000001', 'routed',
    array['itm_94000000000000000000000001'],
    '2026-09-01 20:00:00+00'
  ),
  (
    'cap_94000000000000000000000002',
    'note_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494',
    'mut_94000000000000000000000002', 'source_removed',
    array['ent_94000000000000000000000001'],
    '2026-09-01 19:00:00+00'
  ),
  (
    'cap_94000000000000000000000003',
    'note_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494',
    'mut_94000000000000000000000003', 'source_removed',
    '{}', '2026-09-01 18:00:00+00'
  );

insert into public.note_links (
  id, user_id, from_note_id, to_note_id, link_type, source, created_at
) values
  (
    'lnk_94000000000000000000000001',
    '94949494-9494-4494-8494-949494949494',
    'note_94000000000000000000000002',
    'note_94000000000000000000000001', 'related', 'manual',
    '2026-09-01 20:00:00+00'
  ),
  (
    'lnk_94000000000000000000000002',
    '94949494-9494-4494-8494-949494949494',
    'note_94000000000000000000000003',
    'note_94000000000000000000000001', 'reference', 'manual',
    '2026-09-01 19:00:00+00'
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  public.list_encrypted_note_sources(
    '94949494-9494-4494-8494-949494949494',
    'note_94000000000000000000000001', null, null, null, null, 10
  ) #>> '{items,0,captureId}' = 'cap_94000000000000000000000001'
    and public.list_encrypted_note_sources(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, null, 10
    ) #>> '{items,1,relation}' = 'source_removed'
    and jsonb_array_length(public.list_encrypted_note_sources(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, null, 10
    ) -> 'items') = 2,
  'sources are newest-first, preserve source-removed lineage, and omit deleted captures'
);

select ok(
  public.list_encrypted_note_sources(
    '94949494-9494-4494-8494-949494949494',
    'note_94000000000000000000000001', 3,
    '2026-09-01 20:00:00+00',
    'cap_94000000000000000000000001',
    'mut_94000000000000000000000001', 1
  ) #>> '{items,0,captureId}' = 'cap_94000000000000000000000002',
  'source pagination uses the complete descending relationship keyset'
);

select ok(
  public.list_encrypted_note_backlinks(
    '94949494-9494-4494-8494-949494949494',
    'note_94000000000000000000000001', null, null, null, 5
  ) #>> '{items,0,fromNoteId}' = 'note_94000000000000000000000002'
    and public.list_encrypted_note_backlinks(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, 5
    ) #>> '{items,0,fromNoteRevision}' = '2'
    and jsonb_array_length(public.list_encrypted_note_backlinks(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, 5
    ) -> 'items') = 1,
  'backlinks hydrate only current, non-deleted source-note ciphertext coordinates'
);

select ok(
  private.jsonb_has_exact_keys(
    public.list_encrypted_note_sources(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, null, 1
    ), array['noteId', 'currentRevision', 'items']
  )
    and private.jsonb_has_exact_keys(
      public.list_encrypted_note_backlinks(
        '94949494-9494-4494-8494-949494949494',
        'note_94000000000000000000000001', null, null, null, 1
      ), array['noteId', 'currentRevision', 'items']
    )
    and public.list_encrypted_note_sources(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, null, 1
    )::text not like '%plaintext sentinel%'
    and public.list_encrypted_note_backlinks(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, 1
    )::text not like '%plaintext sentinel%',
  'the RPC boundary returns exact encrypted projections without note or capture plaintext'
);

select is(
  pg_temp.caught_error($statement$
    select public.list_encrypted_note_sources(
      '95959595-9595-4595-8595-959595959595',
      'note_94000000000000000000000001', null, null, null, null, 10
    )
  $statement$) ->> 'message',
  'not_found',
  'a different owner cannot enumerate a target note or its source relationships'
);
select is(
  pg_temp.caught_error($statement$
    select public.list_encrypted_note_backlinks(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', 2, null, null, 5
    )
  $statement$) ->> 'message',
  'stale_revision',
  'a cursor bound to an older target revision fails closed'
);
select is(
  pg_temp.caught_error($statement$
    select public.list_encrypted_note_sources(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', 3, now(), null, null, 10
    )
  $statement$) ->> 'message',
  'validation_failed',
  'a partial source keyset is rejected'
);

reset role;
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation,
  inserted_item_ids, created_at
) values (
  'cap_94000000000000000000000001',
  'note_94000000000000000000000001',
  '94949494-9494-4494-8494-949494949494',
  'mut_94000000000000000000000003', 'source_removed',
  '{}', '2026-09-01 17:00:00+00'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.list_encrypted_export_note_sources(
    '94949494-9494-4494-8494-949494949494',
    '["note_94000000000000000000000001"]'::jsonb
  ) #> '{items,0,sourceCaptureIds}',
  jsonb_build_array(
    'cap_94000000000000000000000001',
    'cap_94000000000000000000000002',
    'cap_94000000000000000000000003'
  ),
  'export source IDs are distinct and canonical when one capture has multiple relationship events'
);

reset role;
update public.notes
set deleted_at = now()
where id = 'note_94000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.list_encrypted_note_backlinks(
      '94949494-9494-4494-8494-949494949494',
      'note_94000000000000000000000001', null, null, null, 5
    )
  $statement$) ->> 'message',
  'not_found',
  'a deleted target note has no context inspection surface'
);
reset role;

select * from finish();
rollback;
