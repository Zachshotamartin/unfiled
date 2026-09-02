# Canary and Log Audit Template

## Authorization

- Candidate commit/deployments:
- Synthetic account class:
- Approved sinks:
- UTC query window:
- Operator:
- Reviewer:

Create a unique synthetic marker in restricted memory. Never write the marker into this file. Record only its SHA-256 digest:

- Canary SHA-256:
- Token-prefix patterns inspected:

## Exercised paths

| Path                             | State   | Safe observation |
| -------------------------------- | ------- | ---------------- |
| Web capture and manual note      | pending |                  |
| Organizer and provider route     | pending |                  |
| Index worker and embedding route | pending |                  |
| Verifier                         | pending |                  |
| Explicit AI-assisted search      | pending |                  |
| Private-manual capture/search    | pending |                  |
| Export and account deletion      | pending |                  |
| Error and retry paths            | pending |                  |

## Sinks inspected

| Sink                                                 | Query bounds | Canary hits | Credential-pattern hits | Reviewer |
| ---------------------------------------------------- | ------------ | ----------- | ----------------------- | -------- |
| Vercel web logs/traces                               |              |             |                         |          |
| Organizer logs                                       |              |             |                         |          |
| Worker logs                                          |              |             |                         |          |
| Verifier logs                                        |              |             |                         |          |
| Search logs                                          |              |             |                         |          |
| Supabase API/database logs                           |              |             |                         |          |
| Vercel environment/logs (root-ring names only)       |              |             |                         |          |
| OpenAI usage diagnostics (user key)                  |              |             |                         |          |
| Anthropic usage diagnostics (user key)               |              |             |                         |          |
| AWS KMS/CloudTrail context (deferred custodian only) |              |             |                         |          |
| Error monitoring                                     |              |             |                         |          |
| Analytics/cache inspection                           |              |             |                         |          |

Any nonzero canary, note-content, provider-key, bearer-token, refresh-token, or cookie hit fails the gate and starts the suspected-key-exposure or privacy-incident runbook.

## Evidence

- Restricted query exports:
- Combined export SHA-256:
- Sanitization result:
- State: pending
- Incident reference if failed:
