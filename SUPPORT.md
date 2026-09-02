# Support

Unfiled is currently a portfolio implementation and controlled-beta candidate. A structured, content-free [GitHub support issue template](./.github/ISSUE_TEMPLATE/support.yml) exists on the Milestone G branch, but it is not active on `main` until the branch is merged. GitHub issues are public; this template is not a private account-data channel and does not prove a deployed Support page, controlled launch domain, or monitored support mailbox.

## How to ask for help now

For repository setup or reproducible development problems, use a public GitHub issue only when the report contains no personal data, note content, email address, authentication material, provider key, database identifier, private deployment URL, or raw diagnostic archive. After the Milestone G branch merges, the structured support template provides the preferred public form for those content-free reports.

The `/support` and `/account-deletion` routes are implemented on the Milestone G branch and passed focused tests, typecheck, lint, and a Next.js production build. Their deployment is recorded in `FINAL_REPORT.md`, not asserted here. A product-account case that requires an email address, ownership evidence, export, note content, or other private data must wait for an explicitly established private support channel. Do not put that information into the public template and do not assume that an address at an aspirational or hardcoded domain is monitored. The absence of a verified private account-support path remains a public-beta blocker.

Security vulnerabilities do not belong in support requests or public issues. Use [GitHub private vulnerability reporting](https://github.com/Zachshotamartin/unfiled/security/advisories/new), which was API-verified active on 2026-09-02, and follow [SECURITY.md](./SECURITY.md).

## Safe diagnostic information

Useful, content-free details include:

- web or iOS surface;
- app version, build number, operating-system version, and device model;
- UTC timestamp and timezone;
- action category, such as sign-in, capture sync, export, or deletion;
- visible error category or HTTP status without a response body; and
- a request identifier only after confirming it contains no user content.

Never send note text, capture text, screenshots containing notes or notifications, one-time codes, bearer or refresh tokens, cookies, OpenAI or Claude API keys, SQLCipher keys, database exports, raw HAR files, or unsanitized logs.

## Common account actions

### Sign-in

Unfiled signs you in with your email address and a password. Never share your password with support or enter a password supplied by another person. Respect the visible resend cooldown. Repeated failures should be reported with a timestamp and error category, not the email address or code.

### Offline captures

An offline capture may remain only on the originating device until it syncs. Keep the app installed, return it to the foreground after unlocking, reconnect, and wait for a durable server receipt. Uninstalling the app can remove an unsynced capture; support cannot reconstruct content that never reached the server.

### Export

Authenticated users can request an account export from Settings. Treat the downloaded archive as sensitive. Support must not ask a user to email an export. If export fails, report only the build, timestamp, file-size category, and safe error category.

### Account deletion

Account deletion is initiated inside the authenticated product and requires deliberate confirmation. Live data and sessions are removed through the product's deletion flow; encrypted backup copies are scheduled to age out within the documented retention window. Support must not request passwords, sign-in codes, tokens, or note samples to complete deletion.

An ambiguous deletion result should be reconciled using the same client flow and its retained one-time operation token. Do not create a second deletion request or attempt ad hoc production SQL.

### AI provider keys

The free private beta is bring-your-own-key. In Settings you can save an OpenAI key, a Claude (Anthropic) key, or both, and choose the provider, model, and effort used for organization. Keys are stored only in Supabase Vault and are never returned by the product or shown to support. Support cannot add, read, validate, or rotate a key for you; if a key is rejected the product marks it invalid, sends the capture to Inbox, and asks you to replace the key. Content you mark AI-assisted may be sent to the provider you chose, using your own key, only for an authorized organization or expansion operation. Private-manual notes are never sent to a provider. AI-assisted search in the free beta uses a local wording-based index rather than a semantic embedding, so paraphrases may not match.

### Lost or replaced device

Use another trusted session to sign out when possible. Device-local unsynced drafts are not a server backup. A synced library can be rehydrated after verified sign-in, subject to account state and retention.

## Supported product scope

The planned first beta supports the hosted web product and the native iPhone application on iOS 17 or newer, with the user's own OpenAI or Claude API key. App-funded AI, Android, imports, voice capture, widgets, share extensions, and collaborative workspaces are not supported release features.

## Response expectations

For an active supported channel, the target is an initial response within 2 business days. This is an operating target, not a contractual service-level agreement. The public issue template is not active on `main` until merge, and the private account-support channel, outage status, business hours, escalation ownership, and supported release versions must be established before external beta invitations.

See docs/runbooks/user-export-support.md and docs/runbooks/deletion-reconciliation.md for operator procedures. Those runbooks never authorize support staff to inspect user content or bypass owner-authorized product paths.
