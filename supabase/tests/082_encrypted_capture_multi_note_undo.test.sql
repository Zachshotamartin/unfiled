create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

create function pg_temp.undo_envelope(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'c5d.undo.ai.object.v1',
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

create function pg_temp.undo_stored_cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.undo_envelope(
      p_resource_id, p_owner_id, p_record_version, p_kind, p_seed
    ),
    'keyId', 'c5d.undo.ai.object.v1',
    'keyClass', 'ai_assisted',
    'keyPurpose', 'object_wrap',
    'keyVersion', 1
  );
$$;

create function pg_temp.undo_cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_reservation_id uuid,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select pg_temp.undo_stored_cipher(
    p_resource_id, p_owner_id, p_record_version, p_kind, p_seed
  ) || jsonb_build_object('reservationId', p_reservation_id::text);
$$;

create function pg_temp.undo_mac(p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', 'c5d.undo.ai.mac.v1',
    'keyClass', 'ai_assisted',
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.undo_time()
returns text
language sql
volatile
as $$
  select to_char(
    date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
$$;

create function pg_temp.undo_write(
  p_note_id text,
  p_target_mutation_id text,
  p_revision_id text,
  p_mutation_id text,
  p_note_reservation uuid,
  p_revision_reservation uuid,
  p_mutation_reservation uuid,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'noteId', p_note_id,
    'targetMutationId', p_target_mutation_id,
    'expectedRevision', 2,
    'sourcePrivacy', 'ai_assisted',
    'expectedCurrentCipher', pg_temp.undo_stored_cipher(
      p_note_id, '55555555-5555-4555-8555-555555555555', 2,
      'note_content', p_seed || 'C'
    ),
    'expectedMutationCipher', pg_temp.undo_stored_cipher(
      p_target_mutation_id, '55555555-5555-4555-8555-555555555555', 2,
      'note_mutation', p_seed || 'M'
    ),
    'noteState', jsonb_build_object(
      'spaceId', null,
      'type', 'generic',
      'title', 'e-' || lower(p_note_id),
      'bodyMarkdown', '',
      'structuredData', jsonb_build_object('schemaVersion', 1),
      'dailyDate', null,
      'isOpen', true,
      'privacy', 'ai_assisted',
      'pinnedAt', null,
      'archivedAt', null,
      'deletedAt', null,
      'tagIds', '[]'::jsonb,
      'links', '[]'::jsonb
    ),
    'noteCipher', pg_temp.undo_cipher(
      p_note_id, '55555555-5555-4555-8555-555555555555', 3,
      'note_content', p_note_reservation, p_seed || 'N'
    ),
    'revision', jsonb_build_object(
      'id', p_revision_id,
      'source', 'undo',
      'actor', 'manual:capture-undo-test',
      'cipher', pg_temp.undo_cipher(
        p_revision_id, '55555555-5555-4555-8555-555555555555', 3,
        'note_revision', p_revision_reservation, p_seed || 'R'
      ),
      'mac', pg_temp.undo_mac(p_seed || '-revision')
    ),
    'mutation', jsonb_build_object(
      'id', p_mutation_id,
      'decisionId', null,
      'undoTargetMutationId', p_target_mutation_id,
      'operations', jsonb_build_array(jsonb_build_object(
        'type', 'set_privacy', 'privacy', 'ai_assisted'
      )),
      'inverse', jsonb_build_array(jsonb_build_object(
        'type', 'set_privacy', 'privacy', 'ai_assisted'
      )),
      'cipher', pg_temp.undo_cipher(
        p_mutation_id, '55555555-5555-4555-8555-555555555555', 3,
        'note_mutation', p_mutation_reservation, p_seed || 'U'
      )
    ),
    'verification', jsonb_build_object(
      'noteContent', pg_temp.undo_mac(p_seed || '-note-proof'),
      'noteMutation', pg_temp.undo_mac(p_seed || '-mutation-proof')
    )
  );
$$;

create temporary table capture_undo_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on capture_undo_values to service_role;

select has_function(
  'public', 'delete_encrypted_capture_with_undo',
  array['uuid', 'text', 'text', 'jsonb'],
  'multi-note encrypted capture undo has one exact public signature'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'authenticated',
      'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.delete_encrypted_capture_with_undo(uuid,text,text,jsonb)',
      'EXECUTE'
    ),
  'only service_role can invoke the atomic undo capability'
);
select ok(
  not exists (
    select 1
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name in (
        'encrypted_capture_undo_cipher_values',
        'consume_replayed_capture_command_reservation'
      )
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_index_worker', 'unfiled_rag_verifier',
        'unfiled_organizer_worker'
      )
  ),
  'undo reservation and validation helpers remain private'
);
select ok(
  position(':encrypted-note-write:' in pg_get_functiondef(procedure.oid))
      < position(':content-encryption-rollout' in pg_get_functiondef(procedure.oid))
    and position(':content-encryption-rollout' in pg_get_functiondef(procedure.oid))
      < position('lock_encrypted_capture_command_replay' in pg_get_functiondef(procedure.oid)),
  'idempotency and rollout advisories precede every replay-row lock'
)
from pg_proc as procedure
join pg_namespace as namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = 'delete_encrypted_capture_with_undo'
  and procedure.proargtypes = '2950 25 25 3802'::oidvector;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '55555555-5555-4555-8555-555555555555',
  'authenticated', 'authenticated', 'capture-undo@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id, state)
values ('55555555-5555-4555-8555-555555555555', 'encrypted_only');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/82000000-0000-4000-8000-000000000001',
    decode(repeat('21', 32), 'hex'), 'active', now()
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.undo.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/82000000-0000-4000-8000-000000000002',
    decode(repeat('22', 32), 'hex'), 'active', now()
  );

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, is_open, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values
  (
    'note_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555', 'generic', 'routed one',
    'routed body one', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.undo_envelope(
      'note_82000000000000000000000001',
      '55555555-5555-4555-8555-555555555555', 2, 'note_content', '1C'
    ),
    'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_82000000000000000000000002',
    '55555555-5555-4555-8555-555555555555', 'generic', 'routed two',
    'routed body two', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.undo_envelope(
      'note_82000000000000000000000002',
      '55555555-5555-4555-8555-555555555555', 2, 'note_content', '2C'
    ),
    'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_82000000000000000000000001',
  '55555555-5555-4555-8555-555555555555', 'web', 'capture-undo-test',
  'top secret capture', 'ai_assisted', now(), 'UTC', 'organized',
  pg_temp.undo_envelope(
    'cap_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555', 1, 'capture', 'C'
  ),
  (pg_temp.undo_mac('capture-content') ->> 'mac'), 18,
  'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'c5d.undo.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version,
  completed_at
) values (
  'job_82000000000000000000000001',
  'cap_82000000000000000000000001',
  '55555555-5555-4555-8555-555555555555', 'succeeded',
  'capture-undo-test', 1, now()
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, decision_envelope,
  decision_key_id, decision_key_class, decision_key_purpose,
  decision_key_version
) values (
  'dec_82000000000000000000000001',
  'cap_82000000000000000000000001',
  '55555555-5555-4555-8555-555555555555', '{}'::jsonb, '{}'::jsonb,
  null, 'auto', 'note_82000000000000000000000001',
  array['explicit_destination'],
  pg_temp.undo_envelope(
    'dec_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555', 1,
    'organization_decision', 'D'
  ),
  'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key,
  before_revision, after_revision, operations, inverse,
  mutation_envelope, mutation_key_id, mutation_key_class,
  mutation_key_purpose, mutation_key_version
) values
  (
    'mut_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555',
    'dec_82000000000000000000000001',
    'note_82000000000000000000000001', 'fixture-route-one', 1, 2,
    jsonb_build_array(jsonb_build_object(
      'type', 'set_title', 'title', 'secret routed title 1'
    )),
    jsonb_build_array(jsonb_build_object(
      'type', 'set_title', 'title', 'secret restored title 1'
    )),
    pg_temp.undo_envelope(
      'mut_82000000000000000000000001',
      '55555555-5555-4555-8555-555555555555', 2, 'note_mutation', '1M'
    ),
    'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_82000000000000000000000002',
    '55555555-5555-4555-8555-555555555555',
    'dec_82000000000000000000000001',
    'note_82000000000000000000000002', 'fixture-route-two', 1, 2,
    jsonb_build_array(jsonb_build_object(
      'type', 'set_title', 'title', 'secret routed title 2'
    )),
    jsonb_build_array(jsonb_build_object(
      'type', 'set_title', 'title', 'secret restored title 2'
    )),
    pg_temp.undo_envelope(
      'mut_82000000000000000000000002',
      '55555555-5555-4555-8555-555555555555', 2, 'note_mutation', '2M'
    ),
    'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation
) values
  (
    'cap_82000000000000000000000001',
    'note_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555',
    'mut_82000000000000000000000001', 'routed'
  ),
  (
    'cap_82000000000000000000000001',
    'note_82000000000000000000000002',
    '55555555-5555-4555-8555-555555555555',
    'mut_82000000000000000000000002', 'routed'
  );
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, outcome,
  headline, destination_note_id, inserted_content, actions, reason_codes,
  receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version
) values (
  'cap_82000000000000000000000001',
  'job_82000000000000000000000001',
  '55555555-5555-4555-8555-555555555555',
  'dec_82000000000000000000000001',
  'mut_82000000000000000000000001', 'added_to_note',
  'secret receipt headline', 'note_82000000000000000000000001',
  jsonb_build_array(jsonb_build_object(
    'type', 'captured', 'mutationId', 'mut_82000000000000000000000001'
  )),
  jsonb_build_array(jsonb_build_object(
    'type', 'undo', 'mutationId', 'mut_82000000000000000000000001',
    'expectedRevision', 2
  )),
  array['explicit_destination'],
  pg_temp.undo_envelope(
    'cap_82000000000000000000000001',
    '55555555-5555-4555-8555-555555555555', 1,
    'capture_receipt', 'P'
  ),
  'c5d.undo.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.reserve_content_key_operations(
  '55555555-5555-4555-8555-555555555555', reservation_id,
  'ai_assisted', 'c5d.undo.ai.object.v1', 1, 1
)
from (values
  ('82000000-0000-4000-8000-000000000010'::uuid),
  ('82000000-0000-4000-8000-000000000011'::uuid),
  ('82000000-0000-4000-8000-000000000012'::uuid),
  ('82000000-0000-4000-8000-000000000013'::uuid),
  ('82000000-0000-4000-8000-000000000014'::uuid),
  ('82000000-0000-4000-8000-000000000015'::uuid),
  ('82000000-0000-4000-8000-000000000016'::uuid),
  ('82000000-0000-4000-8000-000000000020'::uuid),
  ('82000000-0000-4000-8000-000000000021'::uuid),
  ('82000000-0000-4000-8000-000000000022'::uuid),
  ('82000000-0000-4000-8000-000000000023'::uuid),
  ('82000000-0000-4000-8000-000000000024'::uuid),
  ('82000000-0000-4000-8000-000000000025'::uuid),
  ('82000000-0000-4000-8000-000000000026'::uuid)
) as reservations(reservation_id);

insert into capture_undo_values(key, value)
select 'winner', jsonb_build_object(
  'occurredAt', pg_temp.undo_time(),
  'removeInsertedContent', true,
  'sourceNoteIds', jsonb_build_array(
    'note_82000000000000000000000001',
    'note_82000000000000000000000002'
  ),
  'receipt', jsonb_build_object(
    'recordVersion', 1,
    'cipher', pg_temp.undo_stored_cipher(
      'cap_82000000000000000000000001',
      '55555555-5555-4555-8555-555555555555', 1,
      'capture_receipt', 'P'
    )
  ),
  'undoWrites', jsonb_build_array(
    pg_temp.undo_write(
      'note_82000000000000000000000001',
      'mut_82000000000000000000000001',
      'rev_82000000000000000000000011',
      'mut_82000000000000000000000011',
      '82000000-0000-4000-8000-000000000011',
      '82000000-0000-4000-8000-000000000012',
      '82000000-0000-4000-8000-000000000013', '1'
    ),
    pg_temp.undo_write(
      'note_82000000000000000000000002',
      'mut_82000000000000000000000002',
      'rev_82000000000000000000000012',
      'mut_82000000000000000000000012',
      '82000000-0000-4000-8000-000000000014',
      '82000000-0000-4000-8000-000000000015',
      '82000000-0000-4000-8000-000000000016', '2'
    )
  ),
  'requestMac', pg_temp.undo_mac('capture-undo-request'),
  'responseCipher', pg_temp.undo_cipher(
    'idempotency:capture-undo-1',
    '55555555-5555-4555-8555-555555555555', 1,
    'idempotency_response',
    '82000000-0000-4000-8000-000000000010', 'W'
  ),
  'responseVerificationMac', pg_temp.undo_mac('capture-undo-response')
);
insert into capture_undo_values(key, value)
select 'loser', jsonb_set(
  jsonb_set(
    jsonb_set(
      (select value from capture_undo_values where key = 'winner'),
      '{responseCipher}',
      pg_temp.undo_cipher(
        'idempotency:capture-undo-1',
        '55555555-5555-4555-8555-555555555555', 1,
        'idempotency_response',
        '82000000-0000-4000-8000-000000000020', 'L'
      )
    ),
    '{undoWrites,0,noteCipher,reservationId}',
    to_jsonb('82000000-0000-4000-8000-000000000021'::text)
  ),
  '{undoWrites,0,revision,cipher,reservationId}',
  to_jsonb('82000000-0000-4000-8000-000000000022'::text)
);
update capture_undo_values
set value = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(value, '{undoWrites,0,mutation,cipher,reservationId}',
        to_jsonb('82000000-0000-4000-8000-000000000023'::text)),
      '{undoWrites,1,noteCipher,reservationId}',
      to_jsonb('82000000-0000-4000-8000-000000000024'::text)
    ),
    '{undoWrites,1,revision,cipher,reservationId}',
    to_jsonb('82000000-0000-4000-8000-000000000025'::text)
  ),
  '{undoWrites,1,mutation,cipher,reservationId}',
  to_jsonb('82000000-0000-4000-8000-000000000026'::text)
)
where key = 'loser';

select throws_ok(
  $$select public.delete_encrypted_capture_with_undo(
    '55555555-5555-4555-8555-555555555555',
    'cap_82000000000000000000000001', 'capture-undo-1',
    jsonb_set(
      (select value from capture_undo_values where key = 'winner'),
      '{undoWrites,0,noteState,title}',
      to_jsonb('C5D_UNDO_RPC_PLAINTEXT_CANARY'::text)
    )
  )$$,
  '22023', 'validation_failed',
  'the RPC rejects user-authored plaintext in its operational note projection'
);

select throws_ok(
  $$select public.delete_encrypted_capture_with_undo(
    '55555555-5555-4555-8555-555555555555',
    'cap_82000000000000000000000001', 'capture-undo-1',
    jsonb_set(
      (select value from capture_undo_values where key = 'winner'),
      '{undoWrites,1,expectedCurrentCipher}',
      pg_temp.undo_stored_cipher(
        'note_82000000000000000000000002',
        '55555555-5555-4555-8555-555555555555', 2,
        'note_content', 'stale'
      )
    )
  )$$,
  'P0001', 'stale_revision',
  'one stale target aborts the complete multi-note transaction'
);
reset role;
select ok(
  (
    select count(*) = 2 and min(current_revision) = 2
      and max(current_revision) = 2
    from public.notes
    where id in (
      'note_82000000000000000000000001',
      'note_82000000000000000000000002'
    )
  )
    and (
      select status = 'organized' and deleted_at is null
      from public.captures
      where id = 'cap_82000000000000000000000001'
    )
    and (
      select bool_and(consumed_at is null)
      from public.content_key_operation_reservations
      where reservation_id between
        '82000000-0000-4000-8000-000000000010'::uuid and
        '82000000-0000-4000-8000-000000000016'::uuid
    ),
  'stale one-of-many leaves both notes, the capture, and reservations untouched'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.delete_encrypted_capture_with_undo(
    '66666666-6666-4666-8666-666666666666',
    'cap_82000000000000000000000001', 'capture-undo-1',
    (select value from capture_undo_values where key = 'winner')
  )$$,
  '22023', 'invalid_encrypted_field',
  'a command cannot cross the authenticated owner boundary'
);

insert into capture_undo_values(key, value)
select 'result', public.delete_encrypted_capture_with_undo(
  '55555555-5555-4555-8555-555555555555',
  'cap_82000000000000000000000001', 'capture-undo-1',
  (select value from capture_undo_values where key = 'winner')
);
reset role;

select ok(
  (select value ->> 'replayed' from capture_undo_values where key = 'result') = 'false'
    and (
      select count(*) = 2 and min(current_revision) = 3
        and max(current_revision) = 3
      from public.notes
      where user_id = '55555555-5555-4555-8555-555555555555'
        and id in (
          'note_82000000000000000000000001',
          'note_82000000000000000000000002'
        )
    )
    and (
      select count(*) = 2 and bool_and(undone_at is not null)
      from public.note_mutations
      where id in (
        'mut_82000000000000000000000001',
        'mut_82000000000000000000000002'
      )
    )
    and (
      select count(*) = 2
      from public.note_mutations
      where id in (
        'mut_82000000000000000000000011',
        'mut_82000000000000000000000012'
      )
    ),
  'two encrypted inverse mutations commit atomically before deletion'
);
select ok(
  (
    select status = 'deleted' and raw_text = '[deleted]'
      and content_envelope is null and content_key_id is null
    from public.captures
    where id = 'cap_82000000000000000000000001'
  )
    and not exists (
      select 1 from public.capture_receipts
      where capture_id = 'cap_82000000000000000000000001'
    )
    and (
      select bool_and(relation = 'source_removed')
      from public.capture_note_links
      where capture_id = 'cap_82000000000000000000000001'
    ),
  'the source capture is tombstoned only with the full inverse set'
);
select ok(
  (
    select bool_and(title = 'e-' || lower(id))
      and bool_and(body_markdown = '')
      and bool_and(structured_data = '{"schemaVersion":1}'::jsonb)
    from public.notes
    where id in (
      'note_82000000000000000000000001',
      'note_82000000000000000000000002'
    )
  )
    and (
      select bool_and(title = 'e-' || lower(id))
        and bool_and(body_markdown = '')
        and bool_and(structured_data = '{"schemaVersion":1}'::jsonb)
        and bool_and(tag_ids = '[]'::jsonb)
        and bool_and(links = '[]'::jsonb)
      from public.note_revisions
      where id in (
        'rev_82000000000000000000000011',
        'rev_82000000000000000000000012'
      )
    )
    and (
      select bool_and(operations = '[]'::jsonb)
        and bool_and(inverse = '{}'::jsonb)
      from public.note_mutations
      where id in (
        'mut_82000000000000000000000011',
        'mut_82000000000000000000000012'
      )
    ),
  'encrypted-only triggers persist no note, revision, or mutation plaintext'
);
select ok(
  (
    select count(*) = 7
      and bool_and(consumed_by_type = 'encrypted_capture_command')
      and bool_and(consumed_by_id = 'capture-undo-1')
    from public.content_key_operation_reservations
    where reservation_id between
      '82000000-0000-4000-8000-000000000010'::uuid and
      '82000000-0000-4000-8000-000000000016'::uuid
  )
    and (
      select count(*) = 7
      from public.content_encryption_verifications
      where user_id = '55555555-5555-4555-8555-555555555555'
        and (
          (surface in ('note_content', 'note_revision', 'note_mutation')
            and record_version = 3)
          or (surface = 'idempotency_response'
            and resource_id = 'idempotency:capture-undo-1')
        )
    ),
  'all 3N+1 envelopes consume reservations and receive verification records'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into capture_undo_values(key, value)
select 'replay', public.delete_encrypted_capture_with_undo(
  '55555555-5555-4555-8555-555555555555',
  'cap_82000000000000000000000001', 'capture-undo-1',
  (select value from capture_undo_values where key = 'loser')
);
reset role;
select ok(
  (select value ->> 'replayed' from capture_undo_values where key = 'replay') = 'true'
    and (
      select count(*) = 7
        and bool_and(consumed_by_type = 'encrypted_capture_command')
        and bool_and(consumed_by_id = 'capture-undo-1')
      from public.content_key_operation_reservations
      where reservation_id between
        '82000000-0000-4000-8000-000000000020'::uuid and
        '82000000-0000-4000-8000-000000000026'::uuid
    ),
  'a losing full same-key command replays the winner and consumes all 3N+1 reservations'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '55555555-5555-4555-8555-555555555555',
  'c5d.undo.ai.object.v2', 'ai_assisted', 'object_wrap', 2,
  'arn:aws:kms:us-west-2:123456789012:key/82000000-0000-4000-8000-000000000003',
  decode(repeat('23', 32), 'hex')
);
select public.register_user_content_key(
  '55555555-5555-4555-8555-555555555555',
  'c5d.undo.ai.mac.v2', 'ai_assisted', 'content_mac', 2,
  'arn:aws:kms:us-west-2:123456789012:key/82000000-0000-4000-8000-000000000004',
  decode(repeat('24', 32), 'hex')
);
select public.activate_user_content_key(
  '55555555-5555-4555-8555-555555555555', 'c5d.undo.ai.object.v2'
);
select public.activate_user_content_key(
  '55555555-5555-4555-8555-555555555555', 'c5d.undo.ai.mac.v2'
);
select is(
  public.delete_encrypted_capture_with_undo(
    '55555555-5555-4555-8555-555555555555',
    'cap_82000000000000000000000001', 'capture-undo-1',
    jsonb_build_object('requestMac', pg_temp.undo_mac('capture-undo-request'))
  ) ->> 'replayed',
  'true',
  'replay authenticates with the stored retired request-MAC key after rotation'
);

select * from finish();
rollback;
