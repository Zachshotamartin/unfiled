# Release Evidence

## 1. Purpose

Every Unfiled release must be reproducible from one immutable commit and must distinguish code,
local verification, deployed configuration, and manually witnessed behavior. This document defines
the release manifest and evidence custody. It does not itself certify a release.

## 2. Evidence classes

### 2.1 Public sanitized evidence

Safe to commit or link publicly:

- repository commit, tag, pull request, GitHub Actions run, and published release URL;
- test counts, aggregate coverage, pass/fail, durations, tool versions, and configuration digests;
- redacted deployment aliases and one-way deployment/configuration digests;
- restore date, observed RPO/RTO, pass/fail, and sanitized findings;
- named policy/runbook versions and approver roles;
- screenshots containing synthetic UI data only, with tokens, account IDs, browser chrome, and
  private URLs removed.

### 2.2 Restricted raw evidence

Store only in an access-controlled evidence vault with audit logging and retention:

- Vercel project/deployment IDs, team IDs, protected aliases, environment-variable inventory
  (names and Sensitive flags only), Deployment Protection settings, and Ignored Build Step
  configuration;
- Supabase project/backup IDs, database hosts, operator transcripts, and Vault catalog output;
- root-ring generation records (root IDs, generations, statuses) and, in a funded AWS deployment,
  account/role/key ARNs, Terraform state, CloudTrail records, and KMS context values;
- provider project/key metadata, billing controls, and live-evaluation raw reports;
- signed archives, provisioning profiles, App Store Connect/TestFlight identifiers, and device logs;
- HAR, trace, log, alert, and canary-search exports.

Neither class may contain secrets, session material, provider keys, database passwords, note/capture
content, raw canary markers, search queries, prompts, responses, embeddings, or local database keys.
Restricted does not mean content-bearing.

## 3. Release manifest

Create one immutable manifest per candidate. It must contain these fields:

```text
release: semantic version and candidate number
commit: full Git SHA
tag: signed or protected release tag
createdAt: UTC timestamp
operator: named role
scope: web/API, five isolated services, database, native build
changeSummary: content-free description
migrationHead: migration filename and checksum digest
contractState: expand_compatible or contracted
deploymentSetDigest: digest over the five immutable deployment IDs and commit
rootRegistryDigest: digest only (custodian vercel-sensitive-env-v1 in the free beta)
providerRegistryVersion: non-secret version (organization-model-registry-v2)
ci: PR and post-merge run URLs plus conclusions
productionEvidence: manifest references and conclusions (no Preview deployment exists)
nativeEvidence: archive/TestFlight/device references and conclusions
backupEvidence: backup/restore/expiry references and conclusions
monitoringEvidence: dashboard/alert/canary configuration digests and test result
approvals: gate, approver role, UTC timestamp, decision
knownLimitations: explicit user-visible limitations
result: pass, fail, or withdrawn
```

The deployment-set digest is derived in a trusted environment. Do not place its input IDs in a
public workflow log. A manifest is append-only after approval; corrections create a superseding
manifest that references the prior digest.

## 4. Gate matrix

Every row is `pass`, `fail`, `pending`, or `not_applicable` with a reason. There are no silent
waivers.

| Gate                | Minimum evidence                                                                                                                                                                                                                 | Stop condition                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Source              | Reviewed PR, immutable commit, clean tree, strict aggregate CI                                                                                                                                                                   | Commit differs from tested/deployed commit                                                                |
| CI                  | PR and post-merge runs; format/lint/type/coverage/build/database/security/infrastructure/native simulator                                                                                                                        | Missing/failed/cancelled lane                                                                             |
| Supply chain        | Frozen lockfile, dependency audit, Swift package resolution review, action/tool versions                                                                                                                                         | Unreviewed dependency drift or high advisory                                                              |
| Migrations          | Zero-to-head test, lint, checksums, remote apply to the beta project from an approved operator session, rollback/forward-fix classification                                                                                      | Destructive/ambiguous migration or wrong session identity                                                 |
| Production topology | Five distinct Vercel projects, exact roots, stable aliases, Deployment Protection set to Preview-only, Ignored Build Step confirmed, no Preview deployment                                                                       | Shared workload secret/project or a built Preview targeting the beta database                             |
| Trust domains       | App-level OIDC caller verification, exact database logins/RPC allowlists, per-workload root subsets (AWS KMS allow/deny and CloudTrail only in a funded deployment)                                                              | Any unexpected allow or missing deny evidence                                                             |
| Provider            | Registry-v2 model pins, provider-key entry through the UI on a synthetic account, current deterministic reports and live reports for both providers, retention disclosure                                                        | Missing live report, operator key in the free beta, or content-bearing telemetry                          |
| Product acceptance  | Flagship iPhone capture to web inspection, conflict/undo/export/deletion, accessibility                                                                                                                                          | Data loss, duplicate, stale overwrite, or inaccessible critical flow                                      |
| Privacy canary      | Zero hits across every configured sink                                                                                                                                                                                           | Any hit or unsearched sink                                                                                |
| Performance         | Production synthetic-account browser/Core Web Vitals/API/load evidence with cold samples                                                                                                                                         | Published budget exceeded without approved scope reduction                                                |
| Monitoring          | Dashboards, alerts, synthetic probes, test page acknowledgment                                                                                                                                                                   | Unrouted page, blind critical signal, or privacy-unsafe telemetry                                         |
| Backup/restore      | Fresh backup, restore within objective, deletion replay, backup-expiry register                                                                                                                                                  | Failed/stale drill or unavailable compatible key/deployment                                               |
| Web deployment      | Five immutable deployment IDs, health/readiness, canary, rollback target                                                                                                                                                         | Mixed commit set or unknown rollback target                                                               |
| Native              | Signed archive inspection, privacy manifest, TestFlight, physical device/SQLCipher/widget matrix                                                                                                                                 | Wrong entitlement/endpoint, plaintext DB, capture loss, or unsigned-only evidence                         |
| Legal/support       | Reviewed privacy/terms/security/support/deletion text; controlled-origin route proof; verified private vulnerability reporting; content-free public support intake; private account-support path; operator/jurisdiction decision | Missing private account path, unproved origin, unreviewed operator/legal terms, or claim exceeds evidence |

AI-assisted search and BYOK are independent feature gates. The free beta ships BYOK-only (no
app-managed provider mode) and lexical-strength local-hash AI-assisted search; the manifest must
state the exact state and must not describe that search as semantic.

## 5. Release sequence

1. Freeze the candidate commit; generate dependency, migration, OpenAPI, Terraform, and native
   package digests.
2. Open the release PR and require strict aggregate CI. After merge, require the post-merge run for
   the same commit.
3. Apply migrations to the beta Production project through an approved operator session after a
   clean local zero-to-head run. Record checksums and contract state (`expand_compatible`).
4. Deploy isolated worker, verifier, organizer, and search projects first; deploy web last. Verify
   all five immutable deployment IDs map to the candidate commit and that no Preview deployment
   was built.
5. Run synthetic-account acceptance on the Production deployment, the cloud canary-log audit,
   performance/load evidence, exact identity/ACL probes, provider gates for both providers, export,
   and deletion reconciliation.
6. Verify dashboards/alerts and a tested rollback target. Confirm a fresh backup and applicable
   restore drill.
7. Obtain Production migration and promotion approval. Apply only expand-compatible migrations
   during ordinary release; C.5d contraction follows its separate owner-only procedure.
8. Keep the same verified deployment set, repeat health/readiness/canary checks, and monitor the
   initial window. Do not rebuild between evidence collection and cohort admission.
9. For native beta, create and inspect the signed archive, upload to TestFlight, and complete the
   physical-device matrix against the approved Production origin.
10. Finalize the manifest, changelog, known limitations, support instructions, and rollback target.

## 6. Rollback and forward-fix rules

- Web/service rollback restores the prior verified five-deployment set. Do not mix service commits.
- An expand-compatible migration remains in place when old code can safely ignore it.
- A data migration or C.5d contraction is never reversed ad hoc. Use the reviewed forward fix or the
  separately approved restored-backup incident path.
- Disabling AI-assisted search means lexical-only dispatch; it never means routing private/default
  queries through the search service.
- Disabling AI organization keeps durable capture and Inbox fallback available.
- Native rollback uses a prior TestFlight/App Store build only when its API contract remains
  supported and its security/privacy state is acceptable.

Use [deployment rollback](../runbooks/deployment-rollback.md) for execution.

## 7. Stop conditions

Withdraw the candidate when:

- evidence belongs to another commit, environment, project, model, or migration head;
- a required raw artifact is missing, expired, unreviewable, or contains prohibited data;
- the canary audit has an unsearched sink or nonzero result;
- backup/restore, deletion, exact identity, or root-subset deny evidence is incomplete;
- the deployed topology cannot be rolled back as one compatible set;
- Production would require enabling an unapproved feature, secret fallback, broad database role, or
  plaintext compatibility path;
- the signed archive contains a development endpoint, wrong identifier, missing extension, or wrong
  App Group entitlement.

## 8. Evidence retention and review

- Keep public manifests for the life of the release.
- Keep restricted deployment, security, restore, and signing evidence for at least the applicable
  backup-retention window plus the incident-review period selected by the security owner.
- Limit access to named operators and review access quarterly.
- Hash artifacts before storage and record the digest in the manifest.
- Test restoration of the evidence vault annually; do not store the only copy beside production.
- Mark withdrawn and failed candidates explicitly. Never delete failure evidence merely because a
  later candidate passes.
