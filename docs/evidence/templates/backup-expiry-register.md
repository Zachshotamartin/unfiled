# Backup Expiry Register Template

Track every backup or PITR point that may retain pre-contract plaintext, deleted-user wrapped keys, provider credentials, or older security policy. Use opaque digests, never raw provider identifiers.

| Opaque backup SHA-256 | Class | Created UTC | Contains pre-contract state | Scheduled expiry UTC | Deletion/expiry verified UTC | Verification method | Owner | Reviewer | State   |
| --------------------- | ----- | ----------- | --------------------------- | -------------------- | ---------------------------- | ------------------- | ----- | -------- | ------- |
|                       |       |             |                             |                      |                              |                     |       |          | pending |

## Rules

- The register entry does not prove provider deletion until the expiry or deletion observation is reviewed.
- A backup containing a deleted user's wrapped intermediate key may remain decryptable under a retained shared root until expiry.
- Do not revoke a required root merely to make a deletion claim; follow the approved key-lifecycle and restore plan.
- Pre-contract copies block a complete encrypted-library storage claim until every relevant entry is verified expired or separately cryptographically erased.
- Store provider console exports in restricted evidence and record only their digest here.

## Review

- Review cadence:
- Register owner:
- Escalation threshold:
- Oldest overdue entry:
- Overall state: pending
- Restricted register/export SHA-256:
