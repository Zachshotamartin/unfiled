create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select plan(29);

select ok(not has_function_privilege('authenticated', 'public.apply_delayed_organization_mutation(text,text,integer,jsonb,text)', 'EXECUTE'), 'authenticated cannot execute delayed organization mutations');
select ok(has_function_privilege('service_role', 'public.apply_delayed_organization_mutation(text,text,integer,jsonb,text)', 'EXECUTE'), 'service role can execute delayed organization mutations');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select throws_ok(
  $$insert into public.organization_mutation_attempts (job_id, note_id, user_id, planned_revision, operations, state) values ('job_00000000000000000000000001', 'note_00000000000000000000000001', '11111111-1111-4111-8111-111111111111', 1, '[]', 'applied')$$,
  '42501', 'permission denied for table organization_mutation_attempts',
  'authenticated cannot forge organization attempt state'
);

select is(public.create_note('b-org-success-create', 'generic', 'B Organization Success', 'manual baseline') ->> 'replayed', 'false', 'organization success fixture is created');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table b_org_success as
select public.apply_delayed_organization_mutation(
  'job_00000000000000000000000001',
  (select id from public.notes where title = 'B Organization Success'),
  1,
  '[{"type":"set_title","title":"B Organization Applied"}]'::jsonb,
  'b-org-success'
) as result;
select is((select result ->> 'status' from b_org_success), 'applied', 'organization mutation applies when the planned revision is current');
reset role;
select is((select current_revision::text || ':' || title from public.notes where title = 'B Organization Applied'), '2:B Organization Applied', 'organization success appends without losing the baseline');
select is((select source::text from public.note_revisions where note_id = (select id from public.notes where title = 'B Organization Applied') and revision = 2), 'organization', 'organization revision has the truthful source');
select is((select actor from public.note_revisions where note_id = (select id from public.notes where title = 'B Organization Applied') and revision = 2), 'organization:job_00000000000000000000000001', 'organization revision identifies its job actor');
select ok((select decision_id is not null from public.note_mutations where id = (select result ->> 'mutationId' from b_org_success)), 'organization mutation links the job capture decision');
select is((select state || ':' || replan_count::text from public.organization_mutation_attempts where note_id = (select id from public.notes where title = 'B Organization Applied')), 'applied:0', 'successful attempt is durably recorded');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.apply_delayed_organization_mutation('job_00000000000000000000000001', (select id from public.notes where title = 'B Organization Applied'), 1, '[{"type":"set_title","title":"B Organization Applied"}]'::jsonb, 'b-org-success') ->> 'replayed', 'true', 'organization result replays before stale validation');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(public.create_note('b-org-replan-create', 'generic', 'B Organization Replan', 'N') ->> 'replayed', 'false', 'organization replan fixture is created at N');
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Organization Replan'), 1, '[{"type":"set_title","title":"B Manual N Plus One"}]'::jsonb, 'b-org-manual-one') -> 'note' ->> 'currentRevision', '2', 'manual content advances to N+1 before delayed apply');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.apply_delayed_organization_mutation('job_00000000000000000000000001', (select id from public.notes where title = 'B Manual N Plus One'), 1, '[{"type":"set_title","title":"B Stale Organization Plan"}]'::jsonb, 'b-org-first-conflict') ->> 'status', 'replanned', 'first delayed conflict requests exactly one replan at N+1');
reset role;
select is((select current_revision::text || ':' || title from public.notes where title = 'B Manual N Plus One'), '2:B Manual N Plus One', 'first conflict never overwrites manual N+1 content');
select is((select state || ':' || planned_revision::text || ':' || replan_count::text from public.organization_mutation_attempts where note_id = (select id from public.notes where title = 'B Manual N Plus One')), 'replanned:2:1', 'replan state records the current revision and one allowed replan');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(public.apply_user_note_mutation((select id from public.notes where title = 'B Manual N Plus One'), 2, '[{"type":"set_title","title":"B Manual N Plus Two"}]'::jsonb, 'b-org-manual-two') -> 'note' ->> 'currentRevision', '3', 'manual content advances again before the replan applies');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table b_org_second_conflict as
select public.apply_delayed_organization_mutation(
  'job_00000000000000000000000001',
  (select id from public.notes where title = 'B Manual N Plus Two'),
  2,
  '[{"type":"set_title","title":"B Replanned Organization Content"}]'::jsonb,
  'b-org-second-conflict'
) as result;
select is((select result ->> 'status' from b_org_second_conflict), 'needs_review', 'second revision conflict stops automatic application');
reset role;
select is((select current_revision::text || ':' || title from public.notes where title = 'B Manual N Plus Two'), '3:B Manual N Plus Two', 'second conflict preserves the newest manual content');
select is((select count(*) from public.review_items where note_id = (select id from public.notes where title = 'B Manual N Plus Two') and type = 'revision_conflict' and state = 'open'), 1::bigint, 'second conflict creates one unresolved revision review');
select is((select state from public.organization_mutation_attempts where note_id = (select id from public.notes where title = 'B Manual N Plus Two')), 'needs_review', 'attempt transitions to needs_review');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.apply_delayed_organization_mutation('job_00000000000000000000000001', (select id from public.notes where title = 'B Manual N Plus Two'), 2, '[{"type":"set_title","title":"B Replanned Organization Content"}]'::jsonb, 'b-org-second-conflict') ->> 'replayed', 'true', 'second-conflict envelope replays without duplicate review');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(public.create_note('b-org-structure-create', 'list', 'B Organization Structure', '- [ ] safe') ->> 'replayed', 'false', 'organization structure fixture is created');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(public.apply_delayed_organization_mutation('job_00000000000000000000000001', (select id from public.notes where title = 'B Organization Structure'), 1, '[{"type":"replace_body_markdown","bodyMarkdown":"- [ ] safe\nlossy prose"}]'::jsonb, 'b-org-structure-conflict') ->> 'errorCode', 'structure_conflict', 'organization structure ambiguity creates a review outcome');
reset role;
select is((select current_revision::text || ':' || body_markdown from public.notes where title = 'B Organization Structure'), E'1:- [ ] safe', 'organization structure conflict leaves note and revision unchanged');
select is((select count(*) from public.review_items where note_id = (select id from public.notes where title = 'B Organization Structure') and type = 'structure_conflict' and state = 'open'), 1::bigint, 'organization structure conflict commits an unresolved review');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select public.apply_delayed_organization_mutation('job_00000000000000000000000001', 'note_00000000000000000000000009', 1, '[{"type":"set_title","title":"forged"}]'::jsonb, 'b-org-cross-user')$$, 'P0001', 'not_found', 'organization path cannot target another user note');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select ok((select count(*) >= 3 from public.organization_mutation_attempts), 'owner can read their organization attempt state');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select is((select count(*) from public.organization_mutation_attempts), 0::bigint, 'cross-user RLS hides organization attempt state');

select * from finish();
rollback;
