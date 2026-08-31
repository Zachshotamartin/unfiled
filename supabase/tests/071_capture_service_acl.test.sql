create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions;
select no_plan();

select ok(
  not has_table_privilege('anon', 'public.organization_jobs', 'SELECT')
    and not has_table_privilege(
      'authenticated', 'public.organization_jobs', 'SELECT'
    )
    and has_table_privilege('service_role', 'public.organization_jobs', 'SELECT'),
  'organization jobs and their lease capabilities are service-only'
);
select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public' and tablename = 'organization_jobs'
  ),
  0::bigint,
  'organization jobs retain no client policy a future grant could reactivate'
);

select ok(
  not has_function_privilege('anon', signature, 'EXECUTE')
    and not has_function_privilege('authenticated', signature, 'EXECUTE'),
  format('%s rejects anonymous and authenticated execution', signature)
)
from unnest(array[
  'public.create_capture_with_job(uuid,jsonb)',
  'public.claim_capture_jobs(text,integer,integer)',
  'public.heartbeat_capture_job(text,uuid,integer)',
  'public.complete_capture_job(text,uuid,text)',
  'public.fail_capture_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_capture_jobs(integer)',
  'public.list_captures(uuid,text,integer,text,timestamp with time zone,timestamp with time zone)',
  'public.get_capture_detail(uuid,text)',
  'public.get_capture_receipt(uuid,text)',
  'public.retry_capture(uuid,text,text)',
  'public.delete_capture(uuid,text,text,boolean,jsonb)',
  'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)'
]) as protected(signature);

select ok(
  has_function_privilege('service_role', signature, 'EXECUTE'),
  format('%s remains executable by the server service role', signature)
)
from unnest(array[
  'public.create_capture_with_job(uuid,jsonb)',
  'public.claim_capture_jobs(text,integer,integer)',
  'public.heartbeat_capture_job(text,uuid,integer)',
  'public.complete_capture_job(text,uuid,text)',
  'public.fail_capture_job(text,uuid,public.safe_error_code,boolean,integer)',
  'public.recover_stale_capture_jobs(integer)',
  'public.list_captures(uuid,text,integer,text,timestamp with time zone,timestamp with time zone)',
  'public.get_capture_detail(uuid,text)',
  'public.get_capture_receipt(uuid,text)',
  'public.retry_capture(uuid,text,text)',
  'public.delete_capture(uuid,text,text,boolean,jsonb)',
  'public.apply_delayed_organization_mutation(text,uuid,text,integer,jsonb,text)'
]) as service_entrypoint(signature);

select ok(
  (
    select bool_and(
      not has_function_privilege('service_role', signature, 'EXECUTE')
    )
    from unnest(array[
      'private.apply_delayed_organization_mutation_core(text,text,integer,jsonb,text)',
      'private.apply_user_note_mutation_core(text,integer,jsonb,text)',
      'private.apply_user_note_mutation_core_unchecked(text,integer,jsonb,text)'
    ]) as private_core(signature)
  ),
  'service workers cannot bypass public validation and lease fences through private cores'
);

select * from finish();
rollback;
