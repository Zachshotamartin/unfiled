-- Capture attachments: photos and voice recordings sealed beside the capture
-- they belong to, under the capture's key class. Bytes travel as a raw binary
-- upload before the capture exists, so an attachment is created unbound with
-- the client's capture id and bound when that capture is created. Reads and
-- writes go through service-role RPCs only; no role can touch the table.

create table public.capture_attachments (
  id text primary key check (id ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  capture_id text not null check (capture_id ~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text not null check (kind in ('image', 'audio')),
  media_type text not null check (media_type in ('image/jpeg', 'audio/mp4')),
  byte_length integer not null check (byte_length between 1 and 700000),
  width integer check (width between 1 and 8000),
  height integer check (height between 1 and 8000),
  duration_ms integer check (duration_ms between 1 and 120000),
  privacy public.privacy_mode not null,
  content_envelope jsonb not null,
  content_key_id text not null,
  content_key_class public.content_key_class not null,
  content_key_purpose public.content_key_purpose not null,
  content_key_version integer not null,
  content_mac text not null,
  mac_key_id text not null,
  mac_key_class public.content_key_class not null,
  mac_key_purpose public.content_key_purpose not null,
  mac_key_version integer not null,
  bound_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint capture_attachments_kind_shape check (
    (
      kind = 'image' and media_type = 'image/jpeg'
      and width is not null and height is not null and duration_ms is null
    ) or (
      kind = 'audio' and media_type = 'audio/mp4'
      and duration_ms is not null and width is null and height is null
    )
  ),
  constraint capture_attachments_envelope_shape check (
    private.valid_content_envelope(
      content_envelope, user_id, id, 1, 'capture_attachment', content_key_id
    )
    and content_key_class::text = privacy::text
    and content_key_purpose = 'object_wrap'
    and content_key_version >= 1
  ),
  constraint capture_attachments_mac_shape check (
    private.valid_keyed_mac_field(
      content_mac, mac_key_id, mac_key_class, mac_key_purpose, mac_key_version
    )
    and mac_key_class::text = privacy::text
  ),
  constraint capture_attachments_content_key_fkey foreign key (
    user_id, content_key_id, content_key_class,
    content_key_purpose, content_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  constraint capture_attachments_mac_key_fkey foreign key (
    user_id, mac_key_id, mac_key_class, mac_key_purpose, mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);

-- Ciphertext does not compress; skip the attempt Postgres makes on large jsonb.
alter table public.capture_attachments
  alter column content_envelope set storage external;

create index capture_attachments_capture_idx
  on public.capture_attachments (user_id, capture_id)
  where deleted_at is null;
create index capture_attachments_unbound_idx
  on public.capture_attachments (created_at)
  where bound_at is null and deleted_at is null;

alter table public.capture_attachments enable row level security;
revoke all on table public.capture_attachments
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;

-- The reservation consumer and the verification recorder each carry a closed
-- list of surfaces. Extend both in place, the way the storage contraction patch
-- extends preserved definitions, and refuse to run if the lists moved.
do $capture_attachment_surface_patch$
declare
  consumer_definition text := pg_catalog.pg_get_functiondef(
    'private.consume_content_key_reservations(uuid,jsonb,text,text)'::regprocedure
  );
  verification_definition text := pg_catalog.pg_get_functiondef(
    'private.record_content_encryption_verification(uuid,text,text,integer,jsonb,jsonb)'::regprocedure
  );
  consumer_anchor constant text :=
    '''encrypted_capture_command'', ''encrypted_taxonomy_command''';
  verification_anchor constant text :=
    '''idempotency_response'', ''capture_receipt'', ''capture''';
begin
  if (pg_catalog.length(consumer_definition)
      - pg_catalog.length(pg_catalog.replace(consumer_definition, consumer_anchor, '')))
      / pg_catalog.length(consumer_anchor) <> 1
  then
    raise exception 'consume_content_key_reservations consumer list moved';
  end if;
  if (pg_catalog.length(verification_definition)
      - pg_catalog.length(pg_catalog.replace(verification_definition, verification_anchor, '')))
      / pg_catalog.length(verification_anchor) <> 1
  then
    raise exception 'record_content_encryption_verification surface list moved';
  end if;
  execute pg_catalog.replace(
    consumer_definition, consumer_anchor,
    consumer_anchor || ', ''capture_attachment'''
  );
  execute pg_catalog.replace(
    verification_definition, verification_anchor,
    verification_anchor || ', ''capture_attachment'''
  );
end
$capture_attachment_surface_patch$;

alter table public.content_encryption_verifications
  drop constraint content_encryption_verifications_surface_check,
  add constraint content_encryption_verifications_surface_check check (
    surface in (
      'space_display', 'tag_display', 'note_content', 'note_revision',
      'organization_decision', 'note_mutation', 'generated_block',
      'review_item', 'routing_rule', 'organization_mutation_attempt',
      'idempotency_response', 'capture_receipt', 'capture',
      'capture_attachment'
    )
  );

create function private.capture_attachment_projection(
  attachment_row public.capture_attachments
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'attachmentId', attachment_row.id,
    'captureId', attachment_row.capture_id,
    'kind', attachment_row.kind,
    'mediaType', attachment_row.media_type,
    'byteLength', attachment_row.byte_length,
    'width', attachment_row.width,
    'height', attachment_row.height,
    'durationMs', attachment_row.duration_ms,
    'privacy', attachment_row.privacy,
    'boundAt', attachment_row.bound_at,
    'createdAt', attachment_row.created_at,
    'contentCipher', private.encrypted_cipher_projection(
      attachment_row.content_envelope, attachment_row.content_key_id,
      attachment_row.content_key_class, attachment_row.content_key_purpose,
      attachment_row.content_key_version
    ),
    'contentMac', private.encrypted_mac_projection(
      attachment_row.content_mac, attachment_row.mac_key_id,
      attachment_row.mac_key_class, attachment_row.mac_key_purpose,
      attachment_row.mac_key_version
    )
  );
$$;

create function public.create_encrypted_capture_attachment(
  p_owner_id uuid,
  p_attachment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment_id_value text;
  capture_id_value text;
  kind_value text;
  media_type_value text;
  byte_length_value integer;
  width_value integer;
  height_value integer;
  duration_value integer;
  privacy_value public.privacy_mode;
  content_cipher jsonb;
  content_mac jsonb;
  attachment_row public.capture_attachments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_attachment is null
    or jsonb_typeof(p_attachment) <> 'object'
    or p_attachment - array[
      'attachmentId', 'captureId', 'kind', 'mediaType', 'byteLength',
      'width', 'height', 'durationMs', 'privacy', 'contentCipher', 'contentMac'
    ] <> '{}'::jsonb
    or not p_attachment ?& array[
      'attachmentId', 'captureId', 'kind', 'mediaType', 'byteLength',
      'width', 'height', 'durationMs', 'privacy', 'contentCipher', 'contentMac'
    ]
    or jsonb_typeof(p_attachment -> 'byteLength') <> 'number'
    or jsonb_typeof(p_attachment -> 'width') not in ('number', 'null')
    or jsonb_typeof(p_attachment -> 'height') not in ('number', 'null')
    or jsonb_typeof(p_attachment -> 'durationMs') not in ('number', 'null')
  then
    raise exception using errcode = '22023', message = 'invalid_attachment';
  end if;
  begin
    privacy_value := (p_attachment ->> 'privacy')::public.privacy_mode;
    byte_length_value := (p_attachment ->> 'byteLength')::integer;
    width_value := (p_attachment ->> 'width')::integer;
    height_value := (p_attachment ->> 'height')::integer;
    duration_value := (p_attachment ->> 'durationMs')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'invalid_attachment';
  end;
  attachment_id_value := p_attachment ->> 'attachmentId';
  capture_id_value := p_attachment ->> 'captureId';
  kind_value := p_attachment ->> 'kind';
  media_type_value := p_attachment ->> 'mediaType';
  content_cipher := p_attachment -> 'contentCipher';
  content_mac := p_attachment -> 'contentMac';
  if attachment_id_value !~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'
    or capture_id_value !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$'
    or kind_value not in ('image', 'audio')
    or media_type_value not in ('image/jpeg', 'audio/mp4')
    or byte_length_value not between 1 and 700000
    or not (
      (kind_value = 'image' and media_type_value = 'image/jpeg'
        and width_value between 1 and 8000 and height_value between 1 and 8000
        and duration_value is null)
      or (kind_value = 'audio' and media_type_value = 'audio/mp4'
        and duration_value between 1 and 120000
        and width_value is null and height_value is null)
    )
  then
    raise exception using errcode = '22023', message = 'invalid_attachment';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  if not exists (
    select 1 from public.content_encryption_rollouts
    where user_id = p_owner_id and state in ('dual_write', 'encrypted_read')
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_rollout_state';
  end if;

  select * into attachment_row
  from public.capture_attachments
  where id = attachment_id_value
  for update;
  if found then
    if attachment_row.user_id <> p_owner_id
      or attachment_row.deleted_at is not null
      or attachment_row.capture_id <> capture_id_value
      or attachment_row.kind <> kind_value
      or attachment_row.media_type <> media_type_value
      or attachment_row.byte_length <> byte_length_value
      or attachment_row.width is distinct from width_value
      or attachment_row.height is distinct from height_value
      or attachment_row.duration_ms is distinct from duration_value
      or attachment_row.privacy <> privacy_value
      or attachment_row.content_mac <> content_mac ->> 'mac'
      or attachment_row.mac_key_id <> content_mac ->> 'keyId'
      or not private.valid_encrypted_write_mac(
        content_mac, p_owner_id, privacy_value::text::public.content_key_class,
        true
      )
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return jsonb_build_object(
      'attachmentId', attachment_id_value,
      'createdAt', attachment_row.created_at,
      'replayed', true
    );
  end if;

  if not private.valid_encrypted_write_cipher(
      content_cipher, p_owner_id, attachment_id_value, 1, 'capture_attachment',
      privacy_value::text::public.content_key_class
    )
    or not private.valid_encrypted_write_mac(
      content_mac, p_owner_id, privacy_value::text::public.content_key_class,
      false
    )
  then
    raise exception using errcode = '22023', message = 'invalid_encrypted_field';
  end if;
  perform private.consume_content_key_reservations(
    p_owner_id, jsonb_build_array(content_cipher), 'capture_attachment',
    attachment_id_value
  );

  insert into public.capture_attachments (
    id, user_id, capture_id, kind, media_type, byte_length, width, height,
    duration_ms, privacy, content_envelope, content_key_id, content_key_class,
    content_key_purpose, content_key_version, content_mac, mac_key_id,
    mac_key_class, mac_key_purpose, mac_key_version
  ) values (
    attachment_id_value, p_owner_id, capture_id_value, kind_value,
    media_type_value, byte_length_value, width_value, height_value,
    duration_value, privacy_value, content_cipher -> 'envelope',
    content_cipher ->> 'keyId',
    (content_cipher ->> 'keyClass')::public.content_key_class,
    (content_cipher ->> 'keyPurpose')::public.content_key_purpose,
    (content_cipher ->> 'keyVersion')::integer,
    content_mac ->> 'mac', content_mac ->> 'keyId',
    (content_mac ->> 'keyClass')::public.content_key_class,
    (content_mac ->> 'keyPurpose')::public.content_key_purpose,
    (content_mac ->> 'keyVersion')::integer
  ) returning * into attachment_row;
  perform private.record_content_encryption_verification(
    p_owner_id, 'capture_attachment', attachment_id_value, 1,
    content_cipher -> 'envelope', content_mac
  );
  update public.content_encryption_rollouts
  set
    encrypted_object_count = encrypted_object_count + 1,
    verified_object_count = verified_object_count + 1
  where user_id = p_owner_id;
  return jsonb_build_object(
    'attachmentId', attachment_id_value,
    'createdAt', attachment_row.created_at,
    'replayed', false
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception using errcode = '22023', message = 'invalid_attachment';
end;
$$;

create function public.get_encrypted_capture_attachment(
  p_owner_id uuid,
  p_attachment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  attachment_row public.capture_attachments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_attachment_id !~ '^att_[0-9A-HJKMNP-TV-Z]{26}$' then
    raise exception using errcode = '22023', message = 'invalid_attachment';
  end if;
  select * into attachment_row
  from public.capture_attachments
  where user_id = p_owner_id and id = p_attachment_id and deleted_at is null;
  if not found then
    return null;
  end if;
  return private.capture_attachment_projection(attachment_row);
end;
$$;

create function public.list_encrypted_capture_attachments(
  p_owner_id uuid,
  p_capture_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_capture_id !~ '^cap_[0-9A-HJKMNP-TV-Z]{26}$' then
    raise exception using errcode = '22023', message = 'invalid_attachment';
  end if;
  return coalesce((
    select jsonb_agg(
      private.capture_attachment_projection(attachment_row)
      order by attachment_row.created_at, attachment_row.id
    )
    from public.capture_attachments as attachment_row
    where attachment_row.user_id = p_owner_id
      and attachment_row.capture_id = p_capture_id
      and attachment_row.bound_at is not null
      and attachment_row.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

-- Binds the attachments a capture names. Every id must be the owner's, carry
-- this capture id, be unbound and undeleted, share the capture's privacy, and
-- together hold at most four photos and one recording. On replay the stored
-- set must be exactly the set named again.
create function private.bind_capture_attachments(
  p_owner_id uuid,
  p_capture_id text,
  p_privacy public.privacy_mode,
  p_attachment_ids jsonb,
  p_replayed boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text[];
  stored text[];
  image_count integer;
  audio_count integer;
  bound_count integer;
begin
  if p_attachment_ids is null or jsonb_typeof(p_attachment_ids) = 'null' then
    requested := '{}'::text[];
  elsif jsonb_typeof(p_attachment_ids) <> 'array'
    or jsonb_array_length(p_attachment_ids) > 5
    or exists (
      select 1 from jsonb_array_elements(p_attachment_ids) as entry(item)
      where jsonb_typeof(item) <> 'string'
        or (item #>> '{}') !~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  else
    requested := array(
      select entry.item #>> '{}'
      from jsonb_array_elements(p_attachment_ids) as entry(item)
      order by 1
    );
    if cardinality(requested) <> cardinality(array(select distinct unnest(requested))) then
      raise exception using errcode = '22023', message = 'invalid_capture';
    end if;
  end if;

  if p_replayed then
    stored := array(
      select id from public.capture_attachments
      where user_id = p_owner_id and capture_id = p_capture_id
        and bound_at is not null and deleted_at is null
      order by id
    );
    if stored <> requested then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return;
  end if;
  if cardinality(requested) = 0 then
    return;
  end if;

  perform 1 from public.capture_attachments
  where user_id = p_owner_id and id = any(requested)
  for update;
  select
    count(*) filter (where kind = 'image'),
    count(*) filter (where kind = 'audio'),
    count(*)
  into image_count, audio_count, bound_count
  from public.capture_attachments
  where user_id = p_owner_id
    and id = any(requested)
    and capture_id = p_capture_id
    and privacy = p_privacy
    and bound_at is null
    and deleted_at is null;
  if bound_count <> cardinality(requested) then
    raise exception using errcode = '42501', message = 'attachment_not_owned';
  end if;
  if image_count > 4 or audio_count > 1 then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  update public.capture_attachments
  set bound_at = clock_timestamp()
  where user_id = p_owner_id and id = any(requested);
end;
$$;

-- Uploads that never became part of a capture are removed after a day.
create function private.sweep_unbound_capture_attachments(
  p_older_than interval default interval '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.capture_attachments
  where bound_at is null
    and created_at < clock_timestamp() - p_older_than;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- The public capture RPC accepts attachmentIds and binds them atomically with
-- the capture. Everything else is the E2 wrapper unchanged.
create or replace function public.create_encrypted_capture_with_job(
  p_owner_id uuid,
  p_capture jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
  match_value jsonb;
  stored_match jsonb;
  job_id_value text;
  replayed_value boolean;
  explicit_destination_value text;
  occurred_value timestamptz;
  snapshot_found boolean := false;
  attachment_ids_value jsonb;
  privacy_value public.privacy_mode;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_capture is null or jsonb_typeof(p_capture) <> 'object'
    or not p_capture ? 'routingRuleMatch'
    or p_capture - array[
      'clientCaptureId','jobId','occurredAt','contentCipher','contentMac',
      'contentLength','source','deviceId','clientCreatedAt','clientTimezone',
      'privacy','explicitDestinationNoteId','expansionDisabled',
      'privateReceiptCipher','privateReceiptVerificationMac','routingRuleMatch',
      'attachmentIds'
    ] <> '{}'::jsonb
    or jsonb_typeof(p_capture -> 'routingRuleMatch') not in ('null','object')
    or jsonb_typeof(coalesce(p_capture -> 'attachmentIds', 'null'::jsonb))
      not in ('null','array')
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;
  attachment_ids_value := coalesce(p_capture -> 'attachmentIds', 'null'::jsonb);
  begin
    privacy_value := (p_capture ->> 'privacy')::public.privacy_mode;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end;
  match_value := p_capture -> 'routingRuleMatch';
  explicit_destination_value := nullif(
    p_capture ->> 'explicitDestinationNoteId',''
  );
  if (jsonb_typeof(match_value) = 'object' and (
      not private.valid_capture_routing_rule_match(match_value)
      or p_capture ->> 'privacy' <> 'ai_assisted'
      or explicit_destination_value is not null
    )) or (
      explicit_destination_value is not null
      and jsonb_typeof(match_value) <> 'null'
    )
  then
    raise exception using errcode = '22023', message = 'invalid_capture';
  end if;

  result_value := private.create_encrypted_capture_with_job_e1(
    p_owner_id,p_capture - 'routingRuleMatch' - 'attachmentIds'
  );
  job_id_value := result_value ->> 'jobId';
  replayed_value := (result_value ->> 'replayed')::boolean;

  if replayed_value then
    select jsonb_build_object(
      'ruleId',rule_id,'ruleRevision',rule_revision,
      'destinationKind',destination_kind,'destinationId',destination_id,
      'priority',priority,'matched',matched
    ) into stored_match
    from public.organization_job_rule_matches
    where job_id = job_id_value and user_id = p_owner_id;
    snapshot_found := found;
    if (jsonb_typeof(match_value) = 'null' and snapshot_found)
      or (jsonb_typeof(match_value) = 'object' and (
        not snapshot_found or stored_match is distinct from match_value
      ))
    then
      raise exception using errcode = 'P0001',
        message = 'invalid_idempotency_key';
    end if;
    perform private.bind_capture_attachments(
      p_owner_id, p_capture ->> 'clientCaptureId', privacy_value,
      attachment_ids_value, true
    );
    return result_value;
  end if;

  if explicit_destination_value is not null and not exists (
    select 1 from public.notes
    where user_id = p_owner_id and id = explicit_destination_value
      and deleted_at is null and archived_at is null
  ) then
    raise exception using errcode = '42501',
      message = 'explicit_destination_not_owned';
  end if;
  if jsonb_typeof(match_value) = 'object' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      p_owner_id::text || ':encrypted-routing-rules',0
    ));
    insert into public.organization_job_rule_matches (
      job_id,user_id,rule_id,rule_revision,destination_kind,
      destination_id,priority,matched
    ) values (
      job_id_value,p_owner_id,match_value ->> 'ruleId',
      (match_value ->> 'ruleRevision')::integer,
      match_value ->> 'destinationKind',match_value ->> 'destinationId',
      (match_value ->> 'priority')::integer,true
    );
    occurred_value := (p_capture ->> 'occurredAt')::timestamptz;
    update public.routing_rules
    set last_fired_at = greatest(
      coalesce(last_fired_at,occurred_value),occurred_value
    )
    where user_id = p_owner_id and id = match_value ->> 'ruleId';
  end if;
  perform private.bind_capture_attachments(
    p_owner_id, p_capture ->> 'clientCaptureId', privacy_value,
    attachment_ids_value, false
  );
  return result_value;
exception when invalid_text_representation or datetime_field_overflow
  or numeric_value_out_of_range
then
  raise exception using errcode = '22023', message = 'invalid_capture';
end;
$$;

revoke execute on function private.capture_attachment_projection(
  public.capture_attachments
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.bind_capture_attachments(
  uuid, text, public.privacy_mode, jsonb, boolean
) from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function private.sweep_unbound_capture_attachments(interval)
from public, anon, authenticated, service_role, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.create_encrypted_capture_attachment(uuid, jsonb)
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.get_encrypted_capture_attachment(uuid, text)
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
revoke execute on function public.list_encrypted_capture_attachments(uuid, text)
from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker;
grant execute on function public.create_encrypted_capture_attachment(uuid, jsonb)
to service_role;
grant execute on function public.get_encrypted_capture_attachment(uuid, text)
to service_role;
grant execute on function public.list_encrypted_capture_attachments(uuid, text)
to service_role;

-- The reservation table's own list of consumers must admit the new surface too.
alter table public.content_key_operation_reservations
  drop constraint content_key_operation_reservations_consumed_by_type_check,
  add constraint content_key_operation_reservations_consumed_by_type_check check (
    consumed_by_type is null
    or consumed_by_type in (
      'capture', 'capture_reseal', 'encrypted_note_create',
      'encrypted_note_mutation', 'library_backfill', 'note_rag_index',
      'encrypted_organizer', 'encrypted_capture_command',
      'encrypted_taxonomy_command', 'encrypted_note_retention',
      'encrypted_owner_interaction', 'encrypted_routing_rule_command',
      'capture_attachment'
    )
  );
