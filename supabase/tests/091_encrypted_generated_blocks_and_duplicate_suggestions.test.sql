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
  return jsonb_build_object('sqlstate',sqlstate,'message',sqlerrm);
end;
$$;

create function pg_temp.e3_envelope(
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
    'version',1,'suite','A256GCM','keyId',p_key_id,
    'context',jsonb_build_object(
      'tenantId',p_owner_id::text,'resourceId',p_resource_id,
      'recordVersion',p_record_version,'kind',p_kind
    ),
    'wrappedDataKey',jsonb_build_object(
      'nonce',repeat('A',16),'ciphertext',repeat('B',64)
    ),
    'payload',jsonb_build_object(
      'nonce',repeat('C',16),'ciphertext',repeat(left(p_seed,1),64)
    )
  );
$$;

create function pg_temp.e3_mac(p_key jsonb,p_seed text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac',encode(extensions.digest(p_seed,'sha256'),'hex'),
    'keyId',p_key ->> 'keyId','keyClass',p_key ->> 'keyClass',
    'keyPurpose',coalesce(p_key ->> 'purpose',p_key ->> 'keyPurpose'),
    'keyVersion',(p_key ->> 'keyVersion')::integer
  );
$$;

create function pg_temp.e3_reservation(p_preparation jsonb,p_role text)
returns jsonb
language sql
immutable
as $$
  select item from jsonb_array_elements(p_preparation -> 'reservations')
    as supplied(item)
  where item ->> 'role' = p_role;
$$;

create function pg_temp.e3_cipher(
  p_owner_id uuid,
  p_reservation jsonb,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope',pg_temp.e3_envelope(
      p_owner_id,p_reservation ->> 'resourceId',
      (p_reservation ->> 'recordVersion')::integer,
      p_reservation ->> 'surface',p_reservation #>> '{key,keyId}',p_seed
    ),
    'keyId',p_reservation #>> '{key,keyId}',
    'keyClass',p_reservation ->> 'keyClass',
    'keyPurpose','object_wrap',
    'keyVersion',(p_reservation #>> '{key,keyVersion}')::integer,
    'reservationId',p_reservation ->> 'reservationId'
  );
$$;

create function pg_temp.e3_resolution_command(
  p_owner_id uuid,
  p_preparation jsonb,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'requestMac',pg_temp.e3_mac(
      p_preparation -> 'requestMacKey',p_seed || '-request'
    ),
    'responseCipher',pg_temp.e3_cipher(
      p_owner_id,pg_temp.e3_reservation(p_preparation,'response'),
      p_seed || 'O'
    ),
    'responseVerificationMac',pg_temp.e3_mac(
      p_preparation -> 'requestMacKey',p_seed || '-response'
    ),
    'writes','[]'::jsonb,
    'receipt',jsonb_build_object(
      'recordVersion',
        (p_preparation #>> '{source,receipt,recordVersion}')::integer + 1,
      'cipher',pg_temp.e3_cipher(
        p_owner_id,pg_temp.e3_reservation(p_preparation,'receipt'),
        p_seed || 'C'
      ),
      'verificationMac',pg_temp.e3_mac(
        p_preparation -> 'requestMacKey',
        p_seed || '-receipt'
      )
    ),
    'review',jsonb_build_object(
      'reviewItemId',p_preparation #>> '{ids,reviewItemId}',
      'recordVersion',
        (p_preparation #>> '{source,review,recordVersion}')::integer + 1,
      'type',p_preparation #>> '{source,review,type}',
      'cipher',pg_temp.e3_cipher(
        p_owner_id,pg_temp.e3_reservation(p_preparation,'review'),
        p_seed || 'V'
      ),
      'verificationMac',pg_temp.e3_mac(
        p_preparation -> 'requestMacKey',
        p_seed || '-review'
      )
    )
  );
$$;

create function pg_temp.e3_organizer_cipher(
  p_owner_id uuid,
  p_preparation jsonb,
  p_role text,
  p_resource_id text,
  p_record_version integer,
  p_kind text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope',pg_temp.e3_envelope(
      p_owner_id,p_resource_id,p_record_version,p_kind,
      p_preparation #>> '{keys,objectWrap,keyId}',p_seed
    ),
    'keyId',p_preparation #>> '{keys,objectWrap,keyId}',
    'keyClass',p_preparation #>> '{keys,objectWrap,keyClass}',
    'keyPurpose','object_wrap',
    'keyVersion',
      (p_preparation #>> '{keys,objectWrap,keyVersion}')::integer,
    'reservationId',p_preparation #>> array[
      'reservations',p_role,'reservationId'
    ]
  );
$$;

create function pg_temp.e3_note_state(p_title text,p_body text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'spaceId',null,'type','generic','title',p_title,
    'bodyMarkdown',p_body,
    'structuredData',jsonb_build_object('schemaVersion',1),
    'dailyDate',null,'isOpen',true,'privacy','ai_assisted',
    'pinnedAt',null,'archivedAt',null,'deletedAt',null,
    'tagIds','[]'::jsonb,'links','[]'::jsonb
  );
$$;

create function pg_temp.e3_disclosure_manifest(p_page jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'controls',p_page -> 'controls',
    'candidates',coalesce((
      select jsonb_agg(jsonb_build_object(
        'candidateId',candidate ->> 'candidateId',
        'noteId',candidate ->> 'noteId',
        'revision',candidate -> 'revision',
        'isOpen',candidate #> '{metadata,isOpen}'
      ) order by ordinal)
      from jsonb_array_elements(p_page -> 'candidates')
        with ordinality as listed(candidate,ordinal)
    ),'[]'::jsonb)
  );
$$;

create temporary table e3_values(
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on e3_values to service_role;

create temporary table e3_retention_reservations(
  reservation_id uuid primary key
) on commit drop;

create temporary table e3_loser_reservations(
  scenario text not null,
  reservation_id uuid not null,
  primary key (scenario,reservation_id)
) on commit drop;

create function pg_temp.e3_generated_block_page_summary(
  p_owner_id uuid,
  p_note_id text
)
returns jsonb
language plpgsql
as $$
declare
  after_block_id text := null;
  page_ids text[];
  page_count integer := 0;
  item_count integer := 0;
  next_block_id text;
begin
  loop
    select coalesce(array_agg(page.resource_id order by page.resource_id),array[]::text[])
    into page_ids
    from public.get_encrypted_generated_blocks(
      p_owner_id,p_note_id,after_block_id,51
    ) as page;
    page_count := page_count + 1;
    item_count := item_count + least(cardinality(page_ids),50);
    if cardinality(page_ids) <= 50 then exit; end if;
    next_block_id := page_ids[50];
    if next_block_id is null
      or (after_block_id is not null and next_block_id <= after_block_id)
    then
      raise exception using errcode = 'P0001', message = 'stale_cursor';
    end if;
    after_block_id := next_block_id;
  end loop;
  return jsonb_build_object(
    'items',item_count,'pages',page_count,'lastCursor',after_block_id
  );
end;
$$;

-- Schema and least-privilege boundary.
select has_table(
  'public','encrypted_generated_block_resolution_claims',
  'generated-block resolution CAS claims are durable'
);
select has_column(
  'public','encrypted_organizer_preparations','generated_block_id',
  'organizer preparation freezes a generated-block ID'
);
select has_column(
  'public','encrypted_organizer_preparations',
  'generated_block_reservation_id',
  'organizer preparation freezes the eighth wrap reservation'
);
select has_column(
  'public','organization_jobs','model_id',
  'organization jobs freeze model provenance'
);
select ok(
  not exists (
    select 1
    from pg_constraint as constraint_record
    where constraint_record.conrelid =
      'public.encrypted_generated_block_resolution_claims'::regclass
      and constraint_record.contype = 'u'
      and pg_get_constraintdef(constraint_record.oid)
        like '%(user_id, generated_block_id)%'
  ),
  'a lost prepare never permanently claims a generated block'
);
select has_function(
  'public','resolve_encrypted_generated_block',
  array['uuid','text','integer','text','jsonb']
);
select has_function(
  'public','get_encrypted_generated_blocks',
  array['uuid','text','text','integer'],
  'generated blocks have a dedicated owner-and-note-scoped page overload'
);
select has_index(
  'public','generated_blocks','generated_blocks_rejected_retention',
  'rejected generated blocks have a bounded retention index'
);
select has_index(
  'public','generated_blocks','generated_blocks_visible_note_keyset',
  'visible generated blocks have an owner-note cursor index'
);
select ok(
  pg_get_indexdef('public.generated_blocks_visible_note_keyset'::regclass)
    like '%(user_id, note_id, id)%'
  and pg_get_indexdef('public.generated_blocks_visible_note_keyset'::regclass)
    like '%state <> ''rejected''%'
  and pg_get_indexdef('public.generated_blocks_visible_note_keyset'::regclass)
    like '%content_envelope IS NOT NULL%',
  'the note cursor index matches visibility and ciphertext predicates'
);
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='generated_blocks'
      and column_name='rejected_retention_started_at'
  )
  and pg_get_indexdef(
    'public.generated_blocks_rejected_retention'::regclass
  ) like '%rejected_retention_started_at%',
  'rejected retention uses a private post-commit lifecycle clock'
);
select ok(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_class as relation
    where relation.oid =
      'public.encrypted_generated_block_resolution_claims'::regclass
  ) and not exists (
    select 1 from pg_policy
    where polrelid =
      'public.encrypted_generated_block_resolution_claims'::regclass
  ),
  'generated-block claims use forced policy-free RLS'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'anon','authenticated','unfiled_organizer_worker',
      'unfiled_index_worker','unfiled_rag_verifier'
    ]) as denied(role_name)
    where has_function_privilege(
      denied.role_name,
      'public.resolve_encrypted_generated_block(uuid,text,integer,text,jsonb)',
      'EXECUTE'
    )
  ) and not exists (
    select 1
    from pg_proc as procedure
    cross join lateral aclexplode(coalesce(
      procedure.proacl,acldefault('f',procedure.proowner)
    )) as privilege
    where procedure.oid =
      'public.resolve_encrypted_generated_block(uuid,text,integer,text,jsonb)'::regprocedure
      and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
  ) and has_function_privilege(
    'service_role',
    'public.resolve_encrypted_generated_block(uuid,text,integer,text,jsonb)',
    'EXECUTE'
  ),
  'only service_role may resolve an encrypted generated block'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'anon','authenticated','unfiled_organizer_worker',
      'unfiled_index_worker','unfiled_rag_verifier'
    ]) as denied(role_name)
    where has_function_privilege(
      denied.role_name,
      'public.get_encrypted_generated_blocks(uuid,text,text,integer)',
      'EXECUTE'
    )
  ) and not exists (
    select 1
    from pg_proc as procedure
    cross join lateral aclexplode(coalesce(
      procedure.proacl,acldefault('f',procedure.proowner)
    )) as privilege
    where procedure.oid =
      'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
      and privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
  ) and has_function_privilege(
    'service_role',
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)',
    'EXECUTE'
  ),
  'only service_role may page one owner note generated-block collection'
);
select ok(
  lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) like '%block.user_id = p_owner_id%'
  and lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) like '%block.note_id = p_note_id%'
  and lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) like '%block.state <> ''rejected''%'
  and lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) like '%block.id > p_after_block_id%'
  and lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) like '%order by block.id%'
  and lower(pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text,text,integer)'::regprocedure
  )) not like '%list_encrypted_library_objects%',
  'note pages filter in SQL and use a deterministic block-ID keyset without owner-wide scanning'
);
select is(
  (
    select count(*) from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(
        'unfiled_organizer_worker',procedure.oid,'EXECUTE'
      )
  ),
  12::bigint,
  'the organizer has exactly twelve public capabilities after E4'
);
select ok(
  contract.note_write_advisory > 0
  and contract.rollout_advisory > contract.note_write_advisory
  and contract.sorted_note_lock > contract.rollout_advisory
  and contract.review_lock_source > contract.sorted_note_lock,
  'the E3 Review wrapper proves owner advisories and sorted notes precede its Review lock'
)
from (
  select
    strpos(definition,':encrypted-note-write:') as note_write_advisory,
    strpos(definition,':content-encryption-rollout') as rollout_advisory,
    strpos(definition,'order by note.id for update') as sorted_note_lock,
    strpos(definition,'from public.review_items') as review_lock_source
  from (
    select lower(pg_get_functiondef(
      'public.commit_encrypted_review_resolution(uuid,text,text,jsonb)'::regprocedure
    )) as definition
  ) as function_definition
) as contract;
select ok(
  not has_table_privilege(
    'service_role',
    'public.encrypted_generated_block_resolution_claims',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service_role receives no direct generated-block claim table access'
);
select ok(
  to_regprocedure(
    'public.purge_expired_rejected_generated_blocks(uuid,timestamptz,integer,boolean)'
  ) is null
  and to_regprocedure(
    'private.purge_expired_rejected_generated_blocks(uuid,timestamptz,integer,boolean)'
  ) is not null
  and not has_function_privilege(
    'service_role',
    'private.purge_expired_rejected_generated_blocks(uuid,timestamptz,integer,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'unfiled_organizer_worker',
    'private.purge_expired_rejected_generated_blocks(uuid,timestamptz,integer,boolean)',
    'EXECUTE'
  )
  and pg_get_functiondef(
    'public.claim_encrypted_note_retention(uuid,uuid,uuid,timestamptz,integer,boolean,integer)'::regprocedure
  ) like '%private.purge_expired_rejected_generated_blocks(%',
  'seven-day block cleanup stays private behind the existing retention batch'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'encrypted_generated_block_resolution_claims'
      and column_name ~ '(content|text|proposal|response|operations|inverse)'
  ),
  'resolution coordination stores no generated or user plaintext'
);
select ok(
  pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text[])'::regprocedure
  ) like '%stateRevision%'
  and pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text[])'::regprocedure
  ) like '%reviewItemId%'
  and pg_get_functiondef(
    'public.list_encrypted_library_objects(uuid,text,text,integer)'::regprocedure
  ) like '%stateRevision%'
  and pg_get_functiondef(
    'public.list_encrypted_library_objects(uuid,text,text,integer)'::regprocedure
  ) like '%reviewItemId%',
  'both encrypted block projections expose state CAS and Review binding'
);
select ok(
  pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like '%duplicate_suggestion%'
  and pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like '%insert_encrypted_organizer_generated_block%'
  and pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like '%commit_encrypted_organizer_job_impl_e2%',
  'E3 duplicate and expansion branches preserve the E2 routing wrapper'
);
select ok(
  pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like '%duplicate_reason_codes%'
  and pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like '%p_command #> ''{decision,reasonCodes}''%'
  and pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) not like '%reason_codes = array[''duplicate_suggestion'']%',
  'duplicate publication preserves the sealed receipt reason projection'
);

-- Canonical owner-bound encrypted fixtures.
insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  confirmation_token,recovery_token,email_change_token_new,email_change,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  '93939393-9393-4939-8939-939393939393','authenticated','authenticated',
  'e3-owner@unfiled.local','',now(),'','','','',
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,
  now(),now()
),
(
  '00000000-0000-0000-0000-000000000000',
  '94949494-9494-4949-8949-949494949494','authenticated','authenticated',
  'e3-other@unfiled.local','',now(),'','','','',
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,
  now(),now()
);

insert into public.content_encryption_rollouts(user_id,state) values
  ('93939393-9393-4939-8939-939393939393','encrypted_only'),
  ('94949494-9494-4949-8949-949494949494','encrypted_only');

insert into public.user_content_keys (
  user_id,key_id,key_class,key_purpose,key_version,kms_key_id,
  wrapped_intermediate_key,state,created_at,activated_at
) values
(
  '93939393-9393-4939-8939-939393939393','e3.ai.object.v1',
  'ai_assisted','object_wrap',1,
  'arn:aws:kms:us-west-2:123456789012:key/93000000-0000-4000-8000-000000000001',
  decode(repeat('93',32),'hex'),'active',now(),now()
),
(
  '93939393-9393-4939-8939-939393939393','e3.ai.mac.v1',
  'ai_assisted','content_mac',1,
  'arn:aws:kms:us-west-2:123456789012:key/93000000-0000-4000-8000-000000000002',
  decode(repeat('94',32),'hex'),'active',now(),now()
);

insert into public.notes (
  id,user_id,type,title,body_markdown,structured_data,current_revision,
  is_open,privacy,content_envelope,content_key_id,content_key_class,
  content_key_purpose,content_key_version
) values (
  'note_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393','generic','[encrypted]',
  '[encrypted]','{}'::jsonb,1,true,'ai_assisted',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'note_93000000000000000000000001',1,'note_content',
    'e3.ai.object.v1','N'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

insert into public.captures (
  id,user_id,source,device_id,raw_text,privacy,client_created_at,
  client_timezone,status,content_envelope,content_fingerprint,content_length,
  content_key_id,content_key_class,content_key_purpose,content_key_version,
  fingerprint_key_id,fingerprint_key_class,fingerprint_key_purpose,
  fingerprint_key_version
) values (
  'cap_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393','web','e3-test','[encrypted]',
  'ai_assisted',now(),'UTC','needs_review',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000001',1,'capture',
    'e3.ai.object.v1','C'
  ),encode(extensions.digest('e3-capture','sha256'),'hex'),24,
  'e3.ai.object.v1','ai_assisted','object_wrap',1,
  'e3.ai.mac.v1','ai_assisted','content_mac',1
);

insert into public.organization_jobs (
  id,capture_id,user_id,state,prompt_version,schema_version,completed_at
) values (
  'job_93000000000000000000000001',
  'cap_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393','succeeded','routing-v1',1,now()
);

insert into public.organization_decisions (
  id,capture_id,user_id,candidate_manifest,signals,validated_plan,band,
  destination_note_id,reason_codes,decision_envelope,decision_key_id,
  decision_key_class,decision_key_purpose,decision_key_version
) values (
  'dec_93000000000000000000000001',
  'cap_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393','{}'::jsonb,'{}'::jsonb,null,
  'auto','note_93000000000000000000000001',array['encrypted_organizer'],
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'dec_93000000000000000000000001',1,'organization_decision',
    'e3.ai.object.v1','D'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

insert into public.note_mutations (
  id,user_id,decision_id,note_id,idempotency_key,before_revision,
  after_revision,operations,inverse,mutation_envelope,mutation_key_id,
  mutation_key_class,mutation_key_purpose,mutation_key_version
) values (
  'mut_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393',
  'dec_93000000000000000000000001',
  'note_93000000000000000000000001','e3-route',0,1,
  '[]'::jsonb,'[]'::jsonb,
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'mut_93000000000000000000000001',1,'note_mutation',
    'e3.ai.object.v1','M'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

insert into public.review_items (
  id,user_id,capture_id,note_id,type,state,choices,review_envelope,
  review_key_id,review_key_class,review_key_purpose,review_key_version,
  review_content_revision
) values (
  'rvw_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393',
  'cap_93000000000000000000000001',
  'note_93000000000000000000000001','pending_expansion','open','[]'::jsonb,
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000001',1,'review_item',
    'e3.ai.object.v1','V'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1,1
);

insert into public.generated_blocks (
  id,user_id,note_id,decision_id,kind,content,state,model_id,
  prompt_version,review_item_id,state_revision,content_envelope,
  content_key_id,content_key_class,content_key_purpose,content_key_version
) values (
  'blk_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393',
  'note_93000000000000000000000001',
  'dec_93000000000000000000000001','summary','[encrypted]','proposed',
  'gpt-5.4-mini-2026-03-17','routing-v1',
  'rvw_93000000000000000000000001',1,
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000001',1,'generated_block',
    'e3.ai.object.v1','B'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

insert into public.capture_receipts (
  capture_id,job_id,user_id,decision_id,review_item_id,mutation_id,outcome,
  headline,destination_note_id,inserted_content,actions,reason_codes,
  receipt_envelope,receipt_key_id,receipt_key_class,receipt_key_purpose,
  receipt_key_version
) values (
  'cap_93000000000000000000000001',
  'job_93000000000000000000000001',
  '93939393-9393-4939-8939-939393939393',
  'dec_93000000000000000000000001',
  'rvw_93000000000000000000000001',
  'mut_93000000000000000000000001','added_to_note','[encrypted]',
  'note_93000000000000000000000001','[]'::jsonb,'[]'::jsonb,
  array['expansion_pending'],
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000001',1,'capture_receipt',
    'e3.ai.object.v1','R'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

-- Accepted generated blocks remain with their note, so availability cannot be
-- implemented as a permanent retained-row cap.  This 1,001-row note proves
-- every retained block remains reachable through bounded, non-overlapping
-- note-scoped pages while foreign owners and foreign notes disclose nothing.
insert into public.notes (
  id,user_id,type,title,body_markdown,structured_data,current_revision,
  is_open,privacy,content_envelope,content_key_id,content_key_class,
  content_key_purpose,content_key_version
) values (
  'note_93000000000000000000000090',
  '93939393-9393-4939-8939-939393939393','generic','[encrypted]',
  '[encrypted]','{}'::jsonb,1,true,'ai_assisted',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'note_93000000000000000000000090',1,'note_content',
    'e3.ai.object.v1','P'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

insert into public.generated_blocks (
  id,user_id,note_id,decision_id,kind,content,state,model_id,
  prompt_version,review_item_id,state_revision,resolved_at,created_at,
  content_envelope,content_key_id,content_key_class,content_key_purpose,
  content_key_version
)
select
  generated.id,
  '93939393-9393-4939-8939-939393939393',
  'note_93000000000000000000000090',
  'dec_93000000000000000000000001','suggestion','[encrypted]',generated.state,
  'gpt-5.4-mini-2026-03-17','routing-v1',null,2,now(),now()-interval '1 day',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',generated.id,1,
    'generated_block','e3.ai.object.v1','Q'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
from (
  select
    'blk_' || lpad(ordinal::text,26,'0') as id,
    case when ordinal=50 then 'rejected'::public.block_state
      else 'accepted'::public.block_state end as state
  from generate_series(1,1002) as generated_series(ordinal)
) as generated;

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values
(
  'capacity-page-summary',
  pg_temp.e3_generated_block_page_summary(
    '93939393-9393-4939-8939-939393939393',
    'note_93000000000000000000000090'
  )
),
(
  'foreign-owner-page-summary',
  pg_temp.e3_generated_block_page_summary(
    '94949494-9494-4949-8949-949494949494',
    'note_93000000000000000000000090'
  )
),
(
  'foreign-note-page-summary',
  pg_temp.e3_generated_block_page_summary(
    '93939393-9393-4939-8939-939393939393',
    'note_93000000000000000000000091'
  )
);
reset role;

select ok(
  (select value #>> '{items}' from e3_values
    where key='capacity-page-summary')='1001'
  and (select value #>> '{pages}' from e3_values
    where key='capacity-page-summary')='21'
  and (select value #>> '{items}' from e3_values
    where key='foreign-owner-page-summary')='0'
  and (select value #>> '{items}' from e3_values
    where key='foreign-note-page-summary')='0',
  '1,001 visible retained blocks are reachable in 21 scoped pages without rejected, cross-owner, or cross-note disclosure'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select results_eq(
  $$select resource_id from public.get_encrypted_generated_blocks(
    '93939393-9393-4939-8939-939393939393',
    'note_93000000000000000000000090',
    'blk_00000000000000000000000049',2
  )$$,
  $$values
    ('blk_00000000000000000000000051'::text),
    ('blk_00000000000000000000000052'::text)$$,
  'the note cursor resumes strictly after the last visible block without spending a slot on rejected retention'
);
select is(
  pg_temp.caught_error($statement$
    select * from public.get_encrypted_generated_blocks(
      '93939393-9393-4939-8939-939393939393',
      'note_93000000000000000000000090',null,52
    )
  $statement$) ->> 'message',
  'validation_failed',
  'the scoped database lookahead is bounded to 51 rows'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"93939393-9393-4939-8939-939393939393"}',true);
select is(
  pg_temp.caught_error($statement$
    select * from public.get_encrypted_generated_blocks(
      '93939393-9393-4939-8939-939393939393',
      'note_93000000000000000000000090',null,51
    )
  $statement$) ->> 'sqlstate',
  '42501',
  'an authenticated browser role cannot execute the scoped service capability'
);
reset role;

insert into e3_values(key,value)
select 'note-before',jsonb_build_object(
  'revision',current_revision,
  'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
  'mutationCount',(select count(*) from public.note_mutations
    where user_id = note.user_id and note_id = note.id)
)
from public.notes as note
where id = 'note_93000000000000000000000001';

select is(
  pg_temp.caught_error($statement$
    update public.organization_jobs
    set model_id = 'different-model'
    where id = 'job_93000000000000000000000001'
  $statement$) ->> 'message',
  'immutable_job_model',
  'actual job model provenance is immutable'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  pg_temp.caught_error($statement$
    select * from public.encrypted_generated_block_resolution_claims
  $statement$) ->> 'sqlstate',
  '42501',
  'forced RLS blocks direct service-role claim reads'
);
reset role;

-- Accept path: exact prepare projection, failed commit rollback, atomic CAS,
-- replay, and unchanged user-authored note state.
savepoint accept_path;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'abandoned-prepare',
  public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000001','e3-abandoned',
    '{"type":"accept_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
  )
);
insert into e3_values(key,value) values (
  'accept-prepare',
  public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000001','e3-accept',
    '{"type":"accept_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
  )
);
reset role;

select ok(
  (select count(*)
    from public.encrypted_generated_block_resolution_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and generated_block_id='blk_93000000000000000000000001')=2
  and not exists (
    select 1
    from jsonb_array_elements(
      (select value -> 'reservations' from e3_values
       where key='abandoned-prepare')
    ) as abandoned(reservation)
    join jsonb_array_elements(
      (select value -> 'reservations' from e3_values
       where key='accept-prepare')
    ) as replacement(reservation)
      on replacement.reservation ->> 'reservationId'
        = abandoned.reservation ->> 'reservationId'
  ),
  'a new device key may prepare while an earlier prepare remains abandoned'
);
insert into e3_loser_reservations(scenario,reservation_id)
select 'accept',reservation_id
from public.encrypted_owner_interaction_reservations
where user_id='93939393-9393-4939-8939-939393939393'
  and idempotency_key='e3-abandoned';

select ok(
  (select value ->> 'action' from e3_values where key='accept-prepare')
    = 'accept_expansion'
  and (select value #>> '{ids,generatedBlockId}'
    from e3_values where key='accept-prepare')
    = 'blk_93000000000000000000000001'
  and (select value #>> '{ids,stateRevision}'
    from e3_values where key='accept-prepare') = '1'
  and (select value #>> '{source,generatedBlock,reviewItemId}'
    from e3_values where key='accept-prepare')
    = 'rvw_93000000000000000000000001'
  and (select jsonb_array_length(value -> 'reservations')
    from e3_values where key='accept-prepare') = 3,
  'expansion prepare returns exact block CAS, Review binding, and three wraps'
);

select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '94949494-9494-4949-8949-949494949494',
      'rvw_93000000000000000000000001','e3-cross-owner',
      '{"type":"accept_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
    )
  $statement$) ->> 'message',
  'not_found',
  'cross-owner prepare cannot discover a generated block'
);

insert into e3_values(key,value)
select 'accept-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'accept'
)
from e3_values where key='accept-prepare';
insert into e3_values(key,value)
select 'abandoned-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'abandoned'
)
from e3_values where key='abandoned-prepare';

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  pg_temp.caught_error(format(
    $statement$
      select public.resolve_encrypted_generated_block(%L,%L,1,%L,%L::jsonb)
    $statement$,
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000001','e3-accept',
    jsonb_set(value,'{review,cipher,envelope,context,resourceId}',
      '"rvw_93000000000000000000009999"'::jsonb,true)::text
  )) ->> 'message',
  'invalid_encrypted_field',
  'tampered Review AAD aborts the whole generated-block resolution'
)
from e3_values where key='accept-command';
reset role;
select ok(
  (select state='proposed' and state_revision=1
    from public.generated_blocks
    where id='blk_93000000000000000000000001')
  and (select state='open' and review_content_revision=1
    from public.review_items
    where id='rvw_93000000000000000000000001')
  and (select receipt_revision=1
    from public.capture_receipts
    where capture_id='cap_93000000000000000000000001')
  and not exists (
    select 1 from public.content_key_operation_reservations as reservation
    join public.encrypted_owner_interaction_reservations as binding
      on binding.user_id=reservation.user_id
      and binding.reservation_id=reservation.reservation_id
    where binding.user_id='93939393-9393-4939-8939-939393939393'
      and binding.idempotency_key='e3-accept'
      and reservation.consumed_at is not null
  ),
  'invalid ciphertext rolls back block, Review, receipt, and reservations'
);

select is(
  pg_temp.caught_error($statement$
    select public.commit_encrypted_review_resolution(
      '93939393-9393-4939-8939-939393939393',
      'rvw_93000000000000000000000001','e3-accept','{}'::jsonb
    )
  $statement$) ->> 'message',
  'generated_block_resolver_required',
  'generic Review commit cannot bypass the block CAS'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'accept-result',public.resolve_encrypted_generated_block(
  '93939393-9393-4939-8939-939393939393',
  'blk_93000000000000000000000001',1,'e3-accept',value
)
from e3_values where key='accept-command';
reset role;

select ok(
  (select value ->> 'outcome' from e3_values where key='accept-result')
    = 'accepted'
  and (select value ->> 'stateRevision'
    from e3_values where key='accept-result') = '2'
  and (select state='accepted' and state_revision=2 and resolved_at is not null
    from public.generated_blocks
    where id='blk_93000000000000000000000001')
  and (select state='resolved' and review_content_revision=2
    from public.review_items
    where id='rvw_93000000000000000000000001')
  and (select receipt_revision=2 and review_item_id is null
    from public.capture_receipts
    where capture_id='cap_93000000000000000000000001')
  and (select status='organized' from public.captures
    where id='cap_93000000000000000000000001')
  and exists (
    select 1 from public.feedback_events
    where id=(select value ->> 'feedbackEventId'
      from e3_values where key='accept-result')
      and action='expansion_accepted'
      and generated_block_id='blk_93000000000000000000000001'
  ),
  'accept atomically resolves block, Review, receipt, capture, and feedback'
);
select is(
  (select jsonb_build_object(
    'revision',current_revision,
    'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
    'mutationCount',(select count(*) from public.note_mutations
      where user_id=note.user_id and note_id=note.id)
  ) from public.notes as note
  where id='note_93000000000000000000000001'),
  (select value from e3_values where key='note-before'),
  'accept never rewrites user-authored note content or mutations'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  pg_temp.caught_error(format(
    $statement$
      select public.resolve_encrypted_generated_block(%L,%L,1,%L,%L::jsonb)
    $statement$,
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000001','e3-abandoned',value::text
  )) ->> 'message',
  'stale_revision',
  'the first commit wins and a second outstanding prepare fails cleanly'
)
from e3_values where key='abandoned-command';
reset role;
select ok(
  (select state='accepted' and state_revision=2
    from public.generated_blocks
    where id='blk_93000000000000000000000001')
  and not exists (
    select 1 from public.encrypted_generated_block_resolution_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-abandoned'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-abandoned'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_reservations
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-abandoned'
  )
  and not exists (
    select 1 from public.content_key_operation_reservations as reservation
    join e3_loser_reservations as retained
      on retained.reservation_id=reservation.reservation_id
    where retained.scenario='accept'
  ),
  'accept burns the losing claim and all of its independent wraps atomically'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'accept-replay',public.resolve_encrypted_generated_block(
  '93939393-9393-4939-8939-939393939393',
  'blk_93000000000000000000000001',1,'e3-accept',
  jsonb_build_object('requestMac',value -> 'requestMac')
)
from e3_values where key='accept-command';
reset role;
select ok(
  (select value ->> 'replayed' from e3_values where key='accept-replay')='true'
  and (select value -> 'encryptedResponse'
    from e3_values where key='accept-replay') =
    (select value -> 'encryptedResponse'
    from e3_values where key='accept-result')
  and (select count(*) from public.feedback_events
    where id=(select value ->> 'feedbackEventId'
      from e3_values where key='accept-result'))=1,
  'response-lost retry returns the same encrypted result without duplicate effects'
);

rollback to savepoint accept_path;

-- Reject path uses the same source fixture but a distinct logical request.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'reject-abandoned-prepare',
  public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000001','e3-reject-abandoned',
    '{"type":"reject_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
  )
);
insert into e3_values(key,value) values (
  'reject-prepare',
  public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000001','e3-reject',
    '{"type":"reject_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
  )
);
reset role;
-- Simulate a device that prepared this exact encrypted command eight days ago
-- and only now returns to commit it.  The production transition trigger keeps
-- this timestamp immutable; the test temporarily disables only that trigger
-- to model elapsed wall time without sleeping for eight days.
set constraints all immediate;
alter table public.encrypted_owner_interaction_claims
  disable trigger encrypted_owner_interaction_claim_transition;
