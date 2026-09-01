create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

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

create function pg_temp.repair_envelope(
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

select has_function(
  'private', 'repair_encrypted_organizer_receipt_timestamps', array[]::text[]
);
select ok(
  (
    select procedure.prosecdef
      and procedure.proconfig = array['search_path=""']::text[]
    from pg_catalog.pg_proc as procedure
    where procedure.oid = pg_catalog.to_regprocedure(
      'private.repair_encrypted_organizer_receipt_timestamps()'
    )
  ),
  'the one-time repair is security-definer and search-path pinned'
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name = 'repair_encrypted_organizer_receipt_timestamps'
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_index_worker', 'unfiled_rag_verifier',
        'unfiled_organizer_worker'
      )
  ),
  0::bigint,
  'no runtime role can execute the owner-only repair'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '89898989-8989-4989-8989-898989898989',
  'authenticated', 'authenticated', 'receipt-repair@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

insert into public.content_encryption_rollouts(user_id, state) values (
  '89898989-8989-4989-8989-898989898989', 'encrypted_only'
);

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, created_at, activated_at
) values
  (
    '89898989-8989-4989-8989-898989898989',
    'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/89000000-0000-4000-8000-000000000001',
    decode(repeat('89', 32), 'hex'), 'active', now(), now()
  ),
  (
    '89898989-8989-4989-8989-898989898989',
    'repair.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/89000000-0000-4000-8000-000000000002',
    decode(repeat('98', 32), 'hex'), 'active', now(), now()
  );

insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989', 'web', 'receipt-repair',
  'encrypted receipt repair capture', 'ai_assisted',
  '2026-08-31 14:15:16.123456-07'::timestamptz, 'America/Los_Angeles',
  'organized',
  pg_temp.repair_envelope(
    '89898989-8989-4989-8989-898989898989',
    'cap_89000000000000000000000001', 1, 'capture',
    'repair.ai.object.v1', 'D'
  ),
  encode(extensions.digest('receipt-repair-capture', 'sha256'), 'hex'), 31,
  'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'repair.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);

insert into public.organization_jobs (
  id, capture_id, user_id, state, attempt, prompt_version, schema_version,
  completed_at, last_transition_lease_token, last_transition_action,
  last_transition_request_hash
) values (
  'job_89000000000000000000000001',
  'cap_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989', 'succeeded', 1,
  'receipt-repair-v1', 1, '2026-08-31 21:15:18+00',
  '89000000-0000-4000-8000-000000000001', 'completed', repeat('a', 64)
);

insert into public.content_key_operation_reservations (
  user_id, reservation_id, key_id, key_class, key_purpose, key_version,
  operation_count, consumed_by_type, consumed_by_id, consumed_at
) values
  (
    '89898989-8989-4989-8989-898989898989',
    '89000000-0000-4000-8000-000000000011',
    'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
    'encrypted_organizer', 'note_89000000000000000000000001', now()
  ),
  (
    '89898989-8989-4989-8989-898989898989',
    '89000000-0000-4000-8000-000000000012',
    'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
    'encrypted_organizer', 'dec_89000000000000000000000001', now()
  ),
  (
    '89898989-8989-4989-8989-898989898989',
    '89000000-0000-4000-8000-000000000013',
    'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
    'encrypted_organizer', 'rvw_89000000000000000000000001', now()
  ),
  (
    '89898989-8989-4989-8989-898989898989',
    '89000000-0000-4000-8000-000000000014',
    'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
    'encrypted_organizer', 'cap_89000000000000000000000001', now()
  );

insert into public.encrypted_organizer_preparations (
  job_id, user_id, capture_id, attempt, generation, lease_token, mode,
  note_id, expected_revision, target_revision, decision_id, revision_id,
  mutation_id, review_item_id, write_reservation_id,
  decision_reservation_id, review_reservation_id, receipt_reservation_id,
  object_key_id, object_key_version, controls, command_hash, result,
  completed_at
) values (
  'job_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989',
  'cap_89000000000000000000000001', 1, 0,
  '89000000-0000-4000-8000-000000000001', 'create',
  'note_89000000000000000000000001', null, 1,
  'dec_89000000000000000000000001',
  'rev_89000000000000000000000001',
  'mut_89000000000000000000000001',
  'rvw_89000000000000000000000001',
  '89000000-0000-4000-8000-000000000011',
  '89000000-0000-4000-8000-000000000012',
  '89000000-0000-4000-8000-000000000013',
  '89000000-0000-4000-8000-000000000014',
  'repair.ai.object.v1', 1,
  '{"explicitDestinationNoteId":null,"expansionDisabled":false}'::jsonb,
  repeat('a', 64),
  '{"jobId":"job_89000000000000000000000001","outcome":"review"}'::jsonb,
  '2026-08-31 21:15:19+00'
);

insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, decision_envelope,
  decision_key_id, decision_key_class, decision_key_purpose,
  decision_key_version
) values (
  'dec_89000000000000000000000001',
  'cap_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989', '{}'::jsonb, '{}'::jsonb,
  null, 'review', null, array['ambiguous_intent'],
  pg_temp.repair_envelope(
    '89898989-8989-4989-8989-898989898989',
    'dec_89000000000000000000000001', 1, 'organization_decision',
    'repair.ai.object.v1', 'E'
  ),
  'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);

insert into public.review_items (
  id, user_id, capture_id, note_id, type, choices, state, resolution,
  review_envelope, review_key_id, review_key_class, review_key_purpose,
  review_key_version, review_content_revision
) values (
  'rvw_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989',
  'cap_89000000000000000000000001', null, 'low_confidence', '[]'::jsonb,
  'open', null,
  pg_temp.repair_envelope(
    '89898989-8989-4989-8989-898989898989',
    'rvw_89000000000000000000000001', 1, 'review_item',
    'repair.ai.object.v1', 'F'
  ),
  'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1
);

-- This is the pre-migration shape: the envelope authenticates the capture
-- occurrence time, but the relational projection used the server insert time.
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, review_item_id, mutation_id,
  outcome, headline, destination_note_id, inserted_content, actions,
  reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version, receipt_revision, created_at
) values (
  'cap_89000000000000000000000001',
  'job_89000000000000000000000001',
  '89898989-8989-4989-8989-898989898989',
  'dec_89000000000000000000000001',
  'rvw_89000000000000000000000001', null, 'needs_review',
  'Needs your review', null, '[]'::jsonb, '[]'::jsonb,
  array['ambiguous_intent'],
  pg_temp.repair_envelope(
    '89898989-8989-4989-8989-898989898989',
    'cap_89000000000000000000000001', 1, 'capture_receipt',
    'repair.ai.object.v1', 'G'
  ),
  'repair.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1,
  '2026-08-31 21:15:20+00'
);

select is(
  pg_temp.caught_error($statement$
    update public.capture_receipts
    set created_at = '2026-08-31 21:15:16.123456+00'::timestamptz
    where capture_id = 'cap_89000000000000000000000001'
  $statement$) ->> 'message',
  'stale_content_revision',
  'the ordinary encrypted-write guard rejects a projection-only timestamp edit'
);

select is(
  pg_temp.caught_error($statement$
    select private.repair_encrypted_organizer_receipt_timestamps()
  $statement$) ->> 'message',
  'organizer_receipt_timestamp_repair_unattested',
  'the repair fails closed until the unchanged receipt envelope is verified'
);
select is(
  (
    select created_at
    from public.capture_receipts
    where capture_id = 'cap_89000000000000000000000001'
  ),
  '2026-08-31 21:15:20+00'::timestamptz,
  'a failed attestation does not mutate the legacy projection'
);
select is(
  (
    select trigger.tgenabled::text
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.capture_receipts'::pg_catalog.regclass
      and trigger.tgname = 'capture_receipts_encrypted_rollout_guard'
  ),
  'O',
  'a failed repair leaves the encrypted-write guard enabled'
);

insert into public.content_encryption_verifications (
  user_id, surface, resource_id, record_version, envelope_digest,
  verification_mac, verification_mac_key_id, verification_mac_key_class,
  verification_mac_key_purpose, verification_mac_key_version
)
select receipt.user_id, 'capture_receipt', receipt.capture_id,
  receipt.receipt_revision,
  encode(extensions.digest(receipt.receipt_envelope::text, 'sha256'), 'hex'),
  repeat('b', 64), 'repair.ai.mac.v1', 'ai_assisted', 'content_mac', 1
from public.capture_receipts as receipt
where receipt.capture_id = 'cap_89000000000000000000000001';

-- The production upgrade starts in a fresh migration transaction. Flush this
-- test fixture's initially-deferred binding checks before exercising the same
-- ALTER TRIGGER maintenance boundary.
set constraints all immediate;

select is(
  private.repair_encrypted_organizer_receipt_timestamps(),
  1,
  'one fully attested legacy organizer receipt is repaired'
);
select is(
  (
    select receipt.created_at
    from public.capture_receipts as receipt
    where receipt.capture_id = 'cap_89000000000000000000000001'
  ),
  '2026-08-31 21:15:16.123456+00'::timestamptz,
  'the receipt projection now exactly equals capture.client_created_at'
);
select ok(
  (
    select receipt.receipt_revision = 1
      and receipt.receipt_envelope = pg_temp.repair_envelope(
        '89898989-8989-4989-8989-898989898989',
        'cap_89000000000000000000000001', 1, 'capture_receipt',
        'repair.ai.object.v1', 'G'
      )
    from public.capture_receipts as receipt
    where receipt.capture_id = 'cap_89000000000000000000000001'
  ),
  'the repair preserves the authenticated envelope and receipt revision'
);
select ok(
  exists (
    select 1
    from public.capture_receipts as receipt
    join public.content_encryption_verifications as verification
      on verification.user_id = receipt.user_id
      and verification.surface = 'capture_receipt'
      and verification.resource_id = receipt.capture_id
      and verification.record_version = receipt.receipt_revision
      and verification.envelope_digest = encode(
        extensions.digest(receipt.receipt_envelope::text, 'sha256'), 'hex'
      )
    where receipt.capture_id = 'cap_89000000000000000000000001'
  ),
  'projection repair preserves the current ciphertext verification'
);
select is(
  (
    select trigger.tgenabled::text
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid = 'public.capture_receipts'::pg_catalog.regclass
      and trigger.tgname = 'capture_receipts_encrypted_rollout_guard'
  ),
  'O',
  'the encrypted-write guard is re-enabled after a successful repair'
);
select is(
  private.repair_encrypted_organizer_receipt_timestamps(),
  0,
  'the repair is idempotent after the canonical projection is restored'
);

select * from finish();
rollback;
