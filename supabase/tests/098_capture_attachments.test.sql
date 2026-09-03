create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

-- Photos and recordings are sealed capture attachments: uploaded before the
-- capture exists, bound atomically when it is created, readable only through
-- service-role RPCs, and swept when never bound.

create function pg_temp.content_envelope(
  p_resource_id text,
  p_owner_id uuid,
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
      'recordVersion', 1,
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
  p_kind text,
  p_key_id text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.content_envelope(
      p_resource_id, p_owner_id, p_kind, p_key_id, p_seed
    ),
    'keyId', p_key_id,
    'keyClass', 'ai_assisted',
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
    'keyId', 'c5d.capture.ai.mac.v1',
    'keyClass', 'ai_assisted',
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.event_time()
returns text
language sql
volatile
as $$
  select to_char(
    date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
$$;

create function pg_temp.attachment(
  p_attachment_id text,
  p_capture_id text,
  p_kind text,
  p_reservation_id uuid,
  p_seed text default 'D'
)
returns jsonb
language sql
volatile
as $$
  select jsonb_build_object(
    'attachmentId', p_attachment_id,
    'captureId', p_capture_id,
    'kind', p_kind,
    'mediaType', case p_kind when 'image' then 'image/jpeg' else 'audio/mp4' end,
    'byteLength', 4096,
    'width', case p_kind when 'image' then 1568 else null end,
    'height', case p_kind when 'image' then 1044 else null end,
    'durationMs', case p_kind when 'audio' then 4200 else null end,
    'privacy', 'ai_assisted',
    'contentCipher', pg_temp.cipher(
      p_attachment_id, '55555555-5555-4555-8555-555555555555',
      'capture_attachment', 'c5d.capture.ai.object.v1', p_reservation_id, p_seed
    ),
    'contentMac', pg_temp.mac(p_attachment_id || p_seed)
  );
$$;

create function pg_temp.capture(
  p_capture_id text,
  p_job_id text,
  p_reservation_id uuid,
  p_attachment_ids jsonb
)
returns jsonb
language sql
volatile
as $$
  select jsonb_build_object(
    'clientCaptureId', p_capture_id,
    'jobId', p_job_id,
    'occurredAt', pg_temp.event_time(),
    'contentCipher', pg_temp.cipher(
      p_capture_id, '55555555-5555-4555-8555-555555555555', 'capture',
      'c5d.capture.ai.object.v1', p_reservation_id, 'E'
    ),
    'contentMac', pg_temp.mac(p_capture_id || '-content'),
    'contentLength', 12,
    'source', 'mobile',
    'deviceId', 'attachment-test',
    'clientCreatedAt', pg_temp.event_time(),
    'clientTimezone', 'UTC',
    'privacy', 'ai_assisted',
    'explicitDestinationNoteId', null,
    'expansionDisabled', false,
    'routingRuleMatch', null,
    'privateReceiptCipher', null,
    'privateReceiptVerificationMac', null
  ) || case
    when p_attachment_ids is null then '{}'::jsonb
    else jsonb_build_object('attachmentIds', p_attachment_ids)
  end;
$$;

-- Shape and capability

select has_table('public', 'capture_attachments', 'capture attachments table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.capture_attachments'::regclass),
  'row level security is enabled on capture attachments'
);
select ok(
  not has_table_privilege('service_role', 'public.capture_attachments', 'SELECT')
    and not has_table_privilege('authenticated', 'public.capture_attachments', 'SELECT')
    and not has_table_privilege('anon', 'public.capture_attachments', 'SELECT')
    and not has_table_privilege('unfiled_organizer_worker', 'public.capture_attachments', 'SELECT'),
  'no role can read the attachments table directly'
);
select is(
  (select attstorage from pg_attribute
   where attrelid = 'public.capture_attachments'::regclass and attname = 'content_envelope'),
  'e',
  'the sealed envelope column uses external storage'
);
select has_function(
  'public', 'create_encrypted_capture_attachment', array['uuid', 'jsonb'],
  'attachment creation has one exact signature'
);
select has_function(
  'public', 'get_encrypted_capture_attachment', array['uuid', 'text'],
  'attachment read has one exact signature'
);
select has_function(
  'public', 'list_encrypted_capture_attachments', array['uuid', 'text'],
  'attachment listing has one exact signature'
);
select ok(
  has_function_privilege(
    'service_role', 'public.create_encrypted_capture_attachment(uuid,jsonb)', 'EXECUTE'
  )
    and has_function_privilege(
      'service_role', 'public.get_encrypted_capture_attachment(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.create_encrypted_capture_attachment(uuid,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.get_encrypted_capture_attachment(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role', 'private.bind_capture_attachments(uuid,text,public.privacy_mode,jsonb,boolean)', 'EXECUTE'
    ),
  'only the service role receives attachment capabilities and binding stays private'
);

-- Owner fixture

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '55555555-5555-4555-8555-555555555555',
  'authenticated', 'authenticated', 'attachments@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
), (
  '00000000-0000-0000-0000-000000000000',
  '56565656-5656-4656-8656-565656565656',
  'authenticated', 'authenticated', 'stranger@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id)
values ('55555555-5555-4555-8555-555555555555');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.capture.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/98000000-0000-4000-8000-000000000001',
    decode(repeat('11', 32), 'hex'), 'active', now()
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.capture.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/98000000-0000-4000-8000-000000000002',
    decode(repeat('12', 32), 'hex'), 'active', now()
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.capture.private.object.v1', 'private_manual', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/98000000-0000-4000-8000-000000000003',
    decode(repeat('13', 32), 'hex'), 'active', now()
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'c5d.capture.private.mac.v1', 'private_manual', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/98000000-0000-4000-8000-000000000004',
    decode(repeat('14', 32), 'hex'), 'active', now()
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.advance_content_encryption_rollout(
    '55555555-5555-4555-8555-555555555555', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the attachment owner enters encrypted dual-write'
);
select public.reserve_content_key_operations(
  '55555555-5555-4555-8555-555555555555',
  reservation_id, 'ai_assisted', 'c5d.capture.ai.object.v1', 1, 1
)
from (values
  ('98000000-0000-4000-8000-000000000010'::uuid),
  ('98000000-0000-4000-8000-000000000011'::uuid),
  ('98000000-0000-4000-8000-000000000012'::uuid),
  ('98000000-0000-4000-8000-000000000013'::uuid),
  ('98000000-0000-4000-8000-000000000014'::uuid),
  ('98000000-0000-4000-8000-000000000015'::uuid),
  ('98000000-0000-4000-8000-000000000016'::uuid),
  ('98000000-0000-4000-8000-000000000017'::uuid),
  ('98000000-0000-4000-8000-000000000018'::uuid),
  ('98000000-0000-4000-8000-000000000019'::uuid)
) as reservations(reservation_id);

-- Creating attachments

select is(
  public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000001', 'cap_98000000000000000000000001',
      'image', '98000000-0000-4000-8000-000000000010'
    )
  ) ->> 'replayed',
  'false',
  'a photo is sealed as an unbound attachment'
);
select is(
  public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000001', 'cap_98000000000000000000000001',
      'image', '98000000-0000-4000-8000-000000000010'
    )
  ) ->> 'replayed',
  'true',
  'the same upload again replays without a second row'
);
select throws_ok(
  $$select public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000001', 'cap_98000000000000000000000001',
      'image', '98000000-0000-4000-8000-000000000010', 'Z'
    )
  )$$,
  'P0001', 'invalid_idempotency_key',
  'the same id with different bytes is refused'
);
select throws_ok(
  $$select public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000002', 'cap_98000000000000000000000001',
      'image', '98000000-0000-4000-8000-000000000011'
    ) || jsonb_build_object('durationMs', 10)
  )$$,
  '22023', 'invalid_attachment',
  'a photo cannot carry a duration'
);
select throws_ok(
  $$select public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000002', 'cap_98000000000000000000000001',
      'image', '98000000-0000-4000-8000-000000000011'
    ) || jsonb_build_object('byteLength', 700001)
  )$$,
  '22023', 'invalid_attachment',
  'an attachment above the byte cap is refused'
);
select throws_ok(
  $$select public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    jsonb_set(
      pg_temp.attachment(
        'att_98000000000000000000000002', 'cap_98000000000000000000000001',
        'image', '98000000-0000-4000-8000-000000000011'
      ),
      '{contentCipher,envelope,context,kind}', '"capture"'
    )
  )$$,
  '22023', 'invalid_encrypted_field',
  'an envelope sealed for another kind is refused'
);
select is(
  public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000002', 'cap_98000000000000000000000001',
      'audio', '98000000-0000-4000-8000-000000000011'
    )
  ) ->> 'replayed',
  'false',
  'a recording is sealed as an unbound attachment'
);
select is(
  public.create_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.attachment(
      'att_98000000000000000000000003', 'cap_98000000000000000000000002',
      'image', '98000000-0000-4000-8000-000000000012'
    )
  ) ->> 'replayed',
  'false',
  'a photo for a second capture is sealed'
);

-- Reading

select is(
  public.get_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555', 'att_98000000000000000000000001'
  ) - 'createdAt' - 'contentCipher' - 'contentMac',
  jsonb_build_object(
    'attachmentId', 'att_98000000000000000000000001',
    'captureId', 'cap_98000000000000000000000001',
    'kind', 'image', 'mediaType', 'image/jpeg', 'byteLength', 4096,
    'width', 1568, 'height', 1044, 'durationMs', null,
    'privacy', 'ai_assisted', 'boundAt', null
  ),
  'the owner reads the attachment description and its sealed cipher'
);
select is(
  public.get_encrypted_capture_attachment(
    '55555555-5555-4555-8555-555555555555', 'att_98000000000000000000000001'
  ) #>> '{contentCipher,envelope,context,kind}',
  'capture_attachment',
  'the stored envelope is the sealed attachment'
);
select is(
  public.get_encrypted_capture_attachment(
    '56565656-5656-4656-8656-565656565656', 'att_98000000000000000000000001'
  ),
  null,
  'a stranger reads nothing'
);
select is(
  public.list_encrypted_capture_attachments(
    '55555555-5555-4555-8555-555555555555', 'cap_98000000000000000000000001'
  ),
  '[]'::jsonb,
  'unbound attachments are not listed for a capture'
);

-- Binding on capture creation

select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000001', 'job_98000000000000000000000001',
      '98000000-0000-4000-8000-000000000013',
      '["att_98000000000000000000000001", "att_98000000000000000000000003"]'
    )
  )$$,
  '42501', 'attachment_not_owned',
  'a capture cannot bind an attachment uploaded for another capture'
);
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000001', 'job_98000000000000000000000001',
      '98000000-0000-4000-8000-000000000013',
      '["att_98000000000000000000000001", "att_98000000000000000000000001"]'
    )
  )$$,
  '22023', 'invalid_capture',
  'a capture cannot name the same attachment twice'
);
-- Reading the capture table directly is nobody's capability, the service role included, so the
-- rollback is checked as the owner of the fixtures rather than through the service session.
reset role;
select is(
  (select count(*) from public.captures where id = 'cap_98000000000000000000000001'),
  0::bigint,
  'a refused binding rolls the capture back'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000001', 'job_98000000000000000000000001',
      '98000000-0000-4000-8000-000000000013',
      '["att_98000000000000000000000001", "att_98000000000000000000000002"]'
    )
  ) ->> 'replayed',
  'false',
  'a capture binds its photo and recording atomically'
);
-- The attachments table is nobody's to read directly, so the binding is counted outside the
-- service session, as the owner of the fixtures.
reset role;
select is(
  (select count(*) from public.capture_attachments
   where capture_id = 'cap_98000000000000000000000001' and bound_at is not null),
  2::bigint,
  'both attachments are bound'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000001', 'job_98000000000000000000000001',
      '98000000-0000-4000-8000-000000000013',
      '["att_98000000000000000000000002", "att_98000000000000000000000001"]'
    )
  ) ->> 'replayed',
  'true',
  'replaying the capture with the same attachments in any order is idempotent'
);
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000001', 'job_98000000000000000000000001',
      '98000000-0000-4000-8000-000000000013',
      '["att_98000000000000000000000001"]'
    )
  )$$,
  'P0001', 'invalid_idempotency_key',
  'replaying the capture with a different attachment set is refused'
);
select is(
  jsonb_array_length(public.list_encrypted_capture_attachments(
    '55555555-5555-4555-8555-555555555555', 'cap_98000000000000000000000001'
  )),
  2,
  'bound attachments are listed for their capture in upload order'
);
select is(
  public.create_encrypted_capture_with_job(
    '55555555-5555-4555-8555-555555555555',
    pg_temp.capture(
      'cap_98000000000000000000000003', 'job_98000000000000000000000003',
      '98000000-0000-4000-8000-000000000014', null
    )
  ) ->> 'replayed',
  'false',
  'a capture without attachments still works'
);

-- Sweeping never-bound uploads

reset role;
update public.capture_attachments
set created_at = created_at - interval '2 days'
where id = 'att_98000000000000000000000003';
select is(
  private.sweep_unbound_capture_attachments(),
  1,
  'an upload that never became a capture is swept after a day'
);
select is(
  (select count(*) from public.capture_attachments),
  2::bigint,
  'bound attachments survive the sweep'
);

-- Account deletion

delete from auth.users where id = '55555555-5555-4555-8555-555555555555';
select is(
  (select count(*) from public.capture_attachments),
  0::bigint,
  'deleting the account removes its attachments'
);

select * from finish();
rollback;
