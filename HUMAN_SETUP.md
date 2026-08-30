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
3. Set `NEXT_PUBLIC_SITE_URL` to the canonical origin for each scope, including `https://` and excluding a trailing slash. Use the stable preview alias for Preview and the cleared custom domain for Production; local development falls back to `http://localhost:3000`.
4. Keep preview and production values separate.
5. Run the recorded smoke checks against the preview URL before promoting.
6. Add a custom domain only after name clearance.

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

If the GitHub account plan rejects branch protection for the private repository, keep every merge behind a green `gh pr checks` result and record the API error in the final report.
