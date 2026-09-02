# Runbooks

These runbooks are the executable companion to the [operations policy](../operations/README.md).
Their existence is not evidence that an environment, alert, backup, or response capability has been
provisioned or exercised.

## Execution rules

1. Confirm the environment, alert source, current deployment-set digest, and acting authority before
   taking action.
2. Prefer read-only, content-free diagnostics. Never paste a token, cookie, key, database URL,
   owner ID, note/capture text, search query, ciphertext, provider response, or raw log event into a
   shell argument, ticket, chat, or evidence document.
3. Use a trusted workstation and approved secret manager. Commands containing credentials are
   entered interactively or read through a protected file descriptor; they are not recorded.
4. Treat every state-changing step as separately authorized. An investigation does not authorize a
   deployment, migration, credential rotation, deletion, restore, or feature enablement.
5. Stop when identity, target, backup, key generation, contract state, or outcome is ambiguous.
6. Record UTC timestamps, roles, immutable deployment/configuration digests, safe counts, decisions,
   and evidence references. Raw platform evidence stays in restricted storage.

## Incident priority

| Priority | Examples                                                                                | Initial action                                                                            |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| S1       | Cross-owner/content/key exposure; unexpected root/database allow; accepted capture loss | Freeze the affected feature, page security owner and release operator, preserve evidence. |
| S2       | Auth bypass, single-owner exposure, deletion failure, unusable restore                  | Contain within 15 minutes and escalate to security owner.                                 |
| S3       | Queue/provider/search outage with safe fallback; telemetry gap                          | Disable the affected feature if recovery is not immediate; open incident.                 |
| S4       | No-impact drift or runbook/tooling defect                                               | Track and repair before the next release.                                                 |

## Index

| Situation                                                                    | Runbook                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider unavailable, throttled, or returning unsafe responses               | [Provider outage](./provider-outage.md)                                 |
| Organizer jobs are delayed, retrying, or dead-lettering                      | [Organizer backlog](./organizer-backlog.md)                             |
| Lease conflicts or forced-Review outcomes spike                              | [Lease conflict and forced-Review spike](./organizer-lease-conflict.md) |
| Encrypted index jobs lag or coverage is incomplete                           | [Index backlog](./index-backlog.md)                                     |
| Provider circuit breaker remains open                                        | [Stuck circuit breaker](./stuck-circuit-breaker.md)                     |
| A release must return to a prior deployment                                  | [Deployment rollback](./deployment-rollback.md)                         |
| A database migration fails or becomes ambiguous                              | [Migration failure](./migration-failure.md)                             |
| An isolated PostgreSQL credential must rotate or be revoked                  | [Database-login rotation and revocation](./database-login-rotation.md)  |
| Key-custody configuration is rejected, drifts, or a root boundary is suspect | [Key-custody denial or outage](./kms-denial-outage.md)                  |
| A managed backup or PITR point must be proven or restored                    | [Restore from backup](./restore-from-backup.md)                         |
| A user requests help obtaining an export                                     | [User export support](./user-export-support.md)                         |
| A content, session, database, provider, or root-ring secret may be exposed   | [Suspected key exposure](./suspected-key-exposure.md)                   |
| Semantic search must be disabled or safely degraded                          | [Semantic-search disablement](./semantic-search-disablement.md)         |
| Account deletion has an incomplete or inconsistent outcome                   | [Deletion reconciliation](./deletion-reconciliation.md)                 |
| The synthetic portfolio account must be created, verified, or reset          | [Demo account](./demo-account.md)                                       |

## Re-enable rule

Do not re-enable a disabled feature merely because an alert cleared. Complete that runbook's
verification, repeat any required privacy/identity canary, confirm monitoring is receiving fresh
events, and obtain the named approval. A security-related incident always requires security-owner
approval.
