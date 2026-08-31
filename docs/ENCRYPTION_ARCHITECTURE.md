# Unfiled content encryption architecture

Status: cryptographic foundation and the Milestone C capture path are implemented. Note, revision, derived-search, and production managed-key integration remain release blockers. This document is a security boundary, not a claim that the current product is end-to-end encrypted.

## 1. The honest product promise

Unfiled needs three separate controls:

1. **Transport encryption:** HTTPS/TLS for client-to-API and API-to-provider traffic. Supabase HTTP APIs enforce SSL, and direct Postgres access must additionally enable SSL enforcement with `verify-full` certificate and hostname validation.
2. **Application-level encrypted storage:** this is implemented for Milestone C capture content and is the required C.5 target for note/library content. A per-object data-encryption key (DEK) uses AES-256-GCM; a key-encryption key (KEK) outside the content store wraps each DEK. The application server may decrypt AI-assisted content briefly in memory. Current plaintext manual-note fields are called out in §2 and block launch until C.5 removes them.
3. **End-to-end encryption (E2EE):** only user devices hold a key capable of decryption. Supabase, Vercel, support staff, backups, and AI providers cannot read the content. This is compatible with private manual notes, but it is not compatible with the present server-side AI organizer, server-side plaintext search, or server-side structured mutations.

Therefore the truthful Milestone C.5 promise is **application-encrypted storage for all content, with a separately authorized private-manual key class**. No current mode is E2EE: the owner-authorized application API can decrypt private-manual notes for CRUD, export, and local-in-process lexical search, while the organization worker and AI providers cannot. A future E2EE mode requires a separately accepted design for device enrollment, recovery, synchronization, on-device search, and on-device organization or an explicit disclosure step that is no longer strictly E2EE for the disclosed content.

Do not ship copy such as “only you can read every note” while server-side AI is enabled. The UI must say when content leaves the device, what context accompanies it, and that ordinary API abuse-monitoring retention may apply unless the OpenAI project has approved Zero Data Retention.

## 2. Current-state audit (2026-08-30)

Milestone C closes the capture-storage paths but not the pre-existing manual-note paths:

- New Postgres captures are protected by an authenticated `ContentEnvelopeV1` before the database call. `captures.raw_text` is a constant non-content sentinel, public APIs never expose envelopes or keyed fingerprints, and the worker decrypts only an owner-bound envelope in process memory. The migration deliberately fails if it encounters legacy capture plaintext that has not been backfilled instead of silently discarding it.
- Mobile capture drafts and outbox rows live in a SQLCipher database. A random 256-bit database key is stored with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, applied before the first query, and verified through `PRAGMA cipher_version`; the app fails closed when SQLCipher is unavailable. A one-time verified migration scrubs and deletes the legacy plaintext capture database.
- Web capture drafts and outbox payloads are AES-256-GCM envelopes in IndexedDB under a non-extractable, profile-bound Web Crypto key. Queue state remains plaintext operational metadata. This protects offline disk copies, not XSS, malicious extensions, or compromised same-origin JavaScript.
- Postgres `notes.title`, `notes.body_markdown`, `notes.structured_data`, revision snapshots, generated blocks, review choices, and mutation snapshots are still plaintext. Existing SQL full-text/literal search, Realtime mappers, and organization functions consume those fields. Production must not claim that notes are fully encrypted until these paths are migrated and their old backups have aged out or been cryptographically erased.
- The capture server currently has a strict environment-backed KEK resolver for local development and isolated preview data. It fails closed and supports retired keys, but a production KMS/HSM resolver and per-user intermediate-key lifecycle are not yet implemented.
- The existing security document describes platform encryption at rest and TLS. Those controls remain useful but neither prevents a privileged database/application operator from reading plaintext fields and neither is E2EE.

RLS and least-privilege grants remain mandatory. Encryption does not repair an authorization bug, and RLS does not make plaintext ciphertext.

## 3. Implemented foundation

`@unfiled/content-crypto` provides a small, dependency-free envelope format over the platform Web Crypto implementation:

- AES-256-GCM with a 128-bit authentication tag for both content and DEK wrapping.
- A fresh 256-bit DEK per encrypted object and fresh 96-bit nonces from `crypto.getRandomValues` for every encryption.
- Authenticated associated data binding ciphertext to envelope version, cipher suite, tenant, resource ID, monotonic record version, and content kind. The wrapped DEK is additionally bound to its KEK identifier. Callers must supply the authoritative record version so a ciphertext from another revision is rejected.
- External expected context is mandatory at decryption time, preventing a copied envelope from being accepted as another user, resource, or content type.
- Versioned, strictly parsed, canonical base64url envelopes with bounded input sizes and exact-key validation.
- Non-extractable imported KEKs, generic fail-closed errors, no logger, best-effort zeroing of temporary byte arrays, and no plaintext in errors.
- KEK rotation by rewrapping only the DEK; the content ciphertext remains unchanged.
- Resolver-based decryption that selects the exact authenticated key ID and never silently falls back.

