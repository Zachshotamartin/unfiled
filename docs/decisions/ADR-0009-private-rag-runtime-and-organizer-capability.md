# ADR-0009: Ciphertext-bearing index capabilities and a separate organizer identity

- Status: accepted
- Date: 2026-08-31
- Narrows: ADR-0006 private retrieval and ADR-0007 worker database capability
- Decision drivers: make the encrypted index executable without a Supabase bypass credential; preserve the audited six-function index-worker allowlist; prevent organizer authority from being smuggled into an index RPC; keep private-manual keys and content outside both AI workloads.

## Context

ADR-0007 gave `unfiled_index_worker` exactly six `SECURITY DEFINER` RAG functions and no relation access. That boundary is correct, but the C.5a projections were too narrow to execute: `claim_note_index_jobs` returned only identifiers and lease metadata, while `list_active_note_rag_index` returned ciphertext and key identifiers without the wrapped per-user key records needed by the AI-only KMS custodian. The role could neither open an eligible AI-assisted note nor seal an index document. Giving the process `service_role`, direct table grants, a JWT-signing secret, or generic database credentials would defeat the boundary.

C.5c also needs an atomic organizer completion operation. Folding that operation into one of the six index functions would make the function name and reviewed grant list misleading, couple two different queues and lease protocols, and let an index-only credential mutate notes and capture receipts. Expanding the index role to every organizer operation has the same problem.

Ciphertext and KMS-wrapped intermediate keys are sensitive capabilities even though they are not plaintext. A projection must therefore remain owner-, class-, purpose-, key-, generation-, revision-, lease-, and byte-bound. The worker must never receive a private-manual key record or an RPC that can select one.

## Decision

### 1. Keep the index worker at exactly six functions

`unfiled_index_worker` retains the exact allowlist established by ADR-0007:

- `claim_note_index_jobs`
- `heartbeat_note_index_job`
- `commit_note_rag_index`
- `fail_note_index_job`
- `recover_stale_note_index_jobs`
- `list_active_note_rag_index`

No table, sequence, private-schema, role-membership, root-rewrap, key-registration, generation-administration, note-write, or capture-write capability is added.

The existing functions may return the minimum ciphertext-bearing projections required to perform their named operation. A claim may return only the currently eligible AI-assisted note envelope, its exact AI-assisted object-wrap key record, the generation's model and dimensions, and a single-use target object-wrap reservation and key record. The list function may return only encrypted active-generation index documents and their exact AI-assisted object-wrap key records. Both use fixed row and ciphertext-byte budgets. Neither may return plaintext, content MAC material, private-manual key records, arbitrary keys, or a caller-selected relation projection.

The claim transaction reserves the target wrap operation and binds it to the leased job, target index resource, key, and attempt. Commit accepts only that binding, rechecks owner/privacy/deletion/revision/generation/lease eligibility, consumes the reservation atomically with the index row, and fails closed after a privacy flip, deletion, stale revision, lease loss, rotation mismatch, or replay mismatch. An abandoned attempt burns its bounded reservation; it never becomes a reusable wrapping capability.

### 2. Pin every exact scan to one authoritative generation token

`list_active_note_rag_index` returns one structured page even for an empty library. Its header binds owner, active generation, model, dimensions, revision token, expected eligible count, current indexed count, and coverage state. Its cursor binds the same generation and revision token plus the last index row identifier. A later page with a stale token fails instead of mixing snapshots. The application may restart once; repeated churn returns an incomplete result that cannot authorize automatic organization.

Rows remain eligible only when the database joins them to an active generation and a current, non-deleted, AI-assisted note at the same revision. The caller validates every decrypted document against the generation contract. Complete row counts without successful strict decryption are not sufficient activation evidence. A separately authenticated verifier role is the attestation authority: it may submit only the canonical manifest digest recomputed by the database, and its evidence is bound to the owner, generation contract, ordered row/envelope/key-reference digests, counts, and revision token. The attestation is a database capability decision, not an independently verifiable signature or MAC. Activation stays service-only, revalidates the canonical attestation and digest, and publishes the shadow generation by compare-and-swap. Neither administrative function is granted to an AI worker.

### 3. Give organization its own non-bypass identity and RPC vocabulary

