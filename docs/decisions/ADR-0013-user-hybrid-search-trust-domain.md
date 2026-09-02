# ADR-0013: User hybrid-search trust domain

- Status: accepted; implementation and credential-free local gate complete; independent audit clear; merged as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d`; deployment evidence recorded in `FINAL_REPORT.md`
- Amended 2026-09-02: §5 and the implementation record below name an AWS IAM/KMS role and a fixed provider embedding. Under [ADR-0016](./ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md) the free-beta search project receives the AI object-wrap root only from the Vercel Sensitive root ring (decrypt-only by construction of the subset), computes the query vector with `unfiled-local-hash-v1` in process, and needs no provider key. Vercel Hobby cannot provide dashboard Trusted Sources; the checked-in app-level OIDC verifier enforces the exact web caller. The AI-assisted scope is therefore lexical-strength retrieval, not semantic search. The one-use ticket, five-RPC login, and lexical-only degradation are unchanged. The `infra/aws-kms` role remains deferred paid hardening.
- Date: 2026-09-01
- Depends on: ADR-0006 application-encrypted library, ADR-0007 dedicated database capabilities, ADR-0009 private RAG runtime, and ADR-0011 owner-authorized interaction custody
- Decision drivers: keep private-manual content and private-intent queries away from embedding providers; prevent user-facing search from inheriting organizer or index-worker authority; bind every semantic request to one authenticated owner, one exact request, and one active index generation; preserve lexical search as a fail-closed path.

## Context

Unfiled already has two different search-related paths, neither of which authorizes user-facing semantic search. The owner-authorized web service decrypts the authenticated owner's notes for bounded in-memory lexical search. Separately, the index worker creates encrypted AI-assisted retrieval documents and the organizer may query that index only while holding a live organization-job lease. The organizer's query embedding, database lease, provider credential, KMS roots, and exact RPCs are scoped to capture organization, not an interactive user search.

Reusing the organizer, index worker, verifier, web database authority, or a broad Supabase credential for hybrid search would silently combine trust domains. It could let a public request select an owner, turn mixed or private-manual search intent into a provider disclosure, or give a query-serving process index repair, generation activation, content-MAC, or note-write authority. A browser-supplied owner ID or reusable bearer would not repair that boundary.

Milestone F therefore adds a fifth production Vercel trust domain dedicated to user hybrid search. This ADR authorizes its design, and the current branch implements `apps/search`, its database capability migration/login, exact Terraform OIDC/IAM/KMS identity, web coordination, and client surfaces. That implementation does not establish a real provider project, Vercel project, deployed database identity, CloudTrail record, or canary. Production remains owner-authorized lexical-only until every software and account gate below passes.

Document sources, source-capture inspection, note links, and backlinks are owner-authorized product features outside this service. They do not expand the search service's result or decryption authority.

## Decision

### 1. Deploy search as a fifth, independently attributable service

User-facing semantic retrieval is implemented in the checked-in `apps/search` service and, when released, runs only in a dedicated Vercel project rooted there. The deployed service must have its own exact Production project ID/name, Vercel OIDC subject, AWS IAM role, PostgreSQL login, provider service account/key, deployment logs, budget, alerts, and rotation record. No secret, token, database URI, project identity, cache, or runtime environment is copied from web, organizer, index worker, or verifier.

Only the exact web Production project may invoke the exact search Production origin through Vercel Trusted Sources. The search service rejects browser sessions, cookies, `Authorization`, user JWTs, protection-bypass credentials, Preview callers, workload-to-workload callers, wildcard subjects, and direct public requests. Its request contains a capability-ticket ID, a claim secret, and the exact normalized search body. It never accepts an owner ID, tenant ID, arbitrary generation, database cursor, provider, model, endpoint, API key, or KMS identifier.

The service is request scoped. It keeps query text, decrypted index material, embeddings, ranking buffers, capability secrets, and results only in bounded memory, wipes or releases them on every terminal path, and has no cross-request plaintext or embedding cache. Requests, responses, provider payloads, database parameters, errors, traces, metrics, analytics, and health endpoints must not record query text, note content, snippets, decrypted features, claim secrets, tickets, or owner identifiers. Content-free counts, durations, fixed version identifiers, safe error codes, and pseudonymous deployment-level metrics are allowed.

### 2. Semantic disclosure requires an explicit `ai_assisted` privacy filter

The owner-authorized web boundary dispatches to the semantic service only when the normalized request's privacy filter is exactly and explicitly `ai_assisted`. An omitted/default privacy filter, `mixed`, `private_manual`, or any request capable of returning private-manual notes uses only the existing owner-authorized lexical path. The web service must not speculatively embed such a query and then discard semantic results.

This rule protects both note content and query intent. A query for a private note can itself reveal private information even when no result is returned, so private-manual and mixed/default query text never reaches the search service or provider. An `ai_assisted` semantic result contains only AI-assisted candidates. Combining that result with a separate lexical result happens only in the owner-authorized web boundary and only for the same explicit AI-assisted scope.

Stale, missing, failed, draining, unverified, oversized, or incomplete AI index generations make semantic search unavailable. Every such state fails closed to a fresh owner-authorized lexical-only search; no partial semantic ranking is returned or merged.

### 3. Web mints one exact 30-second capability ticket

After authenticating the session, enforcing request limits, and normalizing the complete search request, web generates a cryptographically random 32-byte claim secret. It computes the versioned full-request SHA-256 digest over the normalized query and every normalized filter, sort, limit, and cursor field. The canonical encoding and normalization vectors are shared and versioned; omitting, reordering, widening, or adding a filter changes the digest.

After deriving the owner from the verified application session, web calls the service-role-only `begin_encrypted_user_search(uuid,text,jsonb,text)` database capability with that server-derived owner, full-request digest, normalized filter projection, and claim-secret hash. The function snapshots the owner's one active, complete, verified AI-assisted generation. It stores only the ticket ID, owner, full-request digest, exact normalized filter projection, active-generation identity and attestation, SHA-256 hash of the random claim secret, issued/expiry timestamps, and content-free lifecycle state. It stores no query, result, snippet, embedding, decrypted feature, raw claim secret, browser token, or provider credential. Expiry is fixed at 30 seconds and cannot be extended or refreshed. Clients and the dedicated search role cannot execute this creation function; the service role cannot execute any of the five search-worker functions below.

The web-to-search request carries exactly the opaque ticket ID, raw claim secret, and exact normalized body; it carries no owner ID. A client-visible next-page request receives a new ticket. Its authenticated cursor is part of the normalized body and binds the complete filter set, request version, active-generation identity/attestation, ranking version, and deterministic last-score/tie-break position. A cursor cannot change privacy, query, filters, generation, ranking version, or sort semantics.

### 4. The database atomically converts the ticket into one bounded claim

The dedicated PostgreSQL role is `unfiled_search_worker`. It is a direct TLS-only login with `NOINHERIT` and `NOBYPASSRLS`; it is not `service_role`, `authenticator`, a member of another runtime role, or reachable through PostgREST. It has no direct table, sequence, `private`-schema, public-schema-create, Vault, auth, extension, ownership, or arbitrary function privilege. The search Vercel project receives only this login and never receives a Supabase anonymous, service-role, secret, or database-owner credential.

Its public EXECUTE allowlist is exactly these five signatures:

- `claim_encrypted_user_search(uuid,text,text)`
- `list_encrypted_user_search_rag_page(uuid,text,text,jsonb,jsonb,integer,integer)`
- `verify_encrypted_user_search_snapshot(uuid,text,text,jsonb,jsonb)`
- `complete_encrypted_user_search(uuid,text,text)`
- `fail_encrypted_user_search(uuid,text,text,public.safe_error_code)`

No search-worker function accepts an owner ID, caller-selected generation, privacy override, provider choice, key ID, table name, or SQL fragment. The claim call receives only the ticket ID, raw claim secret, and recomputed full-request digest. In one locked transaction it hashes and constant-time compares the secret, verifies the exact digest, explicit AI-assisted filter, 30-second expiry, issued state, active complete generation and attestation, burns the claim-secret hash, creates a fresh hashed 30-second lease token, and changes the ticket to leased. It returns the raw lease token only to the winning search request. Concurrent or replayed claims fail; only one request can win.

Subsequent page, snapshot-verification, completion, and failure calls receive the ticket ID, raw lease token, and recomputed request digest rather than the burned claim secret. They remain bound to the same leased ticket. The page capability derives owner, generation, privacy, filters, and fixed row/byte limits from the ticket, and returns only active-generation, current-revision AI-assisted encrypted index rows. It cannot enumerate another owner or generation. Snapshot verification accepts only bounded result and cursor evidence; completion succeeds only after that exact verification. Failure accepts only an allowlisted safe code. A terminal, expired, or unverified ticket can never page, verify, complete, or return to pending state.

The role has no note/capture read or write, owner export/deletion, lexical-search, wrap reservation, root registration/rewrap, index claim/repair/publication, generation seed/drain/verify/activate, organizer claim/lease/commit, provider-key, settings, retention, or Review capability. It cannot call the six index-worker RPCs, two verifier RPCs, eleven organizer RPCs, or any owner-authorized web RPC.

### 5. KMS access is decrypt-only and AI-index-only

The search project's exact Vercel OIDC subject may assume only the dedicated search IAM role. That role may call KMS `Decrypt` only for the active and explicitly registered retired `ai_assisted` object-wrap roots needed to open already-published index documents, and only with the exact existing envelope encryption context. It receives no broad key registry.

The role is denied `GenerateDataKey`, `GenerateDataKeyWithoutPlaintext`, `Encrypt`, `ReEncrypt*`, grants, aliases, key administration, and decrypt on staged/unregistered roots. It receives no AI-assisted content-MAC root and no active, retired, or staged private-manual object-wrap or content-MAC root. It cannot create, rotate, rewrap, repair, attest, or publish an index document. Active/retired access is independently recorded, rotated, and removed after the corresponding index generations can no longer be queried.

### 6. Provider authority is fixed and non-delegable

The search project uses one dedicated, fixed, separately budgeted provider service-account credential and one pinned embedding model/dimension/version that match the accepted index generation and evaluation report. It does not reuse the organizer key, index-worker embedding key, web key, a user BYOK key, or a generic environment variable. Neither a request, ticket, cursor, user setting, database row, nor deployment alias can select a provider, model, base URL, endpoint, organization, project, dimensions, or credential.

The adapter uses the reviewed provider origin, strict response schema and byte/dimension bounds, `store: false` where supported, a fixed deadline, bounded retry policy, and the separately approved provider data-control posture. `store: false` is not represented as zero retention. Provider diagnostics and request-history surfaces are included in the query canary review.

### 7. Claim, embed, decrypt, rank, and revalidate in that order

For an accepted request, the search service:

1. authenticates the exact web caller and validates the bounded ticket/secret/body envelope;
2. independently normalizes the complete body and recomputes its versioned full-request digest;
3. atomically claims the ticket, burns its one-use claim secret, and receives only a fresh short-lived lease token plus its database-derived owner/generation/filter snapshot;
4. embeds the query with the fixed provider/model;
5. pages only the ticket-bound encrypted AI-assisted index rows, unwraps only their DEKs through the dedicated decrypt-only role, authenticates and decodes strict bounded payloads, and ranks them in request memory;
6. revalidates the selected note IDs, indexed revisions, privacy, active-generation identity/attestation, filters, and cursor position through the exact ticket capability;
7. completes the ticket and returns only bounded note IDs, indexed revisions, component scores, ranking version, and an authenticated next cursor to web, which owner-authorizes and hydrates current note DTOs; or
8. records an allowlisted failure and returns a content-free semantic-unavailable result so web performs a fresh lexical-only search.

Generation or note revision drift, deletion, archival/filter drift, privacy changes, malformed envelopes, authentication failure, KMS/provider/database timeout, ticket expiry/replay, cursor mismatch, and result revalidation failure all take the final fail-closed path. The service never repairs an index, activates a generation, writes a note, retries under a different model/key, returns decrypted snippets, or broadens filters.

### 8. Sources, links, and backlinks remain in the owner-authorized application

The search service returns no source capture, backlink, link target, title, body, generated block, Review payload, receipt, or revision content. Note links, backlinks, and source-capture inspection are implemented and authorized through the interactive web/API domain after it hydrates a current owned result. Their APIs and database capabilities are not part of the five-function search role.

## Required implementation and release gates

### Checked-in implementation record (2026-09-02; final validation in progress)

- `apps/search` implements the separately deployable query service, exact web-caller verification, bounded body parser, fixed embedding provider/model, ticket claim/page/verify/complete/fail sequence, TLS PostgreSQL adapter, decrypt-only KMS adapter, strict encrypted RAG material opening, deterministic ranking, content-free logging, cancellation, and request-memory release.
- `20260901000006_user_hybrid_search_trust_domain.sql`, pgTAP `093`, shared search contracts, and the web capability adapter implement the service-role-only ticket issuer, dedicated `unfiled_search_worker` login, exact five-RPC allowlist, one-use 30-second claim and lease secrets, generation/request/filter binding, and cross-role denial matrix.
- Web implements exact request normalization, explicit `ai_assisted` dispatch, authenticated generation-bound cursors, deterministic lexical/semantic merge and dedupe, fresh lexical-only degradation, owner-authorized current-note hydration, and no semantic call for omitted/default, mixed, or private-manual scope.
- `infra/aws-kms` implements the fifth exact Vercel OIDC/IAM role with decrypt-only active/registered-retired AI-assisted object-wrap access and explicit exclusion of generation, encryption, rewrap, grants, administration, staged, content-MAC, and private-manual roots.
- The owner-authorized application, outside search, implements source/backlink inspection through migration `20260901000007` and pgTAP `094`, structured-log editing, streaming human-readable export, atomic account deletion, and the corresponding web/native states.
- Credential-free unit, contract, database, HTTP, concurrency, capacity, configuration/policy, and unsigned native gates are green; exact results are recorded in `BUILD_PLAN.md` and `OPERATIONS_TEST_PLAN.md`. The independent final audit is clear. Required PR checks, merge, and post-merge verification are not yet recorded.
- At the time of acceptance no Vercel project was provisioned. Amended 2026-09-02: the five Vercel projects now exist; deployment identity, database-login, root-ring, query/content canary, Apple signing/archive, and physical-device evidence is recorded in `FINAL_REPORT.md` per `HUMAN_SETUP.md`. Milestone F merged as PR #18 and Milestone G is in progress.

Before semantic search is exposed, automated and deployed evidence must prove:

- exact request canonicalization parity and digest changes for every query/filter/cursor change;
- 30-second expiry, one winning claim under concurrency, replay denial, wrong-secret/digest/caller denial, terminal irreversibility, and no owner ID in the service request;
- explicit `ai_assisted` dispatch only, with default/mixed/private-manual queries and content absent from the service, provider, logs, traces, and metrics;
- exact five-RPC database allowlist and denial of direct relations, every other runtime RPC, PostgREST, `service_role`, role inheritance, and cross-owner/generation access;
- exact OIDC subject and Trusted Sources caller, decrypt-only active/retired AI object-wrap authority, and controlled denial of generation, re-encryption, content-MAC, staged, private-manual, grant, and administration operations;
- fixed provider/model/project, provider retention review, budget/rate controls, deadline/cancellation, malformed/oversized response rejection, and no endpoint/model/credential override;
- active/current/privacy/filter/cursor revalidation at claim, page, and completion, including generation activation/drain/failure and note revision/privacy/archive/delete races;
- no durable or cross-request plaintext/query/embedding cache, no content-bearing telemetry, bounded memory with buffer release, and plaintext canaries across Vercel, database, provider, KMS/CloudTrail, Sentry, traces, analytics, responses, and failure sinks;
- deterministic ranking/cursor fixtures, relevance evaluation, capacity/latency limits, lexical-only degradation, and owner-authorized hydration that rejects stale results; and
- disable/rollback, credential/KMS/database rotation, restored-backup behavior, and deletion reconciliation for tickets and any content-free search metadata.

No local unit test, policy shape test, or unsigned client build substitutes for the fifth Vercel project, real database identity, Trusted Sources/OIDC exchange, controlled KMS allow/deny calls, provider project, and deployed canary evidence.

## Alternatives considered

- Reuse the organizer: rejected because a search request is not an organization-job lease and must not gain create/append/Review, content-MAC, provider-key, or organizer RAG authority.
- Reuse the index worker or verifier: rejected because query serving must not gain index claim, publication, repair, verification, or generation lifecycle authority.
- Run semantic search in web: rejected because web has broader owner-authorized content and service capabilities, while the semantic provider/KMS path needs a smaller, separately attributable blast radius.
- Give search direct tables, `service_role`, or an owner ID: rejected because these bypass the one-request capability and permit enumeration or confused-deputy access.
- Embed every query and filter afterward: rejected because mixed/private query intent would already have been disclosed.
- Use BYOK or request-selectable provider/model/endpoint: rejected because interactive search must have one evaluated custody, retention, cost, and ranking contract.
- Cache decrypted documents or query embeddings between requests: rejected because it creates a second plaintext store outside the encrypted index lifecycle and ticket authority.

## Consequences

Hybrid search adds a fifth Vercel project, a fifth exact OIDC/IAM workload role, a new non-PostgREST database login and five-function allowlist, a dedicated provider project/key, capability-ticket lifecycle storage, and separate operational evidence. This increases deployment and per-query cost and latency. The accepted tradeoff is a materially smaller search compromise boundary and an unambiguous lexical-only fallback.

Users receive semantic behavior only after explicitly limiting a request to AI-assisted notes. Default and mixed searches remain lexical-only, which may be less relevant but never silently exports private query intent. Stale or incomplete index state reduces relevance rather than weakening authorization.

This decision does not authorize plaintext pgvector/FTS, an E2EE claim, production semantic search, source/backlink custody in search, or reuse of any existing workload identity. Production remains lexical-only until required PR checks and all account-controlled gates are green.
