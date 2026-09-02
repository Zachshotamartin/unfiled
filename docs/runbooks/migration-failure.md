# Migration Failure

## Trigger

Use when `supabase db push`, a migration transaction, a post-apply verification, or the C.5d
owner-only operation fails or has an ambiguous client result. The migration filename being present is
not proof that every statement committed.

## Authority

Only the database operator may inspect or apply cloud migrations. Production apply/repair requires
release approval. C.5d contraction additionally requires a real database-owner session where
`session_user = current_user`, an approved backup/restore drill, and its dedicated approval. An
application, service-role key, migration bot using delegated `SET ROLE`, or workload login must never
perform it.

## Immediate containment

1. Stop further migration attempts and Production promotion.
2. Pause signups/writes/background jobs only if the failed migration may have changed a live contract.
3. Preserve the client result, server timestamp, migration/checksum, database audit reference, and
   session identity in restricted evidence. Do not copy SQL values, credentials, rows, or error
   contexts containing data into a ticket.
4. Keep the last compatible application deployment active only when its compatibility is proven.

## Diagnose read-only

1. Confirm project reference through the trusted management plane and prove the operator session's
   original/current identity, TLS host, database, and migration target.
2. Inspect migration history, transaction/activity state, catalog shape, function digests, constraints,
   grants, and contract state using reviewed schema-only queries.
3. Compare the checked-in migration checksum and expected postconditions. Do not infer state from the
   CLI exit code alone.
4. Determine one state: `not_started`, `rolled_back_transaction`, `committed_complete`,
   `committed_partial_nontransactional`, or `unknown`.
5. For `unknown`, stop writes and escalate to the database provider before any retry.

## Recover

- `not_started` or `rolled_back_transaction`: correct the environment/tooling or submit a new
  reviewed migration fix, rerun Preview from the same prior state, then seek Production approval.
- `committed_complete`: do not rerun. Repair the missing client/evidence path and execute all
  postconditions.
- `committed_partial_nontransactional`: do not edit migration history or hand-delete objects. Create
  a forward-only idempotent repair migration after catalog review and test it against an isolated
  copy of the exact partial state.
- `unknown`: remain paused until provider/database evidence resolves the state.

Never change an already applied migration file, mark it complete manually, disable RLS, broaden a
runtime role, restore plaintext columns, or use a Production restore merely to avoid writing a repair.

## Verification

- zero-to-head migration, database lint, pgTAP, concurrency, and local HTTP gates pass at the new head;
- Preview apply from the same starting state passes twice without drift;
- migration history/checksum/catalog/grants match the reviewed target;
- exact organizer/worker/verifier/search identities retain eleven/six/two/five RPCs and no table/RLS
  bypass;
- canary-log audit and encrypted storage postconditions pass;
- application health, capture, search fallback, export, and deletion remain correct.

## Rollback, escalation, and evidence

Ordinary expand-compatible migrations are left in place when old code safely ignores them. C.5d is
not reversed in place. If a contracted Production database cannot be fixed forward, the security
owner may approve restoring the recorded pre-contract backup plus its compatible keys and complete
deployment set; treat that as a security incident because it reopens the historical exposure.

Record identities, migration/checksum, state classification, catalog digests, containment, repair
PR/CI, Preview/Production results, postconditions, approvals, and provider case.
