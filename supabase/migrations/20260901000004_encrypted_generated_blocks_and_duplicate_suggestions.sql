-- Milestone E3: encrypted generated blocks and duplicate suggestions.
--
-- Generated text remains a separate encrypted aggregate.  Organizer prepare
-- reserves its wrap up front, routed expansion publication is atomic with the
-- note write, and accept/reject is a service-only Review resolution with a
-- generated-block CAS.  Duplicate suggestions remain metadata-only Reviews.

-- Freeze the actual routing model on the job.  E4 may source this value from
-- the immutable settings snapshot, but E3 must not accept model provenance
-- supplied only by an organizer process after the lease is claimed.
update public.organization_jobs
set model_id = 'gpt-5.4-mini-2026-03-17'
where model_id is null;

alter table public.organization_jobs
  alter column model_id set default 'gpt-5.4-mini-2026-03-17',
  alter column model_id set not null,
  add constraint organization_jobs_model_id_shape check (
    char_length(model_id) between 1 and 120
  );

create or replace function private.enforce_organization_job_model_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.model_id is distinct from old.model_id then
    raise exception using errcode = 'P0001', message = 'immutable_job_model';
  end if;
  return new;
end;
$$;

create trigger organization_job_model_immutable
before update of model_id on public.organization_jobs
for each row execute function private.enforce_organization_job_model_immutable();

-- The worker claim is the authoritative provenance projection.  Patch only
-- the reviewed JSON fragment and fail closed if a prior migration drifted it.
do $organizer_claim_model_projection$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.claim_encrypted_organizer_jobs_impl(text,integer,integer)'::regprocedure
  );
  old_fragment constant text := $old$'promptVersion', job_row.prompt_version,
      'schemaVersion', job_row.schema_version,$old$;
  new_fragment constant text := $new$'promptVersion', job_row.prompt_version,
      'modelId', job_row.model_id,
      'schemaVersion', job_row.schema_version,$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, old_fragment, ''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'organizer_claim_model_projection_drift';
  end if;
  execute pg_catalog.replace(definition, old_fragment, new_fragment);
end;
$organizer_claim_model_projection$;

-- A retry starts a new attempt of the same immutable organization job.  The
-- legacy retry functions cleared model_id along with transient lease state;
-- remove that assignment rather than weakening the provenance trigger.  Keep
-- this as a fail-closed source patch so an upstream definition change cannot
-- silently reintroduce mutable model provenance.
do $preserve_retry_job_model$
declare
  target_function regprocedure;
  definition text;
  old_fragment constant text := $old$    model_id = null,
$old$;
  occurrence_count integer;
begin
  foreach target_function in array array[
    'public.retry_capture(uuid,text,text)'::regprocedure,
    'public.retry_encrypted_capture(uuid,text,text,jsonb)'::regprocedure
  ] loop
    definition := pg_catalog.pg_get_functiondef(target_function);
    occurrence_count := (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_fragment, ''))
    ) / pg_catalog.length(old_fragment);
    if occurrence_count <> 1 then
      raise exception using errcode = 'P0001',
        message = 'retry_job_model_provenance_drift';
    end if;
    execute pg_catalog.replace(definition, old_fragment, '');
  end loop;
end;
$preserve_retry_job_model$;

-- Every preparation owns one stable generated-block identity and one extra
-- one-operation reservation.  The existing four reservations remain intact;
-- this is the eighth wrap in the organizer budget (4 + 1 + 1 + 1 + 1).
alter table public.encrypted_organizer_preparations
  add column generated_block_id text
    default public.new_entity_id('blk'),
  add column generated_block_reservation_id uuid,
  add column e3_kind text check (
    e3_kind is null or e3_kind in ('expansion','duplicate_suggestion')
  ),
  add column e3_command_hash text check (
    e3_command_hash is null or e3_command_hash ~ '^[0-9a-f]{64}$'
  ),
  add column e3_result jsonb check (
    e3_result is null or jsonb_typeof(e3_result) = 'object'
  );

update public.encrypted_organizer_preparations
set generated_block_id = public.new_entity_id('blk')
where generated_block_id is null;

alter table public.encrypted_organizer_preparations
  alter column generated_block_id set not null,
  add constraint encrypted_organizer_preparations_generated_block_id_key
    unique (generated_block_id),
  add constraint encrypted_organizer_preparations_generated_block_id_shape
    check (generated_block_id ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'),
  add constraint encrypted_organizer_preparations_generated_reservation_fkey
    foreign key (user_id, generated_block_reservation_id)
    references public.content_key_operation_reservations(user_id, reservation_id)
    deferrable initially deferred,
  add constraint encrypted_organizer_preparations_e3_result_shape check (
    (e3_command_hash is null and e3_result is null)
    or (e3_command_hash is not null and e3_result is not null)
    or (e3_command_hash is not null and e3_result is null)
  );

create or replace function private.encrypted_organizer_preparation_projection(
  preparation public.encrypted_organizer_preparations,
  object_key public.user_content_keys,
  mac_key public.user_content_keys,
  replayed_value boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobId', preparation.job_id,
    'mode', preparation.mode,
    'noteId', preparation.note_id,
    'expectedRevision', preparation.expected_revision,
    'targetRevision', preparation.target_revision,
    'replanCount', (
      select job.replan_count from public.organization_jobs as job
      where job.id = preparation.job_id
    ),
    'ids', jsonb_build_object(
      'decisionId', preparation.decision_id,
      'revisionId', preparation.revision_id,
      'mutationId', preparation.mutation_id,
      'reviewItemId', preparation.review_item_id,
      'generatedBlockId', preparation.generated_block_id
    ),
    'reservations', jsonb_build_object(
      'noteWrite', jsonb_build_object(
        'reservationId', preparation.write_reservation_id,
        'operationCount', 4
      ),
      'decision', jsonb_build_object(
        'reservationId', preparation.decision_reservation_id,
        'operationCount', 1
      ),
      'review', jsonb_build_object(
        'reservationId', preparation.review_reservation_id,
        'operationCount', 1
      ),
      'receipt', jsonb_build_object(
        'reservationId', preparation.receipt_reservation_id,
        'operationCount', 1
      ),
      'generatedBlock', jsonb_build_object(
        'reservationId', preparation.generated_block_reservation_id,
        'operationCount', 1
      )
    ),
    'keys', jsonb_build_object(
      'objectWrap', private.organizer_key_projection(object_key),
      'contentMac', private.organizer_key_projection(mac_key)
    ),
    'replayed', replayed_value
  );
$$;

-- Preserve the E2 prepare implementation as the reviewed seven-wrap base and
-- add the generated-block reservation in the same transaction.
alter function private.prepare_encrypted_organizer_write_impl(
  text,text,text,text,bigint,text
) rename to prepare_encrypted_organizer_write_impl_e2;

create function private.prepare_encrypted_organizer_write_impl(
  p_job_id text,
  p_lease_token text,
  p_mode text,
  p_note_id text,
  p_expected_revision bigint,
  p_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  preparation public.encrypted_organizer_preparations%rowtype;
  object_key public.user_content_keys%rowtype;
  mac_key public.user_content_keys%rowtype;
  generated_reservation uuid;
  generated_consumed boolean := false;
  replayed_value boolean := false;
begin
  perform private.assert_encrypted_organizer_lease(
    p_job_id,p_lease_token,true
  );
  perform private.prepare_encrypted_organizer_write_impl_e2(
    p_job_id,p_lease_token,p_mode,p_note_id,p_expected_revision,p_reservation_id
  );

  select prep.* into preparation
  from public.encrypted_organizer_preparations as prep
  where prep.job_id = p_job_id
  for update;
  if not found or preparation.completed_at is not null
    or preparation.lease_token::text <> p_lease_token
    or preparation.write_reservation_id is null
  then
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;

  if preparation.generated_block_reservation_id is not null then
    select reservation.consumed_at is not null into generated_consumed
    from public.content_key_operation_reservations as reservation
    where reservation.user_id = preparation.user_id
      and reservation.reservation_id = preparation.generated_block_reservation_id;
    generated_consumed := coalesce(generated_consumed,true);
  end if;

  select * into object_key
  from public.user_content_keys as content_key
  where content_key.user_id = preparation.user_id
    and content_key.key_id = preparation.object_key_id
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'object_wrap'
    and content_key.key_version = preparation.object_key_version
    and content_key.state = 'active'
  for update of content_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;

  if preparation.generated_block_reservation_id is null or generated_consumed then
    generated_reservation := extensions.gen_random_uuid();
    update public.user_content_keys
    set wrap_operations = wrap_operations + 1
    where user_id = object_key.user_id
      and key_id = object_key.key_id
      and key_class = 'ai_assisted'
      and key_purpose = 'object_wrap'
      and key_version = object_key.key_version
      and state = 'active'
      and wrap_operations < wrap_operation_limit
    returning * into object_key;
    if not found then
      raise exception using errcode = 'P0001', message = 'key_operation_limit';
    end if;
    insert into public.content_key_operation_reservations (
      user_id,reservation_id,key_id,key_class,key_purpose,key_version,
      operation_count
    ) values (
      preparation.user_id,generated_reservation,object_key.key_id,
      'ai_assisted','object_wrap',object_key.key_version,1
    );
    update public.encrypted_organizer_preparations
    set generated_block_reservation_id = generated_reservation,
      e3_kind = null,e3_command_hash = null,e3_result = null,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id
    returning * into preparation;
  else
    replayed_value := true;
  end if;

  select * into mac_key
  from public.user_content_keys as content_key
  where content_key.user_id = preparation.user_id
    and content_key.key_class = 'ai_assisted'
    and content_key.key_purpose = 'content_mac'
    and content_key.state in ('active','retired')
  order by (content_key.state = 'active') desc,content_key.key_version desc
  limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'active_ai_key_required';
  end if;

  return private.encrypted_organizer_preparation_projection(
    preparation,object_key,mac_key,replayed_value
  );
end;
$$;

create or replace function private.consume_encrypted_organizer_reservation(
  p_preparation public.encrypted_organizer_preparations,
  p_cipher jsonb,
  p_expected_reservation uuid,
  p_consumer_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.content_key_operation_reservations%rowtype;
  aggregate_kind text;
begin
  aggregate_kind := case
    when p_consumer_id = p_preparation.decision_id
      then 'organization_decision'
    when p_consumer_id = p_preparation.review_item_id
      then 'review_item'
    when p_consumer_id = p_preparation.capture_id
      then 'capture_receipt'
    when p_consumer_id = p_preparation.generated_block_id
      then 'generated_block'
  end;
  if p_expected_reservation is null
    or p_consumer_id is null
    or char_length(p_consumer_id) not between 1 and 200
    or aggregate_kind is null
    or not private.valid_encrypted_write_cipher(
      p_cipher,p_preparation.user_id,p_consumer_id,1,aggregate_kind,
      'ai_assisted'
    )
    or (p_cipher ->> 'reservationId')::uuid <> p_expected_reservation
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;

  select * into reservation
  from public.content_key_operation_reservations
  where user_id = p_preparation.user_id
    and reservation_id = p_expected_reservation
  for update;
  if not found or reservation.operation_count <> 1
    or reservation.key_id <> p_preparation.object_key_id
    or reservation.key_class <> 'ai_assisted'
    or reservation.key_purpose <> 'object_wrap'
    or reservation.key_version <> p_preparation.object_key_version
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_reservation';
  end if;
  if reservation.consumed_at is not null then
    if reservation.consumed_by_type = 'encrypted_organizer'
      and reservation.consumed_by_id = p_consumer_id
    then return; end if;
    raise exception using errcode = 'P0001', message = 'key_reservation_consumed';
  end if;
  if not exists (
    select 1 from public.user_content_keys
    where user_id = reservation.user_id and key_id = reservation.key_id
      and key_class = 'ai_assisted' and key_purpose = 'object_wrap'
      and key_version = reservation.key_version and state = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;
  update public.content_key_operation_reservations
  set consumed_by_type = 'encrypted_organizer',
    consumed_by_id = p_consumer_id,consumed_at = clock_timestamp()
  where user_id = p_preparation.user_id
    and reservation_id = p_expected_reservation;
end;
$$;

create or replace function private.burn_encrypted_organizer_reservations(
  p_job_id text,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  preparation public.encrypted_organizer_preparations%rowtype;
  reservation_id_value uuid;
begin
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = p_job_id and completed_at is null
  for update;
  if not found then return; end if;
  if preparation.lease_token <> p_lease_token then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;
  for reservation_id_value in
    select value from unnest(array[
      preparation.write_reservation_id,
      preparation.decision_reservation_id,
      case when preparation.e3_kind = 'expansion'
        then null else preparation.review_reservation_id end,
      preparation.receipt_reservation_id,
      case when preparation.e3_kind = 'expansion'
        then null else preparation.generated_block_reservation_id end
    ]) as reservation(value)
    where value is not null
  loop
    update public.content_key_operation_reservations
    set consumed_by_type = 'encrypted_organizer',
      consumed_by_id = preparation.job_id,consumed_at = clock_timestamp()
    where user_id = preparation.user_id
      and reservation_id = reservation_id_value
      and consumed_at is null;
  end loop;
end;
$$;

create or replace function private.insert_encrypted_organizer_generated_block(
  p_preparation public.encrypted_organizer_preparations,
  p_block jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cipher jsonb;
  verification_mac jsonb;
  kind_value public.block_kind;
  job_row public.organization_jobs%rowtype;
begin
  if p_block is null or jsonb_typeof(p_block) <> 'object'
    or p_block - array[
      'kind','modelId','promptVersion','cipher','verificationMac'
    ] <> '{}'::jsonb
    or not p_block ?& array[
      'kind','modelId','promptVersion','cipher','verificationMac'
    ]
    or jsonb_typeof(p_block -> 'kind') <> 'string'
    or jsonb_typeof(p_block -> 'modelId') <> 'string'
    or jsonb_typeof(p_block -> 'promptVersion') <> 'string'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  begin
    kind_value := (p_block ->> 'kind')::public.block_kind;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'validation_failed';
  end;
  select * into job_row from public.organization_jobs
  where id = p_preparation.job_id and user_id = p_preparation.user_id;
  if not found
    or p_block ->> 'modelId' <> job_row.model_id
    or p_block ->> 'promptVersion' <> job_row.prompt_version
  then
    raise exception using errcode = '22023', message = 'invalid_provenance';
  end if;
  cipher := p_block -> 'cipher';
  verification_mac := p_block -> 'verificationMac';
  if not private.valid_encrypted_write_mac(
    verification_mac,p_preparation.user_id,'ai_assisted',false
  ) then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_encrypted_organizer_reservation(
    p_preparation,cipher,p_preparation.generated_block_reservation_id,
    p_preparation.generated_block_id
  );

  insert into public.generated_blocks (
    id,user_id,note_id,decision_id,kind,content,state,model_id,
    prompt_version,review_item_id,state_revision,resolved_at,created_at,
    content_envelope,content_key_id,content_key_class,content_key_purpose,
    content_key_version
  ) values (
    p_preparation.generated_block_id,p_preparation.user_id,
    p_preparation.note_id,p_preparation.decision_id,kind_value,'[encrypted]',
    'proposed',job_row.model_id,job_row.prompt_version,
    p_preparation.review_item_id,1,null,clock_timestamp(),
    cipher -> 'envelope',cipher ->> 'keyId',
    (cipher ->> 'keyClass')::public.content_key_class,
    (cipher ->> 'keyPurpose')::public.content_key_purpose,
    (cipher ->> 'keyVersion')::integer
  );
  perform private.record_content_encryption_verification(
    p_preparation.user_id,'generated_block',
    p_preparation.generated_block_id,1,cipher -> 'envelope',verification_mac
  );
end;
$$;

-- A contracted database no longer has the legacy generated_blocks.content
-- mirror.  Keep the same helper valid on either side of delayed contraction.
do $generated_block_contract$
begin
  if private.encrypted_storage_contract_applied() then
    perform private.contract_replace_function(
      'private.insert_encrypted_organizer_generated_block(public.encrypted_organizer_preparations,jsonb)',
      $old$kind,content,state,model_id,$old$,
      $new$kind,state,model_id,$new$
    );
    perform private.contract_replace_function(
      'private.insert_encrypted_organizer_generated_block(public.encrypted_organizer_preparations,jsonb)',
      $old$p_preparation.decision_id,kind_value,'[encrypted]',
    'proposed',$old$,
      $new$p_preparation.decision_id,kind_value,
    'proposed',$new$
    );
  end if;
end;
$generated_block_contract$;

-- The E2 receipt helper runs inside the E3 transaction and therefore must
-- project the already-sealed E3 receipt correctly on its initial INSERT.  A
-- follow-up relational rewrite is both unnecessary and rejected by the
-- encrypted aggregate revision guard. Expansion Reviews are inserted inside
-- the delegated routed write immediately before this helper runs, so the
-- receipt FK is valid; duplicate reasons come from the decision that E2 has
-- just inserted from the same authenticated command.
do $e3_organizer_receipt_projection$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.insert_encrypted_organizer_receipt(public.encrypted_organizer_preparations,jsonb,text,text,boolean,text)'::regprocedure
  );
  old_review constant text :=
    $old$case when p_review then p_preparation.review_item_id else null end$old$;
  new_review constant text :=
    $new$case when p_review or p_preparation.e3_kind = 'expansion'
      then p_preparation.review_item_id else null end$new$;
  old_reasons constant text := $old$case
      when p_review and p_review_reason = 'planner_ambiguity'$old$;
  new_reasons constant text := $new$case
      when p_preparation.e3_kind = 'expansion'
        then array['expansion_pending']::text[]
      when p_preparation.e3_kind = 'duplicate_suggestion'
        then coalesce((
          select decision.reason_codes
          from public.organization_decisions as decision
          where decision.user_id = p_preparation.user_id
            and decision.id = p_preparation.decision_id
        ),array[]::text[])
      when p_review and p_review_reason = 'planner_ambiguity'$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_review,''))
  ) / pg_catalog.length(old_review);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'e3_receipt_review_projection_drift';
  end if;
  definition := pg_catalog.replace(definition,old_review,new_review);
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_reasons,''))
  ) / pg_catalog.length(old_reasons);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'e3_receipt_reason_projection_drift';
  end if;
  execute pg_catalog.replace(definition,old_reasons,new_reasons);
end;
$e3_organizer_receipt_projection$;

-- The routed E1 implementation owns the note-write/decision/receipt ordering.
-- Insert the pending-expansion Review after the note exists and immediately
-- before the capture link/receipt publication.  Passing the authenticated
-- Review command through the legacy shape is safe: ordinary routed commands
-- ignore that field, while the E3 marker on the locked preparation narrows
-- this hook to the expansion branch.
do $e3_organizer_review_ordering$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.commit_encrypted_organizer_job_impl_e1(text,text,jsonb)'::regprocedure
  );
  old_fragment constant text := $old$    insert into public.capture_note_links ($old$;
  new_fragment constant text := $new$    if preparation.e3_kind = 'expansion' then
      perform private.insert_encrypted_organizer_review(
        preparation,p_command -> 'review',preparation.note_id
      );
    end if;

    insert into public.capture_note_links ($new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'e3_review_ordering_contract_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$e3_organizer_review_ordering$;

-- Keep the complete E2 routing-rule wrapper.  The E3 wrapper delegates every
-- ordinary command byte-for-byte (apart from the new required null field) and
-- performs only the two new atomic publication branches.
alter function private.commit_encrypted_organizer_job_impl(text,text,jsonb)
  rename to commit_encrypted_organizer_job_impl_e2;

create function private.commit_encrypted_organizer_job_impl(
  p_job_id text,
  p_lease_token text,
  p_command jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  preparation public.encrypted_organizer_preparations%rowtype;
  job_row public.organization_jobs%rowtype;
  command_hash_value text;
  legacy_command jsonb;
  delegated_result jsonb;
  final_result jsonb;
  e3_kind_value text;
  duplicate_reason_codes text[];
  e3_review_reservation_id uuid;
  e3_generated_reservation_id uuid;
begin
  -- E2 delegated routing invariants remain authoritative here:
  -- note.is_open; note.privacy = 'ai_assisted'; note.archived_at is null;
  -- note.deleted_at is null; note.type::text = expected_note_type;
  -- expected_note_type in ('generic','principle','project').
  -- Both the space cardinality check and exact-target CAS retain this predicate:
  -- note.type::text = expected_note_type.
  -- Rolling compatibility: a pre-E3 organizer may still submit the six-key
  -- command.  It cannot publish a block and delegates unchanged.
  if jsonb_typeof(p_command) = 'object'
    and private.jsonb_has_exact_keys(p_command,array[
      'outcome','noteWrite','decision','review','receipt','reviewReason'
    ])
  then
    return private.commit_encrypted_organizer_job_impl_e2(
      p_job_id,p_lease_token,p_command
    );
  end if;
  if jsonb_typeof(p_command) <> 'object'
    or not private.jsonb_has_exact_keys(p_command,array[
      'outcome','noteWrite','decision','generatedBlock','review','receipt',
      'reviewReason'
    ])
    or jsonb_typeof(p_command -> 'generatedBlock') not in ('object','null')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  if jsonb_typeof(p_command -> 'generatedBlock') = 'null'
    and not (
      p_command ->> 'outcome' = 'review'
      and p_command ->> 'reviewReason' = 'duplicate_suggestion'
    )
  then
    return private.commit_encrypted_organizer_job_impl_e2(
      p_job_id,p_lease_token,p_command - 'generatedBlock'
    );
  end if;

  if p_command ->> 'outcome' in ('created','appended')
    and p_command ->> 'reviewReason' = 'expansion_pending'
    and jsonb_typeof(p_command -> 'noteWrite') = 'object'
    and jsonb_typeof(p_command -> 'generatedBlock') = 'object'
    and jsonb_typeof(p_command -> 'review') = 'object'
    and p_command #>> '{review,type}' = 'pending_expansion'
  then
    e3_kind_value := 'expansion';
  elsif p_command ->> 'outcome' = 'review'
    and p_command ->> 'reviewReason' = 'duplicate_suggestion'
    and jsonb_typeof(p_command -> 'noteWrite') = 'null'
    and jsonb_typeof(p_command -> 'generatedBlock') = 'null'
    and jsonb_typeof(p_command -> 'review') = 'object'
    and p_command #>> '{review,type}' = 'duplicate_suggestion'
  then
    e3_kind_value := 'duplicate_suggestion';
  else
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  command_hash_value := private.request_hash(jsonb_build_object(
    'domain','unfiled.encrypted-organizer-commit.v2',
    'jobId',p_job_id,'command',p_command
  ));
  job_row := private.lock_encrypted_organizer_job_rollout(p_job_id);
  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = p_job_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;
  if preparation.e3_result is not null then
    if preparation.e3_command_hash <> command_hash_value
      or preparation.e3_kind <> e3_kind_value
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_set(preparation.e3_result,'{replayed}','true'::jsonb,true);
  end if;
  if preparation.completed_at is not null
    or preparation.e3_command_hash is not null
    or preparation.generated_block_reservation_id is null
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  e3_review_reservation_id := preparation.review_reservation_id;
  e3_generated_reservation_id := preparation.generated_block_reservation_id;
  if e3_kind_value = 'expansion' then
    if preparation.controls ->> 'expansionDisabled' <> 'false'
      or p_command ->> 'outcome' <> (case preparation.mode
        when 'create' then 'created' else 'appended' end)
    then
      raise exception using errcode = '42501', message = 'expansion_disabled';
    end if;
    -- Validate provenance and the dedicated reservation before delegating the
    -- note write.  Consumption remains after delegation so rollback/replay is
    -- one transaction.
    if not private.jsonb_has_exact_keys(p_command -> 'generatedBlock',array[
      'kind','modelId','promptVersion','cipher','verificationMac'
    ])
      or p_command #>> '{generatedBlock,modelId}' <> job_row.model_id
      or p_command #>> '{generatedBlock,promptVersion}' <> job_row.prompt_version
      or p_command #>> '{generatedBlock,cipher,reservationId}'
        <> preparation.generated_block_reservation_id::text
      or p_command #>> '{generatedBlock,cipher,envelope,context,resourceId}'
        <> preparation.generated_block_id
    then
      raise exception using errcode = '22023', message = 'invalid_provenance';
    end if;
  end if;

  update public.encrypted_organizer_preparations
  set e3_kind = e3_kind_value,e3_command_hash = command_hash_value,
    updated_at = clock_timestamp()
  where job_id = preparation.job_id;

  if e3_kind_value = 'expansion' then
    legacy_command := jsonb_set(
      p_command - 'generatedBlock','{reviewReason}','null'::jsonb,true
    );
  else
    legacy_command := jsonb_set(
      jsonb_set(p_command - 'generatedBlock','{reviewReason}',
        '"planner_ambiguity"'::jsonb,true),
      '{review,type}','"low_confidence"'::jsonb,true
    );
  end if;

  delegated_result := private.commit_encrypted_organizer_job_impl_e2(
    p_job_id,p_lease_token,legacy_command
  );
  if delegated_result ->> 'outcome' not in ('created','appended','review') then
    -- A replan/review-required response published no E3 aggregate.  Burn the
    -- two reservations deliberately preserved while the delegate ran.
    if e3_kind_value = 'expansion' then
      delete from public.content_encryption_verifications
      where user_id = preparation.user_id
        and surface = 'review_item'
        and resource_id = preparation.review_item_id;
      delete from public.review_items
      where user_id = preparation.user_id
        and id = preparation.review_item_id;
      update public.content_key_operation_reservations
      set consumed_by_type = 'encrypted_organizer',
        consumed_by_id = preparation.job_id,
        consumed_at = clock_timestamp()
      where user_id = preparation.user_id
        and reservation_id in (
          e3_review_reservation_id,e3_generated_reservation_id
        )
        and consumed_at is null;
    end if;
    update public.encrypted_organizer_preparations
    set e3_kind = null,e3_command_hash = null,e3_result = null,
      generated_block_reservation_id = case
        when e3_kind_value = 'expansion' then null
        else generated_block_reservation_id end,
      updated_at = clock_timestamp()
    where job_id = preparation.job_id;
    perform private.burn_encrypted_organizer_reservations(
      preparation.job_id,preparation.lease_token
    );
    return delegated_result;
  end if;

  select * into preparation
  from public.encrypted_organizer_preparations
  where job_id = p_job_id
  for update;
  if e3_kind_value = 'expansion' then
    perform private.insert_encrypted_organizer_generated_block(
      preparation,p_command -> 'generatedBlock'
    );
    perform 1 from public.capture_receipts
    where user_id = preparation.user_id
      and capture_id = preparation.capture_id
      and review_item_id = preparation.review_item_id
      and reason_codes = array['expansion_pending']::text[];
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    update public.captures
    set status = 'needs_review',last_error_code = null
    where user_id = preparation.user_id and id = preparation.capture_id;
    update public.content_encryption_rollouts
    set encrypted_object_count = encrypted_object_count + 2,
      verified_object_count = verified_object_count + 2
    where user_id = preparation.user_id;
    perform private.emit_user_event(
      preparation.user_id,'review_item',preparation.review_item_id
    );
    perform private.emit_user_event(
      preparation.user_id,'generated_block',preparation.generated_block_id
    );
    perform private.emit_user_event(
      preparation.user_id,'capture_receipt',preparation.capture_id
    );
    final_result := delegated_result || jsonb_build_object(
      'generatedBlockId',preparation.generated_block_id,
      'reviewItemId',preparation.review_item_id
    );
  else
    -- The decision projection and sealed deferred receipt are produced from
    -- the same validated plan.  Preserve that exact ordered reason list;
    -- replacing it with a duplicate-specific plaintext label would make the
    -- authenticated receipt fail its relational projection check.
    perform private.encrypted_organizer_reason_codes(
      p_command #> '{decision,reasonCodes}'
    );
    select coalesce(array_agg(reason.value order by reason.ordinality),
      array[]::text[])
    into duplicate_reason_codes
    from jsonb_array_elements_text(
      p_command #> '{decision,reasonCodes}'
    ) with ordinality as reason(value,ordinality);
    update public.review_items
    set type = 'duplicate_suggestion'
    where user_id = preparation.user_id
      and id = preparation.review_item_id
      and type = 'low_confidence' and state = 'open';
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    perform 1 from public.capture_receipts
    where user_id = preparation.user_id
      and capture_id = preparation.capture_id
      and reason_codes = duplicate_reason_codes;
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    final_result := delegated_result || jsonb_build_object(
      'reviewItemId',preparation.review_item_id
    );
    perform private.emit_user_event(
      preparation.user_id,'review_item',preparation.review_item_id
    );
  end if;
  update public.encrypted_organizer_preparations
  set e3_result = final_result,updated_at = clock_timestamp()
  where job_id = preparation.job_id and e3_command_hash = command_hash_value;
  return final_result;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

-- Generated-block resolution reuses the E1 encrypted Review claim and
-- reservation machinery.  This sidecar adds the missing immutable block CAS
-- without widening the generic owner-interaction table or its action enum.
create table public.encrypted_generated_block_resolution_claims (
  user_id uuid not null,
  idempotency_key text not null,
  generated_block_id text not null,
  review_item_id text not null,
  note_id text not null,
  resolution text not null check (
    resolution in ('accept_expansion','reject_expansion')
  ),
  expected_state_revision integer not null check (expected_state_revision >= 1),
  block_envelope_digest text not null check (
    block_envelope_digest ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id,idempotency_key),
  foreign key (user_id,idempotency_key)
    references public.encrypted_owner_interaction_claims(user_id,idempotency_key)
    on delete cascade,
  foreign key (generated_block_id)
    references public.generated_blocks(id) on delete cascade,
  foreign key (review_item_id)
    references public.review_items(id) on delete cascade,
  foreign key (note_id)
    references public.notes(id) on delete cascade,
  check (generated_block_id ~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (review_item_id ~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (note_id ~ '^note_[0-9A-HJKMNP-TV-Z]{26}$')
);

alter table public.encrypted_generated_block_resolution_claims
  enable row level security;
alter table public.encrypted_generated_block_resolution_claims
  force row level security;
revoke all on table public.encrypted_generated_block_resolution_claims
  from public,anon,authenticated,service_role;

do $generated_resolution_table_acl$
declare capability_role text;
begin
  foreach capability_role in array array[
    'unfiled_organizer_worker','unfiled_index_worker','unfiled_rag_verifier'
  ] loop
    if exists (select 1 from pg_roles where rolname = capability_role) then
      execute format(
        'revoke all on table public.encrypted_generated_block_resolution_claims from %I',
        capability_role
      );
    end if;
  end loop;
end;
$generated_resolution_table_acl$;

create trigger encrypted_generated_block_resolution_claims_immutable
before update on public.encrypted_generated_block_resolution_claims
for each row execute function private.reject_owner_interaction_update();

create or replace function private.cleanup_generated_block_resolution_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.encrypted_owner_interaction_claims
  where user_id = old.user_id and idempotency_key = old.idempotency_key;
  return null;
end;
$$;

create trigger encrypted_generated_block_resolution_claim_cleanup
after delete on public.encrypted_generated_block_resolution_claims
for each row execute function private.cleanup_generated_block_resolution_claim();

create or replace function private.generated_block_interaction_projection(
  p_owner_id uuid,
  p_block_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'blockId',block.id,
    'noteId',block.note_id,
    'decisionId',block.decision_id,
    'reviewItemId',block.review_item_id,
    'kind',block.kind,
    'state',block.state,
    'stateRevision',block.state_revision,
    'modelId',block.model_id,
    'promptVersion',block.prompt_version,
    'resolvedAt',block.resolved_at,
    'createdAt',block.created_at,
    'contentCipher',private.encrypted_cipher_projection(
      block.content_envelope,block.content_key_id,block.content_key_class,
      block.content_key_purpose,block.content_key_version
    )
  )
  from public.generated_blocks as block
  where block.user_id = p_owner_id and block.id = p_block_id
    and block.content_envelope is not null;
$$;

alter function private.owner_interaction_prepare_projection(
  public.encrypted_owner_interaction_claims,boolean
) rename to owner_interaction_prepare_projection_e2;

create function private.owner_interaction_prepare_projection(
  p_claim public.encrypted_owner_interaction_claims,
  p_replayed boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
  generated_claim public.encrypted_generated_block_resolution_claims%rowtype;
begin
  result_value := private.owner_interaction_prepare_projection_e2(
    p_claim,p_replayed
  );
  select * into generated_claim
  from public.encrypted_generated_block_resolution_claims
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key;
  if not found then return result_value; end if;
  result_value := jsonb_set(
    result_value,'{action}',to_jsonb(generated_claim.resolution),true
  );
  result_value := jsonb_set(
    result_value,'{ids,generatedBlockId}',
    to_jsonb(generated_claim.generated_block_id),true
  );
  result_value := jsonb_set(
    result_value,'{ids,stateRevision}',
    to_jsonb(generated_claim.expected_state_revision),true
  );
  if p_claim.completed_at is null then
    result_value := jsonb_set(
      result_value,'{source,generatedBlock}',
      private.generated_block_interaction_projection(
        p_claim.user_id,generated_claim.generated_block_id
      ),true
    );
  end if;
  return result_value;
end;
$$;

alter function private.owner_interaction_result(
  public.encrypted_owner_interaction_claims,boolean
) rename to owner_interaction_result_e2;

create function private.owner_interaction_result(
  p_claim public.encrypted_owner_interaction_claims,
  p_replayed boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
  generated_claim public.encrypted_generated_block_resolution_claims%rowtype;
begin
  result_value := private.owner_interaction_result_e2(p_claim,p_replayed);
  select * into generated_claim
  from public.encrypted_generated_block_resolution_claims
  where user_id = p_claim.user_id
    and idempotency_key = p_claim.idempotency_key;
  if not found then return result_value; end if;
  return result_value || jsonb_build_object(
    'outcome',case generated_claim.resolution
      when 'accept_expansion' then 'accepted' else 'rejected' end,
    'generatedBlockId',generated_claim.generated_block_id,
    'stateRevision',generated_claim.expected_state_revision + 1,
    'feedbackEventId',p_claim.feedback_event_id
  );
end;
$$;

-- E1 historically treats dismiss/keep_both as metadata-only and therefore
-- does not expect a receipt cipher.  A capture-linked E3 duplicate Review is
-- different: REQ-V1 requires every resolution to terminalize its source
-- capture.  The E3 prepare wrapper below adds a receipt reservation only for
-- that narrow case; make the shared validator derive receipt necessity from
-- the presence of the reservation so all other E1 behavior remains frozen.
do $duplicate_review_receipt_validation$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'private.validate_owner_interaction_command(public.encrypted_owner_interaction_claims,text,jsonb)'::regprocedure
  );
  old_fragment constant text := $old$  receipt_write_required := p_claim.receipt_revision is not null
    and (p_claim.scope <> 'encrypted_review_resolution'
      or p_claim.action in ('route','create','keep_inbox'));$old$;
  new_fragment constant text := $new$  receipt_write_required := p_claim.receipt_revision is not null
    and (p_claim.scope <> 'encrypted_review_resolution'
      or p_claim.action in ('route','create','keep_inbox')
      or exists (
        select 1
        from public.encrypted_owner_interaction_reservations as binding
        where binding.user_id = p_claim.user_id
          and binding.idempotency_key = p_claim.idempotency_key
          and binding.branch = 'common'
          and binding.role = 'receipt'
      ));$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'duplicate_review_receipt_validation_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$duplicate_review_receipt_validation$;

alter function public.prepare_encrypted_review_resolution(
  uuid,text,text,jsonb
) rename to prepare_encrypted_review_resolution_e2;

create function public.prepare_encrypted_review_resolution(
  p_owner_id uuid,
  p_review_item_id text,
  p_idempotency_key text,
  p_resolution jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  generated_claim public.encrypted_generated_block_resolution_claims%rowtype;
  block_row public.generated_blocks%rowtype;
  review_row public.review_items%rowtype;
  capture_row public.captures%rowtype;
  receipt_row public.capture_receipts%rowtype;
  request_key public.user_content_keys%rowtype;
  resolution_value text;
  block_id_value text;
  expected_revision_value integer;
  delegated_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is not null and p_idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key,0
    ));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':content-encryption-rollout',0
    ));
  end if;
  if jsonb_typeof(p_resolution) <> 'object'
    or jsonb_typeof(p_resolution -> 'type') <> 'string'
    or p_resolution ->> 'type' not in (
      'accept_expansion','reject_expansion'
    )
  then
    delegated_result := public.prepare_encrypted_review_resolution_e2(
      p_owner_id,p_review_item_id,p_idempotency_key,p_resolution
    );
    if p_resolution ->> 'type' not in ('keep_both','dismiss') then
      return delegated_result;
    end if;
    select * into claim_row
    from public.encrypted_owner_interaction_claims
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
    for update;
    if not found or claim_row.completed_at is not null
      or claim_row.scope <> 'encrypted_review_resolution'
      or claim_row.review_item_id <> p_review_item_id
      or claim_row.action <> (p_resolution ->> 'type')
    then
      return delegated_result;
    end if;
    select * into review_row
    from public.review_items
    where user_id = p_owner_id and id = p_review_item_id
    for share;
    if not found or review_row.type <> 'duplicate_suggestion'
      or review_row.capture_id is null
    then
      return delegated_result;
    end if;
    select * into receipt_row
    from public.capture_receipts
    where user_id = p_owner_id and capture_id = review_row.capture_id
      and review_item_id = p_review_item_id
    for share;
    if not found or claim_row.capture_id <> receipt_row.capture_id
      or claim_row.receipt_revision <> receipt_row.receipt_revision
      or receipt_row.receipt_envelope is null
    then
      raise exception using errcode = 'P0001', message = 'not_found';
    end if;
    if not exists (
      select 1
      from public.encrypted_owner_interaction_reservations as binding
      where binding.user_id = p_owner_id
        and binding.idempotency_key = p_idempotency_key
        and binding.branch = 'common' and binding.role = 'receipt'
    ) then
      perform private.reserve_owner_interaction_object(
        p_owner_id,p_idempotency_key,'common','receipt','capture_receipt',
        receipt_row.capture_id,receipt_row.receipt_revision + 1,
        receipt_row.receipt_key_class
      );
    end if;
    return private.owner_interaction_prepare_projection(
      claim_row,
      coalesce((delegated_result ->> 'replayed')::boolean,false)
    );
  end if;
  if p_owner_id is null
    or p_review_item_id is null
    or p_review_item_id !~ '^rvw_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or not private.jsonb_has_exact_keys(p_resolution,array[
      'type','generatedBlockId','expectedStateRevision'
    ])
    or jsonb_typeof(p_resolution -> 'generatedBlockId') <> 'string'
    or p_resolution ->> 'generatedBlockId'
      !~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'
    or jsonb_typeof(p_resolution -> 'expectedStateRevision') <> 'number'
    or p_resolution ->> 'expectedStateRevision' !~ '^[1-9][0-9]{0,8}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  resolution_value := p_resolution ->> 'type';
  block_id_value := p_resolution ->> 'generatedBlockId';
  expected_revision_value :=
    (p_resolution ->> 'expectedStateRevision')::integer;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key,0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout',0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('encrypted_only','contracted')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into claim_row
  from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    select * into generated_claim
    from public.encrypted_generated_block_resolution_claims
    where user_id = p_owner_id and idempotency_key = p_idempotency_key;
    if not found
      or claim_row.scope <> 'encrypted_review_resolution'
      or claim_row.review_item_id <> p_review_item_id
      or generated_claim.generated_block_id <> block_id_value
      or generated_claim.expected_state_revision <> expected_revision_value
      or generated_claim.resolution <> resolution_value
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return private.owner_interaction_prepare_projection(claim_row,true);
  end if;
  if exists (
      select 1 from public.api_idempotency_records
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_note_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    ) or exists (
      select 1 from public.encrypted_taxonomy_write_claims
      where user_id = p_owner_id and idempotency_key = p_idempotency_key
    )
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  -- Discover the parent without a row lock, then lock parent note before block
  -- and Review so note-retention cascades cannot invert this transaction.
  select * into block_row from public.generated_blocks
  where user_id = p_owner_id and id = block_id_value;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  perform 1 from public.notes
  where user_id = p_owner_id and id = block_row.note_id
    and deleted_at is null
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  select * into block_row from public.generated_blocks
  where user_id = p_owner_id and id = block_id_value
  for share;
  select * into review_row from public.review_items
  where user_id = p_owner_id and id = p_review_item_id
  for share;
  if block_row.state <> 'proposed'
    or block_row.state_revision <> expected_revision_value
    or block_row.review_item_id <> p_review_item_id
    or block_row.content_envelope is null
    or block_row.content_key_class <> 'ai_assisted'
    or review_row.id is null or review_row.type <> 'pending_expansion'
    or review_row.state <> 'open'
    or review_row.note_id is distinct from block_row.note_id
    or review_row.capture_id is null
    or review_row.review_envelope is null
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into capture_row from public.captures
  where user_id = p_owner_id and id = review_row.capture_id
    and deleted_at is null for share;
  select * into receipt_row from public.capture_receipts
  where user_id = p_owner_id and capture_id = review_row.capture_id
    and review_item_id = p_review_item_id for share;
  if capture_row.id is null or receipt_row.capture_id is null
    or capture_row.content_envelope is null
    or receipt_row.receipt_envelope is null
    or receipt_row.destination_note_id is distinct from block_row.note_id
  then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  request_key := private.owner_interaction_active_key(
    p_owner_id,'ai_assisted','content_mac'
  );
  insert into public.encrypted_owner_interaction_claims (
    user_id,idempotency_key,scope,action,review_item_id,capture_id,
    receipt_revision,review_content_revision,feedback_event_id,
    review_envelope_digest,receipt_envelope_digest,history_key_class,
    request_mac_key_id,request_mac_key_class,request_mac_key_purpose,
    request_mac_key_version
  ) values (
    p_owner_id,p_idempotency_key,'encrypted_review_resolution','keep_inbox',
    p_review_item_id,review_row.capture_id,receipt_row.receipt_revision,
    review_row.review_content_revision,public.new_entity_id('fbk'),
    private.owner_interaction_envelope_digest(review_row.review_envelope),
    private.owner_interaction_envelope_digest(receipt_row.receipt_envelope),
    'ai_assisted',request_key.key_id,request_key.key_class,
    request_key.key_purpose,request_key.key_version
  ) returning * into claim_row;
  insert into public.encrypted_generated_block_resolution_claims (
    user_id,idempotency_key,generated_block_id,review_item_id,note_id,
    resolution,expected_state_revision,block_envelope_digest
  ) values (
    p_owner_id,p_idempotency_key,block_id_value,p_review_item_id,
    block_row.note_id,resolution_value,expected_revision_value,
    private.owner_interaction_envelope_digest(block_row.content_envelope)
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id,p_idempotency_key,'common','response','idempotency_response',
    'idempotency:' || p_idempotency_key,1,'ai_assisted'
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id,p_idempotency_key,'common','review','review_item',
    p_review_item_id,review_row.review_content_revision + 1,'ai_assisted'
  );
  perform private.reserve_owner_interaction_object(
    p_owner_id,p_idempotency_key,'common','receipt','capture_receipt',
    receipt_row.capture_id,receipt_row.receipt_revision + 1,'ai_assisted'
  );
  return private.owner_interaction_prepare_projection(claim_row,false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

-- Keep generated-block claims out of the generic Review commit.  This wrapper
-- preserves every E2 action while forcing expansion accept/reject through the
-- block-CAS resolver below.
alter function public.commit_encrypted_review_resolution(
  uuid,text,text,jsonb
) rename to commit_encrypted_review_resolution_e2;

create function public.commit_encrypted_review_resolution(
  p_owner_id uuid,
  p_review_item_id text,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  review_row public.review_items%rowtype;
  result_value jsonb;
  duplicate_terminalization boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is not null and p_idempotency_key is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key,0
    ));
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':content-encryption-rollout',0
    ));
  end if;
  if exists (
    select 1 from public.encrypted_generated_block_resolution_claims
    where user_id = p_owner_id and idempotency_key = p_idempotency_key
  ) then
    raise exception using errcode = '22023',
      message = 'generated_block_resolver_required';
  end if;
  if p_owner_id is not null and p_review_item_id is not null
    and p_idempotency_key is not null
  then
    select * into claim_row
    from public.encrypted_owner_interaction_claims
    where user_id = p_owner_id and idempotency_key = p_idempotency_key;
    if found and claim_row.completed_at is null
      and claim_row.scope = 'encrypted_review_resolution'
      and claim_row.review_item_id = p_review_item_id
      and claim_row.action in ('keep_both','dismiss')
      and claim_row.capture_id is not null
      and claim_row.receipt_revision is not null
    then
      -- Keep the public E3 wrapper independently compliant with the shared
      -- interaction lock order instead of relying on the delegated E2 body as
      -- an opaque implementation detail: owner advisories, sorted notes, then
      -- Review.  Reacquiring these locks in E2 is transaction-local and safe.
      perform 1 from public.notes as note
      join public.encrypted_owner_interaction_members as member
        on member.user_id = note.user_id and member.note_id = note.id
      where member.user_id = p_owner_id
        and member.idempotency_key = p_idempotency_key
        and member.expected_revision > 0
      order by note.id for update of note;
      select * into review_row
      from public.review_items
      where user_id = p_owner_id and id = p_review_item_id for update;
      duplicate_terminalization := found
        and review_row.type = 'duplicate_suggestion'
        and review_row.state = 'open'
        and review_row.capture_id = claim_row.capture_id;
    end if;
  end if;
  result_value := public.commit_encrypted_review_resolution_e2(
    p_owner_id,p_review_item_id,p_idempotency_key,p_command
  );
  if not duplicate_terminalization then return result_value; end if;

  -- The delegated E2 transaction has authenticated and consumed the added
  -- receipt cipher but intentionally has no dismiss/keep-both receipt branch.
  -- Finish the E3 capture transition before this outer RPC can commit.
  perform private.update_owner_interaction_receipt(
    claim_row,p_command -> 'receipt','kept_in_inbox',null,null,
    p_review_item_id,array['review_resolved']::text[]
  );
  update public.captures
  set status = 'inbox',last_error_code = null
  where user_id = p_owner_id and id = claim_row.capture_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  perform private.emit_user_event(
    p_owner_id,'capture_receipt',claim_row.capture_id
  );
  perform private.emit_user_event(p_owner_id,'capture',claim_row.capture_id);
  return result_value;
end;
$$;

-- `resolved_at` is part of the owner-visible generated-block projection and is
-- sealed into the terminal response at preparation.occurredAt.  Retention
-- needs a different clock: a request may remain prepared for days before its
-- reject CAS commits.  Keep that service-only anchor immutable and start it
-- only on the actual transition to rejected.
alter table public.generated_blocks
  add column rejected_retention_started_at timestamptz;

update public.generated_blocks
set rejected_retention_started_at = coalesce(
  resolved_at,date_trunc('milliseconds',clock_timestamp())
)
where state = 'rejected';

create function private.anchor_rejected_generated_block_retention()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state = 'rejected' then
      new.rejected_retention_started_at := coalesce(
        new.rejected_retention_started_at,new.resolved_at,
        date_trunc('milliseconds',clock_timestamp())
      );
    elsif new.rejected_retention_started_at is not null then
      raise exception using errcode = '23514',
        message = 'invalid_rejected_retention_anchor';
    end if;
    return new;
  end if;

  if old.state <> 'rejected' and new.state = 'rejected' then
    -- Never trust a caller-supplied historical value on a live transition.
    new.rejected_retention_started_at :=
      date_trunc('milliseconds',clock_timestamp());
  elsif old.state = 'rejected' then
    if new.state <> 'rejected'
      or new.rejected_retention_started_at
        is distinct from old.rejected_retention_started_at
    then
      raise exception using errcode = 'P0001',
        message = 'immutable_rejected_retention_anchor';
    end if;
  elsif new.rejected_retention_started_at is not null then
    raise exception using errcode = '23514',
      message = 'invalid_rejected_retention_anchor';
  end if;
  return new;
end;
$$;

create trigger generated_blocks_rejected_retention_anchor
before insert or update of state,resolved_at,rejected_retention_started_at
on public.generated_blocks
for each row execute function
private.anchor_rejected_generated_block_retention();

alter table public.generated_blocks
  add constraint generated_blocks_rejected_retention_anchor_shape check (
    (state = 'rejected' and rejected_retention_started_at is not null)
    or (state <> 'rejected' and rejected_retention_started_at is null)
  );

create function public.resolve_encrypted_generated_block(
  p_owner_id uuid,
  p_generated_block_id text,
  p_expected_state_revision integer,
  p_idempotency_key text,
  p_command jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  claim_row public.encrypted_owner_interaction_claims%rowtype;
  generated_claim public.encrypted_generated_block_resolution_claims%rowtype;
  block_row public.generated_blocks%rowtype;
  review_row public.review_items%rowtype;
  receipt_row public.capture_receipts%rowtype;
  replay_value jsonb;
  ciphers_value jsonb;
  terminal_state public.block_state;
  terminal_review_state public.review_state;
  feedback_action_value public.feedback_action;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generated_block_id is null
    or p_generated_block_id !~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_expected_state_revision is null or p_expected_state_revision < 1
    or p_idempotency_key is null
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
    or jsonb_typeof(p_command) <> 'object'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':encrypted-note-write:' || p_idempotency_key,0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout',0
  ));
  select * into claim_row
  from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  select * into generated_claim
  from public.encrypted_generated_block_resolution_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  if claim_row.user_id is null or generated_claim.user_id is null then
    -- A winning resolver removes every other incomplete claim for its block.
    -- Preserve a deterministic CAS failure for a losing device that submits
    -- after that cleanup instead of making it indistinguishable from a
    -- request that was never prepared.
    if claim_row.user_id is null and generated_claim.user_id is null
      and exists (
        select 1
        from public.generated_blocks as terminal_block
        where terminal_block.user_id = p_owner_id
          and terminal_block.id = p_generated_block_id
          and (
            terminal_block.state <> 'proposed'
            or terminal_block.state_revision <> p_expected_state_revision
          )
      )
    then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;
    raise exception using errcode = 'P0001', message = 'write_not_prepared';
  end if;
  if claim_row.scope <> 'encrypted_review_resolution'
    or generated_claim.generated_block_id <> p_generated_block_id
    or generated_claim.expected_state_revision <> p_expected_state_revision
  then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;

  -- Retention locks parent notes first.  Follow the same order before the
  -- generated child, Review, receipt, and claim rows.
  perform 1 from public.notes
  where user_id = p_owner_id and id = generated_claim.note_id
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;
  select * into block_row from public.generated_blocks
  where user_id = p_owner_id and id = p_generated_block_id
  for update;
  select * into review_row from public.review_items
  where user_id = p_owner_id and id = generated_claim.review_item_id
  for update;
  select * into receipt_row from public.capture_receipts
  where user_id = p_owner_id and capture_id = claim_row.capture_id
  for update;
  select * into claim_row
  from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key
  for update;
  replay_value := private.owner_interaction_replay_result(claim_row,p_command);
  if replay_value is not null then return replay_value; end if;

  if block_row.id is null or block_row.state <> 'proposed'
    or block_row.state_revision <> generated_claim.expected_state_revision
    or block_row.review_item_id <> generated_claim.review_item_id
    or block_row.note_id <> generated_claim.note_id
    or private.owner_interaction_envelope_digest(block_row.content_envelope)
      <> generated_claim.block_envelope_digest
    or review_row.id is null or review_row.type <> 'pending_expansion'
    or review_row.state <> 'open'
    or review_row.review_content_revision <> claim_row.review_content_revision
    or private.owner_interaction_envelope_digest(review_row.review_envelope)
      <> claim_row.review_envelope_digest
    or receipt_row.capture_id is null
    or receipt_row.receipt_revision <> claim_row.receipt_revision
    or private.owner_interaction_envelope_digest(receipt_row.receipt_envelope)
      <> claim_row.receipt_envelope_digest
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  ciphers_value := private.validate_owner_interaction_command(
    claim_row,null,p_command
  );
  perform private.consume_owner_interaction_reservations(
    claim_row,null,ciphers_value
  );
  terminal_state := case generated_claim.resolution
    when 'accept_expansion' then 'accepted'::public.block_state
    else 'rejected'::public.block_state end;
  -- Rejecting generated text resolves the proposal; it does not dismiss the
  -- Review itself.  `dismissed` is reserved for the distinct `{type:dismiss}`
  -- Review action in the frozen shared interaction contract.
  terminal_review_state := 'resolved'::public.review_state;
  feedback_action_value := case generated_claim.resolution
    when 'accept_expansion' then 'expansion_accepted'::public.feedback_action
    else 'expansion_rejected'::public.feedback_action end;

  perform private.write_owner_interaction_review(
    claim_row,p_command -> 'review',terminal_review_state
  );
  update public.generated_blocks
  set state = terminal_state,
    state_revision = state_revision + 1,
    resolved_at = claim_row.occurred_at
  where user_id = p_owner_id and id = p_generated_block_id
    and state = 'proposed'
    and state_revision = p_expected_state_revision;
  if not found then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  -- Multiple devices may prepare the same proposed block with independent
  -- idempotency keys and wraps.  Once the block CAS succeeds, every other
  -- incomplete preparation is irrecoverably stale.  Delete those sidecars
  -- inside the winning transaction; their cleanup trigger deletes the owner
  -- claim, encrypted replay placeholder, reservation bindings, and underlying
  -- unconsumed wrap reservations.  Completed claims are retained so exact
  -- response replay evidence is never discarded.
  delete from public.encrypted_generated_block_resolution_claims as loser
  using public.encrypted_owner_interaction_claims as interaction
  where loser.user_id = p_owner_id
    and loser.generated_block_id = p_generated_block_id
    and loser.idempotency_key <> p_idempotency_key
    and interaction.user_id = loser.user_id
    and interaction.idempotency_key = loser.idempotency_key
    and interaction.completed_at is null;

  perform private.update_owner_interaction_receipt(
    claim_row,p_command -> 'receipt',receipt_row.outcome::text,
    receipt_row.destination_note_id,receipt_row.mutation_id,null,
    array[case generated_claim.resolution
      when 'accept_expansion' then 'expansion_accepted'
      else 'expansion_rejected' end]::text[]
  );
  update public.captures
  set status = 'organized',last_error_code = null
  where user_id = p_owner_id and id = claim_row.capture_id;

  insert into public.feedback_events (
    id,user_id,decision_id,action,old_destination_note_id,
    new_destination_note_id,reason_code,review_item_id,
    generated_block_id,idempotency_key,created_at
  ) values (
    claim_row.feedback_event_id,p_owner_id,block_row.decision_id,
    feedback_action_value,block_row.note_id,block_row.note_id,
    generated_claim.resolution,generated_claim.review_item_id,
    generated_claim.generated_block_id,p_idempotency_key,
    claim_row.occurred_at
  );
  perform private.finish_owner_interaction(
    claim_row,null,p_command -> 'requestMac',p_command -> 'responseCipher',
    p_command -> 'responseVerificationMac',jsonb_array_length(ciphers_value)
  );
  perform private.emit_user_event(
    p_owner_id,'generated_block',p_generated_block_id
  );
  perform private.emit_user_event(
    p_owner_id,'review_item',generated_claim.review_item_id
  );
  perform private.emit_user_event(
    p_owner_id,'capture_receipt',claim_row.capture_id
  );
  perform private.emit_user_event(p_owner_id,'capture',claim_row.capture_id);
  select * into claim_row
  from public.encrypted_owner_interaction_claims
  where user_id = p_owner_id and idempotency_key = p_idempotency_key;
  return private.owner_interaction_result(claim_row,false);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'validation_failed';
