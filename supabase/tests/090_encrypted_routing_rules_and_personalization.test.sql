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

create function pg_temp.e2_envelope(
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

create function pg_temp.e2_cipher(
  p_owner_id uuid,
  p_resource_id text,
  p_record_version integer,
  p_kind text,
  p_reservation_id uuid,
  p_key_class text,
  p_seed text
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'envelope', pg_temp.e2_envelope(
      p_owner_id, p_resource_id, p_record_version, p_kind,
      case when p_key_class = 'private_manual'
        then 'e2.private.object.v1' else 'e2.ai.object.v1' end,
      p_seed
    ),
    'keyId', case when p_key_class = 'private_manual'
      then 'e2.private.object.v1' else 'e2.ai.object.v1' end,
    'keyClass', p_key_class,
    'keyPurpose', 'object_wrap',
    'keyVersion', 1,
    'reservationId', p_reservation_id::text
  );
$$;

create function pg_temp.e2_mac(p_seed text, p_key_class text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'mac', encode(extensions.digest(p_seed, 'sha256'), 'hex'),
    'keyId', case when p_key_class = 'private_manual'
      then 'e2.private.mac.v1' else 'e2.ai.mac.v1' end,
    'keyClass', p_key_class,
    'keyPurpose', 'content_mac',
    'keyVersion', 1
  );
$$;

create function pg_temp.e2_event_time()
returns text
language sql
volatile
as $$
  select to_char(
    date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
$$;

create function pg_temp.e2_disclosure_manifest(p_page jsonb)
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
        'isOpen',candidate -> 'metadata' -> 'isOpen'
      ) order by ordinal)
      from jsonb_array_elements(p_page -> 'candidates')
        with ordinality as listed(candidate,ordinal)
    ),'[]'::jsonb)
  );
$$;

create temporary table e2_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on e2_values to service_role;

-- Schema, encrypted-at-rest, and lifecycle boundaries.
select has_type(
  'public', 'routing_rule_proposal_state',
  'learned routing rules use a closed proposal lifecycle'
);
select is(
  (
    select array_agg(value.enumlabel order by value.enumsortorder)::text
    from pg_enum as value
    where value.enumtypid = 'public.routing_rule_proposal_state'::regtype
  ),
  '{observing,offered,accepted,declined}',
  'proposal states are exactly observing, offered, accepted, and declined'
);
select has_column(
  'public', 'routing_rules', 'proposal_state',
  'routing rules retain proposal state beside encrypted condition state'
);
select has_table(
  'public', 'routing_rule_proposal_observations',
  'distinct correction observations are durable'
);
select has_table(
  'public', 'encrypted_routing_rule_write_claims',
  'routing-rule idempotency claims are durable'
);
select has_table(
  'public', 'routing_rule_observation_epochs',
  'owners have a content-free observation-set CAS epoch'
);
select has_table(
  'private', 'encrypted_routing_rule_observation_abandonments',
  'stale observation abandonment has a content-free replay tombstone'
);
select ok(
  to_regclass('private.encrypted_routing_rule_observation_reservations') is null
  and (
    select count(*) = 2
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'encrypted_routing_rule_write_claims'
      and (column_name,data_type) in (
        ('observation_reservation_id','uuid'),
        ('observation_reservation_operation_count','integer')
      )
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.encrypted_routing_rule_write_claims'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid)
        like '%observation_reservation_operation_count%'
      and pg_get_constraintdef(oid) like '%expected_revision%'
  ),
  'observe claims own their exact grouped reservation plan without a sidecar'
);
select ok(
  (
    select pg_get_constraintdef(oid) like all(array[
      '%source = ''explicit''%', '%proposal_state IS NULL%',
      '%source = ''correction_suggested''%',
      '%proposal_state = ''accepted''%', '%NOT enabled%'
    ])
    from pg_constraint
    where conrelid = 'public.routing_rules'::regclass
      and conname = 'routing_rules_proposal_lifecycle'
  ),
  'explicit rules have no proposal state and only accepted proposals may enable'
);
select ok(
  (
    select count(*) = 3
      and bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
    from pg_class as relation
    where relation.oid = any(array[
      'public.routing_rule_proposal_observations'::regclass,
      'public.routing_rule_observation_epochs'::regclass,
      'public.encrypted_routing_rule_write_claims'::regclass
    ])
  ) and not exists (
    select 1 from pg_policy
    where polrelid = any(array[
      'public.routing_rule_proposal_observations'::regclass,
      'public.routing_rule_observation_epochs'::regclass,
      'public.encrypted_routing_rule_write_claims'::regclass
    ])
  ),
  'E2 evidence and claim tables use forced policy-free RLS'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public.routing_rule_proposal_observations'::regclass,
      'public.routing_rule_observation_epochs'::regclass,
      'public.encrypted_routing_rule_write_claims'::regclass,
      'public.organization_job_rule_matches'::regclass
    ]) as protected(relation_oid)
    cross join unnest(array[
      'anon','authenticated','service_role','unfiled_index_worker',
      'unfiled_rag_verifier','unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_table_privilege(
      denied.role_name, protected.relation_oid, 'SELECT,INSERT,UPDATE,DELETE'
    )
  ) and not exists (
    select 1
    from unnest(array[
      'private.encrypted_routing_rule_observation_abandonments'::regclass
    ]) as protected(relation_oid)
    cross join unnest(array[
      'anon','authenticated','service_role','unfiled_index_worker',
      'unfiled_rag_verifier','unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_table_privilege(
      denied.role_name,protected.relation_oid,'SELECT,INSERT,UPDATE,DELETE'
    )
  ) and not exists (
    select 1
    from unnest(array[
      'anon','authenticated','service_role','unfiled_index_worker',
      'unfiled_rag_verifier','unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_function_privilege(
      denied.role_name,
      'private.cleanup_routing_rule_observation_reservations()'::regprocedure,
      'EXECUTE'
    )
  ),
  'no runtime role receives routing evidence, tombstone, or cleanup access'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'routing_rule_proposal_observations',
        'routing_rule_observation_epochs',
        'encrypted_routing_rule_write_claims',
        'organization_job_rule_matches'
      )
      and column_name ~ '((condition|request)_(normalized|cipher|envelope|hash)|alias|content)'
  ),
  'content-free E2 evidence and replay tables have no condition or hash channel'
);
select ok(
  (
    select count(*) = 2
    from pg_constraint
    where conrelid = 'public.routing_rule_proposal_observations'::regclass
      and contype in ('p','u')
  ) and (
    select pg_get_constraintdef(oid) like '%user_id, feedback_event_id%'
    from pg_constraint
    where conrelid = 'public.routing_rule_proposal_observations'::regclass
      and contype = 'u'
  ),
  'one feedback event can count once for exactly one owner proposal'
);

-- Exact public capability and organizer boundaries.
select is(
  (
    select count(*)
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'get_encrypted_routing_rule_observation_epoch',
        'get_encrypted_routing_rule_write_claim',
        'prepare_encrypted_routing_rule_write',
        'commit_encrypted_routing_rule_write',
        'delete_encrypted_routing_rule'
      )
  ),
  5::bigint,
  'E2 adds exactly five routing-rule RPCs'
);
select ok(
  to_regprocedure(
    'public.get_encrypted_routing_rule_observation_epoch(uuid)'
  ) is not null
  and to_regprocedure(
    'public.get_encrypted_routing_rule_write_claim(uuid,text,jsonb)'
  ) is not null
  and to_regprocedure(
    'public.prepare_encrypted_routing_rule_write(uuid,text,text,text,integer,bigint,jsonb)'
  ) is not null
  and to_regprocedure(
    'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'
  ) is not null
  and to_regprocedure(
    'public.delete_encrypted_routing_rule(uuid,text,integer,text,jsonb)'
  ) is not null,
  'the five public routing signatures are frozen'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public.get_encrypted_routing_rule_observation_epoch(uuid)'::regprocedure,
      'public.get_encrypted_routing_rule_write_claim(uuid,text,jsonb)'::regprocedure,
      'public.prepare_encrypted_routing_rule_write(uuid,text,text,text,integer,bigint,jsonb)'::regprocedure,
      'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'::regprocedure,
      'public.delete_encrypted_routing_rule(uuid,text,integer,text,jsonb)'::regprocedure
    ]) as rpc(function_oid)
    join pg_proc as procedure on procedure.oid = rpc.function_oid
    where not procedure.prosecdef
      or not (procedure.proconfig @> array['search_path=""'])
  ),
  'all routing RPCs are security-definer functions with an empty search path'
);
select ok(
  not exists (
    select 1
    from unnest(array[
      'public.get_encrypted_routing_rule_observation_epoch(uuid)'::regprocedure,
      'public.get_encrypted_routing_rule_write_claim(uuid,text,jsonb)'::regprocedure,
      'public.prepare_encrypted_routing_rule_write(uuid,text,text,text,integer,bigint,jsonb)'::regprocedure,
      'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'::regprocedure,
      'public.delete_encrypted_routing_rule(uuid,text,integer,text,jsonb)'::regprocedure
    ]) as rpc(function_oid)
    cross join unnest(array[
      'public','anon','authenticated','unfiled_index_worker',
      'unfiled_rag_verifier','unfiled_organizer_worker'
    ]) as denied(role_name)
    where has_function_privilege(denied.role_name, rpc.function_oid, 'EXECUTE')
  ) and not exists (
    select 1
    from unnest(array[
      'public.get_encrypted_routing_rule_observation_epoch(uuid)'::regprocedure,
      'public.get_encrypted_routing_rule_write_claim(uuid,text,jsonb)'::regprocedure,
      'public.prepare_encrypted_routing_rule_write(uuid,text,text,text,integer,bigint,jsonb)'::regprocedure,
      'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'::regprocedure,
      'public.delete_encrypted_routing_rule(uuid,text,integer,text,jsonb)'::regprocedure
    ]) as rpc(function_oid)
    where not has_function_privilege('service_role',rpc.function_oid,'EXECUTE')
  ),
  'routing writes are service-only capabilities'
);
select is(
  (
    select count(*)
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where has_function_privilege(
      'unfiled_organizer_worker',procedure.oid,'EXECUTE'
    )
      and namespace.nspname = 'public'
  ),
  12::bigint,
  'the organizer remains bounded to exactly twelve public RPCs after E4'
);

-- Frozen JSON, projection, ordering, caps, and lock/replay contracts.
select ok(
  private.valid_capture_routing_rule_match(jsonb_build_object(
    'ruleId','rule_90000000000000000000000001',
    'ruleRevision',1,
    'destinationKind','note',
    'destinationId','note_90000000000000000000000001',
    'priority',42,
    'matched',true
  ))
  and not private.valid_capture_routing_rule_match(jsonb_build_object(
    'ruleId','rule_90000000000000000000000001',
    'ruleRevision',1,
    'destinationKind','note',
    'destinationId','note_90000000000000000000000001',
    'priority',42,
    'matched',true,
    'destinationStatus','active'
  )),
  'capture routingRuleMatch accepts exactly the six content-free fields'
);
select ok(
  private.valid_organizer_routing_rule_control(jsonb_build_object(
    'explicitDestinationNoteId',null,
    'expansionDisabled',false,
    'ruleMatch',jsonb_build_object(
      'ruleId','rule_90000000000000000000000001',
      'ruleRevision',1,
      'destinationKind','note',
      'destinationId','note_90000000000000000000000001',
      'priority',42,
      'matched',true
    )
  )) and not private.valid_organizer_routing_rule_control(jsonb_build_object(
    'explicitDestinationNoteId','note_90000000000000000000000001',
    'expansionDisabled',false,
    'ruleMatch',jsonb_build_object(
      'ruleId','rule_90000000000000000000000001',
      'ruleRevision',1,
      'destinationKind','note',
      'destinationId','note_90000000000000000000000001',
      'priority',42,
      'matched',true
    )
  )),
  'organizer controls use ruleMatch and forbid an explicit destination together'
);
select ok(
  (
    select indexdef like '%(user_id, priority DESC, id)%'
      and indexdef like '%WHERE enabled%'
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'routing_rules_owner_match_order'
  ),
  'enabled routing matches order by priority descending then rule ID ascending'
);
select ok(
  pg_get_functiondef(
    'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'::regprocedure
  ) like all(array[
    '%>= 1000%', '%>= 256%', '%observation_count <> 2%',
    '%proposal_observation_replayed%', '%:encrypted-routing-rules%'
  ])
  and pg_get_functiondef(
    'public.delete_encrypted_routing_rule(uuid,text,integer,text,jsonb)'::regprocedure
  ) like all(array[
    '%proposal_state = ''offered''%', '%proposal_state = ''declined''%',
    '%delete from public.routing_rules%'
  ]),
  'caps, two-observation offer, owner writer lock, and delete suppression are explicit'
);
select ok(
  pg_get_functiondef(
    'public.create_encrypted_capture_with_job(uuid,jsonb)'::regprocedure
  ) like all(array[
    '%not p_capture ? ''routingRuleMatch''%',
    '%p_capture ->> ''privacy'' <> ''ai_assisted''%',
    '%explicit_destination_value is not null%',
    '%set last_fired_at = greatest%'
  ])
  and pg_get_functiondef(
    'private.enforce_organization_job_rule_match()'::regprocedure
  ) like all(array[
    '%lock_routing_rule_destination%', '%for share%',
    '%proposal_state = ''accepted''%', '%routing_rule_match_stale%'
  ]) and pg_get_functiondef(
    'public.commit_encrypted_routing_rule_write(uuid,text,text,text,integer,jsonb)'::regprocedure
  ) like all(array[
    '%p_scope = ''update_routing_rule'' and not enabled_value%',
    '%destination_kind_value is distinct from existing_destination_kind%',
    '%destination_id_value is distinct from existing_destination_id%'
  ]),
  'capture admission and blocked-rule pause enforce destination-before-rule validation'
);
select ok(
  pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
  ) like '%''ruleMatch''%'
  and pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
  ) not like '%''routingRuleMatch''%'
  and pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
  ) like all(array[
    '%note.is_open%',
    '%note.privacy = ''ai_assisted''%',
    '%note.archived_at is null%', '%note.deleted_at is null%',
    '%note.type::text = expected_note_type%',
    '%expected_note_type in (''generic'',''principle'',''project'')%'
  ]) and pg_get_functiondef(
    'private.routing_rule_organizer_review_required(text,text,jsonb)'::regprocedure
  ) like all(array[
    '%''review_required''%', '%''candidate_eligibility''%'
  ]),
  'organizer projection is six-field ruleMatch and commit fails closed to Review'
);
select ok(
  pg_get_functiondef(
    'private.list_encrypted_organizer_candidates_impl(text,text,integer)'::regprocedure
  ) like all(array[
    '%safe_capture_local_date%', '%note.type in (''list'',''log'')%',
    '%note.daily_date%', '%note.is_open%', '%note.deleted_at is null%',
    '%note.archived_at is null%'
  ]),
  'space-rule candidate disclosure is bounded to open same-day list/log notes'
);
select ok(
  (
    pg_catalog.length(pg_get_functiondef(
      'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
    )) - pg_catalog.length(pg_catalog.replace(pg_get_functiondef(
      'private.commit_encrypted_organizer_job_impl(text,text,jsonb)'::regprocedure
    ),'note.type::text = expected_note_type',''))
  ) / pg_catalog.length('note.type::text = expected_note_type') = 2,
  'space create/append cardinality and exact-target CAS use the inferred note type'
);
select is(
  private.safe_capture_local_date(
    '2026-09-01 06:30:00+00'::timestamptz,'America/Los_Angeles'
  ),
  date '2026-08-31',
  'capture local date uses a valid IANA timezone'
);
select is(
  private.safe_capture_local_date(
    '2026-09-01 06:30:00+00'::timestamptz,'Mars/Olympus'
  ),
  null::date,
  'an unknown timezone safely yields no daily candidates'
);
select ok(
  pg_get_functiondef(
    'public.list_encrypted_library_objects(uuid,text,text,integer)'::regprocedure
  ) like all(array[
    '%''currentRevision''%', '%''proposalState''%',
    '%''destinationStatus''%', '%rule.condition_revision%'
  ]),
  'owner projection separates public CAS, proposal, destination, and condition revisions'
);

-- Self-contained encrypted create/capture/delete flow exercises admission,
-- exact replay, last-fired non-CAS updates, stale rollback, and immutable
-- snapshots after the mutable rule is gone.
insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  confirmation_token,recovery_token,email_change_token_new,email_change,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '90909090-9090-4090-8090-909090909090',
  'authenticated','authenticated','e2-routing@unfiled.local','',now(),
  '','','','', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,now(),now()
);
insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  confirmation_token,recovery_token,email_change_token_new,email_change,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '91919191-9191-4191-8191-919191919191',
  'authenticated','authenticated','e2-routing-other@unfiled.local','',now(),
  '','','','', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,now(),now()
);
insert into public.content_encryption_rollouts(user_id,state) values (
  '90909090-9090-4090-8090-909090909090','expanded'
),(
  '91919191-9191-4191-8191-919191919191','expanded'
);
insert into public.spaces(id,user_id,name,slug) values (
  'spc_90000000000000000000000001',
  '90909090-9090-4090-8090-909090909090','E2 target','e2-target'
);
insert into public.notes(
  id,user_id,space_id,type,title,body_markdown,structured_data,is_open,privacy
) values
  (
    'note_90000000000000000000000001',
    '90909090-9090-4090-8090-909090909090',
    'spc_90000000000000000000000001','generic','E2 destination','',
    '{}'::jsonb,true,'ai_assisted'
  ),
  (
    'note_90000000000000000000000003',
    '90909090-9090-4090-8090-909090909090',
    'spc_90000000000000000000000001','generic','Private destination','',
    '{}'::jsonb,true,'private_manual'
  ),
  (
    'note_90000000000000000000000004',
    '90909090-9090-4090-8090-909090909090',
    'spc_90000000000000000000000001','generic','Closed destination','',
    '{}'::jsonb,false,'ai_assisted'
  );
insert into public.user_content_keys(
  user_id,key_id,key_class,key_purpose,key_version,kms_key_id,
  wrapped_intermediate_key,state,created_at,activated_at
) select
  '90909090-9090-4090-8090-909090909090',key_id,key_class,key_purpose,1,
  root_arn,decode(repeat(material,32),'hex'),'active',
  '2026-09-01 00:00:00+00','2026-09-01 00:00:01+00'
from (values
  ('e2.private.object.v1','private_manual'::public.content_key_class,
   'object_wrap'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/90000000-0000-4000-8000-000000000001','91'),
  ('e2.private.mac.v1','private_manual'::public.content_key_class,
   'content_mac'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/90000000-0000-4000-8000-000000000002','92'),
  ('e2.ai.object.v1','ai_assisted'::public.content_key_class,
   'object_wrap'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/90000000-0000-4000-8000-000000000003','93'),
  ('e2.ai.mac.v1','ai_assisted'::public.content_key_class,
   'content_mac'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/90000000-0000-4000-8000-000000000004','94')
) as keys(key_id,key_class,key_purpose,root_arn,material);
insert into public.user_content_keys(
  user_id,key_id,key_class,key_purpose,key_version,kms_key_id,
  wrapped_intermediate_key,state,created_at,activated_at
) select
  '91919191-9191-4191-8191-919191919191',key_id,key_class,key_purpose,1,
  root_arn,decode(repeat(material,32),'hex'),'active',
  '2026-09-01 00:00:00+00','2026-09-01 00:00:01+00'
from (values
  ('e2.private.object.v1','private_manual'::public.content_key_class,
   'object_wrap'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/91000000-0000-4000-8000-000000000001','a1'),
  ('e2.private.mac.v1','private_manual'::public.content_key_class,
   'content_mac'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/91000000-0000-4000-8000-000000000002','a2'),
  ('e2.ai.object.v1','ai_assisted'::public.content_key_class,
   'object_wrap'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/91000000-0000-4000-8000-000000000003','a3'),
  ('e2.ai.mac.v1','ai_assisted'::public.content_key_class,
   'content_mac'::public.content_key_purpose,
   'arn:aws:kms:us-west-2:123456789012:key/91000000-0000-4000-8000-000000000004','a4')
) as keys(key_id,key_class,key_purpose,root_arn,material);
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id in (
  '90909090-9090-4090-8090-909090909090',
  '91919191-9191-4191-8191-919191919191'
);

select is(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000001'
  ),
  'active',
  'destination health resolves an owned active note'
);
select is(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000009'
  ),
  'missing',
  'destination health distinguishes an owner-missing note'
);
select ok(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000003'
  ) = 'missing'
  and not private.valid_routing_rule_destination(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000003'
  )
  and not private.lock_routing_rule_destination(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000003'
  ),
  'private-manual notes are never valid or lockable routing destinations'
);
select ok(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000004'
  ) = 'missing'
  and not private.valid_routing_rule_destination(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000004'
  )
  and not private.lock_routing_rule_destination(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000004'
  ),
  'closed notes are never valid or lockable routing destinations'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e2_values(key,value) values (
  'create-preparation',public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090','create_routing_rule',
    'e2-rule-create',null,0,null,
    pg_temp.e2_mac('e2-rule-create','private_manual')
  )
);
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000010',
  'private_manual','e2.private.object.v1',1,2
);
insert into e2_values(key,value)
select 'create-command',jsonb_build_object(
  'scope','create_routing_rule',
  'occurredAt',value ->> 'occurredAt',
  'enabled',true,
  'ruleType','phrase',
  'destinationKind','note',
  'destinationId','note_90000000000000000000000001',
  'priority',42,
  'condition',jsonb_build_object(
    'cipher',pg_temp.e2_cipher(
      '90909090-9090-4090-8090-909090909090',value ->> 'ruleId',1,
      'routing_rule','90000000-0000-4000-8000-000000000010',
      'private_manual','Q'
    ),
    'verificationMac',pg_temp.e2_mac(
      'e2-rule-condition-proof','private_manual'
    )
  ),
  'requestMac',pg_temp.e2_mac('e2-rule-create','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-rule-create',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000010','private_manual','R'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-rule-response-proof','private_manual'
  )
)
from e2_values where key = 'create-preparation';
insert into e2_values(key,value)
select 'create-result',public.commit_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090','create_routing_rule',
  'e2-rule-create',preparation.value ->> 'ruleId',0,command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'create-preparation'
  and command.key = 'create-command';
select ok(
  (select value -> 'expectedObservationEpoch' = 'null'::jsonb
    from e2_values where key = 'create-preparation')
  and (select value #>> '{currentRevision}' = '1'
      and value #>> '{conditionRevision}' = '1'
      and value -> 'proposalState' = 'null'::jsonb
      and value #>> '{replayed}' = 'false'
    from e2_values where key = 'create-result'),
  'explicit encrypted rule creation returns independent CAS and condition revisions'
);
select is(
  public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090','create_routing_rule',
    'e2-rule-create',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    0,(select value from e2_values where key = 'create-command')
  ) ->> 'replayed',
  'true',
  'rule command replay returns the completed encrypted result without a second write'
);

select is(
  public.get_encrypted_routing_rule_observation_epoch(
    '91919191-9191-4191-8191-919191919191'
  ) ->> 'observationEpoch',
  '0',
  'observation epoch reads are isolated from another owner'
);
select is(
  public.get_encrypted_routing_rule_write_claim(
    '91919191-9191-4191-8191-919191919191','e2-rule-create',null
  ),
  '{"found":false}'::jsonb,
  'claim lookup cannot substitute another owner'
);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '91919191-9191-4191-8191-919191919191','update_routing_rule',
    'e2-cross-owner-update',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    1,null,pg_temp.e2_mac('e2-cross-owner-update','private_manual')
  )$$,
  'P0001','not_found',
  'prepare cannot substitute another owner routing rule'
);
select throws_ok(
  $$select public.commit_encrypted_routing_rule_write(
    '91919191-9191-4191-8191-919191919191','create_routing_rule',
    'e2-rule-create',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    0,(select value from e2_values where key = 'create-command')
  )$$,
  'P0001','write_not_prepared',
  'commit cannot substitute another owner routing claim'
);
select public.reserve_content_key_operations(
  '91919191-9191-4191-8191-919191919191',
  '91000000-0000-4000-8000-000000000060',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'cross-owner-delete-command',jsonb_build_object(
  'occurredAt',event.occurred_at,
  'requestMac',pg_temp.e2_mac('e2-cross-owner-delete','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '91919191-9191-4191-8191-919191919191',
    'idempotency:e2-cross-owner-delete',1,'idempotency_response',
    '91000000-0000-4000-8000-000000000060','private_manual','X'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-cross-owner-delete-response','private_manual'
  )
)
from lateral (select pg_temp.e2_event_time() as occurred_at) as event;
select throws_ok(
  $$select public.delete_encrypted_routing_rule(
    '91919191-9191-4191-8191-919191919191',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    1,'e2-cross-owner-delete',
    (select value from e2_values where key = 'cross-owner-delete-command')
  )$$,
  'P0001','not_found',
  'delete cannot substitute another owner routing rule'
);
select public.reserve_content_key_operations(
  '91919191-9191-4191-8191-919191919191',
  '91000000-0000-4000-8000-000000000061',
  'ai_assisted','e2.ai.object.v1',1,1
);
insert into e2_values(key,value)
select 'cross-owner-capture-command',jsonb_build_object(
  'clientCaptureId','cap_91000000000000000000000001',
  'jobId','job_91000000000000000000000001',
  'occurredAt',event.occurred_at,
  'contentCipher',pg_temp.e2_cipher(
    '91919191-9191-4191-8191-919191919191',
    'cap_91000000000000000000000001',1,'capture',
    '91000000-0000-4000-8000-000000000061','ai_assisted','Y'
  ),
  'contentMac',pg_temp.e2_mac('e2-cross-owner-capture','ai_assisted'),
  'contentLength',10,
  'source','web','deviceId','e2-other-web',
  'clientCreatedAt',event.occurred_at,'clientTimezone','UTC',
  'privacy','ai_assisted','explicitDestinationNoteId',null,
  'expansionDisabled',false,'privateReceiptCipher',null,
  'privateReceiptVerificationMac',null,
  'routingRuleMatch',jsonb_build_object(
    'ruleId',preparation.value ->> 'ruleId','ruleRevision',1,
    'destinationKind','note',
    'destinationId','note_90000000000000000000000001',
    'priority',42,'matched',true
  )
)
from e2_values as preparation
cross join lateral (select pg_temp.e2_event_time() as occurred_at) as event
where preparation.key = 'create-preparation';
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '91919191-9191-4191-8191-919191919191',
    (select value from e2_values where key = 'cross-owner-capture-command')
  )$$,
  'P0001','routing_rule_match_stale',
  'capture snapshot and destination validation reject owner substitution'
);
reset role;
select ok(
  not exists (select 1 from public.captures
    where id = 'cap_91000000000000000000000001')
  and not exists (select 1 from public.organization_jobs
    where id = 'job_91000000000000000000000001')
  and not exists (select 1 from public.organization_job_rule_matches
    where job_id = 'job_91000000000000000000000001')
  and not exists (select 1 from public.encrypted_routing_rule_write_claims
    where user_id = '91919191-9191-4191-8191-919191919191')
  and not exists (select 1 from public.routing_rules
    where user_id = '91919191-9191-4191-8191-919191919191'),
  'cross-owner substitutions leave no claim, rule, capture, job, or snapshot'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000020',
  'ai_assisted','e2.ai.object.v1',1,1
);
insert into e2_values(key,value)
select 'capture-command',jsonb_build_object(
  'clientCaptureId','cap_90000000000000000000000001',
  'jobId','job_90000000000000000000000001',
  'occurredAt',event.occurred_at,
  'contentCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'cap_90000000000000000000000001',1,'capture',
    '90000000-0000-4000-8000-000000000020','ai_assisted','C'
  ),
  'contentMac',pg_temp.e2_mac('e2-capture','ai_assisted'),
  'contentLength',18,
  'source','web',
  'deviceId','e2-web',
  'clientCreatedAt',event.occurred_at,
  'clientTimezone','UTC',
  'privacy','ai_assisted',
  'explicitDestinationNoteId',null,
  'expansionDisabled',false,
  'privateReceiptCipher',null,
  'privateReceiptVerificationMac',null,
  'routingRuleMatch',jsonb_build_object(
    'ruleId',preparation.value ->> 'ruleId',
    'ruleRevision',1,
    'destinationKind','note',
    'destinationId','note_90000000000000000000000001',
    'priority',42,
    'matched',true
  )
)
from e2_values as preparation
cross join lateral (select pg_temp.e2_event_time() as occurred_at) as event
where preparation.key = 'create-preparation';
insert into e2_values(key,value)
select 'capture-result',public.create_encrypted_capture_with_job(
  '90909090-9090-4090-8090-909090909090',value
)
from e2_values where key = 'capture-command';
reset role;

select ok(
  (select value ->> 'replayed' = 'false'
    from e2_values where key = 'capture-result')
  and (
    select current_revision = 1
      and condition_revision = 1
      and last_fired_at = (
        select (value ->> 'occurredAt')::timestamptz
        from e2_values where key = 'capture-command'
      )
      and updated_at = created_at
    from public.routing_rules
    where id = (
      select value ->> 'ruleId' from e2_values where key = 'create-preparation'
    )
  ),
  'matched admission updates last_fired without advancing CAS or updated_at'
);
select is(
  private.organization_job_routing_rule_control(
    'job_90000000000000000000000001',
    '90909090-9090-4090-8090-909090909090'
  ),
  (select value -> 'routingRuleMatch'
    from e2_values where key = 'capture-command'),
  'organizer receives the exact immutable six-field ruleMatch snapshot'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  public.create_encrypted_capture_with_job(
    '90909090-9090-4090-8090-909090909090',
    (select value from e2_values where key = 'capture-command')
  ) ->> 'replayed',
  'true',
  'capture replay binds the exact same routing snapshot'
);
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '90909090-9090-4090-8090-909090909090',
    jsonb_set(
      (select value from e2_values where key = 'capture-command'),
      '{routingRuleMatch}','null'::jsonb
    )
  )$$,
  'P0001','invalid_idempotency_key',
  'capture replay cannot remove its admitted routing snapshot'
);

select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000021',
  'ai_assisted','e2.ai.object.v1',1,1
);
insert into e2_values(key,value)
select 'stale-capture-command',
  value || jsonb_build_object(
    'clientCaptureId','cap_90000000000000000000000002',
    'jobId','job_90000000000000000000000002',
    'occurredAt',event.occurred_at,
    'clientCreatedAt',event.occurred_at,
    'contentCipher',pg_temp.e2_cipher(
      '90909090-9090-4090-8090-909090909090',
      'cap_90000000000000000000000002',1,'capture',
      '90000000-0000-4000-8000-000000000021','ai_assisted','S'
    ),
    'routingRuleMatch',jsonb_set(
      value -> 'routingRuleMatch','{priority}','41'::jsonb
    )
  )
from e2_values
cross join lateral (select pg_temp.e2_event_time() as occurred_at) as event
where key = 'capture-command';
select throws_ok(
  $$select public.create_encrypted_capture_with_job(
    '90909090-9090-4090-8090-909090909090',
    (select value from e2_values where key = 'stale-capture-command')
  )$$,
  'P0001','routing_rule_match_stale',
  'a stale pre-admission match fails with the frozen retry token'
);
reset role;
select ok(
  not exists (
    select 1 from public.captures
    where id = 'cap_90000000000000000000000002'
  ) and not exists (
    select 1 from public.organization_jobs
    where id = 'job_90000000000000000000000002'
  ) and (
    select consumed_at is null
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = '90000000-0000-4000-8000-000000000021'
  ),
  'stale admission rolls capture, job, snapshot, and reservation consumption back atomically'
);

update public.content_encryption_rollouts
set state = 'expanded'
where user_id = '90909090-9090-4090-8090-909090909090';
update public.notes
set is_open = false
where id = 'note_90000000000000000000000001';
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '90909090-9090-4090-8090-909090909090';

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e2_values(key,value)
select 'pause-blocked-preparation',public.prepare_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090','update_routing_rule',
  'e2-rule-pause-blocked',value ->> 'ruleId',1,null,
  pg_temp.e2_mac('e2-rule-pause-blocked','private_manual')
)
from e2_values where key = 'create-preparation';
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000022',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'pause-blocked-command',jsonb_build_object(
  'scope','update_routing_rule',
  'occurredAt',value ->> 'occurredAt',
  'enabled',false,
  'ruleType','phrase',
  'destinationKind','note',
  'destinationId','note_90000000000000000000000001',
  'priority',42,
  'condition',null,
  'requestMac',pg_temp.e2_mac('e2-rule-pause-blocked','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-rule-pause-blocked',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000022','private_manual','P'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-rule-pause-blocked-response-proof','private_manual'
  )
)
from e2_values where key = 'pause-blocked-preparation';
insert into e2_values(key,value)
select 'pause-blocked-result',public.commit_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090','update_routing_rule',
  'e2-rule-pause-blocked',preparation.value ->> 'ruleId',1,command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'pause-blocked-preparation'
  and command.key = 'pause-blocked-command';
reset role;

select ok(
  (select value #>> '{currentRevision}' = '2'
      and value #>> '{conditionRevision}' = '1'
      and value #>> '{replayed}' = 'false'
    from e2_values where key = 'pause-blocked-result')
  and (
    select not enabled
      and current_revision = 2
      and condition_revision = 1
      and destination_note_id = 'note_90000000000000000000000001'
      and destination_space_id is null
    from public.routing_rules
    where id = (
      select value ->> 'ruleId' from e2_values where key = 'create-preparation'
    )
  ),
  'an enabled rule can be paused after its unchanged destination becomes ineligible'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e2_values(key,value)
select 'reenable-blocked-preparation',public.prepare_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090','update_routing_rule',
  'e2-rule-reenable-blocked',value ->> 'ruleId',2,null,
  pg_temp.e2_mac('e2-rule-reenable-blocked','private_manual')
)
from e2_values where key = 'create-preparation';
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000023',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'reenable-blocked-command',command.value || jsonb_build_object(
  'occurredAt',preparation.value ->> 'occurredAt',
  'enabled',true,
  'requestMac',pg_temp.e2_mac('e2-rule-reenable-blocked','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-rule-reenable-blocked',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000023','private_manual','E'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-rule-reenable-blocked-response-proof','private_manual'
  )
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'reenable-blocked-preparation'
  and command.key = 'pause-blocked-command';
select throws_ok(
  $$select public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090','update_routing_rule',
    'e2-rule-reenable-blocked',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    2,(select value from e2_values where key = 'reenable-blocked-command')
  )$$,
  'P0001','routing_rule_destination_invalid',
  'a blocked destination cannot be re-enabled'
);

insert into e2_values(key,value)
select 'move-blocked-preparation',public.prepare_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090','update_routing_rule',
  'e2-rule-move-blocked',value ->> 'ruleId',2,null,
  pg_temp.e2_mac('e2-rule-move-blocked','private_manual')
)
from e2_values where key = 'create-preparation';
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000024',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'move-blocked-command',command.value || jsonb_build_object(
  'occurredAt',preparation.value ->> 'occurredAt',
  'destinationId','note_90000000000000000000000003',
  'requestMac',pg_temp.e2_mac('e2-rule-move-blocked','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-rule-move-blocked',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000024','private_manual','M'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-rule-move-blocked-response-proof','private_manual'
  )
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'move-blocked-preparation'
  and command.key = 'pause-blocked-command';
select throws_ok(
  $$select public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090','update_routing_rule',
    'e2-rule-move-blocked',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    2,(select value from e2_values where key = 'move-blocked-command')
  )$$,
  'P0001','routing_rule_destination_invalid',
  'the pause exception cannot move a rule to another ineligible destination'
);
reset role;

update public.content_encryption_rollouts
set state = 'expanded'
where user_id = '90909090-9090-4090-8090-909090909090';
update public.notes
set is_open = true
where id = 'note_90000000000000000000000001';
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '90909090-9090-4090-8090-909090909090';

update public.content_encryption_rollouts
set state = 'expanded'
where user_id = '90909090-9090-4090-8090-909090909090';
update public.notes
set archived_at = clock_timestamp()
where id = 'note_90000000000000000000000001';
select is(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000001'
  ),
  'archived',
  'destination health exposes archived notes instead of treating them active'
);
update public.notes
set archived_at = null, deleted_at = clock_timestamp()
where id = 'note_90000000000000000000000001';
select is(
  private.routing_rule_destination_status(
    '90909090-9090-4090-8090-909090909090','note',
    'note_90000000000000000000000001'
  ),
  'deleted',
  'destination health distinguishes soft-deleted notes'
);
update public.notes
set deleted_at = null
where id = 'note_90000000000000000000000001';
update public.content_encryption_rollouts
set state = 'dual_write'
where user_id = '90909090-9090-4090-8090-909090909090';

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000030',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'delete-command',jsonb_build_object(
  'occurredAt',event.occurred_at,
  'requestMac',pg_temp.e2_mac('e2-rule-delete','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-rule-delete',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000030','private_manual','D'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-rule-delete-response-proof','private_manual'
  )
)
from lateral (select pg_temp.e2_event_time() as occurred_at) as event;
insert into e2_values(key,value)
select 'delete-result',public.delete_encrypted_routing_rule(
  '90909090-9090-4090-8090-909090909090',
  preparation.value ->> 'ruleId',2,'e2-rule-delete',command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'create-preparation'
  and command.key = 'delete-command';
reset role;
select ok(
  not exists (
    select 1 from public.routing_rules
    where id = (
      select value ->> 'ruleId' from e2_values where key = 'create-preparation'
    )
  ) and private.organization_job_routing_rule_control(
    'job_90000000000000000000000001',
    '90909090-9090-4090-8090-909090909090'
  ) = (select value -> 'routingRuleMatch'
    from e2_values where key = 'capture-command'),
  'explicit delete is hard while the admitted organizer snapshot remains authoritative'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-rule-delete',
    (select value -> 'requestMac'
      from e2_values where key = 'delete-command')
  ) @> jsonb_build_object(
    'found',true,'scope','delete_routing_rule','completed',true,
    'replayed',true
  ) and jsonb_typeof(public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-rule-delete',
    (select value -> 'requestMac'
      from e2_values where key = 'delete-command')
  ) -> 'encryptedResponse') = 'object',
  'claim-first delete replay opens the stored response with its exact request MAC'
);
select throws_ok(
  $$select public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-rule-delete',
    pg_temp.e2_mac('different-delete-request','private_manual')
  )$$,
  'P0001','invalid_idempotency_key',
  'claim-first replay rejects a different valid-key request MAC'
);
select is(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-delete-not-found',
    pg_temp.e2_mac('e2-delete-not-found','private_manual')
  ),
  '{"found":false}'::jsonb,
  'a valid new delete MAC may probe an unclaimed idempotency key'
);
select is(
  public.delete_encrypted_routing_rule(
    '90909090-9090-4090-8090-909090909090',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    2,'e2-rule-delete',
    (select value from e2_values where key = 'delete-command')
  ) ->> 'replayed',
  'true',
  'hard-delete replay returns its encrypted tombstone result'
);
reset role;

insert into e2_values(key,value)
select 'delete-old-replay-command',jsonb_set(
  value,'{occurredAt}',to_jsonb(
    date_trunc('milliseconds',clock_timestamp() - interval '10 minutes')
  ),true
)
from e2_values where key = 'delete-command';
update public.encrypted_routing_rule_write_claims as claim
set occurred_at = (command.value ->> 'occurredAt')::timestamptz
from e2_values as command
where claim.user_id = '90909090-9090-4090-8090-909090909090'
  and claim.idempotency_key = 'e2-rule-delete'
  and command.key = 'delete-old-replay-command';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  public.delete_encrypted_routing_rule(
    '90909090-9090-4090-8090-909090909090',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    2,'e2-rule-delete',
    (select value from e2_values where key = 'delete-old-replay-command')
  ) ->> 'replayed',
  'true',
  'completed delete replay binds stored occurredAt but skips fresh-write age'
);
select throws_ok(
  $$select public.delete_encrypted_routing_rule(
    '90909090-9090-4090-8090-909090909090',
    (select value ->> 'ruleId' from e2_values where key = 'create-preparation'),
    2,'e2-rule-delete',jsonb_set(
      (select value from e2_values where key = 'delete-old-replay-command'),
      '{occurredAt}',to_jsonb((
        select (value ->> 'occurredAt')::timestamptz + interval '1 millisecond'
        from e2_values where key = 'delete-old-replay-command'
      )),true
    )
  )$$,
  'P0001','invalid_idempotency_key',
  'completed delete replay rejects a substituted occurredAt'
);
reset role;

-- A matched-space page is complete across active same-day list/log types, but
-- lifecycle-inactive rows must be filtered before encrypted projection.
select is(
  (private.insert_encrypted_routing_rule(
    'rule_90000000000000000000000002',
    '90909090-9090-4090-8090-909090909090',true,'phrase','space',
    'spc_90000000000000000000000001',20,'explicit',null,
    pg_temp.e2_cipher(
      '90909090-9090-4090-8090-909090909090',
      'rule_90000000000000000000000002',1,'routing_rule',
      '90000000-0000-4000-8000-000000000050','private_manual','W'
    ),clock_timestamp()
  )).id,
  'rule_90000000000000000000000002',
  'the candidate regression has an active encrypted space rule'
);
delete from public.organization_job_rule_matches
where job_id = 'job_90000000000000000000000001';
insert into public.organization_job_rule_matches(
  job_id,user_id,rule_id,rule_revision,destination_kind,
  destination_id,priority,matched
) values (
  'job_90000000000000000000000001',
  '90909090-9090-4090-8090-909090909090',
  'rule_90000000000000000000000002',1,'space',
  'spc_90000000000000000000000001',20,true
);
insert into public.notes(
  id,user_id,space_id,type,title,body_markdown,structured_data,
  current_revision,daily_date,is_open,privacy,archived_at,deleted_at,
  content_envelope,content_key_id,content_key_class,
  content_key_purpose,content_key_version
)
select
  fixture.note_id,
  '90909090-9090-4090-8090-909090909090',
  'spc_90000000000000000000000001',fixture.note_type::public.note_type,
  '[encrypted]','[encrypted]','{"schemaVersion":1}'::jsonb,1,
  private.safe_capture_local_date(
    capture.client_created_at,capture.client_timezone
  ),true,'ai_assisted',fixture.archived_at,fixture.deleted_at,
  pg_temp.e2_envelope(
    '90909090-9090-4090-8090-909090909090',fixture.note_id,1,
    'note_content','e2.ai.object.v1',fixture.seed
  ),'e2.ai.object.v1','ai_assisted','object_wrap',1
from (values
  ('note_90000000000000000000000002','list',clock_timestamp(),null::timestamptz,'A'),
  ('note_90000000000000000000000005','log',null::timestamptz,clock_timestamp(),'D')
) as fixture(note_id,note_type,archived_at,deleted_at,seed)
cross join public.captures as capture
where capture.id = 'cap_90000000000000000000000001';
insert into e2_values(key,value) values (
  'space-candidate-claim',
  private.claim_encrypted_organizer_jobs_impl('e2-space-candidate-worker',1,60)
);
insert into e2_values(key,value)
select 'space-inactive-candidate-page',
  private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',8
)
from e2_values where key = 'space-candidate-claim';
select is(
  (select jsonb_array_length(value -> 'candidates')
    from e2_values where key = 'space-inactive-candidate-page'),
  0,
  'archived and deleted same-day rule candidates never enter the projection'
);
update public.notes set archived_at = null,deleted_at = null
where id in (
  'note_90000000000000000000000002',
  'note_90000000000000000000000005'
);
insert into e2_values(key,value)
select 'space-candidate-page',private.list_encrypted_organizer_candidates_impl(
  value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',8
)
from e2_values where key = 'space-candidate-claim';
select is(
  (
    select array_agg(candidate ->> 'noteId' order by candidate ->> 'noteId')
    from e2_values as page
    cross join lateral jsonb_array_elements(
      page.value -> 'candidates'
    ) as candidate
    where page.key = 'space-candidate-page'
  ),
  array[
    'note_90000000000000000000000002',
    'note_90000000000000000000000005'
  ]::text[],
  'space projection includes active list/log rows but excludes archived/deleted rows'
);

insert into e2_values(key,value)
select 'space-candidate-heartbeat',
  private.heartbeat_encrypted_organizer_job_impl(
    claim.value #>> '{jobs,0,jobId}',
    claim.value #>> '{jobs,0,leaseToken}',60,
    pg_temp.e2_disclosure_manifest(page.value)
  )
from e2_values as claim
cross join e2_values as page
where claim.key = 'space-candidate-claim'
  and page.key = 'space-candidate-page';
insert into e2_values(key,value)
select 'space-append-preparation',
  private.prepare_encrypted_organizer_append_impl(
    value #>> '{jobs,0,jobId}',value #>> '{jobs,0,leaseToken}',
    'note_90000000000000000000000002',1,
    '90000000-0000-4000-8000-000000000051'
  )
from e2_values where key = 'space-candidate-claim';
insert into e2_values(key,value) values (
  'space-invalid-target-command',
  '{"outcome":"appended","reviewReason":null,"noteWrite":{},"decision":{},"review":{},"receipt":{}}'::jsonb
);
update public.content_encryption_rollouts set state = 'expanded'
where user_id = '90909090-9090-4090-8090-909090909090';
update public.spaces set archived_at = clock_timestamp()
where user_id = '90909090-9090-4090-8090-909090909090'
  and id = 'spc_90000000000000000000000001';
update public.content_encryption_rollouts set state = 'dual_write'
where user_id = '90909090-9090-4090-8090-909090909090';
insert into e2_values(key,value)
select 'space-invalid-target-result',
  private.commit_encrypted_organizer_job_impl(
    claim.value #>> '{jobs,0,jobId}',
    claim.value #>> '{jobs,0,leaseToken}',command.value
  )
from e2_values as claim
cross join e2_values as command
where claim.key = 'space-candidate-claim'
  and command.key = 'space-invalid-target-command';
select ok(
  (select value @> jsonb_build_object(
      'outcome','review_required',
      'conflictReason','candidate_eligibility',
      'replanCount',1,
      'replayed',false
    ) from e2_values where key = 'space-invalid-target-result')
  and (select write_reservation_id is null
      and decision_reservation_id is null
      and review_reservation_id is null
      and receipt_reservation_id is null
      and commit_replan_result is not null
    from public.encrypted_organizer_preparations
    where job_id = 'job_90000000000000000000000001'),
  'an inactive matched destination persists one content-free Review replan and burns reservations'
);
update public.content_encryption_rollouts set state = 'expanded'
where user_id = '90909090-9090-4090-8090-909090909090';
update public.spaces set archived_at = null
where user_id = '90909090-9090-4090-8090-909090909090'
  and id = 'spc_90000000000000000000000001';
update public.content_encryption_rollouts set state = 'dual_write'
where user_id = '90909090-9090-4090-8090-909090909090';
select is(
  private.commit_encrypted_organizer_job_impl(
    claim.value #>> '{jobs,0,jobId}',
    claim.value #>> '{jobs,0,leaseToken}',command.value
  ) ->> 'replayed',
  'true',
  'exact Review-required replay wins after destination lifecycle recovery'
)
from e2_values as claim
cross join e2_values as command
where claim.key = 'space-candidate-claim'
  and command.key = 'space-invalid-target-command';
select throws_ok(
  $$select private.commit_encrypted_organizer_job_impl(
    claim.value #>> '{jobs,0,jobId}',
    claim.value #>> '{jobs,0,leaseToken}',
    jsonb_set(command.value,'{outcome}','"created"'::jsonb,true)
  )
  from e2_values as claim
  cross join e2_values as command
  where claim.key = 'space-candidate-claim'
    and command.key = 'space-invalid-target-command'$$,
  'P0001','invalid_idempotency_key',
  'a persisted Review-required result rejects a different command hash'
);

