# Unfiled encrypted organizer

`@unfiled/organizer` is the separately deployable AI-assisted create-or-append trust domain. It is not the web application, index worker, or verifier. It accepts no browser session, owner identifier, Supabase API key, broad database credential, static AWS credential, private-manual key, or model-provider credential.

## Security boundary

- Production PostgreSQL identity is exactly `unfiled_organizer_worker`. TLS uses hostname verification and a pinned CA chain. The executor permits only identity preflight and the eight reviewed RPCs: claim, heartbeat/revalidate, candidate projection, prepare create, prepare append, atomic commit, fail, and recovery.
- Claim and candidate RPCs supply only lease-bound, byte-bounded AI-assisted ciphertext and the exact wrapped key records required to open it. The app never accepts an owner ID from the request.
- Each candidate page carries the database-current consent controls and authoritative `isOpen` state. The organizer binds the exact controls plus `{candidateId,noteId,revision,isOpen}` manifest into revalidation, and it never decrypts a closed candidate for the planner.
- The organizer renews the authoritative lease immediately before a planner could receive plaintext and again immediately before atomic commit. A privacy flip, deletion, consent edit, lease loss, or stale revision that wins before either point fails closed.
- `@unfiled/ai-routing` is the sole unknown-plan parser and authorization/materialization boundary. The app first authorizes the candidate manifest, then obtains database-issued stable IDs and reservations, then materializes. Model-selected IDs are never persisted.
- An explicit destination must remain owned, eligible, open, and present in the authorized manifest. Expansion-disabled input cannot produce expansion. Because C.5c-3 intentionally has no generated-block reservation substrate, any otherwise authorized generated expansion becomes an encrypted `expansion_pending` Review for Milestone D instead of being written.
- A stale append may re-plan once. The first conflict atomically burns the old reservation and rebinds preparation; a second conflict returns `review_required` without publishing the stale command. The service discards the conflicted page, fetches and revalidates a current page, then seals and atomically commits a real Review command, so the database never reinterprets append ciphertext as Review.
- Reservation IDs bind the stable job identity, durable claim attempt, and deterministic per-write generation. Every database conflict that burns or invalidates a preparation advances the write generation; same-generation replay is idempotent while replan, refreshed Review, retry, and recovery cannot reuse a consumed reservation.
- The KMS workload is `organization_worker`, limited to AI-assisted object-wrap and content-MAC roots. Private-manual content cannot be projected or decrypted.
- Logs contain only a server-generated request ID, route, method, runtime, status, duration, retryability, and a safe error class. Caller-provided request IDs are ignored; the generated ID is shared by the response, log, and drain invocation for safe correlation. Responses and logs never include note or capture content.
- Claimed/candidate state is released synchronously from warm-process memory in a `finally` path, including when request abort prevents the failure RPC from running.

## Current milestone boundary

C.5c-3 supplies the isolated runtime, exact database adapter, lease-linearized drain, canonical plan authorization/materialization, stable idempotency bindings, KMS authority, cancellation, and atomic commit port. The production planner and content-mutation cipher remain deliberately unavailable until Milestone D connects the evaluated routing/materialization implementation. A deployed service therefore fails safely instead of sending content to an unapproved provider or writing a partial note. Deterministic planners and ciphers are injected only in tests.

## HTTP contract

- `GET|HEAD /health` returns `{"service":"unfiled-organizer","status":"ok"}`.
- `POST /internal/drain` accepts an empty body (defaults to `schedule`) or exact JSON `{"trigger":"manual|recovery|schedule"}`.
- The request body defaults to 1,024 bytes and is hard-capped at 16,384 bytes. The request deadline defaults to and cannot exceed 49 seconds, leaving a strict margin below the trusted web caller's deadline.
- Success is exact JSON `{claimed,completed,failed,retryScheduled}` with nonnegative safe integers and terminal totals no greater than `claimed`.
- Production accepts the exact web project through Vercel Trusted Sources and separately proves the organizer workload OIDC identity to AWS. `Authorization`, cookies, and protection-bypass credentials are rejected in production.

## Local validation

```sh
pnpm --filter @unfiled/organizer lint
pnpm --filter @unfiled/organizer typecheck
pnpm --filter @unfiled/organizer test:coverage
pnpm --filter @unfiled/organizer build
pnpm --filter @unfiled/organizer test:built-server
```

Copy `.env.example` only as a field checklist. Never copy placeholder values into production. Cloud setup is not complete until Vercel Trusted Sources, exact OIDC subjects, the two AI-assisted KMS roots, CloudTrail denial evidence for private-manual access, the exact database login, rotation, restore, and canary evidence are recorded in the repository's human setup checklist.
