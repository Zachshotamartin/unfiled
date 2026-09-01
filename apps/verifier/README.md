# Unfiled independent RAG verifier

This package is a separately deployable trust domain for strict verification of an encrypted, building RAG generation. It pages one owner/generation/revision snapshot through the two-function `unfiled_rag_verifier` database surface, decrypts every projected AI-assisted index document, validates its exact envelope, key binding, model, dimensions, vector values, order, and counts, and only then submits the terminal database attestation object unchanged. Nonterminal pages must carry `verification: null`; the terminal page must carry the one exact canonical attestation. It is independent of the index-worker lease and cannot create, append, seed, fail, or activate a generation.

The service never receives source note rows, revision bodies, or complete source-note aggregates. Strict validation necessarily decrypts the minimum note-derived `PrivateRagIndexDocumentV1` projection transiently; that projection includes fields such as title, headings, snippets, and normalized lexical text. Plaintext byte buffers and decoded vector buffers are actively zeroed, while parsed JavaScript strings remain subject to garbage collection because JavaScript cannot guarantee in-place string erasure. The projection is never persisted, logged, or returned. The service does not call an embedding or language-model provider, generate data keys, re-encrypt roots, mutate index rows, parse browser/user sessions, or render a UI. Its KMS session can call only `Decrypt` for configured active/retired `ai_assisted` `object_wrap` roots. It rejects content-MAC, private-manual, staged, revoked, unknown, cross-account, cross-region, and conflicting key records. KMS ciphertext, imported key bytes, owner-bound digests, OIDC tokens, and database credentials are also never logged or returned.

## HTTP contract

`GET /health` and `HEAD /health` return content-free liveness metadata only. They do not prove database identity, KMS access, invocation authorization, or verification readiness. Verification is exposed as `POST /internal/verify` (rewritten to `/api/internal/verify`) with the exact JSON body:

```json
{
  "ownerId": "00000000-0000-4000-8000-000000000000",
  "generationId": "igen_01K...",
  "revisionToken": "42"
}
```

No query string, cookie, `Authorization`, or deployment-protection bypass header is accepted. Production requires both the web caller's `x-vercel-trusted-oidc-idp-token` and the verifier workload's `x-vercel-oidc-token`. The caller token is cryptographically verified against the configured team issuer/audience, exact web project identity, exact Production subject, and bounded token lifetime. A successful response contains only:

```json
{ "generationId": "igen_01K...", "revisionToken": "42", "verifiedNoteCount": 25, "verified": true }
```

Errors are generic `{ "code", "message", "requestId" }` objects. Client request IDs are accepted only when they are UUIDv4; otherwise the service creates one. Responses are `no-store`, and telemetry contains only bounded request/deployment metadata and aggregate counts.

## Local and Preview behavior

Copy the bounded non-production settings from `.env.example`, then run:

```sh
pnpm --filter @unfiled/verifier dev
```

The server listens on `127.0.0.1:8789` by default. Local and Preview keep `/health` available but fail verification closed with `503`. They reject every Production database, AWS, KMS, and cross-project identity variable. There is intentionally no local plaintext-note workflow, synthetic root key, bearer-secret fallback, or option to point this process at note content. Use the injected unit/adapter tests for credential-free development; use the account-bound Production procedure in `HUMAN_SETUP.md` for real verification evidence.

The deterministic capacity gate runs separately with `pnpm --filter @unfiled/verifier test:capacity`; normal and coverage discovery exclude it so timing is never distorted by V8 instrumentation or parallel unit suites. CI invokes this dedicated one-worker gate explicitly. It streams 1,000 exact 245,760-byte maximum-valid encrypted index documents through 30 actual 8 MiB-bounded responses, including the JSON database-response boundary, strict authenticated decrypt, payload and embedding parsing, and the terminal attestation round trip. Separately, it asserts that the fixed 33-page limit still has 1,023 physical slots under the more conservative 262,160-byte database row maximum. The gate uses the same 18-second in-process allowance as Production configuration at decrypt concurrency 8 and fixed added-heap and resident-memory ceilings; it never substitutes arithmetic for the end-to-end encrypted workload. Fixture encryption time is measured separately and excluded because Production receives already-encrypted database rows.

## Separate Vercel deployment

Create a dedicated Vercel project with Root Directory exactly `apps/verifier`. Do not deploy it inside the web or worker project. Enable Secure Backend Access (OIDC), set a 60-second function ceiling as committed in `vercel.json`, and admit only the proved Production web project through Deployment Protection Trusted Sources. Prove the exact protected Production alias belongs to this verifier project before configuring that alias in the web caller.

Production requires all of the following verifier-scoped variables:

- `UNFILED_VERIFIER_ENV=production`; Vercel must inject `VERCEL_ENV=production`.
- `UNFILED_VERIFIER_PROJECT_ID`, exactly equal to Vercel's injected `VERCEL_PROJECT_ID`.
- `UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT`, exactly equal to `owner:<team-slug>:project:<verifier-project-name>:environment:production` and the AWS trust-policy subject.
- `UNFILED_AWS_REGION` and a verifier-only `UNFILED_AWS_ROLE_ARN` in the same AWS partition, account, and region as the KMS roots.
- `UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN`, the full active AI-assisted object-wrap KMS key ARN. Aliases and raw key IDs are rejected.
- `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`, copied verbatim from `terraform output -raw verifier_retired_ai_object_wrap_roots_json` (initially `[]`). It is a duplicate-free JSON array of at most 20 full retired AI object-wrap root ARNs in the same partition/account/region. It is a root-rotation registry, not the bound on per-generation key records. Row/page admission is the shared, fixed `RAG_GENERATION_VERIFICATION_NOTE_CAPACITY=1000`: 33 pages, an 8,388,608-byte page budget, and at most 31 database-maximum 262,160-byte rows per page provide 1,023 physical worst-row slots, deliberately capped at the accepted 1,000-note retrieval gate. The RPC row limit remains fixed at 50 for smaller rows. A separate, shared `RAG_GENERATION_VERIFICATION_MAX_DISTINCT_KEYS=4` contract bounds the distinct owner-bound object-wrap key records opened by one verification; normal generations use one active key, and a fifth key is a deterministic `generation_invalid` rebuild condition. The request budget reserves four serial KMS timeout windows. Verification is admitted only when both the row/page and key-cardinality bounds hold. Neither bound is environment-overridable; `UNFILED_VERIFIER_MAX_PAGES`, `UNFILED_VERIFIER_PAGE_LIMIT`, and `UNFILED_VERIFIER_PAGE_CIPHERTEXT_BYTE_BUDGET` are rejected in every runtime so web admission and verifier capacity cannot drift.
- `UNFILED_TRUSTED_SOURCE_TEAM_SLUG`, `UNFILED_TRUSTED_SOURCE_OWNER_ID`, `UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID`, `UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME`, and `UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT`, describing the distinct Production web caller. The expected subject must be exactly `owner:<team-slug>:project:<web-project-name>:environment:production`.
- `UNFILED_VERIFIER_DATABASE_URL`, `UNFILED_VERIFIER_DATABASE_EXPECTED_HOST`, `UNFILED_VERIFIER_DATABASE_PROJECT_REF`, and `UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64`. The URL must authenticate the exact `unfiled_rag_verifier` login, target only `postgres`, use `sslmode=verify-full`, and match the pinned canonical hostname and CA. A shared Supavisor endpoint requires transport username `unfiled_rag_verifier.<20-character-project-ref>`; a direct/dedicated endpoint uses `unfiled_rag_verifier`. Every checkout proves both `session_user` and `current_user` are the unsuffixed role.

Optional bounded controls are `UNFILED_VERIFIER_MAX_REQUEST_BYTES` (maximum 4,096), `UNFILED_VERIFIER_TIMEOUT_MS` (fixed default and maximum 49,000), `UNFILED_VERIFIER_DECRYPT_CONCURRENCY` (1–8), `UNFILED_VERIFIER_DATABASE_CONNECT_TIMEOUT_MS` (500–10,000), `UNFILED_VERIFIER_DATABASE_STATEMENT_TIMEOUT_MS` (250–5,000), and `UNFILED_VERIFIER_KMS_TIMEOUT_MS` (500–5,000). Startup rejects a combination unless its explicit worst-case composition fits inside the request deadline. At the defaults, the exact 49 seconds reserve 38 statement windows (one request preflight, 33 page reads, two attestation attempts, and two connection-identity checks), two query-cancellation grace windows for the bounded attestation replay, two connection attempts, four serial KMS timeout windows, an 18-second measured in-process capacity allowance, and 9 seconds for HTTP parsing, OIDC verification, event-loop scheduling, and response headroom. The in-process allowance already includes the simulated database JSON response boundary, strict envelope validation, decrypt, document/vector parsing, and attestation call. It scales inversely when decrypt concurrency is lowered, so unsafe low-throughput combinations fail at startup. One checked-out connection is retained for the verification session; a failed query destroys it, only an attestation replay can acquire the second connection, and a third acquisition is rejected. The pool verifies the exact database role on each of those physical connections; a separate request preflight returns an opaque proof reused only for that verification, eliminating redundant per-page identity queries without weakening the per-connection boundary. The 49-second verifier deadline expires before the web caller's 54-second deadline, the 55-second maintenance deadline, and the 60-second function ceiling. All paging and KMS work is also bound to the request abort signal.

Do not configure static AWS credentials, `UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN`, any private-manual/content-MAC key, `GenerateDataKey`/`ReEncrypt` capability, an OpenAI or embedding credential, a user-session secret, `CRON_SECRET`, `UNFILED_WORKER_DATABASE_URL`, a Supabase API/service key, any non-empty `SUPABASE*` variable, or an ambient database variable such as `DATABASE_URL`, `POSTGRES_URL`, or `PGPASSWORD`. The process rejects those capabilities at startup. The verifier database login must retain exactly two public RPC grants—`list_building_note_rag_index(...)` and `verify_rag_index_generation(...)`—with no relation or private-schema access.

Deployment and runtime code do not substitute for the account-bound gates. Complete the exact Vercel, AWS IAM/KMS, Supabase login/TLS, denial, rotation, outage, replay, header-preservation, and CloudTrail evidence procedure in `HUMAN_SETUP.md` before activating a shadow generation.
