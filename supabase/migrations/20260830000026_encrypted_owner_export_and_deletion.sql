-- Milestone C.5d-6: owner-authorized encrypted export coordinates and live
-- account deletion. Export projections contain only operational identifiers;
-- all content stays in authenticated envelopes until the interactive web
-- runtime opens it. Deletion is serialized with every encrypted owner write,
-- removes the auth principal (and therefore every owner FK cascade), and
-- retains only bounded, pseudonymous, content-free audit evidence.

create table public.account_deletion_receipts (
  idempotency_digest text primary key
    check (idempotency_digest ~ '^[0-9a-f]{64}$'),
  owner_binding_digest text not null
    check (owner_binding_digest ~ '^[0-9a-f]{64}$'),
  deleted_at timestamptz not null,
  backup_expires_at timestamptz not null,
  receipt_expires_at timestamptz not null,
  deleted_record_counts jsonb not null
    check (jsonb_typeof(deleted_record_counts) = 'object'),
  check (backup_expires_at = deleted_at + interval '30 days'),
  check (receipt_expires_at = deleted_at + interval '31 days')
);

create index account_deletion_receipts_expiry
  on public.account_deletion_receipts (receipt_expires_at);

create table public.account_deletion_receipt_lookup_events (
  event_id bigint generated always as identity primary key,
  requester_digest text not null check (requester_digest ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz not null default clock_timestamp()
);

create index account_deletion_receipt_lookup_events_window
  on public.account_deletion_receipt_lookup_events (requester_digest, attempted_at);

alter table public.account_deletion_receipts enable row level security;
alter table public.account_deletion_receipts force row level security;
alter table public.account_deletion_receipt_lookup_events enable row level security;
alter table public.account_deletion_receipt_lookup_events force row level security;
revoke all on table public.account_deletion_receipts
  from public, anon, authenticated, service_role;
revoke all on table public.account_deletion_receipt_lookup_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.account_deletion_receipt_lookup_events_event_id_seq
  from public, anon, authenticated, service_role;

create or replace function private.purge_expired_account_deletion_receipts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  purged_count integer;
begin
  delete from public.account_deletion_receipts
  where receipt_expires_at <= statement_timestamp();
  get diagnostics purged_count = row_count;
  return purged_count;
end;
$$;

create or replace function private.account_deletion_receipt(
  receipt_value public.account_deletion_receipts,
  replayed_value boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'deletedAt', receipt_value.deleted_at,
    'backupExpiresAt', receipt_value.backup_expires_at,
    'receiptExpiresAt', receipt_value.receipt_expires_at,
    'backupRetentionDays', 30,
    'liveDataDeleted', true,
    'sessionsRevoked', true,
    'reRegistrationStartsFresh', true,
    'deletedRecordCounts', receipt_value.deleted_record_counts,
    'replayed', replayed_value
  );
$$;

-- Discover every current public owner table by user_id so adding another
-- owner-scoped table cannot silently weaken either the audit or postcondition.
-- Alternate owner coordinates are intentionally enumerated and named in the
-- evidence rather than hidden inside one aggregate total.
create or replace function private.owner_public_data_counts(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_table record;
  table_count bigint;
  counts_value jsonb := '{}'::jsonb;
begin
  for owner_table in
    select distinct namespace.nspname as schema_name, relation.relname as table_name
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = relation.oid
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and attribute.attname = 'user_id'
      and not attribute.attisdropped
    order by relation.relname
  loop
    execute pg_catalog.format(
      'select count(*)::bigint from %I.%I where user_id::text = $1::text',
      owner_table.schema_name,
      owner_table.table_name
    ) into table_count using p_owner_id;
    counts_value := counts_value || jsonb_build_object(
      'public.' || owner_table.table_name, table_count
    );
  end loop;

  select count(*) into table_count from public.profiles where id = p_owner_id;
  counts_value := counts_value || jsonb_build_object('public.profiles', table_count);
  select count(*) into table_count
  from public.encrypted_note_retention_runs where requested_owner_id = p_owner_id;
  counts_value := counts_value || jsonb_build_object(
    'public.encrypted_note_retention_runs.requested_owner_id', table_count
  );
  select count(*) into table_count
  from public.rag_index_maintenance_checkpoints where after_owner_id = p_owner_id;
  counts_value := counts_value || jsonb_build_object(
    'public.rag_index_maintenance_checkpoints.after_owner_id', table_count
  );
  select count(*) into table_count
  from public.rag_index_maintenance_page_requests
  where response::text like '%' || p_owner_id::text || '%';
  counts_value := counts_value || jsonb_build_object(
    'public.rag_index_maintenance_page_requests.owner_reference', table_count
  );
  return counts_value;
end;
$$;

-- Supabase auth has more than the principal row. Dynamically count every auth
-- relation with user_id and explicitly count the principal. In particular,
-- auth.sessions and auth.identities must both be zero before the receipt can
-- truthfully state that all sessions were revoked.
create or replace function private.owner_auth_data_counts(p_owner_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_table record;
  table_count bigint;
  counts_value jsonb := '{}'::jsonb;
begin
  for owner_table in
    select distinct namespace.nspname as schema_name, relation.relname as table_name
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid = relation.oid
    where namespace.nspname = 'auth'
      and relation.relkind in ('r', 'p')
      and attribute.attname = 'user_id'
      and not attribute.attisdropped
    order by relation.relname
  loop
    execute pg_catalog.format(
      'select count(*)::bigint from %I.%I where user_id::text = $1::text',
      owner_table.schema_name,
      owner_table.table_name
    ) into table_count using p_owner_id;
    counts_value := counts_value || jsonb_build_object(
      'auth.' || owner_table.table_name, table_count
    );
  end loop;
  select count(*) into table_count from auth.users where id = p_owner_id;
  return counts_value || jsonb_build_object('auth.users', table_count);
end;
$$;

create or replace function private.account_deletion_counts_are_zero(counts_value jsonb)
returns boolean
language sql
immutable
strict
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from jsonb_each_text(counts_value) as item(key, value)
    where item.value::numeric <> 0
  );
$$;

-- Source-capture references are operational metadata. This exact, bounded
-- projection prevents export from querying relation tables directly or
-- accepting a partial/cross-owner note set.
create or replace function public.list_encrypted_export_note_sources(
  p_owner_id uuid,
  p_note_ids jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  requested_count integer;
  owned_count integer;
  items_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or jsonb_typeof(p_note_ids) <> 'array'
    or jsonb_array_length(p_note_ids) not between 1 and 50
    or exists (
      select 1 from jsonb_array_elements_text(p_note_ids) as item(value)
      where item.value !~ '^note_[0-9A-HJKMNP-TV-Z]{26}$'
    )
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select count(*), count(distinct value)
  into requested_count, owned_count
  from jsonb_array_elements_text(p_note_ids) as requested(value);
  if requested_count <> owned_count then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  select count(*) into owned_count
  from public.notes as note
  where note.user_id = p_owner_id
    and note.id in (select value from jsonb_array_elements_text(p_note_ids));
  if owned_count <> requested_count then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'noteId', note.id,
    'sourceCaptureIds', coalesce((
      select jsonb_agg(link.capture_id order by link.capture_id)
      from public.capture_note_links as link
      where link.user_id = p_owner_id and link.note_id = note.id
    ), '[]'::jsonb)
  ) order by note.id), '[]'::jsonb)
  into items_value
  from public.notes as note
  where note.user_id = p_owner_id
    and note.id in (select value from jsonb_array_elements_text(p_note_ids));

  return jsonb_build_object('items', items_value);
end;
$$;

-- This token-only lookup is deliberately content-free. It is the replay path
-- for a lost successful HTTP response: after principal deletion there is no
-- access token left to authenticate, so possession of the original 256-bit
-- deletion token is the sole bounded receipt capability. The web process
-- hashes that token before this RPC boundary; raw tokens are never SQL args.
-- Missing and expired digests both return the same not_found status.
create or replace function public.get_account_deletion_receipt(
  p_idempotency_digest text,
  p_requester_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_row public.account_deletion_receipts%rowtype;
  lookup_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_idempotency_digest is null
    or p_idempotency_digest !~ '^[0-9a-f]{64}$'
    or p_requester_digest is null
    or p_requester_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_requester_digest || ':account-deletion-receipt-lookup', 0
  ));
  delete from public.account_deletion_receipt_lookup_events
  where attempted_at < statement_timestamp() - interval '24 hours';
  select count(*) into lookup_count
  from public.account_deletion_receipt_lookup_events
  where requester_digest = p_requester_digest
    and attempted_at >= statement_timestamp() - interval '1 hour';
  if lookup_count >= 20 then
    -- Return a content-free status instead of raising. Raising would roll back
    -- the lookup ledger written by missing-token attempts and make the durable
    -- rate limit ineffective against brute-force retries.
    return jsonb_build_object('status', 'rate_limited');
  end if;
  insert into public.account_deletion_receipt_lookup_events (requester_digest)
  values (p_requester_digest);
  perform private.purge_expired_account_deletion_receipts();
  select * into receipt_row
  from public.account_deletion_receipts
  where idempotency_digest = p_idempotency_digest;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object(
    'status', 'found',
    'receipt', private.account_deletion_receipt(receipt_row, true)
  );
end;
$$;

