# Human Setup

This file contains only steps that require a human account, physical device, paid service, security decision, or visual usability judgment. The implementation and automated tests do not depend on completing these steps. Live evidence for each step is recorded in `FINAL_REPORT.md`; this file never claims that a step has been performed unless it is listed under "Completed during bootstrap".

## Completed during bootstrap

- GitHub CLI authenticated as `Zachshotamartin`.
- Public repository created at `https://github.com/Zachshotamartin/unfiled`.
- Product, GitHub repository, and local project root renamed to `unfiled`.
- `main` branch protection enabled with strict `CI`, admin enforcement, and force-push/deletion
  protection.
- Milestone F merged into `main` as PR #18 at `e09f9554e2fee8acd454363a5a411cb9bf8e5c6d` on
  2026-09-02; the post-merge `push` workflow run `33612621827` succeeded for that commit.
- GitHub private vulnerability reporting enabled and API-verified active on 2026-09-02.
- Five Vercel projects created in team `zach-2267`: `unfiled-web`, `unfiled-organizer`,
  `unfiled-worker`, `unfiled-verifier`, and `unfiled-search`. Each is linked to the GitHub repository
  with `main` as the production branch, region `sfo1`, Node 22, automatic system environment
  variables enabled, and the OIDC team issuer enabled (subject form
  `owner:zach-2267:project:<project-name>:environment:production`). Project IDs, deployment IDs, and
  alias evidence are recorded in `FINAL_REPORT.md`.
- One free remote Supabase project, `Unfiled Preview` (`us-west-2`), selected as the Production
  database for the private beta. Local Supabase remains Development.

## Free private-beta topology

Read this before any section below. The beta is intentionally **$0**:

- **Key custodian:** `UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1` in every project. Four
  independent AES-256 root families (AI object-wrap, AI content-MAC, private-manual object-wrap,
  private-manual content-MAC) live only in Vercel Sensitive Environment Variables bound to the exact
  Vercel project ID and the `production` environment. Web receives all four; the organizer receives
  AI object-wrap + AI content-MAC; worker, verifier, and search receive AI object-wrap only. See
  [ADR-0016](./docs/decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md).
- **AWS KMS / Terraform / CloudTrail / OIDC-to-AWS are deferred paid hardening.** They are preserved
  in `infra/aws-kms` and the `aws-kms` custodian branches, and are **not required or applied** for the
  free beta. Their steps are collected at the end of this file under "Deferred paid hardening".
- **Provider keys are bring-your-own only.** A user saves an OpenAI key, a Claude (Anthropic) key,
  or both in Supabase Vault through the product UI and chooses Provider, Model, and Effort
  ([ADR-0015](./docs/decisions/ADR-0015-user-selectable-provider-model-effort.md)). No operator
  provider key is configured: `UNFILED_ORGANIZER_OPENAI_API_KEY` is optional and unset, so
  app-default jobs fail closed and non-retryably to Inbox and the UI asks the user to add a key.
  There is no app-funded Claude credential; every Anthropic environment variable is rejected by the
  organizer.
- **Retrieval is provider-free.** Worker, search, organizer, and the web generation lifecycle use
  `local-hash-v1` (`unfiled-local-hash-v1`, 512 dimensions), a deterministic feature-hash vector
  computed in process. It needs no provider key and sends no note or query text anywhere. It is not an
  AI semantic embedding and ranks weaker than one; do not present the AI-assisted search scope as
  semantic search.
- **One database, one deployed environment.** The single Supabase project is Production. Vercel
  Preview deployments are intentionally **not built**: an Ignored Build Step skips every
  non-production build so no second custodian ever targets the shared database. Every variable below
  is set in the **Production** scope only.
- **Vercel Hobby limits.** Hobby cannot provide paid deployment protection (Trusted Sources, password,
  or IP protection) or PITR. Workload endpoints enforce the checked-in app-level Vercel OIDC verifier
  instead; the `UNFILED_TRUSTED_SOURCE_*` variables name the exact web caller that verifier accepts.
- **Storage promise.** Application encryption at rest with scoped server-side decryption. Not
  end-to-end encryption, not zero knowledge, not hardware-backed custody.

## Remaining release gates at a glance

Each gate is one human-owned action with its evidence recorded in `FINAL_REPORT.md`:

1. **Vercel Deployment Protection (REQUIRED, all five projects).** In each project open Settings →
   Deployment Protection → Vercel Authentication and set it to protect **Preview deployments only**.
   It currently protects all deployments, which blocks the public web app and the app-level OIDC
   calls between projects. Record the setting per project.
2. **Remote migrations.** From a trusted shell linked to the beta project, apply
   `20260902000000_managed_key_v2_environment_custody.sql` and
   `20260902000001_dual_provider_model_selection.sql` with `pnpm supabase db push --linked` and record
   the migration head. Both pass a clean local reset and the full pgTAP suite; their remote
   application is evidence only when recorded.
3. **Root ring.** Generate the four root families, set the Production custody variables per project
   as described under "Free-beta key custody", redeploy all five projects, and record root key IDs
   and statuses only (never material).
4. **Dedicated database logins.** Provision `unfiled_index_worker`, `unfiled_rag_verifier`,
   `unfiled_organizer_worker`, and `unfiled_search_worker` as TLS-only logins on the shared project and
   set each project's database variables; record the `session_user` and allowlist probes.
5. **Provider keys through the UI.** On a synthetic account, save one low-value OpenAI key and one
   low-value Anthropic key through the product Settings form, confirm status/last-four/revision, and
   run one synthetic capture per provider. Never paste a key anywhere except that masked form.
6. **Live routing evaluation.** Run `pnpm eval:routing:live` and `pnpm eval:routing:live:anthropic`
   with dedicated evaluation keys and commit the dated content-free reports. No credentialed live run
   exists yet.
7. **PITR and contraction remain deferred.** Record in `FINAL_REPORT.md` that the free plan has no
   PITR, that the irreversible encrypted-storage contraction stays un-applied (`expand_compatible`),
   and that all live writes remain encrypted and fail closed. Do not apply the contraction.
8. **Apple signing.** Complete signing, signed-archive inspection, TestFlight distribution, and the
   physical-iPhone matrix.
9. **Name, legal, and mailbox clearance.** Complete `docs/NAME_CLEARANCE.md`, legal review of the
   public routes, and proof of a monitored security/support mailbox.
10. **Monitoring and restore.** Configure the content-free dashboards and alerts in
    `docs/operations/MONITORING_AND_ALERTING.md` and run one timed restore drill within the free
    plan's actual backup capability.
11. **Demo.** Provision the synthetic demo account through supported paths and record the fresh-user
    iPhone-to-web demonstration.

## Local prerequisites

1. Install Node.js 22.18 or newer for the web, worker, shared packages, and repository checks.
2. Install pnpm 10.14.0: `npm install --global pnpm@10.14.0`.
3. Install Docker Desktop and start it before database commands.
4. Install full Xcode from the Mac App Store, open it once to accept its license and install an iOS Simulator runtime, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`. The current project targets iOS 17 and newer and is verified with Xcode 26.6.
5. Install the repository-pinned XcodeGen 2.46.0 release. Generate `apps/ios/Unfiled.xcodeproj` from the checked-in `apps/ios/project.yml`; do not treat hand-edited generated project settings as source of truth. The generation script rejects other versions so a tool upgrade cannot silently rewrite the checked-in project.
6. The Development scheme reads `http://127.0.0.1:3000/api/v1` from `apps/ios/Config/Development.xcconfig`; that loopback reaches the host only from the Simulator. Signed physical-device network tests use the Preview scheme and its reachable HTTPS `/api/v1` origin. Production uses its matching checked configuration. Never place a Supabase service key or another server secret in app configuration.
7. Treat local and CI unsigned simulator builds as code evidence only. They do not prove Apple signing, archive contents, App Group provisioning, installation, Keychain/SQLCipher behavior, or widget behavior on a physical iPhone.
8. Android is not part of this milestone. No Android SDK, application ID, credential, build, or store setup is required.

## Design-sprint evidence

Complete these human validation items before treating Milestone 0 as approved:

1. Test the capture, shopping, workout, mindset, ambiguity, manual-edit, and undo prototype with at least five representative users.
2. Record whether users can capture without filing, understand a receipt, find the manual editor, correct a route, and undo without coaching.
3. Validate the smallest supported iPhone with the keyboard open and Dynamic Type at 200%.
4. Perform optical correction of the working SVG mark and create the final wordmark after trademark clearance.
5. Complete trademark, App Store, package-name, social-handle, and domain clearance for Unfiled.

## Supabase cloud — private-beta topology

1. The one approved free remote project `Unfiled Preview` (`us-west-2`) is the **Production**
   database for the private beta. Only the Vercel Production scope targets it; Preview deployments are
   not built. Local Supabase remains the Development database. Workload-specific least-privilege
   PostgreSQL identities are provisioned below in this shared database.
2. Enable Vault and record the free plan's actual backup/restore behavior. Paid point-in-time
   recovery and a separate remote project are deferred hardening items. Do not claim PITR or
   environment-isolated recovery, and do not execute the irreversible encrypted-storage contraction
   while its required restore/PITR gate is unavailable.
3. Enter the project URL, anonymous key, and service-role key as explicit Production values in only
   the `unfiled-web` project. Do **not** put the Supabase database password in any web or workload
   runtime; keep it in the approved operator secret manager for migrations and recovery only. The
   isolated `unfiled-worker`, `unfiled-verifier`, `unfiled-organizer`, and `unfiled-search` projects
   must never receive a global Supabase service-role or secret key.
4. Link the beta project from a trusted shell: `pnpm supabase link --project-ref <beta-project-ref>`.
5. Review migrations through `20260902000001_dual_provider_model_selection.sql`, then apply with
   `pnpm supabase db push --linked` (add `--include-roles` for the reviewed CLI release when
   `supabase/roles.sql` must be applied). Record the resulting migration head and timestamp in
   `FINAL_REPORT.md`; a green local reset is not remote evidence.
6. Because every deployed caller reaches the same beta records, keep access controlled, use
   synthetic accounts for deployment verification, and do not share the URL as a disposable public
   sandbox. Moving to two remote projects requires a reviewed data/migration and secret cutover.
7. Enable database SSL enforcement and download the official Supabase Root 2021 CA. Every workload
   connects through the shared Supavisor transaction pooler at
   `aws-0-us-west-2.pooler.supabase.com:6543` with the transport username `<role>.<project-ref>`,
   `sslmode=verify-full`, and that CA base64-encoded into the workload's `*_DATABASE_CA_PEM_BASE64`
   variable. PostgreSQL must still report `session_user` and `current_user` as the unsuffixed role.

## Vercel — five projects, Production scope only

The five projects exist (see "Completed during bootstrap"). Expected production aliases are
`https://unfiled-web.vercel.app`, `https://unfiled-organizer.vercel.app`,
`https://unfiled-worker.vercel.app`, `https://unfiled-verifier.vercel.app`, and
`https://unfiled-search.vercel.app`. A resolving alias is not proof of the exact project, deployment,
or commit; record the authenticated dashboard/API mapping in `FINAL_REPORT.md`.

Automatic System Environment Variables are enabled in all five projects. Managed startup requires
Vercel's exact `VERCEL=1`, `VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_GIT_COMMIT_SHA`, and
`VERCEL_PROJECT_ID`; never set or copy them manually. Each `/health` response must be `no-store` and
expose `x-unfiled-deployment=sha256:<lowercase-hex>`, `x-unfiled-commit=<exact-lowercase-full-SHA>`,
and `x-unfiled-environment=production`. The release probe exact-matches these three non-secret
values across all five services.

### Required dashboard action: Deployment Protection

For **each** of the five projects: Settings → Deployment Protection → Vercel Authentication → set to
protect **Preview deployments only**. The projects currently protect all deployments, which returns
Vercel's authentication page instead of the public web app and blocks the app-level OIDC calls from
web to the four isolated services. This is a release gate; record the resulting setting for each
project in `FINAL_REPORT.md`. Vercel Hobby cannot add Trusted Sources, password, or IP protection;
the isolated services rely on the checked-in OIDC verifier described below.

### Ignored Build Step

Preview deployments are intentionally not built. Each project's Ignored Build Step skips every build
whose `VERCEL_ENV` is not `production`. Confirm no Preview deployment exists for any project and
record that in `FINAL_REPORT.md`. Do not set any variable in the Preview or Development scope.

### `unfiled-web` Production variables

Set these in the Production scope (values omitted; see `apps/web/.env.example` for shapes):

```dotenv
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_SITE_URL
SUPABASE_SERVICE_ROLE_KEY
AUTH_RATE_LIMIT_PEPPER
ACCOUNT_DELETION_REPLAY_RATE_LIMIT_PEPPER
UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY
CRON_SECRET
NOTE_RETENTION_EXECUTION_ENABLED=false
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
UNFILED_ORGANIZER_ENV=production
UNFILED_ORGANIZER_ORIGIN=https://unfiled-organizer.vercel.app
UNFILED_WORKER_ENV=production
UNFILED_INDEX_WORKER_ORIGIN=https://unfiled-worker.vercel.app
UNFILED_VERIFIER_ENV=production
UNFILED_RAG_VERIFIER_ORIGIN=https://unfiled-verifier.vercel.app
UNFILED_SEARCH_ENV=production
UNFILED_SEARCH_ORIGIN=https://unfiled-search.vercel.app
UNFILED_EMBEDDING_MODEL_ID=unfiled-local-hash-v1
UNFILED_EMBEDDING_DIMENSIONS=512
```

Rules:

1. Generate `AUTH_RATE_LIMIT_PEPPER` and `ACCOUNT_DELETION_REPLAY_RATE_LIMIT_PEPPER` separately with
   `openssl rand -hex 32`, `UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY` with
   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`, and `CRON_SECRET` with
   `openssl rand -base64 48`. Add each interactively with `vercel env add <NAME> production`; never
   reuse one value for another purpose and never prefix a secret with `NEXT_PUBLIC_`.
2. `NEXT_PUBLIC_SITE_URL` is the canonical origin including `https://` and excluding a trailing slash
   (`https://unfiled-web.vercel.app` until a cleared custom domain exists). It is read by
   `apps/web/src/app/layout.tsx` and is not listed in `apps/web/.env.example`.
3. Leave `UNFILED_MANAGED_AI_FALLBACK_AVAILABLE` **unset**. When it is unset, the settings UI hides
   managed fallback, does not offer "Unfiled managed" mode as a new choice, and always sends
   `byokFallbackToApp: false`. Set it to exactly `1` or `true` only in a future deployment that funds
   `UNFILED_ORGANIZER_OPENAI_API_KEY`.
4. Do not set `UNFILED_CONTENT_KEK_ID`, `UNFILED_CONTENT_KEK`, `UNFILED_CONTENT_FINGERPRINT_KEY`,
   `UNFILED_CONTENT_RETIRED_KEKS`, `UNFILED_LOCAL_KEY_RING_V1`, `UNFILED_WEB_ROOT_KEY_REGISTRY_JSON`,
   `UNFILED_AWS_REGION`, `UNFILED_AWS_ROLE_ARN`, or `UNFILED_WEB_DATA_ADAPTER` in Vercel; the
   `vercel-sensitive-env-v1` runtime rejects all of them.
5. `apps/web/vercel.json` schedules `/api/internal/captures/drain` at 03:07 UTC,
   `/api/internal/retention/notes` at 03:17 UTC, `/api/internal/indexing/maintenance` at 02:22 UTC, and
   `/api/internal/indexing/drain` at 03:27 UTC. Hobby schedules are daily and may run at any point
   within the selected hour. Retention remains a dry run while `NOTE_RETENTION_EXECUTION_ENABLED` is
   `false`; confirm the first cron response has `dryRun: true`, `executionEnabled: false`,
   `purgedCount: 0`, and a plausible `eligibleCount`, then inspect it independently:

   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $UNFILED_RETENTION_CRON_SECRET" \
     "https://unfiled-web.vercel.app/api/internal/retention/notes?dryRun=true"
   ```

   Set the temporary `UNFILED_RETENTION_CRON_SECRET` variable from the secret manager; never paste
   the value into shell history or a ticket. Only after reviewing that dry run and approving permanent
   deletion under the published 30-day policy, set `NOTE_RETENTION_EXECUTION_ENABLED=true` and
   redeploy. Alert on any cron failure or `batchLimitReached: true`; set the gate back to `false`
   while investigating.

6. Add a custom domain only after name clearance.

### Capture encryption and durable workflow

1. For **local development only**, generate three independent values with
   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`, place each directly into a password manager,
   and add these server-only values to `apps/web/.env.local`:

   ```dotenv
   UNFILED_CONTENT_KEK_ID=local-content-kek-v1
   UNFILED_CONTENT_KEK=<first-independent-base64url-value>
   UNFILED_CONTENT_FINGERPRINT_KEY=<second-independent-base64url-value>
   UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY=<third-independent-base64url-value>
   CRON_SECRET=<at-least-32-random-characters>
   ```

   Never put those legacy/local key variables in Vercel. Production uses the Vercel Sensitive root
   ring below and never falls back to local custody.

2. Migration `20260830000012_durable_capture_workflow.sql` deliberately aborts with
   `legacy_capture_encryption_backfill_required` if an older environment contains capture text. For
   disposable data, recreate the project. For data that must be retained, stop writes and use the
   audited backfill/verification tool; never edit the migration to discard or relabel plaintext.
3. `after()` and the daily `/api/internal/captures/drain` recovery route make one content-free
   OIDC-authenticated call to the isolated organizer; they never run the organizer inside `apps/web`
   and never chain the organizer's 49-second budget to the index worker's budget. The encrypted
   organizer and index queues plus their separate recovery crons are authoritative. Deterministic
   organization exists only as an explicitly injected test fixture.
4. After the first Production deployment, create one synthetic canary capture and inspect it only
   through the owner-authorized encrypted projection. The canary must have an authenticated version-1
   ciphertext envelope and keyed verification metadata and must have zero hits in rows, indexes,
   logs, traces, analytics, or URLs. Public API responses may return plaintext only after owner
   authorization and must never return an envelope, MAC/fingerprint, reservation, or key identifier.

## Free-beta key custody — Vercel Sensitive environment root ring

The custodian is `vercel-sensitive-env-v1` ([ADR-0016](./docs/decisions/ADR-0016-free-beta-vercel-sensitive-key-custody-and-local-hash-retrieval.md)).
Root key IDs have the form `urn:unfiled:key-root:vercel-sensitive-env-v1:production:<uuid>`; the
runtime matches `VERCEL_PROJECT_ID` and `VERCEL_ENV=production` against every document and fails
closed on any mismatch.

### 1. Generate the four root families

1. On a trusted machine, generate four independent 32-byte base64url values with
   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` and four lowercase UUIDs with
   `uuidgen | tr 'A-Z' 'a-z'`. Write each value directly into a protected local file or the password
   manager; never pass material as a shell argument, paste it into a ticket, or commit it.
2. Assign one UUID to each family: `ai_assisted/object_wrap`, `ai_assisted/content_mac`,
   `private_manual/object_wrap`, `private_manual/content_mac`.
3. Build the two web documents as compact canonical JSON produced by `JSON.stringify` with no
   whitespace or duplicate properties (shapes in `apps/web/.env.example`):
   - `UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON`: `version: 2`,
     `custodyProvider: "vercel_sensitive_environment_v1"`, the exact web `projectId`,
     `deploymentEnvironment: "production"`, and four `roots` entries (`generation: 1`, `keyClass`,
     `purpose`, `rootKeyId`, `status: "active"`). It contains **no key material**.
   - `UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1`: `version: 1`, the same `projectId` and
     `deploymentEnvironment`, and `roots` entries of `{rootKeyId, keyMaterial}`.
4. Build one ring per isolated project containing **only that workload's subset** and that project's
   own `projectId`:
   - organizer: AI object-wrap + AI content-MAC;
   - worker, verifier, search: AI object-wrap only.
     No private-manual root may appear in any isolated project's ring.
5. Use a throwaway local script that reads the material files and writes the JSON documents to
   protected files; have it print only root IDs. Delete the working directory afterwards.

### 2. Set the Production custody variables

Add every variable below as a **Sensitive** environment variable in the Production scope with
`vercel env add <NAME> production --sensitive` (or the dashboard's Sensitive toggle) so the value is
never readable again from the dashboard or CLI.

`unfiled-web`:

```dotenv
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_WEB_ROOT_KEY_REGISTRY_V2_JSON
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
```

`unfiled-organizer`:

```dotenv
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_ORGANIZER_PROJECT_ID=<organizer prj_ id>
UNFILED_ORGANIZER_AI_OBJECT_WRAP_ROOT_KEY_ID
UNFILED_ORGANIZER_AI_CONTENT_MAC_ROOT_KEY_ID
UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON=[]
UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOT_KEY_IDS_JSON=[]
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
```

`unfiled-worker`:

```dotenv
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_WORKER_PROJECT_ID=<worker prj_ id>
UNFILED_WORKER_AI_OBJECT_WRAP_ROOT_KEY_ID
UNFILED_WORKER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON=[]
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
```

`unfiled-verifier`:

```dotenv
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_VERIFIER_PROJECT_ID=<verifier prj_ id>
UNFILED_VERIFIER_AI_OBJECT_WRAP_ROOT_KEY_ID
UNFILED_VERIFIER_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON=[]
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
```

`unfiled-search`:

```dotenv
UNFILED_KEY_CUSTODIAN=vercel-sensitive-env-v1
UNFILED_SEARCH_PROJECT_ID=<search prj_ id>
UNFILED_SEARCH_AI_OBJECT_WRAP_ROOT_KEY_ID
UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOT_KEY_IDS_JSON=[]
UNFILED_VERCEL_SENSITIVE_ENV_ROOT_KEY_RING_V1
```

Each `*_PROJECT_ID` must equal that project's injected `VERCEL_PROJECT_ID`. Do not set any
`UNFILED_AWS_*`, `*_KMS_KEY_ARN`, `*_EXPECTED_OIDC_SUBJECT`, `*_RETIRED_*_ROOTS_JSON` (AWS ARN
lists), `AWS_*` credential, private-manual, legacy, or `NEXT_PUBLIC_*` key variable alongside this
mode; every runtime rejects them.

### 3. Activate and verify

1. After the V2 migration is applied and the variables are set, redeploy all five projects. The
   first authenticated owner operation atomically generates, registers with
   `register_user_content_key_v2`, proves, and activates four owner-bound intermediate keys.
2. Prove from configuration only (not by printing values) that each isolated project holds exactly
   its subset: organizer two roots, worker/verifier/search one root, and no project except web holds
   a private-manual root. Record root IDs, generation numbers, and statuses in `FINAL_REPORT.md`.
3. Run the synthetic canary from "Capture encryption and durable workflow" step 4 and one
   AI-assisted synthetic index/verify cycle after the database logins below are live.

### 4. Rotate a root family

Rotation is new root generation plus redeploy; there is no external KMS call.

1. Generate a new 32-byte value and UUID for the affected family.
2. In the web registry, add the new root as `active` with `generation` incremented and set the
   previous root to `retired`. Add the new material to every ring that carries that family and keep
   the previous material in those rings while it is retired.
3. Add the previous root ID to each affected workload's `*_RETIRED_*_ROOT_KEY_IDS_JSON` list and set
   the workload's active `*_ROOT_KEY_ID` to the new ID.
4. Redeploy every project that receives that family; a mixed deployment set fails closed.
5. Rewrap owner intermediate keys through the service-only `rewrap_user_content_key` RPC from the
   interactive/admin service; record that one call updates ciphertext, new/previous root, count, and
   timestamp together and that an exact retry reports replay.
6. Remove the retired root from rings and lists only after every reference reaches zero and a
   restore check passes. Never remove a generation still referenced by data.

## Dedicated database logins on the shared beta project

`supabase/roles.sql` and the migrations create `unfiled_index_worker` (six RPCs),
`unfiled_rag_verifier` (two RPCs), `unfiled_organizer_worker` (eleven RPCs), and
`unfiled_search_worker` (five RPCs) as `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS` roles with no relation,
sequence, or private-schema privilege. A migration replay returns a role to `NOLOGIN`; provisioning
is an explicit human step, never a migration secret.

Common procedure for each role:

1. Inspect `pg_auth_members`: zero membership rows is preferred; otherwise the only permitted row is
   the automatic `supabase_admin`-granted ADMIN-only edge to `postgres` with `INHERIT=false` and
   `SET=false`. Reject any other row and do not weaken the migration guard.
2. From a trusted administrator `psql` session over verified TLS, enable login and set a generated
   password only at the interactive prompt:

   ```psql
   ALTER ROLE <role> LOGIN;
   \password <role>
   ```

   Never grant `service_role`, `authenticator`, a parent role, `INHERIT`, `BYPASSRLS`, `SUPERUSER`,
   `CREATEDB`, `CREATEROLE`, or `REPLICATION`.

3. Build the URI from the pooler template: username `<role>.<project-ref>`, host
   `aws-0-us-west-2.pooler.supabase.com`, port `6543`, database `postgres`, `sslmode=verify-full`.
   Add it and its companions to that workload's Production scope only. Never copy a URI, password,
   CA, or project ref into web, another workload, CI, source control, logs, or tickets, and never
   substitute a Supabase API key or an RLS-bypassing URL.
4. From the deployed adapter's session, record a content-free readiness result proving
   `session_user = current_user = '<role>'`. `SET ROLE` is not evidence.
5. Run the deployed privilege probe: EXECUTE on exactly the role's allowlist and permission denied
   for every other function, every relation, the `private` schema, public create, and the other
   workloads' RPCs. Record function names, SQLSTATEs, deployment ID, and timestamps only.
6. Rotate each credential independently: pause the workload, use the same `\password` prompt, update
   only the owning project's secret, redeploy, prove the old credential is rejected and the new
   session keeps the exact allowlist, then resume.

### Index worker (`unfiled-worker`)

```dotenv
UNFILED_WORKER_ENV=production
UNFILED_WORKER_DATABASE_URL
UNFILED_WORKER_DATABASE_EXPECTED_HOST=aws-0-us-west-2.pooler.supabase.com
UNFILED_WORKER_DATABASE_PROJECT_REF=<20-character project ref>
UNFILED_WORKER_DATABASE_CA_PEM_BASE64
UNFILED_WORKER_DATABASE_CONNECT_TIMEOUT_MS=3000
UNFILED_WORKER_DATABASE_STATEMENT_TIMEOUT_MS=500
UNFILED_WORKER_EMBEDDING_PROVIDER=local-hash-v1
UNFILED_TRUSTED_SOURCE_TEAM_SLUG=zach-2267
UNFILED_TRUSTED_SOURCE_OWNER_ID=<team_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web prj_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=unfiled-web
UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=owner:zach-2267:project:unfiled-web:environment:production
```

Optional bounded controls: `UNFILED_WORKER_MAX_REQUEST_BYTES`, `UNFILED_WORKER_TIMEOUT_MS`,
`UNFILED_INDEX_CLAIM_LIMIT`, `UNFILED_INDEX_CONCURRENCY`, `UNFILED_INDEX_LEASE_SECONDS`,
`UNFILED_INDEX_RECOVERY_LIMIT`, `UNFILED_EMBEDDING_MAX_INPUT_BYTES`, `UNFILED_EMBEDDING_TIMEOUT_MS`.
`local-hash-v1` fixes the generation to `unfiled-local-hash-v1`/512 and rejects
`UNFILED_OPENAI_EMBEDDING_API_KEY`, `UNFILED_EMBEDDING_MODEL_ID`, and `UNFILED_EMBEDDING_DIMENSIONS`,
so no provider key exists in the worker. Do not set `UNFILED_WORKER_DRAIN_SECRET` or `CRON_SECRET` in
Production.

Allowlist: `claim_note_index_jobs`, `heartbeat_note_index_job`, `commit_note_rag_index`,
`fail_note_index_job`, `recover_stale_note_index_jobs`, `list_active_note_rag_index`.

Deployed checks: from web, invoke the worker with one synthetic AI-assisted index job; prove the
app-level verifier accepted only the exact `unfiled-web` Production subject and rejected direct
public, cookie, `Authorization`, and wrong-project requests; prove the job completed through the
exact role with an in-process local-hash embedding and no outbound provider request. Exercise lease
loss, timeout, database outage, pooler reconnect, response-loss replay, and credential revocation:
jobs must remain queued or recover through the bounded RPCs without any global credential, direct
table, plaintext payload, or private-manual key. Confirm `/api/internal/indexing/maintenance` (02:22
UTC) and `/api/internal/indexing/drain` (03:27 UTC) target only the proved worker/verifier origins.

### Verifier (`unfiled-verifier`)

```dotenv
UNFILED_VERIFIER_ENV=production
UNFILED_VERIFIER_DATABASE_URL
UNFILED_VERIFIER_DATABASE_EXPECTED_HOST=aws-0-us-west-2.pooler.supabase.com
UNFILED_VERIFIER_DATABASE_PROJECT_REF=<20-character project ref>
UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64
UNFILED_TRUSTED_SOURCE_TEAM_SLUG=zach-2267
UNFILED_TRUSTED_SOURCE_OWNER_ID=<team_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web prj_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=unfiled-web
UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=owner:zach-2267:project:unfiled-web:environment:production
```

Optional: `UNFILED_VERIFIER_MAX_REQUEST_BYTES`, `UNFILED_VERIFIER_TIMEOUT_MS`,
`UNFILED_VERIFIER_DECRYPT_CONCURRENCY`, `UNFILED_VERIFIER_DATABASE_CONNECT_TIMEOUT_MS`,
`UNFILED_VERIFIER_DATABASE_STATEMENT_TIMEOUT_MS`, `UNFILED_VERIFIER_KMS_TIMEOUT_MS`.

Allowlist: `list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)` and
`verify_rag_index_generation(uuid,text,bigint,jsonb)`. Prove `service_role` and `SET ROLE` sessions
cannot use either; a bogus extra attestation field and arbitrary digest are rejected; activation
rejects mutated or stale evidence.

Deployed checks: after the worker proof, invoke the verifier from web with one synthetic complete
shadow generation. The response must contain only generation ID, canonical revision token, verified
count, and `verified: true`; logs must contain only request/deployment metadata and aggregate counts.
Tamper independently with ciphertext, envelope context, key reference, model/dimensions, count,
cursor, and revision token; every case must fail closed without creating activation evidence. Then
run one complete authenticated indexing-maintenance invocation followed by recovery.

### Organizer (`unfiled-organizer`)

```dotenv
UNFILED_ORGANIZER_ENV=production
UNFILED_ORGANIZER_DATABASE_URL
UNFILED_ORGANIZER_DATABASE_EXPECTED_HOST=aws-0-us-west-2.pooler.supabase.com
UNFILED_ORGANIZER_DATABASE_PROJECT_REF=<20-character project ref>
UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64
UNFILED_ORGANIZER_DATABASE_CONNECT_TIMEOUT_MS=3000
UNFILED_ORGANIZER_DATABASE_STATEMENT_TIMEOUT_MS=1500
UNFILED_ORGANIZER_EMBEDDING_PROVIDER=local-hash-v1
UNFILED_ORGANIZER_MAX_REQUEST_BYTES=1024
UNFILED_ORGANIZER_TIMEOUT_MS=49000
UNFILED_TRUSTED_SOURCE_TEAM_SLUG=zach-2267
UNFILED_TRUSTED_SOURCE_OWNER_ID=<team_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web prj_ id>
UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=unfiled-web
UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=owner:zach-2267:project:unfiled-web:environment:production
```

Optional: `UNFILED_ORGANIZER_CLAIM_LIMIT`, `UNFILED_ORGANIZER_CONCURRENCY`,
`UNFILED_ORGANIZER_LEASE_SECONDS`, `UNFILED_ORGANIZER_RECOVERY_LIMIT`. Do **not** set
`UNFILED_ORGANIZER_OPENAI_API_KEY` in the free beta (see "Provider keys" below), and never set
`OPENAI_API_KEY`, `UNFILED_OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `UNFILED_ANTHROPIC_API_KEY`,
`UNFILED_ORGANIZER_ANTHROPIC_API_KEY`, `UNFILED_ORGANIZATION_MODEL_API_KEY`, a model/base-URL
override, `UNFILED_ORGANIZER_DRAIN_SECRET`, or `CRON_SECRET`; startup rejects them.

Allowlist (eleven): `claim_encrypted_organizer_jobs(text,integer,integer)`,
`heartbeat_encrypted_organizer_job(text,text,integer,jsonb)`,
`list_encrypted_organizer_candidates(text,text,integer)`,
`list_encrypted_organizer_rag_page(text,text,jsonb,integer,integer)`,
`select_encrypted_organizer_candidates(text,text,jsonb)`,
`prepare_encrypted_organizer_create(text,text,text,text)`,
`prepare_encrypted_organizer_append(text,text,text,bigint,text)`,
`commit_encrypted_organizer_job(text,text,jsonb)`, `fail_encrypted_organizer_job(text,text,text,boolean)`,
`recover_stale_encrypted_organizer_jobs(integer)`, and
`get_lease_bound_organizer_provider_credential`. Also prove `anon`, `authenticated`, `service_role`,
`unfiled_index_worker`, `unfiled_rag_verifier`, and `unfiled_search_worker` cannot execute any of them.

Deployed checks: invoke the organizer from web with an empty synthetic queue and require the
content-free `{"claimed":0,"completed":0,"failed":0,"retryScheduled":0}` response with
`Cache-Control: no-store`; direct public, wrong-project, expired-token, cookie, `Authorization`, and
protection-bypass requests must fail. With no user key and no operator key, a synthetic AI-assisted
capture must fail closed and non-retryably to Inbox with the "add a key" prompt and make no provider
request. Then, after the provider-key gate below, submit synthetic create, append,
explicit-destination, ambiguous Review, revision-race/replan, response-loss replay,
incomplete/stale-RAG, privacy-flip, and provider/database outage canaries for **each** provider. Each
successful terminal transaction must atomically publish encrypted note state, revision/mutation,
decision, receipt/Review, terminal lease state, and one content-free index job. Require zero plaintext
marker outside the explicitly authorized response/provider request path, and confirm the job snapshot
carries provider, model preference, resolved model ID, effort, expansion, settings revision, and
registry version but no key, Vault ID, or header.

Record and rehearse the disable path: stop the web capture schedule and manual drain callers, remove
the organizer's OIDC caller acceptance, and confirm no new lease is claimed while captures and jobs
remain encrypted and queued.

### Search (`unfiled-search`)

```dotenv
UNFILED_SEARCH_ENV=production
UNFILED_SEARCH_DATABASE_URL
UNFILED_SEARCH_DATABASE_EXPECTED_HOST=aws-0-us-west-2.pooler.supabase.com
UNFILED_SEARCH_DATABASE_PROJECT_REF=<20-character project ref>
UNFILED_SEARCH_DATABASE_CA_PEM_BASE64
UNFILED_SEARCH_EMBEDDING_PROVIDER=local-hash-v1
UNFILED_SEARCH_TRUSTED_SOURCE_TEAM_SLUG=zach-2267
UNFILED_SEARCH_TRUSTED_SOURCE_OWNER_ID=<team_ id>
UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_ID=<web prj_ id>
UNFILED_SEARCH_TRUSTED_SOURCE_WEB_PROJECT_NAME=unfiled-web
UNFILED_SEARCH_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=owner:zach-2267:project:unfiled-web:environment:production
```

Optional: `UNFILED_SEARCH_MAX_REQUEST_BYTES`, `UNFILED_SEARCH_TIMEOUT_MS`,
`UNFILED_SEARCH_DATABASE_CONNECT_TIMEOUT_MS`, `UNFILED_SEARCH_DATABASE_STATEMENT_TIMEOUT_MS`.
`local-hash-v1` rejects `UNFILED_SEARCH_OPENAI_API_KEY`. Do not set `UNFILED_SEARCH_INVOCATION_SECRET`
(local only), `UNFILED_SEARCH_PROJECT_TEAM_SLUG`, `UNFILED_SEARCH_PROJECT_NAME`,
`UNFILED_SEARCH_EXPECTED_OIDC_SUBJECT`, `UNFILED_AWS_REGION`, `UNFILED_SEARCH_AWS_ROLE_ARN`,
`UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN`, or `UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`
(AWS-only).

Allowlist (five): `claim_encrypted_user_search(uuid,text,text)`,
`list_encrypted_user_search_rag_page(uuid,text,text,jsonb,jsonb,integer,integer)`,
`verify_encrypted_user_search_snapshot(uuid,text,text,jsonb,jsonb)`,
`complete_encrypted_user_search(uuid,text,text)`, and
`fail_encrypted_user_search(uuid,text,text,public.safe_error_code)`. Separately prove only
`service_role` can execute `begin_encrypted_user_search(uuid,text,jsonb,text)`.

Deployed checks: from a synthetic owner, submit an explicitly `ai_assisted` request and confirm web
mints a 30-second one-use ticket with a random claim secret and sends only ticket ID, secret, and the
exact normalized request (no owner ID, token, generation, key, provider, or model). Exercise two
concurrent claims, response-loss replay, wrong secret, wrong digest, changed/reordered filters, expiry,
terminal replay, and wrong caller; exactly one claim may win. Send the same query under
omitted/default, `mixed`, `private_manual`, and `ai_assisted` filters: only the exact AI-assisted
request may reach search, it computes the local-hash vector in process, and it may return only
AI-assisted references. Missing, failed, stale, incomplete, or changing state must return
semantic-unavailable and trigger a fresh lexical-only search. Rehearse disable by removing web's
`UNFILED_SEARCH_ORIGIN` while leaving lexical search available. Record capacity/latency evidence and
state in every user-facing surface that this scope is lexical-strength local-hash retrieval, not
semantic search.

## Provider keys, dual-provider BYOK, and live routing gates

The organizer is BYOK-first across OpenAI and Claude (Anthropic). The OpenAI adapter uses the
Responses API with strict Structured Outputs, `model` from the job snapshot, and `reasoning.effort`
low/medium/high. The Claude adapter uses `POST https://api.anthropic.com/v1/messages` with
`x-api-key`, `anthropic-version: 2023-06-01`, `output_config.effort`, and one forced strict tool
(`tool_choice: {type:"tool"}`, parallel tool use disabled) whose input schema is derived from the
OpenAI schema; it accepts exactly one matching `tool_use` block and defers text-only, zero/multiple/
wrong tool calls, `max_tokens`, refusals, and non-object inputs to Review. The credential's provider
selects the adapter, so a Claude key never reaches OpenAI and vice versa, and neither reaches
retrieval.

Registry `organization-model-registry-v2`: OpenAI `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`;
Anthropic `claude-sonnet-5`, `claude-opus-5`. Automatic maps Efficient/Balanced/Thorough (wire
`economical|standard|thorough`) to Luna/Terra/Sol and Sonnet/Sonnet/Opus. Cross-provider model choices
are rejected; switching provider resets an incompatible model to Automatic and deletes no key.

1. **Deterministic gates first.** From a clean checkout of the release commit run `pnpm eval:routing`
   and `pnpm eval:routing:pipeline` and retain both JSON reports. Neither makes a network request or
   authorizes provider traffic.
2. **Live evaluation (both providers).** Create one low-value, separately budgeted evaluation key per
   provider in a dedicated project/organization with spend limits. Run:
   - `pnpm eval:routing:live` with `UNFILED_ROUTING_EVAL_OPENAI_API_KEY` (optional
     `UNFILED_ROUTING_EVAL_OPENAI_MODEL`, default `gpt-5.6-terra`);
   - `pnpm eval:routing:live:anthropic` with `UNFILED_ROUTING_EVAL_ANTHROPIC_API_KEY` (optional
     `UNFILED_ROUTING_EVAL_ANTHROPIC_MODEL`, default `claude-sonnet-5`).

   Set `UNFILED_ROUTING_EVAL_REPORT_PATH` to a new `.json` path under `docs/eval-reports/`. Each
   runner executes exactly three samples per eligible synthetic case and emits only content-free
   telemetry with pinned list prices (OpenAI luna $0.20/$1.20, terra $2/$12, sol $4/$20 per MTok;
   Claude sonnet-5 $2/$10, opus-5 $5/$25 per MTok, cache reads 10% of input). Commit the dated
   reviewed reports and require every eligible case to pass all three samples. **No credentialed live
   run has been executed yet.** Revoke the evaluation keys afterwards.

3. **Provider-key entry through the UI.** In the Production Supabase project confirm Vault is enabled.
   Run the PostgreSQL privilege probe and the deployed REST exposure probe: browser/native, `anon`,
   `authenticated`, worker, verifier, organizer, and search must have no provider-key table, Vault
   table/view/function, or arbitrary secret access; `service_role` requests with `Accept-Profile:
vault` and `Content-Profile: vault` must be rejected. Then, on a synthetic account, enter one
   low-value OpenAI key and one low-value Anthropic key only into the masked authenticated settings
   form. Web validates OpenAI against `https://api.openai.com/v1/models/gpt-5.6-terra` and Anthropic
   against `https://api.anthropic.com/v1/models?limit=1` (`x-api-key`,
   `anthropic-version: 2023-06-01`); a deliberately invalid key must store nothing. A valid write
   returns only provider, status, last-four, validation time, and credential revision. Provider-key
   GET requires exactly one `provider` query parameter, and web treats a provider-mismatched database
   response as an integrity failure. Repeat the exact PUT after an ambiguous response and prove the
   transient replay comparison; replace a key and prove the superseded Vault secret is destroyed
   atomically; delete a key and prove deletion of one provider leaves the other intact.
4. **Settings hierarchy.** Prove provider → model → effort validation on web and iOS: app-default
   mode is unavailable as a new choice (no managed fallback in the free beta), BYOK requires exactly
   one provider, OpenAI accepts only Automatic or an OpenAI registry-v2 model, Anthropic only
   Automatic or a Claude registry-v2 model, and unknown/cross-provider models, unsupported effort,
   extra keys, and stale revisions fail closed. iOS implements the same catalog through a
   build-configuration flag whose name is recorded in `FINAL_REPORT.md`.
5. **Job snapshot and lease binding.** Queue one synthetic BYOK job per provider and inspect
   application tables through an administrative schema-only query: the immutable snapshot may
   contain provider, model preference, resolved model ID, effort, expansion, settings revision, and
   registry version but no key, Vault secret ID, header, ciphertext, or key record. A wrong owner,
   caller-selected provider/Vault ID, missing/expired/stolen lease, private capture, deleted capture,
   or invalid credential must not resolve a secret. Hold a queued job before resolution, delete its
   key, release the job: it must make no provider call and land in Inbox with `provider_key_invalid`.
6. **Canary.** Seed a unique canary key per provider and run settings put/status/delete, one leased
   provider call, invalid-key handling, export, and account deletion. Search Vercel, Supabase,
   provider diagnostics, error sinks, traces, jobs, HTTP responses, exports, content envelopes, and
   backup-visible tables for the canary; require zero hits. Confirm live Vault destruction and
   document separately when infrastructure backups containing the old secret age out.
7. **Retention posture.** OpenAI Responses requests set `store: false`; that is not a Zero Data
   Retention guarantee, and default abuse-monitoring logs may retain content for up to 30 days.
   Anthropic Messages requests are subject to Anthropic's API data-retention terms. Because keys are
   the user's own, the product copy and `/privacy` route must state that AI-assisted content is sent
   to the provider the user selected under that provider's terms.
8. **Optional operator OpenAI key (not in the free beta).** A future funded deployment may set
   `UNFILED_ORGANIZER_OPENAI_API_KEY` from a dedicated OpenAI project restricted to the registry-v2
   models and `UNFILED_MANAGED_AI_FALLBACK_AVAILABLE=1` in web. It funds only OpenAI app-default
   routing and explicitly snapshotted fallback; there is no app-funded Claude credential. Do not set
   either variable in the free beta.

