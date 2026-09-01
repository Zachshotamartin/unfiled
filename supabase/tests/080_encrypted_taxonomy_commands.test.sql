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
      'nonce', repeat('C', 16), 'ciphertext', repeat(left(p_seed, 1), 64)
    )
  );
$$;

create function pg_temp.cipher(
  p_resource_id text,
  p_owner_id uuid,
  p_record_version integer,
  p_kind text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_record_version, p_kind,
      'c5d.taxonomy.object.v1', p_seed
    ),
    'keyId', 'c5d.taxonomy.object.v1',
    'keyClass', 'private_manual',
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id::text
  );
$$;

create function pg_temp.mac(p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', 'c5d.taxonomy.mac.v1',
    'keyClass', 'private_manual',
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.command(
  p_scope text,
  p_claim jsonb,
  p_request_seed text,
  p_reservation_id uuid,
  p_semantic_seed text default null,
  p_parent_id text default null,
  p_sort_key text default 'a0',
  p_archived_at text default null
)
returns jsonb
language plpgsql
immutable
as $$
declare
  base_value jsonb;
  display_kind text;
  display_value jsonb;
  result_revision integer;
begin
  result_revision := (p_claim ->> 'expectedRevision')::integer
    + case when p_scope = 'delete_tag' then 0 else 1 end;
  base_value := jsonb_build_object(
    'scope', p_scope,
    'occurredAt', p_claim ->> 'occurredAt',
    'requestMac', pg_temp.mac(p_request_seed),
    'responseCipher', pg_temp.cipher(
      'idempotency:' || p_request_seed,
      '22222222-2222-4222-8222-222222222222', 1,
      'idempotency_response', p_reservation_id, 'R'
    ),
    'responseVerificationMac', pg_temp.mac(p_request_seed || '-response-proof')
  );
  if p_scope = 'delete_tag' then return base_value; end if;
  display_kind := case when p_scope like '%_space'
    then 'space_display' else 'tag_display' end;
  display_value := jsonb_build_object(
    'cipher', pg_temp.cipher(
      p_claim ->> 'resourceId',
      '22222222-2222-4222-8222-222222222222', result_revision,
      display_kind, p_reservation_id, 'T'
    ),
    'semanticMac', pg_temp.mac(p_semantic_seed),
    'verificationMac', pg_temp.mac(p_request_seed || '-display-proof')
  );
  if display_kind = 'space_display' then
    return base_value || jsonb_build_object(
      'parentId', p_parent_id,
      'sortKey', p_sort_key,
      'archivedAt', p_archived_at,
      'display', display_value
    );
  end if;
  return base_value || jsonb_build_object('display', display_value);
end;
$$;

create temporary table c5d_taxonomy_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on c5d_taxonomy_values to service_role;

-- Isolate the second seeded owner and return it to an empty expanded rollout.
delete from public.captures where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.notes where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.spaces where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.tags where user_id = '22222222-2222-4222-8222-222222222222';
update public.content_encryption_rollouts set
  state = 'expanded', encrypted_object_count = 0, verified_object_count = 0,
  backfill_cursor = null, backfill_completed_at = null
where user_id = '22222222-2222-4222-8222-222222222222';

select has_table(
  'public', 'encrypted_taxonomy_write_claims',
  'taxonomy idempotency claims are durable'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class where oid = 'public.encrypted_taxonomy_write_claims'::regclass
  ),
  'taxonomy claims have enabled and forced RLS'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.commit_encrypted_taxonomy_write(uuid,text,text,text,integer,jsonb)',
    'EXECUTE'
  ),
  'the taxonomy command boundary is service-only'
);
select ok(
  (
    select pg_get_constraintdef(oid) like '%encrypted_taxonomy_command%'
    from pg_constraint
    where conrelid = 'public.content_key_operation_reservations'::regclass
      and conname = 'content_key_operation_reservations_consumed_by_type_check'
  ),
  'the object-key ledger admits the dedicated taxonomy consumer'
);
select ok(
  (
    select procedure.prosrc like all(array[
      '%''capture''%', '%''capture_reseal''%',
      '%''encrypted_note_create''%', '%''encrypted_note_mutation''%',
      '%''library_backfill''%', '%''note_rag_index''%',
      '%''encrypted_capture_command''%', '%''encrypted_taxonomy_command''%'
    ])
      and procedure.prosrc not like '%''encrypted_organizer''%'
      and procedure.prosrc like '%target_reservation_attempt%'
      and procedure.prosrc like '%target_reservation_lease_token%'
      and procedure.prosrc like '%invalid_key_reservation_binding%'
    from pg_proc as procedure
    where procedure.oid =
      'private.consume_content_key_reservations(uuid,jsonb,text,text)'::regprocedure
  ),
  'the shared consumer preserves all prior callable consumers and RAG binding checks'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.register_user_content_key(
  '22222222-2222-4222-8222-222222222222',
  key_id, key_class, purpose, 1, root_arn,
  decode(repeat(material, 32), 'hex')
)
from (values
  (
    'c5d.taxonomy.ai.object.v1', 'ai_assisted'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/80000000-0000-4000-8000-000000000003',
    '23'
  ),
  (
    'c5d.taxonomy.ai.mac.v1', 'ai_assisted'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/80000000-0000-4000-8000-000000000004',
    '24'
  ),
  (
    'c5d.taxonomy.object.v1', 'private_manual'::public.content_key_class,
    'object_wrap'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/80000000-0000-4000-8000-000000000001',
    '21'
  ),
  (
    'c5d.taxonomy.mac.v1', 'private_manual'::public.content_key_class,
    'content_mac'::public.content_key_purpose,
    'arn:aws:kms:us-west-2:123456789012:key/80000000-0000-4000-8000-000000000002',
    '22'
  )
) as key_fixture(key_id, key_class, purpose, root_arn, material);
select public.activate_user_content_key(
  '22222222-2222-4222-8222-222222222222', key_id
)
from (values
  ('c5d.taxonomy.ai.object.v1'), ('c5d.taxonomy.ai.mac.v1'),
  ('c5d.taxonomy.object.v1'), ('c5d.taxonomy.mac.v1')
) as keys(key_id);
select is(
  public.advance_content_encryption_rollout(
    '22222222-2222-4222-8222-222222222222', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the isolated owner enters encrypted writes'
);

insert into c5d_taxonomy_values values (
  'space-create-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_space',
    'c5d-space-create', null, 0, pg_temp.mac('c5d-space-create')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000010',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
insert into c5d_taxonomy_values
select 'space-create-command', pg_temp.command(
  'create_space', value, 'c5d-space-create',
  '80000000-0000-4000-8000-000000000010', 'space-work'
)
from c5d_taxonomy_values where key = 'space-create-claim';
insert into c5d_taxonomy_values values (
  'space-create-result', public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_space',
    'c5d-space-create',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim'),
    0,
    (select value from c5d_taxonomy_values where key = 'space-create-command')
  )
);
reset role;
select ok(
  (
    select name = 'e-' || lower(id)
      and slug = 'e-' || lower(id)
      and display_envelope is not null
      and display_mac = pg_temp.mac('space-work') ->> 'mac'
      and current_revision = 1
    from public.spaces
    where id = (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim')
  ),
  'space creation stores only sentinels, ciphertext, semantic MAC, and operations'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_space',
    'c5d-space-create', null, 0, pg_temp.mac('c5d-space-create')
  ) ->> 'completed',
  'true',
  'completed create replay returns the bound encrypted response'
);
select throws_ok(
  $$select public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_space',
    'c5d-space-create', null, 0, pg_temp.mac('changed-request')
  )$$,
  'P0001', 'invalid_idempotency_key',
  'an idempotency key cannot be rebound to different logical intent'
);

insert into c5d_taxonomy_values values (
  'space-update-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'update_space',
    'c5d-space-update',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim'),
    1, pg_temp.mac('c5d-space-update')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000011',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
select is(
  public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'update_space',
    'c5d-space-update',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim'),
    1,
    pg_temp.command(
      'update_space',
      (select value from c5d_taxonomy_values where key = 'space-update-claim'),
      'c5d-space-update', '80000000-0000-4000-8000-000000000011',
      'space-work', null, 'b0'
    )
  ) ->> 'currentRevision',
  '2',
  'space updates reseal at exactly N plus one'
);

insert into c5d_taxonomy_values values (
  'space-archive-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'archive_space',
    'c5d-space-archive',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim'),
    2, pg_temp.mac('c5d-space-archive')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000012',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
select is(
  public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'archive_space',
    'c5d-space-archive',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'space-create-claim'),
    2,
    pg_temp.command(
      'archive_space',
      (select value from c5d_taxonomy_values where key = 'space-archive-claim'),
      'c5d-space-archive', '80000000-0000-4000-8000-000000000012',
      'space-work', null, 'b0',
      (select value ->> 'occurredAt' from c5d_taxonomy_values
        where key = 'space-archive-claim')
    )
  ) ->> 'currentRevision',
  '3',
  'space archive is an exact revisioned encrypted command'
);

insert into c5d_taxonomy_values values (
  'tag-create-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_tag',
    'c5d-tag-create', null, 0, pg_temp.mac('c5d-tag-create')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000013',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
select is(
  public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_tag',
    'c5d-tag-create',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    0,
    pg_temp.command(
      'create_tag',
      (select value from c5d_taxonomy_values where key = 'tag-create-claim'),
      'c5d-tag-create', '80000000-0000-4000-8000-000000000013',
      'tag-fitness'
    )
  ) ->> 'replayed',
  'false',
  'tag creation commits ciphertext and an encrypted response atomically'
);

insert into c5d_taxonomy_values values (
  'tag-duplicate-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'create_tag',
    'c5d-tag-duplicate', null, 0, pg_temp.mac('c5d-tag-duplicate')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000014',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
select throws_ok(
  format(
    'select public.commit_encrypted_taxonomy_write(%L,%L,%L,%L,0,%L::jsonb)',
    '22222222-2222-4222-8222-222222222222', 'create_tag',
    'c5d-tag-duplicate',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-duplicate-claim'),
    pg_temp.command(
      'create_tag',
      (select value from c5d_taxonomy_values where key = 'tag-duplicate-claim'),
      'c5d-tag-duplicate', '80000000-0000-4000-8000-000000000014',
      'tag-fitness'
    )::text
  ),
  'P0001', 'conflict_requires_review',
  'semantic MAC uniqueness rejects the same normalized tag without plaintext'
);

insert into c5d_taxonomy_values values (
  'tag-update-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'update_tag',
    'c5d-tag-update',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    1, pg_temp.mac('c5d-tag-update')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000015',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 2
);
select is(
  public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'update_tag',
    'c5d-tag-update',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    1,
    pg_temp.command(
      'update_tag',
      (select value from c5d_taxonomy_values where key = 'tag-update-claim'),
      'c5d-tag-update', '80000000-0000-4000-8000-000000000015',
      'tag-strength'
    )
  ) ->> 'currentRevision',
  '2',
  'tag update binds owner, revision, semantic MAC, and response'
);
select throws_ok(
  $$select public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'update_tag',
    'c5d-tag-stale',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    1, pg_temp.mac('c5d-tag-stale')
  )$$,
  'P0001', 'stale_revision',
  'stale taxonomy claims fail before any plaintext is decrypted'
);

insert into c5d_taxonomy_values values (
  'tag-delete-claim', public.prepare_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'delete_tag',
    'c5d-tag-delete',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    2, pg_temp.mac('c5d-tag-delete')
  )
);
select public.reserve_content_key_operations(
  '22222222-2222-4222-8222-222222222222',
  '80000000-0000-4000-8000-000000000016',
  'private_manual', 'c5d.taxonomy.object.v1', 1, 1
);
select is(
  public.commit_encrypted_taxonomy_write(
    '22222222-2222-4222-8222-222222222222', 'delete_tag',
    'c5d-tag-delete',
    (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim'),
    2,
    pg_temp.command(
      'delete_tag',
      (select value from c5d_taxonomy_values where key = 'tag-delete-claim'),
      'c5d-tag-delete', '80000000-0000-4000-8000-000000000016'
    )
  ) ->> 'currentRevision',
  '2',
  'tag deletion commits a replayable encrypted tombstone response'
);
reset role;
select is(
  (
    select count(*) from public.tags
    where id = (select value ->> 'resourceId' from c5d_taxonomy_values
      where key = 'tag-create-claim')
  ),
  0::bigint,
  'tag deletion removes the exact owner resource'
);
select ok(
  not exists (
    select 1 from public.api_idempotency_records
    where user_id = '22222222-2222-4222-8222-222222222222'
      and scope in (
        'create_space', 'update_space', 'archive_space',
        'create_tag', 'update_tag', 'delete_tag'
      )
      and (
        response_envelope is null
        or response_key_class <> 'private_manual'
        or response_json::text ~* 'fitness|strength|work'
      )
  ),
  'taxonomy idempotency storage is encrypted and contains no display plaintext'
);
select ok(
  (
    select bool_and(
      consumed_by_type = 'encrypted_taxonomy_command'
      and consumed_by_id like 'c5d-%'
    )
    from public.content_key_operation_reservations
    where user_id = '22222222-2222-4222-8222-222222222222'
  ),
  'every committed object key is consumed by its exact taxonomy claim'
);

select * from finish();
rollback;
