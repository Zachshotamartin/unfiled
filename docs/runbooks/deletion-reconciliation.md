# Deletion Reconciliation

## Scope and invariants

Use when an account-deletion request has an ambiguous response, a confirmed receipt has incomplete
live-data cleanup, a reconciliation alert is nonzero, a session/device remains active, or restored
backup testing finds deleted-owner data.

Account deletion is irreversible in the live store. A support or operator action must not recreate
an owner, restore content, change a confirmed receipt, or claim that retained backups disappeared
before their documented expiry.

## Authority and privacy

The support owner guides the user through built-in receipt replay. The database/security operators
investigate only content-free deletion receipt state and bounded per-table/Vault/index/session counts
through reviewed functions. They do not inspect rows or accept an email, owner ID, deletion token,
archive, or note content in a ticket.

The unauthenticated receipt token is a bearer capability. The user enters it only in the application;
support never asks them to send it.

The structured GitHub support template may carry only the content-free time, platform, version, and
safe status fields below after it is active on `main`. It is public and must never carry the account
email, ownership evidence, receipt token, export, or private diagnostics. Establish an approved
private account-support channel before collecting any private verification material.

## Triage

1. Ask for UTC time window, client version/platform, and safe deletion status/error code only.
2. Have the user retry the built-in receipt replay with the original token on a trusted device. Exact
   replay may return the confirmed receipt; it must not execute deletion twice.
3. Inspect aggregate deletion requested/confirmed/reconciled counts, oldest incomplete age, safe
   failure class, and session-revocation status for the incident window.
4. If authorized incident tooling can bind a receipt digest to a deletion audit record, use the
   digest generated inside that tool; do not reveal or store its input.
5. Distinguish `request_not_committed`, `committed_response_lost`, `confirmed_live_cleanup_incomplete`,
   `local_device_cleanup_incomplete`, and `backup_copy_within_retention`.

Stop as S1/S2 if another owner's status is exposed, confirmation exists with live owner data/Vault
secret/index rows, a deleted session still authorizes access, or operators need direct content-table
queries to proceed.

## Reconcile

- `request_not_committed`: the user remains signed in and may submit a new deliberate deletion after
  completing export. Do not synthesize a receipt.
- `committed_response_lost`: return status only through exact receipt replay. Do not run deletion
  again or recreate the account.
- `confirmed_live_cleanup_incomplete`: disable affected access, page security/database owners, and
  invoke only the reviewed idempotent reconciliation capability. Verify jobs, index generations,
  Vault bindings/secrets, sessions, and owner rows reach zero.
- `local_device_cleanup_incomplete`: sign out, stop sync/widget work, remove the owner SQLCipher
  profile and Keychain session through the native recovery path. Do not remove another profile or
  treat uninstall/Keychain behavior as server deletion.
- `backup_copy_within_retention`: update the restricted backup-expiry register. Do not restore or
  modify immutable backups solely for one deletion; verify provider expiry at the promised deadline.

Never update audit counters, receipt state, Vault tables, auth users, or cascaded content tables by
hand to manufacture a clean result.

## Verification

- exact replay returns one stable confirmed receipt without authentication or content;
- all live owner tables, encrypted aggregates, index/jobs, Vault binding/live secret, sessions, and
  caches report zero through reviewed checks;
- repeated reconciliation is idempotent and changes no other owner/count;
- web/native sign-out and local encrypted-profile clearing are complete;
- synthetic cross-owner/replay/rate-limit probes fail safely;
- backup expiry is disclosed and tracked separately;
- deletion alert clears and a synthetic full deletion passes.

## Evidence and escalation

Record classification, time window, receipt/audit digests, content-free cleanup counts, reconciliation
attempt/result, session/local-device state, backup-expiry entry, client/deployment versions, security/
database approvals, user communication, and follow-up. Never record the receipt token or owner data.
