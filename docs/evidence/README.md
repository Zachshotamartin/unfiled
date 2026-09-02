# Release Evidence

This directory defines the sanitized evidence that supports Unfiled release claims. It is an index, not a storage location for raw production artifacts.

## Evidence states

Use exactly one state for every gate:

- pending: the work or observation has not been performed;
- blocked: a named dependency prevents the work;
- failed: the work ran and did not meet the gate;
- passed: the gate ran against the identified candidate and has reviewable evidence;
- not-applicable: the release owner approved a written reason.

Local tests, unsigned Simulator builds, policy-shape tests, and implementation review cannot be relabeled as deployed, signed-device, backup, provider, or account evidence.

## Public-repository safety

Allowed public fields include:

- commit SHAs, PR numbers, GitHub Actions run numbers, release tags, and public aliases;
- UTC timestamps, durations, bounded counts, pass/fail states, and reviewer names;
- SHA-256 digests of restricted artifacts;
- public documentation URLs after domain ownership is verified; and
- content-free tool and platform versions.

Never commit:

- note or capture text, even when it seems harmless;
- email addresses, user UUIDs, raw account/project/backup identifiers, database connection strings, or private deployment aliases;
- one-time codes, cookies, bearer/refresh tokens, provider keys, encryption keys, KMS ciphertext, or Vault identifiers;
- raw HAR files, database exports, crash archives, CloudTrail exports, screenshots, screen recordings, or logs;
- a canary value—record only its digest and the number of matches; or
- a restricted-storage URL containing a credential or stable infrastructure identifier.

Store sensitive artifacts in an access-controlled evidence system with retention and audit logging. The public record carries an opaque restricted reference and SHA-256 digest so a reviewer can verify the same artifact without publishing it.

## Evidence workflow

1. Copy the relevant template into a dated release directory only when the gate is ready to run.
2. Bind it to one commit, deployment set, database migration state, and native build.
3. Record the operator separately from the reviewer for destructive, key-custody, restore, and release-promotion gates.
4. Sanitize the record before review. Search it for canary values, token prefixes, emails, UUIDs, connection strings, KMS ARNs, and note fragments.
5. Have the reviewer inspect the restricted artifact and its public digest.
6. Mark passed only after every required assertion has an observation and evidence reference.
7. If a candidate changes in a way that affects the gate, create new evidence. Do not silently edit the old record.

## Templates

- templates/release-manifest.md: top-level release identity and gate roll-up
- templates/ci-and-migration.md: CI, dependency, migration, and database evidence
- templates/deployment-topology.md: five-project trust-domain proof
- templates/provider-data-controls.md: dedicated provider projects, models, retention, and spend controls
- templates/storage-contract-cutover.md: separately approved encrypted-storage contraction and backup boundary
- templates/canary-log-audit.md: plaintext/credential absence across configured sinks
- templates/monitoring-alert-test.md: dashboards, scheduler, alerts, delivery, and acknowledgement
- templates/restore-drill.md: timed isolated restore and encrypted-content verification
- templates/backup-expiry-register.md: sanitized tracking for retained pre-contract copies
- templates/account-deletion-drill.md: live deletion, replay, local cleanup, and backup record
- templates/demo-acceptance-and-video.md: flagship behavior and recording provenance
- templates/ios-signed-archive-device.md: signed archive, TestFlight, and SQLCipher
- templates/legal-name-channels-approval.md: name, policies, domain, mailboxes, and source-license decision

## Claim boundary

A complete template proves only the named gate for the bound candidate. FINAL_REPORT.md must preserve pending or blocked states and must call itself a portfolio implementation report until all production and signed-device release gates are passed.