update public.encrypted_owner_interaction_claims
set occurred_at=date_trunc(
      'milliseconds',clock_timestamp() - interval '8 days'
    ),
    created_at=clock_timestamp() - interval '8 days'
where user_id='93939393-9393-4939-8939-939393939393'
  and idempotency_key='e3-reject';
alter table public.encrypted_owner_interaction_claims
  enable trigger encrypted_owner_interaction_claim_transition;
set constraints all deferred;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update e3_values
set value=public.prepare_encrypted_review_resolution(
  '93939393-9393-4939-8939-939393939393',
  'rvw_93000000000000000000000001','e3-reject',
  '{"type":"reject_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
)
where key='reject-prepare';
reset role;
select ok(
  (select value ->> 'replayed' from e3_values
    where key='reject-prepare')='true'
  and (select (value ->> 'occurredAt')::timestamptz
      < clock_timestamp() - interval '7 days'
    from e3_values where key='reject-prepare'),
  'reject regression models an exact prepare held for longer than retention'
);
insert into e3_loser_reservations(scenario,reservation_id)
select 'reject',reservation_id
from public.encrypted_owner_interaction_reservations
where user_id='93939393-9393-4939-8939-939393939393'
  and idempotency_key='e3-reject-abandoned';
insert into e3_values(key,value)
select 'reject-abandoned-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'reject-abandoned'
)
from e3_values where key='reject-abandoned-prepare';
insert into e3_values(key,value)
select 'reject-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'reject'
)
from e3_values where key='reject-prepare';
insert into e3_values(key,value) values (
  'reject-commit-start',jsonb_build_object(
    'value',date_trunc('milliseconds',clock_timestamp())
  )
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'reject-result',public.resolve_encrypted_generated_block(
  '93939393-9393-4939-8939-939393939393',
  'blk_93000000000000000000000001',1,'e3-reject',value
)
from e3_values where key='reject-command';
reset role;

select ok(
  (select value ->> 'outcome' from e3_values where key='reject-result')
    = 'rejected'
  and (select state='rejected' and state_revision=2
      and resolved_at=(select (value ->> 'occurredAt')::timestamptz
        from e3_values where key='reject-prepare')
      and rejected_retention_started_at >= (
        select (value ->> 'value')::timestamptz
        from e3_values where key='reject-commit-start'
      )
      and rejected_retention_started_at
        > resolved_at + interval '7 days'
    from public.generated_blocks
    where id='blk_93000000000000000000000001')
  and (select state='resolved' and review_content_revision=2
    from public.review_items
    where id='rvw_93000000000000000000000001')
  and (select receipt_revision=2 and review_item_id is null
    from public.capture_receipts
    where capture_id='cap_93000000000000000000000001')
  and exists (
    select 1 from public.feedback_events
    where action='expansion_rejected'
      and generated_block_id='blk_93000000000000000000000001'
  ),
  'reject atomically hides the block and resolves its exact Review'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  pg_temp.caught_error(format(
    $statement$
      select public.resolve_encrypted_generated_block(%L,%L,1,%L,%L::jsonb)
    $statement$,
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000001','e3-reject-abandoned',value::text
  )) ->> 'message',
  'stale_revision',
  'a losing reject submission fails with the same clean block CAS error'
)
from e3_values where key='reject-abandoned-command';
reset role;
select ok(
  not exists (
    select 1 from public.encrypted_generated_block_resolution_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject-abandoned'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject-abandoned'
  )
  and not exists (
    select 1 from public.content_key_operation_reservations as reservation
    join e3_loser_reservations as retained
      on retained.reservation_id=reservation.reservation_id
    where retained.scenario='reject'
  ),
  'reject burns every losing claim so no abandoned sidecar blocks retention'
);
select is(
  (select jsonb_build_object(
    'revision',current_revision,
    'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
    'mutationCount',(select count(*) from public.note_mutations
      where user_id=note.user_id and note_id=note.id)
  ) from public.notes as note
  where id='note_93000000000000000000000001'),
  (select value from e3_values where key='note-before'),
  'reject never rewrites user-authored note content or mutations'
);

select is(
  pg_temp.caught_error($statement$
    select public.prepare_encrypted_review_resolution(
      '93939393-9393-4939-8939-939393939393',
      'rvw_93000000000000000000000001','e3-after-terminal',
      '{"type":"accept_expansion","generatedBlockId":"blk_93000000000000000000000001","expectedStateRevision":1}'::jsonb
    )
  $statement$) ->> 'message',
  'stale_revision',
  'a terminal block rejects a second resolution claim'
);

insert into e3_retention_reservations(reservation_id)
select reservation_id
from public.encrypted_owner_interaction_reservations
where user_id='93939393-9393-4939-8939-939393939393'
  and idempotency_key='e3-reject';
insert into e3_values(key,value)
select 'reject-resolved-at',jsonb_build_object(
  'value',resolved_at,
  'retentionStartedAt',rejected_retention_started_at
)
from public.generated_blocks
where id='blk_93000000000000000000000001';

-- The existing encrypted-retention capability owns generated-block cleanup:
-- dry run is non-destructive, execution before seven days retains the block,
-- and an eligible execution hard-deletes it with all encrypted replay state.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'retention-dry-run',public.claim_encrypted_note_retention(
  '93000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000011',
  '93939393-9393-4939-8939-939393939393',
  date_trunc('milliseconds',
    (value ->> 'retentionStartedAt')::timestamptz + interval '8 days'),
  25,false,300
)
from e3_values where key='reject-resolved-at';
reset role;
select ok(
  (select value ->> 'executed' from e3_values
    where key='retention-dry-run')='false'
  and exists (
    select 1 from public.generated_blocks
    where id='blk_93000000000000000000000001'
  ),
  'generated-block retention defaults to a non-destructive dry run'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'retention-too-young',public.claim_encrypted_note_retention(
  '93000000-0000-4000-8000-000000000002',
  '93000000-0000-4000-8000-000000000012',
  '93939393-9393-4939-8939-939393939393',
  date_trunc('milliseconds',
    (value ->> 'value')::timestamptz + interval '6 days 23 hours'),
  25,true,300
)
from e3_values where key='reject-commit-start';
reset role;
select ok(
  (select value ->> 'executed' from e3_values
    where key='retention-too-young')='true'
  and exists (
    select 1 from public.generated_blocks
    where id='blk_93000000000000000000000001'
  ),
  'an eight-day-old prepare cannot shorten seven-day post-reject retention'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'retention-execute',public.claim_encrypted_note_retention(
  '93000000-0000-4000-8000-000000000003',
  '93000000-0000-4000-8000-000000000013',
  '93939393-9393-4939-8939-939393939393',
  date_trunc('milliseconds',
    (value ->> 'retentionStartedAt')::timestamptz + interval '8 days'),
  25,true,300
)
from e3_values where key='reject-resolved-at';
reset role;
select ok(
  (select value ->> 'executed' from e3_values
    where key='retention-execute')='true'
  and not exists (
    select 1 from public.generated_blocks
    where id='blk_93000000000000000000000001'
  )
  and exists (
    select 1 from public.user_events
    where user_id='93939393-9393-4939-8939-939393939393'
      and entity='generated_block_purged'
      and entity_id='blk_93000000000000000000000001'
  ),
  'eligible rejected generated text is hard-deleted by the existing batch'
);

-- Block deletion cascades the sidecar, owner claim, encrypted replay response,
-- reservation bindings, and the underlying operation reservations.
select ok(
  not exists (
    select 1 from public.encrypted_generated_block_resolution_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_reservations
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject'
  )
  and not exists (
    select 1 from public.api_idempotency_records
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject'
  )
  and not exists (
    select 1 from public.content_key_operation_reservations as reservation
    where reservation.reservation_id in (
      select retained.reservation_id from e3_retention_reservations as retained
    )
  )
  and exists (
    select 1 from public.feedback_events
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-reject'
      and generated_block_id is null
  ),
  'retention cascades claims, replay, and wraps while preserving audit evidence'
);

-- A repeated retention run is a pure replay: it must not consume the next
-- eligible generated-block batch after the first bounded delete.
insert into public.generated_blocks (
  id,user_id,note_id,decision_id,kind,content,state,model_id,
  prompt_version,state_revision,resolved_at,content_envelope,
  content_key_id,content_key_class,content_key_purpose,content_key_version
) values
(
  'blk_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393',
  'note_93000000000000000000000001',
  'dec_93000000000000000000000001','summary','[encrypted]','rejected',
  'gpt-5.4-mini-2026-03-17','routing-v1',2,'2030-01-01T00:00:00Z',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000002',1,'generated_block',
    'e3.ai.object.v1','X'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
),
(
  'blk_93000000000000000000000003',
  '93939393-9393-4939-8939-939393939393',
  'note_93000000000000000000000001',
  'dec_93000000000000000000000001','summary','[encrypted]','rejected',
  'gpt-5.4-mini-2026-03-17','routing-v1',2,'2030-01-01T00:00:01Z',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'blk_93000000000000000000000003',1,'generated_block',
    'e3.ai.object.v1','Y'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'retention-one-item',public.claim_encrypted_note_retention(
    '93000000-0000-4000-8000-000000000004',
    '93000000-0000-4000-8000-000000000014',
    '93939393-9393-4939-8939-939393939393',
    '2030-01-09T00:00:01Z',1,true,300
  )
);
reset role;
select is(
  (select count(*) from public.generated_blocks
    where id in (
      'blk_93000000000000000000000002',
      'blk_93000000000000000000000003'
    )),
  1::bigint,
  'a fresh retention run deletes only its bounded generated-block batch'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'retention-one-item-replay',public.claim_encrypted_note_retention(
    '93000000-0000-4000-8000-000000000004',
    '93000000-0000-4000-8000-000000000014',
    '93939393-9393-4939-8939-939393939393',
    '2030-01-09T00:00:01Z',1,true,300
  )
);
reset role;
select ok(
  (select value ->> 'replayed' from e3_values
    where key='retention-one-item-replay')='true'
  and (select count(*) from public.generated_blocks
    where id in (
      'blk_93000000000000000000000002',
      'blk_93000000000000000000000003'
    ))=1,
  'same-run retention replay does not purge a second generated-block batch'
);

-- Capture-linked duplicate Review resolutions are metadata-only for notes but
-- still terminalize the source capture and reseal its receipt per REQ-V1.
insert into public.captures (
  id,user_id,source,device_id,raw_text,privacy,client_created_at,
  client_timezone,status,content_envelope,content_fingerprint,content_length,
  content_key_id,content_key_class,content_key_purpose,content_key_version,
  fingerprint_key_id,fingerprint_key_class,fingerprint_key_purpose,
  fingerprint_key_version
) values (
  'cap_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393','web','e3-duplicate','[encrypted]',
  'ai_assisted',now(),'UTC','needs_review',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000002',1,'capture',
    'e3.ai.object.v1','U'
  ),encode(extensions.digest('e3-duplicate-capture','sha256'),'hex'),20,
  'e3.ai.object.v1','ai_assisted','object_wrap',1,
  'e3.ai.mac.v1','ai_assisted','content_mac',1
);
insert into public.organization_jobs (
  id,capture_id,user_id,state,prompt_version,schema_version,completed_at
) values (
  'job_93000000000000000000000002',
  'cap_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393',
  'succeeded','routing-v1',1,now()
);
insert into public.organization_decisions (
  id,capture_id,user_id,candidate_manifest,signals,validated_plan,band,
  destination_note_id,reason_codes,decision_envelope,decision_key_id,
  decision_key_class,decision_key_purpose,decision_key_version
) values (
  'dec_93000000000000000000000002',
  'cap_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393','{}'::jsonb,'{}'::jsonb,null,
  'review',null,array['ambiguous_intent','duplicate_suspected'],
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'dec_93000000000000000000000002',1,'organization_decision',
    'e3.ai.object.v1','D'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);
insert into public.review_items (
  id,user_id,capture_id,note_id,type,state,choices,review_envelope,
  review_key_id,review_key_class,review_key_purpose,review_key_version,
  review_content_revision
) values (
  'rvw_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393',
  'cap_93000000000000000000000002',
  'note_93000000000000000000000001','duplicate_suggestion','open','[]'::jsonb,
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000002',1,'review_item',
    'e3.ai.object.v1','V'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1,1
);
insert into public.capture_receipts (
  capture_id,job_id,user_id,decision_id,review_item_id,mutation_id,outcome,
  headline,destination_note_id,inserted_content,actions,reason_codes,
  receipt_envelope,receipt_key_id,receipt_key_class,receipt_key_purpose,
  receipt_key_version
) values (
  'cap_93000000000000000000000002',
  'job_93000000000000000000000002',
  '93939393-9393-4939-8939-939393939393',
  'dec_93000000000000000000000002',
  'rvw_93000000000000000000000002',null,'needs_review','[encrypted]',null,
  '[]'::jsonb,'[]'::jsonb,array['ambiguous_intent','duplicate_suspected'],
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000002',1,'capture_receipt',
    'e3.ai.object.v1','R'
  ),'e3.ai.object.v1','ai_assisted','object_wrap',1
);

savepoint duplicate_keep_both;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'duplicate-keep-prepare',public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000002','e3-duplicate-keep',
    '{"type":"keep_both"}'::jsonb
  )
);
reset role;
select ok(
  (select value ->> 'action' from e3_values
    where key='duplicate-keep-prepare')='keep_both'
  and (select jsonb_array_length(value -> 'reservations') from e3_values
    where key='duplicate-keep-prepare')=3
  and (select pg_temp.e3_reservation(value,'receipt') is not null
    from e3_values where key='duplicate-keep-prepare'),
  'duplicate keep-both prepare reserves the required receipt rewrite'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'duplicate-keep-prepare-replay',public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000002','e3-duplicate-keep',
    '{"type":"keep_both"}'::jsonb
  )
);
reset role;
select ok(
  (select value ->> 'replayed' from e3_values
    where key='duplicate-keep-prepare-replay')='true'
  and (select replay.value -> 'ids' = original.value -> 'ids'
    from e3_values as replay
    cross join e3_values as original
    where replay.key='duplicate-keep-prepare-replay'
      and original.key='duplicate-keep-prepare')
  and (select replay.value -> 'reservations' = original.value -> 'reservations'
    from e3_values as replay
    cross join e3_values as original
    where replay.key='duplicate-keep-prepare-replay'
      and original.key='duplicate-keep-prepare')
  and (select jsonb_array_length(value -> 'reservations')=3
    from e3_values where key='duplicate-keep-prepare-replay'),
  'incomplete duplicate prepare retry preserves exact reservations and replay truth'
);
insert into e3_values(key,value)
select 'duplicate-keep-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'duplicate-keep'
)
from e3_values where key='duplicate-keep-prepare';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'duplicate-keep-result',public.commit_encrypted_review_resolution(
  '93939393-9393-4939-8939-939393939393',
  'rvw_93000000000000000000000002','e3-duplicate-keep',value
)
from e3_values where key='duplicate-keep-command';
reset role;
select ok(
  (select value ->> 'outcome' from e3_values
    where key='duplicate-keep-result')='resolved'
  and (select state='resolved' from public.review_items
    where id='rvw_93000000000000000000000002')
  and (select status='inbox' from public.captures
    where id='cap_93000000000000000000000002')
  and (select outcome='kept_in_inbox' and receipt_revision=2
      and review_item_id='rvw_93000000000000000000000002'
      and reason_codes=array['review_resolved']::text[]
    from public.capture_receipts
    where capture_id='cap_93000000000000000000000002')
  and (select receipt_envelope = command.value #> '{receipt,cipher,envelope}'
    from public.capture_receipts as receipt
    cross join e3_values as command
    where receipt.capture_id='cap_93000000000000000000000002'
      and command.key='duplicate-keep-command')
  and (private.owner_interaction_receipt_projection(
      '93939393-9393-4939-8939-939393939393',
      'cap_93000000000000000000000002'
    ) #>> '{reasonCodes,0}')='review_resolved',
  'keep-both resolves metadata, reseals a readable receipt, and returns capture to Inbox'
);
select is(
  (select jsonb_build_object(
    'revision',current_revision,
    'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
    'mutationCount',(select count(*) from public.note_mutations
      where user_id=note.user_id and note_id=note.id)
  ) from public.notes as note
  where id='note_93000000000000000000000001'),
  (select value from e3_values where key='note-before'),
  'duplicate keep-both never mutates either suggested note'
);
rollback to savepoint duplicate_keep_both;

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value) values (
  'duplicate-dismiss-prepare',public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    'rvw_93000000000000000000000002','e3-duplicate-dismiss',
    '{"type":"dismiss"}'::jsonb
  )
);
reset role;
insert into e3_values(key,value)
select 'duplicate-dismiss-command',pg_temp.e3_resolution_command(
  '93939393-9393-4939-8939-939393939393',value,'duplicate-dismiss'
)
from e3_values where key='duplicate-dismiss-prepare';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'duplicate-dismiss-result',public.commit_encrypted_review_resolution(
  '93939393-9393-4939-8939-939393939393',
  'rvw_93000000000000000000000002','e3-duplicate-dismiss',value
)
from e3_values where key='duplicate-dismiss-command';
reset role;
select ok(
  (select value ->> 'outcome' from e3_values
    where key='duplicate-dismiss-result')='dismissed'
  and (select state='dismissed' from public.review_items
    where id='rvw_93000000000000000000000002')
  and (select status='inbox' from public.captures
    where id='cap_93000000000000000000000002')
  and (select outcome='kept_in_inbox' and receipt_revision=2
      and reason_codes=array['review_resolved']::text[]
    from public.capture_receipts
    where capture_id='cap_93000000000000000000000002')
  and (select receipt_envelope = command.value #> '{receipt,cipher,envelope}'
    from public.capture_receipts as receipt
    cross join e3_values as command
    where receipt.capture_id='cap_93000000000000000000000002'
      and command.key='duplicate-dismiss-command'),
  'dismiss resolves duplicate metadata and atomically returns its capture to Inbox'
);
select is(
  (select jsonb_build_object(
    'revision',current_revision,
    'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
    'mutationCount',(select count(*) from public.note_mutations
      where user_id=note.user_id and note_id=note.id)
  ) from public.notes as note
  where id='note_93000000000000000000000001'),
  (select value from e3_values where key='note-before'),
  'duplicate dismissal remains non-destructive to note content and history'
);

-- Exercise the real organizer capability chain for an expansion.  This is a
-- fresh encrypted capture/job, worker claim, candidate authorization, create
-- preparation, and atomic commit through the implementation directly delegated
-- by the public worker capability: no hand-fixtured E3
-- decision, Review, receipt, or generated-block rows participate.
insert into public.captures (
  id,user_id,source,device_id,raw_text,privacy,client_created_at,
  client_timezone,status,content_envelope,content_fingerprint,content_length,
  content_key_id,content_key_class,content_key_purpose,content_key_version,
  fingerprint_key_id,fingerprint_key_class,fingerprint_key_purpose,
  fingerprint_key_version
) values (
  'cap_93000000000000000000000010',
  '93939393-9393-4939-8939-939393939393','web','e3-organizer-expansion',
  '[encrypted]','ai_assisted','2031-01-01T00:00:00.000Z','UTC','queued',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000010',1,'capture',
    'e3.ai.object.v1','I'
  ),encode(extensions.digest('e3-organizer-expansion','sha256'),'hex'),32,
  'e3.ai.object.v1','ai_assisted','object_wrap',1,
  'e3.ai.mac.v1','ai_assisted','content_mac',1
);
insert into public.organization_jobs (
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_93000000000000000000000010',
  'cap_93000000000000000000000010',
  '93939393-9393-4939-8939-939393939393','created','routing-v1',1
);

insert into e3_values(key,value) values (
  'sql-expansion-claim',
  private.claim_encrypted_organizer_jobs_impl('e3-sql-worker',1,60)
);
insert into e3_values(key,value)
select 'sql-expansion-candidates',private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',8
)
from e3_values where key='sql-expansion-claim';
insert into e3_values(key,value)
select 'sql-expansion-heartbeat',private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}',60,
  pg_temp.e3_disclosure_manifest(page.value)
)
from e3_values as claim
cross join e3_values as page
where claim.key='sql-expansion-claim'
  and page.key='sql-expansion-candidates';
insert into e3_values(key,value)
select 'sql-expansion-prepare',private.prepare_encrypted_organizer_create_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
  'note_93000000000000000000000010',
  '93000000-0000-4000-8000-000000000110'
)
from e3_values where key='sql-expansion-claim';

select ok(
  (select value #>> '{jobs,0,jobId}' from e3_values
    where key='sql-expansion-claim')='job_93000000000000000000000010'
  and (select value ->> 'mode' from e3_values
    where key='sql-expansion-prepare')='create'
  and (select value ->> 'noteId' from e3_values
    where key='sql-expansion-prepare')='note_93000000000000000000000010'
  and (select value #>> '{ids,generatedBlockId}' from e3_values
    where key='sql-expansion-prepare')
      ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'
  and (select count(*) from e3_values as prep
    cross join lateral jsonb_object_keys(prep.value -> 'reservations') as role
    where prep.key='sql-expansion-prepare')=5
  and (select value #>> '{reservations,generatedBlock,operationCount}'
    from e3_values where key='sql-expansion-prepare')='1',
  'organizer prepare freezes the expansion identity and eighth wrap'
);

insert into e3_values(key,value)
select 'sql-expansion-command',jsonb_build_object(
  'outcome','created',
  'reviewReason','expansion_pending',
  'noteWrite',jsonb_build_object(
    'occurredAt','2031-01-01T00:00:00.000Z',
    'noteState',pg_temp.e3_note_state(
      'e-note_93000000000000000000000010',''
    ),
    'noteCipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'noteWrite',prep.value ->> 'noteId',1,
      'note_content','J'
    ),
    'revision',jsonb_build_object(
      'id',prep.value #>> '{ids,revisionId}',
      'source','organization','actor','organization:e3-sql-worker',
      'cipher',pg_temp.e3_organizer_cipher(
        owner_id,prep.value,'noteWrite',
        prep.value #>> '{ids,revisionId}',1,'note_revision','K'
      ),
      'mac',pg_temp.e3_mac(prep.value #> '{keys,contentMac}',
        'sql-expansion-revision')
    ),
    'mutation',jsonb_build_object(
      'id',prep.value #>> '{ids,mutationId}',
      'decisionId',null,'undoTargetMutationId',null,
      'operations',jsonb_build_array(jsonb_build_object('type','create_note')),
      'inverse',jsonb_build_object('type','soft_delete_created_note'),
      'cipher',pg_temp.e3_organizer_cipher(
        owner_id,prep.value,'noteWrite',
        prep.value #>> '{ids,mutationId}',1,'note_mutation','L'
      )
    ),
    'requestMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-expansion-request'
    ),
    'responseCipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'noteWrite',
      'idempotency:organizer:' || (prep.value ->> 'jobId'),1,
      'idempotency_response','M'
    ),
    'verification',jsonb_build_object(
      'noteContent',pg_temp.e3_mac(
        prep.value #> '{keys,contentMac}','sql-expansion-note'
      ),
      'noteMutation',pg_temp.e3_mac(
        prep.value #> '{keys,contentMac}','sql-expansion-mutation'
      ),
      'idempotencyResponse',pg_temp.e3_mac(
        prep.value #> '{keys,contentMac}','sql-expansion-response'
      )
    )
  ),
  'decision',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'decision',
      prep.value #>> '{ids,decisionId}',1,'organization_decision','N'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-expansion-decision'
    ),
    'band','auto','reasonCodes',jsonb_build_array('strong_match')
  ),
  'generatedBlock',jsonb_build_object(
    'kind','summary','modelId',job.model_id,
    'promptVersion',job.prompt_version,
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'generatedBlock',
      prep.value #>> '{ids,generatedBlockId}',1,'generated_block','O'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-expansion-block'
    )
  ),
  'review',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'review',
      prep.value #>> '{ids,reviewItemId}',1,'review_item','P'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-expansion-review'
    ),
    'type','pending_expansion'
  ),
  'receipt',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'receipt',
      'cap_93000000000000000000000010',1,'capture_receipt','Q'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-expansion-receipt'
    )
  )
)
from e3_values as prep
join public.organization_jobs as job on job.id=prep.value ->> 'jobId'
cross join lateral (
  select '93939393-9393-4939-8939-939393939393'::uuid as owner_id
) as fixture
where prep.key='sql-expansion-prepare';

-- Substitute the Review cipher for the generated-block cipher.  Reservation
-- and AAD binding must reject the cross-surface substitution before any of the
-- routed note, decision, Review, receipt, or block can publish.
insert into e3_values(key,value)
select 'sql-expansion-tamper-error',pg_temp.caught_error(format(
  'select private.commit_encrypted_organizer_job_impl(%L,%L,%L::jsonb)',
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  jsonb_set(command.value,'{generatedBlock,cipher}',
    command.value #> '{review,cipher}',true)::text
))
from e3_values as claim
cross join e3_values as command
where claim.key='sql-expansion-claim'
  and command.key='sql-expansion-command';
select ok(
  (select value ->> 'message' from e3_values
    where key='sql-expansion-tamper-error')='invalid_provenance'
  and not exists (
    select 1 from public.notes
    where id='note_93000000000000000000000010'
  )
  and not exists (
    select 1 from public.generated_blocks
    where id=(select value #>> '{ids,generatedBlockId}' from e3_values
      where key='sql-expansion-prepare')
  )
  and not exists (
    select 1 from public.review_items
    where id=(select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-expansion-prepare')
  )
  and not exists (
    select 1 from public.organization_decisions
    where id=(select value #>> '{ids,decisionId}' from e3_values
      where key='sql-expansion-prepare')
  )
  and not exists (
    select 1 from public.capture_receipts
    where capture_id='cap_93000000000000000000000010'
  )
  and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    where reservation.user_id='93939393-9393-4939-8939-939393939393'
      and reservation.reservation_id in (
        select (reservation_value ->> 'reservationId')::uuid
        from e3_values as prep
        cross join lateral jsonb_each(prep.value -> 'reservations')
          as listed(role,reservation_value)
        where prep.key='sql-expansion-prepare'
      )
      and reservation.consumed_at is not null
  ),
  'generated-block substitution rolls the complete organizer transaction back'
);

insert into e3_values(key,value)
select 'sql-expansion-result',private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from e3_values as claim
cross join e3_values as command
where claim.key='sql-expansion-claim'
  and command.key='sql-expansion-command';

select ok(
  (select value ->> 'outcome' from e3_values
    where key='sql-expansion-result')='created'
  and (select value ->> 'replayed' from e3_values
    where key='sql-expansion-result')='false'
  and (select value ->> 'generatedBlockId' from e3_values
    where key='sql-expansion-result')=(
      select value #>> '{ids,generatedBlockId}' from e3_values
      where key='sql-expansion-prepare'
    )
  and exists (
    select 1
    from public.notes as note
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-expansion-prepare'
      and command.key='sql-expansion-command'
      and note.id=prep.value ->> 'noteId'
      and note.current_revision=(prep.value ->> 'targetRevision')::integer
      and note.content_envelope=command.value #> '{noteWrite,noteCipher,envelope}'
      and note.content_envelope
        <> command.value #> '{generatedBlock,cipher,envelope}'
      and (select count(*) from public.note_revisions as revision
        where revision.user_id=note.user_id and revision.note_id=note.id)=1
      and (select count(*) from public.note_mutations as mutation
        where mutation.user_id=note.user_id and mutation.note_id=note.id)=1
  )
  and exists (
    select 1
    from public.generated_blocks as block
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-expansion-prepare'
      and command.key='sql-expansion-command'
      and block.id=prep.value #>> '{ids,generatedBlockId}'
      and block.note_id=prep.value ->> 'noteId'
      and block.decision_id=prep.value #>> '{ids,decisionId}'
      and block.review_item_id=prep.value #>> '{ids,reviewItemId}'
      and block.state='proposed' and block.state_revision=1
      and block.content_envelope=
        command.value #> '{generatedBlock,cipher,envelope}'
  )
  and exists (
    select 1
    from public.review_items as review
    cross join e3_values as prep
    where prep.key='sql-expansion-prepare'
      and review.id=prep.value #>> '{ids,reviewItemId}'
      and review.type='pending_expansion' and review.state='open'
      and review.note_id=prep.value ->> 'noteId'
  )
  and exists (
    select 1 from public.capture_receipts as receipt
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-expansion-prepare'
      and command.key='sql-expansion-command'
      and receipt.capture_id='cap_93000000000000000000000010'
      and receipt.review_item_id=prep.value #>> '{ids,reviewItemId}'
      and receipt.reason_codes=array['expansion_pending']::text[]
      and receipt.receipt_envelope=command.value #> '{receipt,cipher,envelope}'
  )
  and (select status='needs_review' from public.captures
    where id='cap_93000000000000000000000010'),
  'real organizer expansion atomically publishes one note write plus isolated Review and block'
);

insert into e3_values(key,value)
select 'sql-expansion-replay',private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from e3_values as claim
cross join e3_values as command
where claim.key='sql-expansion-claim'
  and command.key='sql-expansion-command';
select ok(
  (select value ->> 'replayed' from e3_values
    where key='sql-expansion-replay')='true'
  and (select value ->> 'generatedBlockId' from e3_values
    where key='sql-expansion-replay')=(
      select value ->> 'generatedBlockId' from e3_values
      where key='sql-expansion-result'
    )
  and (select count(*) from public.generated_blocks
    where id=(select value #>> '{ids,generatedBlockId}' from e3_values
      where key='sql-expansion-prepare'))=1
  and (select count(*) from public.review_items
    where id=(select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-expansion-prepare'))=1
  and (select current_revision=1 from public.notes
    where id='note_93000000000000000000000010'),
  'real expansion replay returns the frozen result without another block or note revision'
);

-- Deleting the source capture must not strand its proposed expansion after the
-- pending-expansion Review is removed.  Prepare an outstanding resolution too,
-- so the deletion proves the complete sidecar/replay/wrap cascade.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'sql-expansion-delete-resolution-prepare',
  public.prepare_encrypted_review_resolution(
    '93939393-9393-4939-8939-939393939393',
    prep.value #>> '{ids,reviewItemId}',
    'e3-delete-pending-resolution',
    jsonb_build_object(
      'type','reject_expansion',
      'generatedBlockId',prep.value #>> '{ids,generatedBlockId}',
      'expectedStateRevision',1
    )
  )
from e3_values as prep
where prep.key='sql-expansion-prepare';
reset role;
insert into e3_loser_reservations(scenario,reservation_id)
select 'capture_delete',reservation_id
from public.encrypted_owner_interaction_reservations
where user_id='93939393-9393-4939-8939-939393939393'
  and idempotency_key='e3-delete-pending-resolution';

insert into public.content_key_operation_reservations (
  user_id,reservation_id,key_id,key_class,key_purpose,key_version,
  operation_count
) values (
  '93939393-9393-4939-8939-939393939393',
  '93000000-0000-4000-8000-000000000113',
  'e3.ai.object.v1','ai_assisted','object_wrap',1,1
);
insert into e3_values(key,value)
select 'sql-expansion-delete-command',jsonb_build_object(
  'occurredAt',to_char(
    date_trunc('milliseconds',clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  'removeInsertedContent',false,
  'sourceNoteIds',jsonb_build_array(
    'note_93000000000000000000000010'
  ),
  'requestMac',pg_temp.e3_mac(
    prep.value #> '{keys,contentMac}','sql-expansion-delete-request'
  ),
  'responseCipher',pg_temp.e3_cipher(
    '93939393-9393-4939-8939-939393939393',
    jsonb_build_object(
      'reservationId','93000000-0000-4000-8000-000000000113',
      'resourceId','idempotency:e3-delete-expansion',
      'recordVersion',1,'surface','idempotency_response',
      'keyClass','ai_assisted',
      'key',jsonb_build_object(
        'keyId','e3.ai.object.v1','keyVersion',1
      )
    ),
    'Z'
  ),
  'responseVerificationMac',pg_temp.e3_mac(
    prep.value #> '{keys,contentMac}','sql-expansion-delete-response'
  )
)
from e3_values as prep
where prep.key='sql-expansion-prepare';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e3_values(key,value)
select 'sql-expansion-delete-result',public.delete_encrypted_capture(
  '93939393-9393-4939-8939-939393939393',
  'cap_93000000000000000000000010','e3-delete-expansion',value
)
from e3_values where key='sql-expansion-delete-command';
insert into e3_values(key,value)
select 'sql-expansion-delete-list-error',pg_temp.caught_error(format(
  'select public.get_encrypted_generated_blocks(%L,array[%L]::text[])',
  '93939393-9393-4939-8939-939393939393',
  prep.value #>> '{ids,generatedBlockId}'
))
from e3_values as prep
where prep.key='sql-expansion-prepare';
reset role;
select ok(
  (select value ->> 'replayed' from e3_values
    where key='sql-expansion-delete-result')='false'
  and (select status='deleted' and content_envelope is null
    from public.captures
    where id='cap_93000000000000000000000010')
  and not exists (
    select 1 from public.generated_blocks as block
    cross join e3_values as prep
    where prep.key='sql-expansion-prepare'
      and block.id=prep.value #>> '{ids,generatedBlockId}'
  )
  and not exists (
    select 1 from public.content_encryption_verifications as verification
    cross join e3_values as prep
    where prep.key='sql-expansion-prepare'
      and verification.user_id='93939393-9393-4939-8939-939393939393'
      and verification.surface='generated_block'
      and verification.resource_id=prep.value #>> '{ids,generatedBlockId}'
  )
  and not exists (
    select 1 from public.user_events as event_record
    cross join e3_values as prep
    where prep.key='sql-expansion-prepare'
      and event_record.user_id='93939393-9393-4939-8939-939393939393'
      and event_record.entity='generated_block'
      and event_record.entity_id=prep.value #>> '{ids,generatedBlockId}'
  )
  and (select count(*)=1
    from public.user_events as event_record
    cross join e3_values as prep
    where prep.key='sql-expansion-prepare'
      and event_record.user_id='93939393-9393-4939-8939-939393939393'
      and event_record.entity='generated_block_purged'
      and event_record.entity_id=prep.value #>> '{ids,generatedBlockId}')
  and not exists (
    select 1 from public.encrypted_generated_block_resolution_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-delete-pending-resolution'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_claims
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-delete-pending-resolution'
  )
  and not exists (
    select 1 from public.encrypted_owner_interaction_reservations
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-delete-pending-resolution'
  )
  and not exists (
    select 1 from public.api_idempotency_records
    where user_id='93939393-9393-4939-8939-939393939393'
      and idempotency_key='e3-delete-pending-resolution'
  )
  and not exists (
    select 1 from public.content_key_operation_reservations as reservation
    join e3_loser_reservations as retained
      on retained.reservation_id=reservation.reservation_id
    where retained.scenario='capture_delete'
  )
  and (select value ->> 'message' from e3_values
    where key='sql-expansion-delete-list-error')='not_found'
  and (select current_revision=1 from public.notes
    where id='note_93000000000000000000000010'),
  'capture deletion purges the proposed block, stale event, verification, and all resolution capabilities'
);

-- Exercise the duplicate-suggestion branch through a fresh organizer lease and
-- real create preparation.  The stable create ID remains unused because a
-- duplicate proposal is metadata-only and must not mutate any note.
insert into public.captures (
  id,user_id,source,device_id,raw_text,privacy,client_created_at,
  client_timezone,status,content_envelope,content_fingerprint,content_length,
  content_key_id,content_key_class,content_key_purpose,content_key_version,
  fingerprint_key_id,fingerprint_key_class,fingerprint_key_purpose,
  fingerprint_key_version
) values (
  'cap_93000000000000000000000011',
  '93939393-9393-4939-8939-939393939393','web','e3-organizer-duplicate',
  '[encrypted]','ai_assisted','2031-01-01T00:00:01.000Z','UTC','queued',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000011',1,'capture',
    'e3.ai.object.v1','S'
  ),encode(extensions.digest('e3-organizer-duplicate','sha256'),'hex'),32,
  'e3.ai.object.v1','ai_assisted','object_wrap',1,
  'e3.ai.mac.v1','ai_assisted','content_mac',1
);
insert into public.organization_jobs (
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_93000000000000000000000011',
  'cap_93000000000000000000000011',
  '93939393-9393-4939-8939-939393939393','created','routing-v1',1
);

insert into e3_values(key,value) values (
  'sql-duplicate-claim',
  private.claim_encrypted_organizer_jobs_impl('e3-sql-worker',1,60)
);
insert into e3_values(key,value)
select 'sql-duplicate-candidates',private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',8
)
from e3_values where key='sql-duplicate-claim';
insert into e3_values(key,value)
select 'sql-duplicate-heartbeat',private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}',60,
  pg_temp.e3_disclosure_manifest(page.value)
)
from e3_values as claim
cross join e3_values as page
where claim.key='sql-duplicate-claim'
  and page.key='sql-duplicate-candidates';
insert into e3_values(key,value)
select 'sql-duplicate-prepare',private.prepare_encrypted_organizer_create_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
  'note_93000000000000000000000011',
  '93000000-0000-4000-8000-000000000111'
)
from e3_values where key='sql-duplicate-claim';

insert into e3_values(key,value)
select 'sql-duplicate-command',jsonb_build_object(
  'outcome','review',
  'reviewReason','duplicate_suggestion',
  'noteWrite',null,
  'decision',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'decision',
      prep.value #>> '{ids,decisionId}',1,'organization_decision','T'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-duplicate-decision'
    ),
    'band','review',
    'reasonCodes',jsonb_build_array(
      'ambiguous_intent','duplicate_suspected'
    )
  ),
  'generatedBlock',null,
  'review',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'review',
      prep.value #>> '{ids,reviewItemId}',1,'review_item','U'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-duplicate-review'
    ),
    'type','duplicate_suggestion'
  ),
  'receipt',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'receipt',
      'cap_93000000000000000000000011',1,'capture_receipt','V'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-duplicate-receipt'
    )
  )
)
from e3_values as prep
cross join lateral (
  select '93939393-9393-4939-8939-939393939393'::uuid as owner_id
) as fixture
where prep.key='sql-duplicate-prepare';

-- A decision cipher cannot be substituted for the independently reserved
-- duplicate Review.  The failed statement must leave every aggregate and wrap
-- untouched so the exact command can still succeed.
insert into e3_values(key,value)
select 'sql-duplicate-tamper-error',pg_temp.caught_error(format(
  'select private.commit_encrypted_organizer_job_impl(%L,%L,%L::jsonb)',
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  jsonb_set(command.value,'{review,cipher}',
    command.value #> '{decision,cipher}',true)::text
))
from e3_values as claim
cross join e3_values as command
where claim.key='sql-duplicate-claim'
  and command.key='sql-duplicate-command';
select ok(
  (select value ->> 'message' from e3_values
    where key='sql-duplicate-tamper-error')='invalid_encrypted_field'
  and not exists (
    select 1 from public.notes
    where id='note_93000000000000000000000011'
  )
  and not exists (
    select 1 from public.organization_decisions
    where id=(select value #>> '{ids,decisionId}' from e3_values
      where key='sql-duplicate-prepare')
  )
  and not exists (
    select 1 from public.review_items
    where id=(select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-duplicate-prepare')
  )
  and not exists (
    select 1 from public.capture_receipts
    where capture_id='cap_93000000000000000000000011'
  )
  and not exists (
    select 1
    from public.content_key_operation_reservations as reservation
    where reservation.user_id='93939393-9393-4939-8939-939393939393'
      and reservation.reservation_id in (
        select (reservation_value ->> 'reservationId')::uuid
        from e3_values as prep
        cross join lateral jsonb_each(prep.value -> 'reservations')
          as listed(role,reservation_value)
        where prep.key='sql-duplicate-prepare'
      )
      and reservation.consumed_at is not null
  ),
  'duplicate cipher substitution rolls back every publication and reservation'
);

insert into e3_values(key,value)
select 'sql-duplicate-result',private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from e3_values as claim
cross join e3_values as command
where claim.key='sql-duplicate-claim'
  and command.key='sql-duplicate-command';
select ok(
  (select value ->> 'outcome' from e3_values
    where key='sql-duplicate-result')='review'
  and (select value ->> 'replayed' from e3_values
    where key='sql-duplicate-result')='false'
  and (select value ->> 'reviewItemId' from e3_values
    where key='sql-duplicate-result')=(
      select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-duplicate-prepare'
    )
  and not exists (
    select 1 from public.notes
    where id='note_93000000000000000000000011'
  )
  and not exists (
    select 1 from public.generated_blocks
    where id=(select value #>> '{ids,generatedBlockId}' from e3_values
      where key='sql-duplicate-prepare')
  )
  and exists (
    select 1 from public.organization_decisions as decision
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-duplicate-prepare'
      and command.key='sql-duplicate-command'
      and decision.id=prep.value #>> '{ids,decisionId}'
      and decision.band='review'
      and decision.destination_note_id is null
      and decision.reason_codes=
        array['ambiguous_intent','duplicate_suspected']::text[]
      and decision.decision_envelope=
        command.value #> '{decision,cipher,envelope}'
  )
  and exists (
    select 1 from public.review_items as review
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-duplicate-prepare'
      and command.key='sql-duplicate-command'
      and review.id=prep.value #>> '{ids,reviewItemId}'
      and review.type='duplicate_suggestion' and review.state='open'
      and review.note_id is null
      and review.review_envelope=command.value #> '{review,cipher,envelope}'
  )
  and exists (
    select 1 from public.capture_receipts as receipt
    cross join e3_values as prep
    cross join e3_values as command
    where prep.key='sql-duplicate-prepare'
      and command.key='sql-duplicate-command'
      and receipt.capture_id='cap_93000000000000000000000011'
      and receipt.review_item_id=prep.value #>> '{ids,reviewItemId}'
      and receipt.destination_note_id is null
      and receipt.mutation_id is null
      and receipt.reason_codes=
        array['ambiguous_intent','duplicate_suspected']::text[]
      and receipt.receipt_envelope=command.value #> '{receipt,cipher,envelope}'
  )
  and (select status='needs_review' from public.captures
    where id='cap_93000000000000000000000011')
  and (select jsonb_build_object(
      'revision',current_revision,
      'digest',encode(extensions.digest(content_envelope::text,'sha256'),'hex'),
      'mutationCount',(select count(*) from public.note_mutations
        where user_id=note.user_id and note_id=note.id)
    )=(select value from e3_values where key='note-before')
    from public.notes as note
    where id='note_93000000000000000000000001'),
  'real duplicate organizer publication is atomic and non-destructive to notes'
);

insert into e3_values(key,value)
select 'sql-duplicate-replay',private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from e3_values as claim
cross join e3_values as command
where claim.key='sql-duplicate-claim'
  and command.key='sql-duplicate-command';
select ok(
  (select value ->> 'replayed' from e3_values
    where key='sql-duplicate-replay')='true'
  and (select value ->> 'reviewItemId' from e3_values
    where key='sql-duplicate-replay')=(
      select value ->> 'reviewItemId' from e3_values
      where key='sql-duplicate-result'
    )
  and (select count(*) from public.review_items
    where id=(select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-duplicate-prepare'))=1
  and (select count(*) from public.organization_decisions
    where id=(select value #>> '{ids,decisionId}' from e3_values
      where key='sql-duplicate-prepare'))=1
  and (select count(*) from public.capture_receipts
    where capture_id='cap_93000000000000000000000011')=1,
  'real duplicate organizer replay returns the frozen publication once'
);

-- Force a consent-control replan after expansion preparation.  The delegated
-- E2 heartbeat clears its four legacy reservation bindings, while the E3
-- wrapper must still burn and clear the separately preserved Review and
-- generated-block wraps using the identities captured before delegation.
insert into public.captures (
  id,user_id,source,device_id,raw_text,privacy,client_created_at,
  client_timezone,status,content_envelope,content_fingerprint,content_length,
  content_key_id,content_key_class,content_key_purpose,content_key_version,
  fingerprint_key_id,fingerprint_key_class,fingerprint_key_purpose,
  fingerprint_key_version
) values (
  'cap_93000000000000000000000012',
  '93939393-9393-4939-8939-939393939393','web','e3-expansion-replan',
  '[encrypted]','ai_assisted','2031-01-01T00:00:02.000Z','UTC','queued',
  pg_temp.e3_envelope(
    '93939393-9393-4939-8939-939393939393',
    'cap_93000000000000000000000012',1,'capture',
    'e3.ai.object.v1','W'
  ),encode(extensions.digest('e3-expansion-replan','sha256'),'hex'),32,
  'e3.ai.object.v1','ai_assisted','object_wrap',1,
  'e3.ai.mac.v1','ai_assisted','content_mac',1
);
insert into public.organization_jobs (
  id,capture_id,user_id,state,prompt_version,schema_version
) values (
  'job_93000000000000000000000012',
  'cap_93000000000000000000000012',
  '93939393-9393-4939-8939-939393939393','created','routing-v1',1
);

insert into e3_values(key,value) values (
  'sql-replan-claim',
  private.claim_encrypted_organizer_jobs_impl('e3-sql-worker',1,60)
);
insert into e3_values(key,value)
select 'sql-replan-candidates',private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',8
)
from e3_values where key='sql-replan-claim';
insert into e3_values(key,value)
select 'sql-replan-heartbeat',private.heartbeat_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',
  claim.value #>> '{jobs,0,leaseToken}',60,
  pg_temp.e3_disclosure_manifest(page.value)
)
from e3_values as claim
cross join e3_values as page
where claim.key='sql-replan-claim'
  and page.key='sql-replan-candidates';
insert into e3_values(key,value)
select 'sql-replan-prepare',private.prepare_encrypted_organizer_create_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
  'note_93000000000000000000000012',
  '93000000-0000-4000-8000-000000000112'
)
from e3_values where key='sql-replan-claim';
insert into e3_values(key,value)
select 'sql-replan-command',jsonb_build_object(
  'outcome','created',
  'reviewReason','expansion_pending',
  'noteWrite','{}'::jsonb,
  'decision','{}'::jsonb,
  'generatedBlock',jsonb_build_object(
    'kind','summary','modelId',job.model_id,
    'promptVersion',job.prompt_version,
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'generatedBlock',
      prep.value #>> '{ids,generatedBlockId}',1,'generated_block','X'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-replan-block'
    )
  ),
  'review',jsonb_build_object(
    'cipher',pg_temp.e3_organizer_cipher(
      owner_id,prep.value,'review',
      prep.value #>> '{ids,reviewItemId}',1,'review_item','Y'
    ),
    'verificationMac',pg_temp.e3_mac(
      prep.value #> '{keys,contentMac}','sql-replan-review'
    ),
    'type','pending_expansion'
  ),
  'receipt','{}'::jsonb
)
from e3_values as prep
join public.organization_jobs as job on job.id=prep.value ->> 'jobId'
cross join lateral (
  select '93939393-9393-4939-8939-939393939393'::uuid as owner_id
) as fixture
where prep.key='sql-replan-prepare';

update public.encrypted_organizer_candidate_pages
set controls=jsonb_set(controls,'{expansionDisabled}','true'::jsonb,true)
where job_id='job_93000000000000000000000012';
insert into e3_values(key,value)
select 'sql-replan-result',private.commit_encrypted_organizer_job_impl(
  claim.value #>> '{jobs,0,jobId}',claim.value #>> '{jobs,0,leaseToken}',
  command.value
)
from e3_values as claim
cross join e3_values as command
where claim.key='sql-replan-claim'
  and command.key='sql-replan-command';
select ok(
  (select value ->> 'outcome' from e3_values
    where key='sql-replan-result')='replan'
  and (select value ->> 'conflictReason' from e3_values
    where key='sql-replan-result')='consent_controls'
  and not exists (
    select 1 from public.notes
    where id='note_93000000000000000000000012'
  )
  and not exists (
    select 1 from public.generated_blocks
    where id=(select value #>> '{ids,generatedBlockId}' from e3_values
      where key='sql-replan-prepare')
  )
  and not exists (
    select 1 from public.review_items
    where id=(select value #>> '{ids,reviewItemId}' from e3_values
      where key='sql-replan-prepare')
  )
  and not exists (
    select 1 from public.organization_decisions
    where id=(select value #>> '{ids,decisionId}' from e3_values
      where key='sql-replan-prepare')
  )
  and not exists (
    select 1 from public.capture_receipts
    where capture_id='cap_93000000000000000000000012'
  )
  and (select count(*)=2
    from public.content_key_operation_reservations as reservation
    cross join e3_values as prep
    where prep.key='sql-replan-prepare'
      and reservation.user_id='93939393-9393-4939-8939-939393939393'
      and reservation.reservation_id in (
        (prep.value #>> '{reservations,review,reservationId}')::uuid,
        (prep.value #>> '{reservations,generatedBlock,reservationId}')::uuid
      )
      and reservation.consumed_at is not null
      and reservation.consumed_by_type='encrypted_organizer'
      and reservation.consumed_by_id='job_93000000000000000000000012')
  and (select review_reservation_id is null
      and generated_block_reservation_id is null
      and e3_kind is null and e3_command_hash is null and e3_result is null
    from public.encrypted_organizer_preparations
    where job_id='job_93000000000000000000000012'),
  'forced expansion replan burns and detaches both preserved E3 wraps without publication'
);

select * from finish();
rollback;
