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

create function pg_temp.environment_envelope(p_seed text)
returns bytea
language sql
immutable
as $$
  select decode('5546454b01' || repeat(left(p_seed, 2), 60), 'hex');
$$;

create temporary table g_key_values (
  key text primary key,
  value jsonb not null
) on commit drop;
grant all on g_key_values to service_role;

select has_column(
  'public', 'user_content_keys', 'custody_provider',
  'managed keys record their honest custody provider'
);
select has_column(
  'public', 'user_content_keys', 'root_key_id',
  'managed-key V2 roots have a provider-neutral column'
);
select has_column(
  'public', 'user_content_keys', 'previous_root_key_id',
  'managed-key V2 root rotation has provider-neutral audit storage'
);
select has_column(
  'public', 'user_content_keys', 'wrap_algorithm',
  'managed-key V2 records persist their exact envelope algorithm'
);
select has_function(
  'public', 'register_user_content_key_v2',
  array[
    'uuid', 'text', 'public.content_key_class', 'public.content_key_purpose',
    'integer', 'text', 'text', 'bytea'
  ],
  'web has a distinct V2 managed-key registration RPC'
);
select has_function(
  'public', 'rewrap_user_content_key_v2',
  array['uuid', 'text', 'text', 'integer', 'text', 'bytea'],
  'web has a distinct V2 provider-root rewrap RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.register_user_content_key_v2(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,text,bytea)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.rewrap_user_content_key_v2(uuid,text,text,integer,text,bytea)',
      'EXECUTE'
    )
    and not exists (
      select 1
      from unnest(array[
        'anon', 'authenticated', 'unfiled_index_worker',
        'unfiled_rag_verifier', 'unfiled_organizer_worker',
        'unfiled_search_worker'
      ]) as runtime(role_name)
      where has_function_privilege(
        runtime.role_name,
        'public.register_user_content_key_v2(uuid,text,public.content_key_class,public.content_key_purpose,integer,text,text,bytea)',
        'EXECUTE'
      ) or has_function_privilege(
        runtime.role_name,
        'public.rewrap_user_content_key_v2(uuid,text,text,integer,text,bytea)',
        'EXECUTE'
      )
    ),
  'only service_role can register or rewrap V2 managed keys'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '95959595-9595-4595-8595-959595959595',
  'authenticated', 'authenticated', 'key-v2@unfiled.local', '', now(),
  '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb, now(), now()
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into g_key_values(key, value)
select 'v1-register', public.register_user_content_key(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.mac.v1', 'ai_assisted', 'content_mac', 1,
  'arn:aws:kms:us-west-2:123456789012:key/95111111-1111-4111-8111-111111111111',
  decode(repeat('95', 32), 'hex')
);

insert into g_key_values(key, value)
select 'v2-register', public.register_user_content_key_v2(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222',
  'AES-256-GCM', pg_temp.environment_envelope('11')
);

select is(
  (select value ->> 'replayed' from g_key_values where key = 'v2-register'),
  'false',
  'V2 registration creates one pending provider-neutral key'
);

insert into g_key_values(key, value)
select 'v2-register-replay', public.register_user_content_key_v2(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.object.v1', 'ai_assisted', 'object_wrap', 1,
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222',
  'AES-256-GCM', pg_temp.environment_envelope('11')
);
select is(
  (select value ->> 'replayed' from g_key_values where key = 'v2-register-replay'),
  'true',
  'exact V2 registration replay is idempotent'
);

select public.activate_user_content_key(
  '95959595-9595-4595-8595-959595959595', 'g.ai.object.v1'
);

insert into g_key_values(key, value)
select 'v1-projection', public.get_user_content_key_by_id(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.mac.v1', 'ai_assisted', 'content_mac'
);
insert into g_key_values(key, value)
select 'v2-projection', public.get_user_content_key_by_id(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.object.v1', 'ai_assisted', 'object_wrap'
);

select ok(
  (select value ->> 'schemaVersion' = '1'
    and value ->> 'rootKeyArn'
      = 'arn:aws:kms:us-west-2:123456789012:key/95111111-1111-4111-8111-111111111111'
    and value ? 'custodyProvider' = false
    and value ? 'rootKeyId' = false
    and (value -> 'rotation') ? 'previousRootKeyArn'
    and (value -> 'rotation') ? 'previousRootKeyId' = false
    from g_key_values where key = 'v1-projection'),
  'V1 projection remains the exact AWS-shaped ManagedKeyRecordV1 contract'
);

select ok(
  (select value ->> 'schemaVersion' = '2'
    and value ->> 'custodyProvider' = 'vercel_sensitive_environment_v1'
    and value ->> 'rootKeyId'
      = 'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222'
    and value ->> 'wrapAlgorithm' = 'AES-256-GCM'
    and value ->> 'encryptedKeyMaterial'
      = translate(replace(encode(pg_temp.environment_envelope('11'), 'base64'), E'\n', ''), '+/=', '-_')
    and value ? 'rootKeyArn' = false
    and (value -> 'rotation') ? 'previousRootKeyId'
    and (value -> 'rotation') ? 'previousRootKeyArn' = false
    and value ->> 'createdAt'
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    from g_key_values where key = 'v2-projection'),
  'V2 lookup emits the exact provider-neutral ManagedKeyRecordV2 wire shape'
);

select is(
  (
    select array_agg(field order by field)
    from jsonb_object_keys(
      (select value from g_key_values where key = 'v2-projection')
    ) as fields(field)
  ),
  array[
    'activatedAt', 'createdAt', 'custodyProvider', 'encryptedKeyMaterial',
    'keyClass', 'keyId', 'keyVersion', 'ownerId', 'purpose', 'retiredAt',
    'revokedAt', 'rootKeyId', 'rotation', 'schemaVersion', 'status',
    'wrapAlgorithm', 'wrapOperationLimit', 'wrapOperations'
  ]::text[],
  'V2 projection has no extra or missing top-level fields'
);

insert into g_key_values(key, value)
select 'v2-rewrap', public.rewrap_user_content_key_v2(
  '95959595-9595-4595-8595-959595959595', 'g.ai.object.v1',
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222',
  0,
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95333333-3333-4333-8333-333333333333',
  pg_temp.environment_envelope('22')
);
select is(
  (select value ->> 'replayed' from g_key_values where key = 'v2-rewrap'),
  'false',
  'V2 rewrap atomically publishes a new provider root'
);

insert into g_key_values(key, value)
select 'v2-rewrap-replay', public.rewrap_user_content_key_v2(
  '95959595-9595-4595-8595-959595959595', 'g.ai.object.v1',
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222',
  0,
  'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95333333-3333-4333-8333-333333333333',
  pg_temp.environment_envelope('22')
);
select is(
  (select value ->> 'replayed' from g_key_values where key = 'v2-rewrap-replay'),
  'true',
  'exact V2 root rewrap replay is idempotent'
);

insert into g_key_values(key, value)
select 'v2-rewrapped-projection', public.get_user_content_key_by_id(
  '95959595-9595-4595-8595-959595959595',
  'g.ai.object.v1', 'ai_assisted', 'object_wrap'
);
select ok(
  (select value ->> 'rootKeyId'
      = 'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95333333-3333-4333-8333-333333333333'
    and value #>> '{rotation,previousRootKeyId}'
      = 'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95222222-2222-4222-8222-222222222222'
    and value #>> '{rotation,rootRewrapCount}' = '1'
    and value #>> '{rotation,lastRootRewrappedAt}'
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    from g_key_values where key = 'v2-rewrapped-projection'),
  'V2 projection preserves complete provider-neutral root-rotation audit metadata'
);

select is(
  pg_temp.caught_error($statement$
    select public.register_user_content_key_v2(
      '95959595-9595-4595-8595-959595959595',
      'g.invalid.v2', 'private_manual', 'object_wrap', 1,
      'arn:aws:kms:us-west-2:123456789012:key/95444444-4444-4444-8444-444444444444',
      'AES-256-GCM', pg_temp.environment_envelope('33')
    )
  $statement$) ->> 'message',
  'validation_failed',
  'V2 registration rejects an AWS ARN instead of disguising it as a provider root'
);
select is(
  pg_temp.caught_error($statement$
    select public.register_user_content_key_v2(
      '95959595-9595-4595-8595-959595959595',
      'g.invalid.envelope', 'private_manual', 'object_wrap', 1,
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95444444-4444-4444-8444-444444444444',
      'AES-256-GCM', decode(repeat('33', 65), 'hex')
    )
  $statement$) ->> 'message',
  'validation_failed',
  'V2 registration rejects a 65-byte value without the versioned envelope prefix'
);
select is(
  pg_temp.caught_error($statement$
    select public.rewrap_user_content_key_v2(
      '95959595-9595-4595-8595-959595959595', 'g.ai.object.v1',
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95333333-3333-4333-8333-333333333333',
      1,
      'urn:unfiled:key-root:vercel-sensitive-env-v1:preview:95555555-5555-4555-8555-555555555555',
      pg_temp.environment_envelope('44')
    )
  $statement$) ->> 'message',
  'validation_failed',
  'V2 rewrap cannot cross Preview and Production root domains'
);
select is(
  pg_temp.caught_error($statement$
    select public.rewrap_user_content_key(
      '95959595-9595-4595-8595-959595959595', 'g.ai.object.v1',
      'arn:aws:kms:us-west-2:123456789012:key/95666666-6666-4666-8666-666666666666',
      1,
      'arn:aws:kms:us-west-2:123456789012:key/95777777-7777-4777-8777-777777777777',
      decode(repeat('44', 32), 'hex')
    )
  $statement$) ->> 'message',
  'invalid_key_provider',
  'legacy AWS rewrap refuses a V2 environment-custody row'
);
select is(
  pg_temp.caught_error($statement$
    select public.rewrap_user_content_key_v2(
      '95959595-9595-4595-8595-959595959595', 'g.ai.mac.v1',
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95333333-3333-4333-8333-333333333333',
      0,
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95888888-8888-4888-8888-888888888888',
      pg_temp.environment_envelope('55')
    )
  $statement$) ->> 'message',
  'invalid_key_provider',
  'V2 rewrap refuses a legacy AWS row'
);

reset role;

select is(
  pg_temp.caught_error($statement$
    update public.user_content_keys
    set root_key_id =
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95999999-9999-4999-8999-999999999999'
    where user_id = '95959595-9595-4595-8595-959595959595'
      and key_id = 'g.ai.object.v1'
  $statement$) ->> 'message',
  'invalid_content_key_root_rewrap',
  'the lifecycle trigger rejects a root change without ciphertext and audit changes'
);
select is(
  pg_temp.caught_error($statement$
    update public.user_content_keys
    set custody_provider = 'aws_kms_v1'
    where user_id = '95959595-9595-4595-8595-959595959595'
      and key_id = 'g.ai.object.v1'
  $statement$) ->> 'message',
  'immutable_content_key_identity',
  'the lifecycle trigger makes the V2 custody provider immutable'
);
select is(
  pg_temp.caught_error($statement$
    insert into public.user_content_keys (
      user_id, key_id, key_class, key_purpose, key_version, schema_version,
      custody_provider, root_key_id, wrap_algorithm, wrapped_intermediate_key
    ) values (
      '95959595-9595-4595-8595-959595959595', 'g.direct.invalid',
      'private_manual', 'content_mac', 1, 2,
      'vercel_sensitive_environment_v1',
      'urn:unfiled:key-root:vercel-sensitive-env-v1:production:95000000-0000-4000-8000-000000000000',
      'AES-256-GCM', decode(repeat('00', 65), 'hex')
    )
  $statement$) ->> 'sqlstate',
  '23514',
  'storage constraints reject malformed V2 envelope bytes even outside the RPC'
);

select * from finish();
rollback;
