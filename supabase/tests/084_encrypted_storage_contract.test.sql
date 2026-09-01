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
      'ciphertext', repeat(left(p_seed, 1), 64)
    )
  );
$$;

create function pg_temp.cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_key_id text,
  p_key_class text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_record_version, p_kind, p_key_id, p_seed
    ),
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id::text
  );
$$;

create function pg_temp.mac(
  p_seed text,
  p_key_id text,
  p_key_class text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', 'content_mac',
    'keyVersion', 1
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

create temporary table c5d7_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on c5d7_values to service_role;

-- Seed data is irrelevant to the operator boundary. Clearing canonical owners
-- with CASCADE gives the destructive path its smallest valid production
-- input, and the outer rollback restores the complete fixture afterward.
truncate table auth.users cascade;

insert into c5d7_values(key, value)
values ('precontract-readiness', private.encrypted_storage_contract_readiness());

select ok(
  (select (value ->> 'ready')::boolean
    from c5d7_values where key = 'precontract-readiness')
    and not (select (value ->> 'applied')::boolean
      from c5d7_values where key = 'precontract-readiness')
    and (select (value ->> 'ownerCount')::bigint
      from c5d7_values where key = 'precontract-readiness') = 0
    and (select (value ->> 'encryptedObjectCount')::bigint
      from c5d7_values where key = 'precontract-readiness') = 0
    and (select value ->> 'readinessDigest'
      from c5d7_values where key = 'precontract-readiness')
        ~ '^[0-9a-f]{64}$',
  'an empty canonical owner set has an exact, fresh readiness digest'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.apply_encrypted_storage_contract(text,text)', 'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'private.apply_encrypted_storage_contract(text,text)', 'EXECUTE'
    ),
  'the irreversible apply capability is absent from runtime roles'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error(format(
    'select private.apply_encrypted_storage_contract(%L,%L)',
    'CONTRACT UNFILED ENCRYPTED STORAGE V1',
    (select value ->> 'readinessDigest'
      from c5d7_values where key = 'precontract-readiness')
  )) ->> 'sqlstate',
  '42501',
  'service_role is denied before the contract even with the exact confirmation'
);
reset role;

select is(
  pg_temp.caught_error(format(
    'select private.apply_encrypted_storage_contract(%L,%L)',
    'contract it',
    (select value ->> 'readinessDigest'
      from c5d7_values where key = 'precontract-readiness')
  )) ->> 'message',
  'contract_confirmation_required',
  'the migration owner must supply the exact destructive confirmation'
);
select is(
  pg_temp.caught_error(format(
    'select private.apply_encrypted_storage_contract(%L,%L)',
    'CONTRACT UNFILED ENCRYPTED STORAGE V1', repeat('0', 64)
  )) ->> 'message',
  'stale_contract_readiness',
  'a syntactically valid but stale readiness digest is rejected'
);

-- This test-only public view is an unknown dependency. The contract uses the
-- default RESTRICT behavior, so its raw_text dependency must abort every DDL
-- and function rewrite performed earlier in the same apply invocation.
create view public.c5d7_contract_dependency_probe as
select capture.id, capture.raw_text from public.captures as capture;

insert into c5d7_values(key, value)
select 'restrict-error', pg_temp.caught_error(format(
  'select private.apply_encrypted_storage_contract(%L,%L)',
  'CONTRACT UNFILED ENCRYPTED STORAGE V1',
  (select value ->> 'readinessDigest'
    from c5d7_values where key = 'precontract-readiness')
));

select is(
  (select value ->> 'sqlstate'
    from c5d7_values where key = 'restrict-error'),
  '2BP01',
  'an unreviewed plaintext dependency aborts physical contraction via RESTRICT'
);
select ok(
  not exists (
    select 1 from private.encrypted_storage_contract_receipts
    where contract_version = 1
  )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'captures'
        and column_name = 'raw_text'
    )
    and to_regprocedure('public.create_note(text,public.note_type,text,text,text,public.privacy_mode,jsonb,jsonb,jsonb)')
      is not null
    and (
      select procedure.prosrc not like '%''contracted''%'
      from pg_catalog.pg_proc as procedure
      where procedure.oid =
        'public.prepare_encrypted_note_write(uuid,text,text,text,integer,public.privacy_mode,jsonb)'::regprocedure
    ),
  'the failed RESTRICT apply rolls its receipt, schema, legacy RPCs, and rewrites back'
);
drop view public.c5d7_contract_dependency_probe;

insert into c5d7_values(key, value)
select 'apply', private.apply_encrypted_storage_contract(
  'CONTRACT UNFILED ENCRYPTED STORAGE V1',
  (select value ->> 'readinessDigest'
    from c5d7_values where key = 'precontract-readiness')
);

select ok(
  (select value ->> 'state' from c5d7_values where key = 'apply')
      = 'contracted'
    and (select (value ->> 'ownerCount')::bigint
      from c5d7_values where key = 'apply') = 0
    and (select (value ->> 'encryptedObjectCount')::bigint
      from c5d7_values where key = 'apply') = 0
    and not (select (value ->> 'replayed')::boolean
      from c5d7_values where key = 'apply'),
  'the exact zero-owner readiness snapshot contracts successfully'
);
select is(
  (
    select count(*)
    from private.encrypted_storage_contract_receipts
    where contract_version = 1
      and readiness_digest = (
        select value ->> 'readinessDigest'
        from c5d7_values where key = 'precontract-readiness'
      )
      and owner_count = 0 and encrypted_object_count = 0
      and confirmation_digest ~ '^[0-9a-f]{64}$'
  ),
  1::bigint,
  'one content-free receipt binds the applied digest and zero-owner counts'
);
select is(
  private.apply_encrypted_storage_contract(
    'CONTRACT UNFILED ENCRYPTED STORAGE V1',
    (select value ->> 'readinessDigest'
      from c5d7_values where key = 'precontract-readiness')
  ) ->> 'replayed',
  'true',
  'the replaced apply function provides digest-bound replay only'
);
select is(
  pg_temp.caught_error(format(
    'select private.apply_encrypted_storage_contract(%L,%L)',
    'CONTRACT UNFILED ENCRYPTED STORAGE V1', repeat('f', 64)
  )) ->> 'message',
  'invalid_contract_replay',
  'contract replay cannot be rebound to another readiness digest'
);

select ok(
  pg_catalog.to_regclass('public.note_chunks') is null
    and pg_catalog.to_regclass('public.notes_fts') is null
    and pg_catalog.to_regclass('public.notes_title_trgm') is null,
  'the plaintext search table and indexes are physically absent'
);
select is(
  (
    with forbidden_column(table_name, column_name) as (values
      ('spaces'::text, 'name'::text), ('spaces', 'slug'),
      ('tags', 'name'),
      ('notes', 'title'), ('notes', 'body_markdown'),
      ('notes', 'structured_data'),
      ('note_revisions', 'title'),
      ('note_revisions', 'body_markdown'),
      ('note_revisions', 'structured_data'),
      ('note_revisions', 'tag_ids'), ('note_revisions', 'links'),
      ('note_revisions', 'content_hash'),
      ('note_mutations', 'operations'), ('note_mutations', 'inverse'),
      ('organization_decisions', 'candidate_manifest'),
      ('organization_decisions', 'signals'),
      ('organization_decisions', 'validated_plan'),
      ('generated_blocks', 'content'),
      ('review_items', 'choices'), ('review_items', 'resolution'),
      ('routing_rules', 'condition_normalized'),
      ('organization_mutation_attempts', 'operations'),
      ('api_idempotency_records', 'request_hash'),
      ('api_idempotency_records', 'response_json'),
      ('capture_receipts', 'headline'),
      ('capture_receipts', 'inserted_content'),
      ('capture_receipts', 'actions'),
      ('captures', 'raw_text')
    )
    select count(*)
    from forbidden_column as forbidden
    join information_schema.columns as column_record
      on column_record.table_schema = 'public'
      and column_record.table_name = forbidden.table_name
      and column_record.column_name = forbidden.column_name
  ),
  0::bigint,
  'every enumerated plaintext aggregate column is physically absent'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where (
      namespace.nspname = 'public'
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
    ) or (
      namespace.nspname = 'private'
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
        'scrub_legacy_content_on_write',
        'enforce_encrypted_rollout_write', 'contract_replace_function'
      ])
    )
  ),
  0::bigint,
  'legacy plaintext, scrub, backfill, and migration-only functions are absent'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_trigger as trigger_record
    join pg_catalog.pg_proc as procedure
      on procedure.oid = trigger_record.tgfoid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where not trigger_record.tgisinternal
      and (
        trigger_record.tgname in (
          'aa_encrypted_only_scrub', 'captures_scrub_plaintext'
        )
        or (
          namespace.nspname = 'private'
          and procedure.proname in (
            'scrub_legacy_content_on_write',
            'enforce_encrypted_rollout_write'
          )
        )
      )
  ) and (
    select count(*)
    from pg_catalog.pg_trigger as trigger_record
    join pg_catalog.pg_class as relation
      on relation.oid = trigger_record.tgrelid
    join pg_catalog.pg_namespace as relation_namespace
      on relation_namespace.oid = relation.relnamespace
    join pg_catalog.pg_proc as procedure
      on procedure.oid = trigger_record.tgfoid
    join pg_catalog.pg_namespace as procedure_namespace
      on procedure_namespace.oid = procedure.pronamespace
    where not trigger_record.tgisinternal
      and relation_namespace.nspname = 'public'
      and procedure_namespace.nspname = 'private'
      and procedure.proname = 'enforce_contracted_encrypted_write'
  ) = 13,
  'legacy guards are gone and all thirteen content surfaces use the contracted guard'
);

select ok(
  not exists (
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
  ),
  'all application identities lack direct content-table privileges after contraction'
);
select ok(
  not has_table_privilege(
    'service_role', 'private.encrypted_storage_contract_receipts', 'SELECT'
  )
    and not has_function_privilege(
      'service_role',
      'private.apply_encrypted_storage_contract(text,text)', 'EXECUTE'
    ),
  'the receipt and replay operator stay outside the runtime capability set'
);

select has_function(
  'public', 'list_encrypted_notes',
  array['uuid', 'timestamp with time zone', 'text', 'integer'],
  'the encrypted note list RPC survives physical contraction'
);
select has_function(
  'public', 'get_encrypted_note', array['uuid', 'text'],
  'the encrypted note detail RPC survives physical contraction'
);
select has_function(
  'public', 'verify_encrypted_content_object',
  array['uuid', 'text', 'text', 'integer', 'jsonb', 'jsonb'],
  'the exact-envelope verification RPC survives physical contraction'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_encrypted_notes(uuid,timestamp with time zone,text,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.verify_encrypted_content_object(uuid,text,text,integer,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.list_encrypted_notes(uuid,timestamp with time zone,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_encrypted_content_object(uuid,text,text,integer,jsonb,jsonb)',
      'EXECUTE'
    ),
  'retained encrypted reads and verification preserve the service-only ACL'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '55555555-5555-4555-8555-555555555555',
  'authenticated', 'authenticated', 'c5d7-fresh@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Fresh Contract Owner"}'::jsonb, now(), now()
);

select ok(
  exists (
    select 1 from public.profiles
    where id = '55555555-5555-4555-8555-555555555555'
      and display_name = 'Fresh Contract Owner'
  ) and exists (
    select 1 from public.content_encryption_rollouts
    where user_id = '55555555-5555-4555-8555-555555555555'
      and state = 'contracted'
      and backfill_completed_at is not null
      and plaintext_scrub_id is not null
      and plaintext_scrub_version = 1
      and plaintext_scrub_started_at is not null
      and plaintext_scrub_completed_at is not null
      and plaintext_scrub_attestation_digest ~ '^[0-9a-f]{64}$'
      and encrypted_object_count = 0 and verified_object_count = 0
  ),
  'fresh signup atomically creates its profile and empty contracted rollout'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  public.get_content_encryption_rollout(
    '55555555-5555-4555-8555-555555555555'
  ) @> '{"found":true,"state":"contracted","writeMode":"encrypted","readMode":"encrypted"}'::jsonb,
  'fresh signup projects only the contracted encrypted repository mode'
);
reset role;

-- Simulate a damaged/missing rollout. Reads must not reinterpret absence as a
-- legacy owner; the first post-contract key registration then bootstraps the
-- only valid state again.
delete from public.content_encryption_rollouts
where user_id = '55555555-5555-4555-8555-555555555555';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.get_content_encryption_rollout(
      '55555555-5555-4555-8555-555555555555'
    )
  $statement$) ->> 'message',
  'not_found',
  'a missing post-contract rollout fails closed instead of selecting legacy storage'
);

select public.register_user_content_key(
  '55555555-5555-4555-8555-555555555555', key_id,
  key_class::public.content_key_class,
  key_purpose::public.content_key_purpose, 1,
  'arn:aws:kms:us-west-2:123456789012:key/' || root_id,
  decode(repeat(material, 32), 'hex')
)
from (values
  ('c5d7.ai.object.v1', 'ai_assisted', 'object_wrap',
    '84000000-0000-4000-8000-000000000001', '11'),
  ('c5d7.ai.mac.v1', 'ai_assisted', 'content_mac',
    '84000000-0000-4000-8000-000000000002', '12'),
  ('c5d7.private.object.v1', 'private_manual', 'object_wrap',
    '84000000-0000-4000-8000-000000000003', '13'),
  ('c5d7.private.mac.v1', 'private_manual', 'content_mac',
    '84000000-0000-4000-8000-000000000004', '14')
) as key_fixture(key_id, key_class, key_purpose, root_id, material);

select ok(
  public.get_content_encryption_rollout(
    '55555555-5555-4555-8555-555555555555'
  ) @> '{"found":true,"state":"contracted","writeMode":"encrypted","readMode":"encrypted"}'::jsonb,
  'post-contract key registration bootstraps a missing rollout as contracted'
);

select public.activate_user_content_key(
  '55555555-5555-4555-8555-555555555555', key_id
)
from (values
  ('c5d7.ai.object.v1'), ('c5d7.ai.mac.v1'),
  ('c5d7.private.object.v1'), ('c5d7.private.mac.v1')
) as key_fixture(key_id);

select is(
  (
    select count(*)
    from public.user_content_keys
    where user_id = '55555555-5555-4555-8555-555555555555'
      and key_version = 1 and state = 'active'
      and (key_class, key_purpose) in (
        ('ai_assisted', 'object_wrap'),
        ('ai_assisted', 'content_mac'),
        ('private_manual', 'object_wrap'),
        ('private_manual', 'content_mac')
      )
  ),
  4::bigint,
  'all four class/purpose key slots register and activate after contraction'
);

select public.reserve_content_key_operations(
  '55555555-5555-4555-8555-555555555555',
  '84000000-0000-4000-8000-000000000010',
  'private_manual', 'c5d7.private.object.v1', 1, 4
);

insert into c5d7_values(key, value) values (
  'create-claim', public.prepare_encrypted_note_write(
    '55555555-5555-4555-8555-555555555555',
    'create_encrypted_note', 'c5d7-create', null, 0, 'private_manual',
    pg_temp.mac(
      'c5d7-logical-create', 'c5d7.private.mac.v1', 'private_manual'
    )
  )
);

