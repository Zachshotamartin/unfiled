-- Milestone G private beta: provider-neutral V2 managed-key records backed by
-- explicitly selected Vercel Sensitive Environment Variables.
--
-- AWS KMS ManagedKeyRecordV1 rows and RPC signatures remain unchanged. V2
-- does not place provider-neutral root identifiers in AWS-named columns and
-- cannot be mistaken for managed KMS custody.

alter table public.user_content_keys
  add column custody_provider text not null default 'aws_kms_v1',
  add column root_key_id text,
  add column previous_root_key_id text,
  add column wrap_algorithm text;

alter table public.user_content_keys
  alter column kms_key_id drop not null;

-- Replace the original AWS-only checks by definition rather than relying on
-- PostgreSQL's generated names for unnamed table constraints.
do $drop_aws_only_key_checks$
declare
  constraint_row record;
begin
  for constraint_row in
    select constraint_value.conname
    from pg_catalog.pg_constraint as constraint_value
    where constraint_value.conrelid = 'public.user_content_keys'::regclass
      and constraint_value.contype = 'c'
      and (
        pg_catalog.pg_get_constraintdef(constraint_value.oid) like '%schema_version%'
        or pg_catalog.pg_get_constraintdef(constraint_value.oid) like '%kms_key_id%'
        or pg_catalog.pg_get_constraintdef(constraint_value.oid) like '%root_rewrap_count%'
      )
  loop
    execute format(
      'alter table public.user_content_keys drop constraint %I',
      constraint_row.conname
    );
  end loop;
end;
$drop_aws_only_key_checks$;

alter table public.user_content_keys
  add constraint user_content_keys_root_rewrap_count_check check (
    root_rewrap_count between 0 and 1000000
  ),
  add constraint user_content_keys_custody_shape_check check (
    (
      schema_version = 1
      and custody_provider = 'aws_kms_v1'
      and kms_key_id is not null
      and char_length(kms_key_id) between 20 and 2048
      and kms_key_id
        ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
      and root_key_id is null
      and previous_root_key_id is null
      and wrap_algorithm is null
      and (
        previous_kms_key_id is null
        or (
          char_length(previous_kms_key_id) between 20 and 2048
          and previous_kms_key_id
            ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
        )
      )
    )
    or (
      schema_version = 2
      and custody_provider = 'vercel_sensitive_environment_v1'
      and kms_key_id is null
      and previous_kms_key_id is null
      and root_key_id
        ~ '^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (
        previous_root_key_id is null
        or (
          previous_root_key_id
            ~ '^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and split_part(previous_root_key_id, ':', 5) = split_part(root_key_id, ':', 5)
        )
      )
      and wrap_algorithm = 'AES-256-GCM'
      and octet_length(wrapped_intermediate_key) = 65
      and substring(wrapped_intermediate_key from 1 for 5) = decode('5546454b01', 'hex')
    )
  ),
  add constraint user_content_keys_root_rewrap_audit_check check (
    (
      root_rewrap_count = 0
      and previous_kms_key_id is null
      and previous_root_key_id is null
      and last_root_rewrapped_at is null
    )
    or (
      root_rewrap_count > 0
      and last_root_rewrapped_at is not null
      and (
        (schema_version = 1 and previous_kms_key_id is not null
          and previous_root_key_id is null)
        or (schema_version = 2 and previous_kms_key_id is null
          and previous_root_key_id is not null)
      )
    )
  );

comment on column public.user_content_keys.custody_provider is
  'Versioned custody implementation; aws_kms_v1 for V1 or vercel_sensitive_environment_v1 for V2.';
comment on column public.user_content_keys.root_key_id is
  'Provider-neutral V2 wrapping-root identifier; never an AWS ARN surrogate.';
comment on column public.user_content_keys.previous_root_key_id is
  'Provider-neutral V2 predecessor root recorded by an atomic root rewrap.';
comment on column public.user_content_keys.wrap_algorithm is
  'V2 envelope algorithm; currently the exact AES-256-GCM contract.';

create or replace function private.enforce_content_key_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_root_identifier text;
  new_root_identifier text;
  old_previous_root_identifier text;
  new_previous_root_identifier text;
  root_identifier_changed boolean;
  wrapped_material_changed boolean;
  root_audit_changed boolean;
begin
  if row(
    new.user_id, new.key_id, new.key_class, new.key_purpose, new.key_version,
    new.schema_version, new.custody_provider, new.predecessor_key_id,
    new.created_at, new.wrap_operation_limit, new.wrap_algorithm
  ) is distinct from row(
    old.user_id, old.key_id, old.key_class, old.key_purpose, old.key_version,
    old.schema_version, old.custody_provider, old.predecessor_key_id,
    old.created_at, old.wrap_operation_limit, old.wrap_algorithm
  ) then
    raise exception using errcode = '23514', message = 'immutable_content_key_identity';
  end if;

  if (old.activated_at is not null and new.activated_at is distinct from old.activated_at)
    or (old.retired_at is not null and new.retired_at is distinct from old.retired_at)
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
  then
    raise exception using
      errcode = '23514', message = 'immutable_content_key_lifecycle_timestamp';
  end if;

  if (old.activated_at is null and new.activated_at is not null
      and not (old.state = 'pending' and new.state = 'active'))
    or (old.retired_at is null and new.retired_at is not null
      and not (old.state = 'active' and new.state = 'retired'))
    or (old.revoked_at is null and new.revoked_at is not null
      and new.state <> 'revoked')
  then
    raise exception using
      errcode = '23514', message = 'invalid_content_key_lifecycle_timestamp';
  end if;

  if (old.state = 'pending' and new.state not in ('pending', 'active', 'revoked'))
    or (old.state = 'active' and new.state not in ('active', 'retired', 'revoked'))
    or (old.state = 'retired' and new.state not in ('retired', 'revoked'))
    or (old.state = 'revoked' and new.state <> 'revoked')
  then
    raise exception using errcode = '23514', message = 'invalid_content_key_transition';
  end if;

  if new.wrap_operations < old.wrap_operations then
    raise exception using errcode = '23514', message = 'content_key_counter_regression';
  end if;

  if old.schema_version = 1 then
    old_root_identifier := old.kms_key_id;
    new_root_identifier := new.kms_key_id;
    old_previous_root_identifier := old.previous_kms_key_id;
    new_previous_root_identifier := new.previous_kms_key_id;
  else
    old_root_identifier := old.root_key_id;
    new_root_identifier := new.root_key_id;
    old_previous_root_identifier := old.previous_root_key_id;
    new_previous_root_identifier := new.previous_root_key_id;
  end if;

  root_identifier_changed := new_root_identifier is distinct from old_root_identifier;
  wrapped_material_changed :=
    new.wrapped_intermediate_key is distinct from old.wrapped_intermediate_key;
  root_audit_changed := row(
    new_previous_root_identifier, new.root_rewrap_count, new.last_root_rewrapped_at
  ) is distinct from row(
    old_previous_root_identifier, old.root_rewrap_count, old.last_root_rewrapped_at
  );

  if root_identifier_changed or wrapped_material_changed then
    if not root_identifier_changed
      or not wrapped_material_changed
      or old.state = 'revoked'
      or new.state <> old.state
      or new.activated_at is distinct from old.activated_at
      or new.retired_at is distinct from old.retired_at
      or new.revoked_at is distinct from old.revoked_at
      or new.wrap_operations <> old.wrap_operations
      or new_previous_root_identifier is distinct from old_root_identifier
      or new.root_rewrap_count <> old.root_rewrap_count + 1
      or new.last_root_rewrapped_at is null
      or new.last_root_rewrapped_at < greatest(
        old.created_at,
        coalesce(old.activated_at, old.created_at),
        coalesce(old.retired_at, old.created_at),
        coalesce(old.last_root_rewrapped_at, old.created_at)
      )
    then
      raise exception using errcode = '23514', message = 'invalid_content_key_root_rewrap';
    end if;
  elsif root_audit_changed then
    raise exception using errcode = '23514', message = 'invalid_content_key_root_rewrap';
  end if;

  return new;
end;
$$;

-- Every service lookup continues through this single discriminator. The V1
-- branch is intentionally identical to the pre-migration wire record.
create or replace function private.content_key_service_projection(
  key_value public.user_content_keys
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case key_value.schema_version
    when 1 then jsonb_build_object(
      'ownerId', key_value.user_id,
      'keyId', key_value.key_id,
      'keyClass', key_value.key_class,
      'purpose', key_value.key_purpose,
      'keyVersion', key_value.key_version,
      'schemaVersion', key_value.schema_version,
      'status', key_value.state,
      'encryptedKeyMaterial', translate(
        replace(encode(key_value.wrapped_intermediate_key, 'base64'), E'\n', ''),
        '+/=', '-_'
      ),
      'rootKeyArn', key_value.kms_key_id,
      'createdAt', to_char(
        key_value.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'activatedAt', case when key_value.activated_at is null then null else
        to_char(
          key_value.activated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'retiredAt', case when key_value.retired_at is null then null else
        to_char(
          key_value.retired_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'revokedAt', case when key_value.revoked_at is null then null else
        to_char(
          key_value.revoked_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'wrapOperations', key_value.wrap_operations,
      'wrapOperationLimit', key_value.wrap_operation_limit,
      'rotation', jsonb_build_object(
        'predecessorKeyId', key_value.predecessor_key_id,
        'previousRootKeyArn', key_value.previous_kms_key_id,
        'rootRewrapCount', key_value.root_rewrap_count,
        'lastRootRewrappedAt', case
          when key_value.last_root_rewrapped_at is null then null else to_char(
            key_value.last_root_rewrapped_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) end
      )
    )
    when 2 then jsonb_build_object(
      'ownerId', key_value.user_id,
      'keyId', key_value.key_id,
      'keyClass', key_value.key_class,
      'purpose', key_value.key_purpose,
      'keyVersion', key_value.key_version,
      'schemaVersion', key_value.schema_version,
      'custodyProvider', key_value.custody_provider,
      'status', key_value.state,
      'encryptedKeyMaterial', translate(
        replace(encode(key_value.wrapped_intermediate_key, 'base64'), E'\n', ''),
        '+/=', '-_'
      ),
      'rootKeyId', key_value.root_key_id,
      'wrapAlgorithm', key_value.wrap_algorithm,
      'createdAt', to_char(
        key_value.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'activatedAt', case when key_value.activated_at is null then null else
        to_char(
          key_value.activated_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'retiredAt', case when key_value.retired_at is null then null else
        to_char(
          key_value.retired_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'revokedAt', case when key_value.revoked_at is null then null else
        to_char(
          key_value.revoked_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) end,
      'wrapOperations', key_value.wrap_operations,
      'wrapOperationLimit', key_value.wrap_operation_limit,
      'rotation', jsonb_build_object(
        'predecessorKeyId', key_value.predecessor_key_id,
        'previousRootKeyId', key_value.previous_root_key_id,
        'rootRewrapCount', key_value.root_rewrap_count,
        'lastRootRewrappedAt', case
          when key_value.last_root_rewrapped_at is null then null else to_char(
            key_value.last_root_rewrapped_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) end
      )
    )
    else null
  end;
$$;

create or replace function public.register_user_content_key_v2(
  p_owner_id uuid,
  p_key_id text,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose,
  p_key_version integer,
  p_root_key_id text,
  p_wrap_algorithm text,
  p_wrapped_intermediate_key bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_key public.user_content_keys%rowtype;
  expected_version integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_key_class is null
    or p_key_purpose is null
    or p_key_version is null
    or p_key_version < 1
    or p_root_key_id is null
    or p_root_key_id
      !~ '^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_wrap_algorithm is distinct from 'AES-256-GCM'
    or p_wrapped_intermediate_key is null
    or octet_length(p_wrapped_intermediate_key) <> 65
    or substring(p_wrapped_intermediate_key from 1 for 5) <> decode('5546454b01', 'hex')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_owner_id::text || ':' || p_key_class::text || ':' || p_key_purpose::text,
      0
    )
  );

  select * into existing_key
  from public.user_content_keys
  where user_id = p_owner_id and key_id = p_key_id;

  if found then
    if existing_key.schema_version <> 2
      or existing_key.custody_provider <> 'vercel_sensitive_environment_v1'
      or existing_key.key_class <> p_key_class
      or existing_key.key_purpose <> p_key_purpose
      or existing_key.key_version <> p_key_version
      or existing_key.root_key_id <> p_root_key_id
      or existing_key.wrap_algorithm <> p_wrap_algorithm
      or existing_key.wrapped_intermediate_key <> p_wrapped_intermediate_key
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'keyId', existing_key.key_id,
      'keyClass', existing_key.key_class,
      'keyPurpose', existing_key.key_purpose,
      'keyVersion', existing_key.key_version,
      'state', existing_key.state,
      'replayed', true
    );
  end if;

  select coalesce(max(key_version), 0) + 1
  into expected_version
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose;

  if p_key_version <> expected_version then
    raise exception using errcode = '22023', message = 'invalid_key_version';
  end if;

  insert into public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version, schema_version,
    custody_provider, kms_key_id, root_key_id, wrap_algorithm,
    wrapped_intermediate_key, predecessor_key_id
  ) values (
    p_owner_id, p_key_id, p_key_class, p_key_purpose, p_key_version, 2,
    'vercel_sensitive_environment_v1', null, p_root_key_id, p_wrap_algorithm,
    p_wrapped_intermediate_key,
    (
      select key_id
      from public.user_content_keys
      where user_id = p_owner_id
        and key_class = p_key_class
        and key_purpose = p_key_purpose
        and state = 'active'
    )
  );

  if private.encrypted_storage_contract_applied() then
    perform private.initialize_contracted_rollout(p_owner_id);
  else
    insert into public.content_encryption_rollouts (user_id, state)
    values (p_owner_id, 'expanded')
    on conflict (user_id) do nothing;
  end if;

  return jsonb_build_object(
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', p_key_purpose,
    'keyVersion', p_key_version,
    'state', 'pending',
    'replayed', false
  );
end;
$$;

create or replace function public.rewrap_user_content_key_v2(
  p_owner_id uuid,
  p_key_id text,
  p_expected_root_key_id text,
  p_expected_root_rewrap_count integer,
  p_new_root_key_id text,
  p_new_wrapped_intermediate_key bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_row public.user_content_keys%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_key_id is null
    or p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_expected_root_key_id is null
    or p_expected_root_key_id
      !~ '^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_expected_root_rewrap_count is null
    or p_expected_root_rewrap_count not between 0 and 999999
    or p_new_root_key_id is null
    or p_new_root_key_id
      !~ '^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_new_root_key_id = p_expected_root_key_id
    or split_part(p_new_root_key_id, ':', 5)
      <> split_part(p_expected_root_key_id, ':', 5)
    or p_new_wrapped_intermediate_key is null
    or octet_length(p_new_wrapped_intermediate_key) <> 65
    or substring(p_new_wrapped_intermediate_key from 1 for 5)
      <> decode('5546454b01', 'hex')
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into key_row
  from public.user_content_keys as content_key
  where content_key.user_id = p_owner_id
    and content_key.key_id = p_key_id
  for update of content_key;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if key_row.schema_version <> 2
    or key_row.custody_provider <> 'vercel_sensitive_environment_v1'
  then
    raise exception using errcode = 'P0001', message = 'invalid_key_provider';
  end if;
  if key_row.state = 'revoked' then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;

  if key_row.root_key_id = p_new_root_key_id
    and key_row.previous_root_key_id = p_expected_root_key_id
    and key_row.root_rewrap_count = p_expected_root_rewrap_count + 1
  then
    if key_row.wrapped_intermediate_key <> p_new_wrapped_intermediate_key then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'keyId', key_row.key_id,
      'state', key_row.state,
      'rootRewrapCount', key_row.root_rewrap_count,
      'rewrapped', true,
      'replayed', true
    );
  end if;

  if key_row.root_key_id <> p_expected_root_key_id
    or key_row.root_rewrap_count <> p_expected_root_rewrap_count
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  update public.user_content_keys
  set
    previous_root_key_id = root_key_id,
    root_key_id = p_new_root_key_id,
    wrapped_intermediate_key = p_new_wrapped_intermediate_key,
    root_rewrap_count = root_rewrap_count + 1,
    last_root_rewrapped_at = now()
  where user_id = p_owner_id and key_id = p_key_id
  returning * into key_row;

  return jsonb_build_object(
    'keyId', key_row.key_id,
    'state', key_row.state,
    'rootRewrapCount', key_row.root_rewrap_count,
    'rewrapped', true,
    'replayed', false
  );
end;
$$;

-- Harden the legacy entry points against a cross-version idempotency replay.
-- Their signatures, accepted V1 payload, and return shapes remain unchanged.
create or replace function public.register_user_content_key(
  p_owner_id uuid,
  p_key_id text,
  p_key_class public.content_key_class,
  p_key_purpose public.content_key_purpose,
  p_key_version integer,
  p_kms_key_id text,
  p_wrapped_intermediate_key bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_key public.user_content_keys%rowtype;
  expected_version integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_key_class is null
    or p_key_purpose is null
    or p_key_version is null
    or p_key_version < 1
    or p_kms_key_id is null
    or char_length(p_kms_key_id) not between 20 and 2048
    or p_kms_key_id
      !~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
    or p_wrapped_intermediate_key is null
    or octet_length(p_wrapped_intermediate_key) not between 1 and 8192
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_owner_id::text || ':' || p_key_class::text || ':' || p_key_purpose::text,
      0
    )
  );

  select * into existing_key
  from public.user_content_keys
  where user_id = p_owner_id and key_id = p_key_id;

  if found then
    if existing_key.schema_version <> 1
      or existing_key.custody_provider <> 'aws_kms_v1'
      or existing_key.key_class <> p_key_class
      or existing_key.key_purpose <> p_key_purpose
      or existing_key.key_version <> p_key_version
      or existing_key.kms_key_id <> p_kms_key_id
      or existing_key.wrapped_intermediate_key <> p_wrapped_intermediate_key
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'keyId', existing_key.key_id,
      'keyClass', existing_key.key_class,
      'keyPurpose', existing_key.key_purpose,
      'keyVersion', existing_key.key_version,
      'state', existing_key.state,
      'replayed', true
    );
  end if;

  select coalesce(max(key_version), 0) + 1
  into expected_version
  from public.user_content_keys
  where user_id = p_owner_id
    and key_class = p_key_class
    and key_purpose = p_key_purpose;

  if p_key_version <> expected_version then
    raise exception using errcode = '22023', message = 'invalid_key_version';
  end if;

  insert into public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version, schema_version,
    custody_provider, kms_key_id, wrapped_intermediate_key, predecessor_key_id
  ) values (
    p_owner_id, p_key_id, p_key_class, p_key_purpose, p_key_version, 1,
    'aws_kms_v1', p_kms_key_id, p_wrapped_intermediate_key,
    (
      select key_id
      from public.user_content_keys
      where user_id = p_owner_id
        and key_class = p_key_class
        and key_purpose = p_key_purpose
        and state = 'active'
    )
  );

  if private.encrypted_storage_contract_applied() then
    perform private.initialize_contracted_rollout(p_owner_id);
  else
    insert into public.content_encryption_rollouts (user_id, state)
    values (p_owner_id, 'expanded')
    on conflict (user_id) do nothing;
  end if;

  return jsonb_build_object(
    'keyId', p_key_id,
    'keyClass', p_key_class,
    'keyPurpose', p_key_purpose,
    'keyVersion', p_key_version,
    'state', 'pending',
    'replayed', false
  );
end;
$$;

create or replace function public.rewrap_user_content_key(
  p_owner_id uuid,
  p_key_id text,
  p_expected_kms_key_id text,
  p_expected_root_rewrap_count integer,
  p_new_kms_key_id text,
  p_new_wrapped_intermediate_key bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  key_row public.user_content_keys%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_key_id is null
    or p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_expected_kms_key_id is null
    or char_length(p_expected_kms_key_id) not between 20 and 2048
    or p_expected_kms_key_id
      !~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
    or p_expected_root_rewrap_count is null
    or p_expected_root_rewrap_count not between 0 and 999999
    or p_new_kms_key_id is null
    or char_length(p_new_kms_key_id) not between 20 and 2048
    or p_new_kms_key_id
      !~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
    or p_new_kms_key_id = p_expected_kms_key_id
    or p_new_wrapped_intermediate_key is null
    or octet_length(p_new_wrapped_intermediate_key) not between 1 and 8192
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into key_row
  from public.user_content_keys as content_key
  where content_key.user_id = p_owner_id
    and content_key.key_id = p_key_id
  for update of content_key;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if key_row.schema_version <> 1 or key_row.custody_provider <> 'aws_kms_v1' then
    raise exception using errcode = 'P0001', message = 'invalid_key_provider';
  end if;
  if key_row.state = 'revoked' then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;

  if key_row.kms_key_id = p_new_kms_key_id
    and key_row.previous_kms_key_id = p_expected_kms_key_id
    and key_row.root_rewrap_count = p_expected_root_rewrap_count + 1
  then
    if key_row.wrapped_intermediate_key <> p_new_wrapped_intermediate_key then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'keyId', key_row.key_id,
      'state', key_row.state,
      'rootRewrapCount', key_row.root_rewrap_count,
      'rewrapped', true,
      'replayed', true
    );
  end if;

  if key_row.kms_key_id <> p_expected_kms_key_id
    or key_row.root_rewrap_count <> p_expected_root_rewrap_count
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  update public.user_content_keys
  set
    previous_kms_key_id = kms_key_id,
    kms_key_id = p_new_kms_key_id,
    wrapped_intermediate_key = p_new_wrapped_intermediate_key,
    root_rewrap_count = root_rewrap_count + 1,
    last_root_rewrapped_at = now()
  where user_id = p_owner_id and key_id = p_key_id
  returning * into key_row;

  return jsonb_build_object(
    'keyId', key_row.key_id,
    'state', key_row.state,
    'rootRewrapCount', key_row.root_rewrap_count,
    'rewrapped', true,
    'replayed', false
  );
end;
$$;

revoke execute on function public.register_user_content_key_v2(
  uuid, text, public.content_key_class, public.content_key_purpose,
  integer, text, text, bytea
) from public, anon, authenticated;
revoke execute on function public.rewrap_user_content_key_v2(
  uuid, text, text, integer, text, bytea
) from public, anon, authenticated, unfiled_index_worker,
  unfiled_rag_verifier, unfiled_organizer_worker, unfiled_search_worker;

grant execute on function public.register_user_content_key_v2(
  uuid, text, public.content_key_class, public.content_key_purpose,
  integer, text, text, bytea
) to service_role;
grant execute on function public.rewrap_user_content_key_v2(
  uuid, text, text, integer, text, bytea
) to service_role;