Official references: [OpenAI project service-account keys](https://developers.openai.com/api/reference/typescript/resources/admin/subresources/organization/subresources/projects/subresources/service_accounts/subresources/api_keys/methods/create), [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), [Claude effort controls](https://platform.claude.com/docs/en/build-with-claude/effort), and [Claude model IDs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).

## Milestone E owner-interaction gates

The accepted contracts are [ADR-0011](./docs/decisions/ADR-0011-encrypted-owner-interactions-and-personal-rules.md),
[ADR-0012](./docs/decisions/ADR-0012-vault-only-lease-bound-byok-credentials.md), and
[ADR-0015](./docs/decisions/ADR-0015-user-selectable-provider-model-effort.md). Migrations
`20260901000001` through `20260901000005` implement the interaction foundation, corrections, routing
rules, generated blocks/duplicate suggestions, and Vault-only settings; `20260902000001` adds
dual-provider model selection. Their credential-free evidence is recorded in `docs/BUILD_PLAN.md` and
`docs/OPERATIONS_TEST_PLAN.md`. Before non-synthetic use:

1. Verify the remote database applied the E0–E4 migrations and the two `20260902` migrations in
   order and that no parallel change reused a timestamp or renamed a public RPC.
2. With two synthetic owners, run correction, Review resolution, and batch-undo races. Record
   content-free evidence that commits lock note IDs in ascending order, validate every
   note/revision/reservation/MAC before writing, and publish nothing when the exact inverse is unsafe.
3. Create an explicit routing rule and a repeated-correction proposal. Prove the condition/alias is
   private-manual ciphertext everywhere durable and absent from organizer/provider requests, jobs,
   Realtime, logs, and telemetry; the organizer receives only rule ID, revision, destination
   kind/ID, priority, and match result.
4. Return a unique synthetic generated expansion from each provider. Prove it is a separately
   encrypted `proposed` block with an encrypted pending-expansion Review, stable across response-loss
   replay, and that accept/reject never modifies the note body, structured data, or revision. Prove
   duplicate suggestions are non-destructive (`Keep both` and `Dismiss` only).
5. Exercise the encrypted-retention capability in dry-run and execute modes for rejected blocks.

## Global encrypted-storage contract — deferred one-way operation

Migration `20260830000027_encrypted_storage_contract.sql` installs the readiness, state, receipt, and
operator apply functions without removing the rollback schema. Applying the contract is separate and
irreversible. **It remains blocked for the free beta**: step 2 below requires a pre-cutover PITR point
restored to an isolated project, which the free plan cannot provide. The database stays
`expand_compatible`; all live writes remain encrypted and fail closed; the retained rollback columns
must contain only their fixed non-content sentinel. Record this state explicitly in `FINAL_REPORT.md`
and do not describe the beta library as contracted.

When the paid gate is funded:

1. Prove every manual CRUD, taxonomy, history/undo, capture, search, export, deletion, and retention
   operation succeeds through its encrypted adapter with the contract state `expand_compatible`.
2. Pause signups, writes, drains, maintenance, and retention. Record deployment IDs and the migration
   checksum. Create the pre-cutover backup/PITR point, restore it to an isolated scratch project with
   separately restored authorized roots, and complete the parity drill.
3. Bring every owner to `encrypted_only` through the official rollout APIs.
4. In a verified database-owner session (`session_user = current_user`), inspect
   `private.encrypted_storage_contract_readiness()` and require `ready=true`, `applied=false`,
   `uncoveredOwnerCount=0`, zero open work, and a 64-character `readinessDigest`.
5. In one transaction, recompute the digest and call
   `private.apply_encrypted_storage_contract('CONTRACT UNFILED ENCRYPTED STORAGE V1', :'readiness_digest')`;
   inspect catalog/ACL postconditions before committing; roll back on any mismatch.
6. Resume a small canary cohort, search every sink for synthetic canaries, and track every
   pre-contract backup through expiry. Until no retained copy contains the old contract, copy may say
   only that the live store is application-encrypted.

## Hosted release evidence — single Production deployment, synthetic accounts

There is no Preview deployment. Run these checks against `https://unfiled-web.vercel.app` with
synthetic accounts only, after the Deployment Protection change above.

1. Request an OTP and verify the 60-second resend cooldown is shown, survives a validation error,
   and reaches zero without enabling early resend.
2. Verify sign-in, refresh after a full browser restart, sign-out, and direct navigation to an
   authenticated route after sign-out.
3. On a physical iPhone build, sign in and relaunch to verify the session survives in Keychain. Sign
   out once online and once in airplane mode; both must return to signed-out immediately, and the
   offline attempt must show the remote-revocation warning.
4. Create and edit all five note types; exercise checklists, log fields, spaces, tags, links,
   archive/delete/restore, revision restore, search (lexical and explicit AI-assisted), and Review
   states.
5. Open one note in two tabs, save the first, and verify the second receives `stale_revision`.
6. Undo a newly created note and undo that undo; verify revisions and identical content.
7. Save an OpenAI key and a Claude key on the synthetic account, switch provider and model, and
   confirm the incompatible model resets to Automatic without deleting either key.
8. Record browser screenshots at 390 px, 768 px, 1280 px, and 1536 px; include keyboard-only focus
   traversal, 200% zoom, reduced motion, and a screen-reader smoke.
9. Verify `/privacy`, `/terms`, `/security`, `/support`, `/account-deletion`, and
   `/.well-known/security.txt` resolve from the exact deployment and state the BYOK, local-hash, and
   non-E2EE limitations.

### Cloud canary-log audit

1. Generate a unique synthetic marker, put it only in a synthetic account's private note, and record
   its hash separately.
2. Exercise the flows that may emit application, Vercel function, Supabase API/database, and
   error-monitoring logs, including one AI-assisted capture per provider with a canary key.
3. Search every configured sink for the marker, common bearer/refresh-token prefixes, and both
   providers' key prefixes. Require zero hits.
4. Record the query window, sinks inspected, result, reviewer, and deployment identifier. Any hit
   blocks promotion and starts the incident-response path.

### Performance smoke

1. Use the Production deployment with synthetic data and a cold browser profile. Record at least
   three runs each at desktop and mobile viewport sizes.
2. Capture LCP, INP, CLS, route-transition timing, and the manual note create/update/search API p95.
3. Run a 10 rps sustained `/api/v1/captures` smoke that asserts zero lost or duplicated captures and
   records p95 durable-acceptance latency, using only synthetic content.
4. Attach traces or HAR files to the release evidence without authorization headers, cookies, note
   bodies, or provider keys.

## Deferred paid hardening (not required for the free beta)

None of the following is applied, required, or claimed for the free private beta. Each is preserved
in the repository so a funded deployment can adopt it without changing envelope formats, key
classes, or RPC allowlists.

### AWS KMS, Terraform, OIDC-to-AWS, and CloudTrail

`infra/aws-kms` defines exact environment identities for web, worker, verifier, organizer, and
search plus four independently controlled KMS roots. Selecting `UNFILED_KEY_CUSTODIAN=aws-kms`
replaces the Vercel Sensitive ring with `UNFILED_AWS_REGION`, per-workload role ARNs
(`UNFILED_AWS_ROLE_ARN` or `UNFILED_SEARCH_AWS_ROLE_ARN`), full key ARNs
(`UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN`, `UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN`,
`UNFILED_SEARCH_AI_OBJECT_WRAP_KMS_KEY_ARN`), retired-ARN lists
(`UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`, `UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`,
`UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOTS_JSON`,
`UNFILED_SEARCH_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON`), the web `UNFILED_WEB_ROOT_KEY_REGISTRY_JSON`,
and exact `*_EXPECTED_OIDC_SUBJECT` values. If funded:

1. Record AWS account and region, two distinct non-runtime administrator/recovery principal ARNs,
   and the Vercel team slug/ID and project names/IDs. Project names, not IDs, appear in OIDC subjects.
2. Instantiate `infra/aws-kms` with locked Terraform state for
   `deployment_environment = "production"`. Run `terraform init`,
   `terraform fmt -check -recursive`, `terraform validate`, `terraform test`,
   `terraform plan -out production-unfiled-kms.tfplan`, and apply only the reviewed plan. Confirm five subjects ending in `production` and four aliases
   (`alias/unfiled/ai-assisted/object-wrap`, `alias/unfiled/ai-assisted/content-mac`,
   `alias/unfiled/private-manual/object-wrap`, `alias/unfiled/private-manual/content-mac`).
3. Copy only each stack's non-secret outputs into the matching project; never give worker,
   verifier, or search the content-MAC ARN or a private-manual ARN.
4. Prove with each real workload identity that STS assumes only the exact role and that
   GenerateDataKey/Decrypt succeed only on the permitted roots; run `runKeyCustodyProbe` and match
   allowed and denied calls to CloudTrail management events (KMS operations are management events).
5. Configure a CloudTrail trail retaining read and write management events that does not exclude
   KMS events, and alert on access denials, unusual volume, key disable/deletion scheduling, and
   private-root attempts by isolated workloads.
6. Follow `infra/aws-kms/README.md` for the staged → active/retired two-apply rotation and complete
   KMS outage, rewrap, restored-backup, and backup-expiry drills before advancing any owner.

### Paid Supabase hardening

Separate remote Preview/Production projects, PITR, an isolated restore project, and the
encrypted-storage contraction gate above. Until funded, do not claim PITR, isolated recovery, or a
contracted library.

### Vercel Pro deployment protection

Trusted Sources, password protection, IP allowlists, and one-minute cron schedules. Until funded,
the app-level OIDC verifier is the only caller control for the isolated services, and the daily
Hobby schedules apply.

### Provider (semantic) embeddings

`UNFILED_WORKER_EMBEDDING_PROVIDER=openai`, `UNFILED_SEARCH_EMBEDDING_PROVIDER=openai`, and
`UNFILED_ORGANIZER_EMBEDDING_PROVIDER=openai` with a dedicated `UNFILED_OPENAI_EMBEDDING_API_KEY` /
`UNFILED_SEARCH_OPENAI_API_KEY`, `UNFILED_EMBEDDING_MODEL_ID=text-embedding-3-small`, and
`UNFILED_EMBEDDING_DIMENSIONS=1536` require a new index generation, a provider data-control review,
and a funded application key. They send AI-assisted note projection text to OpenAI and are not
enabled in the free beta.

## Apple signing, archive, and physical-device evidence

The canonical phone implementation is `apps/ios`: a SwiftUI application plus a WidgetKit Lock Screen extension whose button invokes an App Intent. XcodeGen owns the generated project, and GRDB links its SQLCipher build through Swift Package Manager. Simulator compilation and tests do not require an Apple Developer account; every remaining step in this section is human-owned release evidence.

1. Enroll in the Apple Developer Program before attempting a signed device build or archive.
2. Register the explicit main and widget-extension App IDs, then register and attach the matching App Group to both IDs for every build environment:

   | Environment | Main App ID                           | Widget extension App ID                            | App Group                                   | URL scheme        |
   | ----------- | ------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ----------------- |
   | Development | `com.zachshotamartin.unfiled.dev`     | `com.zachshotamartin.unfiled.dev.quickcapture`     | `group.com.zachshotamartin.unfiled.dev`     | `unfiled-dev`     |
   | Preview     | `com.zachshotamartin.unfiled.preview` | `com.zachshotamartin.unfiled.preview.quickcapture` | `group.com.zachshotamartin.unfiled.preview` | `unfiled-preview` |
   | Production  | `com.zachshotamartin.unfiled`         | `com.zachshotamartin.unfiled.quickcapture`         | `group.com.zachshotamartin.unfiled`         | `unfiled`         |

3. Keep `DEVELOPMENT_TEAM` empty in the shared base configuration. For local signing, select the registered team in Xcode or pass the team identifier only in the trusted build invocation. Xcode's automatic signing must produce profiles whose main-app and widget entitlements both contain the exact App Group for that environment.
4. Regenerate and verify the unsigned simulator project from the repository root. CI must run this same class of build with code signing disabled; it is not signing evidence:

   ```bash
   pnpm ios:ci
   ```

   The script selects an available iPhone Simulator. To pin one, set `UNFILED_IOS_TEST_DESTINATION` to an iOS 17-or-newer destination and record it with the evidence. A generated-project diff after clean generation must be reviewed like any other source change.

5. After the identifiers, App Groups, and the Production web deployment exist, create a signed Preview-scheme build for a physical iPhone pointed at the reachable HTTPS `/api/v1` origin. Supplying a team ID and allowing Xcode to update provisioning is an explicit trusted-machine action. Do not use the Development build for online device evidence: its loopback origin points back to the phone.

   ```bash
   xcodebuild \
     -project apps/ios/Unfiled.xcodeproj \
     -scheme "Unfiled Preview" \
     -configuration Preview \
     -destination 'generic/platform=iOS' \
     DEVELOPMENT_TEAM='<APPLE_TEAM_ID>' \
     -allowProvisioningUpdates \
     build
   ```

6. Install on a physical iPhone running iOS 17 or newer and execute the full device matrix in `docs/BUILD_PLAN.md` section 0.11. Repeat the relevant checks on the oldest supported iOS release and the current release before submission.
7. Create the Production archive only on a trusted signing machine, then inspect the archive before upload:

   ```bash
   xcodebuild \
     -project apps/ios/Unfiled.xcodeproj \
     -scheme Unfiled \
     -configuration Release \
     -destination 'generic/platform=iOS' \
     -archivePath "$PWD/build/Unfiled.xcarchive" \
     DEVELOPMENT_TEAM='<APPLE_TEAM_ID>' \
     -allowProvisioningUpdates \
     archive
   ```

   Confirm the archive embeds and signs exactly one `QuickCaptureWidget.appex`; the containing app and extension must have the expected Production application identifiers and the same Production App Group entitlement. Confirm the managed-fallback build flag is off in the Release configuration. An unsigned simulator artifact cannot satisfy this gate.

8. On a physical iPhone, complete this durable-capture matrix with a synthetic non-sensitive canary:
   - submit in airplane mode, force-quit immediately after `Saved`, relaunch while still offline, then reconnect and verify one server capture and one receipt;
   - lose the network response after server acceptance, force-quit, relaunch, and verify replay returns the original capture/job rather than duplicating either;
   - expire the session, capture offline, verify `Waiting for sign-in`, sign in once, and verify automatic one-time sync;
   - tap both supported Lock Screen widget families and verify the App Intent opens a blank capture in Unfiled with the keyboard ready; the widget itself must never claim to accept free-form text in place;
   - inspect the App Group container and widget snapshot. They may contain the schema version, pending count, and transient random intent nonce only—never capture text, note text, tokens, destinations, or receipts;
   - queue a retry, background and lock the phone, and verify the foreground retry lifecycle stops; after unlocking and making the app active, verify it resumes and syncs exactly once;
   - while locked, verify the session/database Keychain items and completely protected database file are unavailable to the app; after unlocking, verify the same database opens without replacement or data loss;
   - delete a synced capture, relaunch offline and online, and verify no local ghost row or plaintext artifact reappears;
   - save an OpenAI key and a Claude key in Settings, switch provider/model/effort, and verify the pasted key is never persisted in preferences, SQLCipher, analytics, or crash reports.
9. Verify the local database is actually using SQLCipher through GRDB. Record `PRAGMA cipher_version`, the app build identifier, device/iOS version, and pass/fail evidence without recording the canary text or database key. Confirm the database is unreadable without its device Keychain key. Uninstall intentionally deletes the application container, SQLCipher database, drafts, and unsynced outbox; Keychain survival is an OS behavior and is not a recovery mechanism. After reinstall and sign-in, synced server content may rehydrate into a new local database, but an unsynced capture is not recoverable. A missing cipher version, readable database without the Keychain key, duplicate capture, or Lock Screen content exposure blocks release.
10. Create the App Store Connect record and complete the privacy manifest review, privacy and encryption/export-compliance disclosures, screenshots, support URL, deletion URL, TestFlight checks, and release notes before submission. The App Store privacy answers must disclose that AI-assisted content is sent to the user's chosen provider with the user's own key. No Android store work is in scope for this milestone.

## GitHub protection

Completed on 2026-08-30 after the repository became public. `main` requires the strict aggregate
`CI` status, applies the rule to administrators, and rejects force-pushes and branch deletion. Keep
that aggregate job as the stable required-check name when CI lanes change.