insert into c5d7_values(key, value)
select 'create-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', jsonb_build_object(
    'spaceId', null,
    'type', 'generic',
    'title', 'e-' || lower(claim.value ->> 'noteId'),
    'bodyMarkdown', '',
    'structuredData', jsonb_build_object('schemaVersion', 1),
    'dailyDate', null,
    'isOpen', true,
    'privacy', 'private_manual',
    'pinnedAt', null,
    'archivedAt', null,
    'deletedAt', null,
    'tagIds', jsonb_build_array(),
    'links', jsonb_build_array()
  ),
  'noteCipher', pg_temp.cipher(
    claim.value ->> 'noteId',
    '55555555-5555-4555-8555-555555555555', 1, 'note_content',
    'c5d7.private.object.v1', 'private_manual',
    '84000000-0000-4000-8000-000000000010', 'N'
  ),
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId',
    'source', 'manual',
    'actor', 'user:c5d7',
    'cipher', pg_temp.cipher(
      claim.value ->> 'revisionId',
      '55555555-5555-4555-8555-555555555555', 1, 'note_revision',
      'c5d7.private.object.v1', 'private_manual',
      '84000000-0000-4000-8000-000000000010', 'R'
    ),
    'mac', pg_temp.mac(
      'c5d7-revision', 'c5d7.private.mac.v1', 'private_manual'
    )
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId',
    'decisionId', null,
    'undoTargetMutationId', null,
    'operations', jsonb_build_array(jsonb_build_object('type', 'create_note')),
    'inverse', jsonb_build_object('type', 'soft_delete_created_note'),
    'cipher', pg_temp.cipher(
      claim.value ->> 'mutationId',
      '55555555-5555-4555-8555-555555555555', 1, 'note_mutation',
      'c5d7.private.object.v1', 'private_manual',
      '84000000-0000-4000-8000-000000000010', 'M'
    )
  ),
  'requestMac', pg_temp.mac(
    'c5d7-logical-create', 'c5d7.private.mac.v1', 'private_manual'
  ),
  'responseCipher', pg_temp.cipher(
    'idempotency:c5d7-create',
    '55555555-5555-4555-8555-555555555555', 1,
    'idempotency_response', 'c5d7.private.object.v1', 'private_manual',
    '84000000-0000-4000-8000-000000000010', 'I'
  ),
  'verification', jsonb_build_object(
    'noteContent', pg_temp.mac(
      'c5d7-note-verification', 'c5d7.private.mac.v1', 'private_manual'
    ),
    'noteMutation', pg_temp.mac(
      'c5d7-mutation-verification', 'c5d7.private.mac.v1', 'private_manual'
    ),
    'idempotencyResponse', pg_temp.mac(
      'c5d7-response-verification', 'c5d7.private.mac.v1', 'private_manual'
    )
  )
)
from c5d7_values as claim where claim.key = 'create-claim';

insert into c5d7_values(key, value)
select 'create-result', public.create_encrypted_note(
  '55555555-5555-4555-8555-555555555555',
  claim.value ->> 'noteId', 'c5d7-create', command.value
)
from c5d7_values as claim
cross join c5d7_values as command
where claim.key = 'create-claim' and command.key = 'create-command';

select ok(
  (select value ->> 'currentRevision'
    from c5d7_values where key = 'create-result') = '1'
    and not (select (value ->> 'replayed')::boolean
      from c5d7_values where key = 'create-result')
    and public.list_encrypted_notes(
      '55555555-5555-4555-8555-555555555555', null, null, 10
    ) #>> '{notes,0,noteId}' = (
      select value ->> 'noteId' from c5d7_values where key = 'create-claim'
    )
    and not (
      public.list_encrypted_notes(
        '55555555-5555-4555-8555-555555555555', null, null, 10
      ) #> '{notes,0}' ?| array['title', 'bodyMarkdown', 'structuredData']
    )
    and public.get_encrypted_note(
      '55555555-5555-4555-8555-555555555555',
      (select value ->> 'noteId'
        from c5d7_values where key = 'create-claim')
    ) #>> '{contentCipher,keyId}' = 'c5d7.private.object.v1',
  'a retained encrypted create/list/detail round trip stores no plaintext projection'
);

select is(
  public.verify_encrypted_content_object(
    '55555555-5555-4555-8555-555555555555', 'note_content',
    (select value ->> 'noteId'
      from c5d7_values where key = 'create-claim'),
    1,
    (select value #> '{noteCipher,envelope}'
      from c5d7_values where key = 'create-command'),
    pg_temp.mac(
      'c5d7-note-verification', 'c5d7.private.mac.v1', 'private_manual'
    )
  ) ->> 'replayed',
  'true',
  'retained exact-envelope verification remains live in contracted state'
);
reset role;

select * from finish();
rollback;
