# ADR-0016: Free-beta key custody in Vercel Sensitive environment variables and local-hash retrieval

- Status: accepted
- Date: 2026-09-02
- Amends: ADR-0006 decision 2 (managed production key custody), ADR-0007 root rewrap, ADR-0009 organizer custody, and ADR-0013 §5 search custody, each of which named AWS KMS as the required production custodian
- Depends on: ADR-0012 Vault-only credentials and ADR-0015 user-selectable provider/model/effort
- Decision drivers: run a private beta at $0 without weakening the encrypted-storage boundary; keep the four independent root families and per-workload subsets; avoid a second custodian racing the one shared database; avoid sending note or query text to a provider merely for retrieval; keep every claim honest about what this custodian and this retrieval vector are and are not.

## Context

ADR-0006 selected AWS KMS with Vercel OIDC short-lived roles as the production root custodian, and ADR-0007, ADR-0009, and ADR-0013 built the per-workload IAM/KMS boundary on it. Applying `infra/aws-kms` creates billable, account-bound resources, needs two AWS accounts or a state migration for the Vercel issuer, and needs CloudTrail. The private beta is intentionally free: one free remote Supabase project, five Vercel Hobby projects, and no paid provider or cloud accounts.

Retrieval previously assumed an OpenAI embedding model (`text-embedding-3-small`, 1,536 dimensions) funded by an application key in the worker, search, and organizer. A BYOK-only beta has no application key, and sending a user's note text to a provider merely to build an index would disclose content for a purpose the user did not explicitly select.

The application encryption design must not regress: content stays application-encrypted at rest, private-manual content stays outside every AI workload, and no workload receives a broader capability than before.

## Decision

### 1. The free-beta custodian is `vercel-sensitive-env-v1`

`UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1` selects a custodian whose root material lives only in Vercel Sensitive Environment Variables. Four independent, independently generated 32-byte AES-256 root families remain distinct: AI-assisted object-wrap, AI-assisted content-MAC, private-manual object-wrap, and private-manual content-MAC. Root key IDs use the form `urn:unfiled:key-root:vercel-sensitive-env-v1:production:<uuid>`.

Every root document is bound to the exact Vercel project ID and the `production` deployment environment. The runtime matches `VERCEL_PROJECT_ID` and `VERCEL_ENV` against both documents and fails closed on any mismatch, so a copied ring cannot be used by another project or environment.

### 2. Each workload receives only its subset

- Web receives all four root families. Its metadata registry `UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON` holds root IDs, generations, and status only and contains no key material.
- The organizer receives the AI object-wrap and AI content-MAC roots.
- The index worker, verifier, and search receive the AI object-wrap root only.
- The sensitive ring `UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1` in each project contains only the subset that workload may receive. No private-manual root exists in any isolated project; every isolated project rejects AWS, private-manual, legacy, and public-prefixed key variables at startup.

The first authenticated owner operation after the V2 migration generates, registers with `register_user_content_key_v2`, proves, and activates four owner-bound intermediate keys under the active roots.

### 3. Preview deployments are not built

Vercel Preview deployments are intentionally skipped by an Ignored Build Step so that no Preview custodian, Preview ring, or Preview workload ever targets the single shared beta database. The `production` environment is the only deployed environment. Local Supabase remains the Development database with the local-only custodian.

### 4. Rotation is new root generation plus redeploy

A rotation generates a new root for the affected family, adds it to the ring and registry as the new active root while the previous root moves to `retired` (decrypt-only) in the registry and the matching `*_RETIRED_*_ROOT_KEY_IDS_JSON` lists, and redeploys every project that receives that family. Owner intermediate keys are rewrapped through the existing locked compare-and-swap RPC. A retired root is removed only after every reference reaches zero and a restore check passes. There is no separate KMS API call: the redeploy is the rotation.

### 5. Retrieval uses `unfiled-local-hash-v1`

The worker, search, organizer, and the web generation lifecycle use `local-hash-v1` (`unfiled-local-hash-v1`, 512 dimensions): a deterministic, provider-neutral feature-hash vector computed in process from normalized words, adjacent-word pairs, and character trigrams into signed buckets of an L2-normalized float32 vector. It needs no provider key and sends no note or query text anywhere. Generations record the model ID and dimensions, and a generation with a different profile is refused rather than mixed.

Its limitation is stated wherever AI-assisted search is described: it is a lexical retrieval signal, not an AI semantic embedding. Two texts match only to the extent they share wording; paraphrases and synonyms do not match, and relevance is weaker than a semantic embedding. A generation carrying this model ID must never be presented as semantic-search evidence. The optional `openai` embedding mode remains in code for a later funded deployment and is not enabled in the beta.

### 6. AWS KMS is deferred, not removed

`infra/aws-kms`, the `aws-kms` custodian branches, and their tests are preserved as deferred paid hardening. They are not required, applied, or claimed for the free beta. A later decision may adopt them without changing the envelope format, key classes, or RPC allowlists, because the root ID and registry shapes are custodian-specific while owner intermediate keys and object envelopes are not.

### 7. Fresh owners reach `encrypted_only` automatically

Every owner row is created in the `expanded` rollout state, and the free-beta runtime configures
no legacy content key, so without intervention a new user could never write. Instead of adding a
new database transition, the web runs the existing official sequence for owners whose
authoritative rollout reports zero required and zero missing objects: managed key bootstrap,
`expanded → dual_write`, empty backfill, `dual_write → encrypted_read`, empty plaintext scrub,
`encrypted_read → encrypted_only`. The database keeps enforcing every precondition; owners with
legacy objects are untouched; the source is a pass-through when `UNFILED_CONTENT_KEK` exists.

### 8. What this decision does not claim

- It does not make Unfiled end-to-end encrypted or zero knowledge. Root material is available to the Vercel platform and to any process in the receiving project; the owner-authorized application service can decrypt content for its scoped operations.
- It does not provide hardware-backed isolation, per-call audit logging, or grant-based denial evidence equivalent to a KMS/HSM. Denial evidence is limited to configuration rejection and the per-workload subset.
- It does not satisfy the paid PITR/isolated-restore gate that the irreversible storage contraction requires. The database stays `expand_compatible`; all live writes remain encrypted and fail closed.

## Alternatives considered

- Apply the AWS KMS stack now: rejected for the free beta because of account, cost, dual-account issuer, and CloudTrail prerequisites; retained as deferred hardening.
- Store one root in a single environment variable: rejected because it collapses the four independent families and per-workload subsets that limit blast radius.
- Continue OpenAI embeddings for retrieval: rejected because the beta has no application key and would send note text to a provider for a purpose the user did not select.
- Skip retrieval and rely on lexical search only: partially adopted in spirit; the local-hash vector keeps the encrypted index, generation lifecycle, and search trust domain exercised while remaining provider-free.
- Build Preview deployments against the shared database: rejected because two custodians would race for the environment-bound active key and Preview traffic could reach beta data.

## Consequences

Web, organizer, worker, verifier, and search now have two managed custodians and select exactly one. Configuration, registry, and ring shapes are covered by unit tests; the remote ring values, project binding, and redeploy evidence are recorded in `FINAL_REPORT.md`. Runbooks treat ring rotation as generation plus redeploy and keep AWS steps under a deferred heading. Product and portfolio copy must describe AI-assisted search as lexical-strength retrieval over the encrypted index rather than semantic search, and must continue to state that Unfiled is not E2EE.
