# Release gate

Nothing reaches production or `main` unless every real operation the product offers has just
run, for real, against the deployed service and passed. The gate is not the unit suites; it is
two live clients performing the product's operations with synthetic accounts and reading back
what happened.

## The two live clients

1. **API gate** (`scripts/operations/live-gate/api-gate.mjs`). A Node script signs up a synthetic
   account against the target origin and runs the 59 documented operations in realistic order:
   auth (sign-up, duplicate sign-up, wrong password, sign-in, session, refresh, sign-out),
   settings and provider key, spaces and tags, the note lifecycle (create, toggle, stale
   revision, update, revisions and restore, tags, links and backlinks, move, archive and
   unarchive, soft delete and restore, generated blocks), log fields, routing rules, captures
   (create, list, receipt, retry, delete), the organizer path when a key is present (review
   open on the receipt, resolve, receipt updated, undo, decision correction), search, export,
   and account deletion. Output is content-free: step names, status codes, counts, error codes.
2. **Phone gate** (`apps/ios/UnfiledTests/Live/LiveGateTests.swift`). The iPhone app's own
   `AppModel`, the same code the screens call, runs on the simulator against the target origin
   with its own synthetic account: sign-up, refresh, provider key and settings, private capture
   to note, editor save, archive and restore, delete and Recently deleted restore, search, an
   AI-assisted capture through organizing, Open Review and "Let Unfiled decide", the receipt
   after the decision, undo, edit-and-replace, sign-out, account deletion. It runs only when
   `UNFILED_LIVE_GATE=1` and `UNFILED_LIVE_GATE_API_BASE_URL` are in the test environment.

`scripts/operations/live-gate/run.sh production` runs both and writes
`.live-gate/gate-<commit>.json` only when both are green.

## Secrets the gate needs

Read from the environment or the login keychain; never printed and never committed.

| Purpose                                       | Environment variable          | Keychain (service / account)              |
| --------------------------------------------- | ----------------------------- | ----------------------------------------- |
| Organizer key for the synthetic accounts      | `UNFILED_GATE_OPENAI_API_KEY` | `unfiled-gate` / `OPENAI_API_KEY`         |
| Drain the capture and indexing queues at once | `UNFILED_GATE_CRON_SECRET`    | `unfiled-beta-web-secret` / `CRON_SECRET` |

Without the organizer key every organizer-dependent step fails as `no_key`, so the gate is red.
Or put `UNFILED_GATE_OPENAI_API_KEY=…` in a gitignored `.env.live-gate` at the repo root, which the runner loads. Add the key to the keychain with `security add-generic-password -s unfiled-gate -a OPENAI_API_KEY -w` (it prompts; nothing is echoed).

## The release procedure

`scripts/operations/deploy-production.sh`:

1. Refuses a dirty tree.
2. Runs the API gate against the current production with the gate that matches the deployed commit (from git), so it asks whether what is live still works; new steps that need the new deployment belong to step 4. Red means no deploy.
3. Deploys organizer, worker, verifier, search, and web, recording the deployment ids.
4. Runs the live gate again against the new deployments.
5. On red, promotes the previous deployments back and exits non-zero. On green, the commit is
   live and verified; only then is the PR merged.

CI (`.github/workflows/release-gate.yml`) runs the API gate on demand and on every push to
`main`, with the secrets stored in the repository, so a red gate is visible next to the commit.

## What counts as a failure

Any step that does not do what the product promises: a refused write, a missing row after a
write, a receipt that does not reflect a decision, a review that cannot be opened while it is
open, a search that cannot find text it should, an export without the notes. The gate does not
retry around failures; it reports them.
