# ADR-0008: Encrypted aggregate rollout, replay, and key-operation reservations

- Status: accepted
- Date: 2026-08-30
- Implements: ADR-0006 Milestone C.5b
- Depends on: ADR-0007 managed custody and service-only database capability

## Context

Application encryption is not safe if it is added as a second, best-effort copy beside the existing note path. A response-lost retry could encrypt a different generated note or mutation ID, a concurrent edit could advance the plaintext row between decrypt and commit, key rotation could cross a wrapping-key quota check, or one forgotten legacy function could continue returning plaintext after cutover.

The migration also cannot treat a global counter as proof that every object was backfilled. Each mutable content surface has its own resource identity and authenticated record version. A changed envelope must invalidate any earlier verification evidence, and the transition to encrypted reads must serialize with in-flight writes and deletes.

## Decision

### 1. Keep cryptography in the authorized application and state transitions in Postgres

The interactive API authorizes one owner, obtains a callback-scoped managed-key custodian, and composes an owner-bound key resolver. Typed note operations run in the application domain over a decrypted current snapshot. The database never receives an intermediate key, data key, plaintext key configuration, or authority to contact KMS.

Postgres remains authoritative for ownership, generated entity IDs, expected-revision compare-and-swap, relationship checks, immutable history, replay claims, event emission, index-job creation, and the atomic commit. Encrypted write functions accept exact envelope and MAC objects and reject unknown fields, owner/key/class/version substitutions, invalid relationships, stale revisions, and unprepared writes.

### 2. Reserve every object-wrap operation before encryption

Every sealed object consumes a unique database reservation. `reserve_content_key_operations` serializes the active owner/class/object-wrap domain with key activation and retirement, atomically increments the key's wrapping-operation count, and returns a capability bound to `{owner, reservationId, keyId, keyClass, keyVersion, operationCount}`. The encrypted aggregate service resolves that exact key and refuses reused reservation objects or IDs.

The final write consumes each reservation once in the same transaction as the encrypted rows. Failed encryption may burn capacity, which is safe; it cannot reuse a nonce/key-wrap budget. A rotation cannot pass between the active-key check and quota increment. Missing, exhausted, revoked, or mismatched keys fail closed without a local or plaintext fallback.

### 3. Claim logical writes before generating durable identities or ciphertext

An idempotency key is first looked up by `{owner, scope, idempotencyKey}`. New logical requests are MACed under the sticky history class and atomically prepared. The database creates and stores the stable note, revision, and mutation IDs with the exact request-MAC key reference.

A retry recomputes the logical request MAC under the stored active-or-retired key reference and submits it to the prepare function. The database compares the MAC before revision checks, generated-ID checks, timestamps, or randomized ciphertext. A different logical request is rejected; an incomplete request resumes with the same IDs; a completed request returns its encrypted response. Completed responses are decrypted only after this database comparison, so merely possessing a response envelope cannot turn a changed request into a valid replay.

Claims do not expire automatically. Abandoning an incomplete claim would make an old idempotency key ambiguous; an operator-visible repair must either complete it or use a new logical key.

### 4. Make key class sticky across history

Current note content uses the note's resulting privacy class. A revision, mutation, inverse, and replay response use `private_manual` whenever either side of the privacy transition is private. Consequently a later private-to-AI change cannot make the private before-image available to the organization worker. Taxonomy display content is always private-manual. AI workflow content is AI-assisted unless it is derived from a private source, in which case the workflow must not enter the AI path.

Object-wrap keys and content-MAC keys are separate owner/class/purpose records. Semantic uniqueness MACs bind the owner and namespace, so equal strings in different accounts or namespaces do not share a database equality token. Taxonomy cutover requires one complete MAC-key epoch per owner; rotation cannot silently split uniqueness domains.

### 5. Let the database own rollout state

Each owner advances monotonically:

`expanded → dual_write → encrypted_read → encrypted_only → contracted`

C.5b owns only `expanded → dual_write → encrypted_read`. C.5d owns stopping plaintext writes and removing the plaintext contract. The web repository consults the service-only rollout projection for every request and propagates lookup failures. It uses the legacy adapter in `expanded`, the encrypted write adapter plus legacy reads in `dual_write`, and only encrypted adapters from `encrypted_read` onward.

Legacy direct table reads are denied for an owner at `encrypted_read`; legacy writers are rejected by rollout-serialized triggers from `dual_write`. Security-definer legacy readers must contain the same explicit owner-state guard. Service-role code has no direct content-table privilege and reaches content only through reviewed owner-scoped functions.

### 6. Backfill one exact object and version at a time

The service pages an owner's legacy objects in a deterministic surface/resource order. For each object it:

1. captures the exact plaintext projection and record version;
2. seals the typed payload under its authoritative sticky class;
3. decrypts the result and compares the typed canonical payload in memory;
4. produces keyed verification evidence without logging content;
5. commits with an exact plaintext/version compare-and-swap and one wrap reservation.

The commit records `{owner, surface, resourceId, recordVersion, envelopeDigest, verificationKeyReference}` and advances the cursor atomically. Any later envelope or version change deletes that evidence. A repeated batch reference must match every prior parameter and digest. Capture migration is separate because a legacy capture must first decrypt its old global-key envelope, then reseal under the owner's class, replace the global fingerprint with an owner-keyed MAC, and compare-and-swap both legacy values.

The final transition rescans all required rows, exact versions, envelope digests, key states, taxonomy epochs, and active key slots. Counters are audit metadata, not independent proof.

### 7. Return ciphertext plus operational metadata only

Service-only encrypted reads return an exact envelope projection and bounded operational fields. They never return legacy title, body, structure, revision snapshot, operations, inverse, candidate manifest, generated content, review choices, routing text, receipt inserts, raw capture, or an unkeyed content hash. Decryption and sorting that depend on protected display content happen in bounded owner-authorized process memory.

## Consequences

The encrypted path uses more KMS/database calls and must retain careful callback, memory, and pagination bounds. Randomized encryption means a response-lost retry may create unused ciphertext and consume unused reservations before it learns that another caller completed the claim; the committed result remains singular and replay-safe.

`encrypted_read` is not the end of the security migration. Plaintext rollback columns still exist and dual writes still maintain them until C.5d. Product and portfolio copy must not claim that the full library is encrypted at rest until `encrypted_only → contracted`, plaintext functions/indexes/columns are removed, canary scans pass, and pre-cutover backups expire or are destroyed under the documented retention policy.
