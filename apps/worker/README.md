# Unfiled isolated worker

This package is the separately deployable encrypted-index trust domain introduced by C.5a/C.5c. It exposes only JSON health and content-free drain endpoints. It has no page renderer, browser bundle, user-session parser, global Supabase credential, or private-manual key selector.

The production composition is executable. It connects only as `unfiled_index_worker` over verified TLS, calls the exact six reviewed RAG RPCs, opens only owner/revision-bound `ai_assisted` ciphertext through request-scoped KMS custody, obtains a model-bound embedding, seals the retrieval document, revalidates the lease/privacy/revision boundary, and commits the ciphertext. Ambiguous state transitions replay the exact same serialized request once; lease recovery owns any remaining uncertainty.

## Local run

Copy `.env.example` values into your local environment, replace the drain secret with a random value of at least 32 characters, then run:

```sh
pnpm --filter @unfiled/worker dev
```

The local server listens on `127.0.0.1:8788` by default. A drain request has no content payload beyond an optional trigger:

```sh
curl -X POST http://127.0.0.1:8788/internal/drain \
  -H "Authorization: Bearer $UNFILED_WORKER_DRAIN_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"trigger":"manual"}'
```

Indexing is disabled in local/Preview when the complete dedicated database/provider configuration is absent, so the drain returns a generic `503` while health remains available. The production KMS custodian cannot be replaced by the local synthetic authority; use dependency-injected tests and a disposable exact-role database integration for credential-free development evidence. There is no plaintext or global-credential fallback.

## Separate Vercel project

Create a Vercel project whose Root Directory is exactly `apps/worker`. Do not reuse the web/API project. Enable Secure Backend Access (OIDC) for this worker project and keep the project ID in `UNFILED_WORKER_PROJECT_ID`. The committed `api` entries use Vercel's Node Web Handler interface, and `vercel.json` enables cancellation plus a 60-second platform ceiling.

Production needs these worker-scoped values:

- `UNFILED_WORKER_ENV=production` and Vercel's own `VERCEL_ENV=production`.
- `UNFILED_AWS_REGION` and an `UNFILED_AWS_ROLE_ARN` dedicated to the worker workload.
- `UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN` and `UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN`, set to the two distinct full AI-assisted key ARNs emitted by infrastructure. Aliases, raw IDs, and a legacy singular key ID are rejected. Both ARNs must match the role's AWS partition/account and configured region.
- `UNFILED_RETIRED_AI_ROOT_REGISTRY_JSON`, normally `[]`, or a JSON array of retained decrypt-only roots during rotation. Every record must contain exactly `{ "arn", "keyClass": "ai_assisted", "purpose": "object_wrap" | "content_mac", "status": "retired" }`. Copy the exact machine-generated value from `terraform output -raw worker_retired_ai_root_registry_json`; never hand-transform the broader registry or copy staged/private outputs. The worker rejects private-manual, staged, active, duplicate, cross-account/partition/region, active-root duplicates, unknown-field records, and more than 20 retired generations per purpose. Readiness probes active roots only; runtime unwrap accepts the validated retired AI roots so v1 envelopes remain readable while v2 is promoted and rewrap completes.
- `UNFILED_WORKER_EXPECTED_OIDC_SUBJECT`, equal to the one exact production worker subject in the AWS role trust condition. Its `project:` segment contains the exact Vercel project **name** (for example `unfiled-worker`), not the `prj_...` project ID.
- `UNFILED_WORKER_PROJECT_ID`, exactly matching Vercel's injected `VERCEL_PROJECT_ID`.
- `UNFILED_TRUSTED_SOURCE_TEAM_SLUG`, `UNFILED_TRUSTED_SOURCE_OWNER_ID`, `UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID`, `UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME`, and `UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT`, all describing the separate production web project that invokes this worker. The source project ID and name must differ from the worker's, and the source subject must exactly equal `owner:<team-slug>:project:<web-project-name>:environment:production`.
- `UNFILED_WORKER_DATABASE_URL`, using the Supabase shared-pooler transport username `unfiled_index_worker.<project-ref>` and `sslmode=verify-full`; the separately pinned `UNFILED_WORKER_DATABASE_EXPECTED_HOST` and `UNFILED_WORKER_DATABASE_PROJECT_REF`; and `UNFILED_WORKER_DATABASE_CA_PEM_BASE64`, containing the canonical downloaded CA chain. A direct or dedicated-pooler `db.<project-ref>.supabase.co` endpoint instead uses the unsuffixed role. The parser derives the only acceptable transport username from the endpoint class and exact 20-character project ref, and rejects tenant drift, IP literals, alternate users/databases, credentials outside the URL, ambiguous paths/parameters, and hostname mismatch. Every pooled session independently proves both PostgreSQL `session_user` and `current_user` are the unsuffixed exact worker role before use.
- `UNFILED_OPENAI_EMBEDDING_API_KEY`, `UNFILED_EMBEDDING_MODEL_ID`, and `UNFILED_EMBEDDING_DIMENSIONS`. The fixed endpoint is `https://api.openai.com/v1/embeddings`; redirects, unbounded input/output, unexpected response fields, model/dimension mismatch, and non-finite values fail closed. Only AI-assisted note projection text is sent. Private-manual content is rejected by the database before claim and is never opened or submitted.
- Optional bounded controls: `UNFILED_INDEX_CLAIM_LIMIT` (maximum 4), `UNFILED_INDEX_CONCURRENCY` (maximum 4 and no greater than the claim limit), `UNFILED_INDEX_LEASE_SECONDS`, `UNFILED_INDEX_RECOVERY_LIMIT`, database connect/statement timeouts, and embedding input/timeout limits. Configuration fails closed unless a conservative cold-path budget fits inside the worker deadline: pool connection and identity verification, every critical-path RPC and its identity query, one exact terminal replay, all serial provider rounds, the KMS allowance, and fixed transport/CPU slack. A lease must exceed the entire request deadline by at least five seconds. The default two-claim/two-concurrent batch has one provider round; the 45-second worker deadline remains below the 50-second caller deadline, which remains below the 55-second outer wake-up and 60-second function ceiling. The committed defaults are in `.env.example`.

The AWS trust policy must pin OIDC audience `sts.amazonaws.com`. At runtime Vercel places its workload OIDC token in the `x-vercel-oidc-token` request header. The explicit header check is only a bounded presence guard: the Vercel AWS provider reads the token from request context, exchanges it through STS, and the worker proves real GenerateDataKey + Decrypt access against both active AI roots before issuing a request-scoped authority. That opaque authority cannot be recreated with an object literal. It exposes only a revocable worker-safe generate/unwrap facade: every operation rechecks live authority and forces a composite of the original request signal and a private lease-revocation signal. Retained references fail after abort/completion, outstanding custody calls are actively aborted on normal scope completion, and revocation occurs before the KMS session closes. The raw token is never passed to the drain port, returned, or logged.

Do not configure static `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN`. The worker must obtain short-lived credentials through Vercel OIDC. Do not configure `UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN`, `UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN`, or legacy singular key IDs. Its AWS role permits only `kms:DescribeKey`, `kms:GenerateDataKey`, and `kms:Decrypt` against the two exact AI-assisted roots and has an explicit `kms:*` deny for both private-manual roots. Root rewrap remains an interactive-web capability and is not granted to the worker. Bind the AWS trust policy to the exact issuer, `sts.amazonaws.com` audience, and `sub`; a project or team prefix match is insufficient.

Account setup must also enable and retain CloudTrail evidence for the worker's STS/KMS use, including the encryption context needed by the security drills. The implementation does not claim that a worker-specific audit stream exists until that setup has been completed and verified.

Production does not accept the local/preview bearer and rejects both `UNFILED_WORKER_DRAIN_SECRET` and `CRON_SECRET`. Configure Vercel Deployment Protection Trusted Sources so the exact web production project may call the worker production project, and forward the caller token in `x-vercel-trusted-oidc-idp-token`. The worker independently verifies the RS256 signature and pins the team issuer, default team audience, exact subject, owner slug/ID, project name/ID, production environment, `iat`, `nbf`, and one-hour maximum production lifetime. It rejects `Authorization` and `x-vercel-protection-bypass` instead of treating either as a fallback. The worker's separate `x-vercel-oidc-token` AWS workload token is never caller authentication.

Vercel's contract documents the Trusted Sources request header but does not guarantee in the cited setup text that it remains visible after Deployment Protection verification. Before cutover, run a deployed production probe that records only pass/fail and proves the header reaches the function. If it is absent, this implementation returns `401`; do not add a bearer or bypass fallback. Platform Trusted Sources remains mandatory even though the function also performs cryptographic verification.

The process also refuses known user-session variables, private-manual KMS variables, every non-empty environment variable whose name contains `SUPABASE`, and conventional ambient database variables such as `DATABASE_URL`, `POSTGRES_URL`, and `PGPASSWORD`, even in local mode. A linked integration can inject JWT-signing or database capabilities that bypass the worker's RPC-only role, so none may enter this trust domain. The only database capability admitted is the deliberately named, exact-role `UNFILED_WORKER_DATABASE_URL`. Vercel project separation and the database/IAM/KMS policies remain the authoritative capability boundary.

## Remaining production gate

1. Configure the exact Vercel Trusted Sources project/environment rule, deploy the content-free header-visibility probe, and preserve its account-bound evidence.
2. Provision the exact-role TLS database login, CA, provider model, and provider credential through the Production secret flow. Run the account-bound identity/allowlist probe before allowing any real job.
3. The web project already sends only `{ "trigger": "schedule" | "recovery" }` with `x-vercel-trusted-oidc-idp-token`; use Vercel's authenticated management plane to prove the exact Production alias belongs to this worker project before configuring that sensitive caller origin, then verify the daily recovery cron. Runtime cannot infer project ownership from an alias, so never substitute an adjacent project-ID assertion or downgrade production to a bearer, `CRON_SECRET`, deployment-bypass secret, forwarded user token, or forwarded workload token.
4. Exercise wrong-project OIDC, private-key deny, KMS/provider/database outage, timeout/abort, lease recovery, v1→v2 rotation, response-loss replay, header preservation, and CloudTrail audit tests.
5. Complete the generation seed and independent strict-decrypt verifier lifecycle before activating a shadow generation. Complete the separate atomic organizer and retire the same-deployment legacy organizer before claiming workload isolation.

The production cutover is incomplete until those lifecycle and account-bound gates are green. This runtime alone is not evidence that the complete note library is encrypted or that private-manual data is E2EE.
