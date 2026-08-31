create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select plan(55);

select ok(
  to_regprocedure(
    'public.apply_delayed_organization_mutation(text,text,integer,jsonb,text)'
  ) is null,
  'the unfenced delayed organization signature is removed'
);
select ok(
  to_regprocedure(
    'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)'
  ) is not null,
  'the delayed organization RPC requires an exact lease token'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated cannot execute delayed organization mutations'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)',
    'EXECUTE'
  ),
  'anonymous cannot execute delayed organization mutations'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)',
    'EXECUTE'
  ),
  'service role can execute the lease-fenced delayed organization RPC'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.apply_delayed_organization_mutation_core(text,text,integer,jsonb,text)',
    'EXECUTE'
  ),
  'service role cannot bypass the lease fence through the migration-8 core'
);

create temporary table b_org_runtime (
  job_id text primary key,
  capture_id text not null,
  lease_token uuid not null,
  previous_lease_token uuid
) on commit drop;
grant all on table b_org_runtime to authenticated, service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.captures (
  id, user_id, source, raw_text, content_envelope, content_fingerprint,
  content_length, privacy, client_created_at, client_timezone, status
) values (
  'cap_73500000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'web',
  '[encrypted]',
  jsonb_build_object(
    'version', 1,
    'suite', 'A256GCM',
    'keyId', 'test-kek-v1',
    'context', jsonb_build_object(
      'tenantId', '11111111-1111-4111-8111-111111111111',
      'resourceId', 'cap_73500000000000000000000001',
      'recordVersion', 1,
      'kind', 'capture'
    ),
    'wrappedDataKey', jsonb_build_object(
      'nonce', repeat('A', 16),
      'ciphertext', repeat('A', 64)
    ),
    'payload', jsonb_build_object(
      'nonce', repeat('B', 16),
      'ciphertext', repeat('C', 22)
    )
  ),
  repeat('a', 64),
  12,
  'ai_assisted',
  '2026-08-30 18:00:00+00',
  'UTC',
  'queued'
);
insert into public.organization_jobs (
  id, capture_id, user_id, state, prompt_version, schema_version, available_at
) values (
  'job_73500000000000000000000001',
  'cap_73500000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  'created',
  'routing-v1',
  1,
  clock_timestamp() - interval '1 second'
);
insert into public.organization_decisions (
  id, capture_id, user_id, candidate_manifest, signals, validated_plan,
  band, score, margin, reason_codes
) values (
  'dec_73500000000000000000000001',
  'cap_73500000000000000000000001',
  '11111111-1111-4111-8111-111111111111',
  '{"candidateIds":[]}'::jsonb,
  '{}'::jsonb,
  '{"schemaVersion":1,"decision":"append_to_note"}'::jsonb,
  'auto',
  0.990,
  0.950,
  array['test_fixture']
);
insert into b_org_runtime (job_id, capture_id, lease_token)
select
  claimed_job ->> 'jobId',
  claimed_job ->> 'captureId',
  (claimed_job ->> 'leaseToken')::uuid
from jsonb_array_elements(
  public.claim_capture_jobs('delayed-organization-worker', 1, 900) -> 'jobs'
) as claimed(claimed_job);
select is(
  (select count(*) from b_org_runtime),
  1::bigint,
  'the delayed organization fixture has one active lease'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    insert into public.organization_mutation_attempts (
      job_id, note_id, user_id, planned_revision, operations, state
    ) values (
      'job_73500000000000000000000001',
      'note_00000000000000000000000001',
      '11111111-1111-4111-8111-111111111111',
      1,
      '[]',
      'applied'
    )
  $$,
  '42501',
  'permission denied for table organization_mutation_attempts',
  'authenticated cannot forge organization attempt state'
);

select is(
  public.create_note(
    'b-org-success-create', 'generic', 'B Organization Success', 'manual baseline'
  ) ->> 'replayed',
  'false',
  'organization success fixture is created'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table b_org_success as
select public.apply_delayed_organization_mutation(
  runtime.job_id,
  runtime.lease_token,
  (select id from public.notes where title = 'B Organization Success'),
  1,
  '[{"type":"set_title","title":"B Organization Applied"}]'::jsonb,
  'b-org-success'
) as result
from b_org_runtime as runtime;
select is(
  (select result ->> 'status' from b_org_success),
  'applied',
  'organization mutation applies while the exact lease is current'
);
reset role;
select is(
  (
    select current_revision::text || ':' || title
    from public.notes where title = 'B Organization Applied'
  ),
  '2:B Organization Applied',
  'organization success appends without losing the baseline'
);
select is(
  (
    select source::text
    from public.note_revisions
    where note_id = (select id from public.notes where title = 'B Organization Applied')
      and revision = 2
  ),
  'organization',
  'organization revision has the truthful source'
);
select is(
  (
    select actor
    from public.note_revisions
    where note_id = (select id from public.notes where title = 'B Organization Applied')
      and revision = 2
  ),
  'organization:job_73500000000000000000000001',
  'organization revision identifies its job actor'
);
select ok(
  (
    select decision_id is not null
    from public.note_mutations
    where id = (select result ->> 'mutationId' from b_org_success)
  ),
  'organization mutation links the job capture decision'
);
select is(
  (
    select state || ':' || replan_count::text
    from public.organization_mutation_attempts
    where note_id = (select id from public.notes where title = 'B Organization Applied')
  ),
  'applied:0',
  'successful attempt is durably recorded'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.apply_delayed_organization_mutation(
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Organization Applied'),
    1,
    '[{"type":"set_title","title":"B Organization Applied"}]'::jsonb,
    'b-org-success'
  ) ->> 'replayed',
  'true',
  'organization result replays only while the exact lease remains active'
)
from b_org_runtime as runtime;

-- Simulate a committed effect whose HTTP response is lost. Recovery and a new
-- lease must replay the same logical request without appending again.
update b_org_runtime set previous_lease_token = lease_token;
update public.organization_jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select job_id from b_org_runtime);
select is(
  public.recover_stale_capture_jobs(10) ->> 'recovered',
  '1',
  'lost-response recovery expires the original effect lease'
);
update public.organization_jobs
set available_at = clock_timestamp() - interval '1 second'
where id = (select job_id from b_org_runtime);
update b_org_runtime
set lease_token = (
  select (claimed_job ->> 'leaseToken')::uuid
  from jsonb_array_elements(
    public.claim_capture_jobs('delayed-organization-replay-worker', 1, 900) -> 'jobs'
  ) as claimed(claimed_job)
  where claimed_job ->> 'jobId' = b_org_runtime.job_id
);
select ok(
  (
    select lease_token is not null
      and lease_token is distinct from previous_lease_token
    from b_org_runtime
  ),
  'recovery issues a distinct lease for the lost-response retry'
);
select is(
  public.apply_delayed_organization_mutation(
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Organization Applied'),
    1,
    '[{"type":"set_title","title":"B Organization Applied"}]'::jsonb,
    'b-org-success'
  ) ->> 'replayed',
  'true',
  'the same logical effect replays under a new exact lease'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title
    from public.notes where title = 'B Organization Applied'
  ),
  '2:B Organization Applied',
  'lost-response retry does not append a second note revision'
);
select is(
  (
    select count(*)
    from public.note_mutations
    where note_id = (select id from public.notes where title = 'B Organization Applied')
      and before_revision = 1
      and after_revision = 2
  ),
  1::bigint,
  'lost-response retry preserves exactly one mutation effect'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select is(
  public.create_note(
    'b-org-replan-create', 'generic', 'B Organization Replan', 'N'
  ) ->> 'replayed',
  'false',
  'organization replan fixture is created at N'
);
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Organization Replan'),
    1,
    '[{"type":"set_title","title":"B Manual N Plus One"}]'::jsonb,
    'b-org-manual-one'
  ) -> 'note' ->> 'currentRevision',
  '2',
  'manual content advances to N+1 before delayed apply'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.apply_delayed_organization_mutation(
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Manual N Plus One'),
    1,
    '[{"type":"set_title","title":"B Stale Organization Plan"}]'::jsonb,
    'b-org-first-conflict'
  ) ->> 'status',
  'replanned',
  'first delayed conflict requests exactly one replan at N+1'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title
    from public.notes where title = 'B Manual N Plus One'
  ),
  '2:B Manual N Plus One',
  'first conflict never overwrites manual N+1 content'
);
select is(
  (
    select state || ':' || planned_revision::text || ':' || replan_count::text
    from public.organization_mutation_attempts
    where note_id = (select id from public.notes where title = 'B Manual N Plus One')
  ),
  'replanned:2:1',
  'replan state records the current revision and one allowed replan'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select is(
  public.apply_user_note_mutation(
    (select id from public.notes where title = 'B Manual N Plus One'),
    2,
    '[{"type":"set_title","title":"B Manual N Plus Two"}]'::jsonb,
    'b-org-manual-two'
  ) -> 'note' ->> 'currentRevision',
  '3',
  'manual content advances again before the replan applies'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table b_org_second_conflict as
select public.apply_delayed_organization_mutation(
  runtime.job_id,
  runtime.lease_token,
  (select id from public.notes where title = 'B Manual N Plus Two'),
  2,
  '[{"type":"set_title","title":"B Replanned Organization Content"}]'::jsonb,
  'b-org-second-conflict'
) as result
from b_org_runtime as runtime;
select is(
  (select result ->> 'status' from b_org_second_conflict),
  'needs_review',
  'second revision conflict stops automatic application'
);
reset role;
select is(
  (
    select current_revision::text || ':' || title
    from public.notes where title = 'B Manual N Plus Two'
  ),
  '3:B Manual N Plus Two',
  'second conflict preserves the newest manual content'
);
select is(
  (
    select count(*)
    from public.review_items
    where note_id = (select id from public.notes where title = 'B Manual N Plus Two')
      and type = 'revision_conflict'
      and state = 'open'
  ),
  1::bigint,
  'second conflict creates one unresolved revision review'
);
select is(
  (
    select state
    from public.organization_mutation_attempts
    where note_id = (select id from public.notes where title = 'B Manual N Plus Two')
  ),
  'needs_review',
  'attempt transitions to needs_review'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.apply_delayed_organization_mutation(
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Manual N Plus Two'),
    2,
    '[{"type":"set_title","title":"B Replanned Organization Content"}]'::jsonb,
    'b-org-second-conflict'
  ) ->> 'replayed',
  'true',
  'second-conflict result replays without duplicating review state'
)
from b_org_runtime as runtime;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select is(
  public.create_note(
    'b-org-structure-create', 'list', 'B Organization Structure', '- [ ] safe'
  ) ->> 'replayed',
  'false',
  'organization structure fixture is created'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.apply_delayed_organization_mutation(
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Organization Structure'),
    1,
    '[{"type":"replace_body_markdown","bodyMarkdown":"- [ ] safe\nlossy prose"}]'::jsonb,
    'b-org-structure-conflict'
  ) ->> 'errorCode',
  'structure_conflict',
  'organization structure ambiguity creates a review outcome'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || body_markdown
    from public.notes where title = 'B Organization Structure'
  ),
  E'1:- [ ] safe',
  'organization structure conflict leaves note and revision unchanged'
);
select is(
  (
    select count(*)
    from public.review_items
    where note_id = (select id from public.notes where title = 'B Organization Structure')
      and type = 'structure_conflict'
      and state = 'open'
  ),
  1::bigint,
  'organization structure conflict commits an unresolved review'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    runtime.lease_token,
    'note_00000000000000000000000009',
    '[{"type":"set_title","title":"forged"}]',
    'b-org-cross-user'
  ),
  'P0001',
  'not_found',
  'organization path cannot target another user note'
)
from b_org_runtime as runtime;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select is(
  public.create_note(
    'b-org-fence-note', 'generic', 'B Lease Fence', 'manual fence'
  ) ->> 'replayed',
  'false',
  'lease fencing fixture is created'
);
select is(
  public.create_note(
    'b-org-post-fence-note', 'generic', 'B Post Lease Fence', 'post fence baseline'
  ) ->> 'replayed',
  'false',
  'post-mutation lease fencing fixture is created'
);

reset role;
create function pg_temp.expire_delayed_organization_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.title = 'B Post Lease Fence' then
    update public.organization_jobs
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where id = 'job_73500000000000000000000001';
  end if;
  return new;
end;
$$;
create trigger expire_delayed_organization_lease_during_note_write
before update on public.notes
for each row execute function pg_temp.expire_delayed_organization_lease();

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Post Lease Fence'),
    '[{"type":"set_title","title":"Post-check write"}]',
    'b-org-post-expiry'
  ),
  'P0001',
  'stale_revision',
  'lease expiration during core execution rejects the transaction at the post-effect fence'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title || ':' || body_markdown
    from public.notes where title = 'B Post Lease Fence'
  ),
  '1:B Post Lease Fence:post fence baseline',
  'post-effect lease rejection rolls back note state and content atomically'
);
select is(
  (
    select count(*)
    from public.api_idempotency_records
    where user_id = '11111111-1111-4111-8111-111111111111'
      and idempotency_key = 'b-org-post-expiry'
  ),
  0::bigint,
  'post-effect lease rejection rolls back its idempotency claim'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select id from public.notes where title = 'B Lease Fence'),
    '[{"type":"set_title","title":"Wrong token write"}]',
    'b-org-wrong-token'
  ),
  'P0001',
  'stale_revision',
  'a different lease token is rejected before note mutation'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title || ':' || body_markdown
    from public.notes where title = 'B Lease Fence'
  ),
  '1:B Lease Fence:manual fence',
  'wrong-token rejection leaves note state and content unchanged'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.organization_jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select job_id from b_org_runtime);
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Lease Fence'),
    '[{"type":"set_title","title":"Expired token write"}]',
    'b-org-expired-token'
  ),
  'P0001',
  'stale_revision',
  'an expired exact lease is rejected before note mutation'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title || ':' || body_markdown
    from public.notes where title = 'B Lease Fence'
  ),
  '1:B Lease Fence:manual fence',
  'expired-token rejection leaves note state and content unchanged'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.recover_stale_capture_jobs(10) ->> 'recovered',
  '1',
  'stale recovery transitions the expired delayed-organization lease'
);
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Lease Fence'),
    '[{"type":"set_title","title":"Recovered token write"}]',
    'b-org-recovered-token'
  ),
  'P0001',
  'stale_revision',
  'a recovered lease token cannot mutate notes'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title || ':' || body_markdown
    from public.notes where title = 'B Lease Fence'
  ),
  '1:B Lease Fence:manual fence',
  'recovered-token rejection leaves note state and content unchanged'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.organization_jobs
set available_at = clock_timestamp() - interval '1 second'
where id = (select job_id from b_org_runtime);
update b_org_runtime
set lease_token = (
  select (claimed_job ->> 'leaseToken')::uuid
  from jsonb_array_elements(
    public.claim_capture_jobs('delayed-organization-worker-retry', 1, 900) -> 'jobs'
  ) as claimed(claimed_job)
  where claimed_job ->> 'jobId' = b_org_runtime.job_id
);
select ok(
  (select lease_token is not null from b_org_runtime),
  'recovery can issue a distinct active lease for the deletion race regression'
);
select is(
  public.delete_capture(
    '11111111-1111-4111-8111-111111111111'::uuid,
    runtime.capture_id,
    'b-org-delete-active-capture',
    false,
    '[]'::jsonb
  ) ->> 'captureId',
  runtime.capture_id,
  'capture deletion fences the currently running job'
)
from b_org_runtime as runtime;
select throws_ok(
  format(
    'select public.apply_delayed_organization_mutation(%L, %L::uuid, %L, 1, %L::jsonb, %L)',
    runtime.job_id,
    runtime.lease_token,
    (select id from public.notes where title = 'B Lease Fence'),
    '[{"type":"set_title","title":"Deleted capture write"}]',
    'b-org-deleted-capture-token'
  ),
  'P0001',
  'stale_revision',
  'the lease token invalidated by capture deletion cannot mutate notes'
)
from b_org_runtime as runtime;
reset role;
select is(
  (
    select current_revision::text || ':' || title || ':' || body_markdown
    from public.notes where title = 'B Lease Fence'
  ),
  '1:B Lease Fence:manual fence',
  'deleted-capture token rejection leaves note state and content unchanged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);
select ok(
  (select count(*) >= 3 from public.organization_mutation_attempts),
  'owner can read their organization attempt state'
);
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);
select is(
  (select count(*) from public.organization_mutation_attempts),
  0::bigint,
  'cross-user RLS hides organization attempt state'
);

select * from finish();
rollback;
