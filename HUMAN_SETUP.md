# Human Setup

This file contains only steps that require a human account, physical device, paid service, security decision, or visual usability judgment. The implementation and automated tests do not depend on completing these steps.

## Completed during bootstrap

- GitHub CLI authenticated as `Zachshotamartin`.
- Private repository created at `https://github.com/Zachshotamartin/unfiled`.
- Product, GitHub repository, and local project root renamed to `unfiled`.

## Local prerequisites

1. Install Node.js 22.18 or newer. Expo config imports the checked TypeScript native-identity source directly, which requires Node's stable type stripping.
2. Install pnpm 10.14.0: `npm install --global pnpm@10.14.0`.
3. Install Docker Desktop and start it before database commands.
4. Install full Xcode from the Mac App Store. This machine currently exposes only Command Line Tools, so `xcodebuild` cannot build or archive the widget extension.
5. After Xcode opens once, select it: `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.
6. Install an Android SDK through Android Studio for Android device builds.
7. Copy `apps/mobile/.env.example` to `apps/mobile/.env.local`. Keep
   `EXPO_PUBLIC_API_BASE_URL=http://localhost:3000` for the iOS Simulator; use
   `http://10.0.2.2:3000` for the Android emulator, or an HTTPS LAN/tunnel URL reachable by
   a physical phone. This value is a public origin, never a Supabase service key.

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
3. Store each project URL, anonymous key, service-role key, and database password only in the matching Vercel environment.
4. Link preview from a trusted shell: `pnpm supabase link --project-ref <preview-project-ref>`.
5. Review migrations, then apply: `pnpm supabase db push --linked`.
6. Never link a developer preview deployment to production data.

## Vercel

1. Import `Zachshotamartin/unfiled` into Vercel and set the root directory to `apps/web`.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and provider application keys in the appropriate environment scopes.
3. Generate a separate OTP rate-limit pepper for each deployed environment with
   `openssl rand -hex 32`. Add it with `vercel env add AUTH_RATE_LIMIT_PEPPER preview` and
   `vercel env add AUTH_RATE_LIMIT_PEPPER production`; never reuse a provider, Supabase, or cron
   secret. Production OTP requests intentionally fail closed when either this pepper or the service
   role key is absent.
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

1. Generate independent local or Preview-only content keys in a trusted terminal. Run the command twice and place each result directly into a password manager; do not paste either value into an issue, chat, commit, or shell argument:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. For local development, add these server-only values to `apps/web/.env.local`:

   ```dotenv
   UNFILED_CONTENT_KEK_ID=local-content-kek-v1
   UNFILED_CONTENT_KEK=<first-independent-base64url-value>
   UNFILED_CONTENT_FINGERPRINT_KEY=<second-independent-base64url-value>
   CRON_SECRET=<at-least-32-random-characters>
   ```

   The fingerprint key must remain stable through ordinary wrapping-key rotations. Never reuse it as the KEK. `UNFILED_CONTENT_RETIRED_KEKS` is only for a bounded, audited rewrap window and must not become an indefinite archive of old keys.

3. Add independent Preview values interactively with `vercel env add UNFILED_CONTENT_KEK_ID preview`, `vercel env add UNFILED_CONTENT_KEK preview`, `vercel env add UNFILED_CONTENT_FINGERPRINT_KEY preview`, and `vercel env add CRON_SECRET preview`. Interactive entry keeps values out of shell history. The environment-backed resolver is restricted to local and isolated Preview data.
4. Do not launch Production capture storage with a root KEK in Vercel environment variables. Production remains blocked until the checked-in managed KMS/HSM resolver, least-privilege decrypt identity, key-use audit trail, rotation runbook, and restore drill are complete. The final setup steps will identify the selected provider and exact commands when that adapter lands.
5. Migration `20260830000012_durable_capture_workflow.sql` deliberately aborts with `legacy_capture_encryption_backfill_required` if an older environment contains capture text. For disposable Preview data, recreate the project. For data that must be retained, stop writes and use the audited backfill/verification tool delivered with the production key adapter; never edit the migration to discard or relabel plaintext.
6. The checked-in Vercel Hobby schedule calls `/api/internal/captures/drain` daily at 03:07 UTC. `after()` and active clients provide normal prompt processing; the daily call is dormant-work recovery. On Vercel Pro or Enterprise, change only that capture schedule in `apps/web/vercel.json` to `* * * * *`, deploy, and confirm authenticated one-minute invocations. Hobby deployments reject schedules more frequent than daily.
7. After deploying Preview, create one synthetic canary capture, wait for its Inbox receipt, and inspect the `captures` row with an authorized administrative session. `raw_text` must equal `[encrypted]`, the canary must not appear anywhere in the row or logs, `content_envelope.version` must equal `1`, and `content_fingerprint` must be a 64-character keyed digest. Public API responses must contain the authenticated plaintext only after owner authorization and must never contain the envelope, fingerprint, or key identifier.

### Production managed KMS and isolated worker — wait for C.5 code

These are account-bound steps for the repository owner. Do not perform them until the C.5a implementation supplies the exact generated policy files, environment names, and verification command; placeholder IAM policies are not safe enough for production.

1. Create two Vercel projects from this repository: the interactive `apps/web` deployment and the separately deployed `apps/worker` organization/index runtime. Record their exact team, project, and Production environment OIDC subjects.
2. In the selected AWS region, create independent customer-managed KMS keys/aliases for `ai_assisted` and `private_manual`. Enable rotation and CloudTrail data-event auditing.
3. Create distinct AWS roles for the web API and worker. Bind each trust policy to its exact Vercel OIDC subject. The worker role receives only AI-assisted key permissions; the web role receives the owner-authorized key classes required by the interactive API. Neither role receives a static AWS access key.
4. Configure the checked-in `@vercel/oidc-aws-credentials-provider` adapter in each Vercel project, then run the supplied role-separation probe. A direct private-manual decrypt attempt from the worker must be denied and logged.
5. Configure alarms for denied/unusual KMS use, disable/deletion scheduling, and worker attempts against the private alias. Keep KMS key administrators separate from runtime decrypt principals.
6. Complete the recorded outage, rotation/rewrap, restored-backup, and pre-cutover-backup-expiry drills before enabling `encrypted_only` or `contracted` in Production.

Until those steps and C.5 pass, Unfiled may be shown as a portfolio work in progress but must not claim that the complete note library is encrypted or that private-manual mode is end-to-end encrypted.

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

## Apple and EAS

1. Enroll in the Apple Developer Program and create an Expo/EAS account.
2. Register the explicit main and widget-extension App IDs, then register and attach the matching App Group to both IDs for every build environment:

   | Environment | Main App ID                           | Widget extension App ID                            | App Group                                   | URL scheme        |
   | ----------- | ------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ----------------- |
   | Development | `com.zachshotamartin.unfiled.dev`     | `com.zachshotamartin.unfiled.dev.quickcapture`     | `group.com.zachshotamartin.unfiled.dev`     | `unfiled-dev`     |
   | Preview     | `com.zachshotamartin.unfiled.preview` | `com.zachshotamartin.unfiled.preview.quickcapture` | `group.com.zachshotamartin.unfiled.preview` | `unfiled-preview` |
   | Production  | `com.zachshotamartin.unfiled`         | `com.zachshotamartin.unfiled.quickcapture`         | `group.com.zachshotamartin.unfiled`         | `unfiled`         |

3. Run `eas credentials` only after all six App IDs and three App Groups exist so every main-app and extension provisioning profile contains its matching entitlement.
4. Create an EAS development build; the widget cannot run in Expo Go.
5. Install on a physical iPhone running iOS 17 or newer and execute the full device matrix in `docs/BUILD_PLAN.md` section 0.11.
6. Confirm each Release archive embeds and signs exactly one `QuickCaptureWidget.appex` with the same environment-specific App Group as its containing app.
7. Expo Go is not a valid encryption test environment. SQLCipher is compiled through the native Expo SQLite plugin, so use a fresh development or Preview build after every encryption-plugin change.
8. On a physical iPhone, complete this durable-capture matrix with a synthetic non-sensitive canary:
   - submit in airplane mode, force-quit immediately after `Saved`, relaunch while still offline, then reconnect and verify one server capture and one receipt;
   - lose the network response after server acceptance, force-quit, relaunch, and verify replay returns the original capture/job rather than duplicating either;
   - expire the session, capture offline, verify `Waiting for sign-in`, sign in once, and verify automatic one-time sync;
   - begin a widget draft, lock or terminate the app, reopen within 30 minutes, and verify the labeled unsaved draft returns;
   - inspect the App Group container and widget snapshot. They may contain the schema version and pending count only, never capture text, note text, tokens, destinations, or receipts;
   - delete a synced capture, relaunch offline and online, and verify no local ghost row or plaintext artifact reappears.
9. Record `PRAGMA cipher_version`, the app build identifier, device/iOS version, and pass/fail evidence without recording the canary text or database key. A missing cipher version, readable database without the Keychain key, duplicate capture, lost draft, or Lock Screen content exposure blocks release.

## Android and store delivery

1. Create the Android application ID `com.zachshotamartin.unfiled` in Google Play Console.
2. Create EAS preview and production credentials.
3. Complete privacy manifests, store disclosures, screenshots, support URL, deletion URL, and release notes before submission.

## GitHub protection

After the first CI run creates the `CI` check, run:

```bash
gh api --method PUT repos/Zachshotamartin/unfiled/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -F 'required_status_checks[strict]=true' \
  -F 'required_status_checks[contexts][]=CI' \
  -F 'enforce_admins=true' \
  -F 'required_pull_request_reviews=null' \
  -F 'restrictions=null'
```

The command was attempted on 2026-08-30 and GitHub returned HTTP 403:
`Upgrade to GitHub Pro or make this repository public to enable this feature.` Until the
account is upgraded, every merge in this implementation run is manually gated behind a
green `gh pr checks` result and the same limitation is recorded in the final report.
