# Monitoring and Alert Test Template

## Configuration binding

- Candidate commit:
- Dashboard specification revision:
- Alert specification revision:
- Synthetic-monitor revision:
- Monitoring provider and data region:
- Log/metric retention:
- Minute-level scheduler:
- Paging destination:
- Operator:
- Reviewer:

Do not record webhook URLs, integration tokens, account/project IDs, or private dashboard URLs.

## Dashboard checks

| Panel                                   | Source | Expected behavior | State   |
| --------------------------------------- | ------ | ----------------- | ------- |
| Capture accepted/error rate             |        |                   | pending |
| Workflow/organizer oldest age and depth |        |                   | pending |
| Retry/dead-letter rate                  |        |                   | pending |
| Receipt latency                         |        |                   | pending |
| Provider failures/circuit state         |        |                   | pending |
| Index lag and generation coverage       |        |                   | pending |
| Root-ring failures/denials              |        |                   | pending |
| Deletion reconciliation                 |        |                   | pending |
| Retention cron                          |        |                   | pending |

Confirm that labels and samples contain no note/capture text, email, token, provider key, or stable user identifier.

## Alert fire test

| Alert                    | Synthetic trigger | Fired UTC | Delivered UTC | Acknowledged UTC | Cleared UTC | State   |
| ------------------------ | ----------------- | --------- | ------------- | ---------------- | ----------- | ------- |
| Queue oldest age warning |                   |           |               |                  |             | pending |
| Queue oldest age page    |                   |           |               |                  |             | pending |
| Provider outage          |                   |           |               |                  |             | pending |
| Root-ring denial         |                   |           |               |                  |             | pending |
| Retention failure        |                   |           |               |                  |             | pending |
| Deletion finding         |                   |           |               |                  |             | pending |

- Maximum trigger-to-delivery latency:
- On-call acknowledgement owner:
- Duplicate/suppression behavior:
- Recovery notification behavior:
- Daily-cron versus alert-threshold conflict resolved:

## Evidence

- Restricted dashboard export:
- Restricted notification screenshots:
- Combined SHA-256:
- Content-safety review:
- State: pending
- Follow-up gaps:
