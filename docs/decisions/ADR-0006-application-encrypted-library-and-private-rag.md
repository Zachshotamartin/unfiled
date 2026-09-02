# ADR-0006: Application-encrypted library and private per-user retrieval

- Status: accepted
- Date: 2026-08-30
- Narrows: ADR-0001 decision 3; Supabase remains selected, but persisted plaintext `pgvector` and full-text note indexes are not part of the accepted storage design
- Decision drivers: protect note content and derived search material from a database or backup disclosure; retain server-side organization, typed mutations, search, export, and recovery; prevent cross-tenant and private-note retrieval; ship an auditable step before Milestone D.
- Amended 2026-09-02: decision 2 named AWS KMS as the required production custodian and decision 3 assumed a provider embedding. [ADR-0016](./ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md) selects the `vercel-sensitive-env-v1` root ring (four independent root families, per-workload subsets, project/environment binding) and `unfiled-local-hash-v1` retrieval for the free private beta, and defers AWS KMS as paid hardening. The envelope format, key classes, per-user intermediate keys, and retrieval gates below are unchanged.

## Context

The capture encryption foundation does not protect the existing manual-note library. Titles, bodies, structured data, revision snapshots, generated blocks, mutation snapshots, review payloads, routing decisions, and search chunks can still contain plaintext. PostgreSQL full-text indexes and embeddings are derived note content and must be treated as sensitive too. Row Level Security limits ordinary access but does not protect a database dump, backup, replica, or privileged database operator.

Unfiled also needs fast per-user retrieval so a new capture can find likely destination notes before the model decides append versus create. Sending the whole library is too slow and too revealing. Persisting plaintext lexical material or vectors in a shared index would undermine the encrypted-storage promise; vectors can expose semantic attributes and are not ciphertext.

Server-side AI organization remains a product requirement. The application must therefore be able to decrypt authorized AI-assisted content briefly. This decision is application-level encryption, **not end-to-end encryption**.

## Decision

### 1. Encrypt every content-bearing persisted field

Milestone C.5 replaces plaintext note storage with versioned authenticated envelopes. The protected set includes captures; note title, body, and structured data; immutable revision content; generated blocks; organization candidate manifests and plans; mutation operations, inverse snapshots, and stored responses; review choices and resolutions; content-bearing routing-rule conditions; search snippets, lexical signals, embeddings, and hashes. Queue rows, retry records, Realtime events, logs, traces, and analytics contain identifiers and bounded operational state only.

Each content object uses a fresh random 256-bit DEK and AES-256-GCM. Associated data binds at least `{envelopeVersion, userId, resourceId, recordVersion, contentKind}`. The DEK is wrapped by a per-user intermediate key; the database stores ciphertext, the wrapped DEK, key version, and non-sensitive operational metadata. Object-wrapping and content-MAC keys are independent per-user key purposes with separate lifecycle records; neither is derived from the other. Every row carries an owner/class/key reference that SQL can compare with the envelope key ID, and resolution is bound to owner, key class, purpose, and key ID rather than key ID alone. Content fingerprints are keyed MACs under their separate rotation domain, never unkeyed hashes of user text.

Classification is sticky across history. If either side of a privacy transition contains private-manual content, its revision, mutation, inverse, and replay snapshot use the private-manual key class. A private-to-AI transition may not make the private before-image decryptable by the organizer.

Postgres continues to enforce ownership, expected-revision compare-and-swap, idempotency, immutable history, and atomic state transitions. The authenticated server decrypts the current snapshot, applies the same typed domain operation in memory, then calls a reviewed RPC that locks the row, checks the expected revision, and atomically writes the new note envelope, revision envelope, encrypted mutation/inverse data, encrypted idempotency response, event, and index job. A stale revision commits nothing. Clients do not receive direct write grants to encrypted entity tables.

Exports decrypt only after owner authorization and stream directly to the requester without plaintext temporary files. Hard deletion cascades live envelopes, wrapped DEKs, all retrieval generations, and queued index jobs. A deleted user's wrapped intermediate key can still exist in an old backup and remain decryptable under the shared KMS root, so deletion is not immediate cryptographic erasure of backups; the published policy states when those backups expire.

### 2. Use managed production key custody

Local development and synthetic previews may use the strict environment-key resolver. Production must use a managed KMS/HSM resolver. The initial production design is AWS KMS in the deployment's region, `GenerateDataKey` for versioned per-user intermediate keys, and short-lived AWS credentials obtained through Vercel OIDC. No static production root KEK may live in Vercel, Supabase, source control, or a database backup.

Use separate KMS aliases, IAM principals, and audit trails for `ai_assisted` and `private_manual` key classes. This requires separate deployable trust domains, not two code paths inside one Vercel deployment. C.5 creates an `apps/worker` project for organization and indexing with its own exact Vercel OIDC subject and an AI-only AWS role. The interactive web/API project uses a different OIDC subject and owner-authorized role. The current web deployment's `after()` callback and capture cron are a Milestone C adapter only; they must not remain the production organizer once private-manual KMS isolation is claimed. The supported AWS integration uses short-lived credentials from `@vercel/oidc-aws-credentials-provider`; no static AWS access key is accepted.

The organization/index worker can decrypt only AI-assisted keys. The interactive owner-authorized API may decrypt private-manual content for CRUD, export, and lexical search, but cannot send it to a model or embedding provider. This separation reduces blast radius; it does not make private-manual mode E2EE. KMS unavailability fails closed without a plaintext fallback. Rotation rewraps DEKs in resumable, audited batches and retains the prior key only until verification and a restore drill succeed.

### 3. Start retrieval with an encrypted exact per-user index

The accepted C.5 retrieval store has three service-owned tables:

- `rag_index_generations`: one user's index generation for a specific embedding model/version, with build state, coverage counts, and activation time.
- `note_rag_index`: one row per note and generation. Plaintext columns contain only owner, note ID, indexed revision, generation, eligibility, and operational timestamps. One authenticated envelope contains normalized lexical features, headings, a bounded snippet, and zero or more bounded embeddings.
- `note_index_jobs`: leased, idempotent operational work containing IDs, target revision/generation, attempt state, and timestamps—never note or query content.

An index worker may claim only current, non-deleted `ai_assisted` notes. It decrypts the minimum content, obtains an embedding under the disclosed AI-provider policy, encrypts the complete index document, and commits it only if the note is still eligible at the target revision. Embeddings use a bounded, versioned binary representation (base64url-encoded little-endian float32 in the initial design); decoders reject wrong dimensions, NaN, infinity, model mismatch, or oversized features. Private-manual notes have no index row in any generation. A privacy change or deletion makes the note ineligible in the same transaction as the note mutation and removes its index rows asynchronously; query eligibility does not wait for cleanup.

At query time, the authorized service pages only the requesting user's rows from the active generation, decrypts them with bounded concurrency into a bounded in-process working set, and ranks them with:

`0.35 lexical + 0.15 trigram + 0.30 semantic + 0.10 recency + 0.10 title exact`, with pinned boost `×1.2`.

Only rows whose `indexed_revision` equals the current note revision are eligible. Owner, privacy, deletion, generation, and revision are revalidated before a candidate enters model context and again before mutation. A bounded five-minute in-process LRU may cache decrypted index documents under `(userId, generationId, modelId, revisionToken)`; no plaintext shared or durable cache is allowed.

Missing or stale rows never silently become candidates. Retrieval may directly decrypt and rank at most 50 recently changed eligible notes as a repair bridge. If coverage is materially incomplete, RAG cannot authorize auto-apply: the capture goes to Review or Inbox unless a deterministic explicit rule selects a destination. Reindexing builds a new generation beside the active one, verifies complete eligible-note coverage, then atomically flips the active generation. Embedding-model changes re-embed; ordinary KEK rotation only rewraps and does not re-embed.

For an initial 1,000-note library, the gate is cold exact retrieval under 2 seconds p95 excluding the query-embedding provider, warm retrieval under 250 ms p95, candidate recall at least 0.98, and wrong auto-apply at most 0.01. If exact scan no longer meets the budget, the next preferred design is an encrypted, per-user, ephemeral in-memory ANN snapshot. Persisted plaintext vectors, `tsvector`, snippets, or tokens require a new ADR, privacy review, disclosure update, and migration plan; they are not an implicit optimization.

User-initiated search uses the same owner isolation but has a distinct privacy path. AI-assisted notes may use the active encrypted index. Private-manual notes may be decrypted and matched lexically in owner-authorized process memory only; neither their content nor the user's private query is sent to an embedding provider. Search queries use authenticated `POST` bodies rather than URL query strings.

## Migration and release sequence

1. **C.5a — custody and expansion:** add owner/class/purpose-bound key records, the AWS KMS and local-only custodians, separate web/worker workload identities, generic envelope validation, encrypted columns/tables, and content-free RPC/resource references without changing reads.
2. **C.5b — encrypted aggregate:** move typed note operations into the application domain, add service-only envelope/CAS RPCs, and advance a database-controlled rollout state through `expanded → dual_write → encrypted_read → encrypted_only → contracted`. Backfill by owner in resumable batches and verify decrypt-and-canonical-MAC parity without logging content.
3. **C.5c — private RAG:** build content-free index jobs and a complete encrypted shadow generation, then compare candidates, coverage, latency, memory, and routing outcomes against fixtures before atomic activation.
4. **C.5d — cutover and contract:** switch every read, mutation, Realtime payload, export, deletion, search request, and organizer path to envelopes; stop plaintext writes; remove plaintext functions/indexes, `note_chunks`, legacy content columns, unkeyed hashes, and content-bearing idempotency responses. Scan schema, rows, logs, queues, and backups with canary fixtures.
5. Promote only after KMS IAM separation, rotation, rewrap, outage, and backup-restore drills pass. Pre-cutover backups remain capable of containing plaintext until they expire; production disclosure and access controls must state that limitation.

## Alternatives considered

- Database/platform encryption only: useful but does not protect against a database dump or privileged database access.
- Client-only E2EE: strongest confidentiality, but incompatible with the selected server-side organizer and server-side typed mutations without a larger product redesign.
- Plaintext PostgreSQL FTS and `pgvector`: efficient and operationally simple, but exposes sensitive derived content and contradicts the storage boundary.
- Per-user deterministic token hashes: supports some exact matching but leaks equality/frequency and weakens phrase, trigram, and semantic retrieval; rejected for the initial design.
- External vector database: adds another custody and tenant-isolation boundary without solving encryption of searchable vectors.

## Consequences and risks

Application and KMS compromise can still expose content while it is authorized for decryption. Operational metadata—including ownership, object size, revision timing, note type, and access patterns—remains visible. Embedding providers receive bounded AI-assisted note material under the published provider policy. Exact scan adds compute, latency, and memory pressure and must fail safe when its coverage or budget is breached. KMS dependency adds cost and an availability boundary. The expand/backfill/contract migration is security-sensitive, and old backups remain a plaintext risk until expiration.

The benefit is a single auditable rule: durable content and semantic derivatives are ciphertext, while authorization, CAS, idempotency, RLS, history, export, deletion, and AI organization continue to work. Milestone C.5 is not complete—and Unfiled must not claim fully encrypted notes—until its verification gate is green.
