# Synthetic Demo Account

## Purpose and non-production boundary

The portfolio demo account demonstrates capture-first organization on iPhone and the same result on
web. Every person, note, capture, provider input, image, and timestamp is synthetic and visibly
labeled. The account must never contain copied personal data, real contacts, credentials, customer
support cases, production exports, or restored Production rows.

`supabase/seed.sql` is a deterministic local/test fixture on a historical compatibility path. Never
run it against Preview or Production and never treat it as the Milestone G cloud demo seeder.

## Authority and credentials

The release operator creates/resets the account; a second reviewer verifies content and privacy.
Account creation uses the normal sign-in flow on the single beta Production deployment (there is no
Preview deployment or separate Preview project). Data creation uses only the demo owner's normal
authenticated encrypted API—not direct SQL, service-role content writes, or copied database rows.

The demo email/inbox and authentication factors live in the approved password manager. Do not publish
credentials, share a reusable session, embed tokens in a video/QR code, or add them to repository/CI.
For a public interactive demo, create per-reviewer accounts or an explicit read-only product mode;
never share one writable owner session publicly.

## Fixture set

Use a versioned, deterministic fixture manifest with synthetic dates relative to the seed date and
stable idempotency labels. It should demonstrate:

- an empty first-run state and one-field capture;
- a clearly labeled synthetic shopping list organized by day;
- a synthetic workout log with editable numeric fields;
- a synthetic mindset/principle note;
- a synthetic project update and manual generic note;
- one conservative ambiguous result in Review and its correction/Undo;
- spaces, tags, note link/backlink/source context, archive/restore, and revision history;
- explicit lexical versus AI-assisted search disclosure and lexical fallback;
- export completeness and deletion only in a disposable clone account.

Titles or bodies should include a small `Synthetic demo` marker without making every screen noisy.
No fixture may resemble a real secret, bearer prefix, API key, email conversation, medical record,
financial account, address, or identifiable person.

## Create or reseed

1. Confirm the target is the exact beta Production deployment and that the account is a clearly
   labeled synthetic owner; record deployment/migration/contract/root-registry/provider-registry
   digests. Abort on an ambiguous alias.
2. Create a fresh owner through the approved account management flow; sign in normally and capture
   the short-lived owner session only in protected process memory.
3. Run the reviewed seeder with the fixture version and release ID. It submits normal authenticated
   API requests, uses deterministic idempotency keys, follows expected-revision contracts, and logs
   only fixture case IDs, status, counts, and pass/fail.
4. Never print request/response bodies, session values, note/capture IDs, ciphertext, or provider
   output. Provider-backed fixtures use a separately budgeted synthetic project only after its live
   gate; otherwise exercise deterministic or Inbox/lexical behavior.
5. Run the verifier through owner-authorized reads and compare canonical fixture digests in memory.
   Emit only per-case pass/fail and aggregate counts.
6. A reviewer checks visible `Synthetic demo` labeling, flagship flow, accessibility, screenshots,
   and absence of personal/secret-like material.

Seeding is all-or-stop. On an unexpected response, do not continue into a mixed fixture version.
Delete the disposable account through the normal atomic deletion flow, reconcile it, and create a
new account.

## Daily verification and video use

Before a demo or recording:

- verify exact deployment set, fixture version, account age, all expected cases, no unexpected data,
  no open deletion/export artifact, and successful health/readiness;
- reset volatile Review/Undo/search/capture state using owner APIs or recreate the account;
- use a clean device/browser profile, hide notifications and account identifiers, and show only
  synthetic content;
- review the final video frame by frame for tokens, email, project URLs/IDs, browser chrome, debug
  overlays, notification content, and non-synthetic data.

The flagship gate uses a separate fresh owner to prove first-run iPhone capture and web inspection.
A pre-seeded account cannot satisfy the fresh-user gate by itself.

## Reset, deletion, and stop conditions

Prefer a new account per release candidate. Reset only through documented owner CRUD, then verify
the manifest. To retire an account, export only if needed for fixture verification, delete through the
normal account-deletion UI/API, replay the receipt, and run content-free reconciliation. Track backup
age-out separately.

Stop and rotate/recreate the account if credentials/session appear publicly, any non-synthetic data
is found, the target environment is ambiguous, direct SQL/service-role content mutation would be
required, fixture digests differ, deletion does not reconcile, or logs contain fixture plaintext.

## Evidence

Record fixture version/digest, seed/review timestamps, deployment/migration/configuration digests,
case pass/fail counts, visible-label review, provider mode/budget reference, screenshot/video review,
fresh-user result, reset/deletion reconciliation, backup-expiry entry, and approver roles. Do not
record credentials, account email/ID, content, sessions, or raw responses.
