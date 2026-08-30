create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

select plan(80);

-- Milestone B write surfaces are RPC-only. Check every formerly client-writable
-- table and each DML privilege independently so partial grant regressions fail.
select ok(
  not has_table_privilege('authenticated', format('public.%I', target.table_name), target.privilege),
  format('%s rejects direct authenticated %s', target.table_name, target.privilege)
)
from (
  select table_name, privilege
  from unnest(array[
    'spaces',
    'notes',
    'note_revisions',
    'captures',
    'generated_blocks',
    'capture_note_links',
    'routing_rules',
    'review_items',
    'tags',
    'note_tags',
    'note_links',
    'organization_mutation_attempts',
    'auth_otp_quota_events'
  ]) as table_name
  cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as privilege
) as target;

select ok(
  not has_table_privilege(
    'authenticated',
    'public.api_idempotency_records',
    target.privilege
  ),
  format('api_idempotency_records rejects authenticated %s', target.privilege)
)
from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as target(privilege);

select ok(
  has_function_privilege(
    'authenticated',
    'public.update_tag(text,integer,text,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.update_tag(text,integer,text,text)',
    'EXECUTE'
  ),
  'the reviewed tag update RPC is authenticated-only'
);

-- Anonymous users have no table-level read surface. Public product reads start
-- only after an authenticated JWT is present and are then constrained by RLS.
select ok(
  not has_table_privilege('anon', format('public.%I', table_name), 'SELECT'),
  format('%s rejects anonymous SELECT', table_name)
)
from unnest(array[
  'profiles',
  'user_provider_keys',
  'spaces',
  'notes',
  'note_revisions',
  'captures',
  'organization_jobs',
  'organization_decisions',
  'note_mutations',
  'generated_blocks',
  'capture_note_links',
  'routing_rules',
  'review_items',
  'note_chunks',
  'tags',
  'note_tags',
  'note_links',
  'feedback_events',
  'user_events',
  'api_idempotency_records',
  'organization_mutation_attempts',
  'auth_otp_quota_events'
]) as table_name;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

-- Runtime checks guard against an accidental policy/grant combination that a
-- catalog-only assertion could overlook.
select throws_ok($$insert into public.notes (id) values ('note_74000000000000000000000001')$$, '42501', 'permission denied for table notes', 'notes runtime INSERT denial');
select throws_ok($$update public.notes set title = 'forged' where id = 'note_00000000000000000000000001'$$, '42501', 'permission denied for table notes', 'notes runtime UPDATE denial');
select throws_ok($$delete from public.notes where id = 'note_00000000000000000000000001'$$, '42501', 'permission denied for table notes', 'notes runtime DELETE denial');
select throws_ok($$insert into public.spaces (id) values ('spc_74000000000000000000000001')$$, '42501', 'permission denied for table spaces', 'spaces runtime INSERT denial');
select throws_ok($$update public.spaces set name = 'forged' where id = 'spc_00000000000000000000000001'$$, '42501', 'permission denied for table spaces', 'spaces runtime UPDATE denial');
select throws_ok($$insert into public.tags (id) values ('tag_74000000000000000000000001')$$, '42501', 'permission denied for table tags', 'tags runtime INSERT denial');
select throws_ok($$update public.tags set name = 'forged' where id = 'tag_00000000000000000000000001'$$, '42501', 'permission denied for table tags', 'tags runtime UPDATE denial');
select throws_ok($$insert into public.note_tags (note_id, tag_id, user_id) values ('note_00000000000000000000000001', 'tag_00000000000000000000000001', '11111111-1111-4111-8111-111111111111')$$, '42501', 'permission denied for table note_tags', 'note_tags runtime INSERT denial');
select throws_ok($$insert into public.note_links (id) values ('lnk_74000000000000000000000001')$$, '42501', 'permission denied for table note_links', 'note_links runtime INSERT denial');
select throws_ok($$insert into public.note_revisions (id) values ('rev_74000000000000000000000001')$$, '42501', 'permission denied for table note_revisions', 'note_revisions runtime INSERT denial');
select throws_ok($$insert into public.generated_blocks (id) values ('blk_74000000000000000000000001')$$, '42501', 'permission denied for table generated_blocks', 'workflow runtime INSERT denial');
select throws_ok($$select * from public.api_idempotency_records$$, '42501', 'permission denied for table api_idempotency_records', 'idempotency ledger runtime read denial');
select throws_ok($$insert into public.organization_mutation_attempts (job_id) values ('job_74000000000000000000000001')$$, '42501', 'permission denied for table organization_mutation_attempts', 'organization attempt runtime INSERT denial');
select throws_ok($$insert into public.auth_otp_quota_events (email_hash) values (repeat('a', 64))$$, '42501', 'permission denied for table auth_otp_quota_events', 'OTP quota runtime INSERT denial');

select * from finish();
rollback;
