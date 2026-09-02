# Monitoring and Alerting

## 1. Purpose and current status

This document specifies the initial production monitoring contract for the interactive web/API and
the isolated organizer, index worker, generation verifier, and semantic-search services. It does not
claim that a monitoring vendor, dashboard, log drain, alert, or on-call route has been provisioned.

Monitoring must detect loss, duplication, unsafe degradation, privacy-boundary failure, and stalled
deletion or retention work without copying note text, capture text, queries, embeddings, credentials,
or owner identity into telemetry.

## 2. Authority and ownership

Before Production traffic is enabled, the release manifest must name these roles:

| Role               | Authority                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Release operator   | Acknowledges operational alerts and may roll back a deployment or disable a feature.                  |
| Database operator  | Runs approved read-only diagnostic functions and controls database-login rotation.                    |
| Security owner     | Declares a security incident, freezes evidence, rotates credentials, and approves re-enable.          |
| Key recovery owner | Generates, rotates, and retires root-ring generations; application operators cannot assume this role. |
| Support owner      | Handles owner-authorized export and deletion cases without accessing note content.                    |

One person may fill more than one role for an internal beta, but the key recovery role must
remain distinct from runtime identities. Each alert route must have a primary recipient, a backup,
and an acknowledgment target. An unattended mailbox is not an alert route.

## 3. Telemetry privacy contract

### 3.1 Allowed fields

Operational events use a versioned allowlist. A typical request event may contain only:

- schema version, timestamp, environment, service, deployment hash, and region;
- random request or trace ID generated for that request;
- allowlisted route name and HTTP method, never a raw path or URL;
- status, outcome, safe error class/code, retryability, and duration;
- bounded aggregate counts such as claimed, succeeded, retried, dead-lettered, or purged;
- bounded queue age, index coverage count, generation state, and model-token/cost totals;
- a one-way, environment-specific pseudonym only where an owner-level abuse limit cannot be
  implemented without it. The pseudonym key is independent from content, auth, cursor, and root
  keys and is never sent with the event.

Counters must clamp to documented maxima. Unexpected values are rejected rather than serialized.
The logger must construct a fresh allowlisted object; it must never serialize an exception, request,
response, database row, provider object, or arbitrary metadata map.

### 3.2 Prohibited fields

Never emit:

- capture text, note titles or bodies, structured data, tags, space names, generated blocks, search
  queries, snippets, candidate text, embeddings, prompts, or model responses;
- email addresses, raw owner/device/note/capture/job IDs, IP addresses, user agents, cookies,
  authorization values, OTPs, session material, OpenAI or Claude keys, database URLs, root-ring values or encryption-context values,
  ciphertext, MACs, wrapped keys, or Vault identifiers;
- raw URLs, query strings, headers, request/response bodies, stack-local values, shell commands, or
  unrestricted stack traces;
- mobile screenshots, replay video, or text-field breadcrumbs.

Raw platform access logs must be configured to omit or redact query strings, authorization, cookies,
and request bodies. Semantic search accepts a POST body and must never be monitored with a real
query. Error-monitoring defaults must disable PII and mask every text input. Session replay remains
off until a dedicated privacy review proves that masking survives all web and native surfaces.

### 3.3 Canary audit

For every release candidate, place one unique non-secret marker only in a synthetic private note,
exercise the applicable flows on the single Production deployment with a synthetic account, then
search every configured Vercel, Supabase, database, provider, error-monitoring, trace, analytics, and
alert sink. Search for the marker and common bearer, refresh-token, and OpenAI/Anthropic key
prefixes. Any hit is a release blocker and begins the
[suspected key exposure](../runbooks/suspected-key-exposure.md) process even when the marker is not a
real credential.

Record only the marker digest, query window, named sinks, zero/nonzero result, deployment hash,
reviewer, and evidence reference. Never record the marker itself.

## 4. Signal sources

| Source       | Required signal                                                                                                                            | Notes                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Web/API      | request totals/errors/latency by allowlisted route; capture acceptance and receipt latency; cron outcomes                                  | Scheduled handlers must emit explicit completion events, including failures.                                              |
| Organizer    | request result, recovered/requeued/dead-letter counts, safe plan result, provider (openai/anthropic) and model class, lease-conflict count | No destination, candidate, capture, owner, or key data.                                                                   |
| Index worker | request result, claim/commit/retry counts, oldest queue age, unwrap count, generation (local-hash profile)                                 | No document text, vector, key ID, or owner. No provider request exists.                                                   |
| Verifier     | request result, generation validation result, row/page counts, decrypt error class                                                         | A failed verification never logs the failing row.                                                                         |
| Search       | request result, lexical fallback count, ticket denial class, root/database duration classes                                                | No query, result IDs, snippets, embedding, ticket, or claim secret.                                                       |
| Supabase     | connection saturation, database availability, backup status (no PITR on the free plan), bounded queue aggregate functions                  | Dashboards use reviewed read-only functions, not direct content-table export.                                             |
| Root ring    | startup configuration rejection, envelope authentication failure class, generation in use per workload                                     | Root material and encryption-context values are never emitted. AWS/CloudTrail rows apply only to a funded KMS deployment. |
| Vercel       | deployment health, function errors/duration, cron delivery, regions, app-level OIDC caller rejections                                      | Five projects are monitored independently; Preview is not deployed.                                                       |
| Native beta  | crash-free sessions, launch failures, outbox age/count and capture-loss sentinel                                                           | Do not collect draft text, note content, database paths, or Keychain data.                                                |

An ordinary `/health` response proves only process liveness. Readiness is established by separate,
authenticated, content-free probes for the exact database identity, app-level OIDC caller path, root subset,
and required dependency. A readiness probe must not mutate a note, mint a reusable capability, call a
provider with content, or expose configuration details in its response.

## 5. Initial dashboards

Create one Production overview and service drill-downs. Local development never shares a data
source or default filter with Production, and there is no Preview environment.

### 5.1 Release and availability overview

- current Git commit and immutable deployment identifier for all five Vercel projects;
- web/API request rate, error rate, and p50/p95/p99 duration;
- shallow liveness and authenticated content-free readiness by service;
- capture durable-acceptance rate and receipt p95;
- oldest capture, organizer, and index queue age;
- dead-letter and terminal job count;
- semantic requests, lexical degradation, and semantic error rate;
- database connections, backup status, and root-ring configuration rejections;
- active incident, feature-disable state, and last successful restore drill.

### 5.2 Capture and organization

- received to durable to Inbox/Review/organized/failed funnel;
- organizer outcome and retry distribution;
- plan-validation failures and circuit-breaker state;
- auto/Review band distribution and correction/Undo trend;
- receipt latency and unacknowledged durable captures;
- provider requests, safe error class, token totals, and estimated cost by provider and registry-v2 model; no-key and `provider_key_invalid` Inbox fallbacks.

### 5.3 Index and search

- index jobs claimed/committed/retried/dead-lettered;
- oldest index job and active-generation coverage;
- missing/stale coverage and repair overflow;
- verifier successes/failures and activation age;
- lexical versus explicit AI-assisted search rate;
- AI-assisted ticket denials, timeout rate, and lexical fallbacks (local-hash mode has no provider failures).

### 5.4 Lifecycle and privacy

- note-retention runs, dry-run status, purged count, and batch-limit state;
- account-deletion requested/confirmed/reconciled counts and oldest incomplete age;
- deletion reconciliation findings;
- export success/failure/bytes buckets without owner or content;
- canary audit result, backup age, restore-drill age, and pre-contract backup count.

Dashboard links and provider object IDs are kept in restricted release evidence. A public release
summary may contain only the dashboard name, configuration digest, review date, and pass/fail state.

## 6. Alert rules

Thresholds are starting points and require a recorded beta review. `Warn` creates an acknowledged
work item; `Page` wakes the release operator or security owner. Low traffic does not suppress queue,
deletion, backup, root-ring, or privacy alerts.

