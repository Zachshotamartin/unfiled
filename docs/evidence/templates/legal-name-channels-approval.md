# Legal, Name, and Public Channels Approval Template

## Candidate identity

- Selected launch candidate: Unfiled
- Decision owner:
- Screening date:
- Intended jurisdictions/classes:
- Formal legal review:
- ADR-0014 reviewed:

Selection by the product owner does not establish trademark clearance.

## Current repository baseline

These observations are already established for the Milestone G branch. They do not satisfy the legal, operator, domain, mailbox, or deployed-route gates below.

| Observation                                                                                                                                                | Date       | State  | Boundary                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GitHub private vulnerability reporting](https://github.com/Zachshotamartin/unfiled/security/advisories/new) is enabled and the repository setting is true | 2026-09-02 | passed | Proves the private repository reporting path only; not a mailbox, domain, deployed web route, staffing test, or legal approval                            |
| Structured content-free public support issue template exists on the Milestone G branch                                                                     | 2026-09-02 | passed | Implementation evidence only; inactive on `main` until merge and unsuitable for private account data                                                      |
| `/privacy`, `/terms`, `/security`, `/support`, `/account-deletion`, and `/.well-known/security.txt` pass local focused checks and a production web build   | 2026-09-02 | passed | Local code/build evidence only; correct canonical URLs, controlled Vercel mapping, deployed behavior, operator identity, jurisdiction, and review pending |

## Screening

| Surface                                    | State   | Restricted evidence digest | Decision |
| ------------------------------------------ | ------- | -------------------------- | -------- |
| Trademark registries/common-law search     | pending |                            |          |
| App Store and relevant product listings    | pending |                            |          |
| Domain ownership and renewal               | pending |                            |          |
| Package/repository names                   | pending |                            |          |
| Social handles                             | pending |                            |          |
| Confusingly similar products               | pending |                            |          |
| Source license/all-rights-reserved posture | pending |                            |          |

Do not publish search reports containing third-party personal data or account credentials.

## Public channels

| Channel                                | Ownership proved             | Send/receive test | Monitored owner | Escalation tested | State   |
| -------------------------------------- | ---------------------------- | ----------------- | --------------- | ----------------- | ------- |
| GitHub private vulnerability reporting | Repository setting verified  | pending           | pending         | pending           | pending |
| GitHub public support template         | Branch implementation proved | Public issue only | pending         | pending           | pending |
| Canonical web domain                   |                              | not applicable    |                 |                   | pending |
| Support mailbox                        |                              |                   |                 |                   | pending |
| Security mailbox                       |                              |                   |                 |                   | pending |
| Privacy/legal mailbox                  |                              |                   |                 |                   | pending |
| Public status path                     |                              | not applicable    |                 |                   | pending |
| security.txt                           |                              | not applicable    |                 |                   | pending |

Store exact mailbox addresses and DNS/account records only when they are intentionally public. Keep registrar, recovery, and mail-administration evidence restricted.

## Public policy review

| Artifact                              | Correct canonical URL | Effective date | Owner | Legal review | State   |
| ------------------------------------- | --------------------- | -------------- | ----- | ------------ | ------- |
| Privacy policy                        |                       |                |       |              | pending |
| Terms of service                      |                       |                |       |              | pending |
| Security policy                       |                       |                |       |              | pending |
| Support/account deletion              |                       |                |       |              | pending |
| App Store privacy/disclosure metadata |                       |                |       |              | pending |

## Result

- Launch-name decision: blocked pending clearance
- Repository-private vulnerability-reporting setting: passed on 2026-09-02; escalation exercise pending
- Public support issue activation: pending merge to `main`; content-free reports only
- Public web-route activation: blocked pending controlled-domain deployment proof
- Private account-support activation: blocked pending a verified private channel
- Restricted evidence reference:
- Combined SHA-256:
- Decision owner sign-off:
- Reviewer sign-off:
