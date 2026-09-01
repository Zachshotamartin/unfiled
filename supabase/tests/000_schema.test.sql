create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

select plan(27);

select has_table('public', 'profiles', 'profiles exists after applying migrations from zero');
select has_table('public', 'captures', 'captures exists after applying migrations from zero');
select has_table('public', 'user_events', 'sync cursor event table exists');
select has_table('public', 'api_idempotency_records', 'server idempotency ledger exists');
select has_table('public', 'organization_mutation_attempts', 'delayed organization attempt state exists');
select has_table('public', 'auth_otp_quota_events', 'durable hashed OTP quota state exists');
select has_type('public', 'capture_source', 'capture source enum exists');
select ok(
  exists (
    select 1
    from pg_enum as enum_value
    join pg_type as enum_type on enum_type.oid = enum_value.enumtypid
    join pg_namespace as enum_schema on enum_schema.oid = enum_type.typnamespace
    where enum_schema.nspname = 'public'
      and enum_type.typname = 'capture_source'
      and enum_value.enumlabel = 'ios_lock_screen_widget'
  ),
  'capture source accepts the Lock Screen widget'
);
select is(
  (
    select array_agg(enum_value.enumlabel order by enum_value.enumsortorder)::text
    from pg_enum as enum_value
    join pg_type as enum_type on enum_type.oid = enum_value.enumtypid
    join pg_namespace as enum_schema on enum_schema.oid = enum_type.typnamespace
    where enum_schema.nspname = 'public'
      and enum_type.typname = 'safe_error_code'
  ),
  '{account_deletion_failed,budget_exhausted,capture_too_long,conflict_requires_review,forbidden,invalid_capture,invalid_idempotency_key,invalid_plan,not_found,offline,provider_key_invalid,provider_unavailable,rate_limited,stale_revision,structure_conflict,unauthorized,validation_failed}',
  'safe_error_code exactly matches the shared ApiErrorCode contract'
);
select ok(
  to_regprocedure('public.create_capture_with_job(uuid,jsonb)') is not null,
  'owner-bound atomic capture function exists'
);
select ok(
  to_regprocedure(
    'public.apply_delayed_organization_mutation(text,text,integer,jsonb,text)'
  ) is null,
  'the unfenced delayed organization signature is absent'
);
select ok(
  to_regprocedure(
    'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)'
  ) is not null,
  'the lease-token delayed organization signature exists'
);
select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as relation_schema on relation_schema.oid = relation.relnamespace
    where relation_schema.nspname = 'public'
      and relation.relname = any (
        array[
          'profiles', 'user_provider_keys', 'spaces', 'notes', 'note_revisions',
          'captures', 'organization_jobs', 'organization_decisions',
          'note_mutations', 'generated_blocks', 'capture_note_links',
          'routing_rules', 'review_items', 'note_chunks', 'tags', 'note_tags',
          'note_links', 'feedback_events', 'user_events',
          'api_idempotency_records', 'organization_mutation_attempts', 'capture_receipts',
          'auth_otp_quota_events', 'organization_job_ai_settings',
          'organization_job_rule_matches', 'feedback_event_mutations',
          'encrypted_owner_interaction_claims',
          'encrypted_owner_interaction_members',
          'encrypted_owner_interaction_reservations',
          'encrypted_mutation_batches', 'encrypted_mutation_batch_members'
        ]
      )
      and relation.relrowsecurity
  ),
  31::bigint,
  'RLS is enabled on every exposed or service-owned table'
);
select is(
  (
    select array_agg(
      tablename || ':' || policyname || ':' || cmd
      order by tablename, policyname
    )::text
    from pg_policies
    where schemaname = 'public'
  ),
  '{capture_note_links:capture_note_links_select:SELECT,captures:captures_select:SELECT,feedback_events:feedback_events_select:SELECT,generated_blocks:generated_blocks_select:SELECT,note_chunks:note_chunks_select:SELECT,note_links:note_links_select:SELECT,note_mutations:note_mutations_select:SELECT,note_revisions:note_revisions_select:SELECT,note_tags:note_tags_select:SELECT,notes:notes_select:SELECT,organization_decisions:organization_decisions_select:SELECT,organization_mutation_attempts:organization_mutation_attempts_select_own:SELECT,profiles:profiles_delete:DELETE,profiles:profiles_insert:INSERT,profiles:profiles_select:SELECT,profiles:profiles_update:UPDATE,review_items:review_items_select:SELECT,routing_rules:routing_rules_select:SELECT,spaces:spaces_select:SELECT,tags:tags_select:SELECT,user_events:user_events_select:SELECT}',
  'the exact RPC-only capture, queue, and owner-scoped policy identities are installed'
);
select ok(
  has_table_privilege('authenticated', 'public.notes', 'SELECT'),
  'authenticated users may read RLS-filtered notes'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_provider_keys', 'SELECT'),
  'provider key storage has no client read grant'
);
select ok(
  not has_table_privilege('authenticated', 'public.organization_jobs', 'INSERT'),
  'organization jobs reject direct client writes'
);
select ok(
  not has_table_privilege('authenticated', 'public.captures', 'INSERT'),
  'captures reject direct client inserts'
);
select ok(
  not has_table_privilege('authenticated', 'public.captures', 'UPDATE'),
  'captures reject direct client updates'
);
select ok(
  not has_table_privilege('authenticated', 'public.note_revisions', 'UPDATE'),
  'revision history rejects direct client updates'
);
select ok(
  not has_table_privilege('authenticated', 'public.note_revisions', 'DELETE'),
  'revision history rejects direct client deletes'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_capture_with_job(uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients cannot bypass the owner-bound capture service'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.create_capture_with_job(uuid,jsonb)',
    'EXECUTE'
  ),
  'the server service may execute the owner-bound capture function'
);
select ok(
  to_regprocedure('public.apply_user_note_mutation(text,integer,jsonb,text)') is not null,
  'reviewed expected-revision note mutation function exists'
);

insert into public.notes (
  id, user_id, space_id, type, title, structured_data, daily_date
)
values (
  'note_72000000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  null,
  'list',
  'Root daily singleton fixture',
  '{"schemaVersion":1,"items":[]}'::jsonb,
  '2026-09-01'
);
select throws_ok(
  $$
    insert into public.notes (
      id, user_id, space_id, type, title, structured_data, daily_date
    )
    values (
      'note_72000000000000000000000002',
      '11111111-1111-4111-8111-111111111111',
      null,
      'list',
      'Duplicate root daily singleton fixture',
      '{"schemaVersion":1,"items":[]}'::jsonb,
      '2026-09-01'
    )
  $$,
  '23505',
  'duplicate key value violates unique constraint "notes_daily_singleton"',
  'root-level daily notes cannot bypass singleton uniqueness through null space_id'
);
select throws_ok(
  $$
    update public.captures
    set last_error_code = 'openai_http_500_raw'
    where id = 'cap_00000000000000000000000001'
  $$,
  '22P02',
  'invalid input value for enum safe_error_code: "openai_http_500_raw"',
  'captures reject raw provider or internal error strings'
);
select throws_ok(
  $$
    update public.organization_jobs
    set error_code = 'provider_response_body_raw'
    where id = 'job_00000000000000000000000001'
  $$,
  '22P02',
  'invalid input value for enum safe_error_code: "provider_response_body_raw"',
  'organization jobs reject raw provider or internal error strings'
);

select * from finish();
rollback;
