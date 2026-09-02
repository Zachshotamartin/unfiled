# Account Deletion Drill Template

## Candidate and authorization

- Candidate commit/deployments:
- Synthetic account opaque digest:
- Account age/data-manifest version:
- Operator:
- Reviewer:
- Started UTC:

Use only a dedicated synthetic account. Never place the email, user UUID, deletion capability, or note content in this record.

## Before deletion

| Check                                                       | State   | Safe observation |
| ----------------------------------------------------------- | ------- | ---------------- |
| Synthetic label is visible                                  | pending |                  |
| Export completed and was verified privately                 | pending |                  |
| Expected live aggregate categories exist                    | pending |                  |
| At least two sessions/devices are active                    | pending |                  |
| Deletion recovery capability is retained only by the client | pending |                  |

## Deletion and replay

- Confirmation presented and deliberately completed:
- First request outcome:
- Ambiguous-response simulation:
- Same-capability replay outcome:
- Changed-capability denial:
- Unauthenticated receipt replay outcome:
- Receipt backup-expiry date coherent:

## Postconditions

| Assertion                                                             | State   | Safe result |
| --------------------------------------------------------------------- | ------- | ----------- |
| Live notes/captures/revisions/workflows/reviews/index rows are absent | pending |             |
| Vault provider credentials are absent                                 | pending |             |
| Search tickets/capabilities are terminal or absent                    | pending |             |
| Sessions are revoked                                                  | pending |             |
| Web local encrypted state is cleared                                  | pending |             |
| iOS session, SQLCipher profile, and sync stop are cleared             | pending |             |
| Exact replay returns the original content-free receipt                | pending |             |
| No alternate account is affected                                      | pending |             |
| Backup copy is entered in expiry register                             | pending |             |
| Reconciliation reports zero findings                                  | pending |             |

## Evidence and result

- Restricted export/deletion proof:
- Evidence SHA-256:
- Backup-register row digest:
- State: pending
- Incident/follow-up:
- Reviewer sign-off:
