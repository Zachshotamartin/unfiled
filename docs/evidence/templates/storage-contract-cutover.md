# Encrypted Storage Contract Cutover Template

## Warning

The C.5d contraction is an explicit, irreversible database-owner operation. Installing its migration does not apply it. Do not execute it from an ordinary deployment workflow, application credential, or unreviewed terminal session.

## Candidate and approval

- Candidate commit:
- Migration head:
- Production storage state before:
- Fresh readiness digest SHA-256:
- Maintenance window:
- Database-owner operator:
- Independent approver:
- Restore evidence reference:
- Pre-contract backup-register reference:

Do not place the raw readiness digest, database URL, project reference, backup identifier, key identifier, or operator credential in this public record.

## Preconditions

| Gate                                                                 | State   | Evidence |
| -------------------------------------------------------------------- | ------- | -------- |
| Encrypted backfill complete for every owner                          | pending |          |
| Decrypt-and-MAC parity verified                                      | pending |          |
| Plaintext scrub readiness recomputed                                 | pending |          |
| In-flight work is safe                                               | pending |          |
| Per-workload root subsets and denials pass (deferred with paid PITR) | pending |          |
| Restore drill is current and passed                                  | pending |          |
| Canary/log audit is clean                                            | pending |          |
| Rollback window and irreversible boundary approved                   | pending |          |
| Every pre-contract backup is registered                              | pending |          |
| Feature disable and incident owners are present                      | pending |          |

## Execution

- Exact reviewed runbook revision:
- Operation start UTC:
- Operation finish UTC:
- Content-free receipt digest:
- Catalog/ACL assertion result:
- Runtime restart/redeploy required:

Do not paste SQL containing credentials or raw operation output into this file.

## Postconditions

| Assertion                                                      | State   | Observation |
| -------------------------------------------------------------- | ------- | ----------- |
| Global state is contracted                                     | pending |             |
| Fresh owners bootstrap contracted                              | pending |             |
| Legacy plaintext columns/indexes/functions/triggers are absent | pending |             |
| Direct runtime table access is revoked                         | pending |             |
| Encrypted note/capture/search/export paths pass                | pending |             |
| Provider/root-ring/database outage still fails closed          | pending |             |
| Post-contract plaintext canary has zero durable/log hits       | pending |             |
| Backup-expiry tracking remains active                          | pending |             |

## Result

- State: pending
- Incident/rollback decision:
- Restricted operation evidence:
- Evidence SHA-256:
- Operator sign-off:
- Approver sign-off:
- Reviewer sign-off:

No complete-library encrypted-at-rest claim is permitted until this gate and the pre-contract backup-expiry gate are both passed.
