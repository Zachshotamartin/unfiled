# Deployment Rollback

## Trigger and constraints

Use for a release-caused error, latency, identity/configuration drift, capture-risk signal, or failed
post-deploy canary. Unfiled is a five-project system; rollback means returning web, organizer, index
worker, verifier, and search to one previously verified compatible deployment set.

A rollback does not undo a database migration, C.5d contraction, root-ring rotation, Vault mutation,
account deletion, provider request, or already committed user mutation.

## Authority

The release operator may disable features and promote a recorded prior deployment set. A Production
rollback requires a second operator/approver recorded in restricted evidence. Database, root-ring, or
credential changes require their separate authorities and runbooks.

## Preflight

1. Confirm environment and incident; freeze new promotion/migration/configuration work.
2. Record the current and candidate rollback manifest digests, full commit SHAs, all five immutable
   deployment IDs, migration head, C.5d state, root registry and provider-model registry versions,
   and feature states.
3. Prove the rollback set previously passed health/readiness, trust-domain, canary, and applicable
   product gates and supports the current database schema/contract.
4. Confirm no destructive or incompatible data migration occurred after that set. When uncertain,
   stop and use [migration failure](./migration-failure.md) or restore incident review.
5. Verify recent backup/PITR availability. Creating a backup is useful evidence but does not make an
   incompatible rollback safe.

Do not select deployments from aliases, timestamps, or UI ordering alone. Use immutable IDs from the
release manifest.

## Contain and roll back

1. Disable semantic search and AI organization at reviewed controls. Preserve durable capture,
   Inbox fallback, manual notes, export, deletion, and lexical search where safe.
2. Pause recovery crons and background maintenance if they could cross the version boundary. Allow
   current bounded leases to settle; do not cancel database transactions by editing rows.
3. If compatibility between current callers and prior isolated services is proven, promote the four
   prior isolated deployments, verify them, then promote prior web. If compatibility is not proven,
   put public traffic into the narrow approved maintenance state before changing any project.
4. Promote; do not rebuild. Verify the platform reports the exact prior commit and deployment ID for
   every project.
5. Restore only the prior non-secret configuration version referenced by the rollback manifest.
   Never copy a secret between projects or environments.
6. Run shallow health, authenticated content-free readiness, exact caller/OIDC/database/root probes,
   and a synthetic durable-capture/receipt check.
7. Resume recovery crons, then synthetic traffic, then the controlled cohort. Keep semantic/AI
   features disabled until their specific gates pass.

## Verification

- all five deployments match one prior manifest digest and the expected commit;
- database migration head and contract state are supported by that commit;
- one idempotent synthetic capture produces exactly one receipt without loss/duplication;
- manual CRUD, export, deletion replay, and lexical search work;
- exact database identities/RPC allowlists, root subsets, and OIDC caller denials remain intact;
- queue age, error rate, receipt latency, and canary audit are normal;
- no old and new deployment mix remains in active regions.

## Stop, forward fix, and evidence

Stop if any immutable ID, schema compatibility, contract state, secret scope, or post-rollback outcome
is ambiguous. Never hand-recreate dropped columns or weaken encryption/RLS to support old code. After
C.5d contraction or an incompatible data change, use a reviewed forward fix unless the security
owner declares and approves the separately isolated restored-backup path.

Record incident/rollback times, current/prior manifest digests, reason, feature pauses, promotion
order/results, migration/contract state, canary and queue reconciliation, approvals, user impact, and
forward-fix issue.