| Signal                       | Warn                                          | Page / immediate action                                                               |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web capture/API error rate   | >1% over 10 minutes with at least 20 requests | >5% over 5 minutes, or any evidence of accepted-capture loss/duplication              |
| Capture workflow oldest age  | >2 minutes                                    | >10 minutes                                                                           |
| Organizer queue oldest age   | >2 minutes                                    | >10 minutes                                                                           |
| Organizer terminal jobs      | sustained rise                                | >10/hour or any cross-owner/unsafe-write suspicion                                    |
| Forced-Review/replan rate    | >2% weekly or 3x 24-hour baseline             | >10% weekly or sudden unexplained spike                                               |
| Receipt p95                  | >8 seconds for 10 minutes                     | >20 seconds for 5 minutes                                                             |
| Invalid-plan rate            | >2% for 30 minutes                            | >10% or source-preservation failure                                                   |
| Provider error rate          | >5% for 10 minutes per provider               | circuit breaker open >15 minutes, or a request reaching the wrong provider            |
| Index queue oldest age       | >1 minute                                     | >10 minutes                                                                           |
| Active-generation coverage   | <100% after maintenance window                | repair fails, active generation changes unexpectedly, or stale/missing >50            |
| Search semantic failure      | >5% for 10 minutes                            | lexical fallback unavailable, wrong privacy dispatch, or query telemetry suspicion    |
| Root decrypt/rewrap failures | any unexpected failure                        | sustained >5 minutes or any wrong-root/private-root access by an isolated workload    |
| Database identity/ACL probe  | any failure                                   | unexpected allow, RLS bypass, or role drift                                           |
| Deletion reconciliation      | any finding                                   | oldest incomplete >24 hours or live-data/Vault remainder after confirmed deletion     |
| Retention cron               | one failure or batch limit                    | two failures or three consecutive batch limits; disable execution while investigating |
| Backup                       | latest recovery point outside objective       | backup failure or unapproved retention drift (PITR is a deferred paid control)        |
| BYOK call anomaly            | 3x pseudonymous owner baseline                | 10x baseline or budget control bypass                                                 |
| Privacy canary               | n/a                                           | any plaintext or credential-pattern hit                                               |

If volume is too low for a percentage to be meaningful, use the minimum-count condition shown above
and always alert on invariant violations. Never tune an invariant or security alert away to reduce
noise.

## 7. Synthetic monitors

Run from a dedicated synthetic account and region set. Synthetic monitors must be rate limited and
must never use a production user's session.

1. Every minute, request the public health endpoint of each project and verify status, no-store
   headers, bounded response bytes, and the expected service name.
2. Every five minutes, perform one authenticated, content-free readiness probe per trust domain.
   Verify exact caller and dependency success without recording tokens or response bodies.
3. Every fifteen minutes in Production, from a synthetic account with no provider key, create one
   uniquely idempotent synthetic capture through the public API, poll its content-free receipt state,
   and verify exactly one terminal receipt (Inbox, because no key is configured). Purge it through
   the approved synthetic-account reset process.
4. After launch approval, a separate provider canary with a low-value key per provider may verify
   one organized capture per provider; it is disabled unless the provider-canary gate explicitly
   authorizes it.
5. Daily, verify retention, index maintenance, and backup freshness.

Synthetic monitor credentials live only in the monitoring provider's secret store. A monitor may log
its case ID and result but not its email, token, phrase, capture ID, receipt body, or deletion token.

## 8. Alert response and stop conditions

Every page links to the matching runbook and includes environment, service, alert rule, start time,
deployment hash, and dashboard time window—never event payloads.

Immediately stop promotion or disable the affected feature when any of these occurs:

- possible plaintext, query, token, key, or cross-owner disclosure;
- accepted capture loss or duplication;
- unexpected database permission success or a workload opening an envelope outside its root subset;
- semantic search cannot degrade safely to lexical-only;
- deletion confirms while live owner data remains;
- restore or backup coverage cannot be established within the plan's stated capability;
- operators cannot identify the exact deployed commit for all five services.

Feature re-enable requires the relevant runbook's verification steps, a fresh canary audit where
privacy is implicated, and approval from the release operator. Security incidents additionally
require security-owner approval.

## 9. Monitoring release evidence

For each environment, retain:

- monitoring provider and project names, alert destination, and named owners;
- dashboard, alert-rule, and synthetic-monitor configuration digests;
- screenshots or exports with content, tokens, owner IDs, project secrets, and raw URLs removed;
- test-alert timestamp, acknowledgment latency, recipient, and outcome;
- canary digest, search window, sinks checked, and zero-hit result;
- last threshold review, known blind spots, and next review date;
- immutable deployment hashes covered by the evidence.

Raw exports remain in restricted evidence storage. The public repository receives only a sanitized
summary under the rules in [Release Evidence](./RELEASE_EVIDENCE.md).
