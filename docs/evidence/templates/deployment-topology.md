# Deployment Topology Evidence Template

## Candidate

- Commit SHA:
- Environment: production (Preview deployments are intentionally not built)
- UTC observation window:
- Operator:
- Reviewer:

Use public aliases or opaque hashes only. Keep raw platform project/account IDs and management-plane exports in restricted evidence.

## Five-project inventory

| Trust domain  | Public stable alias | Expected commit | Region | Ownership proved | Restricted evidence digest |
| ------------- | ------------------- | --------------- | ------ | ---------------- | -------------------------- |
| Web/API       |                     |                 |        | pending          |                            |
| Organizer     |                     |                 |        | pending          |                            |
| Index worker  |                     |                 |        | pending          |                            |
| RAG verifier  |                     |                 |        | pending          |                            |
| Hybrid search |                     |                 |        | pending          |                            |

## Separation assertions

| Assertion                                                                          | State   | Observation |
| ---------------------------------------------------------------------------------- | ------- | ----------- |
| Every alias resolves to its recorded project                                       | pending |             |
| No Preview deployment exists (Ignored Build Step confirmed)                        | pending |             |
| Deployment Protection protects Preview deployments only                            | pending |             |
| Only exact web Trusted Source reaches isolated routes                              | pending |             |
| Browser authorization/cookies are denied by isolated routes                        | pending |             |
| Each workload holds only its root-ring subset (AWS role in the deferred custodian) | pending |             |
| Database sessions report the exact reviewed non-bypass role                        | pending |             |
| RPC allowlists are organizer 11, worker 6, verifier 2, search 5                    | pending |             |
| Private-manual roots are denied to AI workloads                                    | pending |             |
| Search lacks organizer/index/verifier/write/BYOK capability                        | pending |             |
| No isolated service has a Supabase service-role credential                         | pending |             |
| TLS hostname and certificate validation pass                                       | pending |             |

## Health and fail-closed probes

- Liveness observations:
- Dependency-readiness observations:
- Wrong-caller result:
- Wrong-environment result:
- Wrong-subset/root result:
- Provider/database/root-ring outage behavior:

A shallow HTTP 200 is not dependency-readiness evidence.

## Evidence and conclusion

- Restricted management-plane export reference:
- Restricted database probe reference (CloudTrail only in the deferred AWS custodian):
- Combined SHA-256:
- Sanitization reviewer:
- State: pending
- Blockers:
