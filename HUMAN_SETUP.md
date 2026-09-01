# Human Setup

This file contains only steps that require a human account, physical device, paid service, security decision, or visual usability judgment. The implementation and automated tests do not depend on completing these steps.

## Completed during bootstrap

- GitHub CLI authenticated as `Zachshotamartin`.
- Public repository created at `https://github.com/Zachshotamartin/unfiled`.
- Product, GitHub repository, and local project root renamed to `unfiled`.
- `main` branch protection enabled with strict `CI`, admin enforcement, and force-push/deletion
  protection.

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

## Supabase cloud

1. Create separate preview and production projects at Supabase.
2. Enable Vault and confirm the project plan supports the required backup and point-in-time recovery targets.
3. Store each project URL, anonymous key, service-role key, and database password only in the matching interactive web/API Vercel environment. The isolated `apps/worker`, `apps/verifier`, and `apps/organizer` projects must never receive a global Supabase service-role/secret key; their narrowly scoped C.5c database credentials are provisioned separately below.
4. Link preview from a trusted shell: `pnpm supabase link --project-ref <preview-project-ref>`.
5. Review migrations, then apply: `pnpm supabase db push --linked`.
6. Never link a developer preview deployment to production data.

## Vercel

1. Import `Zachshotamartin/unfiled` into Vercel and set the root directory to `apps/web`.
2. In the `apps/web` project, set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and provider application keys in the appropriate environment scopes. Do not copy the service-role key into the separate worker, verifier, or organizer project.
3. Generate a separate OTP rate-limit pepper for each deployed environment with
   `openssl rand -hex 32`. Add it with `vercel env add AUTH_RATE_LIMIT_PEPPER preview` and
   `vercel env add AUTH_RATE_LIMIT_PEPPER production`; never reuse a provider, Supabase, or cron
   secret. Production OTP requests intentionally fail closed when either this pepper or the service
   role key is absent. Separately generate a private-search cursor key for each environment with
   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`, then add it with
   `vercel env add UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY preview` and
   `vercel env add UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY production`. Never prefix it with
   `NEXT_PUBLIC_` or reuse any content, auth, provider, or cron key. Private search fails closed
   when this exact 32-byte base64url key is absent or malformed.
4. Set `NEXT_PUBLIC_SITE_URL` to the canonical origin for each scope, including `https://` and excluding a trailing slash. Use the stable preview alias for Preview and the cleared custom domain for Production; local development falls back to `http://localhost:3000`.
5. Generate a dedicated cron secret with `openssl rand -base64 48`, then run
   `vercel env add CRON_SECRET production` and paste that value. Do not reuse a Supabase or provider
   key. Set `NOTE_RETENTION_EXECUTION_ENABLED=false` in Production before the first deployment.
6. Keep preview and production values separate.
7. Deploy with `apps/web/vercel.json`. It schedules
   `/api/internal/retention/notes` daily at 03:17 UTC, but the route remains a dry run while the
   execution gate is false or absent. Confirm the first Vercel Cron response has `dryRun: true`,
   `executionEnabled: false`, `purgedCount: 0`, and a plausible `eligibleCount`.
8. Independently inspect the protected dry run before activation. In a trusted shell, set a
   temporary `UNFILED_RETENTION_CRON_SECRET` variable to the value from step 5, then run:

   ```bash
   curl --fail-with-body \
     -H "Authorization: Bearer $UNFILED_RETENTION_CRON_SECRET" \
     "https://YOUR_PRODUCTION_DOMAIN/api/internal/retention/notes?dryRun=true"
   ```

   Never paste the secret into shell history or issue trackers. Verify the response still reports
   zero purges and compare `eligibleCount` with the number of notes deleted at least 30 days ago.

9. Only after reviewing that dry run and approving permanent deletion under the published 30-day
   policy, explicitly change `NOTE_RETENTION_EXECUTION_ENABLED` to `true` in Vercel Production and
   redeploy. The `dryRun=true` URL remains non-destructive after activation. Alert on any cron
   failure or `batchLimitReached: true`; disable execution by setting the gate back to `false` while
   investigating.
10. Run the recorded smoke checks against the preview URL before promoting.
11. Add a custom domain only after name clearance.

### Capture encryption and durable workflow

1. Generate independent local or Preview-only content and private-search cursor keys in a trusted terminal. Run the command three times and place each result directly into a password manager; do not paste any value into an issue, chat, commit, or shell argument:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. For local development, add these server-only values to `apps/web/.env.local`:

   ```dotenv
   UNFILED_CONTENT_KEK_ID=local-content-kek-v1
   UNFILED_CONTENT_KEK=<first-independent-base64url-value>
   UNFILED_CONTENT_FINGERPRINT_KEY=<second-independent-base64url-value>
   UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY=<third-independent-base64url-value>
   CRON_SECRET=<at-least-32-random-characters>
   ```

   The fingerprint key must remain stable through ordinary wrapping-key rotations. Never reuse it as the KEK. `UNFILED_CONTENT_RETIRED_KEKS` is only for a bounded, audited rewrap window and must not become an indefinite archive of old keys.

3. Add independent Preview values interactively with `vercel env add UNFILED_CONTENT_KEK_ID preview`, `vercel env add UNFILED_CONTENT_KEK preview`, `vercel env add UNFILED_CONTENT_FINGERPRINT_KEY preview`, `vercel env add UNFILED_PRIVATE_SEARCH_CURSOR_HMAC_KEY preview`, and `vercel env add CRON_SECRET preview`. Interactive entry keeps values out of shell history. The environment-backed resolver is restricted to local and isolated Preview data.
4. Do not launch Production capture storage with a root KEK in Vercel environment variables. C.5a now checks in the AWS KMS resolver, least-privilege identities, Terraform policies, and rotation contract, and C.5b–d implement the complete encrypted note path. Production remains blocked until the account-bound evidence below passes and the explicit C.5d production contract is applied through its separate runbook.
5. Migration `20260830000012_durable_capture_workflow.sql` deliberately aborts with `legacy_capture_encryption_backfill_required` if an older environment contains capture text. For disposable Preview data, recreate the project. For data that must be retained, stop writes and use the audited backfill/verification tool delivered with the production key adapter; never edit the migration to discard or relabel plaintext.
6. The checked-in Vercel Hobby schedule calls `/api/internal/captures/drain` daily at 03:07 UTC. In Production, Preview, and development, `after()` and this recovery route make one content-free Trusted Sources call to the isolated organizer; they never run the organizer inside `apps/web` and never chain the organizer's 49-second budget to the index worker's 55-second budget. The encrypted organizer and index queues plus their separate authenticated recovery crons are authoritative. Deterministic organization exists only as an explicitly injected test fixture. On Vercel Pro or Enterprise, change only that capture schedule in `apps/web/vercel.json` to `* * * * *`, deploy, and confirm authenticated one-minute invocations. Hobby deployments reject schedules more frequent than daily.
7. After deploying Preview, create one synthetic canary capture and inspect it only through the owner-authorized encrypted projection. Before the global contract, any temporary rollback column must contain only its fixed non-content sentinel; after the contract, prove that column no longer exists. In both states the canary must have an authenticated version-1 ciphertext envelope and keyed verification metadata and must have zero hits in rows, indexes, logs, traces, analytics, or URLs. Public API responses may return plaintext only after owner authorization and must never return an envelope, MAC/fingerprint, reservation, or key identifier.

### Production managed KMS and four isolated workloads — C.5 account evidence pending

The checked-in module at `infra/aws-kms` defines the exact production identities for web, index worker, verifier, and organizer plus four independently controlled KMS roots. These steps create billable, account-bound cloud resources. They do **not** authorize real note traffic yet: the C.5d paths and contract are implemented locally, but the production account evidence, owner rollout, explicit contraction, and post-contract canary below must still pass.

1. Record twelve exact values: AWS region; a dedicated non-runtime KMS administrator role/user ARN;
   Vercel team slug and `team_...` owner ID; and the distinct project **name** plus `prj_...` ID
   for web, worker, verifier, and organizer. Project names—not IDs—appear in OIDC subjects.
2. Create or select four Vercel projects from this repository. Set their Root Directories to
   `apps/web`, `apps/worker`, `apps/verifier`, and `apps/organizer`. In all four projects, enable **Team Issuer** under
   Settings → Security → Secure Backend Access (OIDC). Configure **Trusted Sources** separately on
   the worker, verifier, and organizer projects: authorize only web Production → that project's Production
   deployment. Do not authorize Preview, isolated-workload cross-calls, another project, or a team/project
   wildcard.
3. From `infra/aws-kms`, copy `terraform.tfvars.example` to the ignored `terraform.tfvars`, replace every placeholder, and authenticate Terraform with an administrator identity. If the team's Vercel issuer already exists in that AWS account, use the import command in `infra/aws-kms/README.md` instead of creating a duplicate.
4. Run `terraform init`, `terraform fmt -check -recursive`, `terraform validate`, `terraform test`, `terraform plan -out unfiled-kms.tfplan`, and finally `terraform apply unfiled-kms.tfplan`. Confirm the plan creates four exact-subject runtime roles and these four aliases:
   - `alias/unfiled/ai-assisted/object-wrap`
   - `alias/unfiled/ai-assisted/content-mac`
   - `alias/unfiled/private-manual/object-wrap`
   - `alias/unfiled/private-manual/content-mac`
5. Copy only Terraform's non-secret outputs into Vercel Production settings. All four projects
   receive `UNFILED_AWS_REGION`; each receives its matching `UNFILED_AWS_ROLE_ARN`. Web receives
   both active AI root ARNs. The worker and verifier receive only
   `UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN`: never give either isolated workload the AI content-MAC
   ARN or a broad AI registry. The organizer receives the active AI object-wrap and content-MAC
   ARNs plus only its exact retired-root outputs; it never receives a private-manual ARN or the full
   web registry. Only web receives the
   two active `UNFILED_PRIVATE_*_KMS_KEY_ARN` values and the complete web registry. In the worker set
   all of:

   ```dotenv
   UNFILED_WORKER_ENV=production
   UNFILED_WORKER_PROJECT_ID=<worker-prj-id>
   UNFILED_WORKER_EXPECTED_OIDC_SUBJECT=<terraform-worker_oidc_subject>
   UNFILED_TRUSTED_SOURCE_TEAM_SLUG=<exact-team-slug>
   UNFILED_TRUSTED_SOURCE_OWNER_ID=<team-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web-prj-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=<exact-web-project-name>
   UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=<terraform-web_oidc_subject>
   ```

   Set `UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON` only to the literal result of
   `terraform output -raw worker_retired_ai_object_wrap_roots_json` (initially `[]`); never hand-convert
   the broader registry. In the verifier set all of:

   ```dotenv
   UNFILED_VERIFIER_ENV=production
   UNFILED_VERIFIER_PROJECT_ID=<verifier-prj-id>
   UNFILED_VERIFIER_EXPECTED_OIDC_SUBJECT=<terraform-verifier_oidc_subject>
   UNFILED_TRUSTED_SOURCE_TEAM_SLUG=<exact-team-slug>
   UNFILED_TRUSTED_SOURCE_OWNER_ID=<team-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web-prj-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=<exact-web-project-name>
   UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=<terraform-web_oidc_subject>
   UNFILED_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON=<terraform-verifier-retired-output>
   ```

   Set the last value only to the literal result of
   `terraform output -raw verifier_retired_ai_object_wrap_roots_json` (initially `[]`). Vercel
   injects `VERCEL_ENV` and `VERCEL_PROJECT_ID`; do not override them. In the organizer set all of:

   ```dotenv
   UNFILED_ORGANIZER_ENV=production
   UNFILED_ORGANIZER_PROJECT_ID=<organizer-prj-id>
   UNFILED_ORGANIZER_EXPECTED_OIDC_SUBJECT=<terraform-organizer_oidc_subject>
   UNFILED_AI_OBJECT_WRAP_KMS_KEY_ARN=<active-ai-object-wrap-full-key-arn>
   UNFILED_AI_CONTENT_MAC_KMS_KEY_ARN=<active-ai-content-mac-full-key-arn>
   UNFILED_ORGANIZER_RETIRED_AI_OBJECT_WRAP_ROOTS_JSON=<terraform-organizer-object-wrap-retired-output>
   UNFILED_ORGANIZER_RETIRED_AI_CONTENT_MAC_ROOTS_JSON=<terraform-organizer-content-mac-retired-output>
   UNFILED_TRUSTED_SOURCE_TEAM_SLUG=<exact-team-slug>
   UNFILED_TRUSTED_SOURCE_OWNER_ID=<team-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_ID=<web-prj-id>
   UNFILED_TRUSTED_SOURCE_WEB_PROJECT_NAME=<exact-web-project-name>
   UNFILED_TRUSTED_SOURCE_EXPECTED_OIDC_SUBJECT=<terraform-web_oidc_subject>
   UNFILED_ORGANIZER_TIMEOUT_MS=49000
   ```

   Copy the two organizer retired values only from
   `terraform output -raw organizer_retired_ai_object_wrap_roots_json` and
   `terraform output -raw organizer_retired_ai_content_mac_roots_json`. Never hand-convert the
   broader registry. Never configure AWS access
   keys, a root KEK, a private KMS identifier, a user/browser session secret, `CRON_SECRET`, the
   local drain bearer, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, or another global
   Supabase service/secret variant in any isolated project. The worker and verifier must also reject
   every AI content-MAC identifier. All three reject provider API keys at this checkpoint; Milestone
   D must add any evaluated planner credential only to the organizer's separately reviewed provider
   boundary, never to web, worker, or verifier.

6. Deploy the worker, verifier, and organizer first, but do not make an OIDC-bearing call to any one yet. The
   runtime cannot cryptographically derive a Vercel project ID from a `*.vercel.app` alias, so each
   exact origin is a sensitive bearer-token egress trust boundary. In Vercel's authenticated
   dashboard or REST API, select each project by its recorded `prj_...` ID and prove that the
   intended exact Production alias is attached to that project and its current Production
   deployment. Cross-check each alias through the authenticated alias/deployment view, and record
   only the team ID, project ID, exact alias, Production deployment ID, and commit—not an access
   token or OIDC token. Public DNS, TLS, or an unauthenticated HTTP response does not prove the
   Vercel project mapping. Alias drift, project transfer, or alias reassignment invalidates this
   evidence and requires the corresponding caller to be disabled until the proof is repeated.

   Only after all three proofs, set these target values in the web Production project and deploy web:

   ```dotenv
   UNFILED_INDEX_WORKER_ORIGIN=https://<proved-worker-production-alias>.vercel.app
   UNFILED_RAG_VERIFIER_ORIGIN=https://<proved-verifier-production-alias>.vercel.app
   UNFILED_ORGANIZER_ORIGIN=https://<proved-organizer-production-alias>.vercel.app
   ```

   Do not configure `UNFILED_INDEX_WORKER_PROJECT_ID`: an unverified project-ID string beside an
   alias does not bind them. The web client obtains its short-lived OIDC token at invocation time;
   do not add a shared caller secret, worker bearer, bypass secret, user token, or worker workload
   token to the web project.

   Do not invoke any protected workload yet. Production composition intentionally fails closed
   until the worker has its dedicated database/provider configuration and both verifier and organizer
   have their dedicated database configuration. Alias proof establishes only the OIDC-token egress target; it
   is not runtime, database, provider, or KMS readiness evidence. Complete the three dedicated-login
   sections below before making a real protected call.

7. Configure a CloudTrail trail that retains read and write **management events** and does not
   exclude KMS events. KMS cryptographic operations are management events, not CloudTrail data
   events. Encryption-context values are logged, so they must remain the four non-secret
   owner/class/purpose/key-record identifiers and must never contain note text or email addresses.
   Add alerting for access denials, unusual KMS volume, key disable/deletion scheduling, and worker,
   verifier, or organizer attempts against private-manual roots.
8. After the complete worker, verifier, and organizer readiness/custody proofs below, follow
   `infra/aws-kms/README.md` for the staged → active/retired two-apply rotation. A 21st
   runtime-decryptable retired generation is intentionally blocked until a separately reviewed
   archived-root lifecycle exists. Complete and record KMS outage, intermediate/root rewrap,
   restored-backup, and pre-cutover-backup-expiry drills before advancing any owner to
   `encrypted_only` or `contracted`. For each root rewrap, the interactive/admin service first
   verifies the KMS `ReEncrypt` result names the intended active full key ARN, then calls the
   service-only `rewrap_user_content_key` RPC with the expected old ARN and current rewrap count.
   Record that one call updates ciphertext, new/previous ARN, count, and server timestamp together;
   an exact retry reports replay; a changed ciphertext or stale ARN/count fails; and the dedicated
   worker role cannot execute the RPC. Do not update those columns directly.

### Dedicated production worker database login — provision with C.5c, not before

`supabase/roles.sql` and migration `20260830000015_encrypted_library_expansion.sql` create the exact
PostgreSQL role `unfiled_index_worker`, but deliberately leave it `NOLOGIN`, `NOINHERIT`,
`NOBYPASSRLS`, and without a password. It has no relation or sequence privileges, no access to the
`private` schema, no workload-usable role membership, and no executable public functions except the six RAG capabilities listed in
[ADR-0007](./docs/decisions/ADR-0007-dedicated-worker-database-capability-and-root-rewrap.md).
The C.5c adapter is implemented and remains disabled unless its complete dedicated configuration is
present. Complete these steps only after its pull request is merged and before enabling production
index jobs:

1. In the Supabase dashboard, enable database SSL enforcement and download/record the current CA
   chain and the serverless **transaction pooler** connection information for the production
   project. The C.5c driver must disable prepared statements if its PostgreSQL library requires that
   for transaction pooling. It must perform certificate and hostname verification equivalent to
   `sslmode=verify-full`; `sslmode=disable`, `rejectUnauthorized: false`, and encryption without
   certificate/hostname verification are release blockers.
2. Apply `supabase/roles.sql` with the migrations (`supabase db push --include-roles` for the
   reviewed CLI release). The role guards accept either zero membership rows or PostgreSQL 17's
   single automatic platform-management edge: granted role `unfiled_index_worker`, member
   `postgres`, grantor `supabase_admin`, `ADMIN=true`, `INHERIT=false`, `SET=false`. Reject any other
   inbound or outbound row. If Supabase support or another actual bootstrap-superuser path is
   available, remove that automatic edge and record the resulting zero-row proof; ordinary project
   `postgres` cannot remove a grant recorded by `supabase_admin`. Do not weaken the exact-shape guard
   or treat the edge as a workload login—`postgres` already owns and can replace the migrations and
   security-definer functions.

   Then open `psql` from a trusted administrator session over that verified TLS connection. Enable
   login and set a generated password without placing it in SQL text, shell history, a ticket, or
   this file:

   ```psql
   ALTER ROLE unfiled_index_worker LOGIN;
   \password unfiled_index_worker
   ```

   Let `\password` prompt interactively, save the generated value directly to the production
   password manager/Vercel secret flow, and close the administrator session. Never grant
   `service_role`, `authenticator`, another parent role, `INHERIT`, `BYPASSRLS`, `SUPERUSER`,
   `CREATEDB`, `CREATEROLE`, or `REPLICATION`.

3. Build the server-only URI from Supabase's displayed transaction-pooler template. For the shared
   Supavisor pooler, retain its required transport username shape
   `unfiled_index_worker.<project-ref>`; the suffix selects the Supabase tenant and does not change
   the PostgreSQL role reported after connection. Use the prompted custom-role password. Do not
   improvise the hostname, 20-character project ref, port, or CA. Add only that URI to the worker
   Production project as `UNFILED_WORKER_DATABASE_URL`, set the same canonical hostname as
   `UNFILED_WORKER_DATABASE_EXPECTED_HOST`, set the exact suffix separately as
   `UNFILED_WORKER_DATABASE_PROJECT_REF`, and base64-encode the downloaded canonical PEM chain into
   `UNFILED_WORKER_DATABASE_CA_PEM_BASE64`. The URI must contain `sslmode=verify-full`. A direct or
   dedicated-pooler `db.<project-ref>.supabase.co` URI uses the unsuffixed custom role; the worker
   derives and enforces the correct transport username for either endpoint class. These values
   must not use a client-exposed prefix and must not be copied to the web project, Preview, logs, CI,
   Terraform, or source control. Do not add
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, any framework-prefixed equivalent, or an
   RLS-bypassing database URL to the worker.
4. Create a server-only OpenAI project key restricted to the embedding workload and add it only to
   the worker Production project as `UNFILED_OPENAI_EMBEDDING_API_KEY`. Set the reviewed generation's
   exact model and dimensions as `UNFILED_EMBEDDING_MODEL_ID` and
   `UNFILED_EMBEDDING_DIMENSIONS` in both worker and web Production; the initial planned pair is
   `text-embedding-3-small` and `1536`. The worker rejects a job whose generation differs, and the
   web lifecycle controller uses the same pair to create shadow generations. Do not place the
   provider key in web, verifier, iOS, Preview, logs, source control, or a user preference. Confirm
   provider data controls and retention for the production project before allowing AI-assisted
   notes; private-manual notes remain categorically ineligible and must produce zero provider calls.
5. From the deployed C.5c adapter's database session, record a content-free readiness result proving
   `session_user = 'unfiled_index_worker'`. `SET ROLE unfiled_index_worker` is not acceptable:
   security-definer RPCs check the original connection identity. Confirm again that the role is not
   superuser, cannot bypass RLS, cannot inherit, and has no membership except the exact inert
   platform-management edge above. A connection for which the pooler reports another `session_user`
   fails closed and blocks rollout.
6. Run the deployed privilege probe. It must prove zero direct SELECT/INSERT/UPDATE/DELETE or sequence
   access across `public` and `private`, no `private` schema use, no public create, and EXECUTE on
   exactly: `claim_note_index_jobs`, `heartbeat_note_index_job`, `commit_note_rag_index`,
   `fail_note_index_job`, `recover_stale_note_index_jobs`, and `list_active_note_rag_index`. Direct
   note/key/RAG-table reads, key registration/activation/rewrap, generation creation/activation, and
   every other function must return permission denied. Record identifiers, SQLSTATE/outcome, and
   timestamps only—never rows, ciphertext, credentials, tokens, or note content.
7. From web Production, invoke the proved worker Production alias with one synthetic AI-assisted
   encrypted index job. Prove that Vercel preserves `x-vercel-trusted-oidc-idp-token` for the
   handler and exposes the workload token through the request context used by
   `@vercel/oidc-aws-credentials-provider`. The real short-lived worker identity must exchange
   through STS and complete GenerateDataKey plus Decrypt only on the active AI object-wrap root;
   the job must also complete through the exact database role and restricted embedding provider.
   Never print or return either raw token. Header presence, local JWT parsing, constructing a KMS
   client, or an HTTP health response without successful cryptographic calls is not evidence.
8. Execute `runKeyCustodyProbe` with the deployed worker identity and the AI content-MAC plus both
   private root ARNs supplied only to the controlled probe runner—not to worker environment
   configuration. The recorded report must have both denial-evidence fields equal to
   `"direct_kms"`, object-wrap generation/decryption success, denial on GenerateDataKey and Decrypt
   for AI content-MAC and both private purposes, wrong-context rejection, content-free events, and
   matching CloudTrail evidence.
9. Exercise lease loss, worker timeout, database/provider/KMS outage, pooler reconnect, response-loss
   replay, and credential revocation.
   Jobs must remain queued or recover through the bounded RPCs; no code may fall back to a global
   Supabase credential, direct table access, plaintext job payload, or private-manual key. Enable the
   drain only after these checks and the Vercel/AWS evidence above are green.
10. Inspect configuration only: confirm the web post-commit wake-up and
    `/api/internal/indexing/drain` recovery target the protected worker Production origin, and confirm
    `/api/internal/indexing/maintenance` is scheduled at 02:22 UTC with recovery at 03:27 UTC and
    contains only the proved worker/verifier origins. Do not claim or invoke the complete maintenance
    path until verifier step 6 below is green. [Vercel Hobby
    schedules](https://vercel.com/docs/cron-jobs/usage-and-pricing) are daily but may run at any point
    within the selected hour, so the separate hours preserve maintenance-before-recovery ordering;
    the minute values become exact only on Pro or Enterprise. A wake-up may be lost or rejected
    without losing work because the encrypted database queue is authoritative.
11. Rotate this credential independently of Supabase service keys. Drain/pause the worker, use the
    same trusted `psql` `\password unfiled_index_worker` prompt, update the Vercel Production secret,
    redeploy/recycle pooled connections, prove the old credential is rejected and the new session has
    the same exact allowlist, then resume. A database rebuild or replay of the role-creating migration
    returns it to `NOLOGIN`; repeat the explicit provisioning/probe instead of weakening the migration.

### Dedicated generation-verifier database login — provision separately

`supabase/roles.sql`, migration `20260830000017_private_rag_runtime.sql`, and migration
`20260830000019_rag_generation_control_plane.sql` create and narrow `unfiled_rag_verifier` as
`NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`. It has no table, sequence, or private-schema access and
can execute exactly two public RPCs: one bounded read of an exact building generation and one
canonical attestation write. The separately deployed `apps/verifier` process must strictly decrypt
every projected index document before it submits the database-recomputed manifest digest.
Activation independently revalidates that evidence. The stored attestation is a database capability
decision, not a signature or MAC over plaintext.

1. Apply the same membership-shape gate as the index worker: zero rows after a real superuser
   cleanup is preferred; otherwise the only permitted row is the automatic `supabase_admin`-granted
   ADMIN-only edge to `postgres` for `unfiled_rag_verifier`, with both `INHERIT` and `SET` false.
2. From the trusted verified-TLS administrator session, provision the role itself as the exact
   login; do not grant it to a controller parent role:

   ```psql
   ALTER ROLE unfiled_rag_verifier LOGIN;
   \password unfiled_rag_verifier
   ```

3. Store its separately generated pooler credential only in the `apps/verifier` Production secret
   scope. For the shared Supavisor transaction pooler, use the required transport username
   `unfiled_rag_verifier.<project-ref>`; a direct/dedicated endpoint uses the unsuffixed role. Set:

   ```dotenv
   UNFILED_VERIFIER_DATABASE_URL=<postgresql-uri-with-sslmode-verify-full>
   UNFILED_VERIFIER_DATABASE_EXPECTED_HOST=<exact-canonical-host>
   UNFILED_VERIFIER_DATABASE_PROJECT_REF=<exact-20-character-project-ref>
   UNFILED_VERIFIER_DATABASE_CA_PEM_BASE64=<downloaded-canonical-PEM-as-base64>
   ```

   The credential must not be shared with the index worker, organizer, web project, Preview, CI,
   `service_role`, or any Supabase API key. Require both `session_user` and `current_user` to equal
   `unfiled_rag_verifier` over hostname- and certificate-verified TLS. `SET ROLE` is not evidence.

4. Prove the login can execute only
   `list_building_note_rag_index(uuid,text,bigint,jsonb,integer,integer)` and
   `verify_rag_index_generation(uuid,text,bigint,jsonb)`. It must not read or mutate any relation,
   use the `private` schema, seed/fail/activate a generation, claim worker work, or call another
   public function. Prove service-role and `SET ROLE` sessions cannot use either verifier RPC; a
   bogus extra attestation field and arbitrary digest are rejected; and activation rejects mutated
   or stale canonical evidence. Record only identifiers, SQLSTATEs, role/grant metadata, and
   timestamps—never ciphertext, note content, or credentials.
5. Only after steps 1–4 and the worker readiness proof above are complete, invoke the proved verifier
   Production alias from web Production with one synthetic complete
   shadow generation. Verify Trusted Sources rejects Preview, direct public callers, cookies,
   `Authorization`, protection-bypass headers, and a mismatched web project. Confirm the verifier
   response contains only generation ID, canonical decimal revision token, verified count, and
   `verified: true`; logs must contain only request/deployment metadata and aggregate counts. Tamper
   independently with ciphertext, envelope context, key reference, model/dimensions, count, cursor,
   and revision token; every case must fail closed and must not create activation evidence.
6. Prove that Vercel preserves `x-vercel-trusted-oidc-idp-token` for the verifier handler and exposes
   the workload token through the request context used by
   `@vercel/oidc-aws-credentials-provider`. The real short-lived verifier identity must exchange
   through STS and complete Decrypt only on the active AI object-wrap root. Then run the verifier
   denial probe: it may Describe and Decrypt only active/retired AI object-wrap roots;
   GenerateDataKey, ReEncrypt, staged-root Decrypt, every AI content-MAC operation, every
   private-root operation, and wrong-context Decrypt must be denied. Match allowed and denied calls
   to CloudTrail without recording tokens, ciphertext, encryption-context owner IDs, or plaintext.
   A successful HTTP health check, JWT parse, or client construction is not custody evidence. Record
   worker and verifier identities as separate evidence sets.
7. Now run one complete authenticated indexing-maintenance invocation followed by recovery. Confirm
   it calls only the proved worker and verifier Production origins and reports content-free aggregate
   lifecycle counters. Record only aggregate job counts and deployment/request IDs, never owner/note
   IDs, ciphertext, or content.
8. Rotate and revoke this database credential independently. A rebuild returns the role to
   `NOLOGIN`; repeat the provisioning, exact-session proof, privilege probe, and end-to-end canary
   before the verifier controller resumes.

Until those steps and C.5 pass, Unfiled may be shown as a portfolio work in progress but must not claim that the complete note library is encrypted or that private-manual mode is end-to-end encrypted.

### Dedicated encrypted-organizer database login — provision separately

Migration `20260830000020_encrypted_organizer_runtime.sql` creates the exact PostgreSQL role
`unfiled_organizer_worker` as `NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`. It has no table, sequence,
private-schema, public-create, inherited-role, service-role, index-worker, verifier, or key-admin
capability. It can execute exactly eight job/lease-scoped public RPCs. None accepts an owner UUID;
ownership is derived from the currently leased organization job. The matching `apps/organizer`
deployment is a fourth trust domain with a 49-second maximum request deadline and AI-assisted
object-wrap/content-MAC custody only. Its production planner and content-mutation cipher remain
deliberately unavailable until Milestone D, so this section can establish infrastructure readiness
but cannot establish a real create-or-append result yet.

1. Apply `supabase/roles.sql` and every migration through
   `20260830000020_encrypted_organizer_runtime.sql` before provisioning the login. Inspect
   `pg_auth_members`: zero membership rows touching `unfiled_organizer_worker` is preferred after a
   real bootstrap-superuser cleanup. If the managed Supabase bootstrap grant cannot be removed, the
   only permitted row is granted role `unfiled_organizer_worker`, member `postgres`, grantor
   `supabase_admin`, `ADMIN=true`, `INHERIT=false`, and `SET=false`. Reject every other inbound or
   outbound membership and do not weaken the checked migration guard.
2. In the Supabase dashboard, enable database SSL enforcement and download the canonical CA chain
   plus the exact serverless transaction-pooler connection template. From a trusted administrator
   `psql` session that already uses hostname- and certificate-verified TLS, provision the role itself
   as the login and enter its independently generated password only at the interactive prompt:

   ```psql
   ALTER ROLE unfiled_organizer_worker LOGIN;
   \password unfiled_organizer_worker
   ```

   Never grant `service_role`, `authenticator`, a controller parent role, `INHERIT`, `BYPASSRLS`,
   `SUPERUSER`, `CREATEDB`, `CREATEROLE`, or `REPLICATION`. A migration replay intentionally returns
   the role to `NOLOGIN`; repeat this explicit procedure rather than changing the migration.

3. Build the Production URI from the dashboard template. The shared Supavisor pooler transport
   username is `unfiled_organizer_worker.<project-ref>`; a direct or dedicated endpoint uses the
   unsuffixed role. Use `sslmode=verify-full`, the exact displayed host/port/database, the exact
   20-character project ref, and the downloaded CA. Store only these values in the organizer
   Production project:

   ```dotenv
   UNFILED_ORGANIZER_DATABASE_URL=<exact-postgresql-uri-with-sslmode-verify-full>
   UNFILED_ORGANIZER_DATABASE_EXPECTED_HOST=<exact-canonical-host>
   UNFILED_ORGANIZER_DATABASE_PROJECT_REF=<exact-20-character-project-ref>
   UNFILED_ORGANIZER_DATABASE_CA_PEM_BASE64=<canonical-PEM-chain-as-base64>
   UNFILED_ORGANIZER_DATABASE_CONNECT_TIMEOUT_MS=3000
   UNFILED_ORGANIZER_DATABASE_STATEMENT_TIMEOUT_MS=1500
   ```

   The runtime pins the pooler username shape separately, enables channel binding, requires TLS
   1.2 or newer, verifies the certificate and hostname, and checks the database identity when a
   connection enters the pool. Do not copy this URI, password, CA value, or project ref into web,
   worker, verifier, Preview, CI, Terraform, logs, tickets, or source control. Never substitute a
   Supabase HTTP API key or an RLS-bypassing database URL.

4. Configure the bounded organizer runtime from `apps/organizer/.env.example`:

   ```dotenv
   UNFILED_ORGANIZER_MAX_REQUEST_BYTES=1024
   UNFILED_ORGANIZER_TIMEOUT_MS=49000
   UNFILED_ORGANIZER_CLAIM_LIMIT=2
   UNFILED_ORGANIZER_CONCURRENCY=2
   UNFILED_ORGANIZER_LEASE_SECONDS=120
   UNFILED_ORGANIZER_RECOVERY_LIMIT=100
   ```

   Production must not contain `UNFILED_ORGANIZER_DRAIN_SECRET` or `CRON_SECRET`; exact web
   Trusted Sources identity is the only drain authorization. It must also reject static AWS access
   keys, private-manual KMS identifiers, a global Supabase key/URL, a browser/user secret, and
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `UNFILED_OPENAI_API_KEY`,
   `UNFILED_ANTHROPIC_API_KEY`, or `UNFILED_ORGANIZATION_MODEL_API_KEY`. Milestone D must introduce
   any evaluated provider credential through a separately reviewed organizer-only boundary.

5. Open a connection through the deployed organizer adapter and record a content-free readiness
   result proving both `session_user` and `current_user` equal exactly
   `unfiled_organizer_worker`. `SET ROLE`, an unsuffixed/suffixed-name mismatch after pooler
   authentication, encryption without hostname verification, or a session that reports `postgres`,
   `service_role`, or `authenticator` fails the gate. Record only host class, deployment ID, exact
   role names, TLS mode, timestamp, and pass/fail—never the URI, certificate bytes, password, token,
   ciphertext, or query result content.
6. Run the deployed privilege probe and prove EXECUTE on exactly these signatures:

   - `claim_encrypted_organizer_jobs(text,integer,integer)`
   - `heartbeat_encrypted_organizer_job(text,text,integer,jsonb)`
   - `list_encrypted_organizer_candidates(text,text,integer)`
   - `prepare_encrypted_organizer_create(text,text,text,text)`
   - `prepare_encrypted_organizer_append(text,text,text,bigint,text)`
   - `commit_encrypted_organizer_job(text,text,jsonb)`
   - `fail_encrypted_organizer_job(text,text,text,boolean)`
   - `recover_stale_encrypted_organizer_jobs(integer)`

   Prove zero direct SELECT/INSERT/UPDATE/DELETE or sequence privilege on `public` and `private`, no
   `private` schema use, no public-schema create, and no EXECUTE on any other public or private
   function. Explicitly prove denial for root/key registration, activation, revocation, rewrap,
   plaintext/legacy note functions, service-only aggregate/backfill/rollout functions, all six index
   RPCs, both verifier RPCs, and arbitrary direct relation access. Also prove `anon`,
   `authenticated`, `service_role`, `unfiled_index_worker`, and `unfiled_rag_verifier` cannot execute
   any organizer RPC. Record function names, privilege booleans or SQLSTATEs, deployment ID, and
   timestamps only.

7. Test the data boundary with synthetic ciphertext and content-free reports. A claim must return no
   more than the configured limit; candidate projection must return at most eight AI-assisted
   candidates within its fixed byte budget; private/deleted/stale/cross-owner rows must return no
   projection. A request cannot supply or switch an owner. Lose or replace the lease, flip privacy,
   delete the capture/note, change consent controls, and advance an append revision at each
   disclosure/publication race point. Every race must fail closed, replan at most once, or produce
   Review; it must never disclose private content, publish against stale authority, or loop.
8. From web Production, invoke the exact proved organizer Production alias with an empty synthetic
   queue. Prove Vercel preserves `x-vercel-trusted-oidc-idp-token`; the organizer verifies the exact
   issuer, audience, subject, team slug/ID, web project name/ID, and Production environment; and the
   response is content-free `{"claimed":0,"completed":0,"failed":0,"retryScheduled":0}` with
   `Cache-Control: no-store`. Direct public, Preview, wrong-project, expired-token, cookie,
   `Authorization`, and protection-bypass requests must fail. The organizer must abort by 49 seconds;
   web's 54-second default leaves cleanup margin. A health response or locally decoded JWT is not
   trusted-caller evidence.
9. With the real organizer workload token, prove STS assumes only the exact organizer role. The
   allowed canary may GenerateDataKey/Decrypt on the active AI-assisted object-wrap and content-MAC
   roots and Decrypt only the exact retired roots supplied through the two organizer retired-root
   outputs. Controlled direct probes must deny every private-manual generation, staged-root
   generation/decryption, retired-root generation, wrong-context use, `ReEncrypt`, grant creation,
   key administration, and another workload's authority. Match allowed and denied calls to
   content-free CloudTrail management events. Never record tokens, plaintext, ciphertext, email,
   owner IDs, or encryption-context values.
10. Do not submit a real organization canary at C.5c-3. The checked Production composition has an
    unavailable planner and cipher by design and must fail safely rather than call an unevaluated
    provider or write a partial note. After Milestone D lands, run create, append, explicit
    destination, ambiguous Review, revision-race/replan, response-loss replay, and provider/KMS/DB
    outage canaries. Each successful terminal transaction must atomically publish encrypted note
    state, revision/mutation, decision, receipt/Review, terminal lease state, and one content-free
    index job. Then invoke the independent index recovery path and prove that job completes. The
    organizer response must never synchronously chain the index worker's long-running drain.
11. Exercise connection loss, statement timeout, 49-second request cancellation, stale lease
    recovery, credential revocation, and Vercel alias drift. Jobs must remain encrypted and queued,
    retry within bounded attempts, enter Review/dead-letter deterministically, or recover through
    the exact RPC. There must be no fallback to `apps/web`, a Local/Preview deterministic planner,
    direct tables, a broad Supabase credential, static AWS credentials, plaintext persistence, or
    private-manual custody.
12. Rotate this credential independently of the web, worker, verifier, and Supabase service keys.
    Pause organizer invocations, use the trusted verified-TLS `\password unfiled_organizer_worker`
    prompt, update only the organizer Production secret, redeploy/recycle its pool, prove the old
    credential is rejected and the new session preserves the exact eight-RPC ACL, run the empty-queue
    readiness and denial probes again, then resume. Re-prove alias ownership, OIDC, database session,
    and KMS denials after a project transfer, alias change, role/policy change, CA rotation, database
    restore, or migration replay.

Until the production planner/cipher, explicit production C.5d contraction, account canaries, rotation/restore evidence, and
backup-expiry gates pass, the organizer is an implemented fail-closed security substrate—not a
production routing claim or proof that the complete note library is encrypted.

### Global encrypted-storage contract — C.5d one-way production operation

Migration `20260830000027_encrypted_storage_contract.sql` is safe to deploy before contraction: it
installs the readiness, state, receipt, and operator apply functions without removing the rollback
schema. Applying the contract is intentionally separate and irreversible in place. Do not run it
from `service_role`, an application process, a migration bot using delegated `SET ROLE`, or the
Supabase HTTP API. Use a verified database-owner session where `session_user = current_user`, keep
`ON_ERROR_STOP` enabled, and retain the complete content-free transcript in the release evidence.

1. Deploy the C.5d web/API code and migrations through 27 to Preview, then Production, while the
   contract state remains `expand_compatible`. Prove every currently used manual CRUD, taxonomy,
   history/undo, capture, authenticated body-only search, export, deletion, and retention operation
   succeeds through its encrypted adapter. A rollout lookup, RPC, KMS, or projection failure must
   fail closed; it must never invoke a legacy repository. Keep AI organization disabled until the
   Milestone D planner/cipher gate passes.
2. Pause signups, interactive writes, organizer drains, index maintenance, and retention. Record the
   exact web/organizer/worker/verifier deployment IDs and migration checksum. Create the required
   pre-cutover backup/PITR point, restore it to an isolated scratch project, attach only separately
   restored authorized KMS access, and complete the ciphertext authentication/content-parity drill.
   Record the backup identifier, restore result, retention expiry, and approver without content,
   owner IDs, ciphertext, credentials, or key context. A backup that has not passed this drill blocks
   contraction.
3. Through the official rollout APIs, bring every owner to `encrypted_only`: four active key slots,
   exact encrypted/verified object parity, completed backfill, completed version-1 plaintext scrub,
   matching scrub attestation, safe RAG coverage, and no unfinished note/taxonomy claims, retention
   run, organizer preparation, or wrap reservation. Never update rollout counters or scrub evidence
   directly.
4. In the verified database-owner session, inspect the exact readiness snapshot:

   ```sql
   select session_user, current_user;
   select jsonb_pretty(private.encrypted_storage_contract_readiness());
   ```

   Require `ready=true`, `applied=false`, `uncoveredOwnerCount=0`, every open-work count equal to
   zero, the expected owner/object counts, and a 64-character `readinessDigest`. Investigate any
   mismatch. Do not copy a digest from another environment or an earlier snapshot.

5. Start an explicit transaction, recompute the digest inside it, and apply the exact confirmation:

   ```sql
   begin;
   select private.encrypted_storage_contract_readiness() ->> 'readinessDigest'
     as readiness_digest \gset
   select private.apply_encrypted_storage_contract(
     'CONTRACT UNFILED ENCRYPTED STORAGE V1', :'readiness_digest'
   );
   ```

   Require `state="contracted"`, `replayed=false`, the same digest/counts, and one `appliedAt`.
   Before committing, inspect only content-free catalog/ACL evidence: legacy plaintext columns,
   `note_chunks`, plaintext FTS/trigram indexes, legacy functions, and legacy triggers are absent;
   the retained encrypted trigger set is exact; and PostgreSQL `PUBLIC`, `anon`, `authenticated`, `service_role`,
   `unfiled_index_worker`, `unfiled_rag_verifier`, and `unfiled_organizer_worker` have no direct
   content-table privileges. Any dependency, stale digest, owner-set change, postcondition failure,
   or unexpected output requires `rollback;` and investigation.

6. Commit only after the in-transaction catalog checks pass. A committed contract has no schema
   downgrade. A concurrent caller fails with `contract_application_in_progress`; do not loop
   blindly—obtain a fresh state/readiness snapshot after the first transaction finishes. An exact
   replay with the recorded digest must return `replayed=true`; a different digest or a tampered
   receipt must fail closed.
7. Resume only a small canary cohort. Prove a fresh signup starts in `contracted`, four-key
   registration/activation remains live, and owner-authorized encrypted note/capture create,
   list/detail, manual edit/history/undo, private lexical search, export, retention dry run, and
   account deletion work without any plaintext schema or direct table access. Confirm search uses
   `POST /api/v1/search`, contains no query in URLs, and sends `Cache-Control: no-store`. Search the
   database, backups created after contraction, application/provider logs, traces, analytics,
   Realtime payloads, and error sinks for unique synthetic canaries; require zero plaintext hits.
   Do not call a real AI organization canary until Milestone D is green.
8. Re-enable traffic gradually and watch KMS denials, encrypted-read failures, queue age, search
   errors, retention errors, and receipt latency. If a post-commit defect cannot be corrected
   forward, recovery is a separately approved restore of the recorded pre-cutover backup plus its
   authorized keys and the matching pre-contract application deployment—never hand-recreate dropped
   columns or weaken the contract constraint. Treat that restore as a security incident because it
   reintroduces the plaintext exposure window.
9. Track every pre-contract backup through deletion/expiry and repeat the restore-denial check after
   expiry. Until no retained copy contains the old plaintext contract, product and portfolio copy
   may say only that the production live store is application-encrypted; it must not claim historical
   cryptographic erasure or E2EE.

### Preview release evidence

These checks are intentionally human-owned until preview project credentials and a stable Vercel preview alias exist. The credential-free CI still runs the built-app/local-Supabase HTTP E2E; it does not claim browser, cloud-log, or performance coverage.

1. On the stable synthetic-data preview, request an OTP and verify that the returned 60-second resend cooldown is shown, survives a validation error, and reaches zero without enabling early resend.
2. Verify sign-in, refresh after a full browser restart, sign-out, and direct navigation to an authenticated route after sign-out.
3. On a physical iPhone build, sign in and relaunch the app to verify the session survives in Keychain. Sign out once online and once with airplane mode enabled. Both attempts must immediately return the app to signed-out state; the offline attempt must also show the explicit remote-revocation warning. Re-enable networking, sign in again, and sign out online to complete global provider revocation.
4. Create and edit all five note types. Exercise checklist toggles, log fields, project prose/checklists, spaces, tag rename/association, note links, archive/delete/restore, revision restore, search, and Review empty/non-empty states.
5. Open one note in two tabs, save the first, then verify the second receives `stale_revision` and preserves its local draft instead of silently overwriting.
6. Undo a newly created note and verify it becomes soft-deleted with a new revision; undo that undo and verify the note returns with another revision and identical content.
7. Record browser screenshots at 390 px, 768 px, 1280 px, and 1536 px widths; include keyboard-only focus traversal, 200% zoom, reduced motion, and a screen-reader smoke.

### Cloud canary-log audit

1. Generate a unique synthetic marker that is not a real credential, put it only in a private test note, and record its hash separately.
2. Exercise the preview flows that may emit application, Vercel function, Supabase API/database, and error-monitoring logs.
3. Search every configured log sink for both the marker and common authorization/refresh-token prefixes. The marker, note content, bearer token, refresh token, and provider key material must have zero hits.
4. Record the query window, sinks inspected, result, reviewer, and preview deployment identifier. Any hit blocks promotion and starts the incident-response path.

### Preview performance smoke

1. Use a production-mode preview with synthetic data and a cold browser profile. Record at least three runs each at desktop and mobile viewport sizes.
2. Capture LCP, INP, CLS, route-transition timing, and the manual note create/update/search API p95. Keep cold-start samples visible rather than discarding them.
3. Run a 10 rps sustained `/api/v1/captures` smoke that asserts zero lost or duplicated captures and records p95 durable-acceptance latency. Use only synthetic content and verify the service-only Supabase capture RPCs are not callable with the test user's token.
4. Attach traces or HAR files to the release evidence without authorization headers, cookies, note bodies, or provider keys.

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

5. After the identifiers, App Groups, and stable HTTPS preview deployment exist, create a signed Preview build for a physical iPhone. Supplying a team ID and allowing Xcode to update provisioning is an explicit trusted-machine action. Do not use the Development build for online device evidence: its loopback origin points back to the phone.

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

   Confirm the archive embeds and signs exactly one `QuickCaptureWidget.appex`; the containing app and extension must have the expected Production application identifiers and the same Production App Group entitlement. An unsigned simulator artifact cannot satisfy this gate.

8. On a physical iPhone, complete this durable-capture matrix with a synthetic non-sensitive canary:
   - submit in airplane mode, force-quit immediately after `Saved`, relaunch while still offline, then reconnect and verify one server capture and one receipt;
   - lose the network response after server acceptance, force-quit, relaunch, and verify replay returns the original capture/job rather than duplicating either;
   - expire the session, capture offline, verify `Waiting for sign-in`, sign in once, and verify automatic one-time sync;
   - tap both supported Lock Screen widget families and verify the App Intent opens a blank capture in Unfiled with the keyboard ready; the widget itself must never claim to accept free-form text in place;
   - inspect the App Group container and widget snapshot. They may contain the schema version, pending count, and transient random intent nonce only—never capture text, note text, tokens, destinations, or receipts;
   - queue a retry, background and lock the phone, and verify the foreground retry lifecycle stops; after unlocking and making the app active, verify it resumes and syncs exactly once;
   - while locked, verify the session/database Keychain items and completely protected database file are unavailable to the app; after unlocking, verify the same database opens without replacement or data loss;
   - delete a synced capture, relaunch offline and online, and verify no local ghost row or plaintext artifact reappears.
9. Verify the local database is actually using SQLCipher through GRDB. Record `PRAGMA cipher_version`, the app build identifier, device/iOS version, and pass/fail evidence without recording the canary text or database key. Confirm the database is unreadable without its device Keychain key. Uninstall intentionally deletes the application container, SQLCipher database, drafts, and unsynced outbox; Keychain survival is an OS behavior and is not a recovery mechanism. After reinstall and sign-in, synced server content may rehydrate into a new local database, but an unsynced capture is not recoverable. Verify that exact model and that no stale/phantom outbox row returns. A missing cipher version, readable database without the Keychain key, duplicate capture, or Lock Screen content exposure blocks release.
10. Create the App Store Connect record and complete the privacy manifest review, privacy and encryption/export-compliance disclosures, screenshots, support URL, deletion URL, TestFlight checks, and release notes before submission. No Android store work is in scope for this milestone.

## GitHub protection

Completed on 2026-08-30 after the repository became public. `main` requires the strict aggregate
`CI` status, applies the rule to administrators, and rejects force-pushes and branch deletion. Keep
that aggregate job as the stable required-check name when CI lanes change.