-- Learned proposals require two distinct correction events. Exact command
-- replay cannot count the first event twice, and deleting an offered proposal
-- retains a declined suppression row.
insert into public.feedback_events(
  id,user_id,action,new_destination_note_id,reason_code,idempotency_key
) values
  (
    'fbk_90000000000000000000000001',
    '90909090-9090-4090-8090-909090909090','moved',
    'note_90000000000000000000000001','user_correction','e2-feedback-1'
  ),
  (
    'fbk_90000000000000000000000002',
    '90909090-9090-4090-8090-909090909090','moved',
    'note_90000000000000000000000001','user_correction','e2-feedback-2'
  ),
  (
    'fbk_90000000000000000000000003',
    '90909090-9090-4090-8090-909090909090','moved',
    'note_90000000000000000000000001','user_correction','e2-feedback-3'
  );

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  public.get_encrypted_routing_rule_observation_epoch(
    '90909090-9090-4090-8090-909090909090'
  ) ->> 'observationEpoch',
  '0',
  'a new owner starts with observation epoch zero'
);
insert into e2_values(key,value) values (
  'observe-1-preparation',public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-1',null,0,
    0,
    pg_temp.e2_mac('e2-observe-1','private_manual')
  )
);
insert into e2_values(key,value) values (
  'observe-2-initial-preparation',public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-2',null,0,
    0,
    pg_temp.e2_mac('e2-observe-2','private_manual')
  )
);
insert into e2_values(key,value) values (
  'observe-3-initial-preparation',public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-3',null,0,
    0,
    pg_temp.e2_mac('e2-observe-3','private_manual')
  )
);
select ok(
  (select value ->> 'expectedObservationEpoch' = '0'
    from e2_values where key = 'observe-1-preparation')
  and (select value ->> 'expectedObservationEpoch' = '0'
    from e2_values where key = 'observe-2-initial-preparation')
  and (select first.value ->> 'ruleId' <> second.value ->> 'ruleId'
    from e2_values as first cross join e2_values as second
    where first.key = 'observe-1-preparation'
      and second.key = 'observe-2-initial-preparation')
  and (select third.value ->> 'ruleId' <> first.value ->> 'ruleId'
      and third.value ->> 'ruleId' <> second.value ->> 'ruleId'
    from e2_values as third
    cross join e2_values as first
    cross join e2_values as second
    where third.key = 'observe-3-initial-preparation'
      and first.key = 'observe-1-preparation'
      and second.key = 'observe-2-initial-preparation'),
  'three readers may prepare different new-rule plans at epoch zero'
);
select ok(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-observe-2',null
  ) @> jsonb_build_object(
    'found',true,
    'scope','observe_routing_rule_proposal',
    'expectedObservationEpoch',0,
    'completed',false,
    'replayed',true
  ) and (
    select inspected.value #>> '{reservation,reservationId}'
        = prepared.value #>> '{reservation,reservationId}'
      and inspected.value #>> '{reservation,operationCount}'
        = prepared.value #>> '{reservation,operationCount}'
      and inspected.value #>> '{reservation,key,keyId}'
        = prepared.value #>> '{reservation,key,keyId}'
    from e2_values as prepared
    cross join lateral (
      select public.get_encrypted_routing_rule_write_claim(
        '90909090-9090-4090-8090-909090909090','e2-observe-2',null
      ) as value
    ) as inspected
    where prepared.key = 'observe-2-initial-preparation'
  ),
  'claim inspection returns the stored scope and exact unfinished reservation'
);
insert into e2_values(key,value)
select 'observe-1-command',jsonb_build_object(
  'scope','observe_routing_rule_proposal',
  'occurredAt',value ->> 'occurredAt',
  'ruleType','phrase',
  'destinationKind','note',
  'destinationId','note_90000000000000000000000001',
  'priority',33,
  'feedbackEventId','fbk_90000000000000000000000001',
  'condition',jsonb_build_object(
    'cipher',pg_temp.e2_cipher(
      '90909090-9090-4090-8090-909090909090',value ->> 'ruleId',1,
      'routing_rule',(value #>> '{reservation,reservationId}')::uuid,
      'private_manual','O'
    ),
    'verificationMac',pg_temp.e2_mac(
      'e2-observe-condition-proof','private_manual'
    )
  ),
  'requestMac',pg_temp.e2_mac('e2-observe-1','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-observe-1',1,'idempotency_response',
    (value #>> '{reservation,reservationId}')::uuid,'private_manual','P'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-observe-1-response-proof','private_manual'
  )
)
from e2_values where key = 'observe-1-preparation';
insert into e2_values(key,value)
select 'observe-2-initial-command',jsonb_build_object(
  'scope','observe_routing_rule_proposal',
  'occurredAt',value ->> 'occurredAt',
  'ruleType','phrase',
  'destinationKind','note',
  'destinationId','note_90000000000000000000000001',
  'priority',33,
  'feedbackEventId','fbk_90000000000000000000000002',
  'condition',jsonb_build_object(
    'cipher',pg_temp.e2_cipher(
      '90909090-9090-4090-8090-909090909090',value ->> 'ruleId',1,
      'routing_rule',(value #>> '{reservation,reservationId}')::uuid,
      'private_manual','S'
    ),
    'verificationMac',pg_temp.e2_mac(
      'e2-observe-2-initial-condition-proof','private_manual'
    )
  ),
  'requestMac',pg_temp.e2_mac('e2-observe-2','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-observe-2',1,'idempotency_response',
    (value #>> '{reservation,reservationId}')::uuid,'private_manual','T'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-observe-2-initial-response-proof','private_manual'
  )
)
from e2_values where key = 'observe-2-initial-preparation';
reset role;
select ok(
  (
    select count(*) = 3
      and count(distinct preparation.value #>>
        '{reservation,reservationId}') = 3
      and bool_and(
        (preparation.value -> 'reservation') ?& array[
          'reservationId','operationCount','key'
        ]
        and (preparation.value -> 'reservation') - array[
          'reservationId','operationCount','key'
        ] = '{}'::jsonb
        and preparation.value #>> '{reservation,operationCount}' = '2'
        and preparation.value #> '{reservation,key}' @> jsonb_build_object(
          'ownerId','90909090-9090-4090-8090-909090909090',
          'keyId','e2.private.object.v1',
          'keyClass','private_manual','purpose','object_wrap',
          'keyVersion',1,'status','active'
        )
        and reservation.operation_count = 2
        and reservation.consumed_at is null
      )
    from e2_values as preparation
    join public.content_key_operation_reservations as reservation
      on reservation.user_id = '90909090-9090-4090-8090-909090909090'
      and reservation.reservation_id
        = (preparation.value #>> '{reservation,reservationId}')::uuid
    where preparation.key in (
      'observe-1-preparation','observe-2-initial-preparation',
      'observe-3-initial-preparation'
    )
  ),
  'prepare allocates three distinct exact two-operation observation plans'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok(
  (
    select replay.value #>> '{reservation,reservationId}'
        = original.value #>> '{reservation,reservationId}'
      and replay.value #>> '{reservation,operationCount}'
        = original.value #>> '{reservation,operationCount}'
      and replay.value #>> '{reservation,key,keyId}'
        = original.value #>> '{reservation,key,keyId}'
      and replay.value ->> 'replayed' = 'true'
    from e2_values as original
    cross join lateral (
      select public.prepare_encrypted_routing_rule_write(
        '90909090-9090-4090-8090-909090909090',
        'observe_routing_rule_proposal','e2-observe-1',null,0,0,
        pg_temp.e2_mac('e2-observe-1','private_manual')
      ) as value
    ) as replay
    where original.key = 'observe-1-preparation'
  ),
  'an incomplete prepare replay returns the same persisted reservation plan'
);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'bind_routing_rule_observation_reservations','e2-observe-3',null,0,0,
    pg_temp.e2_mac('e2-observe-3','private_manual')
  )$$,
  '22023','validation_failed',
  'post-seal reservation binding is not an admitted prepare scope'
);
select throws_ok(
  $$select public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-1',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'),
    0,jsonb_set(
      (select value from e2_values where key = 'observe-1-command'),
      '{responseCipher,reservationId}',
      to_jsonb((select value #>> '{reservation,reservationId}'
        from e2_values where key = 'observe-2-initial-preparation'))
    )
  )$$,
  'P0001','invalid_key_reservation',
  'an observe commit cannot substitute another valid prepared reservation'
);
insert into e2_values(key,value)
select 'observe-1-result',public.commit_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090',
  'observe_routing_rule_proposal','e2-observe-1',
  preparation.value ->> 'ruleId',0,command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'observe-1-preparation'
  and command.key = 'observe-1-command';
reset role;
select ok(
  (select value ->> 'proposalState' = 'observing'
      and value ->> 'currentRevision' = '1'
    from e2_values where key = 'observe-1-result')
  and (
    select count(*) = 1
    from public.routing_rule_proposal_observations
    where rule_id = (
      select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'
    )
  )
  and (select consumed_at is not null
      and consumed_by_type = 'encrypted_routing_rule_command'
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = (
        select (value #>> '{reservation,reservationId}')::uuid
        from e2_values where key = 'observe-1-preparation'
      )),
  'the first distinct correction creates a disabled observing proposal'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-1',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'),
    0,(select value from e2_values where key = 'observe-1-command')
  ) ->> 'replayed',
  'true',
  'first-observation replay returns the result without double counting'
);
select throws_ok(
  $$select public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-2',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-2-initial-preparation'),
    0,(select value from e2_values where key = 'observe-2-initial-command')
  )$$,
  'P0001','routing_rule_observation_stale',
  'the second epoch-zero plan cannot create a duplicate learned rule'
);
select is(
  public.get_encrypted_routing_rule_observation_epoch(
    '90909090-9090-4090-8090-909090909090'
  ) ->> 'observationEpoch',
  '1',
  'only the successful first observation advances the owner epoch'
);
select ok(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-observe-2',null
  ) @> jsonb_build_object(
    'found',true,
    'scope','observe_routing_rule_proposal',
    'expectedRevision',0,
    'expectedObservationEpoch',0,
    'completed',false
  ),
  'the stale unfinished claim remains inspectable for bounded re-planning'
);
reset role;
select ok(
  (select count(*) = 1 from public.routing_rules
    where user_id = '90909090-9090-4090-8090-909090909090'
      and source = 'correction_suggested')
  and (select count(*) = 1
    from public.routing_rule_proposal_observations
    where user_id = '90909090-9090-4090-8090-909090909090')
  and not exists (
    select 1 from public.routing_rules
    where id = (select value ->> 'ruleId'
      from e2_values where key = 'observe-2-initial-preparation')
  ),
  'the stale writer leaves one proposal and one observation'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-2',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'),
    1,1,pg_temp.e2_mac('e2-observe-2-tampered','private_manual')
  )$$,
  'P0001','invalid_idempotency_key',
  'stale replacement cannot substitute a different logical-request MAC'
);
insert into e2_values(key,value)
select 'observe-2-preparation',public.prepare_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090',
  'observe_routing_rule_proposal','e2-observe-2',value ->> 'ruleId',1,
  1,pg_temp.e2_mac('e2-observe-2','private_manual')
)
from e2_values where key = 'observe-1-preparation';
reset role;
select ok(
  (select replanned.value ->> 'ruleId' = first.value ->> 'ruleId'
      and replanned.value ->> 'expectedRevision' = '1'
      and replanned.value ->> 'expectedObservationEpoch' = '1'
      and replanned.value ->> 'replayed' = 'false'
    from e2_values as replanned cross join e2_values as first
    where replanned.key = 'observe-2-preparation'
      and first.key = 'observe-1-preparation')
  and (select consumed_at is not null
      and consumed_by_id = 'cancelled:e2-observe-2'
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = (
        select (value #>> '{reservation,reservationId}')::uuid
        from e2_values where key = 'observe-2-initial-preparation'
      ))
  and (select replanned.value #>> '{reservation,operationCount}' = '1'
      and replanned.value #>> '{reservation,reservationId}'
        <> initial.value #>> '{reservation,reservationId}'
    from e2_values as replanned cross join e2_values as initial
    where replanned.key = 'observe-2-preparation'
      and initial.key = 'observe-2-initial-preparation')
  and (select consumed_at is null and operation_count = 1
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = (
        select (value #>> '{reservation,reservationId}')::uuid
        from e2_values where key = 'observe-2-preparation'
      )),
  'the same idempotency key atomically replaces its stale unfinished plan'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into e2_values(key,value)
select 'observe-2-command',jsonb_build_object(
  'scope','observe_routing_rule_proposal',
  'occurredAt',value ->> 'occurredAt',
  'ruleType','phrase',
  'destinationKind','note',
  'destinationId','note_90000000000000000000000001',
  'priority',33,
  'feedbackEventId','fbk_90000000000000000000000002',
  'condition',null,
  'requestMac',pg_temp.e2_mac('e2-observe-2','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-observe-2',1,'idempotency_response',
    (value #>> '{reservation,reservationId}')::uuid,'private_manual','V'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-observe-2-response-proof','private_manual'
  )
)
from e2_values where key = 'observe-2-preparation';
savepoint retired_observation_plan;
select public.register_user_content_key(
  '90909090-9090-4090-8090-909090909090','e2.private.object.v2',
  'private_manual','object_wrap',2,
  'arn:aws:kms:us-west-2:123456789012:key/e2-private-object-v2',
  decode(repeat('ee',32),'hex')
);
select public.activate_user_content_key(
  '90909090-9090-4090-8090-909090909090','e2.private.object.v2'
);
select ok(
  (
    select replay.value #>> '{reservation,reservationId}'
        = original.value #>> '{reservation,reservationId}'
      and replay.value #>> '{reservation,key,status}' = 'retired'
      and inspected.value #>> '{reservation,reservationId}'
        = original.value #>> '{reservation,reservationId}'
      and inspected.value #>> '{reservation,key,status}' = 'retired'
    from e2_values as original
    cross join lateral (
      select public.prepare_encrypted_routing_rule_write(
        '90909090-9090-4090-8090-909090909090',
        'observe_routing_rule_proposal','e2-observe-2',
        original.value ->> 'ruleId',1,1,
        pg_temp.e2_mac('e2-observe-2','private_manual')
      ) as value
    ) as replay
    cross join lateral (
      select public.get_encrypted_routing_rule_write_claim(
        '90909090-9090-4090-8090-909090909090','e2-observe-2',null
      ) as value
    ) as inspected
    where original.key = 'observe-2-preparation'
  ),
  'incomplete prepare and claim replay preserve the plan after key retirement'
);
select is(
  public.commit_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'observe_routing_rule_proposal','e2-observe-2',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-2-preparation'),
    1,(select value from e2_values where key = 'observe-2-command')
  ) ->> 'proposalState',
  'offered',
  'an exact prepared routing reservation remains consumable after retirement'
);
rollback to savepoint retired_observation_plan;
select ok(
  (
    select replay.value -> 'reservation' = original.value -> 'reservation'
      and replay.value ->> 'replayed' = 'true'
    from e2_values as original
    cross join lateral (
      select public.prepare_encrypted_routing_rule_write(
        '90909090-9090-4090-8090-909090909090',
        'observe_routing_rule_proposal','e2-observe-2',
        original.value ->> 'ruleId',1,1,
        pg_temp.e2_mac('e2-observe-2','private_manual')
      ) as value
    ) as replay
    where original.key = 'observe-2-preparation'
  ),
  'an exact replanned prepare replay returns its one-operation reservation'
);
insert into e2_values(key,value)
select 'observe-2-result',public.commit_encrypted_routing_rule_write(
  '90909090-9090-4090-8090-909090909090',
  'observe_routing_rule_proposal','e2-observe-2',
  preparation.value ->> 'ruleId',1,command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'observe-2-preparation'
  and command.key = 'observe-2-command';
select ok(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-observe-2',null
  ) @> jsonb_build_object(
    'found',true,
    'scope','observe_routing_rule_proposal',
    'expectedRevision',1,
    'expectedObservationEpoch',1,
    'completed',true
  ) and public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-observe-2',null
  ) -> 'reservation' = 'null'::jsonb,
  'completed claim inspection omits the spent plan and returns stored scope'
);
select is(
  public.get_encrypted_routing_rule_observation_epoch(
    '90909090-9090-4090-8090-909090909090'
  ) ->> 'observationEpoch',
  '2',
  'the successful second distinct observation advances the epoch again'
);
reset role;
select ok(
  (select value ->> 'proposalState' = 'offered'
      and value ->> 'currentRevision' = '2'
    from e2_values where key = 'observe-2-result')
  and (
    select count(*) = 2
    from public.routing_rule_proposal_observations
    where rule_id = (
      select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'
    )
  ) and (
    select not enabled and proposal_state = 'offered'
    from public.routing_rules
    where id = (
      select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'
    )
  ) and (select consumed_at is not null
      and consumed_by_type = 'encrypted_routing_rule_command'
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = (
        select (value #>> '{reservation,reservationId}')::uuid
        from e2_values where key = 'observe-2-preparation'
      )
  ),
  're-planning the second distinct correction offers one rule with two observations'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'abandon_stale_routing_rule_observation','e2-observe-3',null,0,2,
    pg_temp.e2_mac('e2-observe-3-substituted','private_manual')
  )$$,
  'P0001','invalid_idempotency_key',
  'terminal stale-observation abandonment rejects a substituted request MAC'
);
select is(
  public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'abandon_stale_routing_rule_observation','e2-observe-3',null,0,2,
    pg_temp.e2_mac('e2-observe-3','private_manual')
  ),
  '{"abandoned":true}'::jsonb,
  'a terminal third observation deletes only its stale unfinished claim'
);
select is(
  public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'abandon_stale_routing_rule_observation','e2-observe-3',null,0,2,
    pg_temp.e2_mac('e2-observe-3','private_manual')
  ),
  '{"abandoned":true}'::jsonb,
  'exact stale-observation abandonment replay is a no-op'
);
select is(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-observe-3',null
  ),
  '{"found":false}'::jsonb,
  'the abandoned stale observation no longer has a live routing write claim'
);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090','create_routing_rule',
    'e2-observe-3',null,0,null,
    pg_temp.e2_mac('e2-observe-3','private_manual')
  )$$,
  'P0001','invalid_idempotency_key',
  'an abandonment tombstone permanently reserves the idempotency namespace'
);
reset role;
select ok(
  (select count(*) = 1 from public.routing_rules
    where user_id = '90909090-9090-4090-8090-909090909090'
      and source = 'correction_suggested')
  and (select count(*) = 2
    from public.routing_rule_proposal_observations
    where user_id = '90909090-9090-4090-8090-909090909090')
  and (select routing_rule_id is null from public.feedback_events
    where id = 'fbk_90000000000000000000000003')
  and (select count(*) = 1
    from private.encrypted_routing_rule_observation_abandonments
    where user_id = '90909090-9090-4090-8090-909090909090'
      and idempotency_key = 'e2-observe-3')
  and (select consumed_at is not null
      and consumed_by_id = 'cancelled:e2-observe-3'
    from public.content_key_operation_reservations
    where user_id = '90909090-9090-4090-8090-909090909090'
      and reservation_id = (
        select (value #>> '{reservation,reservationId}')::uuid
        from e2_values where key = 'observe-3-initial-preparation'
      )),
  'terminal abandonment preserves learned state and burns every sealed reservation'
);

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.reserve_content_key_operations(
  '90909090-9090-4090-8090-909090909090',
  '90000000-0000-4000-8000-000000000042',
  'private_manual','e2.private.object.v1',1,1
);
insert into e2_values(key,value)
select 'suppress-command',jsonb_build_object(
  'occurredAt',event.occurred_at,
  'requestMac',pg_temp.e2_mac('e2-suppress','private_manual'),
  'responseCipher',pg_temp.e2_cipher(
    '90909090-9090-4090-8090-909090909090',
    'idempotency:e2-suppress',1,'idempotency_response',
    '90000000-0000-4000-8000-000000000042','private_manual','U'
  ),
  'responseVerificationMac',pg_temp.e2_mac(
    'e2-suppress-response-proof','private_manual'
  )
)
from lateral (select pg_temp.e2_event_time() as occurred_at) as event;
insert into e2_values(key,value)
select 'suppress-result',public.delete_encrypted_routing_rule(
  '90909090-9090-4090-8090-909090909090',
  preparation.value ->> 'ruleId',2,'e2-suppress',command.value
)
from e2_values as preparation
cross join e2_values as command
where preparation.key = 'observe-1-preparation'
  and command.key = 'suppress-command';
reset role;
select ok(
  (select value ->> 'proposalState' = 'declined'
      and value ->> 'currentRevision' = '3'
    from e2_values where key = 'suppress-result')
  and (
    select not enabled and proposal_state = 'declined'
    from public.routing_rules
    where id = (
      select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'
    )
  ),
  'DELETE of an offered proposal retains a declined suppression record'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok(
  $$select public.prepare_encrypted_routing_rule_write(
    '90909090-9090-4090-8090-909090909090',
    'accept_routing_rule_proposal','e2-suppressed-accept',
    (select value ->> 'ruleId'
      from e2_values where key = 'observe-1-preparation'),
    3,null,pg_temp.e2_mac('e2-suppressed-accept','private_manual')
  )$$,
  'P0001','invalid_proposal_state',
  'a retained decline suppresses later accidental acceptance'
);
reset role;

insert into public.user_content_keys(
  user_id,key_id,key_class,key_purpose,key_version,kms_key_id,
  wrapped_intermediate_key,state,predecessor_key_id,created_at
) values (
  '90909090-9090-4090-8090-909090909090','e2.private.mac.v2',
  'private_manual','content_mac',2,
  'arn:aws:kms:us-west-2:123456789012:key/90000000-0000-4000-8000-000000000005',
  decode(repeat('95',32),'hex'),'pending','e2.private.mac.v1',
  '2026-09-01 00:00:02+00'
);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(
  public.activate_user_content_key(
    '90909090-9090-4090-8090-909090909090','e2.private.mac.v2'
  ) ->> 'state',
  'active',
  'the replay regression rotates the request-MAC key'
);
select is(
  public.get_encrypted_routing_rule_write_claim(
    '90909090-9090-4090-8090-909090909090','e2-rule-delete',null
  ) #>> '{requestMacKey,keyId}',
  'e2.private.mac.v1',
  'locator mode discovers the sticky retired request-MAC key without a catch-22'
);
select ok(
  not exists (
    select 1
    from (values
      ('e2-rule-create','e2-rule-create','create_routing_rule'),
      ('e2-rule-delete','e2-rule-delete','delete_routing_rule'),
      ('e2-observe-1','e2-observe-1','observe_routing_rule_proposal'),
      ('e2-observe-2','e2-observe-2','observe_routing_rule_proposal'),
      ('e2-suppress','e2-suppress','delete_routing_rule')
    ) as expected(idempotency_key,mac_seed,scope)
    where not (
      public.get_encrypted_routing_rule_write_claim(
        '90909090-9090-4090-8090-909090909090',
        expected.idempotency_key,
        pg_temp.e2_mac(expected.mac_seed,'private_manual')
      ) @> jsonb_build_object(
        'found',true,'scope',expected.scope,'completed',true,'replayed',true
      )
      and jsonb_typeof(public.get_encrypted_routing_rule_write_claim(
        '90909090-9090-4090-8090-909090909090',
        expected.idempotency_key,
        pg_temp.e2_mac(expected.mac_seed,'private_manual')
      ) -> 'encryptedResponse') = 'object'
    )
  ),
  'completed create, observe, and delete claims replay through their retired sticky MAC'
);
reset role;

select * from finish();
rollback;
