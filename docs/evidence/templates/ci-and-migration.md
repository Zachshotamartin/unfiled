# CI and Migration Evidence Template

## Candidate

- Commit SHA:
- Pull request and merge commit:
- GitHub Actions workflow/run:
- Runner/toolchain versions:
- Operator:
- Reviewer:
- UTC window:

## Required CI lanes

| Lane                                         | State   | Safe result |
| -------------------------------------------- | ------- | ----------- |
| Format, lint, typecheck, boundaries, OpenAPI | pending |             |
| Unit and contract coverage                   | pending |             |
| Built-service health smokes                  | pending |             |
| Database reset, lint, and pgTAP              | pending |             |
| Database concurrency                         | pending |             |
| Semantic-search trust domain                 | pending |             |
| Built-local HTTP E2E                         | pending |             |
| Deterministic routing and capacity           | pending |             |
| Terraform policy tests                       | pending |             |
| Unsigned iOS generation and build (CI iOS)   | pending |             |
| Unsigned iOS Release archive (CI iOS, main)  | pending |             |
| Secret scan                                  | pending |             |
| Production dependency audit                  | pending |             |

Record test counts, durations, and public run links. Do not copy raw job logs into this repository.

The server lanes run in the `CI` workflow and the phone lanes in `CI iOS`; both are required checks on `main`, and a release requires both green for the commit it ships. A lane a commit did not call for (a server-only commit skips the phone lanes, a phone-only commit skips the server lanes) is recorded as skipped, and the packaging evidence for such a commit is the archive of the last commit that touched `apps/ios`.

## Migration gate

- Beta Production migration head before:
- Beta Production migration head after:
- Apply-from-zero result:
- Schema lint result:
- Forward-only review result:
- Production approval identity:
- Production migration window:
- Production migration result:
- Destructive or irreversible operations present:
- Separate restore/rollback evidence:

The C.5d storage contraction is a separately authorized irreversible operation. A normal migration deployment must not imply that it ran.

## Failure and rollback

- First failed assertion, if any:
- Whether traffic or feature flags changed:
- Rollback/disable action:
- Post-action verification:

## Evidence

- Public run reference:
- Restricted logs reference:
- Restricted artifact SHA-256:
- Reviewer conclusion:
- State: pending

Attestation: no plaintext canary, note content, email, token, secret, connection string, raw project/account identifier, or unsanitized log is included.
