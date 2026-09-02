# Database-Login Rotation and Revocation

## Scope

This runbook covers the dedicated TLS PostgreSQL logins:

- `unfiled_organizer_worker` with exactly eleven reviewed RPCs;
- `unfiled_index_worker` with exactly six reviewed RPCs;
- `unfiled_rag_verifier` with exactly two reviewed RPCs;
- `unfiled_search_worker` with exactly five one-use-ticket RPCs.

It does not cover the browser anonymous key, web service-role key, database-owner password, or Vault
provider keys. Rotate each through its own custody procedure.

## Authority and reasons

The database operator rotates passwords and verifies grants. The release operator updates only the
owning Vercel project and deployment. The security owner may order immediate revocation after
suspected exposure. Routine rotation is rehearsed against local Supabase before Production.

## Safety rules

- Never print, echo, pass as a command argument, store in shell history, or paste the old/new URL or
  password into evidence.
- Use the canonical verified-TLS host/CA and exact transport username for the endpoint class.
- Do not create a generic replacement role, grant table/schema access, add inheritance, or use a
  Supabase service/secret key as a shortcut.
- Rotate one workload at a time. Only the Production scope exists in the free beta; Preview
  deployments are not built and must not receive a database credential.

## Routine rotation

1. Confirm environment, role, owning Vercel project, deployment, expected host/project reference,
   exact RPC allowlist, and a tested rollback/maintenance state.
2. Pause only the owning workload and wait for its leases/queries to settle. Preserve safe product
   fallback: Inbox for organizer, lexical-only for search, previous active generation for index.
3. From the approved original database-owner session, generate a new high-entropy password directly
   into the secret manager and alter only the exact role's password.
4. Replace the owning project's database URL secret interactively. Keep host, database, role,
   `sslmode=verify-full`, and CA pin unchanged.
5. Redeploy that project. Do not reuse a deployment built for another environment or project.
6. Verify PostgreSQL reports both `session_user` and `current_user` as the unsuffixed exact role, then
   prove only its exact RPC allowlist succeeds and table/private/admin/other-workload/RLS-bypass
   probes fail.
7. Verify the old credential can no longer connect. Do not include the attempted credential or
   server message in evidence.
8. Resume synthetic work, reconcile queue/receipts, then resume the cohort.

PostgreSQL's single password creates a bounded maintenance interval. Do not create an overlapping
broad role to avoid it. If future infrastructure supports safely scoped dual credentials, adopt it
only through a reviewed migration and updated tests.

## Emergency revocation

1. Disable the affected workload/feature and page security/database/release owners.
2. Revoke connection ability or rotate the password from the database-owner session. Terminate only
   sessions conclusively bound to that role/environment after recording safe counts.
3. Freeze relevant Vercel/database evidence and search for use outside the incident
   window. Do not log SQL text or parameters.
4. Audit role attributes, memberships, grants, function ownership/search paths, RLS bypass, and
   session identity. Any unexpected allow is S1.
5. Provision a clean password on the same exact role only after scope is proven, update the single
   owning project, deploy, run deny probes, and reconcile work.

## Stop conditions and verification

Stop if the role, host, project reference, CA, Vercel target, lease state, or grant set is ambiguous.
Keep the feature disabled if the old credential works, identity differs, any prohibited probe
succeeds, queue/receipt reconciliation fails, or logs contain connection material.

Record rotation/revocation reason, role/environment, start/end, secret-version references (not
values), deployment/configuration digests, exact identity/ACL pass/deny summary, old-credential denial,
queue reconciliation, approvers, and next rotation date.
