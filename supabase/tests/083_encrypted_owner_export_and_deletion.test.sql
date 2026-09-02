create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.owner_delete_envelope(
  p_owner_id uuid,
  p_resource_id text,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_seed text
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
      'ciphertext', repeat(left(p_seed, 1), 64)
    )
  );
$$;

create function pg_temp.owner_delete_token_digest(p_token text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$$;

create function pg_temp.owner_delete_binding(p_token text, p_owner_id uuid)
returns text
language sql
immutable
as $$
  select encode(extensions.hmac(
    convert_to('unfiled:account-deletion-owner:v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to(p_owner_id::text, 'UTF8'),
    convert_to(p_token, 'UTF8'),
    'sha256'
  ), 'hex');
$$;

create temporary table owner_delete_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on owner_delete_values to service_role;

create temporary table owner_delete_secrets (
  owner_id uuid primary key,
  secret_id uuid not null
) on commit drop;

select has_table(
  'public', 'account_deletion_receipts',
  'bounded account-deletion receipts are durable'
);
select has_table(
  'public', 'account_deletion_receipt_lookup_events',
  'receipt replay attempts have a durable rate-limit ledger'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.account_deletion_receipts'::regclass)
    and
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.account_deletion_receipt_lookup_events'::regclass),
  'receipt and replay-ledger storage both force RLS'
);
select ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'account_deletion_receipts',
        'account_deletion_receipt_lookup_events'
      )
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  'no client or service role can access receipt storage directly'
);
select ok(
  not exists (
    select 1
    from information_schema.role_usage_grants
    where object_schema = 'public'
      and object_name = 'account_deletion_receipt_lookup_events_event_id_seq'
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  )
    and not has_sequence_privilege(
      'service_role',
      'public.account_deletion_receipt_lookup_events_event_id_seq', 'USAGE'
    )
    and not has_sequence_privilege(
      'service_role',
      'public.account_deletion_receipt_lookup_events_event_id_seq', 'SELECT'
    ),
  'lookup identity sequence exposes neither nextval nor volume metadata'
);
select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'account_deletion_receipts'
      and column_name in (
        'owner_id', 'owner_digest', 'idempotency_key', 'deletion_token',
        'email', 'provider_key', 'key_material'
      )
  )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'account_deletion_receipts'
        and column_name = 'owner_binding_digest'
    ),
  'receipt storage keeps only capability-keyed owner binding and token digests'
);

select has_function(
  'public', 'list_encrypted_export_note_sources', array['uuid', 'jsonb'],
  'export source projection has one exact bounded signature'
);
select has_function(
  'public', 'get_account_deletion_receipt', array['text', 'text'],
  'response-loss replay has one exact body-digest signature'
);
select has_function(
  'public', 'delete_encrypted_owner_account', array['uuid', 'text', 'text'],
  'account deletion accepts owner, token digest, and capability-keyed binding only'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_encrypted_export_note_sources(uuid,jsonb)', 'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.get_account_deletion_receipt(text,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.delete_encrypted_owner_account(uuid,text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.list_encrypted_export_note_sources(uuid,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.get_account_deletion_receipt(text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.delete_encrypted_owner_account(uuid,text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.get_account_deletion_receipt(text,text)', 'EXECUTE'
    ),
  'only service_role can invoke export, deletion, or post-deletion replay coordinates'
);
select ok(
  not exists (
    select 1
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name in (
        'purge_expired_account_deletion_receipts',
        'account_deletion_receipt',
        'owner_public_data_counts',
        'owner_auth_data_counts',
        'account_deletion_counts_are_zero'
      )
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  'receipt, discovery, and verification helpers remain private'
);
select ok(
  strpos(pg_get_functiondef(
    'public.list_encrypted_export_note_sources(uuid,jsonb)'::regprocedure
  ), 'raw_text') = 0
    and strpos(pg_get_functiondef(
      'public.list_encrypted_export_note_sources(uuid,jsonb)'::regprocedure
    ), 'body_markdown') = 0
    and strpos(pg_get_functiondef(
      'public.list_encrypted_export_note_sources(uuid,jsonb)'::regprocedure
    ), 'content_envelope') = 0
    and strpos(pg_get_functiondef(
      'public.list_encrypted_export_note_sources(uuid,jsonb)'::regprocedure
    ), 'key_ciphertext') = 0,
  'export relation projection cannot return plaintext, ciphertext, or key material'
);
select ok(
  strpos(pg_get_functiondef(
    'public.delete_encrypted_owner_account(uuid,text,text)'::regprocedure
  ), 'auth.flow_state') > 0
    and strpos(pg_get_functiondef(
      'public.delete_encrypted_owner_account(uuid,text,text)'::regprocedure
    ), 'auth.refresh_tokens') > 0
    and strpos(pg_get_functiondef(
      'public.delete_encrypted_owner_account(uuid,text,text)'::regprocedure
    ), 'provider_key_deletion_unavailable') > 0
    and strpos(pg_get_functiondef(
      'public.delete_encrypted_owner_account(uuid,text,text)'::regprocedure
    ), ':content-encryption-rollout') > 0,
  'deletion explicitly handles non-FK auth artifacts, Vault failure, and owner-write fencing'
);
select ok(
  strpos(pg_get_functiondef(
    'public.get_account_deletion_receipt(text,text)'::regprocedure
  ), 'account_deletion_receipt_lookup_events') > 0
    and strpos(pg_get_functiondef(
      'public.get_account_deletion_receipt(text,text)'::regprocedure
    ), $needle$jsonb_build_object('status', 'not_found')$needle$) > 0
    and strpos(pg_get_functiondef(
      'public.get_account_deletion_receipt(text,text)'::regprocedure
    ), $needle$jsonb_build_object('status', 'rate_limited')$needle$) > 0,
  'missing receipt lookups persist durable rate-limit evidence without throwing it away'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '83838383-8383-4383-8383-838383838383',
    'authenticated', 'authenticated', 'owner-delete@unfiled.local', '', now(),
    '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '84848484-8484-4484-8484-848484848484',
    'authenticated', 'authenticated', 'alternate-owner@unfiled.local', '', now(),
    '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '85858585-8585-4585-8585-858585858585',
    'authenticated', 'authenticated', 'vault-failure@unfiled.local', '', now(),
    '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb, now(), now()
  );

insert into public.content_encryption_rollouts(user_id, state) values
  ('83838383-8383-4383-8383-838383838383', 'expanded'),
  ('84848484-8484-4484-8484-848484848484', 'expanded'),
  ('85858585-8585-4585-8585-858585858585', 'expanded');

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '83838383-8383-4383-8383-838383838383', 'export.ai.object.v1',
    'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/83000000-0000-4000-8000-000000000001',
    decode(repeat('31', 32), 'hex'), 'active', now()
  ),
  (
    '83838383-8383-4383-8383-838383838383', 'export.ai.mac.v1',
    'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/83000000-0000-4000-8000-000000000002',
    decode(repeat('32', 32), 'hex'), 'active', now()
  ),
  (
    '84848484-8484-4484-8484-848484848484', 'export.ai.object.v1',
    'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/84000000-0000-4000-8000-000000000001',
    decode(repeat('41', 32), 'hex'), 'active', now()
  );

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values
  (
    'note_83000000000000000000000001',
    '83838383-8383-4383-8383-838383838383', 'generic',
    'owner export note', 'owner export body', '{}', 1, 'ai_assisted',
    pg_temp.owner_delete_envelope(
      '83838383-8383-4383-8383-838383838383',
      'note_83000000000000000000000001', 1, 'note_content',
      'export.ai.object.v1', 'N'
    ), 'export.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_84000000000000000000000001',
    '84848484-8484-4484-8484-848484848484', 'generic',
    'alternate owner note', 'alternate owner body', '{}', 1, 'ai_assisted',
    pg_temp.owner_delete_envelope(
      '84848484-8484-4484-8484-848484848484',
      'note_84000000000000000000000001', 1, 'note_content',
      'export.ai.object.v1', 'O'
    ), 'export.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_83000000000000000000000001',
  '83838383-8383-4383-8383-838383838383', 'web', 'owner-delete-test',
  '[encrypted]', 'ai_assisted', now(), 'UTC', 'organized',
  pg_temp.owner_delete_envelope(
    '83838383-8383-4383-8383-838383838383',
    'cap_83000000000000000000000001', 1, 'capture',
    'export.ai.object.v1', 'C'
  ), repeat('a', 64), 18,
  'export.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'export.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.note_mutations (
  id, user_id, note_id, idempotency_key, before_revision, after_revision,
  operations, inverse, mutation_envelope, mutation_key_id,
  mutation_key_class, mutation_key_purpose, mutation_key_version
) values (
  'mut_83000000000000000000000001',
  '83838383-8383-4383-8383-838383838383',
  'note_83000000000000000000000001', 'owner-export-link', 0, 1,
  '[]'::jsonb, '[]'::jsonb,
  pg_temp.owner_delete_envelope(
    '83838383-8383-4383-8383-838383838383',
    'mut_83000000000000000000000001', 1, 'note_mutation',
    'export.ai.object.v1', 'M'
  ), 'export.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id
) values (
  'cap_83000000000000000000000001',
  'note_83000000000000000000000001',
  '83838383-8383-4383-8383-838383838383',
  'mut_83000000000000000000000001'
);

insert into auth.sessions(id, user_id, created_at, updated_at) values (
  '83000000-0000-4000-8000-000000000010',
  '83838383-8383-4383-8383-838383838383', now(), now()
);
insert into auth.identities(
  provider_id, user_id, identity_data, provider, created_at, updated_at
) values (
  'owner-delete@unfiled.local',
  '83838383-8383-4383-8383-838383838383',
  '{"sub":"83838383-8383-4383-8383-838383838383","email":"owner-delete@unfiled.local"}',
  'email', now(), now()
);
insert into auth.refresh_tokens(token, user_id, session_id, created_at, updated_at)
values (
  'owner-delete-refresh-token',
  '83838383-8383-4383-8383-838383838383',
  '83000000-0000-4000-8000-000000000010', now(), now()
);
insert into auth.flow_state(
  id, user_id, provider_type, authentication_method, created_at, updated_at
) values (
  '83000000-0000-4000-8000-000000000011',
  '83838383-8383-4383-8383-838383838383',
  'email', 'email', now(), now()
);

insert into public.rag_index_maintenance_checkpoints (
  embedding_model_id, embedding_dimensions, phase, after_owner_id
) values (
  'owner-delete-model', 1536, 'seed',
  '83838383-8383-4383-8383-838383838383'
);
insert into public.rag_index_maintenance_page_requests (
  embedding_model_id, embedding_dimensions, phase, request_id,
  request_hash, response
) values (
  'owner-delete-model', 1536, 'seed',
  '83000000-0000-4000-8000-000000000012', repeat('b', 64),
  jsonb_build_object(
    'afterOwnerId', '83838383-8383-4383-8383-838383838383',
    'items', '[]'::jsonb
  )
);

insert into owner_delete_secrets(owner_id, secret_id) values
  (
    '83838383-8383-4383-8383-838383838383',
    vault.create_secret(
      'sk-owner-delete-secret', 'owner-delete-secret',
      'pgTAP account deletion fixture', null
    )
  ),
  (
    '84848484-8484-4484-8484-848484848484',
    vault.create_secret(
      'sk-alternate-owner-secret', 'alternate-owner-secret',
      'pgTAP isolation fixture', null
    )
  );
insert into public.user_provider_keys (
  id, user_id, provider, vault_secret_id, key_last4, validated_at
)
select
  'key_83000000000000000000000001', owner_id,
  'openai'::public.ai_provider, secret_id, '8301', now()
from owner_delete_secrets
where owner_id = '83838383-8383-4383-8383-838383838383'
union all
select
  'key_84000000000000000000000001', owner_id,
  'openai'::public.ai_provider, secret_id, '8401', now()
from owner_delete_secrets
where owner_id = '84848484-8484-4484-8484-848484848484';
insert into public.user_provider_keys (
  id, user_id, provider, vault_secret_id, key_last4, validated_at
) values (
  'key_85000000000000000000000001',
  '85858585-8585-4585-8585-858585858585', 'openai',
  '85000000-0000-4000-8000-000000000001', '8501', now()
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into owner_delete_values(key, value)
select 'sourceProjection', public.list_encrypted_export_note_sources(
  '83838383-8383-4383-8383-838383838383',
  '["note_83000000000000000000000001"]'::jsonb
);
select is(
  (select value from owner_delete_values where key = 'sourceProjection'),
  jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
    'noteId', 'note_83000000000000000000000001',
    'sourceCaptureIds', jsonb_build_array('cap_83000000000000000000000001')
  ))),
  'export projection returns an exact owner-only note/source shape'
);
select throws_ok(
  $$select public.list_encrypted_export_note_sources(
    '83838383-8383-4383-8383-838383838383',
    '["note_84000000000000000000000001"]'::jsonb
  )$$,
  'P0001', 'not_found',
  'export projection hides an alternate owner note'
);
select throws_ok(
  $$select public.list_encrypted_export_note_sources(
    '83838383-8383-4383-8383-838383838383',
    '["note_83000000000000000000000001","note_83000000000000000000000001"]'::jsonb
  )$$,
  '22023', 'validation_failed',
  'export projection rejects duplicate paging coordinates'
);

reset role;

insert into owner_delete_values(key, value)
select 'preCounts',
  private.owner_public_data_counts('83838383-8383-4383-8383-838383838383')
  || private.owner_auth_data_counts('83838383-8383-4383-8383-838383838383')
  || jsonb_build_object('vault.secrets', 1);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into owner_delete_values(key, value)
select 'receipt', public.delete_encrypted_owner_account(
  '83838383-8383-4383-8383-838383838383',
  pg_temp.owner_delete_token_digest('delete_' || repeat('A', 43)),
  pg_temp.owner_delete_binding(
    'delete_' || repeat('A', 43),
    '83838383-8383-4383-8383-838383838383'
  )
);
reset role;

select ok(
  (select value ->> 'schemaVersion' = '1'
     and value ->> 'liveDataDeleted' = 'true'
     and value ->> 'sessionsRevoked' = 'true'
     and value ->> 'reRegistrationStartsFresh' = 'true'
     and value ->> 'backupRetentionDays' = '30'
     and value ->> 'replayed' = 'false'
   from owner_delete_values where key = 'receipt'),
  'initial deletion returns a content-free truthful receipt'
);
select is(
  (select value -> 'deletedRecordCounts'
   from owner_delete_values where key = 'receipt'),
  (select value from owner_delete_values where key = 'preCounts'),
  'receipt retains the exact dynamic per-table deletion audit counts'
);
select ok(
  (select (value -> 'deletedRecordCounts' ->> 'auth.sessions')::integer = 1
     and (value -> 'deletedRecordCounts' ->> 'auth.identities')::integer = 1
     and (value -> 'deletedRecordCounts' ->> 'auth.refresh_tokens')::integer = 1
     and (value -> 'deletedRecordCounts' ->> 'auth.flow_state')::integer = 1
     and (value -> 'deletedRecordCounts' ->> 'auth.users')::integer = 1
   from owner_delete_values where key = 'receipt'),
  'receipt explicitly audits every GoTrue principal, session, identity, refresh, and flow row'
);
select ok(
  private.account_deletion_counts_are_zero(
    private.owner_public_data_counts('83838383-8383-4383-8383-838383838383')
    || private.owner_auth_data_counts('83838383-8383-4383-8383-838383838383')
  ),
  'dynamic discovery verifies every current public/auth owner table is zero'
);
select ok(
  not exists (
    select 1 from auth.sessions
    where user_id = '83838383-8383-4383-8383-838383838383'
  )
    and not exists (
      select 1 from auth.identities
      where user_id = '83838383-8383-4383-8383-838383838383'
    )
    and not exists (
      select 1 from auth.refresh_tokens
      where user_id = '83838383-8383-4383-8383-838383838383'
    )
    and not exists (
      select 1 from auth.flow_state
      where user_id = '83838383-8383-4383-8383-838383838383'
    )
    and not exists (
      select 1 from auth.users
      where id = '83838383-8383-4383-8383-838383838383'
    ),
  'sessions, identities, refresh artifacts, flow state, and principal are all gone'
);
select ok(
  not exists (
    select 1 from vault.secrets
    where id = (
      select secret_id from owner_delete_secrets
      where owner_id = '83838383-8383-4383-8383-838383838383'
    )
  ),
  'owner provider secret is deleted from Vault before locator cascade'
);
select ok(
  (select after_owner_id is null
   from public.rag_index_maintenance_checkpoints
   where embedding_model_id = 'owner-delete-model'
     and embedding_dimensions = 1536 and phase = 'seed')
    and not exists (
      select 1 from public.rag_index_maintenance_page_requests
      where embedding_model_id = 'owner-delete-model'
        and embedding_dimensions = 1536 and phase = 'seed'
    ),
  'global RAG checkpoint and replay coordinates forget the deleted owner'
);
select ok(
  exists (
    select 1 from public.notes
    where id = 'note_84000000000000000000000001'
      and user_id = '84848484-8484-4484-8484-848484848484'
  )
    and exists (
      select 1 from vault.secrets
      where id = (
        select secret_id from owner_delete_secrets
        where owner_id = '84848484-8484-4484-8484-848484848484'
      )
    ),
  'alternate-owner note and Vault secret survive exactly'
);
select ok(
  not exists (
    select 1 from public.account_deletion_receipts
    where row_to_json(account_deletion_receipts)::text like
      '%83838383-8383-4383-8383-838383838383%'
      or row_to_json(account_deletion_receipts)::text like
        '%delete_' || repeat('A', 43) || '%'
  ),
  'durable receipt storage contains neither raw owner UUID nor raw bearer token'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.delete_encrypted_owner_account(
    '84848484-8484-4484-8484-848484848484',
    pg_temp.owner_delete_token_digest('delete_' || repeat('A', 43)),
    pg_temp.owner_delete_binding(
      'delete_' || repeat('A', 43),
      '84848484-8484-4484-8484-848484848484'
    )
  )$$,
  'P0001', 'invalid_idempotency_key',
  'a deletion capability cannot be replayed across owners'
);
reset role;
select ok(
  exists (
    select 1 from auth.users
    where id = '84848484-8484-4484-8484-848484848484'
  ),
  'cross-owner capability rejection does not delete the alternate principal'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into owner_delete_values(key, value)
select 'idempotentDelete', public.delete_encrypted_owner_account(
  '83838383-8383-4383-8383-838383838383',
  pg_temp.owner_delete_token_digest('delete_' || repeat('A', 43)),
  pg_temp.owner_delete_binding(
    'delete_' || repeat('A', 43),
    '83838383-8383-4383-8383-838383838383'
  )
);
insert into owner_delete_values(key, value)
select 'receiptReplay', public.get_account_deletion_receipt(
  pg_temp.owner_delete_token_digest('delete_' || repeat('A', 43)),
  repeat('c', 64)
);
select ok(
  (select value ->> 'replayed' = 'true'
   from owner_delete_values where key = 'idempotentDelete')
    and
  (select value ->> 'status' = 'found'
     and value -> 'receipt' ->> 'replayed' = 'true'
   from owner_delete_values where key = 'receiptReplay'),
  'lost initial responses are recoverable by both authenticated retry and bearer replay'
);
reset role;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '86868686-8686-4686-8686-868686868686',
  'authenticated', 'authenticated', 'owner-delete@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
select ok(
  exists (
    select 1 from public.profiles
    where id = '86868686-8686-4686-8686-868686868686'
  )
    and not exists (
      select 1 from public.notes
      where user_id = '86868686-8686-4686-8686-868686868686'
    ),
  're-registration creates a fresh principal/profile with no inherited library data'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into owner_delete_values(key, value)
select 'missingReceipt', public.get_account_deletion_receipt(
  repeat('d', 64), repeat('e', 64)
);
select is(
  (
    select count(*)
    from generate_series(1, 20) as attempt
    where public.get_account_deletion_receipt(
      repeat('f', 64), repeat('1', 64)
    ) = jsonb_build_object('status', 'not_found')
  ),
  20::bigint,
  'twenty missing receipt attempts persist as indistinguishable not-found results'
);
insert into owner_delete_values(key, value)
select 'rateLimitedReceipt', public.get_account_deletion_receipt(
  repeat('f', 64), repeat('1', 64)
);
reset role;
select is(
  (select value from owner_delete_values where key = 'rateLimitedReceipt'),
  jsonb_build_object('status', 'rate_limited'),
  'the twenty-first receipt attempt is durably rate limited'
);
select is(
  (
    select count(*)
    from public.account_deletion_receipt_lookup_events
    where requester_digest = repeat('1', 64)
  ),
  20::bigint,
  'the durable lookup ledger retains every failed attempt in the active window'
);

update public.account_deletion_receipts
set
  deleted_at = expiry.deleted_at,
  backup_expires_at = expiry.deleted_at + interval '30 days',
  receipt_expires_at = expiry.deleted_at + interval '31 days'
from (
  select clock_timestamp() - interval '32 days' as deleted_at
) as expiry
where idempotency_digest = pg_temp.owner_delete_token_digest(
  'delete_' || repeat('A', 43)
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into owner_delete_values(key, value)
select 'expiredReceipt', public.get_account_deletion_receipt(
  pg_temp.owner_delete_token_digest('delete_' || repeat('A', 43)),
  repeat('2', 64)
);
reset role;
select is(
  (select value from owner_delete_values where key = 'expiredReceipt'),
  (select value from owner_delete_values where key = 'missingReceipt'),
  'missing and expired receipt capabilities return exactly the same content-free result'
);
select ok(
  not exists (
    select 1 from public.account_deletion_receipts
    where idempotency_digest = pg_temp.owner_delete_token_digest(
      'delete_' || repeat('A', 43)
    )
  ),
  'expired pseudonymous receipts are purged on bounded replay access'
);

select * from finish();
rollback;
