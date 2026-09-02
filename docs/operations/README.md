# Operations

This directory defines Unfiled's release and production operating contract. The documents are
procedures and target controls; their presence is not proof that a cloud account, dashboard,
backup, deployment, or drill exists.

## Documents

- [Monitoring and alerting](./MONITORING_AND_ALERTING.md) defines content-free telemetry,
  dashboards, alert routing, synthetic probes, and stop conditions.
- [Backup and restore policy](./BACKUP_AND_RESTORE_POLICY.md) defines backup scope, access,
  retention, deletion-copy handling, and restore-drill requirements.
- [Release evidence](./RELEASE_EVIDENCE.md) defines the release manifest, evidence custody,
  promotion gates, and the difference between public summaries and restricted raw evidence.
- [Runbooks](../runbooks/README.md) contains incident, recovery, support, and release procedures.

## Status language

Use these terms exactly:

- `implemented`: code or documentation exists in the repository.
- `locally verified`: a credential-free local or CI gate passed.
- `deployed`: a named cloud deployment exists and its immutable identifier was recorded.
- `operationally verified`: the deployed control was exercised and produced retained evidence.
- `release ready`: every applicable release-manifest gate is `pass` and no stop condition remains.

Never infer a later state from an earlier one. In particular, a green local test, Terraform
validation, health response, or unsigned simulator build is not deployment, restore, key-custody,
signing, or physical-device evidence. Live evidence for the free private beta is recorded in
`FINAL_REPORT.md`.