end;
$$;

-- A capture deletion removes its capture-linked Review.  PostgreSQL would
-- otherwise apply generated_blocks.review_item_id ON DELETE SET NULL, leaving
-- a proposed ciphertext orphan that cannot be resolved or aged by rejected
-- retention.  Remove only the owner-matched proposed block while the Review
-- binding still exists.  Terminal blocks remain note-owned.
create function private.cleanup_proposed_block_before_review_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  resolution_keys text[];
  resolution_reservations uuid[];
begin
  if tg_op <> 'DELETE' or tg_table_schema <> 'public'
    or tg_table_name <> 'review_items'
  then
    raise exception using errcode = 'P0001',
      message = 'invalid_generated_block_review_cleanup_target';
  end if;
  if old.type <> 'pending_expansion' then return old; end if;

  -- The Review binding constraint normally makes this impossible. Check it
  -- again before any deletion so a privileged cross-owner corruption fails
  -- closed instead of erasing another owner's encrypted evidence.
  if exists (
    select 1 from public.generated_blocks as block
    where block.review_item_id = old.id and block.user_id <> old.user_id
  ) then
    raise exception using errcode = '23514',
      message = 'owner_scope_violation';
  end if;

  for candidate in
    select block.id,block.user_id
    from public.generated_blocks as block
    where block.user_id = old.user_id
      and block.review_item_id = old.id
      and block.state = 'proposed'
    order by block.id
    for update of block
  loop
    if exists (
      select 1
      from public.encrypted_generated_block_resolution_claims as sidecar
      where sidecar.generated_block_id = candidate.id
        and sidecar.user_id <> candidate.user_id
      union all
      select 1
      from public.content_encryption_verifications as verification
      where verification.surface = 'generated_block'
        and verification.resource_id = candidate.id
        and verification.user_id <> candidate.user_id
      union all
      select 1
      from public.feedback_events as feedback
      where feedback.generated_block_id = candidate.id
        and feedback.user_id <> candidate.user_id
      union all
      select 1
      from public.user_events as event_record
      where event_record.entity_id = candidate.id
        and event_record.user_id <> candidate.user_id
    ) then
      raise exception using errcode = '23514',
        message = 'owner_scope_violation';
    end if;

    select coalesce(array_agg(sidecar.idempotency_key order by
      sidecar.idempotency_key),array[]::text[])
    into resolution_keys
    from public.encrypted_generated_block_resolution_claims as sidecar
    where sidecar.user_id = candidate.user_id
      and sidecar.generated_block_id = candidate.id;
    select coalesce(array_agg(binding.reservation_id order by
      binding.reservation_id),array[]::uuid[])
    into resolution_reservations
    from public.encrypted_owner_interaction_reservations as binding
    where binding.user_id = candidate.user_id
      and binding.idempotency_key = any(resolution_keys);

    delete from public.content_encryption_verifications as verification
    where verification.user_id = candidate.user_id
      and verification.surface = 'generated_block'
      and verification.resource_id = candidate.id;
    delete from public.feedback_events as feedback
    where feedback.user_id = candidate.user_id
      and feedback.generated_block_id = candidate.id;
    delete from public.user_events as event_record
    where event_record.user_id = candidate.user_id
      and event_record.entity_id = candidate.id
      and event_record.entity in (
        'generated_block','generated_block_purged'
      );
    delete from public.generated_blocks as block
    where block.user_id = candidate.user_id
      and block.id = candidate.id
      and block.review_item_id = old.id
      and block.state = 'proposed';
    if not found then
      raise exception using errcode = 'P0001', message = 'stale_revision';
    end if;

    if exists (
      select 1 from public.generated_blocks as block
      where block.user_id = candidate.user_id and block.id = candidate.id
      union all
      select 1
      from public.content_encryption_verifications as verification
      where verification.user_id = candidate.user_id
        and verification.surface = 'generated_block'
        and verification.resource_id = candidate.id
      union all
      select 1
      from public.encrypted_generated_block_resolution_claims as sidecar
      where sidecar.user_id = candidate.user_id
        and sidecar.generated_block_id = candidate.id
      union all
      select 1
      from public.encrypted_owner_interaction_claims as interaction
      where interaction.user_id = candidate.user_id
        and interaction.idempotency_key = any(resolution_keys)
      union all
      select 1
      from public.encrypted_owner_interaction_reservations as binding
      where binding.user_id = candidate.user_id
        and binding.idempotency_key = any(resolution_keys)
      union all
      select 1
      from public.api_idempotency_records as response
      where response.user_id = candidate.user_id
        and response.idempotency_key = any(resolution_keys)
      union all
      select 1
      from public.content_key_operation_reservations as reservation
      where reservation.user_id = candidate.user_id
        and reservation.reservation_id = any(resolution_reservations)
      union all
      select 1
      from public.user_events as event_record
      where event_record.user_id = candidate.user_id
        and event_record.entity = 'generated_block'
        and event_record.entity_id = candidate.id
    ) then
      raise exception using errcode = 'P0001',
        message = 'generated_block_cleanup_incomplete';
    end if;
    perform private.emit_user_event(
      candidate.user_id,'generated_block_purged',candidate.id
    );
  end loop;
  return old;
end;
$$;

create trigger generated_block_review_delete_cleanup
before delete on public.review_items
for each row execute function
private.cleanup_proposed_block_before_review_delete();

-- Rejected generated text has a seven-day undo/audit window and then becomes
-- ineligible for storage.  Keep this implementation private and invoke it
-- through the already-reviewed encrypted note-retention batch so E3 does not
-- add a second public retention capability.  Deleting the block cascades its
-- E3 sidecar; the sidecar deletes the E1 claim, whose existing BEFORE DELETE
-- cleanup removes the encrypted replay response and every bound reservation.
create index generated_blocks_rejected_retention
  on public.generated_blocks (rejected_retention_started_at,id)
  include (user_id)
  where state = 'rejected';

create or replace function private.purge_expired_rejected_generated_blocks(
  p_owner_id uuid,
  p_now timestamptz,
  p_batch_size integer,
  p_execute boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  candidate record;
  cutoff_value timestamptz;
  eligible_count integer;
  purged_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_now is null
    or p_now <> date_trunc('milliseconds',p_now)
    or p_batch_size is null or p_batch_size not between 1 and 25
    or p_execute is null
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  cutoff_value := p_now - interval '7 days';

  select count(*)::integer into eligible_count
  from (
    select 1
    from public.generated_blocks as block
    where block.state = 'rejected'
      and block.rejected_retention_started_at <= cutoff_value
      and (p_owner_id is null or block.user_id = p_owner_id)
      and not exists (
        select 1
        from public.encrypted_generated_block_resolution_claims as sidecar
        join public.encrypted_owner_interaction_claims as interaction
          on interaction.user_id = sidecar.user_id
          and interaction.idempotency_key = sidecar.idempotency_key
        where sidecar.generated_block_id = block.id
          and interaction.completed_at is null
      )
    order by block.rejected_retention_started_at,block.id
    limit p_batch_size
  ) as eligible;

  if not p_execute then
    return jsonb_build_object(
      'runAt',p_now,'cutoff',cutoff_value,
      'eligibleCount',eligible_count,'executed',false,'purgedCount',0
    );
  end if;

  for candidate in
    select block.id,block.user_id,block.rejected_retention_started_at
    from public.generated_blocks as block
    where block.state = 'rejected'
      and block.rejected_retention_started_at <= cutoff_value
      and (p_owner_id is null or block.user_id = p_owner_id)
      and not exists (
        select 1
        from public.encrypted_generated_block_resolution_claims as sidecar
        join public.encrypted_owner_interaction_claims as interaction
          on interaction.user_id = sidecar.user_id
          and interaction.idempotency_key = sidecar.idempotency_key
        where sidecar.generated_block_id = block.id
          and interaction.completed_at is null
      )
    order by block.rejected_retention_started_at,block.id
    for update of block skip locked
    limit p_batch_size
  loop
    -- Only the sidecar and feedback evidence receive referential actions from
    -- block deletion.  Fail closed if a privileged write ever crossed owners,
    -- because cleanup must never erase another account's claim or replay.
    if exists (
      select 1
      from public.encrypted_generated_block_resolution_claims as sidecar
      where sidecar.generated_block_id = candidate.id
        and sidecar.user_id <> candidate.user_id
      union all
      select 1
      from public.feedback_events as feedback
      where feedback.generated_block_id = candidate.id
        and feedback.user_id <> candidate.user_id
    ) then
      raise exception using errcode = '23514', message = 'owner_scope_violation';
    end if;

    delete from public.user_events as event_record
    where event_record.user_id = candidate.user_id
      and event_record.entity_id = candidate.id;
    delete from public.generated_blocks as block
    where block.id = candidate.id
      and block.user_id = candidate.user_id
      and block.state = 'rejected'
      and block.rejected_retention_started_at =
        candidate.rejected_retention_started_at
      and block.rejected_retention_started_at <= cutoff_value;
    if found then
      purged_count := purged_count + 1;
      perform private.emit_user_event(
        candidate.user_id,'generated_block_purged',candidate.id
      );
    end if;
  end loop;

  return jsonb_build_object(
    'runAt',p_now,'cutoff',cutoff_value,
    'eligibleCount',eligible_count,'executed',true,
    'purgedCount',purged_count
  );
end;
$$;

-- Extend the daily encrypted-retention batch in place.  The public signature
-- and response remain frozen; the private generated-block result is used only
-- for bounded execution and pgTAP evidence.
do $encrypted_retention_generated_blocks$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.claim_encrypted_note_retention(uuid,uuid,uuid,timestamptz,integer,boolean,integer)'::regprocedure
  );
  old_fragment constant text := $old$  cutoff_value := p_now - interval '30 days';$old$;
  new_fragment constant text := $new$  if not p_execute then
    perform private.purge_expired_rejected_generated_blocks(
      p_owner_id,p_now,p_batch_size,false
    );
  end if;
  cutoff_value := p_now - interval '30 days';$new$;
  replay_anchor constant text := $anchor$  -- Expired capabilities are made non-actionable before selecting new work.$anchor$;
  replay_replacement constant text := $replacement$  -- A repeated run ID is a pure replay and must not consume a second
  -- generated-block batch.  Purge only after the new run row wins its CAS.
  perform private.purge_expired_rejected_generated_blocks(
    p_owner_id,p_now,p_batch_size,true
  );

  -- Expired capabilities are made non-actionable before selecting new work.$replacement$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'encrypted_retention_generated_block_hook_drift';
  end if;
  definition := pg_catalog.replace(definition,old_fragment,new_fragment);
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,replay_anchor,''))
  ) / pg_catalog.length(replay_anchor);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'encrypted_retention_generated_block_replay_drift';
  end if;
  execute pg_catalog.replace(definition,replay_anchor,replay_replacement);
end;
$encrypted_retention_generated_blocks$;

-- Generated-block state and binding are part of every encrypted read
-- projection.  Cipher recordVersion remains 1; stateRevision is a distinct CAS.
do $generated_block_get_projection$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.get_encrypted_generated_blocks(uuid,text[])'::regprocedure
  );
  old_fragment constant text := $old$'state', block.state,
    'modelId', block.model_id,$old$;
  new_fragment constant text := $new$'state', block.state,
    'stateRevision', block.state_revision,
    'reviewItemId', block.review_item_id,
    'modelId', block.model_id,$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'generated_block_get_projection_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$generated_block_get_projection$;

do $generated_block_library_projection$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.list_encrypted_library_objects(uuid,text,text,integer)'::regprocedure
  );
  old_fragment constant text := $old$'kind', block.kind, 'state', block.state, 'modelId', block.model_id,
        'promptVersion', block.prompt_version,$old$;
  new_fragment constant text := $new$'kind', block.kind, 'state', block.state,
        'stateRevision', block.state_revision,
        'reviewItemId', block.review_item_id,
        'modelId', block.model_id,
        'promptVersion', block.prompt_version,$new$;
  occurrence_count integer;
begin
  occurrence_count := (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition,old_fragment,''))
  ) / pg_catalog.length(old_fragment);
  if occurrence_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'generated_block_library_projection_drift';
  end if;
  execute pg_catalog.replace(definition,old_fragment,new_fragment);
end;
$generated_block_library_projection$;

-- The note surface must never discover one note by scanning every encrypted
-- block owned by the account.  Reuse the existing generated-block capability
-- name with an exact note-scoped overload: PostgREST selects this signature by
-- its named arguments, while the original block-ID lookup remains unchanged
-- for atomic resolution.  Block IDs are immutable and globally unique, so the
-- ascending keyset is stable across inserts and avoids offset drift.
create index generated_blocks_visible_note_keyset
  on public.generated_blocks(user_id,note_id,id)
  where state <> 'rejected' and content_envelope is not null;

create function public.get_encrypted_generated_blocks(
  p_owner_id uuid,
  p_note_id text,
  p_after_block_id text default null,
  p_limit integer default 51
)
returns table (
  resource_id text,
  record_version integer,
  operational jsonb,
  content_cipher jsonb,
  content_mac jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_note_id !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    or (
      p_after_block_id is not null
      and p_after_block_id !~ '^blk_[0-9A-HJKMNP-TV-Z]{26}$'
    )
    or p_limit is null
    or p_limit not between 1 and 51
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  return query
  select
    block.id,
    1,
    jsonb_build_object(
      'noteId',block.note_id,
      'decisionId',block.decision_id,
      'reviewItemId',block.review_item_id,
      'kind',block.kind,
      'state',block.state,
      'stateRevision',block.state_revision,
      'modelId',block.model_id,
      'promptVersion',block.prompt_version,
      'resolvedAt',block.resolved_at,
      'createdAt',block.created_at
    ),
    private.encrypted_cipher_projection(
      block.content_envelope,block.content_key_id,block.content_key_class,
      block.content_key_purpose,block.content_key_version
    ),
    null::jsonb
  from public.generated_blocks as block
  where block.user_id = p_owner_id
    and block.note_id = p_note_id
    and block.state <> 'rejected'
    and block.content_envelope is not null
    and (p_after_block_id is null or block.id > p_after_block_id)
  order by block.id
  limit p_limit;
end;
$$;

-- Capability boundary: the organizer retains exactly its ten E2 RPCs.  Only
-- the authenticated web service may prepare or resolve generated-block state.
revoke execute on function public.prepare_encrypted_review_resolution_e2(
  uuid,text,text,jsonb
) from public,anon,authenticated,service_role;
revoke execute on function public.commit_encrypted_review_resolution_e2(
  uuid,text,text,jsonb
) from public,anon,authenticated,service_role;
revoke execute on function public.prepare_encrypted_review_resolution(
  uuid,text,text,jsonb
) from public,anon,authenticated;
revoke execute on function public.commit_encrypted_review_resolution(
  uuid,text,text,jsonb
) from public,anon,authenticated;
revoke execute on function public.resolve_encrypted_generated_block(
  uuid,text,integer,text,jsonb
) from public,anon,authenticated;
revoke execute on function public.get_encrypted_generated_blocks(
  uuid,text,text,integer
) from public,anon,authenticated;

do $generated_block_capability_acl$
declare capability_role text;
begin
  foreach capability_role in array array[
    'unfiled_organizer_worker','unfiled_index_worker','unfiled_rag_verifier'
  ] loop
    if exists (select 1 from pg_roles where rolname = capability_role) then
      execute format(
        'revoke execute on function public.prepare_encrypted_review_resolution_e2(uuid,text,text,jsonb) from %I',
        capability_role
      );
      execute format(
        'revoke execute on function public.commit_encrypted_review_resolution_e2(uuid,text,text,jsonb) from %I',
        capability_role
      );
      execute format(
        'revoke execute on function public.prepare_encrypted_review_resolution(uuid,text,text,jsonb) from %I',
        capability_role
      );
      execute format(
        'revoke execute on function public.commit_encrypted_review_resolution(uuid,text,text,jsonb) from %I',
        capability_role
      );
      execute format(
        'revoke execute on function public.resolve_encrypted_generated_block(uuid,text,integer,text,jsonb) from %I',
        capability_role
      );
      execute format(
        'revoke execute on function public.get_encrypted_generated_blocks(uuid,text,text,integer) from %I',
        capability_role
      );
    end if;
  end loop;
end;
$generated_block_capability_acl$;

grant execute on function public.prepare_encrypted_review_resolution(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.commit_encrypted_review_resolution(
  uuid,text,text,jsonb
) to service_role;
grant execute on function public.resolve_encrypted_generated_block(
  uuid,text,integer,text,jsonb
) to service_role;
grant execute on function public.get_encrypted_generated_blocks(
  uuid,text,text,integer
) to service_role;

-- CREATE OR REPLACE resets neither ownership nor an existing ACL, but newly
-- named/wrapped private functions otherwise receive PostgreSQL's default
-- PUBLIC EXECUTE.  Make the private boundary explicit for every E3 function
-- (and the renamed E2 implementations) that can mutate or project ciphertext.
revoke execute on function private.enforce_organization_job_model_immutable()
  from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.encrypted_organizer_preparation_projection(
  public.encrypted_organizer_preparations,
  public.user_content_keys,
  public.user_content_keys,
  boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.prepare_encrypted_organizer_write_impl(
  text,text,text,text,bigint,text
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.consume_encrypted_organizer_reservation(
  public.encrypted_organizer_preparations,jsonb,uuid,text
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.burn_encrypted_organizer_reservations(
  text,uuid
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.insert_encrypted_organizer_generated_block(
  public.encrypted_organizer_preparations,jsonb
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.commit_encrypted_organizer_job_impl(
  text,text,jsonb
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.cleanup_generated_block_resolution_claim()
  from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.anchor_rejected_generated_block_retention()
  from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.cleanup_proposed_block_before_review_delete()
  from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.generated_block_interaction_projection(
  uuid,text
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.purge_expired_rejected_generated_blocks(
  uuid,timestamptz,integer,boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.owner_interaction_prepare_projection(
  public.encrypted_owner_interaction_claims,boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.owner_interaction_result(
  public.encrypted_owner_interaction_claims,boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;

revoke execute on function private.prepare_encrypted_organizer_write_impl_e2(
  text,text,text,text,bigint,text
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.commit_encrypted_organizer_job_impl_e2(
  text,text,jsonb
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.owner_interaction_prepare_projection_e2(
  public.encrypted_owner_interaction_claims,boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
revoke execute on function private.owner_interaction_result_e2(
  public.encrypted_owner_interaction_claims,boolean
) from public,anon,authenticated,service_role,
    unfiled_organizer_worker,unfiled_index_worker,unfiled_rag_verifier;
