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

create function pg_temp.e1_envelope(
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

create function pg_temp.e1_mac(p_key jsonb, p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', p_key ->> 'keyId',
    'keyClass', p_key ->> 'keyClass',
    'keyPurpose', p_key ->> 'purpose',
    'keyVersion', (p_key ->> 'keyVersion')::integer
  );
$$;

create function pg_temp.e1_mac_key(p_key_class text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'keyId', case p_key_class
      when 'private_manual' then 'e1.private.mac.v1'
      else 'e1.ai.mac.v1'
    end,
    'keyClass', p_key_class,
    'purpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.e1_cipher(
  p_owner_id uuid,
  p_reservation jsonb,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.e1_envelope(
      p_owner_id,
      p_reservation ->> 'resourceId',
      (p_reservation ->> 'recordVersion')::integer,
      p_reservation ->> 'surface',
      p_reservation #>> '{key,keyId}',
      p_seed
    ),
    'keyId', p_reservation #>> '{key,keyId}',
    'keyClass', p_reservation ->> 'keyClass',
    'keyPurpose', 'object_wrap',
    'keyVersion', (p_reservation #>> '{key,keyVersion}')::integer,
    'reservationId', p_reservation ->> 'reservationId'
  );
$$;

create function pg_temp.e1_reservation(
  p_preparation jsonb,
  p_branch text,
  p_role text
)
returns jsonb
language sql
immutable
as $$
  select item
  from jsonb_array_elements(case
    when p_branch = 'common' and p_preparation ? 'commonReservations'
      then p_preparation -> 'commonReservations'
    when p_branch = 'common' then p_preparation -> 'reservations'
    when p_branch = 'applied'
      then p_preparation #> '{branches,applied,reservations}'
    else p_preparation #> '{branches,needsReview,reservations}'
  end) as supplied(item)
  where item ->> 'role' = p_role;
$$;

create function pg_temp.e1_note_state(p_privacy text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'spaceId', null,
    'type', 'generic',
    'dailyDate', null,
    'isOpen', true,
    'privacy', p_privacy,
    'pinnedAt', null,
    'archivedAt', null,
    'deletedAt', null,
    'tagIds', '[]'::jsonb,
    'links', '[]'::jsonb
  );
$$;

create function pg_temp.e1_write(
  p_owner_id uuid,
  p_preparation jsonb,
  p_branch text,
  p_ordinal integer,
  p_source text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  with selected as (
    select item as member
    from jsonb_array_elements(p_preparation -> 'members') as supplied(item)
    where (item ->> 'ordinal')::integer = p_ordinal
  )
  select jsonb_build_object(
    'ordinal', p_ordinal,
    'noteId', member ->> 'noteId',
    'targetMutationId', member -> 'targetMutationId',
    'expectedRevision', (member ->> 'expectedRevision')::integer,
    'noteState', pg_temp.e1_note_state(member ->> 'targetPrivacy'),
    'noteCipher', pg_temp.e1_cipher(
      p_owner_id,
      pg_temp.e1_reservation(
        p_preparation, p_branch, 'note_content:' || p_ordinal
      ),
      p_seed || 'N'
    ),
    'revision', jsonb_build_object(
      'id', member ->> 'revisionId',
      'source', p_source,
      'actor', 'user:e1-test',
      'cipher', pg_temp.e1_cipher(
        p_owner_id,
        pg_temp.e1_reservation(
          p_preparation, p_branch, 'note_revision:' || p_ordinal
        ),
        p_seed || 'R'
      ),
      'mac', pg_temp.e1_mac(
        pg_temp.e1_mac_key(pg_temp.e1_reservation(
          p_preparation, p_branch, 'note_revision:' || p_ordinal
        ) ->> 'keyClass'),
        p_seed || '-revision'
      )
    ),
    'mutation', jsonb_build_object(
      'id', member ->> 'mutationId',
      'undoTargetMutationId', member -> 'targetMutationId',
      'cipher', pg_temp.e1_cipher(
        p_owner_id,
        pg_temp.e1_reservation(
          p_preparation, p_branch, 'note_mutation:' || p_ordinal
        ),
        p_seed || 'M'
      )
    ),
    'verification', jsonb_build_object(
      'noteContent', pg_temp.e1_mac(
        pg_temp.e1_mac_key(pg_temp.e1_reservation(
          p_preparation, p_branch, 'note_content:' || p_ordinal
        ) ->> 'keyClass'),
        p_seed || '-note-proof'
      ),
      'noteMutation', pg_temp.e1_mac(
        pg_temp.e1_mac_key(pg_temp.e1_reservation(
          p_preparation, p_branch, 'note_mutation:' || p_ordinal
        ) ->> 'keyClass'),
        p_seed || '-mutation-proof'
      )
    )
  )
  from selected;
$$;

create function pg_temp.e1_review_command(
  p_owner_id uuid,
  p_preparation jsonb,
  p_include_write boolean,
  p_include_receipt boolean,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'requestMac', pg_temp.e1_mac(
      p_preparation -> 'requestMacKey', p_seed || '-request'
    ),
    'responseCipher', pg_temp.e1_cipher(
      p_owner_id,
      pg_temp.e1_reservation(p_preparation, 'common', 'response'),
      p_seed || 'O'
    ),
    'responseVerificationMac', pg_temp.e1_mac(
      p_preparation -> 'requestMacKey', p_seed || '-response'
    ),
    'writes', case when p_include_write then jsonb_build_array(
      pg_temp.e1_write(
        p_owner_id, p_preparation, 'common', 0, 'interactive', p_seed || 'W'
      )
    ) else '[]'::jsonb end,
    'receipt', case when p_include_receipt then jsonb_build_object(
      'recordVersion',
        (p_preparation #>> '{source,receipt,recordVersion}')::integer + 1,
      'cipher', pg_temp.e1_cipher(
        p_owner_id,
        pg_temp.e1_reservation(p_preparation, 'common', 'receipt'),
        p_seed || 'C'
      ),
      'verificationMac', pg_temp.e1_mac(
        pg_temp.e1_mac_key(pg_temp.e1_reservation(
          p_preparation, 'common', 'receipt'
        ) ->> 'keyClass'),
        p_seed || '-receipt'
      )
    ) else null end,
    'review', jsonb_build_object(
      'reviewItemId', p_preparation #>> '{ids,reviewItemId}',
      'recordVersion',
        (p_preparation #>> '{source,review,recordVersion}')::integer + 1,
      'type', p_preparation #>> '{source,review,type}',
      'cipher', pg_temp.e1_cipher(
        p_owner_id,
        pg_temp.e1_reservation(p_preparation, 'common', 'review'),
        p_seed || 'V'
      ),
      'verificationMac', pg_temp.e1_mac(
        pg_temp.e1_mac_key(pg_temp.e1_reservation(
          p_preparation, 'common', 'review'
        ) ->> 'keyClass'),
        p_seed || '-review'
      )
    )
  );
$$;

create temporary table e1_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on e1_values to service_role;

-- Exact structural boundary.
select has_table(
  'public', 'encrypted_owner_interaction_claims',
  'owner-interaction claims exist'
);
select has_table(
  'public', 'encrypted_owner_interaction_members',
  'owner-interaction members exist'
);
select has_table(
  'public', 'encrypted_owner_interaction_reservations',
  'owner-interaction reservation bindings exist'
);
select has_table(
  'public', 'encrypted_mutation_batches',
  'encrypted mutation batches exist'
);
select has_table(
  'public', 'encrypted_mutation_batch_members',
  'encrypted mutation-batch members exist'
);

select has_column(
  'public', 'encrypted_owner_interaction_claims', 'selected_outcome',
  'a completed dual-branch claim records only the selected content-free outcome'
);
select has_column(
  'public', 'encrypted_owner_interaction_members', 'expected_note_envelope_digest',
  'member CAS evidence binds the encrypted note snapshot by digest'
);
select has_column(
  'public', 'encrypted_owner_interaction_reservations', 'branch',
  'every object reservation is bound to its mutually exclusive branch'
);
select has_column(
  'public', 'encrypted_mutation_batches', 'anchor_mutation_id',
  'a committed batch has a stable content-free anchor'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'encrypted_owner_interaction_claims',
        'encrypted_owner_interaction_members',
        'encrypted_owner_interaction_reservations',
        'encrypted_mutation_batches',
        'encrypted_mutation_batch_members'
      )
      and relation.relrowsecurity and relation.relforcerowsecurity
  ),
  5::bigint,
  'all five E1 relations enable and force RLS'
);
select is(
  (
    select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and tablename in (
      'encrypted_owner_interaction_claims',
      'encrypted_owner_interaction_members',
      'encrypted_owner_interaction_reservations',
      'encrypted_mutation_batches',
      'encrypted_mutation_batch_members'
    )
  ),
  0::bigint,
  'the service-owned E1 relations expose no direct RLS policy'
);
select is(
  (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'encrypted_owner_interaction_claims',
        'encrypted_owner_interaction_members',
        'encrypted_owner_interaction_reservations',
        'encrypted_mutation_batches',
        'encrypted_mutation_batch_members'
      )
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_organizer_worker', 'unfiled_index_worker',
        'unfiled_rag_verifier'
      )
  ),
  0::bigint,
  'runtime roles have no direct E1 table privileges'
);

select has_function(
  'public', 'prepare_encrypted_decision_correction',
  array['uuid','text','text','jsonb']
);
select has_function(
  'public', 'commit_encrypted_decision_correction',
  array['uuid','text','text','jsonb']
);
select has_function(
  'public', 'prepare_encrypted_review_resolution',
  array['uuid','text','text','jsonb']
);
select has_function(
  'public', 'commit_encrypted_review_resolution',
  array['uuid','text','text','jsonb']
);
select has_function(
  'public', 'get_encrypted_mutation_batch',
  array['uuid','text','integer','text']
);
select has_function(
  'public', 'undo_encrypted_mutation_batch',
  array['uuid','text','integer','text','jsonb']
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'public'
      and routine_name in (
        'prepare_encrypted_decision_correction',
        'commit_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'commit_encrypted_review_resolution',
        'get_encrypted_mutation_batch',
        'undo_encrypted_mutation_batch'
      )
      and privilege_type = 'EXECUTE'
      and grantee = 'service_role'
  ),
  6::bigint,
  'service_role receives exactly the six E1 capabilities'
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'public'
      and routine_name in (
        'prepare_encrypted_decision_correction',
        'commit_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'commit_encrypted_review_resolution',
        'get_encrypted_mutation_batch',
        'undo_encrypted_mutation_batch'
      )
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'unfiled_organizer_worker',
        'unfiled_index_worker', 'unfiled_rag_verifier'
      )
  ),
  0::bigint,
  'no other runtime role receives an E1 capability'
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'public'
      and grantee = 'unfiled_organizer_worker'
      and privilege_type = 'EXECUTE'
  ),
  11::bigint,
  'the organizer worker allowlist is exactly eleven functions after E4'
);
select ok(
  (
    select procedure.prosecdef
      and procedure.provolatile = 's'
      and procedure.proconfig = array['search_path=""']::text[]
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where procedure.oid = to_regprocedure(
      'private.content_key_service_projection(public.user_content_keys)'
    )
      and namespace.nspname = 'private'
  ),
  'managed-key projection remains stable, security-definer, and search-path pinned'
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name = 'content_key_service_projection'
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_organizer_worker', 'unfiled_index_worker',
        'unfiled_rag_verifier'
      )
  ),
  0::bigint,
  'managed-key projection gains no direct runtime EXECUTE grant'
);
select ok(
  (
    select procedure.prosecdef
      and procedure.proconfig = array['search_path=""']::text[]
    from pg_catalog.pg_proc as procedure
    where procedure.oid = to_regprocedure(
      'private.cleanup_owner_interaction_references_before_delete()'
    )
  ),
  'referential cleanup is security-definer and search-path pinned'
);
select is(
  (
    select count(*)
    from pg_catalog.pg_trigger as trigger
    where trigger.tgfoid = to_regprocedure(
        'private.cleanup_owner_interaction_references_before_delete()'
      )
      and not trigger.tgisinternal
      and trigger.tgname = 'z_owner_interaction_references_cleanup'
      and pg_catalog.pg_get_triggerdef(trigger.oid) like '%BEFORE DELETE%'
  ),
  3::bigint,
  'spaces, notes, and mutations clean E1 references before FK actions'
);
select is(
  (
    select count(*)
    from information_schema.role_routine_grants
    where specific_schema = 'private'
      and routine_name = 'cleanup_owner_interaction_references_before_delete'
      and grantee in (
        'PUBLIC', 'anon', 'authenticated', 'service_role',
        'unfiled_organizer_worker', 'unfiled_index_worker',
        'unfiled_rag_verifier'
      )
  ),
  0::bigint,
  'referential cleanup is trigger-only for every runtime role'
);
select ok(
  (
    select procedure.prosecdef
      and procedure.proconfig = array['search_path=""']::text[]
      and pg_catalog.pg_get_functiondef(procedure.oid)
        like '%delete from public.api_idempotency_records as response%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        like '%response.user_id = old.user_id%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        like '%response.idempotency_key = old.idempotency_key%'
      and pg_catalog.pg_get_functiondef(procedure.oid)
        like '%response.scope = old.scope%'
    from pg_catalog.pg_proc as procedure
    where procedure.oid = to_regprocedure(
      'private.cleanup_owner_interaction_claim_reservations()'
    )
  ) and exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgfoid = to_regprocedure(
        'private.cleanup_owner_interaction_claim_reservations()'
      )
      and not trigger.tgisinternal
      and trigger.tgname =
        'encrypted_owner_interaction_claim_reservation_cleanup'
      and pg_catalog.pg_get_triggerdef(trigger.oid) like '%BEFORE DELETE%'
  ),
  'claim deletion removes only its exact replay snapshot and parent wraps'
);

select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'encrypted_owner_interaction_claims',
        'encrypted_owner_interaction_members',
        'encrypted_owner_interaction_reservations',
        'encrypted_mutation_batches',
        'encrypted_mutation_batch_members'
      )
      and column_name ~
        '(raw_text|title|body_markdown|structured_data|operations|inverse|proposal|response_envelope)'
  ),
  'E1 coordination storage contains no user-content column'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'prepare_encrypted_decision_correction',
        'commit_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'commit_encrypted_review_resolution',
        'get_encrypted_mutation_batch',
        'undo_encrypted_mutation_batch'
      )
      and lower(pg_catalog.pg_get_functiondef(procedure.oid)) ~
        '(raw_text|body_markdown|structured_data|candidate_manifest|validated_plan|operations)'
  ),
  'E1 public functions compile without legacy plaintext-column dependencies'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'prepare_encrypted_decision_correction',
        'commit_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'commit_encrypted_review_resolution',
        'get_encrypted_mutation_batch',
        'undo_encrypted_mutation_batch'
      )
      and position(':content-encryption-rollout' in
        pg_catalog.pg_get_functiondef(procedure.oid)) = 0
  ),
  'every E1 boundary takes the owner rollout advisory before row work'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'prepare_encrypted_decision_correction',
        'commit_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'commit_encrypted_review_resolution',
        'get_encrypted_mutation_batch',
        'undo_encrypted_mutation_batch'
      )
      and (
        position(':encrypted-note-write:' in
          pg_catalog.pg_get_functiondef(procedure.oid)) = 0
        or position(':encrypted-note-write:' in
          pg_catalog.pg_get_functiondef(procedure.oid)) >
          position(':content-encryption-rollout' in
            pg_catalog.pg_get_functiondef(procedure.oid))
      )
  ),
  'every E1 boundary takes the shared idempotency advisory before rollout'
);
select ok(
  (
    select procedure.prosecdef
      and procedure.proconfig = array['search_path=""']::text[]
    from pg_catalog.pg_proc as procedure
    where procedure.oid = to_regprocedure(
      'private.enforce_encrypted_idempotency_namespace()'
    )
  ) and (
    select count(*) = 6
    from pg_catalog.pg_trigger as trigger
    where trigger.tgfoid = to_regprocedure(
        'private.enforce_encrypted_idempotency_namespace()'
      )
      and not trigger.tgisinternal
      and pg_catalog.pg_get_triggerdef(trigger.oid) like '%BEFORE INSERT%'
  ),
  'the shared encrypted idempotency namespace is fail-closed on every claim and receipt surface'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'prepare_encrypted_decision_correction',
        'prepare_encrypted_review_resolution',
        'get_encrypted_mutation_batch'
      )
      and not (
        pg_catalog.pg_get_functiondef(procedure.oid)
          like '%api_idempotency_records%'
        and pg_catalog.pg_get_functiondef(procedure.oid)
          like '%encrypted_note_write_claims%'
        and pg_catalog.pg_get_functiondef(procedure.oid)
          like '%encrypted_taxonomy_write_claims%'
      )
  ),
  'every E1 prepare checks completed and pending cross-scope idempotency owners'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);


select is(
  pg_temp.caught_error($statement$
    update public.encrypted_mutation_batches
    set kind = 'undo'
    where false
  $statement$) ->> 'sqlstate',
  '42501',
  'forced RLS blocks direct service-role table access'
);
reset role;


-- Canonical encrypted fixtures.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  '88888888-8888-4888-8888-888888888888',
  'authenticated', 'authenticated', 'e1-owner@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
),
(
  '00000000-0000-0000-0000-000000000000',
  '99999999-9999-4999-8999-999999999999',
  'authenticated', 'authenticated', 'e1-other@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

insert into public.content_encryption_rollouts(user_id, state) values
  ('88888888-8888-4888-8888-888888888888', 'encrypted_only'),
  ('99999999-9999-4999-8999-999999999999', 'encrypted_only');

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, created_at, activated_at,
  previous_kms_key_id, root_rewrap_count, last_root_rewrapped_at
) values
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000001',
    decode(repeat('81', 32), 'hex'), 'active',
    '2026-08-31 01:02:03.456789+05:30',
    '2026-08-31 01:03:04.567891+05:30',
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000011',
    1, '2026-08-31 01:04:05.678912+05:30'
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000002',
    decode(repeat('82', 32), 'hex'), 'active',
    '2026-08-31 02:00:00.000111+05:30',
    '2026-08-31 02:00:01.000222+05:30', null, 0, null
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000003',
    decode(repeat('86', 32), 'hex'), 'active',
    '2026-08-31 02:01:00.000111+05:30',
    '2026-08-31 02:01:01.000222+05:30', null, 0, null
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.private.mac.v1', 'private_manual', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000004',
    decode(repeat('87', 32), 'hex'), 'active',
    '2026-08-31 02:02:00.000111+05:30',
    '2026-08-31 02:02:01.000222+05:30', null, 0, null
  ),
  (
    '99999999-9999-4999-8999-999999999999',
    'e1.other.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000001',
    decode(repeat('91', 32), 'hex'), 'active',
    '2026-08-31 03:00:00.000111+05:30',
    '2026-08-31 03:00:01.000222+05:30', null, 0, null
  ),
  (
    '99999999-9999-4999-8999-999999999999',
    'e1.other.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000002',
    decode(repeat('92', 32), 'hex'), 'active',
    '2026-08-31 04:00:00.000111+05:30',
    '2026-08-31 04:00:01.000222+05:30', null, 0, null
  );

insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, predecessor_key_id, created_at,
  activated_at, retired_at, revoked_at
) values
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.lifecycle.pending.v4', 'private_manual', 'content_mac', 4,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000021',
    decode(repeat('83', 32), 'hex'), 'pending', null,
    '2026-08-31 12:34:56.987654+12:45', null, null, null
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.lifecycle.retired.v2', 'private_manual', 'content_mac', 2,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000022',
    decode(repeat('84', 32), 'hex'), 'retired', null,
    '2026-08-31 12:34:56.987654-04:00',
    '2026-08-31 12:35:56.876543-04:00',
    '2026-08-31 12:36:56.765432-04:00', null
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1.lifecycle.revoked.v3', 'private_manual', 'content_mac', 3,
    'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000023',
    decode(repeat('85', 32), 'hex'), 'revoked',
    'e1.lifecycle.retired.v2', '2026-08-31 12:34:56.111999+00',
    '2026-08-31 12:35:56.222888+00',
    '2026-08-31 12:36:56.333777+00',
    '2026-08-31 12:37:56.444666+00'
  );

select ok(
  not exists (
    select 1
    from public.user_content_keys as content_key
    cross join lateral (
      select private.content_key_service_projection(content_key) as value
    ) as projected
    where content_key.user_id = '88888888-8888-4888-8888-888888888888'
      and content_key.key_id in (
        'e1.ai.object.v1', 'e1.lifecycle.pending.v4',
        'e1.lifecycle.retired.v2', 'e1.lifecycle.revoked.v3'
      )
      and (
        projected.value - array[
          'ownerId','keyId','keyClass','purpose','keyVersion','schemaVersion',
          'status','encryptedKeyMaterial','rootKeyArn','createdAt',
          'activatedAt','retiredAt','revokedAt','wrapOperations',
          'wrapOperationLimit','rotation'
        ] <> '{}'::jsonb
        or not projected.value ?& array[
          'ownerId','keyId','keyClass','purpose','keyVersion','schemaVersion',
          'status','encryptedKeyMaterial','rootKeyArn','createdAt',
          'activatedAt','retiredAt','revokedAt','wrapOperations',
          'wrapOperationLimit','rotation'
        ]
        or (projected.value -> 'rotation') - array[
          'predecessorKeyId','previousRootKeyArn','rootRewrapCount',
          'lastRootRewrappedAt'
        ] <> '{}'::jsonb
        or not (projected.value -> 'rotation') ?& array[
          'predecessorKeyId','previousRootKeyArn','rootRewrapCount',
          'lastRootRewrappedAt'
        ]
      )
  ),
  'managed-key projection keeps the exact content-free service shape'
);

select is(
  (
    select jsonb_object_agg(
      content_key.key_id,
      jsonb_build_object(
        'status', projected.value -> 'status',
        'createdAt', projected.value -> 'createdAt',
        'activatedAt', projected.value -> 'activatedAt',
        'retiredAt', projected.value -> 'retiredAt',
        'revokedAt', projected.value -> 'revokedAt',
        'rotation', projected.value -> 'rotation'
      )
    )
    from public.user_content_keys as content_key
    cross join lateral (
      select private.content_key_service_projection(content_key) as value
    ) as projected
    where content_key.user_id = '88888888-8888-4888-8888-888888888888'
      and content_key.key_id in (
        'e1.ai.object.v1', 'e1.lifecycle.pending.v4',
        'e1.lifecycle.retired.v2', 'e1.lifecycle.revoked.v3'
      )
  ),
  jsonb_build_object(
    'e1.ai.object.v1', jsonb_build_object(
      'status', 'active',
      'createdAt', '2026-08-30T19:32:03.456Z',
      'activatedAt', '2026-08-30T19:33:04.567Z',
      'retiredAt', null, 'revokedAt', null,
      'rotation', jsonb_build_object(
        'predecessorKeyId', null,
        'previousRootKeyArn',
          'arn:aws:kms:us-west-2:123456789012:key/88000000-0000-4000-8000-000000000011',
        'rootRewrapCount', 1,
        'lastRootRewrappedAt', '2026-08-30T19:34:05.678Z'
      )
    ),
    'e1.lifecycle.pending.v4', jsonb_build_object(
      'status', 'pending',
      'createdAt', '2026-08-30T23:49:56.987Z',
      'activatedAt', null, 'retiredAt', null, 'revokedAt', null,
      'rotation', jsonb_build_object(
        'predecessorKeyId', null, 'previousRootKeyArn', null,
        'rootRewrapCount', 0, 'lastRootRewrappedAt', null
      )
    ),
    'e1.lifecycle.retired.v2', jsonb_build_object(
      'status', 'retired',
      'createdAt', '2026-08-31T16:34:56.987Z',
      'activatedAt', '2026-08-31T16:35:56.876Z',
      'retiredAt', '2026-08-31T16:36:56.765Z', 'revokedAt', null,
      'rotation', jsonb_build_object(
        'predecessorKeyId', null, 'previousRootKeyArn', null,
        'rootRewrapCount', 0, 'lastRootRewrappedAt', null
      )
    ),
    'e1.lifecycle.revoked.v3', jsonb_build_object(
      'status', 'revoked',
      'createdAt', '2026-08-31T12:34:56.111Z',
      'activatedAt', '2026-08-31T12:35:56.222Z',
      'retiredAt', '2026-08-31T12:36:56.333Z',
      'revokedAt', '2026-08-31T12:37:56.444Z',
      'rotation', jsonb_build_object(
        'predecessorKeyId', 'e1.lifecycle.retired.v2',
        'previousRootKeyArn', null, 'rootRewrapCount', 0,
        'lastRootRewrappedAt', null
      )
    )
  ),
  'managed-key lifecycle and rotation timestamps are canonical UTC milliseconds'
);

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, is_open, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values
  (
    'note_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', 'generic', 'source',
    'encrypted source', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000001', 2, 'note_content',
      'e1.ai.object.v1', 'S'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888', 'generic', 'destination',
    'encrypted destination', '{}'::jsonb, 1, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000002', 1, 'note_content',
      'e1.ai.object.v1', 'D'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000003',
    '88888888-8888-4888-8888-888888888888', 'generic', 'batch one',
    'encrypted batch one', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000003', 2, 'note_content',
      'e1.ai.object.v1', 'B'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000004',
    '88888888-8888-4888-8888-888888888888', 'generic', 'batch two',
    'encrypted batch two', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000004', 2, 'note_content',
      'e1.ai.object.v1', 'C'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000006',
    '88888888-8888-4888-8888-888888888888', 'generic', 'batch three',
    'encrypted batch three', '{}'::jsonb, 2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000006', 2, 'note_content',
      'e1.ai.object.v1', '6'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values
  (
    'cap_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', 'web', 'e1-test',
    'encrypted correction capture', 'ai_assisted', now(), 'UTC', 'organized',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'cap_88000000000000000000000001', 1, 'capture',
      'e1.ai.object.v1', 'C'
    ),
    encode(extensions.digest('capture-one', 'sha256'), 'hex'), 28,
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    'cap_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888', 'web', 'e1-test',
    'encrypted batch capture', 'ai_assisted', now(), 'UTC', 'organized',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'cap_88000000000000000000000002', 1, 'capture',
      'e1.ai.object.v1', 'E'
    ),
    encode(extensions.digest('capture-two', 'sha256'), 'hex'), 23,
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  );

insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version, completed_at
) values
  (
    'job_88000000000000000000000001',
    'cap_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', 'succeeded', 'e1-test', 1, now()
  ),
  (
    'job_88000000000000000000000002',
    'cap_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888', 'succeeded', 'e1-test', 1, now()
  );

insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, decision_envelope,
  decision_key_id, decision_key_class, decision_key_purpose,
  decision_key_version
) values
  (
    'dec_88000000000000000000000001',
    'cap_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', '{}'::jsonb, '{}'::jsonb,
    null, 'auto', 'note_88000000000000000000000001',
    array['explicit_destination'],
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 1,
      'organization_decision', 'e1.ai.object.v1', 'O'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'dec_88000000000000000000000002',
    'cap_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888', '{}'::jsonb, '{}'::jsonb,
    null, 'auto', 'note_88000000000000000000000003',
    array['explicit_destination'],
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000002', 1,
      'organization_decision', 'e1.ai.object.v1', 'P'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key,
  before_revision, after_revision, operations, inverse,
  mutation_envelope, mutation_key_id, mutation_key_class,
  mutation_key_purpose, mutation_key_version
) values
  (
    'mut_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001',
    'note_88000000000000000000000001', 'e1-source-route', 1, 2,
    '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000001', 2, 'note_mutation',
      'e1.ai.object.v1', 'M'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_88000000000000000000000003',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000002',
    'note_88000000000000000000000003', 'e1-batch-one', 1, 2,
    '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000003', 2, 'note_mutation',
      'e1.ai.object.v1', 'N'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_88000000000000000000000004',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000002',
    'note_88000000000000000000000004', 'e1-batch-two', 1, 2,
    '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000004', 2, 'note_mutation',
      'e1.ai.object.v1', 'Q'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_88000000000000000000000006',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000002',
    'note_88000000000000000000000006', 'e1-batch-three', 1, 2,
    '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000006', 2, 'note_mutation',
      'e1.ai.object.v1', '6'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

-- Undo/source-removal restores the privacy authenticated by the exact before
-- snapshot. The fixtures exercise both a private restored state and an
-- AI-visible state whose historical snapshot remains private-key sticky.
insert into public.note_revisions (
  id, note_id, user_id, revision, source, type, title, body_markdown,
  structured_data, is_open, privacy, content_hash, actor,
  snapshot_envelope, snapshot_key_id, snapshot_key_class,
  snapshot_key_purpose, snapshot_key_version, snapshot_mac,
  snapshot_mac_key_id, snapshot_mac_key_class, snapshot_mac_key_purpose,
  snapshot_mac_key_version
) values
  (
    'rev_88000000000000000000000001',
    'note_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', 1, 'organization', 'generic',
    'encrypted source before', 'encrypted source before', '{}'::jsonb,
    true, 'private_manual', repeat('1', 64), 'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000001', 1, 'note_revision',
      'e1.private.object.v1', 'R'
    ),
    'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
    repeat('a', 64), 'e1.private.mac.v1', 'private_manual', 'content_mac', 1
  ),
  (
    'rev_88000000000000000000000003',
    'note_88000000000000000000000003',
    '88888888-8888-4888-8888-888888888888', 1, 'organization', 'generic',
    'encrypted batch private before', 'encrypted batch private before',
    '{}'::jsonb, true, 'private_manual', repeat('3', 64),
    'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000003', 1, 'note_revision',
      'e1.private.object.v1', 'S'
    ),
    'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
    repeat('b', 64), 'e1.private.mac.v1', 'private_manual', 'content_mac', 1
  ),
  (
    'rev_88000000000000000000000004',
    'note_88000000000000000000000004',
    '88888888-8888-4888-8888-888888888888', 1, 'organization', 'generic',
    'encrypted batch sticky before', 'encrypted batch sticky before',
    '{}'::jsonb, true, 'ai_assisted', repeat('4', 64),
    'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000004', 1, 'note_revision',
      'e1.private.object.v1', 'T'
    ),
    'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
    repeat('c', 64), 'e1.private.mac.v1', 'private_manual', 'content_mac', 1
  ),
  (
    'rev_88000000000000000000000006',
    'note_88000000000000000000000006',
    '88888888-8888-4888-8888-888888888888', 1, 'organization', 'generic',
    'encrypted batch AI before', 'encrypted batch AI before',
    '{}'::jsonb, true, 'ai_assisted', repeat('6', 64),
    'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000006', 1, 'note_revision',
      'e1.ai.object.v1', '6'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    repeat('6', 64), 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    'rev_88000000000000000000000002',
    'note_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888', 2, 'organization', 'generic',
    'encrypted source current', 'encrypted source current', '{}'::jsonb,
    true, 'ai_assisted', repeat('2', 64), 'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000002', 2, 'note_revision',
      'e1.ai.object.v1', '2'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    repeat('2', 64), 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    'rev_88000000000000000000000005',
    'note_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888', 1, 'organization', 'generic',
    'encrypted destination before', 'encrypted destination before',
    '{}'::jsonb, true, 'ai_assisted', repeat('5', 64),
    'organizer:e1-test',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'rev_88000000000000000000000005', 1, 'note_revision',
      'e1.ai.object.v1', '5'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    repeat('5', 64), 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  );

insert into public.capture_note_links(
  capture_id, note_id, user_id, mutation_id, relation
) values
  (
    'cap_88000000000000000000000001',
    'note_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000001', 'routed'
  ),
  (
    'cap_88000000000000000000000002',
    'note_88000000000000000000000003',
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000003', 'routed'
  ),
  (
    'cap_88000000000000000000000002',
    'note_88000000000000000000000004',
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000004', 'routed'
  ),
  (
    'cap_88000000000000000000000002',
    'note_88000000000000000000000006',
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000006', 'routed'
  );

insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, outcome,
  headline, destination_note_id, inserted_content, actions, reason_codes,
  receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version
) values
  (
    'cap_88000000000000000000000001',
    'job_88000000000000000000000001',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001',
    'mut_88000000000000000000000001', 'added_to_note',
    'encrypted', 'note_88000000000000000000000001',
    '[]'::jsonb, '[]'::jsonb, array['explicit_destination'],
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'cap_88000000000000000000000001', 1, 'capture_receipt',
      'e1.ai.object.v1', 'R'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'cap_88000000000000000000000002',
    'job_88000000000000000000000002',
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000002',
    'mut_88000000000000000000000003', 'added_to_note',
    'encrypted', 'note_88000000000000000000000003',
    '[]'::jsonb, '[]'::jsonb, array['explicit_destination'],
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'cap_88000000000000000000000002', 1, 'capture_receipt',
      'e1.ai.object.v1', 'T'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.review_items (
  id, user_id, capture_id, note_id, type, state, choices,
  review_envelope, review_key_id, review_key_class, review_key_purpose,
  review_key_version, review_content_revision
) values (
  'rvw_88000000000000000000000001',
  '88888888-8888-4888-8888-888888888888', null,
  'note_88000000000000000000000002', 'low_confidence', 'open',
  '[]'::jsonb,
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000001', 1, 'review_item',
    'e1.ai.object.v1', 'V'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1
);

-- Capture-linked Review fixture reused under savepoints for route, create,
-- dismiss, keep_both, and keep_inbox action-semantics coverage.
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, is_open, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values (
  'note_88000000000000000000000005',
  '88888888-8888-4888-8888-888888888888', 'generic',
  'review route destination', 'encrypted review route destination',
  '{}'::jsonb, 1, true, 'private_manual',
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'note_88000000000000000000000005', 1, 'note_content',
    'e1.private.object.v1', 'W'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1
);
insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_88000000000000000000000003',
  '88888888-8888-4888-8888-888888888888', 'web', 'e1-review-actions',
  'encrypted review capture', 'ai_assisted', now(), 'UTC', 'needs_review',
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'cap_88000000000000000000000003', 1, 'capture',
    'e1.ai.object.v1', 'X'
  ),
  encode(extensions.digest('review-capture', 'sha256'), 'hex'), 24,
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version, completed_at
) values (
  'job_88000000000000000000000003',
  'cap_88000000000000000000000003',
  '88888888-8888-4888-8888-888888888888',
  'succeeded', 'e1-review-actions', 1, now()
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, decision_envelope,
  decision_key_id, decision_key_class, decision_key_purpose,
  decision_key_version
) values (
  'dec_88000000000000000000000003',
  'cap_88000000000000000000000003',
  '88888888-8888-4888-8888-888888888888', '{}'::jsonb, '{}'::jsonb,
  null, 'review', null, array['low_confidence'],
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000003', 1,
    'organization_decision', 'e1.ai.object.v1', 'Y'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.review_items (
  id, user_id, capture_id, note_id, type, state, choices,
  review_envelope, review_key_id, review_key_class, review_key_purpose,
  review_key_version, review_content_revision
) values (
  'rvw_88000000000000000000000002',
  '88888888-8888-4888-8888-888888888888',
  'cap_88000000000000000000000003',
  'note_88000000000000000000000004', 'low_confidence', 'open',
  '[]'::jsonb,
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 1, 'review_item',
    'e1.ai.object.v1', 'Z'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 1
);
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, review_item_id,
  outcome, headline, destination_note_id, inserted_content, actions,
  reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version
) values (
  'cap_88000000000000000000000003',
  'job_88000000000000000000000003',
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000003', null,
  'rvw_88000000000000000000000002', 'needs_review', 'encrypted', null,
  '[]'::jsonb, '[]'::jsonb, array['low_confidence'],
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'cap_88000000000000000000000003', 1, 'capture_receipt',
    'e1.ai.object.v1', '0'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation
) values (
  'cap_88000000000000000000000003',
  'note_88000000000000000000000004',
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000004', 'routed'
);

insert into public.api_idempotency_records (
  user_id, idempotency_key, scope, created_at, completed_at,
  request_mac, request_mac_key_id, request_mac_key_class,
  request_mac_key_purpose, request_mac_key_version,
  response_envelope, response_key_id, response_key_class,
  response_key_purpose, response_key_version, replay_policy,
  request_resource_type, request_resource_id, response_resource_type,
  response_resource_id, response_record_version
) values (
  '88888888-8888-4888-8888-888888888888', 'e1-global-completed',
  'retry_capture', clock_timestamp(), clock_timestamp(), repeat('d', 64),
  'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'idempotency:e1-global-completed', 1, 'idempotency_response',
    'e1.ai.object.v1', 'I'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 'logical_mac',
  'capture', 'cap_88000000000000000000000001',
  'capture', 'cap_88000000000000000000000001', 1
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select public.prepare_encrypted_note_write(
  '88888888-8888-4888-8888-888888888888',
  'apply_encrypted_note_mutation', 'e1-global-pending',
  'note_88000000000000000000000002', 1, 'ai_assisted',
  pg_temp.e1_mac(
    jsonb_build_object(
      'keyId', 'e1.ai.mac.v1', 'keyClass', 'ai_assisted',
      'purpose', 'content_mac', 'keyVersion', 1
    ),
    'e1-global-pending'
  )
);

select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-global-completed',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'correction prepare rejects a completed cross-scope idempotency record'
);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000001', 'e1-global-completed',
      '{"type":"dismiss"}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'Review prepare rejects a completed cross-scope idempotency record'
);
select is(
  pg_temp.caught_error($statement$
    select public.get_encrypted_mutation_batch(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000003', 2, 'e1-global-completed'
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'batch prepare rejects a completed cross-scope idempotency record'
);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-global-pending',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'correction prepare rejects a pending cross-scope claim'
);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000001', 'e1-global-pending',
      '{"type":"dismiss"}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'Review prepare rejects a pending cross-scope claim'
);
select is(
  pg_temp.caught_error($statement$
    select public.get_encrypted_mutation_batch(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000003', 2, 'e1-global-pending'
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'batch prepare rejects a pending cross-scope claim'
);

select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '99999999-9999-4999-8999-999999999999',
      'dec_88000000000000000000000001', 'e1-cross-owner',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'not_found',
  'a cross-owner correction cannot discover another owner decision'
);

-- Missing or unavailable encrypted capture evidence must prepare only the
-- zero-note Review branch; plan-only reconstruction is forbidden.
savepoint missing_capture;
reset role;
update public.captures
set status = 'deleted', deleted_at = clock_timestamp(), raw_text = '[deleted]',
  content_envelope = null, content_fingerprint = null, content_length = null,
  content_key_id = null, content_key_class = null,
  content_key_purpose = null, content_key_version = null,
  fingerprint_key_id = null, fingerprint_key_class = null,
  fingerprint_key_purpose = null, fingerprint_key_version = null
where id = 'cap_88000000000000000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'missing-capture-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001', 'e1-correction-missing',
    jsonb_build_object(
      'source', jsonb_build_object(
        'noteId', 'note_88000000000000000000000001',
        'expectedRevision', 2
      ),
      'destination', jsonb_build_object(
        'type', 'existing_note',
        'noteId', 'note_88000000000000000000000002',
        'expectedRevision', 1
      )
    )
  )
);
reset role;
select ok(
  not (select (value #>> '{branches,applied,available}')::boolean
    from e1_values where key = 'missing-capture-prepare')
    and (select jsonb_array_length(
      value #> '{branches,applied,reservations}'
    ) from e1_values where key = 'missing-capture-prepare') = 0
    and (select (value #>> '{branches,needsReview,available}')::boolean
      from e1_values where key = 'missing-capture-prepare')
    and (select value #> '{source,capture}'
      from e1_values where key = 'missing-capture-prepare') = 'null'::jsonb,
  'missing encrypted capture evidence exposes only the needs-Review branch'
);
rollback to savepoint missing_capture;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

savepoint missing_restored_revision;
reset role;
delete from public.note_revisions
where user_id = '88888888-8888-4888-8888-888888888888'
  and note_id = 'note_88000000000000000000000001'
  and revision = 1;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-correction-no-before',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'encrypted_content_unavailable',
  'correction preparation fails closed without its encrypted before snapshot'
);
rollback to savepoint missing_restored_revision;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into e1_values(key, value) values (
  'correction-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001', 'e1-correction-safe',
    jsonb_build_object(
      'source', jsonb_build_object(
        'noteId', 'note_88000000000000000000000001',
        'expectedRevision', 2
      ),
      'destination', jsonb_build_object(
        'type', 'existing_note',
        'noteId', 'note_88000000000000000000000002',
        'expectedRevision', 1
      )
    )
  )
);

select ok(
  (select value - array[
      'scope','occurredAt','completed','replayed','selectedOutcome',
      'requestMacKey','ids','source','members','commonReservations',
      'branches','encryptedResponse','encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'correction-prepare')
    and (select value ?& array[
      'scope','occurredAt','completed','replayed','selectedOutcome',
      'requestMacKey','ids','source','members','commonReservations',
      'branches','encryptedResponse','encryptedResponseVerificationMac'
    ] from e1_values where key = 'correction-prepare')
    and (select value ->> 'scope'
      from e1_values where key = 'correction-prepare')
      = 'encrypted_decision_correction'
    and not (select (value ->> 'completed')::boolean
      from e1_values where key = 'correction-prepare')
    and not (select (value ->> 'replayed')::boolean
      from e1_values where key = 'correction-prepare')
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'correction-prepare') = 'null'::jsonb,
  'correction preparation has the exact outcome-neutral outer shape'
);
select ok(
  (select jsonb_array_length(value -> 'members')
    from e1_values where key = 'correction-prepare') = 2
    and (select jsonb_array_length(value -> 'commonReservations')
      from e1_values where key = 'correction-prepare') = 2
    and (select jsonb_array_length(
      value #> '{branches,applied,reservations}'
    ) from e1_values where key = 'correction-prepare') = 6
    and (select jsonb_array_length(
      value #> '{branches,needsReview,reservations}'
    ) from e1_values where key = 'correction-prepare') = 1
    and (select (value #>> '{branches,applied,available}')::boolean
      from e1_values where key = 'correction-prepare')
    and (select value #>> '{source,capture,captureId}'
      from e1_values where key = 'correction-prepare')
      = 'cap_88000000000000000000000001'
    and (select value #>> '{source,capture,status}'
      from e1_values where key = 'correction-prepare') = 'done'
    and (select (value #> '{branches,applied}') - array[
        'available','feedbackEventId','batchId','reservations'
      ] from e1_values where key = 'correction-prepare') = '{}'::jsonb
    and (select (value #> '{branches,needsReview}') - array[
        'available','reviewItemId','reservations'
      ] from e1_values where key = 'correction-prepare') = '{}'::jsonb,
  'correction discovery freezes two members and both mutually exclusive plans'
);
select ok(
  (
    select item ->> 'sourcePrivacy' = 'ai_assisted'
      and item ->> 'targetPrivacy' = 'private_manual'
    from e1_values as preparation
    cross join lateral jsonb_array_elements(
      preparation.value -> 'members'
    ) as supplied(item)
    where preparation.key = 'correction-prepare'
      and item ->> 'role' = 'source_removal'
  )
    and (select value #>> '{requestMacKey,keyClass}'
      from e1_values where key = 'correction-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_content:0'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_content:1'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'ai_assisted'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_revision:0'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_mutation:0'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_revision:1'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'ai_assisted'
    and (select pg_temp.e1_reservation(
      value, 'applied', 'note_mutation:1'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'ai_assisted'
    and (select pg_temp.e1_reservation(
      value, 'needs_review', 'review'
    ) ->> 'keyClass' from e1_values where key = 'correction-prepare')
      = 'private_manual',
  'correction projects member-local history and aggregate-private conflict evidence'
);
select ok(
  not exists (
    select 1
    from e1_values as preparation
    cross join lateral jsonb_array_elements(
      preparation.value -> 'commonReservations'
      || preparation.value #> '{branches,applied,reservations}'
      || preparation.value #> '{branches,needsReview,reservations}'
    ) as supplied(reservation)
    where preparation.key = 'correction-prepare'
      and (
        reservation - array[
          'role','surface','resourceId','recordVersion','keyClass',
          'reservationId','key'
        ] <> '{}'::jsonb
        or not reservation ?& array[
          'role','surface','resourceId','recordVersion','keyClass',
          'reservationId','key'
        ]
        or reservation #>> '{key,ownerId}' <>
          '88888888-8888-4888-8888-888888888888'
        or reservation #>> '{key,purpose}' <> 'object_wrap'
        or reservation ->> 'keyClass' <>
          reservation #>> '{key,keyClass}'
      )
  ),
  'every correction reservation repeats its complete managed-key binding'
);

insert into e1_values(key, value)
select 'correction-replay', public.prepare_encrypted_decision_correction(
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000001', 'e1-correction-safe',
  jsonb_build_object(
    'source', jsonb_build_object(
      'noteId', 'note_88000000000000000000000001',
      'expectedRevision', 2
    ),
    'destination', jsonb_build_object(
      'type', 'existing_note',
      'noteId', 'note_88000000000000000000000002',
      'expectedRevision', 1
    )
  )
);
select ok(
  (select (value ->> 'replayed')::boolean
    from e1_values where key = 'correction-replay')
    and (select value - 'replayed'
      from e1_values where key = 'correction-replay')
      = (select value - 'replayed'
        from e1_values where key = 'correction-prepare'),
  'correction prepare replay preserves every stable ID and reservation'
);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-correction-safe',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":2}}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'one correction idempotency key cannot be rebound to another CAS request'
);

insert into e1_values(key, value)
select 'correction-command', jsonb_build_object(
  'selectedOutcome', 'applied',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-correction-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'I'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-correction-response'
  ),
  'writes', jsonb_build_array(
    jsonb_set(
      pg_temp.e1_write(
        '88888888-8888-4888-8888-888888888888', preparation.value,
        'applied', 0, 'interactive', '0'
      ),
      '{noteState,deletedAt}',
      '"2026-08-31T23:59:59.123456Z"'::jsonb
    ),
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 1, 'interactive', '1'
    )
  ),
  'receipt', jsonb_build_object(
    'recordVersion', 2,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'P'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'e1-correction-receipt'
    )
  ),
  'review', null
)
from e1_values as preparation where preparation.key = 'correction-prepare';

insert into e1_values(key, value)
select 'correction-event-before', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
insert into e1_values(key, value)
select 'correction-result', public.commit_encrypted_decision_correction(
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000001', 'e1-correction-safe', value
)
from e1_values where key = 'correction-command';
insert into e1_values(key, value)
select 'correction-event-after', to_jsonb(coalesce(max(seq), 0))
from public.user_events;

reset role;
select ok(
  (select value - array[
      'scope','outcome','decisionId','reviewItemId','feedbackEventId',
      'batchId','members','encryptedResponse','responseVerificationMac',
      'replayed'
    ] = '{}'::jsonb
    from e1_values where key = 'correction-result')
    and (select value ->> 'outcome'
      from e1_values where key = 'correction-result') = 'applied'
    and not (select (value ->> 'replayed')::boolean
      from e1_values where key = 'correction-result')
    and (select jsonb_array_length(value -> 'members')
      from e1_values where key = 'correction-result') = 2
    and (select value -> 'reviewItemId'
      from e1_values where key = 'correction-result') = 'null'::jsonb
    and (select value ->> 'feedbackEventId'
      from e1_values where key = 'correction-result')
      = (select value #>> '{branches,applied,feedbackEventId}'
        from e1_values where key = 'correction-prepare')
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'correction-result')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'correction-command')
    and not exists (
      select 1
      from e1_values as result
      cross join lateral jsonb_array_elements(result.value -> 'members')
        as supplied(member)
      where result.key = 'correction-result'
        and (
          member - array[
            'role','noteId','currentRevision','revisionId','mutationId'
          ] <> '{}'::jsonb
          or not member ?& array[
            'role','noteId','currentRevision','revisionId','mutationId'
          ]
        )
    ),
  'safe correction commits the selected applied branch'
);
select ok(
  (select current_revision from public.notes
    where id = 'note_88000000000000000000000001') = 3
    and (select deleted_at is not null from public.notes
      where id = 'note_88000000000000000000000001')
    and (select current_revision from public.notes
      where id = 'note_88000000000000000000000002') = 2
    and (select undone_at is not null from public.note_mutations
      where id = 'mut_88000000000000000000000001')
    and (
      select count(*) from public.note_mutations
      where user_id = '88888888-8888-4888-8888-888888888888'
        and id in (
          select item ->> 'mutationId'
          from e1_values as preparation
          cross join lateral jsonb_array_elements(
            preparation.value -> 'members'
          ) as supplied(item)
          where preparation.key = 'correction-prepare'
        )
    ) = 2,
  'safe correction soft-deletes its source and publishes exactly two mutations'
);
select ok(
  (select destination_note_id from public.organization_decisions
    where id = 'dec_88000000000000000000000001')
      = 'note_88000000000000000000000002'
    and (select row(outcome::text,destination_note_id,receipt_revision)
      from public.capture_receipts
      where capture_id = 'cap_88000000000000000000000001')
      = row(
        'added_to_note'::text,
        'note_88000000000000000000000002'::text,
        2::integer
      )
    and (
      select count(*) from public.feedback_event_mutations
      where feedback_event_id = (
        select value ->> 'feedbackEventId'
        from e1_values where key = 'correction-result'
      ) and role in ('source_removal','destination_write')
    ) = 2
    and (
      select count(*) from public.encrypted_mutation_batch_members
      where batch_id = (
        select (value ->> 'batchId')::uuid
        from e1_values where key = 'correction-result'
      )
    ) = 2,
  'safe correction atomically updates decision, receipt, feedback, and batch evidence'
);
select ok(
  (select jsonb_agg(
      jsonb_build_array(event.entity, event.entity_id)
      order by event.entity, event.entity_id
    )
    from public.user_events as event
    where event.seq > (
      select (value::text)::bigint from e1_values
      where key = 'correction-event-before'
    )) = (
      select jsonb_agg(
        jsonb_build_array(expected.entity, expected.entity_id)
        order by expected.entity, expected.entity_id
      )
      from (
        values
          ('capture', 'cap_88000000000000000000000001'),
          ('capture_note_link', 'note_88000000000000000000000001'),
          ('capture_note_link', 'note_88000000000000000000000002'),
          ('capture_receipt', 'cap_88000000000000000000000001'),
          ('note', 'note_88000000000000000000000001'),
          ('note', 'note_88000000000000000000000002'),
          ('organization_decision', 'dec_88000000000000000000000001')
        union all
        select 'note_revision', member ->> 'revisionId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(
          preparation.value -> 'members'
        ) as supplied(member)
        where preparation.key = 'correction-prepare'
        union all
        select 'note_mutation', member ->> 'mutationId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(
          preparation.value -> 'members'
        ) as supplied(member)
        where preparation.key = 'correction-prepare'
      ) as expected(entity, entity_id)
    ),
  'correction publishes the exact note, lineage, and capture event set'
);
select ok(
  (
    select count(*)
    from public.content_key_operation_reservations as reservation
    join public.encrypted_owner_interaction_reservations as binding
      on binding.user_id = reservation.user_id
      and binding.reservation_id = reservation.reservation_id
    where binding.user_id = '88888888-8888-4888-8888-888888888888'
      and binding.idempotency_key = 'e1-correction-safe'
      and reservation.consumed_at is not null
  ) = 9
    and not exists (
      select 1 from public.review_items
      where id = (
        select value #>> '{branches,needsReview,reviewItemId}'
        from e1_values where key = 'correction-prepare'
      )
    ),
  'selected correction reservations are consumed and the sibling Review branch is canceled'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-completed-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001', 'e1-correction-safe',
    jsonb_build_object(
      'source', jsonb_build_object(
        'noteId', 'note_88000000000000000000000001',
        'expectedRevision', 2
      ),
      'destination', jsonb_build_object(
        'type', 'existing_note',
        'noteId', 'note_88000000000000000000000002',
        'expectedRevision', 1
      )
    )
  );
select ok(
  (select value - array[
      'scope','occurredAt','completed','replayed','selectedOutcome',
      'requestMacKey','ids','source','members','commonReservations',
      'branches','encryptedResponse','encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'correction-completed-prepare')
    and (select (value ->> 'completed')::boolean
      from e1_values where key = 'correction-completed-prepare')
    and (select (value ->> 'replayed')::boolean
      from e1_values where key = 'correction-completed-prepare')
    and (select value -> 'source'
      from e1_values where key = 'correction-completed-prepare') = 'null'::jsonb
    and (select value -> 'members'
      from e1_values where key = 'correction-completed-prepare') = '[]'::jsonb
    and (select value -> 'commonReservations'
      from e1_values where key = 'correction-completed-prepare') = '[]'::jsonb
    and (select value #> '{branches,applied,reservations}'
      from e1_values where key = 'correction-completed-prepare') = '[]'::jsonb
    and (select value #> '{branches,needsReview,reservations}'
      from e1_values where key = 'correction-completed-prepare') = '[]'::jsonb
    and (select (value #> '{branches,applied}') - array[
        'available','feedbackEventId','batchId','reservations'
      ] from e1_values where key = 'correction-completed-prepare') = '{}'::jsonb
    and (select (value #> '{branches,needsReview}') - array[
        'available','reviewItemId','reservations'
      ] from e1_values where key = 'correction-completed-prepare') = '{}'::jsonb
    and (select (value #>> '{branches,applied,available}')::boolean
      from e1_values where key = 'correction-completed-prepare')
    and not (select (value #>> '{branches,needsReview,available}')::boolean
      from e1_values where key = 'correction-completed-prepare')
    and (select value #>> '{branches,needsReview,reviewItemId}'
      from e1_values where key = 'correction-completed-prepare')
      = (select value #>> '{branches,needsReview,reviewItemId}'
        from e1_values where key = 'correction-prepare')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'correction-completed-prepare')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'correction-result')
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'correction-completed-prepare')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'correction-result'),
  'completed correction prepare returns only immutable replay coordinates and proof'
);

reset role;
savepoint response_cipher_tamper;
update public.api_idempotency_records set response_envelope = jsonb_set(
  response_envelope, '{payload,ciphertext}', to_jsonb(repeat('Z', 64))
)
where user_id = '88888888-8888-4888-8888-888888888888'
  and idempotency_key = 'e1-correction-safe';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-correction-safe',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'completed prepare fails closed when its response cipher no longer matches the persisted proof'
);
reset role;
rollback to savepoint response_cipher_tamper;

savepoint response_proof_missing;
delete from public.content_encryption_verifications
where user_id = '88888888-8888-4888-8888-888888888888'
  and surface = 'idempotency_response'
  and resource_id = 'idempotency:e1-correction-safe';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_decision_correction(
      '88888888-8888-4888-8888-888888888888',
      'dec_88000000000000000000000001', 'e1-correction-safe',
      '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000002","expectedRevision":1}}'::jsonb
    )
  $statement$) ->> 'message',
  'invalid_idempotency_key',
  'completed prepare fails closed when its persisted response proof is missing'
);
reset role;
rollback to savepoint response_proof_missing;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-commit-replay', public.commit_encrypted_decision_correction(
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000001', 'e1-correction-safe',
  jsonb_build_object(
    'selectedOutcome', 'applied',
    'requestMac', command.value -> 'requestMac'
  )
)
from e1_values as command where command.key = 'correction-command';
select ok(
  (select (value ->> 'replayed')::boolean
    from e1_values where key = 'correction-commit-replay')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'correction-commit-replay')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'correction-result')
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'correction-commit-replay')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'correction-result')
    and (select coalesce(max(seq), 0) from public.user_events) = (
      select (value::text)::bigint from e1_values
      where key = 'correction-event-after'
    ),
  'completed correction replays with only selectedOutcome and requestMac'
);
reset role;

-- A second correction starts from the first correction's authenticated
-- destination mutation, not from the original organization mutation. This
-- proves A -> B -> C advances receipt and batch lineage canonically.
savepoint repeat_correction;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'repeat-correction-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001', 'e1-repeat-correction',
    '{"source":{"noteId":"note_88000000000000000000000002","expectedRevision":2},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000005","expectedRevision":1}}'::jsonb
  )
);
reset role;
select ok(
  (select value #>> '{ids,sourceNoteId}' from e1_values
    where key = 'repeat-correction-prepare') =
      'note_88000000000000000000000002'
    and (select value #>> '{source,receipt,destinationNoteId}' from e1_values
      where key = 'repeat-correction-prepare') =
        'note_88000000000000000000000002'
    and (select value #>> '{source,receipt,mutationId}' from e1_values
      where key = 'repeat-correction-prepare') = (
        select member ->> 'mutationId'
        from e1_values as result
        cross join lateral jsonb_array_elements(result.value -> 'members')
          as supplied(member)
        where result.key = 'correction-result'
          and member ->> 'role' = 'destination_write'
      )
    and exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where preparation.key = 'repeat-correction-prepare'
        and member ->> 'role' = 'source_removal'
        and member ->> 'noteId' = 'note_88000000000000000000000002'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{source,receipt,mutationId}'
    ),
  'repeat correction binds the current routed note and first correction mutation'
);
insert into e1_values(key, value)
select 'repeat-correction-command', jsonb_build_object(
  'selectedOutcome', 'applied',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'repeat-correction-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'J'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'repeat-correction-response'
  ),
  'writes', jsonb_build_array(
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 0, 'interactive', 'RC0'
    ),
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 1, 'interactive', 'RC1'
    )
  ),
  'receipt', jsonb_build_object(
    'recordVersion', (
      pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'recordVersion'
    )::integer,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'K'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'repeat-correction-receipt'
    )
  ),
  'review', null
)
from e1_values as preparation
where preparation.key = 'repeat-correction-prepare';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'repeat-correction-result', public.commit_encrypted_decision_correction(
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000001', 'e1-repeat-correction', command.value
)
from e1_values as command where command.key = 'repeat-correction-command';
reset role;
select ok(
  (select destination_note_id from public.organization_decisions
    where id = 'dec_88000000000000000000000001') =
      'note_88000000000000000000000005'
    and (select row(destination_note_id, mutation_id, receipt_revision)
      from public.capture_receipts
      where capture_id = 'cap_88000000000000000000000001') = row(
        'note_88000000000000000000000005'::text,
        (
          select member ->> 'mutationId'
          from e1_values as result
          cross join lateral jsonb_array_elements(result.value -> 'members')
            as supplied(member)
          where result.key = 'repeat-correction-result'
            and member ->> 'role' = 'destination_write'
        ),
        3::integer
      )
    and exists (
      select 1 from public.encrypted_mutation_batches as batch
      join e1_values as result on result.key = 'repeat-correction-result'
        and batch.batch_id = (result.value ->> 'batchId')::uuid
      where batch.kind = 'correction'
        and batch.anchor_mutation_id = (
          select member ->> 'mutationId'
          from jsonb_array_elements(result.value -> 'members')
            as supplied(member)
          where member ->> 'role' = 'destination_write'
        )
    ),
  'repeat correction advances decision, receipt mutation, and canonical batch anchor to C'
);
rollback to savepoint repeat_correction;

-- A correction is an immutable two-member batch whose destination write is
-- the only public Undo anchor. Rejecting the source member before preparation
-- prevents a partial inverse; the canonical Undo restores the prior routed
-- source rather than manufacturing Inbox provenance.
savepoint correction_batch_undo;
insert into e1_values(key, value)
select 'correction-batch-targets', jsonb_build_object(
  'anchorMutationId', max(member ->> 'mutationId') filter (
    where member ->> 'role' = 'destination_write'
  ),
  'sourceMutationId', max(member ->> 'mutationId') filter (
    where member ->> 'role' = 'source_removal'
  )
)
from e1_values as result
cross join lateral jsonb_array_elements(result.value -> 'members')
  as supplied(member)
where result.key = 'correction-result';
insert into e1_values(key, value)
select 'correction-non-anchor-before', jsonb_build_object(
  'events', (select coalesce(max(seq), 0) from public.user_events),
  'claims', (select count(*) from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'),
  'reservations', (select count(*)
    from public.content_key_operation_reservations
    where user_id = '88888888-8888-4888-8888-888888888888'),
  'sourceRevision', (select current_revision from public.notes
    where id = 'note_88000000000000000000000001'),
  'destinationRevision', (select current_revision from public.notes
    where id = 'note_88000000000000000000000002')
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error(format(
    'select public.get_encrypted_mutation_batch(%L,%L,%s,%L)',
    '88888888-8888-4888-8888-888888888888',
    targets.value ->> 'sourceMutationId', 3,
    'e1-correction-non-anchor'
  )) ->> 'message',
  'conflict_requires_review',
  'correction source member is rejected as a non-canonical batch anchor'
)
from e1_values as targets where targets.key = 'correction-batch-targets';
select is(
  pg_temp.caught_error(format(
    'select public.get_encrypted_mutation_batch(%L,%L,%s,%L)',
    '88888888-8888-4888-8888-888888888888',
    targets.value ->> 'sourceMutationId', 3,
    'e1-correction-non-anchor'
  )) ->> 'message',
  'conflict_requires_review',
  'correction non-anchor rejection is stable on identical retry'
)
from e1_values as targets where targets.key = 'correction-batch-targets';
reset role;
select is(
  jsonb_build_object(
    'events', (select coalesce(max(seq), 0) from public.user_events),
    'claims', (select count(*) from public.encrypted_owner_interaction_claims
      where user_id = '88888888-8888-4888-8888-888888888888'),
    'reservations', (select count(*)
      from public.content_key_operation_reservations
      where user_id = '88888888-8888-4888-8888-888888888888'),
    'sourceRevision', (select current_revision from public.notes
      where id = 'note_88000000000000000000000001'),
    'destinationRevision', (select current_revision from public.notes
      where id = 'note_88000000000000000000000002')
  ),
  (select value from e1_values where key = 'correction-non-anchor-before'),
  'non-canonical correction preparation changes no durable state or events'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-batch-undo-prepare', public.get_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  targets.value ->> 'anchorMutationId', 2, 'e1-correction-batch-undo'
)
from e1_values as targets where targets.key = 'correction-batch-targets';
reset role;
select ok(
  (select value -> 'ids' from e1_values
    where key = 'correction-batch-undo-prepare') = jsonb_build_object(
      'anchorMutationId', (select value ->> 'anchorMutationId'
        from e1_values where key = 'correction-batch-targets'),
      'sourceBatchKind', 'correction',
      'restoredSourceTargetMutationId', (select value ->> 'sourceMutationId'
        from e1_values where key = 'correction-batch-targets')
    )
    and (select jsonb_array_length(value -> 'members') from e1_values
      where key = 'correction-batch-undo-prepare') = 2
    and not exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where preparation.key = 'correction-batch-undo-prepare'
        and member ->> 'role' <> 'undo'
    )
    and exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where preparation.key = 'correction-batch-undo-prepare'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{ids,restoredSourceTargetMutationId}'
        and member ->> 'targetMutationId' <>
          preparation.value #>> '{ids,anchorMutationId}'
    )
    and (select value #>> '{source,receipt,mutationId}' from e1_values
      where key = 'correction-batch-undo-prepare') = (
        select value #>> '{ids,anchorMutationId}' from e1_values
        where key = 'correction-batch-undo-prepare'
      )
    and (select value #>> '{source,receipt,destinationNoteId}' from e1_values
      where key = 'correction-batch-undo-prepare') =
        'note_88000000000000000000000002',
  'canonical correction Undo authenticates exact batch kind and restored source member'
);
insert into e1_values(key, value)
select 'correction-batch-undo-command', jsonb_build_object(
  'selectedOutcome', 'applied',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'correction-undo-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'T'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'correction-undo-response'
  ),
  'writes', (
    select jsonb_agg(pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', (member ->> 'ordinal')::integer, 'undo',
      'CU' || (member ->> 'ordinal')
    ) order by (member ->> 'ordinal')::integer)
    from jsonb_array_elements(preparation.value -> 'members')
      as supplied(member)
  ),
  'receipt', jsonb_build_object(
    'recordVersion', (
      pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'recordVersion'
    )::integer,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'V'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'correction-undo-receipt'
    )
  ),
  'review', null
)
from e1_values as preparation
where preparation.key = 'correction-batch-undo-prepare';
insert into e1_values(key, value)
select 'correction-batch-undo-event-before',
  to_jsonb(coalesce(max(seq), 0))
from public.user_events;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-batch-undo-result', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  targets.value ->> 'anchorMutationId', 2, 'e1-correction-batch-undo',
  command.value
)
from e1_values as targets
cross join e1_values as command
where targets.key = 'correction-batch-targets'
  and command.key = 'correction-batch-undo-command';
insert into e1_values(key, value)
select 'correction-batch-undo-event-after',
  to_jsonb(coalesce(max(seq), 0))
from public.user_events;
reset role;
select ok(
  (select value ->> 'outcome' from e1_values
    where key = 'correction-batch-undo-result') = 'applied'
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000001') =
        'note_88000000000000000000000001'
    and (select row(
      outcome::text, destination_note_id, mutation_id, review_item_id,
      decision_id, reason_codes, receipt_revision
    ) from public.capture_receipts
      where capture_id = 'cap_88000000000000000000000001') = row(
        'added_to_note'::text,
        'note_88000000000000000000000001'::text,
        (
          select member ->> 'mutationId'
          from e1_values as preparation
          cross join lateral jsonb_array_elements(preparation.value -> 'members')
            as supplied(member)
          where preparation.key = 'correction-batch-undo-prepare'
            and member ->> 'targetMutationId' =
              preparation.value #>> '{ids,restoredSourceTargetMutationId}'
        ),
        null::text, 'dec_88000000000000000000000001'::text,
        array['user_undo']::text[], 3::integer
      )
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000001') = 'organized'
    and exists (
      select 1 from public.capture_note_links as link
      join e1_values as preparation
        on preparation.key = 'correction-batch-undo-prepare'
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where link.capture_id = 'cap_88000000000000000000000001'
        and link.note_id = 'note_88000000000000000000000001'
        and link.relation = 'routed'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{ids,restoredSourceTargetMutationId}'
        and link.mutation_id = member ->> 'mutationId'
    )
    and exists (
      select 1 from public.capture_note_links as link
      join e1_values as targets on targets.key = 'correction-batch-targets'
      where link.capture_id = 'cap_88000000000000000000000001'
        and link.note_id = 'note_88000000000000000000000002'
        and link.mutation_id = targets.value ->> 'anchorMutationId'
        and link.relation = 'source_removed'
    )
    and exists (
      select 1
      from public.note_mutations as mutation
      join e1_values as preparation
        on preparation.key = 'correction-batch-undo-prepare'
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where mutation.id = member ->> 'mutationId'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{ids,restoredSourceTargetMutationId}'
        and mutation.decision_id = 'dec_88000000000000000000000001'
    )
    and exists (
      select 1
      from public.note_mutations as mutation
      join e1_values as preparation
        on preparation.key = 'correction-batch-undo-prepare'
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      where mutation.id = member ->> 'mutationId'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{ids,anchorMutationId}'
        and mutation.decision_id is null
    )
    and (select row(current_revision, privacy::text) from public.notes
      where id = 'note_88000000000000000000000001') =
        row(4::integer, 'ai_assisted'::text)
    and (select deleted_at is null from public.notes
      where id = 'note_88000000000000000000000001')
    and (select current_revision from public.notes
      where id = 'note_88000000000000000000000002') = 3
    and not exists (
      select 1
      from e1_values as targets
      cross join lateral jsonb_each_text(targets.value) as mutation(key, id)
      join public.note_mutations as stored on stored.id = mutation.id
      where targets.key = 'correction-batch-targets'
        and stored.undone_at is null
    ),
  'applied correction Undo restores the soft-deleted source and routed provenance'
);
select ok(
  (select jsonb_agg(
      jsonb_build_array(event.entity, event.entity_id)
      order by event.entity, event.entity_id
    )
    from public.user_events as event
    where event.seq > (
      select (value::text)::bigint from e1_values
      where key = 'correction-batch-undo-event-before'
    )) = (
      select jsonb_agg(
        jsonb_build_array(expected.entity, expected.entity_id)
        order by expected.entity, expected.entity_id
      )
      from (
        values
          ('capture', 'cap_88000000000000000000000001'),
          ('capture_note_link', 'note_88000000000000000000000001'),
          ('capture_note_link', 'note_88000000000000000000000002'),
          ('capture_receipt', 'cap_88000000000000000000000001'),
          ('note', 'note_88000000000000000000000001'),
          ('note', 'note_88000000000000000000000002'),
          ('organization_decision', 'dec_88000000000000000000000001')
        union all
        select 'note_revision', member ->> 'revisionId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(preparation.value -> 'members')
          as supplied(member)
        where preparation.key = 'correction-batch-undo-prepare'
        union all
        select 'note_mutation', member ->> 'mutationId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(preparation.value -> 'members')
          as supplied(member)
        where preparation.key = 'correction-batch-undo-prepare'
      ) as expected(entity, entity_id)
    ),
  'correction Undo publishes the exact routed provenance and note event set'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-batch-undo-prepare-replay',
  public.get_encrypted_mutation_batch(
    '88888888-8888-4888-8888-888888888888',
    targets.value ->> 'anchorMutationId', 2, 'e1-correction-batch-undo'
  )
from e1_values as targets
where targets.key = 'correction-batch-targets';
reset role;
select ok(
  (select (value ->> 'completed')::boolean
    from e1_values where key = 'correction-batch-undo-prepare-replay')
    and (select (value ->> 'replayed')::boolean
      from e1_values where key = 'correction-batch-undo-prepare-replay')
    and (select value -> 'ids'
      from e1_values where key = 'correction-batch-undo-prepare-replay') =
      (select value -> 'ids'
        from e1_values where key = 'correction-batch-undo-prepare')
    and (select value -> 'members'
      from e1_values where key = 'correction-batch-undo-prepare-replay') =
      '[]'::jsonb,
  'completed correction Undo prepare replay preserves exact source-batch coordinates'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'move-after-correction-undo-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000001', 'e1-move-after-correction-undo',
    '{"source":{"noteId":"note_88000000000000000000000001","expectedRevision":4},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000005","expectedRevision":1}}'::jsonb
  );
reset role;
select ok(
  (select value #>> '{ids,sourceNoteId}' from e1_values
    where key = 'move-after-correction-undo-prepare') =
      'note_88000000000000000000000001'
    and (select value #>> '{source,receipt,mutationId}' from e1_values
      where key = 'move-after-correction-undo-prepare') = (
        select member ->> 'mutationId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(preparation.value -> 'members')
          as supplied(member)
        where preparation.key = 'correction-batch-undo-prepare'
          and member ->> 'targetMutationId' =
            preparation.value #>> '{ids,restoredSourceTargetMutationId}'
      )
    and exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(preparation.value -> 'members')
        as supplied(member)
      join public.note_mutations as mutation
        on mutation.id = member ->> 'targetMutationId'
      where preparation.key = 'move-after-correction-undo-prepare'
        and member ->> 'role' = 'source_removal'
        and mutation.decision_id = 'dec_88000000000000000000000001'
        and member ->> 'targetMutationId' =
          preparation.value #>> '{source,receipt,mutationId}'
    ),
  'restored-source Undo mutation preserves decision lineage for the next Move'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-batch-undo-replay', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  targets.value ->> 'anchorMutationId', 2, 'e1-correction-batch-undo',
  jsonb_build_object(
    'selectedOutcome', 'applied',
    'requestMac', command.value -> 'requestMac'
  )
)
from e1_values as targets
cross join e1_values as command
where targets.key = 'correction-batch-targets'
  and command.key = 'correction-batch-undo-command';
reset role;
select ok(
  (select (value ->> 'replayed')::boolean from e1_values
    where key = 'correction-batch-undo-replay')
    and (select coalesce(max(seq), 0) from public.user_events) = (
      select (value::text)::bigint from e1_values
      where key = 'correction-batch-undo-event-after'
    )
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000001') =
        'note_88000000000000000000000001',
  'correction Undo replay changes no restored provenance or events'
);
rollback to savepoint correction_batch_undo;

-- Batch membership is derived from authenticated server lineage, never from
-- caller-supplied arrays. The web service chooses a branch only after decrypting
-- every member and proving all exact inverses.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'batch-prepare',
  public.get_encrypted_mutation_batch(
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000003', 2, 'e1-batch-undo'
  )
);
select ok(
  (select value - array[
      'scope','occurredAt','completed','replayed','selectedOutcome',
      'requestMacKey','ids','source','members','commonReservations',
      'branches','encryptedResponse','encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'batch-prepare')
    and (select value ->> 'scope'
      from e1_values where key = 'batch-prepare')
      = 'encrypted_mutation_batch_undo'
    and (select value -> 'ids'
      from e1_values where key = 'batch-prepare')
      = jsonb_build_object(
        'anchorMutationId', 'mut_88000000000000000000000003',
        'sourceBatchKind', 'organization',
        'restoredSourceTargetMutationId', null
      )
    and (select jsonb_array_length(value -> 'members')
      from e1_values where key = 'batch-prepare') = 3
    and (select value #> '{source,capture}'
      from e1_values where key = 'batch-prepare') = 'null'::jsonb
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'batch-prepare') = 'null'::jsonb,
  'batch preparation has the exact outcome-neutral shape and three derived members'
);
select ok(
  (
    select array_agg(item ->> 'targetMutationId' order by item ->> 'targetMutationId')
    from e1_values as preparation
    cross join lateral jsonb_array_elements(
      preparation.value -> 'members'
    ) as supplied(item)
    where preparation.key = 'batch-prepare'
  ) = array[
    'mut_88000000000000000000000003',
    'mut_88000000000000000000000004',
    'mut_88000000000000000000000006'
  ]::text[]
    and (select jsonb_array_length(value -> 'commonReservations')
      from e1_values where key = 'batch-prepare') = 2
    and (select jsonb_array_length(
      value #> '{branches,applied,reservations}'
    ) from e1_values where key = 'batch-prepare') = 9
    and (select jsonb_array_length(
      value #> '{branches,needsReview,reservations}'
    ) from e1_values where key = 'batch-prepare') = 1
    and (select (value #> '{branches,applied}') - array[
        'available','batchId','reservations'
      ] from e1_values where key = 'batch-prepare') = '{}'::jsonb
    and (select (value #> '{branches,needsReview}') - array[
        'available','reviewItemId','reservations'
      ] from e1_values where key = 'batch-prepare') = '{}'::jsonb,
  'batch preparation derives ordered 1..16 membership and both complete plans'
);
select ok(
  (
    select jsonb_object_agg(item ->> 'targetMutationId', item ->> 'targetPrivacy')
    from e1_values as preparation
    cross join lateral jsonb_array_elements(
      preparation.value -> 'members'
    ) as supplied(item)
    where preparation.key = 'batch-prepare'
  ) = jsonb_build_object(
    'mut_88000000000000000000000003', 'private_manual',
    'mut_88000000000000000000000004', 'ai_assisted',
    'mut_88000000000000000000000006', 'ai_assisted'
  )
    and (select value #>> '{requestMacKey,keyClass}'
      from e1_values where key = 'batch-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'needs_review', 'review'
    ) ->> 'keyClass' from e1_values where key = 'batch-prepare')
      = 'private_manual'
    and (
      select jsonb_object_agg(
        reservation ->> 'role', reservation ->> 'keyClass'
      )
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value #> '{branches,applied,reservations}'
      ) as supplied(reservation)
      where preparation.key = 'batch-prepare'
        and reservation ->> 'surface' in ('note_revision','note_mutation')
    ) = jsonb_build_object(
      'note_revision:0', 'private_manual',
      'note_mutation:0', 'private_manual',
      'note_revision:1', 'private_manual',
      'note_mutation:1', 'private_manual',
      'note_revision:2', 'ai_assisted',
      'note_mutation:2', 'ai_assisted'
    ),
  'batch projects sticky aggregate Review and independent member history classes'
);

insert into e1_values(key, value)
select 'batch-replay', public.get_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-undo'
);
select ok(
  (select (value ->> 'replayed')::boolean
    from e1_values where key = 'batch-replay')
    and (select value - 'replayed' from e1_values where key = 'batch-replay')
      = (select value - 'replayed'
        from e1_values where key = 'batch-prepare'),
  'batch discovery replay preserves the server-derived group and every stable ID'
);

insert into e1_values(key, value)
select 'batch-command', jsonb_build_object(
  'selectedOutcome', 'needs_review',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-batch-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'B'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-batch-response'
  ),
  'writes', '[]'::jsonb,
  'receipt', jsonb_build_object(
    'recordVersion', 2,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'U'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'e1-batch-receipt'
    )
  ),
  'review', jsonb_build_object(
    'reviewItemId', preparation.value #>> '{branches,needsReview,reviewItemId}',
    'recordVersion', 1,
    'type', 'revision_conflict',
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'needs_review', 'review'), 'W'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'needs_review', 'review'
      ) ->> 'keyClass'),
      'e1-batch-review'
    )
  )
)
from e1_values as preparation where preparation.key = 'batch-prepare';

insert into e1_values(key, value)
select 'batch-result', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-undo', value
)
from e1_values where key = 'batch-command';

reset role;
select ok(
  (select value - array[
      'scope','outcome','decisionId','reviewItemId','feedbackEventId',
      'batchId','members','encryptedResponse','responseVerificationMac',
      'replayed'
    ] = '{}'::jsonb
    from e1_values where key = 'batch-result')
    and (select value ->> 'outcome'
      from e1_values where key = 'batch-result') = 'needs_review'
    and (select value ->> 'reviewItemId'
      from e1_values where key = 'batch-result')
      = (select value #>> '{branches,needsReview,reviewItemId}'
        from e1_values where key = 'batch-prepare')
    and (select value -> 'batchId'
      from e1_values where key = 'batch-result') = 'null'::jsonb
    and (select value -> 'members'
      from e1_values where key = 'batch-result') = '[]'::jsonb
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'batch-result')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'batch-command'),
  'unsafe batch undo atomically returns conflict_requires_review evidence'
);
select ok(
  (select current_revision from public.notes
    where id = 'note_88000000000000000000000003') = 2
    and (select current_revision from public.notes
      where id = 'note_88000000000000000000000004') = 2
    and (select current_revision from public.notes
      where id = 'note_88000000000000000000000006') = 2
    and not exists (
      select 1 from public.note_mutations
      where id in (
        'mut_88000000000000000000000003',
        'mut_88000000000000000000000004',
        'mut_88000000000000000000000006'
      ) and undone_at is not null
    )
    and not exists (
      select 1 from public.encrypted_mutation_batches
      where batch_id = (
        select (value #>> '{branches,applied,batchId}')::uuid
        from e1_values where key = 'batch-prepare'
      )
    ),
  'unsafe batch undo changes zero notes and publishes no applied batch'
);
select ok(
  exists (
    select 1 from public.review_items
    where id = (
      select value ->> 'reviewItemId'
      from e1_values where key = 'batch-result'
    ) and state = 'open' and type = 'revision_conflict'
      and review_content_revision = 1
  )
    and (select row(
      outcome::text, review_item_id, receipt_revision, decision_id,
      destination_note_id, mutation_id
    ) from public.capture_receipts
      where capture_id = 'cap_88000000000000000000000002')
      = row(
        'needs_review'::text,
        (select value ->> 'reviewItemId'
          from e1_values where key = 'batch-result'),
        2::integer, null::text, null::text, null::text
      )
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000002') =
        'note_88000000000000000000000003'
    and (select count(*) from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000002'
        and relation = 'routed') = 3
    and (
      select count(*)
      from public.content_key_operation_reservations as reservation
      join public.encrypted_owner_interaction_reservations as binding
        on binding.user_id = reservation.user_id
        and binding.reservation_id = reservation.reservation_id
      where binding.user_id = '88888888-8888-4888-8888-888888888888'
        and binding.idempotency_key = 'e1-batch-undo'
        and reservation.consumed_at is not null
    ) = 12,
  'unsafe batch persists one encrypted Review and invalidates the unused applied branch'
);

-- A failed batch Undo leaves the already-organized note graph untouched. Its
-- replacement receipt intentionally drops decision lineage, which is the
-- authenticated availability signal for a Review that supports only
-- keep-in-Inbox/dismiss rather than a second route/create over unchanged note
-- content.
savepoint batch_conflict_review;
insert into e1_values(key, value)
select 'batch-conflict-reroute-reservations-before', to_jsonb(count(*))
from public.content_key_operation_reservations;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error(format(
    $statement$
      select public.prepare_encrypted_review_resolution(
        %L, %L, %L,
        '{"type":"route","noteId":"note_88000000000000000000000002","expectedRevision":2}'::jsonb
      )
    $statement$,
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-route'
  )) ->> 'message',
  'not_found',
  'batch-conflict Review rejects route without receipt decision lineage'
)
from e1_values as result
where result.key = 'batch-result';
select is(
  pg_temp.caught_error(format(
    $statement$
      select public.prepare_encrypted_review_resolution(
        %L, %L, %L,
        '{"type":"create","noteType":"generic","spaceId":null}'::jsonb
      )
    $statement$,
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-create'
  )) ->> 'message',
  'not_found',
  'batch-conflict Review rejects create without receipt decision lineage'
)
from e1_values as result
where result.key = 'batch-result';
reset role;
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key in (
        'e1-batch-conflict-route', 'e1-batch-conflict-create'
      )
  ) and not exists (
    select 1 from public.encrypted_owner_interaction_reservations
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key in (
        'e1-batch-conflict-route', 'e1-batch-conflict-create'
      )
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key in (
        'e1-batch-conflict-route', 'e1-batch-conflict-create'
      )
  ) and (select count(*) from public.content_key_operation_reservations) = (
    select (value::text)::bigint from e1_values
    where key = 'batch-conflict-reroute-reservations-before'
  ),
  'rejected batch-conflict reroutes leave no claim or reservation state'
);
savepoint batch_conflict_dismiss;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-conflict-dismiss-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-dismiss',
    '{"type":"dismiss"}'::jsonb
  )
from e1_values as result
where result.key = 'batch-result';
reset role;
select ok(
  (select value #> '{source,receipt,decisionId}' from e1_values
    where key = 'batch-conflict-dismiss-prepare') = 'null'::jsonb
    and (select jsonb_array_length(value -> 'reservations') from e1_values
      where key = 'batch-conflict-dismiss-prepare') = 2,
  'batch-conflict Review keeps metadata-only dismiss available'
);
rollback to savepoint batch_conflict_dismiss;
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-keep-inbox',
    '{"type":"keep_inbox"}'::jsonb
  )
from e1_values as result
where result.key = 'batch-result';
reset role;
select ok(
  (select value #> '{source,receipt,decisionId}' from e1_values
    where key = 'batch-conflict-keep-inbox-prepare') = 'null'::jsonb
    and (select value #> '{source,decision}' from e1_values
      where key = 'batch-conflict-keep-inbox-prepare') = 'null'::jsonb
    and (select jsonb_array_length(value -> 'reservations') from e1_values
      where key = 'batch-conflict-keep-inbox-prepare') = 3,
  'batch-conflict Review exposes a bound receipt without routable decision data'
);
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, false, true,
  'batch-conflict-keep-inbox'
)
from e1_values where key = 'batch-conflict-keep-inbox-prepare';
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-event-before',
  to_jsonb(coalesce(max(seq), 0))
from public.user_events;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-result',
  public.commit_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-keep-inbox',
    command.value
  )
from e1_values as result
cross join e1_values as command
where result.key = 'batch-result'
  and command.key = 'batch-conflict-keep-inbox-command';
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-event-after',
  to_jsonb(coalesce(max(seq), 0))
from public.user_events;
reset role;
select ok(
  (select row(
      outcome::text, decision_id, destination_note_id, mutation_id,
      review_item_id, receipt_revision
    ) from public.capture_receipts
    where capture_id = 'cap_88000000000000000000000002') = row(
      'kept_in_inbox'::text, null::text, null::text, null::text,
      (select value ->> 'reviewItemId'
        from e1_values where key = 'batch-result'), 3::integer
    )
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000002') = 'inbox'
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000002') =
        'note_88000000000000000000000003'
    and (select count(*) from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000002'
        and relation = 'routed') = 3
    and exists (
      select 1 from public.review_items as review
      join e1_values as result on result.key = 'batch-result'
        and result.value ->> 'reviewItemId' = review.id
      where review.state = 'resolved'
        and review.review_content_revision = 2
    ),
  'batch-conflict keep_inbox preserves organized provenance while returning the raw capture'
);
select is(
  (select jsonb_agg(jsonb_build_array(entity, entity_id)
    order by entity, entity_id)
    from public.user_events
    where seq > (
      select (value::text)::bigint from e1_values
      where key = 'batch-conflict-keep-inbox-event-before'
    )),
  jsonb_build_array(
    jsonb_build_array('capture', 'cap_88000000000000000000000002'),
    jsonb_build_array(
      'capture_receipt', 'cap_88000000000000000000000002'
    ),
    jsonb_build_array(
      'review_item', (select value ->> 'reviewItemId'
        from e1_values where key = 'batch-result')
    )
  ),
  'batch-conflict keep_inbox emits only Review, receipt, and capture invalidations'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-conflict-keep-inbox-replay',
  public.commit_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    result.value ->> 'reviewItemId', 'e1-batch-conflict-keep-inbox',
    jsonb_build_object('requestMac', command.value -> 'requestMac')
  )
from e1_values as result
cross join e1_values as command
where result.key = 'batch-result'
  and command.key = 'batch-conflict-keep-inbox-command';
reset role;
select ok(
  (select (value ->> 'replayed')::boolean from e1_values
    where key = 'batch-conflict-keep-inbox-replay')
    and (select coalesce(max(seq), 0) from public.user_events) = (
      select (value::text)::bigint from e1_values
      where key = 'batch-conflict-keep-inbox-event-after'
    ),
  'batch-conflict keep_inbox replay changes no durable state or events'
);
rollback to savepoint batch_conflict_review;
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-completed-prepare', public.get_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-undo'
);
select ok(
  (select value - array[
      'scope','occurredAt','completed','replayed','selectedOutcome',
      'requestMacKey','ids','source','members','commonReservations',
      'branches','encryptedResponse','encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'batch-completed-prepare')
    and (select (value ->> 'completed')::boolean
      from e1_values where key = 'batch-completed-prepare')
    and (select (value ->> 'replayed')::boolean
      from e1_values where key = 'batch-completed-prepare')
    and (select value -> 'source'
      from e1_values where key = 'batch-completed-prepare') = 'null'::jsonb
    and (select value -> 'members'
      from e1_values where key = 'batch-completed-prepare') = '[]'::jsonb
    and (select value -> 'commonReservations'
      from e1_values where key = 'batch-completed-prepare') = '[]'::jsonb
    and (select value #> '{branches,applied,reservations}'
      from e1_values where key = 'batch-completed-prepare') = '[]'::jsonb
    and (select value #> '{branches,needsReview,reservations}'
      from e1_values where key = 'batch-completed-prepare') = '[]'::jsonb
    and (select (value #> '{branches,applied}') - array[
        'available','batchId','reservations'
      ] from e1_values where key = 'batch-completed-prepare') = '{}'::jsonb
    and (select (value #> '{branches,needsReview}') - array[
        'available','reviewItemId','reservations'
      ] from e1_values where key = 'batch-completed-prepare') = '{}'::jsonb
    and not (select (value #>> '{branches,applied,available}')::boolean
      from e1_values where key = 'batch-completed-prepare')
    and (select (value #>> '{branches,needsReview,available}')::boolean
      from e1_values where key = 'batch-completed-prepare')
    and (select value #>> '{branches,applied,batchId}'
      from e1_values where key = 'batch-completed-prepare')
      = (select value #>> '{branches,applied,batchId}'
        from e1_values where key = 'batch-prepare')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'batch-completed-prepare')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'batch-result')
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'batch-completed-prepare')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'batch-result'),
  'completed batch prepare returns only immutable replay coordinates and proof'
);
insert into e1_values(key, value)
select 'batch-commit-replay', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-undo',
  jsonb_build_object(
    'selectedOutcome', 'needs_review',
    'requestMac', command.value -> 'requestMac'
  )
)
from e1_values as command where command.key = 'batch-command';
select ok(
  (select (value ->> 'replayed')::boolean
    from e1_values where key = 'batch-commit-replay')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'batch-commit-replay')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'batch-result')
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'batch-commit-replay')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'batch-result'),
  'completed batch undo replays without resealing consumed reservations'
);

-- The applied branch is independently valid for the same unchanged source
-- batch. It must restore Inbox provenance, clear the decisions that authored
-- the undone mutations, and publish one exact atomic invalidation set.
savepoint batch_applied;
insert into e1_values(key, value) values (
  'batch-applied-prepare', public.get_encrypted_mutation_batch(
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000003', 2, 'e1-batch-applied'
  )
);
insert into e1_values(key, value)
select 'batch-applied-command', jsonb_build_object(
  'selectedOutcome', 'applied',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-batch-applied-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'A'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-batch-applied-response'
  ),
  'writes', jsonb_build_array(
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 0, 'undo', 'A0'
    ),
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 1, 'undo', 'A1'
    ),
    pg_temp.e1_write(
      '88888888-8888-4888-8888-888888888888', preparation.value,
      'applied', 2, 'undo', 'A2'
    )
  ),
  'receipt', jsonb_build_object(
    'recordVersion', 3,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'A'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'e1-batch-applied-receipt'
    )
  ),
  'review', null
)
from e1_values as preparation
where preparation.key = 'batch-applied-prepare';
insert into e1_values(key, value)
select 'batch-applied-event-before', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
insert into e1_values(key, value)
select 'batch-applied-result', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-applied', value
)
from e1_values where key = 'batch-applied-command';
insert into e1_values(key, value)
select 'batch-applied-event-after', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
reset role;
select ok(
  (select destination_note_id from public.organization_decisions
    where id = 'dec_88000000000000000000000002') is null
    and (select row(outcome::text, receipt_revision, destination_note_id,
      mutation_id, review_item_id)
      from public.capture_receipts
      where capture_id = 'cap_88000000000000000000000002') = row(
        'kept_in_inbox'::text, 3, null::text, null::text, null::text
      )
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000002') = 'inbox'
    and not exists (
      select 1 from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000002'
        and relation = 'routed'
    ),
  'applied batch undo atomically clears decision and restores Inbox provenance'
);
select ok(
  (select jsonb_agg(
      jsonb_build_array(event.entity, event.entity_id)
      order by event.entity, event.entity_id
    )
    from public.user_events as event
    where event.seq > (
      select (value::text)::bigint from e1_values
      where key = 'batch-applied-event-before'
    )) = (
      select jsonb_agg(
        jsonb_build_array(expected.entity, expected.entity_id)
        order by expected.entity, expected.entity_id
      )
      from (
        values
          ('capture', 'cap_88000000000000000000000002'),
          ('capture_note_link', 'note_88000000000000000000000003'),
          ('capture_note_link', 'note_88000000000000000000000004'),
          ('capture_note_link', 'note_88000000000000000000000006'),
          ('capture_receipt', 'cap_88000000000000000000000002'),
          ('note', 'note_88000000000000000000000003'),
          ('note', 'note_88000000000000000000000004'),
          ('note', 'note_88000000000000000000000006'),
          ('organization_decision', 'dec_88000000000000000000000002')
        union all
        select 'note_revision', member ->> 'revisionId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(
          preparation.value -> 'members'
        ) as supplied(member)
        where preparation.key = 'batch-applied-prepare'
        union all
        select 'note_mutation', member ->> 'mutationId'
        from e1_values as preparation
        cross join lateral jsonb_array_elements(
          preparation.value -> 'members'
        ) as supplied(member)
        where preparation.key = 'batch-applied-prepare'
      ) as expected(entity, entity_id)
    ),
  'applied batch publishes the exact note, lineage, and capture event set'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'batch-applied-replay', public.undo_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000003', 2, 'e1-batch-applied',
  jsonb_build_object(
    'selectedOutcome', 'applied',
    'requestMac', value -> 'requestMac'
  )
)
from e1_values where key = 'batch-applied-command';
reset role;
select ok(
  (select (value ->> 'replayed')::boolean from e1_values
    where key = 'batch-applied-replay')
    and (select coalesce(max(seq), 0) from public.user_events) = (
      select (value::text)::bigint from e1_values
      where key = 'batch-applied-event-after'
    )
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000002') is null,
  'applied batch replay changes no durable state and emits no events'
);

-- A successful E1 Undo batch is a terminal, one-level history unit. Every
-- generated member must fail with the same stable conflict before a new claim,
-- reservation, write, or event can be created. Cover two members so a
-- non-anchor member cannot bypass the batch-level guard.
insert into e1_values(key, value)
select 'batch-undo-of-undo-before', jsonb_build_object(
  'eventCursor', (select coalesce(max(seq), 0) from public.user_events),
  'claims', (select count(*)
    from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'),
  'reservations', (select count(*)
    from public.content_key_operation_reservations
    where user_id = '88888888-8888-4888-8888-888888888888'),
  'notes', (select jsonb_agg(
      jsonb_build_array(note.id, note.current_revision, note.deleted_at)
      order by note.id
    )
    from public.notes as note
    where note.user_id = '88888888-8888-4888-8888-888888888888'),
  'mutations', (select jsonb_agg(
      jsonb_build_array(mutation.id, mutation.undone_at)
      order by mutation.id
    )
    from public.note_mutations as mutation
    where mutation.user_id = '88888888-8888-4888-8888-888888888888'),
  'batches', (select jsonb_agg(
      jsonb_build_array(batch.batch_id, batch.kind, batch.anchor_mutation_id)
      order by batch.batch_id
    )
    from public.encrypted_mutation_batches as batch
    where batch.user_id = '88888888-8888-4888-8888-888888888888'),
  'members', (select jsonb_agg(
      jsonb_build_array(member.batch_id, member.ordinal, member.mutation_id)
      order by member.batch_id, member.ordinal
    )
    from public.encrypted_mutation_batch_members as member
    where member.user_id = '88888888-8888-4888-8888-888888888888')
);
insert into e1_values(key, value)
select 'batch-undo-of-undo-targets', jsonb_build_object(
  'anchorMutationId', batch.anchor_mutation_id,
  'nonAnchorMutationId', (
    select member.mutation_id
    from public.encrypted_mutation_batch_members as member
    where member.user_id = batch.user_id
      and member.batch_id = batch.batch_id
      and member.mutation_id <> batch.anchor_mutation_id
    order by member.ordinal
    limit 1
  )
)
from public.encrypted_mutation_batches as batch
join e1_values as result on result.key = 'batch-applied-result'
  and batch.batch_id = (result.value ->> 'batchId')::uuid
where batch.user_id = '88888888-8888-4888-8888-888888888888';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error(format(
    'select public.get_encrypted_mutation_batch(%L,%L,%s,%L)',
    '88888888-8888-4888-8888-888888888888',
    targets.value ->> 'anchorMutationId', 3,
    'e1-batch-undo-of-undo-first'
  )) ->> 'message',
  'conflict_requires_review',
  'batch prepare rejects an Undo-generated member with the stable conflict'
)
from e1_values as targets where targets.key = 'batch-undo-of-undo-targets';
select is(
  pg_temp.caught_error(format(
    'select public.get_encrypted_mutation_batch(%L,%L,%s,%L)',
    '88888888-8888-4888-8888-888888888888',
    targets.value ->> 'nonAnchorMutationId', 3,
    'e1-batch-undo-of-undo-second'
  )) ->> 'message',
  'conflict_requires_review',
  'batch prepare rejects an equivalent non-anchor Undo-generated member'
)
from e1_values as targets where targets.key = 'batch-undo-of-undo-targets';
reset role;
select is(
  jsonb_build_object(
    'eventCursor', (select coalesce(max(seq), 0) from public.user_events),
    'claims', (select count(*)
      from public.encrypted_owner_interaction_claims
      where user_id = '88888888-8888-4888-8888-888888888888'),
    'reservations', (select count(*)
      from public.content_key_operation_reservations
      where user_id = '88888888-8888-4888-8888-888888888888'),
    'notes', (select jsonb_agg(
        jsonb_build_array(note.id, note.current_revision, note.deleted_at)
        order by note.id
      )
      from public.notes as note
      where note.user_id = '88888888-8888-4888-8888-888888888888'),
    'mutations', (select jsonb_agg(
        jsonb_build_array(mutation.id, mutation.undone_at)
        order by mutation.id
      )
      from public.note_mutations as mutation
      where mutation.user_id = '88888888-8888-4888-8888-888888888888'),
    'batches', (select jsonb_agg(
        jsonb_build_array(batch.batch_id, batch.kind, batch.anchor_mutation_id)
        order by batch.batch_id
      )
      from public.encrypted_mutation_batches as batch
      where batch.user_id = '88888888-8888-4888-8888-888888888888'),
    'members', (select jsonb_agg(
        jsonb_build_array(member.batch_id, member.ordinal, member.mutation_id)
        order by member.batch_id, member.ordinal
      )
      from public.encrypted_mutation_batch_members as member
      where member.user_id = '88888888-8888-4888-8888-888888888888')
  ),
  (select value from e1_values where key = 'batch-undo-of-undo-before'),
  'rejected undo-of-undo changes no durable state and emits no events'
);
rollback to savepoint batch_applied;

-- Review resolution is action-specific because the public resolution already
-- fixes the intended action. Its current encrypted revision is owner-derived.
reset role;
insert into e1_values(key, value)
select 'captureless-keep-inbox-reservations-before', to_jsonb(count(*))
from public.content_key_operation_reservations
where user_id = '88888888-8888-4888-8888-888888888888';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000001',
      'e1-review-captureless-keep-inbox',
      '{"type":"keep_inbox"}'::jsonb
    )
  $statement$) ->> 'message',
  'validation_failed',
  'captureless Review rejects keep_inbox before preparing an impossible receipt write'
);
reset role;
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-captureless-keep-inbox'
  ) and not exists (
    select 1 from public.encrypted_owner_interaction_reservations
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-captureless-keep-inbox'
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-captureless-keep-inbox'
  ) and not exists (
    select 1 from public.content_encryption_verifications
    where user_id = '88888888-8888-4888-8888-888888888888'
      and resource_id = 'idempotency:e1-review-captureless-keep-inbox'
  ) and (select count(*) from public.content_key_operation_reservations
      where user_id = '88888888-8888-4888-8888-888888888888') = (
    select (value::text)::bigint from e1_values
    where key = 'captureless-keep-inbox-reservations-before'
  ),
  'rejected captureless keep_inbox leaves no claim, reservation, or replay state'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000001', 'e1-review-dismiss',
    '{"type":"dismiss"}'::jsonb
  )
);
select ok(
  (select value - array[
      'scope','action','occurredAt','completed','replayed','requestMacKey',
      'ids','source','members','reservations','encryptedResponse',
      'encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'review-prepare')
    and (select value ->> 'scope'
      from e1_values where key = 'review-prepare')
      = 'encrypted_review_resolution'
    and (select value ->> 'action'
      from e1_values where key = 'review-prepare') = 'dismiss'
    and (select value -> 'ids'
      from e1_values where key = 'review-prepare') = jsonb_build_object(
        'reviewItemId', 'rvw_88000000000000000000000001',
        'destinationNoteId', null,
        'destinationRevisionId', null,
        'destinationMutationId', null
      )
    and (select jsonb_array_length(value -> 'members')
      from e1_values where key = 'review-prepare') = 0
    and (select jsonb_array_length(value -> 'reservations')
      from e1_values where key = 'review-prepare') = 2
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'review-prepare') = 'null'::jsonb,
  'dismiss Review preparation has the exact action-specific wire shape'
);
select ok(
  (select value #>> '{source,review,createdAt}'
    from e1_values where key = 'review-prepare') is not null
    and (select value #> '{source,review,resolvedAt}'
      from e1_values where key = 'review-prepare') = 'null'::jsonb
    and (select value #>> '{source,review,recordVersion}'
      from e1_values where key = 'review-prepare') = '1',
  'Review discovery authenticates its original timestamps and current revision'
);

insert into e1_values(key, value)
select 'review-command', jsonb_build_object(
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-review-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'X'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'e1-review-response'
  ),
  'writes', '[]'::jsonb,
  'receipt', null,
  'review', jsonb_build_object(
    'reviewItemId', 'rvw_88000000000000000000000001',
    'recordVersion', 2,
    'type', 'low_confidence',
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'review'), 'Y'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'review'
      ) ->> 'keyClass'),
      'e1-review-proof'
    )
  )
)
from e1_values as preparation where preparation.key = 'review-prepare';

insert into e1_values(key, value)
select 'review-result', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000001', 'e1-review-dismiss', value
)
from e1_values where key = 'review-command';

reset role;
select ok(
  (select value - array[
      'scope','outcome','decisionId','reviewItemId','feedbackEventId',
      'batchId','members','encryptedResponse','responseVerificationMac',
      'replayed'
    ] = '{}'::jsonb
    from e1_values where key = 'review-result')
    and (select value ->> 'outcome'
      from e1_values where key = 'review-result') = 'dismissed'
    and (select value ->> 'reviewItemId'
      from e1_values where key = 'review-result')
      = 'rvw_88000000000000000000000001'
    and (select row(state::text,review_content_revision,resolved_at is not null)
      from public.review_items
      where id = 'rvw_88000000000000000000000001')
      = row('dismissed'::text,2::integer,true)
    and exists (
      select 1 from public.feedback_events
      where review_item_id = 'rvw_88000000000000000000000001'
        and action = 'review_resolved' and reason_code = 'dismiss'
    )
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'review-result')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'review-command'),
  'dismiss commits one encrypted Review revision and content-free feedback'
);
select is(
  pg_temp.caught_error($statement$
    update public.encrypted_owner_interaction_members
    set role = role
    where idempotency_key = 'e1-correction-safe'
  $statement$) ->> 'message',
  'immutable_owner_interaction',
  'prepared member snapshots are immutable'
);
select is(
  pg_temp.caught_error($statement$
    update public.encrypted_mutation_batches
    set kind = kind
    where batch_id = (
      select (value ->> 'batchId')::uuid
      from e1_values where key = 'correction-result'
    )
  $statement$) ->> 'message',
  'immutable_owner_interaction',
  'committed mutation-batch history is immutable'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'review-completed-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000001', 'e1-review-dismiss',
    '{"type":"dismiss"}'::jsonb
  );
select ok(
  (select value - array[
      'scope','action','occurredAt','completed','replayed','requestMacKey',
      'ids','source','members','reservations','encryptedResponse',
      'encryptedResponseVerificationMac'
    ] = '{}'::jsonb
    from e1_values where key = 'review-completed-prepare')
    and (select (value ->> 'completed')::boolean
      from e1_values where key = 'review-completed-prepare')
    and (select (value ->> 'replayed')::boolean
      from e1_values where key = 'review-completed-prepare')
    and (select value -> 'source'
      from e1_values where key = 'review-completed-prepare') = 'null'::jsonb
    and (select value -> 'members'
      from e1_values where key = 'review-completed-prepare') = '[]'::jsonb
    and (select value -> 'reservations'
      from e1_values where key = 'review-completed-prepare') = '[]'::jsonb
    and (select value -> 'ids'
      from e1_values where key = 'review-completed-prepare')
      = (select value -> 'ids'
        from e1_values where key = 'review-prepare')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'review-completed-prepare')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'review-result')
    and (select value -> 'encryptedResponseVerificationMac'
      from e1_values where key = 'review-completed-prepare')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'review-result'),
  'completed Review prepare returns only immutable replay coordinates and proof'
);
insert into e1_values(key, value)
select 'review-commit-replay', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000001', 'e1-review-dismiss',
  jsonb_build_object('requestMac', command.value -> 'requestMac')
)
from e1_values as command where command.key = 'review-command';
select ok(
  (select (value ->> 'replayed')::boolean
    from e1_values where key = 'review-commit-replay')
    and (select value -> 'encryptedResponse'
      from e1_values where key = 'review-commit-replay')
      = (select value -> 'encryptedResponse'
        from e1_values where key = 'review-result')
    and (select value -> 'responseVerificationMac'
      from e1_values where key = 'review-commit-replay')
      = (select value -> 'responseVerificationMac'
        from e1_values where key = 'review-result'),
  'completed Review resolution replays with only requestMac'
);
reset role;

-- Capture-linked Review routing keeps decision lineage for CAS and mutation
-- history without disclosing decision ciphertext on the Review source wire.
savepoint review_route;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-route-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 'e1-review-route',
    '{"type":"route","noteId":"note_88000000000000000000000005","expectedRevision":1}'::jsonb
  )
);
reset role;
select ok(
  (select value #> '{source,decision}'
    from e1_values where key = 'review-route-prepare') = 'null'::jsonb
    and (select jsonb_array_length(value -> 'members')
      from e1_values where key = 'review-route-prepare') = 1
    and (select jsonb_array_length(value -> 'reservations')
      from e1_values where key = 'review-route-prepare') = 6
    and (select value #>> '{requestMacKey,keyClass}'
      from e1_values where key = 'review-route-prepare') = 'private_manual'
    and (select reservation ->> 'keyClass'
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'reservations'
      ) as reserved(reservation)
      where preparation.key = 'review-route-prepare'
        and reservation ->> 'role' = 'review') = 'private_manual'
    and (select reservation ->> 'keyClass'
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'reservations'
      ) as reserved(reservation)
      where preparation.key = 'review-route-prepare'
        and reservation ->> 'role' = 'receipt') = 'ai_assisted'
    and exists (
      select 1 from public.encrypted_owner_interaction_claims
      where user_id = '88888888-8888-4888-8888-888888888888'
        and idempotency_key = 'e1-review-route'
        and decision_id = 'dec_88000000000000000000000003'
        and decision_content_revision = 1
        and decision_envelope_digest is not null
    ),
  'Review route binds exact decision CAS without projecting its ciphertext'
);
insert into e1_values(key, value)
select 'review-route-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, true, true,
  'review-route'
)
from e1_values where key = 'review-route-prepare';
insert into e1_values(key, value)
select 'review-route-event-before', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'review-route-result', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-route', value
)
from e1_values where key = 'review-route-command';
insert into e1_values(key, value)
select 'review-route-event-after', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
insert into e1_values(key, value)
select 'review-route-replay', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-route',
  jsonb_build_object('requestMac', value -> 'requestMac')
)
from e1_values where key = 'review-route-command';
reset role;
select ok(
  (select value -> 'decisionId' from e1_values
    where key = 'review-route-result') = 'null'::jsonb
    and (select value -> 'feedbackEventId' from e1_values
      where key = 'review-route-result') = 'null'::jsonb
    and (select (value ->> 'replayed')::boolean from e1_values
      where key = 'review-route-replay')
    and (select value -> 'decisionId' from e1_values
      where key = 'review-route-replay') = 'null'::jsonb
    and (select value -> 'feedbackEventId' from e1_values
      where key = 'review-route-replay') = 'null'::jsonb
    and (select coalesce(max(seq), 0) from public.user_events) = (
      select (value::text)::bigint from e1_values
      where key = 'review-route-event-after'
    )
    and (select destination_note_id from public.organization_decisions
    where id = 'dec_88000000000000000000000003')
      = 'note_88000000000000000000000005'
    and (select note_id from public.review_items
      where id = 'rvw_88000000000000000000000002')
      = 'note_88000000000000000000000005'
    and (select review_key_class from public.review_items
      where id = 'rvw_88000000000000000000000002') = 'private_manual'
    and private.owner_interaction_review_projection(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000002'
    ) ->> 'noteId' = 'note_88000000000000000000000005'
    and exists (
      select 1 from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000003'
        and note_id = 'note_88000000000000000000000004'
        and relation = 'source_removed'
    )
    and exists (
      select 1 from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000003'
        and note_id = 'note_88000000000000000000000005'
        and relation = 'routed'
    )
    and exists (
      select 1
      from public.note_mutations as mutation
      join e1_values as preparation
        on preparation.key = 'review-route-prepare'
        and preparation.value #>> '{ids,destinationMutationId}' = mutation.id
      where mutation.decision_id = 'dec_88000000000000000000000003'
        and mutation.note_id = 'note_88000000000000000000000005'
    ) and exists (
      select 1
      from public.capture_receipts as receipt
      join e1_values as preparation on preparation.key = 'review-route-prepare'
      where receipt.capture_id = 'cap_88000000000000000000000003'
        and receipt.decision_id = 'dec_88000000000000000000000003'
        and receipt.destination_note_id =
          'note_88000000000000000000000005'
        and receipt.mutation_id =
          preparation.value #>> '{ids,destinationMutationId}'
    ),
  'Review route commits/replays least-privilege output with internal lineage'
);
select ok(
  (select jsonb_agg(
      jsonb_build_array(event.entity, event.entity_id)
      order by event.entity, event.entity_id
    )
    from public.user_events as event
    where event.seq > (
      select (value::text)::bigint from e1_values
      where key = 'review-route-event-before'
    )) = (
      select jsonb_agg(
        jsonb_build_array(expected.entity, expected.entity_id)
        order by expected.entity, expected.entity_id
      )
      from (
        values
          ('capture', 'cap_88000000000000000000000003'),
          ('capture_note_link', 'note_88000000000000000000000004'),
          ('capture_note_link', 'note_88000000000000000000000005'),
          ('capture_receipt', 'cap_88000000000000000000000003'),
          ('note', 'note_88000000000000000000000005'),
          ('organization_decision', 'dec_88000000000000000000000003'),
          ('review_item', 'rvw_88000000000000000000000002')
        union all
        select 'note_revision', value #>> '{ids,destinationRevisionId}'
        from e1_values where key = 'review-route-prepare'
        union all
        select 'note_mutation', value #>> '{ids,destinationMutationId}'
        from e1_values where key = 'review-route-prepare'
      ) as expected(entity, entity_id)
    ),
  'Review route emits its exact write, lineage, and capture invalidations once'
);
rollback to savepoint review_route;
reset role;

-- A Review that became private through its source note must never downgrade
-- when the user routes it to an AI-visible destination. The destination note
-- remains AI-visible, while Review/request/response history stays private.
savepoint review_private_to_ai;
insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, is_open, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values (
  'note_88000000000000000000000007',
  '88888888-8888-4888-8888-888888888888', 'generic',
  'private review source', 'encrypted private review source', '{}'::jsonb,
  1, true, 'private_manual',
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'note_88000000000000000000000007', 1, 'note_content',
    'e1.private.object.v1', '7'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1
);
insert into public.captures (
  id, user_id, source, device_id, raw_text, privacy,
  client_created_at, client_timezone, status,
  content_envelope, content_fingerprint, content_length,
  content_key_id, content_key_class, content_key_purpose,
  content_key_version, fingerprint_key_id, fingerprint_key_class,
  fingerprint_key_purpose, fingerprint_key_version
) values (
  'cap_88000000000000000000000004',
  '88888888-8888-4888-8888-888888888888', 'web', 'e1-review-private',
  'encrypted private Review capture', 'private_manual', now(), 'UTC',
  'needs_review',
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'cap_88000000000000000000000004', 1, 'capture',
    'e1.private.object.v1', '7'
  ),
  encode(extensions.digest('review-private-capture', 'sha256'), 'hex'), 32,
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
  'e1.private.mac.v1', 'private_manual', 'content_mac', 1
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version, completed_at
) values (
  'job_88000000000000000000000004',
  'cap_88000000000000000000000004',
  '88888888-8888-4888-8888-888888888888',
  'succeeded', 'e1-review-private', 1, now()
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, destination_note_id, reason_codes, decision_envelope,
  decision_key_id, decision_key_class, decision_key_purpose,
  decision_key_version
) values (
  'dec_88000000000000000000000004',
  'cap_88000000000000000000000004',
  '88888888-8888-4888-8888-888888888888', '{}'::jsonb, '{}'::jsonb,
  null, 'review', null, array['low_confidence'],
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000004', 1,
    'organization_decision', 'e1.ai.object.v1', '7'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
);
insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key,
  before_revision, after_revision, operations, inverse,
  mutation_envelope, mutation_key_id, mutation_key_class,
  mutation_key_purpose, mutation_key_version
) values (
  'mut_88000000000000000000000007',
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000004',
  'note_88000000000000000000000007', 'e1-review-private-source', 0, 1,
  '[]'::jsonb, '[]'::jsonb,
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'mut_88000000000000000000000007', 1, 'note_mutation',
    'e1.private.object.v1', '7'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1
);
insert into public.review_items (
  id, user_id, capture_id, note_id, type, state, choices,
  review_envelope, review_key_id, review_key_class, review_key_purpose,
  review_key_version, review_content_revision
) values (
  'rvw_88000000000000000000000003',
  '88888888-8888-4888-8888-888888888888',
  'cap_88000000000000000000000004',
  'note_88000000000000000000000007', 'low_confidence', 'open', '[]'::jsonb,
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000003', 1, 'review_item',
    'e1.private.object.v1', '7'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1, 1
);
insert into public.capture_receipts (
  capture_id, job_id, user_id, decision_id, mutation_id, review_item_id,
  outcome, headline, destination_note_id, inserted_content, actions,
  reason_codes, receipt_envelope, receipt_key_id, receipt_key_class,
  receipt_key_purpose, receipt_key_version
) values (
  'cap_88000000000000000000000004',
  'job_88000000000000000000000004',
  '88888888-8888-4888-8888-888888888888',
  'dec_88000000000000000000000004', null,
  'rvw_88000000000000000000000003', 'needs_review', 'encrypted', null,
  '[]'::jsonb, '[]'::jsonb, array['low_confidence'],
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'cap_88000000000000000000000004', 1, 'capture_receipt',
    'e1.private.object.v1', '7'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1
);
insert into public.capture_note_links (
  capture_id, note_id, user_id, mutation_id, relation
) values (
  'cap_88000000000000000000000004',
  'note_88000000000000000000000007',
  '88888888-8888-4888-8888-888888888888',
  'mut_88000000000000000000000007', 'routed'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-private-ai-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000003', 'e1-review-private-ai',
    '{"type":"route","noteId":"note_88000000000000000000000002","expectedRevision":2}'::jsonb
  )
);
select ok(
  (select value #>> '{requestMacKey,keyClass}' from e1_values
    where key = 'review-private-ai-prepare') = 'private_manual'
    and (select value #>> '{members,0,sourcePrivacy}' from e1_values
      where key = 'review-private-ai-prepare') = 'ai_assisted'
    and (select value #>> '{members,0,targetPrivacy}' from e1_values
      where key = 'review-private-ai-prepare') = 'ai_assisted'
    and (select reservation ->> 'keyClass'
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'reservations'
      ) as reserved(reservation)
      where preparation.key = 'review-private-ai-prepare'
        and reservation ->> 'role' = 'review') = 'private_manual'
    and (select reservation ->> 'keyClass'
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'reservations'
      ) as reserved(reservation)
      where preparation.key = 'review-private-ai-prepare'
        and reservation ->> 'role' = 'receipt') = 'private_manual'
    and not exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'reservations'
      ) as reserved(reservation)
      where preparation.key = 'review-private-ai-prepare'
        and reservation ->> 'surface' in (
          'note_content', 'note_revision', 'note_mutation'
        )
        and reservation ->> 'keyClass' <> 'ai_assisted'
    ),
  'private Review to AI route keeps aggregate history private and destination writes AI'
);
insert into e1_values(key, value)
select 'review-private-ai-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, true, true,
  'review-private-ai'
)
from e1_values where key = 'review-private-ai-prepare';
insert into e1_values(key, value)
select 'review-private-ai-result', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000003', 'e1-review-private-ai', value
)
from e1_values where key = 'review-private-ai-command';
reset role;
select ok(
  (select row(note_id, review_key_class::text)
    from public.review_items
    where id = 'rvw_88000000000000000000000003') = row(
      'note_88000000000000000000000002'::text,
      'private_manual'::text
    )
    and (select row(privacy::text, content_key_class::text, current_revision)
      from public.notes
      where id = 'note_88000000000000000000000002') = row(
        'ai_assisted'::text, 'ai_assisted'::text, 3::integer
      )
    and (select value -> 'decisionId' from e1_values
      where key = 'review-private-ai-result') = 'null'::jsonb,
  'private Review terminalization does not downgrade its encrypted history'
);

-- A correction can have entirely AI-local note members while its originating
-- capture and receipt remain private. Request/response and conflict evidence
-- follow the aggregate provenance class; note history stays member-local.
savepoint correction_private_provenance;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'correction-private-provenance-prepare',
  public.prepare_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000004',
    'e1-correction-private-provenance',
    '{"source":{"noteId":"note_88000000000000000000000002","expectedRevision":3},"destination":{"type":"existing_note","noteId":"note_88000000000000000000000006","expectedRevision":2}}'::jsonb
  )
);
reset role;
select ok(
  (select value #>> '{requestMacKey,keyClass}' from e1_values
    where key = 'correction-private-provenance-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'common', 'response'
    ) ->> 'keyClass' from e1_values
      where key = 'correction-private-provenance-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'common', 'receipt'
    ) ->> 'keyClass' from e1_values
      where key = 'correction-private-provenance-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'needs_review', 'review'
    ) ->> 'keyClass' from e1_values
      where key = 'correction-private-provenance-prepare') = 'private_manual'
    and not exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value -> 'members'
      ) as supplied(member)
      where preparation.key = 'correction-private-provenance-prepare'
        and (
          member ->> 'sourcePrivacy' <> 'ai_assisted'
          or member ->> 'targetPrivacy' <> 'ai_assisted'
        )
    )
    and not exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value #> '{branches,applied,reservations}'
      ) as reserved(reservation)
      where preparation.key = 'correction-private-provenance-prepare'
        and reservation ->> 'surface' in (
          'note_content', 'note_revision', 'note_mutation'
        )
        and reservation ->> 'keyClass' <> 'ai_assisted'
    ),
  'private correction provenance stays aggregate-private without leaking into AI members'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'correction-private-provenance-command', jsonb_build_object(
  'selectedOutcome', 'needs_review',
  'requestMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'correction-private-request'
  ),
  'responseCipher', pg_temp.e1_cipher(
    '88888888-8888-4888-8888-888888888888',
    pg_temp.e1_reservation(preparation.value, 'common', 'response'), 'Q'
  ),
  'responseVerificationMac', pg_temp.e1_mac(
    preparation.value -> 'requestMacKey', 'correction-private-response'
  ),
  'writes', '[]'::jsonb,
  'receipt', jsonb_build_object(
    'recordVersion', (
      pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'recordVersion'
    )::integer,
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'common', 'receipt'), 'R'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'common', 'receipt'
      ) ->> 'keyClass'),
      'correction-private-receipt'
    )
  ),
  'review', jsonb_build_object(
    'reviewItemId', preparation.value #>>
      '{branches,needsReview,reviewItemId}',
    'recordVersion', 1,
    'type', 'revision_conflict',
    'cipher', pg_temp.e1_cipher(
      '88888888-8888-4888-8888-888888888888',
      pg_temp.e1_reservation(preparation.value, 'needs_review', 'review'), 'S'
    ),
    'verificationMac', pg_temp.e1_mac(
      pg_temp.e1_mac_key(pg_temp.e1_reservation(
        preparation.value, 'needs_review', 'review'
      ) ->> 'keyClass'),
      'correction-private-review'
    )
  )
)
from e1_values as preparation
where preparation.key = 'correction-private-provenance-prepare';
insert into e1_values(key, value)
select 'correction-private-provenance-result',
  public.commit_encrypted_decision_correction(
    '88888888-8888-4888-8888-888888888888',
    'dec_88000000000000000000000004',
    'e1-correction-private-provenance', command.value
  )
from e1_values as command
where command.key = 'correction-private-provenance-command';
reset role;
select ok(
  (select value ->> 'outcome' from e1_values
    where key = 'correction-private-provenance-result') = 'needs_review'
    and exists (
      select 1
      from public.review_items as review
      join e1_values as preparation
        on preparation.key = 'correction-private-provenance-prepare'
        and preparation.value #>> '{branches,needsReview,reviewItemId}' =
          review.id
      where review.review_key_class = 'private_manual'
        and review.state = 'open'
    ),
  'mixed-private correction conflict persists private Review evidence'
);
rollback to savepoint correction_private_provenance;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'review-private-ai-undo-prepare', public.get_encrypted_mutation_batch(
  '88888888-8888-4888-8888-888888888888',
  preparation.value #>> '{ids,destinationMutationId}', 3,
  'e1-review-private-ai-undo'
)
from e1_values as preparation
where preparation.key = 'review-private-ai-prepare';
reset role;
select ok(
  (select value #>> '{requestMacKey,keyClass}' from e1_values
    where key = 'review-private-ai-undo-prepare') = 'private_manual'
    and (select value #>> '{source,receipt,sourcePrivacy}' from e1_values
      where key = 'review-private-ai-undo-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'common', 'response'
    ) ->> 'keyClass' from e1_values
      where key = 'review-private-ai-undo-prepare') = 'private_manual'
    and (select pg_temp.e1_reservation(
      value, 'needs_review', 'review'
    ) ->> 'keyClass' from e1_values
      where key = 'review-private-ai-undo-prepare') = 'private_manual'
    and (select jsonb_array_length(value -> 'members') from e1_values
      where key = 'review-private-ai-undo-prepare') = 1
    and (select value #>> '{members,0,sourcePrivacy}' from e1_values
      where key = 'review-private-ai-undo-prepare') = 'ai_assisted'
    and (select value #>> '{members,0,targetPrivacy}' from e1_values
      where key = 'review-private-ai-undo-prepare') = 'ai_assisted'
    and not exists (
      select 1
      from e1_values as preparation
      cross join lateral jsonb_array_elements(
        preparation.value #> '{branches,applied,reservations}'
      ) as reserved(reservation)
      where preparation.key = 'review-private-ai-undo-prepare'
        and reservation ->> 'surface' in (
          'note_content', 'note_revision', 'note_mutation'
        )
        and reservation ->> 'keyClass' <> 'ai_assisted'
    ),
  'private receipt keeps undo aggregate private while its AI member stays local'
);
rollback to savepoint review_private_to_ai;
reset role;

savepoint review_create;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-create-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 'e1-review-create',
    '{"type":"create","noteType":"generic","spaceId":null}'::jsonb
  )
);
reset role;
select ok(
  (select value #> '{source,decision}'
    from e1_values where key = 'review-create-prepare') = 'null'::jsonb
    and exists (
      select 1 from public.encrypted_owner_interaction_claims
      where user_id = '88888888-8888-4888-8888-888888888888'
        and idempotency_key = 'e1-review-create'
        and decision_id = 'dec_88000000000000000000000003'
    ),
  'Review create also keeps its bound decision content off the source wire'
);
insert into e1_values(key, value)
select 'review-create-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, true, true,
  'review-create'
)
from e1_values where key = 'review-create-prepare';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'review-create-result', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-create', value
)
from e1_values where key = 'review-create-command';
insert into e1_values(key, value)
select 'review-create-replay', public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-create',
  jsonb_build_object('requestMac', value -> 'requestMac')
)
from e1_values where key = 'review-create-command';
reset role;
select ok(
  (select value -> 'decisionId' from e1_values
    where key = 'review-create-result') = 'null'::jsonb
    and (select value -> 'feedbackEventId' from e1_values
      where key = 'review-create-result') = 'null'::jsonb
    and (select (value ->> 'replayed')::boolean from e1_values
      where key = 'review-create-replay')
    and exists (
    select 1
    from public.notes as note
    join e1_values as preparation
      on preparation.key = 'review-create-prepare'
      and preparation.value #>> '{ids,destinationNoteId}' = note.id
    where note.current_revision = 1
  ) and exists (
    select 1
    from public.note_mutations as mutation
    join e1_values as preparation
      on preparation.key = 'review-create-prepare'
      and preparation.value #>> '{ids,destinationMutationId}' = mutation.id
    where mutation.decision_id = 'dec_88000000000000000000000003'
      and mutation.note_id = preparation.value #>> '{ids,destinationNoteId}'
  ) and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000003') = (
    select value #>> '{ids,destinationNoteId}'
    from e1_values where key = 'review-create-prepare'
  ) and (select note_id from public.review_items
      where id = 'rvw_88000000000000000000000002') = (
    select value #>> '{ids,destinationNoteId}'
    from e1_values where key = 'review-create-prepare'
  ) and private.owner_interaction_review_projection(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000002'
    ) ->> 'noteId' = (
    select value #>> '{ids,destinationNoteId}'
    from e1_values where key = 'review-create-prepare'
  ),
  'Review create publishes one destination across write, read, and lineage'
);
rollback to savepoint review_create;
reset role;

savepoint review_missing_decision;
update public.capture_receipts set
  decision_id = null,
  receipt_revision = 2,
  receipt_envelope = pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'cap_88000000000000000000000003', 2, 'capture_receipt',
    'e1.ai.object.v1', '1'
  )
where capture_id = 'cap_88000000000000000000000003';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '88888888-8888-4888-8888-888888888888',
      'rvw_88000000000000000000000002', 'e1-review-no-decision',
      '{"type":"route","noteId":"note_88000000000000000000000005","expectedRevision":1}'::jsonb
    )
  $statement$) ->> 'message',
  'not_found',
  'Review routing fails closed when its receipt has no decision lineage'
);
rollback to savepoint review_missing_decision;
reset role;

savepoint review_dismiss_metadata;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-dismiss-linked-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 'e1-review-dismiss-linked',
    '{"type":"dismiss"}'::jsonb
  )
);
select is(
  (select jsonb_array_length(value -> 'reservations')
    from e1_values where key = 'review-dismiss-linked-prepare'),
  2,
  'capture-linked dismiss reserves only response and Review metadata'
);
insert into e1_values(key, value)
select 'review-dismiss-linked-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, false, false,
  'review-dismiss-linked'
)
from e1_values where key = 'review-dismiss-linked-prepare';
insert into e1_values(key, value)
select 'review-dismiss-linked-event-before', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
select public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-dismiss-linked', value
)
from e1_values where key = 'review-dismiss-linked-command';
reset role;
select ok(
  (select row(outcome::text, receipt_revision, decision_id,
      destination_note_id, mutation_id, review_item_id)
    from public.capture_receipts
    where capture_id = 'cap_88000000000000000000000003') = row(
      'needs_review'::text, 1,
      'dec_88000000000000000000000003'::text,
      null::text, null::text, 'rvw_88000000000000000000000002'::text
    )
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000003') = 'needs_review'
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000003') is null
    and exists (
      select 1 from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000003'
        and note_id = 'note_88000000000000000000000004'
        and relation = 'routed'
    ) and (select current_revision from public.notes
      where id = 'note_88000000000000000000000004') = 2
    and (select note_id from public.review_items
      where id = 'rvw_88000000000000000000000002')
      = 'note_88000000000000000000000004',
  'dismiss changes Review metadata without touching receipt, capture, route, note, or decision'
);
select is(
  (select jsonb_agg(jsonb_build_array(entity, entity_id)
    order by entity, entity_id)
    from public.user_events
    where seq > (
      select (value::text)::bigint from e1_values
      where key = 'review-dismiss-linked-event-before'
    )),
  jsonb_build_array(jsonb_build_array(
    'review_item', 'rvw_88000000000000000000000002'
  )),
  'dismiss emits only the Review invalidation'
);
rollback to savepoint review_dismiss_metadata;
reset role;

savepoint review_keep_both_metadata;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-keep-both-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 'e1-review-keep-both',
    '{"type":"keep_both"}'::jsonb
  )
);
insert into e1_values(key, value)
select 'review-keep-both-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, false, false,
  'review-keep-both'
)
from e1_values where key = 'review-keep-both-prepare';
select public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-keep-both', value
)
from e1_values where key = 'review-keep-both-command';
reset role;
select ok(
  (select row(outcome::text, receipt_revision)
    from public.capture_receipts
    where capture_id = 'cap_88000000000000000000000003')
      = row('needs_review'::text, 1)
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000003') = 'needs_review'
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000003') is null
    and (select note_id from public.review_items
      where id = 'rvw_88000000000000000000000002')
      = 'note_88000000000000000000000004',
  'keep_both is metadata-only for receipt, capture, and decision state'
);
rollback to savepoint review_keep_both_metadata;
reset role;

savepoint review_keep_inbox;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value) values (
  'review-keep-inbox-prepare',
  public.prepare_encrypted_review_resolution(
    '88888888-8888-4888-8888-888888888888',
    'rvw_88000000000000000000000002', 'e1-review-keep-inbox',
    '{"type":"keep_inbox"}'::jsonb
  )
);
select is(
  (select jsonb_array_length(value -> 'reservations')
    from e1_values where key = 'review-keep-inbox-prepare'),
  3,
  'keep_inbox adds the one receipt rewrite reservation'
);
insert into e1_values(key, value)
select 'review-keep-inbox-command', pg_temp.e1_review_command(
  '88888888-8888-4888-8888-888888888888', value, false, true,
  'review-keep-inbox'
)
from e1_values where key = 'review-keep-inbox-prepare';
insert into e1_values(key, value)
select 'review-keep-inbox-event-before', to_jsonb(coalesce(max(seq), 0))
from public.user_events;
select public.commit_encrypted_review_resolution(
  '88888888-8888-4888-8888-888888888888',
  'rvw_88000000000000000000000002', 'e1-review-keep-inbox', value
)
from e1_values where key = 'review-keep-inbox-command';
reset role;
select ok(
  (select row(outcome::text, receipt_revision, destination_note_id,
      mutation_id, review_item_id)
    from public.capture_receipts
    where capture_id = 'cap_88000000000000000000000003') = row(
      'kept_in_inbox'::text, 2, null::text, null::text,
      'rvw_88000000000000000000000002'::text
    )
    and (select status::text from public.captures
      where id = 'cap_88000000000000000000000003') = 'inbox'
    and (select destination_note_id from public.organization_decisions
      where id = 'dec_88000000000000000000000003') is null
    and exists (
      select 1 from public.capture_note_links
      where capture_id = 'cap_88000000000000000000000003'
        and note_id = 'note_88000000000000000000000004'
        and relation = 'routed'
    ) and (select note_id from public.review_items
      where id = 'rvw_88000000000000000000000002')
      = 'note_88000000000000000000000004',
  'keep_inbox alone rewrites receipt/capture while preserving route and decision'
);
select is(
  (select jsonb_agg(jsonb_build_array(entity, entity_id)
    order by entity, entity_id)
    from public.user_events
    where seq > (
      select (value::text)::bigint from e1_values
      where key = 'review-keep-inbox-event-before'
    )),
  jsonb_build_array(
    jsonb_build_array('capture', 'cap_88000000000000000000000003'),
    jsonb_build_array('capture_receipt', 'cap_88000000000000000000000003'),
    jsonb_build_array('review_item', 'rvw_88000000000000000000000002')
  ),
  'keep_inbox emits exactly the Review, receipt, and capture invalidations'
);
rollback to savepoint review_keep_inbox;
reset role;

-- Legacy single-note undo must never split a member out of a committed E1
-- batch. An ordinary mutation still reaches the unchanged encrypted-write
-- validation path.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'legacy-batch-prepare', public.prepare_encrypted_note_write(
  '88888888-8888-4888-8888-888888888888',
  'apply_encrypted_note_mutation', 'e1-legacy-batch-guard',
  'note_88000000000000000000000002', 2, 'ai_assisted',
  pg_temp.e1_mac(
    jsonb_build_object(
      'keyId', 'e1.ai.mac.v1', 'keyClass', 'ai_assisted',
      'purpose', 'content_mac', 'keyVersion', 1
    ),
    'e1-legacy-batch-request'
  )
)
from e1_values as correction where correction.key = 'correction-prepare';

insert into e1_values(key, value)
select 'legacy-batch-command', jsonb_build_object(
  'occurredAt', claim.value ->> 'occurredAt',
  'noteState', jsonb_build_object(
    'spaceId', null, 'type', 'generic',
    'title', 'e-note_88000000000000000000000002',
    'bodyMarkdown', '', 'structuredData', '{"schemaVersion":1}'::jsonb,
    'dailyDate', null, 'isOpen', true, 'privacy', 'ai_assisted',
    'pinnedAt', null, 'archivedAt', null, 'deletedAt', null,
    'tagIds', '[]'::jsonb, 'links', '[]'::jsonb
  ),
  'noteCipher', '{}'::jsonb,
  'revision', jsonb_build_object(
    'id', claim.value ->> 'revisionId', 'source', 'undo',
    'actor', 'user:e1-legacy-guard', 'cipher', '{}'::jsonb,
    'mac', '{}'::jsonb
  ),
  'mutation', jsonb_build_object(
    'id', claim.value ->> 'mutationId', 'decisionId', null,
    'undoTargetMutationId', correction.value #>> '{members,1,mutationId}',
    'operations', '[{"type":"set_privacy","privacy":"ai_assisted"}]'::jsonb,
    'inverse', '[{"type":"set_privacy","privacy":"ai_assisted"}]'::jsonb,
    'cipher', '{}'::jsonb
  ),
  'requestMac', pg_temp.e1_mac(
    jsonb_build_object(
      'keyId', 'e1.ai.mac.v1', 'keyClass', 'ai_assisted',
      'purpose', 'content_mac', 'keyVersion', 1
    ),
    'e1-legacy-batch-request'
  ),
  'responseCipher', '{}'::jsonb,
  'verification', jsonb_build_object(
    'noteContent', '{}'::jsonb, 'noteMutation', '{}'::jsonb,
    'idempotencyResponse', '{}'::jsonb
  )
)
from e1_values as claim
cross join e1_values as correction
where claim.key = 'legacy-batch-prepare'
  and correction.key = 'correction-prepare';

select is(
  pg_temp.caught_error(format(
    'select public.apply_encrypted_note_mutation(%L,%L,%s,%L,%L::jsonb)',
    '88888888-8888-4888-8888-888888888888',
    'note_88000000000000000000000002', 2,
    'e1-legacy-batch-guard', command.value::text
  )) ->> 'message',
  'conflict_requires_review',
  'legacy single-note undo rejects a committed E1 batch member'
)
from e1_values as command where command.key = 'legacy-batch-command';

reset role;
select ok(
  (select current_revision from public.notes
    where id = 'note_88000000000000000000000002') = 2
    and (select undone_at is null from public.note_mutations
      where id = (
        select value #>> '{members,1,mutationId}'
        from e1_values where key = 'correction-prepare'
      ))
    and not exists (
      select 1 from public.note_mutations
      where id = (
        select value ->> 'mutationId'
        from e1_values where key = 'legacy-batch-prepare'
      )
    ),
  'rejected legacy batch-member undo writes neither note nor mutation state'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'legacy-ordinary-prepare', public.prepare_encrypted_note_write(
  '88888888-8888-4888-8888-888888888888',
  'apply_encrypted_note_mutation', 'e1-legacy-ordinary',
  'note_88000000000000000000000004', 2, 'ai_assisted',
  pg_temp.e1_mac(
    jsonb_build_object(
      'keyId', 'e1.ai.mac.v1', 'keyClass', 'ai_assisted',
      'purpose', 'content_mac', 'keyVersion', 1
    ),
    'e1-legacy-ordinary-request'
  )
)
from e1_values as correction where correction.key = 'correction-prepare';
insert into e1_values(key, value)
select 'legacy-ordinary-command', jsonb_set(
  jsonb_set(
    jsonb_set(
      batch_command.value,
      '{occurredAt}', to_jsonb(claim.value ->> 'occurredAt')
    ),
    '{revision,id}', to_jsonb(claim.value ->> 'revisionId')
  ),
  '{noteState,title}', to_jsonb('e-note_88000000000000000000000004'::text)
)
  || jsonb_build_object(
    'mutation', (batch_command.value -> 'mutation')
      || jsonb_build_object(
        'id', claim.value ->> 'mutationId',
        'undoTargetMutationId', 'mut_88000000000000000000000004'
    ),
    'requestMac', pg_temp.e1_mac(
      jsonb_build_object(
        'keyId', 'e1.ai.mac.v1', 'keyClass', 'ai_assisted',
        'purpose', 'content_mac', 'keyVersion', 1
      ),
      'e1-legacy-ordinary-request'
    )
  )
from e1_values as batch_command
cross join e1_values as claim
cross join e1_values as correction
where batch_command.key = 'legacy-batch-command'
  and claim.key = 'legacy-ordinary-prepare'
  and correction.key = 'correction-prepare';
select is(
  pg_temp.caught_error(format(
    'select public.apply_encrypted_note_mutation(%L,%L,%s,%L,%L::jsonb)',
    '88888888-8888-4888-8888-888888888888',
    'note_88000000000000000000000004', 2,
    'e1-legacy-ordinary', command.value::text
  )) ->> 'message',
  'invalid_encrypted_field',
  'ordinary non-batch undo retains the existing encrypted validation path'
)
from e1_values as command where command.key = 'legacy-ordinary-command';
reset role;

-- Referential lifecycle is claim-atomic. Parent deletion removes all E1
-- coordination that names the parent before ON DELETE actions can attempt an
-- immutable SET NULL or retain a partial batch.
insert into public.spaces (
  id, user_id, name, slug, display_envelope, display_key_id,
  display_key_class, display_key_purpose, display_key_version,
  display_mac, display_mac_key_id, display_mac_key_class,
  display_mac_key_purpose, display_mac_key_version
) values (
  'spc_88000000000000000000000031',
  '88888888-8888-4888-8888-888888888888',
  'encrypted lifecycle space', 'e1-lifecycle-space',
  pg_temp.e1_envelope(
    '88888888-8888-4888-8888-888888888888',
    'spc_88000000000000000000000031', 1, 'space_display',
    'e1.private.object.v1', 'L'
  ),
  'e1.private.object.v1', 'private_manual', 'object_wrap', 1,
  repeat('9', 64), 'e1.private.mac.v1', 'private_manual', 'content_mac', 1
);

insert into public.notes (
  id, user_id, type, title, body_markdown, structured_data,
  current_revision, is_open, privacy, content_envelope, content_key_id,
  content_key_class, content_key_purpose, content_key_version
) values
  (
    'note_88000000000000000000000011',
    '88888888-8888-4888-8888-888888888888', 'generic',
    'lifecycle source', 'encrypted lifecycle source', '{}'::jsonb,
    2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000011', 2, 'note_content',
      'e1.ai.object.v1', 'A'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000012',
    '88888888-8888-4888-8888-888888888888', 'generic',
    'lifecycle destination', 'encrypted lifecycle destination', '{}'::jsonb,
    2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000012', 2, 'note_content',
      'e1.ai.object.v1', 'B'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'note_88000000000000000000000013',
    '88888888-8888-4888-8888-888888888888', 'generic',
    'lifecycle member', 'encrypted lifecycle member', '{}'::jsonb,
    2, true, 'ai_assisted',
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'note_88000000000000000000000013', 2, 'note_content',
      'e1.ai.object.v1', 'C'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.note_mutations (
  id, user_id, decision_id, note_id, idempotency_key,
  before_revision, after_revision, operations, inverse,
  mutation_envelope, mutation_key_id, mutation_key_class,
  mutation_key_purpose, mutation_key_version
) values
  (
    'mut_88000000000000000000000013',
    '88888888-8888-4888-8888-888888888888', null,
    'note_88000000000000000000000013', 'e1-lifecycle-note-member',
    1, 2, '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000013', 2, 'note_mutation',
      'e1.ai.object.v1', 'D'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_88000000000000000000000015',
    '88888888-8888-4888-8888-888888888888', null,
    'note_88000000000000000000000003', 'e1-lifecycle-batch-anchor',
    1, 2, '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000015', 2, 'note_mutation',
      'e1.ai.object.v1', 'E'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  ),
  (
    'mut_88000000000000000000000016',
    '88888888-8888-4888-8888-888888888888', null,
    'note_88000000000000000000000004', 'e1-lifecycle-batch-member',
    1, 2, '[]'::jsonb, '[]'::jsonb,
    pg_temp.e1_envelope(
      '88888888-8888-4888-8888-888888888888',
      'mut_88000000000000000000000016', 2, 'note_mutation',
      'e1.ai.object.v1', 'F'
    ),
    'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1
  );

insert into public.encrypted_owner_interaction_claims (
  user_id, idempotency_key, scope, action, decision_id,
  anchor_mutation_id, source_note_id, destination_note_id,
  destination_kind, destination_note_type, destination_space_id,
  capture_id, decision_content_revision, expected_anchor_revision,
  feedback_event_id, conflict_review_item_id, output_batch_id,
  history_key_class, request_mac_key_id, request_mac_key_class,
  request_mac_key_purpose, request_mac_key_version
) values
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-space',
    'encrypted_decision_correction', 'pending',
    'dec_88000000000000000000000001', null,
    'note_88000000000000000000000001',
    'note_88000000000000000000000031', 'new_note', 'generic',
    'spc_88000000000000000000000031',
    'cap_88000000000000000000000001', 1, null,
    'fbk_88000000000000000000000031',
    'rvw_88000000000000000000000031',
    '88000000-0000-4000-8000-000000000031',
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-source-note',
    'encrypted_decision_correction', 'pending',
    'dec_88000000000000000000000001', null,
    'note_88000000000000000000000011',
    'note_88000000000000000000000039', 'new_note', 'generic', null,
    'cap_88000000000000000000000001', 1, null,
    'fbk_88000000000000000000000032',
    'rvw_88000000000000000000000032',
    '88000000-0000-4000-8000-000000000032',
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-destination-note',
    'encrypted_decision_correction', 'pending',
    'dec_88000000000000000000000001', null,
    'note_88000000000000000000000001',
    'note_88000000000000000000000012', 'existing_note', null, null,
    'cap_88000000000000000000000001', 1, null,
    'fbk_88000000000000000000000033',
    'rvw_88000000000000000000000033',
    '88000000-0000-4000-8000-000000000033',
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-member-note',
    'encrypted_mutation_batch_undo', 'pending', null,
    'mut_88000000000000000000000004', null, null, null, null, null,
    null, null, 2, null,
    'rvw_88000000000000000000000034',
    '88000000-0000-4000-8000-000000000034',
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-mutation',
    'encrypted_mutation_batch_undo', 'pending', null,
    'mut_88000000000000000000000015', null, null, null, null, null,
    null, null, 2, null,
    'rvw_88000000000000000000000035',
    '88000000-0000-4000-8000-000000000035',
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
  );

-- Dedicated completed claims isolate raw capture and mutation lifecycle from
-- unrelated historical foreign keys. Their response rows use the same
-- encrypted owner-interaction shape as the commit RPC.
insert into public.encrypted_owner_interaction_claims (
  user_id, idempotency_key, scope, action, selected_outcome,
  review_item_id, anchor_mutation_id, capture_id, review_content_revision,
  expected_anchor_revision, feedback_event_id, conflict_review_item_id,
  output_batch_id, review_envelope_digest, history_key_class,
  request_mac_key_id, request_mac_key_class, request_mac_key_purpose,
  request_mac_key_version, request_mac, occurred_at, completed_at
) values
  (
    '88888888-8888-4888-8888-888888888888',
    'e1-lifecycle-capture-review', 'encrypted_review_resolution',
    'dismiss', null, 'rvw_88000000000000000000000002', null,
    'cap_88000000000000000000000003', 1, null,
    'fbk_88000000000000000000000036', null, null,
    repeat('3', 64), 'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted',
    'content_mac', 1, repeat('4', 64),
    '2026-09-01 20:00:00+00'::timestamptz,
    '2026-09-01 20:00:00+00'::timestamptz
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'e1-lifecycle-completed-mutation', 'encrypted_mutation_batch_undo',
    'pending', 'needs_review', null, 'mut_88000000000000000000000015',
    null, null, 2, null, 'rvw_88000000000000000000000037',
    '88000000-0000-4000-8000-000000000037', null,
    'ai_assisted', 'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    repeat('5', 64), '2026-09-01 20:00:01+00'::timestamptz,
    '2026-09-01 20:00:01+00'::timestamptz
  );

insert into public.api_idempotency_records (
  user_id, idempotency_key, scope, created_at, completed_at,
  request_mac, request_mac_key_id, request_mac_key_class,
  request_mac_key_purpose, request_mac_key_version,
  response_envelope, response_key_id, response_key_class,
  response_key_purpose, response_key_version, replay_policy,
  request_resource_type, request_resource_id, response_resource_type,
  response_resource_id, response_record_version
)
select claim.user_id, claim.idempotency_key, claim.scope,
  claim.occurred_at, claim.completed_at, claim.request_mac,
  claim.request_mac_key_id, claim.request_mac_key_class,
  claim.request_mac_key_purpose, claim.request_mac_key_version,
  pg_temp.e1_envelope(
    claim.user_id, 'idempotency:' || claim.idempotency_key, 1,
    'idempotency_response', 'e1.ai.object.v1', 'L'
  ),
  'e1.ai.object.v1', 'ai_assisted', 'object_wrap', 1, 'logical_mac',
  'owner_interaction', case
    when claim.scope = 'encrypted_review_resolution' then claim.review_item_id
    else claim.anchor_mutation_id
  end,
  'owner_interaction', case
    when claim.scope = 'encrypted_review_resolution' then claim.review_item_id
    when claim.selected_outcome = 'needs_review'
      then claim.conflict_review_item_id
    else claim.output_batch_id::text
  end,
  1
from public.encrypted_owner_interaction_claims as claim
where claim.user_id = '88888888-8888-4888-8888-888888888888'
  and claim.idempotency_key in (
    'e1-lifecycle-capture-review',
    'e1-lifecycle-completed-mutation'
  );

insert into public.content_encryption_verifications (
  user_id, surface, resource_id, record_version, envelope_digest,
  verification_mac, verification_mac_key_id, verification_mac_key_class,
  verification_mac_key_purpose, verification_mac_key_version
)
select response.user_id, 'idempotency_response',
  'idempotency:' || response.idempotency_key, 1,
  encode(extensions.digest(response.response_envelope::text, 'sha256'), 'hex'),
  encode(extensions.digest(
    'e1-lifecycle-proof:' || response.idempotency_key, 'sha256'
  ), 'hex'),
  'e1.ai.mac.v1', 'ai_assisted', 'content_mac', 1
from public.api_idempotency_records as response
where response.user_id = '88888888-8888-4888-8888-888888888888'
  and response.idempotency_key in (
    'e1-lifecycle-capture-review',
    'e1-lifecycle-completed-mutation'
  );

insert into public.encrypted_owner_interaction_members (
  user_id, idempotency_key, ordinal, role, note_id,
  target_mutation_id, expected_revision, source_privacy, target_privacy,
  revision_id, mutation_id, expected_note_envelope_digest,
  expected_mutation_envelope_digest, history_key_class
) values
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-member-note',
    0, 'undo', 'note_88000000000000000000000004',
    'mut_88000000000000000000000004', 2, 'ai_assisted', 'ai_assisted',
    'rev_88000000000000000000000034',
    'mut_88000000000000000000000034', repeat('a', 64), repeat('b', 64),
    'ai_assisted'
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-member-note',
    1, 'undo', 'note_88000000000000000000000013',
    'mut_88000000000000000000000013', 2, 'ai_assisted', 'ai_assisted',
    'rev_88000000000000000000000035',
    'mut_88000000000000000000000035', repeat('c', 64), repeat('d', 64),
    'ai_assisted'
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-mutation',
    0, 'undo', 'note_88000000000000000000000003',
    'mut_88000000000000000000000015', 2, 'ai_assisted', 'ai_assisted',
    'rev_88000000000000000000000036',
    'mut_88000000000000000000000036', repeat('e', 64), repeat('f', 64),
    'ai_assisted'
  ),
  (
    '88888888-8888-4888-8888-888888888888', 'e1-lifecycle-mutation',
    1, 'undo', 'note_88000000000000000000000004',
    'mut_88000000000000000000000016', 2, 'ai_assisted', 'ai_assisted',
    'rev_88000000000000000000000037',
    'mut_88000000000000000000000037', repeat('1', 64), repeat('2', 64),
    'ai_assisted'
  );

insert into public.encrypted_mutation_batches (
  batch_id, user_id, kind, anchor_mutation_id
) values (
  '88000000-0000-4000-8000-000000000041',
  '88888888-8888-4888-8888-888888888888',
  'organization', 'mut_88000000000000000000000015'
);
insert into public.encrypted_mutation_batch_members (
  user_id, batch_id, ordinal, role, note_id, mutation_id
) values
  (
    '88888888-8888-4888-8888-888888888888',
    '88000000-0000-4000-8000-000000000041', 0, 'organization',
    'note_88000000000000000000000003',
    'mut_88000000000000000000000015'
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    '88000000-0000-4000-8000-000000000041', 1, 'organization',
    'note_88000000000000000000000004',
    'mut_88000000000000000000000016'
  );

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into e1_values(key, value)
select 'lifecycle-reservation:' || claim_key,
  private.reserve_owner_interaction_object(
    '88888888-8888-4888-8888-888888888888', claim_key,
    'common', 'response', 'idempotency_response',
    'idempotency:' || claim_key, 1, 'ai_assisted'
  )
from unnest(array[
  'e1-lifecycle-space',
  'e1-lifecycle-source-note',
  'e1-lifecycle-destination-note',
  'e1-lifecycle-member-note',
  'e1-lifecycle-mutation'
]) as claims(claim_key);
reset role;

set constraints all immediate;

savepoint lifecycle_account_delete;
select lives_ok(
  $$delete from auth.users
    where id = '88888888-8888-4888-8888-888888888888'$$,
  'account deletion can cascade through every E1 cleanup trigger atomically'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
  ) and not exists (
    select 1 from public.encrypted_mutation_batches
    where user_id = '88888888-8888-4888-8888-888888888888'
  ) and not exists (
    select 1 from public.content_key_operation_reservations
    where user_id = '88888888-8888-4888-8888-888888888888'
  ),
  'account lifecycle leaves no claim, batch, or open wrap reservation'
);
rollback to savepoint lifecycle_account_delete;
select ok(
  exists (
    select 1 from auth.users
    where id = '88888888-8888-4888-8888-888888888888'
  ) and exists (
    select 1 from public.encrypted_mutation_batches
    where user_id = '88888888-8888-4888-8888-888888888888'
      and batch_id = '88000000-0000-4000-8000-000000000041'
  ) and (
    select count(*) = 5
    from public.content_key_operation_reservations as reservation
    join e1_values as expected
      on expected.key like 'lifecycle-reservation:%'
      and expected.value ->> 'reservationId' = reservation.reservation_id::text
    where reservation.user_id = '88888888-8888-4888-8888-888888888888'
      and reservation.consumed_at is null
  ),
  'account lifecycle savepoint rollback restores the complete atomic fixture'
);

-- Completed E1 claims own encrypted replay ciphertext and its verification
-- MAC. Deleting any referenced source must remove all three as one lifecycle
-- unit. These are real committed correction, Review, and batch-Undo records;
-- the precondition prevents an absence-only cleanup assertion from passing.
select ok(
  (
    select count(*)
    from public.api_idempotency_records as response
    join public.content_encryption_verifications as verification
      on verification.user_id = response.user_id
      and verification.surface = 'idempotency_response'
      and verification.resource_id =
        'idempotency:' || response.idempotency_key
      and verification.record_version = 1
      and verification.envelope_digest = encode(
        extensions.digest(response.response_envelope::text, 'sha256'), 'hex'
      )
    where response.user_id = '88888888-8888-4888-8888-888888888888'
      and response.idempotency_key in (
        'e1-lifecycle-capture-review', 'e1-review-dismiss',
        'e1-correction-safe', 'e1-lifecycle-completed-mutation'
      )
  ) = 4
  and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-capture-review'
      and capture_id = 'cap_88000000000000000000000003'
      and completed_at is not null
  ) and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-dismiss'
      and review_item_id = 'rvw_88000000000000000000000001'
      and completed_at is not null
  ) and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-correction-safe'
      and source_note_id = 'note_88000000000000000000000001'
      and completed_at is not null
  ) and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-completed-mutation'
      and anchor_mutation_id = 'mut_88000000000000000000000015'
      and completed_at is not null
  ),
  'completed lifecycle fixtures retain exact encrypted replay proofs'
);

savepoint lifecycle_capture_response;
select lives_ok(
  $$delete from public.captures
    where id = 'cap_88000000000000000000000003'$$,
  'capture deletion cascades its completed E1 claim atomically'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-capture-review'
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-capture-review'
      and scope = 'encrypted_review_resolution'
  ) and not exists (
    select 1 from public.content_encryption_verifications
    where user_id = '88888888-8888-4888-8888-888888888888'
      and surface = 'idempotency_response'
      and resource_id = 'idempotency:e1-lifecycle-capture-review'
  ),
  'capture lifecycle leaves no E1 response ciphertext or verification MAC'
);
rollback to savepoint lifecycle_capture_response;

savepoint lifecycle_review_response;
select lives_ok(
  $$delete from public.review_items
    where id = 'rvw_88000000000000000000000001'$$,
  'Review deletion cascades its completed E1 claim atomically'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-dismiss'
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-review-dismiss'
      and scope = 'encrypted_review_resolution'
  ) and not exists (
    select 1 from public.content_encryption_verifications
    where user_id = '88888888-8888-4888-8888-888888888888'
      and surface = 'idempotency_response'
      and resource_id = 'idempotency:e1-review-dismiss'
  ),
  'Review lifecycle leaves no E1 response ciphertext or verification MAC'
);
rollback to savepoint lifecycle_review_response;

savepoint lifecycle_note_response;
select lives_ok(
  $$delete from public.notes
    where id = 'note_88000000000000000000000001'$$,
  'note deletion cascades its completed correction claim atomically'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-correction-safe'
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-correction-safe'
      and scope = 'encrypted_decision_correction'
  ) and not exists (
    select 1 from public.content_encryption_verifications
    where user_id = '88888888-8888-4888-8888-888888888888'
      and surface = 'idempotency_response'
      and resource_id = 'idempotency:e1-correction-safe'
  ),
  'note lifecycle leaves no E1 response ciphertext or verification MAC'
);
rollback to savepoint lifecycle_note_response;

savepoint lifecycle_mutation_response;
select lives_ok(
  $$delete from public.note_mutations
    where id = 'mut_88000000000000000000000015'$$,
  'mutation deletion cascades its completed batch-Undo claim atomically'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-completed-mutation'
  ) and not exists (
    select 1 from public.api_idempotency_records
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-completed-mutation'
      and scope = 'encrypted_mutation_batch_undo'
  ) and not exists (
    select 1 from public.content_encryption_verifications
    where user_id = '88888888-8888-4888-8888-888888888888'
      and surface = 'idempotency_response'
      and resource_id = 'idempotency:e1-lifecycle-completed-mutation'
  ),
  'mutation lifecycle leaves no E1 response ciphertext or verification MAC'
);
rollback to savepoint lifecycle_mutation_response;

select lives_ok(
  $$delete from public.spaces
    where id = 'spc_88000000000000000000000031'$$,
  'space deletion cleans its immutable destination claim before SET NULL'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-space'
  ) and not exists (
    select 1 from public.spaces
    where id = 'spc_88000000000000000000000031'
  ) and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    join e1_values as expected
      on expected.key = 'lifecycle-reservation:e1-lifecycle-space'
      and expected.value ->> 'reservationId' = reservation.reservation_id::text
  ),
  'space lifecycle removes the claim, parent, and open wrap reservation'
);

select lives_ok(
  $$delete from public.notes where id in (
    'note_88000000000000000000000011',
    'note_88000000000000000000000012',
    'note_88000000000000000000000013'
  )$$,
  'note deletion cleans source, destination, and member claims before cascades'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key in (
        'e1-lifecycle-source-note',
        'e1-lifecycle-destination-note',
        'e1-lifecycle-member-note'
      )
  ) and exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-mutation'
  ) and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    join e1_values as expected
      on expected.key in (
        'lifecycle-reservation:e1-lifecycle-source-note',
        'lifecycle-reservation:e1-lifecycle-destination-note',
        'lifecycle-reservation:e1-lifecycle-member-note'
      )
      and expected.value ->> 'reservationId' = reservation.reservation_id::text
  ),
  'note lifecycle removes owning claims and wraps without widening owner scope'
);

savepoint lifecycle_anchor_mutation;
select lives_ok(
  $$delete from public.note_mutations
    where id = 'mut_88000000000000000000000015'$$,
  'anchor mutation deletion cleans its full claim and committed batch'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-mutation'
  ) and not exists (
    select 1 from public.encrypted_mutation_batches
    where user_id = '88888888-8888-4888-8888-888888888888'
      and batch_id = '88000000-0000-4000-8000-000000000041'
  ) and exists (
    select 1 from public.note_mutations
    where user_id = '88888888-8888-4888-8888-888888888888'
      and id = 'mut_88000000000000000000000016'
  ) and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    join e1_values as expected
      on expected.key = 'lifecycle-reservation:e1-lifecycle-mutation'
      and expected.value ->> 'reservationId' = reservation.reservation_id::text
  ),
  'anchor lifecycle leaves no partial claim, batch, or open wrap'
);
rollback to savepoint lifecycle_anchor_mutation;

select lives_ok(
  $$delete from public.note_mutations
    where id = 'mut_88000000000000000000000016'$$,
  'non-anchor batch mutation deletion cleans the full claim before SET NULL'
);
select ok(
  not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-mutation'
  ) and not exists (
    select 1 from public.encrypted_owner_interaction_members
    where user_id = '88888888-8888-4888-8888-888888888888'
      and idempotency_key = 'e1-lifecycle-mutation'
  ) and not exists (
    select 1 from public.encrypted_mutation_batches
    where user_id = '88888888-8888-4888-8888-888888888888'
      and batch_id = '88000000-0000-4000-8000-000000000041'
  ) and not exists (
    select 1 from public.encrypted_mutation_batch_members
    where user_id = '88888888-8888-4888-8888-888888888888'
      and batch_id = '88000000-0000-4000-8000-000000000041'
  ) and exists (
    select 1 from public.note_mutations
    where user_id = '88888888-8888-4888-8888-888888888888'
      and id = 'mut_88000000000000000000000015'
  ) and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    join e1_values as expected
      on expected.key = 'lifecycle-reservation:e1-lifecycle-mutation'
      and expected.value ->> 'reservationId' = reservation.reservation_id::text
  ),
  'non-anchor lifecycle leaves no partial claim, batch, or open wrap'
);

select * from finish();
rollback;
