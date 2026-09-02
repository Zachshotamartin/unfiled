# Backup and Restore Policy

## 1. Status and scope

This is the target policy for the single Production environment of the free private beta (Vercel
Preview deployments are not built). It does not claim that a Supabase backup, point-in-time recovery
stream, restore project, or restore drill exists. The free Supabase plan provides no PITR and no
isolated restore project; those rows below are recorded as deferred, and the irreversible storage
contraction stays blocked until they are funded and proven.

The policy covers:

- the Supabase PostgreSQL database, including encrypted aggregates, operational metadata, key
  records, Vault state, deletion receipts, and migration state;
- the Vercel Sensitive root-ring registry (root IDs, generations, and statuses only; never material)
  and, in a future funded deployment, separately controlled Terraform state and AWS IAM/KMS
  configuration;
- Vercel deployment/configuration metadata needed to identify a compatible application build;
- recovery evidence and the register of backups that may retain deleted or pre-contract data.

It does not export root-ring material, provider keys, user sessions, Apple signing identities, or
plaintext note content as a backup mechanism.

## 2. Recovery objectives

Before controlled beta, the release operator must record provider-supported objectives and ensure
they are no weaker than:

| Environment                    | Recovery point objective              | Recovery time objective | Restore drill                                         |
| ------------------------------ | ------------------------------------- | ----------------------- | ----------------------------------------------------- |
| Free private beta (Production) | the free plan's actual backup cadence | 4 hours                 | once before cohort admission, within plan capability  |
| Funded beta (deferred)         | 15 minutes with PITR                  | 4 hours                 | quarterly and within 30 days before first public beta |

The free plan cannot supply PITR, so the security owner must approve the narrower private beta and
publish the weaker objective before personal-data enrollment. Scheduled backup success is not restore
evidence.

## 3. Backup sets and custody

### 3.1 Database and Vault

- Enable whatever managed backups the free plan provides in Production and record the actual
  cadence; PITR is deferred. There is no Preview backup set because Preview is not deployed.
- Confirm Vault tables and bindings are included in the provider's documented backup/restore model.
- Encrypt provider-managed backups under the provider's approved controls and restrict restore and
  download permission to named database/recovery operators.
- Never download a production logical dump to a developer laptop for testing.
- Never seed a local or scratch environment by restoring Production data for testing. A funded
  restore drill uses an isolated recovery project with no public traffic; the free beta records the
  plan's actual restore capability instead.

### 3.2 Root ring (free beta) and KMS/Terraform (deferred)

- The Vercel Sensitive root ring is not exported and is not a backup. Root material exists only in
  the Production Sensitive variables of the projects that carry each family; the key recovery owner
  keeps the generation record (root IDs, generations, statuses) in restricted evidence and
  regenerates material only through the rotation procedure in `HUMAN_SETUP.md`.
- A restored database is unreadable without the root generations that wrapped its owner keys.
  Recovery restores the database first, then supplies the scratch environment only the exact root
  generations required, as Sensitive variables bound to the scratch project.
- Preserve every key record's exact root key ID, generation, wrapped bytes, record version, previous
  root, rewrap count, and four opaque encryption-context identifiers.
- Retain a compatible previous application deployment while any supported backup may require it.
- Deferred (funded AWS KMS only): store Terraform state in a versioned, encrypted remote backend with
  locking and access logs; treat it as restricted evidence; never export KMS roots.

### 3.3 Deployment metadata

For every recovery point used by a release, record the database migration head, schema digest,
application commit, all five Vercel deployment identifiers, root registry digest, provider/model
registry version (`organization-model-registry-v2`), and C.5d contract state. Store identifiers in restricted evidence; the public
summary uses digests or redacted references.

## 4. Retention and deletion copies

- Target normal database-backup age-out at 30 days or less.
- A live account deletion removes live rows and Vault secrets but does not claim immediate deletion
  from immutable provider backups. Product copy must say that backup copies expire under the
  published retention period.
- Maintain a restricted backup-expiry register with backup class, creation window, earliest/latest
  expiry, contract state, whether it may contain a deleted account, verification owner, and final
  expiry evidence. Do not record owner IDs, emails, note content, ciphertext, or credentials.
- After the final possible expiry, repeat a restore-denial or catalog-absence check and close the
  register entry. Provider policy text alone is insufficient.
- A legal hold or provider retention change requires security and privacy review before it extends
  the published window.

## 5. Pre-contract backups

The C.5d storage contract is a one-way Production operation. Before contraction:

1. pause signups, interactive writes, organizer/index drains, retention, and schema changes;
2. record the exact compatible deployments and migration checksum;
3. create a named PITR point or backup (requires the funded plan);
4. restore it to an isolated scratch project and complete the authentication/parity drill;
5. record the backup's expiry window and approver;
6. contract only after the restored copy passes.

Pre-contract backups may retain the historical plaintext schema even after the live store is
contracted. Until every such backup expires and the absence check passes, public claims must not
assert historical cryptographic erasure or end-to-end encryption.

## 6. Restore drill frequency and cases

Run the [restore from backup](../runbooks/restore-from-backup.md) procedure:

- quarterly;
- within 30 days before first public beta;
- before C.5d contraction;
- after changing the database plan, backup configuration, custodian, root registry format,
  encryption envelope version, Vault integration, or restore operator roster;
- after a backup, PITR, root-ring, or deletion incident.

Each drill must cover:

- restore to an isolated scratch project with outbound/provider calls disabled;
- schema head and migration checksum;
- strict database-login and RLS/grant checks;
- envelope authentication and projection parity using synthetic fixtures only;
- root-generation compatibility and retired-root handling;
- active-generation/index safety and lexical-only degradation;
- Vault metadata/secret behavior using a low-value synthetic provider key where authorized;
- account-deletion receipt replay and zero live-row/Vault/index findings;
- C.5d contract-state compatibility;
- measured RPO/RTO and complete scratch teardown.

## 7. Stop conditions

Stop the drill and block release if:

- the source backup, target project, contract state, or compatible deployment is ambiguous;
- the scratch target can receive public traffic or can reach a provider unexpectedly;
- any operator would need to copy root material, a database password, a provider key, ciphertext,
  or note content into a transcript, command argument, ticket, or chat;
- authentication/parity, exact database identity, RLS/grants, Vault behavior, or deletion replay
  fails;
- a required root generation is absent from the restricted generation record;
- restored content appears in logs, traces, analytics, errors, or exports;
- the restore exceeds its RTO without an approved incident declaration.

Do not weaken encryption, add a plaintext fallback, hand-create removed columns, or grant a runtime
role broader access to make a drill pass.

## 8. Evidence and review

The restricted drill record contains:

- drill ID, date, environment, operators, approver, source backup/PITR reference, and scratch project;
- application commit/deployment set, migration head/checksum, contract state, and root registry digest;
- start, recovery-point, database-ready, verification-complete, and teardown timestamps;
- pass/fail for every case, content-free counts/digests, RPO/RTO, gaps, and corrective actions;
- confirmation that provider egress stayed disabled and scratch data was destroyed;
- backup-expiry register updates.

The public summary contains only the date, objective, observed RPO/RTO, pass/fail, sanitized gap
summary, evidence digest, and approver role. A failed drill remains visible; a later passing drill
does not erase it.