create or replace function public.delete_encrypted_owner_account(
  p_owner_id uuid,
  p_idempotency_digest text,
  p_owner_binding_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_row public.account_deletion_receipts%rowtype;
  idempotency_digest_value text;
  deleted_at_value timestamptz;
  deleted_counts_value jsonb;
  remaining_counts_value jsonb;
  provider_secret_ids uuid[];
  remaining_provider_secret_count bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;
  if p_owner_id is null
    or p_idempotency_digest is null
    or p_idempotency_digest !~ '^[0-9a-f]{64}$'
    or p_owner_binding_digest is null
    or p_owner_binding_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'validation_failed';
  end if;

  perform private.purge_expired_account_deletion_receipts();
  idempotency_digest_value := p_idempotency_digest;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':account-deletion', 0
  ));

  select * into receipt_row
  from public.account_deletion_receipts
  where idempotency_digest = idempotency_digest_value
  for update;
  if found then
    if receipt_row.owner_binding_digest <> p_owner_binding_digest then
      raise exception using errcode = 'P0001', message = 'invalid_idempotency_key';
    end if;
    return private.account_deletion_receipt(receipt_row, true);
  end if;

  -- Every encrypted writer takes this owner lock before mutable rows. Holding
  -- it through principal deletion fences new writes, waits for in-flight work,
  -- and makes FK cascades the cancellation boundary for jobs and claims.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner_id::text || ':content-encryption-rollout', 0
  ));
  perform 1 from auth.users where id = p_owner_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'not_found';
  end if;

  deleted_counts_value := private.owner_public_data_counts(p_owner_id)
    || private.owner_auth_data_counts(p_owner_id);
  select coalesce(array_agg(distinct vault_secret_id), array[]::uuid[])
  into provider_secret_ids
  from public.user_provider_keys
  where user_id = p_owner_id and vault_secret_id is not null;
  deleted_counts_value := deleted_counts_value || jsonb_build_object(
    'vault.secrets', cardinality(provider_secret_ids)
  );

  -- Maintenance cursors are global rather than owner rows. Remove the deleted
  -- principal from their resumable coordinates and replay payloads.
  update public.rag_index_maintenance_checkpoints
  set after_owner_id = null
  where after_owner_id = p_owner_id;
  delete from public.rag_index_maintenance_page_requests
  where response::text like '%' || p_owner_id::text || '%';

  -- A production Vault secret is not owned by the auth FK graph. Delete it
  -- before provider-key locator rows disappear. Missing Vault capability fails
  -- closed whenever any live locator exists, and any surviving secret aborts
  -- the whole transaction.
  if cardinality(provider_secret_ids) > 0 then
    if pg_catalog.to_regclass('vault.secrets') is null then
      raise exception using errcode = 'P0001', message = 'provider_key_deletion_unavailable';
    end if;
    execute 'delete from vault.secrets where id = any($1)' using provider_secret_ids;
    execute 'select count(*)::bigint from vault.secrets where id = any($1)'
      into remaining_provider_secret_count using provider_secret_ids;
    if remaining_provider_secret_count <> 0 then
      raise exception using errcode = 'P0001', message = 'account_deletion_incomplete';
    end if;
  end if;

  -- GoTrue's flow_state and legacy refresh_tokens.user_id columns are not
  -- owner FKs. Remove those bearer/session artifacts explicitly before the
  -- principal cascade handles sessions, identities, MFA, and linked rows.
  delete from auth.flow_state where user_id = p_owner_id;
  delete from auth.refresh_tokens where user_id = p_owner_id::text;

  deleted_at_value := clock_timestamp();
  delete from auth.users where id = p_owner_id;

  remaining_counts_value := private.owner_public_data_counts(p_owner_id)
    || private.owner_auth_data_counts(p_owner_id)
    || jsonb_build_object('vault.secrets', 0);
  if not private.account_deletion_counts_are_zero(remaining_counts_value)
    or coalesce(remaining_counts_value ->> 'auth.sessions', '1') <> '0'
    or coalesce(remaining_counts_value ->> 'auth.identities', '1') <> '0'
    or coalesce(remaining_counts_value ->> 'auth.users', '1') <> '0'
  then
    raise exception using errcode = 'P0001', message = 'account_deletion_incomplete';
  end if;

  insert into public.account_deletion_receipts (
    idempotency_digest, owner_binding_digest, deleted_at, backup_expires_at,
    receipt_expires_at, deleted_record_counts
  ) values (
    idempotency_digest_value, p_owner_binding_digest, deleted_at_value,
    deleted_at_value + interval '30 days',
    deleted_at_value + interval '31 days', deleted_counts_value
  ) returning * into receipt_row;

  return private.account_deletion_receipt(receipt_row, false);
end;
$$;

revoke execute on function private.purge_expired_account_deletion_receipts()
  from public, anon, authenticated, service_role;
revoke execute on function private.account_deletion_receipt(
  public.account_deletion_receipts, boolean
) from public, anon, authenticated, service_role;
revoke execute on function private.owner_public_data_counts(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.owner_auth_data_counts(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function private.account_deletion_counts_are_zero(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.list_encrypted_export_note_sources(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.list_encrypted_export_note_sources(uuid, jsonb)
  to service_role;
revoke execute on function public.get_account_deletion_receipt(text, text)
  from public, anon, authenticated;
grant execute on function public.get_account_deletion_receipt(text, text)
  to service_role;
revoke execute on function public.delete_encrypted_owner_account(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_encrypted_owner_account(uuid, text, text)
  to service_role;
