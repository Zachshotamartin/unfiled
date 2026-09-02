# Unfiled launch-name clearance record

Status: **selected launch candidate; formal clearance and channel control unproved**

The product owner has selected **Unfiled** as the launch candidate and working identity. That product decision does not establish trademark availability, legal clearance, domain ownership, mailbox delivery, App Store availability, package availability, social-handle control, or Vercel project/deployment control.

This document records the release gate. It is not legal advice and must not be marked cleared without dated evidence from the relevant owner or qualified reviewer.

## Working identity

| Item                   | Working value                                                       | Current evidence status                                                                    |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Product display name   | `Unfiled`                                                           | Selected by product-owner decision                                                         |
| Logo wordmark          | `unfiled`                                                           | Creative system exists; final use remains clearance-gated                                  |
| Primary tagline        | `Just write. It finds its place.`                                   | Selected brand copy; legal/channel review pending                                          |
| Repository name        | `unfiled`                                                           | In use; repository use does not prove broader rights                                       |
| Native host identifier | `com.zachshotamartin.unfiled`                                       | Accepted technically in ADR-0003; Apple registration/signing unproved                      |
| Widget identifier      | `com.zachshotamartin.unfiled.quickcapture`                          | Accepted technically in ADR-0003; Apple registration/signing unproved                      |
| App Group              | `group.com.zachshotamartin.unfiled`                                 | Accepted technically in ADR-0003; provisioning and device behavior unproved                |
| URL scheme             | `unfiled`                                                           | Accepted technically in ADR-0003; collision/channel review pending                         |
| Candidate web domain   | `unfiled.app`                                                       | String appears in product copy; ownership, project mapping, and canonical control unproved |
| Candidate mailboxes    | `hello@`, `support@`, `security@` on the eventual controlled domain | Delivery, monitoring, authentication, and ownership unproved                               |

Opaque native identifiers may remain technically stable even if the public display name changes, but that consequence requires an explicit superseding decision. Do not silently rename bundle IDs or create new Apple records from this checklist.

## Clearance scopes

### 1. Legal and trademark review

Record:

- intended launch jurisdictions;
- relevant product/service categories and trademark classes selected by the reviewer;
- exact-word, plural, spacing, capitalization, phonetic, and confusingly similar results;
- common-law/product-directory findings relevant to notes, knowledge management, capture, productivity, AI, and software services;
- reviewer identity and review date;
- conflicts, risk assessment, required limitations, and expiration/recheck date; and
- whether registration, an opinion, or a narrower geographic/beta use is recommended.

Passing a search-engine query or finding no exact registered mark is not formal clearance.

### 2. Apple and native channels

Verify:

- App Store Connect app-name availability in intended storefronts;
- subtitle and search-term collision risk;
- Apple Developer control of the exact host, widget, and App Group identifiers;
- signed archive consistency with those records;
- URL scheme and associated-domain decisions; and
- the consequence of a later display-name change while keeping opaque identifiers.

Simulator builds and an accepted source-code ADR do not prove Apple registration or provisioning.

### 3. Domain and deployment control

For every canonical origin, record non-secret evidence of:

- registrar account control and recovery ownership;
- nameserver and DNS change authority;
- renewal owner, billing continuity, registry lock where supported, and expiry alerts;
- TLS/certificate behavior;
- exact Vercel team, project, alias, production deployment, and commit mapping from an authenticated control-plane view;
- redirect policy for `www`, alternate domains, and legacy names; and
- separation between marketing/waitlist content and the authenticated product environment.

A resolving domain, valid TLS certificate, public page, or matching product title does not prove the controlled project or deployment commit.

### 4. Mailbox control

For each published address, verify:

- inbound and outbound delivery;
- monitored owner and backup owner;
- SPF, DKIM, and DMARC posture appropriate to the chosen mail provider;
- forwarding and recovery-account security;
- separation of waitlist, support, privacy, and vulnerability-report traffic;
- response targets and escalation rules; and
- a periodic test schedule.

Never publish a security contact that silently forwards to an unmonitored personal inbox.

### 5. Package, repository, and social channels

Check the channels actually intended for launch, such as:

- GitHub organization/repository naming and transfer control;
- package registries used for a public SDK or CLI, if any;
- major social profiles used in the launch plan;
- video/portfolio publisher handles;
- product directories and review sites; and
- common misspellings that create meaningful impersonation risk.

Do not reserve or purchase every possible channel by default. Record which channels matter and which are intentionally unused.

## Evidence register

Store legal advice, private account screenshots, invoices, recovery codes, access tokens, and registrar details outside the public repository. This table should contain only a non-secret reference, date, outcome, and owner.

| Scope                               | Reviewer/owner | Date    | Non-secret evidence reference | Outcome | Recheck date |
| ----------------------------------- | -------------- | ------- | ----------------------------- | ------- | ------------ |
| Trademark/legal                     | Pending        | Pending | Pending                       | Pending | Pending      |
| App Store display name              | Pending        | Pending | Pending                       | Pending | Pending      |
| Apple identifiers/App Group         | Pending        | Pending | Pending                       | Pending | Pending      |
| Domain registrar/DNS                | Pending        | Pending | Pending                       | Pending | Pending      |
| Vercel project/deployment mapping   | Pending        | Pending | Pending                       | Pending | Pending      |
| `hello@` delivery and monitoring    | Pending        | Pending | Pending                       | Pending | Pending      |
| `support@` delivery and monitoring  | Pending        | Pending | Pending                       | Pending | Pending      |
| `security@` delivery and monitoring | Pending        | Pending | Pending                       | Pending | Pending      |
| Repository/package channels         | Pending        | Pending | Pending                       | Pending | Pending      |
| Selected social/video channels      | Pending        | Pending | Pending                       | Pending | Pending      |

## Decision outcomes

The review must result in one of these explicit outcomes:

- **Clear for the recorded scope:** proceed with Unfiled only in the jurisdictions, classes, and channels the evidence covers.
- **Conditional:** document limitations, remediation, recheck date, and whether a controlled beta may proceed.
- **Rename required:** stop new public asset/signing/domain investment, select a new candidate, preserve user data and opaque identifiers safely, and accept a superseding ADR.

Silence, elapsed time, domain availability, or continued development is not an outcome.

## Release gate

Before public product launch, all of the following must be true:

- [ ] Legal/trademark review is recorded for the intended launch scope.
- [ ] App Store name and exact Apple records are controlled.
- [ ] Canonical domain registration, DNS, TLS, and deployment provenance are controlled.
- [ ] Published general, support, privacy, and security mailboxes deliver and are monitored.
- [ ] Public legal and product copy uses the same selected name and operator identity.
- [ ] The public security policy and `security.txt` use proved canonical URLs and contacts.
- [ ] Demo, README, architecture, App Store metadata, and final report use consistent claim-safe naming.
- [ ] ADR-0014 records the final evidence outcome, or a superseding ADR records a rename.

Until every applicable box is complete, describe **Unfiled** as the **selected launch candidate**, not a cleared mark or proved canonical service.