The package deliberately does **not** invent key derivation, recovery, KMS access, device enrollment, logging, persistence, nonce-usage accounting, or a migration strategy. Those need explicit production decisions and security review. Callers of the byte API own the returned plaintext buffer and must zero it after the shortest practical use; JavaScript strings cannot be reliably erased from memory.

## 4. Required key hierarchy

### AI-assisted/server-readable mode

Use one random DEK per content object. Keep the root wrapping key in a managed KMS/HSM, not a Vercel environment variable and never the same Postgres database or backup. Prefer a per-user intermediate KEK so one compromised key does not expose the entire library; the KMS root wraps that intermediate key, and the intermediate key wraps object DEKs. Cache unwrapped intermediate keys only for a short bounded interval in process memory; never write them to disk, exceptions, traces, analytics, or job payloads. A Node/Web Crypto `CryptoKey` marked non-extractable reduces accidental export but is not equivalent to hardware-backed isolation from a compromised server process.

Track AES-GCM operations per KEK. Random 96-bit nonce uniqueness is a security invariant, not a best-effort optimization. Until an external cryptographic review sets a workload-specific bound, rotate a KEK before `2^24` wraps and immediately after any suspected nonce-generator or key compromise; never retry by reusing a nonce.

The database stores only the envelope, non-sensitive operational metadata, and the KMS key identifier. Rotation creates a new KEK version and rewraps DEKs in bounded, resumable batches. Retain the previous KEK until every envelope is verified under the replacement and a restore drill succeeds. Compromise response disables decryption, rotates the affected KEK, rewraps, and audits every use.

### Private-manual application-encrypted mode

Use a separate per-user intermediate-key class, KMS alias, IAM principal, and audit stream for private-manual content. Object wrapping and content MACs are separate key purposes and are never derived from one another. Key resolution is bound to owner, class, purpose, and key ID. History uses sticky classification: if either side of a privacy transition is private, the revision, mutation, inverse, and replay snapshot remain under the private class.

The organization/index worker must have no decrypt permission for this class and private-manual notes must produce no embedding or RAG row. That claim requires a separately deployed `apps/worker` Vercel project with its own exact OIDC subject and AI-only AWS KMS role. It cannot share the interactive web/API deployment, environment, or IAM role. The owner-authorized interactive API uses a different OIDC subject and may decrypt the minimum content needed for CRUD, export, and lexical search in bounded process memory. This is stronger workload separation, not E2EE or zero-knowledge storage.

If a future ADR selects E2EE, generate its account root key on a trusted user device and never upload it unwrapped. Passwordless login credentials such as an email address, OTP, JWT, or device ID are not encryption secrets. That future design must choose and test device wrapping, recovery, and key-loss behavior before implementation; it is outside C.5.

## 5. Integration order and concrete touch points

Encryption changes the data model and cannot be safely hidden in one helper call. Implement in this order:

1. **KMS and policy:** create distinct web/API and `apps/worker` deployments, bind each exact Vercel project/environment OIDC subject to a separate AWS role, and define KMS aliases so the worker can decrypt AI-assisted content but not private-manual content. Use `@vercel/oidc-aws-credentials-provider` for short-lived credentials. Add key-use audit logs, rotation, revocation, availability behavior, and a restore drill. Fail closed when KMS is unavailable; queue captures without plaintext persistence or route them to an explicitly encrypted local outbox.
2. **Schema expansion:** retain the already-encrypted capture path and add envelope columns for notes, revisions, generated blocks, mutation snapshots, review copies, and any remaining job payload that contains content. Keep routing/status metadata outside the envelope only when it is truly non-sensitive. During a resumable C.5 backfill, do not drop old note columns until verification and cutover complete.
3. **API boundary:** encrypt immediately after validation and decrypt only after server-derived-user authorization. Never accept a client-supplied tenant ID as authority. Pass the database row owner, resource ID, and authoritative monotonic revision as the expected decryption context. Enforce revision monotonicity outside the envelope so rolling back the row and ciphertext together cannot silently win. Return generic authentication errors.
4. **Workflow:** claim only encrypted jobs. After authorization, decrypt the minimum capture/candidate context in a short-lived scope, send only the minimum to the configured provider, validate output as untrusted data, encrypt mutations before persistence, and zero transient buffers where the runtime permits. Job errors, traces, retries, dead letters, receipts, and idempotency records must never copy plaintext.
5. **Mobile:** keep capture drafts/outbox in SQLCipher under an independently random database key held in Keychain/Keystore, inaccessible to the widget App Group, and configured with the strongest availability class compatible with background sync. The widget App Group snapshot is content-free: it may carry only schema/version and aggregate queue state, never capture text, note text, titles, destinations, tokens, or receipts.
6. **Web:** encrypt IndexedDB draft/outbox content with a non-extractable Web Crypto key stored as a `CryptoKey`. This protects an offline disk copy but not XSS, a malicious browser extension, or compromised origin JavaScript. Enforce a strict CSP, Trusted Types where practical, dependency integrity, no third-party scripts on authenticated pages, and short-lived plaintext in React state.
7. **Search and Realtime:** remove plaintext SQL full-text/literal indexes and snippets. Page encrypted per-user retrieval rows with bounded concurrency and decode only strict, versioned, bounded float32 embeddings; reject wrong dimensions, non-finite values, and model mismatch. Search private-manual notes lexically only in the owner-authorized service after bounded in-memory decryption; do not send their content or query to an embedding provider. Any future E2EE mode must search locally on devices. Realtime publishes encrypted envelopes and non-sensitive version/state metadata only.
8. **Migration:** drive the rollout through database states `expanded → dual_write → encrypted_read → encrypted_only → contracted`. Backfill envelopes in resumable owner-scoped batches, verify decrypt-and-keyed-MAC parity without logging content, switch reads to ciphertext, stop plaintext writes, remove plaintext indexes/functions/views, then destroy migration keys before dropping plaintext columns and aging out backups. Maintain an explicit rollback window.
9. **Exports/deletion:** exports decrypt only on an authenticated user request, stream directly without temporary files, and never contain keys. Deletion removes live envelopes, wrapped DEKs, search artifacts, device wraps, and provider copies where applicable. With a shared KMS root, old backups can still contain a decryptable wrapped per-user key until the published backup window expires; do not claim immediate cryptographic erasure unless the user has an independently destroyable root and a verified destruction record.

Primary code touch points currently include `apps/web/src/server/product/supabase-http-repository.ts`, capture server handlers/workers, mobile capture/notes repositories, web IndexedDB capture storage, note search, Realtime mappers, every content-bearing RPC/migration, and all import/export/retention paths. Integrate only after the schema and KMS contract are reviewed together.

## 6. Non-negotiable verification gates

- Unit tests: round trip; randomization; payload/wrapped-key/context tamper rejection; malformed and oversized envelopes; wrong tenant/resource/kind/key; UTF-8 rejection; key rotation; resolver no-fallback; plaintext-canary absence from errors.
- Integration tests: database rows, indexes, Realtime changes, queues, dead letters, logs, traces, crash reports, analytics, and backups contain no plaintext canary.
- Authorization tests: another authenticated user and service without decrypt IAM cannot obtain plaintext; copied ciphertext fails under the wrong owner/resource context.
- Offline tests: kill/restart mobile and refresh/crash web; encrypted drafts survive and submit exactly once; sign-out removes local keys or securely isolates each profile.
- Rotation/restore tests: new writes use the active KEK; old envelopes remain readable during migration; rewrap is idempotent; restored backups require separately restored authorized keys; retired keys cannot decrypt.
- Failure tests: KMS/provider/network outage never causes plaintext fallback; retry payloads remain encrypted; corruption produces a generic terminal error and preserves ciphertext for recovery.
- Product test: AI-private content never reaches the organization worker or provider. Server-readable content presents clear disclosure. No E2EE marketing claim is present unless every production path satisfies it.
- Independent cryptographic design review and penetration test before public beta. This package is a foundation, not a substitute for review.

## 7. Sources and rationale

- [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) specifies AES-GCM authenticated encryption. The foundation uses 96-bit random nonces and 128-bit tags and treats nonce uniqueness under a key as mandatory.
- [NIST SP 800-57 Part 1 Rev. 5](https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final) covers key lifecycle, protection, rotation, recovery, and compromise handling.
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) recommends authenticated modes such as GCM, independent keys, secure random generation, separation of keys and data, and vault/HSM storage.
- [W3C Web Cryptography API](https://www.w3.org/TR/webcrypto-2/) defines the platform AES-GCM and non-extractable `CryptoKey` operations used by the shared package.
- [Apple: Storing Keys in the Keychain](https://developer.apple.com/documentation/security/storing-keys-in-the-keychain) identifies Keychain as the place for small cryptographic keys.
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore) provides non-exportable and, where available, hardware-backed key use restrictions.
- [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) explains that HTTP APIs enforce SSL but direct Postgres connections require explicit enforcement and should use `verify-full`.
- [Supabase Vault](https://supabase.com/docs/guides/database/vault) keeps a project root key separate from encrypted database values, but its decrypted SQL view means it is not E2EE and is not by itself the proposed content-encryption boundary.
- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint) documents ordinary abuse-monitoring retention and the separately approved Zero Data Retention controls; `store: false` alone must not be represented as zero retention.
