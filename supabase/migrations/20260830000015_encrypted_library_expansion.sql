-- Milestone C.5a: expand-only encrypted library and private RAG foundations.
--
-- This migration intentionally leaves every legacy plaintext column and read
-- path in place. C.5b owns dual-write/backfill and C.5d owns contraction. New
-- ciphertext is nevertheless fail-closed: an envelope cannot be stored unless
-- its authenticated context and owner/class/purpose/version-bound key reference
-- agree with the authoritative row metadata.

create type public.content_key_class as enum ('ai_assisted', 'private_manual');
create type public.content_key_purpose as enum ('object_wrap', 'content_mac');
create type public.content_key_state as enum ('pending', 'active', 'retired', 'revoked');
create type public.encryption_rollout_state as enum (
  'expanded',
  'dual_write',
  'encrypted_read',
  'encrypted_only',
  'contracted'
);
create type public.rag_generation_state as enum ('building', 'active', 'retired', 'failed');
create type public.note_index_job_state as enum ('queued', 'leased', 'succeeded', 'failed');

-- The isolated index worker never receives Supabase's global service_role or
-- any role with BYPASSRLS. The migration-owned capability starts as NOLOGIN;
-- production credential/login provisioning for this exact role is a separate
-- human operation. Never grant it as membership to a human, authenticator, or
-- parent workload role, and never enable INHERIT, superuser, or BYPASSRLS.
do $dedicated_index_worker$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'unfiled_index_worker'
  ) then
    execute 'create role unfiled_index_worker '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  else
    execute 'alter role unfiled_index_worker '
      || 'nosuperuser nocreatedb nocreaterole noinherit nologin '
      || 'noreplication nobypassrls';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members as membership
    join pg_catalog.pg_roles as granted_role
      on granted_role.oid = membership.roleid
    join pg_catalog.pg_roles as member_role
      on member_role.oid = membership.member
    where granted_role.rolname = 'service_role'
      and member_role.rolname = 'unfiled_index_worker'
  ) then
    execute 'revoke service_role from unfiled_index_worker';
  end if;
end;
$dedicated_index_worker$;

-- Internal retrieval IDs are deliberately outside the product entity-ID
-- surface. They remain sortable and opaque while retaining strict prefixes.
create or replace function public.new_entity_id(prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
begin
  if prefix <> all (
    array[
      'blk', 'cap', 'chk', 'dec', 'ent', 'evt', 'fbk', 'igen', 'ijob', 'irw',
      'itm', 'job', 'key', 'lnk', 'mut', 'note', 'rev', 'rule', 'rvw', 'spc',
      'tag'
    ]
  ) then
    raise exception using errcode = '22023', message = 'invalid_entity_prefix';
  end if;

  return prefix || '_' || public.generate_ulid();
end;
$$;

create or replace function private.valid_content_envelope(
  envelope_value jsonb,
  owner_id uuid,
  resource_id_value text,
  record_version_value integer,
  content_kind_value text,
  key_id_value text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    envelope_value is not null
    and owner_id is not null
    and resource_id_value is not null
    and record_version_value is not null
    and record_version_value >= 1
    and content_kind_value is not null
    and char_length(content_kind_value) between 1 and 80
    and key_id_value is not null
    and jsonb_typeof(envelope_value) = 'object'
    and octet_length(envelope_value::text) <= 1500000
    and (envelope_value - array[
      'version', 'suite', 'keyId', 'context', 'wrappedDataKey', 'payload'
    ]) = '{}'::jsonb
    and envelope_value ?& array[
      'version', 'suite', 'keyId', 'context', 'wrappedDataKey', 'payload'
    ]
    and envelope_value -> 'version' = '1'::jsonb
    and jsonb_typeof(envelope_value -> 'version') = 'number'
    and envelope_value ->> 'suite' = 'A256GCM'
    and jsonb_typeof(envelope_value -> 'suite') = 'string'
    and envelope_value ->> 'keyId' = key_id_value
    and jsonb_typeof(envelope_value -> 'keyId') = 'string'
    and key_id_value ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and jsonb_typeof(envelope_value -> 'context') = 'object'
    and ((envelope_value -> 'context') - array[
      'tenantId', 'resourceId', 'recordVersion', 'kind'
    ]) = '{}'::jsonb
    and (envelope_value -> 'context') ?& array[
      'tenantId', 'resourceId', 'recordVersion', 'kind'
    ]
    and jsonb_typeof(envelope_value -> 'context' -> 'tenantId') = 'string'
    and envelope_value -> 'context' ->> 'tenantId' = owner_id::text
    and jsonb_typeof(envelope_value -> 'context' -> 'resourceId') = 'string'
    and envelope_value -> 'context' ->> 'resourceId' = resource_id_value
    and jsonb_typeof(envelope_value -> 'context' -> 'recordVersion') = 'number'
    and envelope_value -> 'context' -> 'recordVersion' = to_jsonb(record_version_value)
    and jsonb_typeof(envelope_value -> 'context' -> 'kind') = 'string'
    and envelope_value -> 'context' ->> 'kind' = content_kind_value
    and jsonb_typeof(envelope_value -> 'wrappedDataKey') = 'object'
    and ((envelope_value -> 'wrappedDataKey') - array['nonce', 'ciphertext']) = '{}'::jsonb
    and (envelope_value -> 'wrappedDataKey') ?& array['nonce', 'ciphertext']
    and jsonb_typeof(envelope_value -> 'wrappedDataKey' -> 'nonce') = 'string'
    and envelope_value -> 'wrappedDataKey' ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and jsonb_typeof(envelope_value -> 'wrappedDataKey' -> 'ciphertext') = 'string'
    and envelope_value -> 'wrappedDataKey' ->> 'ciphertext' ~ '^[A-Za-z0-9_-]{64}$'
    and jsonb_typeof(envelope_value -> 'payload') = 'object'
    and ((envelope_value -> 'payload') - array['nonce', 'ciphertext']) = '{}'::jsonb
    and (envelope_value -> 'payload') ?& array['nonce', 'ciphertext']
    and jsonb_typeof(envelope_value -> 'payload' -> 'nonce') = 'string'
    and envelope_value -> 'payload' ->> 'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    and jsonb_typeof(envelope_value -> 'payload' -> 'ciphertext') = 'string'
    and envelope_value -> 'payload' ->> 'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    and char_length(envelope_value -> 'payload' ->> 'ciphertext')
      between 22 and 1499000
    and mod(char_length(envelope_value -> 'payload' ->> 'ciphertext'), 4) <> 1
  ), false);
$$;

