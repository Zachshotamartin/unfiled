# Suspected Key or Content Exposure

## Severity and scope

Treat as S1 until scoped when any note/capture/query/prompt/response, auth/session/OTP value, database
credential, user OpenAI or Claude key, cursor/auth pepper, content key, wrapped-key context, a root
from the Vercel Sensitive root ring, Apple signing credential, or production secret may have entered
an unauthorized store, log, person, project, environment, or response. An unexpected database allow,
a workload holding a root outside its subset, and a missing log window are also S1.

Do not paste the suspected value into the incident record to prove exposure. Identify it by secret-
manager version, resource reference, type, and one-way digest created in a trusted environment.

## Authority and first response

The security owner commands the incident. Release, database, key recovery, provider, and support
owners perform only their assigned actions. Preserve evidence before ordinary retention deletes it,
but never broaden access or copy content into a new system to preserve it.

External reports enter through [GitHub private vulnerability reporting](https://github.com/Zachshotamartin/unfiled/security/advisories/new), which was API-verified active on 2026-09-02. Never redirect a suspected exposure into the public support template or a public issue. Repository-channel verification does not substitute for incident staffing, deployed security-route proof, or an approved disclosure decision.

1. Record detection time, reporter, environment, affected surface, safe indicator digest, and
   suspected window in restricted evidence.
2. Freeze promotion and disable the narrow affected feature. For unknown scope, disable AI
   organization and semantic search, pause background drains/rewrap/retention, and preserve durable
   capture to Inbox only if its storage boundary is known safe.
3. Revoke active sessions or workload access only when the implicated identity is known; avoid
   destroying audit evidence or making an ambiguous deployment harder to identify.
4. Lock incident access to named responders and begin an action timeline.

## Classify and contain

### User session, OTP, or auth secret

- revoke affected sessions/magic links and rotate the exact pepper/signing secret through the
  provider procedure;
- verify cross-owner access logs and RLS/authorization denials;
- never attempt to validate a leaked token against a content endpoint.

### Database login or service credential

- disable the owning workload and follow [database-login rotation](./database-login-rotation.md);
- audit role attributes, grants, sessions, SQL audit metadata, and Vercel secret/project scope;
- rotate the web service-role key separately if implicated; do not give it to isolated workloads.

### User BYOK key (OpenAI or Claude) or evaluation/operator key

- for a user key, mark/destroy the exact Vault credential for that provider through owner/incident
  policy and tell the user to rotate it at the provider; deleting one provider's key leaves the other
  intact. There is no provider-key KEK or content-key rotation substitute;
- if a request reached the wrong provider (a Claude key at OpenAI or an OpenAI key at Anthropic),
  treat it as a code defect: disable AI organization, preserve the job snapshot, and fix forward;
- for a dedicated evaluation key or a future operator key, revoke it at the provider, replace it only
  in its owning secret store, and inspect usage/billing without prompts or bodies.

### Content-encryption root (Vercel Sensitive root ring)

- disable affected decrypt/encrypt paths and pause rotation/rewrap;
- generate a new root generation for the affected family through the rotation procedure in
  `HUMAN_SETUP.md` (new material, registry/ring/retired-list update, redeploy of every project that
  carries the family), rewrap owner intermediate keys through the locked CAS RPC, and retire the old
  root; never place root material in a non-Sensitive variable, another project, a ticket, or a log;
- audit which projects held the family and whether Vercel access logs show unexpected environment
  reads;
- do not remove a retired generation until all references reach zero and restore passes.
- deferred (funded AWS KMS only): remove the compromised runtime identity, preserve CloudTrail, and
  use KMS recovery-owner controls through reviewed Terraform.

### Content, query, or telemetry leak

- disable the emitting route/integration, stop log drain/replay ingestion where safe, and prevent
  further retention/replication;
- ask the vendor to restrict access and begin deletion under its incident process;
- search all named sinks by indicator digest/time, not by copying the plaintext again.

### Apple signing credential

- revoke/rotate in Apple Developer/App Store Connect, inspect signing/upload history, and suspend
  affected distribution. Do not place signing material in repository or generic CI secrets.

## Investigate

Establish affected identity, permissions, data class, time range, projects/environments, access/use,
downstream copies, backup impact, and users. Use Vercel, Supabase, provider, secret-manager, Apple,
and monitoring audit references (and CloudTrail only in a funded AWS KMS deployment). Export only the minimum restricted metadata and hash every
artifact. Avoid raw request/response/database rows unless legal/security review explicitly requires
them and the evidence vault is approved for that data class.

Stop if evidence collection would cause another disclosure, key identity/contract state is ambiguous,
or an unapproved operator would gain content/key access.

## Eradicate, recover, and notify

1. Patch the root cause and pass local/CI security gates.
2. Rotate/revoke exact affected credentials and verify prior versions fail. Reconcile queue, receipts,
   deletion, and backups.
3. Deploy a complete compatible set; run exact identity/allow-deny, privacy canary, and synthetic
   product checks.
4. Restore features gradually only after security-owner approval and fresh monitoring evidence.
5. Notify affected users plainly and promptly based on actual scope and applicable obligations. State
   what happened, data/period, containment, user action such as provider-key rotation, and contact.
6. File a blameless postmortem/ADR with sanitized findings and owned corrective actions.

## Evidence and closure

Retain timeline, indicator/resource references, affected permission matrix, audit-query windows,
credential versions revoked/created, configuration/deployment digests, canary and negative probes,
backup-copy assessment, user-notification decision, approvals, and corrective-action deadlines.

Closure requires no active unauthorized access, prior credentials denied, known copies handled,
monitoring restored, affected data/backup scope documented, users notified where required, and all
critical corrective actions complete.
