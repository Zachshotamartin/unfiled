# ADR-0005: Durable capture jobs use Postgres leases in Milestone C

- Status: accepted
- Date: 2026-08-30
- Supersedes: ADR-0001 decision 4 for the Milestone C capture adapter only
- Decision drivers: atomic capture acceptance; encrypted-at-rest payloads; crash recovery; deterministic local tests; minimal new operational surface before the real organizer exists.

## Context

ADR-0001 selected Vercel Workflows behind an `OrganizationJobRunner` port. Milestone C needs durable capture acceptance and visible queued, processing, terminal, failure, and retry states before Milestone D introduces a real routing model. The capture and its organization job must be committed exactly once in the same transaction. Captured content must remain an authenticated encryption envelope in Supabase and must not be copied into workflow logs, URLs, error messages, or another provider's durable payload.

Vercel Workflows is not currently installed or configured in this repository. Making it the first adapter now would add a second durable state machine while the authoritative capture, idempotency, receipt, and retry transitions already need to live next to user-owned Postgres data.

## Decision

Milestone C uses the existing Supabase Postgres database as the durable job adapter:

1. `create_capture_with_job` atomically stores an encrypted capture envelope and a unique organization job.
2. Service-only RPCs claim jobs with `FOR UPDATE SKIP LOCKED`, bounded attempts, an opaque lease token, and lease expiry.
3. Completion and failure RPCs require the current lease token and are replay-safe. Expired leases are recovered and requeued with bounded exponential backoff.
4. The Next.js `after()` hook is a best-effort latency accelerator after a durable create, retry, list, detail, or receipt response. It is never the source of durability.
5. An authenticated cron route recovers dormant work. A daily checked-in schedule remains compatible with Vercel Hobby; a production Pro project should use the documented per-minute schedule. Active clients also retrigger the drain through owner-scoped reads.
6. Worker claims are restricted to `ai_assisted` captures. `private_manual` captures settle directly into Inbox and are never decrypted by the organization worker.
7. The workflow receives only identifiers, metadata, and an authenticated encrypted-content envelope from Postgres. The server reconstructs the expected user/capture/version context before decryption and exposes neither envelope nor keyed fingerprint through public APIs.

`CaptureWorkflowStore` is the current `OrganizationJobRunner` adapter boundary. The deterministic Milestone C organizer only verifies that eligible content can be authenticated and then settles it into Inbox. It does not persist derived plaintext or claim routing effects that do not exist.

## Alternatives considered

- Vercel Workflows immediately: matches ADR-0001, but adds an unconfigured provider and duplicates durable transition state before real organization exists.
- Fire-and-forget Next.js background work: provides low latency but loses work on process termination and deployment, so it cannot be authoritative.
- Cron without leases: simple, but concurrent invocations can process one capture more than once and a crash has no safe recovery owner.
- Plaintext job payloads: operationally easy, but unnecessarily copies sensitive notes into another persistence and observability boundary.

## Consequences

The database now carries queue polling and lease bookkeeping. A dormant Hobby deployment can wait until its daily recovery invocation if every prompt `after()` run fails and no client returns; this is a recovery bound, not the normal-path target. Vercel Pro should run the recovery route every minute. Service-role credentials and content keys remain server-only, and all service responses and telemetry must stay content-free.

The keyed idempotency fingerprint uses an independent stable secret. Ordinary envelope-key rotation rewraps data keys and retains this fingerprint key. An incident-driven fingerprint-key rotation requires an audited migration that authenticates each envelope and recomputes every stored fingerprint before the new key becomes active.

This decision encrypts captured payloads only. The Milestone B note and revision tables still contain plaintext Markdown, and existing server-side search indexes that plaintext. Production launch is blocked from claiming that notes are fully encrypted until a separate cross-cutting migration encrypts note bodies, revisions, generated content, mutation snapshots, and search material or an accepted replacement architecture removes those plaintext paths.

This adapter provides at-least-once execution with exactly-once committed transitions and effects. The lease token prevents a stale worker from completing after recovery. Database tests must cover competing claims, replay, lease expiry, retry exhaustion, owner isolation, and service-only grants.

## Upgrade path

Revisit the adapter at the Milestone E/G operational gate, or sooner if Postgres polling load, function duration, or recovery latency breaches its budget. A Vercel Workflows adapter should start a workflow with only the durable `jobId`; it should claim and transition the same Postgres job through the existing port and RPC invariants. Encrypted content remains in Supabase and is fetched only inside an authenticated execution step. Migration must drain or leave compatible all existing Postgres jobs, run both adapters idempotently during cutover, and prove that no content enters workflow histories or logs.
