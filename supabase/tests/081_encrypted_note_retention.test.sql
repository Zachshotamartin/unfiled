create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.retention_envelope(
  p_owner_id uuid,
  p_resource_id text,
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
    'version', 1, 'suite', 'A256GCM', 'keyId', p_key_id,
    'context', jsonb_build_object(
      'tenantId', p_owner_id, 'resourceId', p_resource_id,
      'recordVersion', p_record_version, 'kind', p_kind
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16), 'ciphertext', repeat('B', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('C', 16), 'ciphertext', repeat(left(p_seed, 1), 64)
    )
  );
$$;

create function pg_temp.retention_cipher(
  p_owner_id uuid,
  p_capture_id text,
  p_record_version integer,
  p_key_id text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.retention_envelope(
      p_owner_id, p_capture_id, p_record_version,
      'capture_receipt', p_key_id, p_seed
    ),
    'keyId', p_key_id, 'keyClass', 'ai_assisted',
    'keyPurpose', 'object_wrap', 'keyVersion', 1,
    'reservationId', p_reservation_id
  );
$$;

create function pg_temp.retention_mac(p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', 'retention.ai.mac.v1', 'keyClass', 'ai_assisted',
    'keyPurpose', 'content_mac', 'keyVersion', 1
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

create temporary table retention_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on retention_values to service_role;

select has_table(
  'public', 'encrypted_note_retention_runs',
  'retention runs persist one bounded, replayable lease'
);
select has_table(
  'public', 'encrypted_note_retention_claims',
  'retention claims persist exact content-free CAS state'
);
select has_function(
  'public', 'claim_encrypted_note_retention',
  array['uuid', 'uuid', 'uuid', 'timestamp with time zone',
    'integer', 'boolean', 'integer'],
  'encrypted retention claim has one exact bounded signature'
);
select has_function(
  'public', 'cancel_encrypted_note_retention_claim',
  array['uuid', 'uuid', 'uuid', 'uuid'],
  'encrypted retention cancellation has one exact capability signature'
);
select has_function(
  'public', 'commit_encrypted_note_retention',
  array['uuid', 'uuid', 'uuid', 'uuid', 'jsonb'],
  'encrypted retention commit has one authenticated command signature'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_encrypted_note_retention(uuid,uuid,uuid,timestamptz,integer,boolean,integer)',
    'EXECUTE'
  ) and has_function_privilege(
    'service_role',
    'public.cancel_encrypted_note_retention_claim(uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ) and has_function_privilege(
    'service_role',
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.claim_encrypted_note_retention(uuid,uuid,uuid,timestamptz,integer,boolean,integer)',
    'EXECUTE'
  ),
  'only service_role receives the encrypted retention capabilities'
);
select ok(
  not has_table_privilege(
    'service_role', 'public.encrypted_note_retention_runs', 'SELECT'
  ) and not has_table_privilege(
    'service_role', 'public.encrypted_note_retention_claims', 'SELECT'
  ),
  'service workers cannot bypass the retention protocol tables'
);
select ok(
  not exists (
    select 1 from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private'
      and procedure.proname = any(array[
        'encrypted_note_retention_snapshot',
        'encrypted_note_retention_claim_projection',
        'consume_encrypted_note_retention_reservations'
      ])
      and (
        has_function_privilege('public', procedure.oid, 'EXECUTE')
        or has_function_privilege('anon', procedure.oid, 'EXECUTE')
        or has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
        or has_function_privilege('service_role', procedure.oid, 'EXECUTE')
        or has_function_privilege('unfiled_index_worker', procedure.oid, 'EXECUTE')
        or has_function_privilege('unfiled_rag_verifier', procedure.oid, 'EXECUTE')
        or has_function_privilege('unfiled_organizer_worker', procedure.oid, 'EXECUTE')
      )
  ),
  'retention projection and reservation helpers stay private'
);
select ok(
  strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'content-encryption-rollout')
  < strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'unfiled.rag-generation-control.v1:')
  and strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'unfiled.rag-generation-control.v1:')
  < strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'for update of job'),
  'commit takes rollout and RAG-control advisories before workflow row locks'
);
select ok(
  strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'for update of job')
  < strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'for update of capture')
  and strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'for update of capture')
  < strpos(pg_get_functiondef(
    'public.commit_encrypted_note_retention(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ), 'for update of note'),
  'commit preserves sorted job -> capture -> note workflow order'
);
select ok(
  pg_get_functiondef(
    'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure
  ) like '%encrypted_retention_required%'
  and strpos(pg_get_functiondef(
    'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure
  ), 'retention_rollout') > 0
  and strpos(pg_get_functiondef(
    'public.purge_expired_deleted_notes(uuid,timestamptz,integer,boolean)'::regprocedure
  ), 'contracted') > 0,
  'the legacy SQL rewrite rejects explicit encrypted owners and filters global batches'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '81818181-8181-4181-8181-818181818181',
  'authenticated', 'authenticated', 'retention-encrypted@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id)
values ('81818181-8181-4181-8181-818181818181');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  ('81818181-8181-4181-8181-818181818181', 'retention.ai.object.v1',
    'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/81000000-0000-4000-8000-000000000001',
    decode(repeat('11', 32), 'hex'), 'active', now()),
  ('81818181-8181-4181-8181-818181818181', 'retention.ai.mac.v1',
    'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/81000000-0000-4000-8000-000000000002',
    decode(repeat('12', 32), 'hex'), 'active', now()),
  ('81818181-8181-4181-8181-818181818181', 'retention.private.object.v1',
    'private_manual', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/81000000-0000-4000-8000-000000000003',
    decode(repeat('13', 32), 'hex'), 'active', now()),
  ('81818181-8181-4181-8181-818181818181', 'retention.private.mac.v1',
    'private_manual', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/81000000-0000-4000-8000-000000000004',
    decode(repeat('14', 32), 'hex'), 'active', now());

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy, deleted_at, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values
  ('note_81000000000000000000000001',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'expired main', 'never returned by retention SQL', '{}', 1,
    'ai_assisted', '2026-07-01T00:00:00Z',
    '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000001', 1, 'note_content',
      'retention.ai.object.v1', 'N'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1),
  ('note_81000000000000000000000002',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'expired cancel', 'cancelled work remains recoverable', '{}', 1,
    'ai_assisted', '2026-07-02T00:00:00Z',
    '2026-06-02T00:00:00Z', '2026-07-02T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000002', 1, 'note_content',
      'retention.ai.object.v1', 'O'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1),
  ('note_81000000000000000000000003',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'expired stale', 'fetch commit races fail closed', '{}', 1,
    'ai_assisted', '2026-07-03T00:00:00Z',
    '2026-06-03T00:00:00Z', '2026-07-03T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000003', 1, 'note_content',
      'retention.ai.object.v1', 'P'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1),
  ('note_81000000000000000000000004',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'expired rag', 'leased index work is fenced and burned', '{}', 1,
    'ai_assisted', '2026-07-04T00:00:00Z',
    '2026-06-04T00:00:00Z', '2026-07-04T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000004', 1, 'note_content',
      'retention.ai.object.v1', 'Q'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1),
  ('note_81000000000000000000000005',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'live review destination', 'operational relation only', '{}', 1,
    'ai_assisted', null,
    '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000005', 1, 'note_content',
      'retention.ai.object.v1', 'R'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1);

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, privacy, deleted_at, created_at, updated_at,
  content_envelope, content_key_id, content_key_class,
  content_key_purpose, content_key_version
) values
  ('note_81000000000000000000000006',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'expired multi primary', 'must leave the next receipt projection', '{}', 2,
    'ai_assisted', '2026-07-06T00:00:00Z',
    '2026-06-06T00:00:00Z', '2026-07-06T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000006', 2, 'note_content',
      'retention.ai.object.v1', 'S'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1),
  ('note_81000000000000000000000007',
    '81818181-8181-4181-8181-818181818181', 'generic',
    'multi sibling', 'survives the first purge', '{}', 4,
    'ai_assisted', null,
    '2026-06-07T00:00:00Z', '2026-08-07T00:00:00Z',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'note_81000000000000000000000007', 4, 'note_content',
      'retention.ai.object.v1', 'T'
    ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1);

insert into public.captures (
  id, user_id, source, raw_text, privacy, explicit_destination_note_id,
  client_created_at, client_timezone, received_at, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose, content_key_version,
  fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values
  ('cap_81000000000000000000000001',
    '81818181-8181-4181-8181-818181818181', 'web', '[encrypted]',
    'ai_assisted', 'note_81000000000000000000000001',
    '2026-07-01T00:00:00Z', 'UTC', '2026-07-01T00:00:00Z', 'organized',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'cap_81000000000000000000000001', 1, 'capture',
      'retention.ai.object.v1', 'A'
    ), repeat('a', 64), 32,
    'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'retention.ai.mac.v1', 'ai_assisted', 'content_mac', 1),
  ('cap_81000000000000000000000003',
    '81818181-8181-4181-8181-818181818181', 'web', '[encrypted]',
    'ai_assisted', 'note_81000000000000000000000003',
    '2026-07-03T00:00:00Z', 'UTC', '2026-07-03T00:00:00Z', 'organized',
    pg_temp.retention_envelope(
      '81818181-8181-4181-8181-818181818181',
      'cap_81000000000000000000000003', 1, 'capture',
      'retention.ai.object.v1', 'B'
    ), repeat('b', 64), 32,
    'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'retention.ai.mac.v1', 'ai_assisted', 'content_mac', 1);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version,
  completed_at, created_at
) values
  ('job_81000000000000000000000001',
    'cap_81000000000000000000000001',
    '81818181-8181-4181-8181-818181818181', 'succeeded',
    'retention-test', 1, '2026-07-01T00:01:00Z', '2026-07-01T00:00:00Z'),
  ('job_81000000000000000000000003',
    'cap_81000000000000000000000003',
    '81818181-8181-4181-8181-818181818181', 'succeeded',
    'retention-test', 1, '2026-07-03T00:01:00Z', '2026-07-03T00:00:00Z');
insert into public.capture_receipts (
  capture_id, job_id, user_id, outcome, headline, inserted_content,
  actions, reason_codes, receipt_envelope, receipt_key_id,
  receipt_key_class, receipt_key_purpose, receipt_key_version,
  receipt_revision, created_at
) values (
  'cap_81000000000000000000000001',
  'job_81000000000000000000000001',
  '81818181-8181-4181-8181-818181818181', 'kept_in_inbox',
  'Original encrypted headline', '[]', '[]', array['retained'],
  pg_temp.retention_envelope(
    '81818181-8181-4181-8181-818181818181',
    'cap_81000000000000000000000001', 1, 'capture_receipt',
    'retention.ai.object.v1', 'C'
  ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
  '2026-07-01T00:01:00Z'
);

insert into public.captures (
  id, user_id, source, raw_text, privacy, explicit_destination_note_id,
  client_created_at, client_timezone, received_at, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose, content_key_version,
  fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_81000000000000000000000006',
  '81818181-8181-4181-8181-818181818181', 'web', '[encrypted]',
  'ai_assisted', 'note_81000000000000000000000006',
  '2026-07-06T00:00:00Z', 'UTC', '2026-07-06T00:00:00Z', 'organized',
  pg_temp.retention_envelope(
    '81818181-8181-4181-8181-818181818181',
    'cap_81000000000000000000000006', 1, 'capture',
    'retention.ai.object.v1', 'U'
  ), repeat('c', 64), 32,
  'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'retention.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version,
  completed_at, created_at
) values (
  'job_81000000000000000000000006',
  'cap_81000000000000000000000006',
  '81818181-8181-4181-8181-818181818181', 'succeeded',
  'retention-test', 2, '2026-07-06T00:01:00Z', '2026-07-06T00:00:00Z'
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, created_at,
  decision_content_revision, decision_envelope, decision_key_id,
  decision_key_class, decision_key_purpose, decision_key_version
) values (
  'dec_81000000000000000000000006',
  'cap_81000000000000000000000006',
  '81818181-8181-4181-8181-818181818181', '{}', '{}', null,
  'auto', 'note_81000000000000000000000006',
  array['multi_note'], '2026-07-06T00:01:00Z', 1,
  pg_temp.retention_envelope(
    '81818181-8181-4181-8181-818181818181',
    'dec_81000000000000000000000006', 1, 'organization_decision',
    'retention.ai.object.v1', 'Y'
  ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key,
  before_revision, after_revision, operations, inverse, created_at
) values
  ('mut_81000000000000000000000006',
    '81818181-8181-4181-8181-818181818181',
    'dec_81000000000000000000000006',
    'note_81000000000000000000000006', 'retention-multi-primary',
    1, 2, '[]', '{}', '2026-07-06T00:01:00Z'),
  ('mut_81000000000000000000000007',
    '81818181-8181-4181-8181-818181818181',
    'dec_81000000000000000000000006',
    'note_81000000000000000000000007', 'retention-multi-sibling',
    3, 4, '[]', '{}', '2026-07-06T00:01:00Z');
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation, inserted_item_ids,
  created_at
) values
  ('cap_81000000000000000000000006',
    'note_81000000000000000000000006',
    '81818181-8181-4181-8181-818181818181',
    'mut_81000000000000000000000006', 'routed', '{}',
    '2026-07-06T00:01:00Z'),
  ('cap_81000000000000000000000006',
    'note_81000000000000000000000007',
    '81818181-8181-4181-8181-818181818181',
    'mut_81000000000000000000000007', 'routed', '{}',
    '2026-07-06T00:01:00Z');
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, outcome, headline,
  destination_note_id, inserted_content, actions, reason_codes,
  receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version, receipt_revision, created_at
) values (
  'cap_81000000000000000000000006',
  'job_81000000000000000000000006',
  '81818181-8181-4181-8181-818181818181',
  'dec_81000000000000000000000006',
  'mut_81000000000000000000000006', 'added_to_note',
  'Updated two encrypted notes', 'note_81000000000000000000000006',
  jsonb_build_array(jsonb_build_object(
    'mutationId', 'mut_81000000000000000000000006'
  )),
  jsonb_build_array(jsonb_build_object(
    'type', 'undo', 'mutationId', 'mut_81000000000000000000000006',
    'expectedRevision', 2
  )), array['multi_note'],
  pg_temp.retention_envelope(
    '81818181-8181-4181-8181-818181818181',
    'cap_81000000000000000000000006', 1, 'capture_receipt',
    'retention.ai.object.v1', 'V'
  ), 'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
  '2026-07-06T00:01:00Z'
);

insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices, state, created_at
) values (
  'rvw_81000000000000000000000001',
  '81818181-8181-4181-8181-818181818181',
  'cap_81000000000000000000000003',
  'note_81000000000000000000000005',
  'low_confidence', '[]', 'open', '2026-07-03T00:02:00Z'
);

insert into public.rag_index_generations (
  id, user_id, embedding_model_id, embedding_dimensions,
  state, expected_note_count, indexed_note_count, revision_token, activated_at
) values
(
  'igen_81000000000000000000000001',
  '81818181-8181-4181-8181-818181818181', 'retention-model', 1536,
  'building', 1, 0, 7, null
),
(
  'igen_81000000000000000000000002',
  '81818181-8181-4181-8181-818181818181', 'retention-model', 1536,
  'active', 1, 1, 11, '2026-06-01T00:00:00Z'
);
insert into public.content_key_operation_reservations (
  user_id, reservation_id, key_id, key_class, key_purpose,
  key_version, operation_count
) values (
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000020',
  'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1
);
-- Model a stale lease that won a race before deletion invalidation. The
-- production target guard prevents constructing this state directly, while
-- retention still defends against it before the note cascade.
set local session_replication_role = replica;
insert into public.note_rag_index (
  id, user_id, note_id, generation_id, indexed_revision, index_envelope,
  index_key_id, index_key_class, index_key_purpose, index_key_version,
  encrypted_byte_length
) values (
  'irw_81000000000000000000000002',
  '81818181-8181-4181-8181-818181818181',
  'note_81000000000000000000000004',
  'igen_81000000000000000000000002', 1,
  pg_temp.retention_envelope(
    '81818181-8181-4181-8181-818181818181',
    'irw_81000000000000000000000002', 1, 'note_rag_index',
    'retention.ai.object.v1', 'I'
  ),
  'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 48
);
insert into public.note_index_jobs (
  id, user_id, note_id, generation_id, target_revision, index_resource_id,
  state, attempt, available_at, lease_owner, lease_token,
  lease_expires_at, last_heartbeat_at,
  target_reservation_id, target_key_id, target_key_class,
  target_key_purpose, target_key_version, target_reservation_attempt,
  target_reservation_lease_token
) values (
  'ijob_81000000000000000000000001',
  '81818181-8181-4181-8181-818181818181',
  'note_81000000000000000000000004',
  'igen_81000000000000000000000001', 1,
  'irw_81000000000000000000000001', 'leased', 1,
  '2026-07-04T00:00:00Z', 'retention-index-worker',
  '81000000-0000-4000-8000-000000000021',
  '2026-09-01T00:00:00Z', '2026-08-31T00:00:00Z',
  '81000000-0000-4000-8000-000000000020',
  'retention.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
  '81000000-0000-4000-8000-000000000021'
);
set local session_replication_role = origin;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.advance_content_encryption_rollout(
    '81818181-8181-4181-8181-818181818181', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the fixture owner enters encrypted write mode'
);

insert into retention_values(key, value) values (
  'dry-run', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000030',
    '81000000-0000-4000-8000-000000000031',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, false, 300
  )
);
reset role;
select ok(
  (select value ->> 'executed' = 'false'
    and value ->> 'eligibleCount' = '1'
    and value ->> 'claimedCount' = '0'
    from retention_values where key = 'dry-run')
  and not exists (
    select 1 from public.encrypted_note_retention_runs
    where run_id = '81000000-0000-4000-8000-000000000030'
  ),
  'dry-run is bounded, reports eligibility, and writes no claim state'
);
select is(
  pg_temp.caught_error($sql$
    select public.purge_expired_deleted_notes(
      '81818181-8181-4181-8181-818181818181',
      '2026-08-31T00:00:00Z', 1, true
    )
  $sql$) ->> 'message',
  'encrypted_retention_required',
  'legacy plaintext retention fails closed for an explicit encrypted owner'
);
select is(
  (select count(*)::integer from private.note_retention_capture_ids(
    'note_81000000000000000000000005'
  ) where capture_id = 'cap_81000000000000000000000003'),
  1,
  'operational review links keep capture discovery complete after actions scrub'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'main-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000040',
    '81000000-0000-4000-8000-000000000041',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
select public.reserve_content_key_operations(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000042', 'ai_assisted',
  'retention.ai.object.v1', 1, 1
);
insert into retention_values(key, value)
select 'main-commit', public.commit_encrypted_note_retention(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000040',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000041',
  jsonb_build_object(
    'contextDigest', value #>> '{claims,0,contextDigest}',
    'receipts', jsonb_build_array(jsonb_build_object(
      'captureId', 'cap_81000000000000000000000001',
      'recordVersion', 2,
      'receiptCipher', pg_temp.retention_cipher(
        '81818181-8181-4181-8181-818181818181',
        'cap_81000000000000000000000001', 2,
        'retention.ai.object.v1',
        '81000000-0000-4000-8000-000000000042', 'Z'
      ),
      'verificationMac', pg_temp.retention_mac('main-verification'),
      'projection', jsonb_build_object('mode', 'inbox', 'primary', null)
    ))
  )
) from retention_values where key = 'main-claim';
reset role;

select ok(
  not exists (
    select 1 from public.notes
    where id = 'note_81000000000000000000000001'
  ) and exists (
    select 1 from public.capture_receipts
    where capture_id = 'cap_81000000000000000000000001'
      and receipt_revision = 2
      and outcome = 'kept_in_inbox'
      and destination_note_id is null
      and mutation_id is null and review_item_id is null
      and 'destination_expired' = any(reason_codes)
      and receipt_envelope -> 'context' ->> 'recordVersion' = '2'
  ),
  'authenticated ciphertext commit reseals the receipt and purges atomically'
);
select ok(
  exists (
    select 1 from public.content_key_operation_reservations
    where reservation_id = '81000000-0000-4000-8000-000000000042'
      and consumed_by_type = 'encrypted_note_retention'
      and consumed_at is not null
  ) and exists (
    select 1 from public.content_encryption_verifications
    where user_id = '81818181-8181-4181-8181-818181818181'
      and surface = 'capture_receipt'
      and resource_id = 'cap_81000000000000000000000001'
      and record_version = 2
  ),
  'commit consumes the exact reservation and records current verification'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value)
select 'main-replay', public.commit_encrypted_note_retention(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000040',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000041',
  jsonb_build_object(
    'contextDigest', value #>> '{claims,0,contextDigest}',
    'receipts', jsonb_build_array(jsonb_build_object(
      'captureId', 'cap_81000000000000000000000001',
      'recordVersion', 2,
      'receiptCipher', pg_temp.retention_cipher(
        '81818181-8181-4181-8181-818181818181',
        'cap_81000000000000000000000001', 2,
        'retention.ai.object.v1',
        '81000000-0000-4000-8000-000000000042', 'Z'
      ),
      'verificationMac', pg_temp.retention_mac('main-verification'),
      'projection', jsonb_build_object('mode', 'inbox', 'primary', null)
    ))
  )
) from retention_values where key = 'main-claim';
reset role;
select is(
  (select value ->> 'replayed' from retention_values where key = 'main-replay'),
  'true',
  'an exact committed command is replay-safe after the note is gone'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'cancel-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000050',
    '81000000-0000-4000-8000-000000000051',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
insert into retention_values(key, value)
select 'cancelled', public.cancel_encrypted_note_retention_claim(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000050',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000051'
) from retention_values where key = 'cancel-claim';
reset role;
select is(
  pg_temp.caught_error(format(
    'select public.commit_encrypted_note_retention(%L,%L,%L,%L,%L::jsonb)',
    '81818181-8181-4181-8181-818181818181',
    '81000000-0000-4000-8000-000000000050',
    (select value #>> '{claims,0,claimId}' from retention_values
      where key = 'cancel-claim'),
    '81000000-0000-4000-8000-000000000051',
    jsonb_build_object(
      'contextDigest', (select value #>> '{claims,0,contextDigest}'
        from retention_values where key = 'cancel-claim'),
      'receipts', '[]'::jsonb
    )::text
  )) ->> 'sqlstate',
  '42501',
  'a cancelled/non-active run can never commit even before lease expiry'
);
delete from public.notes where id = 'note_81000000000000000000000002';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'stale-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000060',
    '81000000-0000-4000-8000-000000000061',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
reset role;
update public.captures set status = 'inbox'
where id = 'cap_81000000000000000000000003';
select is(
  pg_temp.caught_error(format(
    'select public.commit_encrypted_note_retention(%L,%L,%L,%L,%L::jsonb)',
    '81818181-8181-4181-8181-818181818181',
    '81000000-0000-4000-8000-000000000060',
    (select value #>> '{claims,0,claimId}' from retention_values
      where key = 'stale-claim'),
    '81000000-0000-4000-8000-000000000061',
    jsonb_build_object(
      'contextDigest', (select value #>> '{claims,0,contextDigest}'
        from retention_values where key = 'stale-claim'),
      'receipts', '[]'::jsonb
    )::text
  )) ->> 'message',
  'stale_revision',
  'exact snapshot CAS catches a receipt-fetch/content-row race before purge'
);
select ok(
  exists (select 1 from public.notes
    where id = 'note_81000000000000000000000003'),
  'a stale commit leaves the soft-deleted note intact'
);
delete from public.notes where id = 'note_81000000000000000000000003';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'rag-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000070',
    '81000000-0000-4000-8000-000000000071',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
insert into retention_values(key, value)
select 'rag-commit', public.commit_encrypted_note_retention(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000070',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000071',
  jsonb_build_object(
    'contextDigest', value #>> '{claims,0,contextDigest}',
    'receipts', '[]'::jsonb
  )
) from retention_values where key = 'rag-claim';
reset role;
select ok(
  not exists (select 1 from public.notes
    where id = 'note_81000000000000000000000004')
  and not exists (select 1 from public.note_index_jobs
    where id = 'ijob_81000000000000000000000001')
  and not exists (select 1 from public.note_rag_index
    where id = 'irw_81000000000000000000000002')
  and exists (
    select 1 from public.content_key_operation_reservations
    where reservation_id = '81000000-0000-4000-8000-000000000020'
      and consumed_by_type = 'note_rag_index'
      and consumed_at is not null
  ),
  'retention fences a leased index job and burns its reservation before cascade'
);
select ok(
  exists (
    select 1 from public.rag_index_generations
    where id = 'igen_81000000000000000000000001'
      and expected_note_count = 2
      and indexed_note_count = 0
      and revision_token = 8
  ) and exists (
    select 1 from public.rag_index_generations
    where id = 'igen_81000000000000000000000002'
      and expected_note_count = 2
      and indexed_note_count = 0
      and revision_token = 12
  ),
  'job and index-only generation counters are recomputed and attestations invalidated'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'multi-primary-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000080',
    '81000000-0000-4000-8000-000000000081',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
select public.reserve_content_key_operations(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000082', 'ai_assisted',
  'retention.ai.object.v1', 1, 1
);
insert into retention_values(key, value)
select 'multi-primary-commit', public.commit_encrypted_note_retention(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000080',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000081',
  jsonb_build_object(
    'contextDigest', value #>> '{claims,0,contextDigest}',
    'receipts', jsonb_build_array(jsonb_build_object(
      'captureId', 'cap_81000000000000000000000006',
      'recordVersion', 2,
      'receiptCipher', pg_temp.retention_cipher(
        '81818181-8181-4181-8181-818181818181',
        'cap_81000000000000000000000006', 2,
        'retention.ai.object.v1',
        '81000000-0000-4000-8000-000000000082', 'W'
      ),
      'verificationMac', pg_temp.retention_mac('multi-primary'),
      'projection', jsonb_build_object(
        'mode', 'routed',
        'primary', jsonb_build_object(
          'noteId', 'note_81000000000000000000000007',
          'mutationId', 'mut_81000000000000000000000007',
          'expectedRevision', 4,
          'noteRecordVersion', 4
        )
      )
    ))
  )
) from retention_values where key = 'multi-primary-claim';
reset role;
select ok(
  not exists (select 1 from public.notes
    where id = 'note_81000000000000000000000006')
  and exists (select 1 from public.notes
    where id = 'note_81000000000000000000000007')
  and exists (
    select 1 from public.capture_receipts
    where capture_id = 'cap_81000000000000000000000006'
      and receipt_revision = 2
      and outcome = 'added_to_note'
      and destination_note_id = 'note_81000000000000000000000007'
      and mutation_id = 'mut_81000000000000000000000007'
  ) and exists (
    select 1 from public.organization_decisions
    where id = 'dec_81000000000000000000000006'
      and destination_note_id = 'note_81000000000000000000000007'
  ) and exists (
    select 1 from public.captures
    where id = 'cap_81000000000000000000000006'
      and status = 'organized'
      and explicit_destination_note_id is null
  ) and not exists (
    select 1 from public.capture_note_links
    where capture_id = 'cap_81000000000000000000000006'
      and note_id = 'note_81000000000000000000000006'
  ) and exists (
    select 1 from public.capture_note_links
    where capture_id = 'cap_81000000000000000000000006'
      and note_id = 'note_81000000000000000000000007'
  ),
  'partial reconciliation purges one target while preserving the live sibling route'
);

update public.notes
set deleted_at = '2026-07-07T00:00:00Z'
where id = 'note_81000000000000000000000007';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retention_values(key, value) values (
  'multi-last-claim', public.claim_encrypted_note_retention(
    '81000000-0000-4000-8000-000000000090',
    '81000000-0000-4000-8000-000000000091',
    '81818181-8181-4181-8181-818181818181',
    '2026-08-31T00:00:00Z', 1, true, 300
  )
);
select public.reserve_content_key_operations(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000092', 'ai_assisted',
  'retention.ai.object.v1', 1, 1
);
insert into retention_values(key, value)
select 'multi-last-commit', public.commit_encrypted_note_retention(
  '81818181-8181-4181-8181-818181818181',
  '81000000-0000-4000-8000-000000000090',
  (value #>> '{claims,0,claimId}')::uuid,
  '81000000-0000-4000-8000-000000000091',
  jsonb_build_object(
    'contextDigest', value #>> '{claims,0,contextDigest}',
    'receipts', jsonb_build_array(jsonb_build_object(
      'captureId', 'cap_81000000000000000000000006',
      'recordVersion', 3,
      'receiptCipher', pg_temp.retention_cipher(
        '81818181-8181-4181-8181-818181818181',
        'cap_81000000000000000000000006', 3,
        'retention.ai.object.v1',
        '81000000-0000-4000-8000-000000000092', 'X'
      ),
      'verificationMac', pg_temp.retention_mac('multi-last'),
      'projection', jsonb_build_object('mode', 'inbox', 'primary', null)
    ))
  )
) from retention_values where key = 'multi-last-claim';
reset role;
select ok(
  not exists (select 1 from public.notes
    where id = 'note_81000000000000000000000007')
  and not exists (select 1 from public.capture_note_links
    where capture_id = 'cap_81000000000000000000000006')
  and exists (
    select 1 from public.capture_receipts
    where capture_id = 'cap_81000000000000000000000006'
      and receipt_revision = 3
      and outcome = 'kept_in_inbox'
      and destination_note_id is null
      and mutation_id is null
      and inserted_content = '[]'::jsonb
      and actions = '[]'::jsonb
  ) and exists (
    select 1 from public.captures
    where id = 'cap_81000000000000000000000006'
      and status = 'inbox'
  ),
  'sequential all-expired reconciliation converges to an empty non-routed receipt'
);

select * from finish();
rollback;
