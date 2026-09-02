# Restore Drill Evidence Template

## Authorization and binding

- Candidate commit:
- Migration head:
- Storage-contract state:
- Backup class and opaque SHA-256 identifier:
- Backup creation UTC:
- Restore point UTC:
- Approved scratch environment:
- Operator:
- Independent recovery approver:
- Reviewer:
- Drill start UTC:

Never record a raw backup ID, project reference, database URL, root-ring value, KMS ARN, credential, or restored content.

## Preconditions

| Check                                               | State   | Observation |
| --------------------------------------------------- | ------- | ----------- |
| Backup/PITR source is in retention                  | pending |             |
| Scratch target is isolated from Production traffic  | pending |             |
| Production clients cannot resolve scratch           | pending |             |
| Restore authorization is approved                   | pending |             |
| Root generations are separately supplied to scratch | pending |             |
| Logging and query capture are content-safe          | pending |             |
| Destruction owner and deadline are assigned         | pending |             |

## Timings

- Restore requested UTC:
- Database available UTC:
- Required root generations supplied to scratch UTC:
- Verification complete UTC:
- Scratch destroyed UTC:
- Observed RPO:
- Observed RTO:
- Target met:

## Verification

| Assertion                                                        | State   | Content-free result |
| ---------------------------------------------------------------- | ------- | ------------------- |
| Schema and migration head match the restore point                | pending |                     |
| Required key records preserve context/version metadata           | pending |                     |
| Sample envelopes authenticate under exact owner/resource context | pending |                     |
| Wrong owner/resource/key context fails                           | pending |                     |
| Content-parity digests match without logging plaintext           | pending |                     |
| Active/retired/revoked root behavior matches policy              | pending |                     |
| Private-manual data is unavailable to AI workloads               | pending |                     |
| Index generations are consistent or safely rebuildable           | pending |                     |
| Deleted-account replay remains terminal                          | pending |                     |
| No deleted live row is resurrected into the active product       | pending |                     |
| Canary/log audit has zero hits                                   | pending |                     |

## Cleanup

- Scratch ingress disabled:
- Temporary credentials revoked:
- Scratch root variables deleted:
- Scratch deletion verified:
- Restricted artifacts retention/owner:
- Backup entered in expiry register:

## Result

- State: pending
- Gaps/incidents:
- Restricted evidence reference:
- Evidence SHA-256:
- Operator sign-off:
- Reviewer sign-off:
