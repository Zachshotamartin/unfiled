# Unfiled encrypted user search

`apps/search` is Unfiled's separately deployable semantic-search trust domain. It
is not an interactive API and never receives an owner ID from its caller.

The authenticated web service creates a 30-second, one-use capability that
binds the owner, canonical request digest, exact AI-assisted filter manifest,
and active encrypted-index generation. This service receives only the ticket,
raw one-use claim secret, digest, and canonical search material. It claims the
ticket through the dedicated `unfiled_search_worker`, obtains the bound owner,
decrypts only matching AI-assisted index envelopes, ranks them without a
cross-request plaintext cache, revalidates selected references, and terminates
the lease.

The runtime intentionally has:

- five database RPCs and no table, private-schema, service-role, or write access;
- unwrap-only access to the active and retired AI-assisted object-wrap roots
  of the one selected custodian (`aws-kms`: KMS `Decrypt`/`DescribeKey`;
  `vercel-sensitive-env-v1`: an unwrap-only environment custodian);
- no key generation, encrypt, re-encrypt, grant, content-MAC, private-manual,
  organizer, verifier, or index-worker authority;
- one fixed query-embedding profile selected by
  `UNFILED_SEARCH_EMBEDDING_PROVIDER`: `local-hash-v1` (`unfiled-local-hash-v1`,
  512 dimensions, no provider key) in the free beta, or `openai`
  (`text-embedding-3-small`, 1,536 dimensions, one dedicated
  `UNFILED_SEARCH_OPENAI_API_KEY`);
- no query/content logging, durable plaintext, or cross-request plaintext
  cache.

Omitted, mixed, and `private_manual` privacy searches never call this service.
Stale/incomplete generations, ticket mismatch, dependency failure, and any
contract drift fail closed so the owner-facing web path can return fresh
lexical-only results.

Use `.env.example` and the account-controlled procedure in `HUMAN_SETUP.md`.
Local mode exposes only the route/health surface; it deliberately cannot open
encrypted indexes. Preview and Production require Vercel's exact injected
deployment ID, lowercase full commit SHA, and environment. Every managed
response returns only a SHA-256 deployment-ID digest plus the exact commit and
environment in `x-unfiled-deployment`, `x-unfiled-commit`, and
`x-unfiled-environment`; the raw deployment ID is never returned. For the
private beta, both managed scopes deliberately use the same remote Supabase
project and search-only login, which is not database environment isolation.

## Key custodian modes

`UNFILED_KEY_CUSTODIAN` must be exactly `vercel-sensitive-env-v1` (the $0
beta) or `aws-kms` (preserved as deferred paid hardening; not required). The
value is compared without trimming. Both modes require
`UNFILED_SEARCH_PROJECT_ID` (`^prj_[A-Za-z0-9]{6,100}$`, byte-identical to the
injected `VERCEL_PROJECT_ID`), the `UNFILED_SEARCH_TRUSTED_SOURCE_*` caller
identity, and the database values.

In `vercel-sensitive-env-v1` mode the service accepts exactly:

- `UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID`, one root ID matching
  `^urn:unfiled:key-root:vercel-sensitive-env-v1:(preview|production):<RFC-4122 UUID>$`
  whose environment segment equals `UNFILED_SEARCH_ENV`;
- `UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1` (Sensitive), at most 32,768
  bytes of canonical JSON `{"deploymentEnvironment","projectId","roots","version":1}`
  bound to the injected `VERCEL_ENV` and `VERCEL_PROJECT_ID`, whose `roots`
  contain exactly the active plus retired IDs, each with a distinct 32-byte
  base64url `keyMaterial`;
- optional `UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON`, default
  `[]`: a canonical JSON array of at most 20 distinct same-environment root IDs
  excluding the active root.

That mode rejects `UNFILED_SEARCH_PROJECT_TEAM_SLUG`,
`UNFILED_SEARCH_PROJECT_NAME`, `UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT`,
`UNFILED_AWS_REGION`, `UNFILED_SEARCH_AWS_ROLE_ARN`,
`UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN`, and
`UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`; `aws-kms` mode rejects the
three `vercel-sensitive-env-v1` variables in return. At ring-open time the
environment custodian also requires `NODE_ENV=production` and rejects
`AWS_ROLE_ARN`, any `UNFILED_*_AWS_ROLE_ARN`, `UNFILED_LOCAL_KEY_RING_V1`, and
`NEXT_PUBLIC_*` names that look like key material. No `x-vercel-oidc-token`
workload header is used in this mode; if one is handed to the adapter it fails
closed. The request-scoped authority exposes only
`withUnwrappedIntermediateKey`; there is no generate or rewrap method, so this
service cannot mint keys under either custodian. Records are schema V2 in this
mode and V1 in `aws-kms` mode; the two are never mixed.

Honest limits: in `vercel-sensitive-env-v1` mode the root material is an
exportable environment value present in the function process, with no HSM,
per-call audit record, or IAM denial between workloads. Neither mode is
end-to-end encryption or zero knowledge: this service decrypts AI-assisted
index documents by design.

## Query embedding modes

`UNFILED_SEARCH_EMBEDDING_PROVIDER` must be exactly `local-hash-v1` or
`openai`. In `local-hash-v1` mode `UNFILED_SEARCH_OPENAI_API_KEY` is rejected,
so no provider key exists in the process and query text never leaves it. The
query vector is the same deterministic feature hash the index worker used
(`unfiled-local-hash-v1`, 512 dimensions): normalized words, adjacent-word
pairs, and character trigrams in signed buckets of an L2-normalized float32
vector. It is a lexical retrieval signal, not an AI semantic embedding, so a
query matches a note only through shared wording; synonyms and paraphrases do
not match, and its relevance is weaker than a semantic embedding. The
repository refuses a generation whose recorded model ID or dimensions differ
from the configured profile, so a profile change requires a new generation.
`openai` mode requires the dedicated key and uses the fixed
`text-embedding-3-small`/1,536 profile.

## Credential-free trust-domain composition gate

Run `pnpm test:search-trust-domain` from the repository root while local
Supabase is running. The gate creates an encrypted one-note RAG generation,
gives `unfiled_search_worker` a random request-local login, and exercises the
production web coordinator and ticket RPC through local PostgREST. The web
client then crosses an isolated loopback HTTP boundary into the production
search HTTP/auth/query stack. The harness supplies independent deterministic
trusted-source and target-workload OIDC fixtures, plus deterministic provider
and decrypt-only KMS boundary fixtures; it does not install a local production
key authority or a production bypass.

The passing path must use the exact five allowlisted search RPCs over a session
whose `session_user` and `current_user` are both `unfiled_search_worker`, open
the encrypted index, rank opaque references, terminate the ticket, and hydrate
the selected note only in the owner-side web process. The same run also proves
one-use replay denial and that a retry-exhausted provider failure erases ticket
secrets before the production hybrid coordinator performs a second, fresh
lexical scan. Cleanup returns the search role to `NOLOGIN` even when the test
fails. Test output and failure diagnostics contain only bounded status/count
metadata, never fixture content, ticket secrets, OIDC fixtures, or credentials.

This is a credential-free, production-shaped local composition test. It does
not replace deployed Vercel identity, AWS STS/KMS, live provider, or production
network evidence.

## Credential-free capacity and relevance gate

Run `pnpm test:search-capacity` from the repository root. The dedicated gate
prepares a maximum-size, 1,000-note encrypted generation before timing, then
runs one untimed warmup and 20 independent exact scans through the Production
payload opener. Every scan reads and authenticates all 1,000 1,536-dimension
documents, decrypts through exactly four distinct request-local object-wrap
keys, ranks a stable top eight, revalidates those references, and starts with a
fresh opener so no key or plaintext cache crosses requests.

The gate fails at p95 latency ≥ 2,000 ms, added heap ≥ 512 MiB, or added RSS ≥
768 MiB. Its 50-case deterministic corpus also requires recall@8 ≥ 0.98, MRR@8
≥ 0.90, top-one rate ≥ 0.90, exact repeatability for five tie cases, and
fail-closed stale/incomplete-generation behavior. Output is a content-free JSON
summary; it contains aggregate timings/counts, never fixture queries, titles,
note IDs, or decrypted content.

The 2026-09-02 credential-free local run passed 3/3 tests. Across the 20 timed
scans it recorded p50 277.86 ms, p95 288.19 ms, and max 288.63 ms, with exactly
four key unwraps per scan. The relevance corpus recorded recall@8 1.00,
MRR@8 0.99, top-one rate 0.98, and all five stable-tie cases. Added heap was
45.25 MiB and added RSS was 67.89 MiB on that run.

This lane uses a deterministic precomputed query vector, in-process repository
fixture, and local decrypt-only key custodian. It does not establish provider,
PostgreSQL network, STS/KMS network, HTTP/OIDC, Vercel cold-start, deployed
identity, or Production latency evidence; those remain account-owned gates.
