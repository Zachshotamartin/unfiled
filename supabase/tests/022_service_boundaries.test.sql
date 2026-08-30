create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;

create function pg_temp.affected(statement text)
returns bigint
language plpgsql
as $$
declare
  affected_rows bigint;
begin
  execute statement;
  get diagnostics affected_rows = row_count;
  return affected_rows;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select plan(28);

-- BYOK ciphertext and Vault references have no direct client surface.
select throws_ok('select * from public.user_provider_keys', '42501', 'permission denied for table user_provider_keys', 'user_provider_keys rejects SELECT');
select throws_ok($$insert into public.user_provider_keys (id) values ('key_73000000000000000000000001')$$, '42501', 'permission denied for table user_provider_keys', 'user_provider_keys rejects INSERT');
select throws_ok($$update public.user_provider_keys set status = 'revoked'$$, '42501', 'permission denied for table user_provider_keys', 'user_provider_keys rejects UPDATE');
select throws_ok($$delete from public.user_provider_keys$$, '42501', 'permission denied for table user_provider_keys', 'user_provider_keys rejects DELETE');

-- Organization jobs are emitted and advanced only by reviewed server paths.
select throws_ok($$insert into public.organization_jobs (id) values ('job_73000000000000000000000001')$$, '42501', 'permission denied for table organization_jobs', 'organization_jobs rejects INSERT');
select throws_ok($$update public.organization_jobs set state = 'succeeded' where id = 'job_00000000000000000000000001'$$, '42501', 'permission denied for table organization_jobs', 'organization_jobs rejects UPDATE');
select throws_ok($$delete from public.organization_jobs where id = 'job_00000000000000000000000001'$$, '42501', 'permission denied for table organization_jobs', 'organization_jobs rejects DELETE');

-- Model decisions cannot be forged, rewritten, or erased by clients.
select throws_ok($$insert into public.organization_decisions (id) values ('dec_73000000000000000000000001')$$, '42501', 'permission denied for table organization_decisions', 'organization_decisions rejects INSERT');
select throws_ok($$update public.organization_decisions set band = 'auto' where id = 'dec_00000000000000000000000001'$$, '42501', 'permission denied for table organization_decisions', 'organization_decisions rejects UPDATE');
select throws_ok($$delete from public.organization_decisions where id = 'dec_00000000000000000000000001'$$, '42501', 'permission denied for table organization_decisions', 'organization_decisions rejects DELETE');

-- Mutation receipts are written only by the expected-revision mutation path.
select throws_ok($$insert into public.note_mutations (id) values ('mut_73000000000000000000000001')$$, '42501', 'permission denied for table note_mutations', 'note_mutations rejects INSERT');
select throws_ok($$update public.note_mutations set undone_at = now() where id = 'mut_00000000000000000000000001'$$, '42501', 'permission denied for table note_mutations', 'note_mutations rejects UPDATE');
select throws_ok($$delete from public.note_mutations where id = 'mut_00000000000000000000000001'$$, '42501', 'permission denied for table note_mutations', 'note_mutations rejects DELETE');

-- Derived search rows are workflow-owned.
select throws_ok($$insert into public.note_chunks (id) values ('chk_73000000000000000000000001')$$, '42501', 'permission denied for table note_chunks', 'note_chunks rejects INSERT');
select throws_ok($$update public.note_chunks set content = 'forged'$$, '42501', 'permission denied for table note_chunks', 'note_chunks rejects UPDATE');
select throws_ok($$delete from public.note_chunks$$, '42501', 'permission denied for table note_chunks', 'note_chunks rejects DELETE');

-- Feedback telemetry is server-authored even though users may read their rows.
select throws_ok($$insert into public.feedback_events (id) values ('fbk_73000000000000000000000001')$$, '42501', 'permission denied for table feedback_events', 'feedback_events rejects INSERT');
select throws_ok($$update public.feedback_events set reason_code = 'forged'$$, '42501', 'permission denied for table feedback_events', 'feedback_events rejects UPDATE');
select throws_ok($$delete from public.feedback_events$$, '42501', 'permission denied for table feedback_events', 'feedback_events rejects DELETE');

-- Sync cursor events are append-only from transactional server functions.
select throws_ok($$insert into public.user_events (user_id, entity, entity_id) values ('11111111-1111-4111-8111-111111111111', 'forged', 'forged')$$, '42501', 'permission denied for table user_events', 'user_events rejects INSERT');
select throws_ok($$update public.user_events set entity = 'forged' where seq = 1001$$, '42501', 'permission denied for table user_events', 'user_events rejects UPDATE');
select throws_ok($$delete from public.user_events where seq = 1001$$, '42501', 'permission denied for table user_events', 'user_events rejects DELETE');

-- Durable captures cannot bypass create_capture_with_job or rewrite raw source.
select throws_ok(
  $$
    insert into public.captures (
      id, user_id, source, raw_text, client_created_at, client_timezone
    )
    values (
      'cap_73000000000000000000000001',
      '11111111-1111-4111-8111-111111111111',
      'web',
      'bypass the atomic capture RPC',
      '2026-08-30 23:30:00+00',
      'UTC'
    )
  $$,
  '42501',
  'permission denied for table captures',
  'captures rejects direct INSERT'
);
select throws_ok($$update public.captures set raw_text = 'rewrite source' where id = 'cap_00000000000000000000000001'$$, '42501', 'permission denied for table captures', 'captures rejects direct UPDATE');

-- Revision snapshots are client-append-only.
select throws_ok($$update public.note_revisions set body_markdown = 'rewrite history' where id = 'rev_00000000000000000000000001'$$, '42501', 'permission denied for table note_revisions', 'note_revisions rejects UPDATE');
select throws_ok($$delete from public.note_revisions where id = 'rev_00000000000000000000000001'$$, '42501', 'permission denied for table note_revisions', 'note_revisions rejects DELETE');

-- Preserve the original behavioral proof that a cross-user note update affects
-- zero rows and leaves the protected record unchanged.
select is(
  pg_temp.affected($$update public.notes set title = 'must not change' where id = 'note_00000000000000000000000009'$$),
  0::bigint,
  'cross-user note UPDATE affects zero rows'
);
reset role;
select is(
  (
    select title from public.notes
    where id = 'note_00000000000000000000000009'
  ),
  'Other user private fixture',
  'cross-user note UPDATE leaves the stored row unchanged'
);

select * from finish();
rollback;
