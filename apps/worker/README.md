# Unfiled isolated worker

This package is the separately deployable organization and encrypted-index trust domain introduced by C.5a. It exposes only JSON health and content-free drain endpoints. It has no page renderer, browser bundle, user-session parser, or private-manual key selector.

The scaffold intentionally fails closed on `POST /internal/drain` until the durable job repository and drain adapter are connected. Caller verification and `@unfiled/key-management` custody are wired; `GET /health` can still prove that a correctly configured deployment is alive.

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

Until the adapters are wired, the expected response is a generic `503`; no job is claimed and no plaintext fallback exists.

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

The AWS trust policy must pin OIDC audience `sts.amazonaws.com`. At runtime Vercel places its workload OIDC token in the `x-vercel-oidc-token` request header. The explicit header check is only a bounded presence guard: the Vercel AWS provider reads the token from request context, exchanges it through STS, and the worker proves real GenerateDataKey + Decrypt access against both active AI roots before issuing a request-scoped authority. That opaque authority cannot be recreated with an object literal. It exposes only a revocable worker-safe generate/unwrap facade: every operation rechecks live authority and forces a composite of the original request signal and a private lease-revocation signal. Retained references fail after abort/completion, outstanding custody calls are actively aborted on normal scope completion, and revocation occurs before the KMS session closes. The raw token is never passed to the drain port, returned, or logged.

Do not configure static `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or `AWS_SESSION_TOKEN`. The worker must obtain short-lived credentials through Vercel OIDC. Do not configure `UNFILED_PRIVATE_OBJECT_WRAP_KMS_KEY_ARN`, `UNFILED_PRIVATE_CONTENT_MAC_KMS_KEY_ARN`, or legacy singular key IDs. Its AWS role permits only `kms:DescribeKey`, `kms:GenerateDataKey`, and `kms:Decrypt` against the two exact AI-assisted roots and has an explicit `kms:*` deny for both private-manual roots. Root rewrap remains an interactive-web capability and is not granted to the worker. Bind the AWS trust policy to the exact issuer, `sts.amazonaws.com` audience, and `sub`; a project or team prefix match is insufficient.

Account setup must also enable and retain CloudTrail evidence for the worker's STS/KMS use, including the encryption context needed by the security drills. The scaffold does not claim that a worker-specific audit stream exists until that setup has been completed and verified.

Production does not accept the local/preview bearer and rejects both `UNFILED_WORKER_DRAIN_SECRET` and `CRON_SECRET`. Configure Vercel Deployment Protection Trusted Sources so the exact web production project may call the worker production project, and forward the caller token in `x-vercel-trusted-oidc-idp-token`. The worker independently verifies the RS256 signature and pins the team issuer, default team audience, exact subject, owner slug/ID, project name/ID, production environment, `iat`, `nbf`, and one-hour maximum production lifetime. It rejects `Authorization` and `x-vercel-protection-bypass` instead of treating either as a fallback. The worker's separate `x-vercel-oidc-token` AWS workload token is never caller authentication.

Vercel's contract documents the Trusted Sources request header but does not guarantee in the cited setup text that it remains visible after Deployment Protection verification. Before cutover, run a deployed production probe that records only pass/fail and proves the header reaches the function. If it is absent, this implementation returns `401`; do not add a bearer or bypass fallback. Platform Trusted Sources remains mandatory even though the function also performs cryptographic verification.

The process also refuses known user-session variables, private-manual KMS variables, every non-empty environment variable whose name contains `SUPABASE`, and conventional ambient database variables such as `DATABASE_URL`, `POSTGRES_URL`, and `PGPASSWORD`, even in local mode. A linked integration can inject JWT-signing or database capabilities that bypass the worker's RPC-only role, so none may enter this trust domain. C.5c may add only the dedicated non-bypass `UNFILED_WORKER_DATABASE_URL`; the guard intentionally permits that exact capability name. Vercel project separation and the database/IAM/KMS policies remain the authoritative capability boundary.

## C.5a integration checklist

1. Configure the exact Vercel Trusted Sources project/environment rule, deploy the content-free header-visibility probe, and preserve its account-bound evidence.
2. Implement `WorkerDrainPort` in `src/drain.ts` using service-only, content-free claim/heartbeat/complete/fail RPCs. Its durable job rows may contain IDs, revisions, lease state, and encrypted envelopes only.
3. Replace only the remaining fail-closed drain port in `src/entrypoint.ts`. Do not import web auth, UI code, the private-manual custodian, or the interactive API's environment.
4. Configure the web caller to `POST /internal/drain` with `x-vercel-trusted-oidc-idp-token`. Keep request bodies empty or use the strict `{ "trigger": "schedule" }` command. Never downgrade production to a local bearer, `CRON_SECRET`, or deployment-bypass secret.
5. Exercise account-bound wrong-project OIDC, private-key deny, KMS outage, timeout/abort, lease recovery, v1→v2 rotation, header preservation, and CloudTrail audit tests before disabling the Milestone C same-deployment organizer.

The production cutover is incomplete until those adapters and account-bound IAM checks are green. This scaffold alone is not evidence that notes are fully encrypted or that private-manual data is E2EE.