create or replace function private.valid_encrypted_field(
  envelope_value jsonb,
  owner_id uuid,
  resource_id_value text,
  record_version_value integer,
  content_kind_value text,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when envelope_value is null then
      num_nonnulls(
        key_id_value, key_class_value, key_purpose_value, key_version_value
      ) = 0
    else
      key_id_value is not null
      and key_class_value is not null
      and key_purpose_value = 'object_wrap'::public.content_key_purpose
      and key_version_value >= 1
      and private.valid_content_envelope(
        envelope_value,
        owner_id,
        resource_id_value,
        record_version_value,
        content_kind_value,
        key_id_value
      )
  end;
$$;

create or replace function private.valid_keyed_mac_field(
  mac_value text,
  key_id_value text,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_version_value integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when mac_value is null then
      num_nonnulls(
        key_id_value, key_class_value, key_purpose_value, key_version_value
      ) = 0
    else
      mac_value ~ '^[0-9a-f]{64}$'
      and key_id_value is not null
      and key_class_value is not null
      and key_purpose_value = 'content_mac'::public.content_key_purpose
      and key_version_value >= 1
  end;
$$;

-- This exact four-key object is also required by the AWS KMS key policies.
-- It is generated from authoritative columns, so no caller can persist a
-- different owner/class/purpose/key-record encryption context. Key version is
-- intentionally tracked and constrained separately, not added as a fifth KMS
-- context field.
create or replace function private.content_key_kms_context(
  owner_id uuid,
  key_class_value public.content_key_class,
  key_purpose_value public.content_key_purpose,
  key_id_value text
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'UnfiledOwnerId', owner_id::text,
    'UnfiledKeyClass', key_class_value::text,
    'UnfiledKeyPurpose', key_purpose_value::text,
    'UnfiledKeyRecordId', key_id_value
  );
$$;

create table public.user_content_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  key_id text not null default public.new_entity_id('key'),
  key_class public.content_key_class not null,
  key_purpose public.content_key_purpose not null,
  key_version integer not null check (key_version >= 1),
  schema_version integer not null default 1 check (schema_version = 1),
  kms_key_id text not null check (
    char_length(kms_key_id) between 20 and 2048
    and kms_key_id ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
  ),
  wrapped_intermediate_key bytea not null check (
    octet_length(wrapped_intermediate_key) between 1 and 8192
  ),
  kms_encryption_context jsonb generated always as (
    private.content_key_kms_context(user_id, key_class, key_purpose, key_id)
  ) stored,
  state public.content_key_state not null default 'pending',
  predecessor_key_id text,
  previous_kms_key_id text check (
    previous_kms_key_id is null
    or (
      char_length(previous_kms_key_id) between 20 and 2048
      and previous_kms_key_id ~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
    )
  ),
  root_rewrap_count integer not null default 0 check (
    root_rewrap_count between 0 and 1000000
  ),
  last_root_rewrapped_at timestamptz,
  wrap_operations bigint not null default 0 check (wrap_operations >= 0),
  wrap_operation_limit bigint not null default 16777216 check (
    wrap_operation_limit between 1 and 16777216
    and wrap_operations <= wrap_operation_limit
  ),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  primary key (user_id, key_id),
  unique (user_id, key_class, key_purpose, key_version),
  unique (user_id, key_id, key_class, key_purpose, key_version),
  check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  check (predecessor_key_id is null or predecessor_key_id <> key_id),
  check (
    (root_rewrap_count = 0 and previous_kms_key_id is null and last_root_rewrapped_at is null)
    or (
      root_rewrap_count > 0
      and previous_kms_key_id is not null
      and last_root_rewrapped_at is not null
    )
  ),
  check (activated_at is null or activated_at >= created_at),
  check (
    retired_at is null
    or (activated_at is not null and retired_at >= activated_at)
  ),
  check (
    revoked_at is null
    or revoked_at >= coalesce(retired_at, activated_at, created_at)
  ),
  check (
    last_root_rewrapped_at is null
    or last_root_rewrapped_at >= created_at
  ),
  check (
    (state = 'pending' and activated_at is null and retired_at is null and revoked_at is null)
    or (state = 'active' and activated_at is not null and retired_at is null and revoked_at is null)
    or (
      state = 'retired'
      and activated_at is not null
      and retired_at is not null
      and revoked_at is null
    )
    or (state = 'revoked' and revoked_at is not null)
  ),
  foreign key (user_id, predecessor_key_id)
    references public.user_content_keys (user_id, key_id)
    deferrable initially deferred
);
create unique index user_content_keys_one_active
  on public.user_content_keys (user_id, key_class, key_purpose)
  where state = 'active';
create unique index user_content_keys_one_pending
  on public.user_content_keys (user_id, key_class, key_purpose)
  where state = 'pending';

create or replace function private.enforce_content_key_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  root_identifier_changed boolean;
  wrapped_material_changed boolean;
  root_audit_changed boolean;
begin
  if row(
    new.user_id, new.key_id, new.key_class, new.key_purpose, new.key_version,
    new.schema_version, new.predecessor_key_id, new.created_at,
    new.wrap_operation_limit
  ) is distinct from row(
    old.user_id, old.key_id, old.key_class, old.key_purpose, old.key_version,
    old.schema_version, old.predecessor_key_id, old.created_at,
    old.wrap_operation_limit
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

  root_identifier_changed := new.kms_key_id is distinct from old.kms_key_id;
  wrapped_material_changed :=
    new.wrapped_intermediate_key is distinct from old.wrapped_intermediate_key;
  root_audit_changed := row(
    new.previous_kms_key_id, new.root_rewrap_count, new.last_root_rewrapped_at
  ) is distinct from row(
    old.previous_kms_key_id, old.root_rewrap_count, old.last_root_rewrapped_at
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
      or new.previous_kms_key_id is distinct from old.kms_key_id
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
create trigger user_content_keys_enforce_lifecycle
before update on public.user_content_keys
for each row execute function private.enforce_content_key_lifecycle();

create table public.content_encryption_rollouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state public.encryption_rollout_state not null default 'expanded',
  backfill_cursor text,
  encrypted_object_count bigint not null default 0 check (encrypted_object_count >= 0),
  verified_object_count bigint not null default 0 check (
    verified_object_count >= 0 and verified_object_count <= encrypted_object_count
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger content_encryption_rollouts_touch_updated_at
before update on public.content_encryption_rollouts
for each row execute function public.set_updated_at();

-- Composite owner references prevent a service bug from linking one user's
-- encrypted metadata to another user's entity, generation, or key.
alter table public.notes add constraint notes_owner_id_key unique (user_id, id);
alter table public.spaces add constraint spaces_owner_id_key unique (user_id, id);
alter table public.tags add constraint tags_owner_id_key unique (user_id, id);

alter table public.spaces
  add column display_envelope jsonb,
  add column display_key_id text,
  add column display_key_class public.content_key_class,
  add column display_key_purpose public.content_key_purpose,
  add column display_key_version integer,
  add column display_mac text,
  add column display_mac_key_id text,
  add column display_mac_key_class public.content_key_class,
  add column display_mac_key_purpose public.content_key_purpose,
  add column display_mac_key_version integer,
  add constraint spaces_display_envelope_shape check (
    private.valid_encrypted_field(
      display_envelope, user_id, id, current_revision, 'space_display',
      display_key_id, display_key_class, display_key_purpose, display_key_version
    )
  ),
  add constraint spaces_display_mac_shape check (
    private.valid_keyed_mac_field(
      display_mac, display_mac_key_id, display_mac_key_class,
      display_mac_key_purpose, display_mac_key_version
    )
  ),
  add constraint spaces_display_key_fkey foreign key (
    user_id, display_key_id, display_key_class, display_key_purpose, display_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  add constraint spaces_display_mac_key_fkey foreign key (
    user_id, display_mac_key_id, display_mac_key_class,
    display_mac_key_purpose, display_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.tags
  add column display_envelope jsonb,
  add column display_key_id text,
  add column display_key_class public.content_key_class,
  add column display_key_purpose public.content_key_purpose,
  add column display_key_version integer,
  add column display_mac text,
  add column display_mac_key_id text,
  add column display_mac_key_class public.content_key_class,
  add column display_mac_key_purpose public.content_key_purpose,
  add column display_mac_key_version integer,
  add constraint tags_display_envelope_shape check (
    private.valid_encrypted_field(
      display_envelope, user_id, id, current_revision, 'tag_display',
      display_key_id, display_key_class, display_key_purpose, display_key_version
    )
  ),
  add constraint tags_display_mac_shape check (
    private.valid_keyed_mac_field(
      display_mac, display_mac_key_id, display_mac_key_class,
      display_mac_key_purpose, display_mac_key_version
    )
  ),
  add constraint tags_display_key_fkey foreign key (
    user_id, display_key_id, display_key_class, display_key_purpose, display_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  add constraint tags_display_mac_key_fkey foreign key (
    user_id, display_mac_key_id, display_mac_key_class,
    display_mac_key_purpose, display_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.notes
  add column content_envelope jsonb,
  add column content_key_id text,
  add column content_key_class public.content_key_class,
  add column content_key_purpose public.content_key_purpose,
  add column content_key_version integer,
  add constraint notes_content_envelope_shape check (
    private.valid_encrypted_field(
      content_envelope, user_id, id, current_revision, 'note_content',
      content_key_id, content_key_class, content_key_purpose, content_key_version
    )
    and (
      content_envelope is null
      or content_key_class::text = privacy::text
    )
  ),
  add constraint notes_content_key_fkey foreign key (
    user_id, content_key_id, content_key_class, content_key_purpose, content_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.note_revisions
  add column snapshot_envelope jsonb,
  add column snapshot_key_id text,
  add column snapshot_key_class public.content_key_class,
  add column snapshot_key_purpose public.content_key_purpose,
  add column snapshot_key_version integer,
  add column snapshot_mac text,
  add column snapshot_mac_key_id text,
  add column snapshot_mac_key_class public.content_key_class,
  add column snapshot_mac_key_purpose public.content_key_purpose,
  add column snapshot_mac_key_version integer,
  add constraint note_revisions_snapshot_envelope_shape check (
    private.valid_encrypted_field(
      snapshot_envelope, user_id, id, revision, 'note_revision',
      snapshot_key_id, snapshot_key_class, snapshot_key_purpose, snapshot_key_version
    )
    and (
      snapshot_envelope is null
      or privacy = 'ai_assisted'
      or snapshot_key_class = 'private_manual'
    )
  ),
  add constraint note_revisions_snapshot_mac_shape check (
    private.valid_keyed_mac_field(
      snapshot_mac, snapshot_mac_key_id, snapshot_mac_key_class,
      snapshot_mac_key_purpose, snapshot_mac_key_version
    )
  ),
  add constraint note_revisions_snapshot_key_fkey foreign key (
    user_id, snapshot_key_id, snapshot_key_class,
    snapshot_key_purpose, snapshot_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  add constraint note_revisions_snapshot_mac_key_fkey foreign key (
    user_id, snapshot_mac_key_id, snapshot_mac_key_class,
    snapshot_mac_key_purpose, snapshot_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.organization_decisions
  add column decision_envelope jsonb,
  add column decision_key_id text,
  add column decision_key_class public.content_key_class,
  add column decision_key_purpose public.content_key_purpose,
  add column decision_key_version integer,
  add constraint organization_decisions_envelope_shape check (
    private.valid_encrypted_field(
      decision_envelope, user_id, id, 1, 'organization_decision',
      decision_key_id, decision_key_class, decision_key_purpose,
      decision_key_version
    )
  ),
  add constraint organization_decisions_key_fkey foreign key (
    user_id, decision_key_id, decision_key_class,
    decision_key_purpose, decision_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.note_mutations
  add column mutation_envelope jsonb,
  add column mutation_key_id text,
  add column mutation_key_class public.content_key_class,
  add column mutation_key_purpose public.content_key_purpose,
  add column mutation_key_version integer,
  add constraint note_mutations_envelope_shape check (
    private.valid_encrypted_field(
      mutation_envelope, user_id, id, after_revision, 'note_mutation',
      mutation_key_id, mutation_key_class, mutation_key_purpose,
      mutation_key_version
    )
  ),
  add constraint note_mutations_key_fkey foreign key (
    user_id, mutation_key_id, mutation_key_class,
    mutation_key_purpose, mutation_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.generated_blocks
  add column content_envelope jsonb,
  add column content_key_id text,
  add column content_key_class public.content_key_class,
  add column content_key_purpose public.content_key_purpose,
  add column content_key_version integer,
  add constraint generated_blocks_envelope_shape check (
    private.valid_encrypted_field(
      content_envelope, user_id, id, 1, 'generated_block',
      content_key_id, content_key_class, content_key_purpose, content_key_version
    )
  ),
  add constraint generated_blocks_key_fkey foreign key (
    user_id, content_key_id, content_key_class, content_key_purpose, content_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.review_items
  add column review_envelope jsonb,
  add column review_key_id text,
  add column review_key_class public.content_key_class,
  add column review_key_purpose public.content_key_purpose,
  add column review_key_version integer,
  add constraint review_items_envelope_shape check (
    private.valid_encrypted_field(
      review_envelope, user_id, id, 1, 'review_item',
      review_key_id, review_key_class, review_key_purpose, review_key_version
    )
  ),
  add constraint review_items_key_fkey foreign key (
    user_id, review_key_id, review_key_class,
    review_key_purpose, review_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.routing_rules
  add column condition_envelope jsonb,
  add column condition_key_id text,
  add column condition_key_class public.content_key_class,
  add column condition_key_purpose public.content_key_purpose,
  add column condition_key_version integer,
  add constraint routing_rules_envelope_shape check (
    private.valid_encrypted_field(
      condition_envelope, user_id, id, 1, 'routing_rule',
      condition_key_id, condition_key_class, condition_key_purpose,
      condition_key_version
    )
  ),
  add constraint routing_rules_key_fkey foreign key (
    user_id, condition_key_id, condition_key_class,
    condition_key_purpose, condition_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.organization_mutation_attempts
  add column attempt_envelope jsonb,
  add column attempt_key_id text,
  add column attempt_key_class public.content_key_class,
  add column attempt_key_purpose public.content_key_purpose,
  add column attempt_key_version integer,
  add constraint organization_mutation_attempts_envelope_shape check (
    private.valid_encrypted_field(
      attempt_envelope, user_id, job_id || ':' || note_id, 1,
      'organization_mutation_attempt', attempt_key_id, attempt_key_class,
      attempt_key_purpose, attempt_key_version
    )
  ),
  add constraint organization_mutation_attempts_key_fkey foreign key (
    user_id, attempt_key_id, attempt_key_class,
    attempt_key_purpose, attempt_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.api_idempotency_records
  add column request_mac text,
  add column request_mac_key_id text,
  add column request_mac_key_class public.content_key_class,
  add column request_mac_key_purpose public.content_key_purpose,
  add column request_mac_key_version integer,
  add column response_envelope jsonb,
  add column response_key_id text,
  add column response_key_class public.content_key_class,
  add column response_key_purpose public.content_key_purpose,
  add column response_key_version integer,
  add constraint api_idempotency_request_mac_shape check (
    private.valid_keyed_mac_field(
      request_mac, request_mac_key_id, request_mac_key_class,
      request_mac_key_purpose, request_mac_key_version
    )
  ),
  add constraint api_idempotency_response_envelope_shape check (
    private.valid_encrypted_field(
      response_envelope, user_id, 'idempotency:' || idempotency_key, 1,
      'idempotency_response', response_key_id, response_key_class,
      response_key_purpose, response_key_version
    )
  ),
  add constraint api_idempotency_request_key_fkey foreign key (
    user_id, request_mac_key_id, request_mac_key_class,
    request_mac_key_purpose, request_mac_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  add constraint api_idempotency_response_key_fkey foreign key (
    user_id, response_key_id, response_key_class,
    response_key_purpose, response_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

alter table public.capture_receipts
  add column receipt_envelope jsonb,
  add column receipt_key_id text,
  add column receipt_key_class public.content_key_class,
  add column receipt_key_purpose public.content_key_purpose,
  add column receipt_key_version integer,
  add constraint capture_receipts_envelope_shape check (
    private.valid_encrypted_field(
      receipt_envelope, user_id, capture_id, 1, 'capture_receipt',
      receipt_key_id, receipt_key_class, receipt_key_purpose, receipt_key_version
    )
  ),
  add constraint capture_receipts_key_fkey foreign key (
    user_id, receipt_key_id, receipt_key_class,
    receipt_key_purpose, receipt_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

-- Capture envelopes predate per-user key records. Their key reference remains
-- optional during expansion, but a supplied reference must be exact. C.5b
-- backfills it before encrypted-read cutover.
alter table public.captures
  add column content_key_id text,
  add column content_key_class public.content_key_class,
  add column content_key_purpose public.content_key_purpose,
  add column content_key_version integer,
  add column fingerprint_key_id text,
  add column fingerprint_key_class public.content_key_class,
  add column fingerprint_key_purpose public.content_key_purpose,
  add column fingerprint_key_version integer,
  add constraint captures_content_key_reference_shape check (
    (
      content_key_id is null
      and content_key_class is null
      and content_key_purpose is null
      and content_key_version is null
    )
    or (
      private.valid_content_envelope(
        content_envelope, user_id, id, 1, 'capture', content_key_id
      )
      and content_key_class::text = privacy::text
      and content_key_purpose = 'object_wrap'
      and content_key_version >= 1
    )
  ),
  add constraint captures_fingerprint_key_reference_shape check (
    private.valid_keyed_mac_field(
      content_fingerprint, fingerprint_key_id, fingerprint_key_class,
      fingerprint_key_purpose, fingerprint_key_version
    )
    or (
      content_fingerprint is not null
      and fingerprint_key_id is null
      and fingerprint_key_class is null
      and fingerprint_key_purpose is null
      and fingerprint_key_version is null
    )
  ),
  add constraint captures_content_key_fkey foreign key (
    user_id, content_key_id, content_key_class,
    content_key_purpose, content_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred,
  add constraint captures_fingerprint_key_fkey foreign key (
    user_id, fingerprint_key_id, fingerprint_key_class,
    fingerprint_key_purpose, fingerprint_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred;

create table public.rag_index_generations (
  id text primary key default public.new_entity_id('igen'),
  user_id uuid not null references auth.users(id) on delete cascade,
  embedding_model_id text not null check (char_length(embedding_model_id) between 1 and 200),
  embedding_dimensions integer not null check (embedding_dimensions between 1 and 4096),
  envelope_schema_version integer not null default 1 check (envelope_schema_version = 1),
  state public.rag_generation_state not null default 'building',
  expected_note_count integer not null default 0 check (expected_note_count >= 0),
  indexed_note_count integer not null default 0 check (
    indexed_note_count >= 0 and indexed_note_count <= expected_note_count
  ),
  revision_token bigint not null default 0 check (revision_token >= 0),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  failed_at timestamptz,
  unique (user_id, id),
  check (id ~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (
    (state = 'building' and activated_at is null and retired_at is null and failed_at is null)
    or (state = 'active' and activated_at is not null and retired_at is null and failed_at is null)
    or (state = 'retired' and activated_at is not null and retired_at is not null and failed_at is null)
    or (state = 'failed' and activated_at is null and retired_at is null and failed_at is not null)
  )
);
create unique index rag_index_generations_one_active
  on public.rag_index_generations (user_id)
  where state = 'active';
create index rag_index_generations_owner_created
  on public.rag_index_generations (user_id, created_at desc, id desc);

create table public.note_rag_index (
  id text primary key default public.new_entity_id('irw'),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null,
  generation_id text not null,
  indexed_revision integer not null check (indexed_revision >= 1),
  index_envelope jsonb not null,
  index_key_id text not null,
  index_key_class public.content_key_class not null,
  index_key_purpose public.content_key_purpose not null,
  index_key_version integer not null check (index_key_version >= 1),
  encrypted_byte_length integer not null check (encrypted_byte_length between 16 and 262160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, generation_id),
  check (id ~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (index_key_class = 'ai_assisted'),
  check (index_key_purpose = 'object_wrap'),
  check (private.valid_encrypted_field(
    index_envelope, user_id, id, indexed_revision, 'note_rag_index',
    index_key_id, index_key_class, index_key_purpose, index_key_version
  )),
  check (
    encrypted_byte_length = floor(
      char_length(index_envelope -> 'payload' ->> 'ciphertext') * 3 / 4.0
    )::integer
  ),
  foreign key (user_id, note_id)
    references public.notes (user_id, id) on delete cascade,
  foreign key (user_id, generation_id)
    references public.rag_index_generations (user_id, id) on delete cascade,
  foreign key (
    user_id, index_key_id, index_key_class, index_key_purpose, index_key_version
  ) references public.user_content_keys (
    user_id, key_id, key_class, key_purpose, key_version
  ) deferrable initially deferred
);
create index note_rag_index_generation_page
  on public.note_rag_index (user_id, generation_id, id);
create trigger note_rag_index_touch_updated_at
before update on public.note_rag_index
for each row execute function public.set_updated_at();

create table public.note_index_jobs (
  id text primary key default public.new_entity_id('ijob'),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id text not null,
  generation_id text not null,
  target_revision integer not null check (target_revision >= 1),
  index_resource_id text not null default public.new_entity_id('irw')
    check (index_resource_id ~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'),
  state public.note_index_job_state not null default 'queued',
  attempt integer not null default 0 check (attempt between 0 and 5),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  last_transition_lease_token uuid,
  last_transition_action text check (
    last_transition_action in ('succeeded', 'retried', 'failed', 'recovered')
  ),
  last_transition_request_hash text check (
    last_transition_request_hash ~ '^[0-9a-f]{64}$'
  ),
  result_index_id text references public.note_rag_index(id) on delete set null,
  last_error_code public.safe_error_code,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, generation_id, target_revision),
  check (id ~ '^ijob_[0-9A-HJKMNP-TV-Z]{26}$'),
  check (
    (
      state = 'leased'
      and lease_owner is not null
      and char_length(lease_owner) between 1 and 120
      and lease_token is not null
      and lease_expires_at is not null
      and last_heartbeat_at is not null
    )
    or (
      state <> 'leased'
      and lease_owner is null
      and lease_token is null
      and lease_expires_at is null
      and last_heartbeat_at is null
    )
  ),
  check (
    (
      last_transition_lease_token is null
      and last_transition_action is null
      and last_transition_request_hash is null
    )
    or (
      last_transition_lease_token is not null
      and last_transition_action is not null
      and last_transition_request_hash is not null
    )
  ),
  foreign key (user_id, note_id)
    references public.notes (user_id, id) on delete cascade,
  foreign key (user_id, generation_id)
    references public.rag_index_generations (user_id, id) on delete cascade
);
create index note_index_jobs_claimable
  on public.note_index_jobs (available_at, created_at, id)
  where state = 'queued';
create index note_index_jobs_expired_lease
  on public.note_index_jobs (lease_expires_at, id)
  where state = 'leased';
create trigger note_index_jobs_touch_updated_at
before update on public.note_index_jobs
for each row execute function public.set_updated_at();

create or replace function private.enforce_note_rag_index_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  note_row public.notes%rowtype;
  generation_row public.rag_index_generations%rowtype;
  key_state_value public.content_key_state;
begin
  select * into note_row
  from public.notes
  where id = new.note_id and user_id = new.user_id;

  select * into generation_row
  from public.rag_index_generations
  where id = new.generation_id and user_id = new.user_id;

  select state into key_state_value
  from public.user_content_keys
  where user_id = new.user_id
    and key_id = new.index_key_id
    and key_class = new.index_key_class
    and key_purpose = new.index_key_purpose
    and key_version = new.index_key_version;

  if note_row.id is null
    or generation_row.id is null
    or key_state_value is null
    or note_row.deleted_at is not null
    or note_row.privacy <> 'ai_assisted'
    or note_row.current_revision <> new.indexed_revision
    or generation_row.state not in ('building', 'active')
    or key_state_value <> 'active'
  then
    raise exception using errcode = '23514', message = 'ineligible_note_rag_index';
  end if;

  return new;
end;
$$;
create trigger note_rag_index_enforce_eligibility
before insert or update of
  user_id, note_id, generation_id, indexed_revision, index_envelope,
  index_key_id, index_key_class, index_key_purpose, index_key_version
on public.note_rag_index
for each row execute function private.enforce_note_rag_index_eligibility();

create or replace function private.enforce_note_index_job_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.notes as note
    join public.rag_index_generations as generation
      on generation.id = new.generation_id
      and generation.user_id = new.user_id
    where note.id = new.note_id
      and note.user_id = new.user_id
      and note.deleted_at is null
      and note.privacy = 'ai_assisted'
      and note.current_revision = new.target_revision
      and generation.state in ('building', 'active')
  ) then
    raise exception using errcode = '23514', message = 'ineligible_note_index_job';
  end if;

  return new;
end;
$$;
create trigger note_index_jobs_enforce_target
before insert or update of user_id, note_id, generation_id, target_revision
on public.note_index_jobs
for each row execute function private.enforce_note_index_job_target();

create or replace function private.invalidate_note_rag_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.privacy = 'private_manual' or new.deleted_at is not null then
    delete from public.note_rag_index
    where user_id = new.user_id and note_id = new.id;
  end if;

  update public.note_index_jobs
  set
    state = 'failed',
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = case
      when state = 'leased' then lease_token
      else last_transition_lease_token
    end,
    last_transition_action = case
      when state = 'leased' then 'failed'
      else last_transition_action
    end,
    last_transition_request_hash = case
      when state = 'leased' then private.request_hash(jsonb_build_object(
        'action', 'invalidate',
        'noteId', new.id,
        'targetRevision', target_revision,
        'currentRevision', new.current_revision
      ))
      else last_transition_request_hash
    end,
    last_error_code = case
      when new.privacy = 'private_manual' or new.deleted_at is not null
        then 'validation_failed'::public.safe_error_code
      else 'stale_revision'::public.safe_error_code
    end
  where user_id = new.user_id
    and note_id = new.id
    and state in ('queued', 'leased')
    and (
      new.privacy = 'private_manual'
      or new.deleted_at is not null
      or target_revision <> new.current_revision
    );

  update public.rag_index_generations as generation
  set
    expected_note_count = (
      select count(*)::integer
      from public.notes as eligible_note
      where eligible_note.user_id = generation.user_id
        and eligible_note.deleted_at is null
        and eligible_note.privacy = 'ai_assisted'
    ),
    indexed_note_count = (
      select count(*)::integer
      from public.note_rag_index as index_row
      join public.notes as indexed_note
        on indexed_note.id = index_row.note_id
        and indexed_note.user_id = index_row.user_id
      where index_row.generation_id = generation.id
        and index_row.user_id = generation.user_id
        and indexed_note.deleted_at is null
        and indexed_note.privacy = 'ai_assisted'
        and indexed_note.current_revision = index_row.indexed_revision
    ),
    revision_token = generation.revision_token + 1
  where generation.user_id = new.user_id
    and generation.state in ('building', 'active');

  return new;
end;
$$;
create trigger notes_invalidate_rag_state
after update of current_revision, privacy, deleted_at on public.notes
for each row
when (
  old.current_revision is distinct from new.current_revision
  or old.privacy is distinct from new.privacy
  or old.deleted_at is distinct from new.deleted_at
)
execute function private.invalidate_note_rag_state();

alter table public.user_content_keys enable row level security;
alter table public.user_content_keys force row level security;
alter table public.content_encryption_rollouts enable row level security;
alter table public.content_encryption_rollouts force row level security;
alter table public.rag_index_generations enable row level security;
alter table public.rag_index_generations force row level security;
alter table public.note_rag_index enable row level security;
alter table public.note_rag_index force row level security;
alter table public.note_index_jobs enable row level security;
alter table public.note_index_jobs force row level security;

revoke all on table public.user_content_keys from public, anon, authenticated;
revoke all on table public.content_encryption_rollouts from public, anon, authenticated;
revoke all on table public.rag_index_generations from public, anon, authenticated;
revoke all on table public.note_rag_index from public, anon, authenticated;
revoke all on table public.note_index_jobs from public, anon, authenticated;
revoke all on table public.user_content_keys from service_role;
revoke all on table public.content_encryption_rollouts from service_role;
revoke all on table public.rag_index_generations from service_role;
revoke all on table public.note_rag_index from service_role;
revoke all on table public.note_index_jobs from service_role;
-- The key resolver needs the KMS ciphertext record. This grants no plaintext
-- or KMS authority; the separately deployed worker can see opaque private-key
-- ciphertext but its AWS role cannot decrypt it. All mutations and all RAG
-- reads remain behind the reviewed SECURITY DEFINER functions below.
grant select on table public.user_content_keys to service_role;

revoke execute on function private.valid_content_envelope(
  jsonb, uuid, text, integer, text, text
) from public, anon, authenticated;
revoke execute on function private.valid_encrypted_field(
  jsonb, uuid, text, integer, text, text, public.content_key_class,
  public.content_key_purpose, integer
) from public, anon, authenticated;
revoke execute on function private.valid_keyed_mac_field(
  text, text, public.content_key_class, public.content_key_purpose, integer
) from public, anon, authenticated;
revoke execute on function private.content_key_kms_context(
  uuid, public.content_key_class, public.content_key_purpose, text
) from public, anon, authenticated;
grant execute on function private.valid_content_envelope(
  jsonb, uuid, text, integer, text, text
) to service_role;
grant execute on function private.valid_encrypted_field(
  jsonb, uuid, text, integer, text, text, public.content_key_class,
  public.content_key_purpose, integer
) to service_role;
grant execute on function private.valid_keyed_mac_field(
  text, text, public.content_key_class, public.content_key_purpose, integer
) to service_role;
grant execute on function private.content_key_kms_context(
  uuid, public.content_key_class, public.content_key_purpose, text
) to service_role;

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
    or p_kms_key_id !~ '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$'
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
    if existing_key.key_class <> p_key_class
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
    user_id, key_id, key_class, key_purpose, key_version, kms_key_id,
    wrapped_intermediate_key, predecessor_key_id
  ) values (
    p_owner_id, p_key_id, p_key_class, p_key_purpose, p_key_version,
    p_kms_key_id, p_wrapped_intermediate_key,
    (
      select key_id
      from public.user_content_keys
      where user_id = p_owner_id
        and key_class = p_key_class
        and key_purpose = p_key_purpose
        and state = 'active'
    )
  );

  insert into public.content_encryption_rollouts (user_id)
  values (p_owner_id)
  on conflict (user_id) do nothing;

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

create or replace function public.activate_user_content_key(
  p_owner_id uuid,
  p_key_id text
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
    or p_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id and key_id = p_key_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_owner_id::text || ':' || key_row.key_class::text || ':'
        || key_row.key_purpose::text,
      0
    )
  );

  select * into key_row
  from public.user_content_keys
  where user_id = p_owner_id and key_id = p_key_id
  for update;

  if key_row.state = 'active' then
    return jsonb_build_object(
      'keyId', key_row.key_id,
      'keyClass', key_row.key_class,
      'keyPurpose', key_row.key_purpose,
      'keyVersion', key_row.key_version,
      'state', key_row.state,
      'replayed', true
    );
  end if;
  if key_row.state <> 'pending' then
    raise exception using errcode = 'P0001', message = 'invalid_key_state';
  end if;

  update public.user_content_keys
  set state = 'retired', retired_at = now()
  where user_id = p_owner_id
    and key_class = key_row.key_class
    and key_purpose = key_row.key_purpose
    and state = 'active';

  update public.user_content_keys
  set state = 'active', activated_at = now()
  where user_id = p_owner_id and key_id = p_key_id
  returning * into key_row;

  return jsonb_build_object(
    'keyId', key_row.key_id,
    'keyClass', key_row.key_class,
    'keyPurpose', key_row.key_purpose,
    'keyVersion', key_row.key_version,
    'state', key_row.state,
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

create or replace function public.create_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_embedding_model_id text,
  p_embedding_dimensions integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  eligible_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id !~ '^igen_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_embedding_model_id is null
    or char_length(p_embedding_model_id) not between 1 and 200
    or p_embedding_dimensions is null
    or p_embedding_dimensions not between 1 and 4096
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  insert into public.rag_index_generations (
    id, user_id, embedding_model_id, embedding_dimensions,
    expected_note_count
  ) values (
    p_generation_id, p_owner_id, p_embedding_model_id,
    p_embedding_dimensions, eligible_count
  )
  on conflict (id) do nothing
  returning * into generation_row;

  if not found then
    select * into generation_row
    from public.rag_index_generations
    where id = p_generation_id and user_id = p_owner_id;

    if not found
      or generation_row.embedding_model_id <> p_embedding_model_id
      or generation_row.embedding_dimensions <> p_embedding_dimensions
    then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;

    return jsonb_build_object(
      'generationId', generation_row.id,
      'state', generation_row.state,
      'expectedNoteCount', generation_row.expected_note_count,
      'revisionToken', generation_row.revision_token,
      'replayed', true
    );
  end if;

  return jsonb_build_object(
    'generationId', generation_row.id,
    'state', generation_row.state,
    'expectedNoteCount', generation_row.expected_note_count,
    'revisionToken', generation_row.revision_token,
    'replayed', false
  );
end;
$$;

create or replace function public.enqueue_note_index_job(
  p_owner_id uuid,
  p_note_id text,
  p_generation_id text,
  p_target_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.note_index_jobs%rowtype;
  eligible_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_note_id is null
    or p_generation_id is null
    or p_target_revision is null
    or p_target_revision < 1
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  -- Global lock order for stateful note-index work is note -> existing job ->
  -- generation. Claim only locks a job and never waits on either outer row.
  -- Keeping enqueue, commit, and note invalidation in this order serializes a
  -- privacy/revision transition with every operation that may publish an index.
  perform 1
  from public.notes as note
  where note.id = p_note_id
    and note.user_id = p_owner_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = p_target_revision
  for update of note;

  if not found then
    raise exception using errcode = '42501', message = 'ineligible_note_index_job';
  end if;

  select * into job_row
  from public.note_index_jobs
  where user_id = p_owner_id
    and note_id = p_note_id
    and generation_id = p_generation_id
    and target_revision = p_target_revision
  for update;

  perform 1
  from public.rag_index_generations as generation
  where generation.id = p_generation_id
    and generation.user_id = p_owner_id
    and generation.state in ('building', 'active')
  for update of generation;

  if not found then
    raise exception using errcode = '42501', message = 'ineligible_note_index_job';
  end if;

  if job_row.id is not null then
    return jsonb_build_object(
      'jobId', job_row.id,
      'indexResourceId', job_row.index_resource_id,
      'state', job_row.state,
      'replayed', true
    );
  end if;

  insert into public.note_index_jobs (
    user_id, note_id, generation_id, target_revision, index_resource_id
  ) values (
    p_owner_id, p_note_id, p_generation_id, p_target_revision,
    coalesce(
      (
        select id
        from public.note_rag_index
        where user_id = p_owner_id
          and note_id = p_note_id
          and generation_id = p_generation_id
      ),
      public.new_entity_id('irw')
    )
  )
  on conflict (note_id, generation_id, target_revision) do nothing
  returning * into job_row;

  if not found then
    select * into job_row
    from public.note_index_jobs
    where user_id = p_owner_id
      and note_id = p_note_id
      and generation_id = p_generation_id
      and target_revision = p_target_revision;

    if not found then
      raise exception using errcode = '42501', message = 'ineligible_note_index_job';
    end if;

    return jsonb_build_object(
      'jobId', job_row.id,
      'indexResourceId', job_row.index_resource_id,
      'state', job_row.state,
      'replayed', true
    );
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  update public.rag_index_generations
  set
    expected_note_count = eligible_count,
    revision_token = revision_token + 1
  where id = p_generation_id and user_id = p_owner_id;

  return jsonb_build_object(
    'jobId', job_row.id,
    'indexResourceId', job_row.index_resource_id,
    'state', job_row.state,
    'replayed', false
  );
end;
$$;

create or replace function public.claim_note_index_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result_value jsonb;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_worker_id is null
    or char_length(p_worker_id) not between 1 and 120
    or p_limit is null
    or p_limit not between 1 and 100
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  with candidates as (
    select job.id
    from public.note_index_jobs as job
    join public.notes as note
      on note.id = job.note_id and note.user_id = job.user_id
    join public.rag_index_generations as generation
      on generation.id = job.generation_id
      and generation.user_id = job.user_id
    where job.state = 'queued'
      and job.available_at <= now()
      and job.attempt < 5
      and note.deleted_at is null
      and note.privacy = 'ai_assisted'
      and note.current_revision = job.target_revision
      and generation.state in ('building', 'active')
    order by job.available_at, job.created_at, job.id
    limit p_limit
    for update of job skip locked
  ), claimed as (
    update public.note_index_jobs as job
    set
      state = 'leased',
      attempt = job.attempt + 1,
      lease_owner = p_worker_id,
      lease_token = extensions.gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = now(),
      last_error_code = null
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'jobId', claimed.id,
        'userId', claimed.user_id,
        'noteId', claimed.note_id,
        'generationId', claimed.generation_id,
        'targetRevision', claimed.target_revision,
        'indexResourceId', claimed.index_resource_id,
        'attempt', claimed.attempt,
        'leaseToken', claimed.lease_token,
        'leaseExpiresAt', claimed.lease_expires_at
      ) order by claimed.available_at, claimed.created_at, claimed.id
    ),
    '[]'::jsonb
  ) into result_value
  from claimed;

  return jsonb_build_object('jobs', result_value);
end;
$$;

create or replace function public.heartbeat_note_index_job(
  p_job_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.note_index_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_lease_token is null
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 900
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  update public.note_index_jobs
  set
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    last_heartbeat_at = now()
  where id = p_job_id
    and state = 'leased'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into job_row;

  if not found then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  return jsonb_build_object(
    'jobId', job_row.id,
    'leaseExpiresAt', job_row.lease_expires_at
  );
end;
$$;

create or replace function public.commit_note_rag_index(
  p_job_id text,
  p_lease_token uuid,
  p_index_id text,
  p_index_envelope jsonb,
  p_index_key_id text,
  p_index_key_class public.content_key_class,
  p_index_key_purpose public.content_key_purpose,
  p_index_key_version integer,
  p_encrypted_byte_length integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  preliminary_owner_id uuid;
  preliminary_note_id text;
  note_row public.notes%rowtype;
  job_row public.note_index_jobs%rowtype;
  generation_row public.rag_index_generations%rowtype;
  request_hash_value text;
  stored_index_id text;
  coverage_count integer;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_lease_token is null
    or p_index_id !~ '^irw_[0-9A-HJKMNP-TV-Z]{26}$'
    or p_index_envelope is null
    or p_index_key_id is null
    or p_index_key_class <> 'ai_assisted'
    or p_index_key_purpose <> 'object_wrap'
    or p_index_key_version is null
    or p_index_key_version < 1
    or p_encrypted_byte_length is null
    or p_encrypted_byte_length not between 16 and 262160
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  request_hash_value := private.request_hash(jsonb_build_object(
    'indexId', p_index_id,
    'indexEnvelope', p_index_envelope,
    'indexKeyId', p_index_key_id,
    'indexKeyClass', p_index_key_class,
    'indexKeyPurpose', p_index_key_purpose,
    'indexKeyVersion', p_index_key_version,
    'encryptedByteLength', p_encrypted_byte_length
  ));

  -- The unlocked read is only an address lookup. Revalidate that exact address
  -- after taking the authoritative note lock, then take the job and generation
  -- locks in the same order as enqueue and note invalidation. A note update or
  -- delete that wins first is visible after the wait; one that starts later
  -- cannot complete its invalidation until this transaction publishes or exits.
  select job.user_id, job.note_id
  into preliminary_owner_id, preliminary_note_id
  from public.note_index_jobs as job
  where job.id = p_job_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into note_row
  from public.notes as note
  where note.id = preliminary_note_id
    and note.user_id = preliminary_owner_id
  for update of note;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into job_row
  from public.note_index_jobs as job
  where job.id = p_job_id
    and job.user_id = preliminary_owner_id
    and job.note_id = preliminary_note_id
  for update of job;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select * into generation_row
  from public.rag_index_generations as generation
  where generation.id = job_row.generation_id
    and generation.user_id = job_row.user_id
  for update of generation;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if job_row.state = 'succeeded' then
    if job_row.last_transition_lease_token = p_lease_token
      and job_row.last_transition_action = 'succeeded'
      and job_row.last_transition_request_hash = request_hash_value
    then
      return jsonb_build_object(
        'jobId', job_row.id,
        'indexId', job_row.result_index_id,
        'committed', true,
        'replayed', true
      );
    end if;
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if job_row.state <> 'leased'
    or job_row.lease_token <> p_lease_token
    or job_row.lease_expires_at <= now()
  then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  if p_index_id <> job_row.index_resource_id then
    raise exception using errcode = '22023', message = 'invalid_index_resource';
  end if;

  if note_row.id <> job_row.note_id
    or note_row.user_id <> job_row.user_id
    or note_row.deleted_at is not null
    or note_row.privacy <> 'ai_assisted'
    or note_row.current_revision <> job_row.target_revision
    or generation_row.id <> job_row.generation_id
    or generation_row.user_id <> job_row.user_id
    or generation_row.state not in ('building', 'active')
  then
    update public.note_index_jobs
    set
      state = 'failed',
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = p_lease_token,
      last_transition_action = 'failed',
      last_transition_request_hash = request_hash_value,
      last_error_code = case
        when note_row.deleted_at is not null or note_row.privacy <> 'ai_assisted'
          then 'validation_failed'::public.safe_error_code
        else 'stale_revision'::public.safe_error_code
      end
    where id = job_row.id;

    return jsonb_build_object(
      'jobId', job_row.id,
      'committed', false,
      'errorCode', case
        when note_row.deleted_at is not null or note_row.privacy <> 'ai_assisted'
          then 'validation_failed'
        else 'stale_revision'
      end,
      'replayed', false
    );
  end if;

  if not private.valid_content_envelope(
    p_index_envelope,
    job_row.user_id,
    p_index_id,
    job_row.target_revision,
    'note_rag_index',
    p_index_key_id
  ) then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  insert into public.note_rag_index (
    id, user_id, note_id, generation_id, indexed_revision, index_envelope,
    index_key_id, index_key_class, index_key_purpose, index_key_version,
    encrypted_byte_length
  ) values (
    p_index_id, job_row.user_id, job_row.note_id, job_row.generation_id,
    job_row.target_revision, p_index_envelope, p_index_key_id,
    p_index_key_class, p_index_key_purpose, p_index_key_version,
    p_encrypted_byte_length
  )
  on conflict (note_id, generation_id) do update
  set
    indexed_revision = excluded.indexed_revision,
    index_envelope = excluded.index_envelope,
    index_key_id = excluded.index_key_id,
    index_key_class = excluded.index_key_class,
    index_key_purpose = excluded.index_key_purpose,
    index_key_version = excluded.index_key_version,
    encrypted_byte_length = excluded.encrypted_byte_length
  where public.note_rag_index.user_id = excluded.user_id
    and public.note_rag_index.indexed_revision <= excluded.indexed_revision
  returning id into stored_index_id;

  if stored_index_id is null then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  update public.note_index_jobs
  set
    state = 'succeeded',
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = p_lease_token,
    last_transition_action = 'succeeded',
    last_transition_request_hash = request_hash_value,
    result_index_id = stored_index_id,
    last_error_code = null
  where id = job_row.id;

  select count(*)::integer into coverage_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id and note.user_id = index_row.user_id
  where index_row.generation_id = job_row.generation_id
    and index_row.user_id = job_row.user_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = index_row.indexed_revision;

  update public.rag_index_generations
  set
    indexed_note_count = least(expected_note_count, coverage_count),
    revision_token = revision_token + 1
  where id = job_row.generation_id and user_id = job_row.user_id;

  return jsonb_build_object(
    'jobId', job_row.id,
    'indexId', stored_index_id,
    'committed', true,
    'replayed', false
  );
end;
$$;

create or replace function public.fail_note_index_job(
  p_job_id text,
  p_lease_token uuid,
  p_error_code public.safe_error_code,
  p_retryable boolean,
  p_retry_delay_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_row public.note_index_jobs%rowtype;
  request_hash_value text;
  next_state public.note_index_job_state;
  transition_action text;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_job_id is null
    or p_lease_token is null
    or p_error_code is null
    or p_retryable is null
    or p_retry_delay_seconds is null
    or p_retry_delay_seconds not between 0 and 86400
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  request_hash_value := private.request_hash(jsonb_build_object(
    'errorCode', p_error_code,
    'retryable', p_retryable,
    'retryDelaySeconds', p_retry_delay_seconds
  ));

  select * into job_row
  from public.note_index_jobs
  where id = p_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  if job_row.state <> 'leased' then
    if job_row.last_transition_lease_token = p_lease_token
      and job_row.last_transition_request_hash = request_hash_value
      and job_row.last_transition_action in ('retried', 'failed')
    then
      return jsonb_build_object(
        'jobId', job_row.id,
        'state', job_row.state,
        'replayed', true
      );
    end if;
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
  end if;

  if job_row.lease_token <> p_lease_token or job_row.lease_expires_at <= now() then
    raise exception using errcode = '42501', message = 'invalid_or_expired_lease';
  end if;

  next_state := case
    when p_retryable and job_row.attempt < 5 then 'queued'::public.note_index_job_state
    else 'failed'::public.note_index_job_state
  end;
  transition_action := case when next_state = 'queued' then 'retried' else 'failed' end;

  update public.note_index_jobs
  set
    state = next_state,
    available_at = case
      when next_state = 'queued'
        then now() + make_interval(secs => p_retry_delay_seconds)
      else available_at
    end,
    lease_owner = null,
    lease_token = null,
    lease_expires_at = null,
    last_heartbeat_at = null,
    last_transition_lease_token = p_lease_token,
    last_transition_action = transition_action,
    last_transition_request_hash = request_hash_value,
    last_error_code = p_error_code
  where id = job_row.id;

  return jsonb_build_object(
    'jobId', job_row.id,
    'state', next_state,
    'replayed', false
  );
end;
$$;

create or replace function public.recover_stale_note_index_jobs(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovered_count integer;
  failed_count integer;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  with stale as (
    select
      job.id,
      job.lease_token,
      job.attempt,
      exists (
        select 1
        from public.notes as note
        join public.rag_index_generations as generation
          on generation.id = job.generation_id
          and generation.user_id = job.user_id
        where note.id = job.note_id
          and note.user_id = job.user_id
          and note.deleted_at is null
          and note.privacy = 'ai_assisted'
          and note.current_revision = job.target_revision
          and generation.state in ('building', 'active')
      ) as still_eligible
    from public.note_index_jobs as job
    where job.state = 'leased' and job.lease_expires_at <= now()
    order by job.lease_expires_at, job.id
    limit p_limit
    for update of job skip locked
  ), recovered as (
    update public.note_index_jobs as job
    set
      state = case
        when stale.attempt < 5 and stale.still_eligible
          then 'queued'::public.note_index_job_state
        else 'failed'::public.note_index_job_state
      end,
      available_at = case
        when stale.attempt < 5 and stale.still_eligible then now()
        else job.available_at
      end,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      last_heartbeat_at = null,
      last_transition_lease_token = stale.lease_token,
      last_transition_action = 'recovered',
      last_transition_request_hash = private.request_hash(jsonb_build_object(
        'action', 'recover', 'leaseToken', stale.lease_token
      )),
      last_error_code = case
        when stale.attempt < 5 and stale.still_eligible
          then 'provider_unavailable'::public.safe_error_code
        else 'validation_failed'::public.safe_error_code
      end
    from stale
    where job.id = stale.id
    returning job.state
  )
  select
    count(*) filter (where state = 'queued')::integer,
    count(*) filter (where state = 'failed')::integer
  into recovered_count, failed_count
  from recovered;

  return jsonb_build_object(
    'recoveredCount', coalesce(recovered_count, 0),
    'failedCount', coalesce(failed_count, 0)
  );
end;
$$;

create or replace function public.activate_rag_index_generation(
  p_owner_id uuid,
  p_generation_id text,
  p_expected_revision_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  generation_row public.rag_index_generations%rowtype;
  eligible_count integer;
  covered_count integer;
  total_index_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_generation_id is null
    or p_expected_revision_token is null
    or p_expected_revision_token < 0
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select * into generation_row
  from public.rag_index_generations
  where id = p_generation_id and user_id = p_owner_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;
  if generation_row.state = 'active'
    and generation_row.revision_token = p_expected_revision_token + 1
  then
    return jsonb_build_object(
      'generationId', generation_row.id,
      'revisionToken', generation_row.revision_token,
      'replayed', true
    );
  end if;
  if generation_row.state <> 'building'
    or generation_row.revision_token <> p_expected_revision_token
  then
    raise exception using errcode = 'P0001', message = 'stale_revision';
  end if;

  select count(*)::integer into eligible_count
  from public.notes
  where user_id = p_owner_id
    and privacy = 'ai_assisted'
    and deleted_at is null;

  select
    count(*) filter (
      where note.deleted_at is null
        and note.privacy = 'ai_assisted'
        and note.current_revision = index_row.indexed_revision
    )::integer,
    count(*)::integer
  into covered_count, total_index_count
  from public.note_rag_index as index_row
  join public.notes as note
    on note.id = index_row.note_id and note.user_id = index_row.user_id
  where index_row.generation_id = p_generation_id
    and index_row.user_id = p_owner_id;

  if generation_row.expected_note_count <> eligible_count
    or covered_count <> eligible_count
    or total_index_count <> eligible_count
    or exists (
      select 1 from public.note_index_jobs
      where generation_id = p_generation_id
        and user_id = p_owner_id
        and state in ('queued', 'leased')
    )
  then
    raise exception using errcode = 'P0001', message = 'incomplete_index_coverage';
  end if;

  update public.rag_index_generations
  set state = 'retired', retired_at = now(), revision_token = revision_token + 1
  where user_id = p_owner_id and state = 'active' and id <> p_generation_id;

  update public.rag_index_generations
  set
    state = 'active',
    indexed_note_count = covered_count,
    activated_at = now(),
    revision_token = revision_token + 1
  where id = p_generation_id and user_id = p_owner_id
  returning * into generation_row;

  return jsonb_build_object(
    'generationId', generation_row.id,
    'revisionToken', generation_row.revision_token,
    'replayed', false
  );
end;
$$;

create or replace function public.list_active_note_rag_index(
  p_owner_id uuid,
  p_after_id text default null,
  p_limit integer default 25
)
returns table (
  index_id text,
  note_id text,
  generation_id text,
  indexed_revision integer,
  index_envelope jsonb,
  index_key_id text,
  index_key_class public.content_key_class,
  index_key_purpose public.content_key_purpose,
  index_key_version integer,
  embedding_model_id text,
  embedding_dimensions integer,
  generation_revision_token bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'unfiled_index_worker'
  then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  return query
  select
    index_row.id,
    index_row.note_id,
    index_row.generation_id,
    index_row.indexed_revision,
    index_row.index_envelope,
    index_row.index_key_id,
    index_row.index_key_class,
    index_row.index_key_purpose,
    index_row.index_key_version,
    generation.embedding_model_id,
    generation.embedding_dimensions,
    generation.revision_token
  from public.note_rag_index as index_row
  join public.rag_index_generations as generation
    on generation.id = index_row.generation_id
    and generation.user_id = index_row.user_id
    and generation.state = 'active'
  join public.notes as note
    on note.id = index_row.note_id
    and note.user_id = index_row.user_id
    and note.deleted_at is null
    and note.privacy = 'ai_assisted'
    and note.current_revision = index_row.indexed_revision
  where index_row.user_id = p_owner_id
    and (p_after_id is null or index_row.id > p_after_id)
  order by index_row.id
  limit p_limit;
end;
$$;

revoke execute on function public.register_user_content_key(
  uuid, text, public.content_key_class, public.content_key_purpose,
  integer, text, bytea
) from public, anon, authenticated;
revoke execute on function public.activate_user_content_key(
  uuid, text
) from public, anon, authenticated;
revoke execute on function public.rewrap_user_content_key(
  uuid, text, text, integer, text, bytea
) from public, anon, authenticated, unfiled_index_worker;
revoke execute on function public.create_rag_index_generation(
  uuid, text, text, integer
) from public, anon, authenticated;
revoke execute on function public.enqueue_note_index_job(
  uuid, text, text, integer
) from public, anon, authenticated;
revoke execute on function public.claim_note_index_jobs(
  text, integer, integer
) from public, anon, authenticated;
revoke execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) from public, anon, authenticated;
revoke execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) from public, anon, authenticated;
revoke execute on function public.fail_note_index_job(
  text, uuid, public.safe_error_code, boolean, integer
) from public, anon, authenticated;
revoke execute on function public.recover_stale_note_index_jobs(
  integer
) from public, anon, authenticated;
revoke execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) from public, anon, authenticated;
revoke execute on function public.list_active_note_rag_index(
  uuid, text, integer
) from public, anon, authenticated;

grant execute on function public.register_user_content_key(
  uuid, text, public.content_key_class, public.content_key_purpose,
  integer, text, bytea
) to service_role;
grant execute on function public.activate_user_content_key(
  uuid, text
) to service_role;
grant execute on function public.rewrap_user_content_key(
  uuid, text, text, integer, text, bytea
) to service_role;
grant execute on function public.create_rag_index_generation(
  uuid, text, text, integer
) to service_role;
grant execute on function public.enqueue_note_index_job(
  uuid, text, text, integer
) to service_role;
grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to service_role;
grant execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) to service_role;
grant execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) to service_role;
grant execute on function public.fail_note_index_job(
  text, uuid, public.safe_error_code, boolean, integer
) to service_role;
grant execute on function public.recover_stale_note_index_jobs(
  integer
) to service_role;
grant execute on function public.activate_rag_index_generation(
  uuid, text, bigint
) to service_role;
grant execute on function public.list_active_note_rag_index(
  uuid, text, integer
) to service_role;

-- The worker's database authority is an RPC capability, never a Supabase
-- service key. It may resolve public function names but cannot read or mutate
-- any relation, use a sequence, create public objects, or enter private.
revoke all privileges on all tables in schema public
from unfiled_index_worker;
revoke all privileges on all sequences in schema public
from unfiled_index_worker;
revoke all privileges on all tables in schema private
from unfiled_index_worker;
revoke all privileges on all sequences in schema private
from unfiled_index_worker;
revoke execute on all functions in schema public
from unfiled_index_worker;
revoke execute on all functions in schema private
from unfiled_index_worker;
revoke all privileges on schema private
from unfiled_index_worker;
revoke create on schema public
from unfiled_index_worker;
grant usage on schema public
to unfiled_index_worker;

grant execute on function public.claim_note_index_jobs(
  text, integer, integer
) to unfiled_index_worker;
grant execute on function public.heartbeat_note_index_job(
  text, uuid, integer
) to unfiled_index_worker;
grant execute on function public.commit_note_rag_index(
  text, uuid, text, jsonb, text, public.content_key_class,
  public.content_key_purpose, integer, integer
) to unfiled_index_worker;
grant execute on function public.fail_note_index_job(
  text, uuid, public.safe_error_code, boolean, integer
) to unfiled_index_worker;
grant execute on function public.recover_stale_note_index_jobs(
  integer
) to unfiled_index_worker;
grant execute on function public.list_active_note_rag_index(
  uuid, text, integer
) to unfiled_index_worker;
