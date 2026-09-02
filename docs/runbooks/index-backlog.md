# Index Backlog

## Trigger and safe state

Use when encrypted index oldest age exceeds one minute, active-generation coverage drops below 100%,
repair exceeds 50 missing/stale rows, verification/activation stalls, or the recovery drain fails.
The safe state is lexical-only search and conservative organizer retrieval; incomplete or changing
generations must never be queried semantically.

## Authority

The release operator may disable semantic search, pause index maintenance, invoke one bounded
recovery drain, and roll back deployments. The database operator may run reviewed aggregate coverage
and lease diagnostics. Only the key recovery owner changes root availability.

## Diagnose

1. Confirm web, worker, verifier, and search deployment hashes, active/shadow generation state,
   embedding profile (`unfiled-local-hash-v1`/512 in the free beta; no provider request), and
   migration head.
2. Inspect only aggregate pending/leased/retry/dead-letter counts, oldest age, expected/indexed/
   eligible/covered counts, missing/stale count, repair overflow, verifier result, and activation age.
3. Verify exact worker/verifier/search database identities and six-/two-/five-RPC allowlists, the
   app-level OIDC caller verification, root-ring readiness, and database pool.
4. Identify whether the cause is mutation volume, scheduler failure, stale revision churn, root
   configuration rejection, database timeout, invalid ciphertext, embedding-profile drift, or a mixed
   deployment set.
5. Confirm semantic dispatch is already lexical-only for incomplete/changing coverage.

Stop and declare S1 if private-manual content is claimable, worker/verifier/search gains a prohibited
key/RPC, semantic search uses stale coverage, or content/query material appears in telemetry.

## Recover

1. Disable semantic search explicitly and verify lexical-only responses. Do not force-activate a
   shadow generation.
2. Repair the failed dependency or roll back the incompatible deployment/configuration.
3. Run one authenticated recovery drain. Allow its leases to settle before another wave.
4. Let revision revalidation discard stale work and let repair functions enqueue current work. Never
   edit indexed revisions, coverage counters, ciphertext, or activation state directly.
5. If a generation is invalid, mark/fail it only through the reviewed lifecycle function and create a
   new shadow generation. Preserve the prior verified active generation until replacement passes.
6. Activate only after the independent verifier reports exact count/authentication parity and the
   lifecycle CAS succeeds.

## Verification and re-enable

- expected, eligible, indexed, and covered counts reconcile; missing/stale and pending counts are zero;
- verifier proof and generation revision are current and stable;
- private/deleted/archived-ineligible rows remain excluded;
- search rejects stale/incomplete generations and provider failure still yields lexical-only;
- one-use ticket/replay and exact five-RPC tests pass against the deployed search identity;
- queue age remains below one minute for 30 minutes and monitoring is fresh.

Re-enable semantic search for synthetic traffic first, then the beta cohort with release-operator
approval. Security approval is required after any custody or privacy-boundary finding.

## Evidence

Record deployment/model/generation digests, aggregate count/age snapshots, cause, drain waves,
verifier/activation result, lexical-disable interval, root-ring/database evidence references,
privacy canary result, approvals, and remaining capacity work.
