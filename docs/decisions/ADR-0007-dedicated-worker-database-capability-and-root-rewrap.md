# ADR-0007: Dedicated worker database capability and controlled root rewrap

- Status: accepted
- Date: 2026-08-30
- Narrows: ADR-0006 managed-custody and private-retrieval boundaries
- Decision drivers: keep Supabase's global RLS-bypassing credential out of the organizer/indexer; expose only the database operations that worker needs; make KMS-root rewrap atomic, replay-safe, and unavailable to that worker.

## Context

The separately deployed organization/index worker needs to claim, renew, finish, fail, recover, and page encrypted index work. Giving it a Supabase `service_role` or secret key would also give that trust domain an RLS-bypassing capability over unrelated application tables. During the C.5 expand-only stage, those tables still include legacy plaintext note columns, so project separation and an AI-only KMS role would not by themselves prevent a compromised worker from reading private-manual content.

Root rotation creates a second boundary. The interactive/admin service may use AWS KMS `ReEncrypt` to move a wrapped per-user intermediate key from a retired root to the active root. Persisting the returned ciphertext and new root ARN as unrelated writes could produce a torn record, lose a concurrent rotation, or make a retry increment lifecycle metadata twice. The index worker does not need this capability and its AWS role has no KMS rewrap permission.

## Decision

### 1. Give the worker one exact non-bypass database identity

`supabase/roles.sql` and migration `20260830000015_encrypted_library_expansion.sql` own the PostgreSQL role `unfiled_index_worker`. The checked-in role is deliberately `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, and `NOREPLICATION`, with no workload-usable role membership. The guards reject every inbound or outbound membership except PostgreSQL 17's automatic, inert platform-management edge from trusted schema owner `postgres` (`supabase_admin` grantor, `ADMIN=true`, `INHERIT=false`, `SET=false`), or zero rows after a real superuser removes it. The migration revokes all direct public/private table and sequence privileges, public-schema `CREATE`, private-schema access, and every function grant before rebuilding the allowlist.

The only runtime grants are `USAGE` on `public` plus `EXECUTE` on these six `SECURITY DEFINER` functions:

- `claim_note_index_jobs`
- `heartbeat_note_index_job`
- `commit_note_rag_index`
- `fail_note_index_job`
- `recover_stale_note_index_jobs`
- `list_active_note_rag_index`

Each function accepts the exact direct connection identity through `session_user = 'unfiled_index_worker'` (and retains the separately reviewed interactive/admin `auth.role() = 'service_role'` path). A caller cannot acquire the worker capability with `SET ROLE`: `session_user` remains the original login. Function bodies own tenant, privacy, deletion, revision, generation, lease, pagination, and race checks; the worker cannot bypass them with direct SQL.

The migration does not create a production password. After the C.5c repository adapter is ready, a human database administrator provisions `LOGIN` and a generated, rotated credential for this exact role, connects it through TLS with hostname and certificate verification using the supported Supabase pooler/direct connection, and stores the resulting server-only URL only as `UNFILED_WORKER_DATABASE_URL`. The worker never receives `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, another global Supabase service credential, or membership in an RLS-bypassing role. A database reset or role-recreating migration returns the role to `NOLOGIN`; production reprovisioning is an explicit gate, not a migration secret.

### 2. Keep root rewrap in the interactive/admin capability

`rewrap_user_content_key` is a `SECURITY DEFINER` RPC executable by `service_role` and explicitly denied to clients and `unfiled_index_worker`. The caller first performs KMS `ReEncrypt` with the record's exact four-field encryption context, then calls the RPC with the owner/key identity, expected old full KMS key ARN, expected root-rewrap count, new full KMS key ARN, and bounded wrapped intermediate-key ciphertext.

The RPC locks the authoritative key record. It rejects revoked keys, stale old-ARN/count expectations, malformed input, and same-root updates. A successful compare-and-swap atomically records the previous ARN, new ARN, new ciphertext, counter increment, and server-generated rewrap time. A retry is accepted only when the already-persisted new ARN, previous ARN, incremented count, and ciphertext exactly match; a mismatched replay fails. The content-free result exposes only key ID, lifecycle state, count, and rewrap/replay flags.

The application still has to verify the KMS response names the intended active root before calling the RPC. Root rotation remains incomplete until the old-reference count is zero and the restore and rollback drills pass.

## Alternatives considered

- Give the worker the Supabase service key: operationally easy, but it bypasses RLS and defeats the private-worker boundary; rejected.
- Give the worker direct grants on encrypted tables: narrower than `service_role`, but creates a growing, difficult-to-audit SQL surface and would let application checks be bypassed; rejected.
- Use an inherited parent role or `SET ROLE`: weakens identity attribution and can satisfy ordinary privilege checks without proving the original connection identity; rejected.
- Put database credentials or `LOGIN` in the migration: would commit or externalize environment-specific secret lifecycle and make resets silently provision a runtime principal; rejected.
- Let the index worker rewrap roots: it has no operational need, would require broader KMS and database authority, and would expand the blast radius; rejected.
- Update rewrap fields in separate statements: cannot provide one locked compare-and-swap or exact replay semantics; rejected.

## Consequences

The worker now needs a separately rotated database credential and a driver/pooler path that preserves the exact PostgreSQL `session_user`. C.5c must prove the deployed connection reports `unfiled_index_worker`, uses certificate- and hostname-verified TLS, can call exactly the six RPCs, and cannot read a table, enter `private`, execute an administrative RPC, use `rewrap_user_content_key`, or escalate through role membership. Credential loss or database/KMS failure must leave work queued or recoverable without a plaintext fallback.

The interactive/admin service retains a powerful Supabase capability for key lifecycle and future encrypted aggregate operations; this ADR does not claim that capability is harmless. Its environment, call sites, and audit trail remain separate from the worker. C.5a supplies the schema and custody boundary, but account-bound Vercel/AWS/database evidence and C.5b–d encrypted aggregate, RAG adapter, and plaintext-contract work remain launch blockers.
