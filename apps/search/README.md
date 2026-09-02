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
- AWS `Decrypt`/`DescribeKey` access only to active and retired AI-assisted
  object-wrap roots;
- no key generation, encrypt, re-encrypt, grant, content-MAC, private-manual,
  organizer, verifier, or index-worker authority;
- one fixed provider project/key, model (`text-embedding-3-small`), and 1,536
  dimensions;
- no query/content logging, durable plaintext, or cross-request plaintext
  cache.

Omitted, mixed, and `private_manual` privacy searches never call this service.
Stale/incomplete generations, ticket mismatch, dependency failure, and any
contract drift fail closed so the owner-facing web path can return fresh
lexical-only results.

Use `.env.example` and the account-controlled procedure in `HUMAN_SETUP.md`.
Local mode exposes only the route/health surface; it deliberately cannot open
encrypted indexes.

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