C.5c will add a separate `unfiled_organizer_worker` login role and separately deployable organizer process. It receives only explicit organizer queue lease, minimum encrypted source/candidate read, atomic encrypted completion, failure, and recovery functions. It receives no relation access, no `service_role`, no private schema, no index commit authority, no root-rewrap or key-lifecycle authority, and no private-manual key projection. Its KMS workload identity is AI-assisted-only.

The organizer and indexer may share versioned domain and cryptographic packages, but they do not share a database credential. Production may deploy them as separate Vercel projects or as independently configured processes only when workload identity, environment, invocation, database login, and logs remain separately attributable. The existing web `after()`/cron capture workflow is retired before production isolation is claimed. Until the dedicated organizer role and atomic writer are merged and account evidence is recorded, AI-assisted encrypted capture remains fail-closed and documentation must say so.

### 4. Treat external disclosure as a lease-linearized operation

Before an embedding or organization-model call, the AI worker renews or revalidates the authoritative lease after opening the minimum ciphertext. A privacy or deletion transaction that invalidates the job before that revalidation prevents disclosure. That successful revalidation is the operation's authorization linearization point; a later user transition cannot retract a provider request already authorized and sent. The UI and tests must not promise retroactive revocation.

The worker revalidates again before committing. Therefore a transition that wins before disclosure prevents the provider call, while any transition that wins before commit prevents the derived index or organizer mutation from being published. Private-manual captures and notes are excluded before claim and have no model call, embedding call, index job, or RAG row.

## Alternatives considered

- Give `apps/worker` a Supabase service/secret key: rejected because it bypasses RLS and exposes every remaining legacy plaintext relation during migration.
- Grant direct encrypted-table reads: rejected because it creates an open-ended SQL surface and bypasses the reviewed owner/privacy/revision joins.
- Hide organizer writes inside an index RPC: rejected because it makes the allowlist non-auditable and turns an index credential into a note mutation credential.
- Expand `unfiled_index_worker` into one combined role: rejected because compromise of either pipeline would gain both sets of effects and ADR-0007's exact-six guarantee would cease to be true.
- Hold a database lock across an external model call: rejected because it creates long-running transactions, availability coupling, and lock amplification. Lease revalidation supplies an explicit linearization point without claiming retroactive cancellation.

## Consequences

The index RPC response contains ciphertext and KMS-wrapped AI-assisted intermediate keys, so response parsing, byte limits, error redaction, TLS verification, memory lifetime, and log canaries become release-gating. The worker needs a direct PostgreSQL connection whose `session_user` is exact and whose TLS certificate and hostname are verified; prepared statements are disabled where required by the selected pooler.

There are two AI database credentials and two narrowly reviewed grant lists instead of one broad credential. Deployment and rotation are more involved, but compromise boundaries, audit attribution, and permission tests are materially clearer. Neither role can decrypt private-manual keys, and neither role can become a service role through membership or `SET ROLE`.

The verifier role is deliberately `NOLOGIN`, `NOINHERIT`, and non-bypass. PostgreSQL 17 automatically grants a role created by a non-superuser `CREATEROLE` principal back to that creator with `ADMIN=true`, `INHERIT=false`, and `SET=false`, and records the bootstrap superuser as grantor. Managed Supabase does not expose that bootstrap superuser. Role seeding and both migrations therefore fail closed unless each capability role has either zero membership rows (preferred when a real superuser can remove the edge) or exactly that one `supabase_admin`-granted, ADMIN-only management edge to trusted schema owner `postgres`; every other inbound or outbound membership is rejected. `postgres` already owns the migrations and can replace the security-definer RPCs, so this edge adds no workload identity, inherited privilege, or `SET ROLE` path. It must never be copied to `service_role`, `authenticator`, an application login, or a human role.

Production must authenticate the verifier controller as the exact `unfiled_rag_verifier` login rather than granting that role to a parent workload identity. Because the stored evidence has no cryptographic authenticator of its own, role authentication, TLS, credential isolation, and audit attribution are part of the trust boundary; exact-shape input validation rejects legacy or invented MAC fields instead of implying verification that does not occur.

This ADR makes the C.5c runtime implementable; it does not itself prove production KMS denial, database login, CloudTrail, rotation, restore, or backup expiry. Those remain human release gates in `HUMAN_SETUP.md`.
