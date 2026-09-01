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
      'nonce', repeat('A', 16), 'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16),
      'ciphertext', repeat(left(p_seed, 1), 64)
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

create temporary table c5d_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on c5d_values to service_role;

select has_column(
  'public', 'content_encryption_rollouts', 'plaintext_scrub_id',
  'rollouts retain an auditable per-owner scrub identity'
);
select has_column(
  'public', 'content_encryption_rollouts', 'plaintext_scrub_cursor',
  'rollouts retain the bounded scrub cursor'
);
select has_column(
  'public', 'content_encryption_rollouts',
  'plaintext_scrub_attestation_digest',
  'rollouts retain the exact post-scrub attestation digest'
);
select has_function(
  'public', 'prepare_content_plaintext_scrub',
  array['uuid', 'uuid', 'encryption_rollout_state'],
  'the prepare RPC has an explicit owner, operation id, and expected state'
);
select has_function(
  'public', 'scrub_content_plaintext_batch',
  array['uuid', 'uuid', 'text', 'integer'],
  'the bounded batch RPC has an exact cursor and limit'
);
select has_function(
  'public', 'complete_content_plaintext_scrub',
  array['uuid', 'uuid', 'text'],
  'the completion RPC binds the operation and final cursor'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.prepare_content_plaintext_scrub(uuid,uuid,public.encryption_rollout_state)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.scrub_content_plaintext_batch(uuid,uuid,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_content_plaintext_scrub(uuid,uuid,text)', 'EXECUTE'
    ),
  'only the existing service boundary receives the scrub protocol'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    where procedure.oid = any(array[
      'public.prepare_content_plaintext_scrub(uuid,uuid,public.encryption_rollout_state)'::regprocedure,
      'public.scrub_content_plaintext_batch(uuid,uuid,text,integer)'::regprocedure,
      'public.complete_content_plaintext_scrub(uuid,uuid,text)'::regprocedure
    ]) and (
      has_function_privilege('public', procedure.oid, 'EXECUTE')
      or has_function_privilege('anon', procedure.oid, 'EXECUTE')
      or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      or has_function_privilege(
        'unfiled_index_worker', procedure.oid, 'EXECUTE'
      )
      or has_function_privilege(
        'unfiled_rag_verifier', procedure.oid, 'EXECUTE'
      )
      or has_function_privilege(
        'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
      )
    )
  ),
  'clients and isolated workers receive no scrub capability'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = any(array[
        'encrypted_only_note_sentinel',
        'valid_encrypted_only_note_command',
        'encrypted_only_idempotency_response',
        'valid_plaintext_scrub_transition',
        'scrub_legacy_content_on_write',
        'content_plaintext_scrub_readiness'
      ])
      and (
        has_function_privilege('public', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege('service_role', procedure.oid, 'EXECUTE')
        or has_function_privilege(
          'unfiled_index_worker', procedure.oid, 'EXECUTE'
        )
        or has_function_privilege(
          'unfiled_rag_verifier', procedure.oid, 'EXECUTE'
        )
        or has_function_privilege(
          'unfiled_organizer_worker', procedure.oid, 'EXECUTE'
        )
      )
  ),
  'scrub helpers are trigger/internal-only for every application role'
);
select is(
  (
    select count(*)
    from pg_trigger as trigger
    join pg_class as relation on relation.oid = trigger.tgrelid
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'spaces', 'tags', 'notes', 'note_revisions',
        'organization_decisions', 'note_mutations', 'generated_blocks',
        'review_items', 'routing_rules', 'organization_mutation_attempts',
        'api_idempotency_records', 'capture_receipts', 'captures',
        'note_chunks'
      ])
      and trigger.tgname = 'aa_encrypted_only_scrub'
      and not trigger.tgisinternal
  ),
  14::bigint,
  'all thirteen legacy surfaces plus note_chunks have the scrub fence'
);
select ok(
  not exists (
    select 1
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(array[
        'spaces', 'tags', 'notes', 'note_revisions',
        'organization_decisions', 'note_mutations', 'generated_blocks',
        'review_items', 'routing_rules', 'organization_mutation_attempts',
        'api_idempotency_records', 'capture_receipts', 'captures',
        'note_chunks'
      ])
      and not exists (
        select 1 from pg_trigger as prelock
        where prelock.tgrelid = relation.oid
          and prelock.tgname = 'a_content_rollout_advisory_prelock'
          and not prelock.tgisinternal
      )
  ),
  'every scrubbed relation acquires the owner rollout advisory first'
);
select ok(
  (
    select position('pg_advisory_xact_lock' in procedure.prosrc)
      < position('for update' in lower(procedure.prosrc))
    from pg_proc as procedure
    where procedure.oid =
      'public.scrub_content_plaintext_batch(uuid,uuid,text,integer)'::regprocedure
  ),
  'the batch takes the canonical owner advisory before its rollout row lock'
);
select ok(
  (
    select procedure.prosrc like '%encrypted_read%encrypted_only%'
      and procedure.prosrc like '%plaintext_scrub_attestation_digest%'
      and procedure.prosrc like '%content_plaintext_scrub_readiness%'
    from pg_proc as procedure
    where procedure.oid =
      'public.advance_content_encryption_rollout(uuid,public.encryption_rollout_state,public.encryption_rollout_state)'::regprocedure
  ),
  'encrypted_only transition is bound to current scrub evidence'
);
select is(
  (
    select count(*)
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where (namespace.nspname, procedure.proname) in (
      ('public', 'prepare_encrypted_note_write'),
      ('public', 'verify_encrypted_content_object'),
      ('private', 'create_encrypted_capture_with_job_e1'),
      ('private', 'create_encrypted_capture_with_job_legacy'),
      ('private', 'claim_encrypted_organizer_jobs_impl')
    ) and procedure.prosrc like
      '%state in (''dual_write'', ''encrypted_read'', ''encrypted_only'')%'
  ),
  5::bigint,
  'all encrypted writers and the organizer claim path remain live in encrypted_only'
);
select is(
  (
    select count(*)
    from pg_proc as procedure
    where procedure.oid = any(array[
      'public.create_encrypted_note(uuid,text,text,jsonb)'::regprocedure,
      'public.apply_encrypted_note_mutation(uuid,text,integer,text,jsonb)'::regprocedure
    ]) and procedure.prosrc like '%valid_encrypted_only_note_command%'
  ),
  2::bigint,
  'both generic note command RPCs enforce the ciphertext-only projection'
);

-- Dedicated owner fixture.  Every encrypted aggregate surface deliberately
-- starts with the same canary in its legacy projection.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '33333333-3333-4333-8333-333333333333',
  'authenticated', 'authenticated', 'c5d-owner@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id)
values ('33333333-3333-4333-8333-333333333333');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
)
select
  '33333333-3333-4333-8333-333333333333', key_id,
  key_class::public.content_key_class,
  key_purpose::public.content_key_purpose, 1,
  'arn:aws:kms:us-west-2:123456789012:key/' || root_id,
  decode(repeat(material, 32), 'hex'), 'active', now()
from (values
  ('c5d.ai.object.v1', 'ai_assisted', 'object_wrap',
    '78000000-0000-4000-8000-000000000001', '11'),
  ('c5d.ai.mac.v1', 'ai_assisted', 'content_mac',
    '78000000-0000-4000-8000-000000000002', '12'),
  ('c5d.private.object.v1', 'private_manual', 'object_wrap',
    '78000000-0000-4000-8000-000000000003', '13'),
  ('c5d.private.mac.v1', 'private_manual', 'content_mac',
    '78000000-0000-4000-8000-000000000004', '14')
) as key_fixture(key_id, key_class, key_purpose, root_id, material);

insert into public.spaces (
  id, user_id, name, slug, display_envelope, display_key_id,
  display_key_class, display_key_purpose, display_key_version,
  display_mac, display_mac_key_id, display_mac_key_class,
  display_mac_key_purpose, display_mac_key_version
) values (
  'spc_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'C5D_CANARY space', 'c5d-canary-space',
  pg_temp.content_envelope(
    'spc_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'space_display',
    'c5d.private.object.v1'
  ),
  'c5d.private.object.v1', 'private_manual', 'object_wrap', 1,
  repeat('1', 64), 'c5d.private.mac.v1', 'private_manual', 'content_mac', 1
);
insert into public.tags (
  id, user_id, name, display_envelope, display_key_id, display_key_class,
  display_key_purpose, display_key_version, display_mac,
  display_mac_key_id, display_mac_key_class, display_mac_key_purpose,
  display_mac_key_version
) values (
  'tag_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', 'c5d_canary_tag',
  pg_temp.content_envelope(
    'tag_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'tag_display',
    'c5d.private.object.v1'
  ),
  'c5d.private.object.v1', 'private_manual', 'object_wrap', 1,
  repeat('2', 64), 'c5d.private.mac.v1', 'private_manual', 'content_mac', 1
);
insert into public.notes (
  id, user_id, space_id, type, title, body_markdown, structured_data,
  privacy, content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'note_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'spc_78000000000000000000000001', 'generic',
  'C5D_CANARY note', 'C5D_CANARY body',
  '{"schemaVersion":1}'::jsonb, 'ai_assisted',
  pg_temp.content_envelope(
    'note_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'note_content',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status, content_envelope,
  content_fingerprint, content_length, content_key_id, content_key_class,
  content_key_purpose, content_key_version, fingerprint_key_id,
  fingerprint_key_class, fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', 'web', 'c5d-device',
  'C5D_CANARY capture', 'ai_assisted', now(), 'UTC', 'organized',
  pg_temp.content_envelope(
    'cap_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'capture',
    'c5d.ai.object.v1'
  ),
  repeat('3', 64), 18, 'c5d.ai.object.v1', 'ai_assisted',
  'object_wrap', 1, 'c5d.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version,
  completed_at
) values (
  'job_78000000000000000000000001',
  'cap_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'succeeded', 'routing-v1', 1, now()
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, decision_envelope, decision_key_id, decision_key_class,
  decision_key_purpose, decision_key_version
) values (
  'dec_78000000000000000000000001',
  'cap_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  '{"canary":"C5D_CANARY"}', '{"canary":"C5D_CANARY"}',
  '{"canary":"C5D_CANARY"}', 'auto',
  pg_temp.content_envelope(
    'dec_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1,
    'organization_decision', 'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key, before_revision,
  after_revision, operations, inverse, mutation_envelope, mutation_key_id,
  mutation_key_class, mutation_key_purpose, mutation_key_version
) values (
  'mut_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'dec_78000000000000000000000001',
  'note_78000000000000000000000001', 'c5d-canary-mutation', 0, 1,
  '[{"canary":"C5D_CANARY"}]', '{"canary":"C5D_CANARY"}',
  pg_temp.content_envelope(
    'mut_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'note_mutation',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_revisions (
  id, note_id, user_id, revision, source, space_id, type, title,
  body_markdown, structured_data, is_open, privacy, tag_ids, links,
  content_hash, actor, mutation_id, snapshot_envelope, snapshot_key_id,
  snapshot_key_class, snapshot_key_purpose, snapshot_key_version,
  snapshot_mac, snapshot_mac_key_id, snapshot_mac_key_class,
  snapshot_mac_key_purpose, snapshot_mac_key_version
) values (
  'rev_78000000000000000000000001',
  'note_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', 1, 'manual',
  'spc_78000000000000000000000001', 'generic',
  'C5D_CANARY revision', 'C5D_CANARY revision body',
  '{"schemaVersion":1}', true, 'ai_assisted',
  '["tag_78000000000000000000000001"]',
  '[{"target":"C5D_CANARY"}]', repeat('4', 64), 'service:c5d',
  'mut_78000000000000000000000001',
  pg_temp.content_envelope(
    'rev_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'note_revision',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  repeat('4', 64), 'c5d.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);

insert into public.generated_blocks (
  id, user_id, note_id, decision_id, kind, content, state, model_id,
  prompt_version, content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values (
  'blk_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'note_78000000000000000000000001',
  'dec_78000000000000000000000001', 'summary',
  'C5D_CANARY generated block', 'proposed', 'fixture-model', 'fixture-v1',
  pg_temp.content_envelope(
    'blk_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'generated_block',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices, state, resolution,
  review_envelope, review_key_id, review_key_class, review_key_purpose,
  review_key_version
) values (
  'rvw_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'cap_78000000000000000000000001',
  'note_78000000000000000000000001', 'low_confidence',
  '[{"canary":"C5D_CANARY"}]', 'open', '{"canary":"C5D_CANARY"}',
  pg_temp.content_envelope(
    'rvw_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'review_item',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.routing_rules (
  id, user_id, enabled, rule_type, condition_normalized,
  destination_note_id, priority, source, condition_envelope,
  condition_key_id, condition_key_class, condition_key_purpose,
  condition_key_version
) values (
  'rule_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', true, 'phrase',
  'C5D_CANARY routing condition',
  'note_78000000000000000000000001', 100, 'explicit',
  pg_temp.content_envelope(
    'rule_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'routing_rule',
    'c5d.private.object.v1'
  ),
  'c5d.private.object.v1', 'private_manual', 'object_wrap', 1
);
insert into public.organization_mutation_attempts (
  job_id, note_id, user_id, planned_revision, operations, state,
  attempt_envelope, attempt_key_id, attempt_key_class,
  attempt_key_purpose, attempt_key_version
) values (
  'job_78000000000000000000000001',
  'note_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', 1,
  '[{"canary":"C5D_CANARY"}]', 'applied',
  pg_temp.content_envelope(
    'job_78000000000000000000000001:note_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1,
    'organization_mutation_attempt', 'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.api_idempotency_records (
  user_id, idempotency_key, scope, request_hash, response_json,
  completed_at, response_envelope, response_key_id, response_key_class,
  response_key_purpose, response_key_version, request_resource_type,
  request_resource_id, response_resource_type, response_resource_id,
  response_record_version, replay_policy
) values (
  '33333333-3333-4333-8333-333333333333', 'c5d-legacy-canary',
  'create_note', repeat('5', 64), '{"canary":"C5D_CANARY"}', now(),
  pg_temp.content_envelope(
    'idempotency:c5d-legacy-canary',
    '33333333-3333-4333-8333-333333333333', 1,
    'idempotency_response', 'c5d.private.object.v1'
  ),
  'c5d.private.object.v1', 'private_manual', 'object_wrap', 1,
  'note', 'note_78000000000000000000000001', 'note_mutation',
  'mut_78000000000000000000000001', 1, 'legacy_nonreplayable'
);
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, outcome, headline,
  destination_note_id, inserted_content, actions, receipt_envelope,
  receipt_key_id, receipt_key_class, receipt_key_purpose, receipt_key_version
) values (
  'cap_78000000000000000000000001',
  'job_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'dec_78000000000000000000000001',
  'mut_78000000000000000000000001', 'created_note',
  'C5D_CANARY receipt', 'note_78000000000000000000000001',
  '[{"canary":"C5D_CANARY"}]', '[{"canary":"C5D_CANARY"}]',
  pg_temp.content_envelope(
    'cap_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'capture_receipt',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_chunks (
  id, note_id, user_id, revision, ordinal, text_hash, content
) values (
  'chk_78000000000000000000000001',
  'note_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333', 1, 0,
  repeat('6', 64), 'C5D_CANARY legacy search chunk'
);

insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions, state,
  expected_note_count, indexed_note_count, activated_at
) values (
  'igen_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'fixture-embedding', 1536, 'active', 1, 1, now()
);
insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision, index_envelope,
  index_key_id, index_key_class, index_key_purpose, index_key_version,
  encrypted_byte_length
) values (
  'irw_78000000000000000000000001',
  '33333333-3333-4333-8333-333333333333',
  'note_78000000000000000000000001',
  'igen_78000000000000000000000001', 1,
  pg_temp.content_envelope(
    'irw_78000000000000000000000001',
    '33333333-3333-4333-8333-333333333333', 1, 'note_rag_index',
    'c5d.ai.object.v1'
  ),
  'c5d.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 48
);

insert into public.content_encryption_verifications (
  user_id, surface, resource_id, record_version, envelope_digest,
  verification_mac, verification_mac_key_id, verification_mac_key_class,
  verification_mac_key_purpose, verification_mac_key_version
)
select
  '33333333-3333-4333-8333-333333333333', fixture.surface,
  fixture.resource_id, fixture.record_version,
  encode(extensions.digest(fixture.envelope_value::text, 'sha256'), 'hex'),
  encode(extensions.digest(fixture.surface || ':' || fixture.resource_id,
    'sha256'), 'hex'),
  fixture.mac_key_id, fixture.key_class::public.content_key_class,
  'content_mac', 1
from (
  select 'space_display', space.id, space.current_revision,
    space.display_envelope, 'c5d.private.mac.v1', 'private_manual'
  from public.spaces as space where space.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'tag_display', tag.id, tag.current_revision,
    tag.display_envelope, 'c5d.private.mac.v1', 'private_manual'
  from public.tags as tag where tag.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'note_content', note.id, note.current_revision,
    note.content_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.notes as note where note.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'note_revision', revision.id, revision.revision,
    revision.snapshot_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.note_revisions as revision where revision.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'organization_decision', decision.id,
    decision.decision_content_revision, decision.decision_envelope,
    'c5d.ai.mac.v1', 'ai_assisted'
  from public.organization_decisions as decision where decision.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'note_mutation', mutation.id, mutation.after_revision,
    mutation.mutation_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.note_mutations as mutation where mutation.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'generated_block', block.id, 1, block.content_envelope,
    'c5d.ai.mac.v1', 'ai_assisted'
  from public.generated_blocks as block where block.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'review_item', review.id, review.review_content_revision,
    review.review_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.review_items as review where review.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'routing_rule', rule.id, rule.condition_revision,
    rule.condition_envelope, 'c5d.private.mac.v1', 'private_manual'
  from public.routing_rules as rule where rule.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'organization_mutation_attempt', attempt.job_id || ':'
      || attempt.note_id, attempt.attempt_content_revision,
    attempt.attempt_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.organization_mutation_attempts as attempt
  where attempt.user_id = '33333333-3333-4333-8333-333333333333'
  union all
  select 'idempotency_response', 'idempotency:' || record.idempotency_key,
    1, record.response_envelope, 'c5d.private.mac.v1', 'private_manual'
  from public.api_idempotency_records as record where record.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'capture_receipt', receipt.capture_id, receipt.receipt_revision,
    receipt.receipt_envelope, 'c5d.ai.mac.v1', 'ai_assisted'
  from public.capture_receipts as receipt where receipt.user_id =
    '33333333-3333-4333-8333-333333333333'
  union all
  select 'capture', capture.id, 1, capture.content_envelope,
    'c5d.ai.mac.v1', 'ai_assisted'
  from public.captures as capture where capture.user_id =
    '33333333-3333-4333-8333-333333333333'
) as fixture(
  surface, resource_id, record_version, envelope_value, mac_key_id, key_class
);

update public.content_encryption_rollouts set
  state = 'encrypted_read', backfill_completed_at = now(),
  encrypted_object_count = 13, verified_object_count = 13
where user_id = '33333333-3333-4333-8333-333333333333';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into c5d_values(key, value) values (
  'prepare', public.prepare_content_plaintext_scrub(
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010', 'encrypted_read'
  )
);
select is(
  (select value ->> 'replayed' from c5d_values where key = 'prepare'),
  'false',
  'prepare starts one owner-scoped scrub operation'
);
select is(
  public.prepare_content_plaintext_scrub(
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010', 'encrypted_read'
  ) ->> 'replayed',
  'true',
  'prepare replays only the same scrub identity'
);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_content_plaintext_scrub(
      '33333333-3333-4333-8333-333333333333',
      '78000000-0000-4000-8000-000000000011', 'encrypted_read'
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'a second scrub identity cannot alias an in-progress scrub'
);

insert into c5d_values(key, value) values (
  'first-batch', public.scrub_content_plaintext_batch(
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010', null, 3
  )
);
select is(
  (select (value ->> 'processedCount')::integer
    from c5d_values where key = 'first-batch'),
  3,
  'the first batch is bounded by the requested limit'
);
select is(
  public.scrub_content_plaintext_batch(
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010', null, 3
  ) ->> 'replayed',
  'true',
  'an exact lost-response retry returns the stored batch result'
);
select is(
  pg_temp.caught_error($statement$
    select public.scrub_content_plaintext_batch(
      '33333333-3333-4333-8333-333333333333',
      '78000000-0000-4000-8000-000000000010', 'wrong-cursor', 4
    )
  $statement$) ->> 'message',
  'stale_scrub_cursor',
  'a changed request cannot advance from a stale cursor'
);

do $$
declare
  cursor_value text := (
    select value ->> 'cursor' from c5d_values where key = 'first-batch'
  );
  batch_value jsonb;
  batch_count integer := 1;
begin
  loop
    batch_value := public.scrub_content_plaintext_batch(
      '33333333-3333-4333-8333-333333333333',
      '78000000-0000-4000-8000-000000000010', cursor_value, 3
    );
    if (batch_value ->> 'processedCount')::integer > 3 then
      raise exception 'unbounded scrub batch';
    end if;
    batch_count := batch_count + 1;
    cursor_value := batch_value ->> 'cursor';
    exit when (batch_value ->> 'complete')::boolean;
    if batch_count > 20 then raise exception 'scrub failed to converge'; end if;
  end loop;
  insert into c5d_values(key, value) values (
    'last-batch', batch_value || jsonb_build_object('batchCount', batch_count)
  );
end;
$$;

select ok(
  (select (value ->> 'complete')::boolean
    from c5d_values where key = 'last-batch')
    and (select (value ->> 'batchCount')::integer
      from c5d_values where key = 'last-batch') > 1,
  'multiple bounded pages converge on an exact empty rescan'
);

reset role;
select is(
  (
    select private.content_plaintext_scrub_readiness(
      '33333333-3333-4333-8333-333333333333'
    ) ->> 'remainingLegacyRowCount'
  ),
  '0',
  'the exact rescan finds no noncanonical legacy aggregate value'
);
select is(
  (
    select count(*) from public.note_chunks
    where user_id = '33333333-3333-4333-8333-333333333333'
  ),
  0::bigint,
  'legacy plaintext FTS chunks are deleted rather than sentinel indexed'
);
select is(
  (
    select count(*) from public.api_idempotency_records
    where user_id = '33333333-3333-4333-8333-333333333333'
      and replay_policy = 'legacy_nonreplayable'
  ),
  0::bigint,
  'legacy non-replayable idempotency payloads are deleted'
);
select is(
  (
    select count(*)
    from (
      select to_jsonb(space)::text as projection from public.spaces as space
        where space.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(tag)::text from public.tags as tag
        where tag.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(note)::text from public.notes as note
        where note.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(revision)::text
        from public.note_revisions as revision
        where revision.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(decision)::text
        from public.organization_decisions as decision
        where decision.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(mutation)::text
        from public.note_mutations as mutation
        where mutation.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(block)::text
        from public.generated_blocks as block
        where block.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(review)::text from public.review_items as review
        where review.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(rule)::text from public.routing_rules as rule
        where rule.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(attempt)::text
        from public.organization_mutation_attempts as attempt
        where attempt.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(record)::text
        from public.api_idempotency_records as record
        where record.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(receipt)::text
        from public.capture_receipts as receipt
        where receipt.user_id = '33333333-3333-4333-8333-333333333333'
      union all select to_jsonb(capture)::text from public.captures as capture
        where capture.user_id = '33333333-3333-4333-8333-333333333333'
    ) as all_surfaces
    where position('C5D_CANARY' in all_surfaces.projection) > 0
  ),
  0::bigint,
  'the plaintext canary is absent from every legacy aggregate projection'
);

-- Completion must be current, not merely based on the prior empty page.
update public.organization_jobs set state = 'created', completed_at = null
where id = 'job_78000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error(format(
    'select public.complete_content_plaintext_scrub(%L,%L,%L)',
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010',
    (select value ->> 'cursor' from c5d_values where key = 'last-batch')
  )) ->> 'message',
  'plaintext_scrub_incomplete',
  'completion fails closed while organizer work is in flight'
);
reset role;
update public.organization_jobs set state = 'succeeded', completed_at = now()
where id = 'job_78000000000000000000000001';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into c5d_values(key, value)
select 'completion', public.complete_content_plaintext_scrub(
  '33333333-3333-4333-8333-333333333333',
  '78000000-0000-4000-8000-000000000010',
  (select value ->> 'cursor' from c5d_values where key = 'last-batch')
);
select is(
  (select value ->> 'replayed' from c5d_values where key = 'completion'),
  'false',
  'completion persists a fresh exact attestation'
);
select is(
  public.complete_content_plaintext_scrub(
    '33333333-3333-4333-8333-333333333333',
    '78000000-0000-4000-8000-000000000010',
    (select value ->> 'cursor' from c5d_values where key = 'last-batch')
  ) ->> 'replayed',
  'true',
  'completion is replay-safe while the attestation remains current'
);
select is(
  public.advance_content_encryption_rollout(
    '33333333-3333-4333-8333-333333333333',
    'encrypted_read', 'encrypted_only'
  ) ->> 'state',
  'encrypted_only',
  'the owner advances only after scrub, keys, verification, work, and RAG gates'
);
select is(
  public.advance_content_encryption_rollout(
    '33333333-3333-4333-8333-333333333333',
    'encrypted_read', 'encrypted_only'
  ) ->> 'replayed',
  'true',
  'the encrypted_only transition itself is replay-safe'
);

reset role;
select is(
  (
    select state::text from public.content_encryption_rollouts
    where user_id = '33333333-3333-4333-8333-333333333333'
  ),
  'encrypted_only',
  'the durable owner state records the encrypted-only boundary'
);
select ok(
  (
    select plaintext_scrub_started_at is not null
      and plaintext_scrub_completed_at is not null
      and plaintext_scrubbed_row_count > 0
      and plaintext_scrubbed_chunk_count = 1
      and plaintext_scrubbed_idempotency_count = 1
      and plaintext_scrub_attestation_digest ~ '^[0-9a-f]{64}$'
      and last_plaintext_scrub_request_digest ~ '^[0-9a-f]{64}$'
      and last_plaintext_scrub_result_digest ~ '^[0-9a-f]{64}$'
    from public.content_encryption_rollouts
    where user_id = '33333333-3333-4333-8333-333333333333'
  ),
  'bounded scrub counts, cursor protocol digests, and attestation are auditable'
);

select is(
  pg_temp.caught_error($statement$
    insert into public.note_chunks (
      id, note_id, user_id, revision, ordinal, text_hash, content
    ) values (
      'chk_78000000000000000000000002',
      'note_78000000000000000000000001',
      '33333333-3333-4333-8333-333333333333', 1, 0,
      repeat('7', 64), 'plaintext cannot return'
    )
  $statement$) ->> 'message',
  'encrypted_index_required',
  'plaintext note chunks cannot be recreated after cutover'
);

insert into public.spaces (
  id, user_id, name, slug, display_envelope, display_key_id,
  display_key_class, display_key_purpose, display_key_version,
  display_mac, display_mac_key_id, display_mac_key_class,
  display_mac_key_purpose, display_mac_key_version
) values (
  'spc_78000000000000000000000002',
  '33333333-3333-4333-8333-333333333333',
  'C5D_CANARY post cutover', 'c5d-canary-post-cutover',
  pg_temp.content_envelope(
    'spc_78000000000000000000000002',
    '33333333-3333-4333-8333-333333333333', 1, 'space_display',
    'c5d.private.object.v1'
  ),
  'c5d.private.object.v1', 'private_manual', 'object_wrap', 1,
  repeat('8', 64), 'c5d.private.mac.v1', 'private_manual', 'content_mac', 1
);
select is(
  (
    select name from public.spaces
    where id = 'spc_78000000000000000000000002'
  ),
  'e-spc_78000000000000000000000002',
  'encrypted writers remain accepted while their legacy projection is sentinelized'
);

-- Every typed structured-data contract must remain valid after the scrub
-- trigger replaces authored content with its deterministic empty projection.
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data, privacy,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values
(
  'note_78000000000000000000000002',
  '33333333-3333-4333-8333-333333333333', 'list',
  'C5D_TYPED_LIST_TITLE', 'C5D_TYPED_LIST_BODY',
  '{"schemaVersion":1,"items":[{"id":"itm_78000000000000000000000001","text":"C5D_TYPED_LIST_ITEM","checked":false,"ordinal":0,"section":null}]}'::jsonb,
  'private_manual', pg_temp.content_envelope(
    'note_78000000000000000000000002',
    '33333333-3333-4333-8333-333333333333', 1, 'note_content',
    'c5d.private.object.v1', '2'
  ), 'c5d.private.object.v1', 'private_manual', 'object_wrap', 1
),
(
  'note_78000000000000000000000003',
  '33333333-3333-4333-8333-333333333333', 'log',
  'C5D_TYPED_LOG_TITLE', 'C5D_TYPED_LOG_BODY',
  '{"schemaVersion":1,"entries":[{"id":"ent_78000000000000000000000001","occurredAt":"2026-08-31T18:00:00.000+00:00","fields":{"canary":"C5D_TYPED_LOG_FIELD"}}]}'::jsonb,
  'private_manual', pg_temp.content_envelope(
    'note_78000000000000000000000003',
    '33333333-3333-4333-8333-333333333333', 1, 'note_content',
    'c5d.private.object.v1', '3'
  ), 'c5d.private.object.v1', 'private_manual', 'object_wrap', 1
),
(
  'note_78000000000000000000000004',
  '33333333-3333-4333-8333-333333333333', 'project',
  'C5D_TYPED_PROJECT_TITLE', 'C5D_TYPED_PROJECT_BODY',
  '{"schemaVersion":1,"checklistItems":[{"id":"itm_78000000000000000000000002","text":"C5D_TYPED_PROJECT_ITEM","checked":false,"ordinal":0,"lineIndex":0}]}'::jsonb,
  'private_manual', pg_temp.content_envelope(
    'note_78000000000000000000000004',
    '33333333-3333-4333-8333-333333333333', 1, 'note_content',
    'c5d.private.object.v1', '4'
  ), 'c5d.private.object.v1', 'private_manual', 'object_wrap', 1
),
(
  'note_78000000000000000000000005',
  '33333333-3333-4333-8333-333333333333', 'principle',
  'C5D_TYPED_PRINCIPLE_TITLE', 'C5D_TYPED_PRINCIPLE_BODY',
  '{"schemaVersion":1}'::jsonb,
  'private_manual', pg_temp.content_envelope(
    'note_78000000000000000000000005',
    '33333333-3333-4333-8333-333333333333', 1, 'note_content',
    'c5d.private.object.v1', '5'
  ), 'c5d.private.object.v1', 'private_manual', 'object_wrap', 1
);
select ok(
  not exists (
    select 1
    from public.notes as note
    where note.id between 'note_78000000000000000000000002'
        and 'note_78000000000000000000000005'
      and (
        note.title <> 'e-' || lower(note.id)
        or note.body_markdown <> ''
        or note.structured_data <> case note.type
          when 'list' then '{"schemaVersion":1,"items":[]}'::jsonb
          when 'log' then '{"schemaVersion":1,"entries":[]}'::jsonb
          when 'project' then
            '{"schemaVersion":1,"checklistItems":[]}'::jsonb
          else '{"schemaVersion":1}'::jsonb
        end
      )
  ) and (
    select count(*) = 4
    from public.notes as note
    where note.id between 'note_78000000000000000000000002'
        and 'note_78000000000000000000000005'
  ),
  'list, log, project, and plain note constraints accept only type-valid empty sentinels'
);

select ok(
  private.valid_encrypted_only_note_command(
    'apply_encrypted_note_mutation',
    'note_78000000000000000000000002',
    jsonb_build_object(
      'type', 'list', 'privacy', 'private_manual',
      'title', 'e-note_78000000000000000000000002',
      'bodyMarkdown', '',
      'structuredData', '{"schemaVersion":1,"items":[]}'::jsonb
    ),
    jsonb_build_object(
      'operations', '[{"type":"set_privacy","privacy":"private_manual"}]'::jsonb,
      'inverse', '[{"type":"set_privacy","privacy":"private_manual"}]'::jsonb
    )
  ) and not private.valid_encrypted_only_note_command(
    'apply_encrypted_note_mutation',
    'note_78000000000000000000000002',
    jsonb_build_object(
      'type', 'list', 'privacy', 'private_manual',
      'title', 'C5D_PLAINTEXT_COMMAND_CANARY',
      'bodyMarkdown', 'C5D_PLAINTEXT_COMMAND_BODY',
      'structuredData', '{"schemaVersion":1,"items":[]}'::jsonb
    ),
    jsonb_build_object(
      'operations', '[{"type":"set_title","title":"C5D_PLAINTEXT_COMMAND_CANARY"}]'::jsonb,
      'inverse', '[{"type":"set_privacy","privacy":"private_manual"}]'::jsonb
    )
  ),
  'the SQL trust boundary accepts the sentinel and rejects plaintext command canaries'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.prepare_encrypted_note_write(
    '33333333-3333-4333-8333-333333333333',
    'create_encrypted_note', 'c5d-encrypted-only-command-claim',
    null, 0, 'private_manual', jsonb_build_object(
      'keyId', 'c5d.private.mac.v1', 'keyClass', 'private_manual',
      'keyPurpose', 'content_mac', 'keyVersion', 1,
      'mac', repeat('9', 64)
    )
  ) ->> 'commandProjection',
  'encrypted_only',
  'write claims require the content-free command projection after cutover'
);
reset role;

-- An expanded owner remains untouched by the same shared triggers.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '44444444-4444-4444-8444-444444444444',
  'authenticated', 'authenticated', 'c5d-expanded@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id, state)
values ('44444444-4444-4444-8444-444444444444', 'expanded');
insert into public.spaces(id, user_id, name, slug) values (
  'spc_78000000000000000000000003',
  '44444444-4444-4444-8444-444444444444',
  'Mixed owner plaintext', 'mixed-owner-plaintext'
);
select is(
  (
    select name from public.spaces
    where id = 'spc_78000000000000000000000003'
  ),
  'Mixed owner plaintext',
  'expanded owners continue operating without cross-owner sentinelization'
);

select * from finish();
rollback;
