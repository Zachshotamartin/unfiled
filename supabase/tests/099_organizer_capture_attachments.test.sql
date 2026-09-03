create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

-- The organizer reads the photos and recordings bound to the capture of a job
-- it holds a live lease on, projected like the capture itself, and nothing
-- else: unbound uploads, other captures, and other owners stay invisible.

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

create function pg_temp.caught_error(statement text)
returns jsonb
language plpgsql
as $$
begin
  execute statement;
  return null;
exception when others then
  return jsonb_build_object('sqlstate', sqlstate, 'message', sqlerrm);
end;
$$;

create function pg_temp.attachment(
  p_attachment_id text,
  p_capture_id text,
  p_kind text,
  p_reservation_id uuid
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
      p_attachment_id, '57575757-5757-4757-8757-575757575757',
      'capture_attachment', 'c5d.capture.ai.object.v1', p_reservation_id
    ),
    'contentMac', pg_temp.mac(p_attachment_id)
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
      p_capture_id, '57575757-5757-4757-8757-575757575757', 'capture',
      'c5d.capture.ai.object.v1', p_reservation_id, 'E'
    ),
    'contentMac', pg_temp.mac(p_capture_id || '-content'),
    'contentLength', 12,
    'source', 'mobile',
    'deviceId', 'organizer-attachment-test',
    'clientCreatedAt', pg_temp.event_time(),
    'clientTimezone', 'UTC',
    'privacy', 'ai_assisted',
    'explicitDestinationNoteId', null,
    'expansionDisabled', false,
    'routingRuleMatch', null,
    'privateReceiptCipher', null,
    'privateReceiptVerificationMac', null,
    'attachmentIds', p_attachment_ids
  );
$$;

create temporary table organizer_attachment_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on organizer_attachment_values to service_role;

-- Capability

select has_function(
  'public', 'list_encrypted_organizer_attachments', array['text', 'text'],
  'the organizer attachment listing has one exact signature'
);
select ok(
  has_function_privilege(
    'unfiled_organizer_worker',
    'public.list_encrypted_organizer_attachments(text,text)', 'EXECUTE'
  )
    and not has_function_privilege(
      'service_role', 'public.list_encrypted_organizer_attachments(text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.list_encrypted_organizer_attachments(text,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'unfiled_organizer_worker',
      'private.list_encrypted_organizer_attachments_impl(text,text)', 'EXECUTE'
    ),
  'only the organizer login may list attachments, and only through the public wrapper'
);

-- Owner with one capture carrying a photo and a recording, plus one unbound upload

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '57575757-5757-4757-8757-575757575757',
  'authenticated', 'authenticated', 'organizer-attachments@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);
insert into public.content_encryption_rollouts(user_id)
values ('57575757-5757-4757-8757-575757575757');
insert into public.user_content_keys (
  user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
  wrapped_intermediate_key, state, activated_at
) values
  (
    '57575757-5757-4757-8757-575757575757',
    'c5d.capture.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000001',
    decode(repeat('11', 32), 'hex'), 'active', now()
  ),
  (
    '57575757-5757-4757-8757-575757575757',
    'c5d.capture.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000002',
    decode(repeat('12', 32), 'hex'), 'active', now()
  ),
  (
    '57575757-5757-4757-8757-575757575757',
    'c5d.capture.private.object.v1', 'private_manual', 'object_wrap', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000003',
    decode(repeat('13', 32), 'hex'), 'active', now()
  ),
  (
    '57575757-5757-4757-8757-575757575757',
    'c5d.capture.private.mac.v1', 'private_manual', 'content_mac', 1,
    'arn:aws:kms:us-west-2:123456789012:key/99000000-0000-4000-8000-000000000004',
    decode(repeat('14', 32), 'hex'), 'active', now()
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.advance_content_encryption_rollout(
    '57575757-5757-4757-8757-575757575757', 'expanded', 'dual_write'
  ) ->> 'state',
  'dual_write',
  'the owner enters encrypted dual-write'
);
select public.reserve_content_key_operations(
  '57575757-5757-4757-8757-575757575757',
  reservation_id, 'ai_assisted', 'c5d.capture.ai.object.v1', 1, 1
)
from (values
  ('99000000-0000-4000-8000-000000000010'::uuid),
  ('99000000-0000-4000-8000-000000000011'::uuid),
  ('99000000-0000-4000-8000-000000000012'::uuid),
  ('99000000-0000-4000-8000-000000000013'::uuid)
) as reservations(reservation_id);
select public.create_encrypted_capture_attachment(
  '57575757-5757-4757-8757-575757575757',
  pg_temp.attachment(
    'att_99000000000000000000000001', 'cap_99000000000000000000000001',
    'image', '99000000-0000-4000-8000-000000000010'
  )
);
select public.create_encrypted_capture_attachment(
  '57575757-5757-4757-8757-575757575757',
  pg_temp.attachment(
    'att_99000000000000000000000002', 'cap_99000000000000000000000001',
    'audio', '99000000-0000-4000-8000-000000000011'
  )
);
select public.create_encrypted_capture_attachment(
  '57575757-5757-4757-8757-575757575757',
  pg_temp.attachment(
    'att_99000000000000000000000003', 'cap_99000000000000000000000001',
    'image', '99000000-0000-4000-8000-000000000012'
  )
);
select public.create_encrypted_capture_with_job(
  '57575757-5757-4757-8757-575757575757',
  pg_temp.capture(
    'cap_99000000000000000000000001', 'job_99000000000000000000000001',
    '99000000-0000-4000-8000-000000000013',
    '["att_99000000000000000000000001", "att_99000000000000000000000002"]'
  )
);
reset role;

-- Lease-bound listing

update public.organization_jobs
set available_at = clock_timestamp() - interval '1 second'
where id = 'job_99000000000000000000000001';
insert into organizer_attachment_values(key, value)
values ('claim', private.claim_encrypted_organizer_jobs_impl('attachment-worker', 1, 60));
select is(
  (select value #>> '{jobs,0,jobId}' from organizer_attachment_values where key = 'claim'),
  'job_99000000000000000000000001',
  'the worker claims the capture job'
);
insert into organizer_attachment_values(key, value)
select 'attachments', private.list_encrypted_organizer_attachments_impl(
  value #>> '{jobs,0,jobId}', value #>> '{jobs,0,leaseToken}'
)
from organizer_attachment_values where key = 'claim';
select is(
  (select value ->> 'returnedCount' from organizer_attachment_values where key = 'attachments'),
  '2',
  'only the two bound attachments of the leased capture are listed'
);
select is(
  (select value #>> '{attachments,0,attachmentId}'
   from organizer_attachment_values where key = 'attachments'),
  'att_99000000000000000000000001',
  'attachments come back in upload order'
);
select is(
  (select (value #> '{attachments,1}'::text[]) - 'source'::text
   from organizer_attachment_values where key = 'attachments'),
  jsonb_build_object(
    'attachmentId', 'att_99000000000000000000000002',
    'kind', 'audio', 'mediaType', 'audio/mp4', 'byteLength', 4096,
    'width', null, 'height', null, 'durationMs', 4200
  ),
  'the recording is described without its bytes'
);
select ok(
  (select value #>> '{attachments,0,source,envelope,context,kind}'
   from organizer_attachment_values where key = 'attachments') = 'capture_attachment'
    and (select value #>> '{attachments,0,source,keyRecord,keyClass}'
      from organizer_attachment_values where key = 'attachments') = 'ai_assisted'
    and (select value #>> '{attachments,0,source,contentMacKeyRecord,keyPurpose}'
      from organizer_attachment_values where key = 'attachments') = 'content_mac'
    and (select value #>> '{attachments,0,source,contentMac,mac}'
      from organizer_attachment_values where key = 'attachments')
      = encode(extensions.digest('att_99000000000000000000000001', 'sha256'), 'hex')
    and (select value #>> '{attachments,0,source,encryptedByteLength}'
      from organizer_attachment_values where key = 'attachments') = '48',
  'each attachment carries its sealed envelope, both key records, and its MAC'
);
select throws_ok(
  $$select private.list_encrypted_organizer_attachments_impl(
    'job_99000000000000000000000001', '00000000-0000-4000-8000-000000000000'
  )$$,
  '42501', 'invalid_or_expired_lease',
  'a wrong lease token reads nothing'
);

-- SET ROLE is not the organizer login

-- SET ROLE is not a production login: session_user stays postgres, so the public wrapper
-- refuses even though the grant exists. pgTAP's own assertions do not run under the role, so
-- the refusal is captured and checked after the role is dropped.
grant unfiled_organizer_worker to postgres;
set local role unfiled_organizer_worker;
insert into organizer_attachment_values(key, value)
values ('set-role-error', pg_temp.caught_error(
  $$select public.list_encrypted_organizer_attachments(
    'job_99000000000000000000000001', '00000000-0000-4000-8000-000000000000'
  )$$
));
reset role;
select is(
  (select value ->> 'message' from organizer_attachment_values where key = 'set-role-error'),
  'forbidden',
  'SET ROLE cannot impersonate the organizer login for attachments'
);

select * from finish();
rollback;
