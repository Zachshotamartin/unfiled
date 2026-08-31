-- Lease tokens are worker capabilities. Client-visible job state is projected
-- through reviewed capture RPCs, so the underlying queue must remain service-only.
drop policy if exists organization_jobs_select on public.organization_jobs;

revoke select on table public.organization_jobs from public, anon, authenticated;

comment on table public.organization_jobs is
  'Service-only organization queue. Lease and transition capabilities must never be exposed through PostgREST.';
